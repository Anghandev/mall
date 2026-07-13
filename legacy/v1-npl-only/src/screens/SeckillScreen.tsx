import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAccount, useAppKit, useProvider } from '@reown/appkit-react-native';
import { AlertTriangle, ChevronRight, Clock3, Flame, ShieldCheck, Trophy, X, Zap } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ProductThumb } from '../components/ProductThumb';
import { BSC_CHAIN_ID, NPL_BSC_ADDRESS, isWalletProjectConfigured } from '../config/web3';
import { createSeckillIntent, fetchDappAssetsState, fetchFundingTxStatus, fetchSeckillFeed, fetchSeckillSession, normalizeSeckillFeedStreamSnapshot, seckillFeedStreamUrl } from '../services/api';
import type { CheckoutIntentInput, DappStore, SeckillIntentResponse, TxStatusResponse } from '../services/api';
import { ensureBuyerSession } from '../services/buyerAuth';
import { formatNpl } from '../services/orderMath';
import { isOnBsc, readAllowanceWei, sendWalletTransaction, waitForTransactionReceipt } from '../services/payment';
import type { WalletProvider } from '../services/payment';
import { colors, radius, shadow, spacing } from '../theme/tokens';
import type { AddressBookEntry, CartItem, FulfillmentMode, Product, SeckillFeedItem, SeckillSession } from '../types';

type Props = {
  cartItems?: CartItem[];
  onAddToCart?: (product: Product) => boolean;
  onOpenCheckout?: () => void;
  onOpenAssets?: () => void;
  onOpenMall?: () => void;
  address?: string;
  chainId?: string;
  isConnected?: boolean;
  isProjectConfigured?: boolean;
  provider?: WalletProvider;
  deliveryAddress?: AddressBookEntry | null;
  pickupStore?: DappStore | null;
  preferredFulfillmentMode?: FulfillmentMode | null;
  onConnectPress?: () => void;
  onSwitchBsc?: () => Promise<void>;
};

type PurchasePhase = 'idle' | 'switching' | 'session' | 'intent' | 'allowance' | 'approval' | 'payment' | 'order-paid' | 'record-purchase' | 'feed';
type NoticeTone = 'normal' | 'error' | 'success';
type FeedTransport = 'connecting' | 'stream' | 'polling';
type EventSourceLike = {
  close: () => void;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
};
type EventSourceConstructorLike = new (url: string) => EventSourceLike;
type PendingSeckillPurchase = {
  buyerAddress: string;
  sessionId: string;
  orderId: string;
  payOrderHash: string;
  recordPurchaseTransaction: NonNullable<SeckillIntentResponse['seckill']['recordPurchaseTransaction']>;
  recordPurchaseHash?: string;
};

const PENDING_SECKILL_KEY_PREFIX = '@24k/pending-seckill';

const statusCopy: Record<SeckillSession['status'], string> = {
  upcoming: '未开启',
  live: '秒杀中',
  settling: '结算中',
  settled: '已结算'
};

