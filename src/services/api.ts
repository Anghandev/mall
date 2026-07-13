import { API_BASE_URL } from '../config/web3';
import type { AddressBookEntry, AssetSummary, AssetSymbol, CartItem, ClaimRecord, MessageItem, Order, Product, RewardLedgerEntry, SeckillFeedItem, SeckillSession, Store } from '../types';

export type CreateOrderInput = {
  buyerAddress: string;
  items: CartItem[];
  idempotencyKey?: string;
};

export type CheckoutIntentInput = {
  buyerAddress: string;
  idempotencyKey: string;
  items: CartItem[];
};

export type WalletTransaction = {
  key: string;
  from?: string;
  to: string;
  value: string;
  data: string;
};

export type AllowanceCheck = {
  key: 'npl';
  symbol: 'NPL';
  tokenAddress: string;
  owner: string;
  spender: string;
  requiredAmount: string;
  requiredAmountWei: string;
  to: string;
  data: string;
};

export type ApprovalTransaction = WalletTransaction & {
  key: 'npl';
  symbol: 'NPL';
  spender: string;
  amount: 'MaxUint256';
  amountWei: string;
};

export type PaymentIntent = {
  chainId: number;
  chainIdHex: string;
  approvalPolicy: {
    type: 'unlimited-npl';
    allowanceSkip: true;
    amount: 'MaxUint256';
  };
  allowanceChecks: AllowanceCheck[];
  approvalTransactions: ApprovalTransaction[];
  payOrderTransaction: WalletTransaction & {
    key: 'payOrder';
    deadline: number;
    deadlineSeconds: number;
    orderDigest: string;
    productId: string;
    bnmLockedWei: string;
    splitVersion: number;
    authorization: string;
    authorizationDigest: string;
    orderSigner: string;
  };
  submitFundingEndpoint: string;
  fundingStatusEndpoint: string;
};

export type StockPreflightLine = {
  productId: string;
  skuId?: string | null;
  skuName?: string;
  title?: string;
  quantity?: number;
  availableStock?: number;
  ok: boolean;
  reason?: string;
  fulfillmentMode?: 'delivery' | 'pickup';
  addressId?: string | null;
  storeId?: string | null;
  regionCode?: string;
};

export type StockPreflightResponse = {
  ok: boolean;
  lines: StockPreflightLine[];
  quote: {
    amountNpl: string;
    bnmLocked: string;
    chainId: number;
    approval: { type: 'unlimited-npl'; allowanceSkip: true; amount: 'MaxUint256' };
  };
  checkedAt: string;
};

export type FinalCheckResponse = {
  ok: boolean;
  error?: string;
  version: '24k-dapp-final-check-v1';
  checkedAt: string;
  title: string;
  summary: Record<string, unknown>;
  factors: Array<{ key: string; label: string; value: string; detail?: unknown }>;
  preflight: StockPreflightResponse;
  nextAction: {
    method: 'POST';
    endpoint: '/api/dapp/checkout-intent';
    body: CheckoutIntentInput;
    walletFlow: string[];
  } | null;
};

export type CheckoutIntentResponse = {
  ok: true;
  preflight: StockPreflightResponse;
  finalCheck: { required?: string[]; passed?: boolean };
  order: Order;
  paymentIntent: PaymentIntent | null;
  nextActions: string[];
  endpoints: Record<string, string>;
};

export type SeckillIntentResponse = CheckoutIntentResponse & {
  seckill: {
    session: SeckillSession;
    contractAddress: string;
    contractCallerBlocked: true;
    recordPurchaseTransaction: (WalletTransaction & {
      key: 'recordPurchase';
      sessionId: string;
      orderId: string;
    }) | null;
    unavailableReason?: string;
  };
};

export type SeckillFeedStreamSnapshot = {
  version: '24k-seckill-feed-stream-v1';
  sessionId: string;
  generatedAt: string;
  feed: SeckillFeedItem[];
  report: {
    status?: string;
    winnerAddress?: string;
    prizePoolNpl?: number;
    totalBuys?: number;
    txHash?: string;
  } | null;
};

export type TxPollingStatus = 'pending' | 'confirming' | 'confirmed' | 'failed' | 'mismatch' | 'rpc_unavailable';

export type TxStatusResponse = {
  status: TxPollingStatus;
  retryable: boolean;
  txHash: string;
  order?: Order;
  error?: string;
};

export type AssetOrder = Order & {
  fulfillment?: Record<string, unknown>;
  confirmability?: {
    canComplete: boolean;
    reason: string;
    mode: 'delivery' | 'pickup';
    orderStatus: string;
    fulfillmentStatus: string;
  };
  releasePreview?: { bnmLocked?: string; availableIncrease?: string };
  primaryAction?: { key?: string; label?: string; enabled?: boolean };
  actions?: Record<string, unknown>;
  afterSale?: AfterSaleState | null;
};

export type AfterSaleRequestType = 'exchange' | 'delay';

