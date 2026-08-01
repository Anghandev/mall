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
  BuyerOverview,
  BuyerProfile,
  BuyerSavedAddress,
  BuyerShoppingStatement,
  BuyerTakeoverTimeline,
  CatalogCategory,
  CatalogProduct,
  CatalogSku,
  CatalogTag,
  CmsPublicItem,
  EvidenceEnvelopeProjection,
  FulfillmentOrder,
  FulfillmentOrderCursor,
  FulfillmentTarget,
  MerchantStore,
  MediaAssetProjection,
  MediaReadAccessProjection,
  MediaUploadIntentProjection,
  NotificationEndpointProjection,
  NotificationInboxItem,
  OrderStatementCursor,
  PaymentProjection,
  PaymentQuoteResponse,
  PaymentSubmissionRequest,
  PickupTarget,
  RealtimeEventEnvelope,
  SeckillQuoteResponse,
  SettlementListProjection,
  SettlementRail,
  UserRole,
} from '@abu24k/core-artifacts';

import {
  CoreClientError,
  createCoreClient,
  type BuyerEvidenceAction,
  type BuyerAddressWriteRequest,
  type CheckoutTarget,
  type CorePaymentAvailability,
  type CoreClient,
  type FulfillmentEvidenceContentType,
  type PublishedSeckillSessionProjection,
  type QuoteSelection,
  type WalletSession,
} from './core-client';
import { productBaseline } from './bootstrap';
import { coreApiBaseUrl } from './deployment-paths';
import {
  createSeckillRealtimeClient,
  type SeckillRealtimeClient,
  type SeckillRealtimeState,
} from './seckill-realtime';
import { createBrowserWalletGateway, type ApprovalStatus, type WalletGateway } from './wallet';

type SignedQuote = PaymentQuoteResponse | SeckillQuoteResponse;
type LoadState = 'loading' | 'ready' | 'empty' | 'error';
type CheckoutBusyKind = 'PICKUP_TARGET' | 'QUOTE' | 'PAYMENT';

export interface PickupCredentialView {
  code: string;
  idempotencyKey?: string;
  evidenceHash?: string;
  credentialId?: string;
  expiresAt: string;
  phase?: 'REGISTERING' | 'REGISTERED';
}

export type BuyerAddressDraft = Omit<BuyerAddressWriteRequest, 'expectedVersion' | 'idempotencyKey'>;

export interface MallServices {
  core: CoreClient;
  wallet: WalletGateway;
  createIdempotencyKey(): string;
  hashEvidenceFile(file: Blob): Promise<string>;
  submissionStore: SubmissionStore;
  realtime: SeckillRealtimeClient;
  walletWritesAuthorized: boolean;
  supportUrl?: string | null;
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

interface BuyerActionAttempt {
  fingerprint: string;
  uploadIdempotencyKey: string;
  evidenceIdempotencyKey: string;
  commandIdempotencyKey: string;
  uploaded: boolean;
  uploadIntent?: MediaUploadIntentProjection;
  asset?: MediaAssetProjection;
  evidence?: EvidenceEnvelopeProjection;
}

export interface MallRuntimeValue {
  bootstrap: CorePaymentAvailability | null;
  catalog: readonly CatalogProduct[];
  catalogState: LoadState;
  categories: readonly CatalogCategory[];
  tags: readonly CatalogTag[];
  taxonomyState: LoadState;
  stores: readonly MerchantStore[];
  storesState: LoadState;
  storesScope: { readonly productId: string | null };
  checkoutTarget: CheckoutTarget | null;
  seckillSession: PublishedSeckillSessionProjection | null;
  seckillSessionState: LoadState;
  seckillHistory: readonly PublishedSeckillSessionProjection[];
  seckillEvents: readonly RealtimeEventEnvelope[];
  seckillRealtimeState: SeckillRealtimeState | 'IDLE';
  seckillRealtimeError: string | null;
  selectedSeckillSessionId: string | null;
  orders: readonly FulfillmentOrder[];
  ordersState: 'idle' | LoadState;
  ordersNextCursor: FulfillmentOrderCursor | null;
  orderActions: Readonly<Record<string, readonly AllowedAction[]>>;
  orderTargets: Readonly<Record<string, FulfillmentTarget>>;
  pickupCredentials: Readonly<Record<string, PickupCredentialView>>;
  pickupCredentialErrors: Readonly<Record<string, string>>;
  orderCapabilityErrors: Readonly<Record<string, string>>;
  takeoverTimelines: Readonly<Record<string, BuyerTakeoverTimeline>>;
  takeoverTimelineErrors: Readonly<Record<string, string>>;
  fulfillmentEvidenceStatus: 'AVAILABLE';
  buyerProfile: BuyerProfile | null;
  buyerProfileState: 'idle' | LoadState;
  buyerAvatarAccess: MediaReadAccessProjection | null;
  buyerAvatarState: 'idle' | LoadState;
  buyerOverview: BuyerOverview | null;
  buyerOverviewState: 'idle' | LoadState;
  buyerAddresses: readonly BuyerSavedAddress[];
  buyerAddressesState: 'idle' | LoadState;
  shoppingStatements: readonly BuyerShoppingStatement[];
  shoppingStatementsState: 'idle' | LoadState;
  shoppingStatementsNextCursor: OrderStatementCursor | null;
  shoppingStatementsLoadingMore: boolean;
  shoppingStatementsError: string | null;
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
  checkoutBusy: CheckoutBusyKind | null;
  error: string | null;
  walletWritesAuthorized: boolean;
  supportUrl: string | null;
  supportConfigurationError: string | null;
  connectWallet(): Promise<void>;
  reloadCatalog(): Promise<void>;
  reloadTaxonomy(): Promise<void>;
  resolvePublicMedia(assetId: string, forceRefresh?: boolean): Promise<MediaReadAccessProjection>;
  reloadSeckill(): Promise<void>;
  selectSeckillSession(): boolean;
  reloadStores(regionCode?: string, productId?: string): Promise<void>;
  createPickupTarget(storeId: string): Promise<void>;
  createPickupCredential(orderId: string): Promise<void>;
  reloadOrders(): Promise<void>;
  loadMoreOrders(): Promise<void>;
  submitBuyerAction(
    orderId: string,
    action: BuyerEvidenceAction,
    input: { reasonCode: string; file: File | null },
  ): Promise<boolean>;
  reloadBuyerAccount(): Promise<void>;
  saveBuyerProfile(nickname: string, avatarFile: File | null): Promise<boolean>;
  createBuyerAddress(draft: BuyerAddressDraft): Promise<boolean>;
  updateBuyerAddress(addressId: string, draft: BuyerAddressDraft): Promise<boolean>;
  deleteBuyerAddress(addressId: string): Promise<boolean>;
  setDefaultBuyerAddress(addressId: string): Promise<boolean>;
  selectSavedAddress(addressId: string): Promise<boolean>;
  reloadShoppingStatements(): Promise<void>;
  loadMoreShoppingStatements(): Promise<void>;
  reloadSettlements(): Promise<void>;
  requestSettlement(rail: 'REWARD_NPL' | 'PRIZE_USDT', amount: string): Promise<void>;
  reloadNotifications(): Promise<void>;
  enableInAppNotifications(): Promise<void>;
  reloadCms(): Promise<void>;
  selectProduct(productId: string): void;
  selectSku(skuId: string): void;
  setQuantity(quantity: number): void;
  setFulfillmentMode(mode: 'DELIVERY' | 'PICKUP'): void;
  requestOrdinaryQuote(): Promise<boolean>;
  requestSeckillQuote(sessionId: string): Promise<boolean>;
  broadcastPayment(acknowledgeUnlimitedApproval: boolean, acknowledgeSeckillFallback: boolean): Promise<void>;
  retrySubmission(): Promise<void>;
  recoverPaymentSubmission(orderId: string, txHash: string, replacementForTxHash?: string): Promise<void>;
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
  const [categories, setCategories] = useState<readonly CatalogCategory[]>([]);
  const [tags, setTags] = useState<readonly CatalogTag[]>([]);
  const [taxonomyState, setTaxonomyState] = useState<LoadState>('loading');
  const [stores, setStores] = useState<readonly MerchantStore[]>([]);
  const [storesState, setStoresState] = useState<LoadState>('loading');
  const [storesScope, setStoresScope] = useState<{ readonly productId: string | null }>({ productId: null });
  const storeListRequestId = useRef(0);
  const [checkoutTarget, setCheckoutTarget] = useState<CheckoutTarget | null>(null);
  const [seckillSession, setSeckillSession] = useState<PublishedSeckillSessionProjection | null>(null);
  const [seckillSessionState, setSeckillSessionState] = useState<LoadState>('loading');
  const [seckillHistory, setSeckillHistory] = useState<readonly PublishedSeckillSessionProjection[]>([]);
  const [seckillEvents, setSeckillEvents] = useState<readonly RealtimeEventEnvelope[]>([]);
  const [seckillRealtimeState, setSeckillRealtimeState] = useState<SeckillRealtimeState | 'IDLE'>('IDLE');
  const [seckillRealtimeError, setSeckillRealtimeError] = useState<string | null>(null);
  const [selectedSeckillSessionId, setSelectedSeckillSessionId] = useState<string | null>(null);
  const [orders, setOrders] = useState<readonly FulfillmentOrder[]>([]);
  const [ordersState, setOrdersState] = useState<'idle' | LoadState>('idle');
  const [ordersNextCursor, setOrdersNextCursor] = useState<FulfillmentOrderCursor | null>(null);
  const [orderActions, setOrderActions] = useState<Readonly<Record<string, readonly AllowedAction[]>>>({});
  const [orderTargets, setOrderTargets] = useState<Readonly<Record<string, FulfillmentTarget>>>({});
  const [pickupCredentials, setPickupCredentials] = useState<Readonly<Record<string, PickupCredentialView>>>({});
  const [pickupCredentialErrors, setPickupCredentialErrors] = useState<Readonly<Record<string, string>>>({});
  const [orderCapabilityErrors, setOrderCapabilityErrors] = useState<Readonly<Record<string, string>>>({});
  const [takeoverTimelines, setTakeoverTimelines] = useState<Readonly<Record<string, BuyerTakeoverTimeline>>>({});
  const [takeoverTimelineErrors, setTakeoverTimelineErrors] = useState<Readonly<Record<string, string>>>({});
  const [buyerProfile, setBuyerProfile] = useState<BuyerProfile | null>(null);
  const [buyerProfileState, setBuyerProfileState] = useState<'idle' | LoadState>('idle');
  const [buyerAvatarAccess, setBuyerAvatarAccess] = useState<MediaReadAccessProjection | null>(null);
  const [buyerAvatarState, setBuyerAvatarState] = useState<'idle' | LoadState>('idle');
  const [buyerOverview, setBuyerOverview] = useState<BuyerOverview | null>(null);
  const [buyerOverviewState, setBuyerOverviewState] = useState<'idle' | LoadState>('idle');
  const [buyerAddresses, setBuyerAddresses] = useState<readonly BuyerSavedAddress[]>([]);
  const [buyerAddressesState, setBuyerAddressesState] = useState<'idle' | LoadState>('idle');
  const [shoppingStatements, setShoppingStatements] = useState<readonly BuyerShoppingStatement[]>([]);
  const [shoppingStatementsState, setShoppingStatementsState] = useState<'idle' | LoadState>('idle');
  const [shoppingStatementsNextCursor, setShoppingStatementsNextCursor] = useState<OrderStatementCursor | null>(null);
  const [shoppingStatementsLoadingMore, setShoppingStatementsLoadingMore] = useState(false);
  const [shoppingStatementsError, setShoppingStatementsError] = useState<string | null>(null);
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
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const [submittedTxHash, setSubmittedTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<CheckoutBusyKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const broadcastInFlight = useRef(false);
  const walletConnectionAttempt = useRef(0);
  const quoteRequest = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const quoteApprovalInspection = useRef(0);
  const notificationRequestGeneration = useRef(0);
  const buyerActionAttempts = useRef(new Map<string, BuyerActionAttempt>());
  const mediaAccessCache = useRef(new Map<string, MediaReadAccessProjection>());
  const mediaAccessInFlight = useRef(new Map<string, Promise<MediaReadAccessProjection>>());

  const selectedProduct = catalog.find((product) => product.productId === selectedProductId) ?? null;
  const selectedSku = selectedProduct?.skus.find((sku) => sku.skuId === selectedSkuId) ?? null;
  const supportConfiguration = validateSupportUrl(services.supportUrl);

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
    void loadTaxonomy()
      .catch(() => {
        if (active) setTaxonomyState('error');
      });
    return () => { active = false; };

    async function loadTaxonomy() {
      const [nextCategories, nextTags] = await Promise.all([
        services.core.listCatalogCategories(),
        services.core.listCatalogTags(),
      ]);
      if (!active) return;
      setCategories(nextCategories);
      setTags(nextTags);
      setTaxonomyState(nextCategories.length > 0 || nextTags.length > 0 ? 'ready' : 'empty');
    }
  }, [services]);

