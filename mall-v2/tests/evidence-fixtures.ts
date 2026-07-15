import {
  artifactVersion,
  type ArbitrationOpenedResult,
  type EvidenceEnvelopeProjection,
  type FulfillmentCompletedResult,
  type FulfillmentRequestResult,
  type MediaAssetProjection,
  type MediaUploadIntentProjection,
} from '@abu24k/core-artifacts';

import type { BuyerEvidenceAction } from '../src/core-client';
import { deliveryOrder } from './fulfillment-fixtures';

const hash = (value: string) => `0x${value.repeat(64)}`;

export const evidenceFileHash = hash('3');
export const uploadIntentId = hash('4');
export const evidenceAssetId = hash('5');
export const orderEvidenceHash = hash('6');

export function mediaUploadIntent(input: {
  sizeBytes?: number;
  contentType?: 'image/png' | 'application/pdf';
  contentSha256?: string;
} = {}): MediaUploadIntentProjection {
  return {
    artifactVersion,
    uploadIntentId,
    ownerWallet: deliveryOrder.buyerWallet,
    purpose: 'FULFILLMENT_EVIDENCE',
    resourceType: 'ORDER',
    resourceId: deliveryOrder.orderId,
    contentType: input.contentType ?? 'image/png',
    sizeBytes: String(input.sizeBytes ?? 4),
    contentSha256: input.contentSha256 ?? evidenceFileHash,
    state: 'UPLOADED',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    method: 'PUT',
    uploadUrl: 'https://media.mall.test/write-once',
    headers: { 'content-type': input.contentType ?? 'image/png', 'if-none-match': '*' },
    providerReferenceHash: hash('7'),
    writeOnce: true,
  };
}

export function verifiedEvidenceAsset(input: {
  sizeBytes?: number;
  contentType?: 'image/png' | 'application/pdf';
  contentSha256?: string;
} = {}): MediaAssetProjection {
  return {
    artifactVersion,
    assetId: evidenceAssetId,
    uploadIntentId,
    ownerWallet: deliveryOrder.buyerWallet,
    purpose: 'FULFILLMENT_EVIDENCE',
    resourceType: 'ORDER',
    resourceId: deliveryOrder.orderId,
    contentType: input.contentType ?? 'image/png',
    sizeBytes: String(input.sizeBytes ?? 4),
    contentSha256: input.contentSha256 ?? evidenceFileHash,
    providerEvidenceHash: hash('8'),
    objectVersionHash: hash('9'),
    createdAt: '2033-05-18T05:10:00.000Z',
  };
}

export function orderActionEvidence(
  action: BuyerEvidenceAction,
  reasonCode: string,
  mediaAssetIds: readonly string[] = [],
): EvidenceEnvelopeProjection {
  return {
    artifactVersion,
    evidenceHash: orderEvidenceHash,
    ownerWallet: deliveryOrder.buyerWallet,
    actorRole: 'BUYER',
    purpose: 'FULFILLMENT_ACTION',
    resourceType: 'ORDER',
    resourceId: deliveryOrder.orderId,
    action,
    reasonCode,
    trackingNumberHash: null,
    mediaAssetIds,
    payload: { actorRole: 'BUYER', action, reasonCode, mediaAssetIds },
    createdAt: '2033-05-18T05:11:00.000Z',
  };
}

export function buyerActionResult(action: 'REQUEST_EXCHANGE' | 'REQUEST_DELAY'): FulfillmentRequestResult;
export function buyerActionResult(action: 'OPEN_ARBITRATION'): ArbitrationOpenedResult;
export function buyerActionResult(action: 'CONFIRM_RECEIPT'): FulfillmentCompletedResult;
export function buyerActionResult(action: BuyerEvidenceAction): FulfillmentRequestResult | ArbitrationOpenedResult | FulfillmentCompletedResult {
  if (action === 'REQUEST_EXCHANGE' || action === 'REQUEST_DELAY') return {
    orderId: deliveryOrder.orderId,
    requestId: `request:${action.toLowerCase()}`,
    requestType: action === 'REQUEST_EXCHANGE' ? 'EXCHANGE' as const : 'DELAY' as const,
    state: 'OPEN' as const,
    requestedAt: '2033-05-18T05:12:00.000Z',
  };
  if (action === 'OPEN_ARBITRATION') return {
    orderId: deliveryOrder.orderId,
    requestId: 'request:arbitration',
    state: 'ARBITRATION' as const,
    openedAt: '2033-05-18T05:12:00.000Z',
  };
  return {
    orderId: deliveryOrder.orderId,
    state: 'FULFILLED' as const,
    method: 'CUSTOMER_RECEIPT' as const,
    fulfilledAt: '2033-05-18T05:12:00.000Z',
  };
}
