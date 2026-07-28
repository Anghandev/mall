import { randomBytes } from 'node:crypto';
import { Interface, TypedDataEncoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  sensitiveActionTypes,
  verifySensitiveActionApproval,
  type SensitiveActionIntent,
} from '../api/auth.ts';
import {
  CORE_ARTIFACT_VERSION,
  NPL_ADDRESS,
  USDT_ADDRESS,
  settlementTransferStates,
  settlementRails,
  settlementRequestStates,
  type SettlementTransferState,
  type SettlementRail,
  type SettlementRequestState,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import {
  settlementIntentDigest,
  settlementItemHash,
  settlementItemsHash,
  settlementRequestId,
  settlementRequestDomain,
  settlementRequestTypes,
  verifySettlementRequestSignature,
  type SettlementRequestIntent,
} from '../api/settlement-signing.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import { isMerchantOperationallyEligible } from './merchant-eligibility.ts';
import { auditCorrelationId, auditSourceId, enqueueAudit } from './audit-service.ts';
import {
  type MainnetMicrotestEntitlement,
} from './mainnet-microtest-entitlement.ts';
import { lockSeckillPrizeFundingMutation } from './seckill-prize-service.ts';

const INTENT_TTL_SECONDS = 5 * 60;
const RUNTIME_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;
const ERC20_TRANSFER = new Interface(['function transfer(address recipient,uint256 amount) returns (bool)']);

interface AvailableSourceRow {
  order_id: string;
  account_id: string;
  backing_wallet_address: string;
  amount: string;
  created_at: Date;
  policy_version: string | number;
}

export type GovernedSettlementRail = Extract<
  SettlementRail,
  'TAKEOVER_USDT' | 'OPERATIONS_REIMBURSEMENT_USDT'
>;

export interface GovernedSettlementApprovalInput {
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

interface IntentRow {
  intent_id: string;
  artifact_version: string;
  wallet_address: string;
  merchant_id: string | null;
  recipient_address: string;
  rail: SettlementRail;
  asset: 'USDT' | 'NPL';
  asset_address: string;
  executor_wallet: string;
  amount: string;
  items_hash: string;
  intent_digest: string;
  nonce: string;
  deadline: Date;
  state: 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'CANCELLED';
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
}

interface IntentItemRow {
  item_index: number;
  order_id: string;
  account_id: string;
  backing_wallet_address: string;
  amount: string;
  item_hash: string;
  policy_version: string | number;
}

interface GovernedAvailableSourceRow {
  owner_id: string;
  backing_wallet_address: string;
  amount: string;
  policy_version: string | number;
  fulfillment_target_hash: string | null;
}

interface GovernedApprovalRow {
  rail: GovernedSettlementRail;
  resource_type: 'TAKEOVER_CASE' | 'MERCHANT_DEBT_RECOVERY';
  resource_id: string;
  takeover_case_id: string | null;
  debt_recovery_id: string | null;
  replacement_fulfillment_snapshot_id: string | null;
  action_digest: string;
  signer_address: string;
  action_deadline: Date;
  signature: string;
  action_payload: Omit<GovernedSettlementApprovalInput, 'signature'>;
}

interface TakeoverReplacementSnapshotRow {
  snapshot_id: string;
  assignment_id: string;
  case_id: string;
  order_id: string;
  recipient_address: string;
  fulfillment_target_hash: string;
  policy_version: string | number;
  snapshot_hash: string;
}

interface RequestedItemRow {
  request_id: string;
  request_item_index: number;
  order_id: string;
  account_id: string;
  recipient_address: string;
  amount: string;
  requested_at: Date;
  policy_version: string | number;
  merchant_id: string | null;
  rail: SettlementRail;
  merchant_guarantee_status: string | null;
}

interface RequestProjectionRow extends Record<string, unknown> {
  request_id: string;
  state: SettlementRequestState;
}

interface TransferProjectionRow extends Record<string, unknown> {
  transfer_id: string;
  state: string;
  amount: string;
  content_hash: string;
  execution_tx_hash: string | null;
}

interface AdminSettlementRequestRow {
  request_id: string;
  merchant_id: string | null;
  wallet_address: string;
  recipient_address: string;
  rail: SettlementRail;
  asset: 'USDT' | 'NPL';
  executor_wallet: string;
  amount: string;
  state: SettlementRequestState;
  transfer_ids: string[];
  final_execution_tx_hashes: string[];
  intent_digest: string;
  signature_hash: string;
  requested_at: Date | string;
  submitted_at: Date | string | null;
  settled_at: Date | string | null;
  item_count: string;
}

interface AdminSettlementRequestItemRow {
  item_index: number;
  order_id: string;
  account_id: string;
  backing_wallet_address: string;
  amount: string;
  item_hash: string;
  requested_journal_id: string;
  submitted_journal_id: string | null;
  settled_journal_id: string | null;
  policy_version: string;
}

interface AdminSettlementTransitionRow {
  transition_id: string;
  request_item_index: number;
  transfer_id: string | null;
  transition_sequence: number;
  transition_type: string;
  journal_id: string;
  created_at: Date | string;
}

interface AdminSettlementTransferRow {
  transfer_id: string;
  asset: 'USDT' | 'NPL';
  executor_wallet: string;
  executor_nonce: string;
  nonce_state: 'RESERVED' | 'BROADCAST' | 'RELEASED';
  nonce_release_evidence_hash: string | null;
  request_id: string;
  request_item_index: number;
  order_id: string;
  account_id: string;
  recipient_address: string;
  token_address: string;
  amount: string;
  transfer_calldata: string;
  content_hash: string;
  gas_cap: string;
  execution_tx_hash: string | null;
  state: SettlementTransferState;
  created_by: string;
  created_at: Date | string;
  submitted_at: Date | string | null;
  settled_at: Date | string | null;
}

interface AdminSettlementTransferDetailRow extends AdminSettlementTransferRow {
  chain_id: string | number;
  artifact_version: string;
  token_code_hash: string;
  token_transfer_conformance_evidence_hash: string;
  runtime_evidence_hash: string;
  runtime_checked_at: Date | string;
}

interface AdminSettlementAttemptRow {
  attempt_id: string;
  attempt_number: number;
  request_digest: string;
  execution_tx_hash: string | null;
  executor_wallet: string;
  executor_nonce: string;
  transaction_to: string;
  transaction_calldata: string;
  replacement_for_attempt_id: string | null;
  state: string;
  created_at: Date | string;
  submitted_at: Date | string | null;
  updated_at: Date | string;
}

interface AdminSettlementFinalityRow {
  transaction_id: string;
  expected_event_hash: string;
  tx_hash: string;
  replacement_for_tx_hash: string | null;
  receipt_status: number | null;
  block_number: string | null;
  block_hash: string | null;
  confirmations: number;
  required_confirmations: number;
  state: string;
  evidence: Record<string, unknown>;
  submitted_at: Date | string;
  finalized_at: Date | string | null;
  updated_at: Date | string;
}

interface AdminSettlementLedgerMovementRow {
  event_type: string;
  asset: string;
  debits: string;
  credits: string;
}

interface AdminSettlementCoverageRow {
  snapshot_id: string;
  block_number: string;
  block_hash: string;
  evidence_hash: string;
  recorded_at: Date | string;
  executor_wallet: string;
  asset: 'USDT' | 'NPL';
  verified_asset_balance: string;
  unsettled_liability: string;
  coverage_met: boolean;
}

interface AdminSettlementBreakerRow {
  scope: string;
  paused: boolean;
  evidence_hash: string;
  policy_version: string | null;
  changed_by: string;
  changed_at: Date | string;
}

export interface EoaRuntimeEvidence {
  executorWallet: string;
  nextNonce: string;
  tokenAddress: string;
  tokenCodeHash: string;
  tokenTransferConformanceEvidenceHash: string;
  evidenceHash: string;
  checkedAt: Date;
}

export interface AdminSettlementRequestQuery {
  requestId?: string;
  merchantId?: string;
  walletAddress?: string;
  orderId?: string;
  transferId?: string;
  executionTxHash?: string;
  rail?: SettlementRail;
  asset?: 'USDT' | 'NPL';
  state?: SettlementRequestState;
  from?: Date;
  to?: Date;
  cursorRequestedAt?: Date;
  cursorRequestId?: string;
  limit?: number;
}

export interface AdminSettlementTransferQuery {
  transferId?: string;
  merchantId?: string;
  orderId?: string;
  executorWallet?: string;
  executionTxHash?: string;
  asset?: 'USDT' | 'NPL';
  state?: SettlementTransferState;
  from?: Date;
  to?: Date;
  cursorCreatedAt?: Date;
  cursorTransferId?: string;
  limit?: number;
}

export class SettlementService {
  readonly #transactions: SqlTransactionRunner;
  readonly #secondarySignerAddress: string | undefined;
  readonly #governanceVerifyingContract: string | undefined;
  readonly #clock: () => Date;
  readonly #mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    secondarySignerAddress?: string;
    governanceVerifyingContract?: string;
    clock?: () => Date;
    mainnetMicrotestEntitlement?: MainnetMicrotestEntitlement;
  }) {
    this.#transactions = input.transactions;
    this.#secondarySignerAddress = input.secondarySignerAddress
      ? normalizedAddress(input.secondarySignerAddress, 'secondary signer')
      : undefined;
    this.#governanceVerifyingContract = input.governanceVerifyingContract
      ? normalizedAddress(input.governanceVerifyingContract, 'governance verifying contract')
      : undefined;
    this.#clock = input.clock ?? (() => new Date());
    this.#mainnetMicrotestEntitlement = input.mainnetMicrotestEntitlement;
  }

  createIntent(
    actor: FulfillmentActor,
    input: { rail: SettlementRail; amount: string; idempotencyKey: string; correlationId?: string },
  ) {
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    if (isGovernedRail(input.rail)) {
      throw new CoreError('Forbidden', 'Governed settlement rail requires a secondary-wallet approval', 403);
    }
    validateAmount(input.amount);
    validateIdempotencyKey(input.idempotencyKey);
    const requestHash = hashJson({ wallet, merchantId: actor.merchantId ?? null, ...input });
    return this.#transactions.transaction(async (executor) => {
      const existing = await executor.query<IntentRow>(
        `SELECT * FROM core.settlement_intents
         WHERE wallet_address = $1 AND idempotency_key = $2`,
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Settlement intent idempotency conflict', 409);
        }
        const ownership = await authorizeSettlementOwner(
          executor,
          actor,
          wallet,
          input.rail,
          this.#mainnetMicrotestEntitlement,
          this.#clock(),
        );
        if (ownership.microtestProductId) {
          await assertMicrotestIntentItems(
            executor,
            await loadIntentItems(executor, existing.rows[0].intent_id),
            this.#mainnetMicrotestEntitlement!,
          );
        }
        return loadIntentProjection(executor, existing.rows[0]);
      }

      const rail = railDefinition(input.rail);
      const ownership = await authorizeSettlementOwner(
        executor,
        actor,
        wallet,
        input.rail,
        this.#mainnetMicrotestEntitlement,
        this.#clock(),
      );
      const recipient = ownership.recipient;
      const sources = await availableSources(
        executor,
        wallet,
        ownership.merchantId,
        input.rail,
        ownership.microtestProductId ? this.#mainnetMicrotestEntitlement : undefined,
      );
      const selected = selectSources(sources, BigInt(input.amount));
      if (selected.items.length > 256) {
        throw new CoreError('InvalidRequest', 'Settlement intent exceeds the 256-item operational limit');
      }
      const now = this.#clock();
      const deadline = new Date(now.getTime() + INTENT_TTL_SECONDS * 1000);
      const nonce = await allocateNonce(executor, wallet);
      const intentId = randomHash();
      const items = selected.items.map((item, index) => ({
        itemIndex: index,
        orderId: item.order_id,
        accountId: item.account_id,
        backingWalletAddress: item.backing_wallet_address,
        amount: item.selectedAmount,
        itemHash: settlementItemHash(intentId, {
          itemIndex: index,
          orderId: item.order_id,
          accountId: item.account_id,
          backingWalletAddress: item.backing_wallet_address,
          amount: item.selectedAmount,
        }),
      }));
      const itemsHash = settlementItemsHash(items);
      const intent: SettlementRequestIntent = {
        intentId,
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        recipient,
        rail: input.rail,
        asset: rail.assetAddress,
        executorWallet: selected.executorWallet,
        amount: input.amount,
        itemsHash,
        nonce,
        deadline: Math.floor(deadline.getTime() / 1000),
      };
      const digest = settlementIntentDigest(intent).toLowerCase();
      await executor.query(
        `INSERT INTO core.settlement_intents (
           intent_id, artifact_version, wallet_address, merchant_id, recipient_address, rail,
           asset, asset_address, executor_wallet, amount, items_hash, intent_digest,
           nonce, deadline, state, idempotency_key, request_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ISSUED',$15,$16,$17)`,
        [
          intentId,
          CORE_ARTIFACT_VERSION,
          wallet,
          ownership.merchantId ?? null,
          recipient,
          input.rail,
          rail.asset,
          rail.assetAddress,
          selected.executorWallet,
          input.amount,
          itemsHash,
          digest,
          nonce,
          deadline,
          input.idempotencyKey,
          requestHash,
          now,
        ],
      );
      for (const item of items) {
        await executor.query(
          `INSERT INTO core.settlement_intent_items (
             intent_id, item_index, order_id, account_id, backing_wallet_address, amount, item_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            intentId,
            item.itemIndex,
            item.orderId,
            item.accountId,
            item.backingWalletAddress,
            item.amount,
            item.itemHash,
          ],
        );
      }
      await enqueueSettlementAuthorizationAudit(executor, {
        eventType: 'SettlementIntentIssued',
        resourceType: 'SETTLEMENT_INTENT',
        resourceId: intentId,
        ...(ownership.merchantId ? { merchantId: ownership.merchantId } : {}),
        actor,
        wallet,
        correlationId: auditCorrelationId(input.correlationId),
        requestHash,
        payload: {
          rail: input.rail,
          recipient,
          executorWallet: selected.executorWallet,
          amount: input.amount,
          itemsHash,
          nonce,
          deadline: deadline.toISOString(),
        },
        now,
      });
      return intentProjection(intent, items, digest, now);
    });
  }

  async createGovernedIntent(
    actor: FulfillmentActor,
    input: {
      rail: GovernedSettlementRail;
      resourceId: string;
      orderId: string;
      accountId: string;
      recipient: string;
      fulfillmentTargetHash?: string;
      amount: string;
      idempotencyKey: string;
      correlationId?: string;
      approval: GovernedSettlementApprovalInput;
    },
  ) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'ARBITRATOR');
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    const recipient = normalizedAddress(input.recipient, 'governed settlement recipient');
    if (recipient === '0x0000000000000000000000000000000000000000') {
      throw new CoreError('InvalidRequest', 'Governed settlement recipient cannot be the zero address');
    }
    validateAmount(input.amount);
    validateIdempotencyKey(input.idempotencyKey);
    if (
      !isGovernedRail(input.rail)
      || !isHash(input.orderId)
      || !input.resourceId
      || !input.accountId
      || (input.rail === 'TAKEOVER_USDT' && !isHash(input.fulfillmentTargetHash ?? ''))
      || (input.rail === 'OPERATIONS_REIMBURSEMENT_USDT' && input.fulfillmentTargetHash !== undefined)
    ) {
      throw new CoreError('InvalidRequest', 'Governed settlement request is invalid');
    }
    const secondarySigner = this.#secondarySignerAddress;
    const verifyingContract = this.#governanceVerifyingContract;
    if (!secondarySigner || !verifyingContract) {
      throw new CoreError('ExternalBlocked', 'Governed settlement signer configuration is unavailable', 503);
    }
    const approvalIntent = governedApprovalIntent(input.approval);
    const requestHash = hashJson({
      wallet,
      rail: input.rail,
      resourceId: input.resourceId,
      orderId: input.orderId,
      accountId: input.accountId,
      recipient,
      fulfillmentTargetHash: input.fulfillmentTargetHash ?? null,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      approval: input.approval,
    });
    try {
      return await this.#transactions.transaction(async (executor) => {
      const existing = await executor.query<IntentRow>(
        `SELECT * FROM core.settlement_intents
         WHERE wallet_address = $1 AND idempotency_key = $2`,
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Governed settlement intent conflict', 409);
        }
        return loadIntentProjection(executor, existing.rows[0]);
      }
      await lockLedgerAccounts(executor, [input.accountId]);
      const source = await governedAvailableSource(executor, {
        ...input,
        executorWallet: approvalIntent.executorWallet,
      });
      if (BigInt(source.amount) < BigInt(input.amount)) {
        throw new CoreError('FinalityPending', 'Governed settlement balance is insufficient', 409);
      }
      if (input.rail === 'OPERATIONS_REIMBURSEMENT_USDT' && recipient !== source.owner_id) {
        throw new CoreError('InvalidRequest', 'Operations reimbursement must return to the Operations Wallet');
      }
      const oldValueHash = hashJson({
        accountId: input.accountId,
        availableAmount: source.amount,
        backingWalletAddress: source.backing_wallet_address,
      });
      const newValueHash = hashJson({
        rail: input.rail,
        resourceId: input.resourceId,
        orderId: input.orderId,
        accountId: input.accountId,
        recipient,
        amount: input.amount,
        fulfillmentTargetHash: input.rail === 'TAKEOVER_USDT'
          ? source.fulfillment_target_hash
          : null,
      });
      const expectedAction = input.rail === 'TAKEOVER_USDT'
        ? 'CREATE_TAKEOVER_PAYOUT'
        : 'CREATE_OPERATIONS_REIMBURSEMENT';
      const expectedResourceType = input.rail === 'TAKEOVER_USDT'
        ? 'TAKEOVER_CASE'
        : 'MERCHANT_DEBT_RECOVERY';
      if (
        approvalIntent.action !== expectedAction
        || approvalIntent.resourceType !== expectedResourceType
        || approvalIntent.resourceId !== input.resourceId
        || approvalIntent.policyVersion !== BigInt(source.policy_version)
        || approvalIntent.oldValueHash.toLowerCase() !== oldValueHash
        || approvalIntent.newValueHash.toLowerCase() !== newValueHash
        || normalizedAddress(approvalIntent.executorWallet, 'approved executor wallet') !== source.backing_wallet_address
      ) throw new CoreError('InvalidSignature', 'Secondary approval does not match the governed settlement', 401);
      const verified = verifySensitiveActionApproval(
        approvalIntent,
        input.approval.signature,
        secondarySigner,
        source.backing_wallet_address,
        verifyingContract,
        this.#clock(),
      );
      const actionDigest = TypedDataEncoder.hash(
        verified.domain,
        sensitiveActionTypes,
        verified.intent,
      ).toLowerCase();
      const replay = await executor.query<{ intent_id: string }>(
        `SELECT intent_id FROM core.governed_settlement_intent_approvals
         WHERE action_digest = $1 OR (signer_address = $2 AND action_nonce = $3)
         LIMIT 1`,
        [actionDigest, verified.signer, approvalIntent.nonce.toString()],
      );
      if (replay.rows[0]) {
        throw new CoreError('NonceReplay', 'Governed settlement approval was already consumed', 401);
      }
      const now = this.#clock();
      const replacementSnapshot = input.rail === 'TAKEOVER_USDT'
        ? await ensureTakeoverReplacementSnapshot(executor, {
          caseId: input.resourceId,
          orderId: input.orderId,
          recipient,
          fulfillmentTargetHash: source.fulfillment_target_hash!,
          policyVersion: source.policy_version,
          createdBy: wallet,
          createdAt: now,
        })
        : undefined;
      const merchantId = await merchantIdForOrder(executor, input.orderId);
      const deadline = new Date(now.getTime() + INTENT_TTL_SECONDS * 1000);
      const nonce = await allocateNonce(executor, wallet);
      const intentId = randomHash();
      const item = {
        itemIndex: 0,
        orderId: input.orderId,
        accountId: input.accountId,
        backingWalletAddress: source.backing_wallet_address,
        amount: input.amount,
        itemHash: settlementItemHash(intentId, {
          itemIndex: 0,
          orderId: input.orderId,
          accountId: input.accountId,
          backingWalletAddress: source.backing_wallet_address,
          amount: input.amount,
        }),
      };
      const itemsHash = settlementItemsHash([item]);
      const intent: SettlementRequestIntent = {
        intentId,
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        recipient,
        rail: input.rail,
        asset: USDT_ADDRESS,
        executorWallet: source.backing_wallet_address,
        amount: input.amount,
        itemsHash,
        nonce,
        deadline: Math.floor(deadline.getTime() / 1000),
      };
      const digest = settlementIntentDigest(intent).toLowerCase();
      await executor.query(
        `INSERT INTO core.settlement_intents (
           intent_id, artifact_version, wallet_address, merchant_id, recipient_address, rail,
           asset, asset_address, executor_wallet, amount, items_hash, intent_digest,
           nonce, deadline, state, idempotency_key, request_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'USDT',$7,$8,$9,$10,$11,$12,$13,'ISSUED',$14,$15,$16)`,
        [
          intentId,
          CORE_ARTIFACT_VERSION,
          wallet,
          merchantId,
          recipient,
          input.rail,
          USDT_ADDRESS,
          source.backing_wallet_address,
          input.amount,
          itemsHash,
          digest,
          nonce,
          deadline,
          input.idempotencyKey,
          requestHash,
          now,
        ],
      );
      await executor.query(
        `INSERT INTO core.settlement_intent_items (
           intent_id, item_index, order_id, account_id, backing_wallet_address, amount, item_hash
         ) VALUES ($1,0,$2,$3,$4,$5,$6)`,
        [intentId, item.orderId, item.accountId, item.backingWalletAddress, item.amount, item.itemHash],
      );
      await executor.query(
        `INSERT INTO core.governed_settlement_intent_approvals (
           intent_id, rail, resource_type, resource_id, takeover_case_id,
           debt_recovery_id, replacement_fulfillment_snapshot_id,
           action_digest, signer_address, action_nonce, action_deadline,
           signature, signature_hash, action_payload, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          intentId,
          input.rail,
          expectedResourceType,
          input.resourceId,
          input.rail === 'TAKEOVER_USDT' ? input.resourceId : null,
          input.rail === 'OPERATIONS_REIMBURSEMENT_USDT' ? input.resourceId : null,
          replacementSnapshot?.snapshot_id ?? null,
          actionDigest,
          verified.signer,
          approvalIntent.nonce.toString(),
          new Date(Number(approvalIntent.deadline) * 1000),
          input.approval.signature,
          keccak256(input.approval.signature).toLowerCase(),
          JSON.stringify({
            ...input.approval,
            policyVersion: approvalIntent.policyVersion.toString(),
            nonce: approvalIntent.nonce.toString(),
            deadline: approvalIntent.deadline.toString(),
            signature: undefined,
          }),
          now,
        ],
      );
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:settlement-governed-intent', { intentId, actionDigest }),
        streamName: 'financial',
        evidenceProfile: 'SIGNED_OFFCHAIN',
        eventType: 'GovernedSettlementIntentIssued',
        resourceType: expectedResourceType,
        resourceId: input.resourceId,
        merchantId,
        actorWallet: wallet,
        actorRole: actor.roles[0]!,
        correlationId: auditCorrelationId(input.correlationId),
        requestHash: requestHash.slice(2),
        payload: {
          intentId,
          rail: input.rail,
          orderId: input.orderId,
          accountId: input.accountId,
          recipient,
          amount: input.amount,
          executorWallet: source.backing_wallet_address,
          replacementFulfillmentSnapshotId: replacementSnapshot?.snapshot_id ?? null,
          actionDigest,
        },
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash: keccak256(input.approval.signature).toLowerCase(),
          signer: verified.signer,
          digest: actionDigest,
          domain: sensitiveActionAuditDomain(verifyingContract),
          nonce: approvalIntent.nonce.toString(),
          deadline: approvalIntent.deadline.toString(),
        },
        createdAt: now,
      });
        return intentProjection(intent, [item], digest, now);
      });
    } catch (error) {
      if (isGovernedApprovalReplay(error)) {
        throw new CoreError('NonceReplay', 'Governed settlement approval was already consumed', 401);
      }
      throw error;
    }
  }

  async submitRequest(actor: FulfillmentActor, input: { intentId: string; signature: string; correlationId?: string }) {
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    if (!isHash(input.intentId)) throw new CoreError('InvalidRequest', 'Settlement intent ID is invalid');
    const snapshot = await this.#transactions.transaction(async (executor) => {
      const intent = await loadIntent(executor, input.intentId);
      return { intent, items: await loadIntentItems(executor, input.intentId) };
    });
    if (snapshot.intent.wallet_address !== wallet) {
      throw new CoreError('Forbidden', 'Settlement intent is bound to another wallet', 403);
    }
    const typedIntent = rowIntent(snapshot.intent);
    const verified = await verifySettlementRequestSignature(
      typedIntent,
      input.signature,
      this.#clock(),
    );
    if (verified.digest.toLowerCase() !== snapshot.intent.intent_digest) {
      throw new CoreError('InvalidSignature', 'Settlement intent digest does not match the immutable record', 401);
    }

    return this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const intent = await loadIntent(executor, input.intentId, true);
      if (intent.wallet_address !== wallet) throw new CoreError('Forbidden', 'Settlement wallet mismatch', 403);
      if (intent.state === 'CONSUMED') return loadRequestProjectionByIntent(executor, intent.intent_id);
      if (intent.state !== 'ISSUED') throw new CoreError('UnknownState', 'Settlement intent is not active', 409);
      const now = this.#clock();
      if (new Date(intent.deadline) < now) {
        await executor.query(
          `UPDATE core.settlement_intents SET state = 'EXPIRED'
           WHERE intent_id = $1 AND state = 'ISSUED'`,
          [intent.intent_id],
        );
        throw new CoreError('NonceExpired', 'Settlement request intent expired', 401);
      }
      const items = await loadIntentItems(executor, intent.intent_id);
      assertIntentSnapshot(snapshot, intent, items, verified.digest);
      const ownership = await authorizeSettlementOwner(
        executor,
        actor,
        wallet,
        intent.rail,
        this.#mainnetMicrotestEntitlement,
        now,
      );
      if (ownership.microtestProductId) {
        await assertMicrotestIntentItems(executor, items, this.#mainnetMicrotestEntitlement!);
      }
      await lockLedgerAccounts(executor, items.map((item) => item.account_id));
      const governedApproval = isGovernedRail(intent.rail)
        ? await loadAndVerifyGovernedApproval(executor, {
          intent,
          secondarySignerAddress: this.#secondarySignerAddress,
          governanceVerifyingContract: this.#governanceVerifyingContract,
          now,
        })
        : undefined;
      for (const item of items) {
        await assertAvailableSource(executor, intent, item, governedApproval, now);
      }

      const requestId = settlementRequestId(rowIntent(intent));
      const signatureHash = keccak256(input.signature).toLowerCase();
      await executor.query(
        `INSERT INTO core.settlement_requests (
           request_id, intent_id, artifact_version, wallet_address, merchant_id, recipient_address,
           rail, asset, asset_address, executor_wallet, amount, items_hash, intent_digest,
           signature, signature_hash, state, requested_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'REQUESTED',$16)`,
        [
          requestId,
          intent.intent_id,
          intent.artifact_version,
          intent.wallet_address,
          intent.merchant_id,
          intent.recipient_address,
          intent.rail,
          intent.asset,
          intent.asset_address,
          intent.executor_wallet,
          intent.amount,
          intent.items_hash,
          intent.intent_digest,
          input.signature,
          signatureHash,
          now,
        ],
      );
      for (const item of items) {
        const journalId = `journal:settlement-request:${requestId}:${item.item_index}`;
        const lines = stateMoveLines(item.account_id, item.amount, 'AVAILABLE', 'REQUESTED', intent.executor_wallet);
        await postSettlementJournal(executor, {
          journalId,
          eventKey: `settlement-request:${requestId}:${item.item_index}`,
          eventType: 'SETTLEMENT_REQUESTED',
          resourceType: 'SETTLEMENT_REQUEST',
          resourceId: requestId,
          orderId: item.order_id,
          policyVersion: Number(item.policy_version),
          contentHash: hashJson({ requestId, itemIndex: item.item_index, lines }),
          sourceKind: 'SIGNED_REQUEST',
          sourceReferenceHash: intent.intent_digest,
          payload: { intentId: intent.intent_id, requestId, itemIndex: item.item_index },
          lines,
        });
        await executor.query(
          `INSERT INTO core.settlement_request_items (
             request_id, item_index, order_id, account_id, backing_wallet_address,
             amount, requested_journal_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            requestId,
            item.item_index,
            item.order_id,
            item.account_id,
            item.backing_wallet_address,
            item.amount,
            journalId,
          ],
        );
        await executor.query(
          `INSERT INTO core.settlement_request_item_transitions (
             transition_id, request_id, request_item_index, transfer_id,
             transition_sequence, transition_type, journal_id, created_at
           ) VALUES ($1,$2,$3,NULL,1,'REQUESTED',$4,$5)`,
          [`transition:${journalId}`, requestId, item.item_index, journalId, now],
        );
      }
      await executor.query(
        `UPDATE core.settlement_intents SET state = 'CONSUMED', consumed_at = $2
         WHERE intent_id = $1 AND state = 'ISSUED'`,
        [intent.intent_id, now],
      );
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
         ) VALUES ($1,'SETTLEMENT_REQUEST',$2,'SettlementRequested',$3,$1,'PENDING')`,
        [`outbox:settlement-request:${requestId}`, requestId, JSON.stringify({ requestId, rail: intent.rail })],
      );
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:settlement-request', { requestId, digest: intent.intent_digest }),
        streamName: 'financial',
        evidenceProfile: 'SIGNED_OFFCHAIN',
        eventType: 'SettlementRequested',
        resourceType: 'SETTLEMENT_REQUEST',
        resourceId: requestId,
        ...(intent.merchant_id ? { merchantId: intent.merchant_id } : {}),
        actorWallet: wallet,
        actorRole: actor.roles[0]!,
        correlationId: auditCorrelationId(input.correlationId),
        requestHash: intent.intent_digest.slice(2),
        payload: {
          intentId: intent.intent_id,
          rail: intent.rail,
          executorWallet: intent.executor_wallet,
          recipient: intent.recipient_address,
          amount: intent.amount,
          itemsHash: intent.items_hash,
        },
        signatureEvidence: {
          scheme: verified.scheme,
          signatureHash,
          signer: wallet,
          digest: verified.digest,
          domain: settlementAuditDomain(intent.executor_wallet),
          nonce: String(intent.nonce),
          deadline: String(Math.floor(new Date(intent.deadline).getTime() / 1_000)),
        },
        createdAt: now,
      });
      return loadRequestProjection(executor, requestId);
    });
  }

  list(actor: FulfillmentActor) {
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    return this.#transactions.transaction(async (executor) => {
      const balances = await executor.query<{
        asset: string;
        purpose: string;
        subtype: string | null;
        balance_state: string;
        amount: string;
      }>(
        `SELECT account.asset, account.purpose, account.subtype, line.balance_state,
           sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
         FROM core.ledger_lines line
         JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
         JOIN core.ledger_accounts account ON account.account_id = line.account_id
         WHERE account.owner_id = $1 AND account.asset IN ('USDT','NPL')
           AND line.balance_state <> 'POSTED'
         GROUP BY account.asset, account.purpose, account.subtype, line.balance_state
         HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
         ORDER BY account.asset, account.purpose, account.subtype, line.balance_state`,
        [wallet],
      );
      const points = await executor.query<{
        purpose: string;
        balance_state: string;
        amount: string;
      }>(
        `SELECT account.purpose, line.balance_state,
           sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
         FROM core.ledger_lines line
         JOIN core.ledger_accounts account ON account.account_id = line.account_id
         WHERE account.owner_id = $1 AND account.asset = 'BNM_POINTS'
           AND line.balance_state IN ('LOCKED','AVAILABLE')
         GROUP BY account.purpose, line.balance_state
         HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
         ORDER BY account.purpose, line.balance_state`,
        [wallet],
      );
      const requests = await executor.query<{ request_id: string }>(
        `SELECT request_id FROM core.settlement_requests
         WHERE wallet_address = $1 ORDER BY requested_at DESC, request_id DESC`,
        [wallet],
      );
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        balances: balances.rows.map((row) => ({
          asset: row.asset,
          purpose: row.purpose,
          rewardSubtype: row.subtype,
          state: row.balance_state,
          amount: row.amount,
        })),
        points: points.rows.map((row) => ({
          pointsType: 'BNM' as const,
          purpose: row.purpose,
          state: row.balance_state,
          amount: row.amount,
          transferable: false as const,
        })),
        requests: await Promise.all(requests.rows.map((row) => loadRequestProjection(executor, row.request_id))),
      };
    });
  }

  listAdminRequests(actor: FulfillmentActor, input: AdminSettlementRequestQuery = {}) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    const query = validateAdminRequestQuery(input);
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<AdminSettlementRequestRow>(
        `SELECT request.request_id, request.merchant_id, request.wallet_address,
           request.recipient_address, request.rail, request.asset, request.executor_wallet,
           request.amount::text, request.state, ARRAY(
             SELECT transfer.transfer_id FROM core.settlement_transfers transfer
             WHERE transfer.request_id = request.request_id
             ORDER BY transfer.request_item_index
           ) AS transfer_ids, ARRAY(
             SELECT attempt.execution_tx_hash
             FROM core.settlement_transfers transfer
             JOIN core.settlement_transfer_attempts attempt ON attempt.transfer_id = transfer.transfer_id
             WHERE transfer.request_id = request.request_id
               AND attempt.state = 'SETTLED' AND attempt.execution_tx_hash IS NOT NULL
             ORDER BY transfer.request_item_index
           ) AS final_execution_tx_hashes, request.intent_digest, request.signature_hash,
           request.requested_at, request.submitted_at,
           request.settled_at, count(item.item_index)::text AS item_count
         FROM core.settlement_requests request
         JOIN core.settlement_request_items item ON item.request_id = request.request_id
         WHERE ($1::text IS NULL OR request.request_id = $1)
           AND ($2::text IS NULL OR request.merchant_id = $2)
           AND ($3::text IS NULL OR request.wallet_address = $3)
           AND ($4::text IS NULL OR EXISTS (
             SELECT 1 FROM core.settlement_request_items requested_item
             WHERE requested_item.request_id = request.request_id AND requested_item.order_id = $4
           ))
           AND ($5::text IS NULL OR EXISTS (
             SELECT 1 FROM core.settlement_transfers filtered_transfer
             WHERE filtered_transfer.request_id = request.request_id
               AND filtered_transfer.transfer_id = $5
           ))
           AND ($6::text IS NULL OR EXISTS (
             SELECT 1 FROM core.settlement_transfers filtered_transfer
             JOIN core.settlement_transfer_attempts attempt
               ON attempt.transfer_id = filtered_transfer.transfer_id
             WHERE filtered_transfer.request_id = request.request_id
               AND attempt.execution_tx_hash = $6
           ))
           AND ($7::text IS NULL OR request.rail = $7)
           AND ($8::text IS NULL OR request.asset = $8)
           AND ($9::text IS NULL OR request.state = $9)
           AND ($10::timestamptz IS NULL OR request.requested_at >= $10)
           AND ($11::timestamptz IS NULL OR request.requested_at < $11)
           AND ($12::timestamptz IS NULL OR (request.requested_at, request.request_id) < ($12, $13))
         GROUP BY request.request_id
         ORDER BY request.requested_at DESC, request.request_id DESC
         LIMIT $14`,
        [
          query.requestId ?? null,
          query.merchantId ?? null,
          query.walletAddress ?? null,
          query.orderId ?? null,
          query.transferId ?? null,
          query.executionTxHash ?? null,
          query.rail ?? null,
          query.asset ?? null,
          query.state ?? null,
          query.from ?? null,
          query.to ?? null,
          query.cursorRequestedAt ?? null,
          query.cursorRequestId ?? null,
          query.limit + 1,
        ],
      );
      const page = result.rows.slice(0, query.limit);
      const last = result.rows.length > query.limit ? page.at(-1) : undefined;
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        requests: page.map(adminRequestProjection),
        nextCursor: last
          ? { requestedAt: timestamp(last.requested_at), requestId: last.request_id }
          : null,
      };
    });
  }

  getAdminRequest(actor: FulfillmentActor, requestId: string) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    requireHash(requestId, 'settlement request ID');
    return this.#transactions.transaction(async (executor) => {
      return loadAdminRequestDetail(executor, requestId);
    });
  }

  failedCloseUnbroadcastQuarantinedRequest(
    actor: FulfillmentActor,
    input: {
      requestId: string;
      reasonCode: string;
      evidenceHash: string;
      idempotencyKey: string;
      correlationId?: string;
    },
  ) {
    assertRole(actor, 'ADMIN', 'OPERATOR');
    requireHash(input.requestId, 'settlement request ID');
    requireHash(input.evidenceHash, 'failed-close evidence hash');
    validateIdempotencyKey(input.idempotencyKey);
    if (!/^[A-Z0-9:_-]{4,80}$/.test(input.reasonCode)) {
      throw new CoreError('InvalidRequest', 'Failed-close reason code is invalid', 400);
    }
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    const now = this.#clock();
    const requestHash = hashJson({
      requestId: input.requestId.toLowerCase(),
      reasonCode: input.reasonCode,
      evidenceHash: input.evidenceHash.toLowerCase(),
      idempotencyKey: input.idempotencyKey,
    });
    return this.#transactions.transaction(async (executor) => {
      const request = await executor.query<{
        request_id: string;
        state: SettlementRequestState;
        rail: SettlementRail;
        asset: 'USDT' | 'NPL';
        executor_wallet: string;
        merchant_id: string | null;
        intent_digest: string;
        amount: string;
      }>(
        `SELECT request_id, state, rail, asset, executor_wallet, merchant_id,
           intent_digest, amount::text
         FROM core.settlement_requests
         WHERE request_id = $1
         FOR UPDATE`,
        [input.requestId.toLowerCase()],
      );
      const row = request.rows[0];
      if (!row) throw new CoreError('InvalidRequest', 'Settlement request not found', 404);
      if (row.state === 'FAILED_CLOSED') return loadAdminRequestDetail(executor, row.request_id);
      if (row.state !== 'QUARANTINED') {
        throw new CoreError('InvalidRequest', 'Only quarantined settlement requests can be failed-closed', 409);
      }
      if (row.rail !== 'PRIZE_USDT' || row.asset !== 'USDT' || row.amount !== '1') {
        throw new CoreError('InvalidRequest', 'Failed-close is limited to the one-atomic-USDT prize quarantine repair', 409);
      }
      const transfers = await executor.query<{
        transfer_id: string;
        state: SettlementTransferState;
        amount: string;
        submitted_at: Date | null;
        execution_tx_hashes: string[];
        nonce_state: string;
      }>(
        `SELECT transfer.transfer_id, transfer.state, transfer.amount::text,
           transfer.submitted_at,
           transfer.nonce_state,
           ARRAY(
             SELECT attempt.execution_tx_hash
             FROM core.settlement_transfer_attempts attempt
             WHERE attempt.transfer_id = transfer.transfer_id
               AND attempt.execution_tx_hash IS NOT NULL
             ORDER BY attempt.attempt_number
           ) AS execution_tx_hashes
         FROM core.settlement_transfers transfer
         WHERE transfer.request_id = $1
         FOR UPDATE`,
        [row.request_id],
      );
      if (
        transfers.rows.length !== 1
        || transfers.rows[0]?.state !== 'QUARANTINED'
        || transfers.rows[0]?.amount !== '1'
      ) {
        throw new CoreError('InvalidRequest', 'Failed-close prize quarantine repair must target exactly one unbroadcast one-atomic transfer', 409);
      }
      if (transfers.rows.some((transfer) => transfer.submitted_at || transfer.execution_tx_hashes.length > 0)) {
        throw new CoreError('InvalidRequest', 'Quarantined settlement request has broadcast evidence and cannot be failed-closed', 409);
      }
      const items = await executor.query<{
        item_index: number;
        order_id: string;
        account_id: string;
        amount: string;
        policy_version: string | number;
      }>(
        `SELECT item.item_index, item.order_id, item.account_id, item.amount::text,
           orders.policy_version::text
         FROM core.settlement_request_items item
         JOIN core.orders orders ON orders.order_id = item.order_id
         WHERE item.request_id = $1
         ORDER BY item.item_index
         FOR UPDATE OF item`,
        [row.request_id],
      );
      if (items.rows.length === 0) {
        throw new CoreError('UnknownState', 'Quarantined settlement request has no items', 409);
      }
      if (items.rows.length !== 1 || items.rows[0]?.amount !== '1') {
        throw new CoreError('InvalidRequest', 'Failed-close prize quarantine repair must target exactly one one-atomic request item', 409);
      }
      await lockLedgerAccounts(executor, items.rows.map((item) => item.account_id));
      await assertRequestedStateBalances(executor, items.rows.map((item) => ({
        account_id: item.account_id,
        amount: item.amount,
        order_id: item.order_id,
      })));
      for (const item of items.rows) {
        const journalId = `journal:settlement-failed-close:${row.request_id}:${item.item_index}`;
        const lines = stateMoveLines(item.account_id, item.amount, 'REQUESTED', 'AVAILABLE', row.executor_wallet);
        await postSettlementJournal(executor, {
          journalId,
          eventKey: `settlement-failed-close:${row.request_id}:${item.item_index}`,
          eventType: 'SETTLEMENT_FAILED_CLOSED',
          resourceType: 'SETTLEMENT_REQUEST',
          resourceId: row.request_id,
          orderId: item.order_id,
          policyVersion: Number(item.policy_version),
          contentHash: hashJson({
            requestId: row.request_id,
            itemIndex: item.item_index,
            reasonCode: input.reasonCode,
            evidenceHash: input.evidenceHash.toLowerCase(),
            lines,
          }),
          sourceKind: 'RECONCILIATION',
          sourceReferenceHash: input.evidenceHash.toLowerCase(),
          payload: {
            requestId: row.request_id,
            itemIndex: item.item_index,
            reasonCode: input.reasonCode,
            idempotencyKey: input.idempotencyKey,
          },
          lines,
        });
        const sequence = await executor.query<{ next_sequence: number }>(
          `SELECT COALESCE(max(transition_sequence), 0) + 1 AS next_sequence
           FROM core.settlement_request_item_transitions
           WHERE request_id = $1 AND request_item_index = $2`,
          [row.request_id, item.item_index],
        );
        await executor.query(
          `INSERT INTO core.settlement_request_item_transitions (
             transition_id, request_id, request_item_index, transfer_id,
             transition_sequence, transition_type, journal_id, created_at
           ) VALUES ($1,$2,$3,NULL,$4,'FAILED_CLOSED',$5,$6)`,
          [
            `transition:${journalId}`,
            row.request_id,
            item.item_index,
            sequence.rows[0]?.next_sequence ?? 2,
            journalId,
            now,
          ],
        );
      }
      await executor.query(
        `UPDATE core.settlement_transfer_attempts
         SET state = 'FAILED_CLOSED', updated_at = $2
         WHERE transfer_id = ANY($1::text[])
           AND state = 'QUARANTINED'
           AND execution_tx_hash IS NULL`,
        [transfers.rows.map((transfer) => transfer.transfer_id), now],
      );
      await executor.query(
        `UPDATE core.settlement_transfers
         SET state = 'FAILED_CLOSED',
             nonce_state = CASE WHEN nonce_state = 'RESERVED' THEN 'RELEASED' ELSE nonce_state END,
             nonce_release_evidence_hash = CASE WHEN nonce_state = 'RESERVED' THEN $2 ELSE nonce_release_evidence_hash END
         WHERE request_id = $1 AND state = 'QUARANTINED'`,
        [row.request_id, input.evidenceHash.toLowerCase()],
      );
      await executor.query(
        `UPDATE core.settlement_requests
         SET state = 'FAILED_CLOSED'
         WHERE request_id = $1 AND state = 'QUARANTINED'`,
        [row.request_id],
      );
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:settlement-failed-close', {
          requestId: row.request_id,
          idempotencyKey: input.idempotencyKey,
        }),
        streamName: 'financial',
        evidenceProfile: 'AUTHORIZATION',
        eventType: 'SettlementFailedClosed',
        resourceType: 'SETTLEMENT_REQUEST',
        resourceId: row.request_id,
        ...(row.merchant_id ? { merchantId: row.merchant_id } : {}),
        actorWallet: wallet,
        actorRole: actor.roles[0]!,
        correlationId: auditCorrelationId(input.correlationId),
        requestHash: requestHash.slice(2),
        payload: {
          rail: row.rail,
          asset: row.asset,
          amount: row.amount,
          reasonCode: input.reasonCode,
          evidenceHash: input.evidenceHash.toLowerCase(),
          transferIds: transfers.rows.map((transfer) => transfer.transfer_id),
        },
        authorizationEvidence: {
          scheme: 'SESSION_RESOURCE_OWNERSHIP',
          subject: wallet,
          roles: [...actor.roles].sort(),
          evidenceHash: input.evidenceHash.toLowerCase(),
          checkedAt: now.toISOString(),
        },
        createdAt: now,
      });
      return loadAdminRequestDetail(executor, row.request_id);
    });
  }

  listAdminTransfers(actor: FulfillmentActor, input: AdminSettlementTransferQuery = {}) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    const query = validateAdminTransferQuery(input);
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<AdminSettlementTransferRow>(
        `${adminTransferSelect()}
         WHERE ($1::text IS NULL OR transfer.transfer_id = $1)
           AND ($2::text IS NULL OR request.merchant_id = $2)
           AND ($3::text IS NULL OR transfer.order_id = $3)
           AND ($4::text IS NULL OR transfer.executor_wallet = $4)
           AND ($5::text IS NULL OR EXISTS (
             SELECT 1 FROM core.settlement_transfer_attempts filtered_attempt
             WHERE filtered_attempt.transfer_id = transfer.transfer_id
               AND filtered_attempt.execution_tx_hash = $5
           ))
           AND ($6::text IS NULL OR transfer.asset = $6)
           AND ($7::text IS NULL OR transfer.state = $7)
           AND ($8::timestamptz IS NULL OR transfer.created_at >= $8)
           AND ($9::timestamptz IS NULL OR transfer.created_at < $9)
           AND ($10::timestamptz IS NULL OR (transfer.created_at, transfer.transfer_id) < ($10, $11))
         ORDER BY transfer.created_at DESC, transfer.transfer_id DESC
         LIMIT $12`,
        [
          query.transferId ?? null,
          query.merchantId ?? null,
          query.orderId ?? null,
          query.executorWallet ?? null,
          query.executionTxHash ?? null,
          query.asset ?? null,
          query.state ?? null,
          query.from ?? null,
          query.to ?? null,
          query.cursorCreatedAt ?? null,
          query.cursorTransferId ?? null,
          query.limit + 1,
        ],
      );
      const page = result.rows.slice(0, query.limit);
      const last = result.rows.length > query.limit ? page.at(-1) : undefined;
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        transfers: page.map(adminTransferProjection),
        nextCursor: last
          ? { createdAt: timestamp(last.created_at), transferId: last.transfer_id }
          : null,
      };
    });
  }

  getAdminTransfer(actor: FulfillmentActor, transferId: string) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    requireHash(transferId, 'settlement transfer ID');
    return this.#transactions.transaction(async (executor) => {
      const transferResult = await executor.query<AdminSettlementTransferDetailRow>(
        `${adminTransferDetailSelect()} WHERE transfer.transfer_id = $1`,
        [transferId],
      );
      const transfer = transferResult.rows[0];
      if (!transfer) throw new CoreError('InvalidRequest', 'Settlement transfer not found', 404);
      const attempts = await executor.query<AdminSettlementAttemptRow>(
        `SELECT attempt_id, attempt_number, request_digest, execution_tx_hash,
           executor_wallet, executor_nonce::text, transaction_to, transaction_calldata,
           replacement_for_attempt_id, state, created_at, submitted_at, updated_at
         FROM core.settlement_transfer_attempts
         WHERE transfer_id = $1 ORDER BY attempt_number`,
        [transferId],
      );
      const finality = await executor.query<AdminSettlementFinalityRow>(
        `SELECT transaction_id, expected_event_hash, tx_hash,
           replacement_for_tx_hash, receipt_status, block_number::text,
           block_hash, confirmations, required_confirmations, state,
           evidence, submitted_at, finalized_at, updated_at
         FROM core.transaction_finality
         WHERE resource_type = 'SETTLEMENT_TRANSFER' AND resource_id = $1
         ORDER BY updated_at DESC, transaction_id DESC LIMIT 1`,
        [transferId],
      );
      const movements = await executor.query<AdminSettlementLedgerMovementRow>(
        `SELECT journal.event_type, account.asset,
           COALESCE(sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE 0 END), 0)::text AS debits,
           COALESCE(sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE 0 END), 0)::text AS credits
         FROM core.ledger_journals journal
         JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
         JOIN core.ledger_accounts account ON account.account_id = line.account_id
         WHERE journal.resource_type = 'SETTLEMENT_TRANSFER' AND journal.resource_id = $1
         GROUP BY journal.event_type, account.asset
         ORDER BY journal.event_type, account.asset`,
        [transferId],
      );
      const coverage = await executor.query<AdminSettlementCoverageRow>(
        `SELECT snapshot.snapshot_id, snapshot.block_number::text,
           snapshot.block_hash, snapshot.evidence_hash, snapshot.recorded_at,
           item.wallet_address AS executor_wallet, item.asset,
           item.verified_asset_balance::text, item.unsettled_liability::text, item.coverage_met
         FROM core.coverage_snapshots snapshot
         JOIN core.coverage_snapshot_items item ON item.snapshot_id = snapshot.snapshot_id
         WHERE item.wallet_address = $1 AND item.asset = $2
           AND COALESCE((
             SELECT canonical FROM core.coverage_snapshot_canonicality observation
             WHERE observation.snapshot_id = snapshot.snapshot_id
             ORDER BY observation.observed_at DESC, observation.observation_id DESC LIMIT 1
           ), snapshot.canonical)
         ORDER BY snapshot.block_number DESC, snapshot.recorded_at DESC LIMIT 1`,
        [transfer.executor_wallet, transfer.asset],
      );
      const breakers = await executor.query<AdminSettlementBreakerRow>(
        `SELECT scope, paused, evidence_hash, policy_version::text,
           changed_by, changed_at FROM core.circuit_breakers ORDER BY scope`,
      );
      const ledgerMovements = movements.rows.map((row) => ({
        eventType: row.event_type,
        asset: row.asset,
        debits: row.debits,
        credits: row.credits,
        balanced: row.debits === row.credits,
      }));
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        transfer: {
          ...adminTransferProjection(transfer),
          artifactVersion: transfer.artifact_version,
          chainId: Number(transfer.chain_id),
          tokenCodeHash: transfer.token_code_hash,
          tokenTransferConformanceEvidenceHash: transfer.token_transfer_conformance_evidence_hash,
          runtimeEvidenceHash: transfer.runtime_evidence_hash,
          runtimeCheckedAt: timestamp(transfer.runtime_checked_at),
        },
        attempts: attempts.rows.map((row) => ({
          attemptId: row.attempt_id,
          attemptNumber: row.attempt_number,
          requestDigest: row.request_digest,
          executionTxHash: row.execution_tx_hash,
          executorWallet: row.executor_wallet,
          executorNonce: row.executor_nonce,
          transactionTo: row.transaction_to,
          transactionCalldata: row.transaction_calldata,
          replacementForAttemptId: row.replacement_for_attempt_id,
          state: row.state,
          createdAt: timestamp(row.created_at),
          submittedAt: nullableTimestamp(row.submitted_at),
          updatedAt: timestamp(row.updated_at),
        })),
        finality: finality.rows[0] ? adminFinalityProjection(finality.rows[0]) : null,
        coverage: coverage.rows[0] ? adminCoverageProjection(coverage.rows[0]) : null,
        breakers: breakers.rows.map((row) => ({
          scope: row.scope,
          paused: row.paused,
          evidenceHash: row.evidence_hash,
          policyVersion: row.policy_version,
          changedBy: row.changed_by,
          changedAt: timestamp(row.changed_at),
        })),
        reconciliation: {
          expectedAmount: transfer.amount,
          ledgerMovements,
          conserved: ledgerMovements.length > 0
            && ledgerMovements.every((row) => row.balanced),
        },
      };
    });
  }

  createTransfer(
    actor: FulfillmentActor,
    input: {
      asset: 'USDT' | 'NPL';
      gasCap: string;
      idempotencyKey: string;
      runtime: EoaRuntimeEvidence;
      correlationId?: string;
    },
  ) {
    assertRole(actor, 'ADMIN', 'OPERATOR');
    validateIdempotencyKey(input.idempotencyKey);
    validateAmount(input.gasCap);
    const tokenAddress = input.asset === 'USDT' ? USDT_ADDRESS : NPL_ADDRESS;
    const runtime = validateEoaRuntime(input.runtime, tokenAddress, this.#clock);
    return this.#transactions.transaction(async (executor) => {
      await lockSeckillPrizeFundingMutation(executor);
      const existing = await executor.query<{ transfer_id: string }>(
        'SELECT transfer_id FROM core.settlement_transfers WHERE idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing.rows[0]) return loadTransferProjection(executor, existing.rows[0].transfer_id);
      await assertTransferCreationAvailable(executor, runtime.executorWallet, input.asset, this.#clock);
      await executor.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`settlement-executor:${runtime.executorWallet}`],
      );
      const requestedItems = await executor.query<RequestedItemRow>(
        `SELECT request.request_id, item.item_index AS request_item_index,
           item.order_id, item.account_id, request.recipient_address, item.amount,
           request.requested_at, orders.policy_version, request.merchant_id,
           request.rail, merchant.guarantee_status AS merchant_guarantee_status
         FROM core.settlement_requests request
         JOIN core.settlement_request_items item ON item.request_id = request.request_id
         JOIN core.orders orders ON orders.order_id = item.order_id
         LEFT JOIN core.merchants merchant ON merchant.merchant_id = orders.merchant_id
         WHERE request.state IN ('REQUESTED','RETRYABLE') AND request.executor_wallet = $1
           AND request.asset = $2 AND item.submitted_journal_id IS NULL
           AND NOT (
             request.rail = 'MERCHANT_USDT'
             AND NOT (merchant.status = 'APPROVED' AND merchant.guarantee_status <> 'FROZEN')
           )
         ORDER BY request.requested_at, request.request_id, item.item_index
         LIMIT 1
         FOR UPDATE OF request, item`,
        [
          runtime.executorWallet,
          input.asset,
        ],
      );
      if (requestedItems.rows.length === 0) {
        throw new CoreError('FinalityPending', 'No eligible requested settlement items are available', 409);
      }
      const item = requestedItems.rows[0]!;
      const recipientAddress = normalizedAddress(item.recipient_address, 'settlement recipient');
      if (recipientAddress === runtime.executorWallet.toLowerCase()) {
        throw new CoreError('InvalidRequest', 'Settlement transfer recipient cannot equal the EOA executor wallet', 409);
      }
      const authorizationMode = 'FORMAL';
      let authorizationExpiresAt: Date | null = null;
      const authorizationEvidenceHash: string | null = null;
      await lockLedgerAccounts(executor, [item.account_id]);
      await assertRequestedStateBalances(executor, [item]);
      const pendingSeckillReservation = await executor.query<{ action_id: string }>(
        `SELECT action_id FROM core.seckill_governance_actions
         WHERE governance_wallet_address = $1
           AND state IN ('PENDING_EXECUTION','RECONCILE_REQUIRED')
           AND executor_nonce IS NOT NULL
         ORDER BY executor_nonce, action_id LIMIT 1`,
        [runtime.executorWallet],
      );
      if (pendingSeckillReservation.rows[0]) {
        throw new CoreError('FinalityPending', 'The EOA nonce is reserved by an unresolved seckill execution', 409);
      }
      const executorNonce = await nextAvailableSettlementExecutorNonce(
        executor,
        runtime.executorWallet,
        runtime.nextNonce,
      );
      if (!executorNonce || !/^(0|[1-9][0-9]*)$/.test(executorNonce)) {
        throw new CoreError('UnknownState', 'EOA settlement nonce allocation failed', 409);
      }
      const transferId = randomHash();
      const transferCalldata = ERC20_TRANSFER.encodeFunctionData(
        'transfer',
        [recipientAddress, BigInt(item.amount)],
      ).toLowerCase();
      const contentHash = hashJson({
        transferId,
        artifactVersion: CORE_ARTIFACT_VERSION,
        chainId: 56,
        requestId: item.request_id,
        requestItemIndex: item.request_item_index,
        orderId: item.order_id,
        accountId: item.account_id,
        asset: input.asset,
        tokenAddress,
        executorWallet: runtime.executorWallet,
        executorNonce,
        recipientAddress: item.recipient_address,
        amount: item.amount,
        transferCalldata,
        gasCap: input.gasCap,
        authorizationMode,
        authorizationExpiresAt: null,
        authorizationEvidenceHash,
      });
      await executor.query(
        `INSERT INTO core.settlement_transfers (
           transfer_id, artifact_version, chain_id, request_id, request_item_index,
           order_id, account_id, asset, token_address, executor_wallet, executor_nonce,
           recipient_address, amount, transfer_calldata, content_hash, idempotency_key, gas_cap,
           token_code_hash, token_transfer_conformance_evidence_hash,
           runtime_evidence_hash, runtime_checked_at, authorization_mode,
           authorization_expires_at, authorization_evidence_hash,
           state, created_by, created_at
         ) VALUES ($1,$2,56,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'PENDING',$24,$25)`,
        [
          transferId,
          CORE_ARTIFACT_VERSION,
          item.request_id,
          item.request_item_index,
          item.order_id,
          item.account_id,
          input.asset,
          tokenAddress,
          runtime.executorWallet,
          executorNonce,
          recipientAddress,
          item.amount,
          transferCalldata,
          contentHash,
          input.idempotencyKey,
          input.gasCap,
          runtime.tokenCodeHash,
          runtime.tokenTransferConformanceEvidenceHash,
          runtime.evidenceHash,
          runtime.checkedAt,
          authorizationMode,
          authorizationExpiresAt,
          authorizationEvidenceHash,
          normalizedAddress(actor.walletAddress, 'transfer creator'),
          this.#clock(),
        ],
      );
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
         ) VALUES ($1,'SETTLEMENT_TRANSFER',$2,'SettlementTransferCreated',$3,$1,'PENDING')`,
        [
          `outbox:settlement-transfer:${transferId}`,
          transferId,
          JSON.stringify({ transferId, contentHash }),
        ],
      );
      const now = this.#clock();
      await enqueueSettlementAuthorizationAudit(executor, {
        eventType: 'SettlementTransferCreated',
        resourceType: 'SETTLEMENT_TRANSFER',
        resourceId: transferId,
        ...(item.merchant_id ? { merchantId: item.merchant_id } : {}),
        actor,
        wallet: normalizedAddress(actor.walletAddress, 'transfer creator'),
        correlationId: auditCorrelationId(input.correlationId),
        requestHash: contentHash,
        payload: {
          asset: input.asset,
          executorWallet: runtime.executorWallet,
          executorNonce,
          recipientAddress: item.recipient_address,
          amount: item.amount,
          gasCap: input.gasCap,
          contentHash,
          runtimeEvidenceHash: runtime.evidenceHash,
        },
        now,
      });
      return loadTransferProjection(executor, transferId);
    });
  }
}

export async function nextAvailableSettlementExecutorNonce(
  executor: SqlExecutor,
  executorWallet: string,
  chainPendingNonce: string,
) {
  const result = await executor.query<{ next_nonce: string }>(
    `WITH RECURSIVE occupied(executor_nonce) AS (
       SELECT transfer.executor_nonce
       FROM core.settlement_transfers transfer
       WHERE transfer.executor_wallet = $1 AND transfer.nonce_state <> 'RELEASED'
       UNION
       SELECT action.executor_nonce
       FROM core.seckill_governance_actions action
       WHERE action.governance_wallet_address = $1
         AND action.executor_nonce IS NOT NULL
         AND action.nonce_release_evidence_hash IS NULL
     ), candidate(next_nonce) AS (
       SELECT $2::numeric
       UNION ALL
       SELECT candidate.next_nonce + 1
       FROM candidate
       WHERE EXISTS (SELECT 1 FROM occupied WHERE executor_nonce = candidate.next_nonce)
     )
     SELECT candidate.next_nonce::text AS next_nonce
     FROM candidate
     WHERE NOT EXISTS (SELECT 1 FROM occupied WHERE executor_nonce = candidate.next_nonce)
     LIMIT 1`,
    [executorWallet, chainPendingNonce],
  );
  return result.rows[0]?.next_nonce;
}

async function enqueueSettlementAuthorizationAudit(executor: SqlExecutor, input: {
  eventType: string;
  resourceType: string;
  resourceId: string;
  merchantId?: string;
  actor: FulfillmentActor;
  wallet: string;
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  now: Date;
}) {
  const roles = [...input.actor.roles].sort();
  const evidenceHash = hashJson({
    wallet: input.wallet,
    roles,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    merchantId: input.merchantId ?? null,
    checkedAt: input.now.toISOString(),
  });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:settlement-authorization', {
      eventType: input.eventType,
      resourceId: input.resourceId,
      requestHash: input.requestHash,
      merchantId: input.merchantId ?? null,
    }),
    streamName: 'financial',
    evidenceProfile: 'AUTHORIZATION',
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    ...(input.merchantId ? { merchantId: input.merchantId } : {}),
    actorWallet: input.wallet,
    actorRole: roles[0]!,
    correlationId: input.correlationId,
    requestHash: input.requestHash.slice(2),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'SESSION_RESOURCE_OWNERSHIP',
      subject: input.wallet,
      roles,
      evidenceHash,
      checkedAt: input.now.toISOString(),
    },
    createdAt: input.now,
  });
}

function sensitiveActionAuditDomain(verifyingContract: string) {
  return `Abu24KV2Core:2:56:${normalizedAddress(verifyingContract, 'governance verifying contract')}`;
}

function settlementAuditDomain(executorWallet: string) {
  return `Abu24KV2Settlement:2:56:${normalizedAddress(executorWallet, 'settlement wallet')}`;
}

function railDefinition(rail: SettlementRail) {
  if (rail === 'REWARD_NPL') {
    return { asset: 'NPL' as const, assetAddress: NPL_ADDRESS, purposes: ['REWARD_LIABILITY'] as const };
  }
  if (rail === 'PRIZE_USDT') {
    return { asset: 'USDT' as const, assetAddress: USDT_ADDRESS, purposes: ['SECKILL_PRIZE_LIABILITY'] as const };
  }
  if (rail === 'MERCHANT_USDT') {
    return {
      asset: 'USDT' as const,
      assetAddress: USDT_ADDRESS,
      purposes: ['MERCHANT_RECEIVABLE', 'MERCHANT_FREIGHT_RECEIVABLE'] as const,
    };
  }
  if (rail === 'TAKEOVER_USDT') {
    return { asset: 'USDT' as const, assetAddress: USDT_ADDRESS, purposes: ['TAKEOVER_PAYABLE'] as const };
  }
  if (rail === 'OPERATIONS_REIMBURSEMENT_USDT') {
    return { asset: 'USDT' as const, assetAddress: USDT_ADDRESS, purposes: ['OPERATIONS_REIMBURSEMENT'] as const };
  }
  throw new CoreError('InvalidRequest', 'Settlement rail is invalid');
}

async function authorizeSettlementOwner(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  wallet: string,
  rail: SettlementRail,
  mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined,
  now: Date,
): Promise<{ recipient: string; merchantId?: string; microtestProductId?: string }> {
  if (isGovernedRail(rail)) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'ARBITRATOR');
    return { recipient: wallet };
  }
  if (rail !== 'MERCHANT_USDT') return { recipient: wallet };
  if (!actor.roles.includes('MERCHANT')) throw new CoreError('Forbidden', 'Merchant role is required', 403);
  const merchant = await executor.query<{
    merchant_id: string;
    settlement_wallet: string;
    status: string;
    guarantee_status: string;
  }>(
    `SELECT merchant.merchant_id, merchant.settlement_wallet, merchant.status, merchant.guarantee_status
     FROM core.merchants merchant
     WHERE merchant.settlement_wallet = $1 OR ($2::text IS NOT NULL AND merchant.merchant_id = $2)
     ORDER BY CASE WHEN settlement_wallet = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [wallet, actor.merchantId ?? null],
  );
  const row = merchant.rows[0];
  if (!row || row.settlement_wallet.toLowerCase() !== wallet) {
    throw new CoreError('Forbidden', 'Merchant settlement wallet must sign the request', 403);
  }
  if (actor.merchantId && row.merchant_id !== actor.merchantId) {
    throw new CoreError('Forbidden', 'Merchant settlement scope does not match the active session', 403);
  }
  if (!isMerchantOperationallyEligible(row.status, row.guarantee_status)) {
    throw new CoreError('Forbidden', 'Merchant settlement is frozen', 403);
  }
  return {
    recipient: row.settlement_wallet.toLowerCase(),
    merchantId: row.merchant_id,
  };
}

