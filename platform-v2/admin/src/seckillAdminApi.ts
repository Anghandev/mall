import {
  artifactVersion,
  seckillStates,
  type RealtimeEventEnvelope,
  type RealtimeEventPage,
  type SeckillBreakerResumeRequest,
  type SeckillForceCloseRequest,
  type SeckillGovernanceActionKind,
  type SeckillGovernanceActionProjection,
  type SeckillGovernanceActionState,
  type SeckillGovernanceApprovalRequest,
  type SeckillGovernanceChallenge,
  type SeckillGovernanceChallengeRequest,
  type SeckillPrizeInjectionRequest,
  type SeckillPrizeSettlementProjection,
  type SeckillSessionCreateRequest,
  type SeckillSessionHistoryPage,
  type SeckillSessionProjection,
  type SeckillWinnerReviewRequest,
} from '@abu24k/core-artifacts';
import websocketProtocol from '@abu24k/core-artifacts/websocket';
import { CoreApiError, requestCoreJson } from './coreApi';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const amountPattern = /^(0|[1-9][0-9]*)$/;
const signaturePattern = /^0x(?:[0-9a-fA-F]{2})+$/;
const coreOrigin = (import.meta.env.VITE_CORE_API_ORIGIN ?? '').trim().replace(/\/$/, '');
const governanceActionKinds = ['OPEN_SESSION', 'FORCE_CLOSE', 'RESUME_PURCHASES', 'PRIZE_INJECTION'] as const satisfies readonly SeckillGovernanceActionKind[];
const governanceActionStates = [
  'DRAFT', 'SECONDARY_SIGNED', 'PENDING_EXECUTION', 'SUBMITTED', 'MINED',
  'FINAL', 'REORGED', 'FAILED', 'CANCELLED',
] as const satisfies readonly SeckillGovernanceActionState[];
const governanceAllowedActions = ['APPROVE_SECONDARY', 'EXECUTE', 'CANCEL'] as const;

export type SeckillPageQuery = Readonly<{ cursor?: string; limit?: number }>;

export async function fetchCurrentSeckillSession(signal?: AbortSignal): Promise<SeckillSessionProjection> {
  const body = await requestCoreJson('/v2/seckill/sessions/current', signal ? { signal } : {});
  if (!isSeckillSession(body)) throw invalid('Current seckill session does not match the coordinated generated type');
  return body;
}

export async function fetchSeckillSessionHistory(query: SeckillPageQuery = {}, signal?: AbortSignal): Promise<SeckillSessionHistoryPage> {
  const body = await requestCoreJson(`/v2/seckill/sessions/history${queryString(query)}`, signal ? { signal } : {});
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every(isSeckillSession) || (body.nextCursor !== null && !isCursor(body.nextCursor))) {
    throw invalid('Seckill history does not match the coordinated generated type');
  }
  return body as unknown as SeckillSessionHistoryPage;
}

export async function fetchSeckillSessionEvents(sessionId: string, query: SeckillPageQuery = {}, signal?: AbortSignal): Promise<RealtimeEventPage> {
  requireSessionId(sessionId);
  const body = await requestCoreJson(`/v2/seckill/sessions/${encodeURIComponent(sessionId)}/events${queryString(query)}`, signal ? { signal } : {});
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every((item) => isRealtimeEvent(item, sessionId)) || !isCursor(body.nextCursor)) {
    throw invalid('Seckill event replay does not match the coordinated generated type');
  }
  return body as unknown as RealtimeEventPage;
}

export async function fetchSeckillGovernanceActions(
  token: string,
  signal?: AbortSignal,
): Promise<readonly SeckillGovernanceActionProjection[]> {
  const body = await authenticatedGet('/v2/admin/seckill/actions', token, signal);
  if (!Array.isArray(body) || !body.every(isSeckillGovernanceAction)) {
    throw invalid('Seckill governance action list does not match the coordinated generated type');
  }
  return Object.freeze([...body]);
}

export async function fetchSeckillGovernanceAction(
  actionId: string,
  token: string,
  signal?: AbortSignal,
): Promise<SeckillGovernanceActionProjection> {
  requireHash(actionId, 'Seckill action ID');
  const body = await authenticatedGet(`/v2/admin/seckill/actions/${encodeURIComponent(actionId)}`, token, signal);
  if (!isSeckillGovernanceAction(body) || body.actionId.toLowerCase() !== actionId.toLowerCase()) {
    throw invalid('Seckill governance action detail does not match the requested action');
  }
  return body;
}

