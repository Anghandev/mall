import { randomUUID } from 'node:crypto';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, REQUIRED_CONFIRMATIONS, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import {
  verifySettlementExecutionAuthorization,
  type SettlementExecutionAuthorization,
  type SettlementRequestIntent,
} from '../api/settlement-signing.ts';
import { auditSourceId, enqueueAudit } from '../data/audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';
import type { MainnetMicrotestEntitlement } from '../data/mainnet-microtest-entitlement.ts';
import type { EoaRuntimeEvidence } from '../data/settlement-service.ts';
import {
  lockSeckillPrizeFundingMutation,
  reconcileSeckillPrizeFundingReorgOnce,
  reopenRecoveredSeckillPrizePayoutFinality,
} from '../data/seckill-prize-service.ts';

interface TransferRow {
  transfer_id: string;
  artifact_version: string;
  request_id: string;
  request_state: string;
  request_item_index: number;
  order_id: string;
  account_id: string;
  backing_wallet_address: string;
  merchant_id: string | null;
  policy_version: string | number;
  asset: 'USDT' | 'NPL';
  token_address: string;
  token_transfer_conformance_evidence_hash: string;
  executor_wallet: string;
  executor_nonce: string;
  recipient_address: string;
  amount: string;
  transfer_calldata: string;
  content_hash: string;
  gas_cap: string;
  state: string;
  submitted_at: Date | null;
  settled_at: Date | null;
  authorization: SettlementExecutionAuthorization;
}

interface AttemptRow {
  attempt_id: string;
  attempt_number: number;
  lease_token: string;
  request_digest: string;
  execution_tx_hash: string | null;
  state: string;
  submitted_at: Date | null;
  updated_at: Date;
}

export interface EoaSettlementSubmissionInput {
  chainId: 56;
  transferId: string;
  executorWallet: string;
  executorNonce: string;
  tokenAddress: string;
  requestId: string;
  requestItemIndex: number;
  orderId: string;
  accountId: string;
  backingWalletAddress: string;
  recipientAddress: string;
  amount: string;
  transferCalldata: string;
  contentHash: string;
  gasLimit: string;
  requestDigest: string;
  idempotencyKey: string;
  reconciliationOnly?: true;
  authorization: SettlementExecutionAuthorization;
}

export interface EoaSettlementSubmission {
  executionTxHash: string;
  executorWallet: string;
  executorNonce: string;
  requestDigest: string;
}

export interface EoaSettlementBroadcaster {
  submit(input: EoaSettlementSubmissionInput): Promise<EoaSettlementSubmission>;
  replace(input: EoaSettlementSubmissionInput & {
    replacementForAttemptId: string;
    replacementForExecutionTxHash: string;
  }): Promise<EoaSettlementSubmission & { replacementForExecutionTxHash: string }>;
}

export interface EoaSettlementReceipt {
  chainId: 56;
  executionTxHash: string;
  transactionTo: string;
  transactionCalldata: string;
  executorWallet: string;
  executorNonce: string;
  receiptStatus: 0 | 1;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  canonicalBlock: boolean;
  transfers: readonly { tokenAddress: string; from: string; to: string; amount: string }[];
  transferEventDeltas: readonly { tokenAddress: string; account: string; delta: string }[];
  evidenceHash: string;
}

export interface EoaSettlementChainSource {
  receipt(executionTxHash: string): Promise<EoaSettlementReceipt | undefined>;
  canonicalBlock(input: { blockNumber: number; blockHash: string }): Promise<{
    canonical: boolean;
    observedBlockHash: string;
    evidenceHash: string;
  }>;
}

export const deterministicEoaSettlementExecutorErrorCodes = [
  'CHAIN_MISMATCH',
  'SIGNATURE_MISMATCH',
  'AUTHORIZATION_MISMATCH',
  'ROLE_MISMATCH',
  'AMOUNT_MISMATCH',
  'CALLDATA_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'RECONCILIATION_MISSING',
  'INVALID_ENVELOPE',
] as const;

export type DeterministicEoaSettlementExecutorErrorCode =
  (typeof deterministicEoaSettlementExecutorErrorCodes)[number];

interface SettlementTransferService {
  hasPendingTransfer(input: { asset: 'USDT' | 'NPL'; executorWallet: string }): Promise<boolean>;
  createTransfer(
    actor: { walletAddress: string; roles: readonly ['OPERATOR'] },
    input: {
      asset: 'USDT' | 'NPL';
      gasCap: string;
      idempotencyKey: string;
      runtime: EoaRuntimeEvidence;
      correlationId: string;
    },
  ): Promise<unknown>;
}

interface SettlementWorkerLogger {
  error(message: string, context?: unknown): void;
}

const defaultSettlementWorkerLogger: SettlementWorkerLogger = {
  error(message, context) {
    console.error(message, context);
  },
};
const SETTLED_CANONICALITY_AUDIT_INTERVAL_MS = 30 * 60_000;

