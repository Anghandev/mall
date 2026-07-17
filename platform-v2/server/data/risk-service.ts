import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit, type AuditOutboxInput } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const TWENTY_MINUTES_MS = 20 * 60 * 1_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

export type RiskSignalType =
  | 'HIGH_GAS'
  | 'WALLET_CONTEXT'
  | 'ORDER_CANCELLATION'
  | 'ADDRESS_CHANGE'
  | 'PICKUP_STORE_CHANGE';
export type RiskSourceType =
  | 'CHAIN_MONITOR'
  | 'EDGE_AUTH'
  | 'ORDER_SERVICE'
  | 'ACCOUNT_SERVICE'
  | 'FULFILLMENT_TARGET_SERVICE';
export type RiskSubjectType = 'WALLET' | 'IP' | 'DEVICE';

export interface RiskObservationInput {
  observationId: string;
  signalType: RiskSignalType;
  sourceType: RiskSourceType;
  walletAddress: string;
  ipHash?: string;
  deviceHash?: string;
  resourceId?: string;
  txHash?: string;
  gasPriceWei?: string;
  evidenceHash: string;
  observedAt: string;
}

interface RestrictionRow {
  restriction_id: string;
  subject_type: RiskSubjectType;
  subject_value: string;
  restriction_kind: 'NEW_PAYMENT' | 'BLACKLIST';
  trigger_type: 'HIGH_GAS' | 'WALLET_SWITCH' | 'ORDER_CANCELLATION' | 'SUBJECT_BLACKLIST' | 'MANUAL';
  reason_code: string;
  evidence_hash: string;
  source_observation_id: string | null;
  state: 'ACTIVE' | 'EXPIRED' | 'OVERRIDDEN';
  starts_at: Date;
  expires_at: Date | null;
  created_by: string | null;
  request_hash: string;
  override_by: string | null;
  override_reason_code: string | null;
  override_evidence_hash: string | null;
  override_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AppealRow {
  appeal_id: string;
  restriction_id: string;
  submitted_by: string;
  statement_hash: string;
  evidence_hash: string;
  state: 'PENDING' | 'APPROVED' | 'REJECTED';
  request_hash: string;
  decided_by: string | null;
  decision_reason_code: string | null;
  decision_evidence_hash: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ObservationRow {
  observation_id: string;
  signal_type: RiskSignalType;
  source_type: RiskObservationInput['sourceType'];
  wallet_address: string;
  ip_hash: string | null;
  device_hash: string | null;
  resource_id: string | null;
  tx_hash: string | null;
  gas_price_wei: string | number | null;
  evidence_hash: string;
  observed_at: Date;
  recorded_at: Date;
  request_hash: string;
}

export class RiskService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;

  constructor(input: { transactions: SqlTransactionRunner; clock?: () => Date }) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
  }