export async function createSeckillSessionDraft(
  input: SeckillSessionCreateRequest,
  token: string,
): Promise<SeckillGovernanceActionProjection> {
  requireAmount(input.policyVersion, 'policyVersion', true);
  requireHash(input.rulesContentHash, 'rulesContentHash');
  requireText(input.productId, 'productId');
  requireText(input.skuId, 'skuId');
  if (!Number.isSafeInteger(input.inventory) || input.inventory < 1) throw invalid('Seckill inventory must be a positive integer', 400);
  requireAmount(input.seckillListPriceUsdt, 'seckillListPriceUsdt', true);
  if (!isDateTime(input.startsAt)) throw invalid('Seckill startsAt must be an ISO timestamp', 400);
  requireIdempotencyKey(input.idempotencyKey);
  return writeAction('/v2/admin/seckill/sessions', input, token, {
    actionKind: 'OPEN_SESSION',
  });
}

export async function createSeckillForceClose(
  sessionId: string,
  input: SeckillForceCloseRequest,
  token: string,
): Promise<SeckillGovernanceActionProjection> {
  requireHash(sessionId, 'Seckill session ID');
  requireBoundedText(input.reasonCode, 'reasonCode', 2, 128);
  requireIdempotencyKey(input.idempotencyKey);
  return writeAction(`/v2/admin/seckill/sessions/${encodeURIComponent(sessionId)}/force-close`, input, token, {
    actionKind: 'FORCE_CLOSE', sessionId,
  });
}

export async function createSeckillPrizeInjection(
  sessionId: string,
  input: SeckillPrizeInjectionRequest,
  token: string,
): Promise<SeckillGovernanceActionProjection> {
  requireHash(sessionId, 'Seckill session ID');
  requireAmount(input.amountUsdt, 'amountUsdt', true);
  requireIdempotencyKey(input.idempotencyKey);
  return writeAction(`/v2/admin/seckill/sessions/${encodeURIComponent(sessionId)}/prize-injections`, input, token, {
    actionKind: 'PRIZE_INJECTION', sessionId,
  });
}

export async function createSeckillBreakerResume(
  input: SeckillBreakerResumeRequest,
  token: string,
): Promise<SeckillGovernanceActionProjection> {
  requireHash(input.sessionId, 'Seckill session ID');
  requireIdempotencyKey(input.idempotencyKey);
  return writeAction('/v2/admin/seckill/breaker/resume', input, token, {
    actionKind: 'RESUME_PURCHASES', sessionId: input.sessionId,
  });
}

export async function reviewSeckillWinner(
  session: SeckillSessionProjection,
  input: SeckillWinnerReviewRequest,
  token: string,
): Promise<SeckillPrizeSettlementProjection> {
  const settlement = session.prizeSettlement;
  if (settlement?.state !== 'REVIEW_PENDING' || settlement.candidate === null) {
    throw invalid('Seckill winner is not awaiting review', 409);
  }
  if (!['APPROVE', 'REJECT'].includes(input.decision)) throw invalid('Winner review decision must be APPROVE or REJECT', 400);
  requireBoundedText(input.reasonCode, 'reasonCode', 2, 128);
  requireHash(input.evidenceHash, 'evidenceHash');
  requireIdempotencyKey(input.idempotencyKey);
  const body = await authenticatedWrite(
    `/v2/admin/seckill/sessions/${encodeURIComponent(session.sessionId)}/winner-review`, input, token,
  );
  if (!isSeckillPrizeSettlement(body) || !samePrizeSnapshot(body, settlement)) {
    throw invalid('Winner review result does not preserve the frozen candidate and pool snapshot');
  }
  const expectedDecision = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const validState = input.decision === 'APPROVE'
    ? body.state === 'APPROVED'
    : ['ROLLOVER_PENDING', 'ROLLED_OVER'].includes(body.state);
  if (!validState || body.review?.decision !== expectedDecision || body.review.evidenceHash.toLowerCase() !== input.evidenceHash.toLowerCase()) {
    throw invalid('Winner review result does not match the submitted decision and evidence');
  }
  return body;
}