export class SettlementTransferScheduler {
  readonly #service: SettlementTransferService;
  readonly #platformWallet: string;
  readonly #targets: readonly {
    asset: 'USDT' | 'NPL';
    executorWallet: string;
    gasCap: string;
    attest(): Promise<EoaRuntimeEvidence>;
  }[];
  readonly #logger: SettlementWorkerLogger;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #running = false;

  constructor(input: {
    service: SettlementTransferService;
    platformWallet: string;
    targets: readonly {
      asset: 'USDT' | 'NPL';
      executorWallet: string;
      gasCap: string;
      attest(): Promise<EoaRuntimeEvidence>;
    }[];
    logger?: SettlementWorkerLogger;
  }) {
    this.#service = input.service;
    this.#platformWallet = address(input.platformWallet, 'platform wallet');
    this.#logger = input.logger ?? defaultSettlementWorkerLogger;
    this.#targets = input.targets.map((target) => {
      positiveInteger(target.gasCap, 'settlement gas cap');
      return { ...target, executorWallet: address(target.executorWallet, 'settlement executor wallet') };
    });
  }

  async pollOnce() {
    let created = 0;
    for (const target of this.#targets) {
      try {
        if (!await this.#service.hasPendingTransfer({
          asset: target.asset,
          executorWallet: target.executorWallet,
        })) continue;
        const runtime = await target.attest();
        await this.#service.createTransfer(
          { walletAddress: this.#platformWallet, roles: ['OPERATOR'] },
          {
            asset: target.asset,
            gasCap: target.gasCap,
            idempotencyKey: `eoa-transfer:${runtime.executorWallet}:${runtime.nextNonce}`,
            runtime,
            correlationId: `settlement-transfer:${runtime.executorWallet}:${runtime.nextNonce}`,
          },
        );
        created += 1;
      } catch (error) {
        if (error instanceof CoreError && ['FinalityPending', 'BreakerActive'].includes(error.code)) continue;
        this.#logger.error('settlement transfer scheduler target failed', {
          asset: target.asset,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        continue;
      }
    }
    return created;
  }

  start(intervalMs = 5_000) {
    if (this.#running) return;
    this.#running = true;
    const poll = async () => {
      if (!this.#running) return;
      this.#inFlight = this.pollOnce().then(() => undefined).catch(() => undefined);
      await this.#inFlight;
      this.#inFlight = undefined;
      if (this.#running) this.#timer = setTimeout(poll, intervalMs);
    };
    this.#timer = setTimeout(poll, intervalMs);
  }

  async stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#inFlight;
  }
}

export class SettlementWorker {
  readonly #transactions: SqlTransactionRunner;
  readonly #broadcaster: EoaSettlementBroadcaster;
  readonly #chain: EoaSettlementChainSource;
  readonly #replacementDelayMs: number;
  readonly #clock: () => Date;
  readonly #mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined;
  readonly #logger: SettlementWorkerLogger;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #running = false;

  constructor(input: {
    transactions: SqlTransactionRunner;
    broadcaster: EoaSettlementBroadcaster;
    chain: EoaSettlementChainSource;
    replacementDelayMs?: number;
    clock?: () => Date;
    mainnetMicrotestEntitlement?: MainnetMicrotestEntitlement;
    logger?: SettlementWorkerLogger;
  }) {
    const delay = input.replacementDelayMs ?? 300_000;
    if (!Number.isSafeInteger(delay) || delay <= 0) {
      throw new CoreError('ExternalBlocked', 'Settlement replacement delay is unavailable', 503);
    }
    this.#transactions = input.transactions;
    this.#broadcaster = input.broadcaster;
    this.#chain = input.chain;
    this.#replacementDelayMs = delay;
    this.#clock = input.clock ?? (() => new Date());
    this.#mainnetMicrotestEntitlement = input.mainnetMicrotestEntitlement;
    this.#logger = input.logger ?? defaultSettlementWorkerLogger;
  }

  async pollOnce() {
    const recovered = await this.#safeStep('recoverExpiredLeaseOnce', () => this.recoverExpiredLeaseOnce());
    const submitted = await this.#safeStep('submitOnce', () => this.submitOnce());
    const finalized = await this.#safeStep('pollFinalityOnce', () => this.pollFinalityOnce());
    const reconciled = await this.#safeStep('reconcileSettledCanonicalityOnce', () => this.reconcileSettledCanonicalityOnce());
    const prizeFundingReconciled = await this.#safeStep('reconcilePrizeFundingOnce', () => this.reconcilePrizeFundingOnce());
    const replaced = await this.#safeStep('replaceOnce', () => this.replaceOnce());
    return { recovered, submitted, finalized, reconciled, prizeFundingReconciled, replaced };
  }

  async #safeStep(name: string, step: () => Promise<number>) {
    try {
      return await step();
    } catch (error) {
      this.#logger.error('settlement worker step failed', {
        step: name,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return 0;
    }
  }

  reconcilePrizeFundingOnce() {
    return this.#transactions.transaction((executor) => (
      reconcileSeckillPrizeFundingReorgOnce(executor, this.#clock())
    ));
  }

  start(intervalMs = 2_000) {
    if (this.#running) return;
    this.#running = true;
    const poll = async () => {
      if (!this.#running) return;
      this.#inFlight = this.pollOnce().then(() => undefined).catch(() => undefined);
      await this.#inFlight;
      this.#inFlight = undefined;
      if (this.#running) this.#timer = setTimeout(poll, intervalMs);
    };
    this.#timer = setTimeout(poll, intervalMs);
  }

  async stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#inFlight;
  }

  async submitOnce() {
    const leased = await this.#leaseTransfer();
    if (!leased) return 0;
    try {
      const submitted = validateSubmission(
        await this.#broadcaster.submit(submissionInput(leased.transfer, leased.attempt)),
        leased.transfer,
        leased.attempt.request_digest,
      );
      await this.#recordSubmission(leased, submitted);
      return 1;
    } catch (error) {
      await this.#markLeaseRetryable(leased, error);
      throw error;
    }
  }

  async recoverExpiredLeaseOnce() {
    return this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const result = await executor.query<{ attempt_id: string; transfer_id: string }>(
        `SELECT attempt.attempt_id, attempt.transfer_id
         FROM core.settlement_transfer_attempts attempt
         JOIN core.settlement_transfers transfer ON transfer.transfer_id = attempt.transfer_id
         WHERE attempt.state = 'LEASED' AND attempt.leased_until < $1
           AND (
             transfer.state = 'LEASED'
             OR (attempt.replacement_for_attempt_id IS NOT NULL AND transfer.state IN ('SUBMITTED','MINED'))
           )
         ORDER BY attempt.leased_until, attempt.attempt_id
         LIMIT 1 FOR UPDATE OF attempt, transfer SKIP LOCKED`,
        [this.#clock()],
      );
      const row = result.rows[0];
      if (!row) return 0;
      await executor.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'RETRYABLE', updated_at = $2
         WHERE attempt_id = $1 AND state = 'LEASED'`,
        [row.attempt_id, this.#clock()],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'RETRYABLE'
         WHERE transfer_id = $1 AND state = 'LEASED'`,
        [row.transfer_id],
      );
      return 1;
    });
  }

  async pollFinalityOnce() {
    const candidate = await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const result = await executor.query<{
        transfer_id: string;
        attempt_id: string;
        execution_tx_hash: string;
        uncertain_settled: boolean;
        recovered_terminal: boolean;
      }>(
        `SELECT candidate.transfer_id, candidate.attempt_id,
           candidate.execution_tx_hash, candidate.uncertain_settled,
           candidate.recovered_terminal
         FROM (
           SELECT transfer.transfer_id, attempt.attempt_id,
             attempt.execution_tx_hash, false AS uncertain_settled,
             false AS recovered_terminal,
             attempt.updated_at
           FROM core.settlement_transfers transfer
           JOIN LATERAL (
             SELECT * FROM core.settlement_transfer_attempts current_attempt
             WHERE current_attempt.transfer_id = transfer.transfer_id
               AND current_attempt.state IN ('SUBMITTED','MINED')
               AND current_attempt.execution_tx_hash IS NOT NULL
             ORDER BY current_attempt.attempt_number DESC LIMIT 1
           ) attempt ON true
           WHERE transfer.state IN ('SUBMITTED','MINED')
           UNION ALL
           SELECT transfer.transfer_id, attempt.attempt_id,
             attempt.execution_tx_hash, true AS uncertain_settled,
             false AS recovered_terminal,
             finality.updated_at
           FROM core.settlement_transfers transfer
           JOIN core.settlement_requests request ON request.request_id = transfer.request_id
           JOIN core.settlement_transfer_attempts attempt
             ON attempt.transfer_id = transfer.transfer_id AND attempt.state = 'SETTLED'
           JOIN core.transaction_finality finality
             ON finality.transaction_id = 'settlement-finality:' || attempt.attempt_id
           WHERE transfer.state = 'SETTLED' AND request.state = 'QUARANTINED'
             AND finality.state IN ('REORGED','MINED')
             AND attempt.execution_tx_hash IS NOT NULL
           UNION ALL
           SELECT transfer.transfer_id, attempt.attempt_id,
             attempt.execution_tx_hash, false AS uncertain_settled,
             true AS recovered_terminal, finality.updated_at
           FROM core.settlement_transfers transfer
           JOIN core.settlement_requests request ON request.request_id = transfer.request_id
           JOIN core.settlement_transfer_attempts attempt
             ON attempt.transfer_id = transfer.transfer_id
            AND attempt.state IN ('FAILED','QUARANTINED')
           JOIN core.transaction_finality finality
             ON finality.transaction_id = 'settlement-finality:' || attempt.attempt_id
           WHERE transfer.state = 'QUARANTINED' AND request.state = 'QUARANTINED'
             AND finality.state IN ('REORGED','MINED')
             AND attempt.execution_tx_hash IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM core.durable_jobs job
               WHERE job.job_type = 'RECONCILE'
                 AND job.payload ->> 'kind' = 'SECKILL_PRIZE_FUNDING_REORG'
                 AND (job.payload -> 'transferIds') @> jsonb_build_array(transfer.transfer_id)
             )
         ) candidate
         ORDER BY candidate.updated_at, candidate.transfer_id LIMIT 1`,
      );
      if (!result.rows[0]) return undefined;
      return {
        transfer: await loadTransfer(executor, result.rows[0].transfer_id),
        attempt: await loadAttempt(executor, result.rows[0].attempt_id),
        txHash: result.rows[0].execution_tx_hash,
        uncertainSettled: result.rows[0].uncertain_settled,
        recoveredTerminal: result.rows[0].recovered_terminal,
      };
    });
    if (!candidate) return 0;
    const receipt = await this.#chain.receipt(candidate.txHash);
    if (!receipt) return 0;
    validateReceipt(candidate.transfer, receipt);
    if (candidate.recoveredTerminal) {
      await this.#recordRecoveredPrizeObservation(candidate, receipt);
      return 1;
    }
    if (candidate.uncertainSettled) {
      await this.#recordUncertainSettledObservation(candidate, receipt);
      return 1;
    }
    if (!receipt.canonicalBlock) {
      await this.#markReorged(candidate, receipt.evidenceHash);
      return 1;
    }
    if (receipt.receiptStatus !== 1 && receipt.confirmations >= REQUIRED_CONFIRMATIONS) {
      await this.#markFailedReceipt(candidate, receipt);
      return 1;
    }
    if (receipt.confirmations < REQUIRED_CONFIRMATIONS) {
      await this.#recordMined(candidate, receipt);
      return 1;
    }
    await this.#settle(candidate, receipt);
    return 1;
  }

  async reconcileSettledCanonicalityOnce() {
    const auditBefore = new Date(this.#clock().getTime() - SETTLED_CANONICALITY_AUDIT_INTERVAL_MS);
    const candidate = await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const result = await executor.query<{
        transfer_id: string;
        attempt_id: string;
        transaction_id: string;
        block_number: string;
        block_hash: string;
        finality_state: 'FINAL' | 'FAILED';
        recovered_prize: boolean;
      }>(
        `SELECT candidate.transfer_id, candidate.attempt_id, candidate.transaction_id,
           candidate.block_number, candidate.block_hash, candidate.finality_state,
           candidate.recovered_prize
         FROM (
           SELECT transfer.transfer_id, attempt.attempt_id, finality.transaction_id,
             finality.block_number::text, finality.block_hash,
             finality.state AS finality_state, false AS recovered_prize,
             finality.updated_at
           FROM core.settlement_transfers transfer
           JOIN core.settlement_requests request ON request.request_id = transfer.request_id
           JOIN core.settlement_intents intent ON intent.intent_id = request.intent_id
           JOIN core.settlement_transfer_attempts attempt
             ON attempt.transfer_id = transfer.transfer_id AND attempt.state = 'SETTLED'
           JOIN core.transaction_finality finality
             ON finality.resource_type = 'SETTLEMENT_TRANSFER'
            AND finality.resource_id = transfer.transfer_id
            AND finality.tx_hash = attempt.execution_tx_hash
           WHERE transfer.state = 'SETTLED' AND finality.state = 'FINAL'
             AND finality.block_number IS NOT NULL AND finality.block_hash IS NOT NULL
             AND transfer.artifact_version = $1
             AND intent.artifact_version = $1
             AND finality.updated_at <= $2
           UNION ALL
           SELECT transfer.transfer_id, attempt.attempt_id, finality.transaction_id,
             finality.block_number::text, finality.block_hash,
             finality.state AS finality_state, true AS recovered_prize,
             finality.updated_at
           FROM core.settlement_transfers transfer
           JOIN core.settlement_requests request ON request.request_id = transfer.request_id
           JOIN core.settlement_intents intent ON intent.intent_id = request.intent_id
           JOIN core.settlement_transfer_attempts attempt
             ON attempt.transfer_id = transfer.transfer_id
            AND attempt.state IN ('FAILED','QUARANTINED')
           JOIN core.transaction_finality finality
             ON finality.resource_type = 'SETTLEMENT_TRANSFER'
            AND finality.resource_id = transfer.transfer_id
            AND finality.tx_hash = attempt.execution_tx_hash
           WHERE transfer.state = 'QUARANTINED' AND request.state = 'QUARANTINED'
             AND finality.state IN ('FINAL','FAILED')
             AND finality.block_number IS NOT NULL AND finality.block_hash IS NOT NULL
             AND transfer.artifact_version = $1
             AND intent.artifact_version = $1
             AND finality.updated_at <= $2
             AND EXISTS (
               SELECT 1 FROM core.durable_jobs job
               WHERE job.job_type = 'RECONCILE'
                 AND job.payload ->> 'kind' = 'SECKILL_PRIZE_FUNDING_REORG'
                 AND (job.payload -> 'transferIds') @> jsonb_build_array(transfer.transfer_id)
             )
         ) candidate
         ORDER BY candidate.updated_at, candidate.transfer_id LIMIT 1`,
        [CORE_ARTIFACT_VERSION, auditBefore],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        transfer: await loadTransfer(executor, row.transfer_id),
        attempt: await loadAttempt(executor, row.attempt_id),
        transactionId: row.transaction_id,
        blockNumber: Number(row.block_number),
        blockHash: row.block_hash,
        finalityState: row.finality_state,
        recoveredPrize: row.recovered_prize,
      };
    });
    if (!candidate) return 0;
    const observation = await this.#chain.canonicalBlock(candidate);
    if (observation.canonical) {
      await this.#transactions.transaction((executor) => executor.query(
        `UPDATE core.transaction_finality SET evidence = evidence || $2::jsonb, updated_at = $3
         WHERE transaction_id = $1 AND state = $4`,
        [
          candidate.transactionId,
          JSON.stringify({ canonicalityEvidenceHash: observation.evidenceHash }),
          this.#clock(),
          candidate.finalityState,
        ],
      ).then(() => undefined));
      return 1;
    }
    if (candidate.recoveredPrize) {
      await this.#transactions.transaction((executor) => (
        reopenRecoveredSeckillPrizePayoutFinality(executor, {
          transferId: candidate.transfer.transfer_id,
          attemptId: candidate.attempt.attempt_id,
          executionTxHash: candidate.attempt.execution_tx_hash!,
          finalityTransactionId: candidate.transactionId,
          previousFinalityState: candidate.finalityState,
          sourceBlockHash: candidate.blockHash,
          evidenceHash: observation.evidenceHash,
          at: this.#clock(),
        })
      ));
      return 1;
    }
    await this.#reverseSettled(candidate, observation.evidenceHash);
    return 1;
  }

  async replaceOnce() {
    const candidate = await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const retryableReplacement = await executor.query<{
        transfer_id: string;
        attempt_id: string;
        replacement_for_attempt_id: string;
      }>(
        `SELECT transfer.transfer_id, attempt.attempt_id, attempt.replacement_for_attempt_id
         FROM core.settlement_transfer_attempts attempt
         JOIN core.settlement_transfers transfer ON transfer.transfer_id = attempt.transfer_id
         JOIN core.settlement_requests request ON request.request_id = transfer.request_id
         WHERE transfer.state IN ('SUBMITTED','MINED')
           AND (
             request.state <> 'QUARANTINED'
             OR EXISTS (
               SELECT 1 FROM core.durable_jobs job
               WHERE job.job_type = 'RECONCILE'
                 AND job.payload ->> 'kind' = 'SECKILL_PRIZE_FUNDING_REORG'
                 AND job.state IN ('READY','LEASED','RETRY')
                 AND (job.payload -> 'transferIds') @> to_jsonb(ARRAY[transfer.transfer_id])
             )
           )
           AND attempt.state = 'RETRYABLE'
           AND attempt.replacement_for_attempt_id IS NOT NULL
         ORDER BY attempt.updated_at, transfer.transfer_id LIMIT 1
         FOR UPDATE OF attempt, transfer SKIP LOCKED`,
      );
      if (retryableReplacement.rows[0]) {
        const transfer = await loadTransfer(executor, retryableReplacement.rows[0].transfer_id, true);
        const previous = await loadAttempt(executor, retryableReplacement.rows[0].replacement_for_attempt_id, true);
        const attempt = await leaseExistingAttempt(executor, retryableReplacement.rows[0].attempt_id, this.#clock());
        return { transfer, previous, attempt };
      }
      const result = await executor.query<{ transfer_id: string; attempt_id: string }>(
        `SELECT transfer.transfer_id, attempt.attempt_id
         FROM core.settlement_transfers transfer
         JOIN core.settlement_requests request ON request.request_id = transfer.request_id
         JOIN LATERAL (
           SELECT * FROM core.settlement_transfer_attempts current_attempt
           WHERE current_attempt.transfer_id = transfer.transfer_id
             AND current_attempt.state IN ('SUBMITTED','MINED')
             AND current_attempt.execution_tx_hash IS NOT NULL
           ORDER BY current_attempt.attempt_number DESC LIMIT 1
         ) attempt ON true
         WHERE transfer.state IN ('SUBMITTED','MINED')
           AND request.state <> 'QUARANTINED'
           AND attempt.updated_at < $1
         ORDER BY attempt.updated_at, transfer.transfer_id LIMIT 1`,
        [new Date(this.#clock().getTime() - this.#replacementDelayMs)],
      );
      if (!result.rows[0]) return undefined;
      const transfer = await loadTransfer(executor, result.rows[0].transfer_id, true);
      const previous = await loadAttempt(executor, result.rows[0].attempt_id, true);
      const attempt = await createAttempt(executor, transfer, this.#clock(), previous.attempt_id);
      return { transfer, previous, attempt };
    });
    if (!candidate || !candidate.previous.execution_tx_hash) return 0;
    try {
      const input = submissionInput(candidate.transfer, candidate.attempt);
      const submitted = validateReplacement(
        await this.#broadcaster.replace({
          ...input,
          replacementForAttemptId: candidate.previous.attempt_id,
          replacementForExecutionTxHash: candidate.previous.execution_tx_hash,
        }),
        candidate.transfer,
        candidate.attempt.request_digest,
        candidate.previous.execution_tx_hash,
      );
      await this.#transactions.transaction(async (executor) => {
        await lockSeckillPrizeFundingMutation(executor);
        await executor.query(
          `UPDATE core.settlement_transfer_attempts SET state = 'REPLACED', updated_at = $2
           WHERE attempt_id = $1 AND state IN ('SUBMITTED','MINED')`,
          [candidate.previous.attempt_id, this.#clock()],
        );
      });
      await this.#recordSubmission(candidate, submitted, candidate.previous.execution_tx_hash);
      return 1;
    } catch (error) {
      await this.#markLeaseRetryable(candidate, error);
      throw error;
    }
  }

  async #leaseTransfer() {
    return this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const now = this.#clock();
      const configured = this.#mainnetMicrotestEntitlement;
      const microtest = configured && now < configured.expiresAt ? configured : undefined;
      const selected = await executor.query<{ transfer_id: string }>(
        `SELECT transfer.transfer_id
         FROM core.settlement_transfers transfer
         JOIN core.settlement_requests request ON request.request_id = transfer.request_id
         JOIN core.orders orders ON orders.order_id = transfer.order_id
         LEFT JOIN core.merchants merchant ON merchant.merchant_id = orders.merchant_id
         LEFT JOIN core.merchant_guarantees guarantee ON guarantee.merchant_id = merchant.merchant_id
         WHERE transfer.state IN ('PENDING','RETRYABLE')
           AND (
             request.state <> 'QUARANTINED'
             OR (
               request.state = 'QUARANTINED'
               AND transfer.state = 'RETRYABLE'
               AND EXISTS (
                 SELECT 1 FROM core.settlement_transfer_attempts retry_attempt
                 WHERE retry_attempt.transfer_id = transfer.transfer_id
                   AND retry_attempt.state = 'RETRYABLE'
                   AND retry_attempt.replacement_for_attempt_id IS NULL
               )
               AND EXISTS (
                 SELECT 1 FROM core.durable_jobs job
                 WHERE job.job_type = 'RECONCILE'
                   AND job.payload ->> 'kind' = 'SECKILL_PRIZE_FUNDING_REORG'
                   AND job.state IN ('READY','LEASED','RETRY')
                   AND (job.payload -> 'transferIds') @> to_jsonb(ARRAY[transfer.transfer_id])
               )
             )
           )
           AND (
             transfer.authorization_mode = 'FORMAL'
             OR (
               transfer.authorization_mode = 'MAINNET_MICROTEST'
               AND request.rail = 'MERCHANT_USDT'
               AND $1::text IS NOT NULL
               AND merchant.status = 'APPROVED'
               AND orders.merchant_id = $1
               AND request.merchant_id = $1
               AND lower(merchant.settlement_wallet) = lower($2)
               AND orders.product_id = $3
               AND lower(orders.buyer_wallet) = ANY($4::text[])
               AND guarantee.balance_usdt > 0
               AND lower(guarantee.source_evidence_hash) = lower($5)
               AND orders.created_at >= guarantee.updated_at
               AND transfer.authorization_evidence_hash = $5
               AND transfer.authorization_expires_at = $6
               AND $7::timestamptz < transfer.authorization_expires_at
             )
           )
         ORDER BY transfer.created_at, transfer.transfer_id
         LIMIT 1 FOR UPDATE OF transfer SKIP LOCKED`,
        [
          microtest?.merchantId ?? null,
          microtest?.merchantWallet ?? null,
          microtest?.productId ?? null,
          microtest ? [...microtest.buyerWallets] : [],
          microtest?.evidenceHash ?? null,
          microtest?.expiresAt ?? null,
          now,
        ],
      );
      if (!selected.rows[0]) return undefined;
      const transfer = await loadTransfer(executor, selected.rows[0].transfer_id, true);
      const retryable = await executor.query<{ attempt_id: string }>(
        `SELECT attempt_id FROM core.settlement_transfer_attempts
         WHERE transfer_id = $1 AND state = 'RETRYABLE' AND replacement_for_attempt_id IS NULL
         ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,
        [transfer.transfer_id],
      );
      const attempt = retryable.rows[0]
        ? await leaseExistingAttempt(executor, retryable.rows[0].attempt_id, now)
        : await createAttempt(executor, transfer, now);
      if (transfer.request_state === 'QUARANTINED' && !retryable.rows[0]) {
        throw new CoreError('UnknownState', 'Quarantined settlement reconciliation cannot create an attempt', 409);
      }
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'LEASED'
         WHERE transfer_id = $1 AND state IN ('PENDING','RETRYABLE')`,
        [transfer.transfer_id],
      );
      return { transfer, attempt };
    });
  }

  async #recordSubmission(
    leased: { transfer: TransferRow; attempt: AttemptRow },
    submitted: EoaSettlementSubmission,
    replacementForTxHash?: string,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const transfer = await loadTransfer(executor, leased.transfer.transfer_id, true);
      const attempt = await loadAttempt(executor, leased.attempt.attempt_id, true);
      if (attempt.state !== 'LEASED') throw new CoreError('UnknownState', 'Settlement lease is no longer active', 409);
      const now = this.#clock();
      await executor.query(
        `UPDATE core.settlement_transfer_attempts
         SET execution_tx_hash = $2, state = 'SUBMITTED', submitted_at = $3, updated_at = $3
         WHERE attempt_id = $1 AND lease_token = $4 AND state = 'LEASED'`,
        [attempt.attempt_id, submitted.executionTxHash, now, attempt.lease_token],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'SUBMITTED', nonce_state = 'BROADCAST',
           submitted_at = COALESCE(submitted_at, $2)
         WHERE transfer_id = $1 AND state IN ('LEASED','SUBMITTED','MINED')`,
        [transfer.transfer_id, now],
      );
      await executor.query(
        `INSERT INTO core.transaction_finality (
           transaction_id, resource_type, resource_id, chain_id, contract_address,
           expected_event_hash, tx_hash, replacement_for_tx_hash, confirmations,
           required_confirmations, state, evidence, submitted_at, updated_at
         ) VALUES ($1,'SETTLEMENT_TRANSFER',$2,56,$3,$4,$5,$6,0,$7,'SUBMITTED',$8,$9,$9)`,
        [
          `settlement-finality:${attempt.attempt_id}`,
          transfer.transfer_id,
          transfer.token_address,
          transfer.content_hash,
          submitted.executionTxHash,
          replacementForTxHash ?? null,
          REQUIRED_CONFIRMATIONS,
          JSON.stringify({ requestDigest: attempt.request_digest, contentHash: transfer.content_hash }),
          now,
        ],
      );
      await markItemSubmitted(executor, transfer, submitted.executionTxHash, now);
      if (!replacementForTxHash) {
        await executor.query(
          `INSERT INTO core.outbox_events (
             event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
           ) VALUES ($1,'SETTLEMENT_TRANSFER',$2,'SettlementTransferSubmitted',$3,$1,'PENDING')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            `outbox:settlement-submitted:${transfer.transfer_id}`,
            transfer.transfer_id,
            JSON.stringify({ transferId: transfer.transfer_id, executionTxHash: submitted.executionTxHash }),
          ],
        );
      }
      await enqueueTransferAudit(executor, {
        transfer,
        eventType: replacementForTxHash ? 'SettlementTransferReplaced' : 'SettlementTransferSubmitted',
        evidenceProfile: 'CHAIN_OBSERVED',
        evidenceHash: attempt.request_digest,
        txHash: submitted.executionTxHash,
        at: now,
      });
    });
  }

  async #recordMined(
    candidate: { transfer: TransferRow; attempt: AttemptRow },
    receipt: EoaSettlementReceipt,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      await executor.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'MINED', updated_at = $2
         WHERE attempt_id = $1 AND state IN ('SUBMITTED','MINED')`,
        [candidate.attempt.attempt_id, this.#clock()],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'MINED'
         WHERE transfer_id = $1 AND state IN ('SUBMITTED','MINED')`,
        [candidate.transfer.transfer_id],
      );
      await updateFinality(executor, candidate.attempt.attempt_id, receipt, 'MINED', this.#clock());
    });
  }

  async #settle(
    candidate: { transfer: TransferRow; attempt: AttemptRow },
    receipt: EoaSettlementReceipt,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const transfer = await loadTransfer(executor, candidate.transfer.transfer_id, true);
      if (transfer.state === 'SETTLED') return;
      if (!['SUBMITTED', 'MINED'].includes(transfer.state)) {
        throw new CoreError('UnknownState', 'Settlement transfer is not awaiting finality', 409);
      }
      const now = this.#clock();
      const journalId = `journal:settlement-settled:${transfer.transfer_id}:${receipt.executionTxHash}`;
      const lines = stateMoveLines(transfer, 'SUBMITTED', 'SETTLED');
      await postJournal(executor, {
        journalId,
        eventKey: `settlement-settled:${transfer.transfer_id}:${receipt.executionTxHash}`,
        eventType: 'SETTLEMENT_SETTLED',
        transfer,
        contentHash: hashJson({ transferId: transfer.transfer_id, receipt: receipt.evidenceHash, lines }),
        sourceReferenceHash: receipt.evidenceHash,
        sourceTxHash: receipt.executionTxHash,
        sourceBlockHash: receipt.blockHash,
        lines,
      });
      await executor.query(
        `UPDATE core.settlement_request_items SET settled_journal_id = $3
         WHERE request_id = $1 AND item_index = $2`,
        [transfer.request_id, transfer.request_item_index, journalId],
      );
      await addTransition(executor, transfer, 'SETTLED', journalId, now);
      await executor.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'SETTLED', updated_at = $2
         WHERE attempt_id = $1 AND state IN ('SUBMITTED','MINED')`,
        [candidate.attempt.attempt_id, now],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'SETTLED', settled_at = $2
         WHERE transfer_id = $1`,
        [transfer.transfer_id, now],
      );
      await updateFinality(executor, candidate.attempt.attempt_id, receipt, 'FINAL', now);
      await updateRequestAggregate(executor, transfer.request_id, now);
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
         ) VALUES ($1,'SETTLEMENT_TRANSFER',$2,'SettlementTransferFinalized',$3,$1,'PENDING')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          `outbox:settlement-finalized:${transfer.transfer_id}:${receipt.executionTxHash}`,
          transfer.transfer_id,
          JSON.stringify({ transferId: transfer.transfer_id, executionTxHash: receipt.executionTxHash }),
        ],
      );
      await enqueueTransferAudit(executor, {
        transfer,
        eventType: 'SettlementTransferFinalized',
        evidenceProfile: 'CHAIN_FINAL',
        evidenceHash: receipt.evidenceHash,
        txHash: receipt.executionTxHash,
        blockHash: receipt.blockHash,
        confirmations: receipt.confirmations,
        at: now,
      });
    });
  }

  async #markReorged(
    candidate: { transfer: TransferRow; attempt: AttemptRow },
    evidenceHash: string,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const now = this.#clock();
      const request = await executor.query<{ state: string }>(
        'SELECT state FROM core.settlement_requests WHERE request_id = $1 FOR UPDATE',
        [candidate.transfer.request_id],
      );
      if (request.rows[0]?.state !== 'QUARANTINED') {
        await executor.query(
          `UPDATE core.settlement_transfer_attempts SET state = 'REORGED', updated_at = $2
           WHERE attempt_id = $1 AND state IN ('SUBMITTED','MINED')`,
          [candidate.attempt.attempt_id, now],
        );
        await executor.query(
          `UPDATE core.settlement_transfers SET state = 'RETRYABLE'
           WHERE transfer_id = $1 AND state IN ('SUBMITTED','MINED')`,
          [candidate.transfer.transfer_id],
        );
      }
      await executor.query(
        `UPDATE core.transaction_finality SET state = 'REORGED', evidence = evidence || $2::jsonb,
           updated_at = $3 WHERE transaction_id = $1`,
        [
          `settlement-finality:${candidate.attempt.attempt_id}`,
          JSON.stringify({ reorgEvidenceHash: evidenceHash }),
          now,
        ],
      );
    });
  }

  async #recordUncertainSettledObservation(
    candidate: { transfer: TransferRow; attempt: AttemptRow },
    receipt: EoaSettlementReceipt,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const transfer = await loadTransfer(executor, candidate.transfer.transfer_id, true);
      const attempt = await loadAttempt(executor, candidate.attempt.attempt_id, true);
      if (transfer.state !== 'SETTLED' || attempt.state !== 'SETTLED') return;
      const now = this.#clock();
      if (!receipt.canonicalBlock) {
        await executor.query(
          `UPDATE core.transaction_finality SET state = 'REORGED', finalized_at = NULL,
             evidence = evidence || $2::jsonb, updated_at = $3
           WHERE transaction_id = $1`,
          [
            `settlement-finality:${attempt.attempt_id}`,
            JSON.stringify({ reorgEvidenceHash: receipt.evidenceHash }),
            now,
          ],
        );
        return;
      }
      if (receipt.receiptStatus === 1) {
        await updateFinality(
          executor,
          attempt.attempt_id,
          receipt,
          receipt.confirmations >= REQUIRED_CONFIRMATIONS ? 'FINAL' : 'MINED',
          now,
        );
        return;
      }
      if (receipt.confirmations < REQUIRED_CONFIRMATIONS) {
        await updateFinality(executor, attempt.attempt_id, receipt, 'MINED', now);
        return;
      }
      const journalId = `journal:settlement-finality-failed:${transfer.transfer_id}:${receipt.blockHash}`;
      const lines = stateMoveLines(transfer, 'SETTLED', 'REQUESTED');
      await postJournal(executor, {
        journalId,
        eventKey: `settlement-finality-failed:${transfer.transfer_id}:${receipt.blockHash}`,
        eventType: 'SETTLEMENT_FINALITY_REVERSED',
        transfer,
        contentHash: hashJson({ transferId: transfer.transfer_id, receipt: receipt.evidenceHash, lines }),
        sourceReferenceHash: receipt.evidenceHash,
        sourceTxHash: receipt.executionTxHash,
        sourceBlockHash: receipt.blockHash,
        lines,
      });
      await addTransition(executor, transfer, 'FINALITY_REVERSED', journalId, now);
      await executor.query(
        `UPDATE core.settlement_request_items SET settled_journal_id = NULL
         WHERE request_id = $1 AND item_index = $2`,
        [transfer.request_id, transfer.request_item_index],
      );
      await executor.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'QUARANTINED', updated_at = $2
         WHERE attempt_id = $1 AND state = 'SETTLED'`,
        [attempt.attempt_id, now],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'RETRYABLE', settled_at = NULL
         WHERE transfer_id = $1 AND state = 'SETTLED'`,
        [transfer.transfer_id],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'QUARANTINED'
         WHERE transfer_id = $1 AND state = 'RETRYABLE'`,
        [transfer.transfer_id],
      );
      await executor.query(
        `UPDATE core.transaction_finality SET state = 'FAILED', receipt_status = 0,
           block_number = $2, block_hash = $3, confirmations = $4,
           evidence = $5::jsonb, finalized_at = $6, updated_at = $6
         WHERE transaction_id = $1`,
        [
          `settlement-finality:${attempt.attempt_id}`,
          receipt.blockNumber,
          receipt.blockHash,
          receipt.confirmations,
          JSON.stringify({ receiptEvidenceHash: receipt.evidenceHash }),
          now,
        ],
      );
      await enqueueTransferAudit(executor, {
        transfer,
        eventType: 'SettlementTransferReorgedExecutionFailed',
        evidenceProfile: 'CHAIN_FINAL',
        evidenceHash: receipt.evidenceHash,
        txHash: receipt.executionTxHash,
        blockHash: receipt.blockHash,
        confirmations: receipt.confirmations,
        at: now,
      });
    });
  }

  async #recordRecoveredPrizeObservation(
    candidate: { transfer: TransferRow; attempt: AttemptRow },
    receipt: EoaSettlementReceipt,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const transfer = await loadTransfer(executor, candidate.transfer.transfer_id, true);
      const attempt = await loadAttempt(executor, candidate.attempt.attempt_id, true);
      if (transfer.state !== 'QUARANTINED' || !['FAILED', 'QUARANTINED'].includes(attempt.state)) return;
      const now = this.#clock();
      if (!receipt.canonicalBlock) {
        await executor.query(
          `UPDATE core.transaction_finality SET state = 'REORGED', finalized_at = NULL,
             evidence = evidence || $2::jsonb, updated_at = $3
           WHERE transaction_id = $1`,
          [
            `settlement-finality:${attempt.attempt_id}`,
            JSON.stringify({ reorgEvidenceHash: receipt.evidenceHash }),
            now,
          ],
        );
        return;
      }
      if (receipt.confirmations < REQUIRED_CONFIRMATIONS) {
        await updateFinality(executor, attempt.attempt_id, receipt, 'MINED', now);
        return;
      }
      const item = await executor.query<{ settled_journal_id: string | null }>(
        `SELECT settled_journal_id FROM core.settlement_request_items
         WHERE request_id = $1 AND item_index = $2 FOR UPDATE`,
        [transfer.request_id, transfer.request_item_index],
      );
      const settledJournalId = item.rows[0]?.settled_journal_id ?? null;
      if (receipt.receiptStatus === 1 && settledJournalId === null) {
        const journalId = `journal:settlement-recovered-final:${transfer.transfer_id}:${receipt.blockHash}`;
        const lines = stateMoveLines(transfer, 'REQUESTED', 'SETTLED');
        await postJournal(executor, {
          journalId,
          eventKey: `settlement-recovered-final:${transfer.transfer_id}:${receipt.blockHash}`,
          eventType: 'SETTLEMENT_SETTLED',
          transfer,
          contentHash: hashJson({ transferId: transfer.transfer_id, receipt: receipt.evidenceHash, lines }),
          sourceReferenceHash: receipt.evidenceHash,
          sourceTxHash: receipt.executionTxHash,
          sourceBlockHash: receipt.blockHash,
          lines,
        });
        await executor.query(
          `UPDATE core.settlement_request_items SET settled_journal_id = $3
           WHERE request_id = $1 AND item_index = $2`,
          [transfer.request_id, transfer.request_item_index, journalId],
        );
        await addTransition(executor, transfer, 'SETTLED', journalId, now);
      }
      if (receipt.receiptStatus === 0 && settledJournalId !== null) {
        const journalId = `journal:settlement-recovered-failed:${transfer.transfer_id}:${receipt.blockHash}`;
        const lines = stateMoveLines(transfer, 'SETTLED', 'REQUESTED');
        await postJournal(executor, {
          journalId,
          eventKey: `settlement-recovered-failed:${transfer.transfer_id}:${receipt.blockHash}`,
          eventType: 'SETTLEMENT_FINALITY_REVERSED',
          transfer,
          contentHash: hashJson({ transferId: transfer.transfer_id, receipt: receipt.evidenceHash, lines }),
          sourceReferenceHash: receipt.evidenceHash,
          sourceTxHash: receipt.executionTxHash,
          sourceBlockHash: receipt.blockHash,
          lines,
        });
        await executor.query(
          `UPDATE core.settlement_request_items SET settled_journal_id = NULL
           WHERE request_id = $1 AND item_index = $2`,
          [transfer.request_id, transfer.request_item_index],
        );
        await addTransition(executor, transfer, 'FINALITY_REVERSED', journalId, now);
      }
      await executor.query(
        `UPDATE core.transaction_finality SET state = $2,
           receipt_status = $3, block_number = $4, block_hash = $5,
           confirmations = $6, evidence = $7::jsonb, finalized_at = $8, updated_at = $8
         WHERE transaction_id = $1`,
        [
          `settlement-finality:${attempt.attempt_id}`,
          receipt.receiptStatus === 1 ? 'FINAL' : 'FAILED',
          receipt.receiptStatus,
          receipt.blockNumber,
          receipt.blockHash,
          receipt.confirmations,
          JSON.stringify({ receiptEvidenceHash: receipt.evidenceHash }),
          now,
        ],
      );
      await enqueueTransferAudit(executor, {
        transfer,
        eventType: receipt.receiptStatus === 1
          ? 'SettlementRecoveredPrizeTransferFinalized'
          : 'SettlementRecoveredPrizeTransferFailed',
        evidenceProfile: 'CHAIN_FINAL',
        evidenceHash: receipt.evidenceHash,
        txHash: receipt.executionTxHash,
        blockHash: receipt.blockHash,
        confirmations: receipt.confirmations,
        at: now,
      });
    });
  }

  async #markFailedReceipt(
    candidate: { transfer: TransferRow; attempt: AttemptRow },
    receipt: EoaSettlementReceipt,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const transfer = await loadTransfer(executor, candidate.transfer.transfer_id, true);
      const now = this.#clock();
      const journalId = `journal:settlement-execution-reversed:${transfer.transfer_id}:${receipt.executionTxHash}`;
      const lines = stateMoveLines(transfer, 'SUBMITTED', 'REQUESTED');
      await postJournal(executor, {
        journalId,
        eventKey: `settlement-execution-reversed:${transfer.transfer_id}:${receipt.executionTxHash}`,
        eventType: 'SETTLEMENT_EXECUTION_REVERSED',
        transfer,
        contentHash: hashJson({ transferId: transfer.transfer_id, receipt: receipt.evidenceHash, lines }),
        sourceReferenceHash: receipt.evidenceHash,
        sourceTxHash: receipt.executionTxHash,
        sourceBlockHash: receipt.blockHash,
        lines,
      });
      await addTransition(executor, transfer, 'EXECUTION_REVERSED', journalId, now);
      await executor.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'FAILED', updated_at = $2
         WHERE attempt_id = $1`,
        [candidate.attempt.attempt_id, now],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'QUARANTINED'
         WHERE transfer_id = $1`,
        [transfer.transfer_id],
      );
      await executor.query(
        `UPDATE core.transaction_finality SET state = 'FAILED', receipt_status = 0,
           block_number = $2, block_hash = $3, confirmations = $4,
           evidence = $5::jsonb, updated_at = $6 WHERE transaction_id = $1`,
        [
          `settlement-finality:${candidate.attempt.attempt_id}`,
          receipt.blockNumber,
          receipt.blockHash,
          receipt.confirmations,
          JSON.stringify({ receiptEvidenceHash: receipt.evidenceHash }),
          now,
        ],
      );
      await executor.query(
        `UPDATE core.settlement_requests SET state = 'QUARANTINED'
         WHERE request_id = $1`,
        [transfer.request_id],
      );
    });
  }

  async #reverseSettled(
    candidate: {
      transfer: TransferRow;
      attempt: AttemptRow;
      transactionId: string;
      blockHash: string;
    },
    evidenceHash: string,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const transfer = await loadTransfer(executor, candidate.transfer.transfer_id, true);
      if (transfer.state !== 'SETTLED') return;
      const now = this.#clock();
      const request = await executor.query<{ state: string }>(
        'SELECT state FROM core.settlement_requests WHERE request_id = $1 FOR UPDATE',
        [transfer.request_id],
      );
      if (request.rows[0]?.state === 'QUARANTINED') {
        await reopenRecoveredSeckillPrizePayoutFinality(executor, {
          transferId: transfer.transfer_id,
          attemptId: candidate.attempt.attempt_id,
          executionTxHash: candidate.attempt.execution_tx_hash!,
          finalityTransactionId: candidate.transactionId,
          previousFinalityState: 'FINAL',
          sourceBlockHash: candidate.blockHash,
          evidenceHash,
          at: now,
        });
        return;
      }
      const journalId = `journal:settlement-finality-reversed:${transfer.transfer_id}:${candidate.attempt.execution_tx_hash}`;
      const lines = stateMoveLines(transfer, 'SETTLED', 'SUBMITTED');
      await postJournal(executor, {
        journalId,
        eventKey: `settlement-finality-reversed:${transfer.transfer_id}:${candidate.attempt.execution_tx_hash}`,
        eventType: 'SETTLEMENT_FINALITY_REVERSED',
        transfer,
        contentHash: hashJson({ transferId: transfer.transfer_id, evidenceHash, lines }),
        sourceReferenceHash: evidenceHash,
        sourceTxHash: candidate.attempt.execution_tx_hash,
        sourceBlockHash: null,
        lines,
      });
      await addTransition(executor, transfer, 'FINALITY_REVERSED', journalId, now);
      await executor.query(
        `UPDATE core.settlement_request_items SET settled_journal_id = NULL
         WHERE request_id = $1 AND item_index = $2`,
        [transfer.request_id, transfer.request_item_index],
      );
      await executor.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'REORGED', updated_at = $2
         WHERE attempt_id = $1`,
        [candidate.attempt.attempt_id, now],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'RETRYABLE', settled_at = NULL
         WHERE transfer_id = $1`,
        [transfer.transfer_id],
      );
      await executor.query(
        `UPDATE core.transaction_finality SET state = 'REORGED', finalized_at = NULL,
           evidence = evidence || $2::jsonb, updated_at = $3 WHERE transaction_id = $1`,
        [candidate.transactionId, JSON.stringify({ reorgEvidenceHash: evidenceHash }), now],
      );
      await executor.query(
        `UPDATE core.settlement_requests SET state = 'SUBMITTED', settled_at = NULL
         WHERE request_id = $1 AND state = 'SETTLED'`,
        [transfer.request_id],
      );
    });
  }

  async #markLeaseRetryable(
    leased: { transfer: TransferRow; attempt: AttemptRow },
    error: unknown,
  ) {
    if (isDeterministicSettlementExecutorRejection(error)) {
      await this.#markLeaseQuarantined(leased, error);
      return;
    }
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const now = this.#clock();
      await executor.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'RETRYABLE', updated_at = $2
         WHERE attempt_id = $1 AND state = 'LEASED'`,
        [leased.attempt.attempt_id, now],
      );
      await executor.query(
        `UPDATE core.settlement_transfers SET state = 'RETRYABLE'
         WHERE transfer_id = $1 AND state = 'LEASED'`,
        [leased.transfer.transfer_id],
      );
      await enqueueTransferAudit(executor, {
        transfer: leased.transfer,
        eventType: 'SettlementTransferSubmissionFailed',
        evidenceProfile: 'SYSTEM',
        evidenceHash: hashJson(settlementSubmissionFailureEvidence(error, 'RETRYABLE')),
        at: now,
      });
    });
  }

  async #markLeaseQuarantined(
    leased: { transfer: TransferRow; attempt: AttemptRow },
    error: unknown,
  ) {
    await this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const now = this.#clock();
      const failureEvidenceHash = hashJson(settlementSubmissionFailureEvidence(error, 'QUARANTINED'));
      await executor.query(
        `UPDATE core.settlement_transfer_attempts SET state = 'QUARANTINED', updated_at = $2
         WHERE attempt_id = $1 AND state = 'LEASED'`,
        [leased.attempt.attempt_id, now],
      );
      const transferQuarantined = await executor.query<{ transfer_id: string }>(
        `UPDATE core.settlement_transfers
         SET state = 'QUARANTINED',
           nonce_state = CASE WHEN NOT EXISTS (
             SELECT 1 FROM core.settlement_transfer_attempts prior
             WHERE prior.transfer_id = core.settlement_transfers.transfer_id
               AND prior.execution_tx_hash IS NOT NULL
           ) THEN 'RELEASED' ELSE nonce_state END,
           nonce_release_evidence_hash = CASE WHEN NOT EXISTS (
             SELECT 1 FROM core.settlement_transfer_attempts prior
             WHERE prior.transfer_id = core.settlement_transfers.transfer_id
               AND prior.execution_tx_hash IS NOT NULL
           ) THEN $2 ELSE nonce_release_evidence_hash END
         WHERE transfer_id = $1 AND state IN ('LEASED','SUBMITTED','MINED')
         RETURNING transfer_id`,
        [leased.transfer.transfer_id, failureEvidenceHash],
      );
      if (transferQuarantined.rows[0]) {
        await executor.query(
          `UPDATE core.settlement_requests SET state = 'QUARANTINED'
           WHERE request_id = $1`,
          [leased.transfer.request_id],
        );
      }
      await enqueueTransferAudit(executor, {
        transfer: leased.transfer,
        eventType: 'SettlementTransferSubmissionQuarantined',
        evidenceProfile: 'SYSTEM',
        evidenceHash: failureEvidenceHash,
        at: now,
      });
    });
  }
}

