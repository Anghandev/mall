import { useState } from 'react';
import {
  BadgeCheck,
  Banknote,
  Box,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  FileClock,
  Headphones,
  History,
  LocateFixed,
  LockKeyhole,
  MapPinned,
  Minus,
  Navigation,
  Package,
  PackageOpen,
  Phone,
  Plus,
  Radio,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  ShoppingBag,
  Store,
  Truck,
  UserRound,
  WalletCards,
  Zap,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  AllowedAction,
  FulfillmentOrder,
  FulfillmentTarget,
  MerchantStore,
  PaymentRouterIntent,
} from '@abu24k/core-artifacts';

import {
  DisabledAction,
  EmptyState,
  RulesDisclosure,
  ScreenHeader,
  StatusNotice,
  UnavailableValue,
} from './components';
import { useMallRuntime, type BrowserPosition, type MallRuntimeValue } from './mall-runtime';

const unavailableReason = '安全配置未发布，当前操作已停用';

export function SeckillScreen() {
  return (
    <div className="screen screen--seckill">
      <ScreenHeader
        eyebrow="60 分钟主场"
        title="秒杀大厅"
        description="以链上最终确认时间为准"
        trailing={<span className="status-pill status-pill--muted">暂未开放</span>}
      />

      <section className="seckill-hero" aria-label="秒杀活动状态">
        <img src="/brand/prize-vault.png" alt="黑金秒杀奖池保险柜" />
        <div className="seckill-hero__overlay">
          <p>接力大奖池</p>
          <strong className="amount-placeholder" aria-label="大奖池金额暂不可用">
            -- USDT
          </strong>
          <span>等待活动状态同步</span>
        </div>
      </section>

      <div className="timer-grid" aria-label="活动计时">
        <UnavailableValue label="主场倒计时" />
        <UnavailableValue label="接力倒计时" />
      </div>

      <div className="action-row">
        <RulesDisclosure />
        <button className="button button--secondary" type="button" disabled>
          <History aria-hidden="true" size={18} />
          历史战报
        </button>
      </div>

      <StatusNotice title="活动暂不可参与">
        活动阶段、报价、库存和结算结果尚未完成权威同步。页面不会自行推算倒计时或订单归类。
      </StatusNotice>

      <section className="section-block" aria-labelledby="relay-feed-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CHAIN FINAL EVENTS</p>
            <h2 id="relay-feed-title">接力风云</h2>
          </div>
          <Radio aria-hidden="true" size={19} />
        </div>
        <EmptyState title="暂无已确认动态">
          只展示已去重、可恢复游标的链上最终事件，连接中断时不插入临时记录。
        </EmptyState>
      </section>

      <DisabledAction reason={unavailableReason} icon="wallet">
        支付并广播
      </DisabledAction>
    </div>
  );
}

