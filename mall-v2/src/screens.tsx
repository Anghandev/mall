import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  KeyRound,
  History,
  ImageOff,
  LockKeyhole,
  MapPinned,
  Megaphone,
  Minus,
  Package,
  PackageOpen,
  Phone,
  Plus,
  Radio,
  RefreshCw,
  ScanLine,
  Send,
  Save,
  ShieldAlert,
  ShoppingBag,
  Star,
  Store,
  Tag,
  Trash2,
  Truck,
  UserRound,
  WalletCards,
  Zap,
  X,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  chainIdentity,
  type ApprovalRequirement,
  type AllowedAction,
  type AllowedActionName,
  type BuyerSavedAddress,
  type CatalogCategory,
  type FulfillmentOrder,
  type FulfillmentTarget,
  type MerchantStore,
  type MediaPurpose,
  type MediaReadAccessProjection,
  type MediaResourceType,
  type PaymentRouterIntent,
  type RealtimeEventEnvelope,
  type RewardSubtype,
  type SeckillPrizeSettlementProjection,
  type SeckillSessionProjection,
  type SettlementBalance,
  type SettlementRail,
  type SettlementRequestProjection,
} from '@abu24k/core-artifacts';

import { BrandImage } from './brand-image';
import {
  DisabledAction,
  EmptyState,
  RulesDialog,
  RulesDisclosure,
  ScreenHeader,
  StatusNotice,
} from './components';
import type { BuyerEvidenceAction, PublishedSeckillSessionProjection } from './core-client';
import { useMallRuntime, type MallRuntimeValue, type PickupCredentialView } from './mall-runtime';

export function SeckillScreen() {
  const runtime = useMallRuntime();
  const navigate = useNavigate();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rulesDialogMode, setRulesDialogMode] = useState<'read' | 'confirm' | null>(null);
  const expiredReloadKeyRef = useRef<string | null>(null);
  const session = runtime.seckillSession;
  const mainTarget = session?.phase === 'PREHEAT' ? session.startsAt : session?.mainDeadline;
  const reloadExpiredDeadline = (deadlineKey: string) => {
    if (expiredReloadKeyRef.current === deadlineKey) return;
    expiredReloadKeyRef.current = deadlineKey;
    void runtime.reloadSeckill();
  };
  const mainCountdown = useAuthoritativeCountdown(session?.serverTime, mainTarget, reloadExpiredDeadline);
  const relayCountdown = useAuthoritativeCountdown(
    session?.serverTime,
    session?.phase === 'LIVE' ? session.relayDeadline : undefined,
    reloadExpiredDeadline,
  );
  const publishedRules = runtime.cmsItems.filter((item) => (
    item.contentType === 'SECKILL_RULES'
      && item.contentHash.toLowerCase() === session?.rulesContentHash.toLowerCase()
  ));
  const productAvailable = Boolean(session && runtime.catalog.some((product) =>
    product.productId === session.product.productId
      && product.skus.some((sku) => (
        sku.skuId === session.product.skuId
        && sku.seckill?.sessionId.toLowerCase() === session.sessionId.toLowerCase()
        && sku.seckill.phase === 'LIVE'
      ))));
  const canConfigure = Boolean(
    session?.phase === 'LIVE'
      && BigInt(session.inventory.available) > 0n
      && productAvailable
      && mainCountdown.ready
      && relayCountdown.ready
      && !mainCountdown.expired
      && !relayCountdown.expired
      && runtime.bootstrap?.writesEnabled
      && !runtime.pendingSubmission,
  );

  return (
    <div className="screen screen--seckill">
      <ScreenHeader
        eyebrow="60 分钟主场"
        title="秒杀大厅"
        description="看活动、看奖励、看剩余时间，准备好就直接抢"
        trailing={<SeckillPhasePill phase={session?.phase} />}
      />

      <section className="seckill-hero" aria-label="秒杀活动状态">
        <BrandImage
          filename="prize-vault.png"
          alt="黑金秒杀奖池保险柜"
          width={1024}
          height={1024}
          decoding="async"
          loading="eager"
          fetchPriority="high"
        />
        <div className="seckill-hero__overlay">
          <p>接力大奖池</p>
          <strong className="amount-placeholder">
            {session ? formatUsdtNumber(session.prizePoolUsdt) : '--'}
          </strong>
          <span>{session ? 'USDT · 当前活动实时同步' : '等待活动状态同步'}</span>
        </div>
      </section>

      <div className="timer-grid" aria-label="活动计时">
        <CountdownMetric
          label={session?.phase === 'PREHEAT' ? '距主场开始' : '主场倒计时'}
          value={mainCountdown}
        />
        <CountdownMetric label="接力倒计时" value={relayCountdown} />
      </div>

      <SeckillActionCard
        canConfigure={canConfigure}
        mainCountdown={mainCountdown}
        onConfigure={() => setRulesDialogMode('confirm')}
        productAvailable={productAvailable}
        relayCountdown={relayCountdown}
        runtime={runtime}
        session={session}
      />

      <div className="action-row">
        <RulesDisclosure onOpen={() => setRulesDialogMode('read')} />
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

      <PublishedContent
        items={publishedRules}
        state={runtime.cmsState}
        onRetry={() => void runtime.reloadCms()}
      />

      {runtime.seckillSessionState === 'loading' ? <p className="loading-copy" role="status">正在同步权威场次…</p> : null}
      {runtime.seckillSessionState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="活动同步失败" tone="warning">暂时不能参与，刷新成功后会恢复倒计时和抢购入口。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadSeckill()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.seckillSessionState === 'empty' ? <EmptyState title="暂无活动">现在还没有可参与的秒杀，开场后这里会显示商品和倒计时。</EmptyState> : null}

      {session ? <SeckillSessionDashboard session={session} /> : null}

      {historyOpen ? <SeckillHistory sessions={runtime.seckillHistory} /> : null}

      <section className="section-block" aria-labelledby="relay-feed-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">实时动态</p>
            <h2 id="relay-feed-title">最新抢购动态</h2>
          </div>
          <span className={`realtime-state realtime-state--${runtime.seckillRealtimeState.toLowerCase()}`}>
            <Radio aria-hidden="true" size={16} /> {realtimeStateLabel(runtime.seckillRealtimeState)}
          </span>
        </div>
        {runtime.seckillEvents.length === 0 ? (
          <EmptyState title="暂无抢购动态">还没有新的成功抢购，页面会自动刷新最新动态。</EmptyState>
        ) : (
          <ol className="relay-feed" aria-live="polite">
            {runtime.seckillEvents.map((event) => <RelayEvent event={event} key={event.eventId} />)}
          </ol>
        )}
        {runtime.seckillRealtimeError ? <p className="field-error" role="status">{runtime.seckillRealtimeError}</p> : null}
      </section>

      <RulesDialog
        open={rulesDialogMode !== null}
        confirmationRequired={rulesDialogMode === 'confirm'}
        onClose={() => setRulesDialogMode(null)}
        onConfirm={() => {
          if (!runtime.selectSeckillSession()) return;
          setRulesDialogMode(null);
          navigate('/checkout');
        }}
      />
    </div>
  );
}

function SeckillActionCard({
  canConfigure,
  mainCountdown,
  onConfigure,
  productAvailable,
  relayCountdown,
  runtime,
  session,
}: {
  canConfigure: boolean;
  mainCountdown: CountdownState;
  onConfigure(): void;
  productAvailable: boolean;
  relayCountdown: CountdownState;
  runtime: MallRuntimeValue;
  session: PublishedSeckillSessionProjection | null;
}) {
  const readyCopy = session
    ? seckillActionReason(runtime, session, productAvailable, mainCountdown, relayCountdown)
    : runtime.seckillSessionState === 'loading'
      ? '正在刷新活动信息'
      : '等待下一场活动开放';
  return (
    <section className="seckill-action-card" aria-labelledby="seckill-action-title">
      <div>
        <p className="eyebrow">参与入口</p>
        <h2 id="seckill-action-title">{canConfigure ? '现在可以抢' : '暂时不能抢'}</h2>
        <p>{canConfigure ? '确认规则后进入下单页，选择规格、履约方式和地址。' : readyCopy}</p>
      </div>
      <button
        className="button button--primary"
        type="button"
        disabled={!canConfigure || runtime.busy}
        onClick={onConfigure}
      >
        <WalletCards aria-hidden="true" size={18} />
        立即抢购
      </button>
    </section>
  );
}

function SeckillSessionDashboard({ session }: { session: PublishedSeckillSessionProjection }) {
  const publicStatus = seckillPhaseCopy(session);
  return (
    <section className="section-block seckill-dashboard" aria-labelledby="current-session-title">
      <div className="section-heading">
        <div><p className="eyebrow">当前活动</p><h2 id="current-session-title">{session.product.title}</h2></div>
        <Zap aria-hidden="true" size={19} />
      </div>
      <dl className="seckill-facts">
        <div><dt>秒杀价</dt><dd>{formatUsdtAmount(session.product.seckillListPriceUsdt)}</dd></div>
        <div><dt>剩余可抢</dt><dd>{session.inventory.available}</dd></div>
        <div><dt>成功抢购</dt><dd>{session.inventory.sold}</dd></div>
        <div><dt>活动奖励</dt><dd>奖池 + BNM</dd></div>
      </dl>
      <p className="phase-copy">{publicStatus}</p>
      {session.lastBuyerWallet ? <p className="last-buyer">最新抢购用户 {shortAddress(session.lastBuyerWallet)}</p> : null}
      {session.phase === 'SETTLED' ? (
        session.winnerWallet
          ? <div className="winner-callout"><BadgeCheck aria-hidden="true" size={20} /><span>本场中奖用户</span><strong>{shortAddress(session.winnerWallet)}</strong></div>
          : <p className="field-help">本场已结算，没有产生可展示的中奖用户。</p>
      ) : null}
      <SeckillPrizeOutcome session={session} publicView />
    </section>
  );
}