async function createAttempt(
  executor: SqlExecutor,
  transfer: TransferRow,
  now: Date,
  replacementForAttemptId?: string,
) {
  const count = await executor.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM core.settlement_transfer_attempts WHERE transfer_id = $1',
    [transfer.transfer_id],
  );
  const attemptNumber = Number(count.rows[0]?.count ?? '0') + 1;
  const attemptId = `settlement-attempt:${transfer.transfer_id}:${attemptNumber}`;
  const leaseToken = randomUUID();
  const requestDigest = hashJson({
    chainId: 56,
    transferId: transfer.transfer_id,
    executorWallet: transfer.executor_wallet,
    executorNonce: transfer.executor_nonce,
    tokenAddress: transfer.token_address,
    recipientAddress: transfer.recipient_address,
    amount: transfer.amount,
    transferCalldata: transfer.transfer_calldata,
    contentHash: transfer.content_hash,
    gasLimit: transfer.gas_cap,
    replacementForAttemptId: replacementForAttemptId ?? null,
  });
  await executor.query(
    `INSERT INTO core.settlement_transfer_attempts (
       attempt_id, transfer_id, attempt_number, lease_token, request_digest,
       transaction_to, transaction_calldata, executor_wallet, executor_nonce,
       gas_limit, replacement_for_attempt_id, state, leased_until,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'LEASED',$12,$13,$13)`,
    [
      attemptId,
      transfer.transfer_id,
      attemptNumber,
      leaseToken,
      requestDigest,
      transfer.token_address,
      transfer.transfer_calldata,
      transfer.executor_wallet,
      transfer.executor_nonce,
      transfer.gas_cap,
      replacementForAttemptId ?? null,
      new Date(now.getTime() + 2 * 60 * 1000),
      now,
    ],
  );
  return loadAttempt(executor, attemptId);
}

