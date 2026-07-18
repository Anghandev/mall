import { randomBytes } from 'node:crypto';
import { Interface, TypedDataEncoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  sensitiveActionDomain,
  sensitiveActionTypes,
  verifySensitiveActionApproval,
  type SensitiveActionIntent,
} from '../api/auth.ts';
import { CORE_ARTIFACT_VERSION, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import { reviewSeckillPrize } from './seckill-prize-service.ts';

const ROUTER = new Interface([
  'function openSeckillSession(bytes32 sessionId,uint64 policyVersion,uint64 startsAt)',
  'function setSeckillPurchasesPaused(bool paused,bytes32 evidenceHash)',
]);
const ERC20 = new Interface(['function transfer(address recipient,uint256 amount) returns (bool)']);
const FIXED_TIMERS = Object.freeze({
  mainDurationSeconds: 3_600,
  relayInitialSeconds: 60,
  relayIncrementSeconds: 30,
  relayCapSeconds: 60,
});

type ActionKind = 'OPEN_SESSION' | 'FORCE_CLOSE' | 'RESUME_PURCHASES' | 'PRIZE_INJECTION';
type ActionState =
  | 'DRAFT' | 'SECONDARY_SIGNED' | 'PENDING_EXECUTION' | 'SUBMITTED'
  | 'MINED' | 'FINAL' | 'REORGED' | 'FAILED' | 'CANCELLED';

export interface SeckillActionRow {
  action_id: string;
  session_id: string;
  policy_version: string | number;
  action_kind: ActionKind;
  evidence_hash: string;
  governance_wallet_address: string;
  target_address: string;
  calldata: string;
  calldata_hash: string;
  old_value_hash: string;
  new_value_hash: string;
  state: ActionState;
  executor_nonce: string | number | null;
  submitted_tx_hash: string | null;
  execution_evidence_hash: string | null;
  execution_tx_hash: string | null;
  block_number: string | number | null;
  block_hash: string | null;
  confirmations: number;
  canonical: boolean | null;
  actor_wallet: string;
  secondary_signer: string | null;
  secondary_signature_hash: string | null;
  approval_nonce: string | number | null;
  approval_deadline: Date | null;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
  updated_at: Date;
}

interface PlanRow {
  session_id: string;
  action_id: string;
  policy_version: string | number;
  merchant_id: string;
  product_id: string;
  sku_id: string;
  product_policy_hash: string;
  rules_content_hash: string;
  starts_at: Date;
  main_deadline: Date;
  relay_deadline: Date;
  inventory: string | number;
  seckill_list_price_usdt: string;
  snapshot: unknown;
  inventory_lock_state: 'LOCKED' | 'RELEASED';
  released_at: Date | null;
}

interface InjectionRow {
  injection_id: string;
  action_id: string;
  session_id: string;
  amount_usdt: string;
  operations_wallet_address: string;
  settlement_wallet_address: string;
  token_address: string;
  final_journal_id: string | null;
  reversal_journal_id: string | null;
}

export class SeckillOperationsService {
  readonly #transactions: SqlTransactionRunner;
  readonly #governanceWallet: string;
  readonly #operationsWallet: string;
  readonly #settlementWallet: string;
  readonly #paymentRouter: string;
  readonly #usdt: string;
  readonly #secondarySigner: string;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    governanceWalletAddress: string;
    operationsWalletAddress: string;
    settlementWalletAddress: string;
    paymentRouterAddress: string;
    usdtAddress?: string;
    secondarySignerAddress: string;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#governanceWallet = address(input.governanceWalletAddress, 'seckill governance wallet');
    this.#operationsWallet = address(input.operationsWalletAddress, 'operations wallet');
    this.#settlementWallet = address(input.settlementWalletAddress, 'USDT settlement wallet');
    this.#paymentRouter = address(input.paymentRouterAddress, 'PaymentRouter');
    this.#usdt = address(input.usdtAddress ?? USDT_ADDRESS, 'USDT');
    this.#secondarySigner = address(input.secondarySignerAddress, 'seckill secondary signer');
    this.#clock = input.clock ?? (() => new Date());
  }

  list(actor: FulfillmentActor) {
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const actions = await executor.query<SeckillActionRow>(
        'SELECT * FROM core.seckill_governance_actions ORDER BY created_at DESC, action_id DESC LIMIT 100',
      );
      return Object.freeze(await Promise.all(actions.rows.map((row) => actionProjection(executor, row))));
    });
  }

  get(actor: FulfillmentActor, actionId: string) {
    assertHash(actionId, 'seckill action ID');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      return actionProjection(executor, await loadAction(executor, actionId.toLowerCase()));
    });
  }

  createSession(
    actor: FulfillmentActor,
    input: {
      policyVersion: string;
      rulesContentHash: string;
      productId: string;
      skuId: string;
      inventory: number;
      seckillListPriceUsdt: string;
      startsAt: string;
      idempotencyKey: string;
      correlationId: string;
    },
  ) {
    const parsed = sessionInput(input, this.#clock());
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      const requestHash = hashJson({ wallet, ...parsed });
      const existing = await idempotentAction(executor, wallet, parsed.idempotencyKey, requestHash);
      if (existing) return actionProjection(executor, existing);
      const policy = await requireSessionPolicy(executor, parsed.policyVersion, parsed.rulesContentHash);
      const catalog = await requireSessionCatalog(executor, parsed.productId, parsed.skuId, parsed.inventory);
      await requireGuarantee(executor, catalog.merchant_id);
      const coverageSnapshotId = await requireFullCoverage(executor);
      await requireSeckillBreakerOpen(executor);
      await requireNoSessionOverlap(executor, parsed.skuId, parsed.startsAt, parsed.mainDeadline);
      await requireNoOrdinaryQuotes(executor, parsed.skuId, this.#clock());

      const sessionId = randomHash();
      const snapshot = {
        artifactVersion: CORE_ARTIFACT_VERSION,
        sessionId,
        policyVersion: parsed.policyVersion.toString(),
        policyHash: policy.policy_hash,
        rulesContentHash: parsed.rulesContentHash,
        merchantId: catalog.merchant_id,
        productId: parsed.productId,
        productVersion: String(catalog.product_version),
        skuId: parsed.skuId,
        skuVersion: String(catalog.sku_version),
        chainProductId: catalog.chain_product_id,
        chainSkuId: catalog.chain_sku_id,
        productPolicyHash: catalog.product_policy_hash,
        inventory: String(parsed.inventory),
        seckillListPriceUsdt: parsed.seckillListPriceUsdt,
        startsAt: parsed.startsAt.toISOString(),
        mainDeadline: parsed.mainDeadline.toISOString(),
        relayDeadline: parsed.relayDeadline.toISOString(),
        timers: FIXED_TIMERS,
        guaranteeEvidenceHash: catalog.guarantee_evidence_hash,
        coverageSnapshotId,
      };
      const evidenceHash = hashJson(snapshot);
      const calldata = ROUTER.encodeFunctionData('openSeckillSession', [
        sessionId,
        parsed.policyVersion,
        Math.floor(parsed.startsAt.getTime() / 1_000),
      ]).toLowerCase();
      const actionId = hashJson({ domain: 'ABU24K_SECKILL_OPEN_V1', sessionId, requestHash });
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.seckill_governance_actions (
           action_id, session_id, policy_version, action_kind, evidence_hash,
           governance_wallet_address, target_address, calldata, calldata_hash,
           old_value_hash, new_value_hash, state, actor_wallet,
           idempotency_key, request_hash, created_at, updated_at
         ) VALUES ($1,$2,$3,'OPEN_SESSION',$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11,$12,$13,$14,$14)`,
        [
          actionId,
          sessionId,
          parsed.policyVersion.toString(),
          evidenceHash,
          this.#governanceWallet,
          this.#paymentRouter,
          calldata,
          keccak256(calldata).toLowerCase(),
          hashJson({ sessionId, published: false }),
          evidenceHash,
          wallet,
          parsed.idempotencyKey,
          requestHash,
          now,
        ],
      );
      await executor.query(
        `INSERT INTO core.seckill_session_plans (
           session_id, action_id, policy_version, merchant_id, product_id, sku_id,
           product_policy_hash, rules_content_hash, starts_at, main_deadline,
           relay_deadline, inventory, seckill_list_price_usdt, snapshot,
           inventory_lock_state, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'LOCKED',$15,$15)`,
        [
          sessionId,
          actionId,
          parsed.policyVersion.toString(),
          catalog.merchant_id,
          parsed.productId,
          parsed.skuId,
          catalog.product_policy_hash,
          parsed.rulesContentHash,
          parsed.startsAt,
          parsed.mainDeadline,
          parsed.relayDeadline,
          parsed.inventory,
          parsed.seckillListPriceUsdt,
          JSON.stringify(snapshot),
          now,
        ],
      );
      const locked = await executor.query<{ sku_id: string }>(
        `UPDATE core.skus SET stock_available = stock_available - $2,
           stock_seckill_locked = stock_seckill_locked + $2
         WHERE sku_id = $1 AND lifecycle_state = 'ACTIVE' AND stock_available >= $2
         RETURNING sku_id`,
        [parsed.skuId, parsed.inventory],
      );
      if (!locked.rows[0]) throw new CoreError('InventoryUnavailable', 'Activity inventory cannot be locked', 409);
      await appendTransition(executor, actionId, null, 'DRAFT', { evidenceHash, requestHash }, now);
      await enqueueActionAudit(executor, {
        actionId,
        eventType: 'SeckillSessionDraftCreated',
        actorWallet: wallet,
        actorRole: actorRole(actor, ['ADMIN', 'OPERATOR']),
        correlationId: input.correlationId,
        requestHash,
        payload: snapshot,
        now,
      });
      return actionProjection(executor, await loadAction(executor, actionId));
    });
  }

  createForceClose(
    actor: FulfillmentActor,
    sessionId: string,
    input: { reasonCode: string; idempotencyKey: string; correlationId: string },
  ) {
    assertHash(sessionId, 'seckill session ID');
    validateIdempotencyKey(input.idempotencyKey);
    const reasonCode = boundedText(input.reasonCode, 'force-close reason', 2, 128);
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN']);
      const requestHash = hashJson({ wallet, sessionId: sessionId.toLowerCase(), reasonCode });
      const existing = await idempotentAction(executor, wallet, input.idempotencyKey, requestHash);
      if (existing) return actionProjection(executor, existing);
      const session = await executor.query<{
        session_id: string; policy_version: string | number; phase: string;
        starts_at: Date; main_deadline: Date; relay_deadline: Date;
      }>(
        'SELECT session_id, policy_version, phase, starts_at, main_deadline, relay_deadline FROM core.seckill_sessions WHERE session_id = $1 FOR UPDATE',
        [sessionId.toLowerCase()],
      );
      const row = session.rows[0];
      if (!row || row.phase === 'FORCE_CLOSED') throw new CoreError('InvalidRequest', 'Seckill session is not force-closeable', 409);
      const active = await executor.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM core.seckill_governance_actions
           WHERE action_kind = 'FORCE_CLOSE' AND session_id = $1
             AND state IN ('DRAFT','SECONDARY_SIGNED','PENDING_EXECUTION','SUBMITTED','MINED','FINAL')
         ) AS exists`,
        [row.session_id],
      );
      if (active.rows[0]?.exists) throw new CoreError('IdempotencyConflict', 'A force-close action already exists', 409);
      const evidenceHash = hashJson({
        sessionId: row.session_id,
        policyVersion: String(row.policy_version),
        reasonCode,
        requestedBy: wallet,
      });
      return this.#insertSimpleAction(executor, actor, {
        sessionId: row.session_id,
        policyVersion: BigInt(row.policy_version),
        actionKind: 'FORCE_CLOSE',
        evidenceHash,
        governanceWallet: this.#governanceWallet,
        targetAddress: this.#paymentRouter,
        calldata: ROUTER.encodeFunctionData('setSeckillPurchasesPaused', [true, evidenceHash]).toLowerCase(),
        oldValueHash: hashJson({ sessionId: row.session_id, phase: row.phase, paused: false }),
        newValueHash: hashJson({ sessionId: row.session_id, phase: 'FORCE_CLOSED', paused: true }),
        idempotencyKey: input.idempotencyKey,
        requestHash,
        correlationId: input.correlationId,
        auditEventType: 'SeckillForceCloseDraftCreated',
      });
    });
  }

  createResume(
    actor: FulfillmentActor,
    input: { sessionId: string; idempotencyKey: string; correlationId: string },
  ) {
    assertHash(input.sessionId, 'seckill session ID');
    validateIdempotencyKey(input.idempotencyKey);
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN']);
      const sessionId = input.sessionId.toLowerCase();
      const requestHash = hashJson({ wallet, sessionId, action: 'RESUME_PURCHASES' });
      const existing = await idempotentAction(executor, wallet, input.idempotencyKey, requestHash);
      if (existing) return actionProjection(executor, existing);
      const closed = await executor.query<{ policy_version: string | number; phase: string }>(
        'SELECT policy_version, phase FROM core.seckill_sessions WHERE session_id = $1 FOR UPDATE',
        [sessionId],
      );
      if (closed.rows[0]?.phase !== 'FORCE_CLOSED') {
        throw new CoreError('InvalidRequest', 'Only a finalized force-closed session can authorize breaker recovery', 409);
      }
      const causes = await executor.query<{ cause_type: string; cause_id: string; evidence_hash: string }>(
        `SELECT cause_type, cause_id, evidence_hash FROM core.breaker_causes
         WHERE scope = 'SECKILL_PURCHASE' AND active ORDER BY cause_type, cause_id`,
      );
      if (causes.rows.length === 0 || causes.rows.some((cause) => cause.cause_type !== 'OPERATIONS')) {
        throw new CoreError('BreakerActive', 'Seckill breaker has no exclusively operational recovery path', 409);
      }
      const evidenceHash = hashJson({ sessionId, causes: causes.rows, requestedBy: wallet });
      return this.#insertSimpleAction(executor, actor, {
        sessionId,
        policyVersion: BigInt(closed.rows[0].policy_version),
        actionKind: 'RESUME_PURCHASES',
        evidenceHash,
        governanceWallet: this.#governanceWallet,
        targetAddress: this.#paymentRouter,
        calldata: ROUTER.encodeFunctionData('setSeckillPurchasesPaused', [false, evidenceHash]).toLowerCase(),
        oldValueHash: hashJson({ paused: true, causes: causes.rows }),
        newValueHash: hashJson({ paused: false, closedSessionId: sessionId }),
        idempotencyKey: input.idempotencyKey,
        requestHash,
        correlationId: input.correlationId,
        auditEventType: 'SeckillBreakerResumeDraftCreated',
      });
    });
  }

  createPrizeInjection(
    actor: FulfillmentActor,
    sessionId: string,
    input: { amountUsdt: string; idempotencyKey: string; correlationId: string },
  ) {
    assertHash(sessionId, 'seckill session ID');
    validateIdempotencyKey(input.idempotencyKey);
    const amount = positiveAtomic(input.amountUsdt, 'prize injection amount');
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN']);
      const normalizedSessionId = sessionId.toLowerCase();
      const requestHash = hashJson({ wallet, sessionId: normalizedSessionId, amountUsdt: amount.toString() });
      const existing = await idempotentAction(executor, wallet, input.idempotencyKey, requestHash);
      if (existing) return actionProjection(executor, existing);
      await requireFullCoverage(executor);
      const session = await executor.query<{
        policy_version: string | number; phase: string; prize_pool_usdt: string;
      }>(
        `SELECT policy_version, phase, prize_pool_usdt::text
         FROM core.seckill_sessions WHERE session_id = $1 FOR UPDATE`,
        [normalizedSessionId],
      );
      const row = session.rows[0];
      if (!row || row.phase === 'FORCE_CLOSED' || row.phase === 'SETTLED') {
        throw new CoreError('InvalidRequest', 'Prize injection requires an unsettled published session', 409);
      }
      const evidenceHash = hashJson({
        sessionId: normalizedSessionId,
        amountUsdt: amount.toString(),
        operationsWalletAddress: this.#operationsWallet,
        settlementWalletAddress: this.#settlementWallet,
        tokenAddress: this.#usdt,
      });
      const projection = await this.#insertSimpleAction(executor, actor, {
        sessionId: normalizedSessionId,
        policyVersion: BigInt(row.policy_version),
        actionKind: 'PRIZE_INJECTION',
        evidenceHash,
        governanceWallet: this.#operationsWallet,
        targetAddress: this.#usdt,
        calldata: ERC20.encodeFunctionData('transfer', [this.#settlementWallet, amount]).toLowerCase(),
        oldValueHash: hashJson({ prizePoolUsdt: row.prize_pool_usdt }),
        newValueHash: hashJson({ prizePoolUsdt: (BigInt(row.prize_pool_usdt) + amount).toString() }),
        idempotencyKey: input.idempotencyKey,
        requestHash,
        correlationId: input.correlationId,
        auditEventType: 'SeckillPrizeInjectionDraftCreated',
      });
      const actionId = projection.actionId;
      await executor.query(
        `INSERT INTO core.seckill_prize_injections (
           injection_id, action_id, session_id, amount_usdt, operations_wallet_address,
           settlement_wallet_address, token_address, created_at, updated_at
         ) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$7)`,
        [
          actionId,
          normalizedSessionId,
          amount.toString(),
          this.#operationsWallet,
          this.#settlementWallet,
          this.#usdt,
          this.#clock(),
        ],
      );
      return actionProjection(executor, await loadAction(executor, actionId));
    });
  }

  reviewWinner(
    actor: FulfillmentActor,
    sessionId: string,
    input: {
      decision: 'APPROVE' | 'REJECT';
      reasonCode: string;
      evidenceHash: string;
      idempotencyKey: string;
      correlationId: string;
    },
  ) {
    assertHash(sessionId, 'seckill session ID');
    if (!['APPROVE', 'REJECT'].includes(input.decision)) {
      throw new CoreError('InvalidRequest', 'Seckill winner review decision is invalid');
    }
    const reasonCode = boundedText(input.reasonCode, 'winner review reason', 2, 128);
    assertHash(input.evidenceHash, 'winner review evidence hash');
    validateIdempotencyKey(input.idempotencyKey);
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN']);
      const normalizedSessionId = sessionId.toLowerCase();
      const requestHash = hashJson({
        wallet,
        sessionId: normalizedSessionId,
        decision: input.decision,
        reasonCode,
        evidenceHash: input.evidenceHash.toLowerCase(),
      });
      const now = this.#clock();
      const authorizationEvidenceHash = hashJson({
        wallet,
        roles: ['ADMIN'],
        checkedAt: now.toISOString(),
      });
      const projection = await reviewSeckillPrize(executor, {
        sessionId: normalizedSessionId,
        actorWallet: wallet,
        decision: input.decision,
        reasonCode,
        evidenceHash: input.evidenceHash.toLowerCase(),
        idempotencyKey: input.idempotencyKey,
        requestHash,
        at: now,
      });
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:seckill-prize-review', {
          sessionId: normalizedSessionId,
          requestHash,
        }),
        streamName: 'financial',
        evidenceProfile: 'RBAC',
        eventType: input.decision === 'APPROVE'
          ? 'SeckillWinnerReviewApproved'
          : 'SeckillWinnerReviewRejected',
        resourceType: 'SECKILL_SESSION',
        resourceId: normalizedSessionId,
        actorWallet: wallet,
        actorRole: 'ADMIN',
        correlationId: input.correlationId,
        requestHash: requestHash.slice(2),
        payload: {
          decision: input.decision,
          reasonCode,
          evidenceHash: input.evidenceHash.toLowerCase(),
          candidateOrderId: projection.candidate?.orderId ?? null,
          replacementWinner: null,
        },
        authorizationEvidence: {
          scheme: 'RBAC_ROLE_REVALIDATION',
          subject: wallet,
          roles: ['ADMIN'],
          evidenceHash: authorizationEvidenceHash,
          checkedAt: now.toISOString(),
        },
        createdAt: now,
      });
      return projection;
    });
  }

  approvalChallenge(actor: FulfillmentActor, actionId: string, input: { nonce: string; deadline: string }) {
    assertHash(actionId, 'seckill action ID');
    const nonce = unsigned(input.nonce, 'seckill approval nonce');
    const deadline = unsigned(input.deadline, 'seckill approval deadline');
    validateDeadline(deadline, this.#clock());
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN']);
      const action = await lockedAction(executor, actionId.toLowerCase());
      if (action.state !== 'DRAFT') throw new CoreError('InvalidRequest', 'Seckill action is not awaiting approval', 409);
      if (wallet === this.#secondarySigner) {
        throw new CoreError('Forbidden', 'Seckill approval requires an independent secondary wallet', 403);
      }
      const intent = actionIntent(action, nonce, deadline);
      const domain = sensitiveActionDomain(action.target_address);
      return Object.freeze({
        artifactVersion: CORE_ARTIFACT_VERSION,
        actionId: action.action_id,
        sessionId: action.session_id,
        actionKind: action.action_kind,
        signer: this.#secondarySigner,
        executorWallet: action.governance_wallet_address,
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

  submitApproval(
    actor: FulfillmentActor,
    actionId: string,
    input: { nonce: string; deadline: string; signature: string; correlationId: string },
  ) {
    assertHash(actionId, 'seckill action ID');
    const nonce = unsigned(input.nonce, 'seckill approval nonce');
    const deadline = unsigned(input.deadline, 'seckill approval deadline');
    validateDeadline(deadline, this.#clock());
    const signatureHash = signatureDigest(input.signature);
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN']);
      const action = await lockedAction(executor, actionId.toLowerCase());
      if (action.state !== 'DRAFT') {
        if (
          action.secondary_signer === this.#secondarySigner
          && String(action.approval_nonce) === nonce.toString()
          && action.secondary_signature_hash === signatureHash
        ) return actionProjection(executor, action);
        throw new CoreError('IdempotencyConflict', 'Seckill action approval no longer matches the draft', 409);
      }
      if (wallet === this.#secondarySigner) {
        throw new CoreError('Forbidden', 'Seckill approval requires an independent secondary wallet', 403);
      }
      const intent = actionIntent(action, nonce, deadline);
      const approval = verifySensitiveActionApproval(
        intent,
        input.signature,
        this.#secondarySigner,
        action.governance_wallet_address,
        action.target_address,
        this.#clock(),
      );
      if (approval.signer === wallet) {
        throw new CoreError('Forbidden', 'Seckill approval requires an independent secondary wallet', 403);
      }
      const now = this.#clock();
      await executor.query(
        `UPDATE core.seckill_governance_actions
         SET state = 'SECONDARY_SIGNED', secondary_signer = $2,
           secondary_signature_hash = $3, approval_nonce = $4,
           approval_deadline = $5, updated_at = $6
         WHERE action_id = $1`,
        [action.action_id, approval.signer, signatureHash, nonce.toString(), new Date(Number(deadline) * 1_000), now],
      );
      const digest = TypedDataEncoder.hash(approval.domain, sensitiveActionTypes, intent).toLowerCase();
      await appendTransition(executor, action.action_id, 'DRAFT', 'SECONDARY_SIGNED', { digest, signatureHash }, now);
      await enqueueActionAudit(executor, {
        actionId: action.action_id,
        eventType: 'SeckillActionSecondarySigned',
        actorWallet: wallet,
        actorRole: 'ADMIN',
        correlationId: input.correlationId,
        requestHash: digest,
        payload: { actionKind: action.action_kind, sessionId: action.session_id, digest, signatureHash },
        now,
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash,
          signer: approval.signer,
          digest,
          domain: `Abu24KV2Core:2:56:${action.target_address}`,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      });
      return actionProjection(executor, await loadAction(executor, action.action_id));
    });
  }

  execute(actor: FulfillmentActor, actionId: string, correlationId: string) {
    assertHash(actionId, 'seckill action ID');
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN']);
      const action = await lockedAction(executor, actionId.toLowerCase());
      if (action.state === 'PENDING_EXECUTION' || ['SUBMITTED', 'MINED', 'FINAL'].includes(action.state)) {
        return actionProjection(executor, action);
      }
      if (action.state !== 'SECONDARY_SIGNED') {
        throw new CoreError('InvalidRequest', 'Seckill action is not secondary-signed', 409);
      }
      if (!action.approval_deadline || action.approval_deadline <= this.#clock()) {
        throw new CoreError('NonceExpired', 'Seckill approval expired before EOA execution', 401);
      }
      const now = this.#clock();
      await executor.query(
        `UPDATE core.seckill_governance_actions SET state = 'PENDING_EXECUTION', updated_at = $2
         WHERE action_id = $1`,
        [action.action_id, now],
      );
      await appendTransition(executor, action.action_id, 'SECONDARY_SIGNED', 'PENDING_EXECUTION', {}, now);
      await enqueueActionAudit(executor, {
        actionId: action.action_id,
        eventType: 'SeckillEoaExecutionRequested',
        actorWallet: wallet,
        actorRole: 'ADMIN',
        correlationId,
        requestHash: action.calldata_hash,
        payload: { actionKind: action.action_kind, sessionId: action.session_id, calldataHash: action.calldata_hash },
        now,
      });
      return actionProjection(executor, await loadAction(executor, action.action_id));
    });
  }

  cancel(actor: FulfillmentActor, actionId: string, input: { correlationId: string }) {
    assertHash(actionId, 'seckill action ID');
    return this.#transactions.transaction(async (executor) => {
      const wallet = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      const action = await lockedAction(executor, actionId.toLowerCase());
      if (!['DRAFT', 'SECONDARY_SIGNED'].includes(action.state)) {
        throw new CoreError('InvalidRequest', 'Only an unsubmitted seckill action can be cancelled', 409);
      }
      if (action.action_kind !== 'OPEN_SESSION' && !actor.roles.includes('ADMIN')) {
        throw new CoreError('Forbidden', 'Only ADMIN can cancel governed seckill controls', 403);
      }
      const now = this.#clock();
      if (action.action_kind === 'OPEN_SESSION') {
        await releaseSeckillPlanInventory(executor, action.session_id, now, false);
      }
      await executor.query(
        `UPDATE core.seckill_governance_actions SET state = 'CANCELLED', updated_at = $2
         WHERE action_id = $1`,
        [action.action_id, now],
      );
      await appendTransition(executor, action.action_id, action.state, 'CANCELLED', {}, now);
      await enqueueActionAudit(executor, {
        actionId: action.action_id,
        eventType: 'SeckillActionCancelled',
        actorWallet: wallet,
        actorRole: actorRole(actor, ['ADMIN', 'OPERATOR']),
        correlationId: input.correlationId,
        requestHash: action.request_hash,
        payload: { actionKind: action.action_kind, sessionId: action.session_id },
        now,
      });
      return actionProjection(executor, await loadAction(executor, action.action_id));
    });
  }

  async #insertSimpleAction(
    executor: SqlExecutor,
    actor: FulfillmentActor,
    input: {
      sessionId: string;
      policyVersion: bigint;
      actionKind: Exclude<ActionKind, 'OPEN_SESSION'>;
      evidenceHash: string;
      governanceWallet: string;
      targetAddress: string;
      calldata: string;
      oldValueHash: string;
      newValueHash: string;
      idempotencyKey: string;
      requestHash: string;
      correlationId: string;
      auditEventType: string;
    },
  ) {
    const wallet = address(actor.walletAddress, 'seckill actor wallet');
    const actionId = hashJson({
      domain: `ABU24K_SECKILL_${input.actionKind}_V1`,
      sessionId: input.sessionId,
      requestHash: input.requestHash,
    });
    const now = this.#clock();
    await executor.query(
      `INSERT INTO core.seckill_governance_actions (
         action_id, session_id, policy_version, action_kind, evidence_hash,
         governance_wallet_address, target_address, calldata, calldata_hash,
         old_value_hash, new_value_hash, state, actor_wallet,
         idempotency_key, request_hash, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT',$12,$13,$14,$15,$15)`,
      [
        actionId,
        input.sessionId,
        input.policyVersion.toString(),
        input.actionKind,
        input.evidenceHash,
        input.governanceWallet,
        input.targetAddress,
        input.calldata,
        keccak256(input.calldata).toLowerCase(),
        input.oldValueHash,
        input.newValueHash,
        wallet,
        input.idempotencyKey,
        input.requestHash,
        now,
      ],
    );
    await appendTransition(executor, actionId, null, 'DRAFT', { evidenceHash: input.evidenceHash }, now);
    await enqueueActionAudit(executor, {
      actionId,
      eventType: input.auditEventType,
      actorWallet: wallet,
      actorRole: 'ADMIN',
      correlationId: input.correlationId,
      requestHash: input.requestHash,
      payload: { actionKind: input.actionKind, sessionId: input.sessionId, evidenceHash: input.evidenceHash },
      now,
    });
    return actionProjection(executor, await loadAction(executor, actionId));
  }
}

