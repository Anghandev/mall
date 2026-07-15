import { useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  Banknote,
  Bell,
  Box,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  FileClock,
  FileUp,
  Headphones,
  History,
  ImageOff,
  LocateFixed,
  LockKeyhole,
  MapPinned,
  Megaphone,
  Minus,
  Navigation,
  Package,
  PackageOpen,
  Phone,
  Plus,
  Radio,
  RefreshCw,
  ScanLine,
  Send,
  ShieldAlert,
  ShoppingBag,
  Store,
  Tag,
  Truck,
  UserRound,
  WalletCards,
  Zap,
  X,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  AllowedAction,
  AllowedActionName,
  CatalogCategory,
  FulfillmentOrder,
  FulfillmentTarget,
  MerchantStore,
  MediaPurpose,
  MediaReadAccessProjection,
  MediaResourceType,
  PaymentRouterIntent,
  RealtimeEventEnvelope,
  RewardSubtype,
  SeckillSessionProjection,
  SettlementBalance,
  SettlementRail,
  SettlementRequestProjection,
} from '@abu24k/core-artifacts';

import {
  DisabledAction,
  EmptyState,
  RulesDisclosure,
  ScreenHeader,
  StatusNotice,
} from './components';
import type { BuyerEvidenceAction } from './core-client';
import { useMallRuntime, type BrowserPosition, type MallRuntimeValue } from './mall-runtime';

export function SeckillScreen() {
  const runtime = useMallRuntime();
  const navigate = useNavigate();
  const [historyOpen, setHistoryOpen] = useState(false);
  const session = runtime.seckillSession;
  const mainTarget = session?.phase === 'PREHEAT' ? session.startsAt : session?.mainDeadline;
  const mainCountdown = useAuthoritativeCountdown(session?.serverTime, mainTarget);
  const relayCountdown = useAuthoritativeCountdown(
    session?.serverTime,
    session?.phase === 'LIVE' ? session.relayDeadline : undefined,
  );
  const productAvailable = Boolean(session && runtime.catalog.some((product) =>
    product.productId === session.product.productId
      && product.skus.some((sku) => sku.skuId === session.product.skuId)));
  const canConfigure = Boolean(
    session?.phase === 'LIVE'
      && BigInt(session.inventory.available) > 0n
      && productAvailable
      && runtime.bootstrap?.writesEnabled
      && !runtime.pendingSubmission,
  );

  return (
    <div className="screen screen--seckill">
      <ScreenHeader
        eyebrow="60 分钟主场"
        title="秒杀大厅"
        description="以链上最终确认时间为准"
        trailing={<SeckillPhasePill phase={session?.phase} />}
      />

      <PublishedContent
        items={runtime.cmsItems.filter((item) => item.contentType === 'SECKILL_RULES')}
        state={runtime.cmsState}
        onRetry={() => void runtime.reloadCms()}
      />

      <section className="seckill-hero" aria-label="秒杀活动状态">
        <img src="/brand/prize-vault.png" alt="黑金秒杀奖池保险柜" />
        <div className="seckill-hero__overlay">
          <p>接力大奖池</p>
          <strong className="amount-placeholder">
            {session ? session.prizePoolUsdt : '--'}
          </strong>
          <span>{session ? `USDT 原子单位 · 场次 ${shortHash(session.sessionId)}` : '等待活动状态同步'}</span>
        </div>
      </section>

      <div className="timer-grid" aria-label="活动计时">
        <CountdownMetric
          label={session?.phase === 'PREHEAT' ? '距主场开始' : '主场倒计时'}
          value={session ? mainCountdown : null}
        />
        <CountdownMetric label="接力倒计时" value={session?.phase === 'LIVE' ? relayCountdown : null} />
      </div>

      <div className="action-row">
        <RulesDisclosure />
        <button
          className="button button--secondary"
          type="button"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((current) => !current)}
          disabled={runtime.seckillSessionState === 'loading'}
        >
          <History aria-hidden="true" size={18} />
          历史战报
        </button>
      </div>

      {runtime.seckillSessionState === 'loading' ? <p className="loading-copy" role="status">正在同步权威场次…</p> : null}
      {runtime.seckillSessionState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="场次同步失败" tone="warning">已停止倒计时、活动动作和事件流，不使用本地场次兜底。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadSeckill()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.seckillSessionState === 'empty' ? <EmptyState title="暂无已发布场次">Core 当前没有可展示的秒杀场次。</EmptyState> : null}

      {session ? <SeckillSessionDashboard session={session} /> : null}

      {historyOpen ? <SeckillHistory sessions={runtime.seckillHistory} /> : null}

      <section className="section-block" aria-labelledby="relay-feed-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CHAIN FINAL EVENTS</p>
            <h2 id="relay-feed-title">接力风云</h2>
          </div>
          <span className={`realtime-state realtime-state--${runtime.seckillRealtimeState.toLowerCase()}`}>
            <Radio aria-hidden="true" size={16} /> {realtimeStateLabel(runtime.seckillRealtimeState)}
          </span>
        </div>
        {runtime.seckillEvents.length === 0 ? (
          <EmptyState title="暂无已确认动态">只展示已去重、可恢复游标的链上最终事件，连接中断时不插入临时记录。</EmptyState>
        ) : (
          <ol className="relay-feed" aria-live="polite">
            {runtime.seckillEvents.map((event) => <RelayEvent event={event} key={event.eventId} />)}
          </ol>
        )}
        {runtime.seckillRealtimeError ? <p className="field-error" role="status">{runtime.seckillRealtimeError}</p> : null}
      </section>

      <button
        className="button button--primary"
        type="button"
        disabled={!canConfigure || runtime.busy}
        onClick={() => {
          runtime.selectSeckillSession();
          navigate('/checkout');
        }}
      >
        <WalletCards aria-hidden="true" size={18} /> 配置秒杀订单
      </button>
      {!canConfigure && session ? <p className="control-reason">{seckillActionReason(runtime, session, productAvailable)}</p> : null}
    </div>
  );
}

function SeckillSessionDashboard({ session }: { session: SeckillSessionProjection }) {
  return (
    <section className="section-block seckill-dashboard" aria-labelledby="current-session-title">
      <div className="section-heading">
        <div><p className="eyebrow">AUTHORITATIVE SESSION</p><h2 id="current-session-title">{session.product.title}</h2></div>
        <Zap aria-hidden="true" size={19} />
      </div>
      <dl className="seckill-facts">
        <div><dt>秒杀价</dt><dd>{session.product.seckillListPriceUsdt} USDT 原子单位</dd></div>
        <div><dt>可用库存</dt><dd>{session.inventory.available}</dd></div>
        <div><dt>已售 / 预留</dt><dd>{session.inventory.sold} / {session.inventory.reserved}</dd></div>
        <div><dt>策略版本</dt><dd>{session.policyVersion}</dd></div>
      </dl>
      <p className="phase-copy">{seckillPhaseCopy(session)}</p>
      {session.lastBuyerWallet ? <p className="last-buyer">最后接力 {shortAddress(session.lastBuyerWallet)}</p> : null}
      {session.phase === 'SETTLED' ? (
        session.winnerWallet
          ? <div className="winner-callout"><BadgeCheck aria-hidden="true" size={20} /><span>本场赢家</span><strong>{shortAddress(session.winnerWallet)}</strong></div>
          : <p className="field-help">本场已最终结算，Core 未发布赢家钱包。</p>
      ) : null}
    </section>
  );
}