export async function createSeckillGovernanceChallenge(
  action: SeckillGovernanceActionProjection,
  input: SeckillGovernanceChallengeRequest,
  token: string,
): Promise<SeckillGovernanceChallenge> {
  if (!action.allowedActions.includes('APPROVE_SECONDARY') || action.state !== 'DRAFT') {
    throw invalid('Seckill action is not awaiting secondary approval', 409);
  }
  requireAmount(input.nonce, 'nonce');
  requireAmount(input.deadline, 'deadline', true);
  const body = await authenticatedWrite(
    `/v2/admin/seckill/actions/${encodeURIComponent(action.actionId)}/approval-challenge`, input, token,
  );
  if (!isSeckillGovernanceChallenge(body, action, input)) {
    throw invalid('Seckill governance challenge is not bound to the selected action');
  }
  return body;
}

export async function submitSeckillGovernanceApproval(
  action: SeckillGovernanceActionProjection,
  challenge: SeckillGovernanceChallenge,
  input: SeckillGovernanceApprovalRequest,
  actorWallet: string,
  token: string,
): Promise<SeckillGovernanceActionProjection> {
  if (!addressPattern.test(actorWallet) || actorWallet.toLowerCase() === challenge.signer.toLowerCase()) {
    throw invalid('Seckill approval requires an independent secondary wallet', 403);
  }
  if (!isSeckillGovernanceChallenge(challenge, action, input) || !signaturePattern.test(input.signature)) {
    throw invalid('Seckill governance approval does not match its challenge', 400);
  }
  const body = await authenticatedWrite(
    `/v2/admin/seckill/actions/${encodeURIComponent(action.actionId)}/secondary-signature`, input, token,
  );
  if (
    !isSeckillGovernanceAction(body)
      || !sameAction(body, action)
      || body.state !== 'SECONDARY_SIGNED'
      || body.secondarySigner?.toLowerCase() !== challenge.signer.toLowerCase()
      || body.approvalNonce !== input.nonce
      || !deadlineMatches(body.approvalDeadline, input.deadline)
  ) throw invalid('Seckill governance approval result is not bound to the challenge');
  return body;
}

export async function executeSeckillGovernanceAction(
  action: SeckillGovernanceActionProjection,
  token: string,
): Promise<SeckillGovernanceActionProjection> {
  if (!action.allowedActions.includes('EXECUTE') || action.state !== 'SECONDARY_SIGNED') {
    throw invalid('Seckill action is not ready for governance wallet execution', 409);
  }
  const body = await authenticatedWrite(`/v2/admin/seckill/actions/${encodeURIComponent(action.actionId)}/execute`, {}, token);
  if (!isSeckillGovernanceAction(body) || !sameAction(body, action) || body.state !== 'PENDING_EXECUTION') {
    throw invalid('Seckill execution result does not match the selected action');
  }
  return body;
}

export async function cancelSeckillGovernanceAction(
  action: SeckillGovernanceActionProjection,
  token: string,
): Promise<SeckillGovernanceActionProjection> {
  if (!action.allowedActions.includes('CANCEL') || !['DRAFT', 'SECONDARY_SIGNED'].includes(action.state)) {
    throw invalid('Seckill action is no longer cancellable', 409);
  }
  const body = await authenticatedWrite(`/v2/admin/seckill/actions/${encodeURIComponent(action.actionId)}/cancel`, {}, token);
  if (!isSeckillGovernanceAction(body) || !sameAction(body, action) || body.state !== 'CANCELLED') {
    throw invalid('Cancelled seckill action does not match the selected action');
  }
  return body;
}