export async function releaseSeckillPlanInventory(
  executor: SqlExecutor,
  sessionId: string,
  at: Date,
  expireQuotes: boolean,
) {
  const plan = await executor.query<PlanRow>(
    'SELECT * FROM core.seckill_session_plans WHERE session_id = $1 FOR UPDATE',
    [sessionId],
  );
  const row = plan.rows[0];
  if (!row || row.inventory_lock_state === 'RELEASED') return;
  if (expireQuotes) {
    const reservations = await executor.query<{ reservation_id: string }>(
      `SELECT leg.reservation_id
       FROM core.payment_quotes quote
       JOIN core.payment_quote_legs leg ON leg.order_id = quote.order_id
       JOIN core.inventory_reservations reservation ON reservation.reservation_id = leg.reservation_id
       WHERE quote.session_id = $1 AND quote.state IN ('QUOTED','REORGED')
         AND reservation.state = 'ACTIVE'
       FOR UPDATE OF reservation`,
      [sessionId],
    );
    for (const reservation of reservations.rows) {
      await executor.query("SELECT core.release_inventory_reservation($1, 'RELEASED')", [reservation.reservation_id]);
    }
    await executor.query(
      `UPDATE core.payment_quotes SET state = 'EXPIRED', updated_at = $2
       WHERE session_id = $1 AND state IN ('QUOTED','REORGED')`,
      [sessionId, at],
    );
  }
  const session = await executor.query<{ sold: string | number; reserved: string | number }>(
    'SELECT sold, reserved FROM core.seckill_sessions WHERE session_id = $1 FOR UPDATE',
    [sessionId],
  );
  const sold = BigInt(session.rows[0]?.sold ?? 0);
  const reserved = BigInt(session.rows[0]?.reserved ?? 0);
  if (reserved !== 0n) return;
  const releasable = BigInt(row.inventory) - sold;
  if (releasable < 0n) throw new CoreError('UnknownState', 'Seckill inventory lock is below sold inventory', 409);
  if (releasable > 0n) {
    const released = await executor.query<{ sku_id: string }>(
      `UPDATE core.skus SET stock_available = stock_available + $2,
         stock_seckill_locked = stock_seckill_locked - $2
       WHERE sku_id = $1 AND stock_seckill_locked >= $2 RETURNING sku_id`,
      [row.sku_id, releasable.toString()],
    );
    if (!released.rows[0]) throw new CoreError('UnknownState', 'Seckill inventory lock cannot be released', 409);
  }
  await executor.query(
    `UPDATE core.seckill_session_plans
     SET inventory_lock_state = 'RELEASED', released_at = $2, updated_at = $2
     WHERE session_id = $1`,
    [sessionId, at],
  );
}