async function leaseExistingAttempt(
  executor: SqlExecutor,
  attemptId: string,
  now: Date,
) {
  const leaseToken = randomUUID();
  await executor.query(
    `UPDATE core.settlement_transfer_attempts
     SET state = 'LEASED', lease_token = $2, leased_until = $3, updated_at = $4
     WHERE attempt_id = $1 AND state = 'RETRYABLE'`,
    [attemptId, leaseToken, new Date(now.getTime() + 2 * 60 * 1000), now],
  );
  return loadAttempt(executor, attemptId);
}

function submissionInput(transfer: TransferRow, attempt: AttemptRow): EoaSettlementSubmissionInput {
  return {
    chainId: 56,
    transferId: transfer.transfer_id,
    executorWallet: transfer.executor_wallet,
    executorNonce: transfer.executor_nonce,
    tokenAddress: transfer.token_address,
    requestId: transfer.request_id,
    requestItemIndex: transfer.request_item_index,
    orderId: transfer.order_id,
    accountId: transfer.account_id,
    backingWalletAddress: transfer.backing_wallet_address,
    recipientAddress: transfer.recipient_address,
    amount: transfer.amount,
    transferCalldata: transfer.transfer_calldata,
    contentHash: transfer.content_hash,
    gasLimit: transfer.gas_cap,
    requestDigest: attempt.request_digest,
    idempotencyKey: attempt.attempt_id,
    ...(transfer.request_state === 'QUARANTINED' ? { reconciliationOnly: true as const } : {}),
    authorization: transfer.authorization,
  };
}

