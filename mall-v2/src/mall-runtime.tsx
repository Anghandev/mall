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
  CatalogProduct,
  CatalogSku,
  PaymentProjection,
  PaymentQuoteResponse,
  PaymentSubmissionRequest,
  SeckillQuoteResponse,
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
import { createBrowserWalletGateway, type ApprovalStatus, type WalletGateway } from './wallet';

type SignedQuote = PaymentQuoteResponse | SeckillQuoteResponse;
type LoadState = 'loading' | 'ready' | 'empty' | 'error';

export interface MallServices {
  core: CoreClient;
  wallet: WalletGateway;
  resolveCheckoutTarget(mode: 'DELIVERY' | 'PICKUP'): Promise<CheckoutTarget | null>;
  createIdempotencyKey(): string;
  submissionStore: SubmissionStore;
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

  const value = useMemo<MallRuntimeValue>(() => ({
    bootstrap,
    catalog,
    catalogState,
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

    selectProduct(productId) {
      if (pendingSubmission) return setError('当前链上交易尚未提交到 Core，请先恢复跟踪');
      const product = catalog.find((item) => item.productId === productId);
      setSelectedProductId(product?.productId ?? null);
      setSelectedSkuId(null);
      setQuantityState(1);
      clearPaymentState();
    },

    selectSku(skuId) {
      if (pendingSubmission) return setError('当前链上交易尚未提交到 Core，请先恢复跟踪');
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
    error,
    fulfillmentMode,
    projection,
    pendingSubmission,
    quantity,
    quote,
    selectedProduct,
    selectedSku,
    services,
    session,
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
    const target = await services.resolveCheckoutTarget(fulfillmentMode);
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
    setQuote(null);
    setProjection(null);
    setApprovals([]);
    setPendingSubmission(null);
    setSubmittedTxHash(null);
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

export function useMallRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('MallRuntimeProvider is required');
  return value;
}

export const defaultMallServices: MallServices = Object.freeze({
  core: createCoreClient(),
  wallet: createBrowserWalletGateway(),
  async resolveCheckoutTarget() {
    return null;
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
