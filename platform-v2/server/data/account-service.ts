import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type {
  AdministrativeRegionResolver,
  ParsedPostalAddress,
  PostalAddressParser,
} from '../api/providers.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

type DeliveryTargetCreator = (
  actor: FulfillmentActor,
  input: {
    idempotencyKey: string;
    recipientName: string;
    phone: string;
    address: string;
    longitude: number;
    latitude: number;
  },
) => Promise<unknown>;

export interface BuyerProfileUpdate {
  nickname: string | null;
  avatarAssetId: string | null;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface BuyerAddressInput {
  label: string;
  recipientName: string;
  phone: string;
  detailAddress: string;
  longitude: number;
  latitude: number;
  isDefault: boolean;
  expectedVersion?: number;
  idempotencyKey: string;
}

export interface MerchantProfileUpdate {
  shopName: string;
  logoAssetId: string | null;
  expectedVersion: number;
  idempotencyKey: string;
  correlationId: string;
}

interface BuyerProfileRow {
  buyer_wallet: string;
  encrypted_nickname: Uint8Array | null;
  encryption_iv: Uint8Array | null;
  encryption_tag: Uint8Array | null;
  avatar_asset_id: string | null;
  retention_policy_version: string | null;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BuyerAddressRow {
  address_id: string;
  buyer_wallet: string;
  encrypted_payload: Uint8Array;
  encryption_iv: Uint8Array;
  encryption_tag: Uint8Array;
  retention_policy_version: string;
  is_default: boolean;
  status: 'ACTIVE' | 'DELETED';
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

interface MerchantRow {
  merchant_id: string;
  settlement_wallet: string;
  profile: Record<string, unknown>;
  profile_version: string | number;
  updated_at: Date | string;
}

interface AccountCommandRow {
  request_hash: string;
  command_type: string;
  resource_id: string;
}

export class AccountService {
  readonly #transactions: SqlTransactionRunner;
  readonly #regions: AdministrativeRegionResolver;
  readonly #parser: PostalAddressParser;
  readonly #key: Buffer | undefined;
  readonly #retentionPolicyVersion: string | undefined;
  readonly #clock: () => Date;
  readonly #createDeliveryTarget: DeliveryTargetCreator;

  constructor(input: {
    transactions: SqlTransactionRunner;
    regions: AdministrativeRegionResolver;
    parser: PostalAddressParser;
    encryptionKey?: string;
    retentionPolicyVersion?: string;
    createDeliveryTarget: DeliveryTargetCreator;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#regions = input.regions;
    this.#parser = input.parser;
    this.#key = parseEncryptionKey(input.encryptionKey);
    this.#retentionPolicyVersion = normalizedRetentionPolicy(input.retentionPolicyVersion);
    this.#createDeliveryTarget = input.createDeliveryTarget;
    this.#clock = input.clock ?? (() => new Date());
  }

  getBuyerProfile(actor: FulfillmentActor) {
    const wallet = buyerWallet(actor);
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<BuyerProfileRow>(
        'SELECT * FROM core.buyer_profiles WHERE buyer_wallet = $1',
        [wallet],
      );
      return buyerProfileProjection(result.rows[0], wallet, this.#key);
    });
  }

  updateBuyerProfile(actor: FulfillmentActor, input: BuyerProfileUpdate) {
    const wallet = buyerWallet(actor);
    validateBuyerProfile(input);
    const requestHash = hashJson({
      domain: 'ABU24K_BUYER_PROFILE_V1',
      artifactVersion: CORE_ARTIFACT_VERSION,
      wallet,
      ...input,
    });
    return this.#transactions.transaction(async (executor) => {
      await lockBuyerAccount(executor, wallet, this.#clock());
      const duplicate = await accountCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (duplicate) {
        assertCommand(duplicate, 'BUYER_PROFILE_UPDATE', wallet);
        return buyerProfileProjection(await loadBuyerProfile(executor, wallet), wallet, this.#key);
      }
      const current = await loadBuyerProfile(executor, wallet, true);
      const currentVersion = current ? Number(current.version) : 0;
      if (currentVersion !== input.expectedVersion) {
        throw new CoreError('UnknownState', 'Buyer profile version changed', 409);
      }
      const now = this.#clock();
      const encrypted = input.nickname === null
        ? undefined
        : encryptJson({ nickname: input.nickname.trim() }, requireEncryptionKey(this.#key), `buyer-profile:${wallet}`);
      if (encrypted) requireRetentionPolicy(this.#retentionPolicyVersion);
      await verifyProfileAsset(executor, wallet, 'BUYER', wallet, 'BUYER_AVATAR', input.avatarAssetId);
      const version = currentVersion + 1;
      await executor.query(
        `INSERT INTO core.buyer_profiles (
           buyer_wallet, encrypted_nickname, encryption_iv, encryption_tag,
           avatar_asset_id, retention_policy_version, version, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (buyer_wallet) DO UPDATE SET
           encrypted_nickname = EXCLUDED.encrypted_nickname,
           encryption_iv = EXCLUDED.encryption_iv,
           encryption_tag = EXCLUDED.encryption_tag,
           avatar_asset_id = EXCLUDED.avatar_asset_id,
           retention_policy_version = EXCLUDED.retention_policy_version,
           version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at`,
        [
          wallet,
          encrypted?.ciphertext ?? null,
          encrypted?.iv ?? null,
          encrypted?.tag ?? null,
          input.avatarAssetId?.toLowerCase() ?? null,
          encrypted ? this.#retentionPolicyVersion : null,
          version,
          now,
        ],
      );
      await insertCommand(executor, {
        wallet,
        commandType: 'BUYER_PROFILE_UPDATE',
        resourceId: wallet,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdAt: now,
      });
      await enqueueAccountAudit(executor, {
        wallet,
        role: 'BUYER',
        eventType: 'BuyerProfileUpdated',
        resourceType: 'BUYER_PROFILE',
        resourceId: wallet,
        requestHash,
        correlationId: input.idempotencyKey,
        payload: { version, nicknameConfigured: input.nickname !== null, avatarConfigured: input.avatarAssetId !== null },
        createdAt: now,
      });
      return buyerProfileProjection(await loadBuyerProfile(executor, wallet), wallet, this.#key);
    });
  }

  async parseBuyerAddress(actor: FulfillmentActor, rawText: string) {
    buyerWallet(actor);
    const text = rawText.trim();
    if (text.length < 5 || text.length > 1_000) throw new CoreError('InvalidRequest', 'Address text must contain 5-1000 characters');
    const parsed = await this.#parser.parse({ rawText: text });
    const missingFields = addressMissingFields(parsed);
    return Object.freeze({
      ...parsed,
      canSave: missingFields.length === 0,
      missingFields,
    });
  }

  listBuyerAddresses(actor: FulfillmentActor) {
    const wallet = buyerWallet(actor);
    return this.#transactions.transaction(async (executor) => {
      const rows = await executor.query<BuyerAddressRow>(
        `SELECT * FROM core.buyer_saved_addresses
         WHERE buyer_wallet = $1 AND status = 'ACTIVE'
         ORDER BY is_default DESC, updated_at DESC, address_id`,
        [wallet],
      );
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        addresses: rows.rows.map((row) => buyerAddressProjection(row, requireEncryptionKey(this.#key))),
      };
    });
  }

  createBuyerAddress(actor: FulfillmentActor, input: BuyerAddressInput) {
    const wallet = buyerWallet(actor);
    return this.writeBuyerAddress(wallet, undefined, input, 'BUYER_ADDRESS_CREATE');
  }

  updateBuyerAddress(actor: FulfillmentActor, addressId: string, input: BuyerAddressInput) {
    const wallet = buyerWallet(actor);
    validateResourceId(addressId, 'addressId');
    if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) {
      throw new CoreError('InvalidRequest', 'expectedVersion must be a positive integer');
    }
    return this.writeBuyerAddress(wallet, addressId, input, 'BUYER_ADDRESS_UPDATE');
  }

  deleteBuyerAddress(actor: FulfillmentActor, addressId: string, input: {
    expectedVersion: number;
    idempotencyKey: string;
  }) {
    const wallet = buyerWallet(actor);
    validateResourceId(addressId, 'addressId');
    validateExpectedVersion(input.expectedVersion);
    validateIdempotencyKey(input.idempotencyKey);
    const requestHash = hashJson({
      domain: 'ABU24K_BUYER_ADDRESS_DELETE_V1',
      artifactVersion: CORE_ARTIFACT_VERSION,
      wallet,
      addressId,
      ...input,
    });
    return this.#transactions.transaction(async (executor) => {
      await lockBuyerAccount(executor, wallet, this.#clock());
      const duplicate = await accountCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (duplicate) {
        assertCommand(duplicate, 'BUYER_ADDRESS_DELETE', addressId);
        return { addressId, status: 'DELETED' as const };
      }
      const row = await loadBuyerAddress(executor, wallet, addressId, true);
      if (row.status !== 'ACTIVE' || Number(row.version) !== input.expectedVersion) {
        throw new CoreError('UnknownState', 'Buyer address version changed or was deleted', 409);
      }
      const now = this.#clock();
      await executor.query(
        `UPDATE core.buyer_saved_addresses
         SET status = 'DELETED', is_default = false, deleted_at = $3,
             version = version + 1, updated_at = $3
         WHERE buyer_wallet = $1 AND address_id = $2`,
        [wallet, addressId, now],
      );
      if (row.is_default) await promoteLatestAddress(executor, wallet, now);
      await insertCommand(executor, {
        wallet,
        commandType: 'BUYER_ADDRESS_DELETE',
        resourceId: addressId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdAt: now,
      });
      await enqueueAccountAudit(executor, {
        wallet,
        role: 'BUYER',
        eventType: 'BuyerAddressDeleted',
        resourceType: 'BUYER_ADDRESS',
        resourceId: addressId,
        requestHash,
        correlationId: input.idempotencyKey,
        payload: { addressId },
        createdAt: now,
      });
      return { addressId, status: 'DELETED' as const };
    });
  }

  setDefaultBuyerAddress(actor: FulfillmentActor, addressId: string, input: {
    expectedVersion: number;
    idempotencyKey: string;
  }) {
    const wallet = buyerWallet(actor);
    validateResourceId(addressId, 'addressId');
    validateExpectedVersion(input.expectedVersion);
    validateIdempotencyKey(input.idempotencyKey);
    const requestHash = hashJson({
      domain: 'ABU24K_BUYER_ADDRESS_DEFAULT_V1',
      artifactVersion: CORE_ARTIFACT_VERSION,
      wallet,
      addressId,
      ...input,
    });
    return this.#transactions.transaction(async (executor) => {
      await lockBuyerAccount(executor, wallet, this.#clock());
      const duplicate = await accountCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (duplicate) {
        assertCommand(duplicate, 'BUYER_ADDRESS_SET_DEFAULT', addressId);
        return buyerAddressProjection(
          await loadBuyerAddress(executor, wallet, addressId),
          requireEncryptionKey(this.#key),
        );
      }
      const row = await loadBuyerAddress(executor, wallet, addressId, true);
      if (row.status !== 'ACTIVE' || Number(row.version) !== input.expectedVersion) {
        throw new CoreError('UnknownState', 'Buyer address version changed or was deleted', 409);
      }
      const now = this.#clock();
      await executor.query(
        `UPDATE core.buyer_saved_addresses
         SET is_default = false, version = version + 1, updated_at = $2
         WHERE buyer_wallet = $1 AND status = 'ACTIVE' AND is_default AND address_id <> $3`,
        [wallet, now, addressId],
      );
      await executor.query(
        `UPDATE core.buyer_saved_addresses
         SET is_default = true, version = version + 1, updated_at = $3
         WHERE buyer_wallet = $1 AND address_id = $2 AND status = 'ACTIVE'`,
        [wallet, addressId, now],
      );
      await insertCommand(executor, {
        wallet,
        commandType: 'BUYER_ADDRESS_SET_DEFAULT',
        resourceId: addressId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdAt: now,
      });
      await enqueueAccountAudit(executor, {
        wallet,
        role: 'BUYER',
        eventType: 'BuyerDefaultAddressChanged',
        resourceType: 'BUYER_ADDRESS',
        resourceId: addressId,
        requestHash,
        correlationId: input.idempotencyKey,
        payload: { addressId },
        createdAt: now,
      });
      return buyerAddressProjection(
        await loadBuyerAddress(executor, wallet, addressId),
        requireEncryptionKey(this.#key),
      );
    });
  }

  async createBuyerAddressTarget(actor: FulfillmentActor, addressId: string, idempotencyKey: string) {
    const wallet = buyerWallet(actor);
    validateResourceId(addressId, 'addressId');
    validateIdempotencyKey(idempotencyKey);
    const address = await this.#transactions.transaction((executor) => loadBuyerAddress(executor, wallet, addressId));
    if (address.status !== 'ACTIVE') throw new CoreError('UnknownState', 'Buyer address was deleted', 409);
    const payload = decryptJson(address, requireEncryptionKey(this.#key), `buyer-address:${wallet}:${addressId}`);
    return this.#createDeliveryTarget(actor, {
      idempotencyKey,
      recipientName: requiredPayloadString(payload, 'recipientName'),
      phone: requiredPayloadString(payload, 'phone'),
      address: requiredPayloadString(payload, 'detailAddress'),
      longitude: requiredPayloadNumber(payload, 'longitude'),
      latitude: requiredPayloadNumber(payload, 'latitude'),
    });
  }

  getBuyerOverview(actor: FulfillmentActor) {
    const wallet = buyerWallet(actor);
    return this.#transactions.transaction(async (executor) => {
      const counts = await executor.query<{
        pending_shipment: string | number;
        pending_receipt: string | number;
        after_sale: string | number;
        total: string | number;
      }>(
        `SELECT
           count(*) FILTER (WHERE orders.state IN ('PAID', 'TAKEOVER')) AS pending_shipment,
           count(*) FILTER (WHERE orders.state IN ('SHIPPED', 'DELIVERED', 'FULFILLMENT_PENDING')) AS pending_receipt,
           count(*) FILTER (WHERE orders.state = 'ARBITRATION' OR EXISTS (
             SELECT 1 FROM core.fulfillment_requests request
             WHERE request.order_id = orders.order_id
               AND request.request_type IN ('EXCHANGE', 'DELAY')
               AND request.state = 'OPEN'
           )) AS after_sale,
           count(*) AS total
         FROM core.orders orders WHERE orders.buyer_wallet = $1`,
        [wallet],
      );
      const row = counts.rows[0];
      if (!row) throw new CoreError('UnknownState', 'Buyer overview projection is unavailable', 409);
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        orderCounts: {
          pendingPayment: { status: 'DecisionBlocked', count: null, blocker: 'BUYER_PENDING_PAYMENT_PROJECTION' },
          pendingShipment: { status: 'AVAILABLE', count: String(row.pending_shipment) },
          pendingReceipt: { status: 'AVAILABLE', count: String(row.pending_receipt) },
          afterSale: { status: 'AVAILABLE', count: String(row.after_sale) },
          total: { status: 'AVAILABLE', count: String(row.total) },
        },
      };
    });
  }

  getBuyerTakeoverTimeline(actor: FulfillmentActor, orderId: string) {
    const wallet = buyerWallet(actor);
    validateResourceId(orderId, 'orderId');
    return this.#transactions.transaction(async (executor) => {
      const order = await executor.query<{ order_id: string }>(
        'SELECT order_id FROM core.orders WHERE order_id = $1 AND buyer_wallet = $2',
        [orderId, wallet],
      );
      if (!order.rows[0]) throw new CoreError('Forbidden', 'Order is outside the buyer scope', 403);
      const result = await executor.query<{
        transition_id: string;
        from_state: string | null;
        to_state: string;
        public_evidence_type: string;
        public_evidence_hash: string;
        occurred_at: Date | string;
      }>(
        `SELECT transition_id, from_state, to_state, public_evidence_type,
                public_evidence_hash, occurred_at
         FROM core.takeover_case_transitions
         WHERE order_id = $1 ORDER BY occurred_at, transition_id`,
        [orderId],
      );
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        orderId,
        historyStatus: result.rows.some((row) => row.public_evidence_type === 'LEGACY_OPEN_EVIDENCE')
          ? 'PARTIAL_LEGACY'
          : 'COMPLETE',
        transitions: result.rows.map((row) => ({
          transitionId: row.transition_id,
          fromState: row.from_state,
          toState: row.to_state,
          evidenceType: row.public_evidence_type,
          occurredAt: new Date(row.occurred_at).toISOString(),
        })),
      };
    });
  }