export type AfterSaleRequestRecord = {
  id?: string;
  orderId: string;
  type: AfterSaleRequestType;
  status: string;
  lockState?: string;
  result?: string;
  reason?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AfterSaleState = {
  available: boolean;
  allowedTypes: AfterSaleRequestType[];
  active: boolean;
  case: AfterSaleRequestRecord | null;
  endpoint?: string;
  assetState?: string;
  transactionIntent?: AfterSaleTransactionIntent | null;
  arbitrationStatusEndpoint?: string | null;
};

export type AfterSaleTransactionIntent = WalletTransaction & {
  key: 'buyerDisputeOrder';
  chainId: number;
  orderId: string;
};

export type AfterSaleRequestResponse = {
  ok: boolean;
  request: AfterSaleRequestRecord;
  order?: AssetOrder;
  message?: string;
  transactionIntent?: AfterSaleTransactionIntent | null;
  arbitrationStatusEndpoint?: string | null;
};

export type ArbitrationTxStatusResponse = TxStatusResponse & {
  afterSale?: AfterSaleRequestRecord | null;
};

export type ShoppingRecord = {
  orderId: string;
  productId: string;
  title: string;
  skuName?: string;
  quantity: number;
  amountNpl: string;
  status: string;
  fulfillmentMode?: 'delivery' | 'pickup';
  regionCode?: string;
  createdAt?: string;
};

export type SeckillRecord = {
  sessionId: string;
  eventName: string;
  orderId?: string;
  txHash?: string;
  createdAt?: string;
  session?: { productId?: string; status?: string; prizePoolNpl?: string | number } | null;
  prizeClaim?: {
    claimable: boolean;
    status: string;
    rewardId?: string;
    assetSymbol?: 'NPL';
    amount?: number;
    note?: string;
  };
};

export type DappAssetSummary = AssetSummary & {
  orders: AssetOrder[];
  orderStateCounts: Record<string, number>;
  shoppingRecords: ShoppingRecord[];
  seckillRecords: SeckillRecord[];
  actions: Record<string, string>;
};

export type DappAssetsStateResponse = {
  version: '24k-dapp-assets-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  connectRequired: boolean;
  summary: DappAssetSummary;
  primaryAction: Record<string, unknown>;
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
};

export type ClaimIntentResponse = {
  ok: true;
  walletAddress: string;
  rewardId: string;
  bucketId: string;
  assetSymbol: AssetSymbol;
  amount: string;
  chainId: number;
  nonce: string;
  expiresAt: number;
  secondaryMessage: string;
  signatureKind: 'personal_sign';
  submit: { method: 'POST'; endpoint: '/api/claims'; body: Record<string, string> };
  claimTransaction: (WalletTransaction & { key: 'rewardLedgerClaim'; rewardId: string; entryId: string }) | null;
  unavailableReason?: string;
  nextActions: string[];
  endpoints: Record<string, string>;
};

export type ClaimTxStatusResponse = {
  status: TxPollingStatus | 'unavailable';
  retryable: boolean;
  txHash: string;
  reward?: RewardLedgerEntry;
  error?: string;
};

export type CompleteOrderIntentResponse = {
  ok: true;
  order: Order;
  confirmability: { canComplete: boolean; reason: string; mode: 'delivery' | 'pickup' };
  chainId: number;
  chainIdHex: string;
  completeOrderTransaction: (WalletTransaction & { key: 'completeOrder'; orderId: string }) | null;
  unavailableReason?: string;
  physicalDeliveryWarning: string;
};

export type AddressParseResponse = {
  ok: boolean;
  sourceText: string;
  parsed: Partial<AddressBookEntry>;
  missing: string[];
  confidence: number;
  reviewRequired: boolean;
  warning: string;
  nextAction: { method: 'POST'; endpoint: '/api/address-book'; body: Record<string, unknown> };
};

export type BuyerAuthSession = {
  token: string;
  address: string;
  role: 'buyer';
  expiresAt: number;
};

export type BuyerActionIntent = {
  action: 'buyer.address.upsert' | 'buyer.address.delete' | 'buyer.address.default' | 'buyer.timeout-refund.request' | 'buyer.after-sale.request';
  walletAddress: string;
  chainId: number;
  nonce: string;
  expiresAt: number;
  secondaryMessage: string;
  signatureKind: 'personal_sign';
};

export type AddressMutationAuth = {
  token: string;
  secondaryMessage: string;
  secondarySignature: string;
};

export type AddressWriteInput = {
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  regionCode: string;
  isDefault?: boolean;
};

export type DappStore = Omit<Store, 'distanceKm'> & {
  distanceKm?: number;
  distanceSource?: string;
  pickupContext?: {
    fulfillmentMode?: 'pickup';
    storeId?: string;
    regionCode?: string;
    checkoutItemPatch?: Pick<CartItem, 'fulfillmentMode' | 'storeId' | 'regionCode'>;
  };
  dapp?: {
    selectable?: boolean;
    checkoutItemPatch?: Pick<CartItem, 'fulfillmentMode' | 'storeId' | 'regionCode'>;
  };
  actions?: {
    call?: string;
    navigation?: { provider?: string; lat?: number; lng?: number; label?: string; query?: string };
  };
};

export type DappStoresStateResponse = {
  version: '24k-dapp-stores-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  stores: DappStore[];
  filters: { cities?: string[]; districts?: string[]; regionCodes?: string[] };
  policies: Record<string, unknown>;
};

export type CmsPlacementKind = 'banner' | 'popup' | 'faq' | 'legal' | 'update';
export type CmsPlacementFrequency = 'once' | 'daily' | 'always';

export type CmsPlacement = {
  id: string;
  kind: CmsPlacementKind;
  title: string;
  body: string;
  mediaUrl?: string;
  actionLabel?: string;
  actionUrl?: string;
  frequency: CmsPlacementFrequency;
  regionCodes: string[];
  version?: string;
  minimumAppVersion?: string;
  forceUpdate: boolean;
  publishedAt?: string;
};

export type CmsPlacementsResponse = {
  placements: CmsPlacement[];
  generatedAt?: string;
};

export async function fetchProducts(): Promise<Product[]> {
  const response = await fetch(`${API_BASE_URL}/api/products`);
  if (!response.ok) throw new Error(`商品接口不可用：HTTP ${response.status}`);
  const payload = await response.json() as unknown[];
  return payload.map(normalizeProduct);
}

export async function fetchMessages(): Promise<MessageItem[]> {
  const response = await fetch(`${API_BASE_URL}/api/messages`);
  if (!response.ok) throw new Error(`消息接口不可用：HTTP ${response.status}`);
  const payload = await response.json() as unknown[];
  return payload.map(normalizeMessage);
}

export async function fetchSeckillSession(): Promise<{ session: SeckillSession; feed: SeckillFeedItem[]; product: Product }> {
  const response = await fetch(`${API_BASE_URL}/api/seckill/current`);
  if (!response.ok) throw new Error(`秒杀接口不可用：HTTP ${response.status}`);
  const payload = await response.json() as { session?: unknown; feed?: unknown[]; product?: unknown };
  if (!payload.session || !payload.product) throw new Error('秒杀接口缺少 session 或 product。');
  return {
    session: normalizeSeckillSession(payload.session),
    feed: Array.isArray(payload.feed) ? payload.feed.map(normalizeFeed) : [],
    product: normalizeProduct(payload.product)
  };
}

export async function fetchSeckillFeed(sessionId: string): Promise<SeckillFeedItem[]> {
  const payload = await requestApi<{ feed?: unknown[] }>(
    `/api/seckill/feed${queryString({ sessionId })}`,
    undefined,
    '秒杀滚动墙接口不可用'
  );
  return Array.isArray(payload.feed) ? payload.feed.map(normalizeFeed) : [];
}

export function seckillFeedStreamUrl(sessionId: string): string {
  return `${API_BASE_URL}/api/seckill/feed/stream${queryString({ sessionId })}`;
}

export function normalizeSeckillFeedStreamSnapshot(raw: unknown): SeckillFeedStreamSnapshot {
  const row = objectRecord(raw);
  if (row.version !== '24k-seckill-feed-stream-v1' || !row.sessionId) throw new Error('秒杀实时流快照不完整。');
  const report = row.report && typeof row.report === 'object' ? objectRecord(row.report) : null;
  return {
    version: '24k-seckill-feed-stream-v1',
    sessionId: String(row.sessionId),
    generatedAt: String(row.generatedAt || ''),
    feed: arrayValue(row.feed).map(normalizeFeed),
    report: report ? {
      status: report.status ? String(report.status) : undefined,
      winnerAddress: report.winnerAddress ? String(report.winnerAddress) : undefined,
      prizePoolNpl: optionalFiniteNumber(report.prizePoolNpl),
      totalBuys: optionalFiniteNumber(report.totalBuys),
      txHash: report.txHash ? String(report.txHash) : undefined
    } : null
  };
}

export async function fetchStores(args: { lat?: number; lng?: number; city?: string; district?: string } = {}): Promise<DappStore[]> {
  const payload = await requestApi<unknown[]>(`/api/stores${queryString(args)}`, undefined, '门店接口不可用');
  if (!Array.isArray(payload)) throw new Error('门店接口返回了无效数据。');
  return payload.map(normalizeStore).filter((store) => !SERVER_SHOWCASE_STORE_IDS.has(store.id));
}

export async function fetchDappStoresState(args: { address?: string; lat?: number; lng?: number; city?: string; district?: string } = {}): Promise<DappStoresStateResponse> {
  const payload = await requestApi<Omit<DappStoresStateResponse, 'stores'>>(`/api/dapp/stores-state${queryString(args)}`, undefined, '门店状态接口不可用') as Omit<DappStoresStateResponse, 'stores'> & { stores?: unknown[] };
  if (!Array.isArray(payload.stores)) throw new Error('门店状态接口缺少 stores 数据。');
  return { ...payload, stores: payload.stores.map(normalizeStore).filter((store) => !SERVER_SHOWCASE_STORE_IDS.has(store.id)) };
}

export async function fetchAssetSummary(address: string, token: string): Promise<AssetSummary> {
  const query = address ? `?address=${encodeURIComponent(address)}` : '';
  const response = await fetch(`${API_BASE_URL}/api/assets/summary${query}`, authenticatedGet(token));
  if (!response.ok) throw new Error(`资产接口不可用：HTTP ${response.status}`);
  const payload = await response.json() as Partial<AssetSummary>;
  return {
    address: typeof payload.address === 'string' ? payload.address : address,
    addresses: Array.isArray(payload.addresses) ? payload.addresses.map(normalizeAddress) : [],
    buckets: Array.isArray(payload.buckets) ? payload.buckets.map(normalizeBucket) : [],
    ledger: Array.isArray(payload.ledger) ? payload.ledger.map(normalizeLedger) : [],
    claims: Array.isArray(payload.claims) ? payload.claims.map(normalizeClaim) : []
  };
}

export async function fetchDappAssetsState(address: string, token: string): Promise<DappAssetsStateResponse> {
  const payload = await requestApi<Omit<DappAssetsStateResponse, 'summary'>>(
    `/api/dapp/assets-state?address=${encodeURIComponent(address)}`,
    authenticatedGet(token),
    '资产状态接口不可用'
  ) as Omit<DappAssetsStateResponse, 'summary'> & { summary?: unknown };
  if (!payload.summary || typeof payload.summary !== 'object') throw new Error('资产状态接口缺少 summary 数据。');
  return { ...payload, summary: normalizeDappAssetSummary(payload.summary, address) };
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const response = await fetch(`${API_BASE_URL}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...input,
      idempotencyKey: input.idempotencyKey || orderIdempotencyKey(input)
    })
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) detail = payload.error;
    } catch {}
    throw new Error(`创建订单失败：${detail}`);
  }

  return response.json() as Promise<Order>;
}

export async function getOrder(idOrOrderId: string, buyerAddress: string, token: string): Promise<Order> {
  const buyerQuery = buyerAddress ? `?buyerAddress=${encodeURIComponent(buyerAddress)}` : '';
  const response = await fetch(`${API_BASE_URL}/api/orders/${encodeURIComponent(idOrOrderId)}${buyerQuery}`, authenticatedGet(token));
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) detail = payload.error;
    } catch {}
    throw new Error(`刷新订单失败：${detail}`);
  }
  return response.json() as Promise<Order>;
}

export async function submitFundTx(idOrOrderId: string, buyerAddress: string, txHash: string, token: string): Promise<Order> {
  const response = await fetch(`${API_BASE_URL}/api/orders/${encodeURIComponent(idOrOrderId)}/fund-tx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ buyerAddress, txHash })
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) detail = payload.error;
    } catch {}
    throw new Error(`提交付款交易失败：${detail}`);
  }
  return response.json() as Promise<Order>;
}