async function requireSessionPolicy(executor: SqlExecutor, policyVersion: bigint, rulesContentHash: string) {
  const result = await executor.query<{
    policy_version: string | number;
    policy_hash: string;
    rules_content_hash: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT policy_version, policy_hash, rules_content_hash, payload
     FROM core.policy_snapshots
     WHERE policy_version = $1 AND publication_status = 'PUBLISHED'
       AND policy_version = (SELECT max(policy_version) FROM core.policy_snapshots WHERE publication_status = 'PUBLISHED')`,
    [policyVersion.toString()],
  );
  const policy = result.rows[0];
  if (!policy) throw new CoreError('DecisionBlocked', 'Session requires the latest published policyVersion', 409);
  if (policy.rules_content_hash.toLowerCase() !== rulesContentHash) {
    throw new CoreError('DecisionBlocked', 'Session rules hash does not match its policyVersion', 409);
  }
  const timers = {
    mainDurationSeconds: integerPolicy(policy.payload.seckillMainDuration, 'seckill main duration'),
    relayInitialSeconds: integerPolicy(policy.payload.relayInitial, 'relay initial'),
    relayIncrementSeconds: integerPolicy(policy.payload.relayIncrement, 'relay increment'),
    relayCapSeconds: integerPolicy(policy.payload.relayCap, 'relay cap'),
  };
  if (stableJson(timers) !== stableJson(FIXED_TIMERS)) {
    throw new CoreError('DecisionBlocked', 'Published policy does not contain the frozen seckill timers', 409);
  }
  const rules = await executor.query<{ active_version_id: string }>(
    `SELECT publication.active_version_id
     FROM core.current_cms_publications publication
     JOIN core.cms_entries entry ON entry.entry_id = publication.entry_id
     WHERE entry.content_type = 'SECKILL_RULES'
       AND publication.policy_version = $1
       AND publication.content_hash = $2
       AND (publication.starts_at IS NULL OR publication.starts_at <= clock_timestamp())
       AND (publication.ends_at IS NULL OR publication.ends_at > clock_timestamp())
     LIMIT 1`,
    [policyVersion.toString(), rulesContentHash],
  );
  if (!rules.rows[0]) throw new CoreError('DecisionBlocked', 'Published seckill rules are unavailable for this policy', 409);
  return policy;
}

async function requireSessionCatalog(executor: SqlExecutor, productId: string, skuId: string, inventory: number) {
  const result = await executor.query<{
    merchant_id: string;
    merchant_status: string;
    guarantee_status: string;
    product_version: string | number;
    product_policy_hash: string;
    chain_product_id: string;
    product_state: string;
    sku_version: string | number;
    chain_sku_id: string;
    sku_state: string;
    stock_available: string | number;
    proposed_seckill_inventory: string | number;
    guarantee_evidence_hash: string;
  }>(
    `SELECT product.merchant_id, merchant.status AS merchant_status,
       merchant.guarantee_status, product.version AS product_version,
       product.product_policy_hash, product.chain_product_id,
       product.lifecycle_state AS product_state, sku.sku_version,
       sku.chain_sku_id, sku.lifecycle_state AS sku_state,
       sku.stock_available, sku.proposed_seckill_inventory,
       guarantee.source_evidence_hash AS guarantee_evidence_hash
     FROM core.products product
     JOIN core.skus sku ON sku.product_id = product.product_id
     JOIN core.merchants merchant ON merchant.merchant_id = product.merchant_id
     LEFT JOIN core.merchant_guarantees guarantee ON guarantee.merchant_id = merchant.merchant_id
     WHERE product.product_id = $1 AND sku.sku_id = $2
     FOR UPDATE OF product, sku, merchant`,
    [productId, skuId],
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('InvalidRequest', 'Session product or SKU was not found', 404);
  if (row.merchant_status !== 'APPROVED' || row.guarantee_status !== 'READY') {
    throw new CoreError('Forbidden', 'Merchant is not eligible for a seckill session', 409);
  }
  if (row.product_state !== 'ACTIVE' || row.sku_state !== 'ACTIVE') {
    throw new CoreError('InvalidRequest', 'Session product and SKU must be active', 409);
  }
  if (inventory > Number(row.proposed_seckill_inventory)) {
    throw new CoreError('InventoryUnavailable', 'Activity inventory exceeds the merchant proposal', 409);
  }
  if (inventory > Number(row.stock_available)) {
    throw new CoreError('InventoryUnavailable', 'Activity inventory exceeds available stock', 409);
  }
  if (!row.guarantee_evidence_hash) throw new CoreError('FinalityPending', 'Merchant guarantee evidence is unavailable', 409);
  return row;
}

async function requireGuarantee(executor: SqlExecutor, merchantId: string) {
  const guarantee = await executor.query<{ balance_usdt: string; minimum_usdt: string }>(
    'SELECT balance_usdt::text, minimum_usdt::text FROM core.merchant_guarantees WHERE merchant_id = $1',
    [merchantId],
  );
  const row = guarantee.rows[0];
  if (!row || BigInt(row.balance_usdt) < BigInt(row.minimum_usdt)) {
    throw new CoreError('BreakerActive', 'Merchant guarantee is below 1,000 USDT', 409);
  }
}

async function requireFullCoverage(executor: SqlExecutor) {
  const snapshot = await executor.query<{ snapshot_id: string; canonical: boolean }>(
    `SELECT snapshot.snapshot_id,
       COALESCE((
         SELECT canonical FROM core.coverage_snapshot_canonicality observation
         WHERE observation.snapshot_id = snapshot.snapshot_id
         ORDER BY observed_at DESC, observation_id DESC LIMIT 1
       ), snapshot.canonical) AS canonical
     FROM core.coverage_snapshots snapshot
     ORDER BY recorded_at DESC, snapshot_id DESC LIMIT 1`,
  );
  const row = snapshot.rows[0];
  if (!row?.canonical) throw new CoreError('FinalityPending', 'Canonical coverage evidence is unavailable', 409);
  const coverage = await executor.query<{ item_count: string; covered_count: string }>(
    `SELECT count(*)::text AS item_count,
       count(*) FILTER (WHERE coverage_met)::text AS covered_count
     FROM core.coverage_snapshot_items WHERE snapshot_id = $1`,
    [row.snapshot_id],
  );
  if (coverage.rows[0]?.item_count === '0' || coverage.rows[0]?.item_count !== coverage.rows[0]?.covered_count) {
    throw new CoreError('BreakerActive', 'Wallet assets / unsettled liabilities coverage is below 100%', 409);
  }
  return row.snapshot_id;
}

async function requireSeckillBreakerOpen(executor: SqlExecutor) {
  const breaker = await executor.query<{ paused: boolean }>(
    "SELECT paused FROM core.circuit_breakers WHERE scope = 'SECKILL_PURCHASE'",
  );
  if (breaker.rows[0]?.paused !== false) throw new CoreError('BreakerActive', 'Seckill purchases are paused', 409);
}

async function requireNoSessionOverlap(
  executor: SqlExecutor,
  skuId: string,
  startsAt: Date,
  mainDeadline: Date,
) {
  const overlap = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM core.seckill_session_plans plan
       JOIN core.seckill_governance_actions action ON action.action_id = plan.action_id
       WHERE plan.sku_id = $1 AND action.state NOT IN ('REORGED','FAILED','CANCELLED')
         AND tstzrange(plan.starts_at, plan.main_deadline, '[)') && tstzrange($2, $3, '[)')
       UNION ALL
       SELECT 1 FROM core.seckill_sessions session
       WHERE session.sku_id = $1 AND session.phase IN ('PREHEAT','LIVE','SETTLING')
         AND tstzrange(session.starts_at, session.main_deadline, '[)') && tstzrange($2, $3, '[)')
     ) AS exists`,
    [skuId, startsAt, mainDeadline],
  );
  if (overlap.rows[0]?.exists) throw new CoreError('InvalidRequest', 'Seckill session overlaps an active schedule', 409);
}

