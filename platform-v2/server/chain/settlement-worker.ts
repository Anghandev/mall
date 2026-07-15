import { randomUUID } from 'node:crypto';
import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { REQUIRED_CONFIRMATIONS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from '../data/audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';
import type { SafeRuntimeEvidence } from '../data/settlement-service.ts';
import {
  assertSafeSettlementBatch,
  buildSafeSettlementBatch,
  type SafeSettlementBatch,
  type SettlementTransferItem,
} from './safe-multisend.ts';

const SAFE_INTERFACE = new Interface([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) returns (bool success)',
]);

interface BatchRow {
  batch_id: string;
  artifact_version: string;
  asset: 'USDT' | 'NPL';
  asset_address: string;
  safe_address: string;
  safe_version: string;
  safe_singleton_address: string;
  safe_singleton_code_hash: string;
  safe_nonce: string;
  multisend_address: string;
  multisend_code_hash: string;
  token_code_hash: string;
  token_transfer_conformance_evidence_hash: string;
  item_count: number;
  total_amount: string;
  items_hash: string;
  content_hash: string;
  multisend_transactions: string;
  multisend_calldata: string;
  safe_tx_data: string;
  safe_tx_hash: string;
  state: string;
  approval_threshold: number;
  owner_set_hash: string;
  packed_signatures: string | null;
}

interface BatchItemRow {
  item_index: number;
  request_id: string;
  request_item_index: number;
  order_id: string;
  account_id: string;
  recipient_address: string;
  token_address: string;
  amount: string;
  transfer_calldata: string;
  item_hash: string;
  policy_version: string | number;
  merchant_id: string | null;
}

type LoadedBatch = { row: BatchRow; items: BatchItemRow[] };

export interface VerifiedSafeApprovals {
  safeAddress: string;
  safeTxHash: string;
  ownerSetHash: string;
  threshold: number;
  proposalReferenceHash: string;
  approvalEvidenceHash: string;
  packedSignatures: string;
  approvals: readonly { ownerAddress: string; signature: string }[];
}

export interface SafeApprovalVerifier {
  verify(input: {
    batchId: string;
    safeAddress: string;
    safeTxHash: string;
    signingData: string;
    ownerSetHash: string;
    threshold: number;
  }): Promise<VerifiedSafeApprovals>;
}

interface SafeSettlementSubmissionInput {
  chainId: 56;
  batchId: string;
  safeAddress: string;
  safeNonce: string;
  safeTxHash: string;
  contentHash: string;
  execTransactionCalldata: string;
  requestDigest: string;
  idempotencyKey: string;
  outerGasLimit: string;
}

interface SafeSettlementSubmission {
  executionTxHash: string;
  outerSender: string;
  outerNonce: string;
  requestDigest: string;
}

export interface SafeSettlementBroadcaster {
  submit(input: SafeSettlementSubmissionInput): Promise<SafeSettlementSubmission>;
  replace(input: SafeSettlementSubmissionInput & {
    replacementForAttemptId: string;
    replacementForExecutionTxHash: string;
    outerSender: string;
    outerNonce: string;
  }): Promise<SafeSettlementSubmission & { replacementForExecutionTxHash: string }>;
}

export interface SafeSettlementReceipt {
  chainId: 56;
  executionTxHash: string;
  transactionTo: string;
  transactionCalldata: string;
  outerSender: string;
  outerNonce: string;
  receiptStatus: 0 | 1;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  canonicalBlock: boolean;
  executionSuccessSafeTxHash?: string;
  executionFailureSafeTxHash?: string;
  safeNonceAfter: string;
  transfers: readonly { tokenAddress: string; from: string; to: string; amount: string }[];
  transactionDeltas: readonly { tokenAddress: string; account: string; delta: string }[];
  evidenceHash: string;
}

export interface SafeSettlementChainSource {
  receipt(executionTxHash: string): Promise<SafeSettlementReceipt | undefined>;
  canonicalBlock(input: { blockNumber: number; blockHash: string }): Promise<{
    canonical: boolean;
    observedBlockHash: string;
    evidenceHash: string;
  }>;
}

interface SettlementBatchService {
  createBatch(
    actor: { walletAddress: string; roles: readonly ['OPERATOR'] },
    input: {
      asset: 'USDT' | 'NPL';
      idempotencyKey: string;
      runtime: SafeRuntimeEvidence;
      correlationId: string;
    },
  ): Promise<unknown>;
}

export class SettlementBatchScheduler {
  readonly #service: SettlementBatchService;
  readonly #platformWallet: string;
  readonly #targets: readonly { asset: 'USDT' | 'NPL'; attest(): Promise<SafeRuntimeEvidence> }[];
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #running = false;

  constructor(input: {
    service: SettlementBatchService;
    platformWallet: string;
    targets: readonly { asset: 'USDT' | 'NPL'; attest(): Promise<SafeRuntimeEvidence> }[];
  }) {
    this.#service = input.service;
    this.#platformWallet = normalizedAddress(input.platformWallet, 'platform wallet');
    this.#targets = input.targets;
  }

