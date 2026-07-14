import { randomBytes } from 'node:crypto';
import { AbiCoder, MaxUint256, getAddress, keccak256 } from 'ethers';
import {
  buildDualPaymentQuote,
  buildPaymentIntent,
  type CanonicalPaymentIntent,
} from '../api/checkout.ts';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { buildOtherUsdtAllocations, parsePaymentPolicySnapshot } from '../api/payment-policy.ts';
import type { PaymentPolicySnapshot } from '../api/payment-policy.ts';
import {
  paymentAuthorizationDigest,
  paymentIntentHash,
  paymentWalletAuthorization,
  seckillAuthorizationDigest,
  seckillIntentHash,
  seckillWalletAuthorization,
  toRouterPaymentIntent,
  toRouterSeckillIntent,
  type CanonicalSeckillIntent,
} from '../api/payment-signing.ts';
import type { SignerRequest } from '../chain/signer.ts';
import { reserveInventory } from './inventory.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

export interface QuoteSigner {
  sign(request: SignerRequest): Promise<{ signature: string; signer: string }>;
}

export interface PaymentOracleQuoteSource {
  quote(input: {
    listPriceUsdt: bigint;
    policyVersion: number;
    oracleVersion: string;
  }): Promise<{ nplQuoteAmount: bigint; oracleVersion: string }>;
}

export interface BeneficiarySnapshotSource {
  resolve(input: {
    buyer: string;
    merchant: string;
    regionCodeHash: string;
    policyVersion: number;
  }): Promise<Readonly<Record<string, string>>>;
}

export interface PaymentPolicyAttestationSource {
  assertPublished(input: {
    artifactVersion: string;
    policyHash: string;
    rulesContentHash: string;
    beneficiarySetHash: string;
    policy: PaymentPolicySnapshot;
    requireLatest: boolean;
  }): Promise<void>;
}

export interface CreateOrdinaryQuoteInput {
  idempotencyKey: string;
  productId: string;
  skuId: string;
  quantity: number;
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  fulfillmentTargetHash: string;
  regionCodeHash: string;
}

export interface CreateSeckillQuoteInput extends CreateOrdinaryQuoteInput {
  sessionId: string;
}

interface CatalogRow {
  product_id: string;
  chain_product_id: string;
  merchant_id: string;
  title: string;
  product_policy_hash: string;
  merchant_concession_bps: number;
  metadata: unknown;
  product_state: string;
  sku_id: string;
  chain_sku_id: string;
  attributes: unknown;
  list_price_usdt: string;
  merchant_cost_usdt: string;
  stock_available: string | number;
  sku_state: string;
  settlement_wallet: string;
  merchant_status: string;
  guarantee_status: string;
}

interface PolicyRow {
  artifact_version: string;
  policy_version: string;
  policy_hash: string;
  oracle_version: string;
  rules_content_hash: string;
  beneficiary_set_hash: string;
  payload: unknown;
}

interface SessionRow {
  session_id: string;
  policy_version: string;
  product_policy_hash: string;
  seckill_list_price_usdt: string;
  phase: string;
  starts_at: Date;
  main_deadline: Date;
  relay_deadline: Date;
  available: string | number;
}

interface StoredQuoteRow {
  order_id: string;
  product_id: string;
  sku_id: string;
  authorization_digest: string;
  quote_signature: string;
  deadline: Date;
  state: string;
  submitted_tx_hash: string | null;
  intent: CanonicalPaymentIntent;
  snapshot_hash: string;
}

interface StoredSeckillQuoteRow extends StoredQuoteRow {
  session_id: string;
  classification: 'SECKILL' | 'FALLBACK_RETAIL';
}

interface StoredPaymentFinalityRow {
  transaction_hash: string;
  replacement_for_tx_hash: string | null;
  block_number: string | number;
  block_hash: string;
  confirmations: string | number;
  required_confirmations: string | number;
  receipt_status: 1;
  state: 'MINED' | 'REORGED' | 'FINAL';
  canonical: boolean;
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
}

export class CatalogPaymentService {
  readonly #transactions: SqlTransactionRunner;
  readonly #signer: QuoteSigner;
  readonly #oracle: PaymentOracleQuoteSource;
  readonly #beneficiaries: BeneficiarySnapshotSource;
  readonly #policies: PaymentPolicyAttestationSource;
  readonly #paymentRouterAddress: string;
  readonly #clock: () => Date;
  readonly #bytes32: () => string;
  readonly #nonce: () => bigint;

  constructor(input: {
    transactions: SqlTransactionRunner;
    signer: QuoteSigner;
    oracle: PaymentOracleQuoteSource;
    beneficiaries: BeneficiarySnapshotSource;
    policies: PaymentPolicyAttestationSource;
    paymentRouterAddress: string;
    clock?: () => Date;
    bytes32?: () => string;
    nonce?: () => bigint;
  }) {
    this.#transactions = input.transactions;
    this.#signer = input.signer;
    this.#oracle = input.oracle;
    this.#beneficiaries = input.beneficiaries;
    this.#policies = input.policies;
    try {
      this.#paymentRouterAddress = getAddress(input.paymentRouterAddress).toLowerCase();
    } catch {
      throw new CoreError('ExternalBlocked', 'PaymentRouter address is unavailable', 503);
    }
    this.#clock = input.clock ?? (() => new Date());
    this.#bytes32 = input.bytes32 ?? (() => `0x${randomBytes(32).toString('hex')}`);
    this.#nonce = input.nonce ?? (() => BigInt(`0x${randomBytes(32).toString('hex')}`));
  }

