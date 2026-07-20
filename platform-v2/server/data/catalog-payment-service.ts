import { randomBytes } from 'node:crypto';
import { AbiCoder, MaxUint256, getAddress, keccak256 } from 'ethers';
import {
  buildDualPaymentQuote,
  buildPaymentIntent,
  type CanonicalPaymentIntent,
} from '../api/checkout.ts';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { parsePaymentPolicySnapshot } from '../api/payment-policy.ts';
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
import type { BnmWalletRegistrationSource } from '../chain/bnm-availability-worker.ts';
import { reserveInventory } from './inventory.ts';
import { assertWalletPaymentAllowed } from './risk-service.ts';
import { assertQuoteFulfillmentTarget } from './fulfillment-target-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import {
  blocksOrdinaryQuote,
  effectiveSeckillPhase,
  type StoredSeckillPhase,
} from './seckill-phase.ts';
import {
  isMicrotestBuyerEligible,
  isMicrotestProductEligible,
  type MainnetMicrotestEntitlement,
} from './mainnet-microtest-entitlement.ts';

export interface QuoteSigner {
  sign(request: SignerRequest): Promise<{ signature: string; signer: string }>;
}

export interface PaymentNplQuoteSource {
  quote(input: {
    listPriceUsdt: bigint;
    policyVersion: number;
  }): Promise<{
    nplQuoteAmount: bigint;
    quoteSourceEvidence: {
      source: 'PRIMARY' | 'FALLBACK';
      observedBlock: number;
      reservesHash: string;
    };
  }>;
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
  subtitle: string;
  product_policy_hash: string;
  merchant_concession_bps: number;
  metadata: unknown;
  main_image_asset_ids: unknown;
  video_asset_id: string | null;
  rich_detail: unknown;
  default_freight_usdt: string;
  fulfillment_modes: unknown;
  category_id: string | null;
  tag_ids: unknown;
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
  guarantee_balance_usdt: string | null;
  guarantee_evidence_hash: string | null;
  total_stock_available: string | number;
}

interface PolicyRow {
  artifact_version: string;
  policy_version: string;
  policy_hash: string;
  rules_content_hash: string;
  beneficiary_set_hash: string;
  payload: unknown;
}

interface SessionRow {
  session_id: string;
  policy_version: string;
  product_policy_hash: string;
  seckill_list_price_usdt: string;
  phase: StoredSeckillPhase;
  starts_at: Date;
  main_deadline: Date;
  relay_deadline: Date;
  available: string | number;
}

