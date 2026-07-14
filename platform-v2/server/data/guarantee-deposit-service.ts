import { randomUUID } from 'node:crypto';
import { getAddress, id, keccak256, toUtf8Bytes } from 'ethers';
import { USDT_ADDRESS, type UserRole } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const GUARANTEE_MINIMUM_USDT = 1_000n * 10n ** 18n;
const TRANSFER_EVENT_SIGNATURE_HASH = id('Transfer(address,address,uint256)').toLowerCase();

interface GuaranteeActor {
  walletAddress: string;
  roles: readonly UserRole[];
  merchantId?: string;
}

export interface GuaranteeDepositFinalityItem {
  depositId: string;
  merchantId: string;
  merchantWallet: string;
  policyVersion: number;
  tokenAddress: string;
  operationsSafeAddress: string;
  expectedAmountUsdt: string;
  transactionHash: string;
  state: 'SUBMITTED' | 'MINED' | 'FINAL' | 'REORGED' | 'QUARANTINED';
  observedBlockNumber?: number;
  observedBlockHash?: string;
  observedLogIndex?: number;
  confirmations: number;
}

export interface GuaranteeDepositChainObservation {
  state: 'MINED' | 'FINAL';
  transactionHash: string;
  tokenAddress: string;
  from: string;
  to: string;
  amount: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  confirmations: number;
  receiptStatus: 1;
  canonicalBlock: true;
  transferEvidenceHash: string;
  observedAt: Date;
  reorgedFrom?: Omit<GuaranteeDepositReorgObservation, 'state' | 'transactionHash' | 'observedAt'>;
}

export interface GuaranteeDepositReorgObservation {
  state: 'REORGED';
  transactionHash: string;
  previousBlockNumber: number;
  previousBlockHash: string;
  previousLogIndex: number;
  canonicalBlockHash: string;
  confirmations: number;
  evidenceHash: string;
  observedAt: Date;
}

interface DepositRow {
  deposit_id: string;
  merchant_id: string;
  merchant_wallet: string;
  policy_version: string | number;
  token_address: string;
  operations_safe_address: string;
  expected_amount_usdt: string;
  transaction_hash: string;
  state: GuaranteeDepositFinalityItem['state'];
  observed_block_number: string | number | null;
  observed_block_hash: string | null;
  observed_log_index: number | null;
  confirmations: number;
  transfer_evidence_hash: string | null;
  final_journal_id: string | null;
  correlation_id: string;
  request_hash: string;
}