function validateSubmission(
  value: EoaSettlementSubmission,
  transfer: TransferRow,
  requestDigest: string,
) {
  if (
    !isHash(value.executionTxHash)
    || address(value.executorWallet, 'submitted executor wallet') !== transfer.executor_wallet
    || value.executorNonce !== transfer.executor_nonce
    || value.requestDigest !== requestDigest
  ) throw new CoreError('InvalidFinality', 'EOA executor response is not bound to the transfer intent', 502);
  return { ...value, executionTxHash: value.executionTxHash.toLowerCase() };
}

function validateReplacement(
  value: EoaSettlementSubmission & { replacementForExecutionTxHash: string },
  transfer: TransferRow,
  requestDigest: string,
  previousTxHash: string,
) {
  const submitted = validateSubmission(value, transfer, requestDigest);
  if (value.replacementForExecutionTxHash.toLowerCase() !== previousTxHash.toLowerCase()) {
    throw new CoreError('InvalidFinality', 'EOA replacement did not bind the previous transaction', 502);
  }
  return submitted;
}

function validateReceipt(transfer: TransferRow, receipt: EoaSettlementReceipt) {
  if (
    receipt.chainId !== 56
    || !isHash(receipt.executionTxHash)
    || address(receipt.transactionTo, 'settlement transaction target') !== transfer.token_address
    || transfer.token_address !== expectedSettlementTokenAddress(transfer.asset)
    || !isHash(transfer.token_transfer_conformance_evidence_hash)
    || receipt.transactionCalldata.toLowerCase() !== transfer.transfer_calldata
    || address(receipt.executorWallet, 'settlement transaction sender') !== transfer.executor_wallet
    || receipt.executorNonce !== transfer.executor_nonce
    || !isHash(receipt.blockHash)
    || !isHash(receipt.evidenceHash)
    || !Number.isSafeInteger(receipt.blockNumber)
    || !Number.isSafeInteger(receipt.confirmations)
    || receipt.confirmations < 0
  ) throw new CoreError('InvalidFinality', 'Settlement transaction evidence drifted from the immutable intent', 409);
  if (receipt.receiptStatus !== 1) return;
  const matchingTransfer = receipt.transfers.filter((event) =>
    address(event.tokenAddress, 'transfer token') === transfer.token_address
    && address(event.from, 'transfer sender') === transfer.executor_wallet
    && address(event.to, 'transfer recipient') === transfer.recipient_address
    && event.amount === transfer.amount);
  const senderDelta = receipt.transferEventDeltas.find((delta) =>
    address(delta.tokenAddress, 'delta token') === transfer.token_address
    && address(delta.account, 'delta account') === transfer.executor_wallet);
  const recipientDelta = receipt.transferEventDeltas.find((delta) =>
    address(delta.tokenAddress, 'delta token') === transfer.token_address
    && address(delta.account, 'delta account') === transfer.recipient_address);
  if (
    matchingTransfer.length !== 1
    || senderDelta?.delta !== `-${transfer.amount}`
    || recipientDelta?.delta !== transfer.amount
  ) throw new CoreError('InvalidFinality', 'Settlement token transfer or transfer event deltas are invalid', 409);
}