  async pollOnce() {
    let created = 0;
    for (const target of this.#targets) {
      const runtime = await target.attest();
      try {
        await this.#service.createBatch(
          { walletAddress: this.#platformWallet, roles: ['OPERATOR'] },
          {
            asset: target.asset,
            idempotencyKey: `safe-batch:${runtime.safeAddress}:${runtime.safeNonce}`,
            runtime,
            correlationId: `settlement-batch:${runtime.safeAddress}:${runtime.safeNonce}`,
          },
        );
        created += 1;
      } catch (error) {
        if (error instanceof CoreError && ['FinalityPending', 'BreakerActive'].includes(error.code)) continue;
        throw error;
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
  readonly #approvals: SafeApprovalVerifier;
  readonly #broadcaster: SafeSettlementBroadcaster;
  readonly #chain: SafeSettlementChainSource;
  readonly #runtimeAttest: (safeAddress: string) => Promise<SafeRuntimeEvidence>;
  readonly #outerGasLimit: string;
  readonly #replacementDelayMs: number;
  readonly #clock: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #running = false;

  constructor(input: {
    transactions: SqlTransactionRunner;
    approvals: SafeApprovalVerifier;
    broadcaster: SafeSettlementBroadcaster;
    chain: SafeSettlementChainSource;
    runtimeAttest: (safeAddress: string) => Promise<SafeRuntimeEvidence>;
    outerGasLimit: string;
    replacementDelayMs?: number;
    clock?: () => Date;
  }) {
    if (!/^[1-9][0-9]*$/.test(input.outerGasLimit)) {
      throw new CoreError('ExternalBlocked', 'Safe outer gas limit is unavailable', 503);
    }
    if (!Number.isSafeInteger(input.replacementDelayMs ?? 300_000) || (input.replacementDelayMs ?? 300_000) <= 0) {
      throw new CoreError('ExternalBlocked', 'Safe replacement delay is unavailable', 503);
    }
    this.#transactions = input.transactions;
    this.#approvals = input.approvals;
    this.#broadcaster = input.broadcaster;
    this.#chain = input.chain;
    this.#runtimeAttest = input.runtimeAttest;
    this.#outerGasLimit = input.outerGasLimit;
    this.#replacementDelayMs = input.replacementDelayMs ?? 300_000;
    this.#clock = input.clock ?? (() => new Date());
  }

  async pollOnce() {
    const approved = await this.approveOnce();
    const recovered = await this.recoverExpiredLeaseOnce();
    const submitted = await this.submitOnce();
    const finalized = await this.pollFinalityOnce();
    const reconciled = await this.reconcileSettledCanonicalityOnce();
    const replaced = await this.replaceOnce();
    return { approved, recovered, submitted, finalized, reconciled, replaced };
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

  async approveOnce() {
    const candidate = await this.#transactions.transaction(async (executor) => {
      const result = await executor.query<{ batch_id: string }>(
        `SELECT batch_id FROM core.settlement_batches
         WHERE state = 'APPROVAL_PENDING' ORDER BY created_at, batch_id LIMIT 1`,
      );
      if (!result.rows[0]) return undefined;
      return loadBatch(executor, result.rows[0].batch_id);
    });
    if (!candidate) return 0;
    const verified = validateApprovals(
      await this.#approvals.verify({
        batchId: candidate.row.batch_id,
        safeAddress: candidate.row.safe_address,
        safeTxHash: candidate.row.safe_tx_hash,
        signingData: assertPersistedBatch(candidate).signingData,
        ownerSetHash: candidate.row.owner_set_hash,
        threshold: candidate.row.approval_threshold,
      }),
      candidate.row,
    );
    await this.#transactions.transaction(async (executor) => {
      const batch = await loadBatchRow(executor, candidate.row.batch_id, true);
      if (batch.state === 'APPROVED') return;
      if (batch.state !== 'APPROVAL_PENDING') {
        throw new CoreError('UnknownState', 'Settlement batch is no longer awaiting approvals', 409);
      }
      for (const approval of verified.approvals) {
        await executor.query(
          `INSERT INTO core.settlement_batch_approvals (
             batch_id, owner_address, safe_tx_hash, signature, signature_hash, approved_at
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            batch.batch_id,
            approval.ownerAddress,
            batch.safe_tx_hash,
            approval.signature,
            keccak256(approval.signature).toLowerCase(),
            this.#clock(),
          ],
        );
      }
      await executor.query(
        `UPDATE core.settlement_batches SET state = 'APPROVED', approved_at = $2,
           proposal_reference_hash = $3, approval_evidence_hash = $4, packed_signatures = $5
         WHERE batch_id = $1 AND state = 'APPROVAL_PENDING'`,
        [
          batch.batch_id,
          this.#clock(),
          verified.proposalReferenceHash,
          verified.approvalEvidenceHash,
          verified.packedSignatures,
        ],
      );
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
         ) VALUES ($1,'SETTLEMENT_BATCH',$2,'SettlementBatchApproved',$3,$1,'PENDING')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          `outbox:settlement-approved:${batch.batch_id}`,
          batch.batch_id,
          JSON.stringify({ batchId: batch.batch_id, safeTxHash: batch.safe_tx_hash }),
        ],
      );
      await enqueueSettlementApprovalAudit(executor, batch, verified, this.#clock());
    });
    return 1;
  }

  async submitOnce() {
    const leased = await this.#transactions.transaction(async (executor) => {
      const selected = await executor.query<{ batch_id: string }>(
        `SELECT batch_id FROM core.settlement_batches
         WHERE state = 'APPROVED' ORDER BY approved_at, batch_id
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!selected.rows[0]) return undefined;
      const loaded = await loadBatch(executor, selected.rows[0].batch_id);
      if (!loaded.row.packed_signatures) {
        throw new CoreError('InvalidFinality', 'Approved Safe batch has no verified signatures', 409);
      }
      const batch = assertPersistedBatch(loaded);
      const execTransactionCalldata = encodeExecTransaction(batch, loaded.row.packed_signatures);
      const requestDigest = hashJson({
        chainId: 56,
        batchId: batch.batchId,
        safeAddress: batch.safeAddress,
        safeNonce: batch.safeNonce,
        safeTxHash: batch.safeTxHash,
        contentHash: batch.contentHash,
        execTransactionCalldata,
        outerGasLimit: this.#outerGasLimit,
      });
      const count = await executor.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM core.settlement_execution_attempts WHERE batch_id = $1',
        [batch.batchId],
      );
      const attemptNumber = Number(count.rows[0]?.count ?? '0') + 1;
      const attemptId = `settlement-attempt:${batch.batchId}:${attemptNumber}`;
      const leaseToken = randomUUID();
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.settlement_execution_attempts (
           attempt_id, batch_id, attempt_number, lease_token, request_digest,
           exec_transaction_calldata, safe_tx_hash, state, leased_until, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'LEASED',$8,$9,$9)`,
        [
          attemptId,
          batch.batchId,
          attemptNumber,
          leaseToken,
          requestDigest,
          execTransactionCalldata,
          batch.safeTxHash,
          new Date(now.getTime() + 2 * 60 * 1000),
          now,
        ],
      );
      await executor.query(
        `UPDATE core.settlement_batches SET state = 'SUBMITTING'
         WHERE batch_id = $1 AND state = 'APPROVED'`,
        [batch.batchId],
      );
      return { batch, loaded, runtimeRow: loaded.row, attemptId, leaseToken, requestDigest, execTransactionCalldata };
    });
    if (!leased) return 0;

    let broadcastAttempted = false;
    try {
      assertCurrentRuntime(leased.runtimeRow, await this.#runtimeAttest(leased.batch.safeAddress));
      broadcastAttempted = true;
      const submitted = await this.#broadcaster.submit({
        chainId: 56,
        batchId: leased.batch.batchId,
        safeAddress: leased.batch.safeAddress,
        safeNonce: leased.batch.safeNonce,
        safeTxHash: leased.batch.safeTxHash,
        contentHash: leased.batch.contentHash,
        execTransactionCalldata: leased.execTransactionCalldata,
        requestDigest: leased.requestDigest,
        idempotencyKey: leased.attemptId,
        outerGasLimit: this.#outerGasLimit,
      });
      validateSubmission(submitted, leased.requestDigest);
      await this.#transactions.transaction(async (executor) => {
        const attempt = await executor.query<{ state: string; lease_token: string }>(
          `SELECT state, lease_token FROM core.settlement_execution_attempts
           WHERE attempt_id = $1 FOR UPDATE`,
          [leased.attemptId],
        );
        if (attempt.rows[0]?.state !== 'LEASED' || attempt.rows[0].lease_token !== leased.leaseToken) {
          throw new CoreError('IdempotencyConflict', 'Settlement execution lease was superseded', 409);
        }
        const now = this.#clock();
        await executor.query(
          `UPDATE core.settlement_execution_attempts SET state = 'SUBMITTED',
             execution_tx_hash = $2, outer_sender = $3, outer_nonce = $4,
             submitted_at = $5, updated_at = $5 WHERE attempt_id = $1`,
          [
            leased.attemptId,
            submitted.executionTxHash,
            normalizedAddress(submitted.outerSender, 'outer sender'),
            submitted.outerNonce,
            now,
          ],
        );
        await executor.query(
          `UPDATE core.settlement_batches SET state = 'SUBMITTED', submitted_at = $2
           WHERE batch_id = $1 AND state = 'SUBMITTING'`,
          [leased.batch.batchId, now],
        );
        await executor.query(
          `UPDATE core.safe_nonce_reservations SET state = 'SUBMITTED'
           WHERE batch_id = $1 AND state = 'RESERVED'`,
          [leased.batch.batchId],
        );
        await executor.query(
          `INSERT INTO core.transaction_finality (
             transaction_id, resource_type, resource_id, chain_id, contract_address,
             expected_event_hash, tx_hash, confirmations, required_confirmations,
             state, evidence, submitted_at
           ) VALUES ($1,'SETTLEMENT_BATCH',$2,56,$3,$4,$5,0,15,'SUBMITTED',$6,$7)`,
          [
            `settlement:${leased.attemptId}`,
            leased.batch.batchId,
            leased.batch.safeAddress,
            leased.batch.safeTxHash,
            submitted.executionTxHash,
            JSON.stringify({
              safeTxHash: leased.batch.safeTxHash,
              contentHash: leased.batch.contentHash,
              requestDigest: leased.requestDigest,
              outerSender: submitted.outerSender,
              outerNonce: submitted.outerNonce,
            }),
            now,
          ],
        );
        await enqueueSettlementChainAudit(executor, leased.loaded, {
          evidenceProfile: 'CHAIN_OBSERVED',
          eventType: 'SettlementBatchSubmitted',
          attemptId: leased.attemptId,
          executionTxHash: submitted.executionTxHash,
          outerSender: submitted.outerSender,
          outerNonce: submitted.outerNonce,
          execTransactionCalldata: leased.execTransactionCalldata,
          requestHash: leased.requestDigest,
          createdAt: now,
        });
      });
      return 1;
    } catch (error) {
      if (broadcastAttempted) throw error;
      await this.#transactions.transaction(async (executor) => {
        await executor.query(
          `UPDATE core.settlement_execution_attempts SET state = 'QUARANTINED', updated_at = $2
           WHERE attempt_id = $1 AND state = 'LEASED'`,
          [leased.attemptId, this.#clock()],
        );
        await executor.query(
          `UPDATE core.settlement_batches SET state = 'QUARANTINED'
           WHERE batch_id = $1 AND state = 'SUBMITTING'`,
          [leased.batch.batchId],
        );
        await pauseSettlementBatches(executor, `submission:${leased.batch.batchId}`, leased.requestDigest, this.#clock());
        await enqueueSettlementSystemAudit(executor, {
          eventType: 'SettlementSubmissionQuarantined',
          batchId: leased.batch.batchId,
          attemptId: leased.attemptId,
          evidenceHash: leased.requestDigest,
          createdAt: this.#clock(),
        });
      });
      throw error;
    }
  }

  async recoverExpiredLeaseOnce() {
    const candidate = await this.#transactions.transaction(async (executor) => {
      const result = await executor.query<{
        batch_id: string;
        attempt_id: string;
        lease_token: string;
        request_digest: string;
        exec_transaction_calldata: string;
        safe_tx_hash: string;
        replacement_for_attempt_id: string | null;
        previous_execution_tx_hash: string | null;
        previous_outer_sender: string | null;
        previous_outer_nonce: string | null;
      }>(
        `SELECT attempt.batch_id, attempt.attempt_id, attempt.lease_token,
           attempt.request_digest, attempt.exec_transaction_calldata, attempt.safe_tx_hash,
           attempt.replacement_for_attempt_id,
           previous.execution_tx_hash AS previous_execution_tx_hash,
           previous.outer_sender AS previous_outer_sender,
           previous.outer_nonce::text AS previous_outer_nonce
         FROM core.settlement_execution_attempts attempt
         LEFT JOIN core.settlement_execution_attempts previous
           ON previous.attempt_id = attempt.replacement_for_attempt_id
         WHERE attempt.state = 'LEASED' AND attempt.leased_until <= $1
         ORDER BY attempt.leased_until, attempt.attempt_id LIMIT 1`,
        [this.#clock()],
      );
      if (!result.rows[0]) return undefined;
      return { ...result.rows[0], loaded: await loadBatch(executor, result.rows[0].batch_id) };
    });
    if (!candidate) return 0;
    const batch = assertPersistedBatch(candidate.loaded);
    const expectedCalldata = encodeExecTransaction(batch, requiredSignatures(candidate.loaded.row));
    if (
      candidate.safe_tx_hash !== batch.safeTxHash
      || candidate.exec_transaction_calldata.toLowerCase() !== expectedCalldata.toLowerCase()
    ) throw new CoreError('InvalidFinality', 'Expired settlement lease changed the immutable Safe envelope', 409);
    const envelope = {
      chainId: 56 as const,
      batchId: batch.batchId,
      safeAddress: batch.safeAddress,
      safeNonce: batch.safeNonce,
      safeTxHash: batch.safeTxHash,
      contentHash: batch.contentHash,
      execTransactionCalldata: candidate.exec_transaction_calldata,
      requestDigest: candidate.request_digest,
      idempotencyKey: candidate.attempt_id,
      outerGasLimit: this.#outerGasLimit,
    };
    assertCurrentRuntime(candidate.loaded.row, await this.#runtimeAttest(batch.safeAddress));
    const replacement = candidate.replacement_for_attempt_id !== null;
    const submitted = replacement
      ? await this.#broadcaster.replace({
        ...envelope,
        replacementForAttemptId: candidate.replacement_for_attempt_id!,
        replacementForExecutionTxHash: requiredValue(
          candidate.previous_execution_tx_hash,
          'replacement execution transaction',
        ),
        outerSender: requiredValue(candidate.previous_outer_sender, 'replacement outer sender'),
        outerNonce: requiredValue(candidate.previous_outer_nonce, 'replacement outer nonce'),
      })
      : await this.#broadcaster.submit(envelope);
    if (replacement) {
      validateReplacementSubmission(
        submitted as Awaited<ReturnType<SafeSettlementBroadcaster['replace']>>,
        {
          requestDigest: candidate.request_digest,
          replacementForExecutionTxHash: candidate.previous_execution_tx_hash!,
          outerSender: candidate.previous_outer_sender!,
          outerNonce: candidate.previous_outer_nonce!,
        },
      );
    } else {
      validateSubmission(submitted, candidate.request_digest);
    }
    await this.#transactions.transaction(async (executor) => {
      const attempt = await executor.query<{ state: string; lease_token: string }>(
        `SELECT state, lease_token FROM core.settlement_execution_attempts
         WHERE attempt_id = $1 FOR UPDATE`,
        [candidate.attempt_id],
      );
      if (attempt.rows[0]?.state !== 'LEASED' || attempt.rows[0].lease_token !== candidate.lease_token) {
        throw new CoreError('IdempotencyConflict', 'Expired settlement lease was superseded', 409);
      }
      const now = this.#clock();
      await executor.query(
        `UPDATE core.settlement_execution_attempts SET state = 'SUBMITTED',
           execution_tx_hash = $2, outer_sender = $3, outer_nonce = $4,
           submitted_at = $5, updated_at = $5 WHERE attempt_id = $1`,
        [
          candidate.attempt_id,
          submitted.executionTxHash,
          normalizedAddress(submitted.outerSender, 'outer sender'),
          submitted.outerNonce,
          now,
        ],
      );
      await executor.query(
        `UPDATE core.settlement_batches SET state = 'SUBMITTED', settled_at = NULL,
           submitted_at = $2 WHERE batch_id = $1 AND state IN ('SUBMITTING','REORGED')`,
        [batch.batchId, now],
      );
      await executor.query(
        `UPDATE core.safe_nonce_reservations SET state = 'SUBMITTED'
         WHERE batch_id = $1 AND state IN ('RESERVED','REORGED')`,
        [batch.batchId],
      );
      if (replacement) {
        await executor.query(
          `UPDATE core.transaction_finality SET state = 'REPLACED', updated_at = $2
           WHERE transaction_id = $1 AND state IN ('SUBMITTED','MINED','REORGED')`,
          [`settlement:${candidate.replacement_for_attempt_id}`, now],
        );
      }
      await executor.query(
        `INSERT INTO core.transaction_finality (
           transaction_id, resource_type, resource_id, chain_id, contract_address,
           expected_event_hash, tx_hash, replacement_for_tx_hash, confirmations,
           required_confirmations, state, evidence, submitted_at
         ) VALUES ($1,'SETTLEMENT_BATCH',$2,56,$3,$4,$5,$6,0,15,'SUBMITTED',$7,$8)`,
        [
          `settlement:${candidate.attempt_id}`,
          batch.batchId,
          batch.safeAddress,
          batch.safeTxHash,
          submitted.executionTxHash,
          replacement ? candidate.previous_execution_tx_hash : null,
          JSON.stringify({
            safeTxHash: batch.safeTxHash,
            contentHash: batch.contentHash,
            requestDigest: candidate.request_digest,
            outerSender: submitted.outerSender,
            outerNonce: submitted.outerNonce,
            recoveredExpiredLease: true,
            ...(replacement
              ? {
                replacementForAttemptId: candidate.replacement_for_attempt_id,
                replacementForExecutionTxHash: candidate.previous_execution_tx_hash,
              }
              : {}),
          }),
          now,
        ],
      );
      await enqueueSettlementChainAudit(executor, candidate.loaded, {
        evidenceProfile: 'CHAIN_OBSERVED',
        eventType: replacement ? 'SettlementBatchReplaced' : 'SettlementBatchSubmitted',
        attemptId: candidate.attempt_id,
        executionTxHash: submitted.executionTxHash,
        outerSender: submitted.outerSender,
        outerNonce: submitted.outerNonce,
        execTransactionCalldata: candidate.exec_transaction_calldata,
        requestHash: candidate.request_digest,
        ...(replacement ? { replacementForTxHash: candidate.previous_execution_tx_hash! } : {}),
        payload: { recoveredExpiredLease: true },
        createdAt: now,
      });
    });
    return 1;
  }

  async replaceOnce() {
    const cutoff = new Date(this.#clock().getTime() - this.#replacementDelayMs);
    const candidate = await this.#transactions.transaction(async (executor) => {
      const result = await executor.query<{
        batch_id: string;
        attempt_id: string;
        attempt_number: number;
        request_digest: string;
        exec_transaction_calldata: string;
        safe_tx_hash: string;
        execution_tx_hash: string;
        outer_sender: string;
        outer_nonce: string;
      }>(
        `SELECT attempt.batch_id, attempt.attempt_id, attempt.attempt_number,
           attempt.request_digest, attempt.exec_transaction_calldata, attempt.safe_tx_hash,
           attempt.execution_tx_hash, attempt.outer_sender, attempt.outer_nonce::text
         FROM core.settlement_execution_attempts attempt
         JOIN core.settlement_batches batch ON batch.batch_id = attempt.batch_id
         WHERE batch.state IN ('SUBMITTED','MINED','REORGED')
           AND attempt.state IN ('SUBMITTED','MINED','REORGED')
           AND attempt.submitted_at <= $1
           AND attempt.execution_tx_hash IS NOT NULL
           AND attempt.outer_sender IS NOT NULL
           AND attempt.outer_nonce IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM core.settlement_execution_attempts newer
             WHERE newer.batch_id = attempt.batch_id
               AND newer.attempt_number > attempt.attempt_number
           )
         ORDER BY attempt.submitted_at, attempt.batch_id LIMIT 1`,
        [cutoff],
      );
      if (!result.rows[0]) return undefined;
      return { ...result.rows[0], loaded: await loadBatch(executor, result.rows[0].batch_id) };
    });
    if (!candidate) return 0;
    if (await this.#chain.receipt(candidate.execution_tx_hash)) return 0;

    const leased = await this.#transactions.transaction(async (executor) => {
      const previous = await executor.query<typeof candidate>(
        `SELECT batch_id, attempt_id, attempt_number, request_digest,
           exec_transaction_calldata, safe_tx_hash, execution_tx_hash,
           outer_sender, outer_nonce::text
         FROM core.settlement_execution_attempts
         WHERE attempt_id = $1 AND state IN ('SUBMITTED','MINED','REORGED') FOR UPDATE`,
        [candidate.attempt_id],
      );
      const current = previous.rows[0];
      if (
        !current
        || current.execution_tx_hash !== candidate.execution_tx_hash
        || current.outer_sender !== candidate.outer_sender
        || current.outer_nonce !== candidate.outer_nonce
      ) return undefined;
      const newer = await executor.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM core.settlement_execution_attempts
         WHERE batch_id = $1 AND attempt_number > $2`,
        [candidate.batch_id, candidate.attempt_number],
      );
      if (newer.rows[0]?.count !== '0') return undefined;
      const batch = assertPersistedBatch(candidate.loaded);
      const expectedCalldata = encodeExecTransaction(batch, requiredSignatures(candidate.loaded.row));
      if (
        current.request_digest !== candidate.request_digest
        || current.safe_tx_hash !== batch.safeTxHash
        || current.exec_transaction_calldata.toLowerCase() !== expectedCalldata.toLowerCase()
      ) throw new CoreError('InvalidFinality', 'Replacement source does not match the immutable Safe envelope', 409);
      const attemptNumber = candidate.attempt_number + 1;
      const attemptId = `settlement-attempt:${batch.batchId}:${attemptNumber}`;
      const leaseToken = randomUUID();
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.settlement_execution_attempts (
           attempt_id, batch_id, attempt_number, lease_token, request_digest,
           exec_transaction_calldata, safe_tx_hash, outer_sender, outer_nonce,
           replacement_for_attempt_id, state, leased_until, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'LEASED',$11,$12,$12)`,
        [
          attemptId,
          batch.batchId,
          attemptNumber,
          leaseToken,
          current.request_digest,
          current.exec_transaction_calldata,
          current.safe_tx_hash,
          current.outer_sender,
          current.outer_nonce,
          current.attempt_id,
          new Date(now.getTime() + 2 * 60 * 1000),
          now,
        ],
      );
      return {
        batch,
        loaded: candidate.loaded,
        runtimeRow: candidate.loaded.row,
        attemptId,
        leaseToken,
        requestDigest: current.request_digest,
        execTransactionCalldata: current.exec_transaction_calldata,
        replacementForAttemptId: current.attempt_id,
        replacementForExecutionTxHash: current.execution_tx_hash,
        outerSender: current.outer_sender,
        outerNonce: current.outer_nonce,
      };
    });
    if (!leased) return 0;

    let broadcastAttempted = false;
    try {
      assertCurrentRuntime(leased.runtimeRow, await this.#runtimeAttest(leased.batch.safeAddress));
      broadcastAttempted = true;
      const submitted = await this.#broadcaster.replace({
        chainId: 56,
        batchId: leased.batch.batchId,
        safeAddress: leased.batch.safeAddress,
        safeNonce: leased.batch.safeNonce,
        safeTxHash: leased.batch.safeTxHash,
        contentHash: leased.batch.contentHash,
        execTransactionCalldata: leased.execTransactionCalldata,
        requestDigest: leased.requestDigest,
        idempotencyKey: leased.attemptId,
        outerGasLimit: this.#outerGasLimit,
        replacementForAttemptId: leased.replacementForAttemptId,
        replacementForExecutionTxHash: leased.replacementForExecutionTxHash,
        outerSender: leased.outerSender,
        outerNonce: leased.outerNonce,
      });
      validateReplacementSubmission(submitted, leased);
      await this.#transactions.transaction(async (executor) => {
        const attempt = await executor.query<{ state: string; lease_token: string }>(
          `SELECT state, lease_token FROM core.settlement_execution_attempts
           WHERE attempt_id = $1 FOR UPDATE`,
          [leased.attemptId],
        );
        if (attempt.rows[0]?.state !== 'LEASED' || attempt.rows[0].lease_token !== leased.leaseToken) {
          throw new CoreError('IdempotencyConflict', 'Settlement replacement lease was superseded', 409);
        }
        const now = this.#clock();
        await executor.query(
          `UPDATE core.settlement_execution_attempts SET state = 'SUBMITTED',
             execution_tx_hash = $2, submitted_at = $3, updated_at = $3
           WHERE attempt_id = $1`,
          [leased.attemptId, submitted.executionTxHash, now],
        );
        await executor.query(
          `UPDATE core.transaction_finality SET state = 'REPLACED', updated_at = $2
           WHERE transaction_id = $1 AND state IN ('SUBMITTED','MINED','REORGED')`,
          [`settlement:${leased.replacementForAttemptId}`, now],
        );
        await executor.query(
          `UPDATE core.settlement_batches SET state = 'SUBMITTED', settled_at = NULL,
             submitted_at = $2 WHERE batch_id = $1 AND state = 'REORGED'`,
          [leased.batch.batchId, now],
        );
        await executor.query(
          `UPDATE core.safe_nonce_reservations SET state = 'SUBMITTED'
           WHERE batch_id = $1 AND state = 'REORGED'`,
          [leased.batch.batchId],
        );
        await executor.query(
          `INSERT INTO core.transaction_finality (
             transaction_id, resource_type, resource_id, chain_id, contract_address,
             expected_event_hash, tx_hash, replacement_for_tx_hash, confirmations,
             required_confirmations, state, evidence, submitted_at
           ) VALUES ($1,'SETTLEMENT_BATCH',$2,56,$3,$4,$5,$6,0,15,'SUBMITTED',$7,$8)`,
          [
            `settlement:${leased.attemptId}`,
            leased.batch.batchId,
            leased.batch.safeAddress,
            leased.batch.safeTxHash,
            submitted.executionTxHash,
            leased.replacementForExecutionTxHash,
            JSON.stringify({
              safeTxHash: leased.batch.safeTxHash,
              contentHash: leased.batch.contentHash,
              requestDigest: leased.requestDigest,
              outerSender: leased.outerSender,
              outerNonce: leased.outerNonce,
              replacementForAttemptId: leased.replacementForAttemptId,
              replacementForExecutionTxHash: leased.replacementForExecutionTxHash,
            }),
            now,
          ],
        );
        await enqueueSettlementChainAudit(executor, leased.loaded, {
          evidenceProfile: 'CHAIN_OBSERVED',
          eventType: 'SettlementBatchReplaced',
          attemptId: leased.attemptId,
          executionTxHash: submitted.executionTxHash,
          outerSender: submitted.outerSender,
          outerNonce: submitted.outerNonce,
          execTransactionCalldata: leased.execTransactionCalldata,
          requestHash: leased.requestDigest,
          replacementForTxHash: leased.replacementForExecutionTxHash,
          createdAt: now,
        });
      });
      return 1;
    } catch (error) {
      if (broadcastAttempted) throw error;
      await this.#transactions.transaction(async (executor) => {
        await executor.query(
          `UPDATE core.settlement_execution_attempts SET state = 'QUARANTINED', updated_at = $2
           WHERE attempt_id = $1 AND state = 'LEASED'`,
          [leased.attemptId, this.#clock()],
        );
        await pauseSettlementBatches(
          executor,
          `replacement:${leased.batch.batchId}`,
          leased.requestDigest,
          this.#clock(),
        );
        await enqueueSettlementSystemAudit(executor, {
          eventType: 'SettlementReplacementQuarantined',
          batchId: leased.batch.batchId,
          attemptId: leased.attemptId,
          evidenceHash: leased.requestDigest,
          createdAt: this.#clock(),
        });
      });
      throw error;
    }
  }

  async pollFinalityOnce() {
    const candidate = await this.#transactions.transaction(async (executor) => {
      const batchResult = await executor.query<{ batch_id: string }>(
        `SELECT batch.batch_id
         FROM core.settlement_batches batch
         WHERE batch.state IN ('SUBMITTED','MINED')
           AND EXISTS (
             SELECT 1 FROM core.settlement_execution_attempts attempt
             WHERE attempt.batch_id = batch.batch_id
               AND attempt.state IN ('SUBMITTED','MINED')
               AND attempt.execution_tx_hash IS NOT NULL
           )
         ORDER BY batch.submitted_at, batch.batch_id LIMIT 1`,
      );
      const batchId = batchResult.rows[0]?.batch_id;
      if (!batchId) return undefined;
      const attempts = await executor.query<{
        batch_id: string;
        attempt_id: string;
        execution_tx_hash: string;
        outer_sender: string;
        outer_nonce: string;
        replacement_for_tx_hash: string | null;
      }>(
        `SELECT attempt.batch_id, attempt.attempt_id, attempt.execution_tx_hash,
           attempt.outer_sender, attempt.outer_nonce::text, finality.replacement_for_tx_hash
         FROM core.settlement_execution_attempts attempt
         JOIN core.transaction_finality finality
           ON finality.transaction_id = 'settlement:' || attempt.attempt_id
         WHERE attempt.batch_id = $1 AND attempt.state IN ('SUBMITTED','MINED')
           AND attempt.execution_tx_hash IS NOT NULL
         ORDER BY attempt.attempt_number DESC`,
        [batchId],
      );
      return { attempts: attempts.rows, loaded: await loadBatch(executor, batchId) };
    });
    if (!candidate) return 0;
    const batch = assertPersistedBatch(candidate.loaded);
    const expectedCalldata = encodeExecTransaction(batch, requiredSignatures(candidate.loaded.row));
    let observed:
      | { attempt: (typeof candidate.attempts)[number]; receipt: SafeSettlementReceipt }
      | undefined;
    for (const attempt of candidate.attempts) {
      const receipt = await this.#chain.receipt(attempt.execution_tx_hash);
      if (receipt) {
        observed = { attempt, receipt };
        break;
      }
    }
    if (!observed) return 0;
    const attempt = observed.attempt;
    const receipt = observed.receipt;
    try {
      validateReceipt(batch, expectedCalldata, attempt, receipt);
    } catch (error) {
      await this.#transactions.transaction(async (executor) => {
        await quarantineFinality(executor, candidate.loaded, attempt, receipt, expectedCalldata, false, this.#clock());
      });
      throw error;
    }

    if (!receipt.canonicalBlock) {
      await this.#transactions.transaction(async (executor) => {
        await executor.query(
          `UPDATE core.settlement_batches SET state = 'REORGED' WHERE batch_id = $1`,
          [batch.batchId],
        );
        await executor.query(
          `UPDATE core.settlement_execution_attempts SET state = 'REORGED', updated_at = $2
           WHERE attempt_id = $1`,
          [attempt.attempt_id, this.#clock()],
        );
        await executor.query(
          `UPDATE core.transaction_finality SET state = 'REORGED', block_number = $2,
             block_hash = $3, confirmations = $4, evidence = $5, updated_at = $6
           WHERE transaction_id = $1`,
          [
            `settlement:${attempt.attempt_id}`,
            receipt.blockNumber,
            receipt.blockHash,
            receipt.confirmations,
            JSON.stringify(receipt),
            this.#clock(),
          ],
        );
        await executor.query(
          `UPDATE core.safe_nonce_reservations SET state = 'REORGED' WHERE batch_id = $1`,
          [batch.batchId],
        );
        await pauseSettlementBatches(executor, `reorg:${batch.batchId}`, receipt.evidenceHash, this.#clock());
        await enqueueSettlementChainAudit(executor, candidate.loaded, {
          evidenceProfile: 'CHAIN_OBSERVED',
          eventType: 'SettlementBatchReorged',
          attemptId: attempt.attempt_id,
          executionTxHash: attempt.execution_tx_hash,
          outerSender: attempt.outer_sender,
          outerNonce: attempt.outer_nonce,
          execTransactionCalldata: expectedCalldata,
          requestHash: hashJson(receipt),
          ...(attempt.replacement_for_tx_hash
            ? { replacementForTxHash: attempt.replacement_for_tx_hash }
            : {}),
          blockHash: receipt.blockHash,
          confirmations: receipt.confirmations,
          payload: { canonical: false, receiptEvidenceHash: receipt.evidenceHash },
          createdAt: this.#clock(),
        });
      });
      return 1;
    }

    if (receipt.confirmations < REQUIRED_CONFIRMATIONS) {
      await this.#transactions.transaction(async (executor) => {
        await executor.query(
          `UPDATE core.settlement_batches SET state = 'MINED' WHERE batch_id = $1`,
          [batch.batchId],
        );
        await executor.query(
          `UPDATE core.settlement_execution_attempts SET state = 'MINED', updated_at = $2
           WHERE attempt_id = $1`,
          [attempt.attempt_id, this.#clock()],
        );
        await executor.query(
          `UPDATE core.transaction_finality SET state = 'MINED', receipt_status = $2,
             block_number = $3, block_hash = $4, confirmations = $5, evidence = $6,
             updated_at = $7 WHERE transaction_id = $1`,
          [
            `settlement:${attempt.attempt_id}`,
            receipt.receiptStatus,
            receipt.blockNumber,
            receipt.blockHash,
            receipt.confirmations,
            JSON.stringify(receipt),
            this.#clock(),
          ],
        );
        await enqueueSettlementChainAudit(executor, candidate.loaded, {
          evidenceProfile: 'CHAIN_OBSERVED',
          eventType: 'SettlementBatchMined',
          attemptId: attempt.attempt_id,
          executionTxHash: attempt.execution_tx_hash,
          outerSender: attempt.outer_sender,
          outerNonce: attempt.outer_nonce,
          execTransactionCalldata: expectedCalldata,
          requestHash: hashJson(receipt),
          ...(attempt.replacement_for_tx_hash
            ? { replacementForTxHash: attempt.replacement_for_tx_hash }
            : {}),
          blockHash: receipt.blockHash,
          confirmations: receipt.confirmations,
          payload: { receiptStatus: receipt.receiptStatus, receiptEvidenceHash: receipt.evidenceHash },
          createdAt: this.#clock(),
        });
      });
      return 1;
    }
    if (receipt.receiptStatus !== 1 || receipt.executionFailureSafeTxHash) {
      await this.#transactions.transaction(async (executor) => {
        await quarantineFinality(executor, candidate.loaded, attempt, receipt, expectedCalldata, true, this.#clock());
      });
      return 1;
    }
    await this.#transactions.transaction(async (executor) => {
      await settleBatch(executor, candidate.loaded, attempt.attempt_id, receipt, this.#clock());
    });
    return 1;
  }

  async reconcileSettledCanonicalityOnce() {
    const candidate = await this.#transactions.transaction(async (executor) => {
      const result = await executor.query<{
        batch_id: string;
        attempt_id: string;
        block_number: string;
        block_hash: string;
      }>(
        `SELECT batch.batch_id, attempt.attempt_id,
           finality.block_number::text, finality.block_hash
         FROM core.settlement_batches batch
         JOIN core.settlement_execution_attempts attempt
           ON attempt.batch_id = batch.batch_id AND attempt.state = 'SETTLED'
         JOIN core.transaction_finality finality
           ON finality.transaction_id = 'settlement:' || attempt.attempt_id
         WHERE batch.state = 'SETTLED' AND finality.state = 'FINAL'
           AND finality.block_number IS NOT NULL AND finality.block_hash IS NOT NULL
         ORDER BY finality.updated_at, batch.batch_id LIMIT 1`,
      );
      if (!result.rows[0]) return undefined;
      return { ...result.rows[0], loaded: await loadBatch(executor, result.rows[0].batch_id) };
    });
    if (!candidate) return 0;
    const blockNumber = Number(candidate.block_number);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0 || !isHash(candidate.block_hash)) {
      throw new CoreError('InvalidFinality', 'Persisted settlement block identity is invalid', 409);
    }
    const observation = await this.#chain.canonicalBlock({
      blockNumber,
      blockHash: candidate.block_hash,
    });
    if (!isHash(observation.observedBlockHash) || !isHash(observation.evidenceHash)) {
      throw new CoreError('InvalidFinality', 'Settlement canonicality observation is invalid', 409);
    }
    if (!observation.canonical && observation.observedBlockHash.toLowerCase() === candidate.block_hash.toLowerCase()) {
      throw new CoreError('InvalidFinality', 'Settlement canonicality result contradicts its observed block hash', 409);
    }
    if (observation.canonical) {
      await this.#transactions.transaction(async (executor) => {
        await executor.query(
          `UPDATE core.transaction_finality SET updated_at = $2,
             evidence = evidence || $3::jsonb WHERE transaction_id = $1 AND state = 'FINAL'`,
          [
            `settlement:${candidate.attempt_id}`,
            this.#clock(),
            JSON.stringify({ latestCanonicalityEvidenceHash: observation.evidenceHash }),
          ],
        );
      });
      return 1;
    }
    await this.#transactions.transaction(async (executor) => {
      await reverseSettledBatchFinality(
        executor,
        candidate.loaded,
        candidate.attempt_id,
        candidate.block_hash,
        observation,
        this.#clock(),
      );
    });
    return 1;
  }
}

function validateApprovals(value: VerifiedSafeApprovals, batch: BatchRow) {
  const approvals = value.approvals.map((approval) => ({
    ownerAddress: normalizedAddress(approval.ownerAddress, 'Safe owner'),
    signature: approval.signature,
  })).sort((left, right) => left.ownerAddress.localeCompare(right.ownerAddress));
  if (
    normalizedAddress(value.safeAddress, 'Safe') !== batch.safe_address
    || value.safeTxHash.toLowerCase() !== batch.safe_tx_hash
    || value.ownerSetHash.toLowerCase() !== batch.owner_set_hash
    || value.threshold !== batch.approval_threshold
    || approvals.length < batch.approval_threshold
    || new Set(approvals.map((approval) => approval.ownerAddress)).size !== approvals.length
    || approvals.some((approval) => !/^0x(?:[0-9a-fA-F]{2})+$/.test(approval.signature))
    || !isHash(value.proposalReferenceHash)
    || !isHash(value.approvalEvidenceHash)
    || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.packedSignatures)
  ) throw new CoreError('InvalidSignature', 'Safe approvals do not match the immutable settlement batch', 401);
  return {
    ...value,
    safeAddress: batch.safe_address,
    safeTxHash: batch.safe_tx_hash,
    ownerSetHash: batch.owner_set_hash,
    proposalReferenceHash: value.proposalReferenceHash.toLowerCase(),
    approvalEvidenceHash: value.approvalEvidenceHash.toLowerCase(),
    approvals,
  };
}

function validateSubmission(
  value: Awaited<ReturnType<SafeSettlementBroadcaster['submit']>>,
  expectedDigest: string,
) {
  if (
    !isHash(value.executionTxHash)
    || !/^(0|[1-9][0-9]*)$/.test(value.outerNonce)
    || value.requestDigest.toLowerCase() !== expectedDigest
  ) throw new CoreError('InvalidFinality', 'Safe broadcaster response is not bound to the execution envelope', 502);
  normalizedAddress(value.outerSender, 'outer sender');
}

function validateReplacementSubmission(
  value: Awaited<ReturnType<SafeSettlementBroadcaster['replace']>>,
  expected: {
    requestDigest: string;
    replacementForExecutionTxHash: string;
    outerSender: string;
    outerNonce: string;
  },
) {
  validateSubmission(value, expected.requestDigest);
  if (
    value.replacementForExecutionTxHash.toLowerCase() !== expected.replacementForExecutionTxHash.toLowerCase()
    || normalizedAddress(value.outerSender, 'replacement outer sender') !== expected.outerSender
    || value.outerNonce !== expected.outerNonce
  ) throw new CoreError('InvalidFinality', 'Safe replacement changed sender, nonce or transaction identity', 502);
}

function validateReceipt(
  batch: SafeSettlementBatch,
  expectedCalldata: string,
  attempt: { execution_tx_hash: string; outer_sender: string; outer_nonce: string },
  receipt: SafeSettlementReceipt,
) {
  if (
    receipt.chainId !== 56
    || receipt.executionTxHash.toLowerCase() !== attempt.execution_tx_hash.toLowerCase()
    || normalizedAddress(receipt.transactionTo, 'receipt target') !== batch.safeAddress
    || receipt.transactionCalldata.toLowerCase() !== expectedCalldata.toLowerCase()
    || normalizedAddress(receipt.outerSender, 'outer sender') !== attempt.outer_sender.toLowerCase()
    || receipt.outerNonce !== attempt.outer_nonce
    || !/^(0|[1-9][0-9]*)$/.test(receipt.outerNonce)
    || !Number.isSafeInteger(receipt.blockNumber)
    || receipt.blockNumber < 0
    || !isHash(receipt.blockHash)
    || !Number.isSafeInteger(receipt.confirmations)
    || receipt.confirmations < 0
    || !isHash(receipt.evidenceHash)
    || !/^(0|[1-9][0-9]*)$/.test(receipt.safeNonceAfter)
  ) throw new CoreError('InvalidFinality', 'Safe receipt does not match the immutable execution envelope', 409);
  if (!receipt.canonicalBlock) return;
  if (
    receipt.executionFailureSafeTxHash
    && receipt.executionFailureSafeTxHash.toLowerCase() !== batch.safeTxHash
  ) {
    throw new CoreError('InvalidFinality', 'Safe ExecutionFailure does not match the approved batch', 409);
  }
  if (receipt.receiptStatus !== 1) return;
  if (receipt.executionSuccessSafeTxHash?.toLowerCase() !== batch.safeTxHash) {
    throw new CoreError('InvalidFinality', 'Safe ExecutionSuccess evidence is missing', 409);
  }
  if (BigInt(receipt.safeNonceAfter) < BigInt(batch.safeNonce) + 1n) {
    throw new CoreError('InvalidFinality', 'Safe nonce was not consumed by the approved batch', 409);
  }
  validateTransfers(batch, receipt);
}

function validateTransfers(batch: SafeSettlementBatch, receipt: SafeSettlementReceipt) {
  const expected = batch.items.map((item) => ({
    tokenAddress: item.tokenAddress,
    from: batch.safeAddress,
    to: item.recipientAddress,
    amount: item.amount,
  }));
  const actual = receipt.transfers.map((item) => ({
    tokenAddress: normalizedAddress(item.tokenAddress, 'transfer token'),
    from: normalizedAddress(item.from, 'transfer sender'),
    to: normalizedAddress(item.to, 'transfer recipient'),
    amount: item.amount,
  }));
  if (stableJson(actual) !== stableJson(expected)) {
    throw new CoreError('InvalidFinality', 'Safe transfer logs do not match every batch item', 409);
  }
  const expectedDeltas = new Map<string, bigint>();
  const add = (token: string, account: string, delta: bigint) => {
    const key = `${token}:${account}`;
    expectedDeltas.set(key, (expectedDeltas.get(key) ?? 0n) + delta);
  };
  for (const item of batch.items) {
    add(item.tokenAddress, batch.safeAddress, -BigInt(item.amount));
    add(item.tokenAddress, item.recipientAddress, BigInt(item.amount));
  }
  const actualDeltas = new Map<string, bigint>();
  for (const delta of receipt.transactionDeltas) {
    const token = normalizedAddress(delta.tokenAddress, 'transaction-delta token');
    const account = normalizedAddress(delta.account, 'transaction-delta account');
    if (!/^-?(0|[1-9][0-9]*)$/.test(delta.delta)) {
      throw new CoreError('InvalidFinality', 'Safe transaction delta is invalid', 409);
    }
    const key = `${token}:${account}`;
    actualDeltas.set(key, (actualDeltas.get(key) ?? 0n) + BigInt(delta.delta));
  }
  if (
    expectedDeltas.size !== actualDeltas.size
    || [...expectedDeltas].some(([key, value]) => actualDeltas.get(key) !== value)
  ) throw new CoreError('InvalidFinality', 'Safe transaction deltas do not conserve the settlement batch', 409);
}

async function loadBatch(executor: SqlExecutor, batchId: string) {
  const row = await loadBatchRow(executor, batchId);
  const items = await executor.query<BatchItemRow>(
    `SELECT item.*, orders.policy_version, request.merchant_id
     FROM core.settlement_batch_items item
     JOIN core.orders orders ON orders.order_id = item.order_id
     JOIN core.settlement_requests request ON request.request_id = item.request_id
     WHERE item.batch_id = $1 ORDER BY item.item_index`,
    [batchId],
  );
  return { row, items: items.rows };
}

async function loadBatchRow(executor: SqlExecutor, batchId: string, forUpdate = false) {
  const result = await executor.query<BatchRow>(
    `SELECT batch_id, artifact_version, asset, asset_address, safe_address, safe_version,
       safe_singleton_address, safe_singleton_code_hash, safe_nonce::text,
       multisend_address, multisend_code_hash, token_code_hash,
       token_transfer_conformance_evidence_hash, item_count,
       total_amount::text, items_hash, content_hash, multisend_transactions,
       multisend_calldata, safe_tx_data, safe_tx_hash, state, approval_threshold,
       owner_set_hash, packed_signatures
     FROM core.settlement_batches WHERE batch_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [batchId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Settlement batch not found', 404);
  return result.rows[0];
}