  getMerchantProfile(actor: FulfillmentActor) {
    return this.#transactions.transaction(async (executor) => {
      const merchant = await authorizedMerchant(executor, actor, false);
      return merchantProfileProjection(merchant);
    });
  }

  updateMerchantProfile(actor: FulfillmentActor, input: MerchantProfileUpdate) {
    validateMerchantProfile(input);
    const wallet = normalizedWallet(actor.walletAddress);
    return this.#transactions.transaction(async (executor) => {
      const merchant = await authorizedMerchant(executor, actor, true);
      const requestHash = hashJson({
        domain: 'ABU24K_MERCHANT_PROFILE_V1',
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        merchantId: merchant.merchant_id,
        shopName: input.shopName,
        logoAssetId: input.logoAssetId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      });
      const duplicate = await accountCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (duplicate) {
        assertCommand(duplicate, 'MERCHANT_PROFILE_UPDATE', merchant.merchant_id);
        return merchantProfileProjection(await loadMerchant(executor, merchant.merchant_id));
      }
      if (Number(merchant.profile_version) !== input.expectedVersion) {
        throw new CoreError('UnknownState', 'Merchant profile version changed', 409);
      }
      await verifyProfileAsset(
        executor,
        wallet,
        'MERCHANT',
        merchant.merchant_id,
        'MERCHANT_LOGO',
        input.logoAssetId,
      );
      const now = this.#clock();
      const profile = {
        ...merchant.profile,
        shopName: input.shopName.trim(),
        logoAssetId: input.logoAssetId?.toLowerCase() ?? null,
      };
      await executor.query(
        `UPDATE core.merchants
         SET profile = $2, profile_version = profile_version + 1, updated_at = $3
         WHERE merchant_id = $1`,
        [merchant.merchant_id, JSON.stringify(profile), now],
      );
      await insertCommand(executor, {
        wallet,
        merchantId: merchant.merchant_id,
        commandType: 'MERCHANT_PROFILE_UPDATE',
        resourceId: merchant.merchant_id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdAt: now,
      });
      await enqueueAccountAudit(executor, {
        wallet,
        role: 'MERCHANT',
        merchantId: merchant.merchant_id,
        eventType: 'MerchantProfileUpdated',
        resourceType: 'MERCHANT_PROFILE',
        resourceId: merchant.merchant_id,
        requestHash,
        correlationId: input.correlationId,
        payload: { shopNameChanged: true, logoConfigured: input.logoAssetId !== null },
        createdAt: now,
      });
      return merchantProfileProjection(await loadMerchant(executor, merchant.merchant_id));
    });
  }

  recordMerchantAuditExport(actor: FulfillmentActor, input: {
    from: Date;
    to: Date;
    entryCount: number;
    idempotencyKey: string;
    correlationId: string;
  }) {
    validateIdempotencyKey(input.idempotencyKey);
    if (!Number.isSafeInteger(input.entryCount) || input.entryCount < 0 || input.entryCount > 1_000) {
      throw new CoreError('InvalidRequest', 'Merchant audit export count is invalid');
    }
    const wallet = normalizedWallet(actor.walletAddress);
    return this.#transactions.transaction(async (executor) => {
      const merchant = await authorizedMerchant(executor, actor, true);
      const requestHash = hashJson({
        domain: 'ABU24K_MERCHANT_AUDIT_EXPORT_V1',
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        merchantId: merchant.merchant_id,
        from: input.from.toISOString(),
        to: input.to.toISOString(),
        entryCount: input.entryCount,
        idempotencyKey: input.idempotencyKey,
      });
      const duplicate = await accountCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (duplicate) {
        assertCommand(duplicate, 'MERCHANT_AUDIT_EXPORT', merchant.merchant_id);
        return { recorded: true as const, existing: true as const };
      }
      const now = this.#clock();
      await insertCommand(executor, {
        wallet,
        merchantId: merchant.merchant_id,
        commandType: 'MERCHANT_AUDIT_EXPORT',
        resourceId: merchant.merchant_id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdAt: now,
      });
      await enqueueAccountAudit(executor, {
        wallet,
        role: 'MERCHANT',
        merchantId: merchant.merchant_id,
        eventType: 'MerchantAuditExported',
        resourceType: 'MERCHANT_AUDIT',
        resourceId: merchant.merchant_id,
        requestHash,
        correlationId: input.correlationId,
        payload: {
          from: input.from.toISOString(),
          to: input.to.toISOString(),
          entryCount: input.entryCount,
        },
        createdAt: now,
      });
      return { recorded: true as const, existing: false as const };
    });
  }

  recordMerchantOrderExport(actor: FulfillmentActor, input: {
    exportId: string;
    contentHash: string;
    rowCount: number;
    filters: Record<string, unknown>;
    idempotencyKey: string;
    correlationId: string;
  }) {
    validateIdempotencyKey(input.idempotencyKey);
    if (!/^0x[0-9a-f]{64}$/.test(input.exportId) || !/^0x[0-9a-f]{64}$/.test(input.contentHash)) {
      throw new CoreError('InvalidRequest', 'Merchant order export identity is invalid');
    }
    if (!Number.isSafeInteger(input.rowCount) || input.rowCount < 0 || input.rowCount > 1_000) {
      throw new CoreError('InvalidRequest', 'Merchant order export count is invalid');
    }
    const wallet = normalizedWallet(actor.walletAddress);
    return this.#transactions.transaction(async (executor) => {
      const merchant = await authorizedMerchant(executor, actor, true);
      const requestHash = hashJson({
        domain: 'ABU24K_MERCHANT_ORDER_EXPORT_AUDIT_V1',
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        merchantId: merchant.merchant_id,
        exportId: input.exportId,
        contentHash: input.contentHash,
        rowCount: input.rowCount,
        filters: input.filters,
        idempotencyKey: input.idempotencyKey,
      });
      const duplicate = await accountCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (duplicate) {
        assertCommand(duplicate, 'MERCHANT_ORDER_EXPORT', input.exportId);
        return { recorded: true as const, existing: true as const };
      }
      const now = this.#clock();
      await insertCommand(executor, {
        wallet,
        merchantId: merchant.merchant_id,
        commandType: 'MERCHANT_ORDER_EXPORT',
        resourceId: input.exportId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdAt: now,
      });
      await enqueueAccountAudit(executor, {
        wallet,
        role: 'MERCHANT',
        merchantId: merchant.merchant_id,
        eventType: 'MerchantOrdersExported',
        resourceType: 'MERCHANT_ORDER_EXPORT',
        resourceId: input.exportId,
        requestHash,
        correlationId: input.correlationId,
        payload: {
          contentHash: input.contentHash,
          rowCount: input.rowCount,
          filters: input.filters,
        },
        createdAt: now,
      });
      return { recorded: true as const, existing: false as const };
    });
  }

  private async writeBuyerAddress(
    wallet: string,
    addressId: string | undefined,
    input: BuyerAddressInput,
    commandType: 'BUYER_ADDRESS_CREATE' | 'BUYER_ADDRESS_UPDATE',
  ) {
    validateBuyerAddress(input);
    const retentionPolicyVersion = requireRetentionPolicy(this.#retentionPolicyVersion);
    const key = requireEncryptionKey(this.#key);
    const normalizedAddressId = addressId
      ?? `address:${hashJson({ wallet, idempotencyKey: input.idempotencyKey }).slice(2, 34)}`;
    const requestHash = hashJson({
      domain: 'ABU24K_BUYER_ADDRESS_V1',
      artifactVersion: CORE_ARTIFACT_VERSION,
      wallet,
      addressId: normalizedAddressId,
      ...input,
    });
    const replay = await this.#transactions.transaction(async (executor) => {
      const duplicate = await accountCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (!duplicate) return undefined;
      assertCommand(duplicate, commandType, duplicate.resource_id);
      return buyerAddressProjection(
        await loadBuyerAddress(executor, wallet, duplicate.resource_id),
        key,
      );
    });
    if (replay) return replay;
    const region = await this.#regions.reverseGeocode({ longitude: input.longitude, latitude: input.latitude });
    return this.#transactions.transaction(async (executor) => {
      await lockBuyerAccount(executor, wallet, this.#clock());
      const duplicate = await accountCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (duplicate) {
        assertCommand(duplicate, commandType, duplicate.resource_id);
        return buyerAddressProjection(
          await loadBuyerAddress(executor, wallet, duplicate.resource_id),
          key,
        );
      }
      const current = addressId ? await loadBuyerAddress(executor, wallet, addressId, true) : undefined;
      if (current && (current.status !== 'ACTIVE' || Number(current.version) !== input.expectedVersion)) {
        throw new CoreError('UnknownState', 'Buyer address version changed or was deleted', 409);
      }
      const now = this.#clock();
      const payload = {
        label: input.label.trim(),
        recipientName: input.recipientName.trim(),
        phone: input.phone,
        detailAddress: input.detailAddress.trim(),
        longitude: input.longitude,
        latitude: input.latitude,
        province: region.province,
        city: region.city,
        district: region.district,
        formattedAddress: region.formattedAddress,
        regionCode: region.regionCode,
        sourceReferenceHash: region.sourceReferenceHash,
      };
      const encrypted = encryptJson(payload, key, `buyer-address:${wallet}:${normalizedAddressId}`);
      const activeCount = await executor.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM core.buyer_saved_addresses
         WHERE buyer_wallet = $1 AND status = 'ACTIVE'`,
        [wallet],
      );
      const shouldDefault = input.isDefault || Number(activeCount.rows[0]?.count ?? 0) === 0;
      if (shouldDefault) {
        await executor.query(
          `UPDATE core.buyer_saved_addresses
           SET is_default = false, version = version + 1, updated_at = $2
           WHERE buyer_wallet = $1 AND status = 'ACTIVE' AND is_default AND address_id <> $3`,
          [wallet, now, normalizedAddressId],
        );
      }
      if (current) {
        await executor.query(
          `UPDATE core.buyer_saved_addresses SET
             encrypted_payload = $3, encryption_iv = $4, encryption_tag = $5,
             retention_policy_version = $6, is_default = $7,
             version = version + 1, updated_at = $8
           WHERE buyer_wallet = $1 AND address_id = $2`,
          [
            wallet,
            normalizedAddressId,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.tag,
            retentionPolicyVersion,
            shouldDefault || current.is_default,
            now,
          ],
        );
      } else {
        await executor.query(
          `INSERT INTO core.buyer_saved_addresses (
             address_id, buyer_wallet, encrypted_payload, encryption_iv, encryption_tag,
             retention_policy_version, is_default,
             status, version, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',1,$8,$8)`,
          [
            normalizedAddressId,
            wallet,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.tag,
            retentionPolicyVersion,
            shouldDefault,
            now,
          ],
        );
      }
      await insertCommand(executor, {
        wallet,
        commandType,
        resourceId: normalizedAddressId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdAt: now,
      });
      await enqueueAccountAudit(executor, {
        wallet,
        role: 'BUYER',
        eventType: current ? 'BuyerAddressUpdated' : 'BuyerAddressCreated',
        resourceType: 'BUYER_ADDRESS',
        resourceId: normalizedAddressId,
        requestHash,
        correlationId: input.idempotencyKey,
        payload: { addressId: normalizedAddressId, regionBound: true, isDefault: shouldDefault },
        createdAt: now,
      });
      return buyerAddressProjection(
        await loadBuyerAddress(executor, wallet, normalizedAddressId),
        key,
      );
    });
  }
}