async function merchantIdForOrder(executor: SqlExecutor, orderId: string) {
  const result = await executor.query<{ merchant_id: string }>(
    'SELECT merchant_id FROM core.orders WHERE order_id = $1',
    [orderId],
  );
  const merchantId = result.rows[0]?.merchant_id;
  if (!merchantId) throw new CoreError('UnknownState', 'Settlement order merchant is unavailable', 409);
  return merchantId;
}

async function availableSources(
  executor: SqlExecutor,
  wallet: string,
  merchantId: string | undefined,
  rail: SettlementRail,
  microtestEntitlement?: MainnetMicrotestEntitlement,
) {
  const definition = railDefinition(rail);
  return (await executor.query<AvailableSourceRow>(
    `SELECT journal.order_id, line.account_id, line.backing_wallet_address,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount,
       min(orders.created_at) AS created_at, min(orders.policy_version) AS policy_version
     FROM core.ledger_lines line
     JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     JOIN core.orders orders ON orders.order_id = journal.order_id
     WHERE account.owner_id = $1 AND account.asset = $2 AND account.purpose = ANY($3::text[])
       AND line.balance_state = 'AVAILABLE' AND line.backing_wallet_address IS NOT NULL
       AND ($4::text IS NULL OR orders.merchant_id = $4)
       AND ($5::text <> 'PRIZE_USDT' OR EXISTS (
         SELECT 1 FROM core.seckill_prize_settlements prize
         WHERE prize.award_account_id = line.account_id
           AND prize.candidate_order_id = journal.order_id
           AND prize.state = 'APPROVED'
       ))
       AND ($6::text IS NULL OR (
         orders.product_id = $6
         AND lower(orders.buyer_wallet) = ANY($7::text[])
         AND EXISTS (
           SELECT 1 FROM core.merchant_guarantees guarantee
           WHERE guarantee.merchant_id = orders.merchant_id
             AND lower(guarantee.source_evidence_hash) = lower($8)
             AND orders.created_at >= guarantee.updated_at
         )
       ))
     GROUP BY journal.order_id, line.account_id, line.backing_wallet_address
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY min(orders.created_at), journal.order_id, line.account_id`,
    [
      wallet,
      definition.asset,
      [...definition.purposes],
      rail === 'MERCHANT_USDT' ? merchantId ?? null : null,
      rail,
      microtestEntitlement?.productId ?? null,
      microtestEntitlement ? [...microtestEntitlement.buyerWallets] : [],
      microtestEntitlement?.evidenceHash ?? null,
    ],
  )).rows;
}