function assertPersistedBatch(loaded: { row: BatchRow; items: BatchItemRow[] }) {
  const transferItems: SettlementTransferItem[] = loaded.items.map((item) => ({
    orderId: item.order_id,
    requestId: item.request_id,
    requestItemIndex: item.request_item_index,
    accountId: item.account_id,
    tokenAddress: item.token_address,
    recipientAddress: item.recipient_address,
    amount: item.amount,
  }));
  const batch = buildSafeSettlementBatch({
    batchId: loaded.row.batch_id,
    safeAddress: loaded.row.safe_address,
    safeNonce: loaded.row.safe_nonce,
    items: transferItems,
  });
  assertSafeSettlementBatch(batch);
  for (const [actual, expected, field] of [
    [batch.safeTxHash, loaded.row.safe_tx_hash, 'safeTxHash'],
    [batch.contentHash, loaded.row.content_hash, 'contentHash'],
    [batch.itemsHash, loaded.row.items_hash, 'itemsHash'],
    [batch.totalAmount, loaded.row.total_amount, 'totalAmount'],
    [batch.multisendTransactions, loaded.row.multisend_transactions, 'multisendTransactions'],
    [batch.multisendCalldata, loaded.row.multisend_calldata, 'multisendCalldata'],
  ] as const) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new CoreError('InvalidFinality', `Persisted Safe batch mismatch: ${field}`, 409);
    }
  }
  if (batch.itemCount !== loaded.row.item_count) {
    throw new CoreError('InvalidFinality', 'Persisted Safe batch item count mismatch', 409);
  }
  return batch;
}