  listCatalog() {
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<CatalogRow>(`${catalogSelect()}
        WHERE product.lifecycle_state = 'ACTIVE' AND sku.lifecycle_state = 'ACTIVE'
          AND merchant.status = 'APPROVED' AND merchant.guarantee_status = 'READY'
        ORDER BY product.created_at DESC, product.product_id, sku.sku_id`);
      return catalogProjection(result.rows);
    });
  }

  getProduct(productId: string) {
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<CatalogRow>(`${catalogSelect()}
        WHERE product.product_id = $1 AND product.lifecycle_state = 'ACTIVE'
          AND sku.lifecycle_state = 'ACTIVE' AND merchant.status = 'APPROVED'
          AND merchant.guarantee_status = 'READY'
        ORDER BY sku.sku_id`, [productId]);
      const products = catalogProjection(result.rows);
      if (!products[0]) throw new CoreError('InvalidRequest', 'Product not found', 404);
      return products[0];
    });
  }

  async createOrdinaryQuote(buyerWallet: string, input: CreateOrdinaryQuoteInput) {
    const buyer = normalizeAddress(buyerWallet);
    validateCreateQuote(input);
    const existing = await this.#transactions.transaction(async (executor) => {
      const identity = await loadQuoteIdentity(executor, buyer, input.idempotencyKey);
      if (!identity) return undefined;
      if (identity.quote_kind !== 'ORDINARY') {
        throw new CoreError('IdempotencyConflict', 'Idempotency key belongs to a seckill quote', 409);
      }
      return loadExistingQuote(executor, buyer, input.idempotencyKey);
    });
    if (existing) return existingQuoteResponse(existing, input, this.#paymentRouterAddress);

    const prepared = await this.#transactions.transaction((executor) => loadPreparation(executor, input, this.#clock()));
    const policy = parsePaymentPolicySnapshot(
      Number(prepared.policy.policy_version),
      prepared.policy.oracle_version,
      prepared.policy.payload,
    );
    await this.#policies.assertPublished({
      artifactVersion: prepared.policy.artifact_version,
      policyHash: prepared.policy.policy_hash,
      rulesContentHash: prepared.policy.rules_content_hash,
      beneficiarySetHash: prepared.policy.beneficiary_set_hash,
      policy,
      requireLatest: true,
    });
    const now = Math.floor(this.#clock().getTime() / 1000);
    const orderId = this.#bytes32();
    const reservationId = this.#bytes32();
    const deadline = now + 5 * 60;
    const reservationDeadline = now + 10 * 60;
    const listPriceUsdt = BigInt(prepared.catalog.list_price_usdt) * BigInt(input.quantity);
    const merchantBaseReceivableUsdt = BigInt(prepared.catalog.merchant_cost_usdt) * BigInt(input.quantity);
    const oracle = await this.#oracle.quote({
      listPriceUsdt,
      policyVersion: policy.policyVersion,
      oracleVersion: policy.oracleVersion,
    });
    if (oracle.oracleVersion.toLowerCase() !== policy.oracleVersion.toLowerCase() || oracle.nplQuoteAmount <= 0n) {
      throw new CoreError('InvalidRequest', 'Oracle quote does not match the published policy');
    }
    const beneficiaries = await this.#beneficiaries.resolve({
      buyer,
      merchant: prepared.catalog.settlement_wallet,
      regionCodeHash: input.regionCodeHash,
      policyVersion: policy.policyVersion,
    });
    const reservationHash = keccak256(AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'address', 'uint32', 'uint64'],
      [reservationId, prepared.catalog.chain_sku_id, buyer, input.quantity, reservationDeadline],
    ));
    const intent = buildPaymentIntent({
      orderId,
      latestPolicyVersion: policy.policyVersion,
      buyer,
      merchant: prepared.catalog.settlement_wallet,
      productId: prepared.catalog.chain_product_id,
      skuId: prepared.catalog.chain_sku_id,
      quantity: input.quantity,
      fulfillmentMode: input.fulfillmentMode,
      fulfillmentTargetHash: input.fulfillmentTargetHash,
      regionCodeHash: input.regionCodeHash,
      productPolicyHash: prepared.catalog.product_policy_hash,
      reservationId,
      reservationHash,
      reservationDeadline,
      issuedAt: now,
      deadline,
      nonce: this.#nonce(),
      listPriceUsdt,
      nplQuoteAmount: oracle.nplQuoteAmount,
      merchantBaseReceivableUsdt,
      merchantConcessionBps: Number(prepared.catalog.merchant_concession_bps),
      otherUsdtAllocations: buildOtherUsdtAllocations(listPriceUsdt, merchantBaseReceivableUsdt, policy),
      beneficiaries,
    }, policy, 'ORDINARY', now);
    const snapshotHash = paymentIntentHash(intent);
    const digest = paymentAuthorizationDigest(intent, this.#paymentRouterAddress);
    const signed = await this.#signer.sign({
      purpose: 'ORDER_QUOTE',
      digest,
      resourceId: orderId,
      policyVersion: policy.policyVersion,
      deadline,
      idempotencyKey: `payment-quote:${buyer}:${input.idempotencyKey}`,
    });

    await this.#transactions.transaction(async (executor) => {
      const current = await loadPreparation(executor, input, this.#clock());
      if (preparationFingerprint(current) !== preparationFingerprint(prepared)) {
        throw new CoreError('IdempotencyConflict', 'Catalog or policy changed while quote was signed', 409);
      }
      await reserveInventory(executor, {
        reservationId,
        reservationHash,
        policyVersion: policy.policyVersion,
        skuId: prepared.catalog.sku_id,
        buyerWallet: buyer,
        quantity: input.quantity,
        classification: 'ORDINARY',
        expiresAt: new Date(reservationDeadline * 1000),
      });
      await insertQuote(executor, {
        buyer,
        idempotencyKey: input.idempotencyKey,
        catalog: prepared.catalog,
        policyVersion: policy.policyVersion,
        intent,
        digest,
        signature: signed.signature,
        snapshotHash,
      });
    });
    return quoteResponse(intent, digest, signed.signature, snapshotHash, this.#paymentRouterAddress, 'QUOTED', null);
  }

  async createSeckillQuote(buyerWallet: string, input: CreateSeckillQuoteInput) {
    const buyer = normalizeAddress(buyerWallet);
    validateCreateQuote(input);
    if (!isHash(input.sessionId)) throw new CoreError('InvalidRequest', 'Invalid seckill session ID');
    const existing = await this.#transactions.transaction(async (executor) => {
      const identity = await loadQuoteIdentity(executor, buyer, input.idempotencyKey);
      if (!identity) return undefined;
      if (identity.quote_kind !== 'SECKILL') {
        throw new CoreError('IdempotencyConflict', 'Idempotency key belongs to an ordinary quote', 409);
      }
      return loadExistingSeckillQuote(executor, buyer, input.idempotencyKey);
    });
    if (existing) return existingSeckillQuoteResponse(existing, input, this.#paymentRouterAddress);
    const prepared = await this.#transactions.transaction((executor) => loadSeckillPreparation(executor, input, this.#clock()));
    const policy = parsePaymentPolicySnapshot(
      Number(prepared.policy.policy_version),
      prepared.policy.oracle_version,
      prepared.policy.payload,
    );
    await this.#policies.assertPublished({
      artifactVersion: prepared.policy.artifact_version,
      policyHash: prepared.policy.policy_hash,
      rulesContentHash: prepared.policy.rules_content_hash,
      beneficiarySetHash: prepared.policy.beneficiary_set_hash,
      policy,
      requireLatest: false,
    });
    const now = Math.floor(this.#clock().getTime() / 1000);
    const orderId = this.#bytes32();
    const seckillReservationId = this.#bytes32();
    const fallbackReservationId = this.#bytes32();
    const deadline = now + 5 * 60;
    const reservationDeadline = now + 10 * 60;
    const merchantBaseReceivableUsdt = BigInt(prepared.catalog.merchant_cost_usdt) * BigInt(input.quantity);
    const seckillListPriceUsdt = BigInt(prepared.session.seckill_list_price_usdt) * BigInt(input.quantity);
    const fallbackListPriceUsdt = BigInt(prepared.catalog.list_price_usdt) * BigInt(input.quantity);
    const [seckillOracle, fallbackOracle, beneficiaries] = await Promise.all([
      this.#oracle.quote({
        listPriceUsdt: seckillListPriceUsdt,
        policyVersion: policy.policyVersion,
        oracleVersion: policy.oracleVersion,
      }),
      this.#oracle.quote({
        listPriceUsdt: fallbackListPriceUsdt,
        policyVersion: policy.policyVersion,
        oracleVersion: policy.oracleVersion,
      }),
      this.#beneficiaries.resolve({
        buyer,
        merchant: prepared.catalog.settlement_wallet,
        regionCodeHash: input.regionCodeHash,
        policyVersion: policy.policyVersion,
      }),
    ]);
    if (
      seckillOracle.oracleVersion.toLowerCase() !== policy.oracleVersion.toLowerCase()
        || fallbackOracle.oracleVersion.toLowerCase() !== policy.oracleVersion.toLowerCase()
        || seckillOracle.nplQuoteAmount <= 0n || fallbackOracle.nplQuoteAmount <= 0n
    ) throw new CoreError('InvalidRequest', 'Oracle quote does not match the seckill policy');
    const nonce = this.#nonce();
    const shared = {
      orderId,
      latestPolicyVersion: policy.policyVersion,
      buyer,
      merchant: prepared.catalog.settlement_wallet,
      productId: prepared.catalog.chain_product_id,
      skuId: prepared.catalog.chain_sku_id,
      quantity: input.quantity,
      fulfillmentMode: input.fulfillmentMode,
      fulfillmentTargetHash: input.fulfillmentTargetHash,
      regionCodeHash: input.regionCodeHash,
      productPolicyHash: prepared.catalog.product_policy_hash,
      reservationDeadline,
      issuedAt: now,
      deadline,
      nonce,
      merchantBaseReceivableUsdt,
      merchantConcessionBps: Number(prepared.catalog.merchant_concession_bps),
      beneficiaries,
    };
    const seckillReservationHash = reservationHash(
      seckillReservationId,
      prepared.catalog.chain_sku_id,
      buyer,
      input.quantity,
      reservationDeadline,
    );
    const fallbackReservationHash = reservationHash(
      fallbackReservationId,
      prepared.catalog.chain_sku_id,
      buyer,
      input.quantity,
      reservationDeadline,
    );
    const dual = buildDualPaymentQuote(
      {
        ...shared,
        sessionId: input.sessionId,
        reservationId: seckillReservationId,
        reservationHash: seckillReservationHash,
        listPriceUsdt: seckillListPriceUsdt,
        nplQuoteAmount: seckillOracle.nplQuoteAmount,
        otherUsdtAllocations: buildOtherUsdtAllocations(seckillListPriceUsdt, merchantBaseReceivableUsdt, policy),
      },
      {
        ...shared,
        reservationId: fallbackReservationId,
        reservationHash: fallbackReservationHash,
        listPriceUsdt: fallbackListPriceUsdt,
        nplQuoteAmount: fallbackOracle.nplQuoteAmount,
        otherUsdtAllocations: buildOtherUsdtAllocations(fallbackListPriceUsdt, merchantBaseReceivableUsdt, policy),
      },
      policy,
      now,
    );
    const digest = seckillAuthorizationDigest(dual, this.#paymentRouterAddress);
    const signed = await this.#signer.sign({
      purpose: 'ORDER_QUOTE',
      digest,
      resourceId: orderId,
      policyVersion: policy.policyVersion,
      deadline,
      idempotencyKey: `seckill-quote:${buyer}:${input.idempotencyKey}`,
    });
    await this.#transactions.transaction(async (executor) => {
      const current = await loadSeckillPreparation(executor, input, this.#clock());
      if (preparationFingerprint(current) !== preparationFingerprint(prepared)) {
        throw new CoreError('IdempotencyConflict', 'Seckill catalog or policy changed while quote was signed', 409);
      }
      await reserveInventory(executor, {
        reservationId: seckillReservationId,
        reservationHash: seckillReservationHash,
        policyVersion: policy.policyVersion,
        skuId: prepared.catalog.sku_id,
        buyerWallet: buyer,
        quantity: input.quantity,
        classification: 'SECKILL',
        sessionId: input.sessionId,
        expiresAt: new Date(reservationDeadline * 1000),
      });
      await reserveInventory(executor, {
        reservationId: fallbackReservationId,
        reservationHash: fallbackReservationHash,
        policyVersion: policy.policyVersion,
        skuId: prepared.catalog.sku_id,
        buyerWallet: buyer,
        quantity: input.quantity,
        classification: 'FALLBACK_RETAIL',
        expiresAt: new Date(reservationDeadline * 1000),
      });
      await insertSeckillQuote(executor, {
        buyer,
        idempotencyKey: input.idempotencyKey,
        catalog: prepared.catalog,
        policyVersion: policy.policyVersion,
        sessionId: input.sessionId,
        seckillUnitPrice: prepared.session.seckill_list_price_usdt,
        dual,
        digest,
        signature: signed.signature,
      });
    });
    return seckillQuoteResponse(dual, digest, signed.signature, this.#paymentRouterAddress, 'QUOTED', null);
  }

  submitPayment(buyerWallet: string, input: { orderId: string; txHash: string; replacementForTxHash?: string }) {
    const buyer = normalizeAddress(buyerWallet);
    if (!isHash(input.orderId) || !isHash(input.txHash) || (input.replacementForTxHash && !isHash(input.replacementForTxHash))) {
      throw new CoreError('InvalidRequest', 'Invalid payment submission');
    }
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<{ state: string; submitted_tx_hash: string | null }>(
        'SELECT state, submitted_tx_hash FROM core.payment_quotes WHERE order_id = $1 AND buyer_wallet = $2 FOR UPDATE',
        [input.orderId, buyer],
      );
      const quote = result.rows[0];
      if (!quote || !['QUOTED', 'SUBMITTED', 'REORGED'].includes(quote.state)) {
        throw new CoreError('InvalidRequest', 'Payment quote is not submittable', 409);
      }
      if (quote.submitted_tx_hash && quote.submitted_tx_hash.toLowerCase() !== input.txHash.toLowerCase()) {
        if (input.replacementForTxHash?.toLowerCase() !== quote.submitted_tx_hash.toLowerCase()) {
          throw new CoreError('IdempotencyConflict', 'Replacement transaction does not match the prior submission', 409);
        }
      }
      await executor.query(
        `UPDATE core.payment_quotes SET state = 'SUBMITTED', submitted_tx_hash = $2,
           submitted_at = COALESCE(submitted_at, clock_timestamp()), updated_at = clock_timestamp()
         WHERE order_id = $1`,
        [input.orderId, input.txHash.toLowerCase()],
      );
      return { orderId: input.orderId, txHash: input.txHash.toLowerCase(), state: 'SUBMITTED' as const };
    });
  }

  getPayment(buyerWallet: string, orderId: string) {
    const buyer = normalizeAddress(buyerWallet);
    if (!isHash(orderId)) throw new CoreError('InvalidRequest', 'Invalid order ID');
    return this.#transactions.transaction(async (executor) => {
      const identity = await loadStoredQuoteIdentity(executor, orderId, buyer);
      if (!identity) throw new CoreError('InvalidRequest', 'Payment not found', 404);
      const finality = await loadPaymentFinality(executor, orderId);
      if (identity.quote_kind === 'SECKILL') {
        const quotes = await loadStoredSeckillQuoteByOrder(executor, orderId, buyer);
        const seckill = quotes.find((row) => row.classification === 'SECKILL');
        const fallback = quotes.find((row) => row.classification === 'FALLBACK_RETAIL');
        if (!seckill || !fallback) throw new CoreError('InvalidFinality', 'Seckill quote legs are incomplete', 409);
        return {
          ...seckillQuoteResponse(
            {
              sessionId: seckill.session_id,
              seckill: seckill.intent,
              fallback: fallback.intent,
              classificationAuthority: 'PAYMENT_ROUTER_BLOCK_TIMESTAMP',
            },
            seckill.authorization_digest,
            seckill.quote_signature,
            this.#paymentRouterAddress,
            seckill.state,
            seckill.submitted_tx_hash,
          ),
          finality,
        };
      }
      const quote = await loadStoredQuote(executor, orderId, buyer);
      if (!quote) throw new CoreError('InvalidFinality', 'Ordinary quote leg is unavailable', 409);
      return {
        ...quoteResponse(
          quote.intent,
          quote.authorization_digest,
          quote.quote_signature,
          quote.snapshot_hash,
          this.#paymentRouterAddress,
          quote.state,
          quote.submitted_tx_hash,
        ),
        finality,
      };
    });
  }
}

