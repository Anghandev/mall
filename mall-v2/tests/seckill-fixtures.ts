import {
  artifactVersion,
  type RealtimeEventEnvelope,
} from '@abu24k/core-artifacts';
import type { PublishedSeckillSessionProjection } from '../src/core-client';
import { product } from './payment-fixtures';

export const seckillSessionId = `0x${'9'.repeat(64)}`;
export const seckillBuyer = `0x${'1'.repeat(40)}`;
export const seckillGovernanceActionId = `0x${'a'.repeat(64)}`;
export const seckillRulesContentHash = `0x${'b'.repeat(64)}`;
export const seckillPublicationTxHash = `0x${'c'.repeat(64)}`;

export function seckillSession(
  overrides: Partial<PublishedSeckillSessionProjection> = {},
): PublishedSeckillSessionProjection {
  return {
    artifactVersion,
    sessionId: seckillSessionId,
    policyVersion: '12',
    merchantId: 'merchant-1',
    product: {
      productId: product.productId,
      skuId: product.skus[1]!.skuId,
      title: product.title,
      metadata: {},
      attributes: product.skus[1]!.attributes,
      seckillListPriceUsdt: '80000000000000000000',
    },
    phase: 'LIVE',
    storedPhase: 'LIVE',
    serverTime: '2033-05-18T05:00:00.000Z',
    startsAt: '2033-05-18T04:59:00.000Z',
    mainDeadline: '2033-05-18T05:59:00.000Z',
    relayDeadline: '2033-05-18T05:01:00.000Z',
    settlementEarliestAt: '2033-05-18T05:06:00.000Z',
    settlementDeadline: '2033-05-18T05:11:00.000Z',
    timers: {
      mainDurationSeconds: 3_600,
      relayInitialSeconds: 60,
      relayIncrementSeconds: 30,
      relayCapSeconds: 60,
    },
    inventory: { total: '100', sold: '31', reserved: '2', available: '67' },
    prizePoolUsdt: '240000000000000000000',
    lastBuyerWallet: seckillBuyer,
    winnerWallet: null,
    snapshot: { rulesContentHash: seckillRulesContentHash },
    governanceActionId: seckillGovernanceActionId,
    rulesContentHash: seckillRulesContentHash,
    publicationTxHash: seckillPublicationTxHash,
    allowedActions: [],
    ...overrides,
  };
}

export function relayEvent(cursor = '1', eventId = `relay:${cursor}`): RealtimeEventEnvelope {
  return {
    artifactVersion,
    protocolVersion: 1,
    eventId,
    channel: `seckill:${seckillSessionId}`,
    cursor,
    eventType: 'SeckillRelayExtended',
    resourceType: 'SECKILL_SESSION',
    resourceId: seckillSessionId,
    occurredAt: '2033-05-18T05:00:15.000Z',
    finality: 'FINAL',
    payload: {
      orderId: `0x${'2'.repeat(64)}`,
      buyerWallet: seckillBuyer,
      transactionHash: `0x${'3'.repeat(64)}`,
      blockNumber: '32000000',
      blockHash: `0x${'4'.repeat(64)}`,
      paymentEventKey: `payment:${cursor}`,
      previousRelayDeadline: '2033-05-18T05:00:30.000Z',
      relayDeadline: '2033-05-18T05:01:00.000Z',
      extensionSeconds: 30,
    },
  };
}
