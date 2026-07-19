import { createHash, randomBytes } from 'node:crypto';
import { orderAllowedActions } from '../api/allowed-actions.ts';
import { CORE_ARTIFACT_VERSION, executableOrderActionNames, type TakeoverState, type UserRole } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

export interface TakeoverCaseQuery {
  state?: TakeoverState;
  originalMerchantId?: string;
  replacementMerchantId?: string;
  cursorOpenedAt?: Date;
  cursorCaseId?: string;
  limit?: number;
}

export interface TakeoverAssignmentInput {
  replacementMerchantId: string;
  reasonCode: string;
  evidenceHash: string;
  idempotencyKey: string;
  correlationId: string;
}

interface CaseRow {
  case_id: string;
  order_id: string;
  merchant_id: string;
  policy_version: string | number;
  state: TakeoverState;
  required_usdt: string | null;
  guarantee_used_usdt: string;
  merchant_available_used_usdt: string;
  future_proceeds_used_usdt: string;
  platform_advance_usdt: string;
  disbursed_usdt: string;
  merchant_debt_usdt: string;
  evidence_hash: string;
  opened_at: Date;
  closed_at: Date | null;
  updated_at: Date;
  product_id: string;
  sku_id: string;
  quantity: string | number;
  fulfillment_mode: 'DELIVERY' | 'PICKUP';
  fulfillment_target_hash: string;
  order_state: string;
  buyer_wallet: string;
  merchant_wallet: string;
  payment_finalized_at: Date | null;
}

interface AssignmentRow {
  assignment_id: string;
  case_id: string;
  order_id: string;
  assignment_version: string | number;
  original_merchant_id: string;
  replacement_merchant_id: string;
  replacement_wallet: string;
  replacement_application_version: string | number;
  replacement_level: string | null;
  replacement_license_asset_id: string;
  supersedes_assignment_id: string | null;
  reason_code: string;
  evidence_hash: string;
  assigned_by: string;
  correlation_id: string;
  assigned_at: Date;
}

interface CandidateRow {
  merchant_id: string;
  settlement_wallet: string;
  application_version: string | number;
  license_asset_id: string;
  shop_name: string | null;
}

