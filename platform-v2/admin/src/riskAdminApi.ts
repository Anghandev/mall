import {
  artifactVersion,
  riskAppealStates,
  riskRestrictionKinds,
  riskRestrictionStates,
  riskSignalTypes,
  riskSourceTypes,
  riskSubjectTypes,
  type RiskAppeal,
  type RiskAppealCreateRequest,
  type RiskAppealDecisionRequest,
  type RiskObservation,
  type RiskOverview,
  type RiskOverrideRequest,
  type RiskRestriction,
  type RiskRestrictionCreateRequest,
} from '@abu24k/core-artifacts';
import { CoreApiError, requestCoreJson } from './coreApi';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const reasonPattern = /^[A-Z][A-Z0-9_]{1,63}$/;

export async function fetchRiskOverview(token: string, signal?: AbortSignal): Promise<RiskOverview> {
  const body = await requestCoreJson('/v2/admin/risk/overview', {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!isRiskOverview(body)) throw invalid('Risk overview does not match the coordinated generated type');
  return body;
}

export async function createRiskRestriction(
  input: RiskRestrictionCreateRequest,
  token: string,
): Promise<RiskRestriction> {
  validateRestrictionInput(input);
  return writeRiskResource('/v2/admin/risk/restrictions', input, token, isRiskRestriction, 'Risk restriction');
}

export async function overrideRiskRestriction(
  restrictionId: string,
  input: RiskOverrideRequest,
  token: string,
): Promise<RiskRestriction> {
  requireHash(restrictionId, 'restrictionId');
  requireReason(input.reasonCode);
  requireHash(input.evidenceHash, 'evidenceHash');
  return writeRiskResource(
    `/v2/admin/risk/restrictions/${encodeURIComponent(restrictionId)}/override`,
    input,
    token,
    isRiskRestriction,
    'Risk restriction override',
  );
}

export async function submitRiskAppeal(
  input: RiskAppealCreateRequest,
  token: string,
): Promise<RiskAppeal> {
  requireHash(input.restrictionId, 'restrictionId');
  requireHash(input.statementHash, 'statementHash');
  requireHash(input.evidenceHash, 'evidenceHash');
  requireIdempotencyKey(input.idempotencyKey);
  return writeRiskResource('/v2/admin/risk/appeals', input, token, isRiskAppeal, 'Risk appeal');
}

export async function decideRiskAppeal(
  appealId: string,
  input: RiskAppealDecisionRequest,
  token: string,
): Promise<RiskAppeal> {
  requireHash(appealId, 'appealId');
  if (!['APPROVE', 'REJECT'].includes(input.decision)) throw invalid('Risk appeal decision is invalid', 400);
  requireReason(input.reasonCode);
  requireHash(input.evidenceHash, 'evidenceHash');
  return writeRiskResource(
    `/v2/admin/risk/appeals/${encodeURIComponent(appealId)}/decision`,
    input,
    token,
    isRiskAppeal,
    'Risk appeal decision',
  );
}

async function writeRiskResource<T>(
  path: string,
  body: object,
  token: string,
  validate: (value: unknown) => value is T,
  label: string,
) {
  const response = await requestCoreJson(path, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!validate(response)) throw invalid(`${label} does not match the coordinated generated type`);
  return response;
}

function validateRestrictionInput(input: RiskRestrictionCreateRequest) {
  if (!riskSubjectTypes.includes(input.subjectType)) throw invalid('Risk subject type is invalid', 400);
  if (input.subjectType === 'WALLET' ? !addressPattern.test(input.subjectValue) : !bytes32Pattern.test(input.subjectValue)) {
    throw invalid('Risk subject value does not match its subject type', 400);
  }
  if (!riskRestrictionKinds.includes(input.restrictionKind)) throw invalid('Risk restriction kind is invalid', 400);
  requireReason(input.reasonCode);
  requireHash(input.evidenceHash, 'evidenceHash');
  requireIdempotencyKey(input.idempotencyKey);
  if (input.expiresAt !== undefined && !isDateTime(input.expiresAt)) throw invalid('Risk expiry must be an ISO timestamp', 400);
}

function isRiskOverview(value: unknown): value is RiskOverview {
  return isRecord(value)
    && hasExactKeys(value, ['artifactVersion', 'generatedAt', 'observations', 'restrictions', 'appeals', 'decisionBlocked'])
    && value.artifactVersion === artifactVersion
    && isDateTime(value.generatedAt)
    && Array.isArray(value.observations)
    && value.observations.every(isRiskObservation)
    && Array.isArray(value.restrictions)
    && value.restrictions.every(isRiskRestriction)
    && Array.isArray(value.appeals)
    && value.appeals.every(isRiskAppeal)
    && Array.isArray(value.decisionBlocked)
    && value.decisionBlocked.every((item) => isRecord(item)
      && hasExactKeys(item, ['capability', 'reasonCode'])
      && isNonEmptyString(item.capability)
      && ['DecisionBlocked', 'ExternalBlocked'].includes(String(item.reasonCode)));
}

function isRiskObservation(value: unknown): value is RiskObservation {
  return isRecord(value)
    && hasExactKeys(value, [
      'observationId', 'signalType', 'sourceType', 'walletAddress', 'ipHash', 'deviceHash',
      'resourceId', 'txHash', 'gasPriceWei', 'evidenceHash', 'observedAt', 'recordedAt',
    ])
    && bytes32Pattern.test(String(value.observationId))
    && riskSignalTypes.includes(value.signalType as never)
    && riskSourceTypes.includes(value.sourceType as never)
    && addressPattern.test(String(value.walletAddress))
    && isNullableHash(value.ipHash)
    && isNullableHash(value.deviceHash)
    && (value.resourceId === null || isNonEmptyString(value.resourceId))
    && isNullableHash(value.txHash)
    && (value.gasPriceWei === null || /^(0|[1-9][0-9]*)$/.test(String(value.gasPriceWei)))
    && bytes32Pattern.test(String(value.evidenceHash))
    && isDateTime(value.observedAt)
    && isDateTime(value.recordedAt);
}

function isRiskRestriction(value: unknown): value is RiskRestriction {
  if (!isRecord(value) || !hasExactKeys(value, [
    'restrictionId', 'subjectType', 'subjectValue', 'restrictionKind', 'triggerType', 'reasonCode',
    'evidenceHash', 'sourceObservationId', 'state', 'startsAt', 'expiresAt', 'createdBy', 'overrideBy',
    'overrideReasonCode', 'overrideEvidenceHash', 'overrideAt', 'createdAt', 'updatedAt',
  ])) return false;
  if (!riskSubjectTypes.includes(value.subjectType as never) || typeof value.subjectValue !== 'string') return false;
  if (value.subjectType === 'WALLET' ? !addressPattern.test(value.subjectValue) : !bytes32Pattern.test(value.subjectValue)) return false;
  return bytes32Pattern.test(String(value.restrictionId))
    && riskRestrictionKinds.includes(value.restrictionKind as never)
    && ['HIGH_GAS', 'WALLET_SWITCH', 'ORDER_CANCELLATION', 'SUBJECT_BLACKLIST', 'MANUAL'].includes(String(value.triggerType))
    && reasonPattern.test(String(value.reasonCode))
    && bytes32Pattern.test(String(value.evidenceHash))
    && isNullableHash(value.sourceObservationId)
    && riskRestrictionStates.includes(value.state as never)
    && isDateTime(value.startsAt)
    && isNullableDateTime(value.expiresAt)
    && isNullableAddress(value.createdBy)
    && isNullableAddress(value.overrideBy)
    && (value.overrideReasonCode === null || reasonPattern.test(String(value.overrideReasonCode)))
    && isNullableHash(value.overrideEvidenceHash)
    && isNullableDateTime(value.overrideAt)
    && isDateTime(value.createdAt)
    && isDateTime(value.updatedAt);
}

function isRiskAppeal(value: unknown): value is RiskAppeal {
  return isRecord(value)
    && hasExactKeys(value, [
      'appealId', 'restrictionId', 'submittedBy', 'statementHash', 'evidenceHash', 'state',
      'decidedBy', 'decisionReasonCode', 'decisionEvidenceHash', 'decidedAt', 'createdAt', 'updatedAt',
    ])
    && bytes32Pattern.test(String(value.appealId))
    && bytes32Pattern.test(String(value.restrictionId))
    && addressPattern.test(String(value.submittedBy))
    && bytes32Pattern.test(String(value.statementHash))
    && bytes32Pattern.test(String(value.evidenceHash))
    && riskAppealStates.includes(value.state as never)
    && isNullableAddress(value.decidedBy)
    && (value.decisionReasonCode === null || reasonPattern.test(String(value.decisionReasonCode)))
    && isNullableHash(value.decisionEvidenceHash)
    && isNullableDateTime(value.decidedAt)
    && isDateTime(value.createdAt)
    && isDateTime(value.updatedAt);
}

function requireHash(value: string, field: string) {
  if (!bytes32Pattern.test(value)) throw invalid(`${field} must be bytes32`, 400);
}

function requireReason(value: string) {
  if (!reasonPattern.test(value)) throw invalid('Risk reasonCode is invalid', 400);
}

function requireIdempotencyKey(value: string) {
  if (value.length < 8 || value.length > 128) throw invalid('Risk idempotencyKey must contain 8-128 characters', 400);
}

function isNullableHash(value: unknown) {
  return value === null || bytes32Pattern.test(String(value));
}

function isNullableAddress(value: unknown) {
  return value === null || addressPattern.test(String(value));
}

function isNullableDateTime(value: unknown) {
  return value === null || isDateTime(value);
}

function isDateTime(value: unknown) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalid(message: string, status = 502) {
  return new CoreApiError({ code: 'InvalidResponse', message, status });
}
