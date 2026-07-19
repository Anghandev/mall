import {
  artifactVersion,
  guaranteeStatuses,
  merchantLifecycleStatuses,
  merchantReviewActions,
  settlementRequestStates,
  type MediaAssetProjection,
  type MediaContentType,
  type MediaReadAccessProjection,
  type MediaUploadIntentProjection,
  type MerchantApplicationCreateRequest,
  type MerchantApplicationUpdateRequest,
  type MerchantLifecycleDetail,
  type MerchantLifecycleList,
  type MerchantLifecycleStatus,
  type MerchantReviewAction,
  type MerchantReviewChallenge,
  type MerchantReviewChallengeRequest,
} from '@abu24k/core-artifacts';
import { CoreApiError, requestCoreJson } from './coreApi';

const amountPattern = /^(0|[1-9][0-9]*)$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const signaturePattern = /^0x(?:[0-9a-fA-F]{2})+$/;
const reasonPattern = /^[A-Z0-9_:-]{2,64}$/;
const licenseContentTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

export type MerchantLifecycleQuery = Readonly<{
  status?: MerchantLifecycleStatus;
  search?: string;
  limit?: number;
  cursorCreatedAt?: string;
  cursorMerchantId?: string;
}>;

export async function listMerchantLifecycle(
  query: MerchantLifecycleQuery,
  token: string,
  signal?: AbortSignal,
): Promise<MerchantLifecycleList> {
  const params = new URLSearchParams();
  if (query.status) {
    if (!merchantLifecycleStatuses.includes(query.status)) throw invalid('Merchant status is invalid', 400);
    params.set('status', query.status);
  }
  if (query.search) params.set('search', boundedText(query.search, 'search', 100));
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw invalid('Merchant limit must be 1-100', 400);
    params.set('limit', String(query.limit));
  }
  if (query.cursorCreatedAt) {
    if (!validDate(query.cursorCreatedAt)) throw invalid('Merchant cursorCreatedAt is invalid', 400);
    params.set('cursorCreatedAt', query.cursorCreatedAt);
  }
  if (query.cursorMerchantId) params.set('cursorMerchantId', resourceId(query.cursorMerchantId));
  const body = await authenticatedGet(`/v2/admin/merchants${params.size ? `?${params}` : ''}`, token, signal);
  if (!isMerchantLifecycleList(body)) throw invalid('Merchant lifecycle list does not match the coordinated generated type');
  return body;
}

export async function getMerchantLifecycle(
  merchantId: string,
  token: string,
  signal?: AbortSignal,
): Promise<MerchantLifecycleDetail> {
  const normalized = resourceId(merchantId);
  const body = await authenticatedGet(`/v2/admin/merchants/${encodeURIComponent(normalized)}`, token, signal);
  if (!isMerchantLifecycleDetail(body) || body.merchant.merchantId !== normalized) {
    throw invalid('Merchant lifecycle detail does not match the requested merchant');
  }
  return body;
}

export async function createMerchantApplication(
  input: MerchantApplicationCreateRequest,
  token: string,
): Promise<MerchantLifecycleDetail> {
  validateApplication(input, true);
  const body = await authenticatedWrite('/v2/admin/merchants', 'POST', input, token);
  if (!isMerchantLifecycleDetail(body) || body.merchant.status !== 'PENDING' || body.merchant.applicationVersion < 1) {
    throw invalid('Created merchant application does not match the coordinated generated type');
  }
  return body;
}

export async function updateMerchantApplication(
  merchantId: string,
  input: MerchantApplicationUpdateRequest,
  token: string,
): Promise<MerchantLifecycleDetail> {
  validateApplication(input, false);
  const normalized = resourceId(merchantId);
  const body = await authenticatedWrite(`/v2/admin/merchants/${encodeURIComponent(normalized)}/application`, 'PUT', input, token);
  if (
    !isMerchantLifecycleDetail(body)
      || body.merchant.merchantId !== normalized
      || body.merchant.applicationVersion !== input.expectedVersion + 1
  ) throw invalid('Updated merchant application is not bound to the expected version');
  return body;
}