export async function runStockPreflight(input: CheckoutIntentInput, token: string): Promise<StockPreflightResponse> {
  return requestApi('/api/stock/preflight', authenticatedJson('POST', token, input), '库存复核失败');
}

export async function createFinalCheck(input: CheckoutIntentInput, token: string): Promise<FinalCheckResponse> {
  return requestApi('/api/dapp/final-check', authenticatedJson('POST', token, input), '付前终核失败');
}

export async function createCheckoutIntent(input: CheckoutIntentInput, token: string): Promise<CheckoutIntentResponse> {
  return requestApi('/api/dapp/checkout-intent', authenticatedJson('POST', token, input), '创建支付意图失败');
}

export async function createSeckillIntent(input: CheckoutIntentInput, token: string): Promise<SeckillIntentResponse> {
  return requestApi('/api/dapp/seckill-intent', authenticatedJson('POST', token, input), '创建秒杀支付意图失败');
}

export async function fetchFundingTxStatus(orderId: string, buyerAddress: string, txHash: string, token: string): Promise<TxStatusResponse> {
  return requestApi(
    `/api/orders/${encodeURIComponent(orderId)}/fund-tx-status${queryString({ buyerAddress, txHash })}`,
    authenticatedGet(token),
    '付款交易状态查询失败'
  );
}

