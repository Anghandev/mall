import { CoreError } from './errors.ts';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface FulfillmentProjection {
  orderId: string;
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  state: 'PAID' | 'SHIPPED' | 'DELIVERED' | 'ARBITRATION' | 'TAKEOVER' | 'FULFILLMENT_PENDING' | 'FULFILLED';
  paidAt: Date;
  shippedAt?: Date;
  deliveredAt?: Date;
  shipmentEvidenceHash?: string;
  takeoverOpened: boolean;
}

export function evaluateTakeover(order: FulfillmentProjection, now: Date) {
  if (order.fulfillmentMode === 'PICKUP') {
    throw new CoreError(
      'PickupTakeoverDecisionBlocked',
      'Pickup timeout evidence is not defined by the frozen policy',
      409,
      { orderId: order.orderId },
    );
  }
  if (order.state !== 'PAID' || order.shipmentEvidenceHash || now.getTime() < order.paidAt.getTime() + SEVEN_DAYS_MS) {
    throw new CoreError('FinalityPending', 'Delivery takeover is not eligible', 409, { orderId: order.orderId });
  }
  return {
    orderId: order.orderId,
    action: 'OPEN_TAKEOVER' as const,
    evidenceRequired: true,
    customerFundsRemainLocked: true,
  };
}

export function evaluateForcedReceipt(order: FulfillmentProjection, actor: 'MERCHANT' | 'PLATFORM', now: Date) {
  if (actor !== 'MERCHANT' || order.state !== 'DELIVERED' || !order.deliveredAt) {
    throw new CoreError('Forbidden', 'Only the merchant can request review after delivery', 403);
  }
  const eligibleAt = new Date(order.deliveredAt.getTime() + SEVEN_DAYS_MS);
  if (now < eligibleAt) throw new CoreError('FinalityPending', 'Forced receipt review is not yet eligible', 409, { eligibleAt });
  return {
    orderId: order.orderId,
    action: 'REQUEST_FORCED_RECEIPT' as const,
    platformReviewRequired: true,
    canFinalizeDirectly: false,
  };
}

export function assertEmptySessionPrizeDecision(winner: string | undefined, prizePoolUsdt: bigint) {
  if (!winner && prizePoolUsdt > 0n) {
    throw new CoreError(
      'EmptySessionPrizeDecisionBlocked',
      'Injected prize in an empty session remains Locked',
      409,
    );
  }
}
