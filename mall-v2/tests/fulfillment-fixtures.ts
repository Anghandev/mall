import {
  artifactVersion,
  type AllowedAction,
  type DeliveryTarget,
  type FulfillmentOrder,
  type FulfillmentTarget,
  type MerchantStore,
  type PickupTarget,
} from '@abu24k/core-artifacts';

const hash = (value: string) => `0x${value.repeat(64)}`;
const address = (value: string) => `0x${value.repeat(40)}`;

export const store: MerchantStore = {
  storeId: 'store-dalian-001',
  merchantId: 'merchant-001',
  name: '阿步 24K 大连自提店',
  regionCode: '210202',
  longitude: 121.6389,
  latitude: 38.914,
  address: '辽宁省大连市中山区示例路 24 号',
  phone: '0411-88888888',
  status: 'ACTIVE',
  version: 3,
};

export const deliveryTarget: DeliveryTarget = {
  targetId: 'target-delivery-001',
  targetHash: hash('4'),
  fulfillmentMode: 'DELIVERY',
  regionCode: '210202',
  regionCodeHash: hash('5'),
  expiresAt: '2033-05-18T03:38:20.000Z',
};

export const pickupTarget: PickupTarget = {
  targetId: 'target-pickup-001',
  targetHash: hash('6'),
  fulfillmentMode: 'PICKUP',
  regionCode: store.regionCode,
  regionCodeHash: hash('7'),
  expiresAt: '2033-05-18T03:38:20.000Z',
  storeId: store.storeId,
  store,
};

export const deliveryOrderTarget: FulfillmentTarget = {
  ...deliveryTarget,
  payload: {
    recipientName: '张三',
    phone: '13800138000',
    address: '辽宁省大连市中山区示例路 24 号 3 单元',
    longitude: 121.6389,
    latitude: 38.914,
    regionCode: '210202',
  },
};

export const pickupOrderTarget: FulfillmentTarget = {
  targetId: pickupTarget.targetId,
  targetHash: pickupTarget.targetHash,
  fulfillmentMode: 'PICKUP',
  regionCode: pickupTarget.regionCode,
  regionCodeHash: pickupTarget.regionCodeHash,
  expiresAt: pickupTarget.expiresAt,
  storeId: store.storeId,
  payload: store,
};

export const deliveryOrder: FulfillmentOrder = {
  orderId: hash('8'),
  artifactVersion,
  buyerWallet: address('1'),
  merchantId: store.merchantId,
  merchantWallet: address('2'),
  productId: 'product-24k-shoe',
  skuId: 'sku-42-black-gold',
  fulfillmentMode: 'DELIVERY',
  state: 'SHIPPED',
  finalityStatus: 'FINAL',
  exactAmounts: {
    listPriceUsdt: '120000000000000000000',
    usdtPaymentAmount: '84000000000000000000',
    nplQuoteAmount: '240000000000000000000',
    nplPaymentAmount: '72000000000000000000',
    nplBurnAmount: '48000000000000000000',
    nplRewardAmount: '24000000000000000000',
    merchantBaseReceivableUsdt: '70000000000000000000',
    merchantConcessionAmount: '17500000000000000000',
    merchantNetReceivableUsdt: '52500000000000000000',
    bnmAmount: '120000000000000000000',
  },
  paidAt: '2033-05-18T03:10:00.000Z',
  paymentFinalizedAt: '2033-05-18T03:15:00.000Z',
  shippedAt: '2033-05-18T04:00:00.000Z',
  deliveredAt: null,
  fulfilledAt: null,
  takeoverOpenedAt: null,
  arbitrationOpenedAt: null,
  requests: [],
  shipments: [{
    shipmentId: 'shipment-001',
    carrierCode: 'SF',
    trackingNumberHash: hash('9'),
    providerReferenceHash: null,
    createdAt: '2033-05-18T04:00:00.000Z',
  }],
  logistics: [{
    logisticsEventId: 'logistics-001',
    provider: 'KUAIDI100',
    status: 'IN_TRANSIT',
    locationHash: hash('a'),
    occurredAt: '2033-05-18T05:00:00.000Z',
  }],
  balances: [
    { asset: 'USDT', state: 'LOCKED', amount: '52500000000000000000' },
    { asset: 'NPL', state: 'LOCKED', amount: '24000000000000000000' },
    { asset: 'BNM_POINTS', state: 'LOCKED', amount: '120000000000000000000' },
  ],
};

export const pickupOrder: FulfillmentOrder = {
  ...deliveryOrder,
  orderId: hash('b'),
  fulfillmentMode: 'PICKUP',
  state: 'DELIVERED',
  shippedAt: null,
  deliveredAt: '2033-05-18T06:00:00.000Z',
  shipments: [],
  logistics: [],
};

export const deliveryActions: readonly AllowedAction[] = [
  { action: 'REQUEST_EXCHANGE', enabled: true },
  { action: 'REQUEST_DELAY', enabled: false, reasonCode: 'UnknownState' },
  { action: 'CONFIRM_RECEIPT', enabled: false, reasonCode: 'UnknownState' },
  { action: 'OPEN_ARBITRATION', enabled: true },
];

export const pickupActions: readonly AllowedAction[] = [
  { action: 'VERIFY_PICKUP', enabled: true },
  { action: 'OPEN_TAKEOVER', enabled: false, reasonCode: 'PickupTakeoverDecisionBlocked' },
];