function buyerProfileProjection(row: BuyerProfileRow | undefined, wallet: string, key: Buffer | undefined) {
  const nickname = row?.encrypted_nickname
    ? requiredPayloadString(decryptJson(row, requireEncryptionKey(key), `buyer-profile:${wallet}`), 'nickname')
    : null;
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    wallet,
    accountId: null,
    accountIdStatus: 'DecisionBlocked' as const,
    nickname,
    avatarAssetId: row?.avatar_asset_id ?? null,
    version: row ? Number(row.version) : 0,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  };
}

function buyerAddressProjection(row: BuyerAddressRow, key: Buffer) {
  if (row.status !== 'ACTIVE') throw new CoreError('UnknownState', 'Buyer address was deleted', 409);
  const payload = decryptJson(row, key, `buyer-address:${row.buyer_wallet}:${row.address_id}`);
  return {
    addressId: row.address_id,
    label: requiredPayloadString(payload, 'label'),
    recipientName: requiredPayloadString(payload, 'recipientName'),
    phone: requiredPayloadString(payload, 'phone'),
    detailAddress: requiredPayloadString(payload, 'detailAddress'),
    longitude: requiredPayloadNumber(payload, 'longitude'),
    latitude: requiredPayloadNumber(payload, 'latitude'),
    province: requiredPayloadString(payload, 'province'),
    city: requiredPayloadString(payload, 'city'),
    district: requiredPayloadString(payload, 'district'),
    formattedAddress: requiredPayloadString(payload, 'formattedAddress'),
    regionCode: requiredPayloadString(payload, 'regionCode'),
    isDefault: row.is_default,
    version: Number(row.version),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function merchantProfileProjection(row: MerchantRow) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    merchantId: row.merchant_id,
    shopName: typeof row.profile.shopName === 'string' ? row.profile.shopName : null,
    logoAssetId: typeof row.profile.logoAssetId === 'string' ? row.profile.logoAssetId : null,
    settlementWallet: row.settlement_wallet,
    settlementWalletMutable: false as const,
    version: Number(row.profile_version),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function authorizedMerchant(executor: SqlExecutor, actor: FulfillmentActor, lock: boolean) {
  const wallet = normalizedWallet(actor.walletAddress);
  if (!actor.roles.includes('MERCHANT') || !actor.merchantId) {
    throw new CoreError('Forbidden', 'Merchant role is required', 403);
  }
  const result = await executor.query<MerchantRow>(
    `SELECT merchant.* FROM core.merchants merchant
     JOIN core.wallet_role_bindings binding
       ON binding.merchant_id = merchant.merchant_id
      AND binding.wallet_address = $1 AND binding.role = 'MERCHANT' AND binding.status = 'ACTIVE'
     WHERE merchant.merchant_id = $2 ${lock ? 'FOR UPDATE OF merchant' : ''}`,
    [wallet, actor.merchantId],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Merchant binding is inactive or mismatched', 403);
  return result.rows[0];
}

async function loadMerchant(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<MerchantRow>('SELECT * FROM core.merchants WHERE merchant_id = $1', [merchantId]);
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Merchant was not found', 404);
  return result.rows[0];
}

async function loadBuyerProfile(executor: SqlExecutor, wallet: string, lock = false) {
  const result = await executor.query<BuyerProfileRow>(
    `SELECT * FROM core.buyer_profiles WHERE buyer_wallet = $1${lock ? ' FOR UPDATE' : ''}`,
    [wallet],
  );
  return result.rows[0];
}

async function loadBuyerAddress(executor: SqlExecutor, wallet: string, addressId: string, lock = false) {
  const result = await executor.query<BuyerAddressRow>(
    `SELECT * FROM core.buyer_saved_addresses
     WHERE buyer_wallet = $1 AND address_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [wallet, addressId],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Buyer address is outside the wallet scope', 403);
  return result.rows[0];
}

async function accountCommand(executor: SqlExecutor, wallet: string, idempotencyKey: string, requestHash: string) {
  const result = await executor.query<AccountCommandRow>(
    'SELECT request_hash, command_type, resource_id FROM core.account_write_commands WHERE actor_wallet = $1 AND idempotency_key = $2',
    [wallet, idempotencyKey],
  );
  const row = result.rows[0];
  if (row && row.request_hash !== requestHash) throw new CoreError('IdempotencyConflict', 'Account command changed', 409);
  return row;
}

function assertCommand(row: AccountCommandRow, commandType: string, resourceId: string) {
  if (row.command_type !== commandType || row.resource_id !== resourceId) {
    throw new CoreError('IdempotencyConflict', 'Account command identity changed', 409);
  }
}

async function insertCommand(executor: SqlExecutor, input: {
  wallet: string;
  merchantId?: string;
  commandType: string;
  resourceId: string;
  idempotencyKey: string;
  requestHash: string;
  createdAt: Date;
}) {
  await executor.query(
    `INSERT INTO core.account_write_commands (
       command_id, actor_wallet, merchant_id, command_type, resource_id,
       idempotency_key, request_hash, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      hashJson({ wallet: input.wallet, idempotencyKey: input.idempotencyKey }),
      input.wallet,
      input.merchantId ?? null,
      input.commandType,
      input.resourceId,
      input.idempotencyKey,
      input.requestHash,
      input.createdAt,
    ],
  );
}

async function enqueueAccountAudit(executor: SqlExecutor, input: {
  wallet: string;
  role: 'BUYER' | 'MERCHANT';
  merchantId?: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  requestHash: string;
  correlationId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}) {
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:account', {
      eventType: input.eventType,
      resourceId: input.resourceId,
      requestHash: input.requestHash,
    }),
    streamName: 'operational',
    evidenceProfile: 'AUTHORIZATION',
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actorWallet: input.wallet,
    actorRole: input.role,
    ...(input.merchantId ? { merchantId: input.merchantId } : {}),
    correlationId: input.correlationId,
    requestHash: input.requestHash.slice(2),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'SESSION_RESOURCE_OWNERSHIP',
      subject: input.wallet,
      roles: [input.role],
      evidenceHash: hashJson({ role: input.role, merchantId: input.merchantId ?? null }),
      checkedAt: input.createdAt.toISOString(),
    },
    createdAt: input.createdAt,
  });
}