function encodeExecTransaction(batch: SafeSettlementBatch, packedSignatures: string) {
  return SAFE_INTERFACE.encodeFunctionData('execTransaction', [
    batch.safeTransaction.to,
    batch.safeTransaction.value,
    batch.safeTransaction.data,
    batch.safeTransaction.operation,
    batch.safeTransaction.safeTxGas,
    batch.safeTransaction.baseGas,
    batch.safeTransaction.gasPrice,
    batch.safeTransaction.gasToken,
    batch.safeTransaction.refundReceiver,
    packedSignatures,
  ]);
}

function requiredSignatures(row: BatchRow) {
  if (!row.packed_signatures) {
    throw new CoreError('InvalidFinality', 'Submitted batch signatures are unavailable', 409);
  }
  return row.packed_signatures;
}

function requiredValue(value: string | null, name: string) {
  if (!value) throw new CoreError('InvalidFinality', `${name} is unavailable for lease recovery`, 409);
  return value;
}

function assertCurrentRuntime(row: BatchRow, evidence: SafeRuntimeEvidence) {
  const mismatched = [
    [normalizedAddress(evidence.safeAddress, 'attested Safe'), row.safe_address],
    [evidence.safeVersion, row.safe_version],
    [normalizedAddress(evidence.singletonAddress, 'attested Safe singleton'), row.safe_singleton_address],
    [evidence.singletonCodeHash.toLowerCase(), row.safe_singleton_code_hash],
    [evidence.safeNonce, row.safe_nonce],
    [evidence.ownerSetHash.toLowerCase(), row.owner_set_hash],
    [String(evidence.approvalThreshold), String(row.approval_threshold)],
    [normalizedAddress(evidence.multisendAddress, 'attested MultiSend'), row.multisend_address],
    [evidence.multisendCodeHash.toLowerCase(), row.multisend_code_hash],
    [evidence.tokenCodeHash.toLowerCase(), row.token_code_hash],
    [
      evidence.tokenTransferConformanceEvidenceHash.toLowerCase(),
      row.token_transfer_conformance_evidence_hash,
    ],
  ].some(([actual, expected]) => actual !== expected);
  if (mismatched) {
    throw new CoreError('ExternalBlocked', 'Safe runtime changed after settlement batch approval', 503);
  }
}

