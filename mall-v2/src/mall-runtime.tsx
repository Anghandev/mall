import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AllowedAction,
  CatalogProduct,
  CatalogSku,
  CmsPublicItem,
  FulfillmentOrder,
  FulfillmentTarget,
  MerchantStore,
  NotificationEndpointProjection,
  NotificationInboxItem,
  PaymentProjection,
  PaymentQuoteResponse,
  PaymentSubmissionRequest,
  RealtimeEventEnvelope,
  SeckillQuoteResponse,
  SeckillSessionProjection,
  SettlementListProjection,
  SettlementRail,
} from '@abu24k/core-artifacts';

import {
  CoreClientError,
  createCoreClient,
  type CheckoutTarget,
  type CorePaymentAvailability,
  type CoreClient,
  type WalletSession,
} from './core-client';
import { productBaseline } from './bootstrap';
import {
  createSeckillRealtimeClient,
  type SeckillRealtimeClient,
  type SeckillRealtimeState,
} from './seckill-realtime';
import { createBrowserWalletGateway, type ApprovalStatus, type WalletGateway } from './wallet';

type SignedQuote = PaymentQuoteResponse | SeckillQuoteResponse;
type LoadState = 'loading' | 'ready' | 'empty' | 'error';

export interface BrowserPosition {
  latitude: number;
  longitude: number;
}

export interface DeliveryTargetDraft {
  recipientName: string;
  phone: string;
  address: string;
}

export interface MallServices {
  core: CoreClient;
  wallet: WalletGateway;
  getCurrentPosition(): Promise<BrowserPosition>;
  createIdempotencyKey(): string;
  submissionStore: SubmissionStore;
  realtime: SeckillRealtimeClient;
  walletWritesAuthorized: boolean;
}

export interface SubmissionStore {
  load(walletAddress: string): PendingSubmission | null;
  save(submission: PendingSubmission): void;
  clear(submission: PendingSubmission): void;
}

export interface PendingSubmission extends PaymentSubmissionRequest {
  artifactVersion: string;
  chainId: number;
  walletAddress: string;
  phase: 'PENDING_CORE_SUBMISSION' | 'AWAITING_PROJECTION';
}

export interface MallRuntimeValue {
  bootstrap: CorePaymentAvailability | null;
  catalog: readonly CatalogProduct[];
  catalogState: LoadState;
  stores: readonly MerchantStore[];
  storesState: LoadState;
  location: BrowserPosition | null;
  locationState: 'idle' | 'loading' | 'ready' | 'error';
  checkoutTarget: CheckoutTarget | null;
  seckillSession: SeckillSessionProjection | null;
  seckillSessionState: LoadState;
  seckillHistory: readonly SeckillSessionProjection[];
  seckillEvents: readonly RealtimeEventEnvelope[];
  seckillRealtimeState: SeckillRealtimeState | 'IDLE';
  seckillRealtimeError: string | null;
  selectedSeckillSessionId: string | null;
  orders: readonly FulfillmentOrder[];
  ordersState: 'idle' | LoadState;
  orderActions: Readonly<Record<string, readonly AllowedAction[]>>;
  orderTargets: Readonly<Record<string, FulfillmentTarget>>;
  orderCapabilityErrors: Readonly<Record<string, string>>;
  fulfillmentEvidenceStatus: 'NOT_PUBLISHED_FAIL_CLOSED';
  settlements: SettlementListProjection | null;
  settlementsState: 'idle' | LoadState;
  notifications: readonly NotificationInboxItem[];
  notificationsState: 'idle' | LoadState;
  notificationEndpoint: NotificationEndpointProjection | null;
  cmsItems: readonly CmsPublicItem[];
  cmsState: LoadState;
  session: WalletSession | null;
  selectedProduct: CatalogProduct | null;
  selectedSku: CatalogSku | null;
  quantity: number;
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  quote: SignedQuote | null;
  projection: PaymentProjection | null;
  approvals: readonly ApprovalStatus[];
  pendingSubmission: PendingSubmission | null;
  submittedTxHash: string | null;
  busy: boolean;
  error: string | null;
  walletWritesAuthorized: boolean;
  connectWallet(): Promise<void>;
  reloadCatalog(): Promise<void>;
  reloadSeckill(): Promise<void>;
  selectSeckillSession(): void;
  reloadStores(regionCode?: string): Promise<void>;
  requestLocation(): Promise<void>;
  createDeliveryTarget(draft: DeliveryTargetDraft): Promise<void>;
  createPickupTarget(storeId: string): Promise<void>;
  reloadOrders(): Promise<void>;
  reloadSettlements(): Promise<void>;
  requestSettlement(rail: 'REWARD_NPL' | 'PRIZE_USDT', amount: string): Promise<void>;
  reloadNotifications(): Promise<void>;
  enableInAppNotifications(): Promise<void>;
  reloadCms(): Promise<void>;
  selectProduct(productId: string): void;
  selectSku(skuId: string): void;
  setQuantity(quantity: number): void;
  setFulfillmentMode(mode: 'DELIVERY' | 'PICKUP'): void;
  requestOrdinaryQuote(): Promise<void>;
  requestSeckillQuote(sessionId: string): Promise<void>;
  broadcastPayment(acknowledgeUnlimitedApproval: boolean, acknowledgeSeckillFallback: boolean): Promise<void>;
  retrySubmission(): Promise<void>;
  refreshPayment(): Promise<void>;
  revokeApproval(index: number): Promise<void>;
  clearError(): void;
}

