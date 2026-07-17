import { createHash, randomBytes } from 'node:crypto';
import { normalizeAddress } from '../api/auth.ts';
import {
  CORE_ARTIFACT_VERSION,
  adminExportFormats,
  adminResourceTypes,
  type AdminBatchAction,
  type AdminExportFormat,
  type AdminResourceType,
  type CatalogReviewDecision,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import {
  productLifecycleDecisionAvailability,
  productWriteLock,
  type ProductWriteLockSubject,
} from './catalog-management-service.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

type PlatformRole = 'ADMIN' | 'OPERATOR' | 'AUDITOR';

export interface AdminGlobalSearchQuery {
  resourceTypes?: AdminResourceType[];
  relation?: 'AND' | 'OR';
  orderId?: string;
  productId?: string;
  merchantId?: string;
  txHash?: string;
  uid?: string;
  wallet?: string;
  walletMatch?: 'EXACT' | 'FUZZY';
  from?: Date;
  to?: Date;
  pendingReview?: boolean;
  limit?: number;
}

export interface AdminResourceSelection {
  resourceType: AdminResourceType;
  resourceId: string;
}

export interface AdminExportInput {
  selection: AdminResourceSelection[];
  format: AdminExportFormat;
  idempotencyKey: string;
}

interface ResourceRow {
  resource_type: AdminResourceType;
  resource_id: string;
  title: string;
  status: string;
  merchant_id: string | null;
  product_id: string | null;
  created_at: Date | string;
  tag_ids: unknown;
  lifecycle_state: string;
}

interface StoredOperation {
  request_hash: string;
  result: Record<string, unknown>;
}

export class AdminGlobalOperationsService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;
  readonly #bytes32: () => string;

  constructor(input: {
    transactions: SqlTransactionRunner;
    clock?: () => Date;
    bytes32?: () => string;
  }) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
    this.#bytes32 = input.bytes32 ?? (() => `0x${randomBytes(32).toString('hex')}`);
  }

  search(actor: FulfillmentActor, input: AdminGlobalSearchQuery = {}) {
    const query = searchQuery(input);
    return this.#transactions.transaction(async (executor) => {
      const role = await requireCurrentPlatformRole(executor, actor, true);
      let effectiveQuery = query;
      if (query.uid) {
        const identity = await executor.query<{ buyer_wallet: string }>(
          'SELECT buyer_wallet FROM core.buyer_accounts WHERE uid = $1::bigint',
          [query.uid],
        );
        const buyerWallet = identity.rows[0]?.buyer_wallet;
        if (!buyerWallet || (query.wallet && query.wallet !== buyerWallet)) {
          return {
            artifactVersion: CORE_ARTIFACT_VERSION,
            relation: query.relation,
            walletMatch: query.walletMatch,
            resources: [],
            truncated: false,
            unavailableFilters: ['PHONE', 'YELLOW_QUEUE'] as const,
          };
        }
        effectiveQuery = { ...query, wallet: buyerWallet, walletMatch: 'EXACT' as const };
      }
      const rows: ResourceRow[] = [];
      if (effectiveQuery.resourceTypes.includes('ORDER')) rows.push(...await searchOrders(executor, effectiveQuery));
      if (effectiveQuery.resourceTypes.includes('PRODUCT')) rows.push(...await searchProducts(executor, effectiveQuery));
      if (effectiveQuery.resourceTypes.includes('MERCHANT')) rows.push(...await searchMerchants(executor, effectiveQuery));
      rows.sort(compareResourceRows);
      const truncated = rows.length > effectiveQuery.limit;
      const resources = [];
      for (const row of rows.slice(0, effectiveQuery.limit)) {
        const actions = await allowedBatchActions(executor, row, role, this.#clock());
        resources.push(resourceProjection(row, actions));
      }
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        relation: query.relation,
        walletMatch: query.walletMatch,
        resources,
        truncated,
        unavailableFilters: ['PHONE', 'YELLOW_QUEUE'] as const,
      };
    });
  }

  exportSelection(actor: FulfillmentActor, input: AdminExportInput) {
    const value = exportInput(input);
    const wallet = actorWallet(actor);
    const operationType = `EXPORT_${value.format}` as const;
    const requestHash = hashJson({ actor: wallet, ...value });
    return this.#transactions.transaction(async (executor) => {
      const role = await requireCurrentPlatformRole(executor, actor, true);
      const existing = await executor.query<StoredOperation>(
        `SELECT request_hash, result FROM core.admin_batch_operations
         WHERE actor_wallet = $1 AND operation_type = $2 AND idempotency_key = $3`,
        [wallet, operationType, value.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Admin export');
        return existing.rows[0].result;
      }
      const rows: ResourceRow[] = [];
      for (const item of value.selection) rows.push(await loadSelectedResource(executor, item));
      const exportRows = rows.map(exportRow);
      const generated = value.format === 'CSV' ? csvExport(exportRows) : excelExport(exportRows);
      const now = this.#clock();
      const operationId = this.#bytes32().toLowerCase();
      const contentHash = hashBytes(generated.content);
      const filename = exportFilename(value.format, now);
      const result = Object.freeze({
        artifactVersion: CORE_ARTIFACT_VERSION,
        exportId: operationId,
        format: value.format,
        filename,
        mediaType: generated.mediaType,
        rowCount: exportRows.length,
        byteLength: Buffer.byteLength(generated.content),
        contentHash,
        contentBase64: Buffer.from(generated.content, 'utf8').toString('base64'),
        createdAt: now.toISOString(),
      });
      await executor.query(
        `INSERT INTO core.admin_batch_operations (
           operation_id, operation_type, actor_wallet, actor_role, idempotency_key,
           request_hash, result, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [operationId, operationType, wallet, role, value.idempotencyKey, requestHash, JSON.stringify(result), now],
      );
      await enqueueAdminAudit(executor, {
        operationId,
        eventType: 'AdminResourcesExported',
        actor: wallet,
        role,
        requestHash,
        now,
        payload: {
          format: value.format,
          selection: value.selection,
          rowCount: exportRows.length,
          contentHash,
        },
      });
      return result;
    });
  }
}

async function searchOrders(executor: SqlExecutor, query: ReturnType<typeof searchQuery>) {
  const criteria: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    criteria.push(sql.replace('?', `$${params.length}`));
  };
  if (query.orderId) add('orders.order_id = ?', query.orderId);
  if (query.productId) add('orders.product_id = ?', query.productId);
  if (query.merchantId) add('orders.merchant_id = ?', query.merchantId);
  if (query.txHash) add('lower(orders.payment_tx_hash) = ?', query.txHash);
  if (query.wallet) {
    params.push(query.wallet);
    criteria.push(query.walletMatch === 'EXACT'
      ? `(lower(orders.buyer_wallet) = $${params.length} OR lower(orders.merchant_wallet) = $${params.length})`
      : `(strpos(lower(orders.buyer_wallet), $${params.length}) > 0 OR strpos(lower(orders.merchant_wallet), $${params.length}) > 0)`);
  }
  addDateCriterion(criteria, params, 'orders.created_at', query.from, query.to);
  if (query.pendingReview !== undefined) {
    params.push(query.pendingReview);
    criteria.push(`(product.lifecycle_state = 'REVIEW') = $${params.length}`);
  }
  params.push(query.limit + 1);
  const result = await executor.query<ResourceRow>(
    `SELECT 'ORDER'::text AS resource_type, orders.order_id AS resource_id,
       orders.order_id AS title, orders.state AS status, orders.merchant_id,
       orders.product_id, orders.created_at, '[]'::jsonb AS tag_ids,
       ''::text AS lifecycle_state
     FROM core.orders orders
     JOIN core.products product ON product.product_id = orders.product_id
     ${searchWhere(query, criteria)}
     ORDER BY orders.created_at DESC, orders.order_id DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

async function searchProducts(executor: SqlExecutor, query: ReturnType<typeof searchQuery>) {
  if (query.relation === 'AND' && (query.orderId || query.txHash)) return [];
  const criteria: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    criteria.push(sql.replace('?', `$${params.length}`));
  };
  if (query.productId) add('product.product_id = ?', query.productId);
  if (query.merchantId) add('product.merchant_id = ?', query.merchantId);
  if (query.wallet) add(query.walletMatch === 'EXACT'
    ? 'lower(merchant.settlement_wallet) = ?'
    : 'strpos(lower(merchant.settlement_wallet), ?) > 0', query.wallet);
  addDateCriterion(criteria, params, 'product.created_at', query.from, query.to);
  if (query.pendingReview !== undefined) add("(product.lifecycle_state = 'REVIEW') = ?", query.pendingReview);
  params.push(query.limit + 1);
  const result = await executor.query<ResourceRow>(
    `SELECT 'PRODUCT'::text AS resource_type, product.product_id AS resource_id,
       product.title, product.lifecycle_state AS status, product.merchant_id,
       product.product_id, product.created_at,
       COALESCE((SELECT jsonb_agg(assignment.tag_id ORDER BY assignment.tag_id)
         FROM core.product_tag_assignments assignment
         WHERE assignment.product_id = product.product_id
           AND assignment.product_version = product.version), '[]'::jsonb) AS tag_ids,
       product.lifecycle_state
     FROM core.products product
     JOIN core.merchants merchant ON merchant.merchant_id = product.merchant_id
     ${searchWhere(query, criteria)}
     ORDER BY product.created_at DESC, product.product_id DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

async function searchMerchants(executor: SqlExecutor, query: ReturnType<typeof searchQuery>) {
  if (query.relation === 'AND' && (query.orderId || query.productId || query.txHash)) return [];
  const criteria: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    criteria.push(sql.replace('?', `$${params.length}`));
  };
  if (query.merchantId) add('merchant.merchant_id = ?', query.merchantId);
  if (query.wallet) add(query.walletMatch === 'EXACT'
    ? 'lower(merchant.settlement_wallet) = ?'
    : 'strpos(lower(merchant.settlement_wallet), ?) > 0', query.wallet);
  addDateCriterion(criteria, params, 'merchant.created_at', query.from, query.to);
  if (query.pendingReview !== undefined) add("(merchant.status = 'PENDING') = ?", query.pendingReview);
  params.push(query.limit + 1);
  const result = await executor.query<ResourceRow>(
    `SELECT 'MERCHANT'::text AS resource_type, merchant.merchant_id AS resource_id,
       COALESCE(NULLIF(merchant.profile->>'shopName', ''), merchant.merchant_id) AS title,
       merchant.status, merchant.merchant_id, NULL::text AS product_id,
       merchant.created_at, '[]'::jsonb AS tag_ids,
       ''::text AS lifecycle_state
     FROM core.merchants merchant
     ${searchWhere(query, criteria)}
     ORDER BY merchant.created_at DESC, merchant.merchant_id DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

async function loadSelectedResource(executor: SqlExecutor, item: AdminResourceSelection) {
  const sources: Record<AdminResourceType, string> = {
    ORDER: `SELECT 'ORDER'::text AS resource_type, orders.order_id AS resource_id,
      orders.order_id AS title, orders.state AS status, orders.merchant_id,
      orders.product_id, orders.created_at, '[]'::jsonb AS tag_ids,
      ''::text AS lifecycle_state FROM core.orders orders WHERE orders.order_id = $1`,
    PRODUCT: `SELECT 'PRODUCT'::text AS resource_type, product.product_id AS resource_id,
      product.title, product.lifecycle_state AS status, product.merchant_id,
      product.product_id, product.created_at,
      COALESCE((SELECT jsonb_agg(assignment.tag_id ORDER BY assignment.tag_id)
        FROM core.product_tag_assignments assignment
        WHERE assignment.product_id = product.product_id
          AND assignment.product_version = product.version), '[]'::jsonb) AS tag_ids,
      product.lifecycle_state FROM core.products product WHERE product.product_id = $1`,
    MERCHANT: `SELECT 'MERCHANT'::text AS resource_type, merchant.merchant_id AS resource_id,
      COALESCE(NULLIF(merchant.profile->>'shopName', ''), merchant.merchant_id) AS title,
      merchant.status, merchant.merchant_id, NULL::text AS product_id,
      merchant.created_at, '[]'::jsonb AS tag_ids,
      ''::text AS lifecycle_state FROM core.merchants merchant WHERE merchant.merchant_id = $1`,
  };
  const result = await executor.query<ResourceRow>(sources[item.resourceType], [item.resourceId]);
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Selected Admin resource does not exist', 404, { ...item });
  return result.rows[0];
}

async function allowedBatchActions(
  executor: SqlExecutor,
  row: ResourceRow,
  role: PlatformRole,
  now: Date,
) {
  const actions: Array<{ action: AdminBatchAction; enabled: boolean; reasonCode?: string }> = [
    { action: 'EXPORT_CSV', enabled: true },
    { action: 'EXPORT_EXCEL', enabled: true },
  ];
  if (row.resource_type === 'PRODUCT') {
    if (role === 'AUDITOR') {
      actions.push({ action: 'ADD_PRODUCT_TAGS', enabled: false, reasonCode: 'Forbidden' });
      for (const item of productLifecycleBatchActions) {
        actions.push({ action: item.action, enabled: false, reasonCode: 'Forbidden' });
      }
    } else {
      const subject: ProductWriteLockSubject = {
        product_id: row.product_id!,
        lifecycle_state: row.lifecycle_state,
      };
      const lock = await productWriteLock(executor, subject, now);
      actions.push(lock
        ? { action: 'ADD_PRODUCT_TAGS', enabled: false, reasonCode: 'ProductWriteLocked' }
        : { action: 'ADD_PRODUCT_TAGS', enabled: true });
      for (const item of productLifecycleBatchActions) {
        const availability = await productLifecycleDecisionAvailability(
          executor,
          row.product_id!,
          item.decision,
          now,
        );
        actions.push(availability.enabled
          ? { action: item.action, enabled: true }
          : { action: item.action, enabled: false, reasonCode: availability.reasonCode });
      }
    }
  }
  return actions;
}

const productLifecycleBatchActions: ReadonlyArray<{
  action: AdminBatchAction;
  decision: CatalogReviewDecision;
}> = [
  { action: 'APPROVE_PRODUCTS', decision: 'APPROVE' },
  { action: 'REJECT_PRODUCTS', decision: 'REJECT' },
  { action: 'PUBLISH_PRODUCTS', decision: 'PUBLISH' },
  { action: 'HIDE_PRODUCTS', decision: 'HIDE' },
  { action: 'DELIST_PRODUCTS', decision: 'DELIST' },
];

function resourceProjection(row: ResourceRow, allowedActions: Awaited<ReturnType<typeof allowedBatchActions>>) {
  return Object.freeze({
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    title: row.title,
    status: row.status,
    merchantId: row.merchant_id,
    productId: row.product_id,
    tagIds: stringArray(row.tag_ids),
    allowedBatchActions: allowedActions,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function exportRow(row: ResourceRow) {
  return {
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    title: row.title,
    status: row.status,
    merchantId: row.merchant_id ?? '',
    productId: row.product_id ?? '',
    tagIds: stringArray(row.tag_ids).join('|'),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const exportColumns = [
  'resourceType', 'resourceId', 'title', 'status', 'merchantId', 'productId', 'tagIds', 'createdAt',
] as const;

function csvExport(rows: Array<ReturnType<typeof exportRow>>) {
  const lines = [exportColumns.join(','), ...rows.map((row) => exportColumns.map((column) => csvCell(row[column])).join(','))];
  return { mediaType: 'text/csv; charset=utf-8', content: `\uFEFF${lines.join('\r\n')}\r\n` };
}

function excelExport(rows: Array<ReturnType<typeof exportRow>>) {
  const rowXml = [
    exportColumns.map((column) => excelCell(column)),
    ...rows.map((row) => exportColumns.map((column) => excelCell(row[column]))),
  ].map((cells) => `<Row>${cells.join('')}</Row>`).join('');
  const content = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Admin Export">` +
    `<Table>${rowXml}</Table></Worksheet></Workbook>`;
  return { mediaType: 'application/vnd.ms-excel; charset=utf-8', content };
}

function csvCell(value: string) {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

function excelCell(value: string) {
  return `<Cell><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
}

function xmlEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function exportFilename(format: AdminExportFormat, now: Date) {
  const stamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `abu24k-admin-resources-${stamp}.${format === 'CSV' ? 'csv' : 'xls'}`;
}

function searchQuery(input: AdminGlobalSearchQuery) {
  const resourceTypes = input.resourceTypes ?? [...adminResourceTypes];
  if (resourceTypes.length < 1 || new Set(resourceTypes).size !== resourceTypes.length
    || resourceTypes.some((type) => !adminResourceTypes.includes(type))) {
    throw new CoreError('InvalidRequest', 'Admin resource types are invalid');
  }
  for (const [name, value] of Object.entries({
    orderId: input.orderId, productId: input.productId, merchantId: input.merchantId,
  })) if (value !== undefined) validateResourceId(value, name);
  const relation = input.relation ?? 'AND';
  if (relation !== 'AND' && relation !== 'OR') throw new CoreError('InvalidRequest', 'Admin search relation is invalid');
  const walletMatch = input.walletMatch ?? 'EXACT';
  if (walletMatch !== 'EXACT' && walletMatch !== 'FUZZY') {
    throw new CoreError('InvalidRequest', 'Admin wallet match mode is invalid');
  }
  const txHash = input.txHash?.toLowerCase();
  if (txHash && !/^0x[0-9a-f]{64}$/.test(txHash)) throw new CoreError('InvalidRequest', 'txHash is invalid');
  const uid = input.uid?.trim();
  if (uid && (!/^[1-9][0-9]{0,18}$/.test(uid) || (uid.length === 19 && uid > '9223372036854775807'))) {
    throw new CoreError('InvalidRequest', 'Buyer UID is invalid');
  }
  const wallet = input.wallet
    ? walletMatch === 'EXACT' ? normalizedWallet(input.wallet) : fuzzyWalletFragment(input.wallet)
    : undefined;
  if (input.from && input.to && input.from >= input.to) throw new CoreError('InvalidRequest', 'Search time range is invalid');
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError('InvalidRequest', 'Search limit must be 1-100');
  const hasCriteria = Boolean(
    input.orderId || input.productId || input.merchantId || txHash || uid || wallet || input.from || input.to
      || input.pendingReview !== undefined,
  );
  if (uid && (relation !== 'AND' || walletMatch !== 'EXACT')) {
    throw new CoreError('InvalidRequest', 'Buyer UID requires exact AND search');
  }
  return {
    resourceTypes,
    relation,
    walletMatch,
    hasCriteria,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.productId ? { productId: input.productId } : {}),
    ...(input.merchantId ? { merchantId: input.merchantId } : {}),
    ...(txHash ? { txHash } : {}),
    ...(uid ? { uid } : {}),
    ...(wallet ? { wallet } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.pendingReview !== undefined ? { pendingReview: input.pendingReview } : {}),
    limit,
  };
}

function addDateCriterion(
  criteria: string[],
  params: unknown[],
  column: string,
  from?: Date,
  to?: Date,
) {
  const parts: string[] = [];
  if (from) {
    params.push(from);
    parts.push(`${column} >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    parts.push(`${column} < $${params.length}`);
  }
  if (parts.length) criteria.push(`(${parts.join(' AND ')})`);
}

function searchWhere(query: ReturnType<typeof searchQuery>, criteria: string[]) {
  if (criteria.length) return `WHERE ${criteria.join(` ${query.relation} `)}`;
  return query.hasCriteria ? 'WHERE false' : '';
}

function fuzzyWalletFragment(value: string) {
  if (typeof value !== 'string') throw new CoreError('InvalidRequest', 'Fuzzy wallet fragment is invalid');
  const fragment = value.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{6,40}$/.test(fragment)) {
    throw new CoreError('InvalidRequest', 'Fuzzy wallet fragment must contain 6-40 hexadecimal characters');
  }
  return fragment;
}

function exportInput(input: AdminExportInput) {
  if (!adminExportFormats.includes(input.format)) throw new CoreError('InvalidRequest', 'Admin export format is invalid');
  if (!Array.isArray(input.selection) || input.selection.length < 1 || input.selection.length > 100) {
    throw new CoreError('InvalidRequest', 'Admin export requires 1-100 selected resources');
  }
  validateIdempotencyKey(input.idempotencyKey);
  const selection = input.selection.map((item) => {
    if (!item || !adminResourceTypes.includes(item.resourceType)) throw new CoreError('InvalidRequest', 'Admin export resource type is invalid');
    validateResourceId(item.resourceId, 'resourceId');
    return { resourceType: item.resourceType, resourceId: item.resourceId };
  });
  const keys = selection.map((item) => `${item.resourceType}:${item.resourceId}`);
  if (new Set(keys).size !== keys.length) throw new CoreError('InvalidRequest', 'Admin export selection contains duplicates');
  return { format: input.format, selection: [...selection].sort(compareSelection), idempotencyKey: input.idempotencyKey };
}

async function requireCurrentPlatformRole(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  readOnly: boolean,
): Promise<PlatformRole> {
  const allowed: PlatformRole[] = readOnly ? ['ADMIN', 'OPERATOR', 'AUDITOR'] : ['ADMIN', 'OPERATOR'];
  const result = await executor.query<{ role: PlatformRole }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE wallet_address = $1 AND status = 'ACTIVE'
       AND role IN (${allowed.map((_, index) => `$${index + 2}`).join(',')})
     ORDER BY CASE role WHEN 'ADMIN' THEN 1 WHEN 'OPERATOR' THEN 2 ELSE 3 END LIMIT 1`,
    [actorWallet(actor), ...allowed],
  );
  if (!result.rows[0] || !actor.roles.includes(result.rows[0].role)) {
    throw new CoreError('Forbidden', 'Active Admin resource role is required', 403);
  }
  return result.rows[0].role;
}

async function enqueueAdminAudit(executor: SqlExecutor, input: {
  operationId: string;
  eventType: string;
  actor: string;
  role: PlatformRole;
  requestHash: string;
  now: Date;
  payload: Record<string, unknown>;
}) {
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('admin-global-operations', {
      eventType: input.eventType, operationId: input.operationId, requestHash: input.requestHash,
    }),
    streamName: 'operational',
    evidenceProfile: 'RBAC',
    eventType: input.eventType,
    resourceType: 'ADMIN_BATCH_OPERATION',
    resourceId: input.operationId,
    actorWallet: input.actor,
    actorRole: input.role,
    correlationId: `admin-global:${input.operationId}`,
    requestHash: input.requestHash.slice(2),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: input.actor,
      roles: [input.role],
      evidenceHash: hashJson({ subject: input.actor, role: input.role, checkedAt: input.now.toISOString() }),
      checkedAt: input.now.toISOString(),
    },
    createdAt: input.now,
  });
}

function compareResourceRows(left: ResourceRow, right: ResourceRow) {
  return new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
    || left.resource_type.localeCompare(right.resource_type)
    || left.resource_id.localeCompare(right.resource_id);
}

function compareSelection(left: AdminResourceSelection, right: AdminResourceSelection) {
  return left.resourceType.localeCompare(right.resourceType) || left.resourceId.localeCompare(right.resourceId);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function actorWallet(actor: FulfillmentActor) {
  try {
    return normalizeAddress(actor.walletAddress);
  } catch {
    throw new CoreError('Forbidden', 'Actor wallet is invalid', 403);
  }
}

function normalizedWallet(value: string) {
  try {
    return normalizeAddress(value);
  } catch {
    throw new CoreError('InvalidRequest', 'wallet must be an exact address');
  }
}

function validateResourceId(value: string, label: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new CoreError('InvalidRequest', `${label} is invalid`);
}

function validateIdempotencyKey(value: string) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new CoreError('InvalidRequest', 'idempotencyKey is invalid');
}

function idempotencyConflict(label: string) {
  return new CoreError('IdempotencyConflict', `${label} idempotency key was reused with different input`, 409);
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function hashBytes(value: string) {
  return `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
