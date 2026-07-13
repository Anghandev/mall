import { useEffect, useMemo, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ChevronRight, MapPin, PackageCheck, Search, ShieldCheck, SlidersHorizontal, X } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ProductThumb } from '../components/ProductThumb';
import { fetchProducts } from '../services/api';
import { formatNpl } from '../services/orderMath';
import { colors, radius, shadow, spacing } from '../theme/tokens';
import type { DappStore } from '../services/api';
import type { AddressBookEntry, CartItem, FulfillmentMode, Product, Sku } from '../types';

type Props = {
  cartItems?: CartItem[];
  notice?: string;
  onAddToCart?: (product: Product, selection?: Partial<CartItem>) => boolean;
  onOpenCheckout?: () => void;
  onOpenSeckill?: () => void;
  onOpenAssets?: () => void;
  onOpenStores?: () => void;
  deliveryAddress?: AddressBookEntry | null;
  pickupStore?: DappStore | null;
  preferredFulfillmentMode?: FulfillmentMode | null;
  address?: string;
  chainId?: string;
  isConnected?: boolean;
  isProjectConfigured?: boolean;
  provider?: unknown;
  onConnectPress?: () => void;
  onSwitchBsc?: () => Promise<void>;
};

const categories: Array<Product['category'] | '全部'> = ['全部', '数码', '运动', '食品', '穿搭', '居家'];