async function loadPreparation(executor: SqlExecutor, input: CreateOrdinaryQuoteInput, now: Date) {
  const breaker = await executor.query<{ paused: boolean }>(
    "SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_PAYMENT'",
  );
  if (breaker.rows[0]?.paused) throw new CoreError('BreakerActive', 'New payments are paused', 409);
  const catalogResult = await executor.query<CatalogRow>(`${catalogSelect()}
    WHERE product.product_id = $1 AND sku.sku_id = $2`, [input.productId, input.skuId]);
  const catalog = catalogResult.rows[0];
  if (
    !catalog || catalog.product_state !== 'ACTIVE' || catalog.sku_state !== 'ACTIVE'
      || catalog.merchant_status !== 'APPROVED' || catalog.guarantee_status !== 'READY'
      || Number(catalog.stock_available) < input.quantity
  ) throw new CoreError('InventoryUnavailable', 'Product, merchant or inventory is unavailable', 409);
  const policyResult = await executor.query<PolicyRow>(
    `SELECT artifact_version, policy_version, policy_hash, oracle_version,
       rules_content_hash, beneficiary_set_hash, payload FROM core.policy_snapshots
     WHERE publication_status = 'PUBLISHED' AND (effective_from IS NULL OR effective_from <= $1)
     ORDER BY policy_version DESC LIMIT 1`,
    [now],
  );
  const policy = policyResult.rows[0];
  if (!policy) throw new CoreError('DecisionBlocked', 'No published payment policy is effective', 409);
  return { catalog, policy };
}

