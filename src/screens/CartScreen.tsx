import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ArrowLeft, ChevronRight, Minus, Plus, Search, ShieldCheck, ShoppingCart, X } from 'lucide-react-native';
import { ProductThumb } from '../components/ProductThumb';
import { WalletPill } from '../components/WalletPill';
import { NPL_BSC_ADDRESS } from '../config/web3';
import { colors, radius, spacing } from '../theme/tokens';
import type { CartItem, Order, Product } from '../types';
import { formatNpl, selectedCartTotal } from '../services/orderMath';
import { isOnBsc, readAllowanceWei, sendWalletTransaction, waitForTransactionReceipt } from '../services/payment';
import { createCheckoutIntent, createFinalCheck, fetchFundingTxStatus, fetchProducts, runStockPreflight } from '../services/api';
import { ensureBuyerSession } from '../services/buyerAuth';
import type { CheckoutIntentInput, FinalCheckResponse, PaymentIntent, TxStatusResponse } from '../services/api';
import type { WalletProvider } from '../services/payment';

type Props = {
  address?: string;
  chainId?: string;
  isConnected: boolean;
  isProjectConfigured: boolean;
  provider?: WalletProvider;
  items: CartItem[];
  setItems: Dispatch<SetStateAction<CartItem[]>>;
  onConnectPress: () => void;
  onSwitchBsc: () => Promise<void>;
  onBack?: () => void;
};

const PENDING_ORDER_KEY_PREFIX = '@24k/pending-order';
const CHAIN_SETTLED_STATUSES = new Set(['PaidLocked', 'Arbitration', 'Released', 'ForcedRefunded', 'EmergencyRefunded', 'Cancelled']);