interface CatalogSeckillRow {
  session_id: string;
  policy_version: string | number;
  product_id: string;
  sku_id: string;
  seckill_list_price_usdt: string;
  phase: StoredSeckillPhase;
  starts_at: Date | string;
  main_deadline: Date | string;
  relay_deadline: Date | string;
  inventory: string | number;
  sold: string | number;
  reserved: string | number;
  merchant_id: string;
  settlement_wallet: string;
  merchant_status: string;
  guarantee_status: string;
  guarantee_balance_usdt: string | null;
  guarantee_evidence_hash: string | null;
  default_freight_usdt: string;
  list_price_usdt: string;
  stock_available: string | number;
  total_stock_available: string | number;
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
  readonly #nplQuotes: PaymentNplQuoteSource;
  readonly #beneficiaries: BeneficiarySnapshotSource;
  readonly #policies: PaymentPolicyAttestationSource;
  readonly #bnmWallets: BnmWalletRegistrationSource;
  readonly #paymentRouterAddress: string;
  readonly #clock: () => Date;
  readonly #bytes32: () => string;
  readonly #nonce: () => bigint;
  readonly #mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    signer: QuoteSigner;
    nplQuotes: PaymentNplQuoteSource;
    beneficiaries: BeneficiarySnapshotSource;
    policies: PaymentPolicyAttestationSource;
    bnmWallets: BnmWalletRegistrationSource;
    paymentRouterAddress: string;
    clock?: () => Date;
    bytes32?: () => string;
    nonce?: () => bigint;
    mainnetMicrotestEntitlement?: MainnetMicrotestEntitlement;
  }) {
    this.#transactions = input.transactions;
    this.#signer = input.signer;
    this.#nplQuotes = input.nplQuotes;
    this.#beneficiaries = input.beneficiaries;
    this.#policies = input.policies;
    this.#bnmWallets = input.bnmWallets;
    try {
      this.#paymentRouterAddress = getAddress(input.paymentRouterAddress).toLowerCase();
    } catch {
      throw new CoreError('ExternalBlocked', 'PaymentRouter address is unavailable', 503);
    }
    this.#clock = input.clock ?? (() => new Date());
    this.#bytes32 = input.bytes32 ?? (() => `0x${randomBytes(32).toString('hex')}`);
    this.#nonce = input.nonce ?? (() => BigInt(`0x${randomBytes(32).toString('hex')}`));
    this.#mainnetMicrotestEntitlement = input.mainnetMicrotestEntitlement;
  }

  listCatalog(buyerWallet?: string) {
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<CatalogRow>(`${catalogSelect()}
        WHERE product.lifecycle_state = 'ACTIVE' AND sku.lifecycle_state = 'ACTIVE'
          AND merchant.status = 'APPROVED'
        ORDER BY product.created_at DESC, product.product_id, sku.sku_id`);
      const now = this.#clock();
      const buyer = buyerWallet ? normalizeAddress(buyerWallet) : undefined;
      const sessions = await loadCatalogSeckillRows(
        executor,
        undefined,
        this.#mainnetMicrotestEntitlement,
        now,
        buyer,
      );
      return catalogProjection(
        result.rows.filter((row) => catalogRowVisible(row, this.#mainnetMicrotestEntitlement, now, buyer)),
        sessions,
        now,
      );
    });
  }

  getProduct(productId: string, buyerWallet?: string) {
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<CatalogRow>(`${catalogSelect()}
        WHERE product.product_id = $1 AND product.lifecycle_state = 'ACTIVE'
          AND sku.lifecycle_state = 'ACTIVE' AND merchant.status = 'APPROVED'
        ORDER BY sku.sku_id`, [productId]);
      const now = this.#clock();
      const buyer = buyerWallet ? normalizeAddress(buyerWallet) : undefined;
      const sessions = await loadCatalogSeckillRows(
        executor,
        productId,
        this.#mainnetMicrotestEntitlement,
        now,
        buyer,
      );
      const products = catalogProjection(
        result.rows.filter((row) => catalogRowVisible(row, this.#mainnetMicrotestEntitlement, now, buyer)),
        sessions,
        now,
      );
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
    if (existing) {
      await this.#bnmWallets.assertRegistered(buyer);
      await this.#transactions.transaction((executor) => assertStoredQuoteStillAuthorized(
        executor,
        existing,
        buyer,
        input.quantity,
        this.#mainnetMicrotestEntitlement,
        this.#clock(),
      ));
      return existingQuoteResponse(existing, input, this.#paymentRouterAddress);
    }

    const prepared = await this.#transactions.transaction((executor) => loadPreparation(
      executor,
      buyer,
      input,
      this.#clock(),
      this.#mainnetMicrotestEntitlement,
    ));
    await this.#bnmWallets.assertRegistered(buyer);
    const policy = parsePaymentPolicySnapshot(Number(prepared.policy.policy_version), prepared.policy.payload);
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
    const { deadline, reservationDeadline } = quoteDeadlines(
      now,
      prepared.catalog,
      this.#mainnetMicrotestEntitlement,
    );
    const listPriceUsdt = BigInt(prepared.catalog.list_price_usdt) * BigInt(input.quantity);
    const freightUsdt = input.fulfillmentMode === 'DELIVERY' ? BigInt(prepared.catalog.default_freight_usdt) : 0n;
    const nplQuote = await this.#nplQuotes.quote({
      listPriceUsdt,
      policyVersion: policy.policyVersion,
    });
    if (nplQuote.nplQuoteAmount <= 0n) throw new CoreError('InvalidRequest', 'NPL quote is invalid');
    assertQuoteSourceEvidence(nplQuote.quoteSourceEvidence);
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
      freightUsdt,
      nplQuoteAmount: nplQuote.nplQuoteAmount,
      merchantConcessionBps: Number(prepared.catalog.merchant_concession_bps),
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
      const current = await loadPreparation(
        executor,
        buyer,
        input,
        this.#clock(),
        this.#mainnetMicrotestEntitlement,
      );
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
        quoteSourceEvidence: nplQuote.quoteSourceEvidence,
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
    if (existing) {
      await this.#bnmWallets.assertRegistered(buyer);
      const existingQuote = existing[0];
      if (existingQuote) {
        await this.#transactions.transaction((executor) => assertStoredQuoteStillAuthorized(
          executor,
          existingQuote,
          buyer,
          input.quantity,
          this.#mainnetMicrotestEntitlement,
          this.#clock(),
        ));
      }
      return existingSeckillQuoteResponse(existing, input, this.#paymentRouterAddress);
    }
    const prepared = await this.#transactions.transaction((executor) => loadSeckillPreparation(
      executor,
      buyer,
      input,
      this.#clock(),
      this.#mainnetMicrotestEntitlement,
    ));
    await this.#bnmWallets.assertRegistered(buyer);
    const policy = parsePaymentPolicySnapshot(Number(prepared.policy.policy_version), prepared.policy.payload);
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
    const { deadline, reservationDeadline } = quoteDeadlines(
      now,
      prepared.catalog,
      this.#mainnetMicrotestEntitlement,
    );
    const freightUsdt = input.fulfillmentMode === 'DELIVERY' ? BigInt(prepared.catalog.default_freight_usdt) : 0n;
    const seckillListPriceUsdt = BigInt(prepared.session.seckill_list_price_usdt) * BigInt(input.quantity);
    const fallbackListPriceUsdt = BigInt(prepared.catalog.list_price_usdt) * BigInt(input.quantity);
    const [seckillNplQuote, fallbackNplQuote, beneficiaries] = await Promise.all([
      this.#nplQuotes.quote({
        listPriceUsdt: seckillListPriceUsdt,
        policyVersion: policy.policyVersion,
      }),
      this.#nplQuotes.quote({
        listPriceUsdt: fallbackListPriceUsdt,
        policyVersion: policy.policyVersion,
      }),
      this.#beneficiaries.resolve({
        buyer,
        merchant: prepared.catalog.settlement_wallet,
        regionCodeHash: input.regionCodeHash,
        policyVersion: policy.policyVersion,
      }),
    ]);
    if (
      seckillNplQuote.nplQuoteAmount <= 0n || fallbackNplQuote.nplQuoteAmount <= 0n
    ) throw new CoreError('InvalidRequest', 'NPL quote is invalid');
    assertQuoteSourceEvidence(seckillNplQuote.quoteSourceEvidence);
    assertQuoteSourceEvidence(fallbackNplQuote.quoteSourceEvidence);
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
      freightUsdt,
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
        nplQuoteAmount: seckillNplQuote.nplQuoteAmount,
      },
      {
        ...shared,
        reservationId: fallbackReservationId,
        reservationHash: fallbackReservationHash,
        listPriceUsdt: fallbackListPriceUsdt,
        nplQuoteAmount: fallbackNplQuote.nplQuoteAmount,
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
      const current = await loadSeckillPreparation(
        executor,
        buyer,
        input,
        this.#clock(),
        this.#mainnetMicrotestEntitlement,
      );
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
        quoteSourceEvidence: {
          SECKILL: seckillNplQuote.quoteSourceEvidence,
          FALLBACK_RETAIL: fallbackNplQuote.quoteSourceEvidence,
        },
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
      const txHash = input.txHash.toLowerCase();
      if (quote?.state === 'PAID') {
        if (quote.submitted_tx_hash?.toLowerCase() !== txHash) {
          throw new CoreError('IdempotencyConflict', 'Indexed payment transaction does not match the submission', 409);
        }
        return { orderId: input.orderId, txHash, state: 'SUBMITTED' as const };
      }
      if (!quote || !['QUOTED', 'SUBMITTED', 'REORGED'].includes(quote.state)) {
        throw new CoreError('InvalidRequest', 'Payment quote is not submittable', 409);
      }
      if (quote.submitted_tx_hash && quote.submitted_tx_hash.toLowerCase() !== txHash) {
        if (input.replacementForTxHash?.toLowerCase() !== quote.submitted_tx_hash.toLowerCase()) {
          throw new CoreError('IdempotencyConflict', 'Replacement transaction does not match the prior submission', 409);
        }
      }
      await executor.query(
        `UPDATE core.payment_quotes SET state = 'SUBMITTED', submitted_tx_hash = $2,
           submitted_at = COALESCE(submitted_at, clock_timestamp()), updated_at = clock_timestamp()
         WHERE order_id = $1`,
        [input.orderId, txHash],
      );
      return { orderId: input.orderId, txHash, state: 'SUBMITTED' as const };
    });
  }

  getPayment(buyerWallet: string, orderId: string) {
    const buyer = normalizeAddress(buyerWallet);
    return this.#getPayment(orderId, buyer);
  }

  getAdminPayment(actor: FulfillmentActor, orderId: string) {
    if (!actor.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role))) {
      throw new CoreError('Forbidden', 'Platform role is required', 403);
    }
    return this.#getPayment(orderId);
  }

  #getPayment(orderId: string, buyer?: string) {
    if (!isHash(orderId)) throw new CoreError('InvalidRequest', 'Invalid order ID');
    return this.#transactions.transaction(async (executor) => {
      const identity = await loadStoredQuoteIdentity(executor, orderId, buyer);
      if (!identity) throw new CoreError('InvalidRequest', 'Payment not found', 404);
      const owner = identity.buyer_wallet;
      const finality = await loadPaymentFinality(executor, orderId);
      if (identity.quote_kind === 'SECKILL') {
        const quotes = await loadStoredSeckillQuoteByOrder(executor, orderId, owner);
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
      const quote = await loadStoredQuote(executor, orderId, owner);
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

async function loadPreparation(
  executor: SqlExecutor,
  buyer: string,
  input: CreateOrdinaryQuoteInput,
  now: Date,
  mainnetMicrotestEntitlement?: MainnetMicrotestEntitlement,
) {
  const breaker = await executor.query<{ paused: boolean }>(
    "SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_PAYMENT'",
  );
  if (breaker.rows[0]?.paused) throw new CoreError('BreakerActive', 'New payments are paused', 409);
  await assertWalletPaymentAllowed(executor, buyer, now);
  await assertQuoteFulfillmentTarget(executor, {
    buyerWallet: buyer,
    fulfillmentMode: input.fulfillmentMode,
    fulfillmentTargetHash: input.fulfillmentTargetHash,
    regionCodeHash: input.regionCodeHash,
    now,
  });
  await executor.query('SELECT sku_id FROM core.skus WHERE sku_id = $1 FOR UPDATE', [input.skuId]);
  const catalogResult = await executor.query<CatalogRow>(`${catalogSelect()}
    WHERE product.product_id = $1 AND sku.sku_id = $2`, [input.productId, input.skuId]);
  const catalog = catalogResult.rows[0];
  if (
    !catalog || catalog.product_state !== 'ACTIVE' || catalog.sku_state !== 'ACTIVE'
      || catalog.merchant_status !== 'APPROVED'
      || !catalogRowPurchasable(catalog, buyer, input.quantity, mainnetMicrotestEntitlement, now)
      || Number(catalog.stock_available) < input.quantity
  ) throw new CoreError('InventoryUnavailable', 'Product, merchant or inventory is unavailable', 409);
  const activeSessions = await executor.query<CatalogSeckillRow>(
    `SELECT session_id, policy_version, product_id, sku_id,
       seckill_list_price_usdt::text, phase, starts_at, main_deadline,
       relay_deadline, inventory, sold, reserved
     FROM core.seckill_sessions
     WHERE product_id = $1 AND sku_id = $2
       AND phase NOT IN ('SETTLED','FORCE_CLOSED')
     ORDER BY starts_at, session_id`,
    [input.productId, input.skuId],
  );
  const blocking = activeSessions.rows.filter((session) => blocksOrdinaryQuote(session, now));
  if (blocking.length > 0) {
    if (blocking.length > 1) {
      throw new CoreError('UnknownState', 'Multiple active seckill sessions block ordinary checkout', 409, {
        productId: input.productId,
        skuId: input.skuId,
        sessionIds: blocking.map((session) => session.session_id),
      });
    }
    const session = blocking[0]!;
    throw new CoreError('SeckillOnlyProduct', 'Ordinary checkout is unavailable during the seckill session', 409, {
      blockingResource: {
        type: 'SECKILL_SESSION',
        id: session.session_id,
        state: effectiveSeckillPhase(session, now),
      },
    });
  }
  const policyResult = await executor.query<PolicyRow>(
    `SELECT artifact_version, policy_version, policy_hash,
       rules_content_hash, beneficiary_set_hash, payload FROM core.canonical_policy_publications
     WHERE publication_status = 'PUBLISHED' AND (effective_from IS NULL OR effective_from <= $1)
     ORDER BY policy_version DESC LIMIT 1`,
    [now],
  );
  const policy = policyResult.rows[0];
  if (!policy) throw new CoreError('DecisionBlocked', 'No published payment policy is effective', 409);
  return { catalog, policy };
}

async function loadSeckillPreparation(
  executor: SqlExecutor,
  buyer: string,
  input: CreateSeckillQuoteInput,
  now: Date,
  mainnetMicrotestEntitlement?: MainnetMicrotestEntitlement,
) {
  const breakers = await executor.query<{ scope: string }>(
    `SELECT scope FROM core.circuit_breakers
     WHERE paused AND scope IN ('NEW_PAYMENT', 'SECKILL_PURCHASE')`,
  );
  if (breakers.rows.length > 0) throw new CoreError('BreakerActive', 'Seckill payments are paused', 409);
  await assertWalletPaymentAllowed(executor, buyer, now);
  await assertQuoteFulfillmentTarget(executor, {
    buyerWallet: buyer,
    fulfillmentMode: input.fulfillmentMode,
    fulfillmentTargetHash: input.fulfillmentTargetHash,
    regionCodeHash: input.regionCodeHash,
    now,
  });
  const catalogResult = await executor.query<CatalogRow>(`${catalogSelect()}
    WHERE product.product_id = $1 AND sku.sku_id = $2`, [input.productId, input.skuId]);
  const catalog = catalogResult.rows[0];
  if (
    !catalog || catalog.product_state !== 'ACTIVE' || catalog.sku_state !== 'ACTIVE'
      || catalog.merchant_status !== 'APPROVED'
      || !catalogRowPurchasable(catalog, buyer, input.quantity, mainnetMicrotestEntitlement, now)
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
    !session || effectiveSeckillPhase(session, now) !== 'LIVE'
      || Number(session.available) < input.quantity
      || session.product_policy_hash.toLowerCase() !== catalog.product_policy_hash.toLowerCase()
  ) throw new CoreError('InventoryUnavailable', 'Seckill session is not live or has no inventory', 409);
  const policyResult = await executor.query<PolicyRow>(
    `SELECT artifact_version, policy_version, policy_hash,
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
    quoteSourceEvidence: { source: 'PRIMARY' | 'FALLBACK'; observedBlock: number; reservesHash: string };
  },
) {
  await executor.query(
    `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id,
       merchant_wallet, product_id, sku_id, chain_product_id, chain_sku_id,
       product_policy_hash, list_price_usdt, freight_usdt, merchant_cost_usdt, merchant_concession_bps,
       policy_version, quote_kind, authorization_digest, quote_signature, deadline, state
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ORDINARY',$17,$18,$19,'QUOTED')`,
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
      input.intent.freightUsdt,
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
       order_id, classification, reservation_id, snapshot_hash, intent, quote_source_evidence,
       product_usdt_payment_amount, platform_service_fee_usdt,
       custody_product_usdt, freight_usdt, usdt_payment_amount
     ) VALUES ($1,'ORDINARY',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.intent.orderId,
      input.intent.reservationId,
      input.snapshotHash,
      JSON.stringify(input.intent),
      JSON.stringify(input.quoteSourceEvidence),
      input.intent.productUsdtPaymentAmount,
      input.intent.platformServiceFeeUsdt,
      input.intent.custodyProductUsdt,
      input.intent.freightUsdt,
      input.intent.usdtPaymentAmount,
    ],
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
    quoteSourceEvidence: Record<'SECKILL' | 'FALLBACK_RETAIL', {
      source: 'PRIMARY' | 'FALLBACK'; observedBlock: number; reservesHash: string;
    }>;
  },
) {
  await executor.query(
    `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id,
       merchant_wallet, product_id, sku_id, chain_product_id, chain_sku_id,
       product_policy_hash, list_price_usdt, seckill_list_price_usdt, freight_usdt,
       merchant_cost_usdt, merchant_concession_bps, policy_version, quote_kind,
       session_id, authorization_digest, quote_signature, deadline, state
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       'SECKILL',$18,$19,$20,$21,'QUOTED')`,
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
      input.dual.seckill.freightUsdt,
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
         order_id, classification, reservation_id, snapshot_hash, intent, quote_source_evidence,
         product_usdt_payment_amount, platform_service_fee_usdt,
         custody_product_usdt, freight_usdt, usdt_payment_amount
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        intent.orderId,
        classification,
        intent.reservationId,
        paymentIntentHash(intent),
        JSON.stringify(intent),
        JSON.stringify(input.quoteSourceEvidence[classification]),
        intent.productUsdtPaymentAmount,
        intent.platformServiceFeeUsdt,
        intent.custodyProductUsdt,
        intent.freightUsdt,
        intent.usdtPaymentAmount,
      ],
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

async function assertStoredQuoteStillAuthorized(
  executor: SqlExecutor,
  quote: StoredQuoteRow,
  buyer: string,
  quantity: number,
  mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined,
  now: Date,
) {
  if (new Date(quote.deadline) <= now) {
    throw new CoreError('NonceExpired', 'Stored payment quote has expired', 401);
  }
  const result = await executor.query<CatalogRow>(`${catalogSelect()}
    WHERE product.product_id = $1 AND sku.sku_id = $2`, [quote.product_id, quote.sku_id]);
  const catalog = result.rows[0];
  if (
    !catalog || catalog.product_state !== 'ACTIVE' || catalog.sku_state !== 'ACTIVE'
      || catalog.merchant_status !== 'APPROVED'
      || !catalogRowPurchasable(catalog, buyer, quantity, mainnetMicrotestEntitlement, now)
  ) throw new CoreError('Forbidden', 'Stored payment quote is no longer authorized', 403);
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

async function loadStoredQuoteIdentity(executor: SqlExecutor, orderId: string, buyer?: string) {
  const result = await executor.query<{ quote_kind: 'ORDINARY' | 'SECKILL'; buyer_wallet: string }>(
    `SELECT quote_kind, buyer_wallet FROM core.payment_quotes
     WHERE order_id = $1 AND ($2::text IS NULL OR buyer_wallet = $2)`,
    [orderId, buyer ?? null],
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

function catalogProjection(rows: CatalogRow[], sessionRows: CatalogSeckillRow[], now: Date) {
  const sessions = catalogSeckillOverlays(sessionRows, now);
  const products = new Map<string, {
    productId: string;
    chainProductId: string;
    title: string;
    subtitle: string;
    metadata: unknown;
    mainImageAssetIds: string[];
    videoAssetId: string | null;
    richDetail: Readonly<Record<string, unknown>>;
    defaultFreightUsdt: string;
    fulfillmentModes: string[];
    categoryId: string | null;
    tagIds: string[];
    skus: Array<Record<string, unknown>>;
  }>();
  for (const row of rows) {
    let product = products.get(row.product_id);
    if (!product) {
      product = {
        productId: row.product_id,
        chainProductId: row.chain_product_id,
        title: row.title,
        subtitle: row.subtitle,
        metadata: object(row.metadata),
        mainImageAssetIds: mediaAssetIds(row.main_image_asset_ids),
        videoAssetId: row.video_asset_id,
        richDetail: object(row.rich_detail),
        defaultFreightUsdt: row.default_freight_usdt,
        fulfillmentModes: stringArray(row.fulfillment_modes),
        categoryId: row.category_id,
        tagIds: stringArray(row.tag_ids),
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
      seckill: sessions.get(row.sku_id) ?? null,
    });
  }
  return [...products.values()];
}

function mediaAssetIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function catalogSeckillOverlays(rows: CatalogSeckillRow[], now: Date) {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!blocksOrdinaryQuote(row, now)) continue;
    if (result.has(row.sku_id)) {
      throw new CoreError('UnknownState', 'Multiple active seckill sessions exist for one SKU', 409, {
        skuId: row.sku_id,
      });
    }
    const available = Number(row.inventory) - Number(row.sold) - Number(row.reserved);
    if (!Number.isSafeInteger(available) || available < 0) {
      throw new CoreError('UnknownState', 'Seckill inventory projection is invalid', 409);
    }
    result.set(row.sku_id, {
      sessionId: row.session_id,
      policyVersion: String(row.policy_version),
      phase: effectiveSeckillPhase(row, now),
      startsAt: isoTimestamp(row.starts_at),
      mainDeadline: isoTimestamp(row.main_deadline),
      relayDeadline: isoTimestamp(row.relay_deadline),
      seckillListPriceUsdt: row.seckill_list_price_usdt,
      inventory: {
        total: String(row.inventory),
        sold: String(row.sold),
        reserved: String(row.reserved),
        available: String(available),
      },
      ordinaryCheckoutAllowed: false,
    });
  }
  return result;
}

async function loadCatalogSeckillRows(
  executor: SqlExecutor,
  productId: string | undefined,
  mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined,
  now: Date,
  buyer?: string,
) {
  const result = await executor.query<CatalogSeckillRow>(
    `SELECT session.session_id, session.policy_version, session.product_id,
       session.sku_id, session.seckill_list_price_usdt::text, session.phase,
       session.starts_at, session.main_deadline, session.relay_deadline,
       session.inventory, session.sold, session.reserved, product.merchant_id,
       merchant.settlement_wallet, merchant.status AS merchant_status,
       merchant.guarantee_status, guarantee.balance_usdt::text AS guarantee_balance_usdt,
       guarantee.source_evidence_hash AS guarantee_evidence_hash,
       product.default_freight_usdt::text, sku.list_price_usdt::text,
       sku.stock_available,
       (SELECT sum(all_skus.stock_available) FROM core.skus all_skus
         WHERE all_skus.product_id = product.product_id
           AND all_skus.lifecycle_state <> 'DELISTED') AS total_stock_available
     FROM core.seckill_sessions session
     JOIN core.products product ON product.product_id = session.product_id
     JOIN core.skus sku ON sku.sku_id = session.sku_id AND sku.product_id = product.product_id
     JOIN core.merchants merchant ON merchant.merchant_id = product.merchant_id
     LEFT JOIN core.merchant_guarantees guarantee ON guarantee.merchant_id = merchant.merchant_id
     WHERE session.phase NOT IN ('SETTLED','FORCE_CLOSED')
       AND product.lifecycle_state = 'ACTIVE' AND sku.lifecycle_state = 'ACTIVE'
       AND merchant.status = 'APPROVED'
       AND ($1::text IS NULL OR product.product_id = $1)
     ORDER BY session.starts_at, session.session_id`,
    [productId ?? null],
  );
  return result.rows.filter((row) => row.guarantee_status === 'READY' || (
    isMicrotestProductEligible(mainnetMicrotestEntitlement, {
      merchantId: row.merchant_id,
      merchantWallet: row.settlement_wallet,
      productId: row.product_id,
      listPriceUsdt: row.list_price_usdt,
      freightUsdt: row.default_freight_usdt,
      stockAvailable: Number(row.total_stock_available),
      guaranteeBalanceUsdt: row.guarantee_balance_usdt ?? '0',
      guaranteeEvidenceHash: row.guarantee_evidence_hash,
    }, now)
    && mainnetMicrotestEntitlement !== undefined
    && buyer !== undefined
    && mainnetMicrotestEntitlement.buyerWallets.has(buyer)
    && Number(row.inventory) === mainnetMicrotestEntitlement.seckillInventory
    && BigInt(row.seckill_list_price_usdt) <= mainnetMicrotestEntitlement.maxListPriceUsdt
  ));
}

function isoTimestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CoreError('UnknownState', 'Catalog timestamp projection is invalid', 409);
  return date.toISOString();
}

function object(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CoreError('UnknownState', 'Catalog list projection is invalid', 409);
  }
  return value as string[];
}