async function requireNoOrdinaryQuotes(executor: SqlExecutor, skuId: string, now: Date) {
  const active = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM core.payment_quotes
       WHERE sku_id = $1 AND quote_kind = 'ORDINARY'
         AND state IN ('QUOTED','SUBMITTED','REORGED') AND deadline > $2
     ) AS exists`,
    [skuId, now],
  );
  if (active.rows[0]?.exists) throw new CoreError('FinalityPending', 'Active ordinary quote prevents activity inventory lock', 409);
}

function sessionInput(
  input: {
    policyVersion: string;
    rulesContentHash: string;
    productId: string;
    skuId: string;
    inventory: number;
    seckillListPriceUsdt: string;
    startsAt: string;
    idempotencyKey: string;
  },
  now: Date,
) {
  const policyVersion = positiveAtomic(input.policyVersion, 'policyVersion');
  assertHash(input.rulesContentHash, 'rules content hash');
  const productId = boundedText(input.productId, 'product ID', 1, 160);
  const skuId = boundedText(input.skuId, 'SKU ID', 1, 160);
  if (!Number.isSafeInteger(input.inventory) || input.inventory <= 0) {
    throw new CoreError('InvalidRequest', 'Session inventory must be a positive integer');
  }
  const seckillListPriceUsdt = positiveAtomic(input.seckillListPriceUsdt, 'seckill price').toString();
  const startsAt = new Date(input.startsAt);
  if (!Number.isFinite(startsAt.getTime()) || startsAt <= now) {
    throw new CoreError('InvalidRequest', 'Session start must be a future ISO timestamp');
  }
  validateIdempotencyKey(input.idempotencyKey);
  return {
    policyVersion,
    rulesContentHash: input.rulesContentHash.toLowerCase(),
    productId,
    skuId,
    inventory: input.inventory,
    seckillListPriceUsdt,
    startsAt,
    mainDeadline: new Date(startsAt.getTime() + FIXED_TIMERS.mainDurationSeconds * 1_000),
    relayDeadline: new Date(startsAt.getTime() + FIXED_TIMERS.relayInitialSeconds * 1_000),
    idempotencyKey: input.idempotencyKey,
  };
}

function actionIntent(action: SeckillActionRow, nonce: bigint, deadline: bigint): SensitiveActionIntent {
  return {
    action: `SECKILL_${action.action_kind}`,
    resourceType: 'SECKILL_SESSION',
    resourceId: action.session_id,
    policyVersion: BigInt(action.policy_version),
    oldValueHash: action.old_value_hash,
    newValueHash: action.new_value_hash,
    executorWallet: action.governance_wallet_address,
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

async function actionProjection(executor: SqlExecutor, row: SeckillActionRow) {
  const plan = row.action_kind === 'OPEN_SESSION'
    ? (await executor.query<PlanRow>('SELECT * FROM core.seckill_session_plans WHERE action_id = $1', [row.action_id])).rows[0]
    : undefined;
  const injection = row.action_kind === 'PRIZE_INJECTION'
    ? (await executor.query<InjectionRow>('SELECT * FROM core.seckill_prize_injections WHERE action_id = $1', [row.action_id])).rows[0]
    : undefined;
  return Object.freeze({
    artifactVersion: CORE_ARTIFACT_VERSION,
    actionId: row.action_id,
    sessionId: row.session_id,
    policyVersion: String(row.policy_version),
    actionKind: row.action_kind,
    state: row.state,
    evidenceHash: row.evidence_hash,
    executorWallet: row.governance_wallet_address,
    targetAddress: row.target_address,
    calldataHash: row.calldata_hash,
    executorNonce: row.executor_nonce === null ? null : String(row.executor_nonce),
    submittedTxHash: row.submitted_tx_hash,
    executionEvidenceHash: row.execution_evidence_hash,
    executionTxHash: row.execution_tx_hash,
    blockNumber: row.block_number === null ? null : String(row.block_number),
    blockHash: row.block_hash,
    confirmations: row.confirmations,
    canonical: row.canonical,
    actorWallet: row.actor_wallet,
    secondarySigner: row.secondary_signer,
    approvalNonce: row.approval_nonce === null ? null : String(row.approval_nonce),
    approvalDeadline: row.approval_deadline?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sessionPlan: plan ? {
      merchantId: plan.merchant_id,
      productId: plan.product_id,
      skuId: plan.sku_id,
      productPolicyHash: plan.product_policy_hash,
      rulesContentHash: plan.rules_content_hash,
      startsAt: plan.starts_at.toISOString(),
      mainDeadline: plan.main_deadline.toISOString(),
      relayDeadline: plan.relay_deadline.toISOString(),
      inventory: String(plan.inventory),
      seckillListPriceUsdt: plan.seckill_list_price_usdt,
      timers: FIXED_TIMERS,
      snapshot: object(plan.snapshot),
      inventoryLockState: plan.inventory_lock_state,
      releasedAt: plan.released_at?.toISOString() ?? null,
    } : null,
    prizeInjection: injection ? {
      injectionId: injection.injection_id,
      amountUsdt: injection.amount_usdt,
      operationsWalletAddress: injection.operations_wallet_address,
      settlementWalletAddress: injection.settlement_wallet_address,
      tokenAddress: injection.token_address,
      finalJournalId: injection.final_journal_id,
      reversalJournalId: injection.reversal_journal_id,
    } : null,
    allowedActions: allowedActions(row),
  });
}

function allowedActions(row: SeckillActionRow) {
  if (row.state === 'DRAFT') return ['APPROVE_SECONDARY', 'CANCEL'];
  if (row.state === 'SECONDARY_SIGNED') return ['PROPOSE_SAFE', 'CANCEL'];
  return [];
}

async function idempotentAction(executor: SqlExecutor, wallet: string, key: string, requestHash: string) {
  const result = await executor.query<SeckillActionRow>(
    'SELECT * FROM core.seckill_governance_actions WHERE actor_wallet = $1 AND idempotency_key = $2',
    [wallet, key],
  );
  if (result.rows[0] && result.rows[0].request_hash !== requestHash) {
    throw new CoreError('IdempotencyConflict', 'Seckill operation idempotency conflict', 409);
  }
  return result.rows[0];
}

async function loadAction(executor: SqlExecutor, actionId: string) {
  const result = await executor.query<SeckillActionRow>(
    'SELECT * FROM core.seckill_governance_actions WHERE action_id = $1',
    [actionId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Seckill action was not found', 404);
  return result.rows[0];
}

async function lockedAction(executor: SqlExecutor, actionId: string) {
  const result = await executor.query<SeckillActionRow>(
    'SELECT * FROM core.seckill_governance_actions WHERE action_id = $1 FOR UPDATE',
    [actionId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Seckill action was not found', 404);
  return result.rows[0];
}

async function appendTransition(
  executor: SqlExecutor,
  actionId: string,
  fromState: ActionState | null,
  toState: ActionState,
  evidence: Record<string, unknown>,
  at: Date,
) {
  const transitionId = hashJson({ actionId, fromState, toState, evidence });
  await executor.query(
    `INSERT INTO core.seckill_governance_transitions (
       transition_id, action_id, from_state, to_state, evidence, recorded_at
     ) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (transition_id) DO NOTHING`,
    [transitionId, actionId, fromState, toState, JSON.stringify(evidence), at],
  );
}

async function requireCurrentRole(executor: SqlExecutor, actor: FulfillmentActor, allowed: readonly string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) {
    throw new CoreError('Forbidden', 'Wallet session cannot operate seckill governance', 403);
  }
  const wallet = address(actor.walletAddress, 'seckill actor wallet');
  const roles = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[])`,
    [wallet, [...allowed]],
  );
  if (!roles.rows[0]) throw new CoreError('Forbidden', 'Current wallet role cannot operate seckill governance', 403);
  return wallet;
}