async function enqueueSettlementApprovalAudit(
  executor: SqlExecutor,
  batch: BatchRow,
  approvals: VerifiedSafeApprovals,
  at: Date,
) {
  const signatureEvidence = {
    scheme: 'SAFE_OWNER_SET' as const,
    signatureHash: approvals.approvalEvidenceHash,
    signer: batch.safe_address,
    digest: batch.safe_tx_hash,
    domain: `Safe:${batch.safe_version}:56:${batch.safe_address}`,
    nonce: batch.safe_nonce,
    deadline: '0',
  };
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:settlement-approval', {
      batchId: batch.batch_id,
      safeTxHash: batch.safe_tx_hash,
      approvalEvidenceHash: approvals.approvalEvidenceHash,
    }),
    streamName: 'financial',
    evidenceProfile: 'SAFE_APPROVED',
    eventType: 'SettlementBatchApproved',
    resourceType: 'SETTLEMENT_BATCH',
    resourceId: batch.batch_id,
    actorWallet: batch.safe_address,
    actorRole: 'SAFE_OWNER_SET',
    correlationId: `settlement:${batch.batch_id}`,
    requestHash: batch.safe_tx_hash.slice(2),
    payload: {
      safeAddress: batch.safe_address,
      safeTxHash: batch.safe_tx_hash,
      safeNonce: batch.safe_nonce,
      ownerSetHash: batch.owner_set_hash,
      threshold: batch.approval_threshold,
      approvedOwners: approvals.approvals.map((approval) => approval.ownerAddress),
      proposalReferenceHash: approvals.proposalReferenceHash,
      approvalEvidenceHash: approvals.approvalEvidenceHash,
    },
    signatureEvidence,
    createdAt: at,
  });
  for (const summary of await loadSettlementMerchantSummaries(executor, batch.batch_id)) {
    await enqueueAudit(executor, {
      sourceEventId: auditSourceId('audit:settlement-approval', {
        batchId: batch.batch_id,
        safeTxHash: batch.safe_tx_hash,
        approvalEvidenceHash: approvals.approvalEvidenceHash,
        merchantId: summary.merchantId,
      }),
      streamName: 'financial',
      evidenceProfile: 'SAFE_APPROVED',
      eventType: 'SettlementBatchApproved',
      resourceType: 'SETTLEMENT_BATCH',
      resourceId: batch.batch_id,
      merchantId: summary.merchantId,
      actorWallet: batch.safe_address,
      actorRole: 'SAFE_OWNER_SET',
      correlationId: `settlement:${batch.batch_id}`,
      requestHash: batch.safe_tx_hash.slice(2),
      payload: {
        safeAddress: batch.safe_address,
        safeTxHash: batch.safe_tx_hash,
        itemCount: summary.itemCount,
        totalAmount: summary.totalAmount,
      },
      signatureEvidence,
      createdAt: at,
    });
  }
}