function catalogSelect() {
  return `SELECT product.product_id, product.chain_product_id, product.merchant_id,
    product.title, product.subtitle, product.product_policy_hash, product.merchant_concession_bps,
    product.metadata, product.main_image_asset_ids, product.video_asset_id,
    product.rich_detail, product.default_freight_usdt::text, product.fulfillment_modes,
    (SELECT assignment.category_id FROM core.product_category_assignments assignment
      WHERE assignment.product_id = product.product_id
        AND assignment.product_version = product.version
      ORDER BY assignment.category_id LIMIT 1) AS category_id,
    COALESCE((SELECT jsonb_agg(assignment.tag_id ORDER BY assignment.tag_id)
      FROM core.product_tag_assignments assignment
      WHERE assignment.product_id = product.product_id
        AND assignment.product_version = product.version), '[]'::jsonb) AS tag_ids,
    product.lifecycle_state AS product_state, sku.sku_id,
    sku.chain_sku_id, sku.attributes, sku.list_price_usdt::text,
    sku.merchant_cost_usdt::text, sku.stock_available, sku.lifecycle_state AS sku_state,
    merchant.settlement_wallet, merchant.status AS merchant_status,
    merchant.guarantee_status, guarantee.balance_usdt::text AS guarantee_balance_usdt,
    guarantee.source_evidence_hash AS guarantee_evidence_hash,
    (SELECT sum(all_skus.stock_available) FROM core.skus all_skus
      WHERE all_skus.product_id = product.product_id
        AND all_skus.lifecycle_state <> 'DELISTED') AS total_stock_available
  FROM core.products product
  JOIN core.skus sku ON sku.product_id = product.product_id
  JOIN core.merchants merchant ON merchant.merchant_id = product.merchant_id
  LEFT JOIN core.merchant_guarantees guarantee ON guarantee.merchant_id = merchant.merchant_id`;
}