async function verifyProfileAsset(
  executor: SqlExecutor,
  wallet: string,
  resourceType: 'BUYER' | 'MERCHANT',
  resourceId: string,
  purpose: 'BUYER_AVATAR' | 'MERCHANT_LOGO',
  assetId: string | null,
) {
  if (assetId === null) return;
  if (!/^0x[0-9a-fA-F]{64}$/.test(assetId)) throw new CoreError('InvalidRequest', 'Invalid profile media asset id');
  const result = await executor.query<{ asset_id: string }>(
    `SELECT asset_id FROM core.media_assets
     WHERE asset_id = $1 AND owner_wallet = $2 AND resource_type = $3
       AND resource_id = $4 AND purpose = $5`,
    [assetId.toLowerCase(), wallet, resourceType, resourceId, purpose],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Profile media is unverified or outside the actor scope', 403);
}

async function promoteLatestAddress(executor: SqlExecutor, wallet: string, now: Date) {
  await executor.query(
    `UPDATE core.buyer_saved_addresses SET is_default = true, version = version + 1, updated_at = $2
     WHERE address_id = (
       SELECT address_id FROM core.buyer_saved_addresses
       WHERE buyer_wallet = $1 AND status = 'ACTIVE'
       ORDER BY updated_at DESC, address_id LIMIT 1
     )`,
    [wallet, now],
  );
}

async function lockBuyerAccount(executor: SqlExecutor, wallet: string, now: Date) {
  await executor.query(
    `INSERT INTO core.buyer_account_locks (buyer_wallet, updated_at)
     VALUES ($1,$2) ON CONFLICT (buyer_wallet) DO NOTHING`,
    [wallet, now],
  );
  await executor.query(
    'SELECT buyer_wallet FROM core.buyer_account_locks WHERE buyer_wallet = $1 FOR UPDATE',
    [wallet],
  );
}

function encryptJson(payload: Record<string, unknown>, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptJson(
  row: Pick<BuyerAddressRow, 'encrypted_payload' | 'encryption_iv' | 'encryption_tag'>
    | Pick<BuyerProfileRow, 'encrypted_nickname' | 'encryption_iv' | 'encryption_tag'>,
  key: Buffer,
  aad: string,
) {
  const ciphertext = 'encrypted_payload' in row ? row.encrypted_payload : row.encrypted_nickname;
  if (!ciphertext || !row.encryption_iv || !row.encryption_tag) {
    throw new CoreError('ExternalBlocked', 'Encrypted account data is incomplete', 503);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.encryption_iv));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(row.encryption_tag));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext)),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('InvalidPayload');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CoreError('ExternalBlocked', 'Account data decryption failed', 503);
  }
}

