import { Interface, TypedDataEncoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  sensitiveActionDomain,
  sensitiveActionTypes,
  verifySensitiveActionApproval,
  type SensitiveActionIntent,
} from '../api/auth.ts';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const ROUTER = new Interface(['function setNewPaymentsPaused(bool paused,bytes32 evidenceHash)']);

interface ActionRow {
  action_id: string;
  snapshot_id: string;
  policy_version: string | number;
  action: 'PAUSE' | 'RESUME';
  target_paused: boolean;
  evidence_hash: string;
  governance_safe_address: string;
  router_address: string;
  calldata_hash: string;
  state: 'PENDING_PROPOSAL' | 'SAFE_PROPOSED' | 'MINED' | 'FINAL' | 'REORGED' | 'FAILED' | 'SUPERSEDED';
  safe_tx_hash: string | null;
  proposal_hash: string | null;
  execution_tx_hash: string | null;
  confirmations: number;
  actor_wallet: string | null;
  secondary_signer: string | null;
  secondary_signature_hash: string | null;
  approval_nonce: string | number | null;
  approval_deadline: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ResumeContext {
  actorWallet: string;
  snapshotId: string;
  evidenceHash: string;
  policyVersion: bigint;
  oldValueHash: string;
  newValueHash: string;
}

export class CoverageBreakerService {
  readonly #transactions: SqlTransactionRunner;
  readonly #governanceSafe: string;
  readonly #paymentRouter: string;
  readonly #secondarySigner: string;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    governanceSafeAddress: string;
    paymentRouterAddress: string;
    secondarySignerAddress: string;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#governanceSafe = address(input.governanceSafeAddress, 'coverage governance Safe');
    this.#paymentRouter = address(input.paymentRouterAddress, 'PaymentRouter');
    this.#secondarySigner = address(input.secondarySignerAddress, 'coverage secondary signer');
    this.#clock = input.clock ?? (() => new Date());
  }

