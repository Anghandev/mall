import {
  adminBatchActions,
  adminExportFormats,
  adminResourceTypes,
  artifactVersion,
  catalogProductLifecycleStates,
  catalogReviewDecisions,
  coreErrorCodes,
  type AdminExportFormat,
  type AdminGlobalSearchResponse,
  type AdminProductBatchTagRequest,
  type AdminProductBatchTagResult,
  type AdminProductLifecycleBatchRequest,
  type AdminProductLifecycleBatchResult,
  type AdminResourceExport,
  type AdminResourceExportRequest,
  type AdminResourceSelection,
  type AdminResourceSummary,
  type AdminResourceType,
} from '@abu24k/core-artifacts';
import { CoreApiError, requestCoreJson } from './coreApi';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const walletFragmentPattern = /^(?:0x)?[0-9a-fA-F]{6,40}$/;
const amountPattern = /^(0|[1-9][0-9]*)$/;
const reasonCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const unavailableFilters = ['PHONE', 'YELLOW_QUEUE'] as const;

export type AdminGlobalSearchFilters = Readonly<{
  resourceTypes?: readonly AdminResourceType[];
  relation?: 'AND' | 'OR';
  orderId?: string;
  productId?: string;
  merchantId?: string;
  txHash?: string;
  uid?: string;
  wallet?: string;
  walletMatch?: 'EXACT' | 'FUZZY';
  from?: string;
  to?: string;
  pendingReview?: boolean;
  limit?: number;
}>;

export async function searchAdminGlobalResources(
  filters: AdminGlobalSearchFilters,
  token: string,
  signal?: AbortSignal,
): Promise<AdminGlobalSearchResponse> {
  const relation = filters.relation ?? 'AND';
  const walletMatch = filters.walletMatch ?? 'EXACT';
  const query = globalSearchQuery({ ...filters, relation, walletMatch });
  const body = await requestCoreJson(`/v2/admin/global/resources?${query}`, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!isAdminGlobalSearchResponse(body, relation, walletMatch)) {
    throw invalidResponse('Admin global resource search does not match the coordinated generated type');
  }
  return body;
}

export async function batchApplyAdminProductLifecycle(
  input: AdminProductLifecycleBatchRequest,
  token: string,
): Promise<AdminProductLifecycleBatchResult> {
  if (!catalogReviewDecisions.includes(input.action)) throw invalidRequest('Admin product lifecycle action is invalid');
  const productIds = validateResourceIds(input.productIds, 'productIds', 100);
  const reasonCode = input.reasonCode.trim();
  if (!reasonCodePattern.test(reasonCode)) throw invalidRequest('Lifecycle reasonCode must be 2-64 uppercase characters');
  requireIdempotencyKey(input.idempotencyKey);
  const request = { ...input, productIds, reasonCode };
  const body = await requestCoreJson('/v2/admin/catalog/products/batch-lifecycle', authenticatedPost(token, request));
  if (!isAdminProductLifecycleBatchResult(body, request)) {
    throw invalidResponse('Admin product lifecycle batch result does not match the coordinated generated type');
  }
  return body;
}

export async function exportAdminGlobalResources(
  input: AdminResourceExportRequest,
  token: string,
): Promise<AdminResourceExport> {
  validateSelection(input.selection);
  if (!adminExportFormats.includes(input.format)) throw invalidRequest('Admin export format is invalid');
  requireIdempotencyKey(input.idempotencyKey);
  const body = await requestCoreJson('/v2/admin/global/exports', authenticatedPost(token, input));
  if (!isAdminResourceExport(body, input.format, input.selection.length)) {
    throw invalidResponse('Admin global export does not match the coordinated generated type');
  }
  return body;
}

export async function batchAddAdminProductTags(
  input: AdminProductBatchTagRequest,
  token: string,
): Promise<AdminProductBatchTagResult> {
  const productIds = validateResourceIds(input.productIds, 'productIds', 100);
  const tagIds = validateResourceIds(input.tagIds, 'tagIds', 20);
  requireIdempotencyKey(input.idempotencyKey);
  const body = await requestCoreJson('/v2/admin/catalog/products/batch-tags', authenticatedPost(token, input));
  if (!isAdminProductBatchTagResult(body, productIds, tagIds)) {
    throw invalidResponse('Admin product batch-tag result does not match the coordinated generated type');
  }
  return body;
}