export function SeckillScreen({
  cartItems = [],
  onOpenCheckout = () => {},
  onOpenAssets,
  address: addressProp,
  chainId: chainIdProp,
  isConnected: isConnectedProp,
  isProjectConfigured: isProjectConfiguredProp,
  provider: providerProp,
  deliveryAddress,
  pickupStore,
  preferredFulfillmentMode,
  onConnectPress,
  onSwitchBsc
}: Props) {
  const account = useAccount();
  const { provider: appKitProvider } = useProvider();
  const { open, switchNetwork } = useAppKit();
  const address = addressProp || account.address;
  const chainId = chainIdProp || account.chainId;
  const isConnected = isConnectedProp ?? account.isConnected;
  const projectConfigured = isProjectConfiguredProp ?? isWalletProjectConfigured;
  const provider = providerProp || appKitProvider as WalletProvider | undefined;
  const [session, setSession] = useState<SeckillSession | null>(null);
  const [feed, setFeed] = useState<SeckillFeedItem[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [apiState, setApiState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [apiError, setApiError] = useState('');
  const [dialog, setDialog] = useState<'rules' | 'report' | null>(null);
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState<NoticeTone>('normal');
  const [purchasePhase, setPurchasePhase] = useState<PurchasePhase>('idle');
  const [busy, setBusy] = useState(false);
  const [hasPendingPurchase, setHasPendingPurchase] = useState(false);
  const [feedTransport, setFeedTransport] = useState<FeedTransport>('connecting');
  const purchaseLock = useRef(false);
  const pendingPurchaseRef = useRef<PendingSeckillPurchase | null>(null);
  const feedStreamConnectedRef = useRef(false);
  const activeSessionIdRef = useRef('');

  useEffect(() => {
    let mounted = true;
    let loaded = false;
    let refreshing = false;

    async function refresh(initial: boolean) {
      if (refreshing) return;
      refreshing = true;
      try {
        const payload = await fetchSeckillSession();
        if (!mounted) return;
        loaded = true;
        const sessionChanged = activeSessionIdRef.current !== payload.session.id;
        activeSessionIdRef.current = payload.session.id;
        setSession(payload.session);
        if (initial || sessionChanged || !feedStreamConnectedRef.current) setFeed(payload.feed);
        setProduct(payload.product);
        setApiError('');
        if (initial) {
          setNotice(`场次 ${payload.session.id} 已从秒杀 API 同步。`);
          setNoticeTone('normal');
        }
        setApiState('ready');
      } catch (error) {
        if (!mounted) return;
        setApiError(error instanceof Error ? error.message : '秒杀 API 加载失败。');
        if (!loaded) {
          setSession(null);
          setFeed([]);
          setProduct(null);
          setApiState('error');
          setNotice('');
        }
      } finally {
        refreshing = false;
      }
    }

    void refresh(true);
    const timer = setInterval(() => { void refresh(false); }, 5_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!session?.id) return;
    const sessionId = session.id;
    let active = true;
    let source: EventSourceLike | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollBusy = false;
    const EventSourceConstructor = Platform.OS === 'web'
      ? (globalThis as unknown as { EventSource?: EventSourceConstructorLike }).EventSource
      : undefined;

    async function pollFeed() {
      if (!active || pollBusy) return;
      pollBusy = true;
      try {
        const latestFeed = await fetchSeckillFeed(sessionId);
        if (active && !feedStreamConnectedRef.current) setFeed(latestFeed);
      } catch {
        // The full session refresh keeps the existing error state and retries independently.
      } finally {
        pollBusy = false;
      }
    }

    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }

    function startPolling() {
      feedStreamConnectedRef.current = false;
      setFeedTransport('polling');
      if (pollTimer) return;
      void pollFeed();
      pollTimer = setInterval(() => { void pollFeed(); }, 5_000);
    }

    function scheduleReconnect() {
      if (!active || !EventSourceConstructor || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectStream();
      }, 5_000);
    }

    function disconnectStream() {
      source?.close();
      source = null;
      startPolling();
      scheduleReconnect();
    }

    function connectStream() {
      if (!active || !EventSourceConstructor) {
        startPolling();
        return;
      }
      source?.close();
      setFeedTransport('connecting');
      try {
        source = new EventSourceConstructor(seckillFeedStreamUrl(sessionId));
        source.onopen = () => {
          if (!active) return;
          feedStreamConnectedRef.current = true;
          stopPolling();
          setFeedTransport('stream');
        };
        source.addEventListener('snapshot', (event) => {
          if (!active) return;
          try {
            const snapshot = normalizeSeckillFeedStreamSnapshot(JSON.parse(event.data));
            if (snapshot.sessionId !== sessionId) return;
            feedStreamConnectedRef.current = true;
            stopPolling();
            setFeedTransport('stream');
            setFeed(snapshot.feed);
            setSession((current) => current && current.id === snapshot.sessionId ? {
              ...current,
              status: isSeckillStatus(snapshot.report?.status) ? snapshot.report.status : current.status,
              prizePoolNpl: snapshot.report?.prizePoolNpl ?? current.prizePoolNpl,
              totalBuys: snapshot.report?.totalBuys ?? current.totalBuys,
              winnerAddress: snapshot.report?.winnerAddress ?? current.winnerAddress
            } : current);
          } catch {
            disconnectStream();
          }
        });
        source.onerror = disconnectStream;
      } catch {
        disconnectStream();
      }
    }

    connectStream();
    return () => {
      active = false;
      feedStreamConnectedRef.current = false;
      source?.close();
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [session?.id]);

  useEffect(() => {
    let mounted = true;
    if (!address || !session) {
      setHasPendingPurchase(false);
      return () => { mounted = false; };
    }
    AsyncStorage.getItem(pendingSeckillKey(address, session.id))
      .then((value) => {
        if (mounted) setHasPendingPurchase(Boolean(value));
      })
      .catch(() => {
        if (mounted) setHasPendingPurchase(false);
      });
    return () => { mounted = false; };
  }, [address, session?.id]);

  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const actionDisabled = busy || !session || !product || (session.status !== 'live' && !hasPendingPurchase);

  async function handleBuy() {
    if (purchaseLock.current) return;
    if (!session || !product) {
      setNotice('秒杀场次尚未就绪，无法加入终核清单。');
      setNoticeTone('error');
      return;
    }
    if (session.status !== 'live' && !hasPendingPurchase) {
      setNotice(`当前场次${statusCopy[session.status]}，只能查看规则和战报。`);
      setNoticeTone('error');
      return;
    }
    if (!projectConfigured) {
      setNotice('钱包连接尚未配置，暂时无法发起真实秒杀交易。');
      setNoticeTone('error');
      return;
    }
    if (!isConnected || !address) {
      setNotice('请先连接钱包，再参与本场秒杀。');
      setNoticeTone('normal');
      if (onConnectPress) onConnectPress();
      else open({ view: 'Connect' });
      return;
    }
    if (!provider) {
      setNotice('钱包 Provider 未就绪，请重新连接钱包。');
      setNoticeTone('error');
      return;
    }

    purchaseLock.current = true;
    setBusy(true);
    let phase: PurchasePhase = 'switching';
    try {
      setPurchasePhase(phase);
      setNoticeTone('normal');
      setNotice(isOnBsc(chainId) ? '正在确认钱包网络。' : '当前不是 BSC，正在请求钱包切换网络。');
      let currentChainId = await provider.request<string>({ method: 'eth_chainId' });
      if (!isOnBsc(currentChainId)) {
        if (onSwitchBsc) await onSwitchBsc();
        else await switchNetwork(`eip155:${BSC_CHAIN_ID}`);
        currentChainId = await provider.request<string>({ method: 'eth_chainId' });
        if (!isOnBsc(currentChainId)) throw new Error(`钱包当前链为 ${currentChainId}，未切换到 BSC。`);
      }

      phase = 'session';
      setPurchasePhase(phase);
      setNotice('请在钱包签署 Buyer SIWE 登录消息。');
      const buyerSession = await ensureBuyerSession(provider, address);
      const inMemoryPending = pendingPurchaseRef.current?.buyerAddress.toLowerCase() === address.toLowerCase()
        && pendingPurchaseRef.current.sessionId === session.id
        ? pendingPurchaseRef.current
        : null;
      const pending = inMemoryPending || await readPendingSeckillPurchase(address, session.id);
      if (pending) {
        pendingPurchaseRef.current = pending;
        setHasPendingPurchase(true);
        setNotice('检测到本场未完成的秒杀交易，正在继续原订单，避免重复付款。');
        await finishPendingPurchase(pending, buyerSession.token, (nextPhase) => {
          phase = nextPhase;
          setPurchasePhase(nextPhase);
        });
        return;
      }
      if (session.status !== 'live') throw new Error('SECKILL_NOT_LIVE');
      const item = await buildSeckillCheckoutItem(product, cartItems, address, buyerSession.token, deliveryAddress, pickupStore, preferredFulfillmentMode);
      const input: CheckoutIntentInput = {
        buyerAddress: address,
        idempotencyKey: seckillAttemptKey(address, session.id),
        items: [item]
      };

      phase = 'intent';
      setPurchasePhase(phase);
      setNotice('正在创建后端秒杀支付 intent，并锁定库存与履约信息。');
      const intent = await createSeckillIntent(input, buyerSession.token);
      assertSeckillIntent(intent, address, session.id);
      const paymentIntent = intent.paymentIntent!;
      const allowanceCheck = paymentIntent.allowanceChecks[0]!;

      phase = 'allowance';
      setPurchasePhase(phase);
      setNotice('正在链上读取 NPL allowance。');
      let allowance = await readAllowanceWei(provider, allowanceCheck);
      if (allowance < BigInt(allowanceCheck.requiredAmountWei)) {
        phase = 'approval';
        setPurchasePhase(phase);
        const approval = paymentIntent.approvalTransactions.find((transaction) => transaction.key === allowanceCheck.key);
        if (!approval) throw new Error('后端未返回 NPL MaxUint256 授权交易。');
        setNotice('NPL allowance 不足，请在钱包确认 MaxUint256 授权。');
        const approvalHash = requireTxHash(await sendWalletTransaction(provider, approval), 'NPL 授权');
        setNotice(`NPL 授权已广播，正在等待打包。TxHash：${approvalHash}`);
        await waitForTransactionReceipt(provider, approvalHash);
        allowance = await readAllowanceWei(provider, allowanceCheck);
        if (allowance < BigInt(allowanceCheck.requiredAmountWei)) throw new Error('NPL 授权已打包，但 allowance 仍不足。');
      } else {
        setNotice('NPL allowance 充足，已跳过 approve。');
      }

      phase = 'payment';
      setPurchasePhase(phase);
      setNotice('请在钱包确认后端签名的 9 参数 payOrder 交易。');
      const payOrderHash = requireTxHash(await sendWalletTransaction(provider, paymentIntent.payOrderTransaction), 'payOrder');
      setNotice(`payOrder 已广播，正在等待链上打包。TxHash：${payOrderHash}`);
      const pendingPurchase: PendingSeckillPurchase = {
        buyerAddress: address,
        sessionId: session.id,
        orderId: intent.order.orderId,
        payOrderHash,
        recordPurchaseTransaction: intent.seckill.recordPurchaseTransaction!
      };
      pendingPurchaseRef.current = pendingPurchase;
      setHasPendingPurchase(true);
      await writePendingSeckillPurchase(pendingPurchase);
      await finishPendingPurchase(pendingPurchase, buyerSession.token, (nextPhase) => {
        phase = nextPhase;
        setPurchasePhase(nextPhase);
      });
    } catch (error) {
      setNotice(seckillErrorMessage(error, phase));
      setNoticeTone('error');
    } finally {
      purchaseLock.current = false;
      setBusy(false);
      setPurchasePhase('idle');
    }
  }

  async function finishPendingPurchase(pending: PendingSeckillPurchase, token: string, onPhase: (phase: PurchasePhase) => void) {
    if (!provider || !address) throw new Error('钱包 Provider 未就绪，请重新连接钱包。');
    assertPendingSeckillPurchase(pending, address);

    onPhase('order-paid');
    setNotice(`正在确认原订单的 payOrder。TxHash：${pending.payOrderHash}`);
    try {
      await waitForTransactionReceipt(provider, pending.payOrderHash);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('交易失败')) {
        await clearPendingSeckillPurchase(pending);
        pendingPurchaseRef.current = null;
        setHasPendingPurchase(false);
      }
      throw error;
    }
    const funding = await pollFundingUntilOrderPaid(pending.orderId, address, pending.payOrderHash, token, (status) => {
      setNotice(`${fundingStatusCopy(status)} TxHash：${pending.payOrderHash}`);
    });
    if (funding.status === 'failed' || funding.status === 'mismatch') {
      await clearPendingSeckillPurchase(pending);
      pendingPurchaseRef.current = null;
      setHasPendingPurchase(false);
      throw new Error(fundingStatusCopy(funding));
    }
    if (funding.status !== 'confirmed') throw new Error(`${fundingStatusCopy(funding)} 已保留原订单，重试不会重复付款。`);

    onPhase('record-purchase');
    let recordHash = pending.recordPurchaseHash;
    if (!recordHash) {
      setNotice('OrderPaid 已确认，请在钱包确认 recordPurchase。');
      recordHash = requireTxHash(await sendWalletTransaction(provider, pending.recordPurchaseTransaction), 'recordPurchase');
      pending = { ...pending, recordPurchaseHash: recordHash };
      pendingPurchaseRef.current = pending;
      await writePendingSeckillPurchase(pending);
    }
    setNotice(`recordPurchase 已广播，正在等待 PurchaseRecorded。TxHash：${recordHash}`);
    try {
      await waitForTransactionReceipt(provider, recordHash);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('交易失败')) {
        pending = { ...pending, recordPurchaseHash: undefined };
        pendingPurchaseRef.current = pending;
        await writePendingSeckillPurchase(pending);
      }
      throw error;
    }

    onPhase('feed');
    setNotice('链上秒杀记录已确认，正在刷新滚动墙与场次状态。');
    const indexed = await pollSeckillUntilRecorded(pending.sessionId, pending.orderId, recordHash, (payload) => {
      setSession(payload.session);
      setFeed(payload.feed);
      setProduct(payload.product);
    });
    await clearPendingSeckillPurchase(pending);
    pendingPurchaseRef.current = null;
    setHasPendingPurchase(false);
    setNotice(indexed
      ? `秒杀成功，OrderPaid 与 PurchaseRecorded 均已确认。recordPurchase TxHash：${recordHash}`
      : `秒杀链上交易已确认，滚动墙仍在索引。recordPurchase TxHash：${recordHash}`);
    setNoticeTone('success');
  }

  function handleSafetyTap(item: string) {
    if (item === '中奖提取' && onOpenAssets) {
      onOpenAssets();
      return;
    }
    setNotice(`${item} 状态需以当前场次接口和链上合约结果为准。`);
    setNoticeTone('normal');
  }

  return (
    <View style={styles.shell}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <LinearGradient colors={['#080704', '#1A1408', '#3B2812']} style={styles.hero}>
          <Image source={require('../../assets/products/24k-runner.png')} resizeMode="cover" style={styles.heroImage} />
          <View style={styles.heroScrim} />
          <View style={styles.heroTop}>
            <View>
              <Text style={styles.brand}>24K 秒杀大厅</Text>
              <Text style={styles.brandSub}>{session ? `主倒计时 · 接力 +${session.relayExtendSeconds}s` : '等待场次 API'}</Text>
            </View>
            <View style={styles.livePill}><Flame size={16} color={colors.obsidian} /><Text style={styles.liveText}>{session ? statusCopy[session.status] : apiState === 'error' ? '不可用' : '同步中'}</Text></View>
          </View>
          <View style={styles.timerRow}>
            <TimerBox label="主倒计时" value={session ? formatSeconds(session.mainSecondsLeft) : '--:--'} />
            <TimerBox label="接力倒计时" value={session ? formatSeconds(session.relaySecondsLeft) : '--:--'} accent />
          </View>
          <View style={styles.poolCard}>
            <Text style={styles.poolLabel}>本场奖池</Text>
            <Text style={styles.poolValue}>{session ? `${formatNpl(session.prizePoolNpl)} NPL` : '--'}</Text>
            <Text style={styles.poolHint}>{session ? `累计抢购 ${session.totalBuys} 次 · 规则 ${session.ruleVersion}` : apiState === 'error' ? '场次数据不可用' : '等待 API 返回'}</Text>
          </View>
        </LinearGradient>

        {notice ? (
          <View style={[styles.notice, noticeTone === 'error' && styles.noticeError, noticeTone === 'success' && styles.noticeSuccess]}>
            {noticeTone === 'error'
              ? <AlertTriangle size={17} color={colors.danger} />
              : <ShieldCheck size={17} color={noticeTone === 'success' ? colors.greenDeep : colors.goldDeep} />}
            <Text style={[styles.noticeText, noticeTone === 'error' && styles.noticeTextError, noticeTone === 'success' && styles.noticeTextSuccess]}>{notice}</Text>
          </View>
        ) : null}
        {apiState !== 'ready' ? (
          <View style={[styles.stateNotice, apiState === 'error' && styles.stateNoticeError]}>
            <Text style={styles.stateTitle}>{apiState === 'loading' ? '正在同步秒杀场次' : '秒杀接口失败保护'}</Text>
            <Text style={styles.stateText}>{apiState === 'loading' ? '数据返回前不展示场次商品、奖池数值或滚动记录。' : apiError || '秒杀 API 加载失败，当前没有可展示的场次数据。'}</Text>
          </View>
        ) : null}

        {session && product ? (
          <>
            <View style={styles.productCard}>
              <ProductThumb product={product} size={122} radiusSize={radius.lg} />
              <View style={styles.productInfo}>
                <Text style={styles.productBadge}>本场主推 · NPL 托管</Text>
                <Text style={styles.productTitle}>{product.title}</Text>
                <Text style={styles.productSummary}>{product.summary}</Text>
                <View style={styles.priceRow}><Text style={styles.price}>{formatNpl(product.priceNpl)}</Text><Text style={styles.unit}>NPL</Text></View>
              </View>
            </View>

            <View style={styles.actionRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="打开秒杀规则" onPress={() => setDialog('rules')} style={styles.secondaryButton}><Text style={styles.secondaryText}>规则</Text></Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="立即参与秒杀"
                accessibilityState={{ busy, disabled: actionDisabled }}
                disabled={actionDisabled}
                onPress={handleBuy}
                style={({ pressed }) => [styles.primaryButton, actionDisabled && styles.primaryButtonDisabled, pressed && styles.primaryButtonPressed]}
              >
                {busy ? <ActivityIndicator size="small" color={colors.obsidian} /> : <Zap size={18} color={colors.obsidian} />}
                <Text style={styles.primaryText}>{busy ? purchasePhaseLabel(purchasePhase) : hasPendingPurchase ? '继续未完成交易' : isConnected ? '立即抢购' : '连接钱包参与'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="打开秒杀战报" onPress={() => setDialog('report')} style={styles.secondaryButton}><Text style={styles.secondaryText}>战报</Text></Pressable>
            </View>
          </>
        ) : null}

        <Pressable accessibilityRole="button" accessibilityLabel="进入终核结算" onPress={onOpenAssets || onOpenCheckout} style={styles.checkoutLink}>
          <Text style={styles.checkoutText}>终核清单 {cartCount} 件</Text><ChevronRight size={18} color={colors.gold} />
        </Pressable>

        {session ? (
          <>
            <View style={styles.sectionHead}>
              <View style={styles.sectionTitleRow}><Trophy size={20} color={colors.gold} /><Text style={styles.sectionTitle}>滚动墙</Text></View>
              <View style={styles.transportPill} accessibilityLiveRegion="polite"><View style={[styles.transportDot, feedTransport === 'stream' && styles.transportDotLive]} /><Text style={styles.transportText}>{feedTransport === 'stream' ? '实时' : feedTransport === 'polling' ? '5 秒轮询' : '连接中'}</Text></View>
            </View>
            <View style={styles.feedCard}>{feed.length ? feed.map((item) => <FeedRow key={item.id} item={item} />) : (
              <View style={styles.emptyFeed}><Text style={styles.emptyTitle}>暂无滚动记录</Text><Text style={styles.emptyText}>当前场次 API 尚未返回抢购动态。</Text></View>
            )}</View>

            <View style={styles.safetyGrid}>
              {['tx.origin 限制', '强截止秒杀', 'pause 秒杀', '中奖提取'].map((item) => <Pressable accessibilityRole="button" accessibilityLabel={item} onPress={() => handleSafetyTap(item)} key={item} style={({ pressed }) => [styles.safetyItem, pressed && styles.pressed]}><AlertTriangle size={15} color={colors.gold} /><Text style={styles.safetyText}>{item}</Text></Pressable>)}
            </View>
          </>
        ) : null}
      </ScrollView>

      <Modal visible={dialog !== null} transparent animationType="fade" onRequestClose={() => setDialog(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭弹窗" onPress={() => setDialog(null)} style={styles.close}><X size={18} color={colors.ink} /></Pressable>
            {session ? (
              <>
                <Text style={styles.modalTitle}>{dialog === 'rules' ? '秒杀规则' : '本场战报'}</Text>
                <Text style={styles.modalText}>{dialog === 'rules'
                  ? `用户每次抢购成功会延长接力倒计时 ${session.relayExtendSeconds} 秒。主倒计时结束或强截止触发后进入结算。具体风控结果以链上合约为准。`
                  : `当前奖池 ${formatNpl(session.prizePoolNpl)} NPL，已完成 ${session.totalBuys} 次抢购。`}</Text>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

async function buildSeckillCheckoutItem(product: Product, cartItems: CartItem[], address: string, token: string, selectedAddress?: AddressBookEntry | null, selectedStore?: DappStore | null, preferredMode?: FulfillmentMode | null): Promise<CartItem> {
  if (product.stock <= 0) throw new Error('INSUFFICIENT_STOCK');
  const existing = cartItems.find((item) => item.productId === product.id && item.selected)
    || cartItems.find((item) => item.productId === product.id);
  const activeSku = product.skus?.find((sku) => sku.id === existing?.skuId && sku.stock > 0)
    || product.skus?.find((sku) => sku.stock > 0);
  if (product.skus?.length && !activeSku) throw new Error('INSUFFICIENT_STOCK');

  const base: CartItem = {
    productId: product.id,
    skuId: activeSku?.id,
    skuName: activeSku?.name || product.sku,
    unitPriceNpl: activeSku?.settlementPriceNpl || product.priceNpl,
    quantity: 1,
    selected: true
  };
  if (existing?.fulfillmentMode === 'pickup' && existing.storeId) {
    return { ...base, fulfillmentMode: 'pickup', storeId: existing.storeId, regionCode: existing.regionCode };
  }
  if (existing?.fulfillmentMode !== 'pickup' && existing?.addressId) {
    return { ...base, fulfillmentMode: 'delivery', addressId: existing.addressId, regionCode: existing.regionCode };
  }
  if (preferredMode === 'pickup') {
    if (!product.fulfillmentModes.includes('pickup') || !selectedStore) throw new Error('STORE_REQUIRED');
    if (selectedStore.merchantAddress && selectedStore.merchantAddress.toLowerCase() !== product.sellerAddress.toLowerCase()) throw new Error('STORE_NOT_FOUND');
    return { ...base, fulfillmentMode: 'pickup', storeId: selectedStore.id, regionCode: selectedStore.regionCode };
  }
  if (!product.fulfillmentModes.includes('delivery') && selectedStore) {
    if (selectedStore.merchantAddress && selectedStore.merchantAddress.toLowerCase() !== product.sellerAddress.toLowerCase()) throw new Error('STORE_NOT_FOUND');
    return { ...base, fulfillmentMode: 'pickup', storeId: selectedStore.id, regionCode: selectedStore.regionCode };
  }
  if (!product.fulfillmentModes.includes('delivery')) {
    throw new Error('该秒杀商品仅支持门店自提，请先在终核清单选择门店。');
  }

  if (selectedAddress) {
    return {
      ...base,
      fulfillmentMode: 'delivery',
      addressId: selectedAddress.id,
      regionCode: selectedAddress.regionCode
    };
  }

  const assets = await fetchDappAssetsState(address, token);
  const deliveryAddress = assets.summary.addresses.find((entry) => entry.isDefault);
  if (!deliveryAddress) throw new Error('ADDRESS_REQUIRED');
  return {
    ...base,
    fulfillmentMode: 'delivery',
    addressId: deliveryAddress.id,
    regionCode: deliveryAddress.regionCode
  };
}

async function readPendingSeckillPurchase(address: string, sessionId: string): Promise<PendingSeckillPurchase | null> {
  const raw = await AsyncStorage.getItem(pendingSeckillKey(address, sessionId));
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingSeckillPurchase;
    if (pending.buyerAddress.toLowerCase() !== address.toLowerCase() || pending.sessionId !== sessionId) return null;
    return pending;
  } catch {
    throw new Error('本场待恢复秒杀记录损坏，为避免重复付款已阻止新交易。');
  }
}

async function writePendingSeckillPurchase(pending: PendingSeckillPurchase) {
  await AsyncStorage.setItem(pendingSeckillKey(pending.buyerAddress, pending.sessionId), JSON.stringify(pending));
}

async function clearPendingSeckillPurchase(pending: PendingSeckillPurchase) {
  await AsyncStorage.removeItem(pendingSeckillKey(pending.buyerAddress, pending.sessionId));
}

function pendingSeckillKey(address: string, sessionId: string) {
  return `${PENDING_SECKILL_KEY_PREFIX}/${address.toLowerCase()}/${sessionId}`;
}

function assertPendingSeckillPurchase(pending: PendingSeckillPurchase, buyerAddress: string) {
  const transaction = pending.recordPurchaseTransaction;
  const valid = pending.buyerAddress.toLowerCase() === buyerAddress.toLowerCase()
    && /^0x[0-9a-fA-F]{64}$/.test(pending.payOrderHash)
    && (!pending.recordPurchaseHash || /^0x[0-9a-fA-F]{64}$/.test(pending.recordPurchaseHash))
    && transaction.key === 'recordPurchase'
    && transaction.from?.toLowerCase() === buyerAddress.toLowerCase()
    && /^0x[0-9a-fA-F]{40}$/.test(transaction.to)
    && /^0x[0-9a-fA-F]+$/.test(transaction.data)
    && transaction.sessionId === pending.sessionId
    && transaction.orderId === pending.orderId;
  if (!valid) throw new Error('本场待恢复秒杀记录校验失败，为避免重复付款已阻止新交易。');
}

function assertSeckillIntent(intent: SeckillIntentResponse, buyerAddress: string, sessionId: string) {
  const payment = intent.paymentIntent;
  const check = payment?.allowanceChecks[0];
  const approval = payment?.approvalTransactions[0];
  const payOrder = payment?.payOrderTransaction;
  const recordPurchase = intent.seckill?.recordPurchaseTransaction;
  const buyer = buyerAddress.toLowerCase();
  const npl = NPL_BSC_ADDRESS.toLowerCase();
  const escrow = intent.order.escrowAddress.toLowerCase();
  const maxUint256 = (2n ** 256n - 1n).toString();
  const valid = Boolean(payment)
    && isOnBsc(String(payment?.chainId))
    && isOnBsc(String(intent.order.chainId))
    && intent.order.buyerAddress.toLowerCase() === buyer
    && payment?.approvalPolicy.type === 'unlimited-npl'
    && payment.approvalPolicy.allowanceSkip === true
    && payment.approvalPolicy.amount === 'MaxUint256'
    && payment.allowanceChecks.length === 1
    && check?.key === 'npl'
    && check.symbol === 'NPL'
    && check.owner.toLowerCase() === buyer
    && check.tokenAddress.toLowerCase() === npl
    && check.to.toLowerCase() === npl
    && check.spender.toLowerCase() === escrow
    && payment.approvalTransactions.length === 1
    && approval?.key === 'npl'
    && approval.symbol === 'NPL'
    && approval.amount === 'MaxUint256'
    && approval.amountWei === maxUint256
    && approval.from?.toLowerCase() === buyer
    && approval.to.toLowerCase() === npl
    && approval.spender.toLowerCase() === escrow
    && payOrder?.key === 'payOrder'
    && payOrder.from?.toLowerCase() === buyer
    && payOrder.to.toLowerCase() === escrow
    && /^0x[0-9a-fA-F]+$/.test(payOrder.data)
    && /^0x[0-9a-fA-F]{64}$/.test(payOrder.productId)
    && /^0x[0-9a-fA-F]{64}$/.test(payOrder.authorizationDigest)
    && /^0x[0-9a-fA-F]+$/.test(payOrder.authorization)
    && /^0x[0-9a-fA-F]{40}$/.test(payOrder.orderSigner)
    && payOrder.orderDigest === intent.order.orderDigest
    && BigInt(payOrder.bnmLockedWei) > 0n
    && Number.isSafeInteger(payOrder.splitVersion)
    && payOrder.splitVersion > 0
    && payOrder.deadline > Math.floor(Date.now() / 1000)
    && intent.seckill.contractCallerBlocked === true
    && intent.seckill.session.id === sessionId
    && /^0x[0-9a-fA-F]{40}$/.test(intent.seckill.contractAddress)
    && recordPurchase?.key === 'recordPurchase'
    && recordPurchase.from?.toLowerCase() === buyer
    && recordPurchase.to.toLowerCase() === intent.seckill.contractAddress.toLowerCase()
    && recordPurchase.sessionId === sessionId
    && recordPurchase.orderId === intent.order.orderId
    && /^0x[0-9a-fA-F]+$/.test(recordPurchase.data);
  if (!valid) throw new Error('后端秒杀 intent 不符合 NPL allowance、9 参数 payOrder 或 recordPurchase 约束，已阻止交易。');
}

async function pollFundingUntilOrderPaid(
  orderId: string,
  buyerAddress: string,
  txHash: string,
  token: string,
  onUpdate: (status: TxStatusResponse) => void
) {
  let latest = await fetchFundingTxStatus(orderId, buyerAddress, txHash, token);
  onUpdate(latest);
  for (let attempt = 0; latest.retryable && attempt < 29; attempt += 1) {
    await delay(3_000);
    latest = await fetchFundingTxStatus(orderId, buyerAddress, txHash, token);
    onUpdate(latest);
  }
  return latest;
}

async function pollSeckillUntilRecorded(
  sessionId: string,
  orderId: string,
  txHash: string,
  onUpdate: (payload: Awaited<ReturnType<typeof fetchSeckillSession>>) => void
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const [state, latestFeed] = await Promise.all([fetchSeckillSession(), fetchSeckillFeed(sessionId)]);
    const payload = { ...state, feed: latestFeed };
    onUpdate(payload);
    if (latestFeed.some((item) => item.orderId?.toLowerCase() === orderId.toLowerCase() || item.txHash?.toLowerCase() === txHash.toLowerCase())) {
      return true;
    }
    if (attempt < 11) await delay(3_000);
  }
  return false;
}

function fundingStatusCopy(status: TxStatusResponse) {
  if (status.status === 'pending') return '付款交易正在等待 OrderPaid 事件。';
  if (status.status === 'confirmed') return '后端已验证 OrderPaid，订单已进入 PaidLocked。';
  if (status.status === 'failed') return `链上 payOrder 执行失败：${status.error || 'CHAIN_EVENT_TX_FAILED'}`;
  if (status.status === 'mismatch') return `OrderPaid 与订单不匹配：${status.error || 'CHAIN_EVENT_MISMATCH'}`;
  return `后端 RPC 暂不可用：${status.error || 'RPC_UNAVAILABLE'}`;
}

function seckillErrorMessage(error: unknown, phase: PurchasePhase) {
  const message = error instanceof Error ? error.message : '';
  if (/4001|user rejected|rejected|denied|cancelled|canceled|拒绝|取消/i.test(message)) {
    if (phase === 'switching') return '钱包已拒绝切换到 BSC，秒杀交易未发起。';
    if (phase === 'session') return '钱包已拒绝 Buyer SIWE 登录签名。';
    if (phase === 'approval') return '钱包已拒绝 NPL 授权，payOrder 未发起。';
    if (phase === 'payment') return '钱包已拒绝 payOrder，订单未付款。';
    if (phase === 'record-purchase') return '钱包已拒绝 recordPurchase；订单已付款，可依据订单和 TxHash 继续核对。';
    return '钱包已取消或拒签，秒杀流程已停止。';
  }
  if (/ADDRESS_REQUIRED|ADDRESS_NOT_FOUND/.test(message)) return '参与秒杀前需先在“我的资产”保存一个有效收货地址。';
  if (/STORE_REQUIRED|STORE_NOT_FOUND/.test(message)) return '该秒杀商品需要先选择有效自提门店。';
  if (/INSUFFICIENT_STOCK/.test(message)) return '该规格刚刚已抢光，请刷新场次后重试。';
  if (/SECKILL_NOT_LIVE|SESSION_SETTLING|SESSION_SETTLED/.test(message)) return '本场秒杀已不在可购买阶段，已阻止交易。';
  return message || '秒杀交易失败，请重试。';
}

function purchasePhaseLabel(phase: PurchasePhase) {
  if (phase === 'session') return '登录中';
  if (phase === 'intent') return '创建订单';
  if (phase === 'allowance') return '检查授权';
  if (phase === 'approval') return '授权 NPL';
  if (phase === 'payment') return '支付中';
  if (phase === 'order-paid') return '确认付款';
  if (phase === 'record-purchase') return '记录秒杀';
  if (phase === 'feed') return '刷新结果';
  return '切换网络';
}

function seckillAttemptKey(address: string, sessionId: string) {
  return `seckill:${sessionId}:${address.toLowerCase()}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function requireTxHash(value: string, action: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${action} 未返回有效 TxHash，已停止后续流程。`);
  return value;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function TimerBox({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <View style={[styles.timerBox, accent && styles.timerBoxAccent]}><Clock3 size={17} color={accent ? colors.obsidian : colors.gold} /><Text style={[styles.timerValue, accent && styles.timerValueAccent]}>{value}</Text><Text style={[styles.timerLabel, accent && styles.timerLabelAccent]}>{label}</Text></View>;
}

function FeedRow({ item }: { item: SeckillFeedItem }) {
  return <View style={styles.feedRow}><Text style={styles.feedAddress}>{item.address}</Text><Text style={styles.feedText}>{item.text}</Text><Text style={styles.feedTime}>{item.createdAt}</Text></View>;
}

function formatSeconds(total: number) {
  const safe = Math.max(0, total);
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const seconds = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function isSeckillStatus(value: unknown): value is SeckillSession['status'] {
  return value === 'upcoming' || value === 'live' || value === 'settling' || value === 'settled';
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.pageDeep },
  screen: { flex: 1 },
  content: { paddingBottom: 120 },
  hero: { minHeight: 374, padding: spacing.lg, justifyContent: 'space-between', overflow: 'hidden' },
  heroImage: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: 0.46 },
  heroScrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(8,7,4,0.34)' },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', zIndex: 1 },
  brand: { color: colors.white, fontSize: 32, fontWeight: '900', letterSpacing: -0.8 },
  brandSub: { color: '#E6D3A2', marginTop: 7, fontSize: 13, fontWeight: '800' },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.gold, borderRadius: radius.round, paddingHorizontal: 12, paddingVertical: 8 },
  liveText: { color: colors.obsidian, fontSize: 13, fontWeight: '900' },
  timerRow: { flexDirection: 'row', gap: spacing.md, zIndex: 1 },
  timerBox: { flex: 1, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(244,216,146,0.26)', backgroundColor: 'rgba(8,7,4,0.58)', padding: spacing.md },
  timerBoxAccent: { backgroundColor: colors.gold },
  timerValue: { color: colors.white, marginTop: 8, fontSize: 34, fontWeight: '900', letterSpacing: -1.2 },
  timerValueAccent: { color: colors.obsidian },
  timerLabel: { color: '#CDBB8A', marginTop: 4, fontSize: 12, fontWeight: '800' },
  timerLabelAccent: { color: '#4A3411' },
  poolCard: { zIndex: 1, borderRadius: radius.xl, backgroundColor: 'rgba(255,253,247,0.10)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(244,216,146,0.24)', padding: spacing.lg },
  poolLabel: { color: '#CDBB8A', fontSize: 12, fontWeight: '900' },
  poolValue: { color: colors.white, marginTop: 4, fontSize: 34, fontWeight: '900', letterSpacing: -1.2 },
  poolHint: { color: '#E6D3A2', marginTop: 5, fontSize: 13, fontWeight: '700' },
  notice: { margin: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.accentSoft, padding: spacing.md, flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  noticeText: { flex: 1, color: colors.goldDeep, fontSize: 13, lineHeight: 18, fontWeight: '800' },
  noticeError: { backgroundColor: colors.redSoft },
  noticeSuccess: { backgroundColor: colors.greenSoft },
  noticeTextError: { color: colors.danger },
  noticeTextSuccess: { color: colors.greenDeep },
  stateNotice: { marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceDarkElevated, padding: spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineDark },
  stateNoticeError: { backgroundColor: colors.brownDeep },
  stateTitle: { color: colors.gold, fontSize: 13, fontWeight: '900' },
  stateText: { color: colors.champagne, marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  productCard: { marginHorizontal: spacing.lg, flexDirection: 'row', gap: spacing.md, borderRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.md, ...shadow.soft },
  productInfo: { flex: 1 },
  productBadge: { color: colors.goldDeep, fontSize: 12, fontWeight: '900' },
  productTitle: { color: colors.ink, marginTop: 7, fontSize: 19, lineHeight: 24, fontWeight: '900', letterSpacing: -0.3 },
  productSummary: { color: colors.inkMuted, marginTop: 6, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 9 },
  price: { color: colors.ink, fontSize: 25, fontWeight: '900', letterSpacing: -0.9 },
  unit: { color: colors.inkMuted, fontSize: 11, fontWeight: '900' },
  actionRow: { marginHorizontal: spacing.lg, marginTop: spacing.lg, flexDirection: 'row', gap: spacing.sm },
  primaryButton: { flex: 1.5, height: 54, borderRadius: radius.round, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  primaryButtonDisabled: { opacity: 0.52 },
  primaryButtonPressed: { opacity: 0.78 },
  primaryText: { color: colors.obsidian, fontSize: 16, fontWeight: '900' },
  secondaryButton: { flex: 1, height: 54, borderRadius: radius.round, backgroundColor: colors.surfaceDarkElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineDark, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: colors.champagne, fontSize: 15, fontWeight: '900' },
  checkoutLink: { marginHorizontal: spacing.lg, marginTop: spacing.md, borderRadius: radius.lg, padding: spacing.md, backgroundColor: colors.surfaceDark, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineDark, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  checkoutText: { color: colors.white, fontSize: 14, fontWeight: '900' },
  sectionHead: { marginHorizontal: spacing.lg, marginTop: spacing.xl, marginBottom: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionTitle: { color: colors.white, fontSize: 22, fontWeight: '900', letterSpacing: -0.5 },
  transportPill: { minHeight: 30, borderRadius: radius.round, backgroundColor: colors.surfaceDarkElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineDark, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  transportDot: { width: 7, height: 7, borderRadius: radius.round, backgroundColor: colors.warning },
  transportDotLive: { backgroundColor: colors.green },
  transportText: { color: colors.champagne, fontSize: 10, fontWeight: '900' },
  feedCard: { marginHorizontal: spacing.lg, borderRadius: radius.xl, backgroundColor: colors.surfaceDarkElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineDark, overflow: 'hidden' },
  feedRow: { padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.lineDark },
  feedAddress: { color: colors.gold, fontSize: 13, fontWeight: '900' },
  feedText: { color: colors.white, marginTop: 5, fontSize: 14, fontWeight: '800' },
  feedTime: { color: '#AFA48B', marginTop: 4, fontSize: 12, fontWeight: '700' },
  emptyFeed: { padding: spacing.xl, alignItems: 'center' },
  emptyTitle: { color: colors.white, fontSize: 18, fontWeight: '900' },
  emptyText: { color: colors.champagne, marginTop: 6, fontSize: 13, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  safetyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, margin: spacing.lg },
  safetyItem: { width: '48%', borderRadius: radius.lg, backgroundColor: colors.surfaceDark, padding: spacing.md, flexDirection: 'row', gap: 7, alignItems: 'center' },
  safetyText: { color: colors.champagne, fontSize: 12, fontWeight: '800' },
  pressed: { opacity: 0.72 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end', padding: spacing.lg },
  modalCard: { borderRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.xl, ...shadow.deep },
  close: { position: 'absolute', top: 12, right: 12, width: 34, height: 34, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  modalTitle: { color: colors.ink, fontSize: 24, fontWeight: '900' },
  modalText: { color: colors.inkMuted, marginTop: spacing.md, fontSize: 15, lineHeight: 22, fontWeight: '700' }
});
