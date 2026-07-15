import {
  artifactVersion,
  auditEvidenceProfiles,
  auditStreamNames,
  balanceStates,
  breakerScopes,
  cmsContentFormats,
  cmsContentTypes,
  guaranteeStatuses,
  merchantGuaranteeDepositStates,
  operationsAlertEventTypes,
  operationsAlertSeverities,
  operationsMetricComponents,
  operationsMetricStatuses,
  operationsMetricUnits,
  notificationCampaignStates,
  notificationCampaignTopics,
  notificationDeliveryStates,
  policyDraftStates,
  rewardSubtypes,
  settlementRails,
  settlementRequestStates,
  systemConfigKeys,
  takeoverStates,
  type AdminBusinessDashboard,
  type AuditStreamName,
  type AuditListResponse,
  type CmsVersionCreateRequest,
  type CmsVersionProjection,
  type CoverageBreakerActionProjection,
  type CoverageBreakerResumeChallenge,
  type CoverageBreakerResumeChallengeRequest,
  type CoverageBreakerResumeRequest,
  type MerchantFinanceProjection,
  type MonitoringAcknowledgeResult,
  type MonitoringDashboard,
  type NotificationCampaignCreateResult,
  type NotificationCampaignPublishResult,
  type NotificationCampaignRequest,
  type NotificationInboxItem,
  type PolicyApprovalChallenge,
  type PolicyDraftCreateRequest,
  type PolicyDraftDetail,
  type PolicyDraftProjection,
  type PolicyDraftUpdateRequest,
  type PolicySecondarySignatureRequest,
  type SettlementListProjection,
  type SensitiveApproval,
  type SystemConfigCreateRequest,
  type SystemConfigProjection,
  type TakeoverFundingChallenge,
  type TakeoverFundingChallengeRequest,
  type TakeoverFundingDetail,
  type TakeoverFundingRequest,
  type TakeoverFundingResult,
} from '@abu24k/core-artifacts';
import { CoreApiError, requestCoreJson } from './coreApi';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const amountPattern = /^(0|[1-9][0-9]*)$/;
const signaturePattern = /^0x(?:[0-9a-fA-F]{2})+$/;

export type AuditFilters = Readonly<{
  streamName?: AuditStreamName;
  eventType?: string;
  resourceType?: string;
  resourceId?: string;
  correlationId?: string;
  actorWallet?: string;
  from?: string;
  to?: string;
  cursorCreatedAt?: string;
  cursorEntryId?: string;
  limit?: number;
}>;

export async function fetchAdminBusinessDashboard(
  token: string,
  signal?: AbortSignal,
): Promise<AdminBusinessDashboard> {
  const body = await authenticatedGet('/v2/admin/dashboard', token, signal);
  if (!isAdminBusinessDashboard(body)) {
    throw invalid('Admin business dashboard does not match the coordinated generated type');
  }
  return body;
}

export async function fetchCoverageBreakerActions(
  token: string,
  signal?: AbortSignal,
): Promise<readonly CoverageBreakerActionProjection[]> {
  const body = await authenticatedGet('/v2/admin/coverage-breaker/actions', token, signal);
  if (!Array.isArray(body) || !body.every(isCoverageBreakerAction)) {
    throw invalid('Coverage breaker actions do not match the coordinated generated type');
  }
  return Object.freeze([...body]);
}

export async function createCoverageBreakerResumeChallenge(
  input: CoverageBreakerResumeChallengeRequest,
  token: string,
): Promise<CoverageBreakerResumeChallenge> {
  requireAmount(input.nonce, 'nonce');
  requireAmount(input.deadline, 'deadline');
  const body = await authenticatedWrite('/v2/admin/coverage-breaker/resume-challenge', 'POST', input, token);
  if (!isCoverageBreakerResumeChallenge(body, input)) {
    throw invalid('Coverage breaker resume challenge does not match the coordinated generated type');
  }
  return body;
}