export async function createMerchantReviewChallenge(
  merchant: MerchantLifecycleDetail,
  input: MerchantReviewChallengeRequest,
  actorWallet: string,
  token: string,
): Promise<MerchantReviewChallenge> {
  if (!merchantReviewActions.includes(input.action)) throw invalid('Merchant review action is invalid', 400);
  requireReason(input.reasonCode);
  requireIdempotencyKey(input.idempotencyKey);
  requireAddress(actorWallet, 'actorWallet');
  const expected = reviewTransition(merchant.merchant.status, input.action);
  const body = await authenticatedWrite(
    `/v2/admin/merchants/${encodeURIComponent(resourceId(merchant.merchant.merchantId))}/review-challenges`,
    'POST',
    input,
    token,
  );
  if (!isMerchantReviewChallenge(body, merchant, input, expected)) {
    throw invalid('Merchant review challenge is not bound to the selected status and application version');
  }
  if (body.secondarySigner.toLowerCase() === actorWallet.toLowerCase()) {
    throw invalid('Merchant review requires an independent secondary wallet', 403);
  }
  return body;
}

export async function publishMerchantReview(
  challenge: MerchantReviewChallenge,
  signature: string,
  token: string,
): Promise<MerchantLifecycleDetail> {
  if (challenge.state !== 'DRAFT' || Date.parse(challenge.expiresAt) <= Date.now()) {
    throw invalid('Merchant review challenge is expired', 401);
  }
  if (!signaturePattern.test(signature)) throw invalid('Merchant review signature is invalid', 400);
  const body = await authenticatedWrite(
    `/v2/admin/merchants/${encodeURIComponent(resourceId(challenge.merchantId))}/review-actions/${challenge.actionId.toLowerCase()}/publish`,
    'POST',
    { signature },
    token,
  );
  if (
    !isMerchantLifecycleDetail(body)
      || body.merchant.merchantId !== challenge.merchantId
      || body.merchant.status !== challenge.toStatus
      || body.merchant.applicationVersion !== challenge.applicationVersion
      || !body.reviews.some((review) => review.actionId.toLowerCase() === challenge.actionId.toLowerCase()
        && review.state === 'PUBLISHED'
        && review.approvalSignatureHash !== null)
  ) throw invalid('Published merchant review lacks bound secondary-signature evidence');
  return body;
}

export async function uploadMerchantLicense(
  merchantId: string,
  file: File,
  idempotencyKey: string,
  ownerWallet: string,
  token: string,
): Promise<MediaAssetProjection> {
  const normalizedMerchantId = resourceId(merchantId);
  if (!licenseContentTypes.includes(file.type as typeof licenseContentTypes[number])) {
    throw invalid('Merchant license must be JPG, PNG, WebP or PDF', 400);
  }
  if (file.size < 1 || file.size > 10_485_760) throw invalid('Merchant license must be 1 byte to 10 MB', 400);
  requireIdempotencyKey(idempotencyKey);
  requireAddress(ownerWallet, 'ownerWallet');
  const contentSha256 = await sha256File(file);
  const request = {
    purpose: 'MERCHANT_LICENSE' as const,
    resourceType: 'MERCHANT' as const,
    resourceId: normalizedMerchantId,
    contentType: file.type as MediaContentType,
    sizeBytes: file.size,
    contentSha256,
    idempotencyKey,
  };
  const intentBody = await authenticatedWrite('/v2/media/upload-intents', 'POST', request, token);
  if (!isLicenseUploadIntent(intentBody, request, ownerWallet)) {
    throw invalid('Merchant license upload intent does not match the selected file and merchant');
  }
  await putMediaFile(intentBody, file);
  const assetBody = await authenticatedWrite(
    `/v2/media/upload-intents/${intentBody.uploadIntentId.toLowerCase()}/complete`,
    'POST',
    {},
    token,
  );
  if (!isLicenseAsset(assetBody, intentBody)) throw invalid('Merchant license asset is not bound to the completed upload');
  return assetBody;
}