async function assertMicrotestIntentItems(
  executor: SqlExecutor,
  items: readonly IntentItemRow[],
  entitlement: MainnetMicrotestEntitlement,
) {
  const orderIds = [...new Set(items.map((item) => item.order_id))];
  const result = await executor.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM core.orders orders
     JOIN core.merchant_guarantees guarantee ON guarantee.merchant_id = orders.merchant_id
     WHERE orders.order_id = ANY($1::text[])
       AND orders.product_id = $2
       AND lower(orders.buyer_wallet) = ANY($3::text[])
       AND lower(guarantee.source_evidence_hash) = lower($4)
       AND orders.created_at >= guarantee.updated_at`,
    [orderIds, entitlement.productId, [...entitlement.buyerWallets], entitlement.evidenceHash],
  );
  if (Number(result.rows[0]?.count ?? 0) !== orderIds.length) {
    throw new CoreError('Forbidden', 'Micro-test settlement is limited to the configured product', 403);
  }
}

function isGovernedRail(rail: SettlementRail): rail is GovernedSettlementRail {
  return rail === 'TAKEOVER_USDT' || rail === 'OPERATIONS_REIMBURSEMENT_USDT';
}

function governedApprovalIntent(
  input: Omit<GovernedSettlementApprovalInput, 'signature'> | GovernedSettlementApprovalInput,
): SensitiveActionIntent {
  if (
    !input.action
    || !input.resourceType
    || !input.resourceId
    || !isHash(input.oldValueHash)
    || !isHash(input.newValueHash)
    || !/^(0|[1-9][0-9]*)$/.test(input.policyVersion)
    || !/^(0|[1-9][0-9]*)$/.test(input.nonce)
    || !/^[1-9][0-9]*$/.test(input.deadline)
  ) throw new CoreError('InvalidRequest', 'Governed settlement approval is invalid');
  const intent: SensitiveActionIntent = {
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    policyVersion: BigInt(input.policyVersion),
    oldValueHash: input.oldValueHash.toLowerCase(),
    newValueHash: input.newValueHash.toLowerCase(),
    executorWallet: normalizedAddress(input.executorWallet, 'approved executor wallet'),
    nonce: BigInt(input.nonce),
    deadline: BigInt(input.deadline),
  };
  if (intent.policyVersion <= 0n || intent.deadline > 8_640_000_000_000n) {
    throw new CoreError('InvalidRequest', 'Governed settlement approval bounds are invalid');
  }
  return intent;
}

async function governedAvailableSource(
  executor: SqlExecutor,
  input: {
    rail: GovernedSettlementRail;
    resourceId: string;
    orderId: string;
    accountId: string;
    fulfillmentTargetHash?: string;
    executorWallet: string;
  },
) {
  const result = input.rail === 'TAKEOVER_USDT'
    ? await executor.query<GovernedAvailableSourceRow>(
      `SELECT account.owner_id, line.backing_wallet_address,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount,
         takeover.policy_version, lower(orders.fulfillment_target_hash) AS fulfillment_target_hash
       FROM core.ledger_lines line
       JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       JOIN core.takeover_cases takeover ON takeover.case_id = $2
       JOIN core.orders orders ON orders.order_id = takeover.order_id
       JOIN core.fulfillment_targets target
         ON lower(target.target_hash) = lower(orders.fulfillment_target_hash)
       WHERE line.account_id = $1 AND takeover.order_id = $3
         AND lower(orders.fulfillment_target_hash) = lower($4)
         AND account.owner_id = takeover.case_id
         AND account.asset = 'USDT' AND account.purpose = 'TAKEOVER_PAYABLE'
         AND journal.order_id = takeover.order_id
         AND line.balance_state = 'AVAILABLE' AND line.backing_wallet_address = $5
       GROUP BY account.owner_id, line.backing_wallet_address,
         takeover.policy_version, orders.fulfillment_target_hash
       HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0`,
      [input.accountId, input.resourceId, input.orderId, input.fulfillmentTargetHash, input.executorWallet],
    )
    : await executor.query<GovernedAvailableSourceRow>(
      `SELECT account.owner_id, line.backing_wallet_address,
         LEAST(
           sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END),
           recovery.amount_usdt - COALESCE((
             SELECT sum(item.amount)
             FROM core.governed_settlement_intent_approvals approval
             JOIN core.settlement_requests request ON request.intent_id = approval.intent_id
             JOIN core.settlement_request_items item ON item.request_id = request.request_id
             WHERE approval.debt_recovery_id = recovery.recovery_id
           ), 0)
         )::text AS amount,
         orders.policy_version, NULL::text AS fulfillment_target_hash
       FROM core.ledger_lines line
       JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       JOIN core.merchant_debt_recoveries recovery ON recovery.recovery_id = $2
       JOIN core.takeover_cases takeover ON takeover.case_id = recovery.case_id
       JOIN core.orders orders ON orders.order_id = recovery.order_id
       WHERE line.account_id = $1 AND journal.order_id = recovery.order_id
         AND recovery.order_id = $3 AND recovery.reversed_at IS NULL
         AND recovery.operations_wallet_address = takeover.platform_advance_wallet_address
         AND account.owner_id = recovery.operations_wallet_address
         AND account.asset = 'USDT' AND account.purpose = 'OPERATIONS_REIMBURSEMENT'
         AND line.balance_state = 'AVAILABLE'
         AND line.backing_wallet_address = recovery.backing_wallet_address
         AND line.backing_wallet_address = $4
       GROUP BY account.owner_id, line.backing_wallet_address, orders.policy_version,
         recovery.recovery_id, recovery.amount_usdt
       HAVING LEAST(
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END),
         recovery.amount_usdt - COALESCE((
           SELECT sum(item.amount)
           FROM core.governed_settlement_intent_approvals approval
           JOIN core.settlement_requests request ON request.intent_id = approval.intent_id
           JOIN core.settlement_request_items item ON item.request_id = request.request_id
           WHERE approval.debt_recovery_id = recovery.recovery_id
         ), 0)
       ) > 0`,
      [input.accountId, input.resourceId, input.orderId, input.executorWallet],
    );
  if (result.rows.length !== 1) {
    throw new CoreError('FinalityPending', 'Governed settlement source is unavailable or ambiguous', 409);
  }
  return {
    ...result.rows[0]!,
    owner_id: result.rows[0]!.owner_id.toLowerCase(),
    backing_wallet_address: result.rows[0]!.backing_wallet_address.toLowerCase(),
    fulfillment_target_hash: result.rows[0]!.fulfillment_target_hash?.toLowerCase() ?? null,
  };
}

async function ensureTakeoverReplacementSnapshot(
  executor: SqlExecutor,
  input: {
    caseId: string;
    orderId: string;
    recipient: string;
    fulfillmentTargetHash: string;
    policyVersion: string | number;
    createdBy: string;
    createdAt: Date;
  },
) {
  const authority = await executor.query<{
    case_id: string;
    order_id: string;
    policy_version: string | number;
    fulfillment_target_hash: string;
    assignment_id: string;
  }>(
    `SELECT takeover.case_id, takeover.order_id, takeover.policy_version,
       lower(orders.fulfillment_target_hash) AS fulfillment_target_hash,
       assignment.assignment_id
     FROM core.takeover_cases takeover
     JOIN core.orders orders ON orders.order_id = takeover.order_id
     JOIN core.fulfillment_targets target
       ON lower(target.target_hash) = lower(orders.fulfillment_target_hash)
     JOIN LATERAL (
       SELECT assignment_id, replacement_wallet
       FROM core.takeover_assignments current_assignment
       WHERE current_assignment.case_id = takeover.case_id
       ORDER BY assignment_version DESC LIMIT 1
     ) assignment ON assignment.replacement_wallet = lower($5)
     WHERE takeover.case_id = $1 AND takeover.order_id = $2
       AND takeover.policy_version = $3
       AND takeover.state = 'FUNDED'
       AND lower(orders.fulfillment_target_hash) = lower($4)
     FOR UPDATE OF takeover`,
    [input.caseId, input.orderId, input.policyVersion, input.fulfillmentTargetHash, input.recipient],
  );
  if (!authority.rows[0]) {
    throw new CoreError('InvalidFinality', 'Takeover replacement fulfillment target is not authoritative', 409);
  }
  const existing = await executor.query<TakeoverReplacementSnapshotRow>(
    'SELECT * FROM core.takeover_replacement_fulfillment_snapshots WHERE case_id = $1',
    [input.caseId],
  );
  const snapshotContent = {
    assignmentId: authority.rows[0].assignment_id,
    caseId: input.caseId,
    orderId: input.orderId,
    recipient: input.recipient,
    fulfillmentTargetHash: authority.rows[0].fulfillment_target_hash,
    policyVersion: BigInt(input.policyVersion).toString(),
  };
  const snapshotHash = hashJson(snapshotContent);
  if (existing.rows[0]) {
    if (existing.rows[0].snapshot_hash !== snapshotHash) {
      throw new CoreError('InvalidFinality', 'Takeover replacement fulfillment target is already frozen', 409);
    }
    return existing.rows[0];
  }
  const snapshotId = randomHash();
  await executor.query(
    `INSERT INTO core.takeover_replacement_fulfillment_snapshots (
       snapshot_id, assignment_id, case_id, order_id, recipient_address, fulfillment_target_hash,
       policy_version, snapshot_hash, created_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      snapshotId,
      authority.rows[0].assignment_id,
      input.caseId,
      input.orderId,
      input.recipient,
      authority.rows[0].fulfillment_target_hash,
      input.policyVersion,
      snapshotHash,
      input.createdBy,
      input.createdAt,
    ],
  );
  return {
    snapshot_id: snapshotId,
    assignment_id: authority.rows[0].assignment_id,
    case_id: input.caseId,
    order_id: input.orderId,
    recipient_address: input.recipient,
    fulfillment_target_hash: authority.rows[0].fulfillment_target_hash,
    policy_version: input.policyVersion,
    snapshot_hash: snapshotHash,
  } satisfies TakeoverReplacementSnapshotRow;
}

