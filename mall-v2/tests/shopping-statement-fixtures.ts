import {
  artifactVersion,
  type BuyerShoppingStatement,
  type BuyerShoppingStatementPage,
} from '@abu24k/core-artifacts';

export const buyerWallet = '0x1111111111111111111111111111111111111111';
export const ordinaryShoppingOrderId = `0x${'31'.repeat(32)}`;
export const fallbackShoppingOrderId = `0x${'21'.repeat(32)}`;
export const shoppingPaymentTxHash = `0x${'41'.repeat(32)}`;

export const ordinaryShoppingStatement = {
  orderId: ordinaryShoppingOrderId,
  productId: 'product-shopping-01',
  skuId: 'sku-black-41',
  quantity: '2',
  orderState: 'FULFILLED',
  paymentTxHash: shoppingPaymentTxHash,
  paymentFinalizedAt: '2026-07-16T09:58:00.000Z',
  fulfilledAt: '2026-07-16T10:30:00.000Z',
  createdAt: '2026-07-16T09:55:00.000Z',
  orderKind: 'ORDINARY',
  paymentAmounts: {
    usdtPaymentAmount: '14000000000000000000',
    nplPaymentAmount: '600000000000000000000',
  },
  bnm: {
    amount: '20000000000000000000',
    state: 'AVAILABLE',
    transferable: false,
    journalIds: ['journal-bnm-locked-ordinary', 'journal-bnm-available-ordinary'],
  },
} as const satisfies BuyerShoppingStatement;

export const fallbackShoppingStatement = {
  orderId: fallbackShoppingOrderId,
  productId: 'product-fallback-02',
  skuId: 'sku-retail-42',
  quantity: '1',
  orderState: 'PAID',
  paymentTxHash: `0x${'42'.repeat(32)}`,
  paymentFinalizedAt: '2026-07-15T12:03:00.000Z',
  fulfilledAt: null,
  createdAt: '2026-07-15T12:00:00.000Z',
  orderKind: 'FALLBACK_RETAIL',
  paymentAmounts: {
    usdtPaymentAmount: '7000000000000000000',
    nplPaymentAmount: '300000000000000000000',
  },
  bnm: {
    amount: '10000000000000000000',
    state: 'LOCKED',
    transferable: false,
    journalIds: ['journal-bnm-locked-fallback'],
  },
} as const satisfies BuyerShoppingStatement;

export const firstShoppingStatementPage = {
  artifactVersion,
  buyerWallet,
  statements: [ordinaryShoppingStatement],
  nextCursor: {
    createdAt: ordinaryShoppingStatement.createdAt,
    orderId: ordinaryShoppingStatement.orderId,
  },
} as const satisfies BuyerShoppingStatementPage;

export const secondShoppingStatementPage = {
  artifactVersion,
  buyerWallet,
  statements: [fallbackShoppingStatement],
  nextCursor: null,
} as const satisfies BuyerShoppingStatementPage;