function expectedSettlementTokenAddress(asset: 'USDT' | 'NPL') {
  return asset === 'USDT' ? USDT_ADDRESS : NPL_ADDRESS;
}

async function loadTransfer(executor: SqlExecutor, transferId: string, forUpdate = false) {
  const result = await executor.query<Omit<TransferRow, 'authorization'>>(
    `SELECT transfer.transfer_id, transfer.artifact_version, transfer.request_id,
       request.state AS request_state,
       transfer.request_item_index, transfer.order_id, transfer.account_id,
       request_item.backing_wallet_address,
       request.merchant_id, orders.policy_version, transfer.asset, transfer.token_address,
       transfer.token_transfer_conformance_evidence_hash,
       transfer.executor_wallet, transfer.executor_nonce::text, transfer.recipient_address,
       transfer.amount::text, transfer.transfer_calldata, transfer.content_hash,
       transfer.gas_cap::text, transfer.state, transfer.submitted_at, transfer.settled_at
     FROM core.settlement_transfers transfer
     JOIN core.settlement_requests request ON request.request_id = transfer.request_id
     JOIN core.settlement_request_items request_item
       ON request_item.request_id = transfer.request_id
      AND request_item.item_index = transfer.request_item_index
     JOIN core.orders orders ON orders.order_id = transfer.order_id
     WHERE transfer.transfer_id = $1${forUpdate ? ' FOR UPDATE OF transfer' : ''}`,
    [transferId],
  );
  const transfer = result.rows[0];
  if (!transfer) throw new CoreError('InvalidRequest', 'Settlement transfer not found', 404);
  const authorization = await loadTransferAuthorization(executor, transfer);
  verifySettlementExecutionAuthorization(authorization, {
    requestId: transfer.request_id,
    requestItemIndex: transfer.request_item_index,
    orderId: transfer.order_id,
    accountId: transfer.account_id,
    backingWalletAddress: transfer.backing_wallet_address,
    executorWallet: transfer.executor_wallet,
    tokenAddress: transfer.token_address,
    recipientAddress: transfer.recipient_address,
    amount: transfer.amount,
  });
  return { ...transfer, authorization };
}