function selectSources(rows: AvailableSourceRow[], requested: bigint) {
  const groups = new Map<string, AvailableSourceRow[]>();
  for (const row of rows) {
    const backingWallet = row.backing_wallet_address.toLowerCase();
    groups.set(backingWallet, [
      ...(groups.get(backingWallet) ?? []),
      { ...row, backing_wallet_address: backingWallet },
    ]);
  }
  const eligible = [...groups.entries()]
    .map(([executorWallet, items]) => ({
      executorWallet,
      items,
      total: items.reduce((sum, item) => sum + BigInt(item.amount), 0n),
      first: new Date(items[0]!.created_at).getTime(),
    }))
    .filter((group) => group.total >= requested)
    .sort((left, right) => left.first - right.first || left.executorWallet.localeCompare(right.executorWallet));
  const selectedGroup = eligible[0];
  if (!selectedGroup) throw new CoreError('FinalityPending', 'Available settlement balance is insufficient', 409);
  let remaining = requested;
  const items: Array<AvailableSourceRow & { selectedAmount: string }> = [];
  for (const row of selectedGroup.items) {
    if (remaining === 0n) break;
    const selectedAmount = BigInt(row.amount) > remaining ? remaining : BigInt(row.amount);
    items.push({ ...row, selectedAmount: selectedAmount.toString() });
    remaining -= selectedAmount;
  }
  return { executorWallet: selectedGroup.executorWallet, items };
}