export class TakeoverCaseService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;

  constructor(input: { transactions: SqlTransactionRunner; clock?: () => Date }) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
  }

  listAdmin(actor: FulfillmentActor, input: TakeoverCaseQuery = {}) {
    const query = takeoverQuery(input);
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      return listCases(executor, query);
    });
  }

  getAdmin(actor: FulfillmentActor, caseId: string) {
    validateResourceId(caseId, 'caseId');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      return caseDetail(executor, caseId, actor);
    });
  }

  listCandidates(actor: FulfillmentActor, caseId: string) {
    validateResourceId(caseId, 'caseId');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const takeover = await loadCase(executor, caseId);
      if (!['OPEN', 'FUNDED'].includes(takeover.state) || takeover.order_state !== 'TAKEOVER') {
        throw new CoreError('UnknownState', 'Takeover case cannot be assigned from its current state', 409);
      }
      const result = await eligibleCandidates(executor, takeover.merchant_id);
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        caseId,
        candidates: result.rows.map(candidateProjection),
      };
    });
  }

  assign(actor: FulfillmentActor, caseId: string, input: TakeoverAssignmentInput) {
    validateResourceId(caseId, 'caseId');
    const normalized = assignmentInput(input);
    const wallet = normalizedWallet(actor.walletAddress);
    const requestHash = hashJson({ caseId, ...normalized });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      const prior = await executor.query<{ request_hash: string; assignment_id: string }>(
        `SELECT request_hash, assignment_id FROM core.takeover_assignments
         WHERE assigned_by = $1 AND idempotency_key = $2`,
        [wallet, normalized.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Takeover assignment idempotency conflict', 409);
        }
        return assignmentDetail(executor, prior.rows[0].assignment_id);
      }
      const takeover = await loadCase(executor, caseId, true);
      if (
        !['OPEN', 'FUNDED'].includes(takeover.state)
        || takeover.order_state !== 'TAKEOVER'
        || takeover.fulfillment_mode !== 'DELIVERY'
      ) throw new CoreError('UnknownState', 'Takeover case cannot be assigned from its current state', 409);
      const shipped = await executor.query<{ shipment_id: string }>(
        'SELECT shipment_id FROM core.shipments WHERE order_id = $1 LIMIT 1',
        [takeover.order_id],
      );
      if (shipped.rows[0]) throw new CoreError('UnknownState', 'A shipped takeover case cannot be reassigned', 409);
      const candidate = (await eligibleCandidates(executor, takeover.merchant_id, normalized.replacementMerchantId)).rows[0];
      if (!candidate) throw new CoreError('Forbidden', 'Replacement merchant is not currently eligible', 403);
      const current = await currentAssignment(executor, caseId);
      if (current?.replacement_merchant_id === candidate.merchant_id) {
        throw new CoreError('UnknownState', 'Replacement merchant is already assigned', 409);
      }
      if (current) {
        const payout = await executor.query<{ snapshot_id: string }>(
          'SELECT snapshot_id FROM core.takeover_replacement_fulfillment_snapshots WHERE case_id = $1',
          [caseId],
        );
        if (payout.rows[0]) {
          throw new CoreError('UnknownState', 'Takeover payout recipient is frozen and cannot be reassigned', 409);
        }
      }
      const assignmentId = randomHash();
      const version = Number(current?.assignment_version ?? 0) + 1;
      const assignedAt = this.#clock();
      await executor.query(
        `INSERT INTO core.takeover_assignments (
           assignment_id, case_id, order_id, assignment_version, original_merchant_id,
           replacement_merchant_id, replacement_wallet, replacement_application_version,
           replacement_level, replacement_license_asset_id, supersedes_assignment_id,
           reason_code, evidence_hash, assigned_by, idempotency_key, request_hash,
           correlation_id, assigned_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          assignmentId, caseId, takeover.order_id, version, takeover.merchant_id,
          candidate.merchant_id, candidate.settlement_wallet.toLowerCase(), candidate.application_version,
          null, candidate.license_asset_id, current?.assignment_id ?? null,
          normalized.reasonCode, normalized.evidenceHash, wallet, normalized.idempotencyKey,
          requestHash, normalized.correlationId, assignedAt,
        ],
      );
      const result = await assignmentDetail(executor, assignmentId);
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
         ) VALUES ($1,'TAKEOVER_CASE',$2,$3,$4,$1,'PENDING')`,
        [
          `outbox:takeover-assignment:${assignmentId}`,
          caseId,
          current ? 'TakeoverReplacementReassigned' : 'TakeoverReplacementAssigned',
          JSON.stringify(result),
        ],
      );
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('takeover-assignment', { assignmentId, requestHash }),
        streamName: 'operational',
        evidenceProfile: 'RBAC',
        eventType: current ? 'TakeoverReplacementReassigned' : 'TakeoverReplacementAssigned',
        resourceType: 'TAKEOVER_CASE',
        resourceId: caseId,
        merchantId: takeover.merchant_id,
        actorWallet: wallet,
        actorRole: roles[0]!,
        correlationId: normalized.correlationId,
        requestHash: requestHash.slice(2),
        payload: result,
        authorizationEvidence: {
          scheme: 'RBAC_ROLE_REVALIDATION',
          subject: wallet,
          roles,
          evidenceHash: hashJson({ subject: wallet, roles: [...roles].sort(), checkedAt: assignedAt.toISOString() }),
          checkedAt: assignedAt.toISOString(),
        },
        createdAt: assignedAt,
      });
      return result;
    });
  }

  listMerchant(actor: FulfillmentActor, input: TakeoverCaseQuery = {}) {
    const query = takeoverQuery(input);
    return this.#transactions.transaction(async (executor) => {
      const merchantId = await requireMerchant(executor, actor);
      return listCases(executor, { ...query, replacementMerchantId: merchantId }, merchantId);
    });
  }

  getMerchant(actor: FulfillmentActor, caseId: string) {
    validateResourceId(caseId, 'caseId');
    return this.#transactions.transaction(async (executor) => {
      const merchantId = await requireMerchant(executor, actor);
      const current = await currentAssignment(executor, caseId);
      if (!current || current.replacement_merchant_id !== merchantId) {
        throw new CoreError('Forbidden', 'Takeover case is outside the replacement merchant scope', 403);
      }
      return caseDetail(executor, caseId, actor, merchantId);
    });
  }
}

