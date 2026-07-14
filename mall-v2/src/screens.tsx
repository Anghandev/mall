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
  ScanLine,
  ShieldAlert,
  ShoppingBag,
  Store,
  Truck,
  UserRound,
  WalletCards,
  Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import {
  DisabledAction,
  EmptyState,
  RulesDisclosure,
  ScreenHeader,
  StatusNotice,
  UnavailableValue,
} from './components';

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
          <span className="muted-label">待同步</span>
        </div>
        <div className="category-skeleton" aria-label="商品分类加载不可用">
          <span />
          <span />
          <span />
          <span />
        </div>
      </section>

      <div className="catalog-skeleton" aria-hidden="true">
        <div><span /></div>
        <div><span /></div>
        <div><span /></div>
        <div><span /></div>
      </div>

      <EmptyState title="商品目录暂不可用">
        商品、秒杀遮罩、SKU 与库存必须来自同一版本的安全配置，当前不会展示示例商品。
      </EmptyState>

      <DisabledAction reason="商品策略和库存预留未发布，结算入口已停用">
        立即购买
      </DisabledAction>
    </div>
  );
}

export function StoresScreen() {
  return (
    <div className="screen screen--stores">
      <ScreenHeader
        eyebrow="O2O STORES"
        title="线下门店"
        description="位置、营业状态与行政区划需实时校验"
      />

      <img className="store-hero" src="/brand/store-front.png" alt="阿步 24K 线下门店空间" />

      <fieldset className="location-filter" disabled>
        <legend>筛选地区</legend>
        <label>
          国家
          <select defaultValue="" disabled>
            <option value="">待同步</option>
          </select>
        </label>
        <label>
          城市
          <select defaultValue="" disabled>
            <option value="">待同步</option>
          </select>
        </label>
        <label>
          区县
          <select defaultValue="" disabled>
            <option value="">待同步</option>
          </select>
        </label>
      </fieldset>

      <StatusNotice title="位置服务不可用" tone="warning">
        尚未取得真实设备定位与门店区域数据，不显示虚构距离或最近门店。
      </StatusNotice>

      <section className="store-placeholder" aria-labelledby="nearby-store-title">
        <div className="store-placeholder__icon"><Store aria-hidden="true" size={24} /></div>
        <div>
          <h2 id="nearby-store-title">附近门店</h2>
          <p>门店名称、地址、营业时间与距离待同步</p>
        </div>
        <span className="status-pill status-pill--muted">-- km</span>
      </section>

      <div className="split-actions">
        <button className="button button--secondary" type="button" disabled>
          <Phone aria-hidden="true" size={18} />
          拨号
        </button>
        <button className="button button--secondary" type="button" disabled>
          <Navigation aria-hidden="true" size={18} />
          导航
        </button>
      </div>
      <p className="control-reason">真实设备、原生地图与 HTTPS 域名完成验收后开放</p>
    </div>
  );
}