async function allocateNonce(executor: SqlExecutor, wallet: string) {
  const result = await executor.query<{ nonce: string }>(
    `INSERT INTO core.settlement_wallet_nonces (wallet_address, next_nonce)
     VALUES ($1, 1)
     ON CONFLICT (wallet_address) DO UPDATE
       SET next_nonce = core.settlement_wallet_nonces.next_nonce + 1,
           updated_at = clock_timestamp()
     RETURNING (next_nonce - 1)::text AS nonce`,
    [wallet],
  );
  return result.rows[0]!.nonce;
}

async function loadIntent(executor: SqlExecutor, intentId: string, forUpdate = false) {
  const result = await executor.query<IntentRow>(
    `SELECT * FROM core.settlement_intents WHERE intent_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [intentId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Settlement intent not found', 404);
  return result.rows[0];
}

async function loadIntentItems(executor: SqlExecutor, intentId: string) {
  return (await executor.query<IntentItemRow>(
    `SELECT item.*, orders.policy_version
     FROM core.settlement_intent_items item
     JOIN core.orders orders ON orders.order_id = item.order_id
     WHERE item.intent_id = $1 ORDER BY item.item_index`,
    [intentId],
  )).rows;
}

function assertIntentSnapshot(
  snapshot: { intent: IntentRow; items: IntentItemRow[] },
  currentIntent: IntentRow,
  currentItems: IntentItemRow[],
  verifiedDigest: string,
) {
  const snapshotDigest = settlementIntentDigest(rowIntent(snapshot.intent)).toLowerCase();
  const currentDigest = settlementIntentDigest(rowIntent(currentIntent)).toLowerCase();
  const snapshotItemsHash = intentItemsHash(snapshot.intent.intent_id, snapshot.items);
  const currentItemsHash = intentItemsHash(currentIntent.intent_id, currentItems);
  if (
    snapshotDigest !== snapshot.intent.intent_digest
    || currentDigest !== currentIntent.intent_digest
    || snapshot.intent.intent_digest !== currentIntent.intent_digest
    || currentIntent.intent_digest !== verifiedDigest.toLowerCase()
    || snapshotItemsHash !== snapshot.intent.items_hash
    || currentItemsHash !== currentIntent.items_hash
    || snapshotItemsHash !== currentItemsHash
  ) throw new CoreError('InvalidSignature', 'Settlement intent changed after wallet signature verification', 401);
}

function intentItemsHash(intentId: string, items: readonly IntentItemRow[]) {
  const canonical = items.map((item) => {
    const expectedItemHash = hashJson({
      intentId,
      itemIndex: item.item_index,
      orderId: item.order_id,
      accountId: item.account_id,
      backingWalletAddress: item.backing_wallet_address,
      amount: item.amount,
    });
    if (expectedItemHash !== item.item_hash) {
      throw new CoreError('InvalidFinality', 'Settlement intent item content hash is invalid', 409);
    }
    return {
      itemIndex: item.item_index,
      orderId: item.order_id,
      accountId: item.account_id,
      backingWalletAddress: item.backing_wallet_address,
      amount: item.amount,
      itemHash: item.item_hash,
    };
  });
  return hashJson(canonical);
}

async function loadAndVerifyGovernedApproval(
  executor: SqlExecutor,
  input: {
    intent: IntentRow;
    secondarySignerAddress: string | undefined;
    governanceVerifyingContract: string | undefined;
    now: Date;
  },
) {
  if (!input.secondarySignerAddress || !input.governanceVerifyingContract) {
    throw new CoreError('ExternalBlocked', 'Governed settlement signer configuration is unavailable', 503);
  }
  const result = await executor.query<GovernedApprovalRow>(
    `SELECT rail, resource_type, resource_id, takeover_case_id, debt_recovery_id,
       replacement_fulfillment_snapshot_id,
       action_digest, signer_address, action_deadline, signature, action_payload
     FROM core.governed_settlement_intent_approvals WHERE intent_id = $1`,
    [input.intent.intent_id],
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('InvalidSignature', 'Governed settlement approval is unavailable', 401);
  const approvalIntent = governedApprovalIntent(row.action_payload);
  const expectedResourceType = input.intent.rail === 'TAKEOVER_USDT'
    ? 'TAKEOVER_CASE'
    : 'MERCHANT_DEBT_RECOVERY';
  if (
    row.rail !== input.intent.rail
    || row.resource_type !== expectedResourceType
    || approvalIntent.resourceType !== expectedResourceType
    || approvalIntent.resourceId !== row.resource_id
    || (input.intent.rail === 'TAKEOVER_USDT'
      ? row.takeover_case_id !== row.resource_id || row.debt_recovery_id !== null
      : row.debt_recovery_id !== row.resource_id || row.takeover_case_id !== null)
    || new Date(row.action_deadline) < input.now
  ) throw new CoreError('InvalidSignature', 'Governed settlement approval record is invalid', 401);
  const verified = verifySensitiveActionApproval(
    approvalIntent,
    row.signature,
    input.secondarySignerAddress,
    input.intent.executor_wallet,
    input.governanceVerifyingContract,
    input.now,
  );
  const digest = TypedDataEncoder.hash(verified.domain, sensitiveActionTypes, verified.intent).toLowerCase();
  if (digest !== row.action_digest || verified.signer !== row.signer_address) {
    throw new CoreError('InvalidSignature', 'Governed settlement approval digest is invalid', 401);
  }
  return row;
}

async function loadIntentProjection(executor: SqlExecutor, row: IntentRow) {
  const items = await loadIntentItems(executor, row.intent_id);
  return intentProjection(rowIntent(row), items.map((item) => ({
    itemIndex: item.item_index,
    orderId: item.order_id,
    accountId: item.account_id,
    backingWalletAddress: item.backing_wallet_address,
    amount: item.amount,
    itemHash: item.item_hash,
  })), row.intent_digest, new Date(row.created_at));
}

function intentProjection(
  intent: SettlementRequestIntent,
  items: readonly unknown[],
  digest: string,
  createdAt: Date,
) {
  return {
    intent,
    digest,
    typedData: {
      domain: settlementRequestDomain(intent.executorWallet),
      types: settlementRequestTypes,
      primaryType: 'SettlementRequest',
      message: intent,
    },
    items,
    createdAt: createdAt.toISOString(),
  };
}

function rowIntent(row: IntentRow): SettlementRequestIntent {
  return {
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
  };
}

async function lockLedgerAccounts(executor: SqlExecutor, accountIds: string[]) {
  const ids = [...new Set(accountIds)].sort();
  if (ids.length === 0) throw new CoreError('InvalidRequest', 'No ledger accounts were selected');
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
  const locked = await executor.query<{ account_id: string }>(
    `SELECT account_id FROM core.ledger_accounts
     WHERE account_id IN (${placeholders}) ORDER BY account_id FOR UPDATE`,
    ids,
  );
  if (locked.rows.length !== ids.length) throw new CoreError('InvalidFinality', 'Settlement account is unavailable', 409);
}

async function assertRequestedStateBalances(
  executor: SqlExecutor,
  items: readonly Pick<RequestedItemRow, 'order_id' | 'account_id' | 'amount'>[],
) {
  for (const item of items) {
    const result = await executor.query<{ amount: string }>(
      `SELECT COALESCE(sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END),0)::text AS amount
       FROM core.ledger_lines line
       JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
       WHERE journal.order_id = $1 AND line.account_id = $2 AND line.balance_state = 'REQUESTED'`,
      [item.order_id, item.account_id],
    );
    if (BigInt(result.rows[0]?.amount ?? '0') < BigInt(item.amount)) {
      throw new CoreError('InvalidFinality', 'Requested settlement balance is no longer backed by the order', 409);
    }
  }
}

async function assertAvailableSource(
  executor: SqlExecutor,
  intent: IntentRow,
  item: IntentItemRow,
  governedApproval: GovernedApprovalRow | undefined,
  now: Date,
) {
  if (isGovernedRail(intent.rail)) {
    if (!governedApproval) throw new CoreError('InvalidSignature', 'Governed settlement approval is required', 401);
    let replacementSnapshot: TakeoverReplacementSnapshotRow | undefined;
    if (intent.rail === 'TAKEOVER_USDT') {
      const result = await executor.query<TakeoverReplacementSnapshotRow>(
        `SELECT snapshot_id, assignment_id, case_id, order_id, recipient_address,
           fulfillment_target_hash, policy_version, snapshot_hash
         FROM core.takeover_replacement_fulfillment_snapshots WHERE snapshot_id = $1`,
        [governedApproval.replacement_fulfillment_snapshot_id],
      );
      replacementSnapshot = result.rows[0];
      if (!replacementSnapshot) {
        throw new CoreError('InvalidFinality', 'Takeover replacement fulfillment snapshot is unavailable', 409);
      }
    }
    const source = await governedAvailableSource(executor, {
      rail: intent.rail,
      resourceId: governedApproval.resource_id,
      orderId: item.order_id,
      accountId: item.account_id,
      executorWallet: intent.executor_wallet,
      ...(replacementSnapshot
        ? { fulfillmentTargetHash: replacementSnapshot.fulfillment_target_hash }
        : {}),
    });
    const approvalIntent = governedApprovalIntent(governedApproval.action_payload);
    const oldValueHash = hashJson({
      accountId: item.account_id,
      availableAmount: source.amount,
      backingWalletAddress: source.backing_wallet_address,
    });
    const newValueHash = hashJson({
      rail: intent.rail,
      resourceId: governedApproval.resource_id,
      orderId: item.order_id,
      accountId: item.account_id,
      recipient: intent.recipient_address,
      amount: item.amount,
      fulfillmentTargetHash: replacementSnapshot?.fulfillment_target_hash ?? null,
    });
    const expectedAction = intent.rail === 'TAKEOVER_USDT'
      ? 'CREATE_TAKEOVER_PAYOUT'
      : 'CREATE_OPERATIONS_REIMBURSEMENT';
    const expectedResourceType = intent.rail === 'TAKEOVER_USDT'
      ? 'TAKEOVER_CASE'
      : 'MERCHANT_DEBT_RECOVERY';
    if (
      item.amount !== intent.amount
      || item.backing_wallet_address !== intent.executor_wallet
      || source.backing_wallet_address !== intent.executor_wallet
      || BigInt(source.amount) < BigInt(item.amount)
      || approvalIntent.policyVersion !== BigInt(source.policy_version)
      || approvalIntent.action !== expectedAction
      || approvalIntent.resourceType !== expectedResourceType
      || approvalIntent.resourceId !== governedApproval.resource_id
      || approvalIntent.oldValueHash !== oldValueHash
      || approvalIntent.newValueHash !== newValueHash
      || approvalIntent.executorWallet !== intent.executor_wallet
      || approvalIntent.deadline < BigInt(Math.floor(now.getTime() / 1000))
    ) throw new CoreError('FinalityPending', 'Governed settlement source no longer matches its approval', 409);
    if (intent.rail === 'OPERATIONS_REIMBURSEMENT_USDT') {
      if (intent.recipient_address !== source.owner_id || governedApproval.replacement_fulfillment_snapshot_id) {
        throw new CoreError('InvalidFinality', 'Operations reimbursement recipient is not the snapshotted operations wallet', 409);
      }
      return;
    }
    if (
      !replacementSnapshot
      || replacementSnapshot.case_id !== governedApproval.resource_id
      || replacementSnapshot.order_id !== item.order_id
      || replacementSnapshot.recipient_address !== intent.recipient_address
      || replacementSnapshot.fulfillment_target_hash !== source.fulfillment_target_hash
      || BigInt(replacementSnapshot.policy_version) !== BigInt(source.policy_version)
      || replacementSnapshot.snapshot_hash !== hashJson({
        assignmentId: replacementSnapshot.assignment_id,
        caseId: replacementSnapshot.case_id,
        orderId: replacementSnapshot.order_id,
        recipient: replacementSnapshot.recipient_address,
        fulfillmentTargetHash: replacementSnapshot.fulfillment_target_hash,
        policyVersion: BigInt(replacementSnapshot.policy_version).toString(),
      })
    ) throw new CoreError('InvalidFinality', 'Takeover replacement fulfillment snapshot does not match payout', 409);
    return;
  }
  const definition = railDefinition(intent.rail);
  const result = await executor.query<{ amount: string }>(
    `SELECT COALESCE(sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END), 0)::text AS amount
     FROM core.ledger_lines line
     JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND line.account_id = $2
       AND line.balance_state = 'AVAILABLE' AND line.backing_wallet_address = $3
       AND account.owner_id = $4 AND account.asset = $5 AND account.purpose = ANY($6::text[])
       AND ($7::text <> 'PRIZE_USDT' OR EXISTS (
         SELECT 1 FROM core.seckill_prize_settlements prize
         WHERE prize.award_account_id = line.account_id
           AND prize.candidate_order_id = journal.order_id
           AND prize.state = 'APPROVED'
       ))`,
    [
      item.order_id,
      item.account_id,
      intent.executor_wallet,
      intent.wallet_address,
      definition.asset,
      [...definition.purposes],
      intent.rail,
    ],
  );
  if (BigInt(result.rows[0]?.amount ?? '0') < BigInt(item.amount)) {
    throw new CoreError('FinalityPending', 'Settlement source is no longer Available', 409);
  }
}

function stateMoveLines(
  accountId: string,
  amount: string,
  from: 'AVAILABLE' | 'REQUESTED' | 'SUBMITTED' | 'SETTLED',
  to: 'AVAILABLE' | 'REQUESTED' | 'SUBMITTED' | 'SETTLED',
  executorWallet: string,
) {
  return [
    {
      account_id: accountId,
      side: 'DEBIT',
      amount,
      balance_state: from,
      backing_wallet_address: executorWallet,
    },
    {
      account_id: accountId,
      side: 'CREDIT',
      amount,
      balance_state: to,
      backing_wallet_address: executorWallet,
    },
  ];
}

async function postSettlementJournal(
  executor: SqlExecutor,
  input: {
    journalId: string;
    eventKey: string;
    eventType: 'SETTLEMENT_REQUESTED' | 'SETTLEMENT_SUBMITTED' | 'SETTLEMENT_SETTLED'
      | 'SETTLEMENT_EXECUTION_REVERSED' | 'SETTLEMENT_FINALITY_REVERSED' | 'SETTLEMENT_FAILED_CLOSED';
    resourceType: 'SETTLEMENT_REQUEST' | 'SETTLEMENT_TRANSFER';
    resourceId: string;
    orderId: string;
    policyVersion: number;
    contentHash: string;
    sourceKind: 'SIGNED_REQUEST' | 'EOA_TRANSFER' | 'RECONCILIATION';
    sourceReferenceHash: string;
    payload: Record<string, unknown>;
    lines: ReturnType<typeof stateMoveLines>;
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
      input.orderId,
      input.policyVersion,
      input.contentHash,
      null,
      null,
      input.sourceKind,
      input.sourceReferenceHash,
      JSON.stringify(input.payload),
      JSON.stringify(input.lines),
    ],
  );
}

async function loadRequestProjectionByIntent(executor: SqlExecutor, intentId: string) {
  const result = await executor.query<{ request_id: string }>(
    'SELECT request_id FROM core.settlement_requests WHERE intent_id = $1',
    [intentId],
  );
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Consumed settlement request is unavailable', 409);
  return loadRequestProjection(executor, result.rows[0].request_id);
}

async function loadRequestProjection(executor: SqlExecutor, requestId: string) {
  const request = await executor.query<RequestProjectionRow>(
    `SELECT request_id, intent_id, artifact_version, wallet_address, recipient_address,
       rail, asset, asset_address, executor_wallet, amount::text, items_hash, intent_digest,
       signature_hash, state, ARRAY(
         SELECT transfer.transfer_id FROM core.settlement_transfers transfer
         WHERE transfer.request_id = request.request_id ORDER BY transfer.request_item_index
       ) AS transfer_ids, ARRAY(
         SELECT attempt.execution_tx_hash
         FROM core.settlement_transfers transfer
         JOIN core.settlement_transfer_attempts attempt ON attempt.transfer_id = transfer.transfer_id
         WHERE transfer.request_id = request.request_id
           AND attempt.state = 'SETTLED' AND attempt.execution_tx_hash IS NOT NULL
         ORDER BY transfer.request_item_index
       ) AS final_execution_tx_hashes,
       requested_at, submitted_at, settled_at
     FROM core.settlement_requests request WHERE request_id = $1`,
    [requestId],
  );
  if (!request.rows[0]) throw new CoreError('InvalidRequest', 'Settlement request not found', 404);
  const items = await executor.query<Record<string, unknown>>(
    `SELECT item_index, order_id, account_id, backing_wallet_address, amount::text,
       requested_journal_id, submitted_journal_id, settled_journal_id
     FROM core.settlement_request_items WHERE request_id = $1 ORDER BY item_index`,
    [requestId],
  );
  const transitions = await executor.query<Record<string, unknown>>(
    `SELECT transition_id, request_item_index, transfer_id, transition_sequence,
       transition_type, journal_id, created_at
     FROM core.settlement_request_item_transitions
     WHERE request_id = $1 ORDER BY request_item_index, transition_sequence`,
    [requestId],
  );
  return { ...request.rows[0], items: items.rows, transitions: transitions.rows };
}

function validateEoaRuntime(value: EoaRuntimeEvidence, tokenAddress: string, clock: () => Date) {
  const checkedAt = new Date(value.checkedAt);
  const now = clock();
  if (
    normalizedAddress(value.tokenAddress, 'settlement token') !== normalizedAddress(tokenAddress, 'expected token')
    || !/^(0|[1-9][0-9]*)$/.test(value.nextNonce)
    || !isHash(value.tokenCodeHash)
    || !isHash(value.tokenTransferConformanceEvidenceHash)
    || !isHash(value.evidenceHash)
    || !Number.isFinite(checkedAt.getTime())
    || checkedAt > now
    || now.getTime() - checkedAt.getTime() > RUNTIME_EVIDENCE_MAX_AGE_MS
  ) throw new CoreError('ExternalBlocked', 'Fresh verified EOA settlement runtime evidence is unavailable', 503);
  return {
    ...value,
    executorWallet: normalizedAddress(value.executorWallet, 'EOA executor wallet'),
    tokenAddress: normalizedAddress(value.tokenAddress, 'settlement token'),
    tokenCodeHash: value.tokenCodeHash.toLowerCase(),
    tokenTransferConformanceEvidenceHash: value.tokenTransferConformanceEvidenceHash.toLowerCase(),
    evidenceHash: value.evidenceHash.toLowerCase(),
    checkedAt,
  };
}

async function assertTransferCreationAvailable(
  executor: SqlExecutor,
  executorWallet: string,
  asset: 'USDT' | 'NPL',
  clock: () => Date,
) {
  const breaker = await executor.query<{ blocked: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM core.circuit_breakers WHERE scope = 'NEW_SETTLEMENT_BATCH' AND paused)
       OR EXISTS (
         SELECT 1 FROM core.breaker_causes
         WHERE scope = 'NEW_SETTLEMENT_BATCH' AND active
       )
     ) AS blocked`,
  );
  if (breaker.rows[0]?.blocked) throw new CoreError('BreakerActive', 'New settlement transfers are paused', 409);
  const coverage = await executor.query<{
    coverage_met: boolean;
    recorded_at: Date;
    canonical: boolean;
  }>(
    `SELECT latest.coverage_met, latest.recorded_at, canonicality.canonical
     FROM (
       SELECT snapshot.snapshot_id, snapshot.recorded_at, item.coverage_met
       FROM core.coverage_snapshots snapshot
       JOIN core.coverage_snapshot_items item ON item.snapshot_id = snapshot.snapshot_id
       WHERE item.wallet_address = $1 AND item.asset = $2
       ORDER BY snapshot.recorded_at DESC, snapshot.block_number DESC, snapshot.snapshot_id DESC
       LIMIT 1
     ) latest
     JOIN LATERAL (
       SELECT bool_and(observation.canonical) AS canonical
       FROM core.coverage_snapshot_canonicality observation
       WHERE observation.snapshot_id = latest.snapshot_id
         AND observation.observed_at = (
           SELECT max(last_observation.observed_at)
           FROM core.coverage_snapshot_canonicality last_observation
           WHERE last_observation.snapshot_id = latest.snapshot_id
         )
     ) canonicality ON true`,
    [executorWallet, asset],
  );
  const row = coverage.rows[0];
  const now = clock();
  if (
    !row
    || !row.canonical
    || !row.coverage_met
    || now.getTime() - new Date(row.recorded_at).getTime() > RUNTIME_EVIDENCE_MAX_AGE_MS
  ) throw new CoreError('ExternalBlocked', 'Fresh wallet coverage evidence is unavailable', 503);
}