async function loadTransferAuthorization(
  executor: SqlExecutor,
  transfer: Omit<TransferRow, 'authorization'>,
): Promise<SettlementExecutionAuthorization> {
  const request = await executor.query<{
    request_id: string;
    signature: string;
    intent_id: string;
    artifact_version: string;
    wallet_address: string;
    recipient_address: string;
    rail: SettlementRequestIntent['rail'];
    asset_address: string;
    executor_wallet: string;
    amount: string;
    items_hash: string;
    nonce: string;
    deadline: Date;
  }>(
    `SELECT request.request_id, request.signature, intent.intent_id,
       intent.artifact_version, intent.wallet_address, intent.recipient_address,
       intent.rail, intent.asset_address, intent.executor_wallet, intent.amount::text,
       intent.items_hash, intent.nonce::text, intent.deadline
     FROM core.settlement_requests request
     JOIN core.settlement_intents intent ON intent.intent_id = request.intent_id
     WHERE request.request_id = $1`,
    [transfer.request_id],
  );
  const row = request.rows[0];
  if (!row) throw new CoreError('InvalidFinality', 'Signed settlement request authorization is unavailable', 409);
  const items = await executor.query<{
    item_index: number;
    order_id: string;
    account_id: string;
    backing_wallet_address: string;
    amount: string;
    item_hash: string;
  }>(
    `SELECT item_index, order_id, account_id, backing_wallet_address, amount::text, item_hash
     FROM core.settlement_intent_items WHERE intent_id = $1 ORDER BY item_index`,
    [row.intent_id],
  );
  return {
    requestId: row.request_id,
    selectedItemIndex: transfer.request_item_index,
    intent: {
      intentId: row.intent_id,
      artifactVersion: row.artifact_version,
      wallet: row.wallet_address,
      recipient: row.recipient_address,
      rail: row.rail,
      asset: row.asset_address,
      executorWallet: row.executor_wallet,
      amount: row.amount,
      itemsHash: row.items_hash,
      nonce: row.nonce,
      deadline: Math.floor(new Date(row.deadline).getTime() / 1000),
    },
    signature: row.signature,
    items: items.rows.map((item) => ({
      itemIndex: item.item_index,
      orderId: item.order_id,
      accountId: item.account_id,
      backingWalletAddress: item.backing_wallet_address,
      amount: item.amount,
      itemHash: item.item_hash,
    })),
  };
}