export class GuaranteeDepositService {
  readonly #transactions: SqlTransactionRunner;
  readonly #operationsSafeAddress: string;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    operationsSafeAddress: string;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#operationsSafeAddress = normalizedAddress(input.operationsSafeAddress, 'Operations Treasury Safe');
    this.#clock = input.clock ?? (() => new Date());
  }

  submit(actor: GuaranteeActor, input: {
    policyVersion: string;
    expectedAmountUsdt: string;
    transactionHash: string;
    idempotencyKey: string;
    correlationId: string;
  }) {
    if (!actor.roles.includes('MERCHANT')) throw new CoreError('Forbidden', 'MERCHANT role is required', 403);
    const wallet = normalizedAddress(actor.walletAddress, 'guarantee depositor');
    const policyVersion = positiveSafeInteger(input.policyVersion, 'guarantee policy version');
    if (!/^[1-9][0-9]*$/.test(input.expectedAmountUsdt)) throw new CoreError('InvalidRequest', 'Guarantee amount is invalid');
    if (!isHash(input.transactionHash)) throw new CoreError('InvalidRequest', 'Guarantee transaction hash is invalid');
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)) throw new CoreError('InvalidRequest', 'Guarantee idempotency key is invalid');
    if (!input.correlationId || input.correlationId.length > 128) throw new CoreError('InvalidRequest', 'Guarantee correlation id is invalid');
    const transactionHash = input.transactionHash.toLowerCase();
    const requestHash = hashJson({
      wallet,
      policyVersion,
      expectedAmountUsdt: input.expectedAmountUsdt,
      transactionHash,
    });
    return this.#transactions.transaction(async (executor) => {
      const binding = await executor.query<{
        merchant_id: string;
        settlement_wallet: string;
        role: string;
      }>(
        `SELECT binding.merchant_id, merchant.settlement_wallet, binding.role
         FROM core.wallet_role_bindings binding
         JOIN core.merchants merchant ON merchant.merchant_id = binding.merchant_id
         WHERE lower(binding.wallet_address) = $1 AND binding.role = 'MERCHANT'
           AND binding.status = 'ACTIVE' FOR UPDATE OF binding, merchant`,
        [wallet],
      );
      const merchant = binding.rows[0];
      if (!merchant || merchant.settlement_wallet !== wallet) {
        throw new CoreError('Forbidden', 'Current merchant role cannot submit this guarantee deposit', 403);
      }
      if (actor.merchantId && actor.merchantId !== merchant.merchant_id) {
        throw new CoreError('Forbidden', 'Merchant guarantee is outside the wallet scope', 403);
      }
      const policy = await executor.query<{
        payload: Record<string, unknown>;
        publication_status: string;
      }>(
        'SELECT payload, publication_status FROM core.policy_snapshots WHERE policy_version = $1',
        [policyVersion],
      );
      if (!policy.rows[0] || policy.rows[0].publication_status !== 'PUBLISHED') {
        throw new CoreError('InvalidRequest', 'Published guarantee policy version was not found', 404);
      }
      const policySafe = normalizedAddress(String(policy.rows[0].payload.operationsTreasurySafe ?? ''), 'policy Operations Treasury Safe');
      if (policySafe !== this.#operationsSafeAddress) {
        throw new CoreError('ExternalBlocked', 'Policy and runtime Operations Treasury Safe do not match', 503);
      }
      const existing = await executor.query<DepositRow>(
        `SELECT * FROM core.merchant_guarantee_deposit_submissions
         WHERE submitted_by = $1 AND idempotency_key = $2`,
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Guarantee deposit idempotency conflict', 409);
        }
        return depositProjection(existing.rows[0]);
      }
      const transactionOwner = await executor.query<DepositRow>(
        'SELECT * FROM core.merchant_guarantee_deposit_submissions WHERE transaction_hash = $1',
        [transactionHash],
      );
      if (transactionOwner.rows[0]) {
        throw new CoreError('IdempotencyConflict', 'Guarantee transaction is already bound to another submission', 409);
      }
      const now = this.#clock();
      const depositId = `guarantee-deposit:${randomUUID()}`;
      await executor.query(
        `INSERT INTO core.merchant_guarantee_deposit_submissions (
           deposit_id, merchant_id, merchant_wallet, policy_version, chain_id,
           token_address, operations_safe_address, expected_amount_usdt,
           transaction_hash, state, idempotency_key, request_hash,
           correlation_id, submitted_by, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,56,$5,$6,$7,$8,'SUBMITTED',$9,$10,$11,$3,$12,$12)`,
        [
          depositId,
          merchant.merchant_id,
          wallet,
          policyVersion,
          USDT_ADDRESS,
          this.#operationsSafeAddress,
          input.expectedAmountUsdt,
          transactionHash,
          input.idempotencyKey,
          requestHash,
          input.correlationId,
          now,
        ],
      );
      await insertTransition(executor, {
        depositId,
        eventType: 'SUBMITTED',
        previousState: null,
        confirmations: 0,
        evidenceHash: requestHash,
        observedAt: now,
      });
      const authorizationEvidenceHash = hashJson({
        wallet,
        merchantId: merchant.merchant_id,
        role: merchant.role,
        checkedAt: now.toISOString(),
      });
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:guarantee-submission', { depositId, requestHash }),
        streamName: 'financial',
        evidenceProfile: 'AUTHORIZATION',
        eventType: 'GuaranteeDepositSubmitted',
        resourceType: 'MERCHANT_GUARANTEE',
        resourceId: merchant.merchant_id,
        actorWallet: wallet,
        actorRole: 'MERCHANT',
        correlationId: input.correlationId,
        requestHash: requestHash.slice(2),
        payload: { depositId, policyVersion, transactionHash, expectedAmountUsdt: input.expectedAmountUsdt },
        authorizationEvidence: {
          scheme: 'RBAC_ROLE_REVALIDATION',
          subject: wallet,
          roles: ['MERCHANT'],
          evidenceHash: authorizationEvidenceHash,
          checkedAt: now.toISOString(),
        },
        createdAt: now,
      });
      return {
        depositId,
        merchantId: merchant.merchant_id,
        policyVersion,
        transactionHash,
        expectedAmountUsdt: input.expectedAmountUsdt,
        operationsSafeAddress: this.#operationsSafeAddress,
        state: 'SUBMITTED' as const,
        confirmations: 0,
      };
    });
  }

  pendingFinality(limit = 25) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('InvalidGuaranteeFinalityLimit');
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<DepositRow>(
        `WITH claimed AS (
           SELECT deposit_id FROM core.merchant_guarantee_deposit_submissions
           WHERE state IN ('SUBMITTED','MINED','FINAL','REORGED')
           ORDER BY last_finality_check_at NULLS FIRST, updated_at, deposit_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE core.merchant_guarantee_deposit_submissions submission
         SET last_finality_check_at = clock_timestamp()
         FROM claimed
         WHERE submission.deposit_id = claimed.deposit_id
         RETURNING submission.*`,
        [limit],
      );
      return result.rows.map(finalityProjection);
    });
  }

  recordObservation(depositId: string, observation: GuaranteeDepositChainObservation) {
    validateChainObservation(observation);
    return this.#transactions.transaction(async (executor) => {
      const deposit = await lockDeposit(executor, depositId);
      assertObservationMatchesDeposit(deposit, observation);
      if (
        deposit.observed_block_number !== null
        && deposit.state !== 'REORGED'
        && (
          Number(deposit.observed_block_number) !== observation.blockNumber
          || deposit.observed_block_hash !== observation.blockHash.toLowerCase()
          || deposit.observed_log_index !== observation.logIndex
        )
      ) throw new CoreError('InvalidFinality', 'Guarantee replacement must record reorg before new chain evidence', 409);
      if (deposit.state === 'FINAL') {
        if (
          deposit.observed_block_hash === observation.blockHash.toLowerCase()
          && deposit.observed_log_index === observation.logIndex
          && deposit.transfer_evidence_hash === observation.transferEvidenceHash.toLowerCase()
        ) return depositProjection(deposit);
        throw new CoreError('InvalidFinality', 'Final guarantee must record reorg before replacement finality', 409);
      }
      if (observation.state === 'MINED') {
        if (observation.confirmations >= 15) throw new CoreError('InvalidFinality', 'Mined guarantee observation already satisfies finality', 409);
        await updateObservedState(executor, deposit, observation, 'MINED');
        await insertTransition(executor, {
          depositId,
          eventType: 'MINED',
          previousState: deposit.state,
          blockNumber: observation.blockNumber,
          blockHash: observation.blockHash,
          logIndex: observation.logIndex,
          confirmations: observation.confirmations,
          evidenceHash: observation.transferEvidenceHash,
          observedAt: observation.observedAt,
        });
        return depositProjection(await lockDeposit(executor, depositId));
      }
      if (observation.confirmations < 15) throw new CoreError('InvalidFinality', 'Final guarantee has fewer than 15 confirmations', 409);
      const journalId = deposit.final_journal_id ?? `journal:guarantee-deposit:${deposit.deposit_id}`;
      if (!deposit.final_journal_id) {
        await postGuaranteeJournal(executor, deposit, observation, journalId);
        await executor.query(
          `INSERT INTO core.merchant_guarantees (
             merchant_id, backing_safe_address, balance_usdt, minimum_usdt,
             source_evidence_hash, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (merchant_id) DO UPDATE SET
             balance_usdt = CASE
               WHEN core.merchant_guarantees.backing_safe_address = EXCLUDED.backing_safe_address
               THEN core.merchant_guarantees.balance_usdt + EXCLUDED.balance_usdt
               ELSE core.merchant_guarantees.balance_usdt
             END,
             source_evidence_hash = EXCLUDED.source_evidence_hash,
             updated_at = EXCLUDED.updated_at`,
          [
            deposit.merchant_id,
            deposit.operations_safe_address,
            deposit.expected_amount_usdt,
            GUARANTEE_MINIMUM_USDT.toString(),
            observation.transferEvidenceHash,
            observation.observedAt,
          ],
        );
      }
      await updateObservedState(executor, deposit, observation, 'FINAL', journalId);
      await insertTransition(executor, {
        depositId,
        eventType: 'FINAL',
        previousState: deposit.state,
        blockNumber: observation.blockNumber,
        blockHash: observation.blockHash,
        logIndex: observation.logIndex,
        confirmations: observation.confirmations,
        evidenceHash: observation.transferEvidenceHash,
        observedAt: observation.observedAt,
      });
      await resolveReorgExposures(executor, deposit, observation);
      await updateMerchantGuaranteeStatus(executor, deposit.merchant_id);
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:guarantee-finality', {
          depositId,
          blockHash: observation.blockHash,
          evidenceHash: observation.transferEvidenceHash,
        }),
        streamName: 'financial',
        evidenceProfile: 'CHAIN_FINAL',
        eventType: 'GuaranteeDepositFinalized',
        resourceType: 'MERCHANT_GUARANTEE',
        resourceId: deposit.merchant_id,
        actorWallet: deposit.merchant_wallet,
        actorRole: 'MERCHANT',
        correlationId: deposit.correlation_id,
        requestHash: observation.transferEvidenceHash.slice(2),
        payload: {
          depositId,
          amountUsdt: deposit.expected_amount_usdt,
          operationsSafeAddress: deposit.operations_safe_address,
          evidenceHash: observation.transferEvidenceHash,
        },
        transactionEvidence: {
          txHash: observation.transactionHash,
          chainId: 56,
          contractAddress: USDT_ADDRESS,
          eventSignatureHash: TRANSFER_EVENT_SIGNATURE_HASH,
          logIndex: observation.logIndex,
          resourceId: deposit.merchant_id,
          policyVersion: Number(deposit.policy_version),
          blockHash: observation.blockHash,
          confirmations: observation.confirmations,
        },
        createdAt: observation.observedAt,
      });
      return depositProjection(await lockDeposit(executor, depositId));
    });
  }

  recordReorg(depositId: string, observation: GuaranteeDepositReorgObservation) {
    validateReorgObservation(observation);
    return this.#transactions.transaction(async (executor) => {
      const deposit = await lockDeposit(executor, depositId);
      if (
        deposit.transaction_hash !== observation.transactionHash.toLowerCase()
        || Number(deposit.observed_block_number) !== observation.previousBlockNumber
        || deposit.observed_block_hash !== observation.previousBlockHash.toLowerCase()
        || deposit.observed_log_index !== observation.previousLogIndex
      ) throw new CoreError('InvalidFinality', 'Guarantee reorg does not match the observed transfer', 409);
      const alreadyRecorded = await executor.query<{ transition_id: string }>(
        `SELECT transition_id FROM core.merchant_guarantee_deposit_transitions
         WHERE deposit_id = $1 AND event_type = 'REORGED' AND evidence_hash = $2`,
        [depositId, observation.evidenceHash.toLowerCase()],
      );
      if (alreadyRecorded.rows[0]) return depositProjection(deposit);
      await executor.query(
        `UPDATE core.merchant_guarantee_deposit_submissions SET state = 'REORGED',
           confirmations = $2, finalized_at = NULL, updated_at = $3
         WHERE deposit_id = $1`,
        [depositId, observation.confirmations, observation.observedAt],
      );
      await insertTransition(executor, {
        depositId,
        eventType: 'REORGED',
        previousState: deposit.state,
        blockNumber: observation.previousBlockNumber,
        blockHash: observation.previousBlockHash,
        canonicalBlockHash: observation.canonicalBlockHash,
        logIndex: observation.previousLogIndex,
        confirmations: observation.confirmations,
        evidenceHash: observation.evidenceHash,
        observedAt: observation.observedAt,
      });
      if (deposit.final_journal_id) {
        await executor.query(
          `INSERT INTO core.merchant_guarantee_reorg_exposures (
             exposure_id, deposit_id, merchant_id, journal_id, amount_usdt,
             previous_block_hash, canonical_block_hash, evidence_hash, state, opened_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9)
           ON CONFLICT (deposit_id, previous_block_hash, canonical_block_hash) DO NOTHING`,
          [
            `guarantee-reorg-exposure:${randomUUID()}`,
            depositId,
            deposit.merchant_id,
            deposit.final_journal_id,
            deposit.expected_amount_usdt,
            observation.previousBlockHash,
            observation.canonicalBlockHash,
            observation.evidenceHash,
            observation.observedAt,
          ],
        );
        await executor.query(
          "UPDATE core.merchants SET guarantee_status = 'FROZEN', updated_at = $2 WHERE merchant_id = $1",
          [deposit.merchant_id, observation.observedAt],
        );
        await activateReorgBreaker(executor, depositId, Number(deposit.policy_version), observation.evidenceHash, observation.observedAt);
      }
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:guarantee-reorg', {
          depositId,
          previousBlockHash: observation.previousBlockHash,
          canonicalBlockHash: observation.canonicalBlockHash,
          evidenceHash: observation.evidenceHash,
        }),
        streamName: 'financial',
        evidenceProfile: 'CHAIN_OBSERVED',
        eventType: 'GuaranteeDepositReorged',
        resourceType: 'MERCHANT_GUARANTEE',
        resourceId: deposit.merchant_id,
        actorWallet: deposit.merchant_wallet,
        actorRole: 'MERCHANT',
        correlationId: deposit.correlation_id,
        requestHash: observation.evidenceHash.slice(2),
        payload: {
          depositId,
          previousBlockHash: observation.previousBlockHash,
          canonicalBlockHash: observation.canonicalBlockHash,
          evidenceHash: observation.evidenceHash,
        },
        transactionEvidence: {
          txHash: deposit.transaction_hash,
          chainId: 56,
          contractAddress: USDT_ADDRESS,
          eventSignatureHash: TRANSFER_EVENT_SIGNATURE_HASH,
          logIndex: observation.previousLogIndex,
          resourceId: deposit.merchant_id,
          policyVersion: Number(deposit.policy_version),
          blockHash: observation.previousBlockHash,
          confirmations: observation.confirmations,
        },
        createdAt: observation.observedAt,
      });
      return depositProjection(await lockDeposit(executor, depositId));
    });
  }
}

