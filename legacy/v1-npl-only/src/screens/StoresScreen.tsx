import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CheckCircle2, Compass, MapPin, Navigation, Phone, ShieldCheck, SlidersHorizontal } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { fetchDappStoresState } from '../services/api';
import type { DappStore } from '../services/api';
import { colors, radius, shadow, spacing } from '../theme/tokens';

type Coordinates = { lat: number; lng: number };
type LocationState = 'requesting' | 'ready' | 'unavailable';

type Props = { selectedStoreId?: string; onSelectStore?: (store: DappStore) => void };

export function StoresScreen({ selectedStoreId, onSelectStore }: Props) {
  const [stores, setStores] = useState<DappStore[]>([]);
  const [apiState, setApiState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [locationState, setLocationState] = useState<LocationState>('requesting');
  const [region, setRegion] = useState('全部');
  const [notice, setNotice] = useState('正在请求系统定位并同步门店 API。');

  useEffect(() => {
    let mounted = true;
    async function loadStores() {
      let coordinates: Coordinates | undefined;
      try {
        coordinates = await requestCurrentCoordinates();
        if (mounted) setLocationState('ready');
      } catch (error) {
        if (mounted) {
          setLocationState('unavailable');
          setNotice(`${locationErrorMessage(error)} 未向 API 提交坐标，距离将保持隐藏。`);
        }
      }

      try {
        const payload = await fetchDappStoresState(coordinates || {});
        if (!mounted) return;
        setStores(payload.stores);
        setApiState('ready');
        if (coordinates) {
          setNotice(`GPS 坐标已交给门店 API，仅显示 distanceSource=gps 的距离。同步时间：${payload.generatedAt}`);
        } else {
          setNotice('门店 API 已返回；因未取得 GPS，不显示任何距离数字。');
        }
      } catch (error) {
        if (!mounted) return;
        setStores([]);
        setApiState('error');
        setNotice(error instanceof Error ? error.message : '门店 API 加载失败。');
      }
    }
    loadStores();
    return () => { mounted = false; };
  }, []);

  const regions = useMemo(() => ['全部', ...new Set(stores.map((store) => store.city).filter(Boolean))], [stores]);
  const filtered = useMemo(() => region === '全部' ? stores : stores.filter((store) => store.city === region), [region, stores]);

  async function callStore(store: DappStore) {
    const apiUrl = store.actions?.call;
    const phone = store.phone.replace(/[^\d+]/g, '');
    const url = apiUrl?.startsWith('tel:') ? apiUrl : phone ? `tel:${phone}` : '';
    if (!url) {
      setNotice(`${store.name} 未返回可用电话，未打开拨号器。`);
      return;
    }
    try {
      await Linking.openURL(url);
      setNotice(`已调用系统拨号器：${store.phone}`);
    } catch (error) {
      setNotice(`无法打开系统拨号器：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function navigateStore(store: DappStore) {
    const lat = store.actions?.navigation?.lat ?? store.lat;
    const lng = store.actions?.navigation?.lng ?? store.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setNotice(`${store.name} 未返回有效经纬度，未打开地图。`);
      return;
    }
    const label = store.actions?.navigation?.label || store.name;
    const url = nativeMapUrl(lat, lng, label);
    try {
      await Linking.openURL(url);
      setNotice(`已调用系统地图导航到 ${store.name}。`);
    } catch (error) {
      setNotice(`无法打开系统地图：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function selectStore(store: DappStore) {
    onSelectStore?.(store);
    setNotice(`已选择自提门店：${store.name} · ${store.regionCode}`);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <LinearGradient colors={['#080704', '#1D170D']} style={styles.hero}>
        <View style={styles.heroCopy}>
          <Text style={styles.title}>线下门店</Text>
          <Text style={styles.subtitle}>自提门店绑定行政区编码，核销后进入履约和区域收益账本。</Text>
        </View>
        <Image source={require('../../assets/products/24k-store-front.png')} resizeMode="cover" style={styles.heroImage} />
      </LinearGradient>

      <View style={styles.notice}><ShieldCheck size={17} color={colors.goldDeep} /><Text style={styles.noticeText}>{notice}</Text></View>
      {apiState !== 'ready' ? (
        <View style={[styles.stateNotice, apiState === 'error' && styles.stateNoticeError]}>
          {apiState === 'loading' ? <ActivityIndicator color={colors.gold} /> : null}
          <Text style={styles.stateTitle}>{apiState === 'loading' ? '正在同步门店' : '门店接口加载失败'}</Text>
          <Text style={styles.stateText}>{apiState === 'loading' ? '未返回前不显示本地门店或距离。' : '已保持失败状态，未用本地数据替代。'}</Text>
        </View>
      ) : null}

      <View style={styles.filterHead}><View style={styles.filterTitle}><SlidersHorizontal size={18} color={colors.ink} /><Text style={styles.filterText}>地区筛选</Text></View><Text style={styles.result}>{apiState === 'ready' ? `${filtered.length} 家` : '--'}</Text></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.regionRail}>{regions.map((item) => {
        const active = item === region;
        return <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => setRegion(item)} style={[styles.region, active && styles.regionActive]}><Text style={[styles.regionText, active && styles.regionTextActive]}>{item}</Text></Pressable>;
      })}</ScrollView>

      <View style={styles.mapCard}>
        {locationState === 'requesting' ? <ActivityIndicator color={colors.gold} /> : <Compass size={32} color={colors.gold} />}
        <View style={styles.mapRings}><View style={styles.mapDot} /></View>
        <Text style={styles.mapTitle}>{locationState === 'ready' ? 'GPS 距离已同步' : locationState === 'requesting' ? '正在请求 GPS' : '未取得 GPS 距离'}</Text>
        <Text style={styles.mapText}>{locationState === 'ready' ? '坐标由系统定位获取，距离由门店 API 计算并标记为 gps。' : '未获得系统定位时，门店仍可拨号和导航，但不显示预设距离。'}</Text>
      </View>

      {apiState === 'ready' ? <View style={styles.list}>{filtered.length ? filtered.map((store) => (
        <StoreCard key={store.id} store={store} selected={selectedStoreId === store.id} onCall={() => callStore(store)} onNav={() => navigateStore(store)} onSelect={() => selectStore(store)} />
      )) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>{region === '全部' ? '暂无真实门店数据' : '该地区暂无门店'}</Text>
          <Text style={styles.emptyText}>{region === '全部' ? '门店 API 未返回持久化门店，因此不显示预设门店。' : '切换到全部地区可查看其他 API 门店。'}</Text>
          {region !== '全部' ? <Pressable accessibilityRole="button" accessibilityLabel="查看全部门店" onPress={() => setRegion('全部')} style={styles.emptyAction}><Text style={styles.emptyActionText}>查看全部门店</Text></Pressable> : null}
        </View>
      )}</View> : null}
    </ScrollView>
  );
}

function StoreCard({ store, selected, onCall, onNav, onSelect }: { store: DappStore; selected: boolean; onCall: () => void; onNav: () => void; onSelect: () => void }) {
  const hasGpsDistance = store.distanceSource === 'gps' && Number.isFinite(store.distanceKm);
  const canCall = Boolean(store.actions?.call || store.phone);
  const navLat = store.actions?.navigation?.lat ?? store.lat;
  const navLng = store.actions?.navigation?.lng ?? store.lng;
  const canNavigate = Number.isFinite(navLat) && Number.isFinite(navLng);
  return (
    <View style={[styles.storeCard, selected && styles.storeCardSelected]}>
      <View style={styles.storeTop}>
        <View style={styles.storeIcon}><MapPin size={22} color={colors.obsidian} /></View>
        <View style={styles.storeInfo}><Text style={styles.storeName}>{store.name}</Text><Text style={styles.storeAddr}>{store.address}</Text></View>
        <Text style={styles.distance}>{hasGpsDistance ? `${store.distanceKm!.toFixed(1)} km` : '距离待定位'}</Text>
      </View>
      <View style={styles.metaRow}><Text style={styles.meta}>营业 {store.hours || '待同步'}</Text><Text style={styles.meta}>行政区 {store.regionCode || '待同步'}</Text></View>
      <View style={styles.actionRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={`拨打 ${store.name}`} disabled={!canCall} onPress={onCall} style={[styles.ghostButton, !canCall && styles.buttonDisabled]}><Phone size={17} color={colors.ink} /><Text style={styles.ghostText}>拨号</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`导航到 ${store.name}`} disabled={!canNavigate} onPress={onNav} style={[styles.ghostButton, !canNavigate && styles.buttonDisabled]}><Navigation size={17} color={colors.ink} /><Text style={styles.ghostText}>导航</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`选择 ${store.name} 自提`} accessibilityState={{ selected }} disabled={selected} onPress={onSelect} style={[styles.goldButton, selected && styles.storeSelectedButton]}><CheckCircle2 size={17} color={colors.obsidian} /><Text style={styles.goldText}>{selected ? '已选' : '自提'}</Text></Pressable>
      </View>
    </View>
  );
}