function validateAdminRequestQuery(input: AdminSettlementRequestQuery) {
  const query = { ...input, limit: validateAdminLimit(input.limit) };
  if (query.requestId) query.requestId = requireHash(query.requestId, 'settlement request ID');
  if (query.orderId) query.orderId = requireHash(query.orderId, 'order ID');
  if (query.transferId) query.transferId = requireHash(query.transferId, 'settlement transfer ID');
  if (query.executionTxHash) query.executionTxHash = requireHash(query.executionTxHash, 'execution TxHash');
  if (query.walletAddress) query.walletAddress = normalizedAddress(query.walletAddress, 'wallet address');
  if (query.rail && !settlementRails.includes(query.rail)) {
    throw new CoreError('InvalidRequest', 'Settlement rail filter is invalid');
  }
  if (query.asset && !['USDT', 'NPL'].includes(query.asset)) {
    throw new CoreError('InvalidRequest', 'Settlement asset filter is invalid');
  }
  if (query.state && !settlementRequestStates.includes(query.state)) {
    throw new CoreError('InvalidRequest', 'Settlement request state filter is invalid');
  }
  validateAdminDateRange(query.from, query.to);
  if (Boolean(query.cursorRequestedAt) !== Boolean(query.cursorRequestId)) {
    throw new CoreError('InvalidRequest', 'Settlement request cursor is incomplete');
  }
  if (query.cursorRequestId) query.cursorRequestId = requireHash(query.cursorRequestId, 'request cursor ID');
  return query;
}