async function listCases(
  executor: SqlExecutor,
  query: Required<Pick<TakeoverCaseQuery, 'limit'>> & Omit<TakeoverCaseQuery, 'limit'>,
  scopedReplacementMerchantId?: string,
) {
  const params: unknown[] = [];
  const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const clauses: string[] = [];
  if (query.state) clauses.push(`takeover.state = ${add(query.state)}`);
  if (query.originalMerchantId) clauses.push(`takeover.merchant_id = ${add(query.originalMerchantId)}`);
  const replacement = scopedReplacementMerchantId ?? query.replacementMerchantId;
  if (replacement) clauses.push(`assignment.replacement_merchant_id = ${add(replacement)}`);
  if (query.cursorOpenedAt && query.cursorCaseId) {
    clauses.push(`(takeover.opened_at, takeover.case_id) < (${add(query.cursorOpenedAt)}, ${add(query.cursorCaseId)})`);
  }
  params.push(query.limit + 1);
  const result = await executor.query<CaseRow & AssignmentRow>(
    `${caseSelect()}
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY takeover.opened_at DESC, takeover.case_id DESC LIMIT $${params.length}`,
    params,
  );
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    cases: rows.map(caseProjection),
    nextCursor: result.rows.length > query.limit && last
      ? { openedAt: new Date(last.opened_at).toISOString(), caseId: last.case_id }
      : null,
  };
}

async function caseDetail(executor: SqlExecutor, caseId: string, actor: FulfillmentActor, merchantId?: string) {
  const row = await loadCaseWithAssignment(executor, caseId);
  if (merchantId && row.replacement_merchant_id !== merchantId) {
    throw new CoreError('Forbidden', 'Takeover case is outside the replacement merchant scope', 403);
  }
  const [assignments, transitions] = await Promise.all([
    executor.query<AssignmentRow>(
      'SELECT * FROM core.takeover_assignments WHERE case_id = $1 ORDER BY assignment_version, assignment_id',
      [caseId],
    ),
    executor.query<Record<string, unknown>>(
      `SELECT transition_id AS "transitionId", from_state AS "fromState", to_state AS "toState",
         public_evidence_type AS "evidenceType", public_evidence_hash AS "evidenceHash",
         occurred_at AS "occurredAt"
       FROM core.takeover_case_transitions WHERE case_id = $1 ORDER BY occurred_at, transition_id`,
      [caseId],
    ),
  ]);
  const current = assignments.rows.at(-1);
  const allowedActions = takeoverAllowedActions(row, current, actor);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    case: { ...caseProjection(row), allowedActions },
    assignments: merchantId && current ? [assignmentProjection(current)] : assignments.rows.map(assignmentProjection),
    transitions: transitions.rows.map((transition) => ({
      ...transition,
      occurredAt: new Date(transition.occurredAt as string | Date).toISOString(),
    })),
  };
}

function takeoverAllowedActions(row: CaseRow, assignment: AssignmentRow | undefined, actor: FulfillmentActor) {
  return orderAllowedActions({
    state: row.order_state as 'TAKEOVER',
    fulfillmentMode: row.fulfillment_mode,
    buyerWallet: row.buyer_wallet,
    merchantId: row.merchant_id,
    merchantWallet: row.merchant_wallet,
    paymentFinalityStatus: row.payment_finalized_at ? 'FINAL' : 'PENDING',
    shipmentEvidence: false,
    takeoverOpened: true,
    ...(assignment ? {
      replacementMerchantId: assignment.replacement_merchant_id,
      replacementMerchantWallet: assignment.replacement_wallet,
      takeoverFunded: row.state === 'FUNDED',
    } : {}),
  }, {
    actorWallet: normalizedWallet(actor.walletAddress),
    ...(actor.merchantId ? { actorMerchantId: actor.merchantId } : {}),
    roles: actor.roles,
    now: new Date(),
    pausedScopes: new Set(),
    executableActions: new Set(executableOrderActionNames),
  });
}

