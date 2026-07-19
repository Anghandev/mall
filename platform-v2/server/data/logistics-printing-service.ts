import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { getAddress, TypedDataEncoder, verifyTypedData, type TypedDataDomain, type TypedDataField } from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { FulfillmentActor, ShipmentInput } from './fulfillment-service.ts';
import type { Carrier } from './evidence-service.ts';
import {
  appendLogisticsOperationAudit,
  assertLogisticsRouteReady,
  requireCurrentLogisticsRole,
} from './logistics-admin-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

export type PrintProvider = 'FEIE' | 'YILIANYUN';
export type WaybillProvider = 'KUAIDI100' | 'CAINIAO';
export type PrintJobState =
  | 'CONFIGURATION_REQUIRED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'ACCEPTED'
  | 'RETRYABLE'
  | 'FAILED';

export class AmbiguousProviderResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousProviderResultError';
  }
}

export interface WaybillAdapter {
  createWaybill(input: {
    requestId: string;
    orderId: string;
    carrierCode: Carrier;
    sender: PostalParty;
    recipient: PostalParty;
    quantity: string;
  }): Promise<{ providerReference: string; trackingNumber: string }>;
}

export interface PrintAdapter {
  print(input: {
    printJobId: string;
    deviceId: string;
    content: string;
    copyCount: 1 | 2;
  }): Promise<{ providerReference: string }>;
}

export interface PostalParty {
  name: string;
  phone: string;
  address: string;
}

export interface TrackingEvidenceWriter {
  createTrackingEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    carrierCode: Carrier;
    trackingNumber: string;
    idempotencyKey: string;
  }): Promise<unknown> | unknown;
}

export interface ShipmentWriter {
  recordShipment(actor: FulfillmentActor, orderId: string, input: ShipmentInput): Promise<unknown> | unknown;
}

export interface PrinterBindingChallengeInput {
  provider: PrintProvider;
  deviceId: string;
  idempotencyKey: string;
}

export interface ApplyPrinterBindingInput {
  challengeId: string;
  signature: string;
  idempotencyKey: string;
}

export interface WaybillBatchInput {
  provider: WaybillProvider;
  carrierCode: Carrier;
  storeId: string;
  orderIds: string[];
  idempotencyKey: string;
}

export interface AdminWaybillBatchInput extends WaybillBatchInput {
  merchantId: string;
}

interface BindingChallengeRow {
  challenge_id: string;
  store_id: string;
  merchant_id: string;
  actor_wallet: string;
  provider: PrintProvider;
  device_id: string;
  old_value_hash: string;
  new_value_hash: string;
  nonce: string;
  deadline: Date;
  state: 'PENDING' | 'CONSUMED' | 'EXPIRED';
  idempotency_key: string;
  request_hash: string;
  signature_hash: string | null;
  created_at: Date;
  consumed_at: Date | null;
}

interface BindingRow {
  binding_id: string;
  store_id: string;
  merchant_id: string;
  provider: PrintProvider;
  device_id: string;
  binding_hash: string;
  version: string | number;
  verified_by_wallet: string;
  challenge_id: string;
  signature_hash: string;
  created_at: Date;
  updated_at: Date;
}