export async function authorizeCoverageBreakerResume(
  input: CoverageBreakerResumeRequest,
  challenge: CoverageBreakerResumeChallenge,
  actorWallet: string,
  token: string,
): Promise<CoverageBreakerActionProjection> {
  requireAmount(input.nonce, 'nonce');
  requireAmount(input.deadline, 'deadline');
  if (!bytes32Pattern.test(input.snapshotId) || !signaturePattern.test(input.signature)) {
    throw invalid('Coverage breaker resume authorization is invalid');
  }
  if (
    !isCoverageBreakerResumeChallenge(challenge, { nonce: input.nonce, deadline: input.deadline })
      || input.snapshotId.toLowerCase() !== challenge.snapshotId.toLowerCase()
      || !addressPattern.test(actorWallet)
  ) throw invalid('Coverage breaker resume authorization does not match its challenge');

  const body = await authenticatedWrite('/v2/admin/coverage-breaker/resume-actions', 'POST', input, token);
  if (
    !isCoverageBreakerAction(body)
      || body.action !== 'RESUME'
      || body.targetPaused
      || body.snapshotId.toLowerCase() !== challenge.snapshotId.toLowerCase()
      || body.evidenceHash.toLowerCase() !== challenge.evidenceHash.toLowerCase()
      || body.policyVersion !== challenge.policyVersion
      || body.governanceSafeAddress.toLowerCase() !== challenge.safeAddress.toLowerCase()
      || body.routerAddress.toLowerCase() !== challenge.routerAddress.toLowerCase()
      || body.actorWallet?.toLowerCase() !== actorWallet.toLowerCase()
      || body.secondarySigner?.toLowerCase() !== challenge.signer.toLowerCase()
      || body.approvalNonce !== input.nonce
      || !deadlineMatches(body.approvalDeadline, input.deadline)
  ) throw invalid('Coverage breaker resume result is not bound to its challenge and session');
  return body;
}

const auditFilterNames = [
  'streamName',
  'eventType',
  'resourceType',
  'resourceId',
  'correlationId',
  'actorWallet',
  'from',
  'to',
  'cursorCreatedAt',
  'cursorEntryId',
  'limit',
] as const satisfies readonly (keyof AuditFilters)[];

export async function fetchSettlementLedger(token: string, signal?: AbortSignal): Promise<SettlementListProjection> {
  const body = await authenticatedGet('/v2/settlements', token, signal);
  if (!isSettlementList(body)) throw invalid('Settlement projection does not match the coordinated generated type');
  return body;
}

export async function fetchMerchantFinance(merchantId: string, token: string, signal?: AbortSignal): Promise<MerchantFinanceProjection> {
  if (!merchantId.trim()) throw invalid('Merchant ID is required');
  const body = await authenticatedGet(`/v2/finance/merchant?merchantId=${encodeURIComponent(merchantId.trim())}`, token, signal);
  if (!isMerchantFinance(body)) throw invalid('Merchant finance projection does not match the coordinated generated type');
  return body;
}

export async function fetchTakeoverFunding(caseId: string, token: string, signal?: AbortSignal): Promise<TakeoverFundingDetail> {
  if (!caseId.trim()) throw invalid('Takeover case ID is required');
  const body = await authenticatedGet(resourcePath('/v2/admin/takeover-funding/', caseId), token, signal);
  if (!isTakeoverFundingDetail(body)) throw invalid('Takeover funding projection does not match the coordinated generated type');
  return body;
}

export async function createTakeoverFundingChallenge(input: TakeoverFundingChallengeRequest, token: string): Promise<TakeoverFundingChallenge> {
  requireAmount(input.requiredUsdt, 'requiredUsdt');
  requireAmount(input.nonce, 'nonce');
  requireAmount(input.deadline, 'deadline');
  const body = await authenticatedWrite('/v2/admin/takeover-funding/approval-challenge', 'POST', input, token);
  if (!isTakeoverFundingChallenge(body)) throw invalid('Takeover funding challenge does not match the coordinated generated type');
  return body;
}

export async function fundTakeover(input: TakeoverFundingRequest, token: string): Promise<TakeoverFundingResult> {
  requireAmount(input.requiredUsdt, 'requiredUsdt');
  const body = await authenticatedWrite('/v2/admin/takeover-funding', 'POST', input, token);
  if (!isTakeoverFundingResult(body)) throw invalid('Takeover funding result does not match the coordinated generated type');
  return body;
}

export async function fetchPolicyDrafts(token: string, signal?: AbortSignal): Promise<readonly PolicyDraftProjection[]> {
  const body = await authenticatedGet('/v2/admin/policy-drafts', token, signal);
  if (!Array.isArray(body) || !body.every(isPolicyDraft)) throw invalid('Policy draft list does not match the coordinated generated type');
  return Object.freeze([...body]);
}

export async function fetchPolicyDraft(draftId: string, token: string, signal?: AbortSignal): Promise<PolicyDraftDetail> {
  const body = await authenticatedGet(resourcePath('/v2/admin/policy-drafts/', draftId), token, signal);
  if (!isPolicyDraftDetail(body)) throw invalid('Policy draft detail does not match the coordinated generated type');
  return body;
}