async function loadSeckillPreparation(executor: SqlExecutor, input: CreateSeckillQuoteInput, now: Date) {
  const breakers = await executor.query<{ scope: string }>(
    `SELECT scope FROM core.circuit_breakers
     WHERE paused AND scope IN ('NEW_PAYMENT', 'SECKILL_PURCHASE')`,
  );
  if (breakers.rows.length > 0) throw new CoreError('BreakerActive', 'Seckill payments are paused', 409);
  const catalogResult = await executor.query<CatalogRow>(`${catalogSelect()}
    WHERE product.product_id = $1 AND sku.sku_id = $2`, [input.productId, input.skuId]);
  const catalog = catalogResult.rows[0];
  if (
    !catalog || catalog.product_state !== 'ACTIVE' || catalog.sku_state !== 'ACTIVE'
      || catalog.merchant_status !== 'APPROVED' || catalog.guarantee_status !== 'READY'
      || Number(catalog.stock_available) < input.quantity
  ) throw new CoreError('InventoryUnavailable', 'Seckill fallback inventory is unavailable', 409);
  const sessionResult = await executor.query<SessionRow>(
    `SELECT session_id, policy_version, product_policy_hash, seckill_list_price_usdt::text,
       phase, starts_at, main_deadline, relay_deadline,
       (inventory - sold - reserved) AS available
     FROM core.seckill_sessions
     WHERE session_id = $1 AND product_id = $2 AND sku_id = $3 AND merchant_id = $4`,
    [input.sessionId, input.productId, input.skuId, catalog.merchant_id],
  );
  const session = sessionResult.rows[0];
  if (
    !session || session.phase !== 'LIVE' || new Date(session.starts_at) > now
      || new Date(session.main_deadline) <= now || new Date(session.relay_deadline) <= now
      || Number(session.available) < input.quantity
      || session.product_policy_hash.toLowerCase() !== catalog.product_policy_hash.toLowerCase()
  ) throw new CoreError('InventoryUnavailable', 'Seckill session is not live or has no inventory', 409);
  const policyResult = await executor.query<PolicyRow>(
    `SELECT artifact_version, policy_version, policy_hash, oracle_version,
       rules_content_hash, beneficiary_set_hash, payload FROM core.policy_snapshots
     WHERE policy_version = $1 AND publication_status = 'PUBLISHED'`,
    [session.policy_version],
  );
  const policy = policyResult.rows[0];
  if (!policy) throw new CoreError('DecisionBlocked', 'Seckill payment policy is unavailable', 409);
  return { catalog, policy, session };
}