interface WaybillRow {
  request_id: string;
  batch_id: string;
  merchant_id: string;
  order_id: string;
  store_id: string;
  waybill_provider: WaybillProvider;
  carrier_code: Carrier;
  idempotency_key: string;
  request_hash: string;
  state: 'PENDING_PROVIDER' | 'CONFIGURATION_REQUIRED' | 'PROVIDER_ACCEPTED' | 'SHIPMENT_RECORDED' | 'COMPLETED' | 'FAILED';
  provider_reference: string | null;
  encrypted_tracking_number: Uint8Array | null;
  tracking_iv: Uint8Array | null;
  tracking_tag: Uint8Array | null;
  tracking_number_hash: string | null;
  shipment_evidence_hash: string | null;
  print_job_id: string | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PrintJobRow {
  print_job_id: string;
  merchant_id: string;
  store_id: string;
  order_id: string;
  job_kind: 'WAYBILL' | 'PICKUP_RECEIPT';
  source_reference: string;
  provider: PrintProvider | null;
  device_id_snapshot: string | null;
  copy_count: 1 | 2;
  encrypted_content: Uint8Array;
  content_iv: Uint8Array;
  content_tag: Uint8Array;
  content_hash: string;
  state: PrintJobState;
  attempts: number;
  next_attempt_at: Date | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  provider_reference: string | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DeliveryContextRow {
  order_id: string;
  merchant_id: string;
  merchant_wallet: string;
  quantity: string;
  fulfillment_mode: 'DELIVERY' | 'PICKUP';
  order_state: string;
  finality_status: string;
  payment_finalized_at: Date | null;
  encrypted_payload: Uint8Array;
  encryption_iv: Uint8Array;
  encryption_tag: Uint8Array;
  store_id: string;
  store_name: string;
  store_phone: string;
  store_address: string;
}

const printerBindingTypes: Record<string, TypedDataField[]> = {
  MerchantPrinterBinding: [
    { name: 'storeId', type: 'string' },
    { name: 'merchantId', type: 'string' },
    { name: 'provider', type: 'string' },
    { name: 'deviceIdHash', type: 'bytes32' },
    { name: 'oldValueHash', type: 'bytes32' },
    { name: 'newValueHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};

export class LogisticsPrintingService {
  readonly #transactions: SqlTransactionRunner;
  readonly #encryptionKey: Buffer | undefined;
  readonly #verifyingContract: string;
  readonly #waybillAdapters: Readonly<Partial<Record<WaybillProvider, WaybillAdapter>>>;
  readonly #printAdapters: Readonly<Partial<Record<PrintProvider, PrintAdapter>>>;
  readonly #evidence: TrackingEvidenceWriter;
  readonly #fulfillment: ShipmentWriter;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    encryptionKey?: string;
    verifyingContract: string;
    waybillAdapters?: Readonly<Partial<Record<WaybillProvider, WaybillAdapter>>>;
    printAdapters?: Readonly<Partial<Record<PrintProvider, PrintAdapter>>>;
    evidence: TrackingEvidenceWriter;
    fulfillment: ShipmentWriter;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#encryptionKey = parseEncryptionKey(input.encryptionKey);
    this.#verifyingContract = normalizedAddress(input.verifyingContract, 'printer binding verifying contract');
    this.#waybillAdapters = input.waybillAdapters ?? {};
    this.#printAdapters = input.printAdapters ?? {};
    this.#evidence = input.evidence;
    this.#fulfillment = input.fulfillment;
    this.#clock = input.clock ?? (() => new Date());
  }

  createPrinterBindingChallenge(actor: FulfillmentActor, storeId: string, input: PrinterBindingChallengeInput) {
    assertMerchant(actor);
    const provider = printProvider(input.provider);
    const deviceId = normalizedDeviceId(input.deviceId);
    validateIdempotencyKey(input.idempotencyKey);
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    const requestHash = hashJson({ storeId, provider, deviceId, idempotencyKey: input.idempotencyKey });
    return this.#transactions.transaction(async (executor) => {
      const store = await merchantStore(executor, actor, storeId);
      const existing = await executor.query<BindingChallengeRow>(
        'SELECT * FROM core.merchant_printer_binding_challenges WHERE actor_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict();
        return challengeProjection(existing.rows[0], this.#verifyingContract);
      }
      const current = await loadBinding(executor, storeId);
      const oldValueHash = current?.binding_hash ?? zeroHash();
      const newValueHash = bindingHash({ storeId, merchantId: store.merchant_id, provider, deviceId });
      const nonce = BigInt(`0x${randomBytes(16).toString('hex')}`);
      const now = this.#clock();
      const deadline = new Date(now.getTime() + 5 * 60_000);
      const challengeId = randomHash();
      const inserted = await executor.query<BindingChallengeRow>(
        `INSERT INTO core.merchant_printer_binding_challenges (
           challenge_id, store_id, merchant_id, actor_wallet, provider, device_id,
           old_value_hash, new_value_hash, nonce, deadline, state,
           idempotency_key, request_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11,$12,$13)
         RETURNING *`,
        [
          challengeId,
          storeId,
          store.merchant_id,
          wallet,
          provider,
          deviceId,
          oldValueHash,
          newValueHash,
          nonce.toString(),
          deadline,
          input.idempotencyKey,
          requestHash,
          now,
        ],
      );
      return challengeProjection(inserted.rows[0]!, this.#verifyingContract);
    });
  }

  async applyPrinterBinding(actor: FulfillmentActor, storeId: string, input: ApplyPrinterBindingInput) {
    assertMerchant(actor);
    validateIdempotencyKey(input.idempotencyKey);
    if (!isHash(input.challengeId) || !signaturePattern(input.signature)) {
      throw new CoreError('InvalidRequest', 'Printer binding challenge or signature is invalid');
    }
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    const challenge = await this.#transactions.transaction(async (executor) => {
      await merchantStore(executor, actor, storeId);
      const result = await executor.query<BindingChallengeRow>(
        'SELECT * FROM core.merchant_printer_binding_challenges WHERE challenge_id = $1',
        [input.challengeId.toLowerCase()],
      );
      const row = result.rows[0];
      if (!row || row.store_id !== storeId || row.actor_wallet !== wallet) {
        throw new CoreError('Forbidden', 'Printer binding challenge is outside the merchant scope', 403);
      }
      return row;
    });
    if (challenge.state === 'CONSUMED') {
      return this.#transactions.transaction(async (executor) => bindingProjection(
        await requiredBinding(executor, storeId),
      ));
    }
    const now = this.#clock();
    if (challenge.deadline.getTime() < now.getTime()) {
      await this.#transactions.transaction((executor) => executor.query(
        `UPDATE core.merchant_printer_binding_challenges SET state = 'EXPIRED'
         WHERE challenge_id = $1 AND state = 'PENDING'`,
        [challenge.challenge_id],
      ));
      throw new CoreError('NonceExpired', 'Printer binding challenge expired', 401);
    }
    const message = bindingMessage(challenge);
    const domain = bindingDomain(this.#verifyingContract);
    let valid = false;
    try {
      valid = normalizedAddress(
        verifyTypedData(domain, printerBindingTypes, message, input.signature),
        'printer binding signer',
      ) === wallet;
    } catch {
      valid = false;
    }
    if (!valid) throw new CoreError('InvalidSignature', 'Printer binding signature mismatch', 401);
    const signatureHash = hashText(input.signature.toLowerCase());
    return this.#transactions.transaction(async (executor) => {
      const locked = await executor.query<BindingChallengeRow>(
        'SELECT * FROM core.merchant_printer_binding_challenges WHERE challenge_id = $1 FOR UPDATE',
        [challenge.challenge_id],
      );
      const row = locked.rows[0];
      if (!row) throw new CoreError('InvalidRequest', 'Printer binding challenge not found', 404);
      if (row.state === 'CONSUMED') return bindingProjection(await requiredBinding(executor, storeId));
      if (row.state !== 'PENDING' || row.deadline.getTime() < now.getTime()) {
        throw new CoreError('NonceExpired', 'Printer binding challenge is no longer pending', 401);
      }
      const current = await loadBinding(executor, storeId, true);
      if ((current?.binding_hash ?? zeroHash()) !== row.old_value_hash) {
        throw new CoreError('InvalidRequest', 'Printer binding changed after challenge creation', 409);
      }
      const version = Number(current?.version ?? 0) + 1;
      const bindingId = current?.binding_id ?? randomHash();
      const binding = await executor.query<BindingRow>(
        `INSERT INTO core.merchant_printer_bindings (
           binding_id, store_id, merchant_id, provider, device_id, binding_hash, version,
           verified_by_wallet, challenge_id, signature_hash, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         ON CONFLICT (store_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           device_id = EXCLUDED.device_id,
           binding_hash = EXCLUDED.binding_hash,
           version = EXCLUDED.version,
           verified_by_wallet = EXCLUDED.verified_by_wallet,
           challenge_id = EXCLUDED.challenge_id,
           signature_hash = EXCLUDED.signature_hash,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          bindingId,
          storeId,
          row.merchant_id,
          row.provider,
          row.device_id,
          row.new_value_hash,
          version,
          wallet,
          row.challenge_id,
          signatureHash,
          now,
        ],
      );
      const saved = binding.rows[0]!;
      await executor.query(
        `INSERT INTO core.merchant_printer_binding_history (
           history_id, binding_id, store_id, merchant_id, provider, device_id,
           binding_hash, version, verified_by_wallet, challenge_id, signature_hash, recorded_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomHash(),
          saved.binding_id,
          saved.store_id,
          saved.merchant_id,
          saved.provider,
          saved.device_id,
          saved.binding_hash,
          Number(saved.version),
          wallet,
          row.challenge_id,
          signatureHash,
          now,
        ],
      );
      await executor.query(
        `UPDATE core.merchant_printer_binding_challenges
         SET state = 'CONSUMED', signature_hash = $2, consumed_at = $3
         WHERE challenge_id = $1`,
        [row.challenge_id, signatureHash, now],
      );
      await executor.query(
        `UPDATE core.print_jobs
         SET provider = $2, device_id_snapshot = $3, state = 'QUEUED',
             next_attempt_at = $4, error_code = NULL, updated_at = $4
         WHERE store_id = $1 AND state = 'CONFIGURATION_REQUIRED'`,
        [storeId, saved.provider, saved.device_id, now],
      );
      await appendOutbox(executor, 'MerchantPrinterBindingChanged', saved.binding_id, {
        storeId,
        merchantId: saved.merchant_id,
        bindingHash: saved.binding_hash,
        version: Number(saved.version),
      }, now);
      return bindingProjection(saved);
    });
  }

  getPrinterBinding(actor: FulfillmentActor, storeId: string) {
    assertMerchant(actor);
    return this.#transactions.transaction(async (executor) => {
      await merchantStore(executor, actor, storeId);
      const binding = await loadBinding(executor, storeId);
      return binding ? bindingProjection(binding) : null;
    });
  }

  async createWaybillBatch(actor: FulfillmentActor, input: WaybillBatchInput) {
    assertMerchant(actor);
    return this.#createWaybillBatch(actor, input, actor.merchantId!, false);
  }

  async createAdminWaybillBatch(actor: FulfillmentActor, input: AdminWaybillBatchInput) {
    assertPlatformOperator(actor);
    if (!input.merchantId || input.merchantId.length > 256) {
      throw new CoreError('InvalidRequest', 'Waybill merchant ID is invalid');
    }
    return this.#createWaybillBatch(actor, input, input.merchantId, true);
  }

  async #createWaybillBatch(
    actor: FulfillmentActor,
    input: WaybillBatchInput,
    merchantId: string,
    platformScope: boolean,
  ) {
    const provider = waybillProvider(input.provider);
    const carrierCode = carrier(input.carrierCode);
    validateIdempotencyKey(input.idempotencyKey);
    if (!Array.isArray(input.orderIds) || input.orderIds.length < 1 || input.orderIds.length > 100) {
      throw new CoreError('InvalidRequest', 'Waybill batch requires 1-100 orders');
    }
    if (new Set(input.orderIds).size !== input.orderIds.length || input.orderIds.some((id) => !id || id.length > 256)) {
      throw new CoreError('InvalidRequest', 'Waybill batch contains invalid or duplicate order IDs');
    }
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    const requestHash = hashJson({ ...input, provider, carrierCode, orderIds: [...input.orderIds] });
    const batch = await this.#transactions.transaction(async (executor) => {
      const roles = platformScope
        ? await requireCurrentLogisticsRole(executor, actor)
        : undefined;
      await assertLogisticsRouteReady(executor, provider, carrierCode);
      const store = await merchantStore(executor, actor, input.storeId, merchantId, platformScope);
      await executor.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`waybill-batch:${wallet}:${input.idempotencyKey}`],
      );
      const existing = await executor.query<{
        batch_id: string; request_hash: string;
      }>('SELECT batch_id, request_hash FROM core.waybill_batches WHERE actor_wallet = $1 AND idempotency_key = $2', [
        wallet,
        input.idempotencyKey,
      ]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict();
        return { batchId: existing.rows[0].batch_id, store };
      }
      const batchId = randomHash();
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.waybill_batches (
           batch_id, merchant_id, actor_wallet, idempotency_key, request_hash,
           item_count, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [batchId, store.merchant_id, wallet, input.idempotencyKey, requestHash, input.orderIds.length, now],
      );
      for (const orderId of input.orderIds) {
        const context = await deliveryContext(executor, actor, orderId, input.storeId, merchantId, platformScope);
        assertWaybillEligible(context);
        const itemKey = `waybill-item-${hashText(`${input.idempotencyKey}:${orderId}`).slice(2, 50)}`;
        await executor.query(
          `INSERT INTO core.waybill_requests (
             request_id, batch_id, merchant_id, order_id, store_id, waybill_provider,
             carrier_code, idempotency_key, request_hash, state, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING_PROVIDER',$10,$10)`,
          [
            randomHash(),
            batchId,
            context.merchant_id,
            orderId,
            input.storeId,
            provider,
            carrierCode,
            itemKey,
            hashJson({ batchId, orderId, provider, carrierCode, storeId: input.storeId }),
            now,
          ],
        );
      }
      if (roles) {
        await appendLogisticsOperationAudit(executor, {
          eventType: 'AdminWaybillBatchCreated',
          resourceType: 'WAYBILL_BATCH',
          resourceId: batchId,
          actor,
          roles,
          requestHash,
          payload: {
            merchantId,
            storeId: input.storeId,
            provider,
            carrierCode,
            itemCount: input.orderIds.length,
          },
          now,
        });
      }
      return { batchId, store };
    });
    const requests = await this.#transactions.transaction((executor) => executor.query<WaybillRow>(
      'SELECT * FROM core.waybill_requests WHERE batch_id = $1 ORDER BY created_at, request_id',
      [batch.batchId],
    ));
    const items = [];
    for (const request of requests.rows) {
      items.push(await this.#processWaybill(actor, request, merchantId, platformScope));
    }
    return { artifactVersion: CORE_ARTIFACT_VERSION, batchId: batch.batchId, items };
  }

  listAdminWaybills(actor: FulfillmentActor, input: { merchantId?: string; limit?: number } = {}) {
    assertPlatformOperator(actor);
    const key = requireEncryptionKey(this.#encryptionKey);
    const limit = boundedListLimit(input.limit);
    if (input.merchantId !== undefined && (!input.merchantId || input.merchantId.length > 256)) {
      throw new CoreError('InvalidRequest', 'Waybill merchant filter is invalid');
    }
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentLogisticsRole(executor, actor);
      const result = await executor.query<WaybillRow>(
        `SELECT * FROM core.waybill_requests
         WHERE ($1::text IS NULL OR merchant_id = $1)
         ORDER BY created_at DESC, request_id DESC LIMIT $2`,
        [input.merchantId ?? null, limit],
      );
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        waybills: result.rows.map((row) => waybillProjection(row, key)),
      };
    });
  }

  listAdminPrintJobs(actor: FulfillmentActor, input: { merchantId?: string; limit?: number } = {}) {
    assertPlatformOperator(actor);
    const limit = boundedListLimit(input.limit);
    if (input.merchantId !== undefined && (!input.merchantId || input.merchantId.length > 256)) {
      throw new CoreError('InvalidRequest', 'Print-job merchant filter is invalid');
    }
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentLogisticsRole(executor, actor);
      const result = await executor.query<PrintJobRow>(
        `SELECT * FROM core.print_jobs
         WHERE ($1::text IS NULL OR merchant_id = $1)
         ORDER BY created_at DESC, print_job_id DESC LIMIT $2`,
        [input.merchantId ?? null, limit],
      );
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        printJobs: result.rows.map(printJobProjection),
      };
    });
  }

  listPrintJobs(actor: FulfillmentActor, limit = 50) {
    assertMerchant(actor);
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<PrintJobRow>(
        `SELECT * FROM core.print_jobs WHERE merchant_id = $1
         ORDER BY created_at DESC, print_job_id DESC LIMIT $2`,
        [actor.merchantId!, boundedLimit],
      );
      return result.rows.map(printJobProjection);
    });
  }

  retryPrintJob(actor: FulfillmentActor, printJobId: string, idempotencyKey: string) {
    assertMerchant(actor);
    return this.#retryPrintJob(actor, printJobId, idempotencyKey, false);
  }

  retryAdminPrintJob(actor: FulfillmentActor, printJobId: string, idempotencyKey: string) {
    assertPlatformOperator(actor);
    return this.#retryPrintJob(actor, printJobId, idempotencyKey, true);
  }

  #retryPrintJob(
    actor: FulfillmentActor,
    printJobId: string,
    idempotencyKey: string,
    platformScope: boolean,
  ) {
    if (!isHash(printJobId)) throw new CoreError('InvalidRequest', 'Print job ID is invalid');
    validateIdempotencyKey(idempotencyKey);
    const wallet = normalizedAddress(actor.walletAddress, 'actor wallet');
    const requestHash = hashJson({ printJobId, idempotencyKey });
    return this.#transactions.transaction(async (executor) => {
      const roles = platformScope
        ? await requireCurrentLogisticsRole(executor, actor)
        : undefined;
      const prior = await executor.query<{ request_hash: string }>(
        'SELECT request_hash FROM core.print_job_retry_commands WHERE actor_wallet = $1 AND idempotency_key = $2',
        [wallet, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw idempotencyConflict();
        return printJobProjection(await requiredPrintJob(executor, actor, printJobId, false, platformScope));
      }
      const job = await requiredPrintJob(executor, actor, printJobId, true, platformScope);
      if (job.state === 'ACCEPTED') return printJobProjection(job);
      const binding = await loadBinding(executor, job.store_id);
      const now = this.#clock();
      const state: PrintJobState = binding ? 'QUEUED' : 'CONFIGURATION_REQUIRED';
      const updated = await executor.query<PrintJobRow>(
        `UPDATE core.print_jobs SET provider = $2, device_id_snapshot = $3,
           state = $4, attempts = 0, next_attempt_at = $5,
           lease_token = NULL, lease_expires_at = NULL, error_code = $6, updated_at = $5
         WHERE print_job_id = $1 RETURNING *`,
        [
          printJobId,
          binding?.provider ?? null,
          binding?.device_id ?? null,
          state,
          now,
          binding ? null : 'PRINTER_NOT_BOUND',
        ],
      );
      await executor.query(
        `INSERT INTO core.print_job_retry_commands (
           command_id, print_job_id, actor_wallet, idempotency_key, request_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomHash(), printJobId, wallet, idempotencyKey, requestHash, now],
      );
      if (roles) {
        await appendLogisticsOperationAudit(executor, {
          eventType: 'AdminPrintJobRetryQueued',
          resourceType: 'PRINT_JOB',
          resourceId: printJobId,
          actor,
          roles,
          requestHash,
          payload: { merchantId: job.merchant_id, storeId: job.store_id, state },
          now,
        });
      }
      return printJobProjection(updated.rows[0]!);
    });
  }

  async dispatchNextPrintJob() {
    const key = requireEncryptionKey(this.#encryptionKey);
    const now = this.#clock();
    const claimed = await this.#transactions.transaction(async (executor) => {
      const candidate = await executor.query<PrintJobRow>(
        `SELECT * FROM core.print_jobs
         WHERE (
           state IN ('QUEUED', 'RETRYABLE') AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
         ) OR (state = 'PROCESSING' AND lease_expires_at <= $1)
         ORDER BY created_at, print_job_id
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [now],
      );
      const job = candidate.rows[0];
      if (!job) return undefined;
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + 30_000);
      const updated = await executor.query<PrintJobRow>(
        `UPDATE core.print_jobs SET state = 'PROCESSING', attempts = attempts + 1,
           lease_token = $2, lease_expires_at = $3, updated_at = $4
         WHERE print_job_id = $1 RETURNING *`,
        [job.print_job_id, leaseToken, leaseExpiresAt, now],
      );
      return updated.rows[0];
    });
    if (!claimed) return undefined;
    const provider = claimed.provider;
    const adapter = provider ? this.#printAdapters[provider] : undefined;
    if (!provider || !claimed.device_id_snapshot || !adapter) {
      return this.#finishPrintFailure(claimed, 'ConfigurationRequired');
    }
    try {
      const result = await adapter.print({
        printJobId: claimed.print_job_id,
        deviceId: claimed.device_id_snapshot,
        content: decryptText(claimed.encrypted_content, claimed.content_iv, claimed.content_tag, key),
        copyCount: claimed.copy_count,
      });
      if (!result.providerReference.trim()) throw new CoreError('ExternalBlocked', 'Print provider returned no reference', 503);
      return this.#transactions.transaction(async (executor) => {
        const updated = await executor.query<PrintJobRow>(
          `UPDATE core.print_jobs SET state = 'ACCEPTED', provider_reference = $3,
             lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
             error_code = NULL, updated_at = $4
           WHERE print_job_id = $1 AND lease_token = $2 RETURNING *`,
          [claimed.print_job_id, claimed.lease_token, result.providerReference.trim(), this.#clock()],
        );
        if (!updated.rows[0]) throw new CoreError('ExternalBlocked', 'Print job lease was lost', 503);
        await appendOutbox(executor, 'PrintJobAccepted', claimed.print_job_id, printJobProjection(updated.rows[0]), this.#clock());
        return printJobProjection(updated.rows[0]);
      });
    } catch (error) {
      return this.#finishPrintFailure(
        claimed,
        error instanceof AmbiguousProviderResultError
          ? 'AMBIGUOUS_PROVIDER_RESULT'
          : error instanceof CoreError ? error.code : 'ExternalBlocked',
      );
    }
  }

  async #finishPrintFailure(job: PrintJobRow, errorCode: string) {
    const configurationRequired = errorCode === 'ConfigurationRequired';
    const terminal = job.attempts >= 5 || errorCode === 'AMBIGUOUS_PROVIDER_RESULT';
    const state: PrintJobState = configurationRequired
      ? 'CONFIGURATION_REQUIRED'
      : terminal ? 'FAILED' : 'RETRYABLE';
    const now = this.#clock();
    const retryAt = state === 'RETRYABLE' ? new Date(now.getTime() + Math.min(60_000, 2 ** job.attempts * 1_000)) : null;
    return this.#transactions.transaction(async (executor) => {
      const updated = await executor.query<PrintJobRow>(
        `UPDATE core.print_jobs SET state = $3, next_attempt_at = $4,
           lease_token = NULL, lease_expires_at = NULL, error_code = $5, updated_at = $6
         WHERE print_job_id = $1 AND lease_token = $2 RETURNING *`,
        [job.print_job_id, job.lease_token, state, retryAt, errorCode, now],
      );
      if (!updated.rows[0]) throw new CoreError('ExternalBlocked', 'Print job lease was lost', 503);
      return printJobProjection(updated.rows[0]);
    });
  }

  async #processWaybill(
    actor: FulfillmentActor,
    initial: WaybillRow,
    merchantId: string,
    platformScope: boolean,
  ) {
    const key = requireEncryptionKey(this.#encryptionKey);
    let request = await this.#transactions.transaction((executor) => loadWaybill(executor, initial.request_id));
    const adapter = this.#waybillAdapters[request.waybill_provider];
    if (request.state === 'PENDING_PROVIDER' || request.state === 'CONFIGURATION_REQUIRED') {
      if (!adapter) {
        request = await this.#markWaybillError(
          actor, platformScope, request.request_id,
          'CONFIGURATION_REQUIRED', 'WAYBILL_PROVIDER_UNAVAILABLE',
        );
        return waybillProjection(request, key);
      }
      try {
        const context = await this.#transactions.transaction(async (executor) => {
          if (platformScope) await requireCurrentLogisticsRole(executor, actor);
          return deliveryContext(executor, actor, request.order_id, request.store_id, merchantId, platformScope);
        });
        const recipient = decryptPostalParty(context, key);
        const result = await adapter.createWaybill({
          requestId: request.request_id,
          orderId: request.order_id,
          carrierCode: request.carrier_code,
          sender: { name: context.store_name, phone: context.store_phone, address: context.store_address },
          recipient,
          quantity: context.quantity,
        });
        const trackingNumber = normalizedTrackingNumber(result.trackingNumber);
        const providerReference = result.providerReference.trim();
        if (!providerReference) throw new CoreError('ExternalBlocked', 'Waybill provider returned no reference', 503);
        const encrypted = encryptText(trackingNumber, key);
        request = await this.#transactions.transaction(async (executor) => {
          if (platformScope) await requireCurrentLogisticsRole(executor, actor);
          const updated = await executor.query<WaybillRow>(
            `UPDATE core.waybill_requests SET state = 'PROVIDER_ACCEPTED', provider_reference = $2,
               encrypted_tracking_number = $3, tracking_iv = $4, tracking_tag = $5,
               error_code = NULL, updated_at = $6
             WHERE request_id = $1 AND state IN ('PENDING_PROVIDER', 'CONFIGURATION_REQUIRED')
             RETURNING *`,
            [
              request.request_id,
              providerReference,
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.tag,
              this.#clock(),
            ],
          );
          return updated.rows[0] ?? loadWaybill(executor, request.request_id);
        });
      } catch (error) {
        const code = error instanceof CoreError ? error.code : 'ExternalBlocked';
        request = await this.#markWaybillError(
          actor,
          platformScope,
          request.request_id,
          code === 'ConfigurationRequired' ? 'CONFIGURATION_REQUIRED' : 'FAILED',
          code,
        );
        return waybillProjection(request, key);
      }
    }
    if (request.state === 'FAILED') return waybillProjection(request, key);
    const trackingNumber = decryptTracking(request, key);
    if (request.state === 'PROVIDER_ACCEPTED') {
      try {
        if (platformScope) {
          await this.#transactions.transaction((executor) => requireCurrentLogisticsRole(executor, actor));
        }
        const evidence = await this.#evidence.createTrackingEvidence(actor, {
          orderId: request.order_id,
          carrierCode: request.carrier_code,
          trackingNumber,
          idempotencyKey: `waybill-evidence-${request.request_id}`,
        }) as { evidenceHash?: unknown; trackingNumberHash?: unknown };
        if (!isHash(String(evidence.evidenceHash)) || !isHash(String(evidence.trackingNumberHash))) {
          throw new CoreError('ExternalBlocked', 'Tracking evidence response is incomplete', 503);
        }
        const shipment = await this.#fulfillment.recordShipment(actor, request.order_id, {
          carrierCode: request.carrier_code,
          trackingNumberHash: String(evidence.trackingNumberHash),
          evidenceHash: String(evidence.evidenceHash),
          providerReferenceHash: hashText(request.provider_reference!),
          idempotencyKey: `waybill-shipment-${request.request_id}`,
        });
        void shipment;
        request = await this.#transactions.transaction(async (executor) => {
          if (platformScope) await requireCurrentLogisticsRole(executor, actor);
          const updated = await executor.query<WaybillRow>(
            `UPDATE core.waybill_requests SET state = 'SHIPMENT_RECORDED',
               tracking_number_hash = $2, shipment_evidence_hash = $3,
               error_code = NULL, updated_at = $4
             WHERE request_id = $1 AND state = 'PROVIDER_ACCEPTED' RETURNING *`,
            [request.request_id, evidence.trackingNumberHash, evidence.evidenceHash, this.#clock()],
          );
          return updated.rows[0] ?? loadWaybill(executor, request.request_id);
        });
      } catch (error) {
        request = await this.#markWaybillError(
          actor,
          platformScope,
          request.request_id,
          'FAILED',
          error instanceof CoreError ? error.code : 'ExternalBlocked',
        );
        return waybillProjection(request, key);
      }
    }
    if (request.state === 'SHIPMENT_RECORDED') {
      const context = await this.#transactions.transaction(async (executor) => {
        if (platformScope) await requireCurrentLogisticsRole(executor, actor);
        return deliveryContext(executor, actor, request.order_id, request.store_id, merchantId, platformScope);
      });
      const recipient = decryptPostalParty(context, key);
      const content = waybillContent({ request, context, recipient, trackingNumber });
      const job = await this.#transactions.transaction(async (executor) => {
        if (platformScope) await requireCurrentLogisticsRole(executor, actor);
        return enqueuePrintJob(executor, {
          merchantId: request.merchant_id,
          storeId: request.store_id,
          orderId: request.order_id,
          kind: 'WAYBILL',
          sourceReference: request.request_id,
          copyCount: 1,
          content,
          encryptionKey: key,
          now: this.#clock(),
        });
      });
      request = await this.#transactions.transaction(async (executor) => {
        if (platformScope) await requireCurrentLogisticsRole(executor, actor);
        const updated = await executor.query<WaybillRow>(
          `UPDATE core.waybill_requests SET state = 'COMPLETED', print_job_id = $2,
             error_code = NULL, updated_at = $3
           WHERE request_id = $1 AND state = 'SHIPMENT_RECORDED' RETURNING *`,
          [request.request_id, job.print_job_id, this.#clock()],
        );
        return updated.rows[0] ?? loadWaybill(executor, request.request_id);
      });
    }
    return waybillProjection(request, key);
  }

  #markWaybillError(
    actor: FulfillmentActor,
    platformScope: boolean,
    requestId: string,
    state: 'CONFIGURATION_REQUIRED' | 'FAILED',
    errorCode: string,
  ) {
    return this.#transactions.transaction(async (executor) => {
      if (platformScope) await requireCurrentLogisticsRole(executor, actor);
      const updated = await executor.query<WaybillRow>(
        `UPDATE core.waybill_requests SET state = $2, error_code = $3, updated_at = $4
         WHERE request_id = $1 AND state IN ('PENDING_PROVIDER', 'CONFIGURATION_REQUIRED', 'PROVIDER_ACCEPTED')
         RETURNING *`,
        [requestId, state, errorCode, this.#clock()],
      );
      return updated.rows[0] ?? loadWaybill(executor, requestId);
    });
  }
}

