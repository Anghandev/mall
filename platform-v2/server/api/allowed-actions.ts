import type {
  AllowedAction,
  AllowedActionName,
  BreakerScope,
  OrderFinalityStatus,
  OrderState,
  UserRole,
} from './enums.ts';

export interface OrderProjection {
  state: OrderState;
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  buyerWallet: string;
  merchantId: string;
  merchantWallet: string;
  replacementMerchantId?: string;
  replacementMerchantWallet?: string;
  takeoverFunded?: boolean;
  deliveredAt?: Date;
  paidAt?: Date;
  shipmentEvidence: boolean;
  takeoverOpened: boolean;
  pendingMethod?: 'CUSTOMER_RECEIPT' | 'PICKUP_VERIFICATION' | 'FORCED_RECEIPT' | 'ARBITRATION';
  paymentFinalityStatus?: OrderFinalityStatus;
  openRequestTypes?: readonly ('EXCHANGE' | 'DELAY' | 'ARBITRATION' | 'FORCED_RECEIPT')[];
  activePickupCredential?: boolean;
  approvedExchange?: boolean;
}

export interface ActionContext {
  actorWallet: string;
  actorMerchantId?: string;
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
  const merchantActor = context.roles.includes('MERCHANT')
    && (actor === merchant || context.actorMerchantId === order.merchantId);
  const replacementMerchantActor = context.roles.includes('MERCHANT')
    && order.replacementMerchantId !== undefined
    && order.replacementMerchantWallet !== undefined
    && (
      actor === order.replacementMerchantWallet.toLowerCase()
      || context.actorMerchantId === order.replacementMerchantId
    );
  const fulfillmentFinal = order.paymentFinalityStatus === undefined || order.paymentFinalityStatus === 'FINAL';

  if (order.state === 'QUOTED' && buyerActor) {
    actions.push(action('PAY_ORDER', !context.pausedScopes.has('NEW_PAYMENT'), 'BreakerActive'));
  }
  if (
    order.fulfillmentMode === 'DELIVERY'
    && (operator || merchantActor)
    && (
      order.state === 'PAID'
      || (
        order.state === 'TAKEOVER'
        && (operator || (replacementMerchantActor && order.takeoverFunded === true))
      )
      || (['SHIPPED', 'DELIVERED'].includes(order.state) && order.approvedExchange)
    )
  ) {
    actions.push(action('RECORD_SHIPMENT', fulfillmentFinal, 'FinalityPending'));
  }
  if (order.state === 'PAID' && order.fulfillmentMode === 'PICKUP' && (operator || merchantActor)) {
    actions.push(action('VERIFY_PICKUP', fulfillmentFinal, 'FinalityPending'));
  }
  if (
    order.state === 'PAID'
    && order.fulfillmentMode === 'PICKUP'
    && buyerActor
    && !order.activePickupCredential
  ) {
    actions.push(action('REGISTER_PICKUP_CREDENTIAL', fulfillmentFinal, 'FinalityPending'));
    actions.push({ action: 'OPEN_TAKEOVER', enabled: false, reasonCode: 'PickupTakeoverDecisionBlocked' });
  }
  if (order.state === 'SHIPPED' && operator) {
    actions.push(action('RECORD_DELIVERY', fulfillmentFinal, 'FinalityPending'));
  }
  if (order.state === 'DELIVERED' && buyerActor) {
    actions.push(action('CONFIRM_RECEIPT', fulfillmentFinal, 'FinalityPending'));
  }
  if (
    order.state === 'DELIVERED'
    && merchantActor
    && order.deliveredAt
    && !order.openRequestTypes?.includes('FORCED_RECEIPT')
  ) {
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
  if (['PAID', 'SHIPPED', 'DELIVERED'].includes(order.state) && buyerActor) {
    if (!order.openRequestTypes?.includes('EXCHANGE')) {
      actions.push(action('REQUEST_EXCHANGE', fulfillmentFinal, 'FinalityPending'));
    }
    if (!order.openRequestTypes?.includes('DELAY')) {
      actions.push(action('REQUEST_DELAY', fulfillmentFinal, 'FinalityPending'));
    }
  }
  if (
    order.openRequestTypes?.some((type) => type === 'EXCHANGE' || type === 'DELAY')
    && ['PAID', 'SHIPPED', 'DELIVERED'].includes(order.state)
    && (merchantActor || operator)
  ) {
    actions.push(action('DECIDE_FULFILLMENT_REQUEST', fulfillmentFinal, 'FinalityPending'));
  }
  if (
    ['SHIPPED', 'DELIVERED', 'TAKEOVER', 'FULFILLMENT_PENDING'].includes(order.state) &&
    !(order.state === 'FULFILLMENT_PENDING' && order.pendingMethod === 'ARBITRATION') &&
    (buyerActor || operator)
  ) {
    actions.push(action('OPEN_ARBITRATION', fulfillmentFinal, 'FinalityPending'));
  }
  if (order.state === 'ARBITRATION' && (context.roles.includes('ARBITRATOR') || context.roles.includes('ADMIN'))) {
    actions.push({ action: 'DECIDE_ARBITRATION', enabled: true });
  }
  if (order.state === 'DELIVERED' && operator && order.openRequestTypes?.includes('FORCED_RECEIPT')) {
    actions.push({ action: 'DECIDE_FORCED_RECEIPT', enabled: true });
  }
  if (
    order.state === 'PAID' &&
    order.fulfillmentMode === 'DELIVERY' &&
    order.paidAt &&
    !order.shipmentEvidence &&
    !order.takeoverOpened &&
    (buyerActor || operator)
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