export function downloadAdminResourceExport(value: AdminResourceExport) {
  if (typeof URL.createObjectURL !== 'function') {
    throw new CoreApiError({ code: 'ExternalBlocked', message: '当前浏览器不支持本地文件下载', status: 503 });
  }
  const binary = atob(value.contentBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: value.mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = value.filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function globalSearchQuery(filters: AdminGlobalSearchFilters & Required<Pick<AdminGlobalSearchFilters, 'relation' | 'walletMatch'>>) {
  const query = new URLSearchParams();
  const resourceTypes = filters.resourceTypes ?? adminResourceTypes;
  if (resourceTypes.length < 1 || resourceTypes.length > adminResourceTypes.length
    || new Set(resourceTypes).size !== resourceTypes.length
    || !resourceTypes.every((type) => adminResourceTypes.includes(type))) {
    throw invalidRequest('At least one unique Admin resource type is required');
  }
  resourceTypes.forEach((type) => query.append('resourceType', type));
  if (!['AND', 'OR'].includes(filters.relation)) throw invalidRequest('Search relation is invalid');
  query.set('relation', filters.relation);
  for (const [key, value] of Object.entries({
    orderId: filters.orderId,
    productId: filters.productId,
    merchantId: filters.merchantId,
  })) {
    if (value !== undefined) query.set(key, resourceId(value, key));
  }
  if (filters.txHash !== undefined) {
    const txHash = filters.txHash.trim().toLowerCase();
    if (!bytes32Pattern.test(txHash)) throw invalidRequest('交易编号格式不正确，请复制钱包里的 0x 开头交易编号。');
    query.set('txHash', txHash);
  }
  if (filters.uid !== undefined) {
    const uid = filters.uid.trim();
    if (!/^[1-9][0-9]{0,18}$/.test(uid) || (uid.length === 19 && uid > '9223372036854775807')) {
      throw invalidRequest('用户编号请输入正整数。');
    }
    if (filters.relation !== 'AND' || filters.walletMatch !== 'EXACT') {
      throw invalidRequest('按用户编号查询时，请使用“同时满足”和“精确钱包”模式。');
    }
    query.set('uid', uid);
  }
  if (filters.wallet !== undefined) {
    const wallet = filters.wallet.trim().toLowerCase();
    if (filters.walletMatch === 'EXACT' && !addressPattern.test(wallet)) {
      throw invalidRequest('钱包地址格式不正确，请填写完整 0x 地址。');
    }
    if (filters.walletMatch === 'FUZZY' && !walletFragmentPattern.test(wallet)) {
      throw invalidRequest('模糊钱包查询请输入 6 到 40 位十六进制字符。');
    }
    query.set('wallet', wallet);
  }
  if (!['EXACT', 'FUZZY'].includes(filters.walletMatch)) throw invalidRequest('钱包查询方式不正确。');
  query.set('walletMatch', filters.walletMatch);
  if (filters.from !== undefined) query.set('from', dateTime(filters.from, 'from'));
  if (filters.to !== undefined) query.set('to', dateTime(filters.to, 'to'));
  if (filters.from !== undefined && filters.to !== undefined
    && Date.parse(filters.from) >= Date.parse(filters.to)) throw invalidRequest('开始时间必须早于结束时间。');
  if (filters.pendingReview !== undefined) query.set('pendingReview', String(filters.pendingReview));
  const limit = filters.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidRequest('查询数量请填写 1 到 100。');
  query.set('limit', String(limit));
  return query.toString();
}

function authenticatedPost(token: string, body: object): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  };
}

function isAdminGlobalSearchResponse(
  value: unknown,
  expectedRelation: 'AND' | 'OR',
  expectedWalletMatch: 'EXACT' | 'FUZZY',
): value is AdminGlobalSearchResponse {
  return isRecord(value)
    && value.artifactVersion === artifactVersion
    && value.relation === expectedRelation
    && value.walletMatch === expectedWalletMatch
    && Array.isArray(value.resources)
    && value.resources.every(isAdminResourceSummary)
    && typeof value.truncated === 'boolean'
    && Array.isArray(value.unavailableFilters)
    && value.unavailableFilters.every((filter) => unavailableFilters.includes(filter as never))
    && new Set(value.unavailableFilters).size === value.unavailableFilters.length;
}

function isAdminResourceSummary(value: unknown): value is AdminResourceSummary {
  return isRecord(value)
    && adminResourceTypes.includes(value.resourceType as never)
    && validResourceId(value.resourceId)
    && validText(value.title, 256)
    && validText(value.status, 64)
    && (value.merchantId === null || validResourceId(value.merchantId))
    && (value.productId === null || validResourceId(value.productId))
    && Array.isArray(value.tagIds)
    && value.tagIds.every(validResourceId)
    && new Set(value.tagIds).size === value.tagIds.length
    && Array.isArray(value.allowedBatchActions)
    && value.allowedBatchActions.every((capability) => isRecord(capability)
      && adminBatchActions.includes(capability.action as never)
      && typeof capability.enabled === 'boolean'
      && (capability.reasonCode === undefined || coreErrorCodes.includes(capability.reasonCode as never)))
    && validDate(value.createdAt);
}