export function createPickupReceiptEnqueuer(input: { encryptionKey?: string; clock?: () => Date }) {
  const key = parseEncryptionKey(input.encryptionKey);
  const clock = input.clock ?? (() => new Date());
  return async (
    executor: SqlExecutor,
    receipt: { orderId: string; merchantId: string; storeId: string; quantity: string; fulfilledAt: Date },
  ) => enqueuePrintJob(executor, {
    merchantId: receipt.merchantId,
    storeId: receipt.storeId,
    orderId: receipt.orderId,
    kind: 'PICKUP_RECEIPT',
    sourceReference: `pickup:${receipt.orderId}`,
    copyCount: 2,
    content: [
      'ABU 24K PICKUP RECEIPT',
      `Order: ${receipt.orderId}`,
      `Store: ${receipt.storeId}`,
      `Quantity: ${receipt.quantity}`,
      `Verified: ${receipt.fulfilledAt.toISOString()}`,
      'Copy: merchant/customer',
    ].join('\n'),
    encryptionKey: requireEncryptionKey(key),
    now: clock(),
  });
}

async function enqueuePrintJob(executor: SqlExecutor, input: {
  merchantId: string;
  storeId: string;
  orderId: string;
  kind: 'WAYBILL' | 'PICKUP_RECEIPT';
  sourceReference: string;
  copyCount: 1 | 2;
  content: string;
  encryptionKey: Buffer;
  now: Date;
}) {
  const existing = await executor.query<PrintJobRow>(
    'SELECT * FROM core.print_jobs WHERE job_kind = $1 AND source_reference = $2',
    [input.kind, input.sourceReference],
  );
  if (existing.rows[0]) return existing.rows[0];
  const binding = await loadBinding(executor, input.storeId);
  const encrypted = encryptText(input.content, input.encryptionKey);
  const state: PrintJobState = binding ? 'QUEUED' : 'CONFIGURATION_REQUIRED';
  const job = await executor.query<PrintJobRow>(
    `INSERT INTO core.print_jobs (
       print_job_id, merchant_id, store_id, order_id, job_kind, source_reference,
       provider, device_id_snapshot, copy_count, encrypted_content, content_iv,
       content_tag, content_hash, state, next_attempt_at, error_code, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
     RETURNING *`,
    [
      randomHash(),
      input.merchantId,
      input.storeId,
      input.orderId,
      input.kind,
      input.sourceReference,
      binding?.provider ?? null,
      binding?.device_id ?? null,
      input.copyCount,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      hashText(input.content),
      state,
      binding ? input.now : null,
      binding ? null : 'PRINTER_NOT_BOUND',
      input.now,
    ],
  );
  await appendOutbox(executor, 'PrintJobCreated', job.rows[0]!.print_job_id, printJobProjection(job.rows[0]!), input.now);
  return job.rows[0]!;
}