type RealtimeSocket = {
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

type RealtimeHandlers = Readonly<{
  onOpen(): void;
  onEvent(event: RealtimeEventEnvelope): void;
  onError(error: CoreApiError): void;
  onClose(code: number, reason: string): void;
}>;

export function subscribeSeckillEvents(
  sessionId: string,
  cursor: string,
  handlers: RealtimeHandlers,
  socketFactory: (url: string) => RealtimeSocket = (url) => new WebSocket(url),
) {
  requireSessionId(sessionId);
  requireCursor(cursor);
  const socket = socketFactory(seckillWebSocketUrl(sessionId, cursor));
  let lastCursor = BigInt(cursor);
  const acceptedEventIds = new Set<string>();

  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (message) => {
    try {
      const event = parseRealtimeEvent(message.data, sessionId);
      if (acceptedEventIds.has(event.eventId)) return;
      const nextCursor = BigInt(event.cursor);
      if (nextCursor <= lastCursor) throw invalid('Realtime seckill cursor is not strictly increasing');
      acceptedEventIds.add(event.eventId);
      lastCursor = nextCursor;
      handlers.onEvent(event);
    } catch (cause) {
      handlers.onError(cause instanceof CoreApiError ? cause : invalid('Realtime seckill payload is not valid JSON'));
      socket.close(4403, 'Protocol violation');
    }
  };
  socket.onerror = () => handlers.onError(new CoreApiError({ code: 'ExternalBlocked', message: 'Seckill realtime connection failed', status: 503 }));
  socket.onclose = (event) => handlers.onClose(event.code, event.reason);

  return {
    close() {
      socket.onclose = null;
      socket.close(1000, 'Admin view closed');
    },
  };
}

export function seckillWebSocketUrl(sessionId: string, cursor = '0', pageOrigin = window.location.origin) {
  requireSessionId(sessionId);
  requireCursor(cursor);
  if (websocketProtocol.publicationStatus !== 'AVAILABLE' || typeof websocketProtocol.endpoint !== 'string') {
    throw new CoreApiError({ code: 'ConfigurationRequired', message: 'Coordinated WebSocket protocol is unavailable', status: 503 });
  }
  const url = new URL(websocketProtocol.endpoint, new URL(coreOrigin || pageOrigin, pageOrigin));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('artifactVersion', artifactVersion);
  url.searchParams.set('channel', `seckill:${sessionId.toLowerCase()}`);
  url.searchParams.set('cursor', cursor);
  return url.toString();
}

export function parseRealtimeEvent(value: unknown, sessionId: string): RealtimeEventEnvelope {
  let body = value;
  if (typeof value === 'string') {
    try { body = JSON.parse(value) as unknown; }
    catch { throw invalid('Realtime seckill payload is not valid JSON'); }
  }
  if (!isRealtimeEvent(body, sessionId)) throw invalid('Realtime seckill event does not match the coordinated protocol');
  return body;
}

async function authenticatedGet(path: string, token: string, signal?: AbortSignal) {
  return requestCoreJson(path, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
}

async function authenticatedWrite(path: string, body: object, token: string) {
  return requestCoreJson(path, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
}

async function writeAction(
  path: string,
  body: object,
  token: string,
  expected: { actionKind: SeckillGovernanceActionKind; sessionId?: string },
) {
  const response = await authenticatedWrite(path, body, token);
  if (
    !isSeckillGovernanceAction(response)
      || response.actionKind !== expected.actionKind
      || (expected.sessionId !== undefined && response.sessionId.toLowerCase() !== expected.sessionId.toLowerCase())
  ) throw invalid('Seckill governance result does not match the requested operation');
  return response;
}

function isSeckillGovernanceAction(value: unknown): value is SeckillGovernanceActionProjection {
  if (!isRecord(value) || !hasExactKeys(value, [
    'artifactVersion', 'actionId', 'sessionId', 'policyVersion', 'actionKind', 'state', 'evidenceHash',
    'executorWallet', 'targetAddress', 'calldataHash', 'executorNonce', 'submittedTxHash', 'executionEvidenceHash',
    'executionTxHash', 'blockNumber', 'blockHash', 'confirmations', 'canonical', 'actorWallet',
    'secondarySigner', 'approvalNonce', 'approvalDeadline', 'createdAt', 'updatedAt', 'sessionPlan',
    'prizeInjection', 'allowedActions',
  ])) return false;
  return value.artifactVersion === artifactVersion
    && bytes32Pattern.test(String(value.actionId))
    && bytes32Pattern.test(String(value.sessionId))
    && amountPattern.test(String(value.policyVersion))
    && governanceActionKinds.includes(value.actionKind as never)
    && governanceActionStates.includes(value.state as never)
    && bytes32Pattern.test(String(value.evidenceHash))
    && addressPattern.test(String(value.executorWallet))
    && addressPattern.test(String(value.targetAddress))
    && bytes32Pattern.test(String(value.calldataHash))
    && isNullableAmount(value.executorNonce)
    && isNullableHash(value.submittedTxHash)
    && isNullableHash(value.executionEvidenceHash)
    && isNullableHash(value.executionTxHash)
    && isNullableAmount(value.blockNumber)
    && isNullableHash(value.blockHash)
    && Number.isSafeInteger(value.confirmations)
    && Number(value.confirmations) >= 0
    && (value.canonical === null || typeof value.canonical === 'boolean')
    && addressPattern.test(String(value.actorWallet))
    && isNullableAddress(value.secondarySigner)
    && isNullableAmount(value.approvalNonce)
    && isNullableDateTime(value.approvalDeadline)
    && isDateTime(value.createdAt)
    && isDateTime(value.updatedAt)
    && (value.sessionPlan === null || isSeckillSessionPlan(value.sessionPlan))
    && (value.prizeInjection === null || isSeckillPrizeInjection(value.prizeInjection))
    && Array.isArray(value.allowedActions)
    && new Set(value.allowedActions).size === value.allowedActions.length
    && value.allowedActions.every((item) => governanceAllowedActions.includes(item as never))
    && isGovernanceFinalityConsistent(value);
}

function isGovernanceFinalityConsistent(value: Record<string, unknown>) {
  if (value.state === 'FINAL') return Number(value.confirmations) >= 15 && value.canonical === true;
  if (value.state === 'MINED') return Number(value.confirmations) < 15 && value.canonical === true;
  return true;
}

function isSeckillSessionPlan(value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, [
    'merchantId', 'productId', 'skuId', 'productPolicyHash', 'rulesContentHash', 'startsAt',
    'mainDeadline', 'relayDeadline', 'inventory', 'seckillListPriceUsdt', 'timers', 'snapshot',
    'inventoryLockState', 'releasedAt',
  ])) return false;
  return nonEmpty(value, ['merchantId', 'productId', 'skuId'])
    && bytes32Pattern.test(String(value.productPolicyHash))
    && bytes32Pattern.test(String(value.rulesContentHash))
    && isDateTime(value.startsAt)
    && isDateTime(value.mainDeadline)
    && isDateTime(value.relayDeadline)
    && amountPattern.test(String(value.inventory))
    && amountPattern.test(String(value.seckillListPriceUsdt))
    && isFixedTimers(value.timers)
    && isRecord(value.snapshot)
    && ['LOCKED', 'RELEASED'].includes(String(value.inventoryLockState))
    && isNullableDateTime(value.releasedAt);
}

function isSeckillPrizeInjection(value: unknown) {
  return isRecord(value)
    && hasExactKeys(value, [
      'injectionId', 'amountUsdt', 'operationsWalletAddress', 'settlementWalletAddress', 'tokenAddress',
      'finalJournalId', 'reversalJournalId',
    ])
    && bytes32Pattern.test(String(value.injectionId))
    && amountPattern.test(String(value.amountUsdt))
    && addressPattern.test(String(value.operationsWalletAddress))
    && addressPattern.test(String(value.settlementWalletAddress))
    && addressPattern.test(String(value.tokenAddress))
    && (value.finalJournalId === null || nonEmpty(value, ['finalJournalId']))
    && (value.reversalJournalId === null || nonEmpty(value, ['reversalJournalId']));
}

function isSeckillGovernanceChallenge(
  value: unknown,
  action: SeckillGovernanceActionProjection,
  input: SeckillGovernanceChallengeRequest,
): value is SeckillGovernanceChallenge {
  if (!isRecord(value) || !hasExactKeys(value, [
    'artifactVersion', 'actionId', 'sessionId', 'actionKind', 'signer', 'executorWallet', 'typedData', 'digest',
  ])) return false;
  if (
    value.artifactVersion !== artifactVersion
      || String(value.actionId).toLowerCase() !== action.actionId.toLowerCase()
      || String(value.sessionId).toLowerCase() !== action.sessionId.toLowerCase()
      || value.actionKind !== action.actionKind
      || !addressPattern.test(String(value.signer))
      || String(value.executorWallet).toLowerCase() !== action.executorWallet.toLowerCase()
      || !bytes32Pattern.test(String(value.digest))
      || !isRecord(value.typedData)
      || !hasExactKeys(value.typedData, ['domain', 'types', 'primaryType', 'message'])
      || value.typedData.primaryType !== 'SensitiveAction'
      || !isRecord(value.typedData.domain)
      || !hasExactKeys(value.typedData.domain, ['name', 'version', 'chainId', 'verifyingContract'])
      || value.typedData.domain.name !== 'Abu24KV2Core'
      || value.typedData.domain.version !== '2'
      || value.typedData.domain.chainId !== 56
      || String(value.typedData.domain.verifyingContract).toLowerCase() !== action.targetAddress.toLowerCase()
      || !isRecord(value.typedData.types)
      || !hasExactKeys(value.typedData.types, ['SensitiveAction'])
      || !Array.isArray(value.typedData.types.SensitiveAction)
      || !isSensitiveActionFields(value.typedData.types.SensitiveAction)
      || !isRecord(value.typedData.message)
      || !hasExactKeys(value.typedData.message, sensitiveActionFields.map(([name]) => name))
  ) return false;
  const message = value.typedData.message;
  return message.action === `SECKILL_${action.actionKind}`
    && message.resourceType === 'SECKILL_SESSION'
    && String(message.resourceId).toLowerCase() === action.sessionId.toLowerCase()
    && message.policyVersion === action.policyVersion
    && bytes32Pattern.test(String(message.oldValueHash))
    && bytes32Pattern.test(String(message.newValueHash))
    && String(message.executorWallet).toLowerCase() === action.executorWallet.toLowerCase()
    && message.nonce === input.nonce
    && message.deadline === input.deadline;
}

const sensitiveActionFields = [
  ['action', 'string'],
  ['resourceType', 'string'],
  ['resourceId', 'string'],
  ['policyVersion', 'uint64'],
  ['oldValueHash', 'bytes32'],
  ['newValueHash', 'bytes32'],
  ['executorWallet', 'address'],
  ['nonce', 'uint256'],
  ['deadline', 'uint64'],
] as const;

function isSensitiveActionFields(value: readonly unknown[]) {
  return value.length === sensitiveActionFields.length
    && value.every((field, index) => isRecord(field)
      && hasExactKeys(field, ['name', 'type'])
      && field.name === sensitiveActionFields[index]?.[0]
      && field.type === sensitiveActionFields[index]?.[1]);
}

function sameAction(value: SeckillGovernanceActionProjection, expected: SeckillGovernanceActionProjection) {
  return value.actionId.toLowerCase() === expected.actionId.toLowerCase()
    && value.sessionId.toLowerCase() === expected.sessionId.toLowerCase()
    && value.actionKind === expected.actionKind
    && value.policyVersion === expected.policyVersion
    && value.executorWallet.toLowerCase() === expected.executorWallet.toLowerCase()
    && value.targetAddress.toLowerCase() === expected.targetAddress.toLowerCase()
    && value.calldataHash.toLowerCase() === expected.calldataHash.toLowerCase();
}

function deadlineMatches(value: string | null, deadline: string) {
  const seconds = Number(deadline);
  return value !== null && Number.isSafeInteger(seconds) && new Date(seconds * 1_000).toISOString() === value;
}

function queryString(query: SeckillPageQuery) {
  const params = new URLSearchParams();
  if (query.cursor !== undefined) { requireCursor(query.cursor); params.set('cursor', query.cursor); }
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw invalid('Seckill page limit must be between 1 and 100');
    params.set('limit', String(query.limit));
  }
  return params.size ? `?${params}` : '';
}