async function insertQuote(
  executor: SqlExecutor,
  input: {
    buyer: string;
    idempotencyKey: string;
    catalog: CatalogRow;
    policyVersion: number;
    intent: CanonicalPaymentIntent;
    digest: string;
    signature: string;
    snapshotHash: string;
  },
) {
  await executor.query(
    `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id,
       merchant_wallet, product_id, sku_id, chain_product_id, chain_sku_id,
       product_policy_hash, list_price_usdt, merchant_cost_usdt, merchant_concession_bps,
       policy_version, quote_kind, authorization_digest, quote_signature, deadline, state
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ORDINARY',$16,$17,$18,'QUOTED')`,
    [
      input.intent.orderId,
      input.idempotencyKey,
      CORE_ARTIFACT_VERSION,
      input.buyer,
      input.catalog.merchant_id,
      input.catalog.settlement_wallet,
      input.catalog.product_id,
      input.catalog.sku_id,
      input.catalog.chain_product_id,
      input.catalog.chain_sku_id,
      input.catalog.product_policy_hash,
      input.catalog.list_price_usdt,
      input.catalog.merchant_cost_usdt,
      input.catalog.merchant_concession_bps,
      input.policyVersion,
      input.digest,
      input.signature,
      new Date(input.intent.deadline * 1000),
    ],
  );
  await executor.query(
    `INSERT INTO core.payment_quote_legs (
       order_id, classification, reservation_id, snapshot_hash, intent
     ) VALUES ($1,'ORDINARY',$2,$3,$4)`,
    [input.intent.orderId, input.intent.reservationId, input.snapshotHash, JSON.stringify(input.intent)],
  );
}