async function merchantStore(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  storeId: string,
  merchantId = actor.merchantId,
  platformScope = false,
) {
  if (!storeId || storeId.length > 256) throw new CoreError('InvalidRequest', 'Store ID is invalid');
  const result = await executor.query<{
    store_id: string; merchant_id: string; status: string;
  }>('SELECT store_id, merchant_id, status FROM core.merchant_stores WHERE store_id = $1', [storeId]);
  const store = result.rows[0];
  if (!store || store.merchant_id !== merchantId || (!platformScope && store.merchant_id !== actor.merchantId)) {
    throw new CoreError('Forbidden', 'Store is outside the merchant scope', 403);
  }
  if (store.status !== 'ACTIVE') throw new CoreError('InvalidRequest', 'Store is not active', 409);
  return store;
}

async function deliveryContext(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  orderId: string,
  storeId: string,
  merchantId = actor.merchantId,
  platformScope = false,
) {
  const result = await executor.query<DeliveryContextRow>(
    `SELECT orders.order_id, orders.merchant_id, orders.merchant_wallet, orders.quantity::text,
       orders.fulfillment_mode, orders.state AS order_state, orders.finality_status,
       finality.finalized_at AS payment_finalized_at,
       target.encrypted_payload, target.encryption_iv, target.encryption_tag,
       store.store_id, store.name AS store_name, store.phone AS store_phone, store.address AS store_address
     FROM core.orders orders
     JOIN core.fulfillment_targets target
       ON lower(target.target_hash) = lower(orders.fulfillment_target_hash)
     JOIN core.merchant_stores store ON store.store_id = $2
     LEFT JOIN core.transaction_finality finality
       ON finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = orders.order_id
       AND finality.state = 'FINAL'
     WHERE orders.order_id = $1`,
    [orderId, storeId],
  );
  const row = result.rows[0];
  if (
    !row
    || row.merchant_id !== merchantId
    || (!platformScope && row.merchant_id !== actor.merchantId)
    || row.fulfillment_mode !== 'DELIVERY'
  ) {
    throw new CoreError('Forbidden', 'Delivery order is outside the merchant scope', 403);
  }
  if (row.store_id !== storeId) throw new CoreError('InvalidRequest', 'Waybill sender store mismatch', 409);
  return row;
}