  ingestObservation(input: RiskObservationInput, correlationId: string) {
    const normalized = normalizeObservation(input);
    const requestHash = hashJson(normalized);
    const recordedAt = this.#clock();
    if (normalized.observedAt.getTime() > recordedAt.getTime() + 60_000) {
      throw new CoreError('InvalidRequest', 'Risk observation is too far in the future');
    }
    return this.#transactions.transaction(async (executor) => {
      const existing = await executor.query<ObservationRow>(
        'SELECT * FROM core.risk_observations WHERE observation_id = $1',
        [normalized.observationId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Risk observation id was reused', 409);
        }
        await expireRestrictions(executor, recordedAt);
        return this.#observationResult(executor, existing.rows[0]);
      }
      await executor.query(
        `INSERT INTO core.risk_observations (
           observation_id, signal_type, source_type, wallet_address, ip_hash, device_hash,
           resource_id, tx_hash, gas_price_wei, evidence_hash, request_hash, observed_at, recorded_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          normalized.observationId,
          normalized.signalType,
          normalized.sourceType,
          normalized.walletAddress,
          normalized.ipHash,
          normalized.deviceHash,
          normalized.resourceId,
          normalized.txHash,
          normalized.gasPriceWei,
          normalized.evidenceHash,
          requestHash,
          normalized.observedAt,
          recordedAt,
        ],
      );
      const created: string[] = [];
      if (normalized.signalType === 'HIGH_GAS') {
        const threshold = await highGasThreshold(executor);
        if (BigInt(normalized.gasPriceWei!) > threshold) {
          created.push(await createRestriction(executor, {
            subjectType: 'WALLET',
            subjectValue: normalized.walletAddress,
            restrictionKind: 'NEW_PAYMENT',
            triggerType: 'HIGH_GAS',
            reasonCode: 'HIGH_GAS_24H',
            evidenceHash: normalized.evidenceHash,
            sourceObservationId: normalized.observationId,
            startsAt: normalized.observedAt,
            expiresAt: new Date(normalized.observedAt.getTime() + TWENTY_FOUR_HOURS_MS),
            requestHash,
          }));
        }
      } else if (normalized.signalType === 'WALLET_CONTEXT') {
        for (const [subjectType, subjectHash] of [
          ['IP', normalized.ipHash],
          ['DEVICE', normalized.deviceHash],
        ] as const) {
          if (!subjectHash) continue;
          await linkSubjectWallet(executor, subjectType, subjectHash, normalized);
          const blocked = await activeSubjectRestriction(executor, subjectType, subjectHash, normalized.observedAt);
          if (blocked) {
            created.push(await mirrorSubjectRestriction(executor, blocked, normalized));
            continue;
          }
          const walletCount = await distinctWalletsInMinute(executor, subjectType, subjectHash, normalized.observedAt);
          if (walletCount > 5) {
            const subjectRestrictionId = await createRestriction(executor, {
              subjectType,
              subjectValue: subjectHash,
              restrictionKind: 'BLACKLIST',
              triggerType: 'WALLET_SWITCH',
              reasonCode: 'WALLET_SWITCH_GT5_1M',
              evidenceHash: normalized.evidenceHash,
              sourceObservationId: normalized.observationId,
              startsAt: normalized.observedAt,
              expiresAt: null,
              requestHash,
            });
            created.push(subjectRestrictionId);
            created.push(...await mirrorSubjectWallets(executor, subjectType, subjectHash, {
              sourceKey: normalized.observationId,
              sourceObservationId: normalized.observationId,
              restrictionKind: 'BLACKLIST',
              reasonCode: 'SUBJECT_BLACKLISTED',
              evidenceHash: normalized.evidenceHash,
              observedAt: normalized.observedAt,
              expiresAt: null,
            }));
          }
        }
      } else if (normalized.signalType === 'ORDER_CANCELLATION') {
        const count = await cancellationsInWindow(executor, normalized.walletAddress, normalized.observedAt);
        if (count >= 3) {
          created.push(await createRestriction(executor, {
            subjectType: 'WALLET',
            subjectValue: normalized.walletAddress,
            restrictionKind: 'NEW_PAYMENT',
            triggerType: 'ORDER_CANCELLATION',
            reasonCode: 'THREE_CANCELLATIONS_5M',
            evidenceHash: normalized.evidenceHash,
            sourceObservationId: normalized.observationId,
            startsAt: normalized.observedAt,
            expiresAt: new Date(normalized.observedAt.getTime() + TWO_HOURS_MS),
            requestHash,
          }));
        }
      }
      await enqueueRiskAudit(executor, {
        eventType: 'RiskObservationRecorded',
        resourceType: 'RISK_OBSERVATION',
        resourceId: normalized.observationId,
        actorWallet: normalized.walletAddress,
        actorRole: 'SYSTEM',
        correlationId,
        requestHash,
        payload: {
          evidenceHash: normalized.evidenceHash,
          signalType: normalized.signalType,
          createdRestrictionIds: created,
        },
        createdAt: recordedAt,
      });
      return this.#observationResult(executor, {
        observation_id: normalized.observationId,
        signal_type: normalized.signalType,
        source_type: normalized.sourceType,
        wallet_address: normalized.walletAddress,
        ip_hash: normalized.ipHash,
        device_hash: normalized.deviceHash,
        resource_id: normalized.resourceId,
        tx_hash: normalized.txHash,
        gas_price_wei: normalized.gasPriceWei,
        evidence_hash: normalized.evidenceHash,
        observed_at: normalized.observedAt,
        recorded_at: recordedAt,
        request_hash: requestHash,
      });
    });
  }

  listOverview(actor: FulfillmentActor) {
    requireRole(actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
    return this.#transactions.transaction(async (executor) => {
      await requireDatabaseRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      await expireRestrictions(executor, this.#clock());
      const [observations, restrictions, appeals] = await Promise.all([
        executor.query<ObservationRow>('SELECT * FROM core.risk_observations ORDER BY observed_at DESC, observation_id DESC LIMIT 100'),
        executor.query<RestrictionRow>('SELECT * FROM core.risk_restrictions ORDER BY created_at DESC, restriction_id DESC LIMIT 100'),
        executor.query<AppealRow>('SELECT * FROM core.risk_appeals ORDER BY created_at DESC, appeal_id DESC LIMIT 100'),
      ]);
      return Object.freeze({
        artifactVersion: CORE_ARTIFACT_VERSION,
        generatedAt: this.#clock().toISOString(),
        observations: observations.rows.map(observationProjection),
        restrictions: restrictions.rows.map(restrictionProjection),
        appeals: appeals.rows.map(appealProjection),
        decisionBlocked: Object.freeze([
          { capability: 'LOW_HISTORY_WALLET_CLUSTERING', reasonCode: 'ExternalBlocked' as const },
          { capability: 'PRODUCTION_DEVICE_FINGERPRINT_SOURCE', reasonCode: 'ExternalBlocked' as const },
        ]),
      });
    });
  }

  createManualRestriction(actor: FulfillmentActor, input: {
    subjectType: RiskSubjectType;
    subjectValue: string;
    restrictionKind: 'NEW_PAYMENT' | 'BLACKLIST';
    reasonCode: string;
    evidenceHash: string;
    expiresAt?: string;
    idempotencyKey: string;
    correlationId: string;
  }) {
    requireRole(actor, ['ADMIN']);
    const now = this.#clock();
    const subjectValue = normalizeSubject(input.subjectType, input.subjectValue);
    const expiresAt = input.expiresAt === undefined ? null : timestamp(input.expiresAt, 'risk expiry');
    if (expiresAt && expiresAt <= now) throw new CoreError('InvalidRequest', 'Risk expiry must be in the future');
    const reasonCode = reason(input.reasonCode);
    const evidenceHash = hash(input.evidenceHash, 'risk evidence');
    const requestHash = hashJson({ ...input, subjectValue, expiresAt });
    return this.#transactions.transaction(async (executor) => {
      const actorWallet = await requireDatabaseRole(executor, actor, ['ADMIN']);
      const prior = await executor.query<RestrictionRow>(
        'SELECT * FROM core.risk_restrictions WHERE created_by = $1 AND idempotency_key = $2',
        [actorWallet, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new CoreError('IdempotencyConflict', 'Risk command changed', 409);
        return restrictionProjection(prior.rows[0]);
      }
      const restrictionId = await createRestriction(executor, {
        subjectType: input.subjectType,
        subjectValue,
        restrictionKind: input.restrictionKind,
        triggerType: 'MANUAL',
        reasonCode,
        evidenceHash,
        sourceObservationId: null,
        startsAt: now,
        expiresAt,
        createdBy: actorWallet,
        idempotencyKey: key(input.idempotencyKey),
        requestHash,
      });
      if (input.subjectType !== 'WALLET') {
        await mirrorSubjectWallets(executor, input.subjectType, subjectValue, {
          sourceKey: restrictionId,
          sourceObservationId: null,
          restrictionKind: input.restrictionKind,
          reasonCode,
          evidenceHash,
          observedAt: now,
          expiresAt,
        });
      }
      const row = await restriction(executor, restrictionId);
      await enqueueRbacAudit(executor, actor, actorWallet, 'RiskRestrictionCreated', row, input.correlationId, requestHash, now);
      return restrictionProjection(row);
    });
  }

  overrideRestriction(actor: FulfillmentActor, restrictionId: string, input: {
    reasonCode: string;
    evidenceHash: string;
    correlationId: string;
  }) {
    requireRole(actor, ['ADMIN']);
    hash(restrictionId, 'restriction id');
    const now = this.#clock();
    return this.#transactions.transaction(async (executor) => {
      const actorWallet = await requireDatabaseRole(executor, actor, ['ADMIN']);
      await expireRestrictions(executor, now);
      const row = await restriction(executor, restrictionId, true);
      if (row.state === 'OVERRIDDEN') return restrictionProjection(row);
      if (row.state !== 'ACTIVE') throw new CoreError('InvalidRequest', 'Only active restrictions can be overridden', 409);
      const reasonCode = reason(input.reasonCode);
      const evidenceHash = hash(input.evidenceHash, 'override evidence');
      await executor.query(
        `UPDATE core.risk_restrictions SET state = 'OVERRIDDEN', override_by = $2,
           override_reason_code = $3, override_evidence_hash = $4, override_at = $5, updated_at = $5
         WHERE restriction_id = $1`,
        [restrictionId, actorWallet, reasonCode, evidenceHash, now],
      );
      await restrictionEvent(executor, restrictionId, 'OVERRIDDEN', actorWallet, reasonCode, evidenceHash, now);
      const updated = await restriction(executor, restrictionId);
      const requestHash = hashJson({ restrictionId, reasonCode, evidenceHash });
      await enqueueRbacAudit(executor, actor, actorWallet, 'RiskRestrictionOverridden', updated, input.correlationId, requestHash, now);
      return restrictionProjection(updated);
    });
  }

  submitAppeal(actor: FulfillmentActor, input: {
    restrictionId: string;
    statementHash: string;
    evidenceHash: string;
    idempotencyKey: string;
    correlationId: string;
  }) {
    requireRole(actor, ['ADMIN', 'OPERATOR']);
    hash(input.restrictionId, 'restriction id');
    const now = this.#clock();
    const requestHash = hashJson(input);
    return this.#transactions.transaction(async (executor) => {
      const actorWallet = await requireDatabaseRole(executor, actor, ['ADMIN', 'OPERATOR']);
      await restriction(executor, input.restrictionId);
      const prior = await executor.query<AppealRow>(
        'SELECT * FROM core.risk_appeals WHERE submitted_by = $1 AND idempotency_key = $2',
        [actorWallet, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new CoreError('IdempotencyConflict', 'Risk appeal changed', 409);
        return appealProjection(prior.rows[0]);
      }
      const appealId = hashJson({ domain: 'ABU24K_RISK_APPEAL_V1', actorWallet, idempotencyKey: input.idempotencyKey });
      await executor.query(
        `INSERT INTO core.risk_appeals (
           appeal_id, restriction_id, submitted_by, statement_hash, evidence_hash,
           state, idempotency_key, request_hash, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8,$8)`,
        [appealId, input.restrictionId, actorWallet, hash(input.statementHash, 'appeal statement'), hash(input.evidenceHash, 'appeal evidence'), key(input.idempotencyKey), requestHash, now],
      );
      const row = (await executor.query<AppealRow>('SELECT * FROM core.risk_appeals WHERE appeal_id = $1', [appealId])).rows[0]!;
      await enqueueRbacAudit(executor, actor, actorWallet, 'RiskAppealSubmitted', row, input.correlationId, requestHash, now);
      return appealProjection(row);
    });
  }

  decideAppeal(actor: FulfillmentActor, appealId: string, input: {
    decision: 'APPROVE' | 'REJECT';
    reasonCode: string;
    evidenceHash: string;
    correlationId: string;
  }) {
    requireRole(actor, ['ADMIN']);
    hash(appealId, 'appeal id');
    const now = this.#clock();
    return this.#transactions.transaction(async (executor) => {
      const actorWallet = await requireDatabaseRole(executor, actor, ['ADMIN']);
      const result = await executor.query<AppealRow>('SELECT * FROM core.risk_appeals WHERE appeal_id = $1 FOR UPDATE', [appealId]);
      const row = result.rows[0];
      if (!row) throw new CoreError('InvalidRequest', 'Risk appeal not found', 404);
      if (row.state !== 'PENDING') return appealProjection(row);
      const state = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const reasonCode = reason(input.reasonCode);
      const evidenceHash = hash(input.evidenceHash, 'appeal decision evidence');
      await executor.query(
        `UPDATE core.risk_appeals SET state = $2, decided_by = $3,
           decision_reason_code = $4, decision_evidence_hash = $5,
           decided_at = $6, updated_at = $6 WHERE appeal_id = $1`,
        [appealId, state, actorWallet, reasonCode, evidenceHash, now],
      );
      if (state === 'APPROVED') {
        const restrictionRow = await restriction(executor, row.restriction_id, true);
        if (restrictionRow.state === 'ACTIVE') {
          await executor.query(
            `UPDATE core.risk_restrictions SET state = 'OVERRIDDEN', override_by = $2,
               override_reason_code = $3, override_evidence_hash = $4,
               override_at = $5, updated_at = $5 WHERE restriction_id = $1`,
            [row.restriction_id, actorWallet, reasonCode, evidenceHash, now],
          );
          await restrictionEvent(executor, row.restriction_id, 'OVERRIDDEN', actorWallet, reasonCode, evidenceHash, now);
        }
      }
      const updated = (await executor.query<AppealRow>('SELECT * FROM core.risk_appeals WHERE appeal_id = $1', [appealId])).rows[0]!;
      const requestHash = hashJson({ appealId, ...input });
      await enqueueRbacAudit(executor, actor, actorWallet, 'RiskAppealDecided', updated, input.correlationId, requestHash, now);
      return appealProjection(updated);
    });
  }

  async #observationResult(executor: SqlExecutor, row: ObservationRow) {
    const restrictions = await executor.query<RestrictionRow>(
      'SELECT * FROM core.risk_restrictions WHERE source_observation_id = $1 ORDER BY restriction_id',
      [row.observation_id],
    );
    return Object.freeze({
      artifactVersion: CORE_ARTIFACT_VERSION,
      observation: observationProjection(row),
      restrictions: restrictions.rows.map(restrictionProjection),
    });
  }
}

export async function assertWalletPaymentAllowed(executor: SqlExecutor, walletAddress: string, now: Date) {
  await expireRestrictions(executor, now);
  const wallet = address(walletAddress);
  const result = await executor.query<RestrictionRow>(
    `SELECT * FROM core.risk_restrictions
     WHERE subject_type = 'WALLET' AND subject_value = $1 AND state = 'ACTIVE'
       AND starts_at <= $2 AND (expires_at IS NULL OR expires_at > $2)
     ORDER BY starts_at DESC, restriction_id DESC LIMIT 1`,
    [wallet, now],
  );
  if (result.rows[0]) {
    throw new CoreError('RiskRestricted', 'Wallet is restricted from creating new payment quotes', 403, {
      restrictionId: result.rows[0].restriction_id,
      reasonCode: result.rows[0].reason_code,
      expiresAt: result.rows[0].expires_at?.toISOString() ?? null,
    });
  }
}

export async function recordFrequentChangeAlert(executor: SqlExecutor, input: {
  signalType: 'ADDRESS_CHANGE' | 'PICKUP_STORE_CHANGE';
  walletAddress: string;
  resourceId: string;
  requestHash: string;
  correlationId: string;
  observedAt: Date;
}) {
  const walletAddress = address(input.walletAddress);
  const eventTypes = input.signalType === 'ADDRESS_CHANGE'
    ? ['BuyerAddressCreated', 'BuyerAddressUpdated', 'BuyerAddressDeleted', 'BuyerDefaultAddressChanged']
    : ['BuyerPickupStoreTargetChanged'];
  const count = await executor.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM core.audit_outbox_events
     WHERE actor_wallet = $1 AND event_type = ANY($2::text[])
       AND created_at > $3 AND created_at <= $4`,
    [walletAddress, eventTypes, new Date(input.observedAt.getTime() - TWENTY_MINUTES_MS), input.observedAt],
  );
  const changeCount = Number(count.rows[0]?.count ?? '0');
  if (changeCount !== 10) return { alerted: false as const, changeCount };

  const sourceType: RiskSourceType = input.signalType === 'ADDRESS_CHANGE'
    ? 'ACCOUNT_SERVICE'
    : 'FULFILLMENT_TARGET_SERVICE';
  const observationId = hashJson({
    domain: 'ABU24K_FREQUENT_CHANGE_ALERT_V1',
    signalType: input.signalType,
    walletAddress,
    resourceId: input.resourceId,
    requestHash: input.requestHash,
  });
  const existing = await executor.query<{ observation_id: string }>(
    'SELECT observation_id FROM core.risk_observations WHERE observation_id = $1',
    [observationId],
  );
  if (!existing.rows[0]) {
    await executor.query(
      `INSERT INTO core.risk_observations (
         observation_id, signal_type, source_type, wallet_address, resource_id,
         evidence_hash, request_hash, observed_at, recorded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$7)`,
      [
        observationId,
        input.signalType,
        sourceType,
        walletAddress,
        input.resourceId,
        input.requestHash,
        input.observedAt,
      ],
    );
    await enqueueRiskAudit(executor, {
      eventType: 'RiskChangeThresholdReached',
      resourceType: 'RISK_OBSERVATION',
      resourceId: observationId,
      actorWallet: walletAddress,
      actorRole: 'SYSTEM',
      correlationId: input.correlationId,
      requestHash: input.requestHash,
      payload: {
        signalType: input.signalType,
        changeCount,
        windowSeconds: TWENTY_MINUTES_MS / 1_000,
        automaticRestrictionCreated: false,
        evidenceHash: input.requestHash,
      },
      createdAt: input.observedAt,
    });
  }
  return { alerted: true as const, changeCount, observationId };
}

async function highGasThreshold(executor: SqlExecutor) {
  const result = await executor.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM core.current_system_config WHERE config_key = 'GAS'",
  );
  const raw = result.rows[0]?.payload?.seckillMaxGasPriceWei;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new CoreError('ConfigurationRequired', 'Published high-Gas threshold is unavailable', 503);
  }
  return BigInt(raw);
}