function SeckillHistory({ sessions }: { sessions: readonly PublishedSeckillSessionProjection[] }) {
  return (
    <section className="section-block" aria-labelledby="seckill-history-title">
      <div className="section-heading"><h2 id="seckill-history-title">历史战报</h2><History aria-hidden="true" size={18} /></div>
      {sessions.length === 0 ? <p className="section-copy">当前没有已结束的历史活动。</p> : (
        <div className="seckill-history-list">
          {sessions.map((session) => (
            <article key={session.sessionId}>
              <div><strong>{session.product.title}</strong><SeckillPhasePill phase={session.phase} /></div>
              <p>奖池 {formatUsdtAmount(session.prizePoolUsdt)} · 已售 {session.inventory.sold}</p>
              <p>{session.winnerWallet ? '赢家已确认' : '无已发布赢家'}</p>
              <SeckillPrizeOutcome session={session} compact publicView />
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
      <div><strong>用户 {shortAddress(String(payload.buyerWallet))}</strong><time dateTime={event.occurredAt}>{formatRelativeTime(event.occurredAt)}</time></div>
      <p>成功抢购，接力时间 +{String(payload.extensionSeconds)} 秒</p>
      <details className="technical-disclosure technical-disclosure--compact">
        <summary>客服核验编号</summary>
        <span>记录 {event.cursor} · {shortHash(String(payload.transactionHash))}</span>
      </details>
    </li>
  );
}

export function MallScreen() {
  const runtime = useMallRuntime();
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
        eyebrow="24K SELECT"
        title="常规商城"
        description="挑商品、选规格，付款前会再次确认价格"
      />

      <PublishedContent
        items={runtime.cmsItems.filter((item) => item.contentType !== 'SECKILL_RULES')}
        state={runtime.cmsState}
        onRetry={() => void runtime.reloadCms()}
      />

      <section className="catalog-banner">
        <BrandImage
          filename="market-banner.png"
          alt="24K商城黑金精选陈列"
          width={1024}
          height={1024}
          decoding="async"
          loading="eager"
          fetchPriority="high"
        />
        <div className="catalog-banner__copy">
          <span>24K SELECT</span>
          <strong>消费记录，履约后释放 BNM</strong>
        </div>
      </section>

      <section aria-labelledby="category-title" className="section-block section-block--flat">
        <div className="section-heading">
          <h2 id="category-title">商品分类</h2>
          <span className="muted-label">全部分类</span>
        </div>
        {runtime.taxonomyState === 'loading' ? (
          <div className="category-skeleton" aria-label="正在加载商品分类"><span /><span /><span /><span /></div>
        ) : null}
        {runtime.taxonomyState === 'empty' ? (
          <EmptyState title="暂无商品分类">分类还没整理好，可以稍后再来看看。</EmptyState>
        ) : null}
        {runtime.taxonomyState === 'error' ? (
          <div className="catalog-retry">
            <StatusNotice title="分类加载失败" tone="warning">分类暂时没加载出来，请刷新后再试。</StatusNotice>
            <button className="button button--secondary" type="button" onClick={() => void runtime.reloadTaxonomy()} disabled={runtime.busy}>
              <RefreshCw aria-hidden="true" size={18} /> 刷新分类
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
        <EmptyState title="暂无可买商品">现在还没有上架可购买的商品。</EmptyState>
      ) : null}
      {runtime.catalogState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="商品加载失败" tone="warning">商品暂时没加载出来，请刷新后再试。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadCatalog()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 刷新商品
          </button>
        </div>
      ) : null}
      {runtime.catalogState === 'ready' ? (
        <div className="product-grid" aria-label="可售商品">
          {visibleProducts.map((product) => {
            const overlay = product.skus.find((sku) => sku.seckill)?.seckill ?? null;
            const ordinarySkus = product.skus.filter((sku) => sku.seckill === null);
            const ordinarySkuCount = ordinarySkus.length;
            const activityOnly = Boolean(overlay && ordinarySkuCount === 0);
            const productPath = activityOnly ? '/seckill' : `/products/${encodeURIComponent(product.productId)}`;
            const firstOrdinarySku = ordinarySkus[0] ?? null;
            return (
            <Link
              aria-label={activityOnly ? `前往秒杀 ${product.title}` : `查看 ${product.title} 商品详情`}
              className={overlay ? 'product-card product-card--seckill' : 'product-card'}
              key={product.productId}
              to={productPath}
            >
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
                <div className="product-card__decision">
                  <span>{activityOnly ? '秒杀活动价' : '普通购买价'}</span>
                  <strong>{firstOrdinarySku ? formatUsdtAmount(firstOrdinarySku.listPriceUsdt) : overlay ? formatUsdtAmount(overlay.seckillListPriceUsdt) : '--'}</strong>
                  <small>{activityOnly ? '前往秒杀大厅参与' : `${ordinarySkuCount} 个普通规格可选`}</small>
                </div>
                <div className="product-card__badges" aria-label="商品属性">
                  <span>BNM 履约后释放</span>
                  {product.fulfillmentModes.map((mode) => <span key={mode}>{mode === 'DELIVERY' ? '快递' : '自提'}</span>)}
                  {product.tagIds.map((id) => <span key={id}>{runtime.tags.find((tag) => tag.tagId === id)?.name ?? id}</span>)}
                </div>
                {overlay ? (
                  <div className="product-card__seckill" role="status">
                    <Zap aria-hidden="true" size={15} />
                    <span>{overlay.phase === 'LIVE' ? '秒杀进行中，普通购买暂停，前往秒杀' : `${seckillOverlayLabel(overlay.phase)}，普通购买暂停`} · 活动价 {formatUsdtAmount(overlay.seckillListPriceUsdt)} · 剩余 {overlay.inventory.available}</span>
                  </div>
                ) : null}
                <dl>
                  <div><dt>普通可售规格</dt><dd>{ordinarySkuCount} / {product.skus.length}</dd></div>
                  <div><dt>默认运费</dt><dd>{formatUsdtAmount(product.defaultFreightUsdt)}</dd></div>
                </dl>
                <span className="button button--primary">
                  {activityOnly ? '前往秒杀' : '查看商品'} <ChevronRight aria-hidden="true" size={17} />
                </span>
              </div>
            </Link>
          );})}
        </div>
      ) : null}
      {runtime.catalogState === 'ready' && visibleProducts.length === 0 ? (
        <EmptyState title="当前筛选无商品">换个分类或清空筛选试试。</EmptyState>
      ) : null}
    </div>
  );
}

export function ProductDetailScreen({ productId }: { productId: string }) {
  const runtime = useMallRuntime();
  const navigate = useNavigate();
  const product = runtime.catalog.find((item) => item.productId === productId) ?? null;
  const ordinarySkus = product?.skus.filter((sku) => sku.seckill === null) ?? [];
  const hasOrdinaryStock = ordinarySkus.some((sku) => BigInt(sku.stockAvailable) > 0n);

  return (
    <div className="screen screen--detail screen--product-detail">
      <ScreenHeader eyebrow="商品详情" title="商品详情" description="商品、图片、规格与库存均由系统实时确认" backTo="/mall" />

      {runtime.catalogState === 'loading' ? <div className="product-detail-skeleton" aria-label="正在加载商品详情"><span /><span /><span /></div> : null}
      {runtime.catalogState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="商品详情同步失败" tone="warning">不展示缓存商品、示例规格或本地价格。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadCatalog()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.catalogState !== 'loading' && runtime.catalogState !== 'error' && !product ? (
        <EmptyState title="商品当前不可售">该商品当前不可售，请返回商城重新选择。</EmptyState>
      ) : null}

      {product ? (
        <>
          <section className="product-detail-gallery" aria-label={`${product.title} 商品媒体`}>
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
            {product.mainImageAssetIds.length === 0 && !product.videoAssetId ? <ImageOff aria-hidden="true" size={30} /> : null}
          </section>

          <section className="product-detail-copy" aria-labelledby="product-detail-title">
            <div>
              <p className="eyebrow">商品编号 · {shortHash(product.productId)}</p>
              <h2 id="product-detail-title">{product.title}</h2>
              {product.subtitle ? <p className="product-detail-copy__subtitle">{product.subtitle}</p> : null}
            </div>
            {richDetailText(product.richDetail) ? <p>{richDetailText(product.richDetail)}</p> : null}
            <div className="product-card__badges" aria-label="商品属性">
              <span>BNM 履约后释放</span>
              {product.fulfillmentModes.map((mode) => <span key={mode}>{fulfillmentModeLabel(mode)}</span>)}
              {product.tagIds.map((id) => <span key={id}>{runtime.tags.find((tag) => tag.tagId === id)?.name ?? id}</span>)}
            </div>
            <dl className="product-core-detail__facts">
              <div><dt>默认运费</dt><dd>{formatUsdtAmount(product.defaultFreightUsdt)}</dd></div>
              <div><dt>普通可售规格</dt><dd>{ordinarySkus.length} / {product.skus.length}</dd></div>
            </dl>
          </section>

          <section className="product-purchase-panel" aria-label="购买决策">
            <div>
              <span>可买规格</span>
              <strong>{ordinarySkus.length}</strong>
              <small>{hasOrdinaryStock ? '普通购买可继续' : '普通库存不足'}</small>
            </div>
            <div>
              <span>普通价格</span>
              <strong>{ordinarySkus[0] ? formatUsdtAmount(ordinarySkus[0].listPriceUsdt) : '--'}</strong>
              <small>最终以签名报价为准</small>
            </div>
            <div>
              <span>履约方式</span>
              <strong>{product.fulfillmentModes.map(fulfillmentModeLabel).join(' / ')}</strong>
              <small>下单时选择</small>
            </div>
          </section>

          <section className="section-block" aria-labelledby="product-skus-title">
            <div className="section-heading"><h2 id="product-skus-title">规格与实时库存</h2><Box aria-hidden="true" size={19} /></div>
            <div className="product-detail-skus">
              {product.skus.map((sku) => (
                <article className={sku.seckill ? 'product-detail-sku is-seckill' : 'product-detail-sku'} key={sku.skuId}>
                  <div><strong>{skuLabel(sku.attributes, sku.skuId)}</strong><code title={sku.skuId}>{shortHash(sku.skuId)}</code></div>
                  <span>{sku.seckill ? `活动库存 ${sku.seckill.inventory.available}` : `普通库存 ${sku.stockAvailable}`}</span>
                  <span>{sku.seckill ? `${seckillOverlayLabel(sku.seckill.phase)} · 普通结算禁用` : formatUsdtAmount(sku.listPriceUsdt)}</span>
                </article>
              ))}
            </div>
          </section>

          {product.skus.some((sku) => sku.seckill) ? (
          <StatusNotice title={ordinarySkus.length === 0 ? '秒杀进行中，普通购买暂停' : '活动规格普通购买暂停'}>
            {ordinarySkus.length === 0
              ? '带秒杀标记的规格不走普通购买；请从秒杀大厅下单。'
              : '活动规格普通购买暂停，其他普通规格可继续购买。'}
          </StatusNotice>
          ) : null}

          <div className="product-detail-buybar">
            {ordinarySkus.length === 0 ? (
              <button className="button button--primary" type="button" onClick={() => navigate('/seckill')}>前往秒杀大厅 <ChevronRight aria-hidden="true" size={17} /></button>
            ) : (
              <button
                className="button button--primary"
                type="button"
                disabled={!hasOrdinaryStock || runtime.busy || Boolean(runtime.pendingSubmission)}
                onClick={() => {
                  runtime.selectProduct(product.productId);
                  navigate('/checkout');
                }}
              >
                <ShoppingBag aria-hidden="true" size={18} /> {hasOrdinaryStock ? '购买' : '普通规格已售罄'}
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function StoresScreen() {
  const runtime = useMallRuntime();
  const [cityCode, setCityCode] = useState('');
  const [districtCode, setDistrictCode] = useState('');
  const cityCodes = useMemo(() => regionCityCodes(runtime.stores), [runtime.stores]);
  const districtCodes = useMemo(() => regionDistrictCodes(runtime.stores, cityCode), [runtime.stores, cityCode]);
  const visibleStores = runtime.stores.filter((store) => (
    (!cityCode || cityCodeFor(store.regionCode) === cityCode)
      && (!districtCode || store.regionCode === districtCode)
  ));

  useEffect(() => {
    if (!runtime.storesScope.productId || runtime.storesState === 'loading') return;
    void runtime.reloadStores();
  }, [runtime.storesScope.productId, runtime.storesState]);

  return (
    <div className="screen screen--stores">
      <ScreenHeader
        eyebrow="附近门店"
        title="线下门店"
        description="按地区查找可自提门店"
      />

      <BrandImage
        className="store-hero"
        filename="store-front.png"
        alt="24K商城线下门店空间"
        width={1024}
        height={1024}
        decoding="async"
        loading="eager"
        fetchPriority="high"
      />

      <div className="store-tools">
        <fieldset className="location-filter">
          <legend>地区筛选</legend>
          <label>
            国家
            <select value="CN" disabled aria-label="国家">
              <option value="CN">中国</option>
            </select>
          </label>
          <label>
            城市
            <select
              value={cityCode}
              aria-label="城市"
              onChange={(event) => {
                setCityCode(event.target.value);
                setDistrictCode('');
              }}
            >
              <option value="">全部城市</option>
              {cityCodes.map((code) => <option key={code} value={code}>城市 {code}</option>)}
            </select>
          </label>
          <label>
            区县
            <select value={districtCode} aria-label="区县" disabled={!cityCode} onChange={(event) => setDistrictCode(event.target.value)}>
              <option value="">全部区县</option>
              {districtCodes.map((code) => <option key={code} value={code}>区县 {code}</option>)}
            </select>
          </label>
        </fieldset>
        <div className="split-actions">
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadStores()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 刷新门店
          </button>
        </div>
      </div>

      {runtime.storesState === 'loading' ? <StoreListSkeleton /> : null}
      {runtime.storesState === 'error' ? (
        <StatusNotice title="门店加载失败" tone="warning">门店信息暂时没加载出来，请刷新后再试。</StatusNotice>
      ) : null}
      {runtime.storesState === 'empty' || (runtime.storesState === 'ready' && visibleStores.length === 0) ? (
        <EmptyState title="当前地区暂无门店">这个地区暂时没有可自提门店，可以换个城市或区县看看。</EmptyState>
      ) : null}
      {runtime.storesState === 'ready' && visibleStores.length > 0 ? (
        <div className="store-list" aria-label="可用自提门店">
          {visibleStores.map((store) => (
            <StoreRow key={store.storeId} store={store} />
          ))}
        </div>
      ) : null}
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

function StoreRow({ store }: { store: MerchantStore }) {
  return (
    <article className="store-row">
      <div className="store-row__header">
        <div>
          <h2>{store.name}</h2>
          <p>{store.address}</p>
        </div>
        <div className="store-row__badges">
          <span className={store.status === 'ACTIVE' ? 'status-pill status-pill--success' : 'status-pill status-pill--muted'}>
            {storeStatusLabel(store.status)}
          </span>
        </div>
      </div>
      <StoreMediaGallery store={store} />
      <dl className="store-row__facts">
        <div><dt>服务地区</dt><dd>按门店地址为准</dd></div>
        <div><dt>营业时间</dt><dd>{store.businessHours}</dd></div>
        <div><dt>服务方式</dt><dd>到店自提</dd></div>
      </dl>
      <div className="store-row__actions">
        <a className="button button--secondary" href={`tel:${store.phone}`} aria-label={`拨打 ${store.name} 电话`}>
          <Phone aria-hidden="true" size={18} /> 拨号
        </a>
      </div>
    </article>
  );
}

function StoreMediaGallery({ store, compact = false }: { store: MerchantStore; compact?: boolean }) {
  return (
    <div
      className={`store-media-gallery${compact ? ' store-media-gallery--compact' : ''}`}
      aria-label={`${store.name} 门店图片`}
    >
      {store.imageAssetIds.map((assetId, index) => (
        <PublicCatalogMedia
          key={assetId}
          alt={`${store.name} 门店图片 ${index + 1}`}
          assetId={assetId}
          expectedPurpose="STORE_IMAGE"
          expectedResourceId={store.storeId}
          expectedResourceType="STORE"
          kind="image"
        />
      ))}
    </div>
  );
}

export function AssetsScreen() {
  const runtime = useMallRuntime();
  const [editingProfile, setEditingProfile] = useState(false);
  const loadedActivityReady = runtime.session && ['ready', 'empty'].includes(runtime.ordersState);
  const loadedSeckillCount = runtime.orders.filter((order) => order.orderKind === 'SECKILL').length;
  const loadedShoppingCount = runtime.orders.length - loadedSeckillCount;
  const ledgerSummaries = ledgerStateSummaries(runtime);
  const orderItems = [
    { label: '待付款', icon: Clock3, count: orderCountText(runtime.buyerOverview?.orderCounts.pendingPayment) },
    { label: '待发货', icon: PackageOpen, count: orderCountText(runtime.buyerOverview?.orderCounts.pendingShipment) },
    { label: '待收货', icon: Truck, count: orderCountText(runtime.buyerOverview?.orderCounts.pendingReceipt) },
    { label: '售后 / 仲裁', icon: ShieldAlert, count: orderCountText(runtime.buyerOverview?.orderCounts.afterSale) },
  ];
  const assetTasks = [
    { title: '查订单', copy: '付款、发货、收货', to: '/assets/orders', icon: Package },
    { title: '收益结算', copy: 'BNM、NPL、USDT', to: '/assets/rewards', icon: CircleDollarSign },
    { title: '地址簿', copy: '下单前确认地址', to: '/assets/addresses', icon: MapPinned },
    { title: '通知', copy: '订单与结算消息', to: '/assets/notifications', icon: Bell },
  ];

  return (
    <div className="screen screen--assets">
      <ScreenHeader eyebrow="我的账户" title="我的资产" description="查看订单、地址、通知和可申请结算的收益" />

      <section className="profile-strip" aria-labelledby="profile-title">
        <div className="avatar-placeholder">
          {runtime.buyerAvatarAccess ? (
            <img src={runtime.buyerAvatarAccess.readUrl} alt="买家头像" referrerPolicy="no-referrer" />
          ) : <UserRound aria-hidden="true" size={24} />}
        </div>
        <div className="profile-strip__copy">
          <h2 id="profile-title">{runtime.buyerProfile?.nickname ?? (runtime.session ? '未设置昵称' : '未连接钱包')}</h2>
          <p>账号编号：{runtime.buyerProfile?.accountId ?? (runtime.session ? '正在加载' : '请先连接钱包')}</p>
        </div>
        <div className="profile-strip__actions">
          <button
            className="icon-button"
            type="button"
            aria-label="编辑买家资料"
            aria-expanded={editingProfile}
            disabled={!runtime.session || runtime.buyerProfileState !== 'ready'}
            onClick={() => setEditingProfile((current) => !current)}
          >
            <UserRound aria-hidden="true" size={20} />
          </button>
          <Link className="icon-button" to="/assets/notifications" aria-label="打开通知中心">
            <Bell aria-hidden="true" size={20} />
          </Link>
          <Link className="icon-button" to="/assets/addresses" aria-label="打开我的收货地址">
            <MapPinned aria-hidden="true" size={20} />
          </Link>
        </div>
      </section>

      {runtime.buyerProfileState === 'loading' ? <div className="account-skeleton" aria-label="正在加载买家资料" /> : null}
      {runtime.session && runtime.buyerProfileState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="资料加载失败" tone="warning">个人资料暂时没加载出来，请刷新后再试。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadBuyerAccount()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 刷新资料
          </button>
        </div>
      ) : null}
      {editingProfile && runtime.buyerProfile ? (
        <BuyerProfileForm onClose={() => setEditingProfile(false)} />
      ) : null}
      {runtime.buyerProfile?.avatarAssetId && runtime.buyerAvatarState === 'error' ? (
        <p className="field-error" role="status">头像暂时加载失败，昵称和账号信息不受影响。</p>
      ) : null}

      <section className="asset-task-grid" aria-label="常用资产操作">
        {assetTasks.map((task) => {
          const Icon = task.icon;
          return (
            <Link className="asset-task-card" key={task.to} to={task.to}>
              <Icon aria-hidden="true" size={19} />
              <span>{task.title}</span>
              <small>{task.copy}</small>
            </Link>
          );
        })}
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
                <strong>{runtime.session && runtime.buyerOverviewState === 'ready' ? item.count : '--'}</strong>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="section-block" aria-labelledby="activity-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">消费记录</p>
            <h2 id="activity-title">我的记录</h2>
          </div>
          <Link to="/assets/activity" className="icon-button" aria-label="查看我的记录">
            <ChevronRight aria-hidden="true" size={20} />
          </Link>
        </div>
        <div className="track-preview">
          <div>
            <Zap aria-hidden="true" size={19} />
            <span>秒杀参与</span>
            <strong>{loadedActivityReady ? loadedSeckillCount : activityCountState(runtime.ordersState, Boolean(runtime.session))}</strong>
            {loadedActivityReady ? <small>已加载</small> : null}
          </div>
          <div>
            <ShoppingBag aria-hidden="true" size={19} />
            <span>消费购物</span>
            <strong>{loadedActivityReady ? loadedShoppingCount : activityCountState(runtime.ordersState, Boolean(runtime.session))}</strong>
            {loadedActivityReady ? <small>已加载</small> : null}
          </div>
        </div>
      </section>

      <section className="section-block ledger-state-panel" aria-labelledby="ledger-state-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">收益状态</p>
            <h2 id="ledger-state-title">收益概览</h2>
          </div>
          <FileClock aria-hidden="true" size={19} />
        </div>
        <div className="ledger-state-grid">
          {ledgerSummaries.map((summary) => (
            <article key={summary.title} className="ledger-state-card">
              <h3>{summary.title}</h3>
              <dl>
                <div><dt>累计</dt><dd>{summary.total}</dd></div>
                <div><dt>{summary.title === 'BNM 积分' ? '可用' : '可申请'}</dt><dd>{summary.available}</dd></div>
                <div><dt>锁定中</dt><dd>{summary.locked}</dd></div>
              </dl>
              <p>{summary.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="ledger-banner" aria-labelledby="ledger-title">
        <BrandImage
          filename="bnm-ledger.png"
          alt="BNM 资产凭证视觉"
          width={1024}
          height={1024}
          decoding="async"
          loading="eager"
          fetchPriority="high"
        />
        <div>
          <p className="eyebrow">收益明细</p>
          <h2 id="ledger-title">收益中心</h2>
          <p>连接钱包后查看可申请收益、锁定中收益和结算记录。</p>
          <Link className="button button--light" to="/assets/rewards">
            查看收益 <ChevronRight aria-hidden="true" size={17} />
          </Link>
        </div>
      </section>
    </div>
  );
}

function BuyerProfileForm({ onClose }: { onClose(): void }) {
  const runtime = useMallRuntime();
  const [nickname, setNickname] = useState(runtime.buyerProfile?.nickname ?? '');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  return (
    <form
      className="profile-form"
      aria-label="编辑买家资料"
      onSubmit={(event) => {
        event.preventDefault();
        void runtime.saveBuyerProfile(nickname, avatarFile).then((saved) => { if (saved) onClose(); });
      }}
    >
      <label className="field">
        昵称
        <input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={40} autoComplete="nickname" />
      </label>
      <label className="field">
        头像文件
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)}
          aria-describedby="avatar-upload-help"
        />
        <span id="avatar-upload-help" className="field-help">支持 JPG、PNG 或 WebP，最大 10 MB；上传成功后会自动绑定到资料。</span>
      </label>
      <div className="profile-form__actions">
        <button className="button button--secondary" type="button" onClick={onClose} disabled={runtime.busy}>取消</button>
        <button className="button button--primary" type="submit" disabled={runtime.busy || nickname.trim().length > 40}>
          <Save aria-hidden="true" size={18} /> {runtime.busy ? '正在保存' : '保存资料'}
        </button>
      </div>
    </form>
  );
}

export function AddressScreen() {
  const runtime = useMallRuntime();
  const location = useLocation();
  const [draft, setDraft] = useState({
    label: '家', recipientName: '', phone: '', province: '', city: '', district: '',
    regionCode: '', detailAddress: '', isDefault: false,
  });
  const phoneInvalid = draft.phone.length > 0 && !/^1[3-9][0-9]{9}$/.test(draft.phone);
  const regionCodeInvalid = draft.regionCode.length > 0 && !/^[0-9]{6}$/.test(draft.regionCode);
  const canSave = Boolean(
    runtime.session
    && draft.label.trim()
    && draft.recipientName.trim()
    && /^1[3-9][0-9]{9}$/.test(draft.phone)
    && draft.province.trim()
    && draft.city.trim()
    && draft.district.trim()
    && /^[0-9]{6}$/.test(draft.regionCode)
    && draft.detailAddress.trim().length >= 5,
  );

  return (
    <div className="screen screen--detail">
      <ScreenHeader
        eyebrow="收货地址"
        title="我的收货地址"
        description="个人信息只提交到经过发布的安全服务"
        backTo={location.state && typeof location.state === 'object' && 'returnTo' in location.state && location.state.returnTo === '/checkout' ? '/checkout' : '/assets'}
      />

      <form
        className="section-block address-review"
        aria-labelledby="manual-address-title"
        onSubmit={(event) => {
          event.preventDefault();
          void runtime.createBuyerAddress({ ...draft, longitude: null, latitude: null }).then((saved) => {
            if (saved) setDraft((current) => ({ ...current, recipientName: '', phone: '', detailAddress: '' }));
          });
        }}
      >
        <div className="section-heading">
          <div><p className="eyebrow">手动填写地址</p><h2 id="manual-address-title">新增收货地址</h2></div>
          <MapPinned aria-hidden="true" size={19} />
        </div>
        <div className="form-grid">
          <label className="field">地址标签<input value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} maxLength={32} disabled={!runtime.session || runtime.busy} required /></label>
          <label className="field">收货人<input value={draft.recipientName} onChange={(event) => setDraft((current) => ({ ...current, recipientName: event.target.value }))} maxLength={64} autoComplete="name" disabled={!runtime.session || runtime.busy} required /></label>
          <label className="field">
            手机号
            <input value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value.replace(/\D/g, '').slice(0, 11) }))} inputMode="numeric" autoComplete="tel" aria-invalid={phoneInvalid} disabled={!runtime.session || runtime.busy} required />
            {phoneInvalid ? <span className="field-error" role="alert">请输入有效的 11 位手机号</span> : null}
          </label>
          <label className="field">省份<input value={draft.province} onChange={(event) => setDraft((current) => ({ ...current, province: event.target.value }))} maxLength={64} autoComplete="address-level1" disabled={!runtime.session || runtime.busy} required /></label>
          <label className="field">城市<input value={draft.city} onChange={(event) => setDraft((current) => ({ ...current, city: event.target.value }))} maxLength={64} autoComplete="address-level2" disabled={!runtime.session || runtime.busy} required /></label>
          <label className="field">区县<input value={draft.district} onChange={(event) => setDraft((current) => ({ ...current, district: event.target.value }))} maxLength={64} autoComplete="address-level3" disabled={!runtime.session || runtime.busy} required /></label>
          <label className="field">
            六位行政区代码
            <input value={draft.regionCode} onChange={(event) => setDraft((current) => ({ ...current, regionCode: event.target.value.replace(/\D/g, '').slice(0, 6) }))} inputMode="numeric" pattern="[0-9]{6}" aria-invalid={regionCodeInvalid} disabled={!runtime.session || runtime.busy} required />
            {regionCodeInvalid ? <span className="field-error" role="alert">请输入六位行政区代码</span> : null}
          </label>
        </div>
        <label className="field">详细地址<textarea value={draft.detailAddress} onChange={(event) => setDraft((current) => ({ ...current, detailAddress: event.target.value }))} rows={3} maxLength={300} autoComplete="street-address" disabled={!runtime.session || runtime.busy} required /></label>
        <label className="check-field"><input type="checkbox" checked={draft.isDefault} onChange={(event) => setDraft((current) => ({ ...current, isDefault: event.target.checked }))} disabled={!runtime.session || runtime.busy} /><span>设为默认地址</span></label>
        <button className="button button--primary" type="submit" disabled={runtime.busy || !canSave}><Save aria-hidden="true" size={18} /> {runtime.busy ? '正在保存' : '保存地址'}</button>
      </form>

      {!runtime.session ? <StatusNotice title="需要钱包登录">登录后只读写当前 BUYER 会话所有的加密地址。</StatusNotice> : null}
      {runtime.buyerAddressesState === 'loading' ? <div className="address-list-skeleton" aria-label="正在加载收货地址" /> : null}
      {runtime.session && runtime.buyerAddressesState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="地址同步失败" tone="warning">列表不使用本地缓存，409 版本冲突后必须重新同步。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadBuyerAccount()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.session && runtime.buyerAddressesState === 'empty' ? (
        <EmptyState title="暂无已保存地址">填写完整收货信息和六位行政区代码后保存。</EmptyState>
      ) : null}
      {runtime.buyerAddresses.length > 0 ? (
        <section className="saved-addresses" aria-labelledby="saved-address-title">
          <div className="section-heading"><h2 id="saved-address-title">已保存地址</h2><span>{runtime.buyerAddresses.length} 条</span></div>
          {runtime.buyerAddresses.map((address) => <SavedAddressRow key={address.addressId} address={address} />)}
        </section>
      ) : null}
    </div>
  );
}

function SavedAddressRow({ address }: { address: BuyerSavedAddress }) {
  const runtime = useMallRuntime();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState({
    label: address.label,
    recipientName: address.recipientName,
    phone: address.phone,
    province: address.province,
    city: address.city,
    district: address.district,
    regionCode: address.regionCode,
    detailAddress: address.detailAddress,
    isDefault: address.isDefault,
  });
  const phoneInvalid = !/^1[3-9][0-9]{9}$/.test(draft.phone);
  const canSave = Boolean(
    draft.label.trim()
    && draft.recipientName.trim()
    && !phoneInvalid
    && draft.province.trim()
    && draft.city.trim()
    && draft.district.trim()
    && /^[0-9]{6}$/.test(draft.regionCode)
    && draft.detailAddress.trim().length >= 5,
  );

  if (editing) {
    return (
      <form
        className="saved-address saved-address--editing"
        aria-label={`编辑${address.label}地址`}
        onSubmit={(event) => {
          event.preventDefault();
          void runtime.updateBuyerAddress(address.addressId, {
            ...draft,
            longitude: null,
            latitude: null,
          }).then((saved) => { if (saved) setEditing(false); });
        }}
      >
        <label className="field">标签<input value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} maxLength={32} /></label>
        <label className="field">收货人<input value={draft.recipientName} onChange={(event) => setDraft((current) => ({ ...current, recipientName: event.target.value }))} maxLength={64} autoComplete="name" /></label>
        <label className="field">
          手机号
          <input value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value.replace(/\D/g, '').slice(0, 11) }))} inputMode="numeric" autoComplete="tel" aria-invalid={phoneInvalid} />
          {phoneInvalid ? <span className="field-error" role="alert">请输入有效的 11 位手机号</span> : null}
        </label>
        <label className="field">省份<input value={draft.province} onChange={(event) => setDraft((current) => ({ ...current, province: event.target.value }))} maxLength={64} autoComplete="address-level1" /></label>
        <label className="field">城市<input value={draft.city} onChange={(event) => setDraft((current) => ({ ...current, city: event.target.value }))} maxLength={64} autoComplete="address-level2" /></label>
        <label className="field">区县<input value={draft.district} onChange={(event) => setDraft((current) => ({ ...current, district: event.target.value }))} maxLength={64} autoComplete="address-level3" /></label>
        <label className="field">六位行政区代码<input value={draft.regionCode} onChange={(event) => setDraft((current) => ({ ...current, regionCode: event.target.value.replace(/\D/g, '').slice(0, 6) }))} inputMode="numeric" pattern="[0-9]{6}" /></label>
        <label className="field">详细地址<textarea value={draft.detailAddress} onChange={(event) => setDraft((current) => ({ ...current, detailAddress: event.target.value }))} rows={3} maxLength={300} autoComplete="street-address" /></label>
        <label className="check-field"><input type="checkbox" checked={draft.isDefault} onChange={(event) => setDraft((current) => ({ ...current, isDefault: event.target.checked }))} /><span>设为默认地址</span></label>
        <div className="profile-form__actions">
          <button className="button button--secondary" type="button" onClick={() => setEditing(false)} disabled={runtime.busy}>取消</button>
          <button className="button button--primary" type="submit" disabled={runtime.busy || !canSave}><Save aria-hidden="true" size={18} /> 保存修改</button>
        </div>
      </form>
    );
  }

  return (
    <article className="saved-address">
      <header>
        <div><h3>{address.label}</h3><span>{address.isDefault ? '默认地址' : `v${address.version}`}</span></div>
        {address.isDefault ? <Star aria-label="当前默认地址" size={17} /> : null}
      </header>
      <p><strong>{address.recipientName}</strong> · {address.phone}</p>
      <p>{address.formattedAddress}</p>
      <small>{address.province} / {address.city} / {address.district} · {address.regionCode}</small>
      <div className="saved-address__actions">
        <button className="button button--primary" type="button" onClick={() => void runtime.selectSavedAddress(address.addressId)} disabled={runtime.busy}>用于下单</button>
        <button className="button button--secondary" type="button" onClick={() => setEditing(true)} disabled={runtime.busy}>编辑</button>
        {!address.isDefault ? (
          <button className="icon-button" type="button" aria-label={`将${address.label}设为默认地址`} onClick={() => void runtime.setDefaultBuyerAddress(address.addressId)} disabled={runtime.busy}><Star aria-hidden="true" size={18} /></button>
        ) : null}
        <button className="icon-button" type="button" aria-label={`删除${address.label}地址`} onClick={() => setConfirmDelete(true)} disabled={runtime.busy}><Trash2 aria-hidden="true" size={18} /></button>
      </div>
      {confirmDelete ? (
        <div className="saved-address__delete" role="alert">
          <span>确定删除这条地址？</span>
          <button type="button" onClick={() => setConfirmDelete(false)} disabled={runtime.busy}>取消</button>
          <button type="button" onClick={() => void runtime.deleteBuyerAddress(address.addressId)} disabled={runtime.busy}>确认删除</button>
        </div>
      ) : null}
    </article>
  );
}

export function OrdersScreen() {
  const runtime = useMallRuntime();
  const [active, setActive] = useState('全部');
  const tabs = ['全部', '待付款', '待发货', '待自提', '待收货', '售后 / 仲裁'];
  const visibleOrders = runtime.orders.filter((order) => orderMatchesTab(order, active));

  return (
    <div className="screen screen--detail">
      <ScreenHeader eyebrow="我的订单" title="我的订单" description="交付动作仅由允许操作开放" backTo="/assets" />
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
      <PaymentRecoveryForm />

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
          订单分组来自系统当前状态，不用本地时间推断。
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
              {...(runtime.takeoverTimelines[order.orderId] ? { takeoverTimeline: runtime.takeoverTimelines[order.orderId] } : {})}
              {...(runtime.takeoverTimelineErrors[order.orderId] ? { takeoverTimelineError: runtime.takeoverTimelineErrors[order.orderId] } : {})}
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
          {runtime.supportUrl ? (
            <a
              className="button button--secondary support-policy__action"
              href={runtime.supportUrl}
              {...(runtime.supportUrl.startsWith('https:') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              <Headphones aria-hidden="true" size={17} /> 联系客服
            </a>
          ) : <p className="field-error">{runtime.supportConfigurationError}</p>}
        </div>
      </section>
    </div>
  );
}

function PaymentRecoveryForm() {
  const runtime = useMallRuntime();
  const [orderId, setOrderId] = useState('');
  const [txHash, setTxHash] = useState('');
  const [replacementForTxHash, setReplacementForTxHash] = useState('');
  const canSubmit = Boolean(runtime.session && orderId.trim() && txHash.trim() && !runtime.busy);
  const usePending = () => {
    if (!runtime.pendingSubmission) return;
    setOrderId(runtime.pendingSubmission.orderId);
    setTxHash(runtime.pendingSubmission.txHash);
    setReplacementForTxHash(runtime.pendingSubmission.replacementForTxHash ?? '');
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    void runtime.recoverPaymentSubmission(orderId, txHash, replacementForTxHash || undefined);
  };
  return (
    <details className="payment-recovery">
      <summary>已经付款但订单没同步？</summary>
      <form onSubmit={submit}>
        <p>只在钱包已经显示付款成功，但商城没跟上时使用。没有付款不要填。</p>
        <label>
          订单号
          <input value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder="0x 开头订单号" autoComplete="off" spellCheck={false} />
        </label>
        <label>
          最新钱包交易编号
          <input value={txHash} onChange={(event) => setTxHash(event.target.value)} placeholder="钱包里复制的 0x 交易编号" autoComplete="off" spellCheck={false} />
        </label>
        <label>
          原交易编号（加速或替换过才填）
          <input value={replacementForTxHash} onChange={(event) => setReplacementForTxHash(event.target.value)} placeholder="没加速过可以不填" autoComplete="off" spellCheck={false} />
        </label>
        <div className="payment-recovery__actions">
          {runtime.pendingSubmission ? <button className="button button--secondary" type="button" onClick={usePending} disabled={runtime.busy}>填入当前待恢复订单</button> : null}
          <button className="button button--primary" type="submit" disabled={!canSubmit}>
            <RefreshCw aria-hidden="true" size={17} /> {runtime.busy ? '提交中' : '提交给系统确认'}
          </button>
        </div>
      </form>
    </details>
  );
}

function PaymentHashValue({ txHash }: { txHash: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const write = globalThis.navigator?.clipboard?.writeText(txHash);
    if (!write) return;
    void write.then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <span className="payment-hash-value">
      <code title={txHash}>{shortHash(txHash)}</code>
      <button type="button" className="text-button" onClick={copy}><Copy aria-hidden="true" size={14} />复制</button>
      {copied ? <small>已复制</small> : null}
    </span>
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
  takeoverTimeline,
  takeoverTimelineError,
}: {
  order: FulfillmentOrder;
  target?: FulfillmentTarget;
  actions: readonly AllowedAction[];
  capabilityError?: string;
  takeoverTimeline?: MallRuntimeValue['takeoverTimelines'][string];
  takeoverTimelineError?: string;
}) {
  const runtime = useMallRuntime();
  const logistics = order.logistics.at(-1);
  const shipment = order.shipments.at(-1);
  const buyerActions = actions.filter((action) => BUYER_FULFILLMENT_ACTIONS.includes(action.action));
  const [activeAction, setActiveAction] = useState<BuyerEvidenceAction | null>(null);
  return (
    <article className="order-row">
      <header className="order-row__header">
        <div>
          <p className="eyebrow">{orderKindLabel(order.orderKind)} · {order.fulfillmentMode === 'DELIVERY' ? '快递订单' : '到店自提'}</p>
          <h2>{shortHash(order.orderId)}</h2>
          {order.orderKind === 'SECKILL' ? <span className="status-pill order-kind-badge"><Zap aria-hidden="true" size={13} />秒杀</span> : null}
        </div>
        <div className="order-row__state">
          <span className="status-pill">{orderStateLabel(order.state, order.fulfillmentMode)}</span>
          <span>{finalityLabel(order.finalityStatus)}</span>
        </div>
      </header>

      <dl className="order-row__identity">
        <div><dt>商品</dt><dd title={order.productId}>{shortHash(order.productId)}</dd></div>
        <div><dt>规格</dt><dd title={order.skuId}>{shortHash(order.skuId)}</dd></div>
        <div><dt>数量</dt><dd>{order.quantity}</dd></div>
        <div><dt>创建时间</dt><dd>{formatIso(order.createdAt)}</dd></div>
        <div><dt>商品 USDT</dt><dd>{formatUsdtAmount(order.exactAmounts.productUsdtPaymentAmount)}</dd></div>
        <div><dt>平台服务费 USDT</dt><dd>{formatUsdtAmount(order.exactAmounts.platformServiceFeeUsdt)}</dd></div>
        <div><dt>商家货款 USDT</dt><dd>{formatUsdtAmount(order.exactAmounts.custodyProductUsdt)}</dd></div>
        <div><dt>运费 USDT</dt><dd>{formatUsdtAmount(order.exactAmounts.freightUsdt)}</dd></div>
        <div><dt>USDT 实付</dt><dd>{formatUsdtAmount(order.exactAmounts.usdtPaymentAmount)}</dd></div>
        <div><dt>NPL 支付</dt><dd>{formatNplAmount(order.exactAmounts.nplPaymentAmount)}</dd></div>
        <div className="order-row__tx"><dt>钱包付款</dt><dd>{order.paymentTxHash ? <PaymentHashValue txHash={order.paymentTxHash} /> : '尚未提交'}</dd></div>
        <div><dt>付款记录</dt><dd>{order.paidAt ? formatIso(order.paidAt) : '待付款'}</dd></div>
        <div><dt>付款最终确认</dt><dd>{order.paymentFinalizedAt ? formatIso(order.paymentFinalizedAt) : '确认中'}</dd></div>
      </dl>

      {target ? <OrderTarget target={target} /> : null}
      {order.fulfillmentMode === 'PICKUP' ? (
        <PickupCredentialPanel
          order={order}
          credential={runtime.pickupCredentials[order.orderId.toLowerCase()] ?? runtime.pickupCredentials[order.orderId]}
          credentialError={runtime.pickupCredentialErrors[order.orderId.toLowerCase()] ?? runtime.pickupCredentialErrors[order.orderId]}
          registerAction={actions.find((action) => action.action === 'REGISTER_PICKUP_CREDENTIAL')}
        />
      ) : null}
      <section className="order-row__section" aria-label="物流状态">
        <div className="section-heading section-heading--compact">
          <h3>物流</h3>
          <Truck aria-hidden="true" size={17} />
        </div>
        {shipment ? (
          <dl className="order-row__identity">
            <div><dt>快递公司</dt><dd>{carrierLabel(shipment.carrierCode)}</dd></div>
            <div><dt>运单号</dt><dd>{shipment.trackingNumber ?? '暂无运单号'}</dd></div>
            <div><dt>发货时间</dt><dd>{formatIso(shipment.createdAt)}</dd></div>
            {shipment.note ? <div><dt>发货备注</dt><dd>{shipment.note}</dd></div> : null}
            {logistics ? <div><dt>物流状态</dt><dd>{logisticsStatusLabel(logistics.status)} · {formatIso(logistics.occurredAt)}</dd></div> : null}
          </dl>
        ) : <p>尚无有效发货证据</p>}
      </section>

      <section className="order-row__section" aria-label="资产状态">
        <div className="section-heading section-heading--compact"><h3>订单资产</h3><Banknote aria-hidden="true" size={17} /></div>
        {order.balances.length > 0 ? (
          <div className="balance-list">
            {order.balances.map((balance, index) => (
              <div key={`${balance.asset}-${balance.state}-${index}`}>
                <span>{balance.asset === 'BNM_POINTS' ? 'BNM 后台积分' : balance.asset}</span>
                <strong>{formatAssetDisplayAmount(balance.amount, balance.asset)}</strong>
                <span>{balance.asset === 'BNM_POINTS' && !['LOCKED', 'AVAILABLE'].includes(balance.state) ? '状态待确认' : balanceStateLabel(balance.state)}</span>
              </div>
            ))}
          </div>
        ) : <p>系统暂未返回资产状态</p>}
        <p className="field-help">BNM 与收益只按系统确认的“锁定中 / 可用”状态展示；履约最终确认前不会提前显示到账。</p>
      </section>

      {order.requests.length > 0 ? (
        <section className="order-row__section" aria-label="履约申请">
          <div className="request-list">
            {order.requests.map((request) => (
              <div key={request.requestId}>
                <span>{requestTypeLabel(request.requestType)}</span>
                <strong>{requestStateLabel(request.state)}</strong>
                <time dateTime={request.requestedAt}>{formatIso(request.requestedAt)}</time>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="order-row__section takeover-timeline" aria-label="平台接管时间线">
        <div className="section-heading section-heading--compact"><h3>平台接管</h3><History aria-hidden="true" size={17} /></div>
        {takeoverTimelineError ? <p className="field-error" role="status">{takeoverTimelineError}</p> : null}
        {takeoverTimeline ? (
          <>
            <p className="takeover-timeline__status">
              历史完整性：<strong>{takeoverTimeline.historyStatus}</strong>
              {takeoverTimeline.historyStatus === 'PARTIAL_LEGACY' ? '（早期记录不完整）' : ''}
            </p>
            {takeoverTimeline.transitions.length > 0 ? (
              <ol>
                {takeoverTimeline.transitions.map((transition) => (
                  <li key={transition.transitionId}>
                    <span>{transition.fromState ?? '初始'} → <strong>{transition.toState}</strong></span>
                    <small>{transition.evidenceType} · {formatIso(transition.occurredAt)}</small>
                  </li>
                ))}
              </ol>
            ) : <p>当前订单没有公开接管转换记录。</p>}
          </>
        ) : !takeoverTimelineError ? <p>正在同步公开接管记录。</p> : null}
      </section>

      <section className="order-row__actions" aria-label="订单允许操作">
        <div className="section-heading section-heading--compact"><h3>可执行操作</h3><ShieldAlert aria-hidden="true" size={17} /></div>
        {capabilityError ? <p className="field-error" role="status">{capabilityError}</p> : null}
        {buyerActions.length > 0 ? (
          <div className="order-action-grid">
            {buyerActions.map((action) => {
              const supported = isBuyerEvidenceAction(action.action);
              const reason = action.enabled
                ? supported ? '系统已允许，可提交订单凭证' : unsupportedBuyerActionReason(action.action)
                : action.reasonCode ?? '系统当前不允许该操作';
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
        void onSubmit({ reasonCode: reasonCode.trim() || defaultBuyerActionReason(action), file }).then(setSubmitted);
      }}
    >
      <div className="order-evidence-form__header">
        <div>
          <p className="eyebrow">订单凭证</p>
          <h4>{actionLabel(action)}</h4>
        </div>
        <button className="icon-button" type="button" aria-label="关闭证据表单" onClick={onClose} disabled={busy}>
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <label className="field" htmlFor={`${fieldId}-reason`}>
        处理原因
        <input
          id={`${fieldId}-reason`}
          value={reasonCode}

          minLength={2}
          maxLength={64}
          pattern="[A-Z][A-Z0-9_]{1,63}"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="不填则自动生成"
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
        <button className="button button--primary" type="submit" disabled={busy}>
          <Send aria-hidden="true" size={17} /> {busy ? '提交中' : '封装证据并提交'}
        </button>
        <button className="button button--secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
      </div>
      {submitted ? <p className="evidence-success" role="status">操作已由系统接收，订单状态已重新同步。</p> : null}
    </form>
  );
}


function PickupCredentialPanel({
  order,
  credential,
  credentialError,
  registerAction,
}: {
  order: FulfillmentOrder;
  credential: PickupCredentialView | undefined;
  credentialError: string | undefined;
  registerAction: AllowedAction | undefined;
}) {
  const runtime = useMallRuntime();
  const [copied, setCopied] = useState<string | null>(null);
  const credentialRegistered = Boolean(credential?.credentialId && credential.phase !== 'REGISTERING');
  const credentialRegistering = credential?.phase === 'REGISTERING';
  const registeredCredential = credentialRegistered ? credential : undefined;
  const registeringCredential = credentialRegistering ? credential : undefined;
  const canRegister = order.state === 'PAID' && (registerAction?.enabled === true || credentialRegistering);
  const registerReason = registerAction?.enabled === false
    ? actionBlockReason(registerAction.reasonCode)
    : order.state !== 'PAID'
      ? '订单付款最终确认后才能生成。'
      : '系统当前没有开放新的核销码。';
  const copy = (label: string, value: string) => {
    const write = globalThis.navigator?.clipboard?.writeText(value);
    if (!write) return;
    void write.then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1600);
    });
  };

  return (
    <section className="order-row__section pickup-credential" aria-label="到店核销信息">
      <div className="section-heading section-heading--compact"><h3>到店核销信息</h3><KeyRound aria-hidden="true" size={17} /></div>
      {registeredCredential ? (
        <div className="pickup-credential__card">
          <span>给门店看的六位核销码</span>
          <strong className="pickup-credential__code" aria-label={`六位核销码 ${registeredCredential.code}`}>{registeredCredential.code}</strong>
          <div className="pickup-credential__actions">
            <button className="button button--secondary" type="button" onClick={() => copy('核销码', registeredCredential.code)}>
              <Copy aria-hidden="true" size={15} />复制核销码
            </button>
          </div>
          <dl>
            <div><dt>核销凭证编号</dt><dd><code>{registeredCredential.credentialId}</code></dd></div>
            <div><dt>有效期</dt><dd>{formatIso(registeredCredential.expiresAt)}</dd></div>
          </dl>
          <p>到店时把这 6 位数字给商家。凭证编号只给客服或平台核对，商家核销不需要你手填。</p>
        </div>
      ) : registeringCredential ? (
        <div className="pickup-credential__card pickup-credential__card--pending">
          <span>核销码正在同步</span>
          <strong>还不能给门店核销</strong>
          <p>本机已保存本次生成信息，但系统还没确认成功。请点下面按钮继续同步；成功后才会显示 6 位核销码。</p>
          <button className="button button--primary" type="button" disabled={runtime.busy} onClick={() => void runtime.createPickupCredential(order.orderId)}>
            <KeyRound aria-hidden="true" size={17} />{runtime.busy ? '正在同步' : '继续同步核销码'}
          </button>
          {credentialError ? <p className="field-error" role="status">{credentialError}</p> : null}
          <dl>
            <div><dt>有效期</dt><dd>{formatIso(registeringCredential.expiresAt)}</dd></div>
          </dl>
        </div>
      ) : (
        <div className="pickup-credential__empty">
          <p>还没有生成六位核销码。</p>
          {canRegister ? (
            <button className="button button--primary" type="button" disabled={runtime.busy} onClick={() => void runtime.createPickupCredential(order.orderId)}>
              <KeyRound aria-hidden="true" size={17} />{runtime.busy ? '正在生成' : '生成到店核销码'}
            </button>
          ) : <p className="field-help">{registerReason}</p>}
          {credentialError ? <p className="field-error" role="status">{credentialError}</p> : null}
          {order.state === 'PAID' && !canRegister ? <p className="field-help">如果你已经在别的手机生成过，请用原手机出示；本机没有保存时页面无法找回六位数字。</p> : null}
        </div>
      )}
      {copied ? <p className="evidence-success" role="status">已复制{copied}</p> : null}
    </section>
  );
}

function actionBlockReason(reason?: string) {
  if (reason === 'FinalityPending') return '系统还在确认付款，稍后刷新再试。';
  if (reason === 'BreakerActive') return '系统暂时关闭了新核销码生成。';
  if (reason === 'Forbidden') return '当前钱包没有权限生成。';
  return '系统当前不允许生成新的核销码。';
}

function OrderTarget({ target }: { target: FulfillmentTarget }) {
  return (
    <section className="order-row__section order-target" aria-label="履约目标">
      <MapPinned aria-hidden="true" size={18} />
      <div>
        <h3>{target.fulfillmentMode === 'DELIVERY' ? target.payload.recipientName : target.payload.name}</h3>
        <p>{target.fulfillmentMode === 'DELIVERY' ? `${target.payload.phone} · ${target.payload.address}` : target.payload.address}</p>
        <details className="technical-disclosure technical-disclosure--compact"><summary>地址核验信息</summary><span>行政区 {target.regionCode} · 快照 {shortHash(target.targetHash)}</span></details>
      </div>
    </section>
  );
}

export function ActivityScreen() {
  const runtime = useMallRuntime();
  const [active, setActive] = useState<'seckill' | 'shopping'>('seckill');

  return (
    <div className="screen screen--detail">
      <ScreenHeader eyebrow="购物记录" title="行为追踪" description="每笔消费与资产状态逐单对应" backTo="/assets" />
      <div className="segmented-control segmented-control--two" role="tablist" aria-label="行为类型">
        <button role="tab" aria-selected={active === 'seckill'} className={active === 'seckill' ? 'is-active' : ''} onClick={() => setActive('seckill')} type="button">
          <Zap aria-hidden="true" size={17} /> 秒杀参与
        </button>
        <button role="tab" aria-selected={active === 'shopping'} className={active === 'shopping' ? 'is-active' : ''} onClick={() => setActive('shopping')} type="button">
          <ShoppingBag aria-hidden="true" size={17} /> 消费购物
        </button>
      </div>

      {active === 'seckill' ? (
        <SeckillActivityContent runtime={runtime} />
      ) : <ShoppingStatementContent runtime={runtime} />}
    </div>
  );
}

function SeckillActivityContent({ runtime }: { runtime: MallRuntimeValue }) {
  const sessions = [runtime.seckillSession, ...runtime.seckillHistory]
    .filter((session): session is PublishedSeckillSessionProjection => Boolean(session))
    .filter((session, index, items) => items.findIndex((item) => item.sessionId === session.sessionId) === index);
  if (runtime.seckillSessionState === 'loading' && sessions.length === 0) {
    return <p className="loading-copy" role="status">正在同步秒杀奖项记录…</p>;
  }
  if (runtime.seckillSessionState === 'error' && sessions.length === 0) {
    return <StatusNotice title="秒杀奖项同步失败" tone="warning">不展示缓存的候选人、奖金或奖金付款状态。</StatusNotice>;
  }
  const prizeSessions = sessions.filter((session) => session.prizeSettlement !== null);
  if (prizeSessions.length === 0) {
    return <EmptyState title="暂无奖项结算记录">系统暂未发布候选审核、滚入下期或付款结果。</EmptyState>;
  }
  return (
    <div className="shopping-statement-list" aria-label="秒杀奖项记录">
      {prizeSessions.map((session) => (
        <article className="shopping-statement" key={session.sessionId}>
          <header className="shopping-statement__header">
            <div><p className="eyebrow">{session.product.title}</p><h2>{shortHash(session.sessionId)}</h2></div>
            <SeckillPhasePill phase={session.phase} />
          </header>
          <SeckillPrizeOutcome
            session={session}
            {...(runtime.session ? { viewerWallet: runtime.session.walletAddress } : {})}
          />
        </article>
      ))}
    </div>
  );
}

function SeckillPrizeOutcome({
  session,
  viewerWallet,
  compact = false,
  publicView = false,
}: {
  session: PublishedSeckillSessionProjection;
  viewerWallet?: string;
  compact?: boolean;
  publicView?: boolean;
}) {
  const prize = session.prizeSettlement;
  if (!prize) return null;
  const candidateIsViewer = Boolean(viewerWallet && prize.candidate
    && prize.candidate.buyerWallet.toLowerCase() === viewerWallet.toLowerCase());
  const winnerIsViewer = Boolean(viewerWallet && session.winnerWallet
    && session.winnerWallet.toLowerCase() === viewerWallet.toLowerCase());
  if (publicView) {
    return (
      <section className={`seckill-prize-outcome${compact ? ' seckill-prize-outcome--compact' : ''}`}>
        <div className="section-heading section-heading--compact">
          <h3>大奖结果</h3>
          <span className="status-pill">{seckillPrizeStateLabel(prize.state)}</span>
        </div>
        <dl className="seckill-facts seckill-facts--public-prize">
          <div><dt>奖池金额</dt><dd>{formatUsdtAmount(prize.poolAmountUsdt)}</dd></div>
          <div><dt>候选状态</dt><dd>{candidateIsViewer ? '你是候选用户' : prize.candidate ? '已有候选用户' : '暂无候选'}</dd></div>
          <div><dt>最终结果</dt><dd>{winnerIsViewer ? '你已中奖' : session.winnerWallet ? '已确认' : '待公布'}</dd></div>
          <div><dt>奖励发放</dt><dd>{prize.payout ? seckillPayoutStateLabel(prize.payout.state) : '等待结算'}</dd></div>
        </dl>
        {candidateIsViewer && prize.state === 'REVIEW_PENDING' ? <p className="field-help">你是当前候选用户，正在等待审核。</p> : null}
        {winnerIsViewer ? <p className="field-help">你是本场已确认赢家。</p> : null}
      </section>
    );
  }
  return (
    <section className={`seckill-prize-outcome${compact ? ' seckill-prize-outcome--compact' : ''}`}>
      <div className="section-heading section-heading--compact">
        <h3>大奖结算</h3>
        <span className="status-pill">{seckillPrizeStateLabel(prize.state)}</span>
      </div>
      {candidateIsViewer && prize.state === 'REVIEW_PENDING' ? <p className="field-help">当前钱包是唯一冻结候选人，正在等待有效性审核。</p> : null}
      {winnerIsViewer ? <p className="field-help">当前钱包是已审核通过的唯一赢家。</p> : null}
      <dl className="seckill-publication" aria-label="秒杀大奖结算证据">
        <div><dt>候选截止时间</dt><dd><time dateTime={prize.cutoffAt}>{prize.cutoffAt}</time></dd></div>
        <div><dt>奖池快照</dt><dd>{formatUsdtAmount(prize.poolAmountUsdt)}</dd></div>
        <details className="technical-disclosure technical-disclosure--compact"><summary>奖池核验信息</summary><div><dt>快照凭证</dt><dd><code title={prize.poolSnapshotHash}>{shortHash(prize.poolSnapshotHash)}</code></dd></div></details>
        {prize.candidate ? <>
          <div><dt>候选订单</dt><dd><code title={prize.candidate.orderId}>{shortHash(prize.candidate.orderId)}</code></dd></div>
          <div><dt>候选钱包</dt><dd>{shortAddress(prize.candidate.buyerWallet)}</dd></div>
          <details className="technical-disclosure technical-disclosure--compact"><summary>候选确认位置</summary><div><dt>确认位置</dt><dd>区块 {prize.candidate.blockNumber} · 记录 {prize.candidate.logIndex}</dd></div></details>
        </> : null}
        {prize.review ? <>
          <div><dt>有效性审核</dt><dd>{prize.review.decision === 'APPROVED' ? '已通过' : '已驳回'} · {seckillPrizeReviewReasonLabel(prize.review.reasonCode)}<details className="technical-disclosure technical-disclosure--compact"><summary>审核原因编号</summary><code>{prize.review.reasonCode}</code></details></dd></div>
          <div><dt>审核钱包</dt><dd>{shortAddress(prize.review.reviewedBy)}</dd></div>
          <div><dt>审核时间</dt><dd><time dateTime={prize.review.reviewedAt}>{prize.review.reviewedAt}</time></dd></div>
        </> : null}
        {prize.rolloverTargetSessionId ? <div><dt>滚入场次</dt><dd><code title={prize.rolloverTargetSessionId}>{shortHash(prize.rolloverTargetSessionId)}</code></dd></div> : null}
        {prize.rolloverJournalId ? <div><dt>滚池记录</dt><dd><code title={prize.rolloverJournalId}>{shortHash(prize.rolloverJournalId)}</code></dd></div> : null}
        {prize.payout ? <>
          <div><dt>奖金付款</dt><dd>{seckillPayoutStateLabel(prize.payout.state)}</dd></div>
          {prize.payout.requestId ? <div><dt>结算申请</dt><dd><code title={prize.payout.requestId}>{shortHash(prize.payout.requestId)}</code></dd></div> : null}
          {prize.payout.transferIds.map((transferId) => (
            <div key={transferId}><dt>转账记录</dt><dd><code title={transferId}>{shortHash(transferId)}</code></dd></div>
          ))}
          {prize.payout.finalExecutionTxHashes.map((txHash) => (
            <div key={txHash}><dt>客服核验编号</dt><dd><code title={txHash}>{shortHash(txHash)}</code></dd></div>
          ))}
        </> : null}
      </dl>
    </section>
  );
}

function ShoppingStatementContent({ runtime }: { runtime: MallRuntimeValue }) {
  if (!runtime.session) {
    return (
      <EmptyState title="连接买家钱包后查看">
        购物记录仅向当前买家钱包开放，未连接钱包时不请求或展示订单数据。
      </EmptyState>
    );
  }
  if (runtime.shoppingStatementsState === 'idle' || (
    runtime.shoppingStatementsState === 'loading' && runtime.shoppingStatements.length === 0
  )) return <ShoppingStatementSkeleton />;
  if (runtime.shoppingStatementsState === 'error') {
    return (
      <section className="activity-error" role="alert">
        <ShieldAlert aria-hidden="true" size={24} />
        <div>
          <h2>购物记录读取失败</h2>
          <p>{runtime.shoppingStatementsError ?? '当前会话未取得买家记录访问权限。'}</p>
        </div>
        <button className="button button--secondary" type="button" disabled={runtime.busy} onClick={() => void runtime.reloadShoppingStatements()}>
          <RefreshCw aria-hidden="true" size={17} /> {runtime.busy ? '重新同步中' : '重新同步'}
        </button>
      </section>
    );
  }
  if (runtime.shoppingStatementsState === 'empty') {
    return (
      <EmptyState title="暂无购物记录">
        当前买家钱包没有最终确认确认的普通或边界转日常订单。
      </EmptyState>
    );
  }
  return (
    <>
      {runtime.shoppingStatementsError ? (
        <div className="activity-page-error" role="alert">{runtime.shoppingStatementsError}</div>
      ) : null}
      <div className="shopping-statement-list" aria-label="消费购物记录">
        {runtime.shoppingStatements.map((statement) => (
          <ShoppingStatementRow key={statement.orderId} statement={statement} />
        ))}
      </div>
      {runtime.shoppingStatementsNextCursor ? (
        <button
          className="button button--secondary order-load-more"
          type="button"
          disabled={runtime.shoppingStatementsLoadingMore}
          onClick={() => void runtime.loadMoreShoppingStatements()}
        >
          <RefreshCw aria-hidden="true" size={17} />
          {runtime.shoppingStatementsLoadingMore ? '正在读取下一页' : '加载下一页'}
        </button>
      ) : null}
    </>
  );
}

function ShoppingStatementRow({ statement }: { statement: MallRuntimeValue['shoppingStatements'][number] }) {
  return (
    <article className="shopping-statement">
      <header className="shopping-statement__header">
        <div>
          <p className="eyebrow">{orderKindLabel(statement.orderKind)}订单</p>
          <h2>{shortHash(statement.orderId)}</h2>
        </div>
        <span className="status-pill">{orderStateLabel(statement.orderState)}</span>
      </header>
      <dl className="shopping-statement__facts">
        <div><dt>商品</dt><dd title={statement.productId}>{shortHash(statement.productId)}</dd></div>
        <div><dt>规格</dt><dd title={statement.skuId}>{shortHash(statement.skuId)}</dd></div>
        <div><dt>数量</dt><dd>{statement.quantity}</dd></div>
        <div><dt>BNM 状态</dt><dd>{statement.bnm.state === 'LOCKED' ? '已锁定' : '可用'}</dd></div>
        <div><dt>商品 USDT</dt><dd>{formatUsdtAmount(statement.paymentAmounts.productUsdtPaymentAmount)}</dd></div>
        <div><dt>平台服务费 USDT</dt><dd>{formatUsdtAmount(statement.paymentAmounts.platformServiceFeeUsdt)}</dd></div>
        <div><dt>商家货款 USDT</dt><dd>{formatUsdtAmount(statement.paymentAmounts.custodyProductUsdt)}</dd></div>
        <div><dt>运费 USDT</dt><dd>{formatUsdtAmount(statement.paymentAmounts.freightUsdt)}</dd></div>
        <div><dt>USDT 实付</dt><dd>{formatUsdtAmount(statement.paymentAmounts.usdtPaymentAmount)}</dd></div>
        <div><dt>NPL 实付</dt><dd>{formatNplAmount(statement.paymentAmounts.nplPaymentAmount)}</dd></div>
        <div><dt>BNM 后台积分</dt><dd>{formatBnmAmount(statement.bnm.amount)}</dd></div>
        <div><dt>下单时间</dt><dd><time dateTime={statement.createdAt}>{statement.createdAt}</time></dd></div>
        <div><dt>付款最终确认</dt><dd><time dateTime={statement.paymentFinalizedAt}>{statement.paymentFinalizedAt}</time></dd></div>
        <div><dt>履约最终时间</dt><dd>{statement.fulfilledAt ? <time dateTime={statement.fulfilledAt}>{statement.fulfilledAt}</time> : '尚未最终履约'}</dd></div>
        <div className="shopping-statement__wide"><dt>订单</dt><dd>系统已记录</dd></div>
        <div className="shopping-statement__wide"><dt>钱包付款</dt><dd>已确认</dd></div>
      </dl>
      <section className="shopping-statement__journals" aria-label="BNM 账本来源">
        <div className="section-heading section-heading--compact"><h3>BNM 来源记录</h3><FileClock aria-hidden="true" size={17} /></div>
        <ul>
          {statement.bnm.journalIds.map((journalId) => <li key={journalId}><code title={journalId}>{shortHash(journalId)}</code></li>)}
        </ul>
      </section>
    </article>
  );
}

function ShoppingStatementSkeleton() {
  return (
    <div className="shopping-statement-list" aria-label="正在加载购物记录">
      {[0, 1].map((item) => <div className="shopping-statement shopping-statement--skeleton" key={item} />)}
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
      <ScreenHeader eyebrow="收益对账" title="收益对账" description="查看 BNM、NPL 收益和秒杀奖金状态" backTo="/assets" />

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
                <span>{state === 'LOCKED' ? '锁定中' : '可用'}</span>
                <strong>{formatBnmAmount(balance?.amount)}</strong>
                <span>BNM</span>
              </div>
              );
            })}
          </div>
        ) : <p className="section-copy">当前钱包暂无 BNM 汇总。</p>}
        {bnmOrderBalances.length > 0 ? (
          <details className="bnm-provenance">
            <summary>查看订单来源</summary>
            <div className="balance-list" aria-label="BNM 订单明细">
            {bnmOrderBalances.map((balance) => (
              <div key={`${balance.orderId}-${balance.state}`}>
                <span>订单 {shortHash(balance.orderId)}</span>
                <strong>{formatBnmAmount(balance.amount)}</strong>
                <span>{balanceStateLabel(balance.state)}</span>
              </div>
            ))}
            </div>
          </details>
        ) : null}
        <p className="field-help"><FileClock aria-hidden="true" size={15} /> BNM 只有“锁定中 / 可用”两种状态，不是代币，也不进入链上结算。</p>
        <Link className="text-link" to="/assets/orders">查看订单与履约来源 <ChevronRight aria-hidden="true" size={15} /></Link>
      </section>

      {!runtime.session ? <StatusNotice title="请先验证钱包">连接钱包后同步该钱包的收益、申请和最终确认状态。</StatusNotice> : null}
      {runtime.settlementsState === 'loading' ? <p className="loading-copy" role="status">正在同步收益账本…</p> : null}
      {runtime.settlementsState === 'error' ? (
        <div className="catalog-retry">
          <StatusNotice title="收益账本同步失败" tone="warning">不会展示缓存金额或伪造可申请状态。</StatusNotice>
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

      <StatusNotice title="签名申请，平台打款">
        可用收益由钱包签名申请，平台逐笔打款并承担手续费；只有达到 15 次确认才表示已到账。
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
  const states = ['LOCKED', 'AVAILABLE', 'REQUESTED', 'SUBMITTED', 'SETTLED'] as const;
  return (
    <section className="reward-rail" aria-labelledby={`${rail}-title`}>
      <div className="reward-rail__header">
        <div className="reward-rail__icon"><Banknote aria-hidden="true" size={22} /></div>
        <div>
          <p className="eyebrow">{rail === 'REWARD_NPL' ? 'NPL 收益' : '秒杀奖金'}</p>
          <h2 id={`${rail}-title`}>{rail === 'REWARD_NPL' ? 'NPL 收益' : '秒杀 USDT 奖金'}</h2>
        </div>
        <span className="status-pill">系统账本</span>
      </div>
      <dl className="settlement-lifecycle" aria-label="结算生命周期金额">
        {states.map((state) => {
          const balance = railBalances.find((item) => item.state === state);
          return <div key={state}><dt>{settlementStateLabel(state)}</dt><dd>{balance ? formatAssetDisplayAmount(balance.amount, balance.asset) : '--'}</dd></div>;
        })}
      </dl>
      {rail === 'REWARD_NPL' ? <RewardSubtypeBreakdown balances={railBalances} /> : null}
      {available ? (
        <button className="button button--primary" type="button" onClick={() => onRequest(available.amount)} disabled={busy}>
          <WalletCards aria-hidden="true" size={18} /> 签名申请结算 {formatAssetDisplayAmount(available.amount, available.asset)}
        </button>
      ) : <p className="field-help">只有系统标记为“可用”的金额才能创建签名结算申请。</p>}
      {railRequests.length > 0 ? (
        <div className="settlement-request-list" aria-label="结算申请记录">
          {railRequests.map((request) => (
            <article key={request.request_id}>
              <div><strong>{settlementStateLabel(request.state)}</strong><span>{formatAssetDisplayAmount(request.amount, request.asset)}</span></div>
              <p>申请 {shortHash(request.request_id)}{request.transfer_ids.length > 0
                ? ` · 转账 ${request.transfer_ids.map(shortHash).join('、')}`
                : ''}</p>
              {request.final_execution_tx_hashes.length > 0 ? request.final_execution_tx_hashes.map((txHash) => (
                <p className="safe-hash" key={txHash}><span>客服核验编号</span><code title={txHash}>{shortHash(txHash)}</code></p>
              )) : <p>平台打款还在确认中，到账后会自动更新。</p>}
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
              <span key={`${subtype}-${balance.state}`}>{settlementStateLabel(balance.state)} {formatNplAmount(balance.amount)}</span>
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
      <ScreenHeader eyebrow="通知中心" title="通知中心" description="订单、BNM 与到账消息" backTo="/assets" />
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
          <StatusNotice title="通知同步失败" tone="warning">不会使用本地示例消息替代系统通知。</StatusNotice>
          <button className="button button--secondary" type="button" onClick={() => void runtime.reloadNotifications()} disabled={runtime.busy}>
            <RefreshCw aria-hidden="true" size={18} /> 重新同步
          </button>
        </div>
      ) : null}
      {runtime.notificationsState === 'empty' ? <EmptyState title="暂无通知">新消息会按当前钱包和主题投递。</EmptyState> : null}
      {runtime.notificationsState === 'ready' ? (
        <div className="notification-list" aria-label="通知列表">
          {runtime.notifications.map((item) => (
            <article key={item.messageId}>
              <div className="notification-list__header">
                <div><p className="eyebrow">{notificationTopicLabel(item.topic)}</p><h2>{notificationTitle(item)}</h2></div>
                <span className="status-pill">{notificationStateLabel(item.deliveryState)}</span>
              </div>
              {notificationTemplateRows(item.templateData).map(([key, label, value]) => <p key={key}><span>{label}</span><strong>{value}</strong></p>)}
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
  const navigate = useNavigate();
  const product = runtime.selectedProduct;
  const sku = runtime.selectedSku;
  const quantityLimit = checkoutQuantityLimit(runtime);
  const quantityWithinLimit = Boolean(sku) && BigInt(runtime.quantity) <= quantityLimit;
  const canQuote = Boolean(
    runtime.session
      && runtime.bootstrap?.writesEnabled
      && product
      && sku
      && quantityWithinLimit
      && product.fulfillmentModes.includes(runtime.fulfillmentMode)
      && (!sku.seckill || Boolean(runtime.selectedSeckillSessionId))
      && runtime.checkoutTarget?.fulfillmentMode === runtime.fulfillmentMode
      && (!runtime.selectedSeckillSessionId
        || (runtime.seckillSession?.sessionId === runtime.selectedSeckillSessionId
          && runtime.seckillSession.phase === 'LIVE'
          && quantityLimit >= BigInt(runtime.quantity)))
      && !runtime.busy,
  );

  return (
    <div className="screen screen--detail screen--checkout">
      <ScreenHeader
        eyebrow={runtime.selectedSeckillSessionId ? '秒杀下单' : '普通下单'}
        title={runtime.selectedSeckillSessionId ? '秒杀订单配置' : '订单配置'}
        description="规格、数量与履约方式需完整确认"
        backTo={runtime.selectedSeckillSessionId ? '/seckill' : product ? `/products/${encodeURIComponent(product.productId)}` : '/mall'}
      />

      {runtime.selectedSeckillSessionId && runtime.seckillSession ? (
        <StatusNotice title="已绑定权威秒杀场次">
          {shortHash(runtime.seckillSession.sessionId)} · {formatUsdtAmount(runtime.seckillSession.product.seckillListPriceUsdt)}；是否命中秒杀以你的钱包付款上链时间为准。
        </StatusNotice>
      ) : null}

      {!product ? (
        <StatusNotice title="请先选择商品" tone="warning">返回商城选择可售商品，当前页面不会补入示例规格。</StatusNotice>
      ) : null}
      {product && !runtime.session ? (
        <StatusNotice title="需要钱包登录">连接钱包后，系统才能为当前买家预留库存。</StatusNotice>
      ) : null}

      <CheckoutFlow
        fulfillmentReady={Boolean(product?.fulfillmentModes.includes(runtime.fulfillmentMode))}
        quoteReady={Boolean(runtime.quote)}
        quantityReady={quantityWithinLimit}
        skuReady={Boolean(sku)}
        targetReady={Boolean(runtime.checkoutTarget?.fulfillmentMode === runtime.fulfillmentMode)}
      />

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
          系统当前阻止新支付，暂不创建新报价。
        </StatusNotice>
      ) : null}

      {product ? (
        <section className="section-block product-core-detail" aria-labelledby="product-core-detail-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">商品信息</p>
              <h2 id="product-core-detail-title">{product.title}</h2>
            </div>
            <ShoppingBag aria-hidden="true" size={19} />
          </div>
          {product.subtitle ? <p className="product-core-detail__subtitle">{product.subtitle}</p> : null}
          {richDetailText(product.richDetail) ? <p>{richDetailText(product.richDetail)}</p> : null}
          <dl className="product-core-detail__facts">
            <div><dt>默认运费</dt><dd>{formatUsdtAmount(product.defaultFreightUsdt)}</dd></div>
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
                <span>{item.seckill ? `${seckillOverlayLabel(item.seckill.phase)} · 活动价 ${formatUsdtAmount(item.seckill.seckillListPriceUsdt)}` : `标价 ${formatUsdtAmount(item.listPriceUsdt)}`} · 库存 {item.seckill?.inventory.available ?? item.stockAvailable}</span>
              </button>
            ))}
          </div>
        ) : <div className="selection-placeholder">规格选项将随商品目录同步</div>}
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

      <section className="section-block" aria-labelledby="quantity-title">
        <div className="section-heading"><h2 id="quantity-title">购买数量</h2><span className="muted-label">最后确认数量</span></div>
        <div className="stepper" aria-label="购买数量">
          <button type="button" disabled={runtime.busy || Boolean(runtime.pendingSubmission) || !sku || runtime.quantity <= 1} onClick={() => runtime.setQuantity(runtime.quantity - 1)} aria-label="减少数量"><Minus aria-hidden="true" size={18} /></button>
          <output aria-label="当前数量">{runtime.quantity}</output>
          <button
            type="button"
            disabled={runtime.busy || Boolean(runtime.pendingSubmission) || !sku || BigInt(runtime.quantity) >= quantityLimit}
            onClick={() => runtime.setQuantity(runtime.quantity + 1)}
            aria-label="增加数量"
          ><Plus aria-hidden="true" size={18} /></button>
        </div>
      </section>

      <div className="checkout-total">
        <span>系统报价</span>
        <strong>{runtime.quote ? formatUsdtAmount(primaryIntent(runtime.quote).listPriceUsdt) : '--'}</strong>
      </div>
      <button
        className="button button--primary"
        type="button"
        disabled={!canQuote}
        onClick={() => void createQuoteAndReview()}
      >
        {quoteButtonLabel(runtime)}
      </button>
      {!canQuote ? <p className="control-reason">{quoteDisabledReason(runtime)}</p> : null}
      {runtime.quote ? (
        <section className="reservation-summary" aria-labelledby="reservation-title">
          <div><p className="eyebrow">库存预留</p><h2 id="reservation-title">库存已预留</h2></div>
          <dl>
            <div><dt>状态</dt><dd>库存已为你保留</dd></div>
            <div><dt>有效期</dt><dd>{formatTimestamp(primaryIntent(runtime.quote).deadline)}</dd></div>
          </dl>
          <Link className="button button--primary" to="/checkout/review">核对报价 <ChevronRight aria-hidden="true" size={17} /></Link>
        </section>
      ) : null}
    </div>
  );

  async function createQuoteAndReview() {
    const ok = runtime.selectedSeckillSessionId
      ? await runtime.requestSeckillQuote(runtime.selectedSeckillSessionId)
      : await runtime.requestOrdinaryQuote();
    if (ok) navigate('/checkout/review');
  }
}

function CheckoutFlow({
  fulfillmentReady,
  quantityReady,
  quoteReady,
  skuReady,
  targetReady,
}: {
  fulfillmentReady: boolean;
  quantityReady: boolean;
  quoteReady: boolean;
  skuReady: boolean;
  targetReady: boolean;
}) {
  const steps = [
    { label: '规格', ready: skuReady },
    { label: '履约', ready: fulfillmentReady },
    { label: '地址/门店', ready: targetReady },
    { label: '数量', ready: quantityReady },
    { label: '报价', ready: quoteReady },
  ];
  return (
    <section className="checkout-flow" aria-label="下单步骤">
      {steps.map((step, index) => (
        <div className={step.ready ? 'checkout-flow__step is-done' : 'checkout-flow__step'} key={step.label}>
          <span>{index + 1}</span>
          <strong>{step.label}</strong>
        </div>
      ))}
    </section>
  );
}

function CheckoutTargetSelector() {
  const runtime = useMallRuntime();
  const addresses = [...runtime.buyerAddresses].sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
  const pickupStoreScopeReady = runtime.fulfillmentMode !== 'PICKUP'
    || !runtime.selectedProduct
    || runtime.storesScope.productId === runtime.selectedProduct.productId;
  const pickupStores = runtime.storesState === 'ready' && pickupStoreScopeReady ? runtime.stores : [];

  useEffect(() => {
    if (
      runtime.fulfillmentMode !== 'PICKUP'
      || !runtime.selectedProduct
      || runtime.storesScope.productId === runtime.selectedProduct.productId
      || runtime.storesState === 'loading'
    ) return;
    void runtime.reloadStores(undefined, runtime.selectedProduct.productId);
  }, [runtime.fulfillmentMode, runtime.selectedProduct?.productId, runtime.storesScope.productId, runtime.storesState]);

  return (
    <section className="checkout-target" aria-labelledby="checkout-target-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">收货信息</p>
          <h2 id="checkout-target-title">{runtime.fulfillmentMode === 'DELIVERY' ? '快递目标' : '自提门店'}</h2>
        </div>
        {runtime.fulfillmentMode === 'DELIVERY' ? <MapPinned aria-hidden="true" size={19} /> : <Store aria-hidden="true" size={19} />}
      </div>

      {runtime.fulfillmentMode === 'DELIVERY' ? (
        <div className="delivery-options">
          {!runtime.session ? <StatusNotice title="需要钱包登录">登录后只读取当前 BUYER 会话的加密地址簿。</StatusNotice> : null}
          {runtime.session && runtime.buyerAddressesState === 'loading' ? <div className="address-list-skeleton" aria-label="正在加载结算地址" /> : null}
          {runtime.session && runtime.buyerAddressesState === 'error' ? (
            <div className="catalog-retry">
              <StatusNotice title="地址同步失败" tone="warning">不使用浏览器输入或缓存地址替代系统地址簿。</StatusNotice>
              <button className="button button--secondary" type="button" onClick={() => void runtime.reloadBuyerAccount()} disabled={runtime.busy}><RefreshCw aria-hidden="true" size={18} /> 重新同步</button>
            </div>
          ) : null}
          {runtime.session && runtime.buyerAddressesState === 'empty' ? <EmptyState title="暂无已保存地址">请先到地址簿完成解析、复核和保存，再返回创建快递订单。</EmptyState> : null}
          {addresses.map((savedAddress) => {
            const active = runtime.checkoutTarget?.review.kind === 'DELIVERY'
              && runtime.checkoutTarget.review.address.addressId === savedAddress.addressId;
            return (
              <article className={active ? 'delivery-option is-active' : 'delivery-option'} key={savedAddress.addressId}>
                <div className="delivery-option__heading"><strong>{savedAddress.label}</strong>{savedAddress.isDefault ? <span>默认地址</span> : null}</div>
                <p>{savedAddress.recipientName} · {savedAddress.phone}</p>
                <p>{savedAddress.formattedAddress}</p>
                <small>{savedAddress.province} / {savedAddress.city} / {savedAddress.district} · {savedAddress.regionCode}</small>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={runtime.busy || active}
                  onClick={() => void runtime.selectSavedAddress(savedAddress.addressId)}
                >
                  {active ? '已选择' : savedAddress.isDefault ? '使用默认地址' : '使用这个地址'}
                </button>
              </article>
            );
          })}
          <Link className="button button--secondary" to="/assets/addresses" state={{ returnTo: '/checkout' }}><MapPinned aria-hidden="true" size={18} /> 管理收货地址</Link>
        </div>
      ) : (
        <div className="pickup-options">
          {runtime.storesState === 'loading' || !pickupStoreScopeReady ? <StoreListSkeleton /> : null}
          {pickupStoreScopeReady && runtime.storesState === 'empty' ? <p className="section-copy">该商家暂无可用自提门店，请选择快递或联系商家。</p> : null}
          {pickupStoreScopeReady && runtime.storesState === 'error' ? <p className="field-error">门店列表读取失败，无法创建自提目标。</p> : null}
          {pickupStores.map((store) => (
            <article className="pickup-option" key={store.storeId}>
              <StoreMediaGallery store={store} compact />
              <div className="pickup-option__selection">
                <span>
                  <strong>{store.name}</strong>
                  <small>{store.address}</small>
                  <small>营业时间：{store.businessHours}</small>
                </span>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-label={`选择 ${store.name}`}
                  disabled={!runtime.session || runtime.busy}
                  onClick={() => void runtime.createPickupTarget(store.storeId)}
                >
                  选择 <ChevronRight aria-hidden="true" size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {runtime.checkoutTarget?.fulfillmentMode === runtime.fulfillmentMode ? (
        <div className="fulfillment-preview" aria-live="polite">
          <BadgeCheck aria-hidden="true" size={22} />
          <div>
            <h2>收货信息已验证</h2>
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
    { icon: Package, label: '商品与最终规格', value: runtime.selectedProduct && runtime.selectedSku ? `${runtime.selectedProduct.title} · ${skuLabel(runtime.selectedSku.attributes, runtime.selectedSku.skuId)}` : '待预留' },
    { icon: ScanLine, label: '数量与总价', value: intent ? `x${intent.quantity} · ${formatUsdtAmount(intent.listPriceUsdt)}` : '待报价' },
    { icon: Truck, label: '履约方式', value: intent ? (intent.fulfillmentMode === 0 ? '快递邮寄' : '到店自提') : '待确认' },
    { icon: MapPinned, label: '地址或门店', value: runtime.checkoutTarget?.label ?? (intent ? shortHash(intent.fulfillmentTargetHash) : '待权威校验') },
  ];

  return (
    <div className="screen screen--detail screen--review">
      <ScreenHeader eyebrow="付款前核对" title="付前最终核对" description="商品、地址、金额和钱包全部确认后再支付" backTo="/checkout" />

      <section className="review-payment-summary" aria-label="支付摘要">
        <div>
          <span>本次 USDT 实付</span>
          <strong>{formatUsdtAmount(intent?.usdtPaymentAmount)}</strong>
          <small>{quote ? '来自系统报价' : '待创建报价'}</small>
        </div>
        <div>
          <span>授权状态</span>
          <strong>{quote ? requiresApproval ? '需确认授权' : '额度充足' : '待报价'}</strong>
          <small>{isSeckillQuote ? '含秒杀/日常双报价' : '普通报价'}</small>
        </div>
      </section>

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
          <div><strong>钱包支付</strong><span>{quote ? '主网钱包支付' : '待安全配置'}</span></div>
        </li>
      </ol>

      {runtime.checkoutTarget ? <CheckoutTargetReview target={runtime.checkoutTarget} /> : null}

      <section className="immutable-warning" aria-labelledby="immutable-warning-title">
        <ShieldAlert aria-hidden="true" size={22} />
        <div>
          <h2 id="immutable-warning-title">付款前请最终确认</h2>
          <p>付款成功后，商品、规格、数量、履约方式与所在行政区将写入订单，后续不可修改。</p>
        </div>
      </section>

      <section className="allowance-disclosure" aria-labelledby="allowance-title">
        <Banknote aria-hidden="true" size={21} />
        <div>
          <h2 id="allowance-title">授权与支付</h2>
          <p>如果钱包额度不足，会请你授权一次；额度足够时不会重复弹窗。你也可以随时点下面的“撤销额度”。</p>
        </div>
      </section>

      {quote ? (
        <details className="payment-intent disclosure-card">
          <summary>
            <div>
              <h2>付款明细</h2>
              <span>{formatUsdtAmount(intent?.usdtPaymentAmount)} · {requiresApproval ? '首次需授权' : '额度充足'}</span>
            </div>
            <strong><span className="disclosure-card__closed">展开</span><span className="disclosure-card__open">收起</span></strong>
          </summary>
          <div className="disclosure-card__body">
            <dl>
              <div><dt>商品 USDT</dt><dd>{formatUsdtAmount(intent?.productUsdtPaymentAmount)}</dd></div>
              <div><dt>平台服务费 USDT</dt><dd>{formatUsdtAmount(intent?.platformServiceFeeUsdt)}</dd></div>
              <div><dt>商家货款 USDT</dt><dd>{formatUsdtAmount(intent?.custodyProductUsdt)}</dd></div>
              <div><dt>运费 USDT</dt><dd>{formatUsdtAmount(intent?.freightUsdt)}</dd></div>
              <div><dt>USDT 实付</dt><dd>{formatUsdtAmount(intent?.usdtPaymentAmount)}</dd></div>
              <div><dt>NPL 支付</dt><dd>{formatNplAmount(intent?.nplPaymentAmount)}</dd></div>
              <div><dt>NPL 销毁</dt><dd>{formatNplAmount(intent?.nplBurnAmount)}</dd></div>
              <div><dt>NPL 奖励钱包</dt><dd>{formatNplAmount(intent?.nplRewardAmount)}</dd></div>
              <div><dt>BNM 锁定</dt><dd>{formatBnmAmount(intent?.bnmAmount)}</dd></div>
            </dl>
            <p className="field-help">金额已按普通小数展示；实际支付仍以系统报价为准。</p>
            {quote.approvalRequirements.map((requirement, index) => (
              <article className="approval-row" key={requirement.token}>
                <div><strong>{approvalTokenLabel(requirement.token)}</strong><span>支付合约 {shortHash(requirement.spender)}</span></div>
                <div><span>当前 {formatApprovalAmount(requirement.token, runtime.approvals[index]?.currentAllowance)}</span><span>{runtime.approvals[index]?.sufficient ? '额度足够' : '需要授权'}</span></div>
                <div><span>本次至少 {formatApprovalAmount(requirement.token, requirement.requiredAmount)}</span><span>授权 {formatRequestedApprovalAmount(requirement)}</span></div>
                {isMaxApproval(requirement.requestedAllowance) ? (
                  <p className="field-help">
                    无限额度授权：钱包会给上面的支付合约长期扣 {approvalTokenLabel(requirement.token)} 的权限。请确认支付合约地址正确；不想长期授权时，点“撤销额度”可把额度归零。
                  </p>
                ) : null}
                <button className="text-button" type="button" onClick={() => void runtime.revokeApproval(index)} disabled={runtime.busy || !runtime.session}>撤销额度归零</button>
              </article>
            ))}
            {requiresApproval ? (
              <p className="field-help">首次购买会先弹出授权，再弹出签名和付款。授权只给当前支付合约，用于本商城支付；不想保留长期额度时，可随时撤销额度归零。</p>
            ) : <p className="field-help">当前两笔代币额度均充足，本次不重复请求授权。</p>}
          </div>
        </details>
      ) : null}

      {quote && 'dual' in quote ? (
        <details className="dual-quote disclosure-card">
          <summary>
            <div>
              <h2>秒杀备用报价</h2>
              <span>活动内按秒杀价，超时自动按普通价</span>
            </div>
            <strong><span className="disclosure-card__closed">展开</span><span className="disclosure-card__open">收起</span></strong>
          </summary>
          <div className="disclosure-card__body">
            <div className="dual-quote__grid">
              <div><strong>付款在活动时间内</strong><span>商品 {formatUsdtAmount(quote.routerCall.intent.seckillPayment.listPriceUsdt)}</span><span>服务费 {formatUsdtAmount(quote.routerCall.intent.seckillPayment.platformServiceFeeUsdt)}</span><span>商家货款 {formatUsdtAmount(quote.routerCall.intent.seckillPayment.custodyProductUsdt)}</span><span>运费 {formatUsdtAmount(quote.routerCall.intent.seckillPayment.freightUsdt)}</span><span>USDT 实付 {formatUsdtAmount(quote.routerCall.intent.seckillPayment.usdtPaymentAmount)}</span><span>NPL {formatNplAmount(quote.routerCall.intent.seckillPayment.nplPaymentAmount)}</span></div>
              <div><strong>付款超过活动截止</strong><span>商品 {formatUsdtAmount(quote.routerCall.intent.fallbackPayment.listPriceUsdt)}</span><span>服务费 {formatUsdtAmount(quote.routerCall.intent.fallbackPayment.platformServiceFeeUsdt)}</span><span>商家货款 {formatUsdtAmount(quote.routerCall.intent.fallbackPayment.custodyProductUsdt)}</span><span>运费 {formatUsdtAmount(quote.routerCall.intent.fallbackPayment.freightUsdt)}</span><span>USDT 实付 {formatUsdtAmount(quote.routerCall.intent.fallbackPayment.usdtPaymentAmount)}</span><span>NPL {formatNplAmount(quote.routerCall.intent.fallbackPayment.nplPaymentAmount)}</span></div>
            </div>
            <p className="field-help">是否命中秒杀只看你的钱包付款上链时间；截止后自动使用普通报价和普通库存预留。</p>
          </div>
        </details>
      ) : null}

      <button
        className="button button--primary"
        type="button"
        disabled={!quote || Boolean(runtime.submittedTxHash) || runtime.busy || !runtime.bootstrap?.writesEnabled || !runtime.walletWritesAuthorized}
        onClick={() => void runtime.broadcastPayment(requiresApproval, isSeckillQuote)}
      >
        <WalletCards aria-hidden="true" size={18} /> {paymentButtonLabel(runtime, requiresApproval)}
      </button>
      {!runtime.walletWritesAuthorized ? (
        <p className="control-reason">当前支付功能还没发布，不会发起钱包交易。</p>
      ) : null}

      {quote ? (
        <section className="payment-status" aria-labelledby="payment-status-title">
          <div className="section-heading"><h2 id="payment-status-title">支付同步</h2><Radio aria-hidden="true" size={19} /></div>
          <dl>
            <div><dt>报价状态</dt><dd>{paymentStateLabel(runtime.projection?.state ?? quote.state)}</dd></div>
            <div><dt>钱包付款</dt><dd>{paymentSubmissionSyncLabel(runtime, quote)}</dd></div>
            <div><dt>支付分类</dt><dd>{paymentClassificationLabel(runtime.projection?.finality?.classification)}</dd></div>
            <div><dt>确认数</dt><dd>{runtime.projection?.finality ? `${runtime.projection.finality.confirmations}/${runtime.projection.finality.requiredConfirmations}` : '--/15'}</dd></div>
            <div><dt>最终确认</dt><dd>{paymentFinalitySyncLabel(runtime, quote)}</dd></div>
          </dl>
          <button className="button button--secondary" type="button" onClick={() => void runtime.refreshPayment()} disabled={runtime.busy || !runtime.session}>
            <RefreshCw aria-hidden="true" size={18} /> 刷新支付状态
          </button>
          {runtime.pendingSubmission ? (
            <button className="button button--secondary" type="button" onClick={() => void runtime.retrySubmission()} disabled={runtime.busy}>
              <RefreshCw aria-hidden="true" size={18} />
              {runtime.pendingSubmission.phase === 'PENDING_CORE_SUBMISSION' ? '重试同步付款' : '刷新支付状态'}
            </button>
          ) : null}
        </section>
      ) : <StatusNotice title="尚未创建付款报价">返回订单配置选择商品和规格，由系统预留库存后再核对。</StatusNotice>}
    </div>
  );
}

function CheckoutTargetReview({ target }: { target: NonNullable<MallRuntimeValue['checkoutTarget']> }) {
  if (target.review.kind === 'DELIVERY') {
    const address = target.review.address;
    return (
      <section className="checkout-review-target" aria-labelledby="checkout-review-target-title">
        <div className="section-heading"><h2 id="checkout-review-target-title">完整收货信息</h2><Truck aria-hidden="true" size={19} /></div>
        <dl>
          <div><dt>收货人</dt><dd>{address.recipientName}</dd></div>
          <div><dt>手机号</dt><dd>{address.phone}</dd></div>
          <div><dt>省 / 市 / 区</dt><dd>{address.province} / {address.city} / {address.district}</dd></div>
          <div><dt>详细地址</dt><dd>{address.formattedAddress}</dd></div>
          <div><dt>行政区代码</dt><dd>{address.regionCode}</dd></div>
        </dl>
      </section>
    );
  }
  const store = target.review.store;
  return (
    <section className="checkout-review-target" aria-labelledby="checkout-review-target-title">
      <div className="section-heading"><h2 id="checkout-review-target-title">完整自提信息</h2><Store aria-hidden="true" size={19} /></div>
      <dl>
        <div><dt>门店</dt><dd>{store.name}</dd></div>
        <div><dt>地址</dt><dd>{store.address}</dd></div>
        <div><dt>营业时间</dt><dd>{store.businessHours}</dd></div>
        <div><dt>联系电话</dt><dd>{store.phone}</dd></div>
        <div><dt>行政区代码</dt><dd>{store.regionCode}</dd></div>
      </dl>
      <p>请在营业时间内到店，并以订单状态和现场核销结果为准。</p>
    </section>
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

function approvalTokenLabel(token: string) {
  if (token.toLowerCase() === chainIdentity.usdtAddress.toLowerCase()) return 'USDT';
  if (token.toLowerCase() === chainIdentity.nplAddress.toLowerCase()) return 'NPL';
  return shortHash(token);
}

function formatRequestedApprovalAmount(requirement: ApprovalRequirement) {
  return isMaxApproval(requirement.requestedAllowance)
    ? '无限额度（最大额度）'
    : formatApprovalAmount(requirement.token, requirement.requestedAllowance);
}

function isMaxApproval(value: string) {
  try {
    return BigInt(value) === (2n ** 256n - 1n);
  } catch {
    return false;
  }
}

function paymentButtonLabel(runtime: MallRuntimeValue, requiresApproval: boolean) {
  if (runtime.busy) {
    if (runtime.checkoutBusy === 'PAYMENT') return '正在处理付款';
    return '正在处理';
  }
  return requiresApproval ? '授权并支付' : '打开钱包支付';
}

function skuLabel(attributes: Readonly<Record<string, unknown>>, fallback: string) {
  const values = Object.values(attributes).filter(
    (value): value is string | number => typeof value === 'string' || typeof value === 'number',
  );
  return values.length > 0 ? values.join(' / ') : fallback;
}

function quoteDisabledReason(runtime: MallRuntimeValue) {
  if (runtime.busy) {
    if (runtime.checkoutBusy === 'PICKUP_TARGET') return '正在确认自提门店，请稍候';
    if (runtime.checkoutBusy === 'QUOTE') return '正在向系统生成报价，请稍候';
    if (runtime.checkoutBusy === 'PAYMENT') return '正在处理付款，请稍候';
    return '正在同步账户信息，请稍候';
  }
  if (!runtime.selectedProduct) return '请先从商城选择商品';
  if (!runtime.selectedSku) return '请手动选择一个可售规格';
  if (!runtime.selectedProduct.fulfillmentModes.includes(runtime.fulfillmentMode)) return '该商品未发布当前履约方式';
  if (runtime.selectedSku.seckill && !runtime.selectedSeckillSessionId) return '该规格正在活动阶段，普通结算已停用';
  if (!runtime.session) return '请先连接钱包';
  if (!runtime.bootstrap) return '正在同步系统安全状态';
  if (!runtime.bootstrap.writesEnabled) return '当前暂时不能付款，请稍后再试';
  if (runtime.selectedSeckillSessionId && (
    runtime.seckillSession?.sessionId !== runtime.selectedSeckillSessionId
      || runtime.seckillSession.phase !== 'LIVE'
  )) return '系统当前场次阶段不允许创建秒杀报价';
  if (runtime.selectedSeckillSessionId && (
    BigInt(runtime.seckillSession?.inventory.available ?? '0') === 0n
      || BigInt(runtime.selectedSku.seckill?.inventory.available ?? '0') === 0n
  )) return '本场已抢完，请返回秒杀大厅查看下一场。';
  if (runtime.selectedSeckillSessionId && checkoutQuantityLimit(runtime) < BigInt(runtime.quantity)) {
    return '本场剩余库存不足，请减少购买数量。';
  }
  if (!runtime.checkoutTarget || runtime.checkoutTarget.fulfillmentMode !== runtime.fulfillmentMode) {
    return runtime.fulfillmentMode === 'DELIVERY' ? '请先选择已保存的收货地址' : '请先选择自提门店';
  }
  return '配置还差一步，请检查规格、履约方式、收货信息和购买数量';
}

function checkoutQuantityLimit(runtime: MallRuntimeValue) {
  const sku = runtime.selectedSku;
  if (!sku) return 0n;
  const stockAvailable = BigInt(sku.stockAvailable);
  if (!runtime.selectedSeckillSessionId) return stockAvailable;
  const sessionAvailable = BigInt(runtime.seckillSession?.inventory.available ?? '0');
  const skuSeckillAvailable = BigInt(sku.seckill?.inventory.available ?? '0');
  return [stockAvailable, sessionAvailable, skuSeckillAvailable].reduce((min, value) => value < min ? value : min);
}

function quoteButtonLabel(runtime: MallRuntimeValue) {
  if (runtime.busy) {
    if (runtime.checkoutBusy === 'PICKUP_TARGET') return '正在确认门店';
    if (runtime.checkoutBusy === 'QUOTE') return '正在生成报价';
    if (runtime.checkoutBusy === 'PAYMENT') return '正在处理付款';
    return '正在同步';
  }
  return runtime.selectedSeckillSessionId ? '生成秒杀报价' : '生成付款报价';
}

type CountdownState = Readonly<{
  value: string | null;
  ready: boolean;
  expired: boolean;
}>;

function CountdownMetric({ label, value }: { label: string; value: CountdownState }) {
  return (
    <div className={value.expired ? 'metric metric--expired' : 'metric'}>
      <span>{label}</span>
      <strong className="metric__value" aria-label={value.value ? `${label}${value.value}` : `${label}未返回数据`}>
        {value.value ?? '--'}
      </strong>
    </div>
  );
}

function useAuthoritativeCountdown(
  serverTime?: string,
  deadline?: string,
  onExpire?: (deadlineKey: string) => void,
): CountdownState {
  const receivedAtRef = useRef(Date.now());
  const notifiedDeadlineRef = useRef<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const serverMs = serverTime ? Date.parse(serverTime) : Number.NaN;
  const deadlineMs = deadline ? Date.parse(deadline) : Number.NaN;
  const ready = Boolean(serverTime && deadline && Number.isFinite(serverMs) && Number.isFinite(deadlineMs));
  const clockSyncKey = ready ? `${serverTime}|${deadline}` : null;
  const expireNotificationKey = ready ? deadline : null;
  useEffect(() => {
    receivedAtRef.current = Date.now();
    setNowMs(receivedAtRef.current);
    if (!ready) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [clockSyncKey, ready]);
  const serverNow = ready ? serverMs + (nowMs - receivedAtRef.current) : Number.NaN;
  const remainingMs = ready ? deadlineMs - serverNow : Number.NaN;
  const expired = ready ? remainingMs <= 0 : false;
  useEffect(() => {
    if (!expireNotificationKey) {
      notifiedDeadlineRef.current = null;
      return;
    }
    if (!expired || notifiedDeadlineRef.current === expireNotificationKey) return;
    notifiedDeadlineRef.current = expireNotificationKey;
    onExpire?.(expireNotificationKey);
  }, [expireNotificationKey, expired, onExpire]);
  if (!ready) return { value: null, ready: false, expired: false };
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return {
    value: [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':'),
    ready: true,
    expired,
  };
}

function SeckillPhasePill({ phase }: { phase?: SeckillSessionProjection['phase'] | undefined }) {
  const label = phase ? seckillPhaseText(phase) : '未同步';
  const tone = phase === 'LIVE' || phase === 'SETTLED'
    ? 'status-pill--success'
    : phase === 'SETTLING'
      ? 'status-pill--locked'
      : 'status-pill--muted';
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function seckillPhaseText(phase: SeckillSessionProjection['phase']) {
  return ({
    PREHEAT: '预热',
    LIVE: '进行中',
    SETTLING: '结算中',
    SETTLED: '已结算',
    FORCE_CLOSED: '已关闭',
  } as const)[phase];
}

function seckillPhaseCopy(session: PublishedSeckillSessionProjection) {
  return ({
    PREHEAT: `预热中，${formatIso(session.startsAt)} 开始。`,
    LIVE: '活动进行中，倒计时和库存会自动同步。',
    SETTLING: `抢购已结束，大奖正在结算，预计 ${formatIso(session.settlementDeadline)} 前完成。`,
    SETTLED: session.winnerWallet
      ? '本场已结算，中奖用户和奖励状态已公布。'
      : session.prizeSettlement?.state === 'ROLLED_OVER'
        ? '本场没有有效赢家，奖池已滚入下一场。'
        : '场次已最终结算。',
    FORCE_CLOSED: '场次已由治理流程强制关闭，不再接受秒杀报价。',
  } as const)[session.phase];
}

function seckillPrizeStateLabel(state: SeckillPrizeSettlementProjection['state']) {
  return ({
    REVIEW_PENDING: '候选审核中',
    APPROVED: '审核通过',
    ROLLOVER_PENDING: '等待滚入',
    ROLLED_OVER: '已滚入下一场',
    QUARANTINED: '已隔离',
  } as const)[state];
}

function seckillPayoutStateLabel(state: NonNullable<SeckillPrizeSettlementProjection['payout']>['state']) {
  return ({
    AVAILABLE: '可用',
    REQUESTED: '已申请',
    SUBMITTED: '已提交',
    SETTLED: '已到账',
    RETRYABLE: '可重试',
    QUARANTINED: '已隔离',
    FAILED_CLOSED: '已关闭',
  } as const)[state];
}

function seckillPrizeReviewReasonLabel(value: string) {
  if (/^ORDER_VALID$/i.test(value)) return '候选订单有效';
  if (/^ORDER_INVALID$/i.test(value)) return '候选订单无效';
  if (/APPROV/i.test(value)) return '系统审核通过';
  if (/REJECT|INVALID|DENY/i.test(value)) return '系统审核不通过';
  return '已记录审核原因';
}

function seckillActionReason(
  runtime: MallRuntimeValue,
  session: PublishedSeckillSessionProjection,
  productAvailable: boolean,
  mainCountdown: CountdownState,
  relayCountdown: CountdownState,
) {
  if (session.phase !== 'LIVE') return `当前状态为${seckillPhaseText(session.phase)}，暂时不能抢`;
  if (!mainCountdown.ready || !relayCountdown.ready) return '活动时间还没同步完成，暂时不能抢';
  if (mainCountdown.expired || relayCountdown.expired) return '倒计时已结束，正在刷新活动状态';
  if (BigInt(session.inventory.available) === 0n) return '本场库存已抢完';
  if (!productAvailable) return '当前商品还没准备好，暂时不能抢';
  if (!runtime.bootstrap?.writesEnabled) return '平台当前暂停新支付，暂时不能抢';
  if (runtime.pendingSubmission) return '你有一笔钱包付款还没提交给系统，请先恢复跟踪或刷新支付状态。';
  if (runtime.busy) return '系统正在同步数据，请稍候。';
  return '确认规则后就能进入下单页。';
}

function ledgerStateSummaries(runtime: MallRuntimeValue) {
  const readable = Boolean(runtime.session && (runtime.settlementsState === 'ready' || runtime.settlementsState === 'empty'));
  const points = runtime.settlements?.points ?? [];
  const balances = runtime.settlements?.balances ?? [];
  const regionalSubtypes: readonly RewardSubtype[] = ['DISTRICT', 'CITY', 'PROVINCE', 'REGION'];
  return [
    {
      title: 'BNM 积分',
      total: readable ? formatBnmAmount(sumAtomicStrings(points.map((point) => point.amount))) : '--',
      available: readable ? formatBnmAmount(sumAtomicStrings(points.filter((point) => point.state === 'AVAILABLE').map((point) => point.amount))) : '--',
      locked: readable ? formatBnmAmount(sumAtomicStrings(points.filter((point) => point.state === 'LOCKED').map((point) => point.amount))) : '--',
      copy: 'BNM 是平台积分，履约完成后会从锁定变为可用积分。',
    },
    {
      title: '创世节点 NPL',
      total: readable ? formatNplAmount(sumAtomicStrings(balances.filter((balance) => balance.rewardSubtype === 'GENESIS').map((balance) => balance.amount))) : '--',
      available: readable ? formatNplAmount(sumAtomicStrings(balances.filter((balance) => balance.rewardSubtype === 'GENESIS' && balance.state === 'AVAILABLE').map((balance) => balance.amount))) : '--',
      locked: readable ? formatNplAmount(sumAtomicStrings(balances.filter((balance) => balance.rewardSubtype === 'GENESIS' && balance.state === 'LOCKED').map((balance) => balance.amount))) : '--',
      copy: '节点收益到账后，可以在收益中心申请结算。',
    },
    {
      title: '区域代理 NPL',
      total: readable ? formatNplAmount(sumAtomicStrings(balances.filter((balance) => balance.rewardSubtype && regionalSubtypes.includes(balance.rewardSubtype)).map((balance) => balance.amount))) : '--',
      available: readable ? formatNplAmount(sumAtomicStrings(balances.filter((balance) => balance.rewardSubtype && regionalSubtypes.includes(balance.rewardSubtype) && balance.state === 'AVAILABLE').map((balance) => balance.amount))) : '--',
      locked: readable ? formatNplAmount(sumAtomicStrings(balances.filter((balance) => balance.rewardSubtype && regionalSubtypes.includes(balance.rewardSubtype) && balance.state === 'LOCKED').map((balance) => balance.amount))) : '--',
      copy: '区域收益按下单时确认的地址归属统计。',
    },
  ] as const;
}

function sumAtomicStrings(values: readonly string[]) {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

function formatUsdtAmount(amount: string | null | undefined) {
  const value = formatUsdtNumber(amount);
  return value === '--' ? value : `${value} USDT`;
}

function formatUsdtNumber(amount: string | null | undefined) {
  return formatAtomicFixed(amount, 18, 2);
}

function formatNplAmount(amount: string | null | undefined) {
  const value = formatAtomicFixed(amount, 18, 2);
  return value === '--' ? value : `${value} NPL`;
}

function formatBnmAmount(amount: string | null | undefined) {
  const value = formatAtomicFixed(amount, 18, 2);
  return value === '--' ? value : `${value} BNM`;
}

function formatAssetDisplayAmount(amount: string | null | undefined, asset: string) {
  if (asset === 'USDT') return formatUsdtAmount(amount);
  if (asset === 'NPL') return formatNplAmount(amount);
  if (asset === 'BNM_POINTS' || asset === 'BNM') return formatBnmAmount(amount);
  const value = formatAtomicFixed(amount, 18, 2);
  return value === '--' ? value : `${value} ${asset}`;
}

function formatApprovalAmount(token: string, amount: string | undefined) {
  if (amount === undefined) return '读取中';
  const normalized = token.toLowerCase();
  if (normalized === chainIdentity.usdtAddress.toLowerCase()) return formatUsdtAmount(amount);
  if (normalized === chainIdentity.nplAddress.toLowerCase()) return formatNplAmount(amount);
  return formatAtomicFixed(amount, 18, 2);
}

function formatAtomicFixed(amount: string | null | undefined, decimals: number, fractionDigits: number) {
  if (amount === undefined || amount === null || amount === '') return '--';
  if (!/^[0-9]+$/.test(amount)) return amount;
  const atomic = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const displayScale = 10n ** BigInt(fractionDigits);
  const rounded = (atomic * displayScale + base / 2n) / base;
  if (atomic > 0n && rounded === 0n) return `<${(1 / Number(displayScale)).toFixed(fractionDigits)}`;
  const whole = rounded / displayScale;
  const fraction = rounded % displayScale;
  return `${whole.toLocaleString('en-US')}.${fraction.toString().padStart(fractionDigits, '0')}`;
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
  if (action === 'OPEN_TAKEOVER') return '当前订单不能由买家直接发起平台接管';
  if (action === 'VERIFY_PICKUP') return '自提核销证据仅授权门店或平台角色';
  return '当前商城买家流程不支持该操作';
}

function cityCodeFor(regionCode: string) {
  return `${regionCode.slice(0, 4)}00`;
}

function regionCityCodes(stores: readonly MerchantStore[]) {
  return [...new Set(stores.map((store) => cityCodeFor(store.regionCode)))].sort();
}

function regionDistrictCodes(stores: readonly MerchantStore[], cityCode: string) {
  if (!cityCode) return [];
  return [...new Set(stores
    .filter((store) => cityCodeFor(store.regionCode) === cityCode)
    .map((store) => store.regionCode))].sort();
}

function activityCountState(state: MallRuntimeValue['ordersState'], authenticated: boolean) {
  if (!authenticated) return '未登录';
  if (state === 'loading' || state === 'idle') return '同步中';
  return '同步失败';
}

function orderCountText(metric: Readonly<{ status: string; count: string | null }> | null | undefined) {
  if (!metric) return null;
  if (metric.status === 'AVAILABLE') return metric.count ?? '0';
  if (['DecisionBlocked', 'ExternalBlocked', 'ConfigurationRequired'].includes(metric.status)) return '--';
  return '--';
}

function orderMatchesTab(order: FulfillmentOrder, tab: string) {
  if (tab === '全部') return true;
  if (tab === '待付款') return ['QUOTED', 'SUBMITTED'].includes(order.state);
  if (tab === '待发货') return order.state === 'PAID' && order.fulfillmentMode === 'DELIVERY';
  if (tab === '待自提') return order.state === 'PAID' && order.fulfillmentMode === 'PICKUP';
  if (tab === '待收货') return ['SHIPPED', 'DELIVERED', 'FULFILLMENT_PENDING'].includes(order.state);
  return ['ARBITRATION', 'TAKEOVER'].includes(order.state);
}

function orderStateLabel(state: FulfillmentOrder['state'], fulfillmentMode?: FulfillmentOrder['fulfillmentMode']) {
  return ({
    QUOTED: '待付款',
    SUBMITTED: '提交中',
    PAID: fulfillmentMode === 'PICKUP' ? '待自提' : '待发货',
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
    FINAL: '最终确认',
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

function carrierLabel(code: string) {
  return ({ SF: '顺丰', JD: '京东物流', YTO: '圆通', ZTO: '中通', STO: '申通', EMS: 'EMS' } as Record<string, string>)[code] ?? code;
}

function balanceStateLabel(state: FulfillmentOrder['balances'][number]['state']) {
  return ({
    LOCKED: '锁定',
    AVAILABLE: '可用',
    REQUESTED: '已申请',
    SUBMITTED: '已提交',
    SETTLED: '已结算',
    DISPUTED: '争议锁定',
  } as const)[state];
}

function requestTypeLabel(type: FulfillmentOrder['requests'][number]['requestType']) {
  return ({ EXCHANGE: '换货', DELAY: '延期', ARBITRATION: '仲裁', FORCED_RECEIPT: '强制收货审查' } as const)[type];
}

function requestStateLabel(state: FulfillmentOrder['requests'][number]['state']) {
  return ({
    OPEN: '待处理',
    APPROVED: '已通过',
    REJECTED: '已拒绝',
    CANCELLED: '已取消',
    CLOSED: '已关闭',
  } as Record<string, string>)[state] ?? state;
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

function defaultBuyerActionReason(action: BuyerEvidenceAction) {
  return ({
    REQUEST_EXCHANGE: 'BUYER_REQUEST_EXCHANGE',
    REQUEST_DELAY: 'BUYER_REQUEST_DELAY',
    CONFIRM_RECEIPT: 'BUYER_CONFIRM_RECEIPT',
    OPEN_ARBITRATION: 'BUYER_OPEN_ARBITRATION',
  } as const)[action];
}

function railForBalance(balance: SettlementBalance): Extract<SettlementRail, 'REWARD_NPL' | 'PRIZE_USDT'> | null {
  if (balance.asset === 'NPL' && balance.purpose === 'REWARD_LIABILITY') return 'REWARD_NPL';
  if (balance.asset === 'USDT' && balance.purpose === 'SECKILL_PRIZE_LIABILITY') return 'PRIZE_USDT';
  return null;
}

function storeStatusLabel(status: MerchantStore['status']) {
  return ({
    DRAFT: '门店资料待完善',
    ACTIVE: '营业中',
    SUSPENDED: '暂停服务',
    CLOSED: '已关闭',
  } as Record<string, string>)[status] ?? '门店状态异常，请联系客服';
}

function settlementStateLabel(state: SettlementBalance['state'] | SettlementRequestProjection['state']) {
  return ({
    LOCKED: '锁定中',
    AVAILABLE: '可用',
    REQUESTED: '已申请',
    SUBMITTED: '已提交',
    SETTLED: '已结算',
    DISPUTED: '争议中',
    RETRYABLE: '可重试',
    QUARANTINED: '已隔离',
    FAILED_CLOSED: '已关闭',
  } as const)[state];
}

function paymentStateLabel(state: string | null | undefined) {
  if (!state) return '等待确认';
  return ({
    QUOTED: '已报价',
    SUBMITTED: '已提交',
    PAID: '已付款',
    PENDING: '确认中',
    CONFIRMED: '已确认',
    MINED: '已上链，等待最终确认',
    FINAL: '已完成',
    REPLACED: '交易已替换',
    REORGED: '链上回滚',
    FAILED: '失败',
    EXPIRED: '已过期',
  } as Record<string, string>)[state] ?? '系统返回新状态，请刷新或联系客服';
}

function paymentSubmissionSyncLabel(
  runtime: MallRuntimeValue,
  quote: NonNullable<MallRuntimeValue['quote']>,
) {
  const walletTxSent = Boolean(runtime.projection?.submittedTxHash || runtime.submittedTxHash || quote.submittedTxHash);
  if (!walletTxSent) return '未发起';
  if (!runtime.projection) return '钱包已发出，等待系统收到付款凭证';
  if (runtime.projection.finality?.state === 'FINAL') return '系统已收到并确认';
  return '系统已收到，等待最终确认';
}

function paymentFinalitySyncLabel(
  runtime: MallRuntimeValue,
  quote: NonNullable<MallRuntimeValue['quote']>,
) {
  if (runtime.projection?.finality) return paymentStateLabel(runtime.projection.finality.state);
  if (runtime.projection) return '等待链上最终确认';
  if (runtime.submittedTxHash || quote.submittedTxHash) return '系统尚未收到付款凭证';
  return '未开始';
}

function paymentClassificationLabel(value: string | null | undefined) {
  if (!value) return '等待系统确认';
  return ({
    ORDINARY: '普通订单',
    SECKILL: '秒杀订单',
    FALLBACK_RETAIL: '普通兜底订单',
  } as Record<string, string>)[value] ?? value;
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

function notificationTopicLabel(topic: string) {
  return ({
    PAYMENT_FINALIZED: '支付',
    PAYMENT_REORGED: '支付',
    SHIPMENT_UPDATED: '发货 / 物流',
    FULFILLMENT_FINALIZED: '履约',
    TAKEOVER_OPENED: '履约',
    BNM_LOCKED: 'BNM',
    BNM_AVAILABLE: 'BNM',
    SETTLEMENT_REQUESTED: '结算',
    SETTLEMENT_SUBMITTED: '结算',
    SETTLEMENT_BATCHED: '历史结算',
    SETTLEMENT_SETTLED: '结算',
    SETTLEMENT_REORGED: '结算',
    ANNOUNCEMENT: '公告',
    MAINTENANCE: '系统维护',
    ACTIVITY: '活动',
  } as Record<string, string>)[topic] ?? '业务通知';
}

function notificationTitle(item: MallRuntimeValue['notifications'][number]) {
  const titles: Record<string, string> = {
    PAYMENT_FINALIZED: '支付已确认',
    PAYMENT_REORGED: '支付确认已回滚',
    SHIPMENT_UPDATED: '发货与物流已更新',
    FULFILLMENT_FINALIZED: item.templateData.method === 'PICKUP_VERIFICATION' ? '自提履约已完成' : '订单履约已完成',
    TAKEOVER_OPENED: '平台接管履约已开启',
    BNM_LOCKED: 'BNM 已锁定',
    BNM_AVAILABLE: 'BNM 已可用',
    SETTLEMENT_REQUESTED: '结算申请已提交',
    SETTLEMENT_SUBMITTED: '结算交易已提交',
    SETTLEMENT_BATCHED: '历史结算交易已提交',
    SETTLEMENT_SETTLED: '结算已完成',
    SETTLEMENT_REORGED: '结算确认已回滚',
    ANNOUNCEMENT: '系统公告',
    MAINTENANCE: '系统维护通知',
    ACTIVITY: '活动通知',
  };
  return titles[item.topic] ?? notificationTopicLabel(item.topic);
}

function notificationTemplateRows(template: Readonly<Record<string, unknown>>) {
  const rows = Object.entries(template)
    .filter((entry): entry is [string, string | number | boolean] => entry[0] !== 'copyKey' && ['string', 'number', 'boolean'].includes(typeof entry[1]))
    .map(([key, value]) => [key, notificationFieldLabel(key), notificationFieldValue(key, value)] as const);
  const variables = template.variables;
  if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
    for (const [key, value] of Object.entries(variables)) {
      if (['string', 'number', 'boolean'].includes(typeof value)) {
        rows.push([`variables.${key}`, `活动参数 · ${notificationFieldLabel(key)}`, String(value)] as const);
      }
    }
  }
  return rows;
}

function notificationFieldLabel(key: string) {
  return ({
    aggregateId: '业务单号',
    orderId: '订单号',
    shipmentId: '发货记录',
    trackingNumberHash: '物流单号凭证',
    carrierCode: '承运商',
    logisticsEventId: '物流事件',
    provider: '物流服务商',
    status: '物流状态',
    deliveredAt: '签收时间',
    occurredAt: '物流更新时间',
    requestId: '结算申请',
    rail: '结算类型',
    chainTxHash: '钱包交易记录',
    executionTxHash: '到账记录',
    state: '状态',
    amount: '数量',
    stateVersion: 'BNM 状态版本',
    method: '履约方式',
    lockedUsdtAmount: '锁定 USDT',
    lockedNplAmount: '锁定 NPL',
    availableUsdtAmount: '可用 USDT',
    availableNplAmount: '可用 NPL',
    rewardSubtypes: '收益类型',
    campaignId: '活动编号',
    transactionHash: '支付交易',
    confirmations: '链上确认数',
    titleKey: '标题模板',
    bodyKey: '正文模板',
    version: '版本',
  } as Record<string, string>)[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function notificationFieldValue(key: string, value: string | number | boolean) {
  const text = String(value);
  if (key === 'state') return ({ LOCKED: '锁定中', AVAILABLE: '可用' } as Record<string, string>)[text] ?? text;
  if (key === 'method') return ({ PICKUP_VERIFICATION: '自提核销', CUSTOMER_RECEIPT: '客户确认收货', FORCED_RECEIPT: '强制收货', ARBITRATION: '仲裁履约' } as Record<string, string>)[text] ?? text;
  if (key === 'rail') return ({ REWARD_NPL: 'NPL 收益', PRIZE_USDT: 'USDT 奖励' } as Record<string, string>)[text] ?? text;
  if (key.toLowerCase().includes('usdtamount')) return formatUsdtAmount(text);
  return text;
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

function formatRelativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return formatIso(value);
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 10) return '刚刚';
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  return formatIso(value);
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