export async function createPolicyDraft(input: PolicyDraftCreateRequest, token: string): Promise<PolicyDraftProjection> {
  const body = await authenticatedWrite('/v2/admin/policy-drafts', 'POST', input, token);
  if (!isPolicyDraft(body)) throw invalid('Created policy draft does not match the coordinated generated type');
  return body;
}

export async function updatePolicyDraft(draftId: string, input: PolicyDraftUpdateRequest, token: string): Promise<PolicyDraftProjection> {
  const body = await authenticatedWrite(resourcePath('/v2/admin/policy-drafts/', draftId), 'PUT', input, token);
  if (!isPolicyDraft(body)) throw invalid('Updated policy draft does not match the coordinated generated type');
  return body;
}

export async function createPolicyApprovalChallenge(draftId: string, nonce: string, deadline: string, token: string): Promise<PolicyApprovalChallenge> {
  requireAmount(nonce, 'nonce');
  requireAmount(deadline, 'deadline');
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/policy-drafts/', draftId)}/approval-challenge`, 'POST', { nonce, deadline }, token);
  if (!isPolicyApprovalChallenge(body)) throw invalid('Policy approval challenge does not match the coordinated generated type');
  return body;
}

export async function submitPolicySecondarySignature(draftId: string, input: PolicySecondarySignatureRequest, token: string): Promise<PolicyDraftProjection> {
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/policy-drafts/', draftId)}/secondary-signature`, 'POST', input, token);
  if (!isPolicyDraft(body)) throw invalid('Policy signature result does not match the coordinated generated type');
  return body;
}

export async function proposePolicyToSafe(draftId: string, token: string): Promise<PolicyDraftProjection> {
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/policy-drafts/', draftId)}/safe-proposal`, 'POST', {}, token);
  if (!isPolicyDraft(body)) throw invalid('Policy Safe proposal does not match the coordinated generated type');
  return body;
}

export async function fetchCmsVersion(versionId: string, token: string, signal?: AbortSignal): Promise<CmsVersionProjection> {
  const body = await authenticatedGet(resourcePath('/v2/admin/cms/versions/', versionId), token, signal);
  if (!isCmsVersion(body)) throw invalid('CMS version does not match the coordinated generated type');
  return body;
}

export async function createCmsVersion(input: CmsVersionCreateRequest, token: string): Promise<CmsVersionProjection> {
  const body = await authenticatedWrite('/v2/admin/cms/versions', 'POST', input, token);
  if (!isCmsVersion(body)) throw invalid('Created CMS version does not match the coordinated generated type');
  return body;
}

export async function publishCmsVersion(versionId: string, evidenceHash: string, token: string): Promise<CmsVersionProjection> {
  if (!bytes32Pattern.test(evidenceHash)) throw invalid('CMS evidence hash must be bytes32');
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/cms/versions/', versionId)}/publish`, 'POST', { evidenceHash }, token);
  if (!isCmsVersion(body)) throw invalid('Published CMS version does not match the coordinated generated type');
  return body;
}

export async function rollbackCmsVersion(versionId: string, evidenceHash: string, token: string): Promise<CmsVersionProjection> {
  if (!bytes32Pattern.test(evidenceHash)) throw invalid('CMS evidence hash must be bytes32');
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/cms/versions/', versionId)}/rollback`, 'POST', { evidenceHash }, token);
  if (!isCmsVersion(body)) throw invalid('CMS rollback result does not match the coordinated generated type');
  return body;
}

export async function fetchSystemConfigVersions(token: string, signal?: AbortSignal): Promise<readonly SystemConfigProjection[]> {
  const body = await authenticatedGet('/v2/admin/system-config/versions', token, signal);
  if (!Array.isArray(body) || !body.every(isSystemConfig)) throw invalid('System config list does not match the coordinated generated type');
  return Object.freeze([...body]);
}

export async function createSystemConfigVersion(input: SystemConfigCreateRequest, token: string): Promise<SystemConfigProjection> {
  const body = await authenticatedWrite('/v2/admin/system-config/versions', 'POST', input, token);
  if (!isSystemConfig(body)) throw invalid('Created system config does not match the coordinated generated type');
  return body;
}

export async function publishSystemConfigVersion(configVersionId: string, approval: SensitiveApproval, token: string): Promise<SystemConfigProjection> {
  if (!isSensitiveApproval(approval)) throw invalid('System config approval does not match SensitiveApproval');
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/system-config/versions/', configVersionId)}/publish`, 'POST', { approval }, token);
  if (!isSystemConfig(body)) throw invalid('Published system config does not match the coordinated generated type');
  return body;
}