function isAdminProductLifecycleBatchResult(
  value: unknown,
  request: AdminProductLifecycleBatchRequest,
): value is AdminProductLifecycleBatchResult {
  if (!isRecord(value)
    || value.artifactVersion !== artifactVersion
    || !bytes32Pattern.test(String(value.operationId))
    || value.action !== request.action
    || value.changedCount !== request.productIds.length
    || !Array.isArray(value.products)
    || value.products.length !== request.productIds.length
    || !validDate(value.createdAt)) return false;
  if (!value.products.every((item) => isRecord(item)
    && validResourceId(item.productId)
    && catalogProductLifecycleStates.includes(item.previousState as never)
    && catalogProductLifecycleStates.includes(item.state as never)
    && item.previousState !== item.state)) return false;
  return sameStringSet(value.products.map((item) => String(item.productId)), request.productIds);
}

function isAdminResourceExport(
  value: unknown,
  expectedFormat: AdminExportFormat,
  expectedRows: number,
): value is AdminResourceExport {
  if (!isRecord(value)
    || value.artifactVersion !== artifactVersion
    || !bytes32Pattern.test(String(value.exportId))
    || value.format !== expectedFormat
    || !validText(value.filename, 160)
    || value.mediaType !== (expectedFormat === 'CSV' ? 'text/csv; charset=utf-8' : 'application/vnd.ms-excel; charset=utf-8')
    || value.rowCount !== expectedRows
    || !Number.isSafeInteger(value.byteLength)
    || Number(value.byteLength) < 1
    || !bytes32Pattern.test(String(value.contentHash))
    || typeof value.contentBase64 !== 'string'
    || !base64Pattern.test(value.contentBase64)
    || !validDate(value.createdAt)) return false;
  return base64ByteLength(value.contentBase64) === value.byteLength;
}

function isAdminProductBatchTagResult(
  value: unknown,
  requestedProductIds: readonly string[],
  requestedTagIds: readonly string[],
): value is AdminProductBatchTagResult {
  if (!isRecord(value)
    || value.artifactVersion !== artifactVersion
    || !bytes32Pattern.test(String(value.operationId))
    || value.action !== 'ADD_PRODUCT_TAGS'
    || !sameStringSet(value.tagIds, requestedTagIds)
    || !Number.isSafeInteger(value.changedCount)
    || Number(value.changedCount) < 0
    || !Array.isArray(value.products)
    || value.products.length !== requestedProductIds.length
    || !validDate(value.createdAt)) return false;
  if (!value.products.every((item) => isRecord(item)
    && validResourceId(item.productId)
    && amountPattern.test(String(item.previousVersion))
    && amountPattern.test(String(item.version))
    && Array.isArray(item.addedTagIds)
    && item.addedTagIds.every(validResourceId)
    && item.addedTagIds.every((tagId) => requestedTagIds.includes(tagId))
    && new Set(item.addedTagIds).size === item.addedTagIds.length)) return false;
  return sameStringSet(value.products.map((item) => String(item.productId)), requestedProductIds)
    && value.changedCount === value.products.filter((item) => item.addedTagIds.length > 0).length;
}

function validateSelection(selection: readonly AdminResourceSelection[]) {
  if (!Array.isArray(selection) || selection.length < 1 || selection.length > 100) {
    throw invalidRequest('Admin export requires 1-100 selected resources');
  }
  const keys = selection.map((item) => {
    if (!adminResourceTypes.includes(item.resourceType)) throw invalidRequest('Admin export resource type is invalid');
    return `${item.resourceType}:${resourceId(item.resourceId, 'resourceId')}`;
  });
  if (new Set(keys).size !== keys.length) throw invalidRequest('Admin export selection contains duplicates');
}

function validateResourceIds(values: readonly string[], field: string, max: number) {
  if (!Array.isArray(values) || values.length < 1 || values.length > max) {
    throw invalidRequest(`${field} must contain 1-${max} items`);
  }
  const normalized = values.map((value) => resourceId(value, field));
  if (new Set(normalized).size !== normalized.length) throw invalidRequest(`${field} contains duplicates`);
  return normalized;
}

function requireIdempotencyKey(value: string) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw invalidRequest('系统提交编号异常，请刷新页面后重试。');
  }
}

function resourceId(value: string, field: string) {
  const normalized = value.trim();
  if (!validResourceId(normalized)) throw invalidRequest(`${field} must contain 1-256 characters`);
  return normalized;
}

function validResourceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 256;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength;
}

function dateTime(value: string, field: string) {
  const timestamp = new Date(value);
  if (!value || Number.isNaN(timestamp.getTime())) throw invalidRequest(`${field} must be a valid timestamp`);
  return timestamp.toISOString();
}

function validDate(value: unknown) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function base64ByteLength(value: string) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function sameStringSet(value: unknown, expected: readonly string[]) {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string')
    && value.length === expected.length
    && new Set(value).size === value.length
    && value.every((item) => expected.includes(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string) {
  return new CoreApiError({ code: 'InvalidRequest', message, status: 400 });
}

function invalidResponse(message: string) {
  return new CoreApiError({ code: 'InvalidResponse', message, status: 502 });
}