async function loadAttempt(executor: SqlExecutor, attemptId: string, forUpdate = false) {
  const result = await executor.query<AttemptRow>(
    `SELECT attempt_id, attempt_number, lease_token, request_digest, execution_tx_hash,
       state, submitted_at, updated_at FROM core.settlement_transfer_attempts
     WHERE attempt_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [attemptId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Settlement attempt not found', 404);
  return result.rows[0];
}

async function markItemSubmitted(
  executor: SqlExecutor,
  transfer: TransferRow,
  txHash: string,
  now: Date,
) {
  const item = await executor.query<{ submitted_journal_id: string | null }>(
    `SELECT submitted_journal_id FROM core.settlement_request_items
     WHERE request_id = $1 AND item_index = $2 FOR UPDATE`,
    [transfer.request_id, transfer.request_item_index],
  );
  if (!item.rows[0]) throw new CoreError('UnknownState', 'Settlement request item is unavailable', 409);
  if (!item.rows[0].submitted_journal_id) {
    const journalId = `journal:settlement-submitted:${transfer.transfer_id}`;
    const lines = stateMoveLines(transfer, 'REQUESTED', 'SUBMITTED');
    await postJournal(executor, {
      journalId,
      eventKey: `settlement-submitted:${transfer.transfer_id}`,
      eventType: 'SETTLEMENT_SUBMITTED',
      transfer,
      contentHash: hashJson({ transferId: transfer.transfer_id, contentHash: transfer.content_hash, lines }),
      sourceReferenceHash: transfer.content_hash,
      sourceTxHash: txHash,
      sourceBlockHash: null,
      lines,
    });
    await executor.query(
      `UPDATE core.settlement_request_items SET submitted_journal_id = $3
       WHERE request_id = $1 AND item_index = $2`,
      [transfer.request_id, transfer.request_item_index, journalId],
    );
    await addTransition(executor, transfer, 'SUBMITTED', journalId, now);
  }
  await updateRequestAggregate(executor, transfer.request_id, now);
}

async function updateRequestAggregate(executor: SqlExecutor, requestId: string, now: Date) {
  const counts = await executor.query<{ total: string; submitted: string; settled: string; quarantined: string }>(
    `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE item.submitted_journal_id IS NOT NULL)::text AS submitted,
       count(*) FILTER (WHERE item.settled_journal_id IS NOT NULL)::text AS settled,
       count(*) FILTER (WHERE transfer.state = 'QUARANTINED')::text AS quarantined
     FROM core.settlement_request_items item
     LEFT JOIN core.settlement_transfers transfer
       ON transfer.request_id = item.request_id AND transfer.request_item_index = item.item_index
     WHERE item.request_id = $1`,
    [requestId],
  );
  const row = counts.rows[0];
  if (!row) throw new CoreError('UnknownState', 'Settlement request aggregate is unavailable', 409);
  if (row.quarantined !== '0') {
    await executor.query(
      `UPDATE core.settlement_requests SET state = 'QUARANTINED' WHERE request_id = $1`,
      [requestId],
    );
  } else if (row.total !== '0' && row.total === row.settled) {
    await executor.query(
      `UPDATE core.settlement_requests SET state = 'SETTLED', settled_at = $2,
         submitted_at = COALESCE(submitted_at, $2)
       WHERE request_id = $1 AND state <> 'QUARANTINED'`,
      [requestId, now],
    );
  } else if (row.total !== '0' && row.total === row.submitted) {
    await executor.query(
      `UPDATE core.settlement_requests SET state = 'SUBMITTED', submitted_at = COALESCE(submitted_at, $2),
         settled_at = NULL WHERE request_id = $1 AND state <> 'QUARANTINED'`,
      [requestId, now],
    );
  }
}

async function addTransition(
  executor: SqlExecutor,
  transfer: TransferRow,
  type: 'SUBMITTED' | 'SETTLED' | 'EXECUTION_REVERSED' | 'FINALITY_REVERSED',
  journalId: string,
  now: Date,
) {
  await executor.query(
    `INSERT INTO core.settlement_request_item_transitions (
       transition_id, request_id, request_item_index, transfer_id,
       transition_sequence, transition_type, journal_id, created_at
     ) VALUES (
       $1,$2,$3,$4,
       (SELECT COALESCE(max(transition_sequence),0) + 1
        FROM core.settlement_request_item_transitions
        WHERE request_id = $2 AND request_item_index = $3),
       $5,$6,$7
     )`,
    [
      `transition:${journalId}`,
      transfer.request_id,
      transfer.request_item_index,
      transfer.transfer_id,
      type,
      journalId,
      now,
    ],
  );
}

function stateMoveLines(
  transfer: TransferRow,
  from: 'REQUESTED' | 'SUBMITTED' | 'SETTLED',
  to: 'REQUESTED' | 'SUBMITTED' | 'SETTLED',
) {
  return [
    {
      account_id: transfer.account_id,
      side: 'DEBIT',
      amount: transfer.amount,
      balance_state: from,
      backing_wallet_address: transfer.executor_wallet,
    },
    {
      account_id: transfer.account_id,
      side: 'CREDIT',
      amount: transfer.amount,
      balance_state: to,
      backing_wallet_address: transfer.executor_wallet,
    },
  ];
}

async function postJournal(executor: SqlExecutor, input: {
  journalId: string;
  eventKey: string;
  eventType: string;
  transfer: TransferRow;
  contentHash: string;
  sourceReferenceHash: string;
  sourceTxHash: string | null;
  sourceBlockHash: string | null;
  lines: ReturnType<typeof stateMoveLines>;
}) {
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14)',
    [
      input.journalId,
      input.eventKey,
      input.eventType,
      'SETTLEMENT_TRANSFER',
      input.transfer.transfer_id,
      input.transfer.order_id,
      Number(input.transfer.policy_version),
      input.contentHash,
      input.sourceTxHash,
      input.sourceBlockHash,
      'EOA_TRANSFER',
      input.sourceReferenceHash,
      JSON.stringify({ transferId: input.transfer.transfer_id }),
      JSON.stringify(input.lines),
    ],
  );
}

async function updateFinality(
  executor: SqlExecutor,
  attemptId: string,
  receipt: EoaSettlementReceipt,
  state: 'MINED' | 'FINAL',
  now: Date,
) {
  await executor.query(
    `UPDATE core.transaction_finality SET receipt_status = $2, block_number = $3,
       block_hash = $4, confirmations = $5, state = $6, evidence = $7::jsonb,
       finalized_at = CASE WHEN $6 = 'FINAL' THEN $8::timestamptz ELSE NULL END,
       updated_at = $8::timestamptz
     WHERE transaction_id = $1`,
    [
      `settlement-finality:${attemptId}`,
      receipt.receiptStatus,
      receipt.blockNumber,
      receipt.blockHash,
      receipt.confirmations,
      state,
      JSON.stringify({ receiptEvidenceHash: receipt.evidenceHash }),
      now,
    ],
  );
}

async function enqueueTransferAudit(executor: SqlExecutor, input: {
  transfer: TransferRow;
  eventType: string;
  evidenceProfile: 'CHAIN_OBSERVED' | 'CHAIN_FINAL' | 'SYSTEM';
  evidenceHash: string;
  txHash?: string;
  blockHash?: string;
  confirmations?: number;
  at: Date;
}) {
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId(`audit:${input.eventType}`, {
      transferId: input.transfer.transfer_id,
      evidenceHash: input.evidenceHash,
    }),
    streamName: 'financial',
    evidenceProfile: input.evidenceProfile,
    eventType: input.eventType,
    resourceType: 'SETTLEMENT_TRANSFER',
    resourceId: input.transfer.transfer_id,
    ...(input.transfer.merchant_id ? { merchantId: input.transfer.merchant_id } : {}),
    actorWallet: input.transfer.executor_wallet,
    actorRole: 'EXECUTOR',
    correlationId: `settlement-transfer:${input.transfer.transfer_id}`,
    requestHash: input.transfer.content_hash.slice(2),
    payload: {
      requestId: input.transfer.request_id,
      orderId: input.transfer.order_id,
      asset: input.transfer.asset,
      recipientAddress: input.transfer.recipient_address,
      amount: input.transfer.amount,
      executorNonce: input.transfer.executor_nonce,
      evidenceHash: input.evidenceHash,
    },
    ...(input.txHash
      ? {
        transactionEvidence: {
          chainId: 56,
          txHash: input.txHash,
          contractAddress: input.transfer.token_address,
          selector: input.transfer.transfer_calldata.slice(0, 10),
          calldataHash: keccak256(input.transfer.transfer_calldata),
          resourceId: input.transfer.transfer_id,
          policyVersion: Number(input.transfer.policy_version),
          ...(input.blockHash ? { blockHash: input.blockHash } : {}),
          confirmations: input.confirmations ?? 0,
        },
      }
      : {}),
    createdAt: input.at,
  });
}

function address(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
}

function positiveInteger(value: string, name: string) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new CoreError('ExternalBlocked', `${name} is unavailable`, 503);
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isDeterministicSettlementExecutorRejection(error: unknown) {
  return error instanceof CoreError
    && error.details.deterministicExecutorFailure === true
    && typeof error.details.executorErrorCode === 'string'
    && deterministicEoaSettlementExecutorErrorCodes.includes(
      error.details.executorErrorCode as DeterministicEoaSettlementExecutorErrorCode,
    );
}

function settlementSubmissionFailureEvidence(error: unknown, disposition: 'RETRYABLE' | 'QUARANTINED') {
  return {
    disposition,
    name: errorName(error),
    coreCode: error instanceof CoreError ? error.code : null,
    executorErrorCode: error instanceof CoreError && typeof error.details.executorErrorCode === 'string'
      ? error.details.executorErrorCode
      : null,
    deterministicExecutorFailure: isDeterministicSettlementExecutorRejection(error),
  };
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'UnknownError';
}