export async function fetchAuditEntries(filters: AuditFilters, token: string, signal?: AbortSignal): Promise<AuditListResponse> {
  const params = new URLSearchParams();
  for (const name of auditFilterNames) {
    const value = filters[name];
    if (value !== undefined && value !== '') params.set(name, String(value));
  }
  const body = await authenticatedGet(`/v2/admin/audit/entries${params.size ? `?${params}` : ''}`, token, signal);
  if (!isAuditList(body)) throw invalid('Audit list does not match the coordinated generated type');
  return body;
}

export async function fetchMonitoringDashboard(token: string, signal?: AbortSignal): Promise<MonitoringDashboard> {
  const body = await authenticatedGet('/v2/admin/monitoring', token, signal);
  if (!isMonitoringDashboard(body)) throw invalid('Monitoring dashboard does not match the coordinated generated type');
  return body;
}

export async function fetchNotifications(token: string, limit = 50, signal?: AbortSignal): Promise<readonly NotificationInboxItem[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid('Notification limit must be between 1 and 200');
  const body = await authenticatedGet(`/v2/notifications?limit=${limit}`, token, signal);
  if (!Array.isArray(body) || !body.every(isNotificationInboxItem)) throw invalid('Notification inbox does not match the coordinated generated type');
  return Object.freeze([...body]);
}

export async function createNotificationCampaign(input: NotificationCampaignRequest, token: string): Promise<NotificationCampaignCreateResult> {
  if (!notificationCampaignTopics.includes(input.topic)) throw invalid('Notification campaign topic is invalid');
  const body = await authenticatedWrite('/v2/admin/notification-campaigns', 'POST', input, token);
  if (!isRecord(body) || typeof body.campaignId !== 'string' || !notificationCampaignStates.includes(body.state as never) || !bytes32Pattern.test(String(body.contentHash))) {
    throw invalid('Notification campaign result does not match the coordinated generated type');
  }
  return body as unknown as NotificationCampaignCreateResult;
}

export async function publishNotificationCampaign(campaignId: string, evidenceHash: string, token: string): Promise<NotificationCampaignPublishResult> {
  if (!bytes32Pattern.test(evidenceHash)) throw invalid('Notification evidence hash must be bytes32');
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/notification-campaigns/', campaignId)}/publish`, 'POST', { evidenceHash }, token);
  if (!isRecord(body) || body.campaignId !== campaignId || body.state !== 'PUBLISHED') throw invalid('Notification publication does not match the coordinated generated type');
  return body as unknown as NotificationCampaignPublishResult;
}