export function CartScreen({ address, chainId, isConnected, isProjectConfigured, provider, items, setItems, onConnectPress, onSwitchBsc, onBack }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [productState, setProductState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [lastTxHash, setLastTxHash] = useState('');
  const [finalCheck, setFinalCheck] = useState<FinalCheckResponse | null>(null);
  const [checkoutDraft, setCheckoutDraft] = useState<CheckoutIntentInput | null>(null);
  const [buyerToken, setBuyerToken] = useState('');
  const [status, setStatus] = useState('选择 24K 商品后，会先检查 NPL allowance；不足时完成 MaxUint256 授权，再付款到托管合约。');
  const [busy, setBusy] = useState(false);
  const [cartSearchOpen, setCartSearchOpen] = useState(false);
  const [cartQuery, setCartQuery] = useState('');
  const [compareMode, setCompareMode] = useState(false);
  const [manageMode, setManageMode] = useState(false);

  const selectedCount = useMemo(() => items.filter((item) => item.selected && item.quantity > 0).length, [items]);
  const total = useMemo(() => selectedCartTotal(items, products), [items, products]);
  const grouped = useMemo(() => {
    const needle = cartQuery.trim().toLowerCase();
    const rows = products.map((product) => ({
      product,
      item: items.find((entry) => entry.productId === product.id)
    })).filter((entry) => entry.item)
      .filter(({ product, item }) => !needle || [product.title, product.shopName, item?.skuName, product.sku, product.summary, product.tags.join(' ')].join(' ').toLowerCase().includes(needle));
    return compareMode ? rows.sort((a, b) => b.product.priceNpl - a.product.priceNpl) : rows;
  }, [cartQuery, compareMode, items, products]);

  useEffect(() => {
    let mounted = true;
    fetchProducts()
      .then((nextProducts) => {
        if (!mounted) return;
        setProducts(nextProducts);
        setItems((current) => reconcileCartItems(current, nextProducts));
        setProductState('ready');
      })
      .catch((error) => {
        if (!mounted) return;
        setProducts([]);
        setProductState('error');
        setStatus(error instanceof Error ? error.message : '商品接口不可用，已阻止结算。');
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!address) {
      setLastOrder(null);
      return () => { mounted = false; };
    }
    const storageKey = pendingOrderKey(address);
    AsyncStorage.getItem(storageKey)
      .then(async (value) => {
        if (!mounted || !value) return;
        let pending: Order;
        try {
          pending = JSON.parse(value) as Order;
        } catch {
          await AsyncStorage.removeItem(storageKey).catch(() => {});
          if (mounted) setStatus('未完成订单缓存损坏，已清理；如已付款，请用后台订单或链上记录核对。');
          return;
        }
        if (pending.buyerAddress.toLowerCase() !== address.toLowerCase()) {
          await AsyncStorage.removeItem(storageKey).catch(() => {});
          return;
        }
        if (pending.txHash && !provider) {
          setLastTxHash(pending.txHash);
          setLastOrder({ ...pending, status: 'Funding' });
          setStatus(`钱包 Provider 尚未恢复，已保留待核对 TxHash：${pending.txHash}`);
          return;
        }
        if (pending.txHash && provider) {
          setLastTxHash(pending.txHash);
          try {
            const session = await ensureBuyerSession(provider, address);
            setBuyerToken(session.token);
            const funding = await fetchFundingTxStatus(pending.orderId, pending.buyerAddress, pending.txHash, session.token);
            if (!mounted) return;
            const submitted = funding.order || pending;
            setLastOrder(submitted);
            if (funding.status === 'confirmed' || isChainSettled(submitted.status)) {
              await AsyncStorage.removeItem(storageKey);
              setStatus(`${statusCopyForIndexedOrder(submitted.status)} 最终 TxHash：${pending.txHash}`);
              return;
            }
            if (funding.status === 'failed' || funding.status === 'mismatch') {
              await AsyncStorage.removeItem(storageKey);
              setStatus(fundingStatusCopy(funding));
              return;
            }
            setLastOrder({ ...submitted, status: 'Funding', txHash: pending.txHash });
            setStatus(fundingStatusCopy(funding));
          } catch (error) {
            if (mounted) setStatus(`${error instanceof Error ? error.message : '订单恢复失败'}；已保留 TxHash：${pending.txHash}`);
          }
          return;
        }
        await AsyncStorage.removeItem(storageKey).catch(() => {});
      })
      .catch(() => {
        // AsyncStorage failures should not block checkout.
      });
    return () => { mounted = false; };
  }, [address, provider]);

  async function handleCheckout() {
    if (!isProjectConfigured) {
      setStatus('先在 .env 配置 EXPO_PUBLIC_REOWN_PROJECT_ID。');
      return;
    }
    if (!isConnected || !address) {
      onConnectPress();
      return;
    }
    if (!isOnBsc(chainId)) {
      setBusy(true);
      setStatus('当前不是 BSC，正在请求钱包切换网络。');
      try {
        await onSwitchBsc();
        setStatus('钱包已接收 BSC 切换请求，网络状态更新后请再次结算。');
      } catch (error) {
        setStatus(checkoutErrorMessage(error, 'switching'));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!provider) {
      setStatus('钱包 provider 未就绪，请重新连接钱包。');
      return;
    }
    if (productState !== 'ready') {
      setStatus('商品与 SKU 尚未从 API 完成同步，已阻止结算。');
      return;
    }
    const checkoutItems = items.filter((item) => item.selected && item.quantity > 0);
    if (checkoutItems.length === 0 || total <= 0) {
      setStatus('请先勾选至少一个商品。');
      return;
    }

    const input: CheckoutIntentInput = {
      buyerAddress: address,
      idempotencyKey: checkoutAttemptKey(address),
      items: checkoutItems
    };
    setBusy(true);
    setFinalCheck(null);
    setCheckoutDraft(null);
    try {
      setStatus('请在钱包签署 Buyer SIWE 登录消息，以保护订单和地址数据。');
      const session = await ensureBuyerSession(provider, address);
      setBuyerToken(session.token);
      setStatus('正在调用库存复核，未通过不会创建订单。');
      const preflight = await runStockPreflight(input, session.token);
      if (!preflight.ok) throw new Error(preflightFailureMessage(preflight.lines));
      setStatus('库存复核通过，正在生成付前 5 要素终核。');
      const checked = await createFinalCheck(input, session.token);
      if (!checked.ok || !checked.nextAction) throw new Error(finalCheckFailureMessage(checked));
      setCheckoutDraft(input);
      setFinalCheck(checked);
      setStatus(`库存与履约已于 ${checked.checkedAt} 复核通过，请确认终核要素。`);
    } catch (error) {
      setStatus(checkoutErrorMessage(error, 'preflight'));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmPayment() {
    if (!checkoutDraft || !finalCheck || !provider || !address) return;
    setBusy(true);
    let phase: 'switching' | 'final-check' | 'allowance' | 'approval' | 'payment' | 'polling' = 'switching';
    try {
      const token = buyerToken || (await ensureBuyerSession(provider, address)).token;
      if (!buyerToken) setBuyerToken(token);
      const currentChainId = await provider.request<string>({ method: 'eth_chainId' });
      if (!isOnBsc(currentChainId)) {
        setStatus('付款前检测到当前不是 BSC，正在请求钱包切换网络。');
        await onSwitchBsc();
        const switchedChainId = await provider.request<string>({ method: 'eth_chainId' });
        if (!isOnBsc(switchedChainId)) throw new Error(`钱包当前链为 ${switchedChainId}，未切换到 BSC。`);
      }

      phase = 'final-check';
      setStatus('支付前正在再次执行 final-check，防止终核期间库存变化。');
      const rechecked = await createFinalCheck(checkoutDraft, token);
      if (!rechecked.ok || !rechecked.nextAction) {
        setFinalCheck(null);
        setCheckoutDraft(null);
        throw new Error(finalCheckFailureMessage(rechecked));
      }
      setFinalCheck(rechecked);

      setStatus('终核通过，正在创建后端 checkout intent。');
      const intent = await createCheckoutIntent(checkoutDraft, token);
      if (!intent.paymentIntent) throw new Error('订单当前不可支付，后端未返回 paymentIntent。');
      const order = intent.order;
      assertNplOnlyPaymentIntent(intent.paymentIntent, address, order);
      setLastOrder(order);
      setFinalCheck(null);
      setCheckoutDraft(null);

      phase = 'allowance';
      setStatus('正在链上读取 NPL allowance。');
      const allowanceCheck = intent.paymentIntent.allowanceChecks[0]!;
      const allowance = await readAllowanceWei(provider, allowanceCheck);
      if (allowance < BigInt(allowanceCheck.requiredAmountWei)) {
        phase = 'approval';
        const approval = intent.paymentIntent.approvalTransactions.find((transaction) => transaction.key === allowanceCheck.key);
        if (!approval) throw new Error('后端未返回 NPL MaxUint256 授权交易。');
        setStatus('NPL allowance 不足，请在钱包确认 MaxUint256 授权。');
        const approvalHash = requireTxHash(await sendWalletTransaction(provider, approval), 'NPL 授权');
        setStatus(`NPL 授权已广播，正在等待打包。TxHash：${approvalHash}`);
        await waitForTransactionReceipt(provider, approvalHash);
        setStatus(`NPL 授权已打包。TxHash：${approvalHash}`);
      } else {
        setStatus('NPL allowance 充足，已跳过 approve。');
      }

      phase = 'final-check';
      const payCheck = await createFinalCheck(checkoutDraft, token);
      if (!payCheck.ok || !payCheck.nextAction) throw new Error(finalCheckFailureMessage(payCheck));

      phase = 'payment';
      setStatus('请在钱包确认 NPL payOrder 交易。');
      const fundHash = requireTxHash(await sendWalletTransaction(provider, intent.paymentIntent.payOrderTransaction), 'payOrder');
      const fundingOrder: Order = { ...order, status: 'Funding', txHash: fundHash };
      setLastTxHash(fundHash);
      setLastOrder(fundingOrder);
      await rememberPendingOrder(fundingOrder);
      setStatus(`payOrder 已广播，正在等待链上打包。最终 TxHash：${fundHash}`);
      try {
        await waitForTransactionReceipt(provider, fundHash);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('交易失败')) {
          await AsyncStorage.removeItem(pendingOrderKey(order.buyerAddress));
        }
        throw error;
      }

      phase = 'polling';
      setStatus(`payOrder 已打包，正在复核 OrderPaid 事件。最终 TxHash：${fundHash}`);
      const funding = await pollFundingUntilFinal(order.orderId, order.buyerAddress, fundHash, token, (value) => {
        setStatus(`${fundingStatusCopy(value)} TxHash：${fundHash}`);
      });
      const indexedOrder = funding.order || fundingOrder;
      setLastOrder({ ...indexedOrder, txHash: fundHash });
      if (funding.status === 'confirmed') {
        await AsyncStorage.removeItem(pendingOrderKey(order.buyerAddress));
        setStatus(`${statusCopyForIndexedOrder(indexedOrder.status)} 最终 TxHash：${fundHash}`);
      } else if (funding.status === 'failed' || funding.status === 'mismatch') {
        await AsyncStorage.removeItem(pendingOrderKey(order.buyerAddress));
        throw new Error(fundingStatusCopy(funding));
      } else {
        await rememberPendingOrder({ ...indexedOrder, status: 'Funding', txHash: fundHash });
        setStatus(`${fundingStatusCopy(funding)} 已保留 TxHash：${fundHash}`);
      }
    } catch (error) {
      setStatus(checkoutErrorMessage(error, phase));
    } finally {
      setBusy(false);
    }
  }

  function toggle(productId: string) {
    const product = products.find((entry) => entry.id === productId);
    const currentItem = items.find((entry) => entry.productId === productId);
    if (product && currentItem && itemAvailableStock(product, currentItem) <= 0) {
      setStatus('该商品暂无库存，不能加入本次 NPL 托管结算。');
      return;
    }
    setItems((current) => current.map((item) => item.productId === productId ? { ...item, selected: !item.selected } : item));
  }

  function changeQuantity(productId: string, delta: number) {
    const product = products.find((entry) => entry.id === productId);
    const currentItem = items.find((entry) => entry.productId === productId);
    if (product && currentItem && itemAvailableStock(product, currentItem) <= 0) {
      setStatus('该商品暂无库存，不能调整数量。');
      return;
    }
    setItems((current) => current.map((item) => {
      if (item.productId !== productId) return item;
      const maxQuantity = product ? Math.max(1, itemAvailableStock(product, item)) : Number.MAX_SAFE_INTEGER;
      const nextQuantity = Math.min(maxQuantity, Math.max(1, item.quantity + delta));
      if (product && item.quantity + delta > maxQuantity) setStatus(`当前 SKU 库存只剩 ${maxQuantity} 件。`);
      return { ...item, quantity: nextQuantity };
    }));
  }

  return (
    <View style={styles.shell}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          {onBack ? <Pressable accessibilityRole="button" accessibilityLabel="返回商城" onPress={onBack} style={styles.backButton}><ArrowLeft size={22} color={colors.ink} /></Pressable> : null}
          <View style={styles.titleRow}>
            <Text style={styles.title}>终核结算</Text>
            <Text style={styles.count}>({items.length})</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={cartSearchOpen ? '关闭终核清单搜索' : '搜索终核清单商品'} onPress={() => setCartSearchOpen((value) => !value)} style={styles.iconButton}>
              <Search size={30} color={colors.ink} strokeWidth={2.5} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="商品对比" accessibilityState={{ selected: compareMode }} onPress={() => { setCompareMode((value) => !value); setStatus(compareMode ? '已恢复默认终核清单排序。' : '已按托管价从高到低排序，方便对比商品。'); }} style={styles.headerTap}><Text style={[styles.headerLink, compareMode && styles.headerLinkActive]}>对比</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="管理终核清单" accessibilityState={{ selected: manageMode }} onPress={() => { setManageMode((value) => !value); setStatus(manageMode ? '已退出管理模式。' : '管理模式已开启，可勾选商品或调整数量。'); }} style={styles.headerTap}><Text style={[styles.headerLink, manageMode && styles.headerLinkActive]}>{manageMode ? '完成' : '管理'}</Text></Pressable>
          </View>
        </View>

        {cartSearchOpen ? (
          <View style={styles.searchBar}>
            <Search size={18} color={colors.inkMuted} strokeWidth={2.3} />
            <TextInput
              value={cartQuery}
              onChangeText={setCartQuery}
              placeholder="搜索待终核商品、店铺、规格"
              placeholderTextColor={colors.inkSoft}
              style={styles.searchInput}
              returnKeyType="search"
              accessibilityLabel="搜索终核清单商品"
            />
            {cartQuery ? (
              <Pressable accessibilityRole="button" accessibilityLabel="清空终核清单搜索" onPress={() => setCartQuery('')} style={styles.searchClear}>
                <Text style={styles.searchClearText}>×</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.walletRow}>
          <WalletPill
            address={address}
            chainId={chainId}
            isConnected={isConnected}
            isProjectConfigured={isProjectConfigured}
            onPress={onConnectPress}
          />
          <Text style={styles.walletNote}>24K · BSC · NPL 托管</Text>
        </View>

        {productState !== 'ready' ? (
          <View style={[styles.dataState, productState === 'error' && styles.dataStateError]}>
            {productState === 'loading' ? <ActivityIndicator color={colors.accent} /> : null}
            <View style={styles.dataStateBody}>
              <Text style={styles.dataStateTitle}>{productState === 'loading' ? '正在同步商品与 SKU' : '商品 API 加载失败'}</Text>
              <Text style={styles.dataStateText}>{productState === 'loading' ? '数据返回前不会创建订单或发起付款。' : '未使用本地商品替代，当前结算已阻断。'}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.cartList}>
          {productState === 'ready' ? (grouped.length ? grouped.map(({ product, item }, index) => item ? (
            <View key={product.id} style={styles.shopBlock}>
              <View style={styles.shopHeader}>
                <Pressable accessibilityRole="checkbox" accessibilityLabel={`选择店铺 ${product.shopName}`} accessibilityState={{ checked: item.selected }} onPress={() => toggle(product.id)} style={styles.shopCheckTap}>
                  <View style={[styles.check, item.selected && styles.checkSelected]}>
                    {item.selected ? <Text style={styles.checkMark}>✓</Text> : null}
                  </View>
                </Pressable>
                <Text style={styles.shopBadge}>{product.shopBadge}</Text>
                <Text style={styles.shopName} numberOfLines={1}>{product.shopName}</Text>
                <ChevronRight size={18} color={colors.ink} strokeWidth={2.4} />
              </View>

              <View style={styles.itemRow}>
                <Pressable accessibilityRole="checkbox" accessibilityLabel={`选择 ${product.title}`} accessibilityState={{ checked: item.selected }} onPress={() => toggle(product.id)} style={styles.itemCheckTap}>
                  <View style={[styles.check, item.selected && styles.checkSelected]}>
                    {item.selected ? <Text style={styles.checkMark}>✓</Text> : null}
                  </View>
                </Pressable>
                <View style={styles.thumbWrap}>
                  <ProductThumb product={product} size={110} />
                  {itemAvailableStock(product, item) <= 0 ? <View style={styles.soldOutMask}><Text style={styles.soldOutText}>暂无库存</Text></View> : null}
                </View>
                <View style={styles.itemInfo}>
                  <Text style={[styles.productTitle, itemAvailableStock(product, item) <= 0 && styles.productTitleMuted]} numberOfLines={2}>{product.title}</Text>
                  <Text style={styles.sku} numberOfLines={1}>{item.skuName || product.sku} · {item.fulfillmentMode === 'pickup' ? '门店自提' : '快递到家'} · 行政区 {item.regionCode || product.adminRegionCode || '待识别'} ›</Text>
                  <View style={styles.tagRow}>{product.tags.slice(0, 3).map((tag) => <Text key={tag} style={[styles.tag, tag.includes('下架') && styles.tagMuted]}>{tag}</Text>)}</View>
                  <View style={styles.priceRow}>
                    <Text style={styles.pricePrefix}>托管价</Text>
                    <Text style={styles.price}>{formatNpl(item.unitPriceNpl ?? product.priceNpl)}</Text>
                    <Text style={styles.priceUnit}>NPL</Text>
                    {product.originalPriceNpl ? <Text style={styles.original}>{formatNpl(product.originalPriceNpl)}</Text> : null}
                  </View>
                  {itemAvailableStock(product, item) > 0 ? (
                    <View style={styles.benefitLine}>
                      <Text style={styles.benefitText}>{index === 0 ? 'BNM全返 · 签收后释放' : index === 2 ? '区域绑定 · 托管成交' : 'NPL 托管 · 链上可查'}</Text>
                    </View>
                  ) : (
                    <View style={styles.recoLine}>
                      <Text style={styles.recoText}>到货提醒已开启  |  查看相似商品 ›</Text>
                    </View>
                  )}
                </View>
                {itemAvailableStock(product, item) > 0 ? (
                  <View style={styles.qtyBox}>
                    <Pressable accessibilityRole="button" accessibilityLabel={`减少 ${product.title} 数量`} onPress={() => changeQuantity(product.id, -1)} style={styles.qtyButton}><Minus size={13} color={colors.ink} /></Pressable>
                    <Text style={styles.qty}>x{item.quantity}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={`增加 ${product.title} 数量`} onPress={() => changeQuantity(product.id, 1)} style={styles.qtyButton}><Plus size={13} color={colors.ink} /></Pressable>
                  </View>
                ) : (
                  <View style={styles.cartIconBubble}><ShoppingCart size={23} color={colors.orange} /></View>
                )}
              </View>
            </View>
          ) : null) : (
            <View style={styles.emptyCartSearch}>
              <Text style={styles.emptyCartTitle}>{cartQuery ? '没有匹配商品' : '终核清单为空'}</Text>
              <Text style={styles.emptyCartText}>{cartQuery ? '清空搜索后可查看全部终核清单商品。' : '请返回商城选择商品。'}</Text>
            </View>
          )) : null}
        </View>

        <View style={styles.statusBox}>
          <ShieldCheck size={18} color={colors.green} strokeWidth={2.4} />
          <Text style={styles.statusText}>{status}</Text>
        </View>
        {lastOrder ? <Text style={styles.orderHint}>订单：{lastOrder.orderId.slice(0, 14)}... · {lastOrder.status}</Text> : null}
        {lastTxHash ? (
          <View style={styles.txCard}>
            <Text style={styles.txLabel}>最终 TxHash</Text>
            <Text selectable style={styles.txHash}>{lastTxHash}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.checkoutBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="全选终核清单商品" style={styles.allSelect} onPress={() => setItems((current) => current.map((item) => {
          const product = products.find((entry) => entry.id === item.productId);
          return { ...item, selected: Boolean(product && itemAvailableStock(product, item) > 0) };
        }))}>
          <View style={styles.emptyCheck} />
          <Text style={styles.allText}>全选</Text>
        </Pressable>
        <View style={styles.totalBox}>
          <Text style={styles.totalLabel}>合计:</Text>
          <Text style={styles.totalValue}>{formatNpl(total)}</Text>
          <Text style={styles.totalUnit}>NPL</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="终核并用 NPL 支付" disabled={busy || productState !== 'ready'} onPress={handleCheckout} style={({ pressed }) => [styles.checkoutButton, (pressed || busy || productState !== 'ready') && styles.checkoutPressed]}>
          {busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.checkoutText}>{productState === 'loading' ? '同步中' : productState === 'error' ? '不可结算' : selectedCount ? '结算' : '选择商品'}</Text>}
        </Pressable>
      </View>

      <Modal visible={finalCheck !== null} transparent animationType="fade" onRequestClose={() => { if (!busy) { setFinalCheck(null); setCheckoutDraft(null); } }}>
        <View style={styles.modalBackdrop}>
          <View style={styles.finalCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭付前终核"
              disabled={busy}
              onPress={() => { setFinalCheck(null); setCheckoutDraft(null); }}
              style={styles.modalClose}
            >
              <X size={19} color={colors.ink} />
            </Pressable>
            <Text style={styles.finalEyebrow}>FINAL CHECK</Text>
            <Text style={styles.finalTitle}>{finalCheck?.title || '付前 5 要素终核'}</Text>
            <ScrollView style={styles.finalScroll} showsVerticalScrollIndicator={false}>
              {finalCheck?.factors.map((factor) => (
                <View key={factor.key} style={styles.factorRow}>
                  <Text style={styles.factorLabel}>{factor.label}</Text>
                  <Text style={styles.factorValue}>{factor.value}</Text>
                </View>
              ))}
              <View style={styles.lockWarning}>
                <Text style={styles.lockWarningTitle}>地址与行政区归属将永久锁定</Text>
                <Text style={styles.lockWarningText}>根据 Web3 分红机制，此地址/门店的行政区划编码在付款瞬间将永久绑定对应的区域代理分红归属。付款成功后不可更改地址、门店或履约模式。</Text>
              </View>
            </ScrollView>
            <View style={styles.finalActions}>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setFinalCheck(null); setCheckoutDraft(null); }} style={styles.finalCancel}>
                <Text style={styles.finalCancelText}>返回修改</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="确认地址与规格并去付款" disabled={busy} onPress={handleConfirmPayment} style={[styles.finalPay, busy && styles.checkoutPressed]}>
                {busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.finalPayText}>确认并支付</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function reconcileCartItems(current: CartItem[], nextProducts: Product[]) {
  return current.flatMap((item) => {
    const product = nextProducts.find((entry) => entry.id === item.productId);
    if (!product) return [];
    const sku = product.skus?.find((entry) => entry.id === item.skuId);
    return [{
      ...item,
      skuName: sku?.name || item.skuName || product.sku,
      unitPriceNpl: sku?.settlementPriceNpl ?? item.unitPriceNpl ?? product.priceNpl
    }];
  });
}

function itemAvailableStock(product: Product, item: CartItem) {
  return product.skus?.find((sku) => sku.id === item.skuId)?.stock ?? product.stock;
}

async function rememberPendingOrder(order: Order) {
  await AsyncStorage.setItem(pendingOrderKey(order.buyerAddress), JSON.stringify(order));
}

function pendingOrderKey(address: string) {
  return `${PENDING_ORDER_KEY_PREFIX}:${address.toLowerCase()}`;
}

function checkoutAttemptKey(address: string) {
  const attempt = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  return `${address.toLowerCase()}:checkout:${attempt}`;
}

function isChainSettled(status: Order['status']) {
  return CHAIN_SETTLED_STATUSES.has(status);
}

function statusCopyForIndexedOrder(status: Order['status']) {
  if (status === 'PaidLocked') return '后台已确认 OrderPaid / PaidLocked。现在才通知商家发货。';
  if (status === 'Released') return '后台已确认订单已放款给商家。';
  if (status === 'ForcedRefunded') return '后台已确认平台强制退款。';
  if (status === 'EmergencyRefunded') return '后台已确认应急退款。';
  if (status === 'Arbitration') return '后台已确认订单进入平台仲裁状态。';
  if (status === 'Cancelled') return '后台已确认订单已取消。';
  return `后台已确认链上状态：${status}。`;
}

function checkoutErrorMessage(error: unknown, phase: 'switching' | 'preflight' | 'final-check' | 'allowance' | 'approval' | 'payment' | 'polling') {
  const message = error instanceof Error ? error.message : '';
  if (/4001|user rejected|rejected|denied|cancelled|canceled|拒绝|取消/i.test(message)) {
    if (phase === 'switching') return '钱包已拒绝切换到 BSC，已阻止结算。';
    if (phase === 'approval') return '钱包已拒绝 NPL 授权，payOrder 未发起。';
    if (phase === 'payment') return '钱包已拒绝 payOrder，订单未付款。';
    return '钱包已取消或拒签，流程已阻断。';
  }
  return message || '支付流程失败，请重试。';
}

function preflightFailureMessage(lines: Array<{ ok: boolean; reason?: string; title?: string; skuName?: string; availableStock?: number }>) {
  const line = lines.find((entry) => !entry.ok);
  const target = [line?.title, line?.skuName].filter(Boolean).join(' / ');
  if (line?.reason === 'INSUFFICIENT_STOCK') return `抱歉，${target || '该规格'}刚刚已被抢光或库存不足（实时库存 ${line.availableStock ?? 0}），请重新选择规格。`;
  if (line?.reason === 'ADDRESS_REQUIRED' || line?.reason === 'ADDRESS_NOT_FOUND') return '快递订单缺少后端可验证的收货地址，请先在资产页保存地址。';
  if (line?.reason === 'STORE_REQUIRED' || line?.reason === 'STORE_NOT_FOUND') return '自提订单缺少后端可验证的门店，请重新选择自提门店。';
  if (line?.reason === 'REGION_MISMATCH') return '地址/门店行政区编码与订单不一致，已阻止付款。';
  return `库存与履约复核未通过：${line?.reason || 'PREFLIGHT_REJECTED'}`;
}

function finalCheckFailureMessage(check: FinalCheckResponse) {
  return check.preflight?.lines?.length
    ? preflightFailureMessage(check.preflight.lines)
    : `付前终核未通过：${check.error || 'FINAL_CHECK_REJECTED'}`;
}

function assertNplOnlyPaymentIntent(intent: PaymentIntent, buyerAddress: string, order: Order) {
  const check = intent.allowanceChecks[0];
  const approval = intent.approvalTransactions[0];
  const buyer = buyerAddress.toLowerCase();
  const npl = NPL_BSC_ADDRESS.toLowerCase();
  const escrow = order.escrowAddress.toLowerCase();
  const maxUint256 = (2n ** 256n - 1n).toString();
  const nplOnly = isOnBsc(String(intent.chainId))
    && isOnBsc(String(order.chainId))
    && order.buyerAddress.toLowerCase() === buyer
    && intent.approvalPolicy.type === 'unlimited-npl'
    && intent.approvalPolicy.allowanceSkip === true
    && intent.approvalPolicy.amount === 'MaxUint256'
    && intent.allowanceChecks.length === 1
    && check?.key === 'npl'
    && check.symbol === 'NPL'
    && check.owner.toLowerCase() === buyer
    && check.tokenAddress.toLowerCase() === npl
    && check.to.toLowerCase() === npl
    && check.spender.toLowerCase() === escrow
    && intent.approvalTransactions.length === 1
    && approval?.key === 'npl'
    && approval.symbol === 'NPL'
    && approval.amount === 'MaxUint256'
    && approval.amountWei === maxUint256
    && approval.from?.toLowerCase() === buyer
    && approval.to.toLowerCase() === npl
    && approval.spender.toLowerCase() === escrow
    && intent.payOrderTransaction.key === 'payOrder'
    && intent.payOrderTransaction.from?.toLowerCase() === buyer
    && intent.payOrderTransaction.to.toLowerCase() === escrow
    && /^0x[0-9a-fA-F]+$/.test(intent.payOrderTransaction.data)
    && /^0x[0-9a-fA-F]{64}$/.test(intent.payOrderTransaction.productId)
    && /^0x[0-9a-fA-F]{64}$/.test(intent.payOrderTransaction.authorizationDigest)
    && /^0x[0-9a-fA-F]+$/.test(intent.payOrderTransaction.authorization)
    && /^0x[0-9a-fA-F]{40}$/.test(intent.payOrderTransaction.orderSigner)
    && intent.payOrderTransaction.orderDigest === order.orderDigest
    && isPositiveIntegerString(intent.payOrderTransaction.bnmLockedWei)
    && Number.isSafeInteger(intent.payOrderTransaction.splitVersion)
    && intent.payOrderTransaction.splitVersion > 0
    && intent.payOrderTransaction.deadline > Math.floor(Date.now() / 1000);
  if (!nplOnly) throw new Error('后端 paymentIntent 不符合 NPL-only allowance/approve/9 参数 payOrder 约束，已阻止交易。');
}

function isPositiveIntegerString(value: string) {
  return /^\d+$/.test(value) && BigInt(value) > 0n;
}

function requireTxHash(value: string, action: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${action} 未返回有效 TxHash，已停止后续流程。`);
  return value;
}

async function pollFundingUntilFinal(orderId: string, buyerAddress: string, txHash: string, token: string, onUpdate: (status: TxStatusResponse) => void) {
  let latest = await fetchFundingTxStatus(orderId, buyerAddress, txHash, token);
  onUpdate(latest);
  for (let attempt = 0; latest.retryable && attempt < 29; attempt += 1) {
    await delay(3_000);
    latest = await fetchFundingTxStatus(orderId, buyerAddress, txHash, token);
    onUpdate(latest);
  }
  return latest;
}

function fundingStatusCopy(status: TxStatusResponse) {
  if (status.status === 'pending') return '付款交易正在打包/等待 OrderPaid 事件。';
  if (status.status === 'confirmed') return '后端已验证 OrderPaid，订单进入 PaidLocked。';
  if (status.status === 'failed') return `链上 payOrder 执行失败：${status.error || 'CHAIN_EVENT_TX_FAILED'}`;
  if (status.status === 'mismatch') return `回执与订单不匹配，已停止处理：${status.error || 'CHAIN_EVENT_MISMATCH'}`;
  return `后端 RPC 暂不可用，订单仍未标记成功：${status.error || 'RPC_UNAVAILABLE'}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.page },
  screen: { flex: 1 },
  content: { paddingTop: 18, paddingBottom: 118 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: 18, backgroundColor: colors.surface, gap: spacing.sm },
  backButton: { width: 42, height: 42, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { color: colors.ink, fontSize: 33, fontWeight: '900', letterSpacing: -1.2 },
  count: { color: colors.ink, fontSize: 19, fontWeight: '600' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerTap: { minHeight: 44, justifyContent: 'center' },
  headerLink: { color: colors.ink, fontSize: 19, fontWeight: '700' },
  headerLinkActive: { color: colors.accent },
  searchBar: { minHeight: 52, marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md },
  searchInput: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '700', paddingVertical: 0 },
  searchClear: { width: 30, height: 30, borderRadius: radius.round, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  searchClearText: { color: colors.inkMuted, fontSize: 22, lineHeight: 24, fontWeight: '700' },
  walletRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#EEF0F3', backgroundColor: colors.surface },
  walletNote: { color: colors.inkMuted, fontSize: 12, fontWeight: '800' },
  dataState: { margin: spacing.lg, marginBottom: 0, borderRadius: radius.lg, backgroundColor: colors.surfaceDark, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dataStateError: { backgroundColor: colors.brownDeep },
  dataStateBody: { flex: 1 },
  dataStateTitle: { color: colors.gold, fontSize: 13, fontWeight: '900' },
  dataStateText: { color: colors.champagne, marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  cartList: { backgroundColor: '#EEF0F3' },
  emptyCartSearch: { margin: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, padding: spacing.xl, alignItems: 'center' },
  emptyCartTitle: { color: colors.ink, fontSize: 18, fontWeight: '900' },
  emptyCartText: { color: colors.inkMuted, marginTop: 6, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  shopBlock: { backgroundColor: colors.surface, paddingTop: 16, paddingBottom: 18, marginBottom: 10 },
  shopHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: 13 },
  shopCheckTap: { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
  check: { width: 28, height: 28, borderRadius: radius.round, borderWidth: 2.3, borderColor: '#CCD2DB', backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  checkSelected: { borderColor: colors.orange, backgroundColor: colors.orange },
  checkMark: { color: colors.surface, fontSize: 17, fontWeight: '900', lineHeight: 21 },
  shopBadge: { color: colors.orange, fontSize: 22, fontWeight: '900', marginRight: 7, letterSpacing: -0.6 },
    shopName: { flex: 1, color: colors.ink, fontSize: 21, fontWeight: '900', letterSpacing: -0.5 },
  itemRow: { flexDirection: 'row', paddingHorizontal: spacing.lg, alignItems: 'flex-start' },
  itemCheckTap: { width: 40, height: 112, alignItems: 'flex-start', justifyContent: 'center' },
  thumbWrap: { width: 110, height: 110, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#F4F5F7' },
  soldOutMask: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 28, backgroundColor: 'rgba(18,24,38,0.78)', alignItems: 'center', justifyContent: 'center' },
  soldOutText: { color: colors.surface, fontSize: 16, fontWeight: '900' },
  itemInfo: { flex: 1, minHeight: 112, paddingLeft: spacing.md, paddingRight: spacing.sm },
  productTitle: { color: colors.ink, fontSize: 18, fontWeight: '700', lineHeight: 25, letterSpacing: -0.25 },
  productTitleMuted: { color: colors.inkMuted },
  sku: { marginTop: 5, color: colors.inkMuted, fontSize: 15, fontWeight: '600' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
  tag: { color: colors.orange, borderColor: '#FFD2B7', borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, fontSize: 12, fontWeight: '800', backgroundColor: '#FFFDFC' },
  tagMuted: { color: colors.inkMuted, borderColor: '#DDE2EA' },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 8 },
  pricePrefix: { color: colors.accent, fontSize: 15, fontWeight: '900' },
  price: { color: colors.accent, fontSize: 28, fontWeight: '900', letterSpacing: -1 },
  priceUnit: { color: colors.accent, fontSize: 12, fontWeight: '900' },
  original: { color: colors.inkSoft, textDecorationLine: 'line-through', fontSize: 15, fontWeight: '700', marginLeft: 4 },
  benefitLine: { marginTop: 4 },
  benefitText: { color: colors.rose, fontSize: 13, fontWeight: '800' },
  recoLine: { marginTop: 5 },
  recoText: { color: colors.inkMuted, fontSize: 14, fontWeight: '800' },
  qtyBox: { alignItems: 'center', gap: 6, marginLeft: 2 },
  qtyButton: { width: 30, height: 28, borderRadius: 9, backgroundColor: '#F0F2F4', alignItems: 'center', justifyContent: 'center' },
  qty: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  cartIconBubble: { width: 44, height: 44, borderRadius: radius.round, backgroundColor: '#FFF2E8', alignItems: 'center', justifyContent: 'center', marginLeft: 4, marginTop: 56 },
  statusBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#ECFFF5', borderRadius: radius.md, padding: spacing.md, marginHorizontal: spacing.lg, marginTop: spacing.sm },
  statusText: { flex: 1, color: '#176A42', fontSize: 14, fontWeight: '700', lineHeight: 19 },
  orderHint: { color: colors.inkMuted, fontSize: 12, fontWeight: '700', marginHorizontal: spacing.lg, marginTop: 8 },
  txCard: { marginHorizontal: spacing.lg, marginTop: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceDark, padding: spacing.md },
  txLabel: { color: colors.gold, fontSize: 11, fontWeight: '900' },
  txHash: { color: colors.champagne, marginTop: 5, fontSize: 11, lineHeight: 17, fontWeight: '700' },
  checkoutBar: { position: 'absolute', left: 0, right: 0, bottom: 0, minHeight: 82, paddingHorizontal: spacing.lg, paddingTop: 10, paddingBottom: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: '#FFFDF9', flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  allSelect: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48 },
  emptyCheck: { width: 27, height: 27, borderRadius: radius.round, borderWidth: 2.2, borderColor: '#CCD2DB' },
  allText: { color: colors.inkMuted, fontSize: 17, fontWeight: '700' },
  totalBox: { flex: 1, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'flex-end' },
  totalLabel: { color: colors.ink, fontSize: 16, fontWeight: '700', marginRight: 3 },
  totalValue: { color: colors.orange, fontSize: 27, fontWeight: '900', letterSpacing: -0.8 },
  totalUnit: { color: colors.orange, fontSize: 11, fontWeight: '900', marginLeft: 2 },
  checkoutButton: { minWidth: 132, height: 60, borderRadius: radius.md, backgroundColor: colors.orange, alignItems: 'center', justifyContent: 'center' },
  checkoutPressed: { opacity: 0.78 },
  checkoutText: { color: colors.surface, fontSize: 23, fontWeight: '900', letterSpacing: -0.4 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'center', padding: spacing.lg },
  finalCard: { width: '100%', maxWidth: 560, maxHeight: '88%', alignSelf: 'center', borderRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.xl },
  modalClose: { position: 'absolute', top: 12, right: 12, width: 44, height: 44, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  finalEyebrow: { color: colors.accentDeep, fontSize: 11, fontWeight: '900' },
  finalTitle: { color: colors.ink, marginTop: 5, paddingRight: 48, fontSize: 23, lineHeight: 29, fontWeight: '900' },
  finalScroll: { marginTop: spacing.lg },
  factorRow: { paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  factorLabel: { color: colors.inkMuted, fontSize: 11, fontWeight: '900' },
  factorValue: { color: colors.ink, marginTop: 5, fontSize: 14, lineHeight: 20, fontWeight: '800' },
  lockWarning: { borderRadius: radius.md, backgroundColor: '#FFF0EC', borderWidth: 1, borderColor: '#F3B7A9', padding: spacing.md, marginTop: spacing.sm, marginBottom: spacing.md },
  lockWarningTitle: { color: colors.danger, fontSize: 13, fontWeight: '900' },
  lockWarningText: { color: colors.danger, marginTop: 6, fontSize: 12, lineHeight: 18, fontWeight: '800' },
  finalActions: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.md },
  finalCancel: { flex: 1, minHeight: 50, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  finalCancelText: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  finalPay: { flex: 1.5, minHeight: 50, borderRadius: radius.md, backgroundColor: colors.orange, alignItems: 'center', justifyContent: 'center' },
  finalPayText: { color: colors.surface, fontSize: 15, fontWeight: '900' }
});