async function lockDeposit(executor: SqlExecutor, depositId: string) {
  const result = await executor.query<DepositRow>(
    'SELECT * FROM core.merchant_guarantee_deposit_submissions WHERE deposit_id = $1 FOR UPDATE',
    [depositId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Guarantee deposit was not found', 404);
  return result.rows[0];
}

async function updateObservedState(
  executor: SqlExecutor,
  deposit: DepositRow,
  observation: GuaranteeDepositChainObservation,
  state: 'MINED' | 'FINAL',
  journalId?: string,
) {
  await executor.query(
    `UPDATE core.merchant_guarantee_deposit_submissions SET state = $2,
       observed_block_number = $3, observed_block_hash = $4, observed_log_index = $5,
       confirmations = $6, transfer_evidence_hash = $7,
       final_journal_id = COALESCE($8, final_journal_id),
       finalized_at = CASE WHEN $2 = 'FINAL' THEN $9::timestamptz ELSE NULL END,
       updated_at = $9::timestamptz
     WHERE deposit_id = $1`,
    [
      deposit.deposit_id,
      state,
      observation.blockNumber,
      observation.blockHash,
      observation.logIndex,
      observation.confirmations,
      observation.transferEvidenceHash,
      journalId ?? null,
      observation.observedAt,
    ],
  );
}

async function postGuaranteeJournal(
  executor: SqlExecutor,
  deposit: DepositRow,
  observation: GuaranteeDepositChainObservation,
  journalId: string,
) {
  const safeAccount = `safe:operations:${deposit.operations_safe_address}:usdt`;
  const liabilityAccount = `guarantee:${deposit.merchant_id}:${deposit.operations_safe_address}:usdt`;
  await ensureAccount(executor, safeAccount, 'SAFE', deposit.operations_safe_address, 'SAFE_ASSET', deposit.operations_safe_address);
  await ensureAccount(executor, liabilityAccount, 'MERCHANT', deposit.merchant_id, 'GUARANTEE_LIABILITY');
  const lines = [
    {
      account_id: safeAccount,
      side: 'DEBIT',
      amount: deposit.expected_amount_usdt,
      balance_state: 'POSTED',
      backing_safe_address: deposit.operations_safe_address,
    },
    {
      account_id: liabilityAccount,
      side: 'CREDIT',
      amount: deposit.expected_amount_usdt,
      balance_state: 'AVAILABLE',
      backing_safe_address: deposit.operations_safe_address,
    },
  ];
  const contentHash = hashJson({
    depositId: deposit.deposit_id,
    merchantId: deposit.merchant_id,
    policyVersion: Number(deposit.policy_version),
    transactionHash: observation.transactionHash,
    blockHash: observation.blockHash,
    logIndex: observation.logIndex,
    transferEvidenceHash: observation.transferEvidenceHash,
    lines,
  });
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,NULL,$12,$13)',
    [
      journalId,
      `guarantee-deposit:${deposit.deposit_id}`,
      'GUARANTEE_DEPOSITED',
      'MERCHANT_GUARANTEE',
      deposit.merchant_id,
      Number(deposit.policy_version),
      contentHash,
      observation.transactionHash,
      observation.blockHash,
      'CHAIN_EVENT',
      observation.transferEvidenceHash,
      JSON.stringify({
        depositId: deposit.deposit_id,
        blockNumber: observation.blockNumber,
        logIndex: observation.logIndex,
        confirmations: observation.confirmations,
      }),
      JSON.stringify(lines),
    ],
  );
}

