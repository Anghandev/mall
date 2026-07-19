import {
  artifactVersion,
  type EvidenceEnvelopeProjection,
  type TakeoverAssignment,
  type TakeoverCase,
  type TakeoverCaseDetail,
  type TakeoverCaseList,
} from '@abu24k/core-artifacts';
import { deliveryOrderId, deliveryTarget, evidenceHash, trackingNumberHash } from './fulfillment-fixtures';

export const replacementMerchantId = 'merchant-1';
export const replacementWallet = '0x1111111111111111111111111111111111111111';
export const takeoverCaseId = 'takeover-case-assigned-1';
export const takeoverAssignmentId = `0x${'a'.repeat(64)}`;

export const takeoverAssignment: TakeoverAssignment = {
  assignmentId: takeoverAssignmentId,
  caseId: takeoverCaseId,
  orderId: deliveryOrderId,
  version: 2,
  originalMerchantId: 'merchant-original',
  replacementMerchantId,
  replacementWallet,
  replacementApplicationVersion: 4,
  replacementLicenseAssetId: `0x${'b'.repeat(64)}`,
  supersedesAssignmentId: `0x${'c'.repeat(64)}`,
  reasonCode: 'CAPACITY_REASSIGNMENT',
  evidenceHash: `0x${'d'.repeat(64)}`,
  assignedBy: '0x2222222222222222222222222222222222222222',
  correlationId: 'takeover-assignment-correlation-2',
  assignedAt: '2026-07-16T02:00:00.000Z',
};

export const fundedTakeoverCase: TakeoverCase = {
  caseId: takeoverCaseId,
  orderId: deliveryOrderId,
  originalMerchantId: 'merchant-original',
  policyVersion: '9',
  state: 'FUNDED',
  requiredUsdt: '20000000000000000000',
  funding: {
    guaranteeUsedUsdt: '0',
    frozenReceivablesUsedUsdt: '0',
    futureProceedsUsedUsdt: '0',
    platformAdvanceUsdt: '20000000000000000000',
    disbursedUsdt: '20000000000000000000',
    merchantDebtUsdt: '20000000000000000000',
  },
  evidenceHash,
  openedAt: '2026-07-15T01:00:00.000Z',
  closedAt: null,
  updatedAt: '2026-07-16T02:00:00.000Z',
  order: {
    productId: 'product-takeover',
    skuId: 'sku-takeover',
    quantity: '1',
    fulfillmentMode: 'DELIVERY',
    fulfillmentTargetHash: deliveryTarget.targetHash,
    state: 'TAKEOVER',
    paymentFinal: true,
  },
  currentAssignment: takeoverAssignment,
};

export const takeoverCaseList: TakeoverCaseList = {
  artifactVersion,
  cases: [fundedTakeoverCase],
  nextCursor: {
    openedAt: fundedTakeoverCase.openedAt,
    caseId: fundedTakeoverCase.caseId,
  },
};

export const takeoverCaseDetail: TakeoverCaseDetail = {
  artifactVersion,
  case: {
    ...fundedTakeoverCase,
    allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: true }],
  },
  assignments: [takeoverAssignment],
  transitions: [{
    transitionId: 'takeover-transition-funded-1',
    fromState: 'OPEN',
    toState: 'FUNDED',
    evidenceType: 'TAKEOVER_FUNDED',
    evidenceHash: `0x${'e'.repeat(64)}`,
    occurredAt: '2026-07-16T01:30:00.000Z',
  }],
};

export const takeoverTrackingEvidence: EvidenceEnvelopeProjection = {
  artifactVersion,
  evidenceHash: `0x${'f'.repeat(64)}`,
  ownerWallet: replacementWallet,
  actorRole: 'MERCHANT',
  purpose: 'SHIPMENT_TRACKING',
  resourceType: 'ORDER',
  resourceId: deliveryOrderId,
  action: 'RECORD_SHIPMENT',
  reasonCode: null,
  trackingNumberHash,
  mediaAssetIds: [],
  payload: {
    actorRole: 'MERCHANT',
    carrierCode: 'SF',
    trackingNumberHash,
  },
  carrierCode: 'SF',
  createdAt: '2026-07-16T02:05:00.000Z',
};
