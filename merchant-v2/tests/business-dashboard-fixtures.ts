import { artifactVersion, type MerchantBusinessDashboard } from '@abu24k/core-artifacts';

export const merchantBusinessDashboard: MerchantBusinessDashboard = {
  artifactVersion,
  timezone: 'Asia/Shanghai',
  window: {
    start: '2026-07-14T16:00:00.000Z',
    end: '2026-07-15T16:00:00.000Z',
    generatedAt: '2026-07-15T08:30:00.000Z',
  },
  merchant: {
    merchantId: 'merchant-1',
    status: 'APPROVED',
    guaranteeStatus: 'READY',
  },
  product: {
    productId: 'product-managed-1',
    title: '24K 足金金片',
    state: 'ACTIVE',
    stock: { total: '20', available: '12', reserved: '3' },
    seckill: {
      sessionId: `0x${'7'.repeat(64)}`,
      phase: 'LIVE',
    },
    updatedAt: '2026-07-15T08:25:00.000Z',
  },
  orders: {
    finalizedToday: '8',
    pendingShipment: '3',
    shipped: '4',
    delivered: '2',
    fulfilled: '1',
    arbitration: '1',
    takeover: '1',
    pickupVerifiedToday: '2',
  },
  sales: {
    listPriceUsdt: '8000000000000000000000',
    buyerUsdtPaid: '5600000000000000000000',
    merchantBaseReceivableUsdt: '4800000000000000000000',
    merchantNetReceivableUsdt: '3600000000000000000000',
  },
  shipmentRate: {
    numerator: '4',
    denominator: '8',
    bps: '5000',
  },
  settlements: {
    requestedCount: '2',
    requestedUsdt: '120000000000000000000',
    settledCount: '1',
    settledUsdt: '90000000000000000000',
  },
};
