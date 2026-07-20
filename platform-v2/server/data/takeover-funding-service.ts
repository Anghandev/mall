import { randomUUID } from 'node:crypto';
import { TypedDataEncoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  sensitiveActionDomain,
  sensitiveActionTypes,
  verifySensitiveActionApproval,
  type SensitiveActionIntent,
} from '../api/auth.ts';
import type { UserRole } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import {
  isMicrotestMerchantProduct,
  type MainnetMicrotestEntitlement,
} from './mainnet-microtest-entitlement.ts';

const GUARANTEE_MINIMUM_USDT = 1_000n * 10n ** 18n;

interface FundingActor {
  walletAddress: string;
  roles: readonly UserRole[];
  merchantId?: string;
}

interface TakeoverCaseRow {
  case_id: string;
  order_id: string;
  merchant_id: string;
  policy_version: string | number;
  state: string;
  required_usdt: string | null;
  evidence_hash: string;
  settlement_wallet: string;
}

interface AvailableReceivableRow {
  order_id: string;
  account_id: string;
  backing_wallet_address: string;
  amount: string;
}

export interface TakeoverFundingApprovalInput {
  action: string;
  resourceType: string;
  resourceId: string;
  policyVersion: string;
  oldValueHash: string;
  newValueHash: string;
  executorWallet: string;
  nonce: string;
  deadline: string;
  signature: string;
}