function validateAdminTransferQuery(input: AdminSettlementTransferQuery) {
  const query = { ...input, limit: validateAdminLimit(input.limit) };
  if (query.transferId) query.transferId = requireHash(query.transferId, 'settlement transfer ID');
  if (query.orderId) query.orderId = requireHash(query.orderId, 'order ID');
  if (query.executionTxHash) query.executionTxHash = requireHash(query.executionTxHash, 'execution TxHash');
  if (query.executorWallet) query.executorWallet = normalizedAddress(query.executorWallet, 'executor wallet');
  if (query.asset && !['USDT', 'NPL'].includes(query.asset)) {
    throw new CoreError('InvalidRequest', 'Settlement asset filter is invalid');
  }
  if (query.state && !settlementTransferStates.includes(query.state)) {
    throw new CoreError('InvalidRequest', 'Settlement transfer state filter is invalid');
  }
  validateAdminDateRange(query.from, query.to);
  if (Boolean(query.cursorCreatedAt) !== Boolean(query.cursorTransferId)) {
    throw new CoreError('InvalidRequest', 'Settlement transfer cursor is incomplete');
  }
  if (query.cursorTransferId) {
    query.cursorTransferId = requireHash(query.cursorTransferId, 'transfer cursor ID');
  }
  return query;
}