async function ensureAccount(
  executor: SqlExecutor,
  accountId: string,
  ownerType: 'SAFE' | 'MERCHANT',
  ownerId: string,
  purpose: 'SAFE_ASSET' | 'GUARANTEE_LIABILITY',
  safeAddress?: string,
) {
  await executor.query(
    `INSERT INTO core.ledger_accounts (
       account_id, owner_type, owner_id, asset, purpose, safe_address
     ) VALUES ($1,$2,$3,'USDT',$4,$5) ON CONFLICT (account_id) DO NOTHING`,
    [accountId, ownerType, ownerId, purpose, safeAddress ?? null],
  );
  const result = await executor.query<{
    owner_type: string;
    owner_id: string;
    asset: string;
    purpose: string;
    safe_address: string | null;
  }>('SELECT owner_type, owner_id, asset, purpose, safe_address FROM core.ledger_accounts WHERE account_id = $1', [accountId]);
  const row = result.rows[0];
  if (
    !row
    || row.owner_type !== ownerType
    || row.owner_id !== ownerId
    || row.asset !== 'USDT'
    || row.purpose !== purpose
    || row.safe_address !== (safeAddress ?? null)
  ) throw new CoreError('InvalidFinality', 'Guarantee ledger account identity mismatch', 409);
}