function SeckillHistory({ sessions }: { sessions: readonly SeckillSessionProjection[] }) {
  return (
    <section className="section-block" aria-labelledby="seckill-history-title">
      <div className="section-heading"><h2 id="seckill-history-title">历史战报</h2><History aria-hidden="true" size={18} /></div>
      {sessions.length === 0 ? <p className="section-copy">Core 当前没有已结算或强制关闭的历史场次。</p> : (
        <div className="seckill-history-list">
          {sessions.map((session) => (
            <article key={session.sessionId}>
              <div><strong>{session.product.title}</strong><SeckillPhasePill phase={session.phase} /></div>
              <p>奖池 {session.prizePoolUsdt} USDT 原子单位 · 已售 {session.inventory.sold}</p>
              <p>{session.winnerWallet ? `赢家 ${shortAddress(session.winnerWallet)}` : '无已发布赢家'}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function RelayEvent({ event }: { event: RealtimeEventEnvelope }) {
  const payload = event.payload as Readonly<Record<string, unknown>>;
  return (
    <li>
      <div><strong>{shortAddress(String(payload.buyerWallet))}</strong><time dateTime={event.occurredAt}>{formatIso(event.occurredAt)}</time></div>
      <p>链上最终购买，接力时间增加 {String(payload.extensionSeconds)} 秒</p>
      <span>游标 {event.cursor} · {shortHash(String(payload.transactionHash))}</span>
    </li>
  );
}

export function MallScreen() {
  const runtime = useMallRuntime();
  const navigate = useNavigate();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [tagId, setTagId] = useState<string | null>(null);
  const visibleProducts = useMemo(() => {
    const categoryIds = categoryId ? descendantCategoryIds(categoryId, runtime.categories) : null;
    return runtime.catalog.filter((product) => (
      (!categoryIds || (product.categoryId !== null && categoryIds.has(product.categoryId)))
      && (!tagId || product.tagIds.includes(tagId))
    ));
  }, [categoryId, runtime.catalog, runtime.categories, tagId]);

  return (
    <div className="screen screen--mall">
      <ScreenHeader
        eyebrow="ABU SELECT"
        title="常规商城"
        description="商品、规格与价格以签名报价为准"
      />

      <PublishedContent
        items={runtime.cmsItems.filter((item) => item.contentType !== 'SECKILL_RULES')}
        state={runtime.cmsState}
        onRetry={() => void runtime.reloadCms()}
      />

      <section className="catalog-banner">
        <img src="/brand/market-banner.png" alt="阿步 24K 黑金精选陈列" />
        <div className="catalog-banner__copy">
          <span>24K SELECT</span>
          <strong>消费记录，履约后释放 BNM</strong>
        </div>
      </section>

      <section aria-labelledby="category-title" className="section-block section-block--flat">
        <div className="section-heading">
          <h2 id="category-title">商品分类</h2>
          <span className="muted-label">Core 目录</span>
        </div>
        {runtime.taxonomyState === 'loading' ? (
          <div className="category-skeleton" aria-label="正在加载商品分类"><span /><span /><span /><span /></div>
        ) : null}
        {runtime.taxonomyState === 'empty' ? (
          <EmptyState title="暂无已发布分类">Core 当前没有启用中的公开类目或标签。</EmptyState>
        ) : null}
        {runtime.taxonomyState === 'error' ? (
          <div className="catalog-retry">
            <StatusNotice title="分类与标签同步失败" tone="warning">当前不使用本地分类或缓存标签替代。</StatusNotice>
            <button className="button button--secondary" type="button" onClick={() => void runtime.reloadTaxonomy()} disabled={runtime.busy}>
              <RefreshCw aria-hidden="true" size={18} /> 重新同步分类
            </button>
          </div>
        ) : null}
        {runtime.taxonomyState === 'ready' ? (
          <CatalogTaxonomy
            runtime={runtime}
            selectedCategoryId={categoryId}
            selectedTagId={tagId}
            onSelectCategory={setCategoryId}
            onSelectTag={setTagId}
          />
        ) : null}
      </section>

      {runtime.catalogState === 'loading' ? (
        <div className="catalog-skeleton" aria-label="正在加载商品目录">
          <div><span /></div><div><span /></div><div><span /></div><div><span /></div>
        </div>
      ) : null}
      {runtime.catalogState === 'empty' ? (
        <EmptyState title="暂无可售商品">目录已成功同步，当前没有通过商家、保证金与商品状态校验的 SKU。</EmptyState>
      ) : null}
      {runtime.catalogState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="商品目录同步失败" tone="warning">当前不展示缓存商品或示例价格。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadCatalog()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.catalogState === 'ready' ? (
        <div className="product-grid" aria-label="可售商品">
          {visibleProducts.map((product) => {
            const overlay = product.skus.find((sku) => sku.seckill)?.seckill ?? null;
            const ordinarySkuCount = product.skus.filter((sku) => sku.seckill === null).length;
            const activityOnly = Boolean(overlay && ordinarySkuCount === 0);
            return (
            <article className={overlay ? 'product-card product-card--seckill' : 'product-card'} key={product.productId}>
              <div className="product-card__visual">
                {product.mainImageAssetIds[0] ? (
                  <PublicCatalogMedia
                    alt={product.title}
                    assetId={product.mainImageAssetIds[0]}
                    expectedPurpose="PRODUCT_IMAGE"
                    expectedResourceId={product.productId}
                    expectedResourceType="PRODUCT"
                    kind="image"
                  />
                ) : <ShoppingBag aria-hidden="true" size={26} />}
              </div>
              <div className="product-card__body">
                <h2>{product.title}</h2>
                {product.subtitle ? <p>{product.subtitle}</p> : null}
                <div className="product-card__badges" aria-label="商品属性">
                  <span>BNM 履约后释放</span>
                  {product.fulfillmentModes.map((mode) => <span key={mode}>{mode === 'DELIVERY' ? '快递' : '自提'}</span>)}
                  {product.tagIds.map((id) => <span key={id}>{runtime.tags.find((tag) => tag.tagId === id)?.name ?? id}</span>)}
                </div>
                {overlay ? (
                  <div className="product-card__seckill" role="status">
                    <Zap aria-hidden="true" size={15} />
                    <span>{seckillOverlayLabel(overlay.phase)} · {overlay.seckillListPriceUsdt} · 剩余 {overlay.inventory.available}</span>
                  </div>
                ) : null}
                <dl>
                  <div><dt>普通可售规格</dt><dd>{ordinarySkuCount} / {product.skus.length}</dd></div>
                  <div><dt>默认运费</dt><dd>{product.defaultFreightUsdt} USDT 原子单位</dd></div>
                </dl>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={runtime.busy || Boolean(runtime.pendingSubmission)}
                  onClick={() => {
                    if (activityOnly) navigate('/seckill');
                    else {
                      runtime.selectProduct(product.productId);
                      navigate('/checkout');
                    }
                  }}
                >
                  {activityOnly ? '前往秒杀' : '选择商品'} <ChevronRight aria-hidden="true" size={17} />
                </button>
              </div>
            </article>
          );})}
        </div>
      ) : null}
      {runtime.catalogState === 'ready' && visibleProducts.length === 0 ? (
        <EmptyState title="当前筛选无商品">筛选结果仅使用 Core 发布的类目与标签关联。</EmptyState>
      ) : null}
    </div>
  );
}

export function StoresScreen() {
  const runtime = useMallRuntime();
  const [regionCode, setRegionCode] = useState('');

  return (
    <div className="screen screen--stores">
      <ScreenHeader
        eyebrow="O2O STORES"
        title="线下门店"
        description="位置、营业状态与行政区划需实时校验"
      />

      <img className="store-hero" src="/brand/store-front.png" alt="阿步 24K 线下门店空间" />

      <form
        className="store-tools"
        onSubmit={(event) => {
          event.preventDefault();
          void runtime.reloadStores(regionCode || undefined);
        }}
      >
        <label className="field">
          六位行政区代码
          <input
            value={regionCode}
            onChange={(event) => setRegionCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            pattern="[0-9]{6}"
            placeholder="全部地区"
          />
        </label>
        <div className="split-actions">
          <button className="button button--secondary" type="submit" disabled={runtime.busy || Boolean(regionCode && regionCode.length !== 6)}>
            <RefreshCw aria-hidden="true" size={18} /> 筛选门店
          </button>
          <button className="button button--secondary" type="button" onClick={() => void runtime.requestLocation()} disabled={runtime.busy}>
            <LocateFixed aria-hidden="true" size={18} />
            {runtime.locationState === 'loading' ? '定位中' : '获取距离'}
          </button>
        </div>
      </form>

      {runtime.locationState !== 'ready' ? (
        <StatusNotice title="设备定位尚未验证" tone="warning">
          未授权定位时只展示 Core 门店资料，不推断最近门店或虚构距离。
        </StatusNotice>
      ) : null}

      {runtime.storesState === 'loading' ? <StoreListSkeleton /> : null}
      {runtime.storesState === 'error' ? (
        <StatusNotice title="门店同步失败" tone="warning">当前不展示缓存门店或示例地址。</StatusNotice>
      ) : null}
      {runtime.storesState === 'empty' ? (
        <EmptyState title="当前地区暂无门店">Core 已返回空门店列表，可清除行政区筛选后重试。</EmptyState>
      ) : null}
      {runtime.storesState === 'ready' ? (
        <div className="store-list" aria-label="可用自提门店">
          {runtime.stores.map((store) => (
            <StoreRow key={store.storeId} store={store} location={runtime.location} />
          ))}
        </div>
      ) : null}

      <p id="native-navigation-blocked" className="control-reason">原生地图桥接与真实设备导航证据仍为 ExternalBlocked，导航入口保持关闭。</p>
    </div>
  );
}

function StoreListSkeleton() {
  return (
    <div className="store-list" aria-label="正在加载门店">
      {[0, 1].map((item) => <div className="store-row store-row--skeleton" key={item} />)}
    </div>
  );
}

function StoreRow({ store, location }: { store: MerchantStore; location: BrowserPosition | null }) {
  const distance = location ? distanceKm(location, store) : null;
  return (
    <article className="store-row">
      <div className="store-row__header">
        <div>
          <h2>{store.name}</h2>
          <p>{store.address}</p>
        </div>
        <span className={store.status === 'ACTIVE' ? 'status-pill status-pill--success' : 'status-pill status-pill--muted'}>
          {store.status === 'ACTIVE' ? '营业中' : store.status}
        </span>
      </div>
      <dl className="store-row__facts">
        <div><dt>行政区</dt><dd>{store.regionCode}</dd></div>
        <div><dt>距离</dt><dd>{distance === null ? '定位后显示' : `${distance.toFixed(1)} km`}</dd></div>
        <div><dt>版本</dt><dd>v{store.version}</dd></div>
      </dl>
      <div className="split-actions">
        <a className="button button--secondary" href={`tel:${store.phone}`} aria-label={`拨打 ${store.name} 电话`}>
          <Phone aria-hidden="true" size={18} /> 拨号
        </a>
        <button className="button button--secondary" type="button" disabled aria-describedby="native-navigation-blocked">
          <Navigation aria-hidden="true" size={18} /> 导航
        </button>
      </div>
    </article>
  );
}

export function AssetsScreen() {
  const runtime = useMallRuntime();
  const orderItems = [
    { label: '待付款', icon: Clock3, count: runtime.orders.filter((order) => ['QUOTED', 'SUBMITTED'].includes(order.state)).length },
    { label: '待发货', icon: PackageOpen, count: runtime.orders.filter((order) => order.state === 'PAID').length },
    { label: '待收货', icon: Truck, count: runtime.orders.filter((order) => ['SHIPPED', 'DELIVERED', 'FULFILLMENT_PENDING'].includes(order.state)).length },
    { label: '售后 / 仲裁', icon: ShieldAlert, count: runtime.orders.filter((order) => ['ARBITRATION', 'TAKEOVER'].includes(order.state)).length },
  ];

  return (
    <div className="screen screen--assets">
      <ScreenHeader eyebrow="PERSONAL LEDGER" title="我的资产" description="消费、交付与收益状态统一对账" />

      <section className="profile-strip" aria-labelledby="profile-title">
        <div className="avatar-placeholder"><UserRound aria-hidden="true" size={24} /></div>
        <div className="profile-strip__copy">
          <h2 id="profile-title">{runtime.session ? shortHash(runtime.session.walletAddress) : '未连接钱包'}</h2>
          <p>{runtime.session ? 'BUYER 会话已验证' : '账号 ID 与链上身份待安全校验'}</p>
        </div>
        <div className="profile-strip__actions">
          <Link className="icon-button" to="/assets/notifications" aria-label="打开通知中心">
            <Bell aria-hidden="true" size={20} />
          </Link>
          <Link className="icon-button" to="/assets/addresses" aria-label="打开我的收货地址">
            <MapPinned aria-hidden="true" size={20} />
          </Link>
        </div>
      </section>

      <section className="section-block" aria-labelledby="order-center-title">
        <div className="section-heading">
          <h2 id="order-center-title">我的订单</h2>
          <Link to="/assets/orders" className="text-link">
            查看全部 <ChevronRight aria-hidden="true" size={16} />
          </Link>
        </div>
        <div className="order-status-grid">
          {orderItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.label} to="/assets/orders" className="order-status-item">
                <span className="order-status-item__icon"><Icon aria-hidden="true" size={20} /></span>
                <strong>{runtime.session && runtime.ordersState !== 'error' ? item.count : '--'}</strong>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="section-block" aria-labelledby="activity-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">TWO TRACKS</p>
            <h2 id="activity-title">行为追踪</h2>
          </div>
          <Link to="/assets/activity" className="icon-button" aria-label="查看行为追踪">
            <ChevronRight aria-hidden="true" size={20} />
          </Link>
        </div>
        <div className="track-preview">
          <div><Zap aria-hidden="true" size={19} /><span>秒杀参与</span><strong>--</strong></div>
          <div><ShoppingBag aria-hidden="true" size={19} /><span>消费购物</span><strong>--</strong></div>
        </div>
      </section>

      <section className="ledger-banner" aria-labelledby="ledger-title">
        <img src="/brand/bnm-ledger.png" alt="BNM 资产凭证视觉" />
        <div>
          <p className="eyebrow">LOCKED / AVAILABLE</p>
          <h2 id="ledger-title">收益对账中心</h2>
          <p>仅展示当前钱包已验证的收益资格与权威账目。</p>
          <Link className="button button--light" to="/assets/rewards">
            查看收益 <ChevronRight aria-hidden="true" size={17} />
          </Link>
        </div>
      </section>
    </div>
  );
}

export function AddressScreen() {
  const [phone, setPhone] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const phoneInvalid = phoneTouched && phone.length > 0 && !/^\d{11}$/.test(phone);

  return (
    <div className="screen screen--detail">
      <ScreenHeader
        eyebrow="DELIVERY PROFILE"
        title="我的收货地址"
        description="个人信息只提交到经过发布的安全服务"
        backTo="/assets"
      />

      <section className="section-block" aria-labelledby="paste-address-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">SMART PARSE</p>
            <h2 id="paste-address-title">粘贴识别</h2>
          </div>
          <Copy aria-hidden="true" size={19} />
        </div>
        <label className="field">
          地址文本
          <textarea
            rows={4}
            disabled
            placeholder="安全解析服务发布后可用"
            aria-describedby="parser-reason"
          />
        </label>
        <p id="parser-reason" className="field-help">当前不在浏览器本地解析或留存收货信息。</p>
      </section>

      <form className="address-form" onSubmit={(event) => event.preventDefault()} noValidate>
        <fieldset>
          <legend>收货人信息</legend>
          <label className="field">
            姓名
            <input name="name" autoComplete="name" maxLength={50} />
          </label>
          <label className="field">
            手机号
            <input
              name="phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))}
              onBlur={() => setPhoneTouched(true)}
              inputMode="numeric"
              autoComplete="tel"
              aria-invalid={phoneInvalid}
              aria-describedby={phoneInvalid ? 'phone-error' : 'phone-help'}
            />
            <span id="phone-help" className="field-help">请输入 11 位手机号</span>
            {phoneInvalid ? <span id="phone-error" className="field-error" role="alert">手机号须为 11 位数字</span> : null}
          </label>
        </fieldset>

        <fieldset disabled>
          <legend>省市区</legend>
          <div className="region-grid">
            <label className="field">省份<select defaultValue=""><option value="">待同步</option></select></label>
            <label className="field">城市<select defaultValue=""><option value="">待同步</option></select></label>
            <label className="field">区县<select defaultValue=""><option value="">待同步</option></select></label>
          </div>
        </fieldset>

        <label className="field">
          详细地址
          <textarea name="street-address" autoComplete="street-address" rows={3} maxLength={200} />
        </label>

        <label className="check-field">
          <input type="checkbox" />
          <span>设为默认地址</span>
        </label>

        <DisabledAction reason="地址服务与行政区划数据未发布，当前内容不会保存">
          保存地址
        </DisabledAction>
      </form>

      <EmptyState title="暂无已同步地址">
        地址列表、修改、删除和默认状态将在身份与数据服务可用后显示。
      </EmptyState>
    </div>
  );
}

export function OrdersScreen() {
  const runtime = useMallRuntime();
  const [active, setActive] = useState('全部');
  const tabs = ['全部', '待付款', '待发货', '待收货', '售后 / 仲裁'];
  const visibleOrders = runtime.orders.filter((order) => orderMatchesTab(order, active));

  return (
    <div className="screen screen--detail">
      <ScreenHeader eyebrow="FULFILLMENT" title="我的订单" description="交付动作仅由允许操作开放" backTo="/assets" />
      <div className="segmented-control order-tabs" role="tablist" aria-label="订单状态">
        {tabs.map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={active === tab}
            className={active === tab ? 'is-active' : ''}
            onClick={() => setActive(tab)}
            type="button"
          >
            {tab}
          </button>
        ))}
      </div>

      {!runtime.session ? (
        <StatusNotice title="需要钱包登录">连接钱包后只读取当前 BUYER 会话可见的订单与允许操作。</StatusNotice>
      ) : null}
      {runtime.ordersState === 'loading' ? <OrderListSkeleton /> : null}
      {runtime.ordersState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="订单同步失败" tone="warning">当前不展示缓存状态或本地推断动作。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadOrders()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.session && ['ready', 'empty'].includes(runtime.ordersState) && visibleOrders.length === 0 ? (
        <EmptyState title={`暂无可显示的${active}订单`}>
          订单分组来自 Core 当前状态，不用本地时间推断。
        </EmptyState>
      ) : null}
      {visibleOrders.length > 0 ? (
        <div className="order-list" aria-live="polite">
          {visibleOrders.map((order) => (
            <OrderRow
              key={order.orderId}
              order={order}
              actions={runtime.orderActions[order.orderId] ?? []}
              {...(runtime.orderTargets[order.orderId] ? { target: runtime.orderTargets[order.orderId] } : {})}
              {...(runtime.orderCapabilityErrors[order.orderId] ? { capabilityError: runtime.orderCapabilityErrors[order.orderId] } : {})}
            />
          ))}
        </div>
      ) : null}
      {runtime.ordersNextCursor ? (
        <button className="button button--secondary order-load-more" type="button" disabled={runtime.busy} onClick={() => void runtime.loadMoreOrders()}>
          <RefreshCw aria-hidden="true" size={17} /> {runtime.busy ? '正在读取下一页' : '加载更多订单'}
        </button>
      ) : null}

      <section className="support-policy" aria-labelledby="support-title">
        <div className="support-policy__icon"><Headphones aria-hidden="true" size={22} /></div>
        <div>
          <h2 id="support-title">交付支持</h2>
          <p>支持商品换货、延迟签收申请与仲裁进度查询。关联收益在履约最终确认前保持锁定。</p>
        </div>
      </section>
    </div>
  );
}

function OrderListSkeleton() {
  return (
    <div className="order-list" aria-label="正在加载订单">
      {[0, 1].map((item) => <div className="order-row order-row--skeleton" key={item} />)}
    </div>
  );
}

function OrderRow({
  order,
  target,
  actions,
  capabilityError,
}: {
  order: FulfillmentOrder;
  target?: FulfillmentTarget;
  actions: readonly AllowedAction[];
  capabilityError?: string;
}) {
  const runtime = useMallRuntime();
  const logistics = order.logistics.at(-1);
  const buyerActions = actions.filter((action) => BUYER_FULFILLMENT_ACTIONS.includes(action.action));
  const [activeAction, setActiveAction] = useState<BuyerEvidenceAction | null>(null);
  return (
    <article className="order-row">
      <header className="order-row__header">
        <div>
          <p className="eyebrow">{orderKindLabel(order.orderKind)} · {order.fulfillmentMode === 'DELIVERY' ? '快递订单' : '到店自提'}</p>
          <h2>{shortHash(order.orderId)}</h2>
        </div>
        <div className="order-row__state">
          <span className="status-pill">{orderStateLabel(order.state)}</span>
          <span>{finalityLabel(order.finalityStatus)}</span>
        </div>
      </header>

      <dl className="order-row__identity">
        <div><dt>商品</dt><dd>{order.productId}</dd></div>
        <div><dt>规格</dt><dd>{order.skuId}</dd></div>
        <div><dt>数量</dt><dd>{order.quantity}</dd></div>
        <div><dt>创建时间</dt><dd>{formatIso(order.createdAt)}</dd></div>
        <div><dt>USDT 支付</dt><dd>{order.exactAmounts.usdtPaymentAmount}</dd></div>
        <div><dt>NPL 支付</dt><dd>{order.exactAmounts.nplPaymentAmount}</dd></div>
        <div className="order-row__tx"><dt>付款 TxHash</dt><dd>{order.paymentTxHash ? <code>{order.paymentTxHash}</code> : '尚未提交'}</dd></div>
        <div><dt>付款记录</dt><dd>{order.paidAt ? formatIso(order.paidAt) : '待付款'}</dd></div>
        <div><dt>付款最终确认</dt><dd>{order.paymentFinalizedAt ? formatIso(order.paymentFinalizedAt) : '确认中'}</dd></div>
      </dl>

      {target ? <OrderTarget target={target} /> : null}
      <section className="order-row__section" aria-label="物流状态">
        <div className="section-heading section-heading--compact">
          <h3>物流</h3>
          <Truck aria-hidden="true" size={17} />
        </div>
        {logistics ? (
          <p>{logistics.provider} · {logisticsStatusLabel(logistics.status)} · {formatIso(logistics.occurredAt)}</p>
        ) : order.shipments[0] ? (
          <p>{order.shipments[0].carrierCode} · 运单 {shortHash(order.shipments[0].trackingNumberHash)}</p>
        ) : <p>尚无有效物流证据</p>}
      </section>

      <section className="order-row__section" aria-label="资产状态">
        <div className="section-heading section-heading--compact"><h3>订单资产</h3><Banknote aria-hidden="true" size={17} /></div>
        {order.balances.length > 0 ? (
          <div className="balance-list">
            {order.balances.map((balance, index) => (
              <div key={`${balance.asset}-${balance.state}-${index}`}>
                <span>{balance.asset === 'BNM_POINTS' ? 'BNM 后台积分' : balance.asset}</span>
                <strong>{balance.amount}</strong>
                <span>{balance.asset === 'BNM_POINTS' && !['LOCKED', 'AVAILABLE'].includes(balance.state) ? '状态不可用' : balanceStateLabel(balance.state)}</span>
              </div>
            ))}
          </div>
        ) : <p>Core 尚未返回资产状态</p>}
      </section>

      {order.requests.length > 0 ? (
        <section className="order-row__section" aria-label="履约申请">
          <div className="request-list">
            {order.requests.map((request) => (
              <div key={request.requestId}>
                <span>{requestTypeLabel(request.requestType)}</span>
                <strong>{request.state}</strong>
                <time dateTime={request.requestedAt}>{formatIso(request.requestedAt)}</time>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="order-row__actions" aria-label="订单允许操作">
        <div className="section-heading section-heading--compact"><h3>可执行操作</h3><ShieldAlert aria-hidden="true" size={17} /></div>
        {capabilityError ? <p className="field-error" role="status">{capabilityError}</p> : null}
        {buyerActions.length > 0 ? (
          <div className="order-action-grid">
            {buyerActions.map((action) => {
              const supported = isBuyerEvidenceAction(action.action);
              const reason = action.enabled
                ? supported ? 'Core 已允许，可提交订单证据' : unsupportedBuyerActionReason(action.action)
                : action.reasonCode ?? 'Core 当前未允许该操作';
              const reasonId = `action-${order.orderId.slice(2, 10)}-${action.action}`;
              return (
                <div key={action.action}>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={!action.enabled || !supported || runtime.busy}
                    aria-describedby={reasonId}
                    aria-expanded={supported && activeAction === action.action}
                    onClick={() => {
                      if (!isBuyerEvidenceAction(action.action)) return;
                      const nextAction = action.action;
                      setActiveAction((current) => current === nextAction ? null : nextAction);
                    }}
                  >
                    {actionLabel(action.action)}
                  </button>
                  <p id={reasonId}>{reason}{action.deadline ? ` · ${formatIso(action.deadline)}` : ''}</p>
                </div>
              );
            })}
          </div>
        ) : <p>当前会话未返回买家履约动作。</p>}
        {activeAction ? (
          <OrderEvidenceForm
            action={activeAction}
            busy={runtime.busy}
            orderId={order.orderId}
            onClose={() => setActiveAction(null)}
            onSubmit={(input) => runtime.submitBuyerAction(order.orderId, activeAction, input)}
          />
        ) : null}
      </section>
    </article>
  );
}

function OrderEvidenceForm({
  action,
  busy,
  orderId,
  onClose,
  onSubmit,
}: {
  action: BuyerEvidenceAction;
  busy: boolean;
  orderId: string;
  onClose(): void;
  onSubmit(input: { reasonCode: string; file: File | null }): Promise<boolean>;
}) {
  const fieldId = `evidence-${orderId.slice(2, 10)}-${action}`;
  const [reasonCode, setReasonCode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);

  return (
    <form
      className="order-evidence-form"
      aria-label={`${actionLabel(action)}证据`}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(false);
        void onSubmit({ reasonCode, file }).then(setSubmitted);
      }}
    >
      <div className="order-evidence-form__header">
        <div>
          <p className="eyebrow">CORE EVIDENCE</p>
          <h4>{actionLabel(action)}</h4>
        </div>
        <button className="icon-button" type="button" aria-label="关闭证据表单" onClick={onClose} disabled={busy}>
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <label className="field" htmlFor={`${fieldId}-reason`}>
        原因代码
        <input
          id={`${fieldId}-reason`}
          value={reasonCode}
          required
          minLength={2}
          maxLength={64}
          pattern="[A-Z][A-Z0-9_]{1,63}"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="大写字母、数字或下划线"
          onChange={(event) => {
            setReasonCode(event.currentTarget.value.toUpperCase());
            setSubmitted(false);
          }}
        />
      </label>
      <label className="field" htmlFor={`${fieldId}-file`}>
        证据文件（可选）
        <span className="field-help"><FileUp aria-hidden="true" size={15} /> JPG、PNG、WebP 或 PDF，最大 10 MB</span>
        <input
          id={`${fieldId}-file`}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0] ?? null);
            setSubmitted(false);
          }}
        />
      </label>
      {file ? <p className="selected-evidence-file">{file.name} · {file.size} bytes</p> : null}
      <div className="order-evidence-form__actions">
        <button className="button button--primary" type="submit" disabled={busy || reasonCode.length < 2}>
          <Send aria-hidden="true" size={17} /> {busy ? '提交中' : '封装证据并提交'}
        </button>
        <button className="button button--secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
      </div>
      {submitted ? <p className="evidence-success" role="status">操作已由 Core 接收，订单状态已重新同步。</p> : null}
    </form>
  );
}

function OrderTarget({ target }: { target: FulfillmentTarget }) {
  return (
    <section className="order-row__section order-target" aria-label="履约目标">
      <MapPinned aria-hidden="true" size={18} />
      <div>
        <h3>{target.fulfillmentMode === 'DELIVERY' ? target.payload.recipientName : target.payload.name}</h3>
        <p>{target.fulfillmentMode === 'DELIVERY' ? `${target.payload.phone} · ${target.payload.address}` : target.payload.address}</p>
        <span>行政区 {target.regionCode} · 快照 {shortHash(target.targetHash)}</span>
      </div>
    </section>
  );
}

export function ActivityScreen() {
  const [active, setActive] = useState<'seckill' | 'shopping'>('seckill');

  return (
    <div className="screen screen--detail">
      <ScreenHeader eyebrow="ACTIVITY LEDGER" title="行为追踪" description="每笔消费与资产状态逐单对应" backTo="/assets" />
      <div className="segmented-control segmented-control--two" role="tablist" aria-label="行为类型">
        <button role="tab" aria-selected={active === 'seckill'} className={active === 'seckill' ? 'is-active' : ''} onClick={() => setActive('seckill')} type="button">
          <Zap aria-hidden="true" size={17} /> 秒杀参与
        </button>
        <button role="tab" aria-selected={active === 'shopping'} className={active === 'shopping' ? 'is-active' : ''} onClick={() => setActive('shopping')} type="button">
          <ShoppingBag aria-hidden="true" size={17} /> 消费购物
        </button>
      </div>

      <EmptyState title={active === 'seckill' ? '暂无秒杀记录' : '暂无购物记录'}>
        {active === 'seckill'
          ? '活动期数、投入、最终结果、USDT 奖金与锁定 BNM 将由权威记录提供。'
          : '订单、待释放 BNM 与履约最终状态将由权威记录提供。'}
      </EmptyState>

      <StatusNotice title="领取操作已停用">
        秒杀奖金只在场次最终结算后开放；其他 BNM 与收益只在履约最终确认后开放。
      </StatusNotice>
    </div>
  );
}

export function RewardsScreen() {
  const runtime = useMallRuntime();
  const bnmOrderBalances = runtime.orders.flatMap((order) => order.balances
    .filter((balance) => balance.asset === 'BNM_POINTS')
    .map((balance) => ({ orderId: order.orderId, ...balance })));
  const bnmTotals = runtime.settlements?.points ?? [];
  const transferableRails = (['REWARD_NPL', 'PRIZE_USDT'] as const).filter((rail) =>
    runtime.settlements?.balances.some((balance) => railForBalance(balance) === rail)
      || runtime.settlements?.requests.some((request) => request.rail === rail),
  );

  return (
    <div className="screen screen--detail screen--rewards">
      <ScreenHeader eyebrow="REWARD LEDGER" title="收益对账" description="Core 账本与 Safe 结算状态逐项对账" backTo="/assets" />

      <section className="reward-rail" aria-labelledby="bnm-rail-title">
        <div className="reward-rail__header">
          <div className="reward-rail__icon"><CircleDollarSign aria-hidden="true" size={22} /></div>
          <div>
            <p className="eyebrow">BNM</p>
            <h2 id="bnm-rail-title">消费产出池</h2>
          </div>
          <span className="status-pill status-pill--locked"><LockKeyhole aria-hidden="true" size={13} />后台积分</span>
        </div>
        {bnmTotals.length > 0 ? (
          <div className="balance-list" aria-label="BNM 账户总额">
            {(['LOCKED', 'AVAILABLE'] as const).map((state) => {
              const balance = bnmTotals.find((item) => item.state === state);
              return (
              <div key={state}>
                <span>{state === 'LOCKED' ? 'Locked' : 'Available'}</span>
                <strong>{balance?.amount ?? '--'}</strong>
                <span>BNM</span>
              </div>
              );
            })}
          </div>
        ) : <p className="section-copy">当前钱包没有 Core 发布的 BNM totals。</p>}
        {bnmOrderBalances.length > 0 ? (
          <details className="bnm-provenance">
            <summary>查看订单来源</summary>
            <div className="balance-list" aria-label="BNM 订单明细">
            {bnmOrderBalances.map((balance) => (
              <div key={`${balance.orderId}-${balance.state}`}>
                <span>订单 {shortHash(balance.orderId)}</span>
                <strong>{balance.amount}</strong>
                <span>{balanceStateLabel(balance.state)}</span>
              </div>
            ))}
            </div>
          </details>
        ) : null}
        <p className="field-help"><FileClock aria-hidden="true" size={15} /> BNM 仅有 Locked / Available，不是代币，也不进入 Safe 结算。</p>
        <Link className="text-link" to="/assets/orders">查看订单与履约来源 <ChevronRight aria-hidden="true" size={15} /></Link>
      </section>

      {!runtime.session ? <StatusNotice title="请先验证钱包">连接钱包后同步该钱包的收益、申请和 Safe 最终状态。</StatusNotice> : null}
      {runtime.settlementsState === 'loading' ? <p className="loading-copy" role="status">正在同步收益账本…</p> : null}
      {runtime.settlementsState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="收益账本同步失败" tone="warning">不会展示缓存金额或伪造可领取状态。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadSettlements()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.session && runtime.settlementsState === 'empty' ? (
        <EmptyState title="暂无可转移收益">当前钱包没有已发布的 NPL 收益、秒杀奖金或结算申请。</EmptyState>
      ) : null}
      {transferableRails.map((rail) => (
        <TransferableRewardRail
          key={rail}
          rail={rail}
          balances={runtime.settlements?.balances ?? []}
          requests={runtime.settlements?.requests ?? []}
          busy={runtime.busy}
          onRequest={(amount) => void runtime.requestSettlement(rail, amount)}
        />
      ))}

      <StatusNotice title="签名申请，不发链上交易">
        可用收益由钱包签署一次性结算意图，平台 Safe 组批并承担 Gas；只有达到 15 次确认的最终 Safe TxHash 才表示 Settled。
      </StatusNotice>
    </div>
  );
}

function TransferableRewardRail({
  rail,
  balances,
  requests,
  busy,
  onRequest,
}: {
  rail: 'REWARD_NPL' | 'PRIZE_USDT';
  balances: readonly SettlementBalance[];
  requests: readonly SettlementRequestProjection[];
  busy: boolean;
  onRequest(amount: string): void;
}) {
  const railBalances = balances.filter((balance) => railForBalance(balance) === rail);
  const railRequests = requests.filter((request) => request.rail === rail);
  const available = railBalances.find((balance) => balance.state === 'AVAILABLE');
  const states = ['LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED'] as const;
  return (
    <section className="reward-rail" aria-labelledby={`${rail}-title`}>
      <div className="reward-rail__header">
        <div className="reward-rail__icon"><Banknote aria-hidden="true" size={22} /></div>
        <div>
          <p className="eyebrow">{rail}</p>
          <h2 id={`${rail}-title`}>{rail === 'REWARD_NPL' ? 'NPL 收益' : '秒杀 USDT 奖金'}</h2>
        </div>
        <span className="status-pill">Core 账本</span>
      </div>
      <dl className="settlement-lifecycle" aria-label="结算生命周期金额">
        {states.map((state) => {
          const balance = railBalances.find((item) => item.state === state);
          return <div key={state}><dt>{settlementStateLabel(state)}</dt><dd>{balance?.amount ?? '--'}</dd></div>;
        })}
      </dl>
      {rail === 'REWARD_NPL' ? <RewardSubtypeBreakdown balances={railBalances} /> : null}
      {available ? (
        <button className="button button--primary" type="button" onClick={() => onRequest(available.amount)} disabled={busy}>
          <WalletCards aria-hidden="true" size={18} /> 签名申请结算 {available.amount}
        </button>
      ) : <p className="field-help">只有 Core 标记为 Available 的金额才能创建签名结算申请。</p>}
      {railRequests.length > 0 ? (
        <div className="settlement-request-list" aria-label="结算申请记录">
          {railRequests.map((request) => (
            <article key={request.request_id}>
              <div><strong>{settlementStateLabel(request.state)}</strong><span>{request.amount} {request.asset}</span></div>
              <p>申请 {shortHash(request.request_id)}{request.batch_id ? ` · 批次 ${shortHash(request.batch_id)}` : ''}</p>
              {request.final_safe_tx_hash ? (
                <p className="safe-hash"><span>Final Safe TxHash</span><code>{request.final_safe_tx_hash}</code></p>
              ) : <p>Safe 最终交易尚未达到 15 次确认</p>}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RewardSubtypeBreakdown({ balances }: { balances: readonly SettlementBalance[] }) {
  const subtypes = Array.from(new Set(
    balances.flatMap((balance) => balance.rewardSubtype ? [balance.rewardSubtype] : []),
  ));
  if (subtypes.length === 0) return null;
  return (
    <div className="reward-breakdown" aria-label="NPL 收益来源明细">
      <h3>收益来源</h3>
      {subtypes.map((subtype) => (
        <article key={subtype}>
          <strong>{rewardSubtypeLabel(subtype)}</strong>
          <div>
            {balances.filter((balance) => balance.rewardSubtype === subtype).map((balance) => (
              <span key={`${subtype}-${balance.state}`}>{settlementStateLabel(balance.state)} {balance.amount}</span>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

export function NotificationsScreen() {
  const runtime = useMallRuntime();
  return (
    <div className="screen screen--detail">
      <ScreenHeader eyebrow="INBOX" title="通知中心" description="订单、BNM 与 Safe 结算消息" backTo="/assets" />
      {!runtime.session ? <StatusNotice title="请先验证钱包">通知只按当前已验证钱包读取。</StatusNotice> : null}
      {runtime.session ? (
        <section className="notification-settings" aria-labelledby="notification-setting-title">
          <div>
            <Bell aria-hidden="true" size={21} />
            <div>
              <h2 id="notification-setting-title">站内通知</h2>
              <p>{runtime.notificationEndpoint ? `${runtime.notificationEndpoint.provider} · ${runtime.notificationEndpoint.state}` : '绑定当前钱包作为站内收件人'}</p>
            </div>
          </div>
          <button className="button button--secondary" type="button" onClick={() => void runtime.enableInAppNotifications()} disabled={runtime.busy}>
            {runtime.notificationEndpoint ? '重新确认绑定' : '启用站内通知'}
          </button>
        </section>
      ) : null}
      {runtime.notificationsState === 'loading' ? <p className="loading-copy" role="status">正在同步通知…</p> : null}
      {runtime.notificationsState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="通知同步失败" tone="warning">不会使用本地示例消息替代 Core inbox。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadNotifications()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.notificationsState === 'empty' ? <EmptyState title="暂无通知">新消息会由 Core 按当前钱包和主题投递。</EmptyState> : null}
      {runtime.notificationsState === 'ready' ? (
        <div className="notification-list" aria-label="通知列表">
          {runtime.notifications.map((item) => (
            <article key={item.messageId}>
              <div className="notification-list__header">
                <div><p className="eyebrow">{item.topic}</p><h2>{item.sourceEventType}</h2></div>
                <span className="status-pill">{notificationStateLabel(item.deliveryState)}</span>
              </div>
              {notificationTemplateRows(item.templateData).map(([key, value]) => <p key={key}><span>{key}</span><strong>{value}</strong></p>)}
              <time dateTime={item.createdAt}>{formatIso(item.createdAt)}</time>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PublishedContent({
  items,
  state,
  onRetry,
}: {
  items: MallRuntimeValue['cmsItems'];
  state: MallRuntimeValue['cmsState'];
  onRetry(): void;
}) {
  if (state === 'error') {
    return (
      <div className="cms-error" role="status">
        <span>平台公告同步失败</span>
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (items.length === 0) return null;
  return (
    <section className="published-content" aria-label="平台发布内容">
      {items.map((item) => (
        <article key={item.versionId}>
          <Megaphone aria-hidden="true" size={18} />
          <div>
            <p className="eyebrow">{item.contentType} · V{item.version}</p>
            <h2>{publicContentText(item.content) || item.slug}</h2>
            <span>{item.placement} · {item.locale}</span>
          </div>
        </article>
      ))}
    </section>
  );
}

export function CheckoutScreen() {
  const runtime = useMallRuntime();
  const product = runtime.selectedProduct;
  const sku = runtime.selectedSku;
  const canQuote = Boolean(
    runtime.session
      && runtime.bootstrap?.writesEnabled
      && product
      && sku
      && product.fulfillmentModes.includes(runtime.fulfillmentMode)
      && (!sku.seckill || Boolean(runtime.selectedSeckillSessionId))
      && runtime.checkoutTarget?.fulfillmentMode === runtime.fulfillmentMode
      && (!runtime.selectedSeckillSessionId
        || (runtime.seckillSession?.sessionId === runtime.selectedSeckillSessionId
          && runtime.seckillSession.phase === 'LIVE'))
      && !runtime.busy,
  );

  return (
    <div className="screen screen--detail screen--checkout">
      <ScreenHeader
        eyebrow={runtime.selectedSeckillSessionId ? 'SECKILL ORDER SETUP' : 'ORDER SETUP'}
        title={runtime.selectedSeckillSessionId ? '秒杀订单配置' : '订单配置'}
        description="规格、数量与履约方式需完整确认"
        backTo={runtime.selectedSeckillSessionId ? '/seckill' : '/mall'}
      />

      {runtime.selectedSeckillSessionId && runtime.seckillSession ? (
        <StatusNotice title="已绑定权威秒杀场次">
          {shortHash(runtime.seckillSession.sessionId)} · {runtime.seckillSession.product.seckillListPriceUsdt} USDT；最终归类仍由 PaymentRouter 区块时间决定。
        </StatusNotice>
      ) : null}

      {!product ? (
        <StatusNotice title="请先选择商品" tone="warning">返回商城从 Core 可售目录选择商品，当前页面不会补入示例 SKU。</StatusNotice>
      ) : null}
      {product && !runtime.session ? (
        <StatusNotice title="需要钱包登录">连接钱包并签署 SIWE 登录挑战后，Core 才会为当前买家预留库存。</StatusNotice>
      ) : null}

      {product && (product.mainImageAssetIds.length > 0 || product.videoAssetId) ? (
        <section className="product-media-gallery" aria-label={`${product.title} 商品媒体`}>
          {product.mainImageAssetIds.map((assetId, index) => (
            <PublicCatalogMedia
              alt={`${product.title} 商品图 ${index + 1}`}
              assetId={assetId}
              expectedPurpose="PRODUCT_IMAGE"
              expectedResourceId={product.productId}
              expectedResourceType="PRODUCT"
              key={assetId}
              kind="image"
            />
          ))}
          {product.videoAssetId ? (
            <PublicCatalogMedia
              alt={`${product.title} 商品视频`}
              assetId={product.videoAssetId}
              expectedPurpose="PRODUCT_VIDEO"
              expectedResourceId={product.productId}
              expectedResourceType="PRODUCT"
              kind="video"
            />
          ) : null}
        </section>
      ) : null}
      {product && runtime.bootstrap && !runtime.bootstrap.writesEnabled ? (
        <StatusNotice title="新支付当前已安全停用" tone="warning">
          {runtime.bootstrap.blockCode === 'DecisionBlocked'
            ? '支付政策尚有未决项，不创建新报价。'
            : '支付部署、Safe、RPC 或运行就绪证据尚不完整，不创建新报价。'}
        </StatusNotice>
      ) : null}

      {product ? (
        <section className="section-block product-core-detail" aria-labelledby="product-core-detail-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">CORE PRODUCT</p>
              <h2 id="product-core-detail-title">{product.title}</h2>
            </div>
            <ShoppingBag aria-hidden="true" size={19} />
          </div>
          {product.subtitle ? <p className="product-core-detail__subtitle">{product.subtitle}</p> : null}
          {richDetailText(product.richDetail) ? <p>{richDetailText(product.richDetail)}</p> : null}
          <dl className="product-core-detail__facts">
            <div><dt>默认运费</dt><dd>{product.defaultFreightUsdt} USDT 原子单位</dd></div>
            <div><dt>履约方式</dt><dd>{product.fulfillmentModes.map(fulfillmentModeLabel).join(' / ')}</dd></div>
          </dl>
        </section>
      ) : null}

      <section className="section-block" aria-labelledby="sku-title">
        <div className="section-heading"><h2 id="sku-title">商品规格</h2><Box aria-hidden="true" size={19} /></div>
        {product ? (
          <div className="sku-options">
            {product.skus.map((item) => (
              <button
                key={item.skuId}
                type="button"
                className={sku?.skuId === item.skuId ? 'sku-option is-active' : 'sku-option'}
                aria-pressed={sku?.skuId === item.skuId}
                onClick={() => runtime.selectSku(item.skuId)}
                disabled={runtime.busy
                  || Boolean(runtime.pendingSubmission)
                  || BigInt(item.stockAvailable) === 0n
                  || Boolean(item.seckill && !runtime.selectedSeckillSessionId)
                  || Boolean(runtime.selectedSeckillSessionId && item.skuId !== runtime.seckillSession?.product.skuId)}
              >
                <strong>{skuLabel(item.attributes, item.skuId)}</strong>
                <span>{item.seckill ? `${seckillOverlayLabel(item.seckill.phase)} · 活动价 ${item.seckill.seckillListPriceUsdt}` : `标价 ${item.listPriceUsdt}`} USDT 原子单位 · 库存 {item.seckill?.inventory.available ?? item.stockAvailable}</span>
              </button>
            ))}
          </div>
        ) : <div className="selection-placeholder">SKU 选项将随商品目录同步</div>}
      </section>

      <section className="section-block" aria-labelledby="quantity-title">
        <div className="section-heading"><h2 id="quantity-title">购买数量</h2></div>
        <div className="stepper" aria-label="购买数量">
          <button type="button" disabled={runtime.busy || Boolean(runtime.pendingSubmission) || !sku || runtime.quantity <= 1} onClick={() => runtime.setQuantity(runtime.quantity - 1)} aria-label="减少数量"><Minus aria-hidden="true" size={18} /></button>
          <output aria-label="当前数量">{runtime.quantity}</output>
          <button
            type="button"
            disabled={runtime.busy || Boolean(runtime.pendingSubmission) || !sku || BigInt(runtime.quantity) >= BigInt(sku.stockAvailable)}
            onClick={() => runtime.setQuantity(runtime.quantity + 1)}
            aria-label="增加数量"
          ><Plus aria-hidden="true" size={18} /></button>
        </div>
      </section>

      <fieldset className="fulfillment-mode">
        <legend>履约方式</legend>
        <div className="segmented-control segmented-control--two">
          <button type="button" disabled={runtime.busy || Boolean(runtime.pendingSubmission) || !product?.fulfillmentModes.includes('DELIVERY')} className={runtime.fulfillmentMode === 'DELIVERY' ? 'is-active' : ''} aria-pressed={runtime.fulfillmentMode === 'DELIVERY'} onClick={() => runtime.setFulfillmentMode('DELIVERY')}>
            <Truck aria-hidden="true" size={17} /> 快递邮寄
          </button>
          <button type="button" disabled={runtime.busy || Boolean(runtime.pendingSubmission) || !product?.fulfillmentModes.includes('PICKUP')} className={runtime.fulfillmentMode === 'PICKUP' ? 'is-active' : ''} aria-pressed={runtime.fulfillmentMode === 'PICKUP'} onClick={() => runtime.setFulfillmentMode('PICKUP')}>
            <Store aria-hidden="true" size={17} /> 到店自提
          </button>
        </div>
      </fieldset>

      <CheckoutTargetSelector />

      <div className="checkout-total">
        <span>Core 签名报价</span>
        <strong>{runtime.quote ? `${primaryIntent(runtime.quote).listPriceUsdt} USDT 原子单位` : '--'}</strong>
      </div>
      <button
        className="button button--primary"
        type="button"
        disabled={!canQuote}
        onClick={() => void (runtime.selectedSeckillSessionId
          ? runtime.requestSeckillQuote(runtime.selectedSeckillSessionId)
          : runtime.requestOrdinaryQuote())}
      >
        {runtime.busy ? '正在预留库存' : runtime.selectedSeckillSessionId ? '创建双腿秒杀报价' : '创建签名报价'}
      </button>
      {!canQuote ? <p className="control-reason">{quoteDisabledReason(runtime)}</p> : null}
      {runtime.quote ? (
        <section className="reservation-summary" aria-labelledby="reservation-title">
          <div><p className="eyebrow">ATOMIC RESERVATION</p><h2 id="reservation-title">库存已预留</h2></div>
          <dl>
            <div><dt>订单</dt><dd>{runtime.quote.orderId}</dd></div>
            <div><dt>预留</dt><dd>{primaryIntent(runtime.quote).reservationId}</dd></div>
            <div><dt>报价截止</dt><dd>{formatTimestamp(primaryIntent(runtime.quote).deadline)}</dd></div>
          </dl>
          <Link className="button button--primary" to="/checkout/review">核对报价 <ChevronRight aria-hidden="true" size={17} /></Link>
        </section>
      ) : null}
    </div>
  );
}

function CheckoutTargetSelector() {
  const runtime = useMallRuntime();
  const [recipientName, setRecipientName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');

  return (
    <section className="checkout-target" aria-labelledby="checkout-target-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">CORE TARGET</p>
          <h2 id="checkout-target-title">{runtime.fulfillmentMode === 'DELIVERY' ? '快递目标' : '自提门店'}</h2>
        </div>
        {runtime.fulfillmentMode === 'DELIVERY' ? <MapPinned aria-hidden="true" size={19} /> : <Store aria-hidden="true" size={19} />}
      </div>

      {runtime.fulfillmentMode === 'DELIVERY' ? (
        <form
          className="checkout-target__form"
          onSubmit={(event) => {
            event.preventDefault();
            void runtime.createDeliveryTarget({ recipientName, phone, address });
          }}
          noValidate
        >
          <div className="checkout-target__person">
            <label className="field">收货人<input value={recipientName} onChange={(event) => setRecipientName(event.target.value)} autoComplete="name" maxLength={64} /></label>
            <label className="field">手机号<input value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))} inputMode="numeric" autoComplete="tel" /></label>
          </div>
          <label className="field">详细地址<textarea value={address} onChange={(event) => setAddress(event.target.value)} autoComplete="street-address" rows={3} maxLength={300} /></label>
          <button
            className="button button--secondary"
            type="submit"
            disabled={!runtime.session || runtime.busy || !recipientName.trim() || !/^\d{11}$/.test(phone) || address.trim().length < 5}
          >
            <LocateFixed aria-hidden="true" size={18} />
            {runtime.locationState === 'loading' ? '定位中' : '验证快递目标'}
          </button>
          {runtime.locationState !== 'ready' ? <p className="control-reason">需要浏览器定位与 Core AMap 行政区验证，拒绝定位时保持 fail-closed。</p> : null}
        </form>
      ) : (
        <div className="pickup-options">
          {runtime.storesState === 'loading' ? <StoreListSkeleton /> : null}
          {runtime.storesState === 'empty' ? <p className="section-copy">当前没有可用自提门店。</p> : null}
          {runtime.storesState === 'error' ? <p className="field-error">门店列表不可用，无法创建自提目标。</p> : null}
          {runtime.stores.map((store) => (
            <button
              key={store.storeId}
              type="button"
              className="pickup-option"
              disabled={!runtime.session || runtime.busy || store.status !== 'ACTIVE'}
              onClick={() => void runtime.createPickupTarget(store.storeId)}
            >
              <span><strong>{store.name}</strong><small>{store.address}</small></span>
              <ChevronRight aria-hidden="true" size={17} />
            </button>
          ))}
        </div>
      )}

      {runtime.checkoutTarget?.fulfillmentMode === runtime.fulfillmentMode ? (
        <div className="fulfillment-preview" aria-live="polite">
          <BadgeCheck aria-hidden="true" size={22} />
          <div>
            <h2>Core 目标已验证</h2>
            <p>{runtime.checkoutTarget.label}</p>
            <span>{shortHash(runtime.checkoutTarget.fulfillmentTargetHash)}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ReviewScreen() {
  const runtime = useMallRuntime();
  const [approvalAcknowledged, setApprovalAcknowledged] = useState(false);
  const [seckillAcknowledged, setSeckillAcknowledged] = useState(false);
  const quote = runtime.quote;
  const intent = quote ? primaryIntent(quote) : null;
  const isSeckillQuote = Boolean(quote && 'dual' in quote);
  const requiresApproval = Boolean(
    quote && (
      runtime.approvals.length !== quote.approvalRequirements.length
        || runtime.approvals.some((approval) => !approval.sufficient)
    ),
  );
  const reviewRows = [
    { icon: Package, label: '商品与最终规格', value: runtime.selectedProduct && runtime.selectedSku ? `${runtime.selectedProduct.title} · ${skuLabel(runtime.selectedSku.attributes, runtime.selectedSku.skuId)}` : '待签名预留' },
    { icon: ScanLine, label: '数量与总价', value: intent ? `x${intent.quantity} · ${intent.listPriceUsdt} USDT 原子单位` : '待签名报价' },
    { icon: Truck, label: '履约方式', value: intent ? (intent.fulfillmentMode === 0 ? '快递邮寄' : '到店自提') : '待确认' },
    { icon: MapPinned, label: '地址或门店', value: intent ? shortHash(intent.fulfillmentTargetHash) : '待权威校验' },
  ];

  return (
    <div className="screen screen--detail screen--review">
      <ScreenHeader eyebrow="FINAL REVIEW" title="付前最终核对" description="五项信息全部绑定后才能广播" backTo="/checkout" />

      <ol className="review-list">
        {reviewRows.map((row, index) => {
          const Icon = row.icon;
          return (
            <li key={row.label}>
              <span className="review-list__number">{index + 1}</span>
              <Icon aria-hidden="true" size={19} />
              <div><strong>{row.label}</strong><span>{row.value}</span></div>
            </li>
          );
        })}
        <li>
          <span className="review-list__number">5</span>
          <WalletCards aria-hidden="true" size={19} />
          <div><strong>钱包广播</strong><span>{quote ? `${quote.routerCall.functionName} · BSC 56` : '待安全配置'}</span></div>
        </li>
      </ol>

      <section className="immutable-warning" aria-labelledby="immutable-warning-title">
        <ShieldAlert aria-hidden="true" size={22} />
        <div>
          <h2 id="immutable-warning-title">付款前请最终确认</h2>
          <p>付款成功后，履约方式以及地址或门店的行政区划将写入订单快照，后续不可修改。</p>
        </div>
      </section>

      <section className="allowance-disclosure" aria-labelledby="allowance-title">
        <Banknote aria-hidden="true" size={21} />
        <div>
          <h2 id="allowance-title">授权与支付</h2>
          <p>额度不足时按 Core 要求申请 MaxUint256；额度足够时不重复授权。撤销使用 approve(0)。</p>
        </div>
      </section>

      {quote ? (
        <section className="payment-intent" aria-labelledby="payment-intent-title">
          <div className="section-heading"><h2 id="payment-intent-title">精确支付意图</h2><WalletCards aria-hidden="true" size={19} /></div>
          <dl>
            <div><dt>USDT 支付</dt><dd>{intent?.usdtPaymentAmount}</dd></div>
            <div><dt>NPL 支付</dt><dd>{intent?.nplPaymentAmount}</dd></div>
            <div><dt>NPL Burn</dt><dd>{intent?.nplBurnAmount}</dd></div>
            <div><dt>NPL Reward Safe</dt><dd>{intent?.nplRewardAmount}</dd></div>
            <div><dt>BNM Locked</dt><dd>{intent?.bnmAmount}</dd></div>
          </dl>
          <p className="field-help">以上均为 Core 返回的 canonical 原子单位，页面未重新计算或分配。</p>
          {quote.approvalRequirements.map((requirement, index) => (
            <article className="approval-row" key={requirement.token}>
              <div><strong>{shortHash(requirement.token)}</strong><span>授权对象 {shortHash(requirement.spender)}</span></div>
              <div><span>当前 {runtime.approvals[index]?.currentAllowance ?? '读取中'}</span><span>{runtime.approvals[index]?.sufficient ? '额度足够' : '需要授权'}</span></div>
              <div><span>最低 {requirement.requiredAmount}</span><span>请求 {requirement.requestedAllowance}</span></div>
              <button className="text-button" type="button" onClick={() => void runtime.revokeApproval(index)} disabled={runtime.busy || !runtime.session}>撤销额度</button>
            </article>
          ))}
          {requiresApproval ? (
            <label className="check-field approval-check">
              <input type="checkbox" checked={approvalAcknowledged} onChange={(event) => setApprovalAcknowledged(event.target.checked)} />
              <span>我已了解无限额度授权风险与上述撤销入口</span>
            </label>
          ) : <p className="field-help">当前两笔代币额度均充足，本次不重复请求授权。</p>}
        </section>
      ) : null}

      {quote && 'dual' in quote ? (
        <section className="dual-quote" aria-labelledby="dual-quote-title">
          <div className="section-heading"><h2 id="dual-quote-title">秒杀与日常备用报价</h2><Zap aria-hidden="true" size={19} /></div>
          <div className="dual-quote__grid">
            <div><strong>区块时间在场内</strong><span>总价 {quote.routerCall.intent.seckillPayment.listPriceUsdt}</span><span>USDT {quote.routerCall.intent.seckillPayment.usdtPaymentAmount}</span><span>NPL {quote.routerCall.intent.seckillPayment.nplPaymentAmount}</span></div>
            <div><strong>区块时间已过截止</strong><span>总价 {quote.routerCall.intent.fallbackPayment.listPriceUsdt}</span><span>USDT {quote.routerCall.intent.fallbackPayment.usdtPaymentAmount}</span><span>NPL {quote.routerCall.intent.fallbackPayment.nplPaymentAmount}</span></div>
          </div>
          <p className="field-help">分类只由 PaymentRouter 的链上区块时间决定；截止后原子使用日常报价和独立库存预留。</p>
          <label className="check-field approval-check">
            <input type="checkbox" checked={seckillAcknowledged} onChange={(event) => setSeckillAcknowledged(event.target.checked)} />
            <span>我已同时核对两笔五分钟签名报价和链上分类规则</span>
          </label>
        </section>
      ) : null}

      <button
        className="button button--primary"
        type="button"
        disabled={!quote || (requiresApproval && !approvalAcknowledged) || (isSeckillQuote && !seckillAcknowledged) || Boolean(runtime.submittedTxHash) || runtime.busy || !runtime.bootstrap?.writesEnabled || !runtime.walletWritesAuthorized}
        onClick={() => void runtime.broadcastPayment(approvalAcknowledged, seckillAcknowledged)}
      >
        <WalletCards aria-hidden="true" size={18} /> {runtime.busy ? '正在处理' : '支付并广播'}
      </button>
      {!runtime.walletWritesAuthorized ? (
        <p className="control-reason">协调 manifest 尚未授权部署与 PAY_ORDER，不会向未发布合约广播。</p>
      ) : null}

      {quote ? (
        <section className="payment-status" aria-labelledby="payment-status-title">
          <div className="section-heading"><h2 id="payment-status-title">支付同步</h2><Radio aria-hidden="true" size={19} /></div>
          <dl>
            <div><dt>报价状态</dt><dd>{runtime.projection?.state ?? quote.state}</dd></div>
            <div><dt>提交 TxHash</dt><dd>{runtime.projection?.submittedTxHash ?? runtime.submittedTxHash ?? quote.submittedTxHash ?? '未提交'}</dd></div>
            <div><dt>链上分类</dt><dd>{runtime.projection?.finality?.classification ?? '待 Indexer'}</dd></div>
            <div><dt>确认数</dt><dd>{runtime.projection?.finality ? `${runtime.projection.finality.confirmations}/${runtime.projection.finality.requiredConfirmations}` : '--/15'}</dd></div>
            <div><dt>最终性</dt><dd>{runtime.projection?.finality?.state ?? '待 Indexer'}</dd></div>
          </dl>
          <button className="button button--secondary" type="button" onClick={() => void runtime.refreshPayment()} disabled={runtime.busy || !runtime.session}>
            <RefreshCw aria-hidden="true" size={18} /> 刷新 Core 投影
          </button>
          {runtime.pendingSubmission ? (
            <button className="button button--secondary" type="button" onClick={() => void runtime.retrySubmission()} disabled={runtime.busy}>
              <RefreshCw aria-hidden="true" size={18} />
              {runtime.pendingSubmission.phase === 'PENDING_CORE_SUBMISSION' ? '重试提交 TxHash' : '刷新 Core 投影'}
            </button>
          ) : null}
        </section>
      ) : <StatusNotice title="尚未创建签名报价">返回订单配置选择 Core 商品和 SKU，由 Core 原子预留库存后再核对。</StatusNotice>}
    </div>
  );
}

export function NotFoundScreen() {
  return (
    <div className="screen screen--detail">
      <ScreenHeader eyebrow="404" title="页面不存在" description="该入口未在当前商城版本中发布" backTo="/seckill" />
      <EmptyState title="找不到该页面">返回秒杀大厅继续浏览已开放的页面。</EmptyState>
      <Link className="button button--primary" to="/seckill">返回秒杀大厅</Link>
    </div>
  );
}

function primaryIntent(quote: NonNullable<MallRuntimeValue['quote']>): PaymentRouterIntent {
  return quote.routerCall.functionName === 'pay'
    ? quote.routerCall.intent
    : quote.routerCall.intent.seckillPayment;
}

function skuLabel(attributes: Readonly<Record<string, unknown>>, fallback: string) {
  const values = Object.values(attributes).filter(
    (value): value is string | number => typeof value === 'string' || typeof value === 'number',
  );
  return values.length > 0 ? values.join(' / ') : fallback;
}

function quoteDisabledReason(runtime: MallRuntimeValue) {
  if (!runtime.selectedProduct) return '请先从商城选择商品';
  if (!runtime.selectedSku) return '请手动选择一个可售 SKU';
  if (!runtime.selectedProduct.fulfillmentModes.includes(runtime.fulfillmentMode)) return '该商品未发布当前履约方式';
  if (runtime.selectedSku.seckill && !runtime.selectedSeckillSessionId) return '该 SKU 正在活动阶段，普通结算已停用';
  if (!runtime.session) return '请先连接钱包并完成 SIWE 登录';
  if (!runtime.bootstrap) return '正在同步 Core 安全状态';
  if (!runtime.bootstrap.writesEnabled) return '新支付当前被 Core 安全门禁阻断';
  if (runtime.selectedSeckillSessionId && (
    runtime.seckillSession?.sessionId !== runtime.selectedSeckillSessionId
      || runtime.seckillSession.phase !== 'LIVE'
  )) return 'Core 当前场次阶段不允许创建秒杀报价';
  if (!runtime.checkoutTarget || runtime.checkoutTarget.fulfillmentMode !== runtime.fulfillmentMode) {
    return runtime.fulfillmentMode === 'DELIVERY' ? '请先验证快递目标' : '请先选择自提门店';
  }
  return '请完成当前配置';
}

function CountdownMetric({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className="metric__value" aria-label={value ? `${label}${value}` : `${label}暂不可用`}>
        {value ?? '--'}
      </strong>
    </div>
  );
}

function useAuthoritativeCountdown(serverTime?: string, deadline?: string) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    setElapsedSeconds(0);
    if (!serverTime || !deadline) return;
    const timer = setInterval(() => setElapsedSeconds((current) => current + 1), 1_000);
    return () => clearInterval(timer);
  }, [serverTime, deadline]);
  if (!serverTime || !deadline) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(deadline) - Date.parse(serverTime)) / 1_000) - elapsedSeconds);
  if (!Number.isFinite(seconds)) return null;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

function SeckillPhasePill({ phase }: { phase?: SeckillSessionProjection['phase'] | undefined }) {
  const label = phase ? ({
    PREHEAT: '预热',
    LIVE: '进行中',
    SETTLING: '结算中',
    SETTLED: '已结算',
    FORCE_CLOSED: '已关闭',
  } as const)[phase] : '未同步';
  const tone = phase === 'LIVE' || phase === 'SETTLED'
    ? 'status-pill--success'
    : phase === 'SETTLING'
      ? 'status-pill--locked'
      : 'status-pill--muted';
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function seckillPhaseCopy(session: SeckillSessionProjection) {
  return ({
    PREHEAT: `预热中，Core 发布开始时间 ${formatIso(session.startsAt)}。`,
    LIVE: '主场和接力均以 Core 时间锚与已发布截止时间显示，页面不改变阶段。',
    SETTLING: `大奖结算窗口 ${formatIso(session.settlementEarliestAt)} 至 ${formatIso(session.settlementDeadline)}。`,
    SETTLED: session.winnerWallet ? '大奖已完成最终结算，赢家由 Core 最终投影发布。' : '场次已最终结算。',
    FORCE_CLOSED: '场次已由治理流程强制关闭，不再接受秒杀报价。',
  } as const)[session.phase];
}

function seckillActionReason(runtime: MallRuntimeValue, session: SeckillSessionProjection, productAvailable: boolean) {
  if (session.phase !== 'LIVE') return `Core 当前阶段为 ${session.phase}，不创建秒杀报价`;
  if (BigInt(session.inventory.available) === 0n) return 'Core 场次库存已售罄';
  if (!productAvailable) return '场次商品与当前可售目录不一致';
  if (!runtime.bootstrap?.writesEnabled) return 'Core 当前安全门禁阻断新支付';
  return '秒杀订单暂不可配置';
}

function realtimeStateLabel(state: MallRuntimeValue['seckillRealtimeState']) {
  return ({
    IDLE: '待场次',
    REPLAYING: '补齐中',
    CONNECTING: '连接中',
    LIVE: '实时',
    RECONNECTING: '恢复中',
    FAIL_CLOSED: '已停流',
    ARTIFACT_MISMATCH: '需重载',
  } as const)[state];
}

function shortAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function rewardSubtypeLabel(subtype: RewardSubtype) {
  return ({
    GENESIS: '创世',
    DIRECT_REFERRAL: '直推',
    DISTRICT: '区县',
    CITY: '城市',
    PROVINCE: '省',
    REGION: '大区',
    OPERATIONS: '运维',
    ROUNDING_REMAINDER: '取整余数',
  } as const)[subtype];
}

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function shortHash(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function CatalogTaxonomy({
  runtime,
  selectedCategoryId,
  selectedTagId,
  onSelectCategory,
  onSelectTag,
}: {
  runtime: MallRuntimeValue;
  selectedCategoryId: string | null;
  selectedTagId: string | null;
  onSelectCategory(categoryId: string | null): void;
  onSelectTag(tagId: string | null): void;
}) {
  const categoriesByLevel = ([1, 2, 3] as const).map((level) => ({
    level,
    items: runtime.categories.filter((category) => category.level === level),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="catalog-taxonomy">
      <button
        className={!selectedCategoryId && !selectedTagId ? 'taxonomy-reset is-active' : 'taxonomy-reset'}
        type="button"
        aria-pressed={!selectedCategoryId && !selectedTagId}
        onClick={() => { onSelectCategory(null); onSelectTag(null); }}
      >全部商品</button>
      {categoriesByLevel.map((group) => (
        <div className="taxonomy-level" key={group.level}>
          <span className="taxonomy-level__label">{categoryLevelLabel(group.level)}</span>
          <ul className="taxonomy-strip" aria-label={`${categoryLevelLabel(group.level)}类目`}>
            {group.items.map((category) => (
              <li key={category.categoryId}>
                <button
                  type="button"
                  aria-pressed={selectedCategoryId === category.categoryId}
                  className={selectedCategoryId === category.categoryId ? 'is-active' : ''}
                  onClick={() => onSelectCategory(selectedCategoryId === category.categoryId ? null : category.categoryId)}
                >
                {category.iconAssetId ? (
                  <PublicCatalogMedia
                    alt=""
                    assetId={category.iconAssetId}
                    expectedPurpose="CATEGORY_ICON"
                    expectedResourceId={category.categoryId}
                    expectedResourceType="CATEGORY"
                    kind="image"
                  />
                ) : null}
                <span>{category.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {runtime.tags.length > 0 ? (
        <div className="taxonomy-level">
          <span className="taxonomy-level__label">标签</span>
          <ul className="taxonomy-strip taxonomy-strip--tags" aria-label="商品标签">
            {runtime.tags.map((tag) => (
              <li key={tag.tagId} title={tag.example || undefined}>
                <button
                  type="button"
                  aria-pressed={selectedTagId === tag.tagId}
                  className={selectedTagId === tag.tagId ? 'is-active' : ''}
                  onClick={() => onSelectTag(selectedTagId === tag.tagId ? null : tag.tagId)}
                >
                  <Tag aria-hidden="true" size={13} />
                  <span>{tag.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PublicCatalogMedia({
  alt,
  assetId,
  expectedPurpose,
  expectedResourceId,
  expectedResourceType,
  kind,
}: {
  alt: string;
  assetId: string;
  expectedPurpose: MediaPurpose;
  expectedResourceId: string;
  expectedResourceType: MediaResourceType;
  kind: 'image' | 'video';
}) {
  const runtime = useMallRuntime();
  const [access, setAccess] = useState<MediaReadAccessProjection | null>(null);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setError(false);
    void runtime.resolvePublicMedia(assetId, refreshKey > 0)
      .then((nextAccess) => {
        assertMediaBinding(nextAccess, {
          assetId,
          expectedPurpose,
          expectedResourceId,
          expectedResourceType,
          kind,
        });
        if (!active) return;
        setAccess(nextAccess);
        const refreshDelay = Math.max(1_000, Date.parse(nextAccess.expiresAt) - Date.now() - 30_000);
        refreshTimer = setTimeout(() => setRefreshKey((current) => current + 1), refreshDelay);
      })
      .catch(() => {
        if (!active) return;
        setAccess(null);
        setError(true);
      });
    return () => {
      active = false;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [assetId, expectedPurpose, expectedResourceId, expectedResourceType, kind, refreshKey]);

  if (error) {
    return (
      <div className="public-media public-media--error" role="status">
        <ImageOff aria-hidden="true" size={19} />
        <button type="button" onClick={() => setRefreshKey((current) => current + 1)}>
          重新加载{kind === 'image' ? '图片' : '视频'}
        </button>
      </div>
    );
  }
  if (!access) return <div className="public-media public-media--loading" aria-label={`${alt || '类目图标'}加载中`} />;
  if (kind === 'video') {
    return <video className="public-media" src={access.readUrl} controls playsInline preload="metadata" aria-label={alt} onError={() => setError(true)} />;
  }
  return <img className="public-media" src={access.readUrl} alt={alt} referrerPolicy="no-referrer" onError={() => setError(true)} />;
}

function assertMediaBinding(
  access: MediaReadAccessProjection,
  expected: {
    assetId: string;
    expectedPurpose: MediaPurpose;
    expectedResourceId: string;
    expectedResourceType: MediaResourceType;
    kind: 'image' | 'video';
  },
) {
  const validContentType = expected.kind === 'image'
    ? access.contentType.startsWith('image/')
    : access.contentType === 'video/mp4';
  if (
    access.assetId.toLowerCase() !== expected.assetId.toLowerCase()
    || access.purpose !== expected.expectedPurpose
    || access.resourceType !== expected.expectedResourceType
    || access.resourceId !== expected.expectedResourceId
    || !validContentType
  ) throw new Error('媒体读取授权与公开目录资源不一致');
}

function categoryLevelLabel(level: CatalogCategory['level']) {
  return ({ 1: '一级', 2: '二级', 3: '三级' } as const)[level];
}

function descendantCategoryIds(categoryId: string, categories: readonly CatalogCategory[]) {
  const ids = new Set([categoryId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of categories) {
      if (category.parentCategoryId && ids.has(category.parentCategoryId) && !ids.has(category.categoryId)) {
        ids.add(category.categoryId);
        changed = true;
      }
    }
  }
  return ids;
}

function seckillOverlayLabel(phase: 'PREHEAT' | 'LIVE' | 'SETTLING') {
  return ({ PREHEAT: '秒杀预热', LIVE: '秒杀进行中', SETTLING: '秒杀结算中' } as const)[phase];
}

function fulfillmentModeLabel(mode: 'DELIVERY' | 'PICKUP') {
  return mode === 'DELIVERY' ? '快递邮寄' : '到店自提';
}

function richDetailText(detail: Readonly<Record<string, unknown>>) {
  return collectDetailText(detail).join(' · ');
}

function collectDetailText(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(collectDetailText);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectDetailText);
  return [];
}

const BUYER_FULFILLMENT_ACTIONS: readonly string[] = [
  'REQUEST_EXCHANGE',
  'REQUEST_DELAY',
  'CONFIRM_RECEIPT',
  'VERIFY_PICKUP',
  'OPEN_ARBITRATION',
  'OPEN_TAKEOVER',
];

const BUYER_EVIDENCE_ACTIONS = [
  'REQUEST_EXCHANGE',
  'REQUEST_DELAY',
  'CONFIRM_RECEIPT',
  'OPEN_ARBITRATION',
] as const satisfies readonly BuyerEvidenceAction[];

function isBuyerEvidenceAction(action: AllowedActionName): action is BuyerEvidenceAction {
  return BUYER_EVIDENCE_ACTIONS.some((supported) => supported === action);
}

function unsupportedBuyerActionReason(action: AllowedActionName) {
  if (action === 'OPEN_TAKEOVER') return 'Core 尚未发布 OPEN_TAKEOVER 的订单证据动作';
  if (action === 'VERIFY_PICKUP') return '自提核销证据仅授权门店或平台角色';
  return '当前 Mall 买家证据流程不支持该操作';
}

function distanceKm(location: BrowserPosition, store: MerchantStore) {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(store.latitude - location.latitude);
  const longitudeDelta = radians(store.longitude - location.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(location.latitude)) * Math.cos(radians(store.latitude))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function orderMatchesTab(order: FulfillmentOrder, tab: string) {
  if (tab === '全部') return true;
  if (tab === '待付款') return ['QUOTED', 'SUBMITTED'].includes(order.state);
  if (tab === '待发货') return order.state === 'PAID';
  if (tab === '待收货') return ['SHIPPED', 'DELIVERED', 'FULFILLMENT_PENDING'].includes(order.state);
  return ['ARBITRATION', 'TAKEOVER'].includes(order.state);
}

function orderStateLabel(state: FulfillmentOrder['state']) {
  return ({
    QUOTED: '待付款',
    SUBMITTED: '提交中',
    PAID: '待发货',
    SHIPPED: '运输中',
    DELIVERED: '已送达',
    ARBITRATION: '仲裁中',
    TAKEOVER: '平台接管',
    FULFILLMENT_PENDING: '履约确认中',
    FULFILLED: '已完成',
    REORG_PENDING: '重组核验中',
  } as const)[state];
}

function orderKindLabel(kind: FulfillmentOrder['orderKind']) {
  return ({ ORDINARY: '普通', SECKILL: '秒杀', FALLBACK_RETAIL: '边界转普通' } as const)[kind];
}

function finalityLabel(status: FulfillmentOrder['finalityStatus']) {
  return ({
    NOT_SUBMITTED: '未提交',
    PENDING: '确认中',
    CONFIRMED: '已确认',
    REPLACED: '交易已替换',
    REORGED: '链重组',
    FINAL: '链上最终',
  } as const)[status];
}

function logisticsStatusLabel(status: FulfillmentOrder['logistics'][number]['status']) {
  return ({
    PICKED_UP: '已揽收',
    IN_TRANSIT: '运输中',
    OUT_FOR_DELIVERY: '派送中',
    DELIVERED: '已送达',
    EXCEPTION: '物流异常',
  } as const)[status];
}

function balanceStateLabel(state: FulfillmentOrder['balances'][number]['state']) {
  return ({
    LOCKED: '锁定',
    AVAILABLE: '可用',
    REQUESTED: '已申请',
    BATCHED: '已入批次',
    SETTLED: '已结算',
    DISPUTED: '争议锁定',
  } as const)[state];
}

function requestTypeLabel(type: FulfillmentOrder['requests'][number]['requestType']) {
  return ({ EXCHANGE: '换货', DELAY: '延期', ARBITRATION: '仲裁', FORCED_RECEIPT: '强制收货审查' } as const)[type];
}

function actionLabel(action: AllowedAction['action']) {
  return ({
    REQUEST_EXCHANGE: '申请换货',
    REQUEST_DELAY: '申请延期',
    CONFIRM_RECEIPT: '确认收货',
    VERIFY_PICKUP: '自提核销',
    OPEN_ARBITRATION: '发起仲裁',
    OPEN_TAKEOVER: '平台接管',
  } as Partial<Record<AllowedAction['action'], string>>)[action] ?? action;
}

function railForBalance(balance: SettlementBalance): Extract<SettlementRail, 'REWARD_NPL' | 'PRIZE_USDT'> | null {
  if (balance.asset === 'NPL' && balance.purpose === 'REWARD_LIABILITY') return 'REWARD_NPL';
  if (balance.asset === 'USDT' && balance.purpose === 'SECKILL_PRIZE_LIABILITY') return 'PRIZE_USDT';
  return null;
}

function settlementStateLabel(state: SettlementBalance['state'] | SettlementRequestProjection['state']) {
  return ({
    LOCKED: 'Locked',
    AVAILABLE: 'Available',
    REQUESTED: 'Requested',
    BATCHED: 'Batched',
    SETTLED: 'Settled',
    DISPUTED: 'Disputed',
    RETRYABLE: '可重试',
    QUARANTINED: '已隔离',
  } as const)[state];
}

function notificationStateLabel(state: MallRuntimeValue['notifications'][number]['deliveryState']) {
  return ({
    PENDING: '待投递',
    PROCESSING: '投递中',
    DELIVERED: '已送达',
    RETRY: '待重试',
    CONFIGURATION_REQUIRED: '需配置',
    DEAD_LETTER: '已隔离',
  } as const)[state];
}

function notificationTemplateRows(template: Readonly<Record<string, unknown>>) {
  return Object.entries(template)
    .filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1]))
    .map(([key, value]) => [key, String(value)] as const);
}

function publicContentText(content: Readonly<Record<string, unknown>>) {
  const values: string[] = [];
  collectPublicText(content, values);
  const combined = values.join(' ').trim();
  return combined.length > 180 ? `${combined.slice(0, 177)}...` : combined;
}

function collectPublicText(value: unknown, output: string[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPublicText(item, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') output.push(record.text);
  if ('children' in record) collectPublicText(record.children, output);
}

function formatIso(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export const mallScreenRequirementEvidence = Object.freeze({
  sourceAndOverrides: ['MAL-SRC-001', 'MAL-OVR-001', 'MAL-SEC-001'],
  shell: ['MAL-SHELL-001', 'MAL-GOAL-001', 'MAL-GOAL-003'],
  seckill: ['MAL-SEK-001', 'MAL-SEK-002', 'MAL-SEK-003', 'MAL-SEK-004', 'MAL-TX-001'],
  catalog: ['MAL-CAT-001', 'MAL-CAT-002'],
  checkout: ['MAL-CHK-001', 'MAL-STOCK-001', 'MAL-REVIEW-001', 'MAL-REGION-001', 'MAL-WALLET-001', 'MAL-FLOW-001', 'MAL-FLOW-002'],
  stores: ['MAL-STORE-001'],
  assets: [
    'MAL-ASSET-001',
    'MAL-ASSET-002',
    'MAL-ASSET-003',
    'MAL-ASSET-004',
    'MAL-ASSET-005',
    'MAL-ASSET-006',
    'MAL-ASSET-007',
    'MAL-ADDR-001',
    'MAL-ORDER-001',
    'MAL-AFTER-001',
    'MAL-TRACK-001',
    'MAL-TRACK-002',
  ],
  rewards: ['MAL-RWD-001', 'MAL-RWD-002', 'MAL-RWD-003', 'MAL-RWD-004', 'MAL-RWD-005', 'MAL-RWD-006', 'MAL-FLOW-003'],
  walletAndExternal: ['MAL-GOAL-002', 'MAL-GOAL-004'],
});