export function AssetsScreen() {
  const orderItems = [
    { label: '待付款', icon: Clock3 },
    { label: '待发货', icon: PackageOpen },
    { label: '待收货', icon: Truck },
    { label: '售后 / 仲裁', icon: ShieldAlert },
  ];

  return (
    <div className="screen screen--assets">
      <ScreenHeader eyebrow="PERSONAL LEDGER" title="我的资产" description="消费、交付与收益状态统一对账" />

      <section className="profile-strip" aria-labelledby="profile-title">
        <div className="avatar-placeholder"><UserRound aria-hidden="true" size={24} /></div>
        <div className="profile-strip__copy">
          <h2 id="profile-title">未连接钱包</h2>
          <p>账号 ID 与链上身份待安全校验</p>
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
                <strong aria-label={`${item.label}数量暂不可用`}>--</strong>
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
  const [active, setActive] = useState('待付款');
  const tabs = ['待付款', '待发货', '待收货', '售后 / 仲裁'];

  return (
    <div className="screen screen--detail">
      <ScreenHeader eyebrow="FULFILLMENT" title="我的订单" description="交付动作仅由允许操作开放" backTo="/assets" />
      <div className="segmented-control" role="tablist" aria-label="订单状态">
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

      <StatusNotice title="订单数据暂不可用">
        订单、物流、平台接管履约和仲裁状态尚未同步，任何交付动作都不会被本地推断。
      </StatusNotice>

      <EmptyState title={`暂无可显示的${active}订单`}>
        加载完成后，物流摘要、秒杀标识和可执行操作会直接显示在订单卡片中。
      </EmptyState>

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
  const [mode, setMode] = useState<'delivery' | 'pickup'>('delivery');

  return (
    <div className="screen screen--detail screen--checkout">
      <ScreenHeader eyebrow="ORDER SETUP" title="订单配置" description="规格、数量与履约方式需完整确认" backTo="/mall" />

      <StatusNotice title="商品策略未发布" tone="warning">
        当前没有可验证的商品、SKU、签名报价或库存预留，结算保持关闭。
      </StatusNotice>

      <section className="section-block" aria-labelledby="sku-title">
        <div className="section-heading"><h2 id="sku-title">商品规格</h2><Box aria-hidden="true" size={19} /></div>
        <div className="selection-placeholder">SKU 选项待同步</div>
      </section>

      <section className="section-block" aria-labelledby="quantity-title">
        <div className="section-heading"><h2 id="quantity-title">购买数量</h2></div>
        <div className="stepper" aria-label="购买数量暂不可用">
          <button type="button" disabled aria-label="减少数量"><Minus aria-hidden="true" size={18} /></button>
          <output aria-label="数量暂不可用">--</output>
          <button type="button" disabled aria-label="增加数量"><Plus aria-hidden="true" size={18} /></button>
        </div>
      </section>

      <fieldset className="fulfillment-mode">
        <legend>履约方式</legend>
        <div className="segmented-control segmented-control--two">
          <button type="button" className={mode === 'delivery' ? 'is-active' : ''} aria-pressed={mode === 'delivery'} onClick={() => setMode('delivery')}>
            <Truck aria-hidden="true" size={17} /> 快递邮寄
          </button>
          <button type="button" className={mode === 'pickup' ? 'is-active' : ''} aria-pressed={mode === 'pickup'} onClick={() => setMode('pickup')}>
            <Store aria-hidden="true" size={17} /> 到店自提
          </button>
        </div>
      </fieldset>

      <section className="fulfillment-preview" aria-live="polite">
        {mode === 'delivery' ? <MapPinned aria-hidden="true" size={22} /> : <LocateFixed aria-hidden="true" size={22} />}
        <div>
          <h2>{mode === 'delivery' ? '默认收货地址' : '最近可用门店'}</h2>
          <p>{mode === 'delivery' ? '身份与地址数据待同步' : '真实位置与门店数据待同步'}</p>
        </div>
      </section>

      <div className="checkout-total">
        <span>签名报价总计</span>
        <strong aria-label="总计暂不可用">--</strong>
      </div>
      <DisabledAction reason="缺少签名报价、SKU 与原子库存预留">确认下单</DisabledAction>
    </div>
  );
}

export function ReviewScreen() {
  const reviewRows = [
    { icon: Package, label: '商品与最终规格', value: '待签名预留' },
    { icon: ScanLine, label: '数量与总价', value: '待签名报价' },
    { icon: Truck, label: '履约方式', value: '待确认' },
    { icon: MapPinned, label: '地址或门店', value: '待权威校验' },
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
          <div><strong>钱包广播</strong><span>待安全配置</span></div>
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
          <p>付款前将逐项展示代币、授权对象、当前额度、无限授权风险和撤销入口；零金额支付腿不会请求授权。</p>
        </div>
      </section>

      <DisabledAction reason="报价、预留、支付意图和钱包环境均未发布" icon="wallet">
        支付并广播
      </DisabledAction>
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