async function enqueueActionAudit(
  executor: SqlExecutor,
  input: {
    actionId: string;
    eventType: string;
    actorWallet: string;
    actorRole: string;
    correlationId: string;
    requestHash: string;
    payload: Record<string, unknown>;
    now: Date;
    signatureEvidence?: {
      scheme: 'EIP712'; signatureHash: string; signer: string; digest: string;
      domain: string; nonce: string; deadline: string;
    };
  },
) {
  const authorizationEvidenceHash = hashJson({
    wallet: input.actorWallet,
    roles: [input.actorRole],
    checkedAt: input.now.toISOString(),
  });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:seckill-governance', {
      actionId: input.actionId,
      eventType: input.eventType,
      requestHash: input.requestHash,
    }),
    streamName: 'governance',
    evidenceProfile: input.signatureEvidence ? 'SIGNED_OFFCHAIN' : 'RBAC',
    eventType: input.eventType,
    resourceType: 'SECKILL_GOVERNANCE_ACTION',
    resourceId: input.actionId,
    actorWallet: input.actorWallet,
    actorRole: input.actorRole,
    correlationId: input.correlationId,
    requestHash: input.requestHash.replace(/^0x/, ''),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: input.actorWallet,
      roles: [input.actorRole],
      evidenceHash: authorizationEvidenceHash,
      checkedAt: input.now.toISOString(),
    },
    ...(input.signatureEvidence ? { signatureEvidence: input.signatureEvidence } : {}),
    createdAt: input.now,
  });
}