  resumeChallenge(actor: FulfillmentActor, input: { nonce: string; deadline: string }) {
    const nonce = unsigned(input.nonce, 'coverage resume nonce');
    const deadline = unsigned(input.deadline, 'coverage resume deadline');
    validateDeadline(deadline, this.#clock());
    return this.#transactions.transaction(async (executor) => {
      const context = await this.#resumeContext(executor, actor);
      const intent = resumeIntent(context, nonce, deadline, this.#governanceSafe);
      const domain = sensitiveActionDomain(this.#paymentRouter);
      return Object.freeze({
        artifactVersion: CORE_ARTIFACT_VERSION,
        snapshotId: context.snapshotId,
        evidenceHash: context.evidenceHash,
        policyVersion: context.policyVersion.toString(),
        signer: this.#secondarySigner,
        safeAddress: this.#governanceSafe,
        routerAddress: this.#paymentRouter,
        typedData: {
          domain,
          types: sensitiveActionTypes,
          primaryType: 'SensitiveAction',
          message: serializableIntent(intent),
        },
        digest: TypedDataEncoder.hash(domain, sensitiveActionTypes, intent).toLowerCase(),
      });
    });
  }

  submitResume(
    actor: FulfillmentActor,
    input: { snapshotId: string; nonce: string; deadline: string; signature: string; correlationId: string },
  ) {
    if (!isHash(input.snapshotId)) throw new CoreError('InvalidRequest', 'Coverage recovery snapshot is invalid');
    const nonce = unsigned(input.nonce, 'coverage resume nonce');
    const deadline = unsigned(input.deadline, 'coverage resume deadline');
    const signatureHash = signatureDigest(input.signature);
    validateDeadline(deadline, this.#clock());
    return this.#transactions.transaction(async (executor) => {
      const actorWallet = await requireCurrentRole(executor, actor, ['ADMIN']);
      if (actorWallet === this.#secondarySigner) {
        throw new CoreError('Forbidden', 'Coverage resume requires an independent secondary wallet', 403);
      }
      const prior = await executor.query<ActionRow>(
        `SELECT * FROM core.coverage_breaker_actions
         WHERE action = 'RESUME' AND secondary_signer = $1 AND approval_nonce = $2
         ORDER BY created_at DESC, action_id DESC LIMIT 1`,
        [this.#secondarySigner, nonce.toString()],
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (
          row.actor_wallet !== actorWallet
          || row.snapshot_id !== input.snapshotId.toLowerCase()
          || row.secondary_signature_hash !== signatureHash
          || row.approval_deadline?.getTime() !== Number(deadline) * 1_000
        ) throw new CoreError('IdempotencyConflict', 'Coverage resume nonce was already consumed', 409);
        return actionProjection(row);
      }
      const context = await this.#resumeContext(executor, actor, actorWallet, input.snapshotId.toLowerCase());
      const intent = resumeIntent(context, nonce, deadline, this.#governanceSafe);
      const approval = verifySensitiveActionApproval(
        intent,
        input.signature,
        this.#secondarySigner,
        this.#governanceSafe,
        this.#paymentRouter,
        this.#clock(),
      );
      if (approval.signer === actorWallet) {
        throw new CoreError('Forbidden', 'Coverage resume requires an independent secondary wallet', 403);
      }
      const calldata = ROUTER.encodeFunctionData(
        'setNewPaymentsPaused',
        [false, context.evidenceHash],
      ).toLowerCase();
      const digest = TypedDataEncoder.hash(approval.domain, sensitiveActionTypes, intent).toLowerCase();
      const now = this.#clock();
      const actionId = hashJson({
        domain: 'ABU24K_COVERAGE_BREAKER_RESUME_V1',
        digest,
        snapshotId: context.snapshotId,
        actorWallet,
        secondarySigner: approval.signer,
      });
      await executor.query(
        `INSERT INTO core.coverage_breaker_actions (
           action_id, snapshot_id, policy_version, action, target_paused, evidence_hash,
           governance_safe_address, router_address, calldata, calldata_hash,
           state, actor_wallet, secondary_signer, secondary_signature_hash,
           approval_nonce, approval_deadline, created_at, updated_at
         ) VALUES ($1,$2,$3,'RESUME',false,$4,$5,$6,$7,$8,'PENDING_PROPOSAL',$9,$10,$11,$12,$13,$14,$14)`,
        [
          actionId,
          context.snapshotId,
          context.policyVersion.toString(),
          context.evidenceHash,
          this.#governanceSafe,
          this.#paymentRouter,
          calldata,
          keccak256(calldata).toLowerCase(),
          actorWallet,
          approval.signer,
          signatureHash,
          nonce.toString(),
          new Date(Number(deadline) * 1_000),
          now,
        ],
      );
      await executor.query(
        `INSERT INTO core.coverage_breaker_action_transitions (
           transition_id, action_id, from_state, to_state, evidence, recorded_at
         ) VALUES ($1,$2,NULL,'PENDING_PROPOSAL',$3,$4)`,
        [
          hashJson({ actionId, state: 'PENDING_PROPOSAL' }),
          actionId,
          JSON.stringify({ snapshotId: context.snapshotId, digest, signatureHash }),
          now,
        ],
      );
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:coverage-breaker-resume', { actionId, digest }),
        streamName: 'governance',
        evidenceProfile: 'SIGNED_OFFCHAIN',
        eventType: 'CoverageBreakerResumeAuthorized',
        resourceType: 'COVERAGE_BREAKER_ACTION',
        resourceId: actionId,
        actorWallet,
        actorRole: 'ADMIN',
        correlationId: input.correlationId,
        requestHash: digest.slice(2),
        payload: {
          snapshotId: context.snapshotId,
          evidenceHash: context.evidenceHash,
          policyVersion: context.policyVersion.toString(),
          safeAddress: this.#governanceSafe,
          routerAddress: this.#paymentRouter,
        },
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash,
          signer: approval.signer,
          digest,
          domain: `Abu24KV2Core:2:56:${this.#paymentRouter}`,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
        createdAt: now,
      });
      return actionProjection((await lockedAction(executor, actionId)));
    });
  }