interface SettlementChainAuditInput {
  evidenceProfile: 'CHAIN_OBSERVED' | 'CHAIN_FINAL';
  eventType: string;
  attemptId: string;
  executionTxHash: string;
  outerSender: string;
  outerNonce: string;
  execTransactionCalldata: string;
  requestHash: string;
  replacementForTxHash?: string;
  blockHash?: string;
  confirmations?: number;
  payload?: Record<string, unknown>;
  createdAt: Date;
}

async function enqueueSettlementChainAudit(
  executor: SqlExecutor,
  loaded: LoadedBatch,
  input: SettlementChainAuditInput,
) {
  if (!isHash(input.requestHash)) throw new CoreError('InvalidFinality', 'Settlement audit request hash is invalid', 409);
  const batch = assertPersistedBatch(loaded);
  const policyVersions = settlementPolicyVersions(loaded.items);
  const transactionEvidence = {
    txHash: input.executionTxHash,
    chainId: 56 as const,
    contractAddress: batch.safeAddress,
    selector: input.execTransactionCalldata.slice(0, 10),
    calldataHash: keccak256(input.execTransactionCalldata).toLowerCase(),
    resourceId: batch.batchId,
    ...(policyVersions.length === 1
      ? { policyVersion: policyVersions[0]! }
      : { policyVersions }),
    ...(input.blockHash ? { blockHash: input.blockHash } : {}),
    ...(input.confirmations === undefined ? {} : { confirmations: input.confirmations }),
    ...(input.replacementForTxHash ? { replacementForTxHash: input.replacementForTxHash } : {}),
  };
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:settlement-chain', {
      batchId: batch.batchId,
      attemptId: input.attemptId,
      eventType: input.eventType,
      executionTxHash: input.executionTxHash,
      requestHash: input.requestHash,
    }),
    streamName: 'financial',
    evidenceProfile: input.evidenceProfile,
    eventType: input.eventType,
    resourceType: 'SETTLEMENT_BATCH',
    resourceId: batch.batchId,
    actorWallet: normalizedAddress(input.outerSender, 'settlement outer sender'),
    actorRole: 'SETTLEMENT_EXECUTOR',
    correlationId: `settlement:${batch.batchId}`,
    requestHash: input.requestHash.slice(2),
    payload: {
      batchId: batch.batchId,
      attemptId: input.attemptId,
      safeAddress: batch.safeAddress,
      safeTxHash: batch.safeTxHash,
      contentHash: batch.contentHash,
      executionTxHash: input.executionTxHash,
      outerSender: input.outerSender,
      outerNonce: input.outerNonce,
      ...input.payload,
    },
    transactionEvidence,
    createdAt: input.createdAt,
  });
  for (const summary of settlementMerchantSummaries(loaded.items)) {
    await enqueueAudit(executor, {
      sourceEventId: auditSourceId('audit:settlement-chain', {
        batchId: batch.batchId,
        attemptId: input.attemptId,
        eventType: input.eventType,
        executionTxHash: input.executionTxHash,
        requestHash: input.requestHash,
        merchantId: summary.merchantId,
      }),
      streamName: 'financial',
      evidenceProfile: input.evidenceProfile,
      eventType: input.eventType,
      resourceType: 'SETTLEMENT_BATCH',
      resourceId: batch.batchId,
      merchantId: summary.merchantId,
      actorWallet: normalizedAddress(input.outerSender, 'settlement outer sender'),
      actorRole: 'SETTLEMENT_EXECUTOR',
      correlationId: `settlement:${batch.batchId}`,
      requestHash: input.requestHash.slice(2),
      payload: {
        batchId: batch.batchId,
        safeAddress: batch.safeAddress,
        safeTxHash: batch.safeTxHash,
        executionTxHash: input.executionTxHash,
        itemCount: summary.itemCount,
        totalAmount: summary.totalAmount,
        ...(input.payload?.canonical === false ? { canonical: false } : {}),
      },
      transactionEvidence,
      createdAt: input.createdAt,
    });
  }
}

async function enqueueSettlementSystemAudit(executor: SqlExecutor, input: {
  eventType: string;
  batchId: string;
  attemptId: string;
  evidenceHash: string;
  createdAt: Date;
}) {
  const evidenceHash = isHash(input.evidenceHash)
    ? input.evidenceHash.toLowerCase()
    : hashJson({ ...input, createdAt: input.createdAt.toISOString() });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:settlement-system', {
      eventType: input.eventType,
      batchId: input.batchId,
      attemptId: input.attemptId,
      evidenceHash,
    }),
    streamName: 'financial',
    evidenceProfile: 'SYSTEM',
    eventType: input.eventType,
    resourceType: 'SETTLEMENT_BATCH',
    resourceId: input.batchId,
    actorRole: 'SETTLEMENT_WORKER',
    correlationId: `settlement:${input.batchId}`,
    requestHash: evidenceHash.slice(2),
    payload: {
      batchId: input.batchId,
      attemptId: input.attemptId,
      evidenceHash,
    },
    createdAt: input.createdAt,
  });
  for (const summary of await loadSettlementMerchantSummaries(executor, input.batchId)) {
    await enqueueAudit(executor, {
      sourceEventId: auditSourceId('audit:settlement-system', {
        eventType: input.eventType,
        batchId: input.batchId,
        attemptId: input.attemptId,
        evidenceHash,
        merchantId: summary.merchantId,
      }),
      streamName: 'financial',
      evidenceProfile: 'SYSTEM',
      eventType: input.eventType,
      resourceType: 'SETTLEMENT_BATCH',
      resourceId: input.batchId,
      merchantId: summary.merchantId,
      actorRole: 'SETTLEMENT_WORKER',
      correlationId: `settlement:${input.batchId}`,
      requestHash: evidenceHash.slice(2),
      payload: {
        batchId: input.batchId,
        attemptId: input.attemptId,
        itemCount: summary.itemCount,
        totalAmount: summary.totalAmount,
      },
      createdAt: input.createdAt,
    });
  }
}