function actorRole(actor: FulfillmentActor, allowed: readonly string[]) {
  return actor.roles.find((role) => allowed.includes(role)) ?? allowed[0]!;
}

function validateIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid idempotency key');
}

function validateDeadline(deadline: bigint, now: Date) {
  const epoch = BigInt(Math.floor(now.getTime() / 1_000));
  if (deadline <= epoch || deadline > epoch + 15n * 60n) {
    throw new CoreError('NonceExpired', 'Seckill approval deadline must be within 15 minutes', 401);
  }
}

function unsigned(value: string, name: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  const result = BigInt(value);
  if (result >= (1n << 256n)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return result;
}

function positiveAtomic(value: string, name: string) {
  const result = unsigned(value, name);
  if (result === 0n) throw new CoreError('InvalidRequest', `${name} must be positive`);
  return result;
}

function integerPolicy(value: unknown, name: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new CoreError('DecisionBlocked', `${name} is invalid`, 409);
  return number;
}

function boundedText(value: string, name: string, minimum: number, maximum: number) {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum) {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
  return value.trim();
}

function assertHash(value: string, name: string): asserts value is string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
}

function signatureDigest(value: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new CoreError('InvalidSignature', 'Seckill approval signature is invalid', 401);
  }
  return keccak256(value).toLowerCase();
}

function address(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
}

function randomHash() {
  return `0x${randomBytes(32).toString('hex')}`;
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function object(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