  useEffect(() => {
    mediaAccessCache.current.clear();
    mediaAccessInFlight.current.clear();
  }, [services, session?.walletAddress]);

  useEffect(() => {
    let active = true;
    void loadSeckillSurface(() => active, false).catch((reason: unknown) => {
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
    const requestId = ++storeListRequestId.current;
    void services.core.listStores()
      .then((nextStores) => {
        if (!active || requestId !== storeListRequestId.current) return;
        setStores(nextStores);
        setStoresScope({ productId: null });
        setStoresState(nextStores.length > 0 ? 'ready' : 'empty');
      })
      .catch(() => {
        if (!active || requestId !== storeListRequestId.current) return;
        setStores([]);
        setStoresScope({ productId: null });
        setStoresState('error');
      });
    return () => { active = false; };
  }, [services]);

  useEffect(() => {
    if (!selectedProduct || fulfillmentMode !== 'PICKUP') return;
    let active = true;
    const requestId = ++storeListRequestId.current;
    setStores([]);
    setStoresState('loading');
    void services.core.listStores(undefined, selectedProduct.productId)
      .then((nextStores) => {
        if (!active || requestId !== storeListRequestId.current) return;
        setStores(nextStores);
        setStoresScope({ productId: selectedProduct.productId });
        setStoresState(nextStores.length > 0 ? 'ready' : 'empty');
      })
      .catch(() => {
        if (!active || requestId !== storeListRequestId.current) return;
        setStores([]);
        setStoresScope({ productId: selectedProduct.productId });
        setStoresState('error');
      });
    return () => { active = false; };
  }, [fulfillmentMode, selectedProduct?.productId, services]);

  const value = useMemo<MallRuntimeValue>(() => ({
    bootstrap,
    catalog,
    catalogState,
    categories,
    tags,
    taxonomyState,
    stores,
    storesState,
    storesScope,
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
    ordersNextCursor,
    orderActions,
    orderTargets,
    pickupCredentials,
    pickupCredentialErrors,
    orderCapabilityErrors,
    takeoverTimelines,
    takeoverTimelineErrors,
    fulfillmentEvidenceStatus: 'AVAILABLE',
    buyerProfile,
    buyerProfileState,
    buyerAvatarAccess,
    buyerAvatarState,
    buyerOverview,
    buyerOverviewState,
    buyerAddresses,
    buyerAddressesState,
    shoppingStatements,
    shoppingStatementsState,
    shoppingStatementsNextCursor,
    shoppingStatementsLoadingMore,
    shoppingStatementsError,
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
    checkoutBusy,
    error,
    walletWritesAuthorized: services.walletWritesAuthorized,
    supportUrl: supportConfiguration.url,
    supportConfigurationError: supportConfiguration.error,

    async connectWallet() {
      let postLoginAttempt: number | null = null;
      let postLoginSession: WalletSession | null = null;
      await run(async () => {
        const connectionAttempt = ++walletConnectionAttempt.current;
        const walletAddress = await services.wallet.connect();
        const cachedSession = loadCachedWalletSession(walletAddress);
        const signMessage = (message: string) => services.wallet.signMessage(message);
        let nextSession = cachedSession ?? await services.core.authenticate(walletAddress, signMessage);
        if (connectionAttempt !== walletConnectionAttempt.current) return;
        if (!nextSession.roles.includes('BUYER')) throw new CoreClientError('Forbidden', '当前钱包没有购买权限');
        if (!cachedSession) saveCachedWalletSession(nextSession);
        let products: readonly CatalogProduct[];
        try {
          products = await services.core.listCatalog(nextSession.token);
        } catch (error) {
          if (!cachedSession || !isWalletSessionAuthFailure(error)) throw error;
          clearCachedWalletSession(walletAddress);
          nextSession = await services.core.authenticate(walletAddress, signMessage);
          if (connectionAttempt !== walletConnectionAttempt.current) return;
          if (!nextSession.roles.includes('BUYER')) throw new CoreClientError('Forbidden', '当前钱包没有购买权限');
          saveCachedWalletSession(nextSession);
          products = await services.core.listCatalog(nextSession.token);
        }
        resetAuthenticatedState();
        const recovered = services.submissionStore.load(nextSession.walletAddress);
        rememberPendingSubmission(recovered);
        setSubmittedTxHash(recovered?.txHash ?? null);
        setSession(nextSession);
        setPickupCredentials(loadCachedPickupCredentials(nextSession.walletAddress));
        setCatalog(products);
        setCatalogState(products.length > 0 ? 'ready' : 'empty');
        postLoginAttempt = connectionAttempt;
        postLoginSession = nextSession;
      });
      if (!postLoginSession || postLoginAttempt === null) return;
      void loadAuthenticatedBundlesAfterLogin(postLoginSession, postLoginAttempt);
    },

    async reloadCatalog() {
      setCatalogState('loading');
      await run(async () => {
        const products = await services.core.listCatalog(session?.token);
        setCatalog(products);
        setCatalogState(products.length > 0 ? 'ready' : 'empty');
      }, () => setCatalogState('error'));
    },

    async reloadTaxonomy() {
      setTaxonomyState('loading');
      await run(async () => {
        const [nextCategories, nextTags] = await Promise.all([
          services.core.listCatalogCategories(),
          services.core.listCatalogTags(),
        ]);
        setCategories(nextCategories);
        setTags(nextTags);
        setTaxonomyState(nextCategories.length > 0 || nextTags.length > 0 ? 'ready' : 'empty');
      }, () => setTaxonomyState('error'));
    },

    resolvePublicMedia,

    async reloadSeckill() {
      setCatalogState('loading');
      await run(async () => {
        const [products] = await Promise.all([
          services.core.listCatalog(session?.token),
          loadSeckillSurface(() => true),
        ]);
        setCatalog(products);
        setCatalogState(products.length > 0 ? 'ready' : 'empty');
      }, () => setCatalogState('error'));
    },

    selectSeckillSession() {
      if (pendingSubmission) {
        setError('当前付款凭证尚未提交给系统，请先恢复跟踪');
        return false;
      }
      if (!seckillSession) {
        setError('当前没有已发布的秒杀场次');
        return false;
      }
      if (seckillSession.phase !== 'LIVE' || BigInt(seckillSession.inventory.available) === 0n) {
        setError('系统当前场次阶段或库存不允许创建秒杀订单');
        return false;
      }
      const product = catalog.find((item) => item.productId === seckillSession.product.productId);
      const sku = product?.skus.find((item) => item.skuId === seckillSession.product.skuId);
      if (!product || !sku || sku.seckill?.sessionId.toLowerCase() !== seckillSession.sessionId.toLowerCase()
        || sku.seckill.phase !== 'LIVE') {
        setError('秒杀商品与当前可售目录 overlay 不一致，已停止进入结算');
        return false;
      }
      setSelectedProductId(product.productId);
      setSelectedSkuId(sku.skuId);
      setSelectedSeckillSessionId(seckillSession.sessionId);
      setQuantityState(1);
      clearPaymentState();
      return true;
    },

    async reloadStores(regionCode, productId) {
      const requestId = ++storeListRequestId.current;
      setStoresState('loading');
      await run(async () => {
        const nextStores = await services.core.listStores(regionCode, productId);
        if (requestId !== storeListRequestId.current) return;
        setStores(nextStores);
        setStoresScope({ productId: productId ?? null });
        setStoresState(nextStores.length > 0 ? 'ready' : 'empty');
      }, () => {
        if (requestId !== storeListRequestId.current) return;
        setStores([]);
        setStoresScope({ productId: productId ?? null });
        setStoresState('error');
      });
    },

    async createPickupTarget(storeId) {
      setCheckoutBusy('PICKUP_TARGET');
      try {
        await run(async () => {
          const activeSession = requireSession();
          if (selectedProduct && storesScope.productId !== selectedProduct.productId) {
            throw new CoreClientError('InvalidRequest', '请先读取当前商品的自提门店');
          }
          const store = stores.find((item) => item.storeId === storeId && item.status === 'ACTIVE');
          if (!store) throw new CoreClientError('InvalidRequest', '请选择当前可用门店');
          const target = await services.core.createPickupTarget(activeSession.token, {
            idempotencyKey: services.createIdempotencyKey(),
            storeId: store.storeId,
          });
          assertPickupTargetMatchesStore(target, store);
          setCheckoutTarget({
            fulfillmentMode: target.fulfillmentMode,
            fulfillmentTargetHash: target.targetHash,
            regionCodeHash: target.regionCodeHash,
            label: `${target.store.name} · ${target.store.address}`,
            review: { kind: 'PICKUP', store: target.store },
          });
          clearQuoteState();
        });
      } finally {
        setCheckoutBusy(null);
      }
    },


    async createPickupCredential(orderId) {
      setBusy(true);
      setError(null);
      const credentialKey = pickupCredentialOrderKey(orderId);
      setPickupCredentialErrors((current) => omitRecordKey(current, credentialKey));
      let activeSession = requireSession();
      let order = orders.find((item) => item.orderId === orderId);
      try {
        activeSession = await ensureFreshBuyerSession(activeSession);
        order = orders.find((item) => item.orderId === orderId);
        if (!order || order.buyerWallet.toLowerCase() !== activeSession.walletAddress.toLowerCase()) {
          throw new CoreClientError('Forbidden', '订单与当前买家钱包不一致');
        }
        if (order.fulfillmentMode !== 'PICKUP' || order.state !== 'PAID') {
          throw new CoreClientError('UnknownState', '只有已付款的自提订单才能生成核销码');
        }
        const allowed = orderActions[orderId]?.find((item) => item.action === 'REGISTER_PICKUP_CREDENTIAL');
        const currentCredential = pickupCredentials[credentialKey];
        const canRetryRegistering = currentCredential?.phase === 'REGISTERING'
          && currentCredential.idempotencyKey
          && currentCredential.evidenceHash;
        if (!allowed?.enabled && !canRetryRegistering) {
          throw new CoreClientError('Forbidden', '系统当前不允许生成新的自提核销码');
        }
        const request = canRetryRegistering
          ? {
              idempotencyKey: currentCredential.idempotencyKey!,
              evidenceHash: currentCredential.evidenceHash!,
              code: currentCredential.code,
              expiresAt: currentCredential.expiresAt,
            }
          : {
              idempotencyKey: services.createIdempotencyKey(),
              evidenceHash: randomBytes32(),
              code: randomPickupCode(),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            };
        const registeringCredential: PickupCredentialView = { ...request, phase: 'REGISTERING' };
        saveCachedPickupCredential(activeSession.walletAddress, order.orderId, registeringCredential);
        setPickupCredentials((current) => ({ ...current, [credentialKey]: registeringCredential }));
        let result: Awaited<ReturnType<CoreClient['registerPickupCredential']>>;
        try {
          result = await services.core.registerPickupCredential(activeSession.token, order.orderId, request);
        } catch (reason) {
          if (!isWalletSessionAuthFailure(reason)) throw reason;
          clearCachedWalletSession(activeSession.walletAddress);
          activeSession = await refreshBuyerSession(activeSession.walletAddress);
          result = await services.core.registerPickupCredential(activeSession.token, order.orderId, request);
        }
        const credential: PickupCredentialView = {
          code: request.code,
          credentialId: result.credentialId,
          expiresAt: result.expiresAt,
          phase: 'REGISTERED',
        };
        saveCachedPickupCredential(activeSession.walletAddress, order.orderId, credential);
        setPickupCredentials((current) => ({ ...current, [credentialKey]: credential }));
        setPickupCredentialErrors((current) => omitRecordKey(current, credentialKey));
        await loadOrderBundle(activeSession);
      } catch (reason) {
        if (order && isDefinitivePickupCredentialRejection(reason)) {
          removeCachedPickupCredential(activeSession.walletAddress, order.orderId);
          setPickupCredentials((current) => omitRecordKey(current, credentialKey));
        }
        const message = errorMessage(reason);
        setError(message);
        setPickupCredentialErrors((current) => ({ ...current, [credentialKey]: pickupCredentialErrorMessage(reason, message) }));
      } finally {
        setBusy(false);
      }
    },

    async reloadOrders() {
      await run(async () => loadOrderBundle(requireSession()), () => setOrdersState('error'));
    },

    async loadMoreOrders() {
      if (!ordersNextCursor) return;
      await run(async () => loadOrderBundle(requireSession(), ordersNextCursor));
    },

    async submitBuyerAction(orderId, action, input) {
      setBusy(true);
      setError(null);
      try {
        const activeSession = requireSession();
        const order = orders.find((item) => item.orderId === orderId);
        if (!order || order.buyerWallet.toLowerCase() !== activeSession.walletAddress.toLowerCase()) {
          throw new CoreClientError('Forbidden', '订单与当前买家钱包不一致');
        }
        const allowed = orderActions[orderId]?.find((item) => item.action === action);
        if (!allowed?.enabled) throw new CoreClientError('Forbidden', '系统当前不允许该订单操作');
        const reasonCode = validateEvidenceReasonCode(input.reasonCode);
        const file = input.file;
        const fileHash = file ? await evidenceFileHash(file) : null;
        const attemptKey = `${orderId.toLowerCase()}:${action}`;
        const fingerprint = file
          ? `${action}:${reasonCode}:${file.type}:${file.size}:${fileHash}`
          : `${action}:${reasonCode}:NO_MEDIA`;
        let attempt = buyerActionAttempts.current.get(attemptKey);
        if (!attempt || attempt.fingerprint !== fingerprint) {
          attempt = {
            fingerprint,
            uploadIdempotencyKey: services.createIdempotencyKey(),
            evidenceIdempotencyKey: services.createIdempotencyKey(),
            commandIdempotencyKey: services.createIdempotencyKey(),
            uploaded: false,
          };
          buyerActionAttempts.current.set(attemptKey, attempt);
        }

        const mediaAssetIds: string[] = [];
        if (file && fileHash) {
          const contentType = evidenceContentType(file.type);
          attempt.uploadIntent ??= await services.core.createMediaUploadIntent(activeSession.token, {
            purpose: 'FULFILLMENT_EVIDENCE',
            resourceType: 'ORDER',
            resourceId: order.orderId,
            contentType,
            sizeBytes: file.size,
            contentSha256: fileHash,
            idempotencyKey: attempt.uploadIdempotencyKey,
          });
          assertUploadIntentForBuyer(attempt.uploadIntent, activeSession, order, file, fileHash);
          if (!attempt.uploaded) {
            await services.core.uploadMediaFile(attempt.uploadIntent, file);
            attempt.uploaded = true;
          }
          attempt.asset ??= await services.core.completeMediaUpload(
            activeSession.token,
            attempt.uploadIntent.uploadIntentId,
          );
          assertMediaAssetForBuyer(attempt.asset, activeSession, order, file, fileHash);
          mediaAssetIds.push(attempt.asset.assetId);
        }

        attempt.evidence ??= await services.core.createOrderActionEvidence(activeSession.token, order.orderId, {
          action,
          reasonCode,
          ...(mediaAssetIds.length > 0 ? { mediaAssetIds } : {}),
          idempotencyKey: attempt.evidenceIdempotencyKey,
        });
        if (
          attempt.evidence.ownerWallet.toLowerCase() !== activeSession.walletAddress.toLowerCase()
          || attempt.evidence.resourceId !== order.orderId
          || attempt.evidence.action !== action
          || attempt.evidence.reasonCode !== reasonCode
        ) throw new CoreClientError('InvalidResponse', '系统凭证与当前买家操作不一致');

        const command = {
          idempotencyKey: attempt.commandIdempotencyKey,
          evidenceHash: attempt.evidence.evidenceHash,
        };
        if (action === 'REQUEST_EXCHANGE') {
          await services.core.requestExchange(activeSession.token, order.orderId, { ...command, reasonCode });
        } else if (action === 'REQUEST_DELAY') {
          await services.core.requestDelay(activeSession.token, order.orderId, { ...command, reasonCode });
        } else if (action === 'OPEN_ARBITRATION') {
          await services.core.openArbitration(activeSession.token, order.orderId, { ...command, reasonCode });
        } else {
          await services.core.confirmReceipt(activeSession.token, order.orderId, command);
        }
        await loadOrderBundle(activeSession);
        buyerActionAttempts.current.delete(attemptKey);
        return true;
      } catch (reason) {
        setError(errorMessage(reason));
        return false;
      } finally {
        setBusy(false);
      }
    },

    async reloadBuyerAccount() {
      await run(async () => loadBuyerAccountBundle(requireSession()), () => {
        setBuyerProfileState('error');
        setBuyerOverviewState('error');
        setBuyerAddressesState('error');
      });
    },

    async saveBuyerProfile(nickname, avatarFile) {
      setBusy(true);
      setError(null);
      try {
        const activeSession = requireSession();
        const current = buyerProfile;
        if (!current) throw new CoreClientError('UnknownState', '买家资料尚未同步');
        const normalizedNickname = nickname.trim() || null;
        if (normalizedNickname && normalizedNickname.length > 40) {
          throw new CoreClientError('InvalidRequest', '昵称最多 40 个字符');
        }
        let avatarAssetId = current.avatarAssetId;
        if (avatarFile) {
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(avatarFile.type) || avatarFile.size < 1 || avatarFile.size > 10_485_760) {
            throw new CoreClientError('InvalidRequest', '头像仅支持 JPG、PNG 或 WebP，且不超过 10 MB');
          }
          const contentSha256 = await services.hashEvidenceFile(avatarFile);
          if (!/^0x[0-9a-fA-F]{64}$/.test(contentSha256)) {
            throw new CoreClientError('InvalidResponse', '本地头像文件哈希无效');
          }
          const intent = await services.core.createMediaUploadIntent(activeSession.token, {
            purpose: 'BUYER_AVATAR',
            resourceType: 'BUYER',
            resourceId: activeSession.walletAddress.toLowerCase(),
            contentType: avatarFile.type as 'image/jpeg' | 'image/png' | 'image/webp',
            sizeBytes: avatarFile.size,
            contentSha256,
            idempotencyKey: services.createIdempotencyKey(),
          });
          assertBuyerAvatarUpload(intent, activeSession, avatarFile, contentSha256);
          await services.core.uploadMediaFile(intent, avatarFile);
          const asset = await services.core.completeMediaUpload(activeSession.token, intent.uploadIntentId);
          assertBuyerAvatarAsset(asset, activeSession, avatarFile, contentSha256);
          avatarAssetId = asset.assetId;
        }
        const next = await services.core.updateBuyerProfile(activeSession.token, {
          nickname: normalizedNickname,
          avatarAssetId,
          expectedVersion: current.version,
          idempotencyKey: services.createIdempotencyKey(),
        });
        assertBuyerProjectionWallet(next.wallet, activeSession);
        setBuyerProfile(next);
        setBuyerProfileState('ready');
        await loadBuyerAvatar(activeSession, next).catch(() => undefined);
        return true;
      } catch (reason) {
        setBuyerProfileState('error');
        setError(errorMessage(reason));
        return false;
      } finally {
        setBusy(false);
      }
    },

    async createBuyerAddress(draft) {
      setBusy(true);
      setError(null);
      try {
        const activeSession = requireSession();
        const created = await services.core.createBuyerAddress(activeSession.token, {
          ...draft,
          label: draft.label.trim(),
          recipientName: draft.recipientName.trim(),
          province: draft.province.trim(),
          city: draft.city.trim(),
          district: draft.district.trim(),
          detailAddress: draft.detailAddress.trim(),
          regionCode: draft.regionCode.trim(),
          longitude: null,
          latitude: null,
          idempotencyKey: services.createIdempotencyKey(),
        });
        setBuyerAddresses((current) => [created, ...current.filter((item) => item.addressId !== created.addressId)]);
        setBuyerAddressesState('ready');
        await loadBuyerAddresses(activeSession);
        return true;
      } catch (reason) {
        setBuyerAddressesState('error');
        setError(errorMessage(reason));
        return false;
      } finally {
        setBusy(false);
      }
    },

    async updateBuyerAddress(addressId, draft) {
      return writeSavedAddress(async (activeSession, current) => {
        await services.core.updateBuyerAddress(activeSession.token, addressId, {
          ...draft,
          expectedVersion: current.version,
          idempotencyKey: services.createIdempotencyKey(),
        });
      }, addressId);
    },

    async deleteBuyerAddress(addressId) {
      return writeSavedAddress(async (activeSession, current) => {
        await services.core.deleteBuyerAddress(
          activeSession.token,
          addressId,
          current.version,
          services.createIdempotencyKey(),
        );
      }, addressId);
    },

    async setDefaultBuyerAddress(addressId) {
      return writeSavedAddress(async (activeSession, current) => {
        await services.core.setDefaultBuyerAddress(
          activeSession.token,
          addressId,
          current.version,
          services.createIdempotencyKey(),
        );
      }, addressId);
    },

    async selectSavedAddress(addressId) {
      setBusy(true);
      setError(null);
      try {
        const activeSession = requireSession();
        const address = requireBuyerAddress(addressId);
        const target = await services.core.createBuyerAddressTarget(
          activeSession.token,
          address.addressId,
          services.createIdempotencyKey(),
        );
        setCheckoutTarget({
          fulfillmentMode: 'DELIVERY',
          fulfillmentTargetHash: target.targetHash,
          regionCodeHash: target.regionCodeHash,
          label: `${address.recipientName} · ${address.formattedAddress}`,
          review: { kind: 'DELIVERY', address },
        });
        setFulfillmentModeState('DELIVERY');
        clearQuoteState();
        return true;
      } catch (reason) {
        setError(errorMessage(reason));
        return false;
      } finally {
        setBusy(false);
      }
    },

    async reloadShoppingStatements() {
      await run(async () => loadShoppingStatementBundle(requireSession()));
    },

    async loadMoreShoppingStatements() {
      if (!shoppingStatementsNextCursor || shoppingStatementsLoadingMore) return;
      await run(async () => loadShoppingStatementBundle(requireSession(), shoppingStatementsNextCursor));
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
        const requestGeneration = notificationRequestGeneration.current;
        const endpoint = await services.core.registerNotificationEndpoint(activeSession.token, {
          channel: 'IN_APP',
          provider: 'CORE',
          endpointReference: `recipient://wallet/${activeSession.walletAddress.toLowerCase()}`,
          topics: ['*'],
        });
        if (requestGeneration !== notificationRequestGeneration.current) return;
        setNotificationEndpoint(endpoint);
        await loadNotificationBundle(activeSession);
      });
    },

    async reloadCms() {
      await run(async () => loadCms(session?.token), () => setCmsState('error'));
    },

    selectProduct(productId) {
      if (pendingSubmission) return setError('当前付款凭证尚未提交给系统，请先恢复跟踪');
      const product = catalog.find((item) => item.productId === productId);
      setSelectedProductId(product?.productId ?? null);
      setSelectedSkuId(product ? firstOrdinaryPurchasableSkuId(product) : null);
      setSelectedSeckillSessionId(null);
      if (checkoutTarget?.fulfillmentMode === 'PICKUP') setCheckoutTarget(null);
      const nextFulfillmentMode = product?.fulfillmentModes.includes(fulfillmentMode)
        ? fulfillmentMode
        : product?.fulfillmentModes[0];
      if (nextFulfillmentMode === 'PICKUP') {
        setStores([]);
        setStoresState('loading');
      }
      if (product && !product.fulfillmentModes.includes(fulfillmentMode)) {
        setFulfillmentModeState(product.fulfillmentModes[0]!);
        setCheckoutTarget(null);
      }
      setQuantityState(1);
      clearPaymentState();
    },

    selectSku(skuId) {
      if (pendingSubmission) return setError('当前付款凭证尚未提交给系统，请先恢复跟踪');
      if (selectedSeckillSessionId && skuId !== seckillSession?.product.skuId) {
        return setError('秒杀订单只能使用当前场次绑定的规格');
      }
      const sku = selectedProduct?.skus.find((item) => item.skuId === skuId);
      if (sku?.seckill && !selectedSeckillSessionId) {
        return setError(`该规格处于${sku.seckill.phase}活动阶段，普通结算已停用`);
      }
      setSelectedSkuId(sku?.skuId ?? null);
      clearPaymentState();
    },

    setQuantity(nextQuantity) {
      if (pendingSubmission) return setError('当前付款凭证尚未提交给系统，请先恢复跟踪');
      setQuantityState(Math.max(1, Math.floor(nextQuantity)));
      clearPaymentState();
    },

    setFulfillmentMode(mode) {
      if (pendingSubmission) return setError('当前付款凭证尚未提交给系统，请先恢复跟踪');
      if (selectedProduct && !selectedProduct.fulfillmentModes.includes(mode)) {
        return setError('该商品未发布当前履约方式');
      }
      setFulfillmentModeState(mode);
      if (mode === 'PICKUP') {
        setStores([]);
        setStoresState('loading');
      }
      if (checkoutTarget?.fulfillmentMode !== mode) setCheckoutTarget(null);
      clearPaymentState();
    },

    async requestOrdinaryQuote() {
      let success = false;
      setCheckoutBusy('QUOTE');
      try {
        await run(async () => {
          const productSnapshot = selectedProduct;
          const skuSnapshot = selectedSku;
          const selection = await buildSelection();
          const nextQuote = await services.core.createOrdinaryQuote(requireSession().token, selection);
          assertQuoteMatchesSelection(nextQuote, selection, productSnapshot, skuSnapshot, null);
          setQuote(nextQuote);
          setProjection(null);
          setSubmittedTxHash(null);
          inspectQuoteApprovals(nextQuote);
          success = true;
        });
      } finally {
        setCheckoutBusy(null);
      }
      return success;
    },

    async requestSeckillQuote(sessionId) {
      let success = false;
      setCheckoutBusy('QUOTE');
      try {
        await run(async () => {
          if (sessionId !== selectedSeckillSessionId
            || sessionId !== seckillSession?.sessionId
            || seckillSession.phase !== 'LIVE') {
            throw new CoreClientError('InvalidRequest', '秒杀场次选择已失效，请返回大厅重新同步');
          }
          if (!selectedSku?.seckill) {
            throw new CoreClientError('InventoryUnavailable', '本场已抢完，请返回秒杀大厅查看下一场。');
          }
          const seckillAvailable = minBigInt(
            BigInt(seckillSession.inventory.available),
            BigInt(selectedSku.seckill.inventory.available),
            BigInt(selectedSku.stockAvailable),
          );
          if (seckillAvailable === 0n) {
            throw new CoreClientError('InventoryUnavailable', '本场已抢完，请返回秒杀大厅查看下一场。');
          }
          if (seckillAvailable < BigInt(quantity)) {
            throw new CoreClientError('InventoryUnavailable', '本场剩余库存不足，请减少购买数量。');
          }
          const productSnapshot = selectedProduct;
          const skuSnapshot = selectedSku;
          const selection = await buildSelection();
          const nextQuote = await services.core.createSeckillQuote(requireSession().token, sessionId, selection);
          assertQuoteMatchesSelection(nextQuote, selection, productSnapshot, skuSnapshot, sessionId);
          setQuote(nextQuote);
          setProjection(null);
          setSubmittedTxHash(null);
          inspectQuoteApprovals(nextQuote);
          success = true;
        });
      } finally {
        setCheckoutBusy(null);
      }
      return success;
    },

    async broadcastPayment(acknowledgeUnlimitedApproval, acknowledgeSeckillFallback) {
      if (broadcastInFlight.current) return;
      broadcastInFlight.current = true;
      setCheckoutBusy('PAYMENT');
      try {
        await run(async () => {
          const activeQuote = requireQuote();
          if (submittedTxHash) throw new CoreClientError('IdempotencyConflict', '当前付款已提交钱包，只能恢复付款凭证或刷新支付状态');
          if ('dual' in activeQuote && !acknowledgeSeckillFallback) {
            throw new CoreClientError('InvalidRequest', '请先确认秒杀与日常备用报价及链上分类规则');
          }
          const latestBootstrap = await services.core.getBootstrap();
          setBootstrap(latestBootstrap);
          if (!latestBootstrap.writesEnabled) {
            throw new CoreClientError('ExternalBlocked', '当前系统暂不支持新支付');
          }
          if (!services.walletWritesAuthorized) {
            throw new CoreClientError('ExternalBlocked', '当前支付上线开关未打开，不会发起钱包交易');
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
          rememberPendingSubmission(submission);
          await submitAndRefresh(submission);
        });
      } finally {
        setCheckoutBusy(null);
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

    async recoverPaymentSubmission(orderId, txHash, replacementForTxHash) {
      await run(async () => {
        const activeSession = requireSession();
        const normalizedOrderId = normalizeBytes32Input(orderId, '订单号');
        const normalizedTxHash = normalizeBytes32Input(txHash, '钱包交易编号');
        const typedReplacement = replacementForTxHash?.trim()
          ? normalizeBytes32Input(replacementForTxHash, '原交易编号')
          : undefined;
        const automaticReplacement = pendingSubmission
          && pendingSubmission.orderId.toLowerCase() === normalizedOrderId
          && pendingSubmission.txHash.toLowerCase() !== normalizedTxHash
          ? pendingSubmission.txHash.toLowerCase()
          : undefined;
        const normalizedReplacement = typedReplacement ?? automaticReplacement;
        if (normalizedReplacement && normalizedReplacement === normalizedTxHash) {
          throw new CoreClientError('InvalidRequest', '新交易编号不能和原交易编号一样');
        }
        const submission: PendingSubmission = {
          artifactVersion: productBaseline.coreArtifacts,
          chainId: productBaseline.chainId,
          walletAddress: activeSession.walletAddress.toLowerCase(),
          phase: 'PENDING_CORE_SUBMISSION',
          orderId: normalizedOrderId,
          txHash: normalizedTxHash,
          ...(normalizedReplacement ? { replacementForTxHash: normalizedReplacement } : {}),
        };
        services.submissionStore.save(submission);
        setSubmittedTxHash(normalizedTxHash);
        rememberPendingSubmission(submission);
        await submitAndRefresh(submission);
        await loadOrderBundle(activeSession).catch(() => undefined);
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
        const activeQuote = requireQuote();
        const requirement = activeQuote.approvalRequirements[index];
        if (!requirement) throw new CoreClientError('InvalidRequest', '授权记录不存在');
        quoteApprovalInspection.current += 1;
        await services.wallet.revokeApproval(requirement);
        inspectQuoteApprovals(activeQuote, { clearBeforeRead: false });
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
    checkoutBusy,
    catalog,
    catalogState,
    categories,
    checkoutTarget,
    error,
    fulfillmentMode,
    seckillSession,
    seckillSessionState,
    seckillHistory,
    seckillEvents,
    seckillRealtimeState,
    seckillRealtimeError,
    selectedSeckillSessionId,
    orderActions,
    orderCapabilityErrors,
    takeoverTimelines,
    takeoverTimelineErrors,
    orders,
    ordersNextCursor,
    ordersState,
    orderTargets,
    buyerProfile,
    buyerProfileState,
    buyerAvatarAccess,
    buyerAvatarState,
    buyerOverview,
    buyerOverviewState,
    buyerAddresses,
    buyerAddressesState,
    shoppingStatements,
    shoppingStatementsState,
    shoppingStatementsNextCursor,
    shoppingStatementsLoadingMore,
    shoppingStatementsError,
    settlements,
    settlementsState,
    notifications,
    notificationsState,
    notificationEndpoint,
    pickupCredentials,
    pickupCredentialErrors,
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
    storesScope,
    storesState,
    submittedTxHash,
    tags,
    taxonomyState,
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

  async function loadAuthenticatedBundlesAfterLogin(activeSession: WalletSession, connectionAttempt: number) {
    const isCurrent = () => connectionAttempt === walletConnectionAttempt.current;
    if (!isCurrent()) return;
    await loadAuthenticatedBundles(activeSession, isCurrent);
    if (!isCurrent()) return;
    await loadCms(activeSession.token, isCurrent).catch(() => {
      if (isCurrent()) setCmsState('error');
    });
  }

  function resolvePublicMedia(assetId: string, forceRefresh = false) {
    const key = assetId.toLowerCase();
    const cached = mediaAccessCache.current.get(key);
    if (!forceRefresh && cached && Date.parse(cached.expiresAt) > Date.now() + 30_000) return Promise.resolve(cached);
    const pending = mediaAccessInFlight.current.get(key);
    if (pending) return pending;
    const request = services.core.createPublicMediaReadAccess(key).catch((reason: unknown) => {
      if (session && reason instanceof CoreClientError && reason.code === 'Forbidden') {
        return services.core.createAuthenticatedMediaReadAccess(session.token, key);
      }
      throw reason;
    });
    const tracked = request
      .then((access) => {
        mediaAccessCache.current.set(key, access);
        return access;
      })
      .finally(() => mediaAccessInFlight.current.delete(key));
    mediaAccessInFlight.current.set(key, tracked);
    return tracked;
  }

  async function evidenceFileHash(file: File) {
    evidenceContentType(file.type);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 10_485_760) {
      throw new CoreClientError('InvalidRequest', '证据文件必须小于或等于 10 MB');
    }
    const hash = await services.hashEvidenceFile(file);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new CoreClientError('InvalidResponse', '本地证据文件哈希无效');
    }
    return hash.toLowerCase();
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
    if (!selectedProduct || !selectedSku) throw new CoreClientError('InvalidRequest', '请选择商品和规格');
    if (!selectedProduct.fulfillmentModes.includes(fulfillmentMode)) {
      throw new CoreClientError('InvalidRequest', '该商品未发布当前履约方式');
    }
    if (selectedSku.seckill && !selectedSeckillSessionId) {
      throw new CoreClientError('SeckillOnlyProduct', '该规格正在活动阶段，普通结算已停用');
    }
    if (selectedSeckillSessionId) {
      if (!selectedSku.seckill) {
        throw new CoreClientError('InventoryUnavailable', '本场已抢完，请返回秒杀大厅查看下一场。');
      }
      const seckillAvailable = minBigInt(
        BigInt(seckillSession?.inventory.available ?? '0'),
        BigInt(selectedSku.seckill.inventory.available),
        BigInt(selectedSku.stockAvailable),
      );
      if (seckillAvailable === 0n) {
        throw new CoreClientError('InventoryUnavailable', '本场已抢完，请返回秒杀大厅查看下一场。');
      }
      if (seckillAvailable < BigInt(quantity)) {
        throw new CoreClientError('InventoryUnavailable', '本场剩余库存不足，请减少购买数量。');
      }
    }
    if (BigInt(selectedSku.stockAvailable) < BigInt(quantity)) {
      throw new CoreClientError('InventoryUnavailable', '抱歉，该规格商品刚刚已被抢光，请重新选择规格！');
    }
    const target = checkoutTarget;
    if (!target || target.fulfillmentMode !== fulfillmentMode) {
      throw new CoreClientError(
        'ExternalBlocked',
        fulfillmentMode === 'DELIVERY'
          ? '请先选择系统已验证的收货地址'
          : '请先选择系统已验证的自提门店',
      );
    }
    return {
      fulfillmentMode: target.fulfillmentMode,
      fulfillmentTargetHash: target.fulfillmentTargetHash,
      regionCodeHash: target.regionCodeHash,
      label: target.label,
      idempotencyKey: quoteIdempotencyKey([
        selectedProduct.productId,
        selectedSku.skuId,
        String(quantity),
        target.fulfillmentMode,
        target.fulfillmentTargetHash,
        target.regionCodeHash,
        selectedSeckillSessionId ?? 'ORDINARY',
      ].join('|')),
      productId: selectedProduct.productId,
      skuId: selectedSku.skuId,
      quantity,
    };
  }

  function assertQuoteMatchesSelection(
    nextQuote: SignedQuote,
    selection: QuoteSelection,
    productSnapshot: CatalogProduct | null,
    skuSnapshot: CatalogSku | null,
    expectedSessionId: string | null,
  ) {
    if (!productSnapshot || !skuSnapshot) {
      throw new CoreClientError('InvalidResponse', '系统报价和当前选择不一致，请重新选择后再试');
    }
    const assertIntent = (intent: PaymentQuoteResponse['intent'], label: string) => {
      if (
        intent.productId.toLowerCase() !== productSnapshot.chainProductId.toLowerCase()
        || intent.skuId.toLowerCase() !== skuSnapshot.chainSkuId.toLowerCase()
        || intent.quantity !== selection.quantity
        || intent.fulfillmentMode !== selection.fulfillmentMode
        || intent.fulfillmentTargetHash.toLowerCase() !== selection.fulfillmentTargetHash.toLowerCase()
        || intent.regionCodeHash.toLowerCase() !== selection.regionCodeHash.toLowerCase()
      ) {
        throw new CoreClientError('InvalidResponse', `${label}和当前选择不一致，请重新选择后再试`);
      }
    };
    if ('intent' in nextQuote) {
      if (expectedSessionId !== null) throw new CoreClientError('InvalidResponse', '系统返回了普通报价，和当前秒杀场次不一致');
      assertIntent(nextQuote.intent, '系统报价');
      return;
    }
    if (!expectedSessionId || nextQuote.dual.sessionId.toLowerCase() !== expectedSessionId.toLowerCase()) {
      throw new CoreClientError('InvalidResponse', '秒杀报价和当前场次不一致，请返回秒杀大厅重新进入');
    }
    assertIntent(nextQuote.dual.seckill, '秒杀报价');
    assertIntent(nextQuote.dual.fallback, '普通兜底报价');
  }

  function assertPickupTargetMatchesStore(target: PickupTarget, store: MerchantStore) {
    if (
      target.storeId !== store.storeId
      || target.store.storeId !== store.storeId
      || target.store.merchantId !== store.merchantId
      || target.store.regionCode !== store.regionCode
      || target.store.status !== 'ACTIVE'
      || target.regionCode !== store.regionCode
    ) {
      throw new CoreClientError('InvalidResponse', '系统返回的自提门店和当前选择不一致，请重新选择门店');
    }
  }

  function quoteIdempotencyKey(fingerprint: string) {
    if (quoteRequest.current?.fingerprint === fingerprint) return quoteRequest.current.idempotencyKey;
    const idempotencyKey = services.createIdempotencyKey();
    quoteRequest.current = { fingerprint, idempotencyKey };
    return idempotencyKey;
  }

  function inspectQuoteApprovals(
    nextQuote: SignedQuote,
    options: { clearBeforeRead?: boolean } = {},
  ) {
    const inspection = ++quoteApprovalInspection.current;
    if (options.clearBeforeRead ?? true) setApprovals([]);
    void services.wallet.inspectApprovals(nextQuote.approvalRequirements)
      .then((nextApprovals) => {
        if (inspection === quoteApprovalInspection.current) setApprovals(nextApprovals);
      })
      .catch(() => {
        // Payment broadcast re-checks allowances before any wallet transaction.
        // A slow or failed read must not block checkout review.
      });
  }

  function clearPaymentState() {
    clearQuoteState();
    rememberPendingSubmission(null);
    setSubmittedTxHash(null);
  }

  function clearQuoteState() {
    quoteApprovalInspection.current += 1;
    quoteRequest.current = null;
    setQuote(null);
    setProjection(null);
    setApprovals([]);
  }

  function rememberPendingSubmission(nextSubmission: PendingSubmission | null) {
    pendingSubmissionRef.current = nextSubmission;
    setPendingSubmission(nextSubmission);
  }

  function clearPendingSubmissionIfResolvedByOrders(nextOrders: readonly FulfillmentOrder[]) {
    const current = pendingSubmissionRef.current;
    if (!current) return;
    const resolved = nextOrders.some((order) => orderProvesPendingSubmissionResolved(order, current));
    if (!resolved) return;
    services.submissionStore.clear(current);
    rememberPendingSubmission(null);
  }

  function clearPendingSubmissionIfResolvedByStatements(nextStatements: readonly BuyerShoppingStatement[]) {
    const current = pendingSubmissionRef.current;
    if (!current) return;
    const resolved = nextStatements.some((statement) => shoppingStatementProvesPendingSubmissionResolved(statement, current));
    if (!resolved) return;
    services.submissionStore.clear(current);
    rememberPendingSubmission(null);
  }

  async function loadOrderBundle(
    activeSession: WalletSession,
    cursor?: FulfillmentOrderCursor,
    isActive: () => boolean = () => true,
  ) {
    if (!isActive()) return;
    if (!cursor) setOrdersState('loading');
    const page = await services.core.listOrders(activeSession.token, cursor);
    const actions: Record<string, readonly AllowedAction[]> = cursor ? { ...orderActions } : {};
    const targets: Record<string, FulfillmentTarget> = cursor ? { ...orderTargets } : {};
    const capabilityErrors: Record<string, string> = cursor ? { ...orderCapabilityErrors } : {};
    const timelines: Record<string, BuyerTakeoverTimeline> = cursor ? { ...takeoverTimelines } : {};
    const timelineErrors: Record<string, string> = cursor ? { ...takeoverTimelineErrors } : {};
    await Promise.all(page.orders.map(async (order) => {
      actions[order.orderId] = order.allowedActions;
      const [targetResult, timelineResult] = await Promise.allSettled([
        services.core.getOrderTarget(activeSession.token, order.orderId),
        services.core.getBuyerTakeoverTimeline(activeSession.token, order.orderId),
      ]);
      if (targetResult.status === 'fulfilled') {
        if (targetResult.value.fulfillmentMode === order.fulfillmentMode) {
          targets[order.orderId] = targetResult.value;
        } else {
          capabilityErrors[order.orderId] = '订单履约方式和收货信息不一致，请联系平台处理';
        }
      } else capabilityErrors[order.orderId] = '履约目标暂无数据';
      if (timelineResult.status === 'fulfilled') timelines[order.orderId] = timelineResult.value;
      else timelineErrors[order.orderId] = errorMessage(timelineResult.reason);
    }));
    if (!isActive()) return;
    const nextOrders = cursor ? mergeOrders(orders, page.orders) : page.orders;
    clearPendingSubmissionIfResolvedByOrders(nextOrders);
    setOrders(nextOrders);
    setOrdersNextCursor(page.nextCursor);
    setOrderActions(actions);
    setOrderTargets(targets);
    setOrderCapabilityErrors(capabilityErrors);
    setTakeoverTimelines(timelines);
    setTakeoverTimelineErrors(timelineErrors);
    setOrdersState(nextOrders.length > 0 ? 'ready' : 'empty');
  }

  async function loadAuthenticatedBundles(activeSession: WalletSession, isActive: () => boolean = () => true) {
    const results = await Promise.allSettled([
      loadBuyerAccountBundle(activeSession, isActive),
      loadOrderBundle(activeSession, undefined, isActive),
      loadShoppingStatementBundle(activeSession, undefined, isActive),
      loadSettlementBundle(activeSession, isActive),
      loadNotificationBundle(activeSession, isActive),
    ]);
    if (!isActive()) return;
    if (results[0]?.status === 'rejected') {
      setBuyerProfileState('error');
      setBuyerOverviewState('error');
      setBuyerAddressesState('error');
    }
    if (results[1]?.status === 'rejected') setOrdersState('error');
    if (results[2]?.status === 'rejected') setShoppingStatementsState('error');
    if (results[3]?.status === 'rejected') setSettlementsState('error');
    if (results[4]?.status === 'rejected') setNotificationsState('error');
    if (results.some((result) => result.status === 'rejected')) {
      setError('部分账户数据同步失败，可在对应页面重试');
    }
  }

  async function ensureFreshBuyerSession(activeSession: WalletSession) {
    const expiry = sessionTokenExpiryMs(activeSession.token);
    if (expiry === null || expiry > Date.now() + WALLET_SESSION_EXPIRY_SAFETY_MS) return activeSession;
    clearCachedWalletSession(activeSession.walletAddress);
    return refreshBuyerSession(activeSession.walletAddress);
  }

  async function refreshBuyerSession(walletAddress: string) {
    const nextSession = await services.core.authenticate(walletAddress, (message) => services.wallet.signMessage(message));
    if (!nextSession.roles.includes('BUYER')) throw new CoreClientError('Forbidden', '当前钱包没有购买权限');
    if (nextSession.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new CoreClientError('WalletMismatch', '钱包登录结果与当前钱包不一致');
    }
    saveCachedWalletSession(nextSession);
    setSession(nextSession);
    return nextSession;
  }

  async function loadBuyerAccountBundle(activeSession: WalletSession, isActive: () => boolean = () => true) {
    if (!isActive()) return;
    setBuyerProfileState('loading');
    setBuyerOverviewState('loading');
    setBuyerAddressesState('loading');
    const [profile, overview, addresses] = await Promise.all([
      services.core.getBuyerProfile(activeSession.token),
      services.core.getBuyerOverview(activeSession.token),
      services.core.listBuyerAddresses(activeSession.token),
    ]);
    assertBuyerProjectionWallet(profile.wallet, activeSession);
    assertBuyerProjectionWallet(overview.wallet, activeSession);
    if (!isActive()) return;
    setBuyerProfile(profile);
    setBuyerProfileState('ready');
    setBuyerOverview(overview);
    setBuyerOverviewState('ready');
    setBuyerAddresses(addresses);
    setBuyerAddressesState(addresses.length > 0 ? 'ready' : 'empty');
    await loadBuyerAvatar(activeSession, profile, isActive).catch(() => undefined);
  }

  async function loadBuyerAvatar(
    activeSession: WalletSession,
    profile: BuyerProfile,
    isActive: () => boolean = () => true,
  ) {
    if (!isActive()) return;
    setBuyerAvatarAccess(null);
    if (!profile.avatarAssetId) {
      setBuyerAvatarState('empty');
      return;
    }
    setBuyerAvatarState('loading');
    try {
      const access = await services.core.createAuthenticatedMediaReadAccess(
        activeSession.token,
        profile.avatarAssetId,
      );
      assertBuyerAvatarRead(access, activeSession, profile.avatarAssetId);
      if (!isActive()) return;
      setBuyerAvatarAccess(access);
      setBuyerAvatarState('ready');
    } catch (reason) {
      if (!isActive()) return;
      setBuyerAvatarState('error');
      throw reason;
    }
  }

  async function loadBuyerAddresses(activeSession: WalletSession) {
    setBuyerAddressesState('loading');
    const addresses = await services.core.listBuyerAddresses(activeSession.token);
    setBuyerAddresses(addresses);
    setBuyerAddressesState(addresses.length > 0 ? 'ready' : 'empty');
  }

  async function loadShoppingStatementBundle(
    activeSession: WalletSession,
    cursor?: OrderStatementCursor,
    isActive: () => boolean = () => true,
  ) {
    if (!isActive()) return;
    if (cursor) setShoppingStatementsLoadingMore(true);
    else setShoppingStatementsState('loading');
    setShoppingStatementsError(null);
    try {
      const page = await services.core.listBuyerShoppingStatements(activeSession.token, cursor);
      assertBuyerProjectionWallet(page.buyerWallet, activeSession);
      const nextStatements = cursor
        ? mergeShoppingStatements(shoppingStatements, page.statements)
        : page.statements;
      if (!isActive()) return;
      clearPendingSubmissionIfResolvedByStatements(nextStatements);
      setShoppingStatements(nextStatements);
      setShoppingStatementsNextCursor(page.nextCursor);
      setShoppingStatementsState(nextStatements.length > 0 ? 'ready' : 'empty');
    } catch (reason) {
      if (!isActive()) return;
      setShoppingStatementsError(errorMessage(reason));
      if (!cursor) {
        setShoppingStatements([]);
        setShoppingStatementsNextCursor(null);
        setShoppingStatementsState('error');
      }
      throw reason;
    } finally {
      if (isActive()) setShoppingStatementsLoadingMore(false);
    }
  }

  async function writeSavedAddress(
    command: (activeSession: WalletSession, current: BuyerSavedAddress) => Promise<void>,
    addressId: string,
  ) {
    setBusy(true);
    setError(null);
    try {
      const activeSession = requireSession();
      const current = requireBuyerAddress(addressId);
      await command(activeSession, current);
      await loadBuyerAddresses(activeSession);
      return true;
    } catch (reason) {
      setBuyerAddressesState('error');
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function requireBuyerAddress(addressId: string) {
    const address = buyerAddresses.find((item) => item.addressId === addressId);
    if (!address) throw new CoreClientError('UnknownState', '收货地址已更新或删除，请重新同步');
    return address;
  }

  async function loadSettlementBundle(activeSession: WalletSession, isActive: () => boolean = () => true) {
    if (!isActive()) return;
    setSettlementsState('loading');
    const nextSettlements = await services.core.listSettlements(activeSession.token);
    if (nextSettlements.wallet.toLowerCase() !== activeSession.walletAddress.toLowerCase()) {
      throw new CoreClientError('WalletMismatch', '收益结算投影与当前钱包不一致');
    }
    if (!isActive()) return;
    setSettlements(nextSettlements);
    setSettlementsState(
      nextSettlements.balances.length > 0 || nextSettlements.points.length > 0 || nextSettlements.requests.length > 0
        ? 'ready'
        : 'empty',
    );
  }

  async function loadSeckillSurface(isActive: () => boolean, includeCurrent = true) {
    if (isActive()) setSeckillSessionState('loading');
    if (!includeCurrent) {
      const history = await services.core.listSeckillSessionHistory(undefined, 20);
      if (!isActive()) return;
      setSeckillHistory(history.items);
      setSeckillSessionState((current) => current === 'loading' ? 'empty' : current);
      return;
    }
    const [current, history] = await Promise.allSettled([
      services.core.getCurrentSeckillSession(),
      services.core.listSeckillSessionHistory(undefined, 20),
    ]);
    if (!isActive()) return;
    if (history.status === 'fulfilled') setSeckillHistory(history.value.items);
    if (current.status === 'fulfilled') {
      if (current.value === null) {
        setSeckillSession(null);
        setSeckillEvents([]);
        setSeckillSessionState('empty');
      } else {
        setSeckillSession(current.value);
        setSeckillSessionState('ready');
      }
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

  async function loadNotificationBundle(activeSession: WalletSession, isActive: () => boolean = () => true) {
    const requestGeneration = ++notificationRequestGeneration.current;
    if (!isActive()) return;
    setNotificationsState('loading');
    try {
      const nextNotifications = deduplicateNotifications(await services.core.listNotifications(activeSession.token));
      if (requestGeneration !== notificationRequestGeneration.current || !isActive()) return;
      setNotifications(nextNotifications);
      setNotificationsState(nextNotifications.length > 0 ? 'ready' : 'empty');
    } catch (reason) {
      if (requestGeneration !== notificationRequestGeneration.current || !isActive()) return;
      throw reason;
    }
  }

  async function loadCms(token?: string, isActive: () => boolean = () => true) {
    if (!isActive()) return;
    setCmsState('loading');
    const items = await services.core.listPublicCms(token);
    if (!isActive()) return;
    setCmsItems(items);
    setCmsState(items.length > 0 ? 'ready' : 'empty');
  }

  async function submitAndRefresh(submission: PendingSubmission) {
    let activeSession = await sessionForPendingSubmission(submission);
    const request = paymentSubmissionRequest(submission);
    try {
      await services.core.submitPayment(activeSession.token, request);
    } catch (reason) {
      if (!isWalletSessionAuthFailure(reason)) throw reason;
      clearCachedWalletSession(activeSession.walletAddress);
      activeSession = await refreshBuyerSession(activeSession.walletAddress);
      await services.core.submitPayment(activeSession.token, request);
    }
    const awaitingProjection = { ...submission, phase: 'AWAITING_PROJECTION' as const };
    services.submissionStore.save(awaitingProjection);
    rememberPendingSubmission(awaitingProjection);
    await refreshAndComplete(awaitingProjection, activeSession);
  }

  async function refreshAndComplete(submission: PendingSubmission, knownSession?: WalletSession) {
    let activeSession = knownSession ?? await sessionForPendingSubmission(submission);
    if (submission.walletAddress !== activeSession.walletAddress.toLowerCase()) {
      throw new CoreClientError('WalletMismatch', '当前钱包与待恢复交易不一致');
    }
    let nextProjection: PaymentProjection;
    try {
      nextProjection = await services.core.getPayment(activeSession.token, submission.orderId);
    } catch (reason) {
      if (!isWalletSessionAuthFailure(reason)) throw reason;
      clearCachedWalletSession(activeSession.walletAddress);
      activeSession = await refreshBuyerSession(activeSession.walletAddress);
      nextProjection = await services.core.getPayment(activeSession.token, submission.orderId);
    }
    setQuote(nextProjection);
    setProjection(nextProjection);
    if (paymentProjectionIsFinal(nextProjection)) {
      services.submissionStore.clear(submission);
      rememberPendingSubmission(null);
    } else {
      services.submissionStore.save(submission);
      rememberPendingSubmission(submission);
    }
  }

  async function sessionForPendingSubmission(submission: PendingSubmission) {
    const activeSession = await ensureFreshBuyerSession(requireSession());
    if (submission.walletAddress !== activeSession.walletAddress.toLowerCase()) {
      throw new CoreClientError('WalletMismatch', '当前钱包与待恢复交易不一致');
    }
    return activeSession;
  }

  function resetAuthenticatedState() {
    notificationRequestGeneration.current += 1;
    buyerActionAttempts.current.clear();
    setSession(null);
    setCheckoutTarget(null);
    setOrders([]);
    setOrdersState('idle');
    setOrdersNextCursor(null);
    setOrderActions({});
    setOrderTargets({});
    setPickupCredentials({});
    setPickupCredentialErrors({});
    setOrderCapabilityErrors({});
    setTakeoverTimelines({});
    setTakeoverTimelineErrors({});
    setBuyerProfile(null);
    setBuyerProfileState('idle');
    setBuyerAvatarAccess(null);
    setBuyerAvatarState('idle');
    setBuyerOverview(null);
    setBuyerOverviewState('idle');
    setBuyerAddresses([]);
    setBuyerAddressesState('idle');
    setShoppingStatements([]);
    setShoppingStatementsState('idle');
    setShoppingStatementsNextCursor(null);
    setShoppingStatementsLoadingMore(false);
    setShoppingStatementsError(null);
    setSettlements(null);
    setSettlementsState('idle');
    setNotifications([]);
    setNotificationsState('idle');
    setNotificationEndpoint(null);
    rememberPendingSubmission(null);
    setSubmittedTxHash(null);
    clearPaymentState();
  }
}

function validateEvidenceReasonCode(value: string) {
  const reasonCode = value.trim();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(reasonCode)) {
    throw new CoreClientError('InvalidRequest', '请输入 2-64 位大写字母、数字或下划线原因代码');
  }
  return reasonCode;
}

function evidenceContentType(value: string): FulfillmentEvidenceContentType {
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(value)) {
    throw new CoreClientError('InvalidRequest', '仅支持 JPG、PNG、WebP 或 PDF 证据文件');
  }
  return value as FulfillmentEvidenceContentType;
}

function assertUploadIntentForBuyer(
  intent: MediaUploadIntentProjection,
  session: WalletSession,
  order: FulfillmentOrder,
  file: File,
  contentSha256: string,
) {
  if (
    intent.ownerWallet.toLowerCase() !== session.walletAddress.toLowerCase()
    || intent.resourceId !== order.orderId
    || intent.contentType !== file.type
    || intent.sizeBytes !== String(file.size)
    || intent.contentSha256.toLowerCase() !== contentSha256
  ) throw new CoreClientError('InvalidResponse', '证据上传授权与当前订单或文件不一致');
}

function assertMediaAssetForBuyer(
  asset: MediaAssetProjection,
  session: WalletSession,
  order: FulfillmentOrder,
  file: File,
  contentSha256: string,
) {
  if (
    asset.ownerWallet.toLowerCase() !== session.walletAddress.toLowerCase()
    || asset.resourceId !== order.orderId
    || asset.contentType !== file.type
    || asset.sizeBytes !== String(file.size)
    || asset.contentSha256.toLowerCase() !== contentSha256
) throw new CoreClientError('InvalidResponse', '已验证证据媒体与当前订单或文件不一致');
}

function assertBuyerAvatarUpload(
  intent: MediaUploadIntentProjection,
  session: WalletSession,
  file: File,
  contentSha256: string,
) {
  if (
    intent.ownerWallet.toLowerCase() !== session.walletAddress.toLowerCase()
    || intent.purpose !== 'BUYER_AVATAR'
    || intent.resourceType !== 'BUYER'
    || intent.resourceId.toLowerCase() !== session.walletAddress.toLowerCase()
    || intent.contentType !== file.type
    || intent.sizeBytes !== String(file.size)
    || intent.contentSha256.toLowerCase() !== contentSha256.toLowerCase()
  ) throw new CoreClientError('InvalidResponse', '头像上传授权与当前买家或文件不一致');
}

function assertBuyerAvatarAsset(
  asset: MediaAssetProjection,
  session: WalletSession,
  file: File,
  contentSha256: string,
) {
  if (
    asset.ownerWallet.toLowerCase() !== session.walletAddress.toLowerCase()
    || asset.purpose !== 'BUYER_AVATAR'
    || asset.resourceType !== 'BUYER'
    || asset.resourceId.toLowerCase() !== session.walletAddress.toLowerCase()
    || asset.contentType !== file.type
    || asset.sizeBytes !== String(file.size)
    || asset.contentSha256.toLowerCase() !== contentSha256.toLowerCase()
  ) throw new CoreClientError('InvalidResponse', '已验证头像与当前买家或文件不一致');
}

function assertBuyerAvatarRead(
  access: MediaReadAccessProjection,
  session: WalletSession,
  assetId: string,
) {
  if (
    access.assetId.toLowerCase() !== assetId.toLowerCase()
    || access.purpose !== 'BUYER_AVATAR'
    || access.resourceType !== 'BUYER'
    || access.resourceId.toLowerCase() !== session.walletAddress.toLowerCase()
    || access.accessScope !== 'AUTHENTICATED'
    || !access.contentType.startsWith('image/')
  ) throw new CoreClientError('InvalidResponse', '头像读取授权与当前买家不一致');
}

function assertBuyerProjectionWallet(wallet: string, session: WalletSession) {
  if (wallet.toLowerCase() !== session.walletAddress.toLowerCase()) {
    throw new CoreClientError('WalletMismatch', '买家账户投影与当前钱包不一致');
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

const coreClientInput = coreApiBaseUrl ? { baseUrl: coreApiBaseUrl } : {};
const defaultCoreClient = createCoreClient(coreClientInput);

export const defaultMallServices: MallServices = Object.freeze({
  core: defaultCoreClient,
  realtime: createSeckillRealtimeClient(defaultCoreClient, coreClientInput),
  wallet: createBrowserWalletGateway(),
  createIdempotencyKey() {
    return `mall-${globalThis.crypto.randomUUID()}`;
  },
  async hashEvidenceFile(file: Blob) {
    if (!globalThis.crypto?.subtle) {
      throw new CoreClientError('ExternalBlocked', '当前浏览器不支持安全文件哈希');
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  },
  submissionStore: createBrowserSubmissionStore(),
  walletWritesAuthorized:
    productBaseline.manifestsAligned
      && productBaseline.payOrderExecutable
      && productBaseline.paymentRouterAddress !== null,
  supportUrl: import.meta.env.VITE_MALL_SUPPORT_URL ?? null,
});


const PICKUP_CREDENTIAL_CACHE_PREFIX = 'abu24k:mall:pickup-credentials';

function pickupCredentialOrderKey(orderId: string) {
  return orderId.toLowerCase();
}

function randomPickupCode() {
  const random = cryptoRandomUint32();
  return String(random % 1_000_000).padStart(6, '0');
}

function randomBytes32() {
  const bytes = new Uint8Array(32);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new CoreClientError('ExternalBlocked', '当前浏览器不支持安全随机数');
  cryptoApi.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function cryptoRandomUint32() {
  const values = new Uint32Array(1);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new CoreClientError('ExternalBlocked', '当前浏览器不支持安全随机数');
  cryptoApi.getRandomValues(values);
  return values[0] ?? Math.floor(Math.random() * 1_000_000);
}

function pickupCredentialCacheKey(walletAddress: string) {
  return [
    PICKUP_CREDENTIAL_CACHE_PREFIX,
    productBaseline.chainId,
    walletAddress.toLowerCase(),
  ].join(':');
}

function legacyPickupCredentialCacheKey(walletAddress: string) {
  return [
    PICKUP_CREDENTIAL_CACHE_PREFIX,
    productBaseline.coreArtifacts,
    productBaseline.chainId,
    walletAddress.toLowerCase(),
  ].join(':');
}

function loadCachedPickupCredentials(walletAddress: string): Readonly<Record<string, PickupCredentialView>> {
  try {
    const next = {
      ...readCachedPickupCredentialsAtKey(legacyPickupCredentialCacheKey(walletAddress)),
      ...readCachedPickupCredentialsAtKey(pickupCredentialCacheKey(walletAddress)),
    };
    if (Object.keys(next).length > 0) {
      globalThis.localStorage?.setItem(pickupCredentialCacheKey(walletAddress), JSON.stringify(next));
    }
    return next;
  } catch {
    return {};
  }
}

function readCachedPickupCredentialsAtKey(key: string) {
  const raw = globalThis.localStorage?.getItem(key);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const next: Record<string, PickupCredentialView> = {};
  for (const [orderId, credential] of Object.entries(parsed)) {
    if (isCachedPickupCredential(credential) && new Date(credential.expiresAt).getTime() > Date.now()) {
      next[pickupCredentialOrderKey(orderId)] = credential;
    }
  }
  return next;
}

function saveCachedPickupCredential(walletAddress: string, orderId: string, credential: PickupCredentialView) {
  try {
    const current = loadCachedPickupCredentials(walletAddress);
    globalThis.localStorage?.setItem(
      pickupCredentialCacheKey(walletAddress),
      JSON.stringify({ ...current, [pickupCredentialOrderKey(orderId)]: credential }),
    );
  } catch {
    // 页面内状态仍会保留本次同步请求；系统未确认前不会把 6 位码展示给门店核销。
  }
}

function removeCachedPickupCredential(walletAddress: string, orderId: string) {
  try {
    const key = pickupCredentialOrderKey(orderId);
    const current = loadCachedPickupCredentials(walletAddress);
    const next = omitRecordKey(current, key);
    globalThis.localStorage?.setItem(pickupCredentialCacheKey(walletAddress), JSON.stringify(next));
  } catch {
    // 本机缓存删除失败不影响系统拒绝结果。
  }
}

function isCachedPickupCredential(value: unknown): value is PickupCredentialView {
  if (!value || typeof value !== 'object') return false;
  const credential = value as PickupCredentialView;
  const phase = credential.phase ?? (credential.credentialId ? 'REGISTERED' : 'REGISTERING');
  if (typeof credential.code !== 'string' || !/^[0-9]{6}$/.test(credential.code)) return false;
  if (credential.credentialId !== undefined && typeof credential.credentialId !== 'string') return false;
  if (typeof credential.expiresAt !== 'string' || !Number.isFinite(new Date(credential.expiresAt).getTime())) return false;
  if (phase === 'REGISTERED') return typeof credential.credentialId === 'string';
  if (phase !== 'REGISTERING') return false;
  return typeof credential.idempotencyKey === 'string'
    && credential.idempotencyKey.length > 0
    && typeof credential.evidenceHash === 'string'
    && /^0x[0-9a-fA-F]{64}$/.test(credential.evidenceHash);
}

export function validateSupportUrl(value: string | null | undefined) {
  const raw = value?.trim();
  if (!raw) return { url: null, error: '客服入口未配置' } as const;
  if (/\s/.test(raw)) return { url: null, error: '客服入口配置无效' } as const;
  try {
    const url = new URL(raw);
    if (!['https:', 'mailto:', 'tel:'].includes(url.protocol)) {
      return { url: null, error: '客服入口仅允许 https、mailto 或 tel' } as const;
    }
    if ((url.protocol === 'https:' && !url.hostname) || (url.protocol !== 'https:' && !url.pathname)) {
      return { url: null, error: '客服入口配置无效' } as const;
    }
    return { url: url.href, error: null } as const;
  } catch {
    return { url: null, error: '客服入口配置无效' } as const;
  }
}

function readinessError(bootstrap: CorePaymentAvailability | null) {
  if (!bootstrap) return new CoreClientError('ConfigurationRequired', '商城安全状态尚未同步');
  if (bootstrap.blockCode === 'DecisionBlocked') {
    return new CoreClientError('DecisionBlocked', '当前暂时不能付款，请稍后再试。');
  }
  if (bootstrap.blockCode === 'ExternalBlocked') {
    return new CoreClientError('ExternalBlocked', '当前暂时不能付款，请稍后再试。');
  }
  return new CoreClientError('ConfigurationRequired', '当前暂时不能付款，请稍后再试。');
}

function mergeOrders(
  current: readonly FulfillmentOrder[],
  incoming: readonly FulfillmentOrder[],
) {
  const byId = new Map(current.map((order) => [order.orderId, order]));
  for (const order of incoming) byId.set(order.orderId, order);
  return [...byId.values()];
}

function mergeShoppingStatements(
  current: readonly BuyerShoppingStatement[],
  incoming: readonly BuyerShoppingStatement[],
) {
  const byId = new Map(current.map((statement) => [statement.orderId.toLowerCase(), statement]));
  for (const statement of incoming) byId.set(statement.orderId.toLowerCase(), statement);
  return [...byId.values()];
}

function deduplicateNotifications(items: readonly NotificationInboxItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.messageId)) return false;
    seen.add(item.messageId);
    return true;
  });
}

function errorMessage(reason: unknown) {
  if (reason instanceof CoreClientError) return translateMallError(reason.message, reason.code);
  if (reason instanceof Error) return translateMallError(reason.message);
  return '操作失败，请稍后重试';
}

function pickupCredentialErrorMessage(reason: unknown, fallback: string) {
  if (
    reason instanceof CoreClientError
    && (reason.code === 'IdempotencyConflict' || /active pickup credential/i.test(reason.message))
  ) {
    return '这笔订单已经有一个有效核销码。本机没有旧码时，请联系平台作废旧码后再生成。';
  }
  if (!(reason instanceof CoreClientError)) {
    return '网络中断，系统还没有确认核销码。请点“继续同步核销码”，确认成功前不要给门店核销。';
  }
  if (['NetworkUnavailable', 'InvalidResponse', 'ExternalBlocked', 'RequestFailed'].includes(reason.code)) {
    return '系统还没有确认核销码。请点“继续同步核销码”，确认成功前不要给门店核销。';
  }
  return fallback;
}

function isDefinitivePickupCredentialRejection(reason: unknown) {
  if (!(reason instanceof CoreClientError) || isWalletSessionAuthFailure(reason)) return false;
  return ![
    'NetworkUnavailable',
    'InvalidResponse',
    'ExternalBlocked',
    'RequestFailed',
  ].includes(reason.code);
}

function paymentProjectionIsFinal(projection: PaymentProjection) {
  return projection.state === 'PAID'
    && projection.finality?.state === 'FINAL'
    && projection.finality.confirmations >= projection.finality.requiredConfirmations;
}

function orderProvesPendingSubmissionResolved(order: FulfillmentOrder, submission: PendingSubmission) {
  return order.orderId.toLowerCase() === submission.orderId.toLowerCase()
    && order.paymentTxHash?.toLowerCase() === submission.txHash.toLowerCase()
    && order.finalityStatus === 'FINAL'
    && orderStateProvesPaymentFinal(order.state);
}

function shoppingStatementProvesPendingSubmissionResolved(statement: BuyerShoppingStatement, submission: PendingSubmission) {
  return statement.orderId.toLowerCase() === submission.orderId.toLowerCase()
    && statement.paymentTxHash.toLowerCase() === submission.txHash.toLowerCase()
    && orderStateProvesPaymentFinal(statement.orderState)
    && Number.isFinite(Date.parse(statement.paymentFinalizedAt));
}

function orderStateProvesPaymentFinal(state: FulfillmentOrder['state'] | BuyerShoppingStatement['orderState']) {
  return [
    'PAID',
    'SHIPPED',
    'DELIVERED',
    'ARBITRATION',
    'TAKEOVER',
    'FULFILLMENT_PENDING',
    'FULFILLED',
  ].includes(state);
}

function omitRecordKey<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  void _removed;
  return rest;
}

function translateMallError(message: string, code?: string) {
  const cleaned = message
    .replace(/^\s*(InvalidRequest|InvalidResponse|Forbidden|ExternalBlocked|ConfigurationRequired|DecisionBlocked)\s*[:：]?\s*/i, '')
    .replace(/\s*[（(][0-9a-f]{8}-[0-9a-f-]{27,}[）)]$/i, '')
    .trim();
  if (/Expired or invalid session token|invalid session token|session token/i.test(cleaned)) return '登录已过期，请重新连接钱包。';
  if (/Merchant is not eligible for publication/i.test(cleaned)) return '商家暂不满足上架条件，请先完成入驻审核或经营条件。';
  if (/Product, merchant or inventory is unavailable/i.test(cleaned)) return '商品、商家或库存当前不可买。请刷新商品页，确认商品已上架且库存足够。';
  if (/Seckill product or merchant is unavailable|Merchant is not eligible for a seckill session/i.test(cleaned)) return '当前秒杀商品暂时不可买。请刷新秒杀页查看最新场次。';
  if (/Fresh wallet coverage evidence is unavailable|Canonical coverage evidence is unavailable/i.test(cleaned)) return '资金覆盖检查还没拿到最新结果，系统暂时不能付款；请稍等后刷新。';
  if (/BSC RPC contract request timed out|Payment receipt RPC operation timed out/i.test(cleaned)) return '链上节点响应超时，系统正在保护付款状态。请稍等后重试，不要连续重复提交。';
  if (/自提门店不属于当前商品商家|Pickup store is outside product merchant/i.test(cleaned)) return '这个门店不是当前商品的自提门店，请重新选择门店。';
  if (/Order pickup-store snapshot is unavailable|pickup-store snapshot/i.test(cleaned)) return '这笔订单的自提门店和商家对不上，请联系平台处理。';
  if (/地址目标|收货地址|address target/i.test(cleaned)) return '收货地址暂时无法确认，请刷新后重试。';
  if (/Register this wallet in the existing BNM system before checkout|registrationRequired/i.test(cleaned)) return '当前钱包还没有完成积分系统登记，请先完成登记后再下单。';
  if (code === 'Forbidden' || /Forbidden/i.test(cleaned)) return '当前钱包没有权限，请切换正确钱包后重试。';
  if (/New payment quotes are blocked by unresolved payment policy/i.test(cleaned)) return '付款资金规则还没准备好，暂时不能下单。';
  if (/New payment quotes are blocked by unavailable payment infrastructure|fresh verified runtime readiness snapshot/i.test(cleaned)) return '付款确认服务还没准备好，暂时不能下单。';
  if (/New payment quote is paused/i.test(cleaned)) return '平台支付开关暂停中，暂时不能下单。';
  if (code === 'DecisionBlocked' || code === 'ExternalBlocked' || code === 'ConfigurationRequired') return '当前暂时不能付款，请稍后再试。';
  if (/Invalid idempotency key|idempotencyKey|idempotency key|Idempotency key/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/canonical integer string|must be a canonical atomic amount|canonical atomic amount|balance\.amount|amount must/i.test(cleaned)) return '系统返回的金额格式异常，请刷新或联系平台处理。';
  if (/Product requires 1-5 verified main images/i.test(cleaned)) return '商品还缺少主图，请商家补齐后再购买。';
  if (/does not match (the )?(coordinated|generated)|generated type|Core returned|Core response|Core API|non-JSON|unreachable|request failed|gateway is unavailable/i.test(cleaned)) return '系统服务暂时无法连接，请刷新或稍后重试。';
  if (/Network|fetch|Failed to fetch|Load failed/i.test(cleaned)) return '网络连接失败，请检查网络后重试。';
  if (/SIWE challenge rate limit exceeded|SIWE[^。]*rate limit/i.test(cleaned)) return '钱包登录请求太频繁，请稍等一会儿再试。刷新页面后 15 分钟内会尽量复用登录状态，不需要反复签名。';
  if (/IdempotencyConflict/i.test(code ?? '') || /current payment/i.test(cleaned)) return '当前付款状态已更新，请刷新订单后重试。';
  if (looksLikeTechnicalEnglish(cleaned)) return '系统返回异常，请刷新或联系平台处理。';
  return cleaned || '操作失败，请稍后重试。';
}

function looksLikeTechnicalEnglish(message: string) {
  return /\b(Order|Wallet|Unexpected|Invalid|Forbidden|Unauthorized|Expired|SIWE|Core|must|not|found|failed|unavailable|canonical|amount|token|session|request|response|error)\b/i.test(message)
    || (!/[\u4e00-\u9fff]/.test(message) && /[A-Za-z]{3,}/.test(message));
}

function minBigInt(first: bigint, ...rest: bigint[]) {
  return rest.reduce((min, value) => value < min ? value : min, first);
}

function firstOrdinaryPurchasableSkuId(product: CatalogProduct) {
  return product.skus.find((sku) => !sku.seckill && BigInt(sku.stockAvailable) > 0n)?.skuId ?? null;
}

const WALLET_SESSION_CACHE_PREFIX = 'abu24k:mall:wallet-session';
const WALLET_SESSION_EXPIRY_SAFETY_MS = 60_000;

function walletSessionCacheKey(walletAddress: string) {
  return [
    WALLET_SESSION_CACHE_PREFIX,
    productBaseline.coreArtifacts,
    productBaseline.chainId,
    walletAddress.toLowerCase(),
  ].join(':');
}

function clearCachedWalletSession(walletAddress: string) {
  try {
    globalThis.sessionStorage?.removeItem(walletSessionCacheKey(walletAddress));
  } catch {
    // Session storage is unavailable.
  }
}

function loadCachedWalletSession(walletAddress: string): WalletSession | null {
  const key = walletSessionCacheKey(walletAddress);
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<WalletSession>;
    if (!isCachedWalletSession(value, walletAddress)) {
      globalThis.sessionStorage?.removeItem(key);
      return null;
    }
    if ((sessionTokenExpiryMs(value.token) ?? 0) <= Date.now() + WALLET_SESSION_EXPIRY_SAFETY_MS) {
      globalThis.sessionStorage?.removeItem(key);
      return null;
    }
    return value;
  } catch {
    try { globalThis.sessionStorage?.removeItem(key); } catch { /* Session storage is unavailable. */ }
    return null;
  }
}

function saveCachedWalletSession(session: WalletSession) {
  if ((sessionTokenExpiryMs(session.token) ?? 0) <= Date.now() + WALLET_SESSION_EXPIRY_SAFETY_MS) return;
  try {
    globalThis.sessionStorage?.setItem(walletSessionCacheKey(session.walletAddress), JSON.stringify(session));
  } catch {
    // Login still works normally when sessionStorage is blocked.
  }
}

const WALLET_SESSION_ROLES = ['BUYER', 'MERCHANT', 'ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR'] as const satisfies readonly UserRole[];
const WALLET_SESSION_ROLE_SET = new Set<string>(WALLET_SESSION_ROLES);

function isCachedWalletSession(value: Partial<WalletSession>, walletAddress: string): value is WalletSession {
  const payload = typeof value.token === 'string' ? sessionTokenPayload(value.token) : null;
  return typeof value.token === 'string'
    && typeof value.walletAddress === 'string'
    && value.walletAddress.toLowerCase() === walletAddress.toLowerCase()
    && payload?.sub === walletAddress.toLowerCase()
    && payload.iss === 'abu24k-v2-core'
    && payload.aud === 'abu24k-v2-products'
    && Array.isArray(value.roles)
    && value.roles.every((role) => typeof role === 'string' && WALLET_SESSION_ROLE_SET.has(role));
}

function isWalletSessionAuthFailure(error: unknown) {
  return error instanceof CoreClientError
    && ['Unauthorized', 'Forbidden', 'WalletMismatch'].includes(error.code);
}

function sessionTokenExpiryMs(token: string) {
  const payload = sessionTokenPayload(token);
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
}

function sessionTokenPayload(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(globalThis.atob(padded)) as { exp?: unknown; sub?: unknown; iss?: unknown; aud?: unknown };
  } catch {
    return null;
  }
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

function normalizeBytes32Input(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!isBytes32(normalized)) {
    throw new CoreClientError('InvalidRequest', `${label}必须是 0x 开头的 64 位交易编号`);
  }
  return normalized;
}