export class TakeoverFundingService {
  readonly #transactions: SqlTransactionRunner;
  readonly #secondarySigner: string | undefined;
  readonly #governanceWallet: string | undefined;
  readonly #verifyingContract: string | undefined;
  readonly #auditReady: () => boolean | Promise<boolean>;
  readonly #clock: () => Date;
  readonly #mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    secondarySigner?: string;
    governanceWallet?: string;
    verifyingContract?: string;
    auditReady?: () => boolean | Promise<boolean>;
    clock?: () => Date;
    mainnetMicrotestEntitlement?: MainnetMicrotestEntitlement;
  }) {
    this.#transactions = input.transactions;
    this.#secondarySigner = input.secondarySigner
      ? normalizedAddress(input.secondarySigner, 'takeover secondary signer')
      : undefined;
    this.#governanceWallet = input.governanceWallet
      ? normalizedAddress(input.governanceWallet, 'takeover governance wallet')
      : undefined;
    this.#verifyingContract = input.verifyingContract
      ? normalizedAddress(input.verifyingContract, 'takeover verifying contract')
      : undefined;
    this.#auditReady = input.auditReady ?? (() => false);
    this.#clock = input.clock ?? (() => new Date());
    this.#mainnetMicrotestEntitlement = input.mainnetMicrotestEntitlement;
  }

  fundingApprovalChallenge(
    actor: FundingActor,
    input: {
      caseId: string;
      requiredUsdt: string;
      operationsWalletAddress: string;
      nonce: string;
      deadline: string;
    },
  ) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'ARBITRATOR');
    const wallet = normalizedAddress(actor.walletAddress, 'funding actor');
    const governance = this.governanceDependencies();
    validateFundingRequest(input);
    const nonce = unsignedBigInt(input.nonce, 'takeover funding nonce');
    const deadline = unsignedBigInt(input.deadline, 'takeover funding deadline');
    if (deadline <= BigInt(Math.floor(this.#clock().getTime() / 1_000))) {
      throw new CoreError('NonceExpired', 'Takeover funding approval deadline has expired', 401);
    }
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR', 'ARBITRATOR']);
      const plan = await buildFundingPlan(executor, input, false);
      const intent: SensitiveActionIntent = {
        action: 'FUND_TAKEOVER',
        resourceType: 'TAKEOVER_CASE',
        resourceId: plan.takeover.case_id,
        policyVersion: BigInt(plan.takeover.policy_version),
        oldValueHash: plan.oldValueHash,
        newValueHash: plan.newValueHash,
        executorWallet: governance.governanceWallet,
        nonce,
        deadline,
      };
      return {
        plan: fundingPlanProjection(plan),
        typedData: {
          domain: sensitiveActionDomain(governance.verifyingContract),
          types: sensitiveActionTypes,
          primaryType: 'SensitiveAction',
          message: serializeSensitiveAction(intent),
        },
      };
    });
  }

  async fundTakeover(
    actor: FundingActor,
    input: {
      caseId: string;
      requiredUsdt: string;
      operationsWalletAddress: string;
      idempotencyKey: string;
      correlationId: string;
      approval: TakeoverFundingApprovalInput;
    },
  ) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'ARBITRATOR');
    const wallet = normalizedAddress(actor.walletAddress, 'funding actor');
    const governance = this.governanceDependencies();
    validateFundingRequest(input);
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)) {
      throw new CoreError('InvalidRequest', 'Takeover funding idempotency key is invalid');
    }
    if (!input.correlationId || input.correlationId.length > 128) {
      throw new CoreError('InvalidRequest', 'Takeover funding correlation ID is invalid');
    }
    if (!await this.#auditReady()) {
      throw new CoreError('ExternalBlocked', 'Audit database is unavailable for takeover funding', 503);
    }
    const intent = fundingApprovalIntent(input.approval);
    const requestHash = hashJson({ wallet, ...input });
    const prepared = await this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR', 'ARBITRATOR']);
      const existing = await executor.query<{ request_hash: string; result: Record<string, unknown> }>(
        `SELECT request_hash, result FROM core.takeover_funding_commands
         WHERE actor_wallet = $1 AND idempotency_key = $2`,
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Takeover funding idempotency conflict', 409);
        }
        return { existing: existing.rows[0].result } as const;
      }
      const plan = await buildFundingPlan(executor, input, false);
      assertFundingApproval(intent, plan, governance.governanceWallet);
      const verified = verifySensitiveActionApproval(
        intent,
        input.approval.signature,
        governance.secondarySigner,
        governance.governanceWallet,
        governance.verifyingContract,
        this.#clock(),
      );
      const actionDigest = TypedDataEncoder.hash(
        sensitiveActionDomain(governance.verifyingContract),
        sensitiveActionTypes,
        intent,
      ).toLowerCase();
      return { plan, verified, actionDigest } as const;
    });
    if ('existing' in prepared) return prepared.existing;
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR', 'ARBITRATOR']);
      const existing = await executor.query<{ request_hash: string; result: Record<string, unknown> }>(
        `SELECT request_hash, result FROM core.takeover_funding_commands
         WHERE actor_wallet = $1 AND idempotency_key = $2`,
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Takeover funding idempotency conflict', 409);
        }
        return existing.rows[0].result;
      }
      const plan = await buildFundingPlan(executor, input, true);
      if (plan.oldValueHash !== prepared.plan.oldValueHash || plan.newValueHash !== prepared.plan.newValueHash) {
        throw new CoreError('IdempotencyConflict', 'Takeover funding sources changed during approval', 409);
      }
      const replay = await executor.query<{ command_id: string }>(
        `SELECT command_id FROM core.takeover_funding_commands
         WHERE action_digest = $1 OR (secondary_signer = $2 AND approval_nonce = $3) LIMIT 1`,
        [prepared.actionDigest, prepared.verified.signer, intent.nonce.toString()],
      );
      if (replay.rows[0]) throw new CoreError('NonceReplay', 'Takeover funding approval was already consumed', 401);
      const fundingEvidenceHash = hashJson({
        actionDigest: prepared.actionDigest,
        approvalSignatureHash: keccak256(input.approval.signature).toLowerCase(),
      });
      await applyFundingPlan(executor, plan, fundingEvidenceHash);
      const now = this.#clock();
      const result = {
        caseId: plan.takeover.case_id,
        state: 'FUNDED',
        requiredUsdt: input.requiredUsdt,
        guaranteeUsedUsdt: plan.guaranteeUsed.toString(),
        frozenReceivablesUsedUsdt: plan.selected.total.toString(),
        futureProceedsUsedUsdt: '0',
        platformAdvanceUsdt: plan.platformAdvance.toString(),
        merchantDebtUsdt: plan.platformAdvance.toString(),
      };
      await executor.query(
        `UPDATE core.takeover_cases SET state = 'FUNDED', required_usdt = $2,
           guarantee_used_usdt = $3, merchant_available_used_usdt = $4,
           future_proceeds_used_usdt = 0, platform_advance_usdt = $5,
           platform_advance_wallet_address = CASE WHEN $5::numeric > 0 THEN $6 ELSE NULL END,
           merchant_debt_usdt = $5, updated_at = $7 WHERE case_id = $1`,
        [
          plan.takeover.case_id,
          input.requiredUsdt,
          plan.guaranteeUsed.toString(),
          plan.selected.total.toString(),
          plan.platformAdvance.toString(),
          plan.operationsWallet,
          now,
        ],
      );
      await executor.query(
        `INSERT INTO core.takeover_case_transitions (
           transition_id, case_id, order_id, from_state, to_state,
           public_evidence_type, public_evidence_hash, occurred_at
         ) VALUES ($1,$2,$3,$4,'FUNDED','FUNDING_APPROVED',$5,$6)`,
        [
          `takeover-transition:${randomUUID()}`,
          plan.takeover.case_id,
          plan.takeover.order_id,
          plan.takeover.state,
          fundingEvidenceHash,
          now,
        ],
      );
      await executor.query(
        `INSERT INTO core.takeover_funding_commands (
           command_id, case_id, actor_wallet, idempotency_key, request_hash,
           evidence_hash, policy_version, old_value_hash, new_value_hash,
           action_digest, secondary_signer, secondary_signature_hash,
           approval_nonce, approval_deadline, governance_wallet_address,
           approval_signature_hash, approval_evidence_hash,
           correlation_id, result, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          `takeover-funding-command:${randomUUID()}`,
          plan.takeover.case_id,
          wallet,
          input.idempotencyKey,
          requestHash,
          fundingEvidenceHash,
          Number(plan.takeover.policy_version),
          plan.oldValueHash,
          plan.newValueHash,
          prepared.actionDigest,
          prepared.verified.signer,
          keccak256(input.approval.signature).toLowerCase(),
          intent.nonce.toString(),
          new Date(Number(intent.deadline) * 1_000),
          governance.governanceWallet,
          keccak256(input.approval.signature).toLowerCase(),
          prepared.actionDigest,
          input.correlationId,
          JSON.stringify(result),
          now,
        ],
      );
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload,
           idempotency_key, state
         ) VALUES ($1,'TAKEOVER_CASE',$2,'TakeoverFundingPrepared',$3,$1,'PENDING')`,
        [`outbox:takeover-funding:${plan.takeover.case_id}`, plan.takeover.case_id, JSON.stringify(result)],
      );
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:takeover-funding', {
          caseId: plan.takeover.case_id,
          actionDigest: prepared.actionDigest,
        }),
        streamName: 'financial',
        evidenceProfile: 'SIGNED_OFFCHAIN',
        eventType: 'TakeoverFundingApproved',
        resourceType: 'TAKEOVER_CASE',
        resourceId: plan.takeover.case_id,
        merchantId: plan.takeover.merchant_id,
        actorWallet: wallet,
        actorRole: roles[0]!,
        correlationId: input.correlationId,
        requestHash: requestHash.slice(2),
        payload: {
          orderId: plan.takeover.order_id,
          policyVersion: Number(plan.takeover.policy_version),
          oldValueHash: plan.oldValueHash,
          newValueHash: plan.newValueHash,
          actionDigest: prepared.actionDigest,
          governanceWallet: governance.governanceWallet,
          operationsWallet: plan.operationsWallet,
          approvalEvidenceHash: prepared.actionDigest,
          result,
        },
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash: keccak256(input.approval.signature).toLowerCase(),
          signer: prepared.verified.signer,
          digest: prepared.actionDigest,
          domain: `Abu24KV2Core:2:56:${governance.verifyingContract}`,
          nonce: intent.nonce.toString(),
          deadline: intent.deadline.toString(),
        },
        createdAt: now,
      });
      return result;
    });
  }

  private governanceDependencies() {
    if (!this.#secondarySigner || !this.#governanceWallet || !this.#verifyingContract) {
      throw new CoreError('ExternalBlocked', 'Takeover funding governance is unavailable', 503);
    }
    return {
      secondarySigner: this.#secondarySigner,
      governanceWallet: this.#governanceWallet,
      verifyingContract: this.#verifyingContract,
    };
  }

  getMerchantFinance(actor: FundingActor, merchantId?: string) {
    const wallet = normalizedAddress(actor.walletAddress, 'finance actor');
    return this.#transactions.transaction(async (executor) => {
      let targetMerchantId = merchantId ?? actor.merchantId;
      let resolvedByWallet = false;
      if (!targetMerchantId && actor.roles.includes('MERCHANT')) {
        const merchant = await executor.query<{ merchant_id: string }>(
          'SELECT merchant_id FROM core.merchants WHERE settlement_wallet = $1',
          [wallet],
        );
        targetMerchantId = merchant.rows[0]?.merchant_id;
        resolvedByWallet = Boolean(targetMerchantId);
      }
      if (!targetMerchantId) throw new CoreError('InvalidRequest', 'Merchant identity is required', 400);
      const platform = actor.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR', 'ARBITRATOR'].includes(role));
      if (
        !platform
        && (!actor.roles.includes('MERCHANT') || (!resolvedByWallet && actor.merchantId !== targetMerchantId))
      ) {
        throw new CoreError('Forbidden', 'Merchant finance is outside the wallet scope', 403);
      }
      const [merchant, guarantee, deposits, debt, takeovers] = await Promise.all([
        executor.query<{
          merchant_id: string;
          status: string;
          guarantee_status: string;
          settlement_wallet: string;
        }>(
          `SELECT merchant_id, status, guarantee_status, settlement_wallet
           FROM core.merchants WHERE merchant_id = $1`,
          [targetMerchantId],
        ),
        executor.query<Record<string, unknown>>(
          `SELECT backing_wallet_address, balance_usdt::text, minimum_usdt::text,
             source_evidence_hash, updated_at
           FROM core.merchant_guarantees WHERE merchant_id = $1`,
          [targetMerchantId],
        ),
        executor.query<Record<string, unknown>>(
          `SELECT deposit_id, policy_version::text, token_address, operations_wallet_address,
             expected_amount_usdt::text, transaction_hash, state,
             observed_block_number::text, observed_block_hash, observed_log_index,
             confirmations, transfer_evidence_hash, created_at, updated_at, finalized_at
           FROM core.merchant_guarantee_deposit_submissions WHERE merchant_id = $1
           ORDER BY created_at DESC, deposit_id DESC`,
          [targetMerchantId],
        ),
        executor.query<Record<string, unknown>>(
          `SELECT incurred_usdt::text, recovered_usdt::text, outstanding_usdt::text,
             latest_evidence_hash, updated_at
           FROM core.merchant_debts WHERE merchant_id = $1`,
          [targetMerchantId],
        ),
        executor.query<Record<string, unknown>>(
          `SELECT case_id, order_id, state, required_usdt::text,
             guarantee_used_usdt::text, merchant_available_used_usdt::text,
             future_proceeds_used_usdt::text, platform_advance_usdt::text,
             disbursed_usdt::text, merchant_debt_usdt::text, evidence_hash,
             opened_at, closed_at, updated_at
           FROM core.takeover_cases WHERE merchant_id = $1
           ORDER BY opened_at DESC, case_id DESC`,
          [targetMerchantId],
        ),
      ]);
      if (!merchant.rows[0]) throw new CoreError('InvalidRequest', 'Merchant not found', 404);
      const merchantRow = merchant.rows[0];
      const guaranteeRow = guarantee.rows[0] as {
        balance_usdt?: string;
        source_evidence_hash?: string;
      } | undefined;
      const microtestEligible = merchantRow.status === 'APPROVED'
        && merchantRow.settlement_wallet.toLowerCase() === this.#mainnetMicrotestEntitlement?.merchantWallet
        && BigInt(guaranteeRow?.balance_usdt ?? '0') > 0n
        && /^0x[0-9a-fA-F]{64}$/.test(guaranteeRow?.source_evidence_hash ?? '')
        && guaranteeRow?.source_evidence_hash?.toLowerCase() === this.#mainnetMicrotestEntitlement?.evidenceHash
        && isMicrotestMerchantProduct(
          this.#mainnetMicrotestEntitlement,
          merchantRow.merchant_id,
          this.#mainnetMicrotestEntitlement?.productId ?? '',
          this.#clock(),
        );
      const formalEligible = merchantRow.status === 'APPROVED' && merchantRow.guarantee_status === 'READY';
      return {
        merchant: merchantRow,
        guarantee: guarantee.rows[0] ?? null,
        guaranteeDeposits: deposits.rows,
        debt: debt.rows[0] ?? null,
        takeovers: takeovers.rows,
        allowedActions: formalEligible || microtestEligible ? ['REQUEST_MERCHANT_USDT'] : [],
        settlementEligibility: formalEligible
          ? { mode: 'FORMAL', expiresAt: null }
          : microtestEligible
            ? { mode: 'MAINNET_MICROTEST', expiresAt: this.#mainnetMicrotestEntitlement!.expiresAt.toISOString() }
            : { mode: 'BLOCKED', expiresAt: null },
      };
    });
  }

  getTakeoverFunding(actor: FundingActor, caseId: string) {
    const wallet = normalizedAddress(actor.walletAddress, 'finance actor');
    return this.#transactions.transaction(async (executor) => {
      const takeover = await executor.query<{
        case_id: string;
        merchant_id: string;
        settlement_wallet: string;
      }>(
        `SELECT takeover.case_id, takeover.merchant_id, merchant.settlement_wallet
         FROM core.takeover_cases takeover
         JOIN core.merchants merchant ON merchant.merchant_id = takeover.merchant_id
         WHERE takeover.case_id = $1`,
        [caseId],
      );
      const row = takeover.rows[0];
      if (!row) throw new CoreError('InvalidRequest', 'Takeover case not found', 404);
      const platform = actor.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR', 'ARBITRATOR'].includes(role));
      if (!platform && (!actor.roles.includes('MERCHANT') || row.settlement_wallet !== wallet)) {
        throw new CoreError('Forbidden', 'Takeover funding is outside the wallet scope', 403);
      }
      const [projection, items, recoveries] = await Promise.all([
        fundingProjection(executor, caseId),
        executor.query<Record<string, unknown>>(
          `SELECT source_type, amount_usdt::text, journal_id, evidence_hash, created_at
           FROM core.takeover_funding_items WHERE case_id = $1
           ORDER BY created_at, funding_item_id`,
          [caseId],
        ),
        executor.query<Record<string, unknown>>(
          `SELECT recovery_id, order_id, amount_usdt::text, operations_wallet_address,
             backing_wallet_address, journal_id, evidence_hash,
             recovered_at, reversed_at, reversal_evidence_hash
           FROM core.merchant_debt_recoveries WHERE case_id = $1
           ORDER BY recovered_at, recovery_id`,
          [caseId],
        ),
      ]);
      return { ...projection, items: items.rows, debtRecoveries: recoveries.rows };
    });
  }
}

