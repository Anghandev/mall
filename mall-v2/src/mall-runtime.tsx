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
  RealtimeEventEnvelope,
  SeckillQuoteResponse,
  SettlementListProjection,
  SettlementRail,
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
  reloadStores(regionCode?: string): Promise<void>;
  createPickupTarget(storeId: string): Promise<void>;
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
  const [submittedTxHash, setSubmittedTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<CheckoutBusyKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const broadcastInFlight = useRef(false);
  const walletConnectionAttempt = useRef(0);
  const quoteRequest = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
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
    void services.core.listStores()
      .then((nextStores) => {
        if (!active) return;
        setStores(nextStores);
        setStoresState(nextStores.length > 0 ? 'ready' : 'empty');
      })
      .catch(() => {
        if (!active) return;
        setStores([]);
        setStoresState('error');
      });
    return () => { active = false; };
  }, [services]);

  const value = useMemo<MallRuntimeValue>(() => ({
    bootstrap,
    catalog,
    catalogState,
    categories,
    tags,
    taxonomyState,
    stores,
    storesState,
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
        resetAuthenticatedState();
        const walletAddress = await services.wallet.connect();
        const nextSession = await services.core.authenticate(
          walletAddress,
          (message) => services.wallet.signMessage(message),
        );
        if (connectionAttempt !== walletConnectionAttempt.current) return;
        if (!nextSession.roles.includes('BUYER')) throw new CoreClientError('Forbidden', '当前钱包没有购买权限');
        const recovered = services.submissionStore.load(nextSession.walletAddress);
        setPendingSubmission(recovered);
        setSubmittedTxHash(recovered?.txHash ?? null);
        setSession(nextSession);
        const products = await services.core.listCatalog(nextSession.token);
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
      await run(async () => loadSeckillSurface(() => true));
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

    async reloadStores(regionCode) {
      setStoresState('loading');
      await run(async () => {
        const nextStores = await services.core.listStores(regionCode);
        setStores(nextStores);
        setStoresState(nextStores.length > 0 ? 'ready' : 'empty');
      }, () => {
        setStores([]);
        setStoresState('error');
      });
    },

    async createPickupTarget(storeId) {
      setCheckoutBusy('PICKUP_TARGET');
      try {
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
            review: { kind: 'PICKUP', store: target.store },
          });
          clearQuoteState();
        });
      } finally {
        setCheckoutBusy(null);
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
      setSelectedSkuId(null);
      setSelectedSeckillSessionId(null);
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
      if (checkoutTarget?.fulfillmentMode !== mode) setCheckoutTarget(null);
      clearPaymentState();
    },

    async requestOrdinaryQuote() {
      let success = false;
      setCheckoutBusy('QUOTE');
      try {
        await run(async () => {
          const selection = await buildSelection();
          const nextQuote = await services.core.createOrdinaryQuote(requireSession().token, selection);
          setQuote(nextQuote);
          setProjection(null);
          setApprovals(await services.wallet.inspectApprovals(nextQuote.approvalRequirements));
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
          const selection = await buildSelection();
          const nextQuote = await services.core.createSeckillQuote(requireSession().token, sessionId, selection);
          setQuote(nextQuote);
          setProjection(null);
          setApprovals(await services.wallet.inspectApprovals(nextQuote.approvalRequirements));
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
          setPendingSubmission(submission);
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

  function quoteIdempotencyKey(fingerprint: string) {
    if (quoteRequest.current?.fingerprint === fingerprint) return quoteRequest.current.idempotencyKey;
    const idempotencyKey = services.createIdempotencyKey();
    quoteRequest.current = { fingerprint, idempotencyKey };
    return idempotencyKey;
  }

  function clearPaymentState() {
    clearQuoteState();
    setPendingSubmission(null);
    setSubmittedTxHash(null);
  }

  function clearQuoteState() {
    quoteRequest.current = null;
    setQuote(null);
    setProjection(null);
    setApprovals([]);
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
      if (targetResult.status === 'fulfilled') targets[order.orderId] = targetResult.value;
      else capabilityErrors[order.orderId] = '履约目标暂无数据';
      if (timelineResult.status === 'fulfilled') timelines[order.orderId] = timelineResult.value;
      else timelineErrors[order.orderId] = errorMessage(timelineResult.reason);
    }));
    if (!isActive()) return;
    const nextOrders = cursor ? mergeOrders(orders, page.orders) : page.orders;
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
    setPendingSubmission(null);
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

function translateMallError(message: string, code?: string) {
  const cleaned = message
    .replace(/^\s*(InvalidRequest|InvalidResponse|Forbidden|ExternalBlocked|ConfigurationRequired|DecisionBlocked)\s*[:：]?\s*/i, '')
    .replace(/\s*[（(][0-9a-f]{8}-[0-9a-f-]{27,}[）)]$/i, '')
    .trim();
  if (code === 'Forbidden' || /Forbidden/i.test(cleaned)) return '当前钱包没有权限，请切换正确钱包后重试。';
  if (/地址目标|收货地址|address target/i.test(cleaned)) return '收货地址暂时无法确认，请刷新后重试。';
  if (code === 'DecisionBlocked' || code === 'ExternalBlocked' || code === 'ConfigurationRequired') return '当前暂时不能付款，请稍后再试。';
  if (/Register this wallet in the existing BNM system before checkout|registrationRequired/i.test(cleaned)) return '当前钱包还没有完成积分系统登记，请先完成登记后再下单。';
  if (/Invalid idempotency key|idempotencyKey|idempotency key|Idempotency key/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/must be a canonical atomic amount|canonical atomic amount/i.test(cleaned)) return '金额格式不正确，请填写普通数字金额，例如 2 或 2.00。';
  if (/Product requires 1-5 verified main images/i.test(cleaned)) return '商品还缺少主图，请商家补齐后再购买。';
  if (/does not match (the )?(coordinated|generated)|generated type|Core returned|Core response|Core API|non-JSON|unreachable|request failed|gateway is unavailable/i.test(cleaned)) return '系统服务暂时无法连接，请刷新或稍后重试。';
  if (/Network|fetch|Failed to fetch|Load failed/i.test(cleaned)) return '网络连接失败，请检查网络后重试。';
  if (/IdempotencyConflict/i.test(code ?? '') || /current payment/i.test(cleaned)) return '当前付款状态已更新，请刷新订单后重试。';
  return cleaned || '操作失败，请稍后重试。';
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
