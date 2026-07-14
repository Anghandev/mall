import { randomBytes } from 'node:crypto';
import { TypedDataEncoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  sensitiveActionTypes,
  verifySensitiveActionApproval,
  type SensitiveActionIntent,
} from '../api/auth.ts';
import {
  CORE_ARTIFACT_VERSION,
  NPL_ADDRESS,
  USDT_ADDRESS,
  type SettlementRail,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import {
  settlementIntentDigest,
  settlementRequestDomain,
  settlementRequestTypes,
  verifySettlementRequestSignature,
  type SettlementRequestIntent,
  type WalletDigestSignatureVerifier,
} from '../api/settlement-signing.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import { auditCorrelationId, auditSourceId, enqueueAudit } from './audit-service.ts';
import {
  MULTISEND_CALL_ONLY_ADDRESS,
  MULTISEND_CALL_ONLY_CODE_HASH,
  SAFE_L2_SINGLETON_ADDRESS,
  SAFE_L2_SINGLETON_CODE_HASH,
  SAFE_VERSION,
  buildSafeSettlementBatch,
  type SettlementTransferItem,
} from '../chain/safe-multisend.ts';

const INTENT_TTL_SECONDS = 5 * 60;
const RUNTIME_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;

interface AvailableSourceRow {
  order_id: string;
  account_id: string;
  backing_safe_address: string;
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
  safeAddress: string;
  nonce: string;
  deadline: string;
  signature: string;
}

interface IntentRow {
  intent_id: string;
  artifact_version: string;
  wallet_address: string;
  recipient_address: string;
  rail: SettlementRail;
  asset: 'USDT' | 'NPL';
  asset_address: string;
  safe_address: string;
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
  backing_safe_address: string;
  amount: string;
  item_hash: string;
  policy_version: string | number;
}

interface GovernedAvailableSourceRow {
  owner_id: string;
  backing_safe_address: string;
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
}

interface RequestProjectionRow extends Record<string, unknown> {
  request_id: string;
  state: 'REQUESTED' | 'BATCHED' | 'SETTLED' | 'RETRYABLE' | 'QUARANTINED';
}

interface BatchProjectionRow extends Record<string, unknown> {
  batch_id: string;
  state: string;
  total_amount: string;
  safe_tx_hash: string;
}

export interface SafeRuntimeEvidence {
  safeAddress: string;
  safeVersion: string;
  singletonAddress: string;
  singletonCodeHash: string;
  safeNonce: string;
  ownerSetHash: string;
  approvalThreshold: number;
  multisendAddress: string;
  multisendCodeHash: string;
  tokenCodeHash: string;
  tokenTransferConformanceEvidenceHash: string;
  evidenceHash: string;
  checkedAt: Date;
}

export class SettlementService {
  readonly #transactions: SqlTransactionRunner;
  readonly #contractWalletVerifier: WalletDigestSignatureVerifier | undefined;
  readonly #secondarySignerAddress: string | undefined;
  readonly #governanceVerifyingContract: string | undefined;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    contractWalletVerifier?: WalletDigestSignatureVerifier;
    secondarySignerAddress?: string;
    governanceVerifyingContract?: string;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#contractWalletVerifier = input.contractWalletVerifier;
    this.#secondarySignerAddress = input.secondarySignerAddress
      ? normalizedAddress(input.secondarySignerAddress, 'secondary signer')
      : undefined;
    this.#governanceVerifyingContract = input.governanceVerifyingContract
      ? normalizedAddress(input.governanceVerifyingContract, 'governance verifying contract')
      : undefined;
    this.#clock = input.clock ?? (() => new Date());
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
        return loadIntentProjection(executor, existing.rows[0]);
      }

      const rail = railDefinition(input.rail);
      const recipient = await authorizeSettlementOwner(executor, actor, wallet, input.rail);
      const sources = await availableSources(executor, wallet, actor.merchantId, input.rail);
      const selected = selectSources(sources, BigInt(input.amount));
      if (selected.items.length > 256) {
        throw new CoreError('InvalidRequest', 'Settlement intent exceeds the 256-item Safe batch limit');
      }
      const now = this.#clock();
      const deadline = new Date(now.getTime() + INTENT_TTL_SECONDS * 1000);
      const nonce = await allocateNonce(executor, wallet);
      const intentId = randomHash();
      const items = selected.items.map((item, index) => ({
        itemIndex: index,
        orderId: item.order_id,
        accountId: item.account_id,
        backingSafeAddress: item.backing_safe_address,
        amount: item.selectedAmount,
        itemHash: hashJson({
          intentId,
          itemIndex: index,
          orderId: item.order_id,
          accountId: item.account_id,
          backingSafeAddress: item.backing_safe_address,
          amount: item.selectedAmount,
        }),
      }));
      const itemsHash = hashJson(items);
      const intent: SettlementRequestIntent = {
        intentId,
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        recipient,
        rail: input.rail,
        asset: rail.assetAddress,
        safeAddress: selected.safeAddress,
        amount: input.amount,
        itemsHash,
        nonce,
        deadline: Math.floor(deadline.getTime() / 1000),
      };
      const digest = settlementIntentDigest(intent).toLowerCase();
      await executor.query(
        `INSERT INTO core.settlement_intents (
           intent_id, artifact_version, wallet_address, recipient_address, rail,
           asset, asset_address, safe_address, amount, items_hash, intent_digest,
           nonce, deadline, state, idempotency_key, request_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ISSUED',$14,$15,$16)`,
        [
          intentId,
          CORE_ARTIFACT_VERSION,
          wallet,
          recipient,
          input.rail,
          rail.asset,
          rail.assetAddress,
          selected.safeAddress,
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
             intent_id, item_index, order_id, account_id, backing_safe_address, amount, item_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            intentId,
            item.itemIndex,
            item.orderId,
            item.accountId,
            item.backingSafeAddress,
            item.amount,
            item.itemHash,
          ],
        );
      }
      await enqueueSettlementAuthorizationAudit(executor, {
        eventType: 'SettlementIntentIssued',
        resourceType: 'SETTLEMENT_INTENT',
        resourceId: intentId,
        actor,
        wallet,
        correlationId: auditCorrelationId(input.correlationId),
        requestHash,
        payload: {
          rail: input.rail,
          recipient,
          safeAddress: selected.safeAddress,
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
        safeAddress: approvalIntent.safeAddress,
      });
      if (BigInt(source.amount) < BigInt(input.amount)) {
        throw new CoreError('FinalityPending', 'Governed settlement balance is insufficient', 409);
      }
      if (input.rail === 'OPERATIONS_REIMBURSEMENT_USDT' && recipient !== source.owner_id) {
        throw new CoreError('InvalidRequest', 'Operations reimbursement must return to the Operations Safe');
      }
      const oldValueHash = hashJson({
        accountId: input.accountId,
        availableAmount: source.amount,
        backingSafeAddress: source.backing_safe_address,
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
        || normalizedAddress(approvalIntent.safeAddress, 'approved Safe') !== source.backing_safe_address
      ) throw new CoreError('InvalidSignature', 'Secondary approval does not match the governed settlement', 401);
      const verified = verifySensitiveActionApproval(
        approvalIntent,
        input.approval.signature,
        secondarySigner,
        source.backing_safe_address,
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
      const deadline = new Date(now.getTime() + INTENT_TTL_SECONDS * 1000);
      const nonce = await allocateNonce(executor, wallet);
      const intentId = randomHash();
      const item = {
        itemIndex: 0,
        orderId: input.orderId,
        accountId: input.accountId,
        backingSafeAddress: source.backing_safe_address,
        amount: input.amount,
        itemHash: hashJson({
          intentId,
          itemIndex: 0,
          orderId: input.orderId,
          accountId: input.accountId,
          backingSafeAddress: source.backing_safe_address,
          amount: input.amount,
        }),
      };
      const itemsHash = hashJson([item]);
      const intent: SettlementRequestIntent = {
        intentId,
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        recipient,
        rail: input.rail,
        asset: USDT_ADDRESS,
        safeAddress: source.backing_safe_address,
        amount: input.amount,
        itemsHash,
        nonce,
        deadline: Math.floor(deadline.getTime() / 1000),
      };
      const digest = settlementIntentDigest(intent).toLowerCase();
      await executor.query(
        `INSERT INTO core.settlement_intents (
           intent_id, artifact_version, wallet_address, recipient_address, rail,
           asset, asset_address, safe_address, amount, items_hash, intent_digest,
           nonce, deadline, state, idempotency_key, request_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,'USDT',$6,$7,$8,$9,$10,$11,$12,'ISSUED',$13,$14,$15)`,
        [
          intentId,
          CORE_ARTIFACT_VERSION,
          wallet,
          recipient,
          input.rail,
          USDT_ADDRESS,
          source.backing_safe_address,
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
           intent_id, item_index, order_id, account_id, backing_safe_address, amount, item_hash
         ) VALUES ($1,0,$2,$3,$4,$5,$6)`,
        [intentId, item.orderId, item.accountId, item.backingSafeAddress, item.amount, item.itemHash],
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
          safeAddress: source.backing_safe_address,
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
      this.#contractWalletVerifier,
    );
    if (verified.digest.toLowerCase() !== snapshot.intent.intent_digest) {
      throw new CoreError('InvalidSignature', 'Settlement intent digest does not match the immutable record', 401);
    }

    return this.#transactions.transaction(async (executor) => {
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
      await authorizeSettlementOwner(executor, actor, wallet, intent.rail);
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

      const requestId = hashJson({ intentId: intent.intent_id, digest: intent.intent_digest });
      const signatureHash = keccak256(input.signature).toLowerCase();
      await executor.query(
        `INSERT INTO core.settlement_requests (
           request_id, intent_id, artifact_version, wallet_address, recipient_address,
           rail, asset, asset_address, safe_address, amount, items_hash, intent_digest,
           signature, signature_hash, state, requested_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'REQUESTED',$15)`,
        [
          requestId,
          intent.intent_id,
          intent.artifact_version,
          intent.wallet_address,
          intent.recipient_address,
          intent.rail,
          intent.asset,
          intent.asset_address,
          intent.safe_address,
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
        const lines = stateMoveLines(item.account_id, item.amount, 'AVAILABLE', 'REQUESTED', intent.safe_address);
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
             request_id, item_index, order_id, account_id, backing_safe_address,
             amount, requested_journal_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            requestId,
            item.item_index,
            item.order_id,
            item.account_id,
            item.backing_safe_address,
            item.amount,
            journalId,
          ],
        );
        await executor.query(
          `INSERT INTO core.settlement_request_item_transitions (
             transition_id, request_id, request_item_index, batch_id,
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
        actorWallet: wallet,
        actorRole: actor.roles[0]!,
        correlationId: auditCorrelationId(input.correlationId),
        requestHash: intent.intent_digest.slice(2),
        payload: {
          intentId: intent.intent_id,
          rail: intent.rail,
          safeAddress: intent.safe_address,
          recipient: intent.recipient_address,
          amount: intent.amount,
          itemsHash: intent.items_hash,
        },
        signatureEvidence: {
          scheme: verified.scheme,
          signatureHash,
          signer: wallet,
          digest: verified.digest,
          domain: settlementAuditDomain(intent.safe_address),
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

  createBatch(
    actor: FulfillmentActor,
    input: {
      asset: 'USDT' | 'NPL';
      idempotencyKey: string;
      runtime: SafeRuntimeEvidence;
      correlationId?: string;
    },
  ) {
    assertRole(actor, 'ADMIN', 'OPERATOR');
    validateIdempotencyKey(input.idempotencyKey);
    const runtime = validateSafeRuntime(input.runtime, this.#clock);
    const tokenAddress = input.asset === 'USDT' ? USDT_ADDRESS : NPL_ADDRESS;
    return this.#transactions.transaction(async (executor) => {
      const existing = await executor.query<{ batch_id: string }>(
        'SELECT batch_id FROM core.settlement_batches WHERE idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing.rows[0]) return loadBatchProjection(executor, existing.rows[0].batch_id);
      await assertBatchCreationAvailable(executor, runtime.safeAddress, input.asset, this.#clock);
      const requestedItems = await executor.query<RequestedItemRow>(
        `SELECT request.request_id, item.item_index AS request_item_index,
           item.order_id, item.account_id, request.recipient_address, item.amount,
           request.requested_at, orders.policy_version
         FROM core.settlement_requests request
         JOIN core.settlement_request_items item ON item.request_id = request.request_id
         JOIN core.orders orders ON orders.order_id = item.order_id
         LEFT JOIN core.merchants merchant ON merchant.merchant_id = orders.merchant_id
         WHERE request.state IN ('REQUESTED','RETRYABLE') AND request.safe_address = $1
           AND request.asset = $2 AND item.batched_journal_id IS NULL
           AND NOT (
             request.rail = 'MERCHANT_USDT'
             AND (merchant.status <> 'APPROVED' OR merchant.guarantee_status <> 'READY')
           )
         ORDER BY request.requested_at, request.request_id, item.item_index
         LIMIT 256
         FOR UPDATE OF request, item`,
        [runtime.safeAddress, input.asset],
      );
      if (requestedItems.rows.length === 0) {
        throw new CoreError('FinalityPending', 'No eligible requested settlement items are available', 409);
      }
      const batchItems = await completeRequestItems(executor, requestedItems.rows);
      if (batchItems.length === 0) {
        throw new CoreError('FinalityPending', 'No complete settlement request fits the Safe batch limit', 409);
      }
      await lockLedgerAccounts(executor, batchItems.map((item) => item.account_id));
      await assertRequestedStateBalances(executor, batchItems);
      const batchId = randomHash();
      const transferItems: SettlementTransferItem[] = batchItems.map((item) => ({
        orderId: item.order_id,
        requestId: item.request_id,
        requestItemIndex: item.request_item_index,
        accountId: item.account_id,
        tokenAddress,
        recipientAddress: item.recipient_address,
        amount: item.amount,
      }));
      const batch = buildSafeSettlementBatch({
        batchId,
        safeAddress: runtime.safeAddress,
        safeNonce: runtime.safeNonce,
        items: transferItems,
      });
      await executor.query(
        `INSERT INTO core.settlement_batches (
           batch_id, artifact_version, chain_id, asset, asset_address, safe_address,
           safe_version, safe_singleton_address, safe_singleton_code_hash, safe_nonce,
           owner_set_hash, safe_runtime_evidence_hash, safe_runtime_checked_at,
           multisend_address, multisend_code_hash, token_code_hash,
           token_transfer_conformance_evidence_hash, item_count, total_amount,
           items_hash, content_hash, idempotency_key, multisend_transactions,
           multisend_calldata, safe_tx_data, safe_tx_hash, safe_tx_gas, base_gas,
           gas_price, gas_token, refund_receiver, state, approval_threshold,
           created_by, created_at
         ) VALUES (
           $1,$2,56,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
           $19,$20,$21,$22,$23,$24,$25,0,0,0,$26,$26,'APPROVAL_PENDING',$27,$28,$29
         )`,
        [
          batchId,
          CORE_ARTIFACT_VERSION,
          input.asset,
          tokenAddress,
          runtime.safeAddress,
          runtime.safeVersion,
          runtime.singletonAddress,
          runtime.singletonCodeHash,
          runtime.safeNonce,
          runtime.ownerSetHash,
          runtime.evidenceHash,
          runtime.checkedAt,
          runtime.multisendAddress,
          runtime.multisendCodeHash,
          runtime.tokenCodeHash,
          runtime.tokenTransferConformanceEvidenceHash,
          batch.itemCount,
          batch.totalAmount,
          batch.itemsHash,
          batch.contentHash,
          input.idempotencyKey,
          batch.multisendTransactions,
          batch.multisendCalldata,
          batch.safeTransaction.data,
          batch.safeTxHash,
          '0x0000000000000000000000000000000000000000',
          runtime.approvalThreshold,
          normalizedAddress(actor.walletAddress, 'batch creator'),
          this.#clock(),
        ],
      );
      await executor.query(
        `INSERT INTO core.safe_nonce_reservations (
           safe_address, safe_nonce, batch_id, content_hash, state, reserved_at
         ) VALUES ($1,$2,$3,$4,'RESERVED',$5)`,
        [runtime.safeAddress, runtime.safeNonce, batchId, batch.contentHash, this.#clock()],
      );
      for (const [index, item] of batchItems.entries()) {
        const builtItem = batch.items[index]!;
        await executor.query(
          `INSERT INTO core.settlement_batch_items (
             batch_id, item_index, request_id, request_item_index, order_id, account_id,
             recipient_address, token_address, amount, transfer_calldata, item_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            batchId,
            index,
            item.request_id,
            item.request_item_index,
            item.order_id,
            item.account_id,
            builtItem.recipientAddress,
            builtItem.tokenAddress,
            item.amount,
            builtItem.transferCalldata,
            builtItem.itemHash,
          ],
        );
        const journalId = `journal:settlement-batch:${batchId}:${index}`;
        const lines = stateMoveLines(item.account_id, item.amount, 'REQUESTED', 'BATCHED', runtime.safeAddress);
        await postSettlementJournal(executor, {
          journalId,
          eventKey: `settlement-batch:${batchId}:${index}`,
          eventType: 'SETTLEMENT_BATCHED',
          resourceType: 'SETTLEMENT_BATCH',
          resourceId: batchId,
          orderId: item.order_id,
          policyVersion: Number(item.policy_version),
          contentHash: hashJson({ batchId, contentHash: batch.contentHash, itemIndex: index, lines }),
          sourceKind: 'SAFE_BATCH',
          sourceReferenceHash: batch.contentHash,
          payload: { batchId, requestId: item.request_id, itemIndex: index },
          lines,
        });
        await executor.query(
          `UPDATE core.settlement_request_items SET batched_journal_id = $3
           WHERE request_id = $1 AND item_index = $2 AND batched_journal_id IS NULL`,
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
             'BATCHED',$5,$6
           )`,
          [
            `transition:${journalId}`,
            item.request_id,
            item.request_item_index,
            batchId,
            journalId,
            this.#clock(),
          ],
        );
      }
      const requestIds = [...new Set(batchItems.map((item) => item.request_id))];
      for (const requestId of requestIds) {
        await executor.query(
          `UPDATE core.settlement_requests SET state = 'BATCHED', batch_id = $2,
             batched_at = $3 WHERE request_id = $1 AND state IN ('REQUESTED','RETRYABLE')`,
          [requestId, batchId, this.#clock()],
        );
      }
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
         ) VALUES ($1,'SETTLEMENT_BATCH',$2,'SettlementBatchApprovalRequested',$3,$1,'PENDING')`,
        [
          `outbox:settlement-batch:${batchId}`,
          batchId,
          JSON.stringify({ batchId, safeTxHash: batch.safeTxHash, contentHash: batch.contentHash }),
        ],
      );
      const now = this.#clock();
      await enqueueSettlementAuthorizationAudit(executor, {
        eventType: 'SettlementBatchCreated',
        resourceType: 'SETTLEMENT_BATCH',
        resourceId: batchId,
        actor,
        wallet: normalizedAddress(actor.walletAddress, 'batch creator'),
        correlationId: auditCorrelationId(input.correlationId),
        requestHash: batch.contentHash,
        payload: {
          asset: input.asset,
          safeAddress: runtime.safeAddress,
          safeNonce: runtime.safeNonce,
          safeTxHash: batch.safeTxHash,
          contentHash: batch.contentHash,
          itemCount: batch.itemCount,
          totalAmount: batch.totalAmount,
          runtimeEvidenceHash: runtime.evidenceHash,
        },
        now,
      });
      return loadBatchProjection(executor, batchId);
    });
  }
}

async function enqueueSettlementAuthorizationAudit(executor: SqlExecutor, input: {
  eventType: string;
  resourceType: string;
  resourceId: string;
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
    checkedAt: input.now.toISOString(),
  });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:settlement-authorization', {
      eventType: input.eventType,
      resourceId: input.resourceId,
      requestHash: input.requestHash,
    }),
    streamName: 'financial',
    evidenceProfile: 'AUTHORIZATION',
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
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

function settlementAuditDomain(safeAddress: string) {
  return `Abu24KV2Settlement:2:56:${normalizedAddress(safeAddress, 'settlement Safe')}`;
}

function railDefinition(rail: SettlementRail) {
  if (rail === 'REWARD_NPL') {
    return { asset: 'NPL' as const, assetAddress: NPL_ADDRESS, purpose: 'REWARD_LIABILITY' };
  }
  if (rail === 'PRIZE_USDT') {
    return { asset: 'USDT' as const, assetAddress: USDT_ADDRESS, purpose: 'SECKILL_PRIZE_LIABILITY' };
  }
  if (rail === 'MERCHANT_USDT') {
    return { asset: 'USDT' as const, assetAddress: USDT_ADDRESS, purpose: 'MERCHANT_RECEIVABLE' };
  }
  if (rail === 'TAKEOVER_USDT') {
    return { asset: 'USDT' as const, assetAddress: USDT_ADDRESS, purpose: 'TAKEOVER_PAYABLE' };
  }
  if (rail === 'OPERATIONS_REIMBURSEMENT_USDT') {
    return { asset: 'USDT' as const, assetAddress: USDT_ADDRESS, purpose: 'OPERATIONS_REIMBURSEMENT' };
  }
  throw new CoreError('InvalidRequest', 'Settlement rail is invalid');
}

async function authorizeSettlementOwner(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  wallet: string,
  rail: SettlementRail,
) {
  if (isGovernedRail(rail)) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'ARBITRATOR');
    return wallet;
  }
  if (rail !== 'MERCHANT_USDT') return wallet;
  if (!actor.roles.includes('MERCHANT')) throw new CoreError('Forbidden', 'Merchant role is required', 403);
  const merchant = await executor.query<{
    merchant_id: string;
    settlement_wallet: string;
    status: string;
    guarantee_status: string;
  }>(
    `SELECT merchant_id, settlement_wallet, status, guarantee_status
     FROM core.merchants
     WHERE settlement_wallet = $1 OR ($2::text IS NOT NULL AND merchant_id = $2)
     ORDER BY CASE WHEN settlement_wallet = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [wallet, actor.merchantId ?? null],
  );
  const row = merchant.rows[0];
  if (!row || row.settlement_wallet.toLowerCase() !== wallet) {
    throw new CoreError('Forbidden', 'Merchant settlement wallet must sign the request', 403);
  }
  if (row.status !== 'APPROVED' || row.guarantee_status !== 'READY') {
    throw new CoreError('Forbidden', 'Merchant settlement is frozen', 403);
  }
  return row.settlement_wallet.toLowerCase();
}

async function availableSources(
  executor: SqlExecutor,
  wallet: string,
  merchantId: string | undefined,
  rail: SettlementRail,
) {
  const definition = railDefinition(rail);
  return (await executor.query<AvailableSourceRow>(
    `SELECT journal.order_id, line.account_id, line.backing_safe_address,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount,
       min(orders.created_at) AS created_at, min(orders.policy_version) AS policy_version
     FROM core.ledger_lines line
     JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     JOIN core.orders orders ON orders.order_id = journal.order_id
     WHERE account.owner_id = $1 AND account.asset = $2 AND account.purpose = $3
       AND line.balance_state = 'AVAILABLE' AND line.backing_safe_address IS NOT NULL
       AND ($4::text IS NULL OR orders.merchant_id = $4)
     GROUP BY journal.order_id, line.account_id, line.backing_safe_address
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY min(orders.created_at), journal.order_id, line.account_id`,
    [wallet, definition.asset, definition.purpose, rail === 'MERCHANT_USDT' ? merchantId ?? null : null],
  )).rows;
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
    safeAddress: normalizedAddress(input.safeAddress, 'approved Safe'),
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
    safeAddress: string;
  },
) {
  const result = input.rail === 'TAKEOVER_USDT'
    ? await executor.query<GovernedAvailableSourceRow>(
      `SELECT account.owner_id, line.backing_safe_address,
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
         AND line.balance_state = 'AVAILABLE' AND line.backing_safe_address = $5
       GROUP BY account.owner_id, line.backing_safe_address,
         takeover.policy_version, orders.fulfillment_target_hash
       HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0`,
      [input.accountId, input.resourceId, input.orderId, input.fulfillmentTargetHash, input.safeAddress],
    )
    : await executor.query<GovernedAvailableSourceRow>(
      `SELECT account.owner_id, line.backing_safe_address,
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
         AND recovery.operations_safe_address = takeover.platform_advance_safe_address
         AND account.owner_id = recovery.operations_safe_address
         AND account.asset = 'USDT' AND account.purpose = 'OPERATIONS_REIMBURSEMENT'
         AND line.balance_state = 'AVAILABLE'
         AND line.backing_safe_address = recovery.backing_safe_address
         AND line.backing_safe_address = $4
       GROUP BY account.owner_id, line.backing_safe_address, orders.policy_version,
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
      [input.accountId, input.resourceId, input.orderId, input.safeAddress],
    );
  if (result.rows.length !== 1) {
    throw new CoreError('FinalityPending', 'Governed settlement source is unavailable or ambiguous', 409);
  }
  return {
    ...result.rows[0]!,
    owner_id: result.rows[0]!.owner_id.toLowerCase(),
    backing_safe_address: result.rows[0]!.backing_safe_address.toLowerCase(),
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
  }>(
    `SELECT takeover.case_id, takeover.order_id, takeover.policy_version,
       lower(orders.fulfillment_target_hash) AS fulfillment_target_hash
     FROM core.takeover_cases takeover
     JOIN core.orders orders ON orders.order_id = takeover.order_id
     JOIN core.fulfillment_targets target
       ON lower(target.target_hash) = lower(orders.fulfillment_target_hash)
     WHERE takeover.case_id = $1 AND takeover.order_id = $2
       AND takeover.policy_version = $3
       AND lower(orders.fulfillment_target_hash) = lower($4)
     FOR UPDATE OF takeover`,
    [input.caseId, input.orderId, input.policyVersion, input.fulfillmentTargetHash],
  );
  if (!authority.rows[0]) {
    throw new CoreError('InvalidFinality', 'Takeover replacement fulfillment target is not authoritative', 409);
  }
  const existing = await executor.query<TakeoverReplacementSnapshotRow>(
    'SELECT * FROM core.takeover_replacement_fulfillment_snapshots WHERE case_id = $1',
    [input.caseId],
  );
  const snapshotContent = {
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
       snapshot_id, case_id, order_id, recipient_address, fulfillment_target_hash,
       policy_version, snapshot_hash, created_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      snapshotId,
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
    const safe = row.backing_safe_address.toLowerCase();
    groups.set(safe, [...(groups.get(safe) ?? []), { ...row, backing_safe_address: safe }]);
  }
  const eligible = [...groups.entries()]
    .map(([safeAddress, items]) => ({
      safeAddress,
      items,
      total: items.reduce((sum, item) => sum + BigInt(item.amount), 0n),
      first: new Date(items[0]!.created_at).getTime(),
    }))
    .filter((group) => group.total >= requested)
    .sort((left, right) => left.first - right.first || left.safeAddress.localeCompare(right.safeAddress));
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
  return { safeAddress: selectedGroup.safeAddress, items };
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

async function completeRequestItems(executor: SqlExecutor, rows: RequestedItemRow[]) {
  const requestIds = [...new Set(rows.map((row) => row.request_id))];
  const counts = new Map<string, number>();
  for (const requestId of requestIds) {
    const result = await executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.settlement_request_items WHERE request_id = $1',
      [requestId],
    );
    counts.set(requestId, Number(result.rows[0]?.count ?? '0'));
  }
  const selected: RequestedItemRow[] = [];
  for (const requestId of requestIds) {
    const items = rows.filter((row) => row.request_id === requestId);
    if (items.length !== counts.get(requestId) || selected.length + items.length > 256) break;
    selected.push(...items);
  }
  return selected;
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
      backingSafeAddress: item.backing_safe_address,
      amount: item.amount,
    });
    if (expectedItemHash !== item.item_hash) {
      throw new CoreError('InvalidFinality', 'Settlement intent item content hash is invalid', 409);
    }
    return {
      itemIndex: item.item_index,
      orderId: item.order_id,
      accountId: item.account_id,
      backingSafeAddress: item.backing_safe_address,
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
    input.intent.safe_address,
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
    backingSafeAddress: item.backing_safe_address,
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
      domain: settlementRequestDomain(intent.safeAddress),
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
    safeAddress: row.safe_address,
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

async function assertRequestedStateBalances(executor: SqlExecutor, items: readonly RequestedItemRow[]) {
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
        `SELECT snapshot_id, case_id, order_id, recipient_address,
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
      safeAddress: intent.safe_address,
      ...(replacementSnapshot
        ? { fulfillmentTargetHash: replacementSnapshot.fulfillment_target_hash }
        : {}),
    });
    const approvalIntent = governedApprovalIntent(governedApproval.action_payload);
    const oldValueHash = hashJson({
      accountId: item.account_id,
      availableAmount: source.amount,
      backingSafeAddress: source.backing_safe_address,
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
      || item.backing_safe_address !== intent.safe_address
      || source.backing_safe_address !== intent.safe_address
      || BigInt(source.amount) < BigInt(item.amount)
      || approvalIntent.policyVersion !== BigInt(source.policy_version)
      || approvalIntent.action !== expectedAction
      || approvalIntent.resourceType !== expectedResourceType
      || approvalIntent.resourceId !== governedApproval.resource_id
      || approvalIntent.oldValueHash !== oldValueHash
      || approvalIntent.newValueHash !== newValueHash
      || approvalIntent.safeAddress !== intent.safe_address
      || approvalIntent.deadline < BigInt(Math.floor(now.getTime() / 1000))
    ) throw new CoreError('FinalityPending', 'Governed settlement source no longer matches its approval', 409);
    if (intent.rail === 'OPERATIONS_REIMBURSEMENT_USDT') {
      if (intent.recipient_address !== source.owner_id || governedApproval.replacement_fulfillment_snapshot_id) {
        throw new CoreError('InvalidFinality', 'Operations reimbursement recipient is not the snapshotted Operations Safe', 409);
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
       AND line.balance_state = 'AVAILABLE' AND line.backing_safe_address = $3
       AND account.owner_id = $4 AND account.asset = $5 AND account.purpose = $6`,
    [
      item.order_id,
      item.account_id,
      intent.safe_address,
      intent.wallet_address,
      definition.asset,
      definition.purpose,
    ],
  );
  if (BigInt(result.rows[0]?.amount ?? '0') < BigInt(item.amount)) {
    throw new CoreError('FinalityPending', 'Settlement source is no longer Available', 409);
  }
}

function stateMoveLines(
  accountId: string,
  amount: string,
  from: 'AVAILABLE' | 'REQUESTED' | 'BATCHED' | 'SETTLED',
  to: 'AVAILABLE' | 'REQUESTED' | 'BATCHED' | 'SETTLED',
  safeAddress: string,
) {
  return [
    {
      account_id: accountId,
      side: 'DEBIT',
      amount,
      balance_state: from,
      backing_safe_address: safeAddress,
    },
    {
      account_id: accountId,
      side: 'CREDIT',
      amount,
      balance_state: to,
      backing_safe_address: safeAddress,
    },
  ];
}

async function postSettlementJournal(
  executor: SqlExecutor,
  input: {
    journalId: string;
    eventKey: string;
    eventType: 'SETTLEMENT_REQUESTED' | 'SETTLEMENT_BATCHED' | 'SETTLEMENT_SETTLED' | 'SETTLEMENT_BATCH_REVERSED';
    resourceType: 'SETTLEMENT_REQUEST' | 'SETTLEMENT_BATCH';
    resourceId: string;
    orderId: string;
    policyVersion: number;
    contentHash: string;
    sourceKind: 'SIGNED_REQUEST' | 'SAFE_BATCH' | 'RECONCILIATION';
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
       rail, asset, asset_address, safe_address, amount::text, items_hash, intent_digest,
       signature_hash, state, batch_id, final_safe_tx_hash, final_execution_tx_hash,
       requested_at, batched_at, settled_at
     FROM core.settlement_requests WHERE request_id = $1`,
    [requestId],
  );
  if (!request.rows[0]) throw new CoreError('InvalidRequest', 'Settlement request not found', 404);
  const items = await executor.query<Record<string, unknown>>(
    `SELECT item_index, order_id, account_id, backing_safe_address, amount::text,
       requested_journal_id, batched_journal_id, settled_journal_id
     FROM core.settlement_request_items WHERE request_id = $1 ORDER BY item_index`,
    [requestId],
  );
  const transitions = await executor.query<Record<string, unknown>>(
    `SELECT transition_id, request_item_index, batch_id, transition_sequence,
       transition_type, journal_id, created_at
     FROM core.settlement_request_item_transitions
     WHERE request_id = $1 ORDER BY request_item_index, transition_sequence`,
    [requestId],
  );
  return { ...request.rows[0], items: items.rows, transitions: transitions.rows };
}

function validateSafeRuntime(value: SafeRuntimeEvidence, clock: () => Date) {
  const checkedAt = new Date(value.checkedAt);
  const now = clock();
  if (
    value.safeVersion !== SAFE_VERSION
    || normalizedAddress(value.singletonAddress, 'Safe singleton') !== SAFE_L2_SINGLETON_ADDRESS
    || value.singletonCodeHash.toLowerCase() !== SAFE_L2_SINGLETON_CODE_HASH
    || normalizedAddress(value.multisendAddress, 'MultiSendCallOnly') !== MULTISEND_CALL_ONLY_ADDRESS
    || value.multisendCodeHash.toLowerCase() !== MULTISEND_CALL_ONLY_CODE_HASH
    || !/^(0|[1-9][0-9]*)$/.test(value.safeNonce)
    || !Number.isSafeInteger(value.approvalThreshold)
    || value.approvalThreshold <= 0
    || !isHash(value.ownerSetHash)
    || !isHash(value.tokenCodeHash)
    || !isHash(value.tokenTransferConformanceEvidenceHash)
    || !isHash(value.evidenceHash)
    || !Number.isFinite(checkedAt.getTime())
    || checkedAt > now
    || now.getTime() - checkedAt.getTime() > RUNTIME_EVIDENCE_MAX_AGE_MS
  ) throw new CoreError('ExternalBlocked', 'Fresh verified Safe runtime evidence is unavailable', 503);
  return {
    ...value,
    safeAddress: normalizedAddress(value.safeAddress, 'Safe'),
    singletonAddress: normalizedAddress(value.singletonAddress, 'Safe singleton'),
    singletonCodeHash: value.singletonCodeHash.toLowerCase(),
    ownerSetHash: value.ownerSetHash.toLowerCase(),
    multisendAddress: normalizedAddress(value.multisendAddress, 'MultiSendCallOnly'),
    multisendCodeHash: value.multisendCodeHash.toLowerCase(),
    tokenCodeHash: value.tokenCodeHash.toLowerCase(),
    tokenTransferConformanceEvidenceHash: value.tokenTransferConformanceEvidenceHash.toLowerCase(),
    evidenceHash: value.evidenceHash.toLowerCase(),
    checkedAt,
  };
}

async function assertBatchCreationAvailable(
  executor: SqlExecutor,
  safeAddress: string,
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
  if (breaker.rows[0]?.blocked) throw new CoreError('BreakerActive', 'New settlement batches are paused', 409);
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
       WHERE item.safe_address = $1 AND item.asset = $2
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
    [safeAddress, asset],
  );
  const row = coverage.rows[0];
  const now = clock();
  if (
    !row
    || !row.canonical
    || !row.coverage_met
    || now.getTime() - new Date(row.recorded_at).getTime() > RUNTIME_EVIDENCE_MAX_AGE_MS
  ) throw new CoreError('ExternalBlocked', 'Fresh Safe coverage evidence is unavailable', 503);
}

async function loadBatchProjection(executor: SqlExecutor, batchId: string) {
  const batch = await executor.query<BatchProjectionRow>(
    `SELECT batch_id, artifact_version, chain_id, asset, asset_address, safe_address,
       safe_version, safe_singleton_address, safe_singleton_code_hash, safe_nonce::text,
       owner_set_hash, safe_runtime_evidence_hash, safe_runtime_checked_at,
       multisend_address, multisend_code_hash, token_code_hash,
       token_transfer_conformance_evidence_hash, item_count, total_amount::text,
       items_hash, content_hash, safe_tx_hash, state, approval_threshold,
       created_by, created_at, approved_at, submitted_at, settled_at
     FROM core.settlement_batches WHERE batch_id = $1`,
    [batchId],
  );
  if (!batch.rows[0]) throw new CoreError('InvalidRequest', 'Settlement batch not found', 404);
  const items = await executor.query<Record<string, unknown>>(
    `SELECT item_index, request_id, request_item_index, order_id, account_id,
       recipient_address, token_address, amount::text, item_hash
     FROM core.settlement_batch_items WHERE batch_id = $1 ORDER BY item_index`,
    [batchId],
  );
  return { ...batch.rows[0], items: items.rows };
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