interface FundingPlan {
  takeover: TakeoverCaseRow;
  operationsWallet: string;
  requiredUsdt: bigint;
  guarantee: { backing_wallet_address: string; balance_usdt: string } | undefined;
  guaranteeUsed: bigint;
  available: AvailableReceivableRow[];
  selected: ReturnType<typeof selectReceivables>;
  platformAdvance: bigint;
  oldValueHash: string;
  newValueHash: string;
}

async function buildFundingPlan(
  executor: SqlExecutor,
  input: { caseId: string; requiredUsdt: string; operationsWalletAddress: string },
  forUpdate: boolean,
): Promise<FundingPlan> {
  const operationsWallet = normalizedAddress(input.operationsWalletAddress, 'operations wallet');
  const takeover = await executor.query<TakeoverCaseRow>(
    `SELECT takeover.case_id, takeover.order_id, takeover.merchant_id, takeover.policy_version,
       takeover.state, takeover.required_usdt::text, takeover.evidence_hash,
       merchant.settlement_wallet
     FROM core.takeover_cases takeover
     JOIN core.merchants merchant ON merchant.merchant_id = takeover.merchant_id
     WHERE takeover.case_id = $1${forUpdate ? ' FOR UPDATE OF takeover, merchant' : ''}`,
    [input.caseId],
  );
  const row = takeover.rows[0];
  if (!row) throw new CoreError('InvalidRequest', 'Takeover case not found', 404);
  if (row.state !== 'OPEN' || row.required_usdt !== null) {
    throw new CoreError('UnknownState', 'Takeover case cannot be funded from its current state', 409);
  }
  const guarantee = await executor.query<{
    backing_wallet_address: string;
    balance_usdt: string;
  }>(
    `SELECT backing_wallet_address, balance_usdt::text FROM core.merchant_guarantees
     WHERE merchant_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM core.merchant_guarantee_reorg_exposures exposure
         WHERE exposure.merchant_id = core.merchant_guarantees.merchant_id
           AND exposure.state = 'OPEN'
       )${forUpdate ? ' FOR UPDATE' : ''}`,
    [row.merchant_id],
  );
  const requiredUsdt = BigInt(input.requiredUsdt);
  const guaranteeUsed = guarantee.rows[0]
    ? minimum(requiredUsdt, BigInt(guarantee.rows[0].balance_usdt))
    : 0n;
  const afterGuarantee = requiredUsdt - guaranteeUsed;
  const available = afterGuarantee > 0n
    ? await availableReceivables(executor, row.settlement_wallet, forUpdate)
    : [];
  const selected = selectReceivables(available, afterGuarantee);
  const platformAdvance = afterGuarantee - selected.total;
  const oldValueHash = hashJson({
    caseId: row.case_id,
    orderId: row.order_id,
    policyVersion: Number(row.policy_version),
    state: row.state,
    requiredUsdt: row.required_usdt,
    takeoverEvidenceHash: row.evidence_hash,
    guarantee: guarantee.rows[0] ?? null,
    availableReceivables: available,
  });
  const newValueHash = hashJson({
    caseId: row.case_id,
    orderId: row.order_id,
    policyVersion: Number(row.policy_version),
    requiredUsdt: input.requiredUsdt,
    operationsWallet,
    guaranteeUsedUsdt: guaranteeUsed.toString(),
    receivables: selected.items.map((item) => ({
      orderId: item.order_id,
      accountId: item.account_id,
      backingWalletAddress: item.backing_wallet_address,
      amount: item.selectedAmount,
    })),
    platformAdvanceUsdt: platformAdvance.toString(),
  });
  return {
    takeover: row,
    operationsWallet,
    requiredUsdt,
    guarantee: guarantee.rows[0],
    guaranteeUsed,
    available,
    selected,
    platformAdvance,
    oldValueHash,
    newValueHash,
  };
}