async function insertSeckillQuote(
  executor: SqlExecutor,
  input: {
    buyer: string;
    idempotencyKey: string;
    catalog: CatalogRow;
    policyVersion: number;
    sessionId: string;
    seckillUnitPrice: string;
    dual: CanonicalSeckillIntent;
    digest: string;
    signature: string;
  },
) {
  await executor.query(
    `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id,
       merchant_wallet, product_id, sku_id, chain_product_id, chain_sku_id,
       product_policy_hash, list_price_usdt, seckill_list_price_usdt,
       merchant_cost_usdt, merchant_concession_bps, policy_version, quote_kind,
       session_id, authorization_digest, quote_signature, deadline, state
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
       'SECKILL',$17,$18,$19,$20,'QUOTED')`,
    [
      input.dual.seckill.orderId,
      input.idempotencyKey,
      CORE_ARTIFACT_VERSION,
      input.buyer,
      input.catalog.merchant_id,
      input.catalog.settlement_wallet,
      input.catalog.product_id,
      input.catalog.sku_id,
      input.catalog.chain_product_id,
      input.catalog.chain_sku_id,
      input.catalog.product_policy_hash,
      input.catalog.list_price_usdt,
      input.seckillUnitPrice,
      input.catalog.merchant_cost_usdt,
      input.catalog.merchant_concession_bps,
      input.policyVersion,
      input.sessionId,
      input.digest,
      input.signature,
      new Date(input.dual.seckill.deadline * 1000),
    ],
  );
  for (const [classification, intent] of [
    ['SECKILL', input.dual.seckill],
    ['FALLBACK_RETAIL', input.dual.fallback],
  ] as const) {
    await executor.query(
      `INSERT INTO core.payment_quote_legs (
         order_id, classification, reservation_id, snapshot_hash, intent
       ) VALUES ($1,$2,$3,$4,$5)`,
      [intent.orderId, classification, intent.reservationId, paymentIntentHash(intent), JSON.stringify(intent)],
    );
  }
}

async function loadExistingQuote(executor: SqlExecutor, buyer: string, idempotencyKey: string) {
  const result = await executor.query<StoredQuoteRow>(
    `SELECT quote.order_id, quote.product_id, quote.sku_id,
       quote.authorization_digest, quote.quote_signature, quote.deadline,
       quote.state, quote.submitted_tx_hash, leg.intent, leg.snapshot_hash
     FROM core.payment_quotes quote
     JOIN core.payment_quote_legs leg ON leg.order_id = quote.order_id AND leg.classification = 'ORDINARY'
     WHERE quote.buyer_wallet = $1 AND quote.idempotency_key = $2`,
    [buyer, idempotencyKey],
  );
  return result.rows[0];
}

async function loadQuoteIdentity(executor: SqlExecutor, buyer: string, idempotencyKey: string) {
  const result = await executor.query<{ order_id: string; quote_kind: 'ORDINARY' | 'SECKILL' }>(
    `SELECT order_id, quote_kind FROM core.payment_quotes
     WHERE buyer_wallet = $1 AND idempotency_key = $2`,
    [buyer, idempotencyKey],
  );
  return result.rows[0];
}

async function loadExistingSeckillQuote(executor: SqlExecutor, buyer: string, idempotencyKey: string) {
  const result = await executor.query<StoredSeckillQuoteRow>(
    `SELECT quote.order_id, quote.product_id, quote.sku_id, quote.session_id,
       quote.authorization_digest, quote.quote_signature, quote.deadline,
       quote.state, quote.submitted_tx_hash, leg.classification, leg.intent, leg.snapshot_hash
     FROM core.payment_quotes quote
     JOIN core.payment_quote_legs leg ON leg.order_id = quote.order_id
     WHERE quote.buyer_wallet = $1 AND quote.idempotency_key = $2
     ORDER BY leg.classification`,
    [buyer, idempotencyKey],
  );
  return result.rows;
}

async function loadStoredQuote(executor: SqlExecutor, orderId: string, buyer: string) {
  const result = await executor.query<StoredQuoteRow>(
    `SELECT quote.order_id, quote.product_id, quote.sku_id,
       quote.authorization_digest, quote.quote_signature, quote.deadline,
       quote.state, quote.submitted_tx_hash, leg.intent, leg.snapshot_hash
     FROM core.payment_quotes quote
     JOIN core.payment_quote_legs leg ON leg.order_id = quote.order_id AND leg.classification = 'ORDINARY'
     WHERE quote.order_id = $1 AND quote.buyer_wallet = $2`,
    [orderId, buyer],
  );
  return result.rows[0];
}