interface SettlementMerchantSummary {
  merchantId: string;
  itemCount: number;
  totalAmount: string;
}

function settlementMerchantSummaries(items: readonly BatchItemRow[]): SettlementMerchantSummary[] {
  const summaries = new Map<string, { itemCount: number; totalAmount: bigint }>();
  for (const item of items) {
    if (!item.merchant_id) continue;
    const summary = summaries.get(item.merchant_id) ?? { itemCount: 0, totalAmount: 0n };
    summary.itemCount += 1;
    summary.totalAmount += BigInt(item.amount);
    summaries.set(item.merchant_id, summary);
  }
  return [...summaries]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([merchantId, summary]) => ({
      merchantId,
      itemCount: summary.itemCount,
      totalAmount: summary.totalAmount.toString(),
    }));
}

async function loadSettlementMerchantSummaries(executor: SqlExecutor, batchId: string) {
  const result = await executor.query<{
    merchant_id: string;
    item_count: string | number;
    total_amount: string;
  }>(
    `SELECT request.merchant_id, count(*) AS item_count, sum(item.amount)::text AS total_amount
     FROM core.settlement_batch_items item
     JOIN core.settlement_requests request ON request.request_id = item.request_id
     WHERE item.batch_id = $1 AND request.merchant_id IS NOT NULL
     GROUP BY request.merchant_id
     ORDER BY request.merchant_id`,
    [batchId],
  );
  return result.rows.map((row) => ({
    merchantId: row.merchant_id,
    itemCount: Number(row.item_count),
    totalAmount: row.total_amount,
  }));
}

function settlementPolicyVersions(items: BatchItemRow[]) {
  const versions = [...new Set(items.map((item) => Number(item.policy_version)))].sort((left, right) => left - right);
  if (versions.length === 0 || versions.some((version) => !Number.isSafeInteger(version) || version <= 0)) {
    throw new CoreError('InvalidFinality', 'Settlement batch policy evidence is invalid', 409);
  }
  return versions;
}

async function loadSettlementAttemptAuditEvidence(executor: SqlExecutor, attemptId: string) {
  const result = await executor.query<{
    execution_tx_hash: string;
    outer_sender: string;
    outer_nonce: string;
    exec_transaction_calldata: string;
    replacement_for_tx_hash: string | null;
  }>(
    `SELECT attempt.execution_tx_hash, attempt.outer_sender, attempt.outer_nonce::text,
       attempt.exec_transaction_calldata, finality.replacement_for_tx_hash
     FROM core.settlement_execution_attempts attempt
     JOIN core.transaction_finality finality
       ON finality.transaction_id = 'settlement:' || attempt.attempt_id
     WHERE attempt.attempt_id = $1`,
    [attemptId],
  );
  const row = result.rows[0];
  if (!row?.execution_tx_hash || !row.outer_sender || row.outer_nonce === null || !row.exec_transaction_calldata) {
    throw new CoreError('InvalidFinality', 'Settlement attempt audit evidence is incomplete', 409);
  }
  return row;
}