function parseEncryptionKey(value: string | undefined) {
  if (!value) return undefined;
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new CoreError('InvalidRequest', 'DELIVERY_DATA_ENCRYPTION_KEY must contain 32 bytes', 500);
  return key;
}

function requireEncryptionKey(key: Buffer | undefined) {
  if (!key) throw new CoreError('ConfigurationRequired', 'Account data encryption is unavailable', 503);
  return key;
}

function normalizedRetentionPolicy(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(normalized)) {
    throw new CoreError('InvalidRequest', 'PII retention policy version is invalid', 500);
  }
  return normalized;
}

function requireRetentionPolicy(value: string | undefined) {
  if (!value) throw new CoreError('DecisionBlocked', 'PII retention policy version is not frozen', 409);
  return value;
}

function validateBuyerProfile(input: BuyerProfileUpdate) {
  assertOnlyKnownObject(input, ['nickname', 'avatarAssetId', 'expectedVersion', 'idempotencyKey']);
  if (input.nickname !== null && (input.nickname.trim().length < 1 || input.nickname.trim().length > 40)) {
    throw new CoreError('InvalidRequest', 'Buyer nickname must contain 1-40 characters');
  }
  validateExpectedVersion(input.expectedVersion, true);
  validateIdempotencyKey(input.idempotencyKey);
}