  listActions(actor: FulfillmentActor) {
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const rows = await executor.query<ActionRow>(
        'SELECT * FROM core.coverage_breaker_actions ORDER BY created_at DESC, action_id DESC LIMIT 50',
      );
      return Object.freeze(rows.rows.map(actionProjection));
    });
  }

  async #resumeContext(
    executor: SqlExecutor,
    actor: FulfillmentActor,
    knownWallet?: string,
    requestedSnapshotId?: string,
  ): Promise<ResumeContext> {
    const actorWallet = knownWallet ?? await requireCurrentRole(executor, actor, ['ADMIN']);
    if (actorWallet === this.#secondarySigner) {
      throw new CoreError('Forbidden', 'Coverage resume requires an independent secondary wallet', 403);
    }
    const latestAction = await executor.query<ActionRow>(
      `SELECT * FROM core.coverage_breaker_actions
       WHERE state IN ('PENDING_PROPOSAL','SAFE_PROPOSED','MINED','FINAL')
       ORDER BY created_at DESC, action_id DESC LIMIT 1`,
    );
    const pause = latestAction.rows[0];
    if (!pause || pause.state !== 'FINAL' || !pause.target_paused) {
      throw new CoreError('FinalityPending', 'Coverage pause must be final before governed recovery', 409);
    }
    const blocked = await executor.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.breaker_causes
       WHERE scope = 'NEW_PAYMENT' AND active AND cause_type <> 'COVERAGE'`,
    );
    if (blocked.rows[0]?.count !== '0') {
      throw new CoreError('BreakerActive', 'Another payment breaker cause prevents coverage recovery', 409);
    }
    const causes = await executor.query<{
      scope: string;
      cause_id: string;
      evidence_hash: string;
      updated_at: Date;
    }>(
      `SELECT scope, cause_id, evidence_hash, updated_at FROM core.breaker_causes
       WHERE cause_type = 'COVERAGE' AND active ORDER BY scope, cause_id`,
    );
    if (causes.rows.length === 0) {
      throw new CoreError('InvalidRequest', 'No active coverage cause requires recovery', 409);
    }
    const latestSnapshot = await executor.query<{
      snapshot_id: string;
      evidence_hash: string;
      recorded_at: Date;
      canonical: boolean;
    }>(
      `SELECT snapshot_id, evidence_hash, recorded_at,
         COALESCE((
           SELECT canonical FROM core.coverage_snapshot_canonicality observation
           WHERE observation.snapshot_id = snapshot.snapshot_id
           ORDER BY observed_at DESC, observation_id DESC LIMIT 1
         ), snapshot.canonical) AS canonical
       FROM core.coverage_snapshots snapshot
       ORDER BY recorded_at DESC, snapshot_id DESC LIMIT 1`,
    );
    const latest = latestSnapshot.rows[0];
    if (!latest || !latest.canonical || latest.recorded_at <= pause.created_at) {
      throw new CoreError('FinalityPending', 'Fresh canonical coverage recovery evidence is unavailable', 409);
    }
    await requireCoveredSnapshot(executor, latest.snapshot_id);
    const recovery = requestedSnapshotId && requestedSnapshotId !== latest.snapshot_id
      ? (await executor.query<{
          snapshot_id: string;
          evidence_hash: string;
          recorded_at: Date;
          canonical: boolean;
        }>(
          `SELECT snapshot_id, evidence_hash, recorded_at,
             COALESCE((
               SELECT canonical FROM core.coverage_snapshot_canonicality observation
               WHERE observation.snapshot_id = snapshot.snapshot_id
               ORDER BY observed_at DESC, observation_id DESC LIMIT 1
             ), snapshot.canonical) AS canonical
           FROM core.coverage_snapshots snapshot WHERE snapshot_id = $1`,
          [requestedSnapshotId],
        )).rows[0]
      : latest;
    if (!recovery || !recovery.canonical || recovery.recorded_at <= pause.created_at) {
      throw new CoreError('FinalityPending', 'Signed coverage recovery snapshot is no longer canonical', 409);
    }
    await requireCoveredSnapshot(executor, recovery.snapshot_id);
    const policy = await executor.query<{ policy_version: string | number }>(
      `SELECT policy_version FROM core.policy_snapshots
       WHERE publication_status = 'PUBLISHED' ORDER BY policy_version DESC LIMIT 1`,
    );
    if (!policy.rows[0]) throw new CoreError('ExternalBlocked', 'Published policy is unavailable for breaker recovery', 503);
    const policyVersion = BigInt(policy.rows[0].policy_version);
    return {
      actorWallet,
      snapshotId: recovery.snapshot_id,
      evidenceHash: recovery.evidence_hash,
      policyVersion,
      oldValueHash: hashJson({ paused: true, causes: causes.rows }),
      newValueHash: hashJson({
        paused: false,
        snapshotId: recovery.snapshot_id,
        evidenceHash: recovery.evidence_hash,
      }),
    };
  }
}

async function requireCoveredSnapshot(executor: SqlExecutor, snapshotId: string) {
  const coverage = await executor.query<{ item_count: string; covered_count: string }>(
    `SELECT count(*)::text AS item_count,
       count(*) FILTER (WHERE coverage_met)::text AS covered_count
     FROM core.coverage_snapshot_items WHERE snapshot_id = $1`,
    [snapshotId],
  );
  if (
    coverage.rows[0]?.item_count === '0'
    || coverage.rows[0]?.item_count !== coverage.rows[0]?.covered_count
  ) throw new CoreError('BreakerActive', 'Coverage snapshot remains below 100%', 409);
}

function resumeIntent(
  context: ResumeContext,
  nonce: bigint,
  deadline: bigint,
  safeAddress: string,
): SensitiveActionIntent {
  return {
    action: 'RESUME_NEW_PAYMENTS',
    resourceType: 'COVERAGE_BREAKER',
    resourceId: context.snapshotId,
    policyVersion: context.policyVersion,
    oldValueHash: context.oldValueHash,
    newValueHash: context.newValueHash,
    safeAddress,
    nonce,
    deadline,
  };
}

function serializableIntent(intent: SensitiveActionIntent) {
  return {
    ...intent,
    policyVersion: intent.policyVersion.toString(),
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
  };
}

async function requireCurrentRole(executor: SqlExecutor, actor: FulfillmentActor, allowed: readonly string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) {
    throw new CoreError('Forbidden', 'Wallet session cannot govern coverage recovery', 403);
  }
  const wallet = address(actor.walletAddress, 'coverage governance wallet');
  const roles = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[])`,
    [wallet, [...allowed]],
  );
  if (!roles.rows[0]) throw new CoreError('Forbidden', 'Current wallet role cannot govern coverage recovery', 403);
  return wallet;
}