function assertWaybillEligible(row: DeliveryContextRow) {
  if (row.order_state !== 'PAID') {
    throw new CoreError('UnknownState', 'Electronic waybill requires a paid order awaiting shipment', 409);
  }
  if (row.finality_status !== 'FINAL' || !row.payment_finalized_at) {
    throw new CoreError('FinalityPending', 'Payment must reach 15 canonical confirmations before waybill creation', 409);
  }
}

function decryptPostalParty(row: DeliveryContextRow, key: Buffer): PostalParty {
  const payload = JSON.parse(decryptText(row.encrypted_payload, row.encryption_iv, row.encryption_tag, key)) as Record<string, unknown>;
  const name = boundedString(payload.recipientName, 'recipient name', 2, 80);
  const phone = boundedString(payload.phone, 'recipient phone', 6, 32);
  const address = boundedString(payload.address, 'recipient address', 5, 500);
  return { name, phone, address };
}

function challengeProjection(row: BindingChallengeRow, verifyingContract: string) {
  const message = bindingMessage(row);
  const domain = bindingDomain(verifyingContract);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    challengeId: row.challenge_id,
    storeId: row.store_id,
    merchantId: row.merchant_id,
    signer: row.actor_wallet,
    expiresAt: row.deadline.toISOString(),
    typedData: { domain, types: printerBindingTypes, primaryType: 'MerchantPrinterBinding', message },
    digest: TypedDataEncoder.hash(domain, printerBindingTypes, message),
  };
}