function isSeckillSession(value: unknown): value is SeckillSessionProjection {
  if (!isRecord(value) || !hasExactKeys(value, [
    'artifactVersion', 'sessionId', 'policyVersion', 'merchantId', 'product', 'phase', 'storedPhase',
    'serverTime', 'startsAt', 'mainDeadline', 'relayDeadline', 'settlementEarliestAt', 'settlementDeadline',
    'timers', 'inventory', 'prizePoolUsdt', 'lastBuyerWallet', 'winnerWallet', 'prizeSettlement',
    'snapshot', 'governanceActionId', 'rulesContentHash', 'publicationTxHash', 'allowedActions',
  ]) || value.artifactVersion !== artifactVersion || !bytes32Pattern.test(String(value.sessionId))) return false;
  if (!amountPattern.test(String(value.policyVersion)) || typeof value.merchantId !== 'string' || !value.merchantId) return false;
  if (!isRecord(value.product)
    || !hasExactKeys(value.product, ['productId', 'skuId', 'title', 'metadata', 'attributes', 'seckillListPriceUsdt'])
    || !nonEmpty(value.product, ['productId', 'skuId', 'title'])
    || !isRecord(value.product.metadata)
    || !isRecord(value.product.attributes)
    || !amountPattern.test(String(value.product.seckillListPriceUsdt))) return false;
  if (!seckillStates.includes(value.phase as never) || !seckillStates.includes(value.storedPhase as never)) return false;
  if (!['serverTime', 'startsAt', 'mainDeadline', 'relayDeadline', 'settlementEarliestAt', 'settlementDeadline'].every((field) => isDateTime(value[field]))) return false;
  const timers = value.timers;
  const inventory = value.inventory;
  if (!isFixedTimers(timers)) return false;
  if (!isRecord(inventory)
    || !hasExactKeys(inventory, ['total', 'sold', 'reserved', 'available'])
    || !['total', 'sold', 'reserved', 'available'].every((field) => amountPattern.test(String(inventory[field])))) return false;
  return amountPattern.test(String(value.prizePoolUsdt))
    && (value.lastBuyerWallet === null || addressPattern.test(String(value.lastBuyerWallet)))
    && (value.winnerWallet === null || addressPattern.test(String(value.winnerWallet)))
    && (value.prizeSettlement === null || isSeckillPrizeSettlement(value.prizeSettlement))
    && isRecord(value.snapshot)
    && isNullableHash(value.governanceActionId)
    && isNullableHash(value.rulesContentHash)
    && isNullableHash(value.publicationTxHash)
    && Array.isArray(value.allowedActions)
    && value.allowedActions.every((item) => typeof item === 'string' && item.length > 0);
}