function validateBuyerAddress(input: BuyerAddressInput) {
  validateIdempotencyKey(input.idempotencyKey);
  if (
    input.label.trim().length < 1 || input.label.trim().length > 32
    || input.recipientName.trim().length < 1 || input.recipientName.trim().length > 64
    || !/^1[3-9][0-9]{9}$/.test(input.phone)
    || input.detailAddress.trim().length < 5 || input.detailAddress.trim().length > 300
    || !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180
    || !Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90
  ) throw new CoreError('InvalidRequest', 'Buyer address is incomplete or invalid');
  if (input.expectedVersion !== undefined) validateExpectedVersion(input.expectedVersion);
}

function validateMerchantProfile(input: MerchantProfileUpdate) {
  if (input.shopName.trim().length < 1 || input.shopName.trim().length > 100) {
    throw new CoreError('InvalidRequest', 'Shop name must contain 1-100 characters');
  }
  validateExpectedVersion(input.expectedVersion);
  validateIdempotencyKey(input.idempotencyKey);
  if (!input.correlationId || input.correlationId.length > 128) throw new CoreError('InvalidRequest', 'Invalid correlation id');
}

function addressMissingFields(parsed: ParsedPostalAddress) {
  const fields: string[] = [];
  if (!parsed.recipientName) fields.push('recipientName');
  if (!/^1[3-9][0-9]{9}$/.test(parsed.phone ?? '')) fields.push('phone');
  if (!parsed.province) fields.push('province');
  if (!parsed.city) fields.push('city');
  if (!parsed.district) fields.push('district');
  if (!parsed.detailAddress) fields.push('detailAddress');
  if (!/^[0-9]{6}$/.test(parsed.regionCode ?? '')) fields.push('regionCode');
  if (!Number.isFinite(parsed.longitude) || !Number.isFinite(parsed.latitude)) fields.push('coordinates');
  return fields;
}