export async function createClaimIntent(input: { walletAddress: string; bucketId: string; rewardId: string }, token: string): Promise<ClaimIntentResponse> {
  return requestApi('/api/dapp/claim-intent', authenticatedJson('POST', token, input), 'Claim intent 创建失败');
}

export async function submitClaimRequest(intent: ClaimIntentResponse, secondarySignature: string, token: string): Promise<ClaimRecord> {
  return requestApi(intent.submit.endpoint, authenticatedJson('POST', token, { ...intent.submit.body, secondarySignature }), 'Claim 请求提交失败');
}

export async function fetchClaimTxStatus(walletAddress: string, rewardId: string, txHash: string, token: string): Promise<ClaimTxStatusResponse> {
  return requestApi(
    `/api/dapp/claim-tx-status${queryString({ walletAddress, rewardId, txHash })}`,
    authenticatedGet(token),
    'Claim 交易状态查询失败'
  );
}

export async function createCompleteOrderIntent(buyerAddress: string, orderId: string, token: string): Promise<CompleteOrderIntentResponse> {
  return requestApi('/api/dapp/complete-order-intent', authenticatedJson('POST', token, { buyerAddress, orderId }), '确认收货 intent 创建失败');
}

export async function requestAfterSale(input: { buyerAddress: string; orderId: string; type: AfterSaleRequestType; reason: string }, auth: AddressMutationAuth): Promise<AfterSaleRequestResponse> {
  const payload = await requestApi<Record<string, unknown>>(
    '/api/dapp/after-sale/request',
    authenticatedJson('POST', auth.token, { ...input, secondaryMessage: auth.secondaryMessage, secondarySignature: auth.secondarySignature }),
    '售后申请提交失败'
  );
  const rawRequest = payload.request || payload.case || payload.afterSale || payload.data || payload;
  const request = normalizeAfterSaleRequest(rawRequest, input);
  return {
    ok: payload.ok !== false,
    request: { ...request, lockState: request.lockState || optionalText(payload.assetState) },
    order: payload.order && typeof payload.order === 'object' ? normalizeAssetOrder(payload.order) : undefined,
    message: optionalText(payload.message) || optionalText(payload.next),
    transactionIntent: normalizeAfterSaleTransactionIntent(payload.transactionIntent, input),
    arbitrationStatusEndpoint: optionalText(payload.arbitrationStatusEndpoint)
  };
}

export async function fetchArbitrationTxStatus(orderId: string, buyerAddress: string, txHash: string, token: string): Promise<ArbitrationTxStatusResponse> {
  const payload = await requestApi<Record<string, unknown>>(
    `/api/orders/${encodeURIComponent(orderId)}/arbitration-tx-status${queryString({ buyerAddress, txHash })}`,
    authenticatedGet(token),
    '仲裁交易状态查询失败'
  );
  return {
    ...(payload as TxStatusResponse),
    afterSale: payload.afterSale && typeof payload.afterSale === 'object'
      ? normalizeAfterSaleRequest(payload.afterSale, { orderId, type: 'exchange' })
      : null
  };
}

export async function fetchCompleteTxStatus(orderId: string, buyerAddress: string, txHash: string, token: string): Promise<TxStatusResponse> {
  return requestApi(
    `/api/orders/${encodeURIComponent(orderId)}/complete-tx-status${queryString({ buyerAddress, txHash })}`,
    authenticatedGet(token),
    '确认收货交易状态查询失败'
  );
}

export async function requestTimeoutRefund(buyerAddress: string, orderId: string, auth: AddressMutationAuth) {
  return requestApi<{ ok: true; status: 'RefundRequested'; next?: string }>(
    '/api/dapp/timeout-refund-request',
    authenticatedJson('POST', auth.token, { buyerAddress, orderId, reason: '7 天未发货', secondaryMessage: auth.secondaryMessage, secondarySignature: auth.secondarySignature }),
    '7 天未发货强制退款申请失败'
  );
}

export async function parseAddressText(walletAddress: string, text: string): Promise<AddressParseResponse> {
  return requestApi('/api/address-book/parse', jsonPost({ walletAddress, text }), '地址解析失败');
}

export async function createBuyerSiweNonce(address: string) {
  return requestApi<{ nonce: string; message: string; role: 'buyer'; address: string; expiresAt: number }>(
    '/api/auth/siwe/nonce',
    jsonPost({ address, role: 'buyer' }),
    'Buyer SIWE 登录消息创建失败'
  );
}

export async function verifyBuyerSiwe(address: string, message: string, signature: string): Promise<BuyerAuthSession> {
  return requestApi(
    '/api/auth/siwe/verify',
    jsonPost({ address, role: 'buyer', message, signature }),
    'Buyer SIWE 登录失败'
  );
}

export async function createBuyerActionIntent(token: string, action: BuyerActionIntent['action'], payload: Record<string, unknown>): Promise<BuyerActionIntent> {
  return requestApi(
    '/api/auth/action-intent',
    authenticatedJson('POST', token, { action, payload }),
    'Buyer 操作授权消息创建失败'
  );
}

export async function saveAddress(input: AddressWriteInput, auth: AddressMutationAuth): Promise<AddressBookEntry> {
  const payload = await requestApi<unknown>('/api/address-book', authenticatedJson('POST', auth.token, { ...input, secondaryMessage: auth.secondaryMessage, secondarySignature: auth.secondarySignature }), '地址保存失败');
  return normalizeAddress(payload);
}