function catalogRowVisible(
  row: CatalogRow,
  mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined,
  now: Date,
  buyer?: string,
) {
  return row.guarantee_status === 'READY'
    || (buyer !== undefined && isMicrotestBuyerEligible(
      mainnetMicrotestEntitlement,
      microtestSubject(row),
      buyer,
      1,
      now,
    ));
}

function catalogRowPurchasable(
  row: CatalogRow,
  buyer: string,
  quantity: number,
  mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined,
  now: Date,
) {
  return row.guarantee_status === 'READY'
    || isMicrotestBuyerEligible(
      mainnetMicrotestEntitlement,
      microtestSubject(row),
      buyer,
      quantity,
      now,
    );
}

function microtestSubject(row: CatalogRow) {
  return {
    merchantId: row.merchant_id,
    merchantWallet: row.settlement_wallet,
    productId: row.product_id,
    listPriceUsdt: row.list_price_usdt,
    freightUsdt: row.default_freight_usdt,
    stockAvailable: Number(row.total_stock_available),
    guaranteeBalanceUsdt: row.guarantee_balance_usdt ?? '0',
    guaranteeEvidenceHash: row.guarantee_evidence_hash,
  };
}

function quoteDeadlines(
  now: number,
  catalog: CatalogRow,
  mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined,
) {
  if (catalog.guarantee_status === 'READY') {
    return { deadline: now + 5 * 60, reservationDeadline: now + 10 * 60 };
  }
  if (!mainnetMicrotestEntitlement || catalog.product_id !== mainnetMicrotestEntitlement.productId) {
    throw new CoreError('Forbidden', 'Mainnet micro-test quote is not authorized', 403);
  }
  const entitlementDeadline = Math.floor(mainnetMicrotestEntitlement.expiresAt.getTime() / 1000);
  const deadline = Math.min(now + 5 * 60, entitlementDeadline);
  const reservationDeadline = Math.min(now + 10 * 60, entitlementDeadline);
  if (deadline <= now || reservationDeadline <= now) {
    throw new CoreError('NonceExpired', 'Mainnet micro-test entitlement expired before quote issuance', 401);
  }
  return { deadline, reservationDeadline };
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
    freight: value.catalog.default_freight_usdt,
    merchantCost: value.catalog.merchant_cost_usdt,
    stock: String(value.catalog.stock_available),
    merchant: value.catalog.settlement_wallet,
    policyVersion: value.policy.policy_version,
    artifactVersion: value.policy.artifact_version,
    policyHash: value.policy.policy_hash,
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

function assertQuoteSourceEvidence(value: unknown): asserts value is {
  source: 'PRIMARY' | 'FALLBACK';
  observedBlock: number;
  reservesHash: string;
} {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
    || Object.keys(value).some((key) => !['source', 'observedBlock', 'reservesHash'].includes(key))
    || !['PRIMARY', 'FALLBACK'].includes(String((value as { source?: unknown }).source))
    || !Number.isSafeInteger((value as { observedBlock?: unknown }).observedBlock)
    || Number((value as { observedBlock?: unknown }).observedBlock) <= 0
    || !isHash(String((value as { reservesHash?: unknown }).reservesHash))
  ) throw new CoreError('InvalidFinality', 'NPL quote source evidence is invalid', 409);
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