async function applyFundingPlan(executor: SqlExecutor, plan: FundingPlan, evidenceHash: string) {
  if (plan.guaranteeUsed > 0n) {
    if (!plan.guarantee) throw new CoreError('InvalidFinality', 'Takeover guarantee source disappeared', 409);
    await fundFromGuarantee(executor, plan.takeover, plan.guarantee, plan.guaranteeUsed, evidenceHash);
  }
  if (plan.selected.total > 0n) {
    await fundFromReceivables(executor, plan.takeover, plan.selected.items, evidenceHash);
  }
  if (plan.platformAdvance > 0n) {
    await fundPlatformAdvance(executor, plan.takeover, plan.operationsWallet, plan.platformAdvance, evidenceHash);
  }
  if (plan.guaranteeUsed + plan.selected.total + plan.platformAdvance !== plan.requiredUsdt) {
    throw new CoreError('InvalidFinality', 'Takeover funding plan does not conserve USDT', 409);
  }
}

function fundingPlanProjection(plan: FundingPlan) {
  return {
    caseId: plan.takeover.case_id,
    orderId: plan.takeover.order_id,
    policyVersion: Number(plan.takeover.policy_version),
    requiredUsdt: plan.requiredUsdt.toString(),
    operationsWallet: plan.operationsWallet,
    guaranteeUsedUsdt: plan.guaranteeUsed.toString(),
    receivables: plan.selected.items.map((item) => ({
      orderId: item.order_id,
      accountId: item.account_id,
      backingWalletAddress: item.backing_wallet_address,
      amount: item.selectedAmount,
    })),
    frozenReceivablesUsedUsdt: plan.selected.total.toString(),
    platformAdvanceUsdt: plan.platformAdvance.toString(),
    oldValueHash: plan.oldValueHash,
    newValueHash: plan.newValueHash,
  };
}

function validateFundingRequest(input: { caseId: string; requiredUsdt: string; operationsWalletAddress: string }) {
  if (!input.caseId || !/^[1-9][0-9]*$/.test(input.requiredUsdt)) {
    throw new CoreError('InvalidRequest', 'Takeover funding request is invalid');
  }
  normalizedAddress(input.operationsWalletAddress, 'operations wallet');
}