async function expireRestrictions(executor: SqlExecutor, now: Date) {
  const expired = await executor.query<RestrictionRow>(
    `SELECT * FROM core.risk_restrictions
     WHERE state = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= $1
     ORDER BY expires_at, restriction_id FOR UPDATE`,
    [now],
  );
  for (const row of expired.rows) {
    await executor.query(
      "UPDATE core.risk_restrictions SET state = 'EXPIRED', updated_at = $2 WHERE restriction_id = $1",
      [row.restriction_id, now],
    );
    await restrictionEvent(executor, row.restriction_id, 'EXPIRED', null, 'EXPIRY_REACHED', row.evidence_hash, now);
  }
}

async function createRestriction(executor: SqlExecutor, input: {
  subjectType: RiskSubjectType;
  subjectValue: string;
  restrictionKind: 'NEW_PAYMENT' | 'BLACKLIST';
  triggerType: RestrictionRow['trigger_type'];
  reasonCode: string;
  evidenceHash: string;
  sourceObservationId: string | null;
  startsAt: Date;
  expiresAt: Date | null;
  requestHash: string;
  createdBy?: string;
  idempotencyKey?: string;
  identityKey?: string;
}) {
  const restrictionId = hashJson({
    domain: 'ABU24K_RISK_RESTRICTION_V1',
    subjectType: input.subjectType,
    subjectValue: input.subjectValue,
    triggerType: input.triggerType,
    sourceObservationId: input.sourceObservationId,
    createdBy: input.createdBy ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    identityKey: input.identityKey ?? null,
  });
  await executor.query(
    `INSERT INTO core.risk_restrictions (
       restriction_id, subject_type, subject_value, restriction_kind, trigger_type,
       reason_code, evidence_hash, source_observation_id, state, starts_at, expires_at,
       created_by, idempotency_key, request_hash, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10,$11,$12,$13,$14,$14)
     ON CONFLICT (restriction_id) DO NOTHING`,
    [restrictionId, input.subjectType, input.subjectValue, input.restrictionKind, input.triggerType,
      input.reasonCode, input.evidenceHash, input.sourceObservationId, input.startsAt, input.expiresAt,
      input.createdBy ?? null, input.idempotencyKey ?? null, input.requestHash, input.startsAt],
  );
  const row = await restriction(executor, restrictionId);
  if (row.request_hash !== input.requestHash) {
    throw new CoreError('IdempotencyConflict', 'Risk restriction identity changed', 409);
  }
  await restrictionEvent(executor, restrictionId, 'CREATED', input.createdBy ?? null, input.reasonCode, input.evidenceHash, input.startsAt);
  return restrictionId;
}