function bindingMessage(row: BindingChallengeRow) {
  return {
    storeId: row.store_id,
    merchantId: row.merchant_id,
    provider: row.provider,
    deviceIdHash: hashText(row.device_id),
    oldValueHash: row.old_value_hash,
    newValueHash: row.new_value_hash,
    nonce: BigInt(row.nonce).toString(),
    deadline: BigInt(Math.floor(row.deadline.getTime() / 1000)).toString(),
  };
}

function bindingDomain(verifyingContract: string): TypedDataDomain {
  return { name: 'Abu24KMerchantPrinter', version: '2', chainId: 56, verifyingContract };
}

function bindingProjection(row: BindingRow) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    bindingId: row.binding_id,
    storeId: row.store_id,
    merchantId: row.merchant_id,
    provider: row.provider,
    deviceId: row.device_id,
    bindingHash: row.binding_hash,
    version: Number(row.version),
    verifiedByWallet: row.verified_by_wallet,
    signatureHash: row.signature_hash,
    updatedAt: row.updated_at.toISOString(),
  };
}

function waybillProjection(row: WaybillRow, key: Buffer) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    requestId: row.request_id,
    batchId: row.batch_id,
    merchantId: row.merchant_id,
    orderId: row.order_id,
    storeId: row.store_id,
    provider: row.waybill_provider,
    carrierCode: row.carrier_code,
    state: row.state,
    providerReference: row.provider_reference,
    trackingNumber: row.encrypted_tracking_number ? decryptTracking(row, key) : null,
    trackingNumberHash: row.tracking_number_hash,
    shipmentEvidenceHash: row.shipment_evidence_hash,
    printJobId: row.print_job_id,
    errorCode: row.error_code,
    updatedAt: row.updated_at.toISOString(),
  };
}