async function settleBatch(
  executor: SqlExecutor,
  loaded: LoadedBatch,
  attemptId: string,
  receipt: SafeSettlementReceipt,
  at: Date,
) {
  const batch = await loadBatchRow(executor, loaded.row.batch_id, true);
  if (batch.state === 'SETTLED') return;
  if (!['SUBMITTED', 'MINED'].includes(batch.state)) {
    throw new CoreError('UnknownState', 'Settlement batch cannot finalize from its current state', 409);
  }
  await lockAccounts(executor, loaded.items.map((item) => item.account_id));
  for (const [index, item] of loaded.items.entries()) {
    await assertStateBalance(executor, item, 'BATCHED');
    const journalId = `journal:settlement-final:${batch.batch_id}:${index}`;
    const lines = stateMoveLines(item.account_id, item.amount, 'BATCHED', 'SETTLED', batch.safe_address);
    await postJournal(executor, {
      journalId,
      eventKey: `settlement-final:${batch.batch_id}:${index}`,
      eventType: 'SETTLEMENT_SETTLED',
      batchId: batch.batch_id,
      orderId: item.order_id,
      policyVersion: Number(item.policy_version),
      contentHash: hashJson({ batchId: batch.batch_id, itemIndex: index, receipt: receipt.evidenceHash, lines }),
      sourceReferenceHash: receipt.evidenceHash,
      payload: { batchId: batch.batch_id, requestId: item.request_id, itemIndex: index },
      lines,
    });
    await executor.query(
      `UPDATE core.settlement_request_items SET settled_journal_id = $3
       WHERE request_id = $1 AND item_index = $2`,
      [item.request_id, item.request_item_index, journalId],
    );
    await executor.query(
      `INSERT INTO core.settlement_request_item_transitions (
         transition_id, request_id, request_item_index, batch_id,
         transition_sequence, transition_type, journal_id, created_at
       ) VALUES (
         $1,$2,$3,$4,
         (SELECT COALESCE(max(transition_sequence),0) + 1
          FROM core.settlement_request_item_transitions
          WHERE request_id = $2 AND request_item_index = $3),
         'SETTLED',$5,$6
       )`,
      [`transition:${journalId}`, item.request_id, item.request_item_index, batch.batch_id, journalId, at],
    );
  }
  const requestIds = [...new Set(loaded.items.map((item) => item.request_id))];
  for (const requestId of requestIds) {
    const remaining = await executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.settlement_request_items
       WHERE request_id = $1 AND settled_journal_id IS NULL`,
      [requestId],
    );
    if (remaining.rows[0]?.count !== '0') continue;
    await executor.query(
      `UPDATE core.settlement_requests SET state = 'SETTLED', settled_at = $2,
         final_safe_tx_hash = $3, final_execution_tx_hash = $4
       WHERE request_id = $1 AND batch_id = $5`,
      [requestId, at, batch.safe_tx_hash, receipt.executionTxHash, batch.batch_id],
    );
  }
  await executor.query(
    `UPDATE core.settlement_batches SET state = 'SETTLED', settled_at = $2
     WHERE batch_id = $1`,
    [batch.batch_id, at],
  );
  await executor.query(
    `UPDATE core.settlement_execution_attempts SET state = 'SETTLED', updated_at = $2
     WHERE attempt_id = $1`,
    [attemptId, at],
  );
  await executor.query(
    `UPDATE core.settlement_execution_attempts SET state = 'REPLACED', updated_at = $3
     WHERE batch_id = $1 AND attempt_id <> $2 AND state IN ('SUBMITTED','MINED')`,
    [batch.batch_id, attemptId, at],
  );
  await executor.query(
    `UPDATE core.safe_nonce_reservations SET state = 'CONSUMED' WHERE batch_id = $1`,
    [batch.batch_id],
  );
  await executor.query(
    `UPDATE core.transaction_finality SET state = 'FINAL', receipt_status = 1,
       block_number = $2, block_hash = $3, confirmations = $4, evidence = $5,
       finalized_at = $6, updated_at = $6 WHERE transaction_id = $1`,
    [
      `settlement:${attemptId}`,
      receipt.blockNumber,
      receipt.blockHash,
      receipt.confirmations,
      JSON.stringify(receipt),
      at,
    ],
  );
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
     ) VALUES ($1,'SETTLEMENT_BATCH',$2,'SettlementBatchFinalized',$3,$1,'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      `outbox:settlement-final:${batch.batch_id}`,
      batch.batch_id,
      JSON.stringify({
        batchId: batch.batch_id,
        safeTxHash: batch.safe_tx_hash,
        executionTxHash: receipt.executionTxHash,
      }),
    ],
  );
  const attemptEvidence = await loadSettlementAttemptAuditEvidence(executor, attemptId);
  await enqueueSettlementChainAudit(executor, loaded, {
    evidenceProfile: 'CHAIN_FINAL',
    eventType: 'SettlementBatchFinalized',
    attemptId,
    executionTxHash: receipt.executionTxHash,
    outerSender: receipt.outerSender,
    outerNonce: receipt.outerNonce,
    execTransactionCalldata: receipt.transactionCalldata,
    requestHash: hashJson(receipt),
    ...(attemptEvidence.replacement_for_tx_hash
      ? { replacementForTxHash: attemptEvidence.replacement_for_tx_hash }
      : {}),
    blockHash: receipt.blockHash,
    confirmations: receipt.confirmations,
    payload: {
      safeTxHash: batch.safe_tx_hash,
      receiptEvidenceHash: receipt.evidenceHash,
      itemCount: batch.item_count,
      totalAmount: batch.total_amount,
    },
    createdAt: at,
  });
}

async function reverseSettledBatchFinality(
  executor: SqlExecutor,
  loaded: LoadedBatch,
  attemptId: string,
  previousBlockHash: string,
  observation: { canonical: boolean; observedBlockHash: string; evidenceHash: string },
  at: Date,
) {
  const batch = await loadBatchRow(executor, loaded.row.batch_id, true);
  if (batch.state === 'REORGED') return;
  if (batch.state !== 'SETTLED') {
    throw new CoreError('UnknownState', 'Only a settled batch can be reversed after a deep reorg', 409);
  }
  await lockAccounts(executor, loaded.items.map((item) => item.account_id));
  for (const [index, item] of loaded.items.entries()) {
    await assertStateBalance(executor, item, 'SETTLED');
    const journalId = `journal:settlement-finality-reorg:${batch.batch_id}:${index}:${observation.observedBlockHash}`;
    const lines = stateMoveLines(item.account_id, item.amount, 'SETTLED', 'BATCHED', batch.safe_address);
    await postJournal(executor, {
      journalId,
      eventKey: `settlement-finality-reorg:${batch.batch_id}:${index}:${observation.observedBlockHash}`,
      eventType: 'SETTLEMENT_FINALITY_REVERSED',
      batchId: batch.batch_id,
      orderId: item.order_id,
      policyVersion: Number(item.policy_version),
      contentHash: hashJson({
        batchId: batch.batch_id,
        itemIndex: index,
        observedBlockHash: observation.observedBlockHash,
        evidenceHash: observation.evidenceHash,
        lines,
      }),
      sourceReferenceHash: observation.evidenceHash,
      payload: {
        batchId: batch.batch_id,
        requestId: item.request_id,
        itemIndex: index,
        previousAttemptId: attemptId,
      },
      lines,
    });
    await executor.query(
      `UPDATE core.settlement_request_items SET settled_journal_id = NULL
       WHERE request_id = $1 AND item_index = $2`,
      [item.request_id, item.request_item_index],
    );
    await executor.query(
      `INSERT INTO core.settlement_request_item_transitions (
         transition_id, request_id, request_item_index, batch_id,
         transition_sequence, transition_type, journal_id, created_at
       ) VALUES (
         $1,$2,$3,$4,
         (SELECT COALESCE(max(transition_sequence),0) + 1
          FROM core.settlement_request_item_transitions
          WHERE request_id = $2 AND request_item_index = $3),
         'FINALITY_REVERSED',$5,$6
       )`,
      [`transition:${journalId}`, item.request_id, item.request_item_index, batch.batch_id, journalId, at],
    );
  }
  for (const requestId of new Set(loaded.items.map((item) => item.request_id))) {
    await executor.query(
      `UPDATE core.settlement_requests SET state = 'BATCHED', settled_at = NULL,
         final_safe_tx_hash = NULL, final_execution_tx_hash = NULL
       WHERE request_id = $1 AND batch_id = $2 AND state = 'SETTLED'`,
      [requestId, batch.batch_id],
    );
  }
  await executor.query(
    `UPDATE core.settlement_batches SET state = 'REORGED', settled_at = NULL WHERE batch_id = $1`,
    [batch.batch_id],
  );
  await executor.query(
    `UPDATE core.settlement_execution_attempts SET state = 'REORGED', updated_at = $2
     WHERE attempt_id = $1`,
    [attemptId, at],
  );
  await executor.query(
    `UPDATE core.transaction_finality SET state = 'REORGED',
       confirmations = 0, evidence = evidence || $2::jsonb, updated_at = $3
     WHERE transaction_id = $1`,
    [
      `settlement:${attemptId}`,
      JSON.stringify({
        previousBlockHash,
        canonicalBlockHash: observation.observedBlockHash,
        canonicalityEvidenceHash: observation.evidenceHash,
      }),
      at,
    ],
  );
  await executor.query(
    `UPDATE core.safe_nonce_reservations SET state = 'REORGED' WHERE batch_id = $1`,
    [batch.batch_id],
  );
  await pauseSettlementBatches(executor, `deep-reorg:${batch.batch_id}`, observation.evidenceHash, at);
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload,
       idempotency_key, state
     ) VALUES ($1,'SETTLEMENT_BATCH',$2,'SettlementFinalityReorged',$3,$1,'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      `outbox:settlement-finality-reorg:${batch.batch_id}:${observation.observedBlockHash.slice(2)}`,
      batch.batch_id,
      JSON.stringify({
        batchId: batch.batch_id,
        attemptId,
        observedBlockHash: observation.observedBlockHash,
        evidenceHash: observation.evidenceHash,
      }),
    ],
  );
  const attemptEvidence = await loadSettlementAttemptAuditEvidence(executor, attemptId);
  await enqueueSettlementChainAudit(executor, loaded, {
    evidenceProfile: 'CHAIN_OBSERVED',
    eventType: 'SettlementBatchFinalityReorged',
    attemptId,
    executionTxHash: attemptEvidence.execution_tx_hash,
    outerSender: attemptEvidence.outer_sender,
    outerNonce: attemptEvidence.outer_nonce,
    execTransactionCalldata: attemptEvidence.exec_transaction_calldata,
    requestHash: hashJson({ previousBlockHash, ...observation }),
    ...(attemptEvidence.replacement_for_tx_hash
      ? { replacementForTxHash: attemptEvidence.replacement_for_tx_hash }
      : {}),
    blockHash: previousBlockHash,
    confirmations: 0,
    payload: {
      previousBlockHash,
      canonicalBlockHash: observation.observedBlockHash,
      canonicalityEvidenceHash: observation.evidenceHash,
    },
    createdAt: at,
  });
}

async function quarantineFinality(
  executor: SqlExecutor,
  loaded: LoadedBatch,
  candidate: {
    batch_id: string;
    attempt_id: string;
    execution_tx_hash: string;
    outer_sender: string;
    outer_nonce: string;
    replacement_for_tx_hash: string | null;
  },
  receipt: SafeSettlementReceipt,
  expectedCalldata: string,
  validatedReceipt: boolean,
  at: Date,
) {
  await executor.query(
    `UPDATE core.settlement_batches SET state = 'QUARANTINED' WHERE batch_id = $1`,
    [candidate.batch_id],
  );
  await executor.query(
    `UPDATE core.settlement_execution_attempts SET state = 'QUARANTINED', updated_at = $2
     WHERE batch_id = $1 AND state IN ('LEASED','SUBMITTED','MINED')`,
    [candidate.batch_id, at],
  );
  await executor.query(
    `UPDATE core.transaction_finality SET state = 'FAILED', receipt_status = $2,
       block_number = $3, block_hash = $4, confirmations = $5, evidence = $6,
       updated_at = $7 WHERE transaction_id = $1`,
    [
      `settlement:${candidate.attempt_id}`,
      receipt.receiptStatus,
      receipt.blockNumber,
      receipt.blockHash,
      receipt.confirmations,
      JSON.stringify(receipt),
      at,
    ],
  );
  await executor.query(
    `UPDATE core.safe_nonce_reservations SET state = 'QUARANTINED' WHERE batch_id = $1`,
    [candidate.batch_id],
  );
  await pauseSettlementBatches(executor, `finality:${candidate.batch_id}`, receipt.evidenceHash, at);
  if (validatedReceipt) {
    await enqueueSettlementChainAudit(executor, loaded, {
      evidenceProfile: 'CHAIN_OBSERVED',
      eventType: 'SettlementFinalityQuarantined',
      attemptId: candidate.attempt_id,
      executionTxHash: candidate.execution_tx_hash,
      outerSender: candidate.outer_sender,
      outerNonce: candidate.outer_nonce,
      execTransactionCalldata: expectedCalldata,
      requestHash: hashJson(receipt),
      ...(candidate.replacement_for_tx_hash
        ? { replacementForTxHash: candidate.replacement_for_tx_hash }
        : {}),
      blockHash: receipt.blockHash,
      confirmations: receipt.confirmations,
      payload: { receiptStatus: receipt.receiptStatus, receiptEvidenceHash: receipt.evidenceHash },
      createdAt: at,
    });
  } else {
    await enqueueSettlementSystemAudit(executor, {
      eventType: 'SettlementFinalityEvidenceRejected',
      batchId: candidate.batch_id,
      attemptId: candidate.attempt_id,
      evidenceHash: hashJson(receipt),
      createdAt: at,
    });
  }
}

async function pauseSettlementBatches(
  executor: SqlExecutor,
  causeId: string,
  evidenceHash: string,
  at: Date,
) {
  if (!isHash(evidenceHash)) evidenceHash = hashJson({ causeId, evidenceHash });
  await executor.query(
    `INSERT INTO core.breaker_causes (
       scope, cause_type, cause_id, active, evidence_hash, updated_at
     ) VALUES ('NEW_SETTLEMENT_BATCH','SECURITY',$1,true,$2,$3)
     ON CONFLICT (scope, cause_type, cause_id) DO UPDATE
       SET active = true, evidence_hash = EXCLUDED.evidence_hash, updated_at = EXCLUDED.updated_at`,
    [causeId, evidenceHash, at],
  );
  const eventId = hashJson({ scope: 'NEW_SETTLEMENT_BATCH', causeId, action: 'PAUSE', evidenceHash });
  await executor.query(
    `INSERT INTO core.breaker_events (
       breaker_event_id, scope, action, cause_type, cause_id,
       evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ($1,'NEW_SETTLEMENT_BATCH','PAUSE','SECURITY',$2,$3,NULL,'SETTLEMENT_WORKER',$4)
     ON CONFLICT (breaker_event_id) DO NOTHING`,
    [eventId, causeId, evidenceHash, at],
  );
  await executor.query(
    `INSERT INTO core.circuit_breakers (
       scope, paused, evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ('NEW_SETTLEMENT_BATCH',true,$1,NULL,'SETTLEMENT_WORKER',$2)
     ON CONFLICT (scope) DO UPDATE SET paused = true, evidence_hash = EXCLUDED.evidence_hash,
       changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
    [evidenceHash, at],
  );
}

async function lockAccounts(executor: SqlExecutor, accountIds: string[]) {
  const ids = [...new Set(accountIds)].sort();
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
  const result = await executor.query<{ account_id: string }>(
    `SELECT account_id FROM core.ledger_accounts
     WHERE account_id IN (${placeholders}) ORDER BY account_id FOR UPDATE`,
    ids,
  );
  if (result.rows.length !== ids.length) throw new CoreError('InvalidFinality', 'Settlement account is unavailable', 409);
}

async function assertStateBalance(executor: SqlExecutor, item: BatchItemRow, state: 'BATCHED' | 'SETTLED') {
  const result = await executor.query<{ amount: string }>(
    `SELECT COALESCE(sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END),0)::text AS amount
     FROM core.ledger_lines line
     JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
     WHERE journal.order_id = $1 AND line.account_id = $2 AND line.balance_state = $3`,
    [item.order_id, item.account_id, state],
  );
  if (BigInt(result.rows[0]?.amount ?? '0') < BigInt(item.amount)) {
    throw new CoreError('InvalidFinality', `Settlement ${state} balance is insufficient`, 409);
  }
}

function stateMoveLines(
  accountId: string,
  amount: string,
  from: 'BATCHED' | 'SETTLED',
  to: 'REQUESTED' | 'BATCHED' | 'SETTLED',
  safeAddress: string,
) {
  return [
    { account_id: accountId, side: 'DEBIT', amount, balance_state: from, backing_safe_address: safeAddress },
    { account_id: accountId, side: 'CREDIT', amount, balance_state: to, backing_safe_address: safeAddress },
  ];
}

async function postJournal(
  executor: SqlExecutor,
  input: {
    journalId: string;
    eventKey: string;
    eventType: 'SETTLEMENT_SETTLED' | 'SETTLEMENT_BATCH_REVERSED' | 'SETTLEMENT_FINALITY_REVERSED';
    batchId: string;
    orderId: string;
    policyVersion: number;
    contentHash: string;
    sourceReferenceHash: string;
    payload: Record<string, unknown>;
    lines: ReturnType<typeof stateMoveLines>;
  },
) {
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,\'SETTLEMENT_BATCH\',$4,$5,$6,$7,NULL,NULL,\'SAFE_BATCH\',$8,NULL,$9,$10)',
    [
      input.journalId,
      input.eventKey,
      input.eventType,
      input.batchId,
      input.orderId,
      input.policyVersion,
      input.contentHash,
      input.sourceReferenceHash,
      JSON.stringify(input.payload),
      JSON.stringify(input.lines),
    ],
  );
}

function normalizedAddress(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
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

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