export function MallScreen({ cartItems = [], notice = '', onAddToCart = () => false, onOpenCheckout = () => {}, onOpenSeckill, onOpenAssets = () => {}, onOpenStores = () => {}, deliveryAddress = null, pickupStore = null, preferredFulfillmentMode = null }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [apiState, setApiState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [apiError, setApiError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Product['category'] | '全部'>('全部');
  const [stockOnly, setStockOnly] = useState(false);
  const [selected, setSelected] = useState<Product | null>(null);
  const [selectedSku, setSelectedSku] = useState<Sku | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [mode, setMode] = useState<FulfillmentMode>('delivery');
  const [localNotice, setLocalNotice] = useState('');

  useEffect(() => {
    let mounted = true;
    fetchProducts()
      .then((nextProducts) => {
        if (!mounted) return;
        setProducts(nextProducts);
        setApiError('');
        setLocalNotice(`已从商品 API 同步 ${nextProducts.length} 件商品，库存与 SKU 以接口返回为准。`);
        setApiState('ready');
      })
      .catch((error) => {
        if (!mounted) return;
        setProducts([]);
        setApiState('error');
        setApiError(error instanceof Error ? error.message : '商品 API 加载失败。');
        setLocalNotice('');
      });
    return () => { mounted = false; };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return products.filter((product) => {
      const inCategory = category === '全部' || product.category === category;
      const inStock = !stockOnly || product.stock > 0;
      const inQuery = !needle || [product.title, product.shopName, product.sku, product.summary, product.tags.join(' ')].join(' ').toLowerCase().includes(needle);
      return inCategory && inStock && inQuery;
    });
  }, [category, products, query, stockOnly]);

  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const activeSku = selectedSku || selected?.skus?.[0] || null;
  const stockState = activeSku ? `${activeSku.name} · 库存 ${activeSku.stock}` : selected ? `库存 ${selected.stock}` : '等待选择商品';
  const nplTotal = (activeSku?.settlementPriceNpl || selected?.priceNpl || 0) * quantity;

  function openProduct(product: Product) {
    setSelected(product);
    setSelectedSku(product.skus?.[0] || null);
    setQuantity(1);
    setMode(preferredFulfillmentMode && product.fulfillmentModes.includes(preferredFulfillmentMode)
      ? preferredFulfillmentMode
      : product.fulfillmentModes.includes('delivery') ? 'delivery' : product.fulfillmentModes[0] || 'delivery');
  }

  function addSelected() {
    if (!selected) return;
    if (mode === 'delivery' && !deliveryAddress) {
      setLocalNotice('请先从我的资产选择一个已复核的收货地址。');
      return;
    }
    if (mode === 'pickup' && !pickupStore) {
      setLocalNotice('请先从线下门店选择自提门店。');
      return;
    }
    if (mode === 'pickup' && pickupStore?.merchantAddress && pickupStore.merchantAddress.toLowerCase() !== selected.sellerAddress.toLowerCase()) {
      setLocalNotice('所选自提门店不属于该商品商家，请重新选择门店。');
      return;
    }
    const added = onAddToCart(selected, {
      skuId: activeSku?.id,
      skuName: activeSku?.name,
      unitPriceNpl: activeSku?.settlementPriceNpl || selected.priceNpl,
      quantity,
      fulfillmentMode: mode,
      addressId: mode === 'delivery' ? deliveryAddress?.id : undefined,
      storeId: mode === 'pickup' ? pickupStore?.id : undefined,
      regionCode: mode === 'delivery' ? deliveryAddress?.regionCode : pickupStore?.regionCode
    });
    if (!added) return;
    setLocalNotice(`${selected.title} · ${activeSku?.name || selected.sku} × ${quantity} 已加入终核清单。`);
  }

  const pickupStoreMatchesSeller = Boolean(selected && pickupStore && (!pickupStore.merchantAddress || pickupStore.merchantAddress.toLowerCase() === selected.sellerAddress.toLowerCase()));
  const fulfillmentReady = mode === 'delivery' ? Boolean(deliveryAddress) : pickupStoreMatchesSeller;
  const fulfillmentLabel = mode === 'delivery'
    ? deliveryAddress ? `${deliveryAddress.name} · ${deliveryAddress.province}${deliveryAddress.city}${deliveryAddress.district}${deliveryAddress.detail}` : '未选择收货地址'
    : pickupStoreMatchesSeller ? `${pickupStore!.name} · ${pickupStore!.address}` : pickupStore ? '当前门店与商品商家不匹配' : '未选择自提门店';

  return (
    <View style={styles.shell}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <LinearGradient colors={['#080704', '#1B150A', '#F3EFE6']} locations={[0, 0.64, 1]} style={styles.heroWrap}>
          <Image source={require('../../assets/products/24k-phone.png')} resizeMode="cover" style={styles.heroImage} />
          <View style={styles.heroScrim} />
          <View style={styles.heroTop}>
            <View>
              <Text style={styles.brand}>24K 常规商城</Text>
              <Text style={styles.brandSub}>NPL 托管 · BNM 全返 · 区域绑定</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="打开终核清单" onPress={onOpenSeckill || onOpenCheckout} style={styles.cartPill}>
              <Text style={styles.cartPillLabel}>终核</Text><Text style={styles.cartPillText}>{cartCount}</Text>
            </Pressable>
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroEyebrow}>24K CURATED</Text>
            <Text style={styles.heroTitle}>精选现货，链上托管成交</Text>
            <Text style={styles.heroText}>商品、SKU、履约、地址和库存先终核，再完成 NPL 托管支付广播。</Text>
          </View>
        </LinearGradient>

        <View style={styles.searchDock}>
          <View style={styles.searchBox}>
            <Search size={20} color={colors.inkMuted} strokeWidth={2.4} />
            <TextInput value={query} onChangeText={setQuery} placeholder="搜索 24K 商品、SKU、门店自提" placeholderTextColor={colors.inkSoft} style={styles.input} returnKeyType="search" accessibilityLabel="搜索常规商城商品" />
            {query ? <Pressable accessibilityRole="button" accessibilityLabel="清空搜索" onPress={() => setQuery('')} style={styles.clearButton}><X size={16} color={colors.inkMuted} /></Pressable> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: stockOnly }} accessibilityLabel={stockOnly ? '显示全部商品' : '只看可支付库存'} onPress={() => setStockOnly((value) => !value)} style={[styles.filterButton, stockOnly && styles.filterButtonActive]}>
            <SlidersHorizontal size={22} color={stockOnly ? colors.obsidian : colors.champagne} strokeWidth={2.3} />
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRail}>{categories.map((item) => {
          const active = item === category;
          return <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => setCategory(item)} style={[styles.category, active && styles.categoryActive]}><Text style={[styles.categoryText, active && styles.categoryTextActive]}>{item}</Text></Pressable>;
        })}</ScrollView>

        {notice || localNotice ? <View style={styles.notice}><ShieldCheck size={17} color={colors.goldDeep} /><Text style={styles.noticeText}>{notice || localNotice}</Text></View> : null}
        {apiState !== 'ready' ? (
          <StateNotice
            tone={apiState}
            title={apiState === 'loading' ? '正在同步商品/SKU' : '商品接口失败保护'}
            text={apiState === 'loading' ? '数据返回前不展示商品、SKU 或库存。' : apiError || '商品 API 加载失败，当前没有可展示的商品数据。'}
          />
        ) : null}

        <View style={styles.sectionHead}><View><Text style={styles.sectionTitle}>常规商品</Text><Text style={styles.sectionSub}>每个商品均预留 SKU、BNM 全返和履约绑定</Text></View><Text style={styles.resultCount}>{filtered.length} 件</Text></View>

        {apiState === 'ready' && filtered.length ? (
          <View style={styles.grid}>{filtered.map((product) => <ProductCard key={product.id} product={product} onOpen={() => openProduct(product)} />)}</View>
        ) : apiState === 'ready' ? (
          <EmptyState
            title={products.length ? '没有匹配商品' : '暂无可售商品'}
            text={products.length ? '清空搜索或关闭现货筛选后，可继续查看 API 返回的商品。' : '商品 API 当前未返回可售商品。'}
            action="重置筛选"
            onPress={() => { setQuery(''); setCategory('全部'); setStockOnly(false); }}
          />
        ) : null}
      </ScrollView>

      <Modal visible={selected !== null} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭商品详情" onPress={() => setSelected(null)} style={styles.close}><X size={18} color={colors.ink} /></Pressable>
            {selected ? (
              <>
                <View style={styles.sheetHead}>
                  <ProductThumb product={selected} size={88} radiusSize={radius.lg} />
                  <View style={styles.sheetTitleBlock}>
                    <Text style={styles.sheetBadge}>{selected.shopBadge} · {selected.shopName}</Text>
                    <Text style={styles.sheetTitle}>{selected.title}</Text>
                    <Text style={styles.sheetText}>{selected.summary}</Text>
                  </View>
                </View>
                <Text style={styles.controlLabel}>SKU</Text>
                <View style={styles.optionWrap}>{(selected.skus || []).map((sku) => <Pressable key={sku.id} accessibilityRole="button" accessibilityState={{ selected: activeSku?.id === sku.id }} onPress={() => setSelectedSku(sku)} style={[styles.option, activeSku?.id === sku.id && styles.optionActive]}><Text style={[styles.optionText, activeSku?.id === sku.id && styles.optionTextActive]}>{sku.name}</Text></Pressable>)}</View>
                <View style={styles.controlRow}>
                  <Text style={styles.controlLabel}>数量</Text>
                  <View style={styles.qtyControl}><Pressable onPress={() => setQuantity(Math.max(1, quantity - 1))} style={styles.qtyBtn}><Text style={styles.qtyText}>−</Text></Pressable><Text style={styles.qtyValue}>{quantity}</Text><Pressable onPress={() => setQuantity(Math.min(activeSku?.stock || selected.stock, quantity + 1))} style={styles.qtyBtn}><Text style={styles.qtyText}>+</Text></Pressable></View>
                </View>
                <Text style={styles.controlLabel}>履约方式</Text>
                <View style={styles.optionWrap}>{selected.fulfillmentModes.map((item) => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: mode === item }} onPress={() => setMode(item)} style={[styles.option, mode === item && styles.optionActive]}><Text style={[styles.optionText, mode === item && styles.optionTextActive]}>{item === 'delivery' ? '快递到家' : '门店自提'}</Text></Pressable>)}</View>
                <Pressable accessibilityRole="button" accessibilityLabel={mode === 'delivery' ? '选择收货地址' : '选择自提门店'} onPress={mode === 'delivery' ? onOpenAssets : onOpenStores} style={styles.fulfillmentPicker}>
                  <MapPin size={19} color={fulfillmentReady ? colors.green : colors.goldDeep} />
                  <View style={styles.fulfillmentPickerBody}><Text style={styles.fulfillmentPickerTitle}>{mode === 'delivery' ? '配送地址' : '自提门店'}</Text><Text numberOfLines={2} style={[styles.fulfillmentPickerValue, !fulfillmentReady && styles.fulfillmentPickerMissing]}>{fulfillmentLabel}</Text></View>
                  <ChevronRight size={18} color={colors.inkMuted} />
                </Pressable>
                <View style={styles.verifyCard}>
                  <Text style={styles.verifyTitle}>付前 5 要素终核</Text>
                  <VerifyLine label="商品" value={selected.title} />
                  <VerifyLine label="SKU / 数量" value={`${stockState} × ${quantity}`} />
                  <VerifyLine label="履约" value={mode === 'delivery' ? '快递到家' : '门店自提'} />
                  <VerifyLine label="地址/门店" value={fulfillmentLabel} />
                  <VerifyLine label="支付" value={`${formatNpl(nplTotal)} NPL`} />
                </View>
                <View style={styles.preflightNote}><ShieldCheck size={18} color={colors.goldDeep} /><Text style={styles.preflightText}>库存复核将在终核结算时调用 API，本页不预判通过结果。</Text></View>
                <View style={styles.sheetActions}>
                  <Pressable accessibilityRole="button" accessibilityLabel={fulfillmentReady ? '加入终核清单' : mode === 'delivery' ? '先选择收货地址' : '先选择自提门店'} onPress={fulfillmentReady ? addSelected : mode === 'delivery' ? onOpenAssets : onOpenStores} style={[styles.sheetButton, !fulfillmentReady && styles.sheetButtonIncomplete]}><Text style={styles.sheetButtonText}>{fulfillmentReady ? '加入终核清单' : mode === 'delivery' ? '选择收货地址' : '选择自提门店'}</Text></Pressable>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ProductCard({ product, onOpen }: { product: Product; onOpen: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`查看 ${product.title}`} onPress={onOpen} style={({ pressed }) => [styles.productCard, pressed && styles.pressed]}>
      <ProductThumb product={product} size={150} radiusSize={radius.lg} />
      <View style={styles.badgeRow}><Text style={styles.badge}>{product.shopBadge}</Text><Text style={styles.stock}>库存 {product.stock}</Text></View>
      <Text style={styles.productTitle} numberOfLines={2}>{product.title}</Text>
      <Text style={styles.productSummary} numberOfLines={2}>{product.summary}</Text>
      <View style={styles.priceRow}><Text style={styles.price}>{formatNpl(product.priceNpl)}</Text><Text style={styles.unit}>NPL</Text></View>
      <Text style={styles.rebate}>BNM {product.bnmRebateRate}% 全返 · NPL 托管</Text>
    </Pressable>
  );
}