async function linkSubjectWallet(executor: SqlExecutor, subjectType: 'IP' | 'DEVICE', subjectHash: string, input: ReturnType<typeof normalizeObservation>) {
  await executor.query(
    `INSERT INTO core.risk_subject_wallets (
       subject_type, subject_hash, wallet_address, first_observation_id, latest_observation_id,
       first_seen_at, last_seen_at
     ) VALUES ($1,$2,$3,$4,$4,$5,$5)
     ON CONFLICT (subject_type, subject_hash, wallet_address) DO UPDATE
       SET latest_observation_id = EXCLUDED.latest_observation_id,
           last_seen_at = GREATEST(core.risk_subject_wallets.last_seen_at, EXCLUDED.last_seen_at)`,
    [subjectType, subjectHash, input.walletAddress, input.observationId, input.observedAt],
  );
}

async function distinctWalletsInMinute(executor: SqlExecutor, subjectType: 'IP' | 'DEVICE', subjectHash: string, at: Date) {
  const column = subjectType === 'IP' ? 'ip_hash' : 'device_hash';
  const result = await executor.query<{ count: string }>(
    `SELECT count(DISTINCT wallet_address)::text AS count FROM core.risk_observations
     WHERE signal_type = 'WALLET_CONTEXT' AND ${column} = $1
       AND observed_at > $2 AND observed_at <= $3`,
    [subjectHash, new Date(at.getTime() - 60_000), at],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function cancellationsInWindow(executor: SqlExecutor, walletAddress: string, at: Date) {
  const result = await executor.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM core.risk_observations
     WHERE signal_type = 'ORDER_CANCELLATION' AND wallet_address = $1
       AND observed_at > $2 AND observed_at <= $3`,
    [walletAddress, new Date(at.getTime() - FIVE_MINUTES_MS), at],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function activeSubjectRestriction(executor: SqlExecutor, subjectType: 'IP' | 'DEVICE', subjectHash: string, at: Date) {
  return (await executor.query<RestrictionRow>(
    `SELECT * FROM core.risk_restrictions WHERE subject_type = $1 AND subject_value = $2
       AND state = 'ACTIVE' AND starts_at <= $3 AND (expires_at IS NULL OR expires_at > $3)
     ORDER BY starts_at DESC, restriction_id DESC LIMIT 1`,
    [subjectType, subjectHash, at],
  )).rows[0];
}

async function mirrorSubjectRestriction(executor: SqlExecutor, subject: RestrictionRow, input: ReturnType<typeof normalizeObservation>) {
  return createRestriction(executor, {
    subjectType: 'WALLET',
    subjectValue: input.walletAddress,
    restrictionKind: subject.restriction_kind,
    triggerType: 'SUBJECT_BLACKLIST',
    reasonCode: subject.reason_code,
    evidenceHash: input.evidenceHash,
    sourceObservationId: input.observationId,
    startsAt: input.observedAt,
    expiresAt: subject.expires_at,
    requestHash: hashJson({ subjectRestrictionId: subject.restriction_id, observationId: input.observationId }),
  });
}

async function mirrorSubjectWallets(executor: SqlExecutor, subjectType: 'IP' | 'DEVICE', subjectHash: string, input: {
  sourceKey: string;
  sourceObservationId: string | null;
  restrictionKind: 'NEW_PAYMENT' | 'BLACKLIST';
  reasonCode: string;
  evidenceHash: string;
  observedAt: Date;
  expiresAt: Date | null;
}) {
  const wallets = await executor.query<{ wallet_address: string }>(
    `SELECT wallet_address FROM core.risk_subject_wallets
     WHERE subject_type = $1 AND subject_hash = $2 ORDER BY wallet_address`,
    [subjectType, subjectHash],
  );
  const created: string[] = [];
  for (const wallet of wallets.rows) {
    created.push(await createRestriction(executor, {
      subjectType: 'WALLET',
      subjectValue: wallet.wallet_address,
      restrictionKind: input.restrictionKind,
      triggerType: 'SUBJECT_BLACKLIST',
      reasonCode: input.reasonCode,
      evidenceHash: input.evidenceHash,
      sourceObservationId: input.sourceObservationId,
      startsAt: input.observedAt,
      expiresAt: input.expiresAt,
      requestHash: hashJson({ subjectType, subjectHash, wallet: wallet.wallet_address, source: input.sourceKey }),
      identityKey: input.sourceKey,
    }));
  }
  return created;
}

async function restriction(executor: SqlExecutor, restrictionId: string, lock = false) {
  const result = await executor.query<RestrictionRow>(
    `SELECT * FROM core.risk_restrictions WHERE restriction_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [restrictionId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Risk restriction not found', 404);
  return result.rows[0];
}

async function restrictionEvent(executor: SqlExecutor, restrictionId: string, eventType: 'CREATED' | 'EXPIRED' | 'OVERRIDDEN', actorWallet: string | null, reasonCode: string, evidenceHash: string, at: Date) {
  const eventId = hashJson({ restrictionId, eventType, actorWallet, reasonCode, evidenceHash });
  await executor.query(
    `INSERT INTO core.risk_restriction_events (
       event_id, restriction_id, event_type, actor_wallet, reason_code, evidence_hash, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, restrictionId, eventType, actorWallet, reasonCode, evidenceHash, at],
  );
}

async function requireDatabaseRole(executor: SqlExecutor, actor: FulfillmentActor, allowed: readonly string[]) {
  const wallet = address(actor.walletAddress);
  const result = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE wallet_address = $1 AND status = 'ACTIVE' AND role = ANY($2::text[]) ORDER BY role LIMIT 1`,
    [wallet, [...allowed]],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Current wallet role cannot manage risk', 403);
  return wallet;
}

function requireRole(actor: FulfillmentActor, allowed: readonly string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) throw new CoreError('Forbidden', 'Session cannot manage risk', 403);
}

async function enqueueRbacAudit(executor: SqlExecutor, actor: FulfillmentActor, actorWallet: string, eventType: string, row: RestrictionRow | AppealRow, correlationId: string, requestHash: string, at: Date) {
  const isAppeal = 'appeal_id' in row;
  await enqueueRiskAudit(executor, {
    eventType,
    resourceType: isAppeal ? 'RISK_APPEAL' : 'RISK_RESTRICTION',
    resourceId: isAppeal ? row.appeal_id : row.restriction_id,
    actorWallet,
    actorRole: actor.roles.find((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? 'ADMIN',
    correlationId,
    requestHash,
    payload: isAppeal ? appealProjection(row) : restrictionProjection(row),
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: actorWallet,
      roles: [...actor.roles],
      evidenceHash: hashJson({ actorWallet, roles: actor.roles }),
      checkedAt: at.toISOString(),
    },
    createdAt: at,
  });
}

function enqueueRiskAudit(
  executor: SqlExecutor,
  input: Omit<AuditOutboxInput, 'sourceEventId' | 'streamName' | 'evidenceProfile'>,
) {
  return enqueueAudit(executor, {
    ...input,
    sourceEventId: auditSourceId('audit:risk', { eventType: input.eventType, resourceId: input.resourceId, requestHash: input.requestHash }),
    streamName: 'operational',
    evidenceProfile: input.authorizationEvidence ? 'AUTHORIZATION' : 'SYSTEM',
    requestHash: input.requestHash.slice(2),
  });
}

function normalizeObservation(input: RiskObservationInput) {
  const signalType = input.signalType;
  if (!['HIGH_GAS', 'WALLET_CONTEXT', 'ORDER_CANCELLATION', 'ADDRESS_CHANGE', 'PICKUP_STORE_CHANGE'].includes(signalType)) throw new CoreError('InvalidRequest', 'Risk signal type is invalid');
  const sourceType = input.sourceType;
  const expectedSource: Record<RiskSignalType, RiskSourceType> = {
    HIGH_GAS: 'CHAIN_MONITOR',
    WALLET_CONTEXT: 'EDGE_AUTH',
    ORDER_CANCELLATION: 'ORDER_SERVICE',
    ADDRESS_CHANGE: 'ACCOUNT_SERVICE',
    PICKUP_STORE_CHANGE: 'FULFILLMENT_TARGET_SERVICE',
  };
  if (sourceType !== expectedSource[signalType]) throw new CoreError('InvalidRequest', 'Risk signal source is invalid');
  const normalized = {
    observationId: hash(input.observationId, 'risk observation id'),
    signalType,
    sourceType,
    walletAddress: address(input.walletAddress),
    ipHash: input.ipHash === undefined ? null : hash(input.ipHash, 'IP hash'),
    deviceHash: input.deviceHash === undefined ? null : hash(input.deviceHash, 'device hash'),
    resourceId: input.resourceId ?? null,
    txHash: input.txHash === undefined ? null : hash(input.txHash, 'risk transaction hash'),
    gasPriceWei: input.gasPriceWei === undefined ? null : amount(input.gasPriceWei, 'Gas price'),
    evidenceHash: hash(input.evidenceHash, 'risk evidence'),
    observedAt: timestamp(input.observedAt, 'risk observation time'),
  };
  if (signalType === 'WALLET_CONTEXT' && !normalized.ipHash && !normalized.deviceHash) throw new CoreError('InvalidRequest', 'Wallet context requires IP or device hash');
  if (signalType === 'HIGH_GAS' && (!normalized.txHash || normalized.gasPriceWei === null)) throw new CoreError('InvalidRequest', 'High-Gas observation is incomplete');
  if (signalType === 'ORDER_CANCELLATION' && (!normalized.resourceId || normalized.resourceId.length > 128)) throw new CoreError('InvalidRequest', 'Cancellation resource is invalid');
  if ((signalType === 'ADDRESS_CHANGE' || signalType === 'PICKUP_STORE_CHANGE') && (!normalized.resourceId || normalized.resourceId.length > 128)) {
    throw new CoreError('InvalidRequest', 'Change alert resource is invalid');
  }
  return normalized;
}

function observationProjection(row: ObservationRow) {
  return Object.freeze({
    observationId: row.observation_id,
    signalType: row.signal_type,
    sourceType: row.source_type,
    walletAddress: row.wallet_address,
    ipHash: row.ip_hash,
    deviceHash: row.device_hash,
    resourceId: row.resource_id,
    txHash: row.tx_hash,
    gasPriceWei: row.gas_price_wei === null ? null : String(row.gas_price_wei),
    evidenceHash: row.evidence_hash,
    observedAt: row.observed_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
  });
}

function restrictionProjection(row: RestrictionRow) {
  return Object.freeze({
    restrictionId: row.restriction_id,
    subjectType: row.subject_type,
    subjectValue: row.subject_value,
    restrictionKind: row.restriction_kind,
    triggerType: row.trigger_type,
    reasonCode: row.reason_code,
    evidenceHash: row.evidence_hash,
    sourceObservationId: row.source_observation_id,
    state: row.state,
    startsAt: row.starts_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdBy: row.created_by,
    overrideBy: row.override_by,
    overrideReasonCode: row.override_reason_code,
    overrideEvidenceHash: row.override_evidence_hash,
    overrideAt: row.override_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function appealProjection(row: AppealRow) {
  return Object.freeze({
    appealId: row.appeal_id,
    restrictionId: row.restriction_id,
    submittedBy: row.submitted_by,
    statementHash: row.statement_hash,
    evidenceHash: row.evidence_hash,
    state: row.state,
    decidedBy: row.decided_by,
    decisionReasonCode: row.decision_reason_code,
    decisionEvidenceHash: row.decision_evidence_hash,
    decidedAt: row.decided_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function normalizeSubject(type: RiskSubjectType, value: string) {
  return type === 'WALLET' ? address(value) : hash(value, `${type} subject`);
}

function address(value: string) {
  try { return getAddress(value).toLowerCase(); } catch { throw new CoreError('InvalidRequest', 'Risk wallet address is invalid'); }
}

function hash(value: string, name: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return value.toLowerCase();
}

function amount(value: string, name: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return value;
}

function timestamp(value: string, name: string) {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== value) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return result;
}

function reason(value: string) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) throw new CoreError('InvalidRequest', 'Risk reason code is invalid');
  return value;
}

function key(value: string) {
  if (value.length < 8 || value.length > 128) throw new CoreError('InvalidRequest', 'Risk idempotency key is invalid');
  return value;
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