function validateAdminDateRange(from?: Date, to?: Date) {
  if (from && !Number.isFinite(from.getTime())) throw new CoreError('InvalidRequest', 'From timestamp is invalid');
  if (to && !Number.isFinite(to.getTime())) throw new CoreError('InvalidRequest', 'To timestamp is invalid');
  if (from && to && from >= to) throw new CoreError('InvalidRequest', 'Settlement date range is invalid');
}

function validateAdminLimit(limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CoreError('InvalidRequest', 'Settlement page limit must be between 1 and 100');
  }
  return limit;
}

async function loadAdminRequest(executor: SqlExecutor, requestId: string) {
  const result = await executor.query<AdminSettlementRequestRow>(
    `SELECT request.request_id, request.merchant_id, request.wallet_address,
       request.recipient_address, request.rail, request.asset, request.executor_wallet,
       request.amount::text, request.state, ARRAY(
         SELECT transfer.transfer_id FROM core.settlement_transfers transfer
         WHERE transfer.request_id = request.request_id ORDER BY transfer.request_item_index
       ) AS transfer_ids, ARRAY(
         SELECT attempt.execution_tx_hash
         FROM core.settlement_transfers transfer
         JOIN core.settlement_transfer_attempts attempt ON attempt.transfer_id = transfer.transfer_id
         WHERE transfer.request_id = request.request_id
           AND attempt.state = 'SETTLED' AND attempt.execution_tx_hash IS NOT NULL
         ORDER BY transfer.request_item_index
       ) AS final_execution_tx_hashes, request.intent_digest,
       request.signature_hash, request.requested_at, request.submitted_at,
       request.settled_at, (
         SELECT count(*)::text FROM core.settlement_request_items item
         WHERE item.request_id = request.request_id
       ) AS item_count
     FROM core.settlement_requests request WHERE request.request_id = $1`,
    [requestId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Settlement request not found', 404);
  return result.rows[0];
}

async function loadAdminRequestDetail(executor: SqlExecutor, requestId: string) {
  const request = await loadAdminRequest(executor, requestId);
  const items = await executor.query<AdminSettlementRequestItemRow>(
    `SELECT item.item_index, item.order_id, item.account_id,
       item.backing_wallet_address, item.amount::text, intent_item.item_hash,
       item.requested_journal_id, item.submitted_journal_id,
       item.settled_journal_id, orders.policy_version::text
     FROM core.settlement_request_items item
     JOIN core.settlement_requests request ON request.request_id = item.request_id
     JOIN core.settlement_intent_items intent_item
       ON intent_item.intent_id = request.intent_id AND intent_item.item_index = item.item_index
     JOIN core.orders orders ON orders.order_id = item.order_id
     WHERE item.request_id = $1 ORDER BY item.item_index`,
    [requestId],
  );
  const transitions = await executor.query<AdminSettlementTransitionRow>(
    `SELECT transition_id, request_item_index, transfer_id,
       transition_sequence, transition_type, journal_id, created_at
     FROM core.settlement_request_item_transitions
     WHERE request_id = $1
     ORDER BY request_item_index, transition_sequence`,
    [requestId],
  );
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    request: adminRequestProjection(request),
    items: items.rows.map((row) => ({
      itemIndex: row.item_index,
      orderId: row.order_id,
      accountId: row.account_id,
      backingWalletAddress: row.backing_wallet_address,
      amount: row.amount,
      itemHash: row.item_hash,
      policyVersion: row.policy_version,
      journals: {
        requested: row.requested_journal_id,
        submitted: row.submitted_journal_id,
        settled: row.settled_journal_id,
      },
    })),
    transitions: transitions.rows.map((row) => ({
      transitionId: row.transition_id,
      requestItemIndex: row.request_item_index,
      transferId: row.transfer_id,
      sequence: row.transition_sequence,
      type: row.transition_type,
      journalId: row.journal_id,
      createdAt: timestamp(row.created_at),
    })),
  };
}

function adminRequestProjection(row: AdminSettlementRequestRow) {
  return {
    requestId: row.request_id,
    merchantId: row.merchant_id,
    walletAddress: row.wallet_address,
    recipientAddress: row.recipient_address,
    rail: row.rail,
    asset: row.asset,
    executorWallet: row.executor_wallet,
    amount: row.amount,
    state: row.state,
    transferIds: row.transfer_ids,
    intentDigest: row.intent_digest,
    signatureHash: row.signature_hash,
    finalExecutionTxHashes: row.final_execution_tx_hashes,
    itemCount: Number(row.item_count),
    requestedAt: timestamp(row.requested_at),
    submittedAt: nullableTimestamp(row.submitted_at),
    settledAt: nullableTimestamp(row.settled_at),
  };
}

function adminTransferSelect() {
  return `SELECT transfer.transfer_id, transfer.asset, transfer.executor_wallet,
    transfer.executor_nonce::text, transfer.nonce_state, transfer.nonce_release_evidence_hash,
    transfer.request_id, transfer.request_item_index,
    transfer.order_id, transfer.account_id, transfer.recipient_address,
    transfer.token_address, transfer.amount::text, transfer.transfer_calldata,
    transfer.content_hash, transfer.gas_cap::text, transfer.state,
    transfer.created_by, transfer.created_at, transfer.submitted_at, transfer.settled_at,
    (SELECT attempt.execution_tx_hash FROM core.settlement_transfer_attempts attempt
     WHERE attempt.transfer_id = transfer.transfer_id AND attempt.execution_tx_hash IS NOT NULL
     ORDER BY attempt.attempt_number DESC LIMIT 1) AS execution_tx_hash
    FROM core.settlement_transfers transfer
    JOIN core.settlement_requests request ON request.request_id = transfer.request_id`;
}

function adminTransferDetailSelect() {
  return `SELECT transfer.transfer_id, transfer.artifact_version, transfer.chain_id,
    transfer.asset, transfer.executor_wallet, transfer.executor_nonce::text,
    transfer.nonce_state, transfer.nonce_release_evidence_hash,
    transfer.request_id, transfer.request_item_index, transfer.order_id, transfer.account_id,
    transfer.recipient_address, transfer.token_address, transfer.amount::text,
    transfer.transfer_calldata, transfer.content_hash, transfer.gas_cap::text,
    transfer.token_code_hash, transfer.token_transfer_conformance_evidence_hash,
    transfer.runtime_evidence_hash, transfer.runtime_checked_at, transfer.state,
    transfer.created_by, transfer.created_at, transfer.submitted_at, transfer.settled_at,
    (SELECT attempt.execution_tx_hash FROM core.settlement_transfer_attempts attempt
     WHERE attempt.transfer_id = transfer.transfer_id AND attempt.execution_tx_hash IS NOT NULL
     ORDER BY attempt.attempt_number DESC LIMIT 1) AS execution_tx_hash
    FROM core.settlement_transfers transfer`;
}

function adminTransferProjection(row: AdminSettlementTransferRow) {
  return {
    transferId: row.transfer_id,
    asset: row.asset,
    executorWallet: row.executor_wallet,
    executorNonce: row.executor_nonce,
    nonceState: row.nonce_state,
    nonceReleaseEvidenceHash: row.nonce_release_evidence_hash,
    requestId: row.request_id,
    requestItemIndex: row.request_item_index,
    orderId: row.order_id,
    accountId: row.account_id,
    recipientAddress: row.recipient_address,
    tokenAddress: row.token_address,
    amount: row.amount,
    transferCalldata: row.transfer_calldata,
    contentHash: row.content_hash,
    gasCap: row.gas_cap,
    executionTxHash: row.execution_tx_hash,
    state: row.state,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
    submittedAt: nullableTimestamp(row.submitted_at),
    settledAt: nullableTimestamp(row.settled_at),
  };
}

function adminFinalityProjection(row: AdminSettlementFinalityRow) {
  return {
    transactionId: row.transaction_id,
    expectedEventHash: row.expected_event_hash,
    executionTxHash: row.tx_hash,
    replacementForTxHash: row.replacement_for_tx_hash,
    receiptStatus: row.receipt_status,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    confirmations: row.confirmations,
    requiredConfirmations: row.required_confirmations,
    state: row.state,
    evidence: row.evidence,
    submittedAt: timestamp(row.submitted_at),
    finalizedAt: nullableTimestamp(row.finalized_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function adminCoverageProjection(row: AdminSettlementCoverageRow) {
  return {
    snapshotId: row.snapshot_id,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    evidenceHash: row.evidence_hash,
    recordedAt: timestamp(row.recorded_at),
    executorWallet: row.executor_wallet,
    asset: row.asset,
    verifiedAssets: row.verified_asset_balance,
    unsettledLiabilities: row.unsettled_liability,
    covered: row.coverage_met,
  };
}

function timestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CoreError('UnknownState', 'Settlement timestamp is invalid', 409);
  return date.toISOString();
}

function nullableTimestamp(value: Date | string | null) {
  return value === null ? null : timestamp(value);
}

function requireHash(value: string, name: string) {
  if (!isHash(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return value.toLowerCase();
}

async function loadTransferProjection(executor: SqlExecutor, transferId: string) {
  const transfer = await executor.query<AdminSettlementTransferDetailRow>(
    `${adminTransferDetailSelect()} WHERE transfer.transfer_id = $1`,
    [transferId],
  );
  if (!transfer.rows[0]) throw new CoreError('InvalidRequest', 'Settlement transfer not found', 404);
  return adminTransferProjection(transfer.rows[0]);
}

function assertRole(actor: FulfillmentActor, ...roles: FulfillmentActor['roles'][number][]) {
  if (!roles.some((role) => actor.roles.includes(role))) {
    throw new CoreError('Forbidden', `${roles.join(' or ')} role is required`, 403);
  }
}

function validateAmount(value: string) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new CoreError('InvalidRequest', 'Settlement amount is invalid');
}

function validateIdempotencyKey(value: string) {
  if (value.length < 8 || value.length > 128) throw new CoreError('InvalidRequest', 'Idempotency key is invalid');
}

function normalizedAddress(value: string, name: string) {
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

function isGovernedApprovalReplay(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const constraint = typeof value.constraint === 'string' ? value.constraint : '';
  const message = typeof value.message === 'string' ? value.message : '';
  return value.code === '23505' && (
    constraint.includes('governed_settlement_intent_approvals')
    || message.includes('governed_settlement_intent_approvals')
  );
}