function isSeckillPrizeSettlement(value: unknown): value is SeckillPrizeSettlementProjection {
  if (!isRecord(value) || !hasExactKeys(value, [
    'state', 'cutoffAt', 'candidate', 'poolAmountUsdt', 'poolSnapshotHash', 'review', 'awardJournalId',
    'rolloverTargetSessionId', 'rolloverJournalId', 'payout',
  ])) return false;
  return ['REVIEW_PENDING', 'APPROVED', 'ROLLOVER_PENDING', 'ROLLED_OVER', 'QUARANTINED'].includes(String(value.state))
    && isDateTime(value.cutoffAt)
    && (value.candidate === null || isSeckillPrizeCandidate(value.candidate))
    && amountPattern.test(String(value.poolAmountUsdt))
    && bytes32Pattern.test(String(value.poolSnapshotHash))
    && (value.review === null || isSeckillPrizeReview(value.review))
    && isNullableNonEmptyText(value.awardJournalId)
    && isNullableHash(value.rolloverTargetSessionId)
    && isNullableNonEmptyText(value.rolloverJournalId)
    && (value.payout === null || isSeckillPrizePayout(value.payout));
}

function isSeckillPrizeCandidate(value: unknown) {
  return isRecord(value)
    && hasExactKeys(value, ['orderId', 'buyerWallet', 'paymentEventKey', 'blockNumber', 'logIndex', 'evidenceHash'])
    && bytes32Pattern.test(String(value.orderId))
    && addressPattern.test(String(value.buyerWallet))
    && nonEmpty(value, ['paymentEventKey'])
    && amountPattern.test(String(value.blockNumber))
    && amountPattern.test(String(value.logIndex))
    && bytes32Pattern.test(String(value.evidenceHash));
}

