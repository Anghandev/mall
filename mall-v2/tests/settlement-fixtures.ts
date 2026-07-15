import {
  artifactVersion,
  chainIdentity,
  type CmsPublicItem,
  type NotificationInboxItem,
  type SettlementIntentProjection,
  type SettlementListProjection,
  type SettlementRequestProjection,
} from '@abu24k/core-artifacts';
import { TypedDataEncoder } from 'ethers';

const hash = (value: string) => `0x${value.repeat(64)}`;
const address = (value: string) => `0x${value.repeat(40)}`;

export const settlementBuyer = address('1');
export const settlementSafe = address('9');
export const finalSafeTxHash = hash('f');
const settlementRequestTypes = {
  SettlementRequest: [
    { name: 'intentId', type: 'bytes32' },
    { name: 'artifactVersion', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'rail', type: 'string' },
    { name: 'asset', type: 'address' },
    { name: 'safeAddress', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'itemsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};
const settlementIntentValue = {
  intentId: hash('8'),
  artifactVersion,
  wallet: settlementBuyer,
  recipient: settlementBuyer,
  rail: 'REWARD_NPL' as const,
  asset: chainIdentity.nplAddress,
  safeAddress: settlementSafe,
  amount: '200',
  itemsHash: hash('7'),
  nonce: '3',
  deadline: 2_000_000_000,
};
const settlementDomain = { name: 'Abu24KV2Settlement', version: '2', chainId: 56, verifyingContract: settlementSafe };

export const settlementIntent: SettlementIntentProjection = {
  intent: settlementIntentValue,
  digest: TypedDataEncoder.hash(settlementDomain, settlementRequestTypes, settlementIntentValue),
  typedData: {
    domain: settlementDomain,
    types: settlementRequestTypes,
    primaryType: 'SettlementRequest',
    message: settlementIntentValue,
  },
  items: [{
    itemIndex: 0,
    orderId: hash('1'),
    accountId: 'ledger:reward:buyer',
    backingSafeAddress: settlementSafe,
    amount: '200',
    itemHash: hash('5'),
  }],
  createdAt: '2033-05-18T05:00:00.000Z',
};

export const requestedSettlement: SettlementRequestProjection = {
  request_id: 'settlement-request-1',
  intent_id: settlementIntent.intent.intentId,
  artifact_version: artifactVersion,
  wallet_address: settlementBuyer,
  recipient_address: settlementBuyer,
  rail: 'REWARD_NPL',
  asset: 'NPL',
  asset_address: chainIdentity.nplAddress,
  safe_address: settlementSafe,
  amount: '200',
  items_hash: settlementIntent.intent.itemsHash,
  intent_digest: settlementIntent.digest,
  signature_hash: hash('4'),
  state: 'REQUESTED',
  batch_id: null,
  final_safe_tx_hash: null,
  final_execution_tx_hash: null,
  requested_at: '2033-05-18T05:01:00.000Z',
  batched_at: null,
  settled_at: null,
  items: [],
  transitions: [],
};

export const settlementProjection: SettlementListProjection = {
  artifactVersion,
  wallet: settlementBuyer,
  balances: [
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: null, state: 'LOCKED', amount: '100' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: null, state: 'AVAILABLE', amount: '200' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: null, state: 'REQUESTED', amount: '300' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: null, state: 'BATCHED', amount: '400' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: null, state: 'SETTLED', amount: '500' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'GENESIS', state: 'LOCKED', amount: '20' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'DIRECT_REFERRAL', state: 'AVAILABLE', amount: '10' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'DISTRICT', state: 'AVAILABLE', amount: '12' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'CITY', state: 'AVAILABLE', amount: '8' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'PROVINCE', state: 'AVAILABLE', amount: '6' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'REGION', state: 'AVAILABLE', amount: '4' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'OPERATIONS', state: 'AVAILABLE', amount: '40' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'ROUNDING_REMAINDER', state: 'AVAILABLE', amount: '1' },
    { asset: 'USDT', purpose: 'SECKILL_PRIZE_LIABILITY', rewardSubtype: null, state: 'AVAILABLE', amount: '60' },
  ],
  points: [
    { pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'LOCKED', amount: '700', transferable: false },
    { pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'AVAILABLE', amount: '300', transferable: false },
  ],
  requests: [{
    ...requestedSettlement,
    request_id: 'settlement-request-settled',
    state: 'SETTLED',
    batch_id: 'settlement-batch-1',
    final_safe_tx_hash: finalSafeTxHash,
    final_execution_tx_hash: finalSafeTxHash,
    batched_at: '2033-05-18T05:02:00.000Z',
    settled_at: '2033-05-18T05:10:00.000Z',
  }],
};

export const publicCmsItem: CmsPublicItem = {
  entryId: 'cms-entry-1',
  versionId: 'cms-version-2',
  version: 2,
  slug: 'mall-announcement',
  contentType: 'RELEASE_ANNOUNCEMENT',
  placement: 'MALL_HOME_TOP',
  locale: 'zh-CN',
  content: { type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text: '结算中心已开放', marks: ['bold'] }] }] },
  contentHash: hash('3'),
  audience: { type: 'ALL' },
  startsAt: null,
  endsAt: null,
  frequencyCap: null,
  policyVersion: null,
};

export const notificationItem: NotificationInboxItem = {
  messageId: 'notification-message-1',
  sourceEventType: 'SettlementFinalized',
  topic: 'SETTLEMENT_SETTLED',
  templateData: { requestId: 'settlement-request-settled', safeTxHash: finalSafeTxHash },
  deliveryState: 'DELIVERED',
  createdAt: '2033-05-18T05:10:00.000Z',
};