function StateNotice({ tone, title, text }: { tone: 'loading' | 'error'; title: string; text: string }) {
  return (
    <View style={[styles.stateNotice, tone === 'error' && styles.stateNoticeError]}>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateText}>{text}</Text>
    </View>
  );
}

function EmptyState({ title, text, action, onPress }: { title: string; text: string; action: string; onPress: () => void }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyText}>{text}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={action} onPress={onPress} style={({ pressed }) => [styles.emptyAction, pressed && styles.pressed]}>
        <Text style={styles.emptyActionText}>{action}</Text>
      </Pressable>
    </View>
  );
}

function VerifyLine({ label, value }: { label: string; value: string }) {
  return <View style={styles.verifyLine}><Text style={styles.verifyLabel}>{label}</Text><Text style={styles.verifyValue} numberOfLines={1}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.page },
  screen: { flex: 1 },
  content: { paddingBottom: 124 },
  heroWrap: { minHeight: 270, padding: spacing.lg, justifyContent: 'space-between', overflow: 'hidden' },
  heroImage: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: 0.54 },
  heroScrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(8,7,4,0.38)' },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', zIndex: 1 },
  brand: { color: colors.white, fontSize: 30, fontWeight: '900', letterSpacing: -0.8 },
  brandSub: { color: colors.champagne, marginTop: 6, fontSize: 13, fontWeight: '800' },
  cartPill: { minWidth: 72, height: 40, borderRadius: radius.round, backgroundColor: colors.gold, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  cartPillLabel: { color: colors.obsidian, fontSize: 12, fontWeight: '900' },
  cartPillText: { color: colors.obsidian, fontSize: 16, fontWeight: '900' },
  heroCopy: { maxWidth: 330, zIndex: 1 },
  heroEyebrow: { color: colors.gold, fontSize: 12, fontWeight: '900', letterSpacing: 1.4 },
  heroTitle: { color: colors.white, marginTop: 8, fontSize: 31, lineHeight: 36, fontWeight: '900', letterSpacing: -1 },
  heroText: { color: '#E8D8AA', marginTop: 10, fontSize: 14, lineHeight: 20, fontWeight: '700' },
  searchDock: { marginHorizontal: spacing.lg, marginTop: -28, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  searchBox: { flex: 1, minHeight: 58, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, gap: spacing.sm, ...shadow.soft },
  input: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '700', paddingVertical: 0 },
  clearButton: { width: 32, height: 32, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  filterButton: { width: 58, height: 58, borderRadius: radius.lg, backgroundColor: colors.graphite, alignItems: 'center', justifyContent: 'center', ...shadow.soft },
  filterButtonActive: { backgroundColor: colors.gold },
  categoryRail: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md },
  category: { paddingHorizontal: 16, height: 38, borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  categoryActive: { backgroundColor: colors.graphite, borderColor: colors.graphite },
  categoryText: { color: colors.inkMuted, fontSize: 14, fontWeight: '800' },
  categoryTextActive: { color: colors.champagne },
  notice: { marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  noticeText: { flex: 1, color: colors.goldDeep, fontSize: 13, fontWeight: '800', lineHeight: 18 },
  stateNotice: { marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceDark, padding: spacing.md },
  stateNoticeError: { backgroundColor: colors.brownDeep },
  stateTitle: { color: colors.gold, fontSize: 13, fontWeight: '900' },
  stateText: { color: colors.champagne, marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  sectionHead: { paddingHorizontal: spacing.lg, paddingTop: 3, paddingBottom: spacing.md, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  sectionTitle: { color: colors.ink, fontSize: 26, fontWeight: '900', letterSpacing: -0.8 },
  sectionSub: { color: colors.inkMuted, marginTop: 5, fontSize: 13, fontWeight: '700' },
  resultCount: { color: colors.goldDeep, fontSize: 13, fontWeight: '900' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingHorizontal: spacing.lg, alignItems: 'flex-start' },
  emptyState: { marginHorizontal: spacing.lg, borderRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.xl, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, ...shadow.soft },
  emptyTitle: { color: colors.ink, fontSize: 19, fontWeight: '900' },
  emptyText: { color: colors.inkMuted, marginTop: 7, fontSize: 13, lineHeight: 19, fontWeight: '700', textAlign: 'center' },
  emptyAction: { marginTop: spacing.md, minHeight: 42, borderRadius: radius.round, backgroundColor: colors.gold, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  emptyActionText: { color: colors.obsidian, fontSize: 13, fontWeight: '900' },
  productCard: { width: '47.8%', borderRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, ...shadow.soft },
  pressed: { opacity: 0.76 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  badge: { color: colors.goldDeep, backgroundColor: colors.accentSoft, borderRadius: radius.round, paddingHorizontal: 8, paddingVertical: 3, fontSize: 11, fontWeight: '900' },
  stock: { color: colors.inkSoft, fontSize: 11, fontWeight: '800' },
  productTitle: { color: colors.ink, marginTop: spacing.sm, fontSize: 15, lineHeight: 20, fontWeight: '900', letterSpacing: -0.25 },
  productSummary: { color: colors.inkMuted, marginTop: 5, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: spacing.sm, gap: 4 },
  price: { color: colors.ink, fontSize: 19, fontWeight: '900', letterSpacing: -0.5 },
  unit: { color: colors.inkMuted, fontSize: 10, fontWeight: '900' },
  rebate: { color: colors.goldDeep, marginTop: 7, fontSize: 11, fontWeight: '900' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.50)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%', borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.lg, ...shadow.deep },
  close: { position: 'absolute', right: 14, top: 14, zIndex: 2, width: 34, height: 34, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  sheetHead: { flexDirection: 'row', gap: spacing.md, paddingRight: 32 },
  sheetTitleBlock: { flex: 1 },
  sheetBadge: { color: colors.goldDeep, fontSize: 12, fontWeight: '900' },
  sheetTitle: { color: colors.ink, marginTop: 5, fontSize: 20, lineHeight: 25, fontWeight: '900' },
  sheetText: { color: colors.inkMuted, marginTop: 5, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  controlLabel: { color: colors.ink, marginTop: spacing.lg, marginBottom: spacing.sm, fontSize: 14, fontWeight: '900' },
  optionWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  option: { borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surfaceMuted, paddingHorizontal: 13, paddingVertical: 9 },
  optionActive: { backgroundColor: colors.graphite, borderColor: colors.graphite },
  optionText: { color: colors.inkMuted, fontSize: 13, fontWeight: '800' },
  optionTextActive: { color: colors.champagne },
  controlRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  qtyControl: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  qtyBtn: { width: 36, height: 36, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  qtyText: { color: colors.ink, fontSize: 20, fontWeight: '900' },
  qtyValue: { color: colors.ink, minWidth: 24, textAlign: 'center', fontSize: 17, fontWeight: '900' },
  fulfillmentPicker: { minHeight: 64, marginTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  fulfillmentPickerBody: { flex: 1, minWidth: 0 },
  fulfillmentPickerTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  fulfillmentPickerValue: { color: colors.inkMuted, marginTop: 3, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  fulfillmentPickerMissing: { color: colors.danger },
  verifyCard: { marginTop: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.page, padding: spacing.md, gap: 8 },
  verifyTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginBottom: 2 },
  verifyLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  verifyLabel: { color: colors.inkMuted, fontSize: 12, fontWeight: '800' },
  verifyValue: { flex: 1, color: colors.ink, textAlign: 'right', fontSize: 12, fontWeight: '900' },
  preflightNote: { marginTop: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  preflightText: { flex: 1, color: colors.goldDeep, fontSize: 13, fontWeight: '800', lineHeight: 18 },
  sheetActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  sheetButton: { flex: 1.5, height: 52, borderRadius: radius.round, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  sheetButtonIncomplete: { backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.gold },
  sheetButtonText: { color: colors.obsidian, fontSize: 15, fontWeight: '900' }
});
