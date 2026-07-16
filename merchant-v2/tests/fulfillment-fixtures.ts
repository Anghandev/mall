import {
  artifactVersion,
  type FulfillmentOrder,
  type FulfillmentTarget,
  type MerchantOrderExport,
} from '@abu24k/core-artifacts';

export const deliveryOrderId = `0x${'1'.repeat(64)}`;
export const pickupOrderId = `0x${'2'.repeat(64)}`;
export const evidenceHash = `0x${'3'.repeat(64)}`;
export const trackingNumberHash = `0x${'4'.repeat(64)}`;
export const paymentTxHash = `0x${'9'.repeat(64)}`;

const exactAmounts = {
  listPriceUsdt: '100000000000000000000',
  usdtPaymentAmount: '70000000000000000000',
  nplQuoteAmount: '30000000000000000000',
  nplPaymentAmount: '30000000000000000000',
  nplBurnAmount: '20000000000000000000',
  nplRewardAmount: '10000000000000000000',
  merchantBaseReceivableUsdt: '80000000000000000000',
  merchantConcessionAmount: '8000000000000000000',
  merchantNetReceivableUsdt: '72000000000000000000',
  bnmAmount: '100000000000000000000',
} as const;

export const deliveryOrder: FulfillmentOrder = {
  orderId: deliveryOrderId,
  artifactVersion,
  buyerWallet: '0x2222222222222222222222222222222222222222',
  merchantId: 'merchant-1',
  merchantWallet: '0x1111111111111111111111111111111111111111',
  productId: 'product-1',
  skuId: 'sku-delivery',
  quantity: '2',
  createdAt: '2026-07-01T07:59:00.000Z',
  orderKind: 'SECKILL',
  paymentTxHash,
  fulfillmentMode: 'DELIVERY',
  state: 'DELIVERED',
  finalityStatus: 'FINAL',
  exactAmounts,
  paidAt: '2026-07-01T08:00:00.000Z',
  paymentFinalizedAt: '2026-07-01T08:05:00.000Z',
  shippedAt: '2026-07-02T08:00:00.000Z',
  deliveredAt: '2026-07-03T08:00:00.000Z',
  fulfilledAt: null,
  takeoverOpenedAt: null,
  arbitrationOpenedAt: null,
  requests: [],
  shipments: [{
    shipmentId: 'shipment-1',
    carrierCode: 'SF_EXPRESS',
    trackingNumberHash,
    providerReferenceHash: null,
    createdAt: '2026-07-02T08:00:00.000Z',
  }],
  logistics: [{
    logisticsEventId: 'logistics-1',
    provider: 'KUAIDI100',
    status: 'DELIVERED',
    locationHash: null,
    occurredAt: '2026-07-03T08:00:00.000Z',
  }],
  balances: [
    { asset: 'USDT', state: 'LOCKED', amount: '72000000000000000000' },
    { asset: 'BNM_POINTS', state: 'LOCKED', amount: '100000000000000000000' },
  ],
  allowedActions: [{ action: 'REQUEST_FORCED_RECEIPT', enabled: true }],
};

export const pickupOrder: FulfillmentOrder = {
  ...deliveryOrder,
  orderId: pickupOrderId,
  skuId: 'sku-pickup',
  fulfillmentMode: 'PICKUP',
  state: 'PAID',
  shippedAt: null,
  deliveredAt: null,
  shipments: [],
  logistics: [],
  allowedActions: [{ action: 'VERIFY_PICKUP', enabled: true }],
};

export const deliveryTarget = {
  targetId: 'target-delivery-1',
  targetHash: `0x${'5'.repeat(64)}`,
  fulfillmentMode: 'DELIVERY',
  regionCode: '110101',
  regionCodeHash: `0x${'6'.repeat(64)}`,
  expiresAt: '2026-07-14T08:00:00.000Z',
  payload: {
    recipientName: '陈先生',
    phone: '13800000000',
    address: '北京市东城区仓储路 24 号',
    longitude: 116.41,
    latitude: 39.91,
    regionCode: '110101',
  },
} satisfies FulfillmentTarget;

export const pickupTarget = {
  targetId: 'target-pickup-1',
  targetHash: `0x${'7'.repeat(64)}`,
  fulfillmentMode: 'PICKUP',
  regionCode: '210211',
  regionCodeHash: `0x${'8'.repeat(64)}`,
  expiresAt: '2026-07-14T08:00:00.000Z',
  storeId: 'store-dalian-1',
  payload: {
    storeId: 'store-dalian-1',
    merchantId: 'merchant-1',
    name: '大连甘井子自提店',
    regionCode: '210211',
    longitude: 121.53,
    latitude: 38.95,
    address: '大连市甘井子区金街 24 号',
    phone: '041100000000',
    businessHours: '09:00-18:00',
    imageAssetIds: [`0x${'9'.repeat(64)}`],
    status: 'ACTIVE',
    version: 1,
  },
} satisfies FulfillmentTarget;

export const merchantOrderExport: MerchantOrderExport = {
  artifactVersion,
  exportId: `0x${'a'.repeat(64)}`,
  merchantId: 'merchant-1',
  contentType: 'application/vnd.ms-excel; charset=utf-8',
  filename: 'merchant-orders-2026-07-01-2026-07-15.xls',
  rowCount: 1,
  contentHash: '0x2c43a932a1286939e54d75351b4dbfe5130806fac610863d7e683d975752d34d',
  contentBase64: 'PFdvcmtib29rPjxSb3c+b3JkZXI8L1Jvdz48L1dvcmtib29rPg==',
  nextCursor: null,
  filters: {
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-15T00:00:00.000Z',
    skuId: 'sku-delivery',
    state: 'DELIVERED',
    fulfillmentMode: 'DELIVERY',
    orderKind: 'SECKILL',
    cursorCreatedAt: null,
    cursorOrderId: null,
    limit: 1_000,
  },
};