function existingQuoteResponse(row: StoredQuoteRow, input: CreateOrdinaryQuoteInput, router: string) {
  if (
    row.product_id !== input.productId
      || row.sku_id !== input.skuId
      || row.intent.quantity !== input.quantity
      || row.intent.fulfillmentMode !== input.fulfillmentMode
      || row.intent.fulfillmentTargetHash.toLowerCase() !== input.fulfillmentTargetHash.toLowerCase()
      || row.intent.regionCodeHash.toLowerCase() !== input.regionCodeHash.toLowerCase()
  ) throw new CoreError('IdempotencyConflict', 'Idempotency key was used for a different quote', 409);
  return quoteResponse(row.intent, row.authorization_digest, row.quote_signature, row.snapshot_hash, router, row.state, row.submitted_tx_hash);
}

function existingSeckillQuoteResponse(
  rows: StoredSeckillQuoteRow[],
  input: CreateSeckillQuoteInput,
  router: string,
) {
  const seckill = rows.find((row) => row.classification === 'SECKILL');
  const fallback = rows.find((row) => row.classification === 'FALLBACK_RETAIL');
  if (
    !seckill || !fallback || seckill.product_id !== input.productId || seckill.sku_id !== input.skuId
      || seckill.session_id.toLowerCase() !== input.sessionId.toLowerCase()
      || seckill.intent.quantity !== input.quantity
      || seckill.intent.fulfillmentMode !== input.fulfillmentMode
      || seckill.intent.fulfillmentTargetHash.toLowerCase() !== input.fulfillmentTargetHash.toLowerCase()
      || seckill.intent.regionCodeHash.toLowerCase() !== input.regionCodeHash.toLowerCase()
  ) throw new CoreError('IdempotencyConflict', 'Idempotency key was used for a different seckill quote', 409);
  return seckillQuoteResponse(
    {
      sessionId: seckill.session_id,
      seckill: seckill.intent,
      fallback: fallback.intent,
      classificationAuthority: 'PAYMENT_ROUTER_BLOCK_TIMESTAMP',
    },
    seckill.authorization_digest,
    seckill.quote_signature,
    router,
    seckill.state,
    seckill.submitted_tx_hash,
  );
}

async function loadStoredQuoteIdentity(executor: SqlExecutor, orderId: string, buyer: string) {
  const result = await executor.query<{ quote_kind: 'ORDINARY' | 'SECKILL' }>(
    'SELECT quote_kind FROM core.payment_quotes WHERE order_id = $1 AND buyer_wallet = $2',
    [orderId, buyer],
  );
  return result.rows[0];
}

async function loadStoredSeckillQuoteByOrder(executor: SqlExecutor, orderId: string, buyer: string) {
  const result = await executor.query<StoredSeckillQuoteRow>(
    `SELECT quote.order_id, quote.product_id, quote.sku_id, quote.session_id,
       quote.authorization_digest, quote.quote_signature, quote.deadline,
       quote.state, quote.submitted_tx_hash, leg.classification, leg.intent, leg.snapshot_hash
     FROM core.payment_quotes quote
     JOIN core.payment_quote_legs leg ON leg.order_id = quote.order_id
     WHERE quote.order_id = $1 AND quote.buyer_wallet = $2 AND quote.quote_kind = 'SECKILL'
     ORDER BY leg.classification`,
    [orderId, buyer],
  );
  return result.rows;
}