function isSeckillPrizeReview(value: unknown) {
  return isRecord(value)
    && hasExactKeys(value, ['decision', 'reasonCode', 'evidenceHash', 'reviewedBy', 'reviewedAt'])
    && ['APPROVED', 'REJECTED'].includes(String(value.decision))
    && typeof value.reasonCode === 'string'
    && value.reasonCode.length >= 2
    && value.reasonCode.length <= 128
    && bytes32Pattern.test(String(value.evidenceHash))
    && addressPattern.test(String(value.reviewedBy))
    && isDateTime(value.reviewedAt);
}

function isSeckillPrizePayout(value: unknown) {
  return isRecord(value)
    && hasExactKeys(value, ['state', 'requestId', 'batchId', 'finalSafeTxHash', 'finalExecutionTxHash'])
    && ['AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED', 'RETRYABLE', 'QUARANTINED'].includes(String(value.state))
    && isNullableHash(value.requestId)
    && isNullableHash(value.batchId)
    && isNullableHash(value.finalSafeTxHash)
    && isNullableHash(value.finalExecutionTxHash);
}

function samePrizeSnapshot(value: SeckillPrizeSettlementProjection, expected: SeckillPrizeSettlementProjection) {
  const candidate = value.candidate;
  const frozen = expected.candidate;
  return value.poolAmountUsdt === expected.poolAmountUsdt
    && value.cutoffAt === expected.cutoffAt
    && value.poolSnapshotHash.toLowerCase() === expected.poolSnapshotHash.toLowerCase()
    && candidate !== null
    && frozen !== null
    && candidate.orderId.toLowerCase() === frozen.orderId.toLowerCase()
    && candidate.buyerWallet.toLowerCase() === frozen.buyerWallet.toLowerCase()
    && candidate.paymentEventKey === frozen.paymentEventKey
    && candidate.blockNumber === frozen.blockNumber
    && candidate.logIndex === frozen.logIndex
    && candidate.evidenceHash.toLowerCase() === frozen.evidenceHash.toLowerCase();
}

