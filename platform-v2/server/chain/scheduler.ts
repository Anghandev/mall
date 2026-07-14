import { CoreError } from '../api/errors.ts';
import { evaluateForcedReceipt, evaluateTakeover, type FulfillmentProjection } from '../api/fulfillment.ts';

export interface ScheduledJob {
  jobType: 'OPEN_TAKEOVER' | 'FORCED_RECEIPT_ELIGIBILITY';
  resourceId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export function scheduleFulfillmentJobs(orders: FulfillmentProjection[], now: Date) {
  const jobs: ScheduledJob[] = [];
  const blocked: Array<{ orderId: string; code: string }> = [];
  for (const order of orders) {
    if (order.state === 'PAID') {
      try {
        const result = evaluateTakeover(order, now);
        jobs.push({
          jobType: 'OPEN_TAKEOVER',
          resourceId: order.orderId,
          idempotencyKey: `open-takeover:${order.orderId}`,
          payload: result,
        });
      } catch (error) {
        if (error instanceof CoreError && error.code === 'PickupTakeoverDecisionBlocked') {
          blocked.push({ orderId: order.orderId, code: error.code });
        } else if (!(error instanceof CoreError && error.code === 'FinalityPending')) {
          throw error;
        }
      }
    }
    if (order.state === 'DELIVERED') {
      try {
        const result = evaluateForcedReceipt(order, 'MERCHANT', now);
        jobs.push({
          jobType: 'FORCED_RECEIPT_ELIGIBILITY',
          resourceId: order.orderId,
          idempotencyKey: `forced-receipt-eligibility:${order.orderId}`,
          payload: result,
        });
      } catch (error) {
        if (!(error instanceof CoreError && error.code === 'FinalityPending')) throw error;
      }
    }
  }
  return { jobs, blocked };
}