async function lockedAction(executor: SqlExecutor, actionId: string) {
  const result = await executor.query<ActionRow>(
    'SELECT * FROM core.coverage_breaker_actions WHERE action_id = $1 FOR UPDATE',
    [actionId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidFinality', 'Coverage-breaker action was not persisted', 409);
  return result.rows[0];
}

function actionProjection(row: ActionRow) {
  return Object.freeze({
    artifactVersion: CORE_ARTIFACT_VERSION,
    actionId: row.action_id,
    snapshotId: row.snapshot_id,
    policyVersion: String(row.policy_version),
    action: row.action,
    targetPaused: row.target_paused,
    evidenceHash: row.evidence_hash,
    governanceSafeAddress: row.governance_safe_address,
    routerAddress: row.router_address,
    calldataHash: row.calldata_hash,
    state: row.state,
    safeTxHash: row.safe_tx_hash,
    proposalHash: row.proposal_hash,
    executionTxHash: row.execution_tx_hash,
    confirmations: row.confirmations,
    actorWallet: row.actor_wallet,
    secondarySigner: row.secondary_signer,
    secondarySignatureHash: row.secondary_signature_hash,
    approvalNonce: row.approval_nonce === null ? null : String(row.approval_nonce),
    approvalDeadline: row.approval_deadline?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function unsigned(value: string, name: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return BigInt(value);
}

function validateDeadline(deadline: bigint, now: Date) {
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1_000));
  if (deadline <= nowSeconds) throw new CoreError('NonceExpired', 'Coverage resume approval expired', 401);
  if (deadline > nowSeconds + 900n) throw new CoreError('InvalidRequest', 'Coverage resume approval exceeds 15 minutes');
}

function signatureDigest(signature: string) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
    throw new CoreError('InvalidSignature', 'Coverage resume signature is malformed', 401);
  }
  return keccak256(signature).toLowerCase();
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function address(value: string, name: string) {
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