const RuntimeContext = createContext<MallRuntimeValue | null>(null);

export function MallRuntimeProvider({
  children,
  services = defaultMallServices,
}: {
  children: ReactNode;
  services?: MallServices;
}) {
  const [bootstrap, setBootstrap] = useState<CorePaymentAvailability | null>(null);
  const [catalog, setCatalog] = useState<readonly CatalogProduct[]>([]);
  const [catalogState, setCatalogState] = useState<LoadState>('loading');
  const [stores, setStores] = useState<readonly MerchantStore[]>([]);
  const [storesState, setStoresState] = useState<LoadState>('loading');
  const [location, setLocation] = useState<BrowserPosition | null>(null);
  const [locationState, setLocationState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [checkoutTarget, setCheckoutTarget] = useState<CheckoutTarget | null>(null);
  const [seckillSession, setSeckillSession] = useState<SeckillSessionProjection | null>(null);
  const [seckillSessionState, setSeckillSessionState] = useState<LoadState>('loading');
  const [seckillHistory, setSeckillHistory] = useState<readonly SeckillSessionProjection[]>([]);
  const [seckillEvents, setSeckillEvents] = useState<readonly RealtimeEventEnvelope[]>([]);
  const [seckillRealtimeState, setSeckillRealtimeState] = useState<SeckillRealtimeState | 'IDLE'>('IDLE');
  const [seckillRealtimeError, setSeckillRealtimeError] = useState<string | null>(null);
  const [selectedSeckillSessionId, setSelectedSeckillSessionId] = useState<string | null>(null);
  const [orders, setOrders] = useState<readonly FulfillmentOrder[]>([]);
  const [ordersState, setOrdersState] = useState<'idle' | LoadState>('idle');
  const [orderActions, setOrderActions] = useState<Readonly<Record<string, readonly AllowedAction[]>>>({});
  const [orderTargets, setOrderTargets] = useState<Readonly<Record<string, FulfillmentTarget>>>({});
  const [orderCapabilityErrors, setOrderCapabilityErrors] = useState<Readonly<Record<string, string>>>({});
  const [settlements, setSettlements] = useState<SettlementListProjection | null>(null);
  const [settlementsState, setSettlementsState] = useState<'idle' | LoadState>('idle');
  const [notifications, setNotifications] = useState<readonly NotificationInboxItem[]>([]);
  const [notificationsState, setNotificationsState] = useState<'idle' | LoadState>('idle');
  const [notificationEndpoint, setNotificationEndpoint] = useState<NotificationEndpointProjection | null>(null);
  const [cmsItems, setCmsItems] = useState<readonly CmsPublicItem[]>([]);
  const [cmsState, setCmsState] = useState<LoadState>('loading');
  const [session, setSession] = useState<WalletSession | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedSkuId, setSelectedSkuId] = useState<string | null>(null);
  const [quantity, setQuantityState] = useState(1);
  const [fulfillmentMode, setFulfillmentModeState] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY');
  const [quote, setQuote] = useState<SignedQuote | null>(null);
  const [projection, setProjection] = useState<PaymentProjection | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalStatus[]>([]);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const [submittedTxHash, setSubmittedTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const broadcastInFlight = useRef(false);

  const selectedProduct = catalog.find((product) => product.productId === selectedProductId) ?? null;
  const selectedSku = selectedProduct?.skus.find((sku) => sku.skuId === selectedSkuId) ?? null;

  useEffect(() => {
    let active = true;
    void Promise.all([services.core.getBootstrap(), services.core.listCatalog()])
      .then(([nextBootstrap, products]) => {
        if (!active) return;
        setBootstrap(nextBootstrap);
        setCatalog(products);
        setCatalogState(products.length > 0 ? 'ready' : 'empty');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setCatalogState('error');
        setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [services]);

  useEffect(() => {
    let active = true;
    void loadSeckillSurface(() => active).catch((reason: unknown) => {
      if (active) setSeckillRealtimeError(errorMessage(reason));
    });
    return () => { active = false; };
  }, [services]);

  useEffect(() => {
    if (!seckillSession) {
      setSeckillRealtimeState('IDLE');
      return;
    }
    const sessionId = seckillSession.sessionId;
    const subscription = services.realtime.subscribe(sessionId, {
      onEvent(event) {
        setSeckillEvents((current) => current.some((item) => item.eventId === event.eventId)
          ? current
          : [event, ...current].slice(0, 50));
        void services.core.getSeckillSession(sessionId)
          .then((next) => setSeckillSession((current) => current?.sessionId === sessionId ? next : current))
          .catch((reason: unknown) => setSeckillRealtimeError(errorMessage(reason)));
      },
      onState: setSeckillRealtimeState,
      onError: (reason) => setSeckillRealtimeError(errorMessage(reason)),
      onArtifactMismatch() {
        setSeckillSession(null);
        setSeckillEvents([]);
        setSeckillSessionState('error');
      },
    });
    return () => subscription.close();
  }, [seckillSession?.sessionId, services]);

  useEffect(() => {
    if (!seckillSession) return;
    const sessionId = seckillSession.sessionId;
    const timer = setInterval(() => {
      void services.core.getSeckillSession(sessionId)
        .then((next) => setSeckillSession((current) => current?.sessionId === sessionId ? next : current))
        .catch((reason: unknown) => setSeckillRealtimeError(errorMessage(reason)));
    }, 15_000);
    return () => clearInterval(timer);
  }, [seckillSession?.sessionId, services]);

  useEffect(() => {
    let active = true;
    void services.core.listPublicCms()
      .then((items) => {
        if (!active) return;
        setCmsItems(items);
        setCmsState(items.length > 0 ? 'ready' : 'empty');
      })
      .catch(() => {
        if (active) setCmsState('error');
      });
    return () => { active = false; };
  }, [services]);

  useEffect(() => {
    let active = true;
    void services.core.listStores()
      .then((nextStores) => {
        if (!active) return;
        setStores(nextStores);
        setStoresState(nextStores.length > 0 ? 'ready' : 'empty');
      })
      .catch(() => {
        if (!active) return;
        setStoresState('error');
      });
    return () => { active = false; };
  }, [services]);

  const value = useMemo<MallRuntimeValue>(() => ({
    bootstrap,
    catalog,
    catalogState,
    stores,
    storesState,
    location,
    locationState,
    checkoutTarget,
    seckillSession,
    seckillSessionState,
    seckillHistory,
    seckillEvents,
    seckillRealtimeState,
    seckillRealtimeError,
    selectedSeckillSessionId,
    orders,
    ordersState,
    orderActions,
    orderTargets,
    orderCapabilityErrors,
    fulfillmentEvidenceStatus: 'NOT_PUBLISHED_FAIL_CLOSED',
    settlements,
    settlementsState,
    notifications,
    notificationsState,
    notificationEndpoint,
    cmsItems,
    cmsState,
    session,
    selectedProduct,
    selectedSku,
    quantity,
    fulfillmentMode,
    quote,
    projection,
    approvals,
    pendingSubmission,
    submittedTxHash,
    busy,
    error,
    walletWritesAuthorized: services.walletWritesAuthorized,

    async connectWallet() {
      await run(async () => {
        const walletAddress = await services.wallet.connect();
        const nextSession = await services.core.authenticate(
          walletAddress,
          (message) => services.wallet.signMessage(message),
        );
        if (!nextSession.roles.includes('BUYER')) throw new CoreClientError('Forbidden', '当前钱包没有购买权限');
        const recovered = services.submissionStore.load(nextSession.walletAddress);
        setPendingSubmission(recovered);
        setSubmittedTxHash(recovered?.txHash ?? null);
        setSession(nextSession);
        await loadAuthenticatedBundles(nextSession);
        await loadCms(nextSession.walletAddress).catch(() => setCmsState('error'));
      });
    },

    async reloadCatalog() {
      setCatalogState('loading');
      await run(async () => {
        const products = await services.core.listCatalog();
        setCatalog(products);
        setCatalogState(products.length > 0 ? 'ready' : 'empty');
      }, () => setCatalogState('error'));
    },

    async reloadSeckill() {
      await run(async () => loadSeckillSurface(() => true));
    },

    selectSeckillSession() {
      if (pendingSubmission) return setError('当前链上交易尚未提交到 Core，请先恢复跟踪');
      if (!seckillSession) return setError('当前没有 Core 发布的秒杀场次');
      if (seckillSession.phase !== 'LIVE' || BigInt(seckillSession.inventory.available) === 0n) {
        return setError('Core 当前场次阶段或库存不允许创建秒杀订单');
      }
      const product = catalog.find((item) => item.productId === seckillSession.product.productId);
      const sku = product?.skus.find((item) => item.skuId === seckillSession.product.skuId);
      if (!product || !sku) return setError('秒杀商品与当前可售目录不一致，已停止进入结算');
      setSelectedProductId(product.productId);
      setSelectedSkuId(sku.skuId);
      setSelectedSeckillSessionId(seckillSession.sessionId);
      setQuantityState(1);
      clearPaymentState();
    },

    async reloadStores(regionCode) {
      setStoresState('loading');
      await run(async () => {
        const nextStores = await services.core.listStores(regionCode);
        setStores(nextStores);
        setStoresState(nextStores.length > 0 ? 'ready' : 'empty');
      }, () => setStoresState('error'));
    },

    async requestLocation() {
      setLocationState('loading');
      await run(async () => {
        const nextLocation = await services.getCurrentPosition();
        setLocation(nextLocation);
        setLocationState('ready');
      }, () => setLocationState('error'));
    },

    async createDeliveryTarget(draft) {
      await run(async () => {
        const activeSession = requireSession();
        assertDeliveryTargetDraft(draft);
        const nextLocation = location ?? await services.getCurrentPosition();
        setLocation(nextLocation);
        setLocationState('ready');
        const target = await services.core.createDeliveryTarget(activeSession.token, {
          idempotencyKey: services.createIdempotencyKey(),
          ...draft,
          ...nextLocation,
        });
        setCheckoutTarget({
          fulfillmentMode: target.fulfillmentMode,
          fulfillmentTargetHash: target.targetHash,
          regionCodeHash: target.regionCodeHash,
          label: `${draft.recipientName} · ${draft.address}`,
        });
        clearQuoteState();
      });
    },

    async createPickupTarget(storeId) {
      await run(async () => {
        const activeSession = requireSession();
        const store = stores.find((item) => item.storeId === storeId && item.status === 'ACTIVE');
        if (!store) throw new CoreClientError('InvalidRequest', '请选择当前可用门店');
        const target = await services.core.createPickupTarget(activeSession.token, {
          idempotencyKey: services.createIdempotencyKey(),
          storeId: store.storeId,
        });
        setCheckoutTarget({
          fulfillmentMode: target.fulfillmentMode,
          fulfillmentTargetHash: target.targetHash,
          regionCodeHash: target.regionCodeHash,
          label: `${target.store.name} · ${target.store.address}`,
        });
        clearQuoteState();
      });
    },

    async reloadOrders() {
      await run(async () => loadOrderBundle(requireSession()), () => setOrdersState('error'));
    },

    async reloadSettlements() {
      await run(async () => loadSettlementBundle(requireSession()), () => setSettlementsState('error'));
    },

    async requestSettlement(rail, amount) {
      await run(async () => {
        const activeSession = requireSession();
        assertBuyerSettlement(rail, amount);
        const intent = await services.core.createSettlementIntent(activeSession.token, {
          rail,
          amount,
          idempotencyKey: services.createIdempotencyKey(),
        });
        const signature = await services.wallet.signSettlementIntent(intent);
        await services.core.submitSettlementRequest(activeSession.token, {
          intentId: intent.intent.intentId,
          signature,
        });
        await loadSettlementBundle(activeSession);
      });
    },

    async reloadNotifications() {
      await run(async () => loadNotificationBundle(requireSession()), () => setNotificationsState('error'));
    },

    async enableInAppNotifications() {
      await run(async () => {
        const activeSession = requireSession();
        const endpoint = await services.core.registerNotificationEndpoint(activeSession.token, {
          channel: 'IN_APP',
          provider: 'CORE',
          endpointReference: `recipient://wallet/${activeSession.walletAddress.toLowerCase()}`,
          topics: ['*'],
        });
        setNotificationEndpoint(endpoint);
        await loadNotificationBundle(activeSession);
      });
    },

    async reloadCms() {
      await run(async () => loadCms(session?.walletAddress), () => setCmsState('error'));
    },

    selectProduct(productId) {
      if (pendingSubmission) return setError('当前链上交易尚未提交到 Core，请先恢复跟踪');
      const product = catalog.find((item) => item.productId === productId);
      setSelectedProductId(product?.productId ?? null);
      setSelectedSkuId(null);
      setSelectedSeckillSessionId(null);
      setQuantityState(1);
      clearPaymentState();
    },

    selectSku(skuId) {
      if (pendingSubmission) return setError('当前链上交易尚未提交到 Core，请先恢复跟踪');
      if (selectedSeckillSessionId && skuId !== seckillSession?.product.skuId) {
        return setError('秒杀订单只能使用 Core 场次绑定的 SKU');
      }
      setSelectedSkuId(selectedProduct?.skus.some((sku) => sku.skuId === skuId) ? skuId : null);
      clearPaymentState();
    },

    setQuantity(nextQuantity) {
      if (pendingSubmission) return setError('当前链上交易尚未提交到 Core，请先恢复跟踪');
      setQuantityState(Math.max(1, Math.floor(nextQuantity)));
      clearPaymentState();
    },

    setFulfillmentMode(mode) {
      if (pendingSubmission) return setError('当前链上交易尚未提交到 Core，请先恢复跟踪');
      setFulfillmentModeState(mode);
      if (checkoutTarget?.fulfillmentMode !== mode) setCheckoutTarget(null);
      clearPaymentState();
    },

    async requestOrdinaryQuote() {
      await run(async () => {
        const selection = await buildSelection();
        const nextQuote = await services.core.createOrdinaryQuote(requireSession().token, selection);
        setQuote(nextQuote);
        setProjection(null);
        setApprovals(await services.wallet.inspectApprovals(nextQuote.approvalRequirements));
      });
    },

    async requestSeckillQuote(sessionId) {
      await run(async () => {
        if (sessionId !== selectedSeckillSessionId
          || sessionId !== seckillSession?.sessionId
          || seckillSession.phase !== 'LIVE') {
          throw new CoreClientError('InvalidRequest', '秒杀场次选择已失效，请返回大厅重新同步');
        }
        const selection = await buildSelection();
        const nextQuote = await services.core.createSeckillQuote(requireSession().token, sessionId, selection);
        setQuote(nextQuote);
        setProjection(null);
        setApprovals(await services.wallet.inspectApprovals(nextQuote.approvalRequirements));
      });
    },

    async broadcastPayment(acknowledgeUnlimitedApproval, acknowledgeSeckillFallback) {
      if (broadcastInFlight.current) return;
      broadcastInFlight.current = true;
      try {
        await run(async () => {
          const activeQuote = requireQuote();
          if (submittedTxHash) throw new CoreClientError('IdempotencyConflict', '当前报价已广播，只能恢复 Core 提交或刷新投影');
          if ('dual' in activeQuote && !acknowledgeSeckillFallback) {
            throw new CoreClientError('InvalidRequest', '请先确认秒杀与日常备用报价及链上分类规则');
          }
          if (!bootstrap?.writesEnabled) {
            throw new CoreClientError('ExternalBlocked', '当前 Core 未开放新支付');
          }
          if (!services.walletWritesAuthorized) {
            throw new CoreClientError('ExternalBlocked', '当前协调 manifest 未授权钱包广播');
          }
          const txHash = await services.wallet.broadcastPayment(activeQuote, acknowledgeUnlimitedApproval);
          const submission: PendingSubmission = {
            artifactVersion: productBaseline.coreArtifacts,
            chainId: productBaseline.chainId,
            walletAddress: activeQuote.buyerAuthorization.message.buyer.toLowerCase(),
            phase: 'PENDING_CORE_SUBMISSION',
            orderId: activeQuote.orderId,
            txHash,
          };
          services.submissionStore.save(submission);
          setSubmittedTxHash(txHash);
          setPendingSubmission(submission);
          await submitAndRefresh(submission);
        });
      } finally {
        broadcastInFlight.current = false;
      }
    },

    async retrySubmission() {
      await run(async () => {
        if (!pendingSubmission) throw new CoreClientError('InvalidRequest', '当前没有待恢复的交易提交');
        if (pendingSubmission.walletAddress !== requireSession().walletAddress.toLowerCase()) {
          throw new CoreClientError('WalletMismatch', '当前钱包与待恢复交易不一致');
        }
        if (pendingSubmission.phase === 'PENDING_CORE_SUBMISSION') await submitAndRefresh(pendingSubmission);
        else await refreshAndComplete(pendingSubmission);
      });
    },

    async refreshPayment() {
      await run(async () => {
        const activeQuote = requireQuote();
        setProjection(await services.core.getPayment(requireSession().token, activeQuote.orderId));
      });
    },

    async revokeApproval(index) {
      await run(async () => {
        const requirement = requireQuote().approvalRequirements[index];
        if (!requirement) throw new CoreClientError('InvalidRequest', '授权记录不存在');
        await services.wallet.revokeApproval(requirement);
        setApprovals(await services.wallet.inspectApprovals(requireQuote().approvalRequirements));
      });
    },

    clearError() {
      setError(null);
    },
  // Callback bodies deliberately use current render state; every mutation causes a new memo value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    bootstrap,
    approvals,
    busy,
    catalog,
    catalogState,
    checkoutTarget,
    error,
    fulfillmentMode,
    location,
    locationState,
    seckillSession,
    seckillSessionState,
    seckillHistory,
    seckillEvents,
    seckillRealtimeState,
    seckillRealtimeError,
    selectedSeckillSessionId,
    orderActions,
    orderCapabilityErrors,
    orders,
    ordersState,
    orderTargets,
    settlements,
    settlementsState,
    notifications,
    notificationsState,
    notificationEndpoint,
    cmsItems,
    cmsState,
    projection,
    pendingSubmission,
    quantity,
    quote,
    selectedProduct,
    selectedSku,
    services,
    session,
    stores,
    storesState,
    submittedTxHash,
  ]);

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;

  async function run(action: () => Promise<void>, onFailure?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      onFailure?.();
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  function requireSession() {
    if (!session) throw new CoreClientError('Unauthorized', '请先连接钱包并完成登录签名');
    return session;
  }

  function requireQuote() {
    if (!quote) throw new CoreClientError('InvalidRequest', '请先创建签名报价和库存预留');
    return quote;
  }

  async function buildSelection() {
    if (!bootstrap?.writesEnabled) throw readinessError(bootstrap);
    if (!selectedProduct || !selectedSku) throw new CoreClientError('InvalidRequest', '请选择商品和 SKU');
    if (BigInt(selectedSku.stockAvailable) < BigInt(quantity)) {
      throw new CoreClientError('InventoryUnavailable', '抱歉，该规格商品刚刚已被抢光，请重新选择规格！');
    }
    const target = checkoutTarget;
    if (!target || target.fulfillmentMode !== fulfillmentMode) {
      throw new CoreClientError(
        'ExternalBlocked',
        fulfillmentMode === 'DELIVERY'
          ? '请先选择由 Core 验证的收货地址'
          : '请先选择由 Core 验证的自提门店',
      );
    }
    return {
      ...target,
      idempotencyKey: services.createIdempotencyKey(),
      productId: selectedProduct.productId,
      skuId: selectedSku.skuId,
      quantity,
    };
  }

  function clearPaymentState() {
    clearQuoteState();
    setPendingSubmission(null);
    setSubmittedTxHash(null);
  }

  function clearQuoteState() {
    setQuote(null);
    setProjection(null);
    setApprovals([]);
  }

  async function loadOrderBundle(activeSession: WalletSession) {
    setOrdersState('loading');
    const nextOrders = await services.core.listOrders(activeSession.token);
    const actions: Record<string, readonly AllowedAction[]> = {};
    const targets: Record<string, FulfillmentTarget> = {};
    const capabilityErrors: Record<string, string> = {};
    await Promise.all(nextOrders.map(async (order) => {
      const [actionResult, targetResult] = await Promise.allSettled([
        services.core.getOrderAllowedActions(activeSession.token, order.orderId),
        services.core.getOrderTarget(activeSession.token, order.orderId),
      ]);
      if (actionResult.status === 'fulfilled') actions[order.orderId] = actionResult.value;
      else capabilityErrors[order.orderId] = '订单允许操作暂不可用';
      if (targetResult.status === 'fulfilled') targets[order.orderId] = targetResult.value;
      else capabilityErrors[order.orderId] = capabilityErrors[order.orderId]
        ? `${capabilityErrors[order.orderId]}；履约目标暂不可用`
        : '履约目标暂不可用';
    }));
    setOrders(nextOrders);
    setOrderActions(actions);
    setOrderTargets(targets);
    setOrderCapabilityErrors(capabilityErrors);
    setOrdersState(nextOrders.length > 0 ? 'ready' : 'empty');
  }

  async function loadAuthenticatedBundles(activeSession: WalletSession) {
    const results = await Promise.allSettled([
      loadOrderBundle(activeSession),
      loadSettlementBundle(activeSession),
      loadNotificationBundle(activeSession),
    ]);
    if (results[0]?.status === 'rejected') setOrdersState('error');
    if (results[1]?.status === 'rejected') setSettlementsState('error');
    if (results[2]?.status === 'rejected') setNotificationsState('error');
    if (results.some((result) => result.status === 'rejected')) {
      setError('部分账户数据同步失败，可在对应页面重试');
    }
  }

  async function loadSettlementBundle(activeSession: WalletSession) {
    setSettlementsState('loading');
    const nextSettlements = await services.core.listSettlements(activeSession.token);
    if (nextSettlements.wallet.toLowerCase() !== activeSession.walletAddress.toLowerCase()) {
      throw new CoreClientError('WalletMismatch', '收益结算投影与当前钱包不一致');
    }
    setSettlements(nextSettlements);
    setSettlementsState(
      nextSettlements.balances.length > 0 || nextSettlements.points.length > 0 || nextSettlements.requests.length > 0
        ? 'ready'
        : 'empty',
    );
  }

  async function loadSeckillSurface(isActive: () => boolean) {
    if (isActive()) setSeckillSessionState('loading');
    const [current, history] = await Promise.allSettled([
      services.core.getCurrentSeckillSession(),
      services.core.listSeckillSessionHistory(undefined, 20),
    ]);
    if (!isActive()) return;
    if (history.status === 'fulfilled') setSeckillHistory(history.value.items);
    if (current.status === 'fulfilled') {
      setSeckillSession(current.value);
      setSeckillSessionState('ready');
      setSeckillRealtimeError(null);
      return;
    }
    if (current.reason instanceof CoreClientError && current.reason.code === 'UnknownState') {
      setSeckillSession(null);
      setSeckillEvents([]);
      setSeckillSessionState('empty');
      return;
    }
    setSeckillSessionState('error');
    throw current.reason;
  }

  async function loadNotificationBundle(activeSession: WalletSession) {
    setNotificationsState('loading');
    const nextNotifications = await services.core.listNotifications(activeSession.token);
    setNotifications(nextNotifications);
    setNotificationsState(nextNotifications.length > 0 ? 'ready' : 'empty');
  }

  async function loadCms(walletAddress?: string) {
    setCmsState('loading');
    const items = await services.core.listPublicCms(walletAddress);
    setCmsItems(items);
    setCmsState(items.length > 0 ? 'ready' : 'empty');
  }

  async function submitAndRefresh(submission: PendingSubmission) {
    await services.core.submitPayment(requireSession().token, paymentSubmissionRequest(submission));
    const awaitingProjection = { ...submission, phase: 'AWAITING_PROJECTION' as const };
    services.submissionStore.save(awaitingProjection);
    setPendingSubmission(awaitingProjection);
    await refreshAndComplete(awaitingProjection);
  }

  async function refreshAndComplete(submission: PendingSubmission) {
    const nextProjection = await services.core.getPayment(requireSession().token, submission.orderId);
    setQuote(nextProjection);
    setProjection(nextProjection);
    services.submissionStore.clear(submission);
    setPendingSubmission(null);
  }
}

function assertBuyerSettlement(rail: SettlementRail, amount: string): asserts rail is 'REWARD_NPL' | 'PRIZE_USDT' {
  if (!['REWARD_NPL', 'PRIZE_USDT'].includes(rail) || !/^[1-9][0-9]*$/.test(amount)) {
    throw new CoreClientError('InvalidRequest', '结算轨道或金额无效');
  }
}

export function useMallRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('MallRuntimeProvider is required');
  return value;
}

const defaultCoreClient = createCoreClient();

export const defaultMallServices: MallServices = Object.freeze({
  core: defaultCoreClient,
  realtime: createSeckillRealtimeClient(defaultCoreClient),
  wallet: createBrowserWalletGateway(),
  async getCurrentPosition() {
    if (!globalThis.navigator?.geolocation) {
      throw new CoreClientError('ExternalBlocked', '当前设备未提供安全定位能力');
    }
    return new Promise<BrowserPosition>((resolve, reject) => {
      globalThis.navigator.geolocation.getCurrentPosition(
        (position) => resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
        () => reject(new CoreClientError('ExternalBlocked', '未取得设备定位授权')),
        { enableHighAccuracy: true, maximumAge: 30_000, timeout: 10_000 },
      );
    });
  },
  createIdempotencyKey() {
    return `mall-${globalThis.crypto.randomUUID()}`;
  },
  submissionStore: createBrowserSubmissionStore(),
  walletWritesAuthorized:
    productBaseline.deploymentAuthorized
      && productBaseline.payOrderExecutable
      && productBaseline.paymentRouterAddress !== null,
});

function readinessError(bootstrap: CorePaymentAvailability | null) {
  if (!bootstrap) return new CoreClientError('ConfigurationRequired', 'Core 安全状态尚未同步');
  if (bootstrap.blockCode === 'DecisionBlocked') {
    return new CoreClientError('DecisionBlocked', '支付政策尚有未决项');
  }
  if (bootstrap.blockCode === 'ExternalBlocked') {
    return new CoreClientError('ExternalBlocked', '支付基础设施尚未就绪');
  }
  return new CoreClientError('ConfigurationRequired', '新支付当前已安全停用');
}

function assertDeliveryTargetDraft(draft: DeliveryTargetDraft) {
  if (!draft.recipientName.trim() || !/^\d{11}$/.test(draft.phone) || draft.address.trim().length < 5) {
    throw new CoreClientError('InvalidRequest', '请完整填写收货人、11 位手机号和详细地址');
  }
}

function errorMessage(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  return '操作失败，请稍后重试';
}

export function createBrowserSubmissionStore(): SubmissionStore {
  const keyFor = (walletAddress: string) => [
    'abu24k:mall:pending-payment-submission',
    productBaseline.coreArtifacts,
    productBaseline.chainId,
    walletAddress.toLowerCase(),
  ].join(':');
  return {
    load(walletAddress) {
      const key = keyFor(walletAddress);
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (!raw) return null;
        const value = JSON.parse(raw) as Partial<PendingSubmission>;
        if (!isPendingSubmission(value, walletAddress)) {
          globalThis.localStorage?.removeItem(key);
          return null;
        }
        return value;
      } catch {
        try { globalThis.localStorage?.removeItem(key); } catch { /* Storage is unavailable. */ }
        return null;
      }
    },
    save(submission) {
      try {
        globalThis.localStorage?.setItem(keyFor(submission.walletAddress), JSON.stringify(submission));
      } catch {
        // In-memory state still prevents duplicate broadcast in restricted storage contexts.
      }
    },
    clear(submission) {
      try {
        globalThis.localStorage?.removeItem(keyFor(submission.walletAddress));
      } catch {
        // The persisted record is idempotent and can be resubmitted safely later.
      }
    },
  };
}

function isPendingSubmission(value: Partial<PendingSubmission>, walletAddress: string): value is PendingSubmission {
  return value.artifactVersion === productBaseline.coreArtifacts
    && value.chainId === productBaseline.chainId
    && value.walletAddress?.toLowerCase() === walletAddress.toLowerCase()
    && (value.phase === 'PENDING_CORE_SUBMISSION' || value.phase === 'AWAITING_PROJECTION')
    && isBytes32(value.orderId)
    && isBytes32(value.txHash)
    && (value.replacementForTxHash === undefined || isBytes32(value.replacementForTxHash));
}

function paymentSubmissionRequest(submission: PendingSubmission): PaymentSubmissionRequest {
  return {
    orderId: submission.orderId,
    txHash: submission.txHash,
    ...(submission.replacementForTxHash ? { replacementForTxHash: submission.replacementForTxHash } : {}),
  };
}

function isBytes32(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}