function buyerWallet(actor: FulfillmentActor) {
  if (!actor.roles.includes('BUYER')) throw new CoreError('Forbidden', 'Buyer role is required', 403);
  return normalizedWallet(actor.walletAddress);
}

function normalizedWallet(value: string) {
  const wallet = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new CoreError('Forbidden', 'Actor wallet is invalid', 403);
  return wallet;
}

function validateExpectedVersion(value: number, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new CoreError('InvalidRequest', 'expectedVersion is invalid');
  }
}

function validateIdempotencyKey(value: string) {
  if (value.length < 8 || value.length > 128) throw new CoreError('InvalidRequest', 'idempotencyKey must contain 8-128 characters');
}

function validateResourceId(value: string, label: string) {
  if (value.length < 1 || value.length > 256) throw new CoreError('InvalidRequest', `${label} is invalid`);
}

function requiredPayloadString(payload: Record<string, unknown>, name: string) {
  const value = payload[name];
  if (typeof value !== 'string' || value.length === 0) throw new CoreError('ExternalBlocked', 'Encrypted account data is invalid', 503);
  return value;
}

function requiredPayloadNumber(payload: Record<string, unknown>, name: string) {
  const value = payload[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CoreError('ExternalBlocked', 'Encrypted account data is invalid', 503);
  return value;
}

function assertOnlyKnownObject(value: object, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CoreError('InvalidRequest', 'Unknown account field');
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