function fundingApprovalIntent(input: TakeoverFundingApprovalInput): SensitiveActionIntent {
  if (!input || typeof input.signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(input.signature)) {
    throw new CoreError('InvalidRequest', 'Takeover funding signature is invalid');
  }
  return {
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    policyVersion: unsignedBigInt(input.policyVersion, 'takeover funding policy version'),
    oldValueHash: requiredHash(input.oldValueHash, 'takeover funding old value hash'),
    newValueHash: requiredHash(input.newValueHash, 'takeover funding new value hash'),
    executorWallet: normalizedAddress(input.executorWallet, 'takeover funding governance wallet'),
    nonce: unsignedBigInt(input.nonce, 'takeover funding nonce'),
    deadline: unsignedBigInt(input.deadline, 'takeover funding deadline'),
  };
}

function assertFundingApproval(intent: SensitiveActionIntent, plan: FundingPlan, governanceWallet: string) {
  if (
    intent.action !== 'FUND_TAKEOVER'
    || intent.resourceType !== 'TAKEOVER_CASE'
    || intent.resourceId !== plan.takeover.case_id
    || intent.policyVersion !== BigInt(plan.takeover.policy_version)
    || intent.oldValueHash.toLowerCase() !== plan.oldValueHash
    || intent.newValueHash.toLowerCase() !== plan.newValueHash
    || normalizedAddress(intent.executorWallet, 'takeover funding governance wallet') !== governanceWallet
  ) throw new CoreError('InvalidSignature', 'Takeover funding approval does not match the exact funding plan', 401);
}

function serializeSensitiveAction(intent: SensitiveActionIntent) {
  return {
    ...intent,
    policyVersion: intent.policyVersion.toString(),
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
  };
}