function isRealtimeEvent(value: unknown, sessionId: string): value is RealtimeEventEnvelope {
  return isRecord(value)
    && value.artifactVersion === artifactVersion
    && value.protocolVersion === 1
    && typeof value.eventId === 'string'
    && value.eventId.length > 0
    && value.channel === `seckill:${sessionId.toLowerCase()}`
    && isCursor(value.cursor)
    && value.eventType === 'SeckillRelayExtended'
    && value.resourceType === 'SECKILL_SESSION'
    && String(value.resourceId).toLowerCase() === sessionId.toLowerCase()
    && bytes32Pattern.test(String(value.resourceId))
    && isDateTime(value.occurredAt)
    && value.finality === 'FINAL'
    && isRecord(value.payload);
}

function requireSessionId(value: string) {
  if (!bytes32Pattern.test(value)) throw invalid('Seckill session ID must be bytes32');
}

function requireHash(value: string, field: string) {
  if (!bytes32Pattern.test(value)) throw invalid(`${field} must be bytes32`, 400);
}

function requireAmount(value: string, field: string, positive = false) {
  if (!amountPattern.test(value) || (positive && value === '0')) throw invalid(`${field} must be a canonical ${positive ? 'positive ' : ''}atomic amount`, 400);
}

function requireText(value: string, field: string) {
  if (!value.trim()) throw invalid(`${field} is required`, 400);
}

function requireBoundedText(value: string, field: string, minimum: number, maximum: number) {
  if (value.trim().length < minimum || value.trim().length > maximum) throw invalid(`${field} must contain ${minimum}-${maximum} characters`, 400);
}

function requireIdempotencyKey(value: string) {
  if (value.length < 8 || value.length > 128) throw invalid('Seckill idempotencyKey must contain 8-128 characters', 400);
}

function requireCursor(value: string) {
  if (!isCursor(value)) throw invalid('Seckill cursor must be a canonical safe integer');
}

function isCursor(value: unknown) {
  return typeof value === 'string' && amountPattern.test(value) && Number.isSafeInteger(Number(value));
}

function isFixedTimers(value: unknown) {
  return isRecord(value)
    && hasExactKeys(value, ['mainDurationSeconds', 'relayInitialSeconds', 'relayIncrementSeconds', 'relayCapSeconds'])
    && value.mainDurationSeconds === 3600
    && value.relayInitialSeconds === 60
    && value.relayIncrementSeconds === 30
    && value.relayCapSeconds === 60;
}

function isNullableHash(value: unknown) {
  return value === null || bytes32Pattern.test(String(value));
}

function isNullableAddress(value: unknown) {
  return value === null || addressPattern.test(String(value));
}

function isNullableAmount(value: unknown) {
  return value === null || amountPattern.test(String(value));
}

function isNullableDateTime(value: unknown) {
  return value === null || isDateTime(value);
}

function isNullableNonEmptyText(value: unknown) {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isDateTime(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonEmpty(value: Readonly<Record<string, unknown>>, fields: readonly string[]) {
  return fields.every((field) => typeof value[field] === 'string' && String(value[field]).length > 0);
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