async function loadCase(executor: SqlExecutor, caseId: string, forUpdate = false) {
  const result = await executor.query<CaseRow>(
    `${caseSelect(false)} WHERE takeover.case_id = $1${forUpdate ? ' FOR UPDATE OF takeover, orders' : ''}`,
    [caseId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Takeover case not found', 404);
  return result.rows[0];
}

async function loadCaseWithAssignment(executor: SqlExecutor, caseId: string) {
  const result = await executor.query<CaseRow & Partial<AssignmentRow>>(
    `${caseSelect()} WHERE takeover.case_id = $1`,
    [caseId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Takeover case not found', 404);
  return result.rows[0] as CaseRow & AssignmentRow;
}

function caseSelect(withAssignment = true) {
  return `SELECT takeover.case_id, takeover.order_id, takeover.merchant_id,
      takeover.policy_version, takeover.state, takeover.required_usdt::text,
      takeover.guarantee_used_usdt::text, takeover.merchant_available_used_usdt::text,
      takeover.future_proceeds_used_usdt::text, takeover.platform_advance_usdt::text,
      takeover.disbursed_usdt::text, takeover.merchant_debt_usdt::text,
      takeover.evidence_hash, takeover.opened_at, takeover.closed_at, takeover.updated_at,
      orders.product_id, orders.sku_id, orders.quantity, orders.fulfillment_mode,
      orders.fulfillment_target_hash, orders.state AS order_state, orders.buyer_wallet,
      orders.merchant_wallet, finality.finalized_at AS payment_finalized_at
      ${withAssignment ? ', assignment.*' : ''}
    FROM core.takeover_cases takeover
    JOIN core.orders orders ON orders.order_id = takeover.order_id
    LEFT JOIN core.transaction_finality finality
      ON finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = orders.order_id
      AND finality.state = 'FINAL'
    ${withAssignment ? `LEFT JOIN LATERAL (
      SELECT * FROM core.takeover_assignments current_assignment
      WHERE current_assignment.case_id = takeover.case_id
      ORDER BY current_assignment.assignment_version DESC LIMIT 1
    ) assignment ON true` : ''}`;
}

async function eligibleCandidates(executor: SqlExecutor, originalMerchantId: string, merchantId?: string) {
  return executor.query<CandidateRow>(
    `SELECT merchant.merchant_id, lower(merchant.settlement_wallet) AS settlement_wallet,
       merchant.application_version,
       application.license_asset_id, merchant.profile->>'shopName' AS shop_name
     FROM core.merchants merchant
     JOIN core.merchant_application_versions application
       ON application.merchant_id = merchant.merchant_id
       AND application.version = merchant.application_version
       AND application.license_asset_id IS NOT NULL
     JOIN core.wallet_role_bindings binding
       ON lower(binding.wallet_address) = lower(merchant.settlement_wallet)
       AND binding.role = 'MERCHANT' AND binding.merchant_id = merchant.merchant_id
       AND binding.status = 'ACTIVE'
     WHERE merchant.merchant_id <> $1 AND merchant.status = 'APPROVED'
       AND merchant.guarantee_status = 'READY'
       AND ($2::text IS NULL OR merchant.merchant_id = $2)
     ORDER BY merchant.merchant_id`,
    [originalMerchantId, merchantId ?? null],
  );
}

async function currentAssignment(executor: SqlExecutor, caseId: string) {
  const result = await executor.query<AssignmentRow>(
    `SELECT * FROM core.takeover_assignments WHERE case_id = $1
     ORDER BY assignment_version DESC LIMIT 1`,
    [caseId],
  );
  return result.rows[0];
}

async function assignmentDetail(executor: SqlExecutor, assignmentId: string) {
  const result = await executor.query<AssignmentRow>(
    'SELECT * FROM core.takeover_assignments WHERE assignment_id = $1',
    [assignmentId],
  );
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Takeover assignment was not persisted', 409);
  return { artifactVersion: CORE_ARTIFACT_VERSION, assignment: assignmentProjection(result.rows[0]) };
}

function caseProjection(row: CaseRow & Partial<AssignmentRow>) {
  return {
    caseId: row.case_id,
    orderId: row.order_id,
    originalMerchantId: row.merchant_id,
    policyVersion: String(row.policy_version),
    state: row.state,
    requiredUsdt: row.required_usdt,
    funding: {
      guaranteeUsedUsdt: row.guarantee_used_usdt,
      frozenReceivablesUsedUsdt: row.merchant_available_used_usdt,
      futureProceedsUsedUsdt: row.future_proceeds_used_usdt,
      platformAdvanceUsdt: row.platform_advance_usdt,
      disbursedUsdt: row.disbursed_usdt,
      merchantDebtUsdt: row.merchant_debt_usdt,
    },
    evidenceHash: row.evidence_hash,
    openedAt: new Date(row.opened_at).toISOString(),
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
    order: {
      productId: row.product_id,
      skuId: row.sku_id,
      quantity: String(row.quantity),
      fulfillmentMode: row.fulfillment_mode,
      fulfillmentTargetHash: row.fulfillment_target_hash,
      state: row.order_state,
      paymentFinal: Boolean(row.payment_finalized_at),
    },
    currentAssignment: row.assignment_id ? assignmentProjection(row as CaseRow & AssignmentRow) : null,
  };
}

function assignmentProjection(row: AssignmentRow) {
  return {
    assignmentId: row.assignment_id,
    caseId: row.case_id,
    orderId: row.order_id,
    version: Number(row.assignment_version),
    originalMerchantId: row.original_merchant_id,
    replacementMerchantId: row.replacement_merchant_id,
    replacementWallet: row.replacement_wallet,
    replacementApplicationVersion: Number(row.replacement_application_version),
    replacementLicenseAssetId: row.replacement_license_asset_id,
    supersedesAssignmentId: row.supersedes_assignment_id,
    reasonCode: row.reason_code,
    evidenceHash: row.evidence_hash,
    assignedBy: row.assigned_by,
    correlationId: row.correlation_id,
    assignedAt: new Date(row.assigned_at).toISOString(),
  };
}

function candidateProjection(row: CandidateRow) {
  return {
    merchantId: row.merchant_id,
    settlementWallet: row.settlement_wallet,
    shopName: row.shop_name ?? row.merchant_id,
    applicationVersion: Number(row.application_version),
    qualificationComplete: true,
    guaranteeReady: true,
  };
}

function takeoverQuery(input: TakeoverCaseQuery) {
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError('InvalidRequest', 'limit must be 1-100');
  if ((input.cursorOpenedAt === undefined) !== (input.cursorCaseId === undefined)) {
    throw new CoreError('InvalidRequest', 'Takeover cursor requires openedAt and caseId');
  }
  for (const value of [input.originalMerchantId, input.replacementMerchantId, input.cursorCaseId]) {
    if (value !== undefined) validateResourceId(value, 'takeover filter');
  }
  return { ...input, limit };
}

function assignmentInput(input: TakeoverAssignmentInput) {
  validateResourceId(input.replacementMerchantId, 'replacementMerchantId');
  if (!/^[A-Z0-9_:-]{2,64}$/.test(input.reasonCode)) throw new CoreError('InvalidRequest', 'reasonCode is invalid');
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.evidenceHash)) throw new CoreError('InvalidRequest', 'evidenceHash is invalid');
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) throw new CoreError('InvalidRequest', 'idempotencyKey is invalid');
  if (!input.correlationId || input.correlationId.length > 128) throw new CoreError('InvalidRequest', 'correlationId is invalid');
  return { ...input, evidenceHash: input.evidenceHash.toLowerCase() };
}

async function requireCurrentRole(executor: SqlExecutor, actor: FulfillmentActor, allowed: UserRole[]) {
  const wallet = normalizedWallet(actor.walletAddress);
  const claimed = allowed.filter((role) => actor.roles.includes(role));
  if (claimed.length === 0) throw new CoreError('Forbidden', `${allowed.join(' or ')} role is required`, 403);
  const result = await executor.query<{ role: UserRole }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[])
     ORDER BY role`,
    [wallet, claimed],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', `${allowed.join(' or ')} role is required`, 403);
  return result.rows.map((row) => row.role);
}

async function requireMerchant(executor: SqlExecutor, actor: FulfillmentActor) {
  const wallet = normalizedWallet(actor.walletAddress);
  if (!actor.roles.includes('MERCHANT') || !actor.merchantId) throw new CoreError('Forbidden', 'MERCHANT role is required', 403);
  const result = await executor.query<{ merchant_id: string }>(
    `SELECT merchant_id FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND role = 'MERCHANT' AND merchant_id = $2 AND status = 'ACTIVE'`,
    [wallet, actor.merchantId],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Active merchant binding is required', 403);
  return actor.merchantId;
}

function validateResourceId(value: string, label: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new CoreError('InvalidRequest', `${label} is invalid`);
}

function normalizedWallet(value: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid actor wallet');
  return value.toLowerCase();
}

function randomHash() {
  return `0x${randomBytes(32).toString('hex')}`;
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(stableJson(value)).digest('hex')}`;
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