export async function updateAddress(id: string, input: AddressWriteInput, auth: AddressMutationAuth): Promise<AddressBookEntry> {
  const payload = await requestApi<unknown>(`/api/address-book/${encodeURIComponent(id)}`, authenticatedJson('PATCH', auth.token, { ...input, id, secondaryMessage: auth.secondaryMessage, secondarySignature: auth.secondarySignature }), '地址修改失败');
  return normalizeAddress(payload);
}

export async function deleteAddress(id: string, auth: AddressMutationAuth): Promise<{ id: string; deleted: true }> {
  return requestApi(`/api/address-book/${encodeURIComponent(id)}`, authenticatedJson('DELETE', auth.token, { id, secondaryMessage: auth.secondaryMessage, secondarySignature: auth.secondarySignature }), '地址删除失败');
}

export async function setDefaultAddress(id: string, auth: AddressMutationAuth): Promise<AddressBookEntry> {
  const payload = await requestApi<unknown>(`/api/address-book/${encodeURIComponent(id)}/default`, authenticatedJson('POST', auth.token, { id, secondaryMessage: auth.secondaryMessage, secondarySignature: auth.secondarySignature }), '默认地址设置失败');
  return normalizeAddress(payload);
}

export async function fetchCmsPlacements(args: { regionCode?: string; appVersion: string }): Promise<CmsPlacementsResponse> {
  const payload = await requestApi<unknown>(
    `/api/cms/placements${queryString(args)}`,
    undefined,
    'CMS 内容接口不可用'
  );
  const row = objectRecord(payload);
  const source = row.placements ?? row.items ?? payload;
  return {
    placements: flattenCmsPlacements(source).map(([kind, entry], index) => normalizeCmsPlacement(entry, kind, index)).filter((entry): entry is CmsPlacement => entry !== null),
    generatedAt: row.generatedAt ? String(row.generatedAt) : undefined
  };
}