export function MallScreen() {
  const runtime = useMallRuntime();
  const navigate = useNavigate();

  return (
    <div className="screen screen--mall">
      <ScreenHeader
        eyebrow="ABU SELECT"
        title="常规商城"
        description="商品、规格与价格以签名报价为准"
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
          <span className="muted-label">分类稍后批次发布</span>
        </div>
        <p className="section-copy">当前先展示 Core 已发布的可售商品，不根据 metadata 猜测分类或秒杀遮罩。</p>
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
          {runtime.catalog.map((product) => (
            <article className="product-card" key={product.productId}>
              <div className="product-card__visual"><ShoppingBag aria-hidden="true" size={26} /></div>
              <div className="product-card__body">
                <h2>{product.title}</h2>
                <p>{product.skus.length} 个可售 SKU</p>
                <dl>
                  <div><dt>首个 SKU 标价</dt><dd>{product.skus[0] ? `${product.skus[0].listPriceUsdt} 原子单位` : '--'}</dd></div>
                  <div><dt>可用库存</dt><dd>{product.skus[0]?.stockAvailable ?? '--'}</dd></div>
                </dl>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={runtime.busy || Boolean(runtime.pendingSubmission)}
                  onClick={() => {
                    runtime.selectProduct(product.productId);
                    navigate('/checkout');
                  }}
                >
                  选择商品 <ChevronRight aria-hidden="true" size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
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
        <Link className="icon-button" to="/assets/addresses" aria-label="打开我的收货地址">
          <MapPinned aria-hidden="true" size={20} />
        </Link>
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
  const logistics = order.logistics.at(-1);
  const buyerActions = actions.filter((action) => BUYER_FULFILLMENT_ACTIONS.includes(action.action));
  return (
    <article className="order-row">
      <header className="order-row__header">
        <div>
          <p className="eyebrow">{order.fulfillmentMode === 'DELIVERY' ? '快递订单' : '到店自提'}</p>
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
        <div><dt>USDT 支付</dt><dd>{order.exactAmounts.usdtPaymentAmount}</dd></div>
        <div><dt>NPL 支付</dt><dd>{order.exactAmounts.nplPaymentAmount}</dd></div>
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
              const reason = action.enabled
                ? 'Core 已允许该操作，但 canonical evidence 生成/上传契约尚未发布'
                : action.reasonCode ?? 'Core 当前未允许该操作';
              const reasonId = `action-${order.orderId.slice(2, 10)}-${action.action}`;
              return (
                <div key={action.action}>
                  <button type="button" className="button button--secondary" disabled aria-describedby={reasonId}>
                    {actionLabel(action.action)}
                  </button>
                  <p id={reasonId}>{reason}{action.deadline ? ` · ${formatIso(action.deadline)}` : ''}</p>
                </div>
              );
            })}
          </div>
        ) : <p>当前会话未返回买家履约动作。</p>}
      </section>
    </article>
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
  return (
    <div className="screen screen--detail screen--rewards">
      <ScreenHeader eyebrow="REWARD LEDGER" title="收益对账" description="累计、待领取与锁定三态分离" backTo="/assets" />

      <section className="reward-rail" aria-labelledby="bnm-rail-title">
        <div className="reward-rail__header">
          <div className="reward-rail__icon"><CircleDollarSign aria-hidden="true" size={22} /></div>
          <div>
            <p className="eyebrow">BNM</p>
            <h2 id="bnm-rail-title">消费产出池</h2>
          </div>
          <span className="status-pill status-pill--locked"><LockKeyhole aria-hidden="true" size={13} />未同步</span>
        </div>
        <div className="metric-grid metric-grid--three">
          <UnavailableValue label="累计" />
          <UnavailableValue label="待领取" />
          <UnavailableValue label="锁定中" />
        </div>
        <Link className="text-link text-link--disabled" to="/assets/rewards" aria-disabled="true" onClick={(event) => event.preventDefault()}>
          <FileClock aria-hidden="true" size={16} /> 资产溯源明细
        </Link>
        <DisabledAction reason="账目、最终状态和领取交易意图尚未发布">自主提取 BNM</DisabledAction>
      </section>

      <section className="eligibility-gate" aria-labelledby="eligibility-title">
        <BadgeCheck aria-hidden="true" size={24} />
        <div>
          <h2 id="eligibility-title">收益资格待校验</h2>
          <p>创世、直推、区域与运维收益仅在服务端确认当前钱包具备资格后出现，未确认时保持隐藏。</p>
        </div>
      </section>

      <StatusNotice title="所有收益默认锁定">
        BNM、节点、直推、区域和运维收益均不会因页面显示而变为可领取，状态必须通过最终确认。
      </StatusNotice>
    </div>
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
      && runtime.checkoutTarget?.fulfillmentMode === runtime.fulfillmentMode
      && !runtime.busy,
  );

  return (
    <div className="screen screen--detail screen--checkout">
      <ScreenHeader eyebrow="ORDER SETUP" title="订单配置" description="规格、数量与履约方式需完整确认" backTo="/mall" />

      {!product ? (
        <StatusNotice title="请先选择商品" tone="warning">返回商城从 Core 可售目录选择商品，当前页面不会补入示例 SKU。</StatusNotice>
      ) : null}
      {product && !runtime.session ? (
        <StatusNotice title="需要钱包登录">连接钱包并签署 SIWE 登录挑战后，Core 才会为当前买家预留库存。</StatusNotice>
      ) : null}
      {product && runtime.bootstrap && !runtime.bootstrap.writesEnabled ? (
        <StatusNotice title="新支付当前已安全停用" tone="warning">
          {runtime.bootstrap.blockCode === 'DecisionBlocked'
            ? '支付政策尚有未决项，不创建新报价。'
            : '支付部署、Safe、RPC 或运行就绪证据尚不完整，不创建新报价。'}
        </StatusNotice>
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
                disabled={runtime.busy || Boolean(runtime.pendingSubmission) || BigInt(item.stockAvailable) === 0n}
              >
                <strong>{skuLabel(item.attributes, item.skuId)}</strong>
                <span>标价 {item.listPriceUsdt} USDT 原子单位 · 库存 {item.stockAvailable}</span>
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
          <button type="button" disabled={runtime.busy || Boolean(runtime.pendingSubmission)} className={runtime.fulfillmentMode === 'DELIVERY' ? 'is-active' : ''} aria-pressed={runtime.fulfillmentMode === 'DELIVERY'} onClick={() => runtime.setFulfillmentMode('DELIVERY')}>
            <Truck aria-hidden="true" size={17} /> 快递邮寄
          </button>
          <button type="button" disabled={runtime.busy || Boolean(runtime.pendingSubmission)} className={runtime.fulfillmentMode === 'PICKUP' ? 'is-active' : ''} aria-pressed={runtime.fulfillmentMode === 'PICKUP'} onClick={() => runtime.setFulfillmentMode('PICKUP')}>
            <Store aria-hidden="true" size={17} /> 到店自提
          </button>
        </div>
      </fieldset>

      <CheckoutTargetSelector />

      <div className="checkout-total">
        <span>Core 签名报价</span>
        <strong>{runtime.quote ? `${primaryIntent(runtime.quote).listPriceUsdt} USDT 原子单位` : '--'}</strong>
      </div>
      <button className="button button--primary" type="button" disabled={!canQuote} onClick={() => void runtime.requestOrdinaryQuote()}>
        {runtime.busy ? '正在预留库存' : '创建签名报价'}
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
  if (!runtime.session) return '请先连接钱包并完成 SIWE 登录';
  if (!runtime.bootstrap) return '正在同步 Core 安全状态';
  if (!runtime.bootstrap.writesEnabled) return '新支付当前被 Core 安全门禁阻断';
  if (!runtime.checkoutTarget || runtime.checkoutTarget.fulfillmentMode !== runtime.fulfillmentMode) {
    return runtime.fulfillmentMode === 'DELIVERY' ? '请先验证快递目标' : '请先选择自提门店';
  }
  return '请完成当前配置';
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

const BUYER_FULFILLMENT_ACTIONS: readonly string[] = [
  'REQUEST_EXCHANGE',
  'REQUEST_DELAY',
  'CONFIRM_RECEIPT',
  'VERIFY_PICKUP',
  'OPEN_ARBITRATION',
  'OPEN_TAKEOVER',
];

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