function printJobProjection(row: PrintJobRow) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    printJobId: row.print_job_id,
    merchantId: row.merchant_id,
    orderId: row.order_id,
    storeId: row.store_id,
    jobKind: row.job_kind,
    provider: row.provider,
    deviceId: row.device_id_snapshot,
    copyCount: row.copy_count,
    contentHash: row.content_hash,
    state: row.state,
    attempts: row.attempts,
    providerReference: row.provider_reference,
    errorCode: row.error_code,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadBinding(executor: SqlExecutor, storeId: string, lock = false) {
  const result = await executor.query<BindingRow>(
    `SELECT * FROM core.merchant_printer_bindings WHERE store_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [storeId],
  );
  return result.rows[0];
}

async function requiredBinding(executor: SqlExecutor, storeId: string) {
  const binding = await loadBinding(executor, storeId);
  if (!binding) throw new CoreError('ConfigurationRequired', 'Store printer is not bound', 503);
  return binding;
}

async function loadWaybill(executor: SqlExecutor, requestId: string) {
  const result = await executor.query<WaybillRow>('SELECT * FROM core.waybill_requests WHERE request_id = $1', [requestId]);
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Waybill request not found', 404);
  return result.rows[0];
}

async function requiredPrintJob(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  printJobId: string,
  lock = false,
  platformScope = false,
) {
  const result = await executor.query<PrintJobRow>(
    `SELECT * FROM core.print_jobs WHERE print_job_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [printJobId],
  );
  const job = result.rows[0];
  if (!job || (!platformScope && job.merchant_id !== actor.merchantId)) {
    throw new CoreError('Forbidden', 'Print job is outside the merchant scope', 403);
  }
  return job;
}