export async function fetchMerchantLicenseAccess(
  merchantId: string,
  assetId: string,
  token: string,
): Promise<MediaReadAccessProjection> {
  requireHash(assetId, 'licenseAssetId');
  const body = await authenticatedGet(`/v2/media/assets/${assetId.toLowerCase()}/access`, token);
  if (!isLicenseReadAccess(body, resourceId(merchantId), assetId)) {
    throw invalid('Merchant license read access is not bound to the selected merchant');
  }
  return body;
}

async function putMediaFile(intent: MediaUploadIntentProjection, file: File) {
  const headers = new Headers(intent.headers);
  if (!headers.has('content-type')) headers.set('content-type', intent.contentType);
  let response: Response;
  try {
    response = await fetch(intent.uploadUrl, { method: 'PUT', headers, body: file });
  } catch {
    throw new CoreApiError({ code: 'ExternalBlocked', message: 'Merchant license storage is unreachable', status: 503 });
  }
  if (!response.ok) throw new CoreApiError({ code: 'ExternalBlocked', message: 'Merchant license storage rejected the upload', status: response.status });
}

async function sha256File(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return `0x${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function validateApplication(input: MerchantApplicationCreateRequest | MerchantApplicationUpdateRequest, create: boolean) {
  boundedText(input.shopName, 'shopName', 80);
  boundedText(input.legalName, 'legalName', 80, 2);
  boundedText(input.legalId, 'legalId', 32, 6);
  boundedText(input.contactPhone, 'contactPhone', 32, 6);
  requireIdempotencyKey(input.idempotencyKey);
  if (create) requireAddress((input as MerchantApplicationCreateRequest).settlementWallet, 'settlementWallet');
  else {
    const update = input as MerchantApplicationUpdateRequest;
    if (!Number.isSafeInteger(update.expectedVersion) || update.expectedVersion < 1) throw invalid('expectedVersion must be positive', 400);
    if (update.licenseAssetId !== null) requireHash(update.licenseAssetId, 'licenseAssetId');
  }
}

function isMerchantLifecycleList(value: unknown): value is MerchantLifecycleList {
  if (!isRecord(value) || value.artifactVersion !== artifactVersion || !Array.isArray(value.merchants) || !value.merchants.every(isMerchantSummary)) return false;
  return value.nextCursor === null || (isRecord(value.nextCursor) && validDate(value.nextCursor.createdAt) && validResourceId(value.nextCursor.merchantId));
}

function isMerchantSummary(value: unknown): value is MerchantLifecycleDetail['merchant'] {
  return isRecord(value)
    && validResourceId(value.merchantId)
    && (value.shopName === null || typeof value.shopName === 'string')
    && addressPattern.test(String(value.settlementWallet))
    && value.settlementWalletMutable === false
    && merchantLifecycleStatuses.includes(value.status as MerchantLifecycleStatus)
    && guaranteeStatuses.includes(value.guaranteeStatus as never)
    && Number.isSafeInteger(value.applicationVersion) && Number(value.applicationVersion) >= 0
    && typeof value.qualificationComplete === 'boolean'
    && (value.reviewedAt === null || validDate(value.reviewedAt))
    && (value.reviewedBy === null || addressPattern.test(String(value.reviewedBy)))
    && validDate(value.createdAt) && validDate(value.updatedAt);
}

function isMerchantLifecycleDetail(value: unknown): value is MerchantLifecycleDetail {
  if (!isRecord(value) || value.artifactVersion !== artifactVersion || !isMerchantSummary(value.merchant) || !isQualification(value.qualification)) return false;
  if (!isRecord(value.analytics) || !isOrderAnalytics(value.analytics.orders) || !isFulfillmentAnalytics(value.analytics.fulfillment)
    || !isRiskAnalytics(value.analytics.risk) || !isContributionAnalytics(value.analytics.contributions)) return false;
  if (!Array.isArray(value.balances) || value.balances.length !== 5 || !value.balances.every((item) => isRecord(item)
    && ['LOCKED', 'AVAILABLE', 'REQUESTED', 'SUBMITTED', 'SETTLED'].includes(String(item.state)) && amountPattern.test(String(item.amount)))
    || new Set(value.balances.map((item) => item.state)).size !== 5) return false;
  if (!Array.isArray(value.settlements) || !value.settlements.every(isSettlement)) return false;
  return Array.isArray(value.reviews) && value.reviews.every(isReviewEvidence);
}

function isQualification(value: unknown) {
  if (!isRecord(value) || !['FULL', 'REDACTED', 'UNAVAILABLE'].includes(String(value.access))) return false;
  if (value.access === 'UNAVAILABLE') return value.reason === 'PARTIAL_LEGACY' && value.licenseAssetId === null;
  return ['legalName', 'legalId', 'contactPhone'].every((field) => value[field] === null || typeof value[field] === 'string')
    && (value.licenseAssetId === null || bytes32Pattern.test(String(value.licenseAssetId)))
    && bytes32Pattern.test(String(value.payloadHash))
    && (value.retentionPolicyVersion === null || typeof value.retentionPolicyVersion === 'string')
    && Number.isSafeInteger(value.version) && Number(value.version) >= 1
    && validDate(value.updatedAt);
}

function isOrderAnalytics(value: unknown) {
  return isRecord(value) && ['totalFinalized', 'ordinaryFinalized', 'seckillFinalized'].every((field) => amountPattern.test(String(value[field])))
    && isNamedAmounts(value.cumulative) && isNamedAmounts(value.today) && value.timezone === 'Asia/Shanghai'
    && isRecord(value.window) && validDate(value.window.start) && validDate(value.window.end);
}

function isNamedAmounts(value: unknown) {
  return isRecord(value) && ['listPriceUsdt', 'buyerPaidUsdt', 'merchantBaseReceivableUsdt', 'merchantNetReceivableUsdt']
    .every((field) => amountPattern.test(String(value[field])));
}

function isFulfillmentAnalytics(value: unknown) {
  return isRecord(value) && ['pendingShipment', 'inTransit', 'completed', 'pickupCompleted'].every((field) => amountPattern.test(String(value[field])))
    && isFastShip48h(value.fastShip48h);
}

function isFastShip48h(value: unknown) {
  if (!isRecord(value) || !amountPattern.test(String(value.numerator)) || !amountPattern.test(String(value.denominator))) return false;
  if (value.status === 'UNAVAILABLE') {
    return value.denominator === '0' && value.bps === null && value.reason === 'NO_ELIGIBLE_DELIVERY_ORDERS';
  }
  return value.status === 'AVAILABLE'
    && value.denominator !== '0'
    && Number.isSafeInteger(value.bps) && Number(value.bps) >= 0 && Number(value.bps) <= 10_000
    && value.reason === null;
}

function isRiskAnalytics(value: unknown) {
  return isRecord(value) && ['takeoverCases', 'guaranteeUsedUsdt', 'frozenReceivableUsedUsdt', 'futureProceedsUsedUsdt', 'platformAdvanceUsdt', 'outstandingDebtUsdt']
    .every((field) => amountPattern.test(String(value[field])))
    && value.abnormalOrderRateBps === null && value.unavailableReason === 'DecisionBlocked';
}

function isContributionAnalytics(value: unknown) {
  return isRecord(value) && amountPattern.test(String(value.finalizedNplBurnAmount))
    && amountPattern.test(String(value.fulfillmentAvailableBnmAmount)) && value.ledgerReconciled === true;
}

function isSettlement(value: unknown) {
  return isRecord(value) && bytes32Pattern.test(String(value.requestId)) && ['USDT', 'NPL'].includes(String(value.asset))
    && amountPattern.test(String(value.amount)) && settlementRequestStates.includes(value.state as never)
    && validDate(value.requestedAt) && Array.isArray(value.finalExecutionTxHashes)
    && value.finalExecutionTxHashes.every((item) => bytes32Pattern.test(String(item)))
    && (value.settledAt === null || validDate(value.settledAt));
}

function isReviewEvidence(value: unknown) {
  return isRecord(value) && bytes32Pattern.test(String(value.actionId)) && merchantReviewActions.includes(value.action as MerchantReviewAction)
    && merchantLifecycleStatuses.includes(value.fromStatus as MerchantLifecycleStatus) && merchantLifecycleStatuses.includes(value.toStatus as MerchantLifecycleStatus)
    && Number.isSafeInteger(value.applicationVersion) && Number(value.applicationVersion) >= 1 && typeof value.reasonCode === 'string'
    && ['DRAFT', 'PUBLISHED', 'EXPIRED'].includes(String(value.state))
    && (value.secondarySigner === null || addressPattern.test(String(value.secondarySigner)))
    && (value.actionDigest === null || bytes32Pattern.test(String(value.actionDigest)))
    && (value.approvalSignatureHash === null || bytes32Pattern.test(String(value.approvalSignatureHash)))
    && validDate(value.createdAt) && validDate(value.updatedAt);
}

function isMerchantReviewChallenge(
  value: unknown,
  merchant: MerchantLifecycleDetail,
  input: MerchantReviewChallengeRequest,
  toStatus: MerchantLifecycleStatus,
): value is MerchantReviewChallenge {
  if (!isRecord(value) || value.artifactVersion !== artifactVersion || !bytes32Pattern.test(String(value.actionId))
    || value.merchantId !== merchant.merchant.merchantId || value.action !== input.action || value.fromStatus !== merchant.merchant.status
    || value.toStatus !== toStatus || value.applicationVersion !== merchant.merchant.applicationVersion || value.reasonCode !== input.reasonCode
    || value.state !== 'DRAFT' || !addressPattern.test(String(value.secondarySigner)) || !validDate(value.expiresAt)
    || Date.parse(String(value.expiresAt)) <= Date.now() || !bytes32Pattern.test(String(value.digest)) || !isRecord(value.typedData)) return false;
  const typedData = value.typedData;
  if (!isRecord(typedData.domain) || !isRecord(typedData.types) || typedData.primaryType !== 'SensitiveAction' || !isRecord(typedData.message)) return false;
  const message = typedData.message;
  return message.action === `${input.action}_MERCHANT` && message.resourceType === 'MERCHANT'
    && message.resourceId === merchant.merchant.merchantId && amountPattern.test(String(message.policyVersion))
    && bytes32Pattern.test(String(message.oldValueHash)) && bytes32Pattern.test(String(message.newValueHash))
    && addressPattern.test(String(message.executorWallet)) && amountPattern.test(String(message.nonce))
    && String(message.deadline) === String(Math.floor(Date.parse(String(value.expiresAt)) / 1_000));
}

function isLicenseUploadIntent(value: unknown, expected: {
  resourceId: string; contentType: MediaContentType; sizeBytes: number; contentSha256: string;
}, ownerWallet: string): value is MediaUploadIntentProjection {
  return isRecord(value) && value.artifactVersion === artifactVersion && bytes32Pattern.test(String(value.uploadIntentId))
    && String(value.ownerWallet).toLowerCase() === ownerWallet.toLowerCase() && value.purpose === 'MERCHANT_LICENSE'
    && value.resourceType === 'MERCHANT' && value.resourceId === expected.resourceId && value.contentType === expected.contentType
    && String(value.sizeBytes) === String(expected.sizeBytes) && String(value.contentSha256).toLowerCase() === expected.contentSha256.toLowerCase()
    && value.state === 'UPLOADED' && validDate(value.expiresAt) && value.method === 'PUT' && typeof value.uploadUrl === 'string'
    && isRecord(value.headers) && bytes32Pattern.test(String(value.providerReferenceHash)) && value.writeOnce === true;
}

function isLicenseAsset(value: unknown, intent: MediaUploadIntentProjection): value is MediaAssetProjection {
  return isRecord(value) && value.artifactVersion === artifactVersion && bytes32Pattern.test(String(value.assetId))
    && value.uploadIntentId === intent.uploadIntentId && String(value.ownerWallet).toLowerCase() === intent.ownerWallet.toLowerCase()
    && value.purpose === 'MERCHANT_LICENSE' && value.resourceType === 'MERCHANT' && value.resourceId === intent.resourceId
    && value.contentType === intent.contentType && value.sizeBytes === intent.sizeBytes
    && String(value.contentSha256).toLowerCase() === intent.contentSha256.toLowerCase()
    && bytes32Pattern.test(String(value.providerEvidenceHash)) && bytes32Pattern.test(String(value.objectVersionHash)) && validDate(value.createdAt);
}

function isLicenseReadAccess(value: unknown, merchantId: string, assetId: string): value is MediaReadAccessProjection {
  return isRecord(value) && value.artifactVersion === artifactVersion && String(value.assetId).toLowerCase() === assetId.toLowerCase()
    && value.purpose === 'MERCHANT_LICENSE' && value.resourceType === 'MERCHANT' && value.resourceId === merchantId
    && licenseContentTypes.includes(value.contentType as typeof licenseContentTypes[number]) && amountPattern.test(String(value.sizeBytes))
    && bytes32Pattern.test(String(value.contentSha256)) && bytes32Pattern.test(String(value.objectVersionHash))
    && value.accessScope === 'AUTHENTICATED' && value.method === 'GET' && typeof value.readUrl === 'string'
    && validDate(value.expiresAt) && bytes32Pattern.test(String(value.providerReferenceHash));
}

function reviewTransition(status: MerchantLifecycleStatus, action: MerchantReviewAction): MerchantLifecycleStatus {
  if (status === 'PENDING' && action === 'APPROVE') return 'APPROVED';
  if (status === 'PENDING' && action === 'REJECT') return 'REJECTED';
  if (status === 'APPROVED' && action === 'BLACKLIST') return 'BLACKLISTED';
  throw invalid(`Merchant ${status} cannot apply ${action}`, 409);
}

async function authenticatedGet(path: string, token: string, signal?: AbortSignal) {
  return requestCoreJson(path, { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
}

async function authenticatedWrite(path: string, method: 'POST' | 'PUT', body: object, token: string) {
  return requestCoreJson(path, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method,
  });
}

function boundedText(value: string, field: string, max: number, min = 1) {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw invalid(`${field} must contain ${min}-${max} characters`, 400);
  return trimmed;
}

function requireIdempotencyKey(value: string) { boundedText(value, 'idempotencyKey', 128, 8); }
function requireReason(value: string) { if (!reasonPattern.test(value)) throw invalid('reasonCode is invalid', 400); }
function requireHash(value: string, field: string) { if (!bytes32Pattern.test(value)) throw invalid(`${field} must be bytes32`, 400); }
function requireAddress(value: string, field: string) { if (!addressPattern.test(value)) throw invalid(`${field} must be an address`, 400); }
function resourceId(value: string) { return boundedText(value, 'merchantId', 256); }
function validResourceId(value: unknown): value is string { return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 256; }
function validDate(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(message: string, status = 502) { return new CoreApiError({ code: 'InvalidResponse', message, status }); }
