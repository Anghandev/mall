import type { AllowedAction, AllowedActionName, BreakerScope, OrderState, UserRole } from './enums.ts';

export interface OrderProjection {
  state: OrderState;
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  buyerWallet: string;
  merchantWallet: string;
  deliveredAt?: Date;
  paidAt?: Date;
  shipmentEvidence: boolean;
  takeoverOpened: boolean;
  pendingMethod?: 'CUSTOMER_RECEIPT' | 'PICKUP_VERIFICATION' | 'FORCED_RECEIPT' | 'ARBITRATION';
}

export interface ActionContext {
  actorWallet: string;
  roles: readonly UserRole[];
  now: Date;
  pausedScopes: ReadonlySet<BreakerScope>;
  executableActions: ReadonlySet<AllowedActionName>;
}

export function orderAllowedActions(order: OrderProjection, context: ActionContext): AllowedAction[] {
  const actions: AllowedAction[] = [];
  const actor = context.actorWallet.toLowerCase();
  const buyer = order.buyerWallet.toLowerCase();
  const merchant = order.merchantWallet.toLowerCase();
  const operator = context.roles.includes('OPERATOR') || context.roles.includes('ADMIN');
  const buyerActor = actor === buyer && context.roles.includes('BUYER');
  const merchantActor = actor === merchant && context.roles.includes('MERCHANT');

  if (order.state === 'QUOTED' && buyerActor) {
    actions.push(action('PAY_ORDER', !context.pausedScopes.has('NEW_PAYMENT'), 'BreakerActive'));
  }
  if (order.state === 'PAID' && order.fulfillmentMode === 'DELIVERY' && (operator || merchantActor)) {
    actions.push({ action: 'RECORD_SHIPMENT', enabled: true });
  }
  if (order.state === 'PAID' && order.fulfillmentMode === 'PICKUP' && operator) {
    actions.push({ action: 'VERIFY_PICKUP', enabled: true });
  }
  if (order.state === 'PAID' && order.fulfillmentMode === 'PICKUP' && buyerActor) {
    actions.push({ action: 'OPEN_TAKEOVER', enabled: false, reasonCode: 'PickupTakeoverDecisionBlocked' });
  }
  if (order.state === 'SHIPPED' && operator) actions.push({ action: 'RECORD_DELIVERY', enabled: true });
  if (order.state === 'DELIVERED' && buyerActor) actions.push({ action: 'CONFIRM_RECEIPT', enabled: true });
  if (order.state === 'DELIVERED' && merchantActor && order.deliveredAt) {
    const deadline = new Date(order.deliveredAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    actions.push(
      context.now >= deadline
        ? { action: 'REQUEST_FORCED_RECEIPT', enabled: true, deadline: deadline.toISOString() }
        : {
            action: 'REQUEST_FORCED_RECEIPT',
            enabled: false,
            reasonCode: 'FinalityPending',
            deadline: deadline.toISOString(),
          },
    );
  }
  if (
    ['SHIPPED', 'DELIVERED', 'TAKEOVER', 'FULFILLMENT_PENDING'].includes(order.state) &&
    !(order.state === 'FULFILLMENT_PENDING' && order.pendingMethod === 'ARBITRATION') &&
    buyerActor
  ) {
    actions.push({ action: 'OPEN_ARBITRATION', enabled: true });
  }
  if (
    order.state === 'PAID' &&
    order.fulfillmentMode === 'DELIVERY' &&
    order.paidAt &&
    !order.shipmentEvidence &&
    buyerActor
  ) {
    const deadline = new Date(order.paidAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    actions.push(
      context.now >= deadline
        ? { action: 'OPEN_TAKEOVER', enabled: true, deadline: deadline.toISOString() }
        : {
            action: 'OPEN_TAKEOVER',
            enabled: false,
            reasonCode: 'FinalityPending',
            deadline: deadline.toISOString(),
          },
    );
  }
  if (operator) actions.push({ action: 'RECONCILE', enabled: true });
  return actions.map((item) =>
    item.enabled && !context.executableActions.has(item.action)
      ? { ...item, enabled: false, reasonCode: 'ConfigurationRequired' }
      : item,
  );
}

export function settlementRequestAllowedAction(
  rail: 'MERCHANT_USDT' | 'REWARD_NPL' | 'PRIZE_USDT',
  amountAvailable: bigint,
  frozen: boolean,
): AllowedAction {
  const actionName = {
    MERCHANT_USDT: 'REQUEST_MERCHANT_SETTLEMENT',
    REWARD_NPL: 'REQUEST_REWARD_SETTLEMENT',
    PRIZE_USDT: 'REQUEST_PRIZE_SETTLEMENT',
  } as const;
  if (amountAvailable === 0n) return { action: actionName[rail], enabled: false, reasonCode: 'FinalityPending' };
  if (frozen && rail !== 'PRIZE_USDT') return { action: actionName[rail], enabled: false, reasonCode: 'MerchantFrozen' };
  return { action: actionName[rail], enabled: true };
}

function action(
  name: AllowedAction['action'],
  enabled: boolean,
  disabledReason: NonNullable<AllowedAction['reasonCode']>,
): AllowedAction {
  return enabled ? { action: name, enabled } : { action: name, enabled, reasonCode: disabledReason };
}