function waybillContent(input: {
  request: WaybillRow;
  context: DeliveryContextRow;
  recipient: PostalParty;
  trackingNumber: string;
}) {
  return [
    'ABU 24K WAYBILL',
    `Carrier: ${input.request.carrier_code}`,
    `Tracking: ${input.trackingNumber}`,
    `Order: ${input.request.order_id}`,
    `From: ${input.context.store_name} ${input.context.store_phone}`,
    input.context.store_address,
    `To: ${input.recipient.name} ${input.recipient.phone}`,
    input.recipient.address,
    `Quantity: ${input.context.quantity}`,
  ].join('\n');
}

function decryptTracking(row: WaybillRow, key: Buffer) {
  if (!row.encrypted_tracking_number || !row.tracking_iv || !row.tracking_tag) {
    throw new CoreError('ExternalBlocked', 'Waybill tracking evidence is incomplete', 503);
  }
  return decryptText(row.encrypted_tracking_number, row.tracking_iv, row.tracking_tag, key);
}

function encryptText(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptText(ciphertext: Uint8Array, iv: Uint8Array, tag: Uint8Array, key: Buffer) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv));
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]).toString('utf8');
  } catch {
    throw new CoreError('ExternalBlocked', 'Encrypted logistics payload cannot be decrypted', 503);
  }
}

function parseEncryptionKey(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new CoreError('ConfigurationRequired', 'Logistics encryption key must contain 32 bytes', 503);
  return key;
}

function requireEncryptionKey(key: Buffer | undefined) {
  if (!key) throw new CoreError('ConfigurationRequired', 'Logistics encryption key is unavailable', 503);
  return key;
}

function assertMerchant(actor: FulfillmentActor) {
  if (!actor.roles.includes('MERCHANT') || !actor.merchantId) {
    throw new CoreError('Forbidden', 'Merchant role is required', 403);
  }
}

function assertPlatformOperator(actor: FulfillmentActor) {
  if (!actor.roles.includes('ADMIN') && !actor.roles.includes('OPERATOR')) {
    throw new CoreError('Forbidden', 'Admin or Operator role is required', 403);
  }
}

function boundedListLimit(value: number | undefined) {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value)) throw new CoreError('InvalidRequest', 'Logistics list limit is invalid');
  return Math.min(Math.max(value, 1), 100);
}

function bindingHash(input: { storeId: string; merchantId: string; provider: PrintProvider; deviceId: string }) {
  return hashJson({ domain: 'ABU24K_PRINTER_BINDING_V1', ...input });
}

function printProvider(value: string): PrintProvider {
  if (value !== 'FEIE' && value !== 'YILIANYUN') throw new CoreError('InvalidRequest', 'Unsupported print provider');
  return value;
}

function waybillProvider(value: string): WaybillProvider {
  if (value !== 'KUAIDI100' && value !== 'CAINIAO') throw new CoreError('InvalidRequest', 'Unsupported waybill provider');
  return value;
}

function carrier(value: string): Carrier {
  if (!['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'].includes(value)) throw new CoreError('InvalidRequest', 'Unsupported carrier');
  return value as Carrier;
}

function normalizedDeviceId(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{3,128}$/.test(normalized)) throw new CoreError('InvalidRequest', 'Printer Device ID is invalid');
  return normalized;
}

function normalizedTrackingNumber(value: string) {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-Z0-9]{6,64}$/.test(normalized)) throw new CoreError('ExternalBlocked', 'Waybill provider returned an invalid tracking number', 503);
  return normalized;
}

function validateIdempotencyKey(value: string) {
  if (value.length < 8 || value.length > 128) throw new CoreError('InvalidRequest', 'Invalid idempotency key');
}

function signaturePattern(value: string) {
  return /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

function boundedString(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new CoreError('ExternalBlocked', `Fulfillment target ${name} is invalid`, 503);
  }
  return value.trim();
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

function zeroHash() {
  return `0x${'00'.repeat(32)}`;
}

function randomHash() {
  return `0x${randomBytes(32).toString('hex')}`;
}

function hashText(value: string) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function hashJson(value: unknown) {
  return hashText(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

function idempotencyConflict() {
  return new CoreError('IdempotencyConflict', 'Idempotency key was reused with different logistics input', 409);
}

async function appendOutbox(
  executor: SqlExecutor,
  eventType: string,
  aggregateId: string,
  payload: unknown,
  now: Date,
) {
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload,
       idempotency_key, state, created_at
     ) VALUES ($1,'LOGISTICS_PRINTING',$2,$3,$4,$1,'PENDING',$5)`,
    [`event:${randomUUID()}`, aggregateId, eventType, JSON.stringify(payload), now],
  );
}

export { printerBindingTypes };