async function loadPaymentFinality(executor: SqlExecutor, orderId: string) {
  const result = await executor.query<StoredPaymentFinalityRow>(
    `SELECT finality.tx_hash AS transaction_hash, finality.replacement_for_tx_hash,
       finality.block_number, finality.block_hash, finality.confirmations,
       finality.required_confirmations, finality.receipt_status, finality.state,
       payment.canonical, payment.classification
     FROM core.transaction_finality finality
     JOIN core.payment_events payment
       ON payment.order_id = finality.resource_id
      AND payment.transaction_hash = finality.tx_hash
      AND payment.block_hash = finality.block_hash
     WHERE finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = $1
     ORDER BY finality.updated_at DESC LIMIT 1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    transactionHash: row.transaction_hash,
    replacementForTxHash: row.replacement_for_tx_hash,
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash,
    confirmations: Number(row.confirmations),
    requiredConfirmations: Number(row.required_confirmations),
    receiptStatus: row.receipt_status,
    state: row.state,
    canonicalBlock: row.canonical,
    classification: row.classification,
  } as const;
}

function quoteResponse(
  intent: CanonicalPaymentIntent,
  authorizationDigest: string,
  quoteSignature: string,
  snapshotHash: string,
  paymentRouterAddress: string,
  state: string,
  submittedTxHash: string | null,
) {
  const buyerAuthorization = paymentWalletAuthorization(intent, paymentRouterAddress);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    orderId: intent.orderId,
    state,
    paymentRouterAddress,
    intent,
    snapshotHash,
    authorizationDigest,
    buyerAuthorization,
    quoteSignature,
    submittedTxHash,
    approvalRequirements: approvalRequirements(intent, paymentRouterAddress),
    routerCall: {
      functionName: 'pay' as const,
      intent: toRouterPaymentIntent(intent),
      quoteSignature,
    },
  } as const;
}

function seckillQuoteResponse(
  dual: CanonicalSeckillIntent & { readonly classificationAuthority: 'PAYMENT_ROUTER_BLOCK_TIMESTAMP' },
  authorizationDigest: string,
  quoteSignature: string,
  paymentRouterAddress: string,
  state: string,
  submittedTxHash: string | null,
) {
  const buyerAuthorization = seckillWalletAuthorization(dual, paymentRouterAddress);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    orderId: dual.seckill.orderId,
    state,
    paymentRouterAddress,
    dual,
    seckillHash: seckillIntentHash(dual),
    snapshotHashes: {
      seckill: paymentIntentHash(dual.seckill),
      fallback: paymentIntentHash(dual.fallback),
    },
    authorizationDigest,
    buyerAuthorization,
    quoteSignature,
    submittedTxHash,
    approvalRequirements: approvalRequirements(dual.seckill, paymentRouterAddress, dual.fallback),
    routerCall: {
      functionName: 'paySeckill' as const,
      intent: toRouterSeckillIntent(dual),
      quoteSignature,
    },
  } as const;
}

function approvalRequirements(
  intent: CanonicalPaymentIntent,
  paymentRouterAddress: string,
  fallback?: CanonicalPaymentIntent,
) {
  const requiredUsdt = fallback
    ? maxAmount(intent.usdtPaymentAmount, fallback.usdtPaymentAmount)
    : intent.usdtPaymentAmount;
  const requiredNpl = fallback
    ? maxAmount(intent.nplPaymentAmount, fallback.nplPaymentAmount)
    : intent.nplPaymentAmount;
  return [
    { token: USDT_ADDRESS, requiredAmount: requiredUsdt },
    { token: NPL_ADDRESS, requiredAmount: requiredNpl },
  ].map(({ token, requiredAmount }) => Object.freeze({
    token,
    spender: paymentRouterAddress,
    requiredAmount,
    requestedAllowance: MaxUint256.toString(),
    approvalMode: 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED' as const,
    risk: 'UNLIMITED_TOKEN_ALLOWANCE' as const,
    revocation: Object.freeze({
      method: 'ERC20_APPROVE_ZERO' as const,
      token,
      spender: paymentRouterAddress,
    }),
  }));
}

function maxAmount(left: string, right: string) {
  return BigInt(left) >= BigInt(right) ? left : right;
}

function catalogProjection(rows: CatalogRow[]) {
  const products = new Map<string, {
    productId: string;
    chainProductId: string;
    title: string;
    metadata: unknown;
    skus: Array<Record<string, unknown>>;
  }>();
  for (const row of rows) {
    let product = products.get(row.product_id);
    if (!product) {
      product = {
        productId: row.product_id,
        chainProductId: row.chain_product_id,
        title: row.title,
        metadata: row.metadata,
        skus: [],
      };
      products.set(row.product_id, product);
    }
    product.skus.push({
      skuId: row.sku_id,
      chainSkuId: row.chain_sku_id,
      attributes: row.attributes,
      listPriceUsdt: row.list_price_usdt,
      stockAvailable: String(row.stock_available),
    });
  }
  return [...products.values()];
}

function catalogSelect() {
  return `SELECT product.product_id, product.chain_product_id, product.merchant_id,
    product.title, product.product_policy_hash, product.merchant_concession_bps,
    product.metadata, product.lifecycle_state AS product_state, sku.sku_id,
    sku.chain_sku_id, sku.attributes, sku.list_price_usdt::text,
    sku.merchant_cost_usdt::text, sku.stock_available, sku.lifecycle_state AS sku_state,
    merchant.settlement_wallet, merchant.status AS merchant_status,
    merchant.guarantee_status
  FROM core.products product
  JOIN core.skus sku ON sku.product_id = product.product_id
  JOIN core.merchants merchant ON merchant.merchant_id = product.merchant_id`;
}

function preparationFingerprint(value: { catalog: CatalogRow; policy: PolicyRow; session?: SessionRow }) {
  return JSON.stringify({
    productId: value.catalog.product_id,
    chainProductId: value.catalog.chain_product_id,
    skuId: value.catalog.sku_id,
    chainSkuId: value.catalog.chain_sku_id,
    productPolicyHash: value.catalog.product_policy_hash,
    concessionBps: value.catalog.merchant_concession_bps,
    listPrice: value.catalog.list_price_usdt,
    merchantCost: value.catalog.merchant_cost_usdt,
    stock: String(value.catalog.stock_available),
    merchant: value.catalog.settlement_wallet,
    policyVersion: value.policy.policy_version,
    artifactVersion: value.policy.artifact_version,
    policyHash: value.policy.policy_hash,
    oracleVersion: value.policy.oracle_version,
    rulesContentHash: value.policy.rules_content_hash,
    beneficiarySetHash: value.policy.beneficiary_set_hash,
    policy: value.policy.payload,
    session: value.session ? {
      id: value.session.session_id,
      policyVersion: value.session.policy_version,
      productPolicyHash: value.session.product_policy_hash,
      listPrice: value.session.seckill_list_price_usdt,
      phase: value.session.phase,
      startsAt: value.session.starts_at,
      mainDeadline: value.session.main_deadline,
      relayDeadline: value.session.relay_deadline,
      available: String(value.session.available),
    } : null,
  });
}

function reservationHash(
  reservationId: string,
  chainSkuId: string,
  buyer: string,
  quantity: number,
  reservationDeadline: number,
) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32', 'address', 'uint32', 'uint64'],
    [reservationId, chainSkuId, buyer, quantity, reservationDeadline],
  ));
}

function validateCreateQuote(input: CreateOrdinaryQuoteInput) {
  if (
    input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128
      || input.productId.length === 0 || input.skuId.length === 0
      || !Number.isSafeInteger(input.quantity) || input.quantity <= 0
      || !['DELIVERY', 'PICKUP'].includes(input.fulfillmentMode)
      || !isHash(input.fulfillmentTargetHash) || !isHash(input.regionCodeHash)
  ) throw new CoreError('InvalidRequest', 'Invalid payment quote request');
}

function normalizeAddress(value: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid buyer wallet');
  }
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