async function requireCurrentRole(executor: SqlExecutor, wallet: string, allowed: readonly UserRole[]) {
  const result = await executor.query<{ role: UserRole }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[]) ORDER BY role`,
    [wallet, [...allowed]],
  );
  if (result.rows.length === 0) throw new CoreError('Forbidden', 'Current wallet role cannot fund takeover', 403);
  return result.rows.map((row) => row.role);
}

export async function captureMerchantFutureProceeds(
  executor: SqlExecutor,
  input: {
    orderId: string;
    merchantId: string;
    evidenceHash: string;
    correlationId: string;
    capturedAt: Date;
  },
) {
  if (!isHash(input.evidenceHash)) throw new CoreError('InvalidFinality', 'Debt-capture evidence is invalid', 409);
  const existing = await executor.query<{ journal_id: string }>(
    `SELECT journal_id FROM core.ledger_journals
     WHERE event_key = $1`,
    [`future-proceeds:${input.orderId}`],
  );
  if (existing.rows[0]) return { capturedUsdt: '0', idempotent: true };
  const debt = await executor.query<{ outstanding_usdt: string }>(
    `SELECT outstanding_usdt::text FROM core.merchant_debts
     WHERE merchant_id = $1 FOR UPDATE`,
    [input.merchantId],
  );
  const outstanding = BigInt(debt.rows[0]?.outstanding_usdt ?? '0');
  if (outstanding === 0n) return { capturedUsdt: '0', idempotent: false };
  const order = await executor.query<{
    policy_version: string | number;
    merchant_wallet: string;
  }>(
    `SELECT orders.policy_version, orders.merchant_wallet
     FROM core.orders orders
     WHERE orders.order_id = $1 AND orders.merchant_id = $2 FOR UPDATE OF orders`,
    [input.orderId, input.merchantId],
  );
  const orderRow = order.rows[0];
  if (!orderRow) throw new CoreError('InvalidFinality', 'Debt-capture order is unavailable', 409);
  const available = await executor.query<{
    account_id: string;
    backing_wallet_address: string;
    amount: string;
  }>(
    `SELECT line.account_id, line.backing_wallet_address,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_lines line
     JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND account.owner_id = $2
       AND account.purpose IN ('MERCHANT_RECEIVABLE','MERCHANT_FREIGHT_RECEIVABLE')
       AND account.asset = 'USDT'
       AND line.balance_state = 'AVAILABLE' AND line.backing_wallet_address IS NOT NULL
     GROUP BY line.account_id, line.backing_wallet_address
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY line.account_id`,
    [input.orderId, orderRow.merchant_wallet],
  );
  const sources = available.rows;
  if (sources.length === 0) return { capturedUsdt: '0', idempotent: false };
  const backingWallet = sources[0]!.backing_wallet_address;
  if (sources.some((source) => source.backing_wallet_address !== backingWallet)) {
    throw new CoreError('InvalidFinality', 'Merchant proceeds span different settlement wallets', 409);
  }
  const captured = minimum(outstanding, sources.reduce((sum, source) => sum + BigInt(source.amount), 0n));
  let sourceRemaining = captured;
  const sourceDebits: Array<{ accountId: string; amount: string }> = [];
  for (const source of sources) {
    if (sourceRemaining === 0n) break;
    const amount = minimum(sourceRemaining, BigInt(source.amount));
    sourceDebits.push({ accountId: source.account_id, amount: amount.toString() });
    sourceRemaining -= amount;
  }
  const cases = await executor.query<{
    case_id: string;
    platform_advance_wallet_address: string;
    remaining: string;
  }>(
    `SELECT takeover.case_id, takeover.platform_advance_wallet_address,
       (takeover.merchant_debt_usdt - COALESCE(sum(recovery.amount_usdt)
         FILTER (WHERE recovery.reversed_at IS NULL), 0))::text AS remaining
     FROM core.takeover_cases takeover
     LEFT JOIN core.merchant_debt_recoveries recovery ON recovery.case_id = takeover.case_id
     WHERE takeover.merchant_id = $1 AND takeover.merchant_debt_usdt > 0
       AND takeover.platform_advance_wallet_address IS NOT NULL
     GROUP BY takeover.case_id, takeover.merchant_debt_usdt,
       takeover.platform_advance_wallet_address, takeover.opened_at
     HAVING takeover.merchant_debt_usdt - COALESCE(sum(recovery.amount_usdt)
       FILTER (WHERE recovery.reversed_at IS NULL), 0) > 0
     ORDER BY takeover.opened_at, takeover.case_id`,
    [input.merchantId],
  );
  let remaining = captured;
  const allocations: Array<{
    recoveryId: string;
    caseId: string;
    operationsWallet: string;
    reimbursementAccount: string;
    amount: string;
  }> = [];
  for (const debtCase of cases.rows) {
    if (remaining === 0n) break;
    const amount = minimum(remaining, BigInt(debtCase.remaining));
    const operationsWallet = normalizedAddress(
      debtCase.platform_advance_wallet_address,
      'frozen operations wallet',
    );
    allocations.push({
      recoveryId: `debt-recovery:${randomUUID()}`,
      caseId: debtCase.case_id,
      operationsWallet,
      reimbursementAccount: `operations-reimbursement:${operationsWallet}:usdt`,
      amount: amount.toString(),
    });
    remaining -= amount;
  }
  if (remaining !== 0n) throw new CoreError('InvalidFinality', 'Merchant debt cases do not conserve recovery', 409);
  for (const allocation of allocations) {
    await ensureAccount(executor, {
      accountId: allocation.reimbursementAccount,
      ownerType: 'BENEFICIARY',
      ownerId: allocation.operationsWallet,
      purpose: 'OPERATIONS_REIMBURSEMENT',
    });
  }
  await lockAccounts(executor, [
    ...sourceDebits.map((source) => source.accountId),
    ...allocations.map((allocation) => allocation.reimbursementAccount),
  ]);
  const lines: LedgerLine[] = [
    ...sourceDebits.map((source) => ({
      account_id: source.accountId,
      side: 'DEBIT',
      amount: source.amount,
      balance_state: 'AVAILABLE',
      backing_wallet_address: backingWallet,
    } as const)),
    ...allocations.map((allocation) => ({
      account_id: allocation.reimbursementAccount,
      side: 'CREDIT',
      amount: allocation.amount,
      balance_state: 'AVAILABLE',
      backing_wallet_address: backingWallet,
    })),
  ];
  const journalId = `journal:future-proceeds:${input.orderId}`;
  await postResourceJournal(executor, {
    journalId,
    eventKey: `future-proceeds:${input.orderId}`,
    eventType: 'FUTURE_PROCEEDS_CAPTURED',
    resourceType: 'MERCHANT_DEBT',
    resourceId: input.merchantId,
    orderId: input.orderId,
    policyVersion: Number(orderRow.policy_version),
    contentHash: hashJson({ input, allocations, captured: captured.toString(), lines }),
    sourceTxHash: null,
    sourceBlockHash: null,
    sourceKind: 'FULFILLMENT_EVIDENCE',
    sourceReferenceHash: input.evidenceHash,
    payload: {
      orderId: input.orderId,
      merchantId: input.merchantId,
      recipients: allocations.map((allocation) => ({
        recoveryId: allocation.recoveryId,
        caseId: allocation.caseId,
        operationsWallet: allocation.operationsWallet,
        amount: allocation.amount,
      })),
    },
    lines,
  });
  await executor.query(
    `UPDATE core.merchant_debts SET recovered_usdt = recovered_usdt + $2,
       outstanding_usdt = outstanding_usdt - $2, latest_evidence_hash = $3,
       updated_at = $4 WHERE merchant_id = $1`,
    [input.merchantId, captured.toString(), input.evidenceHash, input.capturedAt],
  );
  for (const allocation of allocations) {
    await executor.query(
      `INSERT INTO core.merchant_debt_recoveries (
         recovery_id, merchant_id, case_id, order_id, amount_usdt,
         operations_wallet_address, backing_wallet_address,
         journal_id, evidence_hash, recovered_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        allocation.recoveryId,
        input.merchantId,
        allocation.caseId,
        input.orderId,
        allocation.amount,
        allocation.operationsWallet,
        backingWallet,
        journalId,
        input.evidenceHash,
        input.capturedAt,
      ],
    );
  }
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload,
       idempotency_key, state
     ) VALUES ($1,'MERCHANT_DEBT',$2,'FutureProceedsCaptured',$3,$1,'PENDING')`,
    [
      `outbox:future-proceeds:${input.orderId}`,
      input.merchantId,
      JSON.stringify({
        orderId: input.orderId,
        capturedUsdt: captured.toString(),
        recipients: allocations.map((allocation) => allocation.operationsWallet),
      }),
    ],
  );
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:future-proceeds', {
      orderId: input.orderId,
      merchantId: input.merchantId,
      journalId,
      evidenceHash: input.evidenceHash,
    }),
    streamName: 'financial',
    evidenceProfile: 'SYSTEM',
    eventType: 'MerchantFutureProceedsCaptured',
    resourceType: 'MERCHANT_DEBT',
    resourceId: input.merchantId,
    merchantId: input.merchantId,
    correlationId: input.correlationId,
    requestHash: input.evidenceHash.slice(2),
    payload: {
      orderId: input.orderId,
      journalId,
      capturedUsdt: captured.toString(),
      evidenceHash: input.evidenceHash,
      recoveries: allocations.map((allocation) => ({
        recoveryId: allocation.recoveryId,
        caseId: allocation.caseId,
        operationsWallet: allocation.operationsWallet,
        amount: allocation.amount,
      })),
    },
    createdAt: input.capturedAt,
  });
  return { capturedUsdt: captured.toString(), idempotent: false };
}

async function fundFromGuarantee(
  executor: SqlExecutor,
  takeover: TakeoverCaseRow,
  guarantee: { backing_wallet_address: string; balance_usdt: string },
  amount: bigint,
  evidenceHash: string,
) {
  const source = `guarantee:${takeover.merchant_id}:${guarantee.backing_wallet_address}:usdt`;
  const target = await ensureTakeoverPayable(executor, takeover.case_id, guarantee.backing_wallet_address);
  await lockAccounts(executor, [source, target]);
  const lines = moveBetweenAccounts(source, target, amount, guarantee.backing_wallet_address);
  const journalId = `journal:takeover:${takeover.case_id}:guarantee`;
  await postResourceJournal(executor, fundingJournal(
    takeover,
    journalId,
    'GUARANTEE_DEDUCTED',
    evidenceHash,
    lines,
    { sourceType: 'GUARANTEE' },
  ));
  await executor.query(
    `UPDATE core.merchant_guarantees SET balance_usdt = balance_usdt - $2,
       source_evidence_hash = $3, updated_at = clock_timestamp() WHERE merchant_id = $1`,
    [takeover.merchant_id, amount.toString(), evidenceHash],
  );
  await insertFundingItem(executor, takeover.case_id, 'GUARANTEE', amount, journalId, evidenceHash);
}

async function fundFromReceivables(
  executor: SqlExecutor,
  takeover: TakeoverCaseRow,
  items: Array<AvailableReceivableRow & { selectedAmount: string }>,
  evidenceHash: string,
) {
  const byWallet = new Map<string, Array<AvailableReceivableRow & { selectedAmount: string }>>();
  for (const item of items) {
    byWallet.set(item.backing_wallet_address, [...(byWallet.get(item.backing_wallet_address) ?? []), item]);
  }
  let groupIndex = 0;
  for (const [wallet, group] of byWallet) {
    const target = await ensureTakeoverPayable(executor, takeover.case_id, wallet);
    await lockAccounts(executor, [...group.map((item) => item.account_id), target]);
    const total = group.reduce((sum, item) => sum + BigInt(item.selectedAmount), 0n);
    const lines = [
      ...group.map((item) => ({
        account_id: item.account_id,
        side: 'DEBIT',
        amount: item.selectedAmount,
        balance_state: 'AVAILABLE',
        backing_wallet_address: wallet,
      })),
      {
        account_id: target,
        side: 'CREDIT',
        amount: total.toString(),
        balance_state: 'AVAILABLE',
        backing_wallet_address: wallet,
      },
    ];
    const journalId = `journal:takeover:${takeover.case_id}:receivable:${groupIndex}`;
    await postResourceJournal(executor, fundingJournal(
      takeover,
      journalId,
      'TAKEOVER_FUNDED',
      evidenceHash,
      lines,
      { sourceType: 'FROZEN_RECEIVABLE', orders: group.map((item) => item.order_id) },
    ));
    await insertFundingItem(executor, takeover.case_id, 'FROZEN_RECEIVABLE', total, journalId, evidenceHash);
    groupIndex += 1;
  }
}

async function fundPlatformAdvance(
  executor: SqlExecutor,
  takeover: TakeoverCaseRow,
  operationsWallet: string,
  amount: bigint,
  evidenceHash: string,
) {
  const debtAccount = `merchant-debt:${takeover.merchant_id}:usdt`;
  const target = await ensureTakeoverPayable(executor, takeover.case_id, operationsWallet);
  await ensureAccount(executor, {
    accountId: debtAccount,
    ownerType: 'PLATFORM',
    ownerId: takeover.merchant_id,
    purpose: 'MERCHANT_DEBT_RECEIVABLE',
  });
  await lockAccounts(executor, [debtAccount, target]);
  const lines = [
    {
      account_id: debtAccount,
      side: 'DEBIT',
      amount: amount.toString(),
      balance_state: 'POSTED',
      backing_wallet_address: operationsWallet,
    },
    {
      account_id: target,
      side: 'CREDIT',
      amount: amount.toString(),
      balance_state: 'AVAILABLE',
      backing_wallet_address: operationsWallet,
    },
  ];
  const journalId = `journal:takeover:${takeover.case_id}:platform-advance`;
  await postResourceJournal(executor, fundingJournal(
    takeover,
    journalId,
    'MERCHANT_DEBT_CAPTURED',
    evidenceHash,
    lines,
    { sourceType: 'PLATFORM_ADVANCE', operationsWallet },
  ));
  await executor.query(
    `INSERT INTO core.merchant_debts (
       merchant_id, incurred_usdt, recovered_usdt, outstanding_usdt,
       latest_evidence_hash, updated_at
     ) VALUES ($1,$2,0,$2,$3,clock_timestamp())
     ON CONFLICT (merchant_id) DO UPDATE SET
       incurred_usdt = core.merchant_debts.incurred_usdt + EXCLUDED.incurred_usdt,
       outstanding_usdt = core.merchant_debts.outstanding_usdt + EXCLUDED.outstanding_usdt,
       latest_evidence_hash = EXCLUDED.latest_evidence_hash,
       updated_at = EXCLUDED.updated_at`,
    [takeover.merchant_id, amount.toString(), evidenceHash],
  );
  await insertFundingItem(executor, takeover.case_id, 'PLATFORM_ADVANCE', amount, journalId, evidenceHash);
}

async function ensureTakeoverPayable(executor: SqlExecutor, caseId: string, _executorWallet: string) {
  const accountId = `takeover:${caseId}:usdt`;
  await ensureAccount(executor, {
    accountId,
    ownerType: 'BENEFICIARY',
    ownerId: caseId,
    purpose: 'TAKEOVER_PAYABLE',
  });
  return accountId;
}

async function availableReceivables(executor: SqlExecutor, settlementWallet: string, forUpdate = false) {
  const query = () => executor.query<AvailableReceivableRow>(
    `SELECT journal.order_id, line.account_id, line.backing_wallet_address,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_lines line
     JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE account.owner_id = $1
       AND account.purpose IN ('MERCHANT_RECEIVABLE','MERCHANT_FREIGHT_RECEIVABLE')
       AND account.asset = 'USDT' AND line.balance_state = 'AVAILABLE'
       AND line.backing_wallet_address IS NOT NULL
     GROUP BY journal.order_id, line.account_id, line.backing_wallet_address
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY journal.order_id, line.account_id`,
    [settlementWallet],
  );
  let rows = (await query()).rows;
  if (forUpdate && rows.length > 0) {
    await lockAccounts(executor, rows.map((row) => row.account_id));
    rows = (await query()).rows;
  }
  return rows;
}

function selectReceivables(rows: AvailableReceivableRow[], maximum: bigint) {
  let remaining = maximum;
  const items: Array<AvailableReceivableRow & { selectedAmount: string }> = [];
  for (const row of rows) {
    if (remaining === 0n) break;
    const selected = minimum(remaining, BigInt(row.amount));
    items.push({ ...row, selectedAmount: selected.toString() });
    remaining -= selected;
  }
  return { items, total: maximum - remaining };
}

function fundingJournal(
  takeover: TakeoverCaseRow,
  journalId: string,
  eventType: 'GUARANTEE_DEDUCTED' | 'TAKEOVER_FUNDED' | 'MERCHANT_DEBT_CAPTURED',
  evidenceHash: string,
  lines: LedgerLine[],
  payload: Record<string, unknown>,
) {
  return {
    journalId,
    eventKey: journalId.replace('journal:', ''),
    eventType,
    resourceType: 'TAKEOVER_CASE' as const,
    resourceId: takeover.case_id,
    orderId: takeover.order_id,
    policyVersion: Number(takeover.policy_version),
    contentHash: hashJson({ caseId: takeover.case_id, eventType, evidenceHash, lines, payload }),
    sourceTxHash: null,
    sourceBlockHash: null,
    sourceKind: 'GOVERNED_EVIDENCE' as const,
    sourceReferenceHash: evidenceHash,
    payload,
    lines,
  };
}

interface LedgerLine {
  account_id: string;
  side: string;
  amount: string;
  balance_state: string;
  backing_wallet_address: string;
}

async function postResourceJournal(
  executor: SqlExecutor,
  input: {
    journalId: string;
    eventKey: string;
    eventType: string;
    resourceType: 'MERCHANT_GUARANTEE' | 'TAKEOVER_CASE' | 'MERCHANT_DEBT';
    resourceId: string;
    orderId?: string;
    policyVersion?: number;
    contentHash: string;
    sourceTxHash: string | null;
    sourceBlockHash: string | null;
    sourceKind: 'CHAIN_EVENT' | 'GOVERNED_EVIDENCE' | 'FULFILLMENT_EVIDENCE';
    sourceReferenceHash: string;
    payload: Record<string, unknown>;
    lines: LedgerLine[];
  },
) {
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14)',
    [
      input.journalId,
      input.eventKey,
      input.eventType,
      input.resourceType,
      input.resourceId,
      input.orderId ?? null,
      input.policyVersion ?? null,
      input.contentHash,
      input.sourceTxHash,
      input.sourceBlockHash,
      input.sourceKind,
      input.sourceReferenceHash,
      JSON.stringify(input.payload),
      JSON.stringify(input.lines),
    ],
  );
}

async function ensureAccount(
  executor: SqlExecutor,
  input: {
    accountId: string;
    ownerType: 'WALLET' | 'MERCHANT' | 'BENEFICIARY' | 'PLATFORM';
    ownerId: string;
    purpose:
      | 'WALLET_ASSET'
      | 'GUARANTEE_LIABILITY'
      | 'TAKEOVER_PAYABLE'
      | 'MERCHANT_DEBT_RECEIVABLE'
      | 'OPERATIONS_REIMBURSEMENT';
    executorWallet?: string;
  },
) {
  await executor.query(
    `INSERT INTO core.ledger_accounts (
       account_id, owner_type, owner_id, asset, purpose, wallet_address
     ) VALUES ($1,$2,$3,'USDT',$4,$5) ON CONFLICT (account_id) DO NOTHING`,
    [input.accountId, input.ownerType, input.ownerId, input.purpose, input.executorWallet ?? null],
  );
  const result = await executor.query<{
    owner_type: string;
    owner_id: string;
    purpose: string;
    wallet_address: string | null;
  }>(
    `SELECT owner_type, owner_id, purpose, wallet_address FROM core.ledger_accounts
     WHERE account_id = $1`,
    [input.accountId],
  );
  const row = result.rows[0];
  if (
    !row
    || row.owner_type !== input.ownerType
    || row.owner_id !== input.ownerId
    || row.purpose !== input.purpose
    || row.wallet_address !== (input.executorWallet ?? null)
  ) throw new CoreError('InvalidFinality', 'Funding ledger account identity mismatch', 409);
}

async function lockAccounts(executor: SqlExecutor, accountIds: string[]) {
  const ids = [...new Set(accountIds)].sort();
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
  const result = await executor.query<{ account_id: string }>(
    `SELECT account_id FROM core.ledger_accounts
     WHERE account_id IN (${placeholders}) ORDER BY account_id FOR UPDATE`,
    ids,
  );
  if (result.rows.length !== ids.length) throw new CoreError('InvalidFinality', 'Funding account is unavailable', 409);
}

function moveBetweenAccounts(source: string, target: string, amount: bigint, executorWallet: string): LedgerLine[] {
  return [
    {
      account_id: source,
      side: 'DEBIT',
      amount: amount.toString(),
      balance_state: 'AVAILABLE',
      backing_wallet_address: executorWallet,
    },
    {
      account_id: target,
      side: 'CREDIT',
      amount: amount.toString(),
      balance_state: 'AVAILABLE',
      backing_wallet_address: executorWallet,
    },
  ];
}

async function insertFundingItem(
  executor: SqlExecutor,
  caseId: string,
  sourceType: 'GUARANTEE' | 'FROZEN_RECEIVABLE' | 'PLATFORM_ADVANCE',
  amount: bigint,
  journalId: string,
  evidenceHash: string,
) {
  await executor.query(
    `INSERT INTO core.takeover_funding_items (
       funding_item_id, case_id, source_type, amount_usdt, journal_id,
       evidence_hash, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`,
    [`takeover-funding:${randomUUID()}`, caseId, sourceType, amount.toString(), journalId, evidenceHash],
  );
}

async function guaranteeProjection(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<{
    merchant_id: string;
    backing_wallet_address: string;
    balance_usdt: string;
    minimum_usdt: string;
    source_evidence_hash: string;
  }>(
    `SELECT merchant_id, backing_wallet_address, balance_usdt::text,
       minimum_usdt::text, source_evidence_hash
     FROM core.merchant_guarantees WHERE merchant_id = $1`,
    [merchantId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidFinality', 'Merchant guarantee projection is unavailable', 409);
  return result.rows[0];
}

async function fundingProjection(executor: SqlExecutor, caseId: string) {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT case_id, state, required_usdt::text, guarantee_used_usdt::text,
       merchant_available_used_usdt::text, future_proceeds_used_usdt::text,
       platform_advance_usdt::text, merchant_debt_usdt::text
     FROM core.takeover_cases WHERE case_id = $1`,
    [caseId],
  );
  return result.rows[0];
}

function assertRole(actor: FundingActor, ...roles: UserRole[]) {
  if (!roles.some((role) => actor.roles.includes(role))) {
    throw new CoreError('Forbidden', `${roles.join(' or ')} role is required`, 403);
  }
}

function minimum(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function normalizedAddress(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
}

function unsignedBigInt(value: string, name: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return BigInt(value);
}

function requiredHash(value: string, name: string) {
  if (!isHash(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return value.toLowerCase();
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