async function insertTransition(executor: SqlExecutor, input: {
  depositId: string;
  eventType: 'SUBMITTED' | 'MINED' | 'FINAL' | 'REORGED' | 'QUARANTINED';
  previousState: string | null;
  blockNumber?: number;
  blockHash?: string;
  canonicalBlockHash?: string;
  logIndex?: number;
  confirmations: number;
  evidenceHash: string;
  observedAt: Date;
}) {
  await executor.query(
    `INSERT INTO core.merchant_guarantee_deposit_transitions (
       transition_id, deposit_id, event_type, previous_state, block_number,
       block_hash, canonical_block_hash, log_index, confirmations, evidence_hash, observed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (deposit_id, event_type, evidence_hash) DO NOTHING`,
    [
      `guarantee-deposit-transition:${randomUUID()}`,
      input.depositId,
      input.eventType,
      input.previousState,
      input.blockNumber ?? null,
      input.blockHash?.toLowerCase() ?? null,
      input.canonicalBlockHash?.toLowerCase() ?? null,
      input.logIndex ?? null,
      input.confirmations,
      input.evidenceHash.toLowerCase(),
      input.observedAt,
    ],
  );
}

async function activateReorgBreaker(
  executor: SqlExecutor,
  depositId: string,
  policyVersion: number,
  evidenceHash: string,
  observedAt: Date,
) {
  const causeId = `guarantee-reorg:${depositId}`;
  for (const scope of ['NEW_PAYMENT', 'NEW_SETTLEMENT_BATCH'] as const) {
    await executor.query(
      `INSERT INTO core.breaker_causes (
         scope, cause_type, cause_id, active, evidence_hash, updated_at
       ) VALUES ($1,'SECURITY',$2,true,$3,$4)
       ON CONFLICT (scope, cause_type, cause_id) DO UPDATE
         SET active = true, evidence_hash = EXCLUDED.evidence_hash, updated_at = EXCLUDED.updated_at`,
      [scope, causeId, evidenceHash, observedAt],
    );
    await executor.query(
      `INSERT INTO core.breaker_events (
         breaker_event_id, scope, action, cause_type, cause_id,
         evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,$2,'PAUSE','SECURITY',$3,$4,$5,'GUARANTEE_FINALITY_WORKER',$6)
       ON CONFLICT (breaker_event_id) DO NOTHING`,
      [hashJson({ scope, causeId, evidenceHash }), scope, causeId, evidenceHash, policyVersion, observedAt],
    );
    await executor.query(
      `INSERT INTO core.circuit_breakers (
         scope, paused, evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,true,$2,$3,'GUARANTEE_FINALITY_WORKER',$4)
       ON CONFLICT (scope) DO UPDATE SET paused = true,
         evidence_hash = EXCLUDED.evidence_hash, policy_version = EXCLUDED.policy_version,
         changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
      [scope, evidenceHash, policyVersion, observedAt],
    );
  }
}

async function resolveReorgExposures(
  executor: SqlExecutor,
  deposit: DepositRow,
  observation: GuaranteeDepositChainObservation,
) {
  const result = await executor.query<{ exposure_id: string }>(
    `UPDATE core.merchant_guarantee_reorg_exposures SET state = 'RESOLVED',
       resolved_at = $2, resolution_evidence_hash = $3
     WHERE deposit_id = $1 AND state = 'OPEN' RETURNING exposure_id`,
    [deposit.deposit_id, observation.observedAt, observation.transferEvidenceHash],
  );
  if (result.rows.length === 0) return;
  await executor.query(
    `UPDATE core.breaker_causes SET active = false, evidence_hash = $2, updated_at = $3
     WHERE cause_type = 'SECURITY' AND cause_id = $1 AND active`,
    [`guarantee-reorg:${deposit.deposit_id}`, observation.transferEvidenceHash, observation.observedAt],
  );
}

async function updateMerchantGuaranteeStatus(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<{ balance_usdt: string; status: string; exposure_count: string }>(
    `SELECT guarantee.balance_usdt::text, merchant.status,
       (SELECT count(*)::text FROM core.merchant_guarantee_reorg_exposures exposure
        WHERE exposure.merchant_id = merchant.merchant_id AND exposure.state = 'OPEN') AS exposure_count
     FROM core.merchant_guarantees guarantee
     JOIN core.merchants merchant ON merchant.merchant_id = guarantee.merchant_id
     WHERE guarantee.merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('InvalidFinality', 'Merchant guarantee projection is unavailable', 409);
  const state = row.status === 'SUSPENDED' || row.status === 'BLACKLISTED' || row.exposure_count !== '0'
    ? 'FROZEN'
    : BigInt(row.balance_usdt) >= GUARANTEE_MINIMUM_USDT ? 'READY' : 'BELOW_MINIMUM';
  await executor.query(
    'UPDATE core.merchants SET guarantee_status = $2, updated_at = clock_timestamp() WHERE merchant_id = $1',
    [merchantId, state],
  );
}

function assertObservationMatchesDeposit(deposit: DepositRow, observation: GuaranteeDepositChainObservation) {
  if (
    deposit.transaction_hash !== observation.transactionHash.toLowerCase()
    || deposit.token_address !== observation.tokenAddress.toLowerCase()
    || deposit.merchant_wallet !== normalizedAddress(observation.from, 'guarantee transfer sender')
    || deposit.operations_safe_address !== normalizedAddress(observation.to, 'guarantee transfer recipient')
    || deposit.expected_amount_usdt !== observation.amount
  ) throw new CoreError('InvalidFinality', 'Guarantee transfer does not match the frozen submission', 409);
}

function validateChainObservation(observation: GuaranteeDepositChainObservation) {
  if (observation.state === 'FINAL' && observation.confirmations < 15) {
    throw new CoreError('InvalidFinality', 'Final guarantee has fewer than 15 confirmations', 409);
  }
  if (observation.state === 'MINED' && observation.confirmations >= 15) {
    throw new CoreError('InvalidFinality', 'Mined guarantee observation already satisfies finality', 409);
  }
  if (
    !isHash(observation.transactionHash)
    || observation.tokenAddress.toLowerCase() !== USDT_ADDRESS
    || !/^[1-9][0-9]*$/.test(observation.amount)
    || !Number.isSafeInteger(observation.blockNumber)
    || observation.blockNumber < 0
    || !isHash(observation.blockHash)
    || !Number.isSafeInteger(observation.logIndex)
    || observation.logIndex < 0
    || !Number.isSafeInteger(observation.confirmations)
    || observation.confirmations < 1
    || observation.receiptStatus !== 1
    || observation.canonicalBlock !== true
    || !isHash(observation.transferEvidenceHash)
    || Number.isNaN(new Date(observation.observedAt).getTime())
  ) throw new CoreError('InvalidFinality', 'Guarantee deposit lacks canonical transfer evidence', 409);
  normalizedAddress(observation.from, 'guarantee transfer sender');
  normalizedAddress(observation.to, 'guarantee transfer recipient');
}

function validateReorgObservation(observation: GuaranteeDepositReorgObservation) {
  if (
    !isHash(observation.transactionHash)
    || !Number.isSafeInteger(observation.previousBlockNumber)
    || observation.previousBlockNumber < 0
    || !isHash(observation.previousBlockHash)
    || !Number.isSafeInteger(observation.previousLogIndex)
    || observation.previousLogIndex < 0
    || !isHash(observation.canonicalBlockHash)
    || observation.canonicalBlockHash.toLowerCase() === observation.previousBlockHash.toLowerCase()
    || !Number.isSafeInteger(observation.confirmations)
    || observation.confirmations < 0
    || !isHash(observation.evidenceHash)
    || Number.isNaN(new Date(observation.observedAt).getTime())
  ) throw new CoreError('InvalidFinality', 'Guarantee reorg evidence is invalid', 409);
}

function finalityProjection(row: DepositRow): GuaranteeDepositFinalityItem {
  return {
    depositId: row.deposit_id,
    merchantId: row.merchant_id,
    merchantWallet: row.merchant_wallet,
    policyVersion: Number(row.policy_version),
    tokenAddress: row.token_address,
    operationsSafeAddress: row.operations_safe_address,
    expectedAmountUsdt: row.expected_amount_usdt,
    transactionHash: row.transaction_hash,
    state: row.state,
    ...(row.observed_block_number === null ? {} : { observedBlockNumber: Number(row.observed_block_number) }),
    ...(row.observed_block_hash === null ? {} : { observedBlockHash: row.observed_block_hash }),
    ...(row.observed_log_index === null ? {} : { observedLogIndex: row.observed_log_index }),
    confirmations: row.confirmations,
  };
}

function depositProjection(row: DepositRow) {
  return {
    depositId: row.deposit_id,
    merchantId: row.merchant_id,
    policyVersion: Number(row.policy_version),
    transactionHash: row.transaction_hash,
    expectedAmountUsdt: row.expected_amount_usdt,
    operationsSafeAddress: row.operations_safe_address,
    state: row.state,
    confirmations: row.confirmations,
    ...(row.observed_block_number === null ? {} : { blockNumber: Number(row.observed_block_number) }),
    ...(row.observed_block_hash === null ? {} : { blockHash: row.observed_block_hash }),
    ...(row.observed_log_index === null ? {} : { logIndex: row.observed_log_index }),
  };
}

function positiveSafeInteger(value: string, name: string) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return result;
}

function normalizedAddress(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(canonicalJson(value))).toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