function orderIdempotencyKey(input: CreateOrderInput) {
  const selected = input.items
    .filter((item) => item.selected && item.quantity > 0)
    .map((item) => `${item.productId}:${item.quantity}`)
    .sort()
    .join('|');
  return `${input.buyerAddress.toLowerCase()}:${selected}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function normalizeProduct(raw: unknown): Product {
  const row = raw as Partial<Product> & Record<string, unknown>;
  const id = String(row.id || '');
  if (!id || !row.title || !isShopBadge(row.shopBadge) || !isImageTone(row.imageTone) || !isCategory(row.category)) {
    throw new Error('商品数据缺少 id/title 或包含未知的 UI 枚举。');
  }
  return {
    id,
    shopName: String(row.shopName || row.shop_name || ''),
    shopBadge: row.shopBadge,
    title: String(row.title),
    sku: String(row.sku || ''),
    skus: Array.isArray(row.skus) ? row.skus.map(normalizeSku) : [],
    imageUrl: String(row.imageUrl || row.image_url || ''),
    imageTone: row.imageTone,
    category: row.category,
    summary: String(row.summary || ''),
    priceNpl: finiteNumberOrZero(row.priceNpl ?? row.price_npl),
    originalPriceNpl: row.originalPriceNpl === undefined ? undefined : finiteNumberOrZero(row.originalPriceNpl),
    bnmRebateRate: finiteNumberOrZero(row.bnmRebateRate),
    seckillLocked: Boolean(row.seckillLocked),
    fulfillmentModes: Array.isArray(row.fulfillmentModes) ? row.fulfillmentModes.filter(isFulfillmentMode) : [],
    adminRegionCode: row.adminRegionCode ? String(row.adminRegionCode) : undefined,
    stock: finiteNumberOrZero(row.stock),
    sellerAddress: String(row.sellerAddress || row.seller_address || '') as `0x${string}`,
    tags: Array.isArray(row.tags) ? row.tags.map(String) : []
  };
}

function normalizeSku(raw: unknown) {
  const row = raw as Record<string, unknown>;
  const id = String(row.id || '');
  if (!id) throw new Error('SKU 数据缺少 id。');
  return {
    id,
    name: String(row.name || ''),
    settlementPriceNpl: finiteNumberOrZero(row.settlementPriceNpl),
    stock: finiteNumberOrZero(row.stock)
  };
}

function normalizeMessage(raw: unknown): MessageItem {
  const row = raw as Partial<MessageItem> & Record<string, unknown>;
  const id = String(row.id || '');
  if (!id || !row.title || !isMessageTone(row.tone)) throw new Error('消息数据缺少 id/title 或 tone 无效。');
  return {
    id,
    title: String(row.title),
    preview: String(row.preview || ''),
    date: String(row.date || row.date_label || ''),
    unread: row.unread === undefined ? undefined : finiteNumberOrZero(row.unread),
    tone: row.tone
  };
}

function normalizeSeckillSession(raw: unknown): SeckillSession {
  const row = raw as Partial<SeckillSession> & { winner?: unknown };
  const rawStatus = String((raw as Record<string, unknown>).status || '');
  const status = rawStatus === 'scheduled' ? 'upcoming' : rawStatus === 'forceClosed' ? 'settling' : rawStatus;
  if (!row.id || !row.productId || !isSeckillStatus(status) || !row.startsAt || !row.endsAt) {
    throw new Error('秒杀场次数据不完整。');
  }
  return {
    id: String(row.id),
    productId: String(row.productId),
    status,
    startsAt: String(row.startsAt),
    endsAt: String(row.endsAt),
    mainSecondsLeft: finiteNumberOrZero(row.mainSecondsLeft),
    relaySecondsLeft: finiteNumberOrZero(row.relaySecondsLeft),
    relayExtendSeconds: finiteNumberOrZero(row.relayExtendSeconds),
    prizePoolNpl: finiteNumberOrZero(row.prizePoolNpl),
    totalBuys: finiteNumberOrZero(row.totalBuys),
    winnerAddress: row.winnerAddress ? String(row.winnerAddress) : row.winner ? String(row.winner) : undefined,
    ruleVersion: String(row.ruleVersion || '')
  };
}

function normalizeFeed(raw: unknown): SeckillFeedItem {
  const row = raw as Partial<SeckillFeedItem>;
  if (!row.id || !row.address || !row.text || !row.createdAt) throw new Error('秒杀流数据不完整。');
  return {
    id: String(row.id),
    address: String(row.address),
    text: String(row.text),
    createdAt: String(row.createdAt),
    sessionId: row.sessionId ? String(row.sessionId) : undefined,
    buyerAddress: row.buyerAddress ? String(row.buyerAddress) : undefined,
    orderId: row.orderId ? String(row.orderId) : undefined,
    txHash: row.txHash ? String(row.txHash) : undefined,
    totalBuys: row.totalBuys === undefined ? undefined : finiteNumberOrZero(row.totalBuys)
  };
}

function normalizeStore(raw: unknown): DappStore {
  const row = raw as Partial<DappStore> & Record<string, unknown>;
  const id = String(row.id || '');
  const name = String(row.name || '');
  if (!id || !name) throw new Error('门店数据缺少 id 或 name。');
  const distanceKm = optionalFiniteNumber(row.distanceKm);
  return {
    id,
    name,
    merchantAddress: row.merchantAddress ? String(row.merchantAddress) : undefined,
    country: String(row.country || ''),
    city: String(row.city || ''),
    district: String(row.district || ''),
    regionCode: String(row.regionCode || ''),
    address: String(row.address || ''),
    hours: String(row.hours || ''),
    phone: String(row.phone || ''),
    lat: optionalFiniteNumber(row.lat) ?? Number.NaN,
    lng: optionalFiniteNumber(row.lng) ?? Number.NaN,
    ...(distanceKm === undefined ? {} : { distanceKm }),
    distanceSource: row.distanceSource ? String(row.distanceSource) : undefined,
    pickupContext: row.pickupContext && typeof row.pickupContext === 'object' ? row.pickupContext as DappStore['pickupContext'] : undefined,
    dapp: row.dapp && typeof row.dapp === 'object' ? row.dapp as DappStore['dapp'] : undefined,
    actions: row.actions && typeof row.actions === 'object' ? row.actions as DappStore['actions'] : undefined
  };
}

function normalizeAddress(raw: unknown): AddressBookEntry {
  const row = raw as Partial<AddressBookEntry>;
  const id = String(row.id || '');
  if (!id) throw new Error('地址数据缺少 id。');
  return {
    id,
    name: String(row.name || ''),
    phone: String(row.phone || ''),
    province: String(row.province || ''),
    city: String(row.city || ''),
    district: String(row.district || ''),
    detail: String(row.detail || ''),
    regionCode: String(row.regionCode || ''),
    isDefault: Boolean(row.isDefault)
  };
}

function normalizeBucket(raw: unknown): AssetSummary['buckets'][number] {
  const row = raw as Partial<AssetSummary['buckets'][number]>;
  const validBucketIds = ['bnm', 'genesis-node', 'referral-shop', 'region-agent', 'ops', 'seckill-prize'];
  if (!validBucketIds.includes(String(row.id))) throw new Error(`未知资产池：${String(row.id || '缺失 id')}`);
  return {
    id: row.id as AssetSummary['buckets'][number]['id'],
    title: String(row.title || row.id),
    assetSymbol: requireAssetSymbol(row.assetSymbol, 'asset bucket'),
    cumulative: finiteNumberOrZero(row.cumulative),
    available: finiteNumberOrZero(row.available),
    locked: finiteNumberOrZero(row.locked),
    claimed: row.claimed === undefined ? undefined : finiteNumberOrZero(row.claimed),
    burned: row.burned === undefined ? undefined : finiteNumberOrZero(row.burned),
    pendingClaim: row.pendingClaim === undefined ? undefined : finiteNumberOrZero(row.pendingClaim),
    visible: Boolean(row.visible),
    docsKey: row.docsKey ? String(row.docsKey) : undefined,
    claimable: Boolean(row.claimable),
    claimEndpoint: row.claimEndpoint ? String(row.claimEndpoint) : undefined,
    unlockPolicy: row.unlockPolicy ? String(row.unlockPolicy) : undefined,
    visibility: row.visibility,
    stateSummary: row.stateSummary
  };
}

function normalizeLedger(raw: unknown): RewardLedgerEntry {
  const row = raw as Partial<RewardLedgerEntry>;
  const validBucketIds = ['bnm', 'genesis-node', 'referral-shop', 'region-agent', 'ops', 'seckill-prize'];
  const id = String(row.id || '');
  if (!id) throw new Error('资产流水缺少 id。');
  return {
    id,
    bucketId: validBucketIds.includes(String(row.bucketId)) ? row.bucketId as RewardLedgerEntry['bucketId'] : undefined,
    source: String(row.source || '资产流水'),
    assetSymbol: requireAssetSymbol(row.assetSymbol, 'reward ledger'),
    amount: finiteNumberOrZero(row.amount),
    state: row.state === 'Locked' || row.state === 'Available' || row.state === 'PendingClaim' || row.state === 'Claimed' || row.state === 'Burned' ? row.state : 'Locked',
    txHash: row.txHash ? String(row.txHash) : undefined
  };
}

function normalizeClaim(raw: unknown): ClaimRecord {
  const row = raw as Partial<ClaimRecord>;
  const validBucketIds = ['bnm', 'genesis-node', 'referral-shop', 'region-agent', 'ops', 'seckill-prize', 'merchant'];
  const id = String(row.id || '');
  if (!id) throw new Error('Claim 记录缺少 id。');
  return {
    id,
    rewardId: row.rewardId ? String(row.rewardId) : undefined,
    bucketId: validBucketIds.includes(String(row.bucketId)) ? row.bucketId as ClaimRecord['bucketId'] : 'bnm',
    assetSymbol: requireAssetSymbol(row.assetSymbol, 'claim'),
    amount: finiteNumberOrZero(row.amount),
    status: row.status === 'pending' || row.status === 'failed' || row.status === 'success' ? row.status : 'pending',
    txHash: row.txHash ? String(row.txHash) : undefined,
    gasBnb: row.gasBnb === undefined ? undefined : finiteNumberOrZero(row.gasBnb),
    expiresAt: row.expiresAt === undefined ? undefined : finiteNumberOrZero(row.expiresAt),
    createdAt: String(row.createdAt || '')
  };
}

const SERVER_SHOWCASE_ADDRESS_IDS = new Set(['addr-default']);
const SERVER_SHOWCASE_LEDGER_IDS = new Set(['ledger-1', 'ledger-2', 'ledger-3']);
const SERVER_SHOWCASE_CLAIM_IDS = new Set(['claim-1', 'claim-2']);
const SERVER_SHOWCASE_STORE_IDS = new Set(['store-dl-gaoxin', 'store-bj-chaoyang']);

function normalizeDappAssetSummary(raw: unknown, address: string): DappAssetSummary {
  const row = raw as Record<string, unknown>;
  const addresses = arrayValue(row.addresses).map(normalizeAddress).filter((entry) => !SERVER_SHOWCASE_ADDRESS_IDS.has(entry.id));
  const ledger = arrayValue(row.ledger).map(normalizeLedger).filter((entry) => !SERVER_SHOWCASE_LEDGER_IDS.has(entry.id));
  const claims = arrayValue(row.claims).map(normalizeClaim).filter((entry) => !SERVER_SHOWCASE_CLAIM_IDS.has(entry.id));
  const buckets = arrayValue(row.buckets)
    .map(normalizeBucket)
    .filter((bucket) => bucket.visible);

  return {
    address,
    addresses,
    buckets,
    ledger,
    claims,
    orders: arrayValue(row.orders).map(normalizeAssetOrder),
    orderStateCounts: numberRecord(row.orderStateCounts),
    shoppingRecords: arrayValue(row.shoppingRecords).map(normalizeShoppingRecord),
    seckillRecords: arrayValue(row.seckillRecords).map(normalizeSeckillRecord),
    actions: stringRecord(row.actions)
  };
}

function normalizeAssetOrder(raw: unknown): AssetOrder {
  const row = raw as AssetOrder & Record<string, unknown>;
  if (!row || typeof row !== 'object' || !row.orderId) throw new Error('资产订单缺少 orderId。');
  return {
    ...row,
    afterSale: normalizeAfterSaleState(row.afterSale, String(row.orderId))
  };
}

function normalizeAfterSaleRequest(raw: unknown, fallback: { orderId: string; type: AfterSaleRequestType }): AfterSaleRequestRecord {
  const row = objectRecord(raw);
  const orderId = String(row.orderId || fallback.orderId);
  const typeValue = row.type || row.requestType;
  if (typeValue && (!isAfterSaleRequestType(typeValue) || typeValue !== fallback.type)) throw new Error('售后响应类型与当前申请不匹配。');
  const type = isAfterSaleRequestType(typeValue) ? typeValue : fallback.type;
  if (orderId.toLowerCase() !== fallback.orderId.toLowerCase()) throw new Error('售后响应与当前订单不匹配。');
  const resolution = row.result && typeof row.result === 'object' ? objectRecord(row.result) : null;
  const payload = row.payload && typeof row.payload === 'object' ? objectRecord(row.payload) : null;
  const result = optionalText(row.result)
    || optionalText(row.resolution)
    || optionalText(row.processingResult)
    || optionalText(row.decision)
    || optionalText(resolution?.message);
  return {
    id: optionalText(row.id),
    orderId,
    type,
    status: String(row.status || row.state || row.orderStatus || ''),
    lockState: optionalText(row.lockState) || optionalText(row.ledgerState) || optionalText(row.rewardState) || optionalText(row.assetState) || optionalText(payload?.assetState),
    result,
    reason: optionalText(row.reason),
    createdAt: optionalText(row.createdAt),
    updatedAt: optionalText(row.updatedAt)
  };
}

function normalizeEmbeddedAfterSale(raw: unknown, orderId: string): AfterSaleRequestRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = objectRecord(raw);
  const type = row.type || row.requestType;
  if (!isAfterSaleRequestType(type)) return null;
  return normalizeAfterSaleRequest(row, { orderId, type });
}

function normalizeAfterSaleState(raw: unknown, orderId: string): AfterSaleState | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = objectRecord(raw);
  const activeCase = normalizeEmbeddedAfterSale(row.case, orderId);
  return {
    available: row.available === true,
    allowedTypes: arrayValue(row.allowedTypes).filter(isAfterSaleRequestType),
    active: row.active === true,
    case: activeCase,
    endpoint: optionalText(row.endpoint),
    assetState: optionalText(row.assetState) || activeCase?.lockState,
    transactionIntent: normalizeAfterSaleTransactionIntent(row.transactionIntent, { orderId, type: 'exchange' }),
    arbitrationStatusEndpoint: optionalText(row.arbitrationStatusEndpoint)
  };
}

function normalizeAfterSaleTransactionIntent(raw: unknown, fallback: { orderId: string; type: AfterSaleRequestType }): AfterSaleTransactionIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = objectRecord(raw);
  if (fallback.type !== 'exchange') throw new Error('延期申请不应返回 disputeOrder 交易。');
  if (row.key !== 'buyerDisputeOrder' || Number(row.chainId) !== 56) throw new Error('售后交易意图类型或网络不匹配。');
  const orderId = String(row.orderId || '');
  if (orderId.toLowerCase() !== fallback.orderId.toLowerCase()) throw new Error('售后交易意图与当前订单不匹配。');
  const to = String(row.to || '');
  const data = String(row.data || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !/^0x[0-9a-fA-F]+$/.test(data)) throw new Error('售后交易意图缺少有效合约地址或 calldata。');
  return {
    key: 'buyerDisputeOrder',
    chainId: 56,
    orderId,
    from: optionalText(row.from),
    to,
    value: String(row.value || '0x0'),
    data
  };
}

function normalizeShoppingRecord(raw: unknown): ShoppingRecord {
  const row = raw as Partial<ShoppingRecord>;
  if (!row.orderId || !row.productId) throw new Error('购物记录缺少订单或商品标识。');
  return {
    orderId: String(row.orderId),
    productId: String(row.productId),
    title: String(row.title || row.productId),
    skuName: row.skuName ? String(row.skuName) : undefined,
    quantity: finiteNumberOrZero(row.quantity),
    amountNpl: String(row.amountNpl || '0'),
    status: String(row.status || ''),
    fulfillmentMode: row.fulfillmentMode === 'pickup' ? 'pickup' : row.fulfillmentMode === 'delivery' ? 'delivery' : undefined,
    regionCode: row.regionCode ? String(row.regionCode) : undefined,
    createdAt: row.createdAt ? String(row.createdAt) : undefined
  };
}

function normalizeSeckillRecord(raw: unknown): SeckillRecord {
  const row = raw as Partial<SeckillRecord>;
  if (!row.sessionId || !row.eventName) throw new Error('秒杀记录缺少场次或事件标识。');
  return {
    sessionId: String(row.sessionId),
    eventName: String(row.eventName),
    orderId: row.orderId ? String(row.orderId) : undefined,
    txHash: row.txHash ? String(row.txHash) : undefined,
    createdAt: row.createdAt ? String(row.createdAt) : undefined,
    session: row.session || null,
    prizeClaim: row.prizeClaim
  };
}

function flattenCmsPlacements(source: unknown): Array<[CmsPlacementKind | undefined, unknown]> {
  if (Array.isArray(source)) return source.map((entry) => [undefined, entry]);
  if (!source || typeof source !== 'object') return [];
  const row = objectRecord(source);
  const result: Array<[CmsPlacementKind | undefined, unknown]> = [];
  for (const kind of CMS_PLACEMENT_KINDS) {
    const value = row[kind];
    if (Array.isArray(value)) result.push(...value.map((entry): [CmsPlacementKind, unknown] => [kind, entry]));
    else if (value && typeof value === 'object') result.push([kind, value]);
  }
  if (!result.length && (row.kind || row.type || row.placement || row.placementType)) result.push([undefined, row]);
  return result;
}

function normalizeCmsPlacement(raw: unknown, kindHint: CmsPlacementKind | undefined, index: number): CmsPlacement | null {
  const row = objectRecord(raw);
  if (row.visible === false || row.enabled === false) return null;
  const kindValue = kindHint || row.kind || row.type || row.placement || row.placementType;
  if (!isCmsPlacementKind(kindValue)) return null;
  const action = row.action && typeof row.action === 'object' ? objectRecord(row.action) : {};
  const update = row.update && typeof row.update === 'object' ? objectRecord(row.update) : {};
  const frequencyValue = row.frequency || row.displayFrequency;
  const frequency = isCmsPlacementFrequency(frequencyValue) ? frequencyValue : 'once';
  const regionCodes = Array.isArray(row.regionCodes)
    ? row.regionCodes.map(String).filter(Boolean)
    : optionalText(row.regionCode)
      ? [String(row.regionCode)]
      : [];
  const versionValue = row.version ?? row.contentVersion ?? update.version ?? update.latestVersion;
  const version = versionValue === undefined || versionValue === null || versionValue === '' ? undefined : String(versionValue);
  const minimumAppVersion = optionalText(row.minAppVersion) || optionalText(update.minAppVersion);
  const forceUpdate = row.blocking === undefined
    ? isTrue(row.forceUpdate ?? row.force ?? row.mandatory ?? update.force)
    : isTrue(row.blocking);
  return {
    id: String(row.id || row.key || `${kindValue}-${version || index}`),
    kind: kindValue,
    title: String(row.title || ''),
    body: String(row.body || row.content || row.text || ''),
    mediaUrl: optionalText(row.mediaUrl) || optionalText(row.imageUrl),
    actionLabel: optionalText(row.actionLabel) || optionalText(action.label),
    actionUrl: optionalText(row.actionUrl) || optionalText(row.ctaUrl) || optionalText(row.updateUrl) || optionalText(action.url) || optionalText(update.url),
    frequency,
    regionCodes,
    version,
    minimumAppVersion,
    forceUpdate: kindValue === 'update' && forceUpdate,
    publishedAt: optionalText(row.publishedAt) || optionalText(row.updatedAt)
  };
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, finiteNumberOrZero(entry)]));
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'string')) as Record<string, string>;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function finiteNumberOrZero(value: unknown): number {
  return optionalFiniteNumber(value) ?? 0;
}

function isAssetSymbol(value: unknown): value is AssetSymbol {
  return value === 'BNM' || value === 'NPL';
}

function requireAssetSymbol(value: unknown, context: string): AssetSymbol {
  if (isAssetSymbol(value)) return value;
  throw new Error(`资产接口返回未知 ${context} assetSymbol。`);
}

function isShopBadge(value: unknown): value is Product['shopBadge'] {
  return value === '24K' || value === '秒杀' || value === '自提' || value === '精选' || value === '限量' || value === '链上';
}

function isImageTone(value: unknown): value is Product['imageTone'] {
  return value === 'ceramic' || value === 'carry' || value === 'watch' || value === 'fragrance' || value === 'home' || value === 'jacket' || value === 'bottle';
}

function isCategory(value: unknown): value is Product['category'] {
  return value === '精选' || value === '穿搭' || value === '居家' || value === '科技' || value === '香氛' || value === '食品' || value === '数码' || value === '运动';
}

function isFulfillmentMode(value: unknown): value is Product['fulfillmentModes'][number] {
  return value === 'delivery' || value === 'pickup';
}

function isMessageTone(value: unknown): value is MessageItem['tone'] {
  return value === 'order' || value === 'escrow' || value === 'support' || value === 'system' || value === 'promo';
}

function isSeckillStatus(value: unknown): value is SeckillSession['status'] {
  return value === 'upcoming' || value === 'live' || value === 'settling' || value === 'settled';
}

const CMS_PLACEMENT_KINDS: CmsPlacementKind[] = ['banner', 'popup', 'faq', 'legal', 'update'];

function isCmsPlacementKind(value: unknown): value is CmsPlacementKind {
  return CMS_PLACEMENT_KINDS.includes(value as CmsPlacementKind);
}

function isCmsPlacementFrequency(value: unknown): value is CmsPlacementFrequency {
  return value === 'once' || value === 'daily' || value === 'always';
}

function isAfterSaleRequestType(value: unknown): value is AfterSaleRequestType {
  return value === 'exchange' || value === 'delay';
}

function isTrue(value: unknown) {
  return value === true || value === 1 || value === 'true';
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function authenticatedJson(method: 'POST' | 'PATCH' | 'DELETE', token: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  };
}

function authenticatedGet(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function requestApi<T>(path: string, init: RequestInit | undefined, label: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error || `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(`${label}：${detail}`);
  }
  return payload as T;
}

function queryString(params: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}
