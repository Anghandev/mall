import {
  artifactVersion,
  type BuyerOverview,
  type BuyerProfile,
  type BuyerSavedAddress,
  type BuyerTakeoverTimeline,
  type MediaAssetProjection,
  type MediaReadAccessProjection,
  type MediaUploadIntentProjection,
} from '@abu24k/core-artifacts';

import type { ParsedBuyerAddress } from '../src/core-client';
import { deliveryOrder } from './fulfillment-fixtures';

const hash = (value: string) => `0x${value.repeat(64)}`;

export const avatarUploadIntentId = hash('a');
export const avatarAssetId = hash('b');
export const avatarContentHash = hash('c');

export const buyerProfile: BuyerProfile = {
  artifactVersion,
  wallet: deliveryOrder.buyerWallet,
  accountId: null,
  accountIdStatus: 'DecisionBlocked',
  nickname: '阿步会员',
  avatarAssetId: null,
  version: 2,
  updatedAt: '2033-05-18T04:00:00.000Z',
};

export const buyerOverview: BuyerOverview = {
  artifactVersion,
  wallet: deliveryOrder.buyerWallet,
  orderCounts: {
    pendingPayment: { status: 'DecisionBlocked', count: null, blocker: 'BUYER_PENDING_PAYMENT_PROJECTION' },
    pendingShipment: { status: 'AVAILABLE', count: '2' },
    pendingReceipt: { status: 'AVAILABLE', count: '3' },
    afterSale: { status: 'AVAILABLE', count: '1' },
    total: { status: 'AVAILABLE', count: '6' },
  },
};

export const parsedBuyerAddress: ParsedBuyerAddress = {
  recipientName: '张三',
  phone: '13800138000',
  province: '辽宁省',
  city: '大连市',
  district: '中山区',
  detailAddress: '辽宁省大连市中山区示例路 24 号',
  regionCode: '210202',
  longitude: 121.6389,
  latitude: 38.914,
  sourceReferenceHash: hash('d'),
  canSave: true,
  missingFields: [],
};

export const buyerSavedAddress: BuyerSavedAddress = {
  addressId: 'buyer-address-1',
  label: '家',
  recipientName: '张三',
  phone: '13800138000',
  detailAddress: parsedBuyerAddress.detailAddress!,
  longitude: parsedBuyerAddress.longitude!,
  latitude: parsedBuyerAddress.latitude!,
  province: parsedBuyerAddress.province!,
  city: parsedBuyerAddress.city!,
  district: parsedBuyerAddress.district!,
  formattedAddress: parsedBuyerAddress.detailAddress!,
  regionCode: parsedBuyerAddress.regionCode!,
  isDefault: true,
  version: 3,
  updatedAt: '2033-05-18T04:10:00.000Z',
};

export const buyerTakeoverTimeline: BuyerTakeoverTimeline = {
  artifactVersion,
  orderId: deliveryOrder.orderId,
  historyStatus: 'PARTIAL_LEGACY',
  transitions: [{
    transitionId: 'takeover-transition-1',
    fromState: 'OPEN',
    toState: 'FUNDED',
    evidenceType: 'PLATFORM_FUNDING_CONFIRMED',
    occurredAt: '2033-05-18T04:20:00.000Z',
  }],
};

export function avatarUploadIntent(): MediaUploadIntentProjection {
  return {
    artifactVersion,
    uploadIntentId: avatarUploadIntentId,
    ownerWallet: deliveryOrder.buyerWallet,
    purpose: 'BUYER_AVATAR',
    resourceType: 'BUYER',
    resourceId: deliveryOrder.buyerWallet,
    contentType: 'image/png',
    sizeBytes: '4',
    contentSha256: avatarContentHash,
    state: 'UPLOADED',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    method: 'PUT',
    uploadUrl: 'https://media.mall.test/buyer-avatar-write-once',
    headers: { 'content-type': 'image/png', 'if-none-match': '*' },
    providerReferenceHash: hash('e'),
    writeOnce: true,
  };
}

export function verifiedAvatarAsset(): MediaAssetProjection {
  return {
    artifactVersion,
    assetId: avatarAssetId,
    uploadIntentId: avatarUploadIntentId,
    ownerWallet: deliveryOrder.buyerWallet,
    purpose: 'BUYER_AVATAR',
    resourceType: 'BUYER',
    resourceId: deliveryOrder.buyerWallet,
    contentType: 'image/png',
    sizeBytes: '4',
    contentSha256: avatarContentHash,
    providerEvidenceHash: hash('f'),
    objectVersionHash: hash('1'),
    createdAt: '2033-05-18T04:30:00.000Z',
  };
}

export function authenticatedAvatarAccess(): MediaReadAccessProjection {
  return {
    artifactVersion,
    assetId: avatarAssetId,
    purpose: 'BUYER_AVATAR',
    resourceType: 'BUYER',
    resourceId: deliveryOrder.buyerWallet,
    contentType: 'image/png',
    sizeBytes: '4',
    contentSha256: avatarContentHash,
    objectVersionHash: hash('1'),
    accessScope: 'AUTHENTICATED',
    method: 'GET',
    readUrl: 'https://media.mall.test/buyer-avatar.png',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    providerReferenceHash: hash('2'),
  };
}