function requestCurrentCoordinates(): Promise<Coordinates> {
  const geolocation = (globalThis.navigator as Navigator & { geolocation?: Geolocation }).geolocation;
  if (!geolocation) return Promise.reject(new Error('当前运行环境未提供系统定位 API。'));
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) => reject(new Error(error.message || `GEOLOCATION_ERROR_${error.code}`)),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 }
    );
  });
}

function nativeMapUrl(lat: number, lng: number, label: string) {
  const encodedLabel = encodeURIComponent(label);
  if (Platform.OS === 'ios') return `https://maps.apple.com/?ll=${lat},${lng}&q=${encodedLabel}`;
  if (Platform.OS === 'android') return `geo:${lat},${lng}?q=${lat},${lng}(${encodedLabel})`;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

function locationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/denied|permission|PERMISSION_DENIED|拒绝/i.test(message)) return '定位权限被拒绝。';
  if (/timeout/i.test(message)) return '获取系统定位超时。';
  return message || '无法获取系统定位。';
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  content: { paddingBottom: 120 },
  hero: { minHeight: 258, padding: spacing.lg, overflow: 'hidden' },
  heroCopy: { width: '62%', zIndex: 1 },
  title: { color: colors.white, fontSize: 32, fontWeight: '900' },
  subtitle: { color: '#E8D8AA', marginTop: spacing.sm, fontSize: 14, lineHeight: 20, fontWeight: '700' },
  heroImage: { position: 'absolute', right: -28, bottom: -44, width: 232, height: 232, borderRadius: 44, opacity: 0.92 },
  notice: { margin: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.accentSoft, padding: spacing.md, flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  noticeText: { flex: 1, color: colors.goldDeep, fontSize: 13, lineHeight: 18, fontWeight: '800' },
  stateNotice: { marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceDark, padding: spacing.md },
  stateNoticeError: { backgroundColor: colors.brownDeep },
  stateTitle: { color: colors.gold, marginTop: 6, fontSize: 13, fontWeight: '900' },
  stateText: { color: colors.champagne, marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  filterHead: { paddingHorizontal: spacing.lg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  filterTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  filterText: { color: colors.ink, fontSize: 20, fontWeight: '900' },
  result: { color: colors.inkMuted, fontSize: 13, fontWeight: '900' },
  regionRail: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  region: { height: 38, paddingHorizontal: 15, borderRadius: radius.round, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, justifyContent: 'center' },
  regionActive: { backgroundColor: colors.graphite, borderColor: colors.graphite },
  regionText: { color: colors.inkMuted, fontSize: 13, fontWeight: '800' },
  regionTextActive: { color: colors.champagne },
  mapCard: { marginHorizontal: spacing.lg, borderRadius: radius.xl, backgroundColor: colors.surfaceDark, minHeight: 156, padding: spacing.lg, overflow: 'hidden', ...shadow.soft },
  mapRings: { position: 'absolute', right: -20, top: -20, width: 170, height: 170, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(216,162,58,0.32)', alignItems: 'center', justifyContent: 'center' },
  mapDot: { width: 70, height: 70, borderRadius: 999, backgroundColor: 'rgba(216,162,58,0.28)' },
  mapTitle: { color: colors.white, marginTop: spacing.md, fontSize: 22, fontWeight: '900' },
  mapText: { color: '#CDBB8A', marginTop: 6, fontSize: 13, lineHeight: 18, fontWeight: '700', maxWidth: 250 },
  list: { gap: spacing.md, padding: spacing.lg },
  emptyState: { borderRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.xl, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, ...shadow.soft },
  emptyTitle: { color: colors.ink, fontSize: 19, fontWeight: '900', textAlign: 'center' },
  emptyText: { color: colors.inkMuted, marginTop: 7, fontSize: 13, lineHeight: 19, fontWeight: '700', textAlign: 'center' },
  emptyAction: { marginTop: spacing.md, minHeight: 44, borderRadius: radius.round, backgroundColor: colors.gold, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  emptyActionText: { color: colors.obsidian, fontSize: 13, fontWeight: '900' },
  storeCard: { borderRadius: radius.xl, backgroundColor: colors.surface, padding: spacing.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, ...shadow.soft },
  storeCardSelected: { borderWidth: 2, borderColor: colors.gold },
  storeTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  storeIcon: { width: 44, height: 44, borderRadius: radius.round, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  storeInfo: { flex: 1 },
  storeName: { color: colors.ink, fontSize: 18, fontWeight: '900' },
  storeAddr: { color: colors.inkMuted, marginTop: 5, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  distance: { maxWidth: 92, color: colors.goldDeep, fontSize: 12, lineHeight: 17, fontWeight: '900', textAlign: 'right' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  meta: { color: colors.inkMuted, backgroundColor: colors.surfaceMuted, borderRadius: radius.round, paddingHorizontal: 10, paddingVertical: 5, fontSize: 12, fontWeight: '800' },
  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  ghostButton: { flex: 1, height: 48, borderRadius: radius.round, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  ghostText: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  goldButton: { flex: 1.15, height: 48, borderRadius: radius.round, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  storeSelectedButton: { backgroundColor: colors.green },
  goldText: { color: colors.obsidian, fontSize: 14, fontWeight: '900' },
  buttonDisabled: { opacity: 0.46 }
});