export async function acknowledgeMonitoringAlert(alertKey: string, token: string): Promise<MonitoringAcknowledgeResult> {
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/monitoring/alerts/', alertKey)}/acknowledge`, 'POST', {}, token);
  if (!isRecord(body) || body.alertKey !== alertKey || body.state !== 'ACKNOWLEDGED') throw invalid('Alert acknowledgement does not match the coordinated generated type');
  return body as unknown as MonitoringAcknowledgeResult;
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

function resourcePath(prefix: string, resourceId: string) {
  const value = resourceId.trim();
  if (!value) throw invalid('Resource ID is required');
  return `${prefix}${encodeURIComponent(value)}`;
}

function isSettlementList(value: unknown): value is SettlementListProjection {
  if (!isRecord(value) || value.artifactVersion !== artifactVersion || !addressPattern.test(String(value.wallet))) return false;
  return Array.isArray(value.balances)
    && value.balances.every((item) => isRecord(item)
      && ['USDT', 'NPL'].includes(String(item.asset))
      && balanceStates.includes(item.state as never)
      && (item.rewardSubtype === null || rewardSubtypes.includes(item.rewardSubtype as never))
      && amountPattern.test(String(item.amount))
      && typeof item.purpose === 'string')
    && Array.isArray(value.points)
    && value.points.every((item) => isRecord(item)
      && item.pointsType === 'BNM'
      && item.purpose === 'BNM_LIABILITY'
      && ['LOCKED', 'AVAILABLE'].includes(String(item.state))
      && amountPattern.test(String(item.amount))
      && item.transferable === false)
    && Array.isArray(value.requests)
    && value.requests.every((item) => isRecord(item)
      && settlementRails.includes(item.rail as never)
      && settlementRequestStates.includes(item.state as never)
      && amountPattern.test(String(item.amount))
      && addressPattern.test(String(item.recipient_address))
      && (item.final_safe_tx_hash === null || bytes32Pattern.test(String(item.final_safe_tx_hash))));
}

function isMerchantFinance(value: unknown): value is MerchantFinanceProjection {
  if (!isRecord(value) || !isRecord(value.merchant)) return false;
  const merchant = value.merchant;
  return typeof merchant.merchant_id === 'string'
    && guaranteeStatuses.includes(merchant.guarantee_status as never)
    && addressPattern.test(String(merchant.settlement_wallet))
    && (value.guarantee === null || (isRecord(value.guarantee) && amountPattern.test(String(value.guarantee.balance_usdt)) && amountPattern.test(String(value.guarantee.minimum_usdt))))
    && Array.isArray(value.guaranteeDeposits)
    && value.guaranteeDeposits.every((deposit) => isRecord(deposit) && merchantGuaranteeDepositStates.includes(deposit.state as never) && bytes32Pattern.test(String(deposit.transaction_hash)))
    && (value.debt === null || (isRecord(value.debt) && amountPattern.test(String(value.debt.outstanding_usdt))))
    && Array.isArray(value.takeovers)
    && value.takeovers.every((item) => isRecord(item) && takeoverStates.includes(item.state as never));
}

function isTakeoverFundingDetail(value: unknown): value is TakeoverFundingDetail {
  return isRecord(value)
    && typeof value.case_id === 'string'
    && takeoverStates.includes(value.state as never)
    && nullableAmounts(value, ['required_usdt', 'guarantee_used_usdt', 'merchant_available_used_usdt', 'future_proceeds_used_usdt', 'platform_advance_usdt', 'merchant_debt_usdt'])
    && Array.isArray(value.items)
    && value.items.every((item) => isRecord(item) && amountPattern.test(String(item.amount_usdt)) && bytes32Pattern.test(String(item.evidence_hash)))
    && Array.isArray(value.debtRecoveries);
}

function isTakeoverFundingChallenge(value: unknown): value is TakeoverFundingChallenge {
  return isRecord(value) && isRecord(value.plan) && isTypedData(value.typedData)
    && typeof value.plan.caseId === 'string' && amountPattern.test(String(value.plan.requiredUsdt));
}

function isTakeoverFundingResult(value: unknown): value is TakeoverFundingResult {
  return isRecord(value) && typeof value.caseId === 'string' && value.state === 'FUNDED'
    && ['requiredUsdt', 'guaranteeUsedUsdt', 'frozenReceivablesUsedUsdt', 'futureProceedsUsedUsdt', 'platformAdvanceUsdt', 'merchantDebtUsdt'].every((field) => amountPattern.test(String(value[field])));
}

function isPolicyDraft(value: unknown): value is PolicyDraftProjection {
  return isRecord(value)
    && typeof value.draftId === 'string'
    && amountPattern.test(String(value.nextPolicyVersion))
    && (value.artifactVersion === null || value.artifactVersion === artifactVersion)
    && isRecord(value.payload)
    && Array.isArray(value.validationErrors)
    && value.validationErrors.every((item) => isRecord(item) && typeof item.code === 'string' && typeof item.field === 'string')
    && policyDraftStates.includes(value.state as never)
    && nullableHashes(value, ['policyHash', 'operationsHash', 'publicationDigest', 'secondarySignatureHash', 'safeCalldataHash', 'safeTxHash', 'safeProposalHash'])
    && addressPattern.test(String(value.createdBy))
    && isDateTime(value.createdAt)
    && isDateTime(value.updatedAt);
}

function isPolicyDraftDetail(value: unknown): value is PolicyDraftDetail {
  if (!isRecord(value) || !isPolicyDraft(value) || !Array.isArray(value.transitions)) return false;
  return value.transitions.every((item) => isRecord(item) && policyDraftStates.includes(item.toState as never) && bytes32Pattern.test(String(item.evidenceHash)) && isDateTime(item.createdAt));
}

function isPolicyApprovalChallenge(value: unknown): value is PolicyApprovalChallenge {
  return isRecord(value) && typeof value.draftId === 'string' && Number.isSafeInteger(value.policyVersion)
    && addressPattern.test(String(value.signer)) && bytes32Pattern.test(String(value.digest)) && isTypedData(value.typedData);
}

function isCmsVersion(value: unknown): value is CmsVersionProjection {
  return isRecord(value)
    && nonEmpty(value, ['entryId', 'versionId', 'slug', 'placement', 'locale'])
    && Number.isSafeInteger(value.version)
    && cmsContentTypes.includes(value.contentType as never)
    && cmsContentFormats.includes(value.contentFormat as never)
    && isRecord(value.content)
    && isRecord(value.audience)
    && bytes32Pattern.test(String(value.contentHash))
    && typeof value.published === 'boolean'
    && addressPattern.test(String(value.createdBy))
    && isDateTime(value.createdAt);
}

function isSystemConfig(value: unknown): value is SystemConfigProjection {
  return isRecord(value)
    && typeof value.configVersionId === 'string'
    && systemConfigKeys.includes(value.configKey as never)
    && Number.isSafeInteger(value.version)
    && isRecord(value.payload)
    && bytes32Pattern.test(String(value.payloadHash))
    && isDateTime(value.effectiveFrom)
    && typeof value.published === 'boolean'
    && addressPattern.test(String(value.createdBy))
    && isDateTime(value.createdAt);
}

function isAuditList(value: unknown): value is AuditListResponse {
  return isRecord(value)
    && Array.isArray(value.entries)
    && value.entries.every((entry) => isRecord(entry)
      && auditStreamNames.includes(entry.streamName as never)
      && auditEvidenceProfiles.includes(entry.evidenceProfile as never)
      && nonEmpty(entry, ['entryId', 'eventType', 'resourceType', 'resourceId', 'correlationId', 'entryHash'])
      && isDateTime(entry.createdAt))
    && isRecord(value.chainProof)
    && (value.nextCursor === null || isRecord(value.nextCursor));
}

function isMonitoringDashboard(value: unknown): value is MonitoringDashboard {
  return isRecord(value)
    && Array.isArray(value.metrics)
    && value.metrics.every((metric) => isRecord(metric)
      && operationsMetricComponents.includes(metric.component as never)
      && operationsMetricUnits.includes(metric.unit as never)
      && operationsMetricStatuses.includes(metric.status as never)
      && (metric.value === null || typeof metric.value === 'number')
      && isDateTime(metric.observedAt))
    && Array.isArray(value.alerts)
    && value.alerts.every((alert) => isRecord(alert)
      && operationsAlertEventTypes.includes(alert.state as never)
      && operationsAlertSeverities.includes(alert.severity as never)
      && typeof alert.alertKey === 'string')
    && Array.isArray(value.coverage)
    && value.coverage.every((item) => isRecord(item)
      && ['USDT', 'NPL'].includes(String(item.asset))
      && addressPattern.test(String(item.safe_address))
      && amountPattern.test(String(item.assets))
      && amountPattern.test(String(item.unsettled_liabilities))
      && typeof item.covered === 'boolean');
}

function isAdminBusinessDashboard(value: unknown): value is AdminBusinessDashboard {
  if (
    !isRecord(value)
      || value.artifactVersion !== artifactVersion
      || value.timezone !== 'Asia/Shanghai'
      || !isBusinessDayWindow(value.window)
      || !hasAmounts(value.orders, [
        'finalizedToday', 'listPriceUsdt', 'buyerUsdtPaid', 'pendingShipment',
        'shipped', 'delivered', 'fulfilled',
      ])
      || !isRecord(value.orders)
      || !isBusinessRatio(value.orders.shipmentRate)
      || !hasAmounts(value.merchants, ['total', 'newToday', 'pending', 'approved', 'suspended'])
      || !hasAmounts(value.products, ['total', 'pendingReview', 'soldOut'])
      || !hasAmounts(value.seckill, ['createdToday', 'active', 'settling'])
      || !hasAmounts(value.fulfillmentQueues, ['exchange', 'delay', 'arbitration', 'forcedReceipt', 'takeover'])
      || !hasAmounts(value.settlements, ['requestedCount', 'requestedUsdt', 'settledCount', 'settledUsdt', 'failedTransactions'])
      || !hasAmounts(value.risk, ['abnormalObservationsToday', 'blacklistBlocksToday', 'activeRestrictions', 'pendingAppeals'])
      || !Array.isArray(value.coverage)
      || !value.coverage.every(isDashboardCoverage)
      || !Array.isArray(value.breakers)
      || value.breakers.length !== breakerScopes.length
      || new Set(value.breakers.map((item) => isRecord(item) ? item.scope : null)).size !== breakerScopes.length
      || !value.breakers.every((item) => isRecord(item)
        && breakerScopes.includes(item.scope as never)
        && typeof item.paused === 'boolean')
      || !Array.isArray(value.unavailable)
      || !value.unavailable.every((item) => isRecord(item)
        && nonEmpty(item, ['metric', 'detail'])
        && ['DecisionBlocked', 'ExternalBlocked'].includes(String(item.reasonCode)))
  ) return false;
  return true;
}

function isBusinessDayWindow(value: unknown) {
  return isRecord(value)
    && isDateTime(value.start)
    && isDateTime(value.end)
    && isDateTime(value.generatedAt)
    && new Date(value.start).getTime() < new Date(value.end).getTime();
}

function isBusinessRatio(value: unknown) {
  return isRecord(value)
    && amountPattern.test(String(value.numerator))
    && amountPattern.test(String(value.denominator))
    && (value.bps === null || amountPattern.test(String(value.bps)));
}

function isDashboardCoverage(value: unknown) {
  return isRecord(value)
    && nonEmpty(value, ['snapshotId'])
    && amountPattern.test(String(value.blockNumber))
    && isDateTime(value.recordedAt)
    && ['USDT', 'NPL'].includes(String(value.asset))
    && addressPattern.test(String(value.safeAddress))
    && amountPattern.test(String(value.verifiedAssets))
    && amountPattern.test(String(value.unsettledLiabilities))
    && typeof value.covered === 'boolean';
}

const coverageChallengeKeys = [
  'artifactVersion', 'snapshotId', 'evidenceHash', 'policyVersion', 'signer',
  'safeAddress', 'routerAddress', 'typedData', 'digest',
] as const satisfies readonly (keyof CoverageBreakerResumeChallenge)[];
const coverageActionKeys = [
  'artifactVersion', 'actionId', 'snapshotId', 'policyVersion', 'action',
  'targetPaused', 'evidenceHash', 'governanceSafeAddress', 'routerAddress',
  'calldataHash', 'state', 'safeNonce', 'safeTxHash', 'proposalHash', 'executionTxHash',
  'confirmations', 'actorWallet', 'secondarySigner', 'secondarySignatureHash',
  'approvalNonce', 'approvalDeadline', 'createdAt', 'updatedAt',
] as const satisfies readonly (keyof CoverageBreakerActionProjection)[];
const sensitiveActionFields = [
  ['action', 'string'],
  ['resourceType', 'string'],
  ['resourceId', 'string'],
  ['policyVersion', 'uint64'],
  ['oldValueHash', 'bytes32'],
  ['newValueHash', 'bytes32'],
  ['safeAddress', 'address'],
  ['nonce', 'uint256'],
  ['deadline', 'uint64'],
] as const;

function isCoverageBreakerResumeChallenge(
  value: unknown,
  request: CoverageBreakerResumeChallengeRequest,
): value is CoverageBreakerResumeChallenge {
  if (
    !isRecord(value)
      || !hasExactKeys(value, coverageChallengeKeys)
      || value.artifactVersion !== artifactVersion
      || !bytes32Pattern.test(String(value.snapshotId))
      || !bytes32Pattern.test(String(value.evidenceHash))
      || !amountPattern.test(String(value.policyVersion))
      || !addressPattern.test(String(value.signer))
      || !addressPattern.test(String(value.safeAddress))
      || !addressPattern.test(String(value.routerAddress))
      || !bytes32Pattern.test(String(value.digest))
      || !isRecord(value.typedData)
      || !hasExactKeys(value.typedData, ['domain', 'types', 'primaryType', 'message'])
      || value.typedData.primaryType !== 'SensitiveAction'
      || !isRecord(value.typedData.domain)
      || !hasExactKeys(value.typedData.domain, ['name', 'version', 'chainId', 'verifyingContract'])
      || value.typedData.domain.name !== 'Abu24KV2Core'
      || value.typedData.domain.version !== '2'
      || value.typedData.domain.chainId !== 56
      || !addressPattern.test(String(value.typedData.domain.verifyingContract))
      || String(value.typedData.domain.verifyingContract).toLowerCase() !== String(value.routerAddress).toLowerCase()
      || !isRecord(value.typedData.types)
      || !hasExactKeys(value.typedData.types, ['SensitiveAction'])
      || !Array.isArray(value.typedData.types.SensitiveAction)
      || value.typedData.types.SensitiveAction.length !== sensitiveActionFields.length
      || !value.typedData.types.SensitiveAction.every((field, index) => isRecord(field)
        && hasExactKeys(field, ['name', 'type'])
        && field.name === sensitiveActionFields[index]?.[0]
        && field.type === sensitiveActionFields[index]?.[1])
      || !isRecord(value.typedData.message)
      || !hasExactKeys(value.typedData.message, sensitiveActionFields.map(([name]) => name))
  ) return false;

  const message = value.typedData.message;
  return message.action === 'RESUME_NEW_PAYMENTS'
    && message.resourceType === 'COVERAGE_BREAKER'
    && String(message.resourceId).toLowerCase() === String(value.snapshotId).toLowerCase()
    && String(message.policyVersion) === String(value.policyVersion)
    && bytes32Pattern.test(String(message.oldValueHash))
    && bytes32Pattern.test(String(message.newValueHash))
    && addressPattern.test(String(message.safeAddress))
    && String(message.safeAddress).toLowerCase() === String(value.safeAddress).toLowerCase()
    && String(message.nonce) === request.nonce
    && String(message.deadline) === request.deadline;
}

function isCoverageBreakerAction(value: unknown): value is CoverageBreakerActionProjection {
  if (!isRecord(value) || !hasExactKeys(value, coverageActionKeys)) return false;
  return value.artifactVersion === artifactVersion
    && bytes32Pattern.test(String(value.actionId))
    && bytes32Pattern.test(String(value.snapshotId))
    && amountPattern.test(String(value.policyVersion))
    && ['PAUSE', 'RESUME'].includes(String(value.action))
    && typeof value.targetPaused === 'boolean'
    && value.targetPaused === (value.action === 'PAUSE')
    && bytes32Pattern.test(String(value.evidenceHash))
    && addressPattern.test(String(value.governanceSafeAddress))
    && addressPattern.test(String(value.routerAddress))
    && bytes32Pattern.test(String(value.calldataHash))
    && ['PENDING_PROPOSAL', 'SAFE_PROPOSED', 'MINED', 'FINAL', 'REORGED', 'FAILED', 'SUPERSEDED'].includes(String(value.state))
    && (value.safeNonce === null || amountPattern.test(String(value.safeNonce)))
    && nullableHash(value.safeTxHash)
    && nullableHash(value.proposalHash)
    && nullableHash(value.executionTxHash)
    && Number.isSafeInteger(value.confirmations)
    && Number(value.confirmations) >= 0
    && nullableAddress(value.actorWallet)
    && nullableAddress(value.secondarySigner)
    && nullableHash(value.secondarySignatureHash)
    && (value.approvalNonce === null || amountPattern.test(String(value.approvalNonce)))
    && (value.approvalDeadline === null || isCanonicalDateTime(value.approvalDeadline))
    && isCanonicalDateTime(value.createdAt)
    && isCanonicalDateTime(value.updatedAt);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nullableHash(value: unknown) {
  return value === null || bytes32Pattern.test(String(value));
}

function nullableAddress(value: unknown) {
  return value === null || addressPattern.test(String(value));
}

function deadlineMatches(value: string | null, deadline: string) {
  return value !== null && Math.floor(new Date(value).getTime() / 1_000) === Number(deadline);
}

function isCanonicalDateTime(value: unknown) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function hasAmounts(value: unknown, fields: readonly string[]) {
  return isRecord(value) && fields.every((field) => amountPattern.test(String(value[field])));
}

function isNotificationInboxItem(value: unknown): value is NotificationInboxItem {
  return isRecord(value)
    && nonEmpty(value, ['messageId', 'sourceEventType', 'topic'])
    && isRecord(value.templateData)
    && notificationDeliveryStates.includes(value.deliveryState as never)
    && isDateTime(value.createdAt);
}

function isTypedData(value: unknown) {
  return isRecord(value) && isRecord(value.domain) && isRecord(value.types) && typeof value.primaryType === 'string' && isRecord(value.message);
}

function isSensitiveApproval(value: unknown): value is SensitiveApproval {
  return isRecord(value)
    && nonEmpty(value, ['action', 'resourceType', 'resourceId', 'policyVersion', 'oldValueHash', 'newValueHash', 'safeAddress', 'nonce', 'deadline', 'signature'])
    && amountPattern.test(String(value.policyVersion))
    && bytes32Pattern.test(String(value.oldValueHash))
    && bytes32Pattern.test(String(value.newValueHash))
    && addressPattern.test(String(value.safeAddress))
    && amountPattern.test(String(value.nonce))
    && amountPattern.test(String(value.deadline));
}

function nullableAmounts(value: Record<string, unknown>, fields: readonly string[]) {
  return fields.every((field) => value[field] === null || amountPattern.test(String(value[field])));
}

function nullableHashes(value: Record<string, unknown>, fields: readonly string[]) {
  return fields.every((field) => value[field] === null || bytes32Pattern.test(String(value[field])));
}

function nonEmpty(value: Record<string, unknown>, fields: readonly string[]) {
  return fields.every((field) => typeof value[field] === 'string' && String(value[field]).length > 0);
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function requireAmount(value: string, field: string) {
  if (!amountPattern.test(value)) throw invalid(`${field} must be an unsigned canonical integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string) {
  return new CoreApiError({ code: 'InvalidResponse', message, status: 502 });
}
