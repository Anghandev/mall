import {
  bootConsole,
  api,
  signedAction,
  sendTransactionIntent,
  escapeHtml,
  formatAmount,
  shortAddress,
  downloadBlob,
  showToast,
  getSession
} from '/backstage/common.js';

const NAV_ITEMS = [
  ['dashboard', 'dashboard', '运营大盘'],
  ['product', 'package', '唯一单品'],
  ['orders', 'truck', '履约交付'],
  ['pickup', 'scan', '自提核销'],
  ['stores', 'store', '门店管理'],
  ['assets', 'wallet', '资产清算'],
  ['settings', 'settings', '系统配置'],
  ['help', 'help', '帮助中心']
];

const VIEW_META = {
  dashboard: ['运营大盘', '订单、商品、门店与资产的实时摘要'],
  product: ['唯一单品', '一店一商品，送审后由平台状态机死锁'],
  orders: ['履约交付', '筛选、发货、强制签收申请与批量输出'],
  pickup: ['自提核销', '核对订单与门店后完成二次签名核销'],
  stores: ['门店管理', '维护自提网点、行政区编码与打印终端'],
  assets: ['资产清算', '按资产拆分五态账目并发起链上 Claim'],
  settings: ['系统配置', '商家资料、结算钱包、打印机与安全审计'],
  help: ['帮助中心', '同步平台最新秒杀规则与商家规则入口']
};

const STATUS_LABELS = {
  Draft: '草稿未送审',
  PendingReview: '平台审核中',
  Approved: '审核通过',
  Scheduled: '待排期上架',
  Live: '秒杀进行中',
  SoldOut: '已售罄',
  Rejected: '审核驳回',
  Superseded: '已被替代',
  TakedownRequested: '下架审核中',
  TakenDown: '已下架',
  Withdrawn: '已撤回',
  PaidLocked: '已付款待履约',
  AwaitingShipment: '待发货',
  Shipped: '运输中',
  PickupReady: '已核销待释放',
  Completed: '已完成',
  Released: '已释放',
  Arbitration: '仲裁中',
  RefundRequested: '退款审核中',
  ForcedRefunded: '已强制退款',
  EmergencyRefunded: '已紧急退款',
  Cancelled: '已取消',
  Failed: '失败',
  Locked: '锁定中',
  Available: '可提取',
  PendingClaim: '提取确认中',
  Claimed: '已提取',
  Burned: '已销毁',
  Pending: '待提交',
  AwaitingWalletTransaction: '等待钱包交易',
  Submitted: '已提交',
  ConfigurationRequired: '待配置',
  Online: '在线',
  Offline: '离线',
  Configured: '已配置',
  Error: '异常',
  VerifiedAwaitingSettlement: '核销完成待清算',
  pending: '处理中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  expired: '已过期'
};

const ICON_PATHS = {
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  truck: '<path d="M10 17h4V5H2v12h3"/><path d="M14 9h4l4 4v4h-3"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="17.5" r="2.5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  store: '<path d="m2 7 3-4h14l3 4"/><path d="M5 13v8h14v-8"/><path d="M9 21v-6h6v6"/><path d="M2 7h20"/><path d="M6 7v2a2 2 0 0 1-4 0V7"/><path d="M10 7v2a2 2 0 0 1-4 0V7"/><path d="M14 7v2a2 2 0 0 1-4 0V7"/><path d="M18 7v2a2 2 0 0 1-4 0V7"/><path d="M22 7v2a2 2 0 0 1-4 0V7"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a3 3 0 0 0 0 6h15a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V6"/><path d="M16 13h2"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.83 1c0 2-3 2-3 4"/><path d="M12 18h.01"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5"/>',
  logout: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  alert: '<path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
};

const state = {
  context: null,
  active: 'dashboard',
  resources: new Map(),
  requestSerial: 0,
  productDraft: emptyProductDraft(),
  productSourceId: null,
  lastSubmission: null,
  productLockError: '',
  productTakedownId: '',
  orderFilters: { query: '', status: '', mode: 'all', sku: '', from: '', to: '' },
  selectedOrders: new Set(),
  orderPanel: null,
  lastPrintJob: null,
  pickupOrderId: '',
  pickupResult: null,
  storeEditor: null,
  printerStoreId: '',
  printerResult: null,
  claimConfirm: null,
  claimRetry: null,
  claimResult: null,
  claimInspection: null,
  profileResult: null
};

const LOADERS = {
  dashboard: () => api('/api/merchant/dashboard'),
  product: () => api('/api/merchant/product'),
  orders: () => api('/api/merchant/orders'),
  pickup: async () => {
    const [orders, stores] = await Promise.all([
      api('/api/merchant/orders'),
      api('/api/merchant/stores')
    ]);
    return { orders, stores };
  },
  stores: () => api('/api/merchant/stores'),
  assets: async () => {
    const [assets, claimState] = await Promise.all([
      api('/api/merchant/assets'),
      api('/api/merchant/claims')
    ]);
    return { assets, claimState };
  },
  settings: async () => {
    const [dashboard, stores, auditLogs, printJobs, printers] = await Promise.all([
      api('/api/merchant/dashboard'),
      api('/api/merchant/stores'),
      api('/api/merchant/audit-logs'),
      api('/api/merchant/print-jobs'),
      api('/api/merchant/printers')
    ]);
    return { dashboard, stores, auditLogs, printJobs, printers };
  },
  help: () => api('/api/merchant/help')
};

function icon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.chevron}</svg>`;
}

function emptyProductDraft() {
  return {
    storeId: 'default',
    title: '',
    imageUrls: '',
    descriptionHtml: '',
    fulfillmentModes: ['delivery'],
    skus: [{ name: '', settlementPriceNpl: '', stock: '' }]
  };
}

function hydrateProductDraft(submission, force = false) {
  if (!submission) {
    if (force || state.productSourceId !== null) state.productDraft = emptyProductDraft();
    state.productSourceId = null;
    return;
  }
  if (!force && state.productSourceId === submission.id) return;
  const payload = submission.payload && typeof submission.payload === 'object' ? submission.payload : {};
  const sourceSkus = Array.isArray(payload.skus) && payload.skus.length
    ? payload.skus
    : [{
        name: payload.sku || payload.skuName || '',
        settlementPriceNpl: payload.priceNpl || payload.settlementPriceNpl || '',
        stock: payload.stock ?? payload.seckillStock ?? ''
      }];
  const imageUrls = Array.isArray(payload.imageUrls)
    ? payload.imageUrls
    : (payload.imageUrl ? [payload.imageUrl] : []);
  state.productDraft = {
    storeId: submission.storeId || payload.storeId || 'default',
    title: submission.title || payload.title || '',
    imageUrls: imageUrls.filter(Boolean).join('\n'),
    descriptionHtml: payload.descriptionHtml || payload.detailHtml || payload.description || '',
    fulfillmentModes: Array.isArray(payload.fulfillmentModes) && payload.fulfillmentModes.length ? payload.fulfillmentModes : ['delivery'],
    skus: sourceSkus.map((sku) => ({
      name: String(sku.name || sku.skuName || ''),
      settlementPriceNpl: String(sku.settlementPriceNpl || sku.priceNpl || ''),
      stock: String(sku.stock ?? '')
    }))
  };
  state.productSourceId = submission.id;
}

async function render(context) {
  const changedSession = state.context && (
    state.context.address.toLowerCase() !== context.address.toLowerCase()
    || state.context.token !== context.token
  );
  state.context = context;
  if (changedSession) resetWorkspaceState();
  installMerchantStyles();
  context.root.innerHTML = renderShell(context);
  bindRootEvents(context.root);
  const requested = location.hash.slice(1);
  await navigate(VIEW_META[requested] ? requested : 'dashboard', { updateHash: false, focus: false });
}

function resetWorkspaceState() {
  state.resources.clear();
  state.selectedOrders.clear();
  state.productDraft = emptyProductDraft();
  state.productSourceId = null;
  state.lastSubmission = null;
  state.productLockError = '';
  state.productTakedownId = '';
  state.orderPanel = null;
  state.lastPrintJob = null;
  state.pickupOrderId = '';
  state.pickupResult = null;
  state.storeEditor = null;
  state.printerStoreId = '';
  state.printerResult = null;
  state.claimConfirm = null;
  state.claimRetry = null;
  state.claimResult = null;
  state.claimInspection = null;
  state.profileResult = null;
}

function renderShell(context) {
  const session = getSession('merchant');
  return `
    <div class="console-layout merchant-console">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="/api/logo" alt="24K Mall" />
          <div><b>24K 商家工作台</b><span>MERCHANT CONSOLE</span></div>
        </div>
        <nav aria-label="商家后台模块">
          ${NAV_ITEMS.map(([key, iconName, label]) => `
            <button class="nav-button" type="button" data-view="${key}" aria-current="false">
              ${icon(iconName)}<span>${label}</span>
            </button>`).join('')}
        </nav>
        <div class="sidebar-session">
          <span>SIWE 已认证 · BSC</span>
          <code title="${escapeHtml(context.address)}">${escapeHtml(shortAddress(context.address))}</code>
          <span>会话到期</span>
          <code>${escapeHtml(formatDate(session?.expiresAt))}</code>
        </div>
      </aside>
      <main class="workspace">
        <header class="topbar merchant-topbar">
          <div>
            <h1 id="merchant-view-title" tabindex="-1"></h1>
            <p id="merchant-view-subtitle"></p>
          </div>
          <div class="topbar-actions">
            <span class="session-pill" title="${escapeHtml(context.address)}"><i></i>${escapeHtml(shortAddress(context.address))}</span>
            <button class="button small" type="button" data-action="refresh" title="刷新当前模块">${icon('refresh')}<span>刷新</span></button>
            <button class="button small icon" type="button" data-action="logout" title="退出商家工作台" aria-label="退出商家工作台">${icon('logout')}</button>
          </div>
        </header>
        <div id="merchant-view" aria-live="polite"></div>
      </main>
    </div>`;
}

function bindRootEvents(root) {
  root.addEventListener('click', handleClick);
  root.addEventListener('submit', handleSubmit);
  root.addEventListener('change', handleChange);
}

async function navigate(view, options = {}) {
  if (!VIEW_META[view] || !state.context?.root?.isConnected) return;
  state.active = view;
  if (options.updateHash !== false && location.hash !== `#${view}`) {
    history.pushState(null, '', `#${view}`);
  }
  updateShellState();
  const resource = state.resources.get(view);
  if (!resource || options.force) await loadView(view, Boolean(options.force));
  else drawActiveView();
  if (options.focus !== false) requestAnimationFrame(() => document.querySelector('#merchant-view-title')?.focus({ preventScroll: true }));
}

function updateShellState() {
  const meta = VIEW_META[state.active];
  const title = document.querySelector('#merchant-view-title');
  const subtitle = document.querySelector('#merchant-view-subtitle');
  if (title) title.textContent = meta[0];
  if (subtitle) subtitle.textContent = meta[1];
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.active;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

async function loadView(view, force = false) {
  if (!force && state.resources.get(view)?.status === 'loading') return;
  const loader = LOADERS[view];
  const requestId = ++state.requestSerial;
  state.resources.set(view, { status: 'loading', requestId });
  drawActiveView();
  if (!loader) {
    state.resources.set(view, { status: 'error', error: new Error('该模块缺少读取端点'), requestId });
    return drawActiveView();
  }
  try {
    const data = await loader();
    if (state.resources.get(view)?.requestId !== requestId) return;
    if (view === 'product') {
      if (force) state.lastSubmission = null;
      if (force) state.productLockError = '';
      hydrateProductDraft(data, force);
    }
    state.resources.set(view, { status: 'success', data, requestId });
  } catch (error) {
    if (state.resources.get(view)?.requestId !== requestId) return;
    state.resources.set(view, { status: 'error', error, requestId });
  }
  if (state.active === view) drawActiveView();
}

function drawActiveView() {
  const host = document.querySelector('#merchant-view');
  if (!host) return;
  const resource = state.resources.get(state.active);
  if (!resource || resource.status === 'loading') {
    host.innerHTML = renderLoading();
    return;
  }
  if (resource.status === 'error') {
    host.innerHTML = renderError(resource.error);
    return;
  }
  const renderers = {
    dashboard: renderDashboard,
    product: renderProduct,
    orders: renderOrders,
    pickup: renderPickup,
    stores: renderStores,
    assets: renderAssets,
    settings: renderSettings,
    help: renderHelp
  };
  host.innerHTML = renderers[state.active](resource.data);
}

function renderLoading() {
  return `<section class="panel wide loading-panel" aria-label="正在加载">
    <div class="skeleton skeleton-title"></div>
    <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton skeleton-short"></div>
  </section>`;
}

function renderError(error) {
  return `<section class="panel wide error-state" role="alert">
    ${icon('alert')}
    <h3>数据加载失败</h3>
    <p>${escapeHtml(errorText(error))}</p>
    <button class="button" type="button" data-action="retry">${icon('refresh')}重试</button>
  </section>`;
}

function renderDashboard(data = {}) {
  const merchant = data.merchant && typeof data.merchant === 'object' ? data.merchant : {};
  const stats = data.stats || {};
  const assets = data.assets || {};
  const product = data.product || null;
  const paymentAsset = data.paymentAsset || 'NPL';
  const metrics = [
    ['今日待发货', stats.pendingShipments, '笔'],
    ['今日销售货款', stats.todaySalesNpl, paymentAsset],
    ['今日订单', stats.todayOrders, '笔'],
    ['今日自提核销', stats.pickupVerifications, '笔'],
    ['可提取收益', stats.claimableNpl, paymentAsset]
  ];
  return `
    <section class="dashboard-intro">
      <div><span class="eyebrow dark">MERCHANT OVERVIEW</span><h2>${escapeHtml(merchant.name || '未命名商家')}</h2><p class="dashboard-generated">数据生成于 ${escapeHtml(formatDate(data.generatedAt))}</p></div>
      <div class="connection-state"><i></i><span>${escapeHtml(statusLabel(merchant.status || 'Approved'))} · 钱包与 SIWE 会话正常</span></div>
    </section>
    <div class="metric-grid merchant-metrics">
      ${metrics.map(([label, value, unit]) => `<article class="metric"><span>${label}</span><strong>${formatMetric(value, unit)}</strong><small>来自 /api/merchant/dashboard</small></article>`).join('')}
    </div>
    <div class="content-grid">
      <section class="panel wide">
        <div class="panel-head"><div><h2>今日处理顺序</h2><p class="panel-subtitle">按履约风险从高到低进入对应模块</p></div></div>
        <div class="workflow-list">
          ${workflowRow('01', '待发货订单', `${numberText(stats.pendingShipments)} 笔等待物流单号`, 'orders')}
          ${workflowRow('02', '唯一单品状态', product ? `${statusLabel(product.status)} · ${product.title}` : '尚未提报唯一单品', 'product')}
          ${workflowRow('03', '门店自提核销', `${numberText(stats.pickupVerifications)} 笔已计入核销统计`, 'pickup')}
          ${workflowRow('04', '可提取资产', `${formatAmount(stats.claimableNpl, paymentAsset)} 可进入 Claim`, 'assets')}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>登录状态</h2><p class="panel-subtitle">当前结算身份只读</p></div><span class="badge success">已认证</span></div>
        <dl class="detail-list">
          <div><dt>角色</dt><dd>merchant</dd></div>
          <div><dt>网络</dt><dd>BNB Smart Chain · 56</dd></div>
          <div><dt>钱包</dt><dd class="mono" title="${escapeHtml(state.context.address)}">${escapeHtml(shortAddress(state.context.address))}</dd></div>
          <div><dt>会话到期</dt><dd>${escapeHtml(formatDate(getSession('merchant')?.expiresAt))}</dd></div>
        </dl>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>唯一单品</h2><p class="panel-subtitle">当前最新提报</p></div>${product ? statusBadge(product.status) : '<span class="badge">未提报</span>'}</div>
        ${product ? `<dl class="detail-list"><div><dt>商品</dt><dd>${escapeHtml(product.title)}</dd></div><div><dt>提报 ID</dt><dd class="mono">${escapeHtml(shortAddress(product.id))}</dd></div><div><dt>门店</dt><dd class="mono">${escapeHtml(product.storeId || 'default')}</dd></div><div><dt>锁定</dt><dd>${product.locked ? '是' : '否'}</dd></div></dl>` : renderInlineEmpty('当前钱包没有商品提报')}
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>商家货款五态快照</h2><p class="panel-subtitle">由 Dashboard assets 返回，计价资产 ${escapeHtml(paymentAsset)}</p></div></div>
        <div class="dashboard-asset-row">
          ${[['今日销售', assets.todaySalesNpl], ['锁定中', assets.lockedNpl], ['待结算', assets.pendingSettlementNpl], ['可提取', assets.availableNpl], ['已提取', assets.withdrawnNpl]].map(([label, value]) => `<div><span>${label}</span><strong>${formatAmount(value)}</strong></div>`).join('')}
        </div>
      </section>
    </div>`;
}

function workflowRow(index, title, detail, view) {
  return `<button class="workflow-row" type="button" data-view="${view}">
    <span class="workflow-index">${index}</span><span><b>${title}</b><small>${escapeHtml(detail)}</small></span>${icon('chevron')}
  </button>`;
}

function renderProduct(data) {
  const submission = state.lastSubmission || data || null;
  const locked = !isProductEditable(submission) || Boolean(state.productLockError);
  const canRequestTakedown = ['Approved', 'Scheduled', 'Live'].includes(String(submission?.status || ''));
  return `
    <div class="content-grid">
      <section class="panel wide product-state-strip">
        <div>
          <span class="eyebrow dark">SINGLE LISTING POLICY</span>
          <h2>${submission ? escapeHtml(submission.title) : '唯一单品提报'}</h2>
          <p class="panel-subtitle">${submission ? `提报 ID ${escapeHtml(submission.id)} · 门店 ${escapeHtml(submission.storeId || 'default')}` : '当前钱包尚未创建商品提报'}</p>
        </div>
        ${submission ? statusBadge(submission.status) : '<span class="badge info">待送审</span>'}
      </section>
      ${submission ? renderSubmissionResult(submission) : ''}
      ${state.productLockError ? `<section class="panel wide api-gap"><div>${icon('lock')}</div><div><h3>后端已拒绝本次商品操作</h3><p>${escapeHtml(state.productLockError)} 请刷新商品状态后再继续。</p></div></section>` : ''}
      <section class="panel wide">
        <div class="panel-head">
          <div><h2>商品与库存</h2><p class="panel-subtitle">草稿可反复保存，送审后由平台状态机锁定内容</p></div>
          ${locked ? `${icon('lock')}<span class="badge warning">内容已锁定</span>` : '<span class="badge info">可编辑草稿</span>'}
        </div>
        ${renderProductForm(locked, submission)}
      </section>
      ${canRequestTakedown ? renderProductTakedown(submission) : ''}
    </div>`;
}

function isProductEditable(submission) {
  if (!submission) return true;
  return !submission.locked && !['PendingReview', 'Approved', 'Scheduled', 'Live', 'TakedownRequested'].includes(String(submission.status || 'Draft'));
}

function renderProductTakedown(submission) {
  if (state.productTakedownId !== submission.id) {
    return `<section class="panel wide action-availability">
      <div><b>申请下架</b><span>平台复核通过后停止新订单，已付款订单仍继续履约</span></div>
      <button class="button danger small" type="button" data-action="open-product-takedown" data-product-id="${escapeHtml(submission.id)}">${icon('alert')}申请下架</button>
    </section>`;
  }
  return `<section class="panel wide action-panel danger-zone">
    <div class="panel-head"><div><h2>提交下架申请</h2><p class="panel-subtitle mono">${escapeHtml(submission.id)}</p></div><button class="button icon small" type="button" data-action="close-product-takedown" aria-label="关闭下架申请" title="关闭">${icon('x')}</button></div>
    <form id="product-takedown-form" class="form-grid one-column">
      <input type="hidden" name="productId" value="${escapeHtml(submission.id)}" />
      <label class="field"><span>下架原因</span><textarea name="reason" maxlength="500" rows="4" required></textarea></label>
      <div class="form-footer"><p>平台复核期间商品状态会变为下架审核中。</p><button class="button danger" type="submit">${icon('alert')}二次签名提交</button></div>
    </form>
  </section>`;
}

function renderSubmissionResult(submission) {
  return `<section class="panel wide lock-result" role="status">
    <div>${icon(submission.locked ? 'lock' : 'package')}</div>
    <div><h3>${escapeHtml(submission.message || `当前状态：${statusLabel(submission.status)}`)}</h3>
      <p>创建时间 ${escapeHtml(formatDate(submission.createdAt))} · 锁定时间 ${escapeHtml(formatDate(submission.lockedAt))}</p>
    </div>
  </section>`;
}

function renderProductForm(locked, submission) {
  const draft = state.productDraft;
  return `<form id="product-form" novalidate>
    <fieldset class="clean-fieldset" ${locked ? 'disabled' : ''}>
      <div class="form-grid">
        <label class="field"><span>门店 ID</span><input name="storeId" maxlength="96" pattern="[a-zA-Z0-9:._-]{3,96}" value="${escapeHtml(draft.storeId)}" required /></label>
        <label class="field"><span>商品标题（最多 60 字）</span><input name="title" maxlength="60" value="${escapeHtml(draft.title)}" required /></label>
        <label class="field wide"><span>主图 URL（每行一个，最多 5 个）</span><textarea name="imageUrls" rows="3">${escapeHtml(draft.imageUrls)}</textarea></label>
        <label class="field wide"><span>商品详情</span><textarea name="descriptionHtml" rows="6">${escapeHtml(draft.descriptionHtml)}</textarea></label>
      </div>
      <div class="subsection-head"><div><h3>SKU 规格矩阵</h3><p>结算资产按当前后端固定为 NPL</p></div><button class="button small" type="button" data-action="add-sku">${icon('plus')}添加规格</button></div>
      <div class="sku-editor">
        ${draft.skus.map((sku, index) => `<div class="sku-row" data-sku-index="${index}">
          <label class="field"><span>规格名称</span><input name="skuName" maxlength="80" value="${escapeHtml(sku.name)}" required /></label>
          <label class="field"><span>结算价（NPL）</span><input name="skuPrice" inputmode="decimal" min="0.000000000000000001" step="any" value="${escapeHtml(sku.settlementPriceNpl)}" required /></label>
          <label class="field"><span>秒杀库存</span><input name="skuStock" inputmode="numeric" min="1" step="1" value="${escapeHtml(sku.stock)}" required /></label>
          <button class="button icon" type="button" data-action="remove-sku" data-index="${index}" title="移除该规格" aria-label="移除第 ${index + 1} 个规格" ${draft.skus.length === 1 ? 'disabled' : ''}>${icon('trash')}</button>
        </div>`).join('')}
      </div>
      <fieldset class="mode-fieldset">
        <legend>支持履约模式</legend>
        <label><input type="checkbox" name="fulfillmentModes" value="delivery" ${draft.fulfillmentModes.includes('delivery') ? 'checked' : ''} /> 快递邮寄</label>
        <label><input type="checkbox" name="fulfillmentModes" value="pickup" ${draft.fulfillmentModes.includes('pickup') ? 'checked' : ''} /> 到店自提</label>
      </fieldset>
      <div class="form-footer">
        <p>${locked ? '当前商品内容已锁定；审核、排期或上架状态变化后，页面会按后端结果更新。' : '保存草稿与送审分别写入审计；送审成功后内容不可继续修改。'}</p>
        ${locked ? '' : `<div class="inline-actions">
          <button class="button" type="submit" data-product-action="save-draft">${icon('package')}保存草稿</button>
          <button class="button primary" type="submit" data-product-action="submit-review">${icon('send')}${submission?.id ? '保存并提交审核' : '创建草稿并提交审核'}</button>
        </div>`}
      </div>
    </fieldset>
  </form>`;
}

function renderOrders(ordersValue) {
  const orders = Array.isArray(ordersValue) ? ordersValue : [];
  pruneSelectedOrders(orders);
  const filtered = filteredOrders(orders);
  const statuses = [...new Set(orders.map((order) => String(order.status || '')).filter(Boolean))];
  const batchRows = rowsForBatch(filtered);
  return `
    <div class="content-grid">
      <section class="panel wide filter-panel">
        <div class="panel-head">
          <div><h2>订单筛选</h2><p class="panel-subtitle">筛选范围为 Merchant API 当前返回的最近 50 条订单</p></div>
          <div class="segmented" aria-label="履约模式">
            ${[['all', '全部'], ['delivery', '快递'], ['pickup', '自提']].map(([value, label]) => `<button type="button" data-action="order-mode" data-mode="${value}" class="${state.orderFilters.mode === value ? 'active' : ''}">${label}</button>`).join('')}
          </div>
        </div>
        <form id="order-filter-form" class="filter-grid">
          <label class="field"><span>订单 / 买家 / TxHash</span><input name="query" value="${escapeHtml(state.orderFilters.query)}" /></label>
          <label class="field"><span>订单状态</span><select name="status"><option value="">全部状态</option>${statuses.map((status) => `<option value="${escapeHtml(status)}" ${state.orderFilters.status === status ? 'selected' : ''}>${escapeHtml(statusLabel(status))}</option>`).join('')}</select></label>
          <label class="field"><span>开始日期</span><input type="date" name="from" value="${escapeHtml(state.orderFilters.from)}" /></label>
          <label class="field"><span>结束日期</span><input type="date" name="to" value="${escapeHtml(state.orderFilters.to)}" /></label>
          <label class="field"><span>SKU（完整导出）</span><input name="sku" value="${escapeHtml(state.orderFilters.sku)}" /></label>
          <div class="filter-actions"><button class="button" type="button" data-action="reset-order-filters">重置</button><button class="button primary" type="submit">${icon('search')}应用筛选</button></div>
        </form>
      </section>
      <section class="panel wide">
        <div class="panel-head">
          <div><h2>订单流水</h2><p class="panel-subtitle">${filtered.length} / ${orders.length} 笔；完整导出使用状态、履约、日期与 SKU 筛选</p></div>
          <div class="inline-actions">
            <button class="button small" type="button" data-action="export-excel">${icon('download')}完整 Excel</button>
            <button class="button small" type="button" data-action="export-csv">完整 CSV</button>
            <button class="button small" type="button" data-action="print-orders" ${batchRows.length ? '' : 'disabled'}>${icon('printer')}浏览器打印</button>
          </div>
        </div>
        <div class="notice warning compact" role="note">完整导出包含收件人、电话、详细地址与 SKU。下载前需使用当前商家钱包完成二次签名。</div>
        ${filtered.length ? renderOrdersTable(filtered) : renderInlineEmpty(orders.length ? '没有符合当前筛选条件的订单' : '暂无订单')}
      </section>
      ${state.lastPrintJob ? renderPrintJobResult(state.lastPrintJob) : ''}
      ${renderOrderPanel(orders)}
    </div>`;
}

function renderOrdersTable(orders) {
  return `<div class="table-wrap"><table class="orders-table">
    <caption class="sr-only">商家订单列表</caption>
    <thead><tr><th><input type="checkbox" data-select-all aria-label="选择当前全部订单" /></th><th>订单</th><th>状态</th><th>履约</th><th>买家</th><th>金额</th><th>区域</th><th>下单时间</th><th>交易</th><th>操作</th></tr></thead>
    <tbody>${orders.map((order) => {
      const id = String(order.orderId || order.id || '');
      const shipAllowed = order.fulfillmentMode !== 'pickup' && ['PaidLocked', 'AwaitingShipment'].includes(order.status);
      const pickupAllowed = order.fulfillmentMode === 'pickup' && ['PaidLocked', 'AwaitingShipment'].includes(order.status);
      const forceAllowed = ['Shipped', 'PickupReady'].includes(order.status);
      return `<tr>
        <td><input type="checkbox" data-order-select value="${escapeHtml(id)}" aria-label="选择订单 ${escapeHtml(id)}" ${state.selectedOrders.has(id) ? 'checked' : ''} /></td>
        <td><b class="mono">${escapeHtml(id)}</b></td>
        <td>${statusBadge(order.status)}</td>
        <td>${fulfillmentLabel(order.fulfillmentMode)}</td>
        <td class="mono" title="${escapeHtml(order.buyerAddress || '')}">${escapeHtml(shortAddress(order.buyerAddress || ''))}</td>
        <td>${formatAmount(order.amountNpl, 'NPL')}</td>
        <td class="mono">${escapeHtml(order.regionCode || '未返回')}</td>
        <td>${escapeHtml(formatDate(order.createdAt))}</td>
        <td>${txLink(order.txHash || order.fundTxHash)}</td>
        <td><div class="row-actions">
          ${order.fulfillmentMode === 'pickup'
            ? `<button class="button small" type="button" data-action="open-pickup" data-order-id="${escapeHtml(id)}" ${pickupAllowed ? '' : 'disabled'}>核销</button>`
            : `<button class="button small" type="button" data-action="open-ship" data-order-id="${escapeHtml(id)}" ${shipAllowed ? '' : 'disabled'}>发货</button>`}
          <button class="button small" type="button" data-action="open-force-sign" data-order-id="${escapeHtml(id)}" ${forceAllowed ? '' : 'disabled'} title="仅已发货或已核销订单可申请，7 天时限由后端复核">强制签收申请</button>
          <button class="button small icon" type="button" data-action="open-cloud-print" data-order-id="${escapeHtml(id)}" title="提交云打印任务" aria-label="打印订单 ${escapeHtml(id)}">${icon('printer')}</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function renderOrderPanel(orders) {
  if (!state.orderPanel) return '';
  const order = orders.find((item) => String(item.orderId || item.id) === state.orderPanel.orderId);
  if (!order) return '';
  const id = String(order.orderId || order.id);
  if (state.orderPanel.type === 'ship') {
    return `<section class="panel wide action-panel">
      <div class="panel-head"><div><h2>录入物流并发货</h2><p class="panel-subtitle mono">${escapeHtml(id)}</p></div><button class="button icon small" type="button" data-action="close-order-panel" aria-label="关闭发货表单" title="关闭">${icon('x')}</button></div>
      <form id="ship-order-form" class="form-grid">
        <input type="hidden" name="orderId" value="${escapeHtml(id)}" />
        <label class="field"><span>物流承运商</span><input name="carrier" maxlength="80" required /></label>
        <label class="field"><span>物流单号</span><input name="trackingNo" maxlength="120" /></label>
        <label class="check-field wide"><input type="checkbox" name="electronicWaybill" /> <span>由后端电子面单服务生成物流单号</span></label>
        <label class="field"><span>电子面单模板 ID</span><input name="templateId" maxlength="120" /></label>
        <label class="field"><span>月结账号</span><input name="monthlyAccount" maxlength="120" /></label>
        <div class="form-footer wide"><p>提交后订单由后端更新为 Shipped，并写入物流单与审计记录。</p><button class="button primary" type="submit">${icon('send')}二次签名发货</button></div>
      </form>
    </section>`;
  }
  if (state.orderPanel.type === 'print') {
    return `<section class="panel wide action-panel">
      <div class="panel-head"><div><h2>提交云打印任务</h2><p class="panel-subtitle mono">${escapeHtml(id)}</p></div><button class="button icon small" type="button" data-action="close-order-panel" aria-label="关闭打印表单" title="关闭">${icon('x')}</button></div>
      <form id="cloud-print-form" class="form-grid">
        <input type="hidden" name="orderId" value="${escapeHtml(id)}" />
        <label class="field"><span>任务类型</span><select name="jobType"><option value="${order.fulfillmentMode === 'pickup' ? 'pickup' : 'shipment'}">${order.fulfillmentMode === 'pickup' ? '自提双联小票' : '快递履约单'}</option></select></label>
        <label class="field"><span>份数</span><input name="copies" type="number" min="1" max="10" value="${order.fulfillmentMode === 'pickup' ? '2' : '1'}" ${order.fulfillmentMode === 'pickup' ? 'readonly' : ''} /></label>
        <label class="field wide"><span>打印机 Device ID</span><input name="deviceId" maxlength="120" /></label>
        <div class="form-footer wide"><p>后端会返回 Pending、Submitted、ConfigurationRequired 或 Failed 等真实任务状态。</p><button class="button primary" type="submit">${icon('printer')}二次签名提交</button></div>
      </form>
    </section>`;
  }
  return `<section class="panel wide action-panel danger-zone">
    <div class="panel-head"><div><h2>申请强制确认签收</h2><p class="panel-subtitle mono">${escapeHtml(id)}</p></div><button class="button icon small" type="button" data-action="close-order-panel" aria-label="关闭申请表单" title="关闭">${icon('x')}</button></div>
    <div class="notice warning">仅当买家超过 7 天未确认时可申请。后端会复核付款时钟并把符合条件的订单转入 Arbitration，不会直接伪造签收。</div>
    <form id="force-sign-form" class="form-grid one-column">
      <input type="hidden" name="orderId" value="${escapeHtml(id)}" />
      <label class="field"><span>申请原因</span><textarea name="reason" maxlength="300" required></textarea></label>
      <div class="form-footer"><p>申请结果仍需平台仲裁与链上 completeOrder。</p><button class="button danger" type="submit">${icon('alert')}提交仲裁申请</button></div>
    </form>
  </section>`;
}

function renderPrintJobResult(job) {
  const tone = statusTone(job.status);
  return `<section class="panel wide result-panel"><div>${icon(job.status === 'Submitted' ? 'check' : 'printer')}</div><div><h3>云打印任务：${escapeHtml(statusLabel(job.status))}</h3><p>任务 <span class="mono">${escapeHtml(job.id)}</span> · 订单 ${escapeHtml(job.orderId || '未返回')} · 尝试 ${numberText(job.attempts)} 次${job.lastError ? ` · ${escapeHtml(job.lastError)}` : ''}</p></div><span class="badge ${tone}">${escapeHtml(job.status || '未返回')}</span></section>`;
}

function renderPickup(data = {}) {
  const orders = Array.isArray(data.orders) ? data.orders.filter((order) => order.fulfillmentMode === 'pickup') : [];
  const stores = Array.isArray(data.stores) ? data.stores : [];
  const eligible = orders.filter((order) => ['PaidLocked', 'AwaitingShipment'].includes(order.status));
  const selectedId = state.pickupOrderId && eligible.some((order) => String(order.orderId || order.id) === state.pickupOrderId)
    ? state.pickupOrderId
    : String(eligible[0]?.orderId || eligible[0]?.id || '');
  return `<div class="content-grid">
    <section class="panel wide">
      <div class="panel-head"><div><h2>待核销自提单</h2><p class="panel-subtitle">核销后按当前后端状态进入 PickupReady，资产释放继续等待清算事件</p></div><span class="badge info">${orders.length} 笔</span></div>
      ${orders.length ? `<div class="table-wrap"><table><thead><tr><th>订单</th><th>门店</th><th>行政区</th><th>状态</th><th>时间</th></tr></thead><tbody>${orders.map((order) => `<tr><td class="mono">${escapeHtml(order.orderId || order.id)}</td><td class="mono">${escapeHtml(order.storeId || '未返回')}</td><td class="mono">${escapeHtml(order.regionCode || '未返回')}</td><td>${statusBadge(order.status)}</td><td>${escapeHtml(formatDate(order.updatedAt || order.createdAt))}</td></tr>`).join('')}</tbody></table></div>` : renderInlineEmpty('暂无自提订单')}
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>核销验证</h2><p class="panel-subtitle">核销码由用户订单凭证提供</p></div>${icon('scan')}</div>
      <form id="pickup-form" class="form-grid one-column">
        <label class="field"><span>待核销订单</span><select name="orderId" ${eligible.length ? '' : 'disabled'} required>${eligible.map((order) => {
          const id = String(order.orderId || order.id);
          return `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(id)} · ${escapeHtml(order.storeId || '门店未返回')}</option>`;
        }).join('')}</select></label>
        <label class="field"><span>核销码</span><input name="code" minlength="4" maxlength="64" pattern="[a-zA-Z0-9._-]{4,64}" autocomplete="off" ${eligible.length ? '' : 'disabled'} required /></label>
        <button class="button primary" type="submit" ${eligible.length ? '' : 'disabled'}>${icon('scan')}二次签名核销</button>
      </form>
      ${eligible.length ? '' : '<div class="notice compact">当前没有状态为 PaidLocked 或 AwaitingShipment 的自提订单，核销操作已禁用。</div>'}
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>核销门店</h2><p class="panel-subtitle">只展示 Merchant Stores API 返回网点</p></div></div>
      ${stores.length ? `<div class="compact-list">${stores.map((store) => `<div><span><b>${escapeHtml(store.name)}</b><small>${escapeHtml(store.address)}</small></span><code>${escapeHtml(store.regionCode)}</code></div>`).join('')}</div>` : renderInlineEmpty('暂无可核销门店')}
    </section>
    ${state.pickupResult ? `<section class="panel wide result-panel"><div>${icon('check')}</div><div><h3>核销与清算请求已创建</h3><p>订单 <span class="mono">${escapeHtml(state.pickupResult.orderId || state.pickupResult.target)}</span> · ${escapeHtml(statusLabel(state.pickupResult.status))} · 打印任务 ${escapeHtml(state.pickupResult.printJob?.status || '未返回')} · 清算 ${escapeHtml(state.pickupResult.settlementRequest?.status || '未返回')}</p></div><button class="button small" type="button" data-action="print-pickup-result">${icon('printer')}浏览器补打</button></section>` : ''}
  </div>`;
}

function renderStores(storesValue) {
  const stores = Array.isArray(storesValue) ? storesValue : [];
  return `<div class="content-grid">
    <section class="panel wide">
      <div class="panel-head"><div><h2>自提网点</h2><p class="panel-subtitle">行政区编码保存后在本工作台永久只读</p></div><button class="button primary small" type="button" data-action="new-store">${icon('plus')}新增门店</button></div>
      <div class="notice compact">保存时坐标会交给后端逆地理编码服务，服务返回的 6 位行政区编码优先于手工值；已有门店若编码变化，后端返回 STORE_REGION_CODE_LOCKED。</div>
      ${stores.length ? `<div class="table-wrap"><table><thead><tr><th>门店</th><th>行政区</th><th>地址</th><th>营业时间</th><th>电话</th><th>操作</th></tr></thead><tbody>${stores.map((store) => `<tr><td><b>${escapeHtml(store.name)}</b><small class="table-sub mono">${escapeHtml(store.id)}</small></td><td><span class="badge warning mono">${escapeHtml(store.regionCode)}</span></td><td>${escapeHtml(store.address)}</td><td>${escapeHtml(store.hours)}</td><td>${escapeHtml(store.phone)}</td><td><div class="row-actions"><button class="button small" type="button" data-action="edit-store" data-store-id="${escapeHtml(store.id)}">${icon('edit')}编辑</button><button class="button small" type="button" data-action="configure-printer" data-store-id="${escapeHtml(store.id)}">${icon('printer')}打印机</button></div></td></tr>`).join('')}</tbody></table></div>` : renderInlineEmpty('暂无门店，请先新增自提网点')}
    </section>
    ${renderStoreEditor()}
    ${renderPrinterEditor(stores)}
  </div>`;
}

function renderStoreEditor() {
  if (!state.storeEditor) return '';
  const editing = state.storeEditor.mode === 'edit';
  const store = state.storeEditor.store || {};
  return `<section class="panel wide action-panel">
    <div class="panel-head"><div><h2>${editing ? '编辑门店' : '新增门店'}</h2><p class="panel-subtitle">名称、地址和营业资料变更均需要钱包二次签名</p></div><button class="button icon small" type="button" data-action="close-store-editor" aria-label="关闭门店表单" title="关闭">${icon('x')}</button></div>
    <form id="store-form" class="form-grid">
      <label class="field"><span>门店 ID</span><input name="storeId" pattern="[a-zA-Z0-9:._-]{3,96}" maxlength="96" value="${escapeHtml(store.id || '')}" ${editing ? 'readonly' : ''} required /></label>
      <label class="field"><span>门店名称</span><input name="name" maxlength="80" value="${escapeHtml(store.name || '')}" required /></label>
      <label class="field"><span>国家</span><input name="country" value="${escapeHtml(store.country || '')}" required /></label>
      <label class="field"><span>城市</span><input name="city" value="${escapeHtml(store.city || '')}" required /></label>
      <label class="field"><span>区县</span><input name="district" value="${escapeHtml(store.district || '')}" required /></label>
      <label class="field"><span>6 位行政区编码</span><input name="regionCode" inputmode="numeric" pattern="\d{6}" maxlength="6" value="${escapeHtml(store.regionCode || '')}" ${editing ? 'readonly' : ''} required /></label>
      <label class="field wide"><span>详细地址</span><input name="address" value="${escapeHtml(store.address || '')}" required /></label>
      <label class="field"><span>营业时间</span><input name="hours" value="${escapeHtml(store.hours || '')}" required /></label>
      <label class="field"><span>服务电话</span><input name="phone" type="tel" value="${escapeHtml(store.phone || '')}" required /></label>
      <label class="field"><span>纬度</span><input name="lat" inputmode="decimal" min="-90" max="90" step="any" value="${escapeHtml(store.lat ?? '')}" required /></label>
      <label class="field"><span>经度</span><input name="lng" inputmode="decimal" min="-180" max="180" step="any" value="${escapeHtml(store.lng ?? '')}" required /></label>
      <div class="form-footer wide"><p>${editing ? `行政区 ${escapeHtml(store.regionCode)} 已锁定，提交时会强制沿用 API 原值。` : '坐标用于后端逆地理编码；手工编码仅作为服务未返回编码时的校验输入。'}</p><button class="button primary" type="submit">${icon('send')}二次签名保存</button></div>
    </form>
  </section>`;
}

function renderPrinterEditor(stores) {
  if (!state.printerStoreId) return '';
  const store = stores.find((item) => item.id === state.printerStoreId);
  return `<section class="panel wide action-panel">
    <div class="panel-head"><div><h2>绑定核销打印机</h2><p class="panel-subtitle">${escapeHtml(store?.name || state.printerStoreId)}</p></div><button class="button icon small" type="button" data-action="close-printer-editor" aria-label="关闭打印机表单" title="关闭">${icon('x')}</button></div>
    <div class="notice compact">绑定完成后可在“系统配置”查看设备列表、在线状态和最后在线时间。</div>
    <form id="printer-form" class="form-grid">
      <input type="hidden" name="storeId" value="${escapeHtml(state.printerStoreId)}" />
      <label class="field"><span>服务商</span><select name="provider"><option value="feie">飞鹅云</option><option value="yilianyun">易联云</option><option value="other">其他兼容服务</option></select></label>
      <label class="field"><span>Device ID / SN</span><input name="deviceId" maxlength="120" required /></label>
      <label class="field wide"><span>票据模板标识</span><input name="templateId" maxlength="120" /></label>
      <div class="form-footer wide"><p>敏感硬件绑定会写入审计记录。</p><button class="button primary" type="submit">${icon('printer')}二次签名绑定</button></div>
    </form>
    ${state.printerResult ? `<div class="notice success compact">接口已返回 ${escapeHtml(state.printerResult.action || 'merchant.printer.configure')}，审计状态：${escapeHtml(state.printerResult.audit || '未返回')}。</div>` : ''}
  </section>`;
}

function renderAssets(data = {}) {
  const assets = data.assets || {};
  const claimState = data.claimState || {};
  const ledger = Array.isArray(claimState.rewards) ? claimState.rewards : [];
  const claims = Array.isArray(claimState.claims) ? claimState.claims : (Array.isArray(assets.claims) ? assets.claims : []);
  const fiveStates = [
    ['今日销售货款', assets.todaySalesNpl],
    ['锁定中资产', assets.lockedNpl],
    ['待结算资产', assets.pendingSettlementNpl],
    ['可提现余额', assets.availableNpl],
    ['已提现总额', assets.withdrawnNpl]
  ];
  return `<div class="content-grid">
    <section class="panel wide">
      <div class="panel-head"><div><h2>商家货款五态</h2><p class="panel-subtitle">由 /api/merchant/assets 按商家订单与账本实时核算</p></div><span class="badge success">NPL</span></div>
      <div class="merchant-five-state">${fiveStates.map(([label, value]) => `<div><span>${label}</span><strong>${formatAmount(value)}</strong><small>NPL</small></div>`).join('')}</div>
      <div class="asset-secondary"><span>可领 NPL <b>${formatAmount(claimState.availableNpl)}</b></span><span>可领 BNM <b>${formatAmount(claimState.availableBnm)}</b></span></div>
    </section>
    <section class="panel wide">
      <div class="panel-head"><div><h2>商家收益账本</h2><p class="panel-subtitle">逐笔状态来自 Merchant Claims API，NPL 与 BNM 按资产分开展示</p></div></div>
      ${ledger.length ? `<div class="table-wrap"><table><thead><tr><th>来源</th><th>关联订单</th><th>资产</th><th>金额</th><th>状态</th><th>TxHash</th></tr></thead><tbody>${ledger.map((entry) => `<tr><td><b>${escapeHtml(entry.source || '未返回')}</b><small class="table-sub mono">${escapeHtml(entry.id || '')}</small></td><td class="mono">${escapeHtml(entry.orderId || '未返回')}</td><td>${escapeHtml(entry.assetSymbol || '未返回')}</td><td>${formatAmount(entry.amount, entry.assetSymbol)}</td><td>${statusBadge(entry.state)}</td><td>${txLink(entry.txHash)}</td></tr>`).join('')}</tbody></table></div>` : renderInlineEmpty('暂无商家收益流水')}
    </section>
    <section class="panel wide">
      <div class="panel-head"><div><h2>可提取流水</h2><p class="panel-subtitle">每笔流水经 merchant.claim.request 二次签名后返回链上 transactionIntent</p></div></div>
      ${renderClaimableLedger(ledger, claims)}
    </section>
    ${renderClaimRetry()}
    ${renderClaimInspection()}
    ${renderClaimConfirmation(ledger)}
    ${state.claimResult ? renderClaimResult(state.claimResult) : ''}
    <section class="panel wide">
      <div class="panel-head"><div><h2>提现记录</h2><p class="panel-subtitle">状态、交易哈希与 Gas 数据来自 Merchant Claims API</p></div></div>
      ${renderClaimRecords(claims)}
    </section>
  </div>`;
}

function renderClaimableLedger(ledger, claims) {
  const rows = ledger.filter((entry) => entry.state === 'Available');
  if (!rows.length) return renderInlineEmpty('当前没有 Available 流水');
  return `<div class="table-wrap"><table><thead><tr><th>来源</th><th>关联订单</th><th>资产</th><th>金额</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows.map((entry) => {
    const pendingClaim = claims.find((claim) => claim.rewardId === entry.id && isPendingClaim(claim));
    const sessionRetry = state.claimRetry?.rewardId === entry.id ? state.claimRetry : null;
    const claimId = pendingClaim?.id || sessionRetry?.claimId || '';
    const operation = claimId
      ? `<button class="button small" type="button" data-action="query-claim-status" data-claim-id="${escapeHtml(claimId)}">${icon('refresh')}查看进度</button>`
      : (sessionRetry ? `<button class="button primary small" type="button" data-action="retry-claim-transaction">${icon('wallet')}继续交易</button>` : `<button class="button primary small" type="button" data-action="prepare-claim" data-reward-id="${escapeHtml(entry.id)}">${icon('wallet')}Claim</button>`);
    return `<tr><td><b>${escapeHtml(entry.source || '未返回')}</b><small class="table-sub mono">${escapeHtml(entry.id || '')}</small></td><td class="mono">${escapeHtml(entry.orderId || '未返回')}</td><td>${escapeHtml(entry.assetSymbol || '未返回')}</td><td>${formatAmount(entry.amount, entry.assetSymbol)}</td><td>${claimId || sessionRetry ? '<span class="badge warning">请求已记录</span>' : statusBadge(entry.state)}</td><td>${operation}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderClaimRetry() {
  const retry = state.claimRetry;
  if (!retry?.request?.transactionIntent) return '';
  return `<section class="panel wide action-panel">
    <div class="panel-head"><div><h2>链上交易未完成</h2><p class="panel-subtitle mono">${escapeHtml(retry.claimId || retry.rewardId)}</p></div><span class="badge warning">待广播</span></div>
    <div class="notice warning">二次签名请求已由后端记录，但钱包交易未完成。请先检查钱包中是否已有同一笔待确认交易，再决定是否重新发送。</div>
    <div class="form-footer"><p>重试仅使用本次响应中的 transactionIntent，不重新申请 nonce，不再创建 Claim 记录。</p><button class="button primary" type="button" data-action="retry-claim-transaction">${icon('wallet')}重新发送交易</button></div>
  </section>`;
}

function renderClaimRecords(claims) {
  if (!claims.length) return renderInlineEmpty('暂无提现记录');
  return `<div class="table-wrap"><table><thead><tr><th>时间</th><th>资产</th><th>金额</th><th>状态</th><th>TxHash</th><th>Gas Used</th><th>Effective Gas Price</th><th>Gas Cost</th><th>操作</th></tr></thead><tbody>${claims.map((claim) => `<tr>
    <td>${escapeHtml(formatDate(claim.createdAt))}</td><td>${escapeHtml(claim.assetSymbol)}</td><td>${formatAmount(claim.amount, claim.assetSymbol)}</td><td>${statusBadge(claim.status)}</td><td>${txLink(claim.txHash)}</td><td>${renderClaimGasUsed(claim)}</td><td>${renderClaimGasPrice(claim)}</td><td>${renderClaimGasBnb(claim)}</td>
    <td>${isPendingClaim(claim) ? `<div class="row-actions"><button class="button small" type="button" data-action="query-claim-status" data-claim-id="${escapeHtml(claim.id)}">${icon('refresh')}查询</button><button class="button small" type="button" data-action="retry-claim-intent" data-claim-id="${escapeHtml(claim.id)}">${icon('wallet')}重试 intent</button><button class="button danger small" type="button" data-action="cancel-pending-claim" data-claim-id="${escapeHtml(claim.id)}">取消</button></div>` : '<span class="muted">已结束</span>'}</td>
  </tr>`).join('')}</tbody></table></div>`;
}

function renderClaimGasUsed(claim) {
  if (claim.gasUsed === undefined || claim.gasUsed === null || claim.gasUsed === '') return renderMissingClaimGas(claim);
  return `<span class="mono gas-value">${escapeHtml(formatGasInteger(claim.gasUsed))}</span>`;
}

function renderClaimGasPrice(claim) {
  if (claim.effectiveGasPriceWei === undefined || claim.effectiveGasPriceWei === null || claim.effectiveGasPriceWei === '') return renderMissingClaimGas(claim);
  const wei = String(claim.effectiveGasPriceWei);
  return `<span class="gas-value"><b class="mono">${escapeHtml(wei)} Wei</b><small>${escapeHtml(formatWeiAsGwei(wei))} Gwei</small></span>`;
}

function renderClaimGasBnb(claim) {
  if (claim.gasBnb === undefined || claim.gasBnb === null || claim.gasBnb === '') return renderMissingClaimGas(claim);
  const numeric = Number(claim.gasBnb);
  const value = Number.isFinite(numeric) ? numeric.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 12 }) : String(claim.gasBnb);
  return `<span class="mono gas-value">${escapeHtml(value)} BNB</span>`;
}

function renderMissingClaimGas(claim) {
  return `<span class="muted">${isPendingClaim(claim) ? '待链上确认' : 'notConfigured'}</span>`;
}

function formatGasInteger(value) {
  try {
    return BigInt(String(value)).toLocaleString('en-US');
  } catch {
    return String(value);
  }
}

function formatWeiAsGwei(value) {
  try {
    const wei = BigInt(String(value));
    const whole = wei / 1_000_000_000n;
    const fraction = String(wei % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  } catch {
    return 'notConfigured';
  }
}

function isPendingClaim(claim) {
  return ['pending', 'pendingclaim', 'awaitingwallettransaction'].includes(String(claim?.status || '').toLowerCase());
}

function renderClaimInspection() {
  const inspection = state.claimInspection;
  if (!inspection) return '';
  if (inspection.status === 'loading') {
    return `<section class="panel wide result-panel" role="status"><div>${icon('refresh')}</div><div><h3>正在查询 Claim 状态</h3><p class="mono">${escapeHtml(inspection.claimId)}</p></div><span class="badge warning">查询中</span></section>`;
  }
  if (inspection.status === 'error') {
    return `<section class="panel wide error-state compact-error" role="alert">${icon('alert')}<h3>Claim 状态查询失败</h3><p>${escapeHtml(errorText(inspection.error))}</p><button class="button" type="button" data-action="query-claim-status" data-claim-id="${escapeHtml(inspection.claimId)}">${icon('refresh')}重试查询</button></section>`;
  }
  const result = inspection.data || {};
  const claim = result.claim && typeof result.claim === 'object' ? result.claim : result;
  return `<section class="panel wide result-panel"><div>${icon(isPendingClaim(claim) ? 'refresh' : 'check')}</div><div><h3>Claim 状态：${escapeHtml(statusLabel(claim.status))}</h3><p>记录 <span class="mono">${escapeHtml(claim.id || inspection.claimId)}</span> · 更新 ${escapeHtml(formatDate(claim.updatedAt || result.updatedAt || claim.createdAt))} · 到期 ${escapeHtml(formatDate(claim.expiresAt))}</p><div class="claim-gas-summary"><span>Gas Used ${renderClaimGasUsed(claim)}</span><span>Effective Price ${renderClaimGasPrice(claim)}</span><span>Gas Cost ${renderClaimGasBnb(claim)}</span></div></div>${claim.txHash ? txLink(claim.txHash) : statusBadge(claim.status)}</section>`;
}

function renderClaimConfirmation(ledger) {
  if (!state.claimConfirm) return '';
  const entry = ledger.find((item) => item.id === state.claimConfirm.rewardId && item.state === 'Available');
  if (!entry) return '';
  return `<section class="panel wide action-panel">
    <div class="panel-head"><div><h2>确认链上 Claim</h2><p class="panel-subtitle mono">${escapeHtml(entry.id)}</p></div><button class="button icon small" type="button" data-action="cancel-claim" aria-label="取消 Claim" title="取消">${icon('x')}</button></div>
    <div class="claim-review"><div><span>资产</span><b>${escapeHtml(entry.assetSymbol || '未返回')}</b></div><div><span>金额</span><b>${formatAmount(entry.amount, entry.assetSymbol)}</b></div><div><span>账目状态</span><b>${escapeHtml(statusLabel(entry.state))}</b></div><div><span>来源</span><b>${escapeHtml(entry.source || '未返回')}</b></div></div>
    <div class="notice warning">确认后调用 merchant.claim.request 完成二次签名与 claim 记账，再使用同一响应的 transactionIntent 广播。若后端未返回交易 intent，页面会停止。</div>
    <div class="form-footer"><p>钱包会分别请求二次签名和链上交易确认。</p><button class="button primary" type="button" data-action="confirm-claim">${icon('wallet')}确认并唤起钱包</button></div>
  </section>`;
}

function renderClaimResult(result) {
  return `<section class="panel wide result-panel"><div>${icon('check')}</div><div><h3>链上交易已广播并确认</h3><p>交易哈希：<span class="mono">${escapeHtml(shortAddress(result.transaction?.transactionHash || ''))}</span> · 审计动作：merchant.claim.request</p></div>${result.transaction?.explorerUrl ? `<a class="button small" href="${escapeHtml(result.transaction.explorerUrl)}" target="_blank" rel="noreferrer">${icon('external')}BscScan</a>` : ''}</section>`;
}

function renderSettings(data = {}) {
  const dashboard = data.dashboard || {};
  const merchant = dashboard.merchant && typeof dashboard.merchant === 'object' ? dashboard.merchant : {};
  const profile = merchant.profile && typeof merchant.profile === 'object' ? merchant.profile : {};
  const stores = Array.isArray(data.stores) ? data.stores : [];
  const auditLogs = Array.isArray(data.auditLogs) ? data.auditLogs : [];
  const printJobs = Array.isArray(data.printJobs) ? data.printJobs : [];
  const printers = Array.isArray(data.printers) ? data.printers : (Array.isArray(data.printers?.printers) ? data.printers.printers : []);
  return `<div class="content-grid">
    <section class="panel">
      <div class="panel-head"><div><h2>店铺资料</h2><p class="panel-subtitle">资料更新需当前商家钱包二次签名</p></div>${statusBadge(merchant.status)}</div>
      <form id="profile-form" class="form-grid one-column">
        <label class="field"><span>店铺名称</span><input name="name" maxlength="80" value="${escapeHtml(merchant.name || '')}" required /></label>
        <label class="field"><span>店铺 Logo URL</span><input name="logoUrl" type="url" maxlength="500" value="${escapeHtml(profile.logoUrl || '')}" /></label>
        <label class="field"><span>联系电话</span><input name="contactPhone" type="tel" maxlength="24" value="${escapeHtml(profile.contactPhone || '')}" /></label>
        <label class="field"><span>客服链接</span><input name="supportUrl" type="url" maxlength="500" value="${escapeHtml(profile.supportUrl || '')}" /></label>
        <label class="field"><span>店铺公告</span><textarea name="announcement" maxlength="500" rows="4">${escapeHtml(profile.announcement || '')}</textarea></label>
        <div class="form-footer"><p>结算钱包与审核状态不可在此修改。</p><button class="button primary" type="submit">${icon('send')}二次签名保存</button></div>
      </form>
      ${state.profileResult ? `<div class="notice success compact" role="status">店铺资料已保存，审计状态：${escapeHtml(state.profileResult.audit || '已写入')}。</div>` : ''}
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>打印机配置</h2><p class="panel-subtitle">选择门店后进行二次签名绑定</p></div><span class="badge info">${printers.length} 台</span></div>
      ${stores.length ? `<label class="field"><span>门店</span><select id="settings-store-select">${stores.map((store) => `<option value="${escapeHtml(store.id)}">${escapeHtml(store.name)}</option>`).join('')}</select></label><button class="button primary settings-printer-button" type="button" data-action="settings-printer">${icon('printer')}配置打印机</button>` : renderInlineEmpty('暂无门店，无法绑定打印机')}
    </section>
    <section class="panel wide">
      <div class="panel-head"><div><h2>打印机状态</h2><p class="panel-subtitle">设备列表与在线状态来自 Merchant Printers API</p></div><button class="button small" type="button" data-action="refresh-printers">${icon('refresh')}刷新状态</button></div>
      ${renderPrinters(printers, stores)}
    </section>
    <section class="panel wide">
      <div class="panel-head"><div><h2>云打印任务</h2><p class="panel-subtitle">真实服务商提交状态与失败原因</p></div><span class="badge info">${printJobs.length} 条</span></div>
      ${printJobs.length ? `<div class="table-wrap"><table><thead><tr><th>创建时间</th><th>任务</th><th>订单</th><th>类型 / 份数</th><th>状态</th><th>服务商任务</th><th>失败原因</th></tr></thead><tbody>${printJobs.map((job) => `<tr><td>${escapeHtml(formatDate(job.createdAt))}</td><td class="mono">${escapeHtml(job.id)}</td><td class="mono">${escapeHtml(job.orderId || '未返回')}</td><td>${escapeHtml(job.jobType)} · ${numberText(job.copies)}</td><td>${statusBadge(job.status)}</td><td class="mono">${escapeHtml(job.providerJobId || '未返回')}</td><td>${escapeHtml(job.lastError || '')}</td></tr>`).join('')}</tbody></table></div>` : renderInlineEmpty('暂无云打印任务')}
    </section>
    <section class="panel wide">
      <div class="panel-head"><div><h2>操作日志</h2><p class="panel-subtitle">操作时间、动作、模块、详情与签名哈希</p></div><span class="badge info">${auditLogs.length} 条</span></div>
      ${auditLogs.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>目标</th><th>详情</th><th>签名哈希</th></tr></thead><tbody>${auditLogs.map((log) => `<tr><td>${escapeHtml(formatDate(log.createdAt))}</td><td class="mono">${escapeHtml(log.action)}</td><td class="mono">${escapeHtml(log.target)}</td><td>${escapeHtml(compactValue(log.payload))}</td><td class="mono">${escapeHtml(shortAddress(log.payload?.secondarySignatureHash || '未返回'))}</td></tr>`).join('')}</tbody></table></div>` : renderInlineEmpty('当前商家暂无操作日志')}
    </section>
  </div>`;
}

function renderPrinters(printers, stores) {
  if (!printers.length) return renderInlineEmpty('当前商家尚未绑定打印机');
  const storeNames = new Map(stores.map((store) => [store.id, store.name]));
  return `<div class="table-wrap"><table><thead><tr><th>设备</th><th>门店</th><th>服务商</th><th>模板</th><th>状态</th><th>最后在线</th></tr></thead><tbody>${printers.map((printer) => {
    const status = printer.status || (printer.online === true ? 'Online' : (printer.online === false ? 'Offline' : 'Unknown'));
    return `<tr><td><b>${escapeHtml(printer.name || printer.deviceName || '打印机')}</b><small class="table-sub mono">${escapeHtml(printer.deviceId || printer.id || '未返回')}</small></td><td>${escapeHtml(storeNames.get(printer.storeId) || printer.storeName || printer.storeId || '未绑定')}</td><td>${escapeHtml(printer.provider || '未返回')}</td><td class="mono">${escapeHtml(printer.templateId || '未配置')}</td><td>${statusBadge(status)}</td><td>${escapeHtml(formatDate(printer.lastSeenAt || printer.updatedAt))}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderHelp(data = {}) {
  const policies = Array.isArray(data.policies) ? data.policies : [];
  const support = data.support && typeof data.support === 'object' ? data.support : {};
  const channels = Array.isArray(support.channels) ? support.channels : [];
  return `<div class="content-grid">
    <section class="panel wide rules-header">
      <div><span class="eyebrow dark">MERCHANT RULES</span><h2>商家规则中心</h2><p>更新 ${escapeHtml(formatDate(data.updatedAt))} · /api/merchant/help</p></div>
      <span class="badge info">API 同步</span>
    </section>
    <section class="panel wide">
      <div class="panel-head"><div><h2>规则正文</h2><p class="panel-subtitle">正文按 API 原文显示，不执行富文本脚本</p></div></div>
      ${data.seckillRules ? `<pre class="rules-body">${escapeHtml(data.seckillRules)}</pre>` : renderInlineEmpty('帮助 API 未返回秒杀规则正文')}
    </section>
    <section class="panel wide">
      <div class="panel-head"><div><h2>商家须知</h2><p class="panel-subtitle">商品死锁、履约、签名与风控政策</p></div></div>
      ${policies.length ? `<ol class="number-list">${policies.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>` : renderInlineEmpty('帮助 API 未返回商家政策')}
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>支持渠道</h2><p class="panel-subtitle">由平台商家支持配置返回</p></div></div>
      ${channels.length ? `<ul class="plain-list">${channels.map((channel) => `<li>${icon('check')}<span>${escapeHtml(compactValue(channel))}</span></li>`).join('')}</ul>` : renderInlineEmpty('平台尚未配置商家支持渠道')}
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>规则状态</h2><p class="panel-subtitle">来自当前 Help API 响应</p></div><span class="badge success">已同步</span></div>
      <dl class="detail-list"><div><dt>规则正文</dt><dd>${data.seckillRules ? '已返回' : '未返回'}</dd></div><div><dt>商家政策</dt><dd>${policies.length} 条</dd></div><div><dt>支持渠道</dt><dd>${channels.length} 个</dd></div></dl>
    </section>
  </div>`;
}

async function handleClick(event) {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) return navigate(viewButton.dataset.view);
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'refresh') return navigate(state.active, { force: true, updateHash: false, focus: false });
  if (action === 'retry') return navigate(state.active, { force: true, updateHash: false });
  if (action === 'logout') return state.context.logout();
  if (action === 'add-sku') return addSku();
  if (action === 'remove-sku') return removeSku(Number(button.dataset.index));
  if (action === 'order-mode') {
    state.orderFilters.mode = button.dataset.mode || 'all';
    return drawActiveView();
  }
  if (action === 'reset-order-filters') {
    state.orderFilters = { query: '', status: '', mode: 'all', sku: '', from: '', to: '' };
    return drawActiveView();
  }
  if (action === 'open-ship') {
    state.orderPanel = { type: 'ship', orderId: button.dataset.orderId };
    return drawActiveView();
  }
  if (action === 'open-force-sign') {
    state.orderPanel = { type: 'force', orderId: button.dataset.orderId };
    return drawActiveView();
  }
  if (action === 'open-cloud-print') {
    state.orderPanel = { type: 'print', orderId: button.dataset.orderId };
    return drawActiveView();
  }
  if (action === 'close-order-panel') {
    state.orderPanel = null;
    return drawActiveView();
  }
  if (action === 'open-pickup') {
    state.pickupOrderId = button.dataset.orderId || '';
    return navigate('pickup');
  }
  if (action === 'export-excel') return exportOrders('excel', button);
  if (action === 'export-csv') return exportOrders('csv', button);
  if (action === 'print-orders') return printOrders();
  if (action === 'print-pickup-result') return printPickupResult();
  if (action === 'open-product-takedown') {
    state.productTakedownId = button.dataset.productId || '';
    return drawActiveView();
  }
  if (action === 'close-product-takedown') {
    state.productTakedownId = '';
    return drawActiveView();
  }
  if (action === 'new-store') {
    state.storeEditor = { mode: 'new', store: {} };
    state.printerStoreId = '';
    return drawActiveView();
  }
  if (action === 'edit-store') return openStoreEditor(button.dataset.storeId);
  if (action === 'close-store-editor') {
    state.storeEditor = null;
    return drawActiveView();
  }
  if (action === 'configure-printer') {
    state.printerStoreId = button.dataset.storeId || '';
    state.storeEditor = null;
    state.printerResult = null;
    return drawActiveView();
  }
  if (action === 'close-printer-editor') {
    state.printerStoreId = '';
    state.printerResult = null;
    return drawActiveView();
  }
  if (action === 'settings-printer') return openSettingsPrinter();
  if (action === 'refresh-printers') return navigate('settings', { force: true, updateHash: false, focus: false });
  if (action === 'prepare-claim') {
    state.claimConfirm = { rewardId: button.dataset.rewardId };
    return drawActiveView();
  }
  if (action === 'cancel-claim') {
    state.claimConfirm = null;
    return drawActiveView();
  }
  if (action === 'confirm-claim') return runClaim(button);
  if (action === 'retry-claim-transaction') return retryClaimTransaction(button);
  if (action === 'query-claim-status') return queryClaimStatus(button.dataset.claimId);
  if (action === 'retry-claim-intent') return retryPendingClaimIntent(button, button.dataset.claimId);
  if (action === 'cancel-pending-claim') return cancelPendingClaim(button, button.dataset.claimId);
}

async function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const submitter = event.submitter || form.querySelector('[type="submit"]');
  if (form.id === 'product-form') return submitProduct(form, submitter);
  if (form.id === 'product-takedown-form') return requestProductTakedown(form, submitter);
  if (form.id === 'order-filter-form') {
    const values = Object.fromEntries(new FormData(form));
    state.orderFilters = { ...state.orderFilters, query: values.query || '', status: values.status || '', sku: values.sku || '', from: values.from || '', to: values.to || '' };
    return drawActiveView();
  }
  if (form.id === 'ship-order-form') return submitShipment(form, submitter);
  if (form.id === 'force-sign-form') return submitForceSign(form, submitter);
  if (form.id === 'cloud-print-form') return submitCloudPrint(form, submitter);
  if (form.id === 'pickup-form') return submitPickup(form, submitter);
  if (form.id === 'store-form') return submitStore(form, submitter);
  if (form.id === 'printer-form') return submitPrinter(form, submitter);
  if (form.id === 'profile-form') return submitProfile(form, submitter);
}

function handleChange(event) {
  if (event.target.matches('[data-order-select]')) {
    if (event.target.checked) state.selectedOrders.add(event.target.value);
    else state.selectedOrders.delete(event.target.value);
  }
  if (event.target.matches('[data-select-all]')) {
    document.querySelectorAll('[data-order-select]').forEach((checkbox) => {
      checkbox.checked = event.target.checked;
      if (checkbox.checked) state.selectedOrders.add(checkbox.value);
      else state.selectedOrders.delete(checkbox.value);
    });
  }
}

function addSku() {
  captureProductDraft();
  state.productDraft.skus.push({ name: '', settlementPriceNpl: '', stock: '' });
  drawActiveView();
  requestAnimationFrame(() => document.querySelector('.sku-row:last-child input')?.focus());
}

function removeSku(index) {
  captureProductDraft();
  if (state.productDraft.skus.length <= 1 || !state.productDraft.skus[index]) return;
  state.productDraft.skus.splice(index, 1);
  drawActiveView();
}

function captureProductDraft(form = document.querySelector('#product-form')) {
  if (!form) return state.productDraft;
  const rows = [...form.querySelectorAll('.sku-row')];
  state.productDraft = {
    storeId: form.elements.storeId?.value.trim() || 'default',
    title: form.elements.title?.value.trim() || '',
    imageUrls: form.elements.imageUrls?.value || '',
    descriptionHtml: form.elements.descriptionHtml?.value || '',
    fulfillmentModes: [...form.querySelectorAll('[name="fulfillmentModes"]:checked')].map((input) => input.value),
    skus: rows.map((row) => ({
      name: row.querySelector('[name="skuName"]')?.value.trim() || '',
      settlementPriceNpl: row.querySelector('[name="skuPrice"]')?.value.trim() || '',
      stock: row.querySelector('[name="skuStock"]')?.value.trim() || ''
    }))
  };
  return state.productDraft;
}

async function submitProduct(form, button) {
  let current = null;
  let operation = 'save-draft';
  let payload = null;
  let savedDraft = null;
  try {
    const draft = captureProductDraft(form);
    payload = validateProductDraft(draft);
    current = state.lastSubmission || state.resources.get('product')?.data || null;
    operation = button?.dataset.productAction || 'save-draft';
    let result;
    await busy(button, operation === 'submit-review' ? '保存并送审...' : '保存草稿...', async () => {
      savedDraft = await signedAction('merchant.product.draft', payload, '/api/merchant/products/drafts', { sendTransaction: false });
      if (operation !== 'submit-review') {
        result = savedDraft;
        return;
      }
      const productId = savedDraft?.id || savedDraft?.productId || current?.id;
      if (!productId) throw new Error('PRODUCT_DRAFT_ID_MISSING');
      result = await signedAction('merchant.product.submit-review', { productId }, `/api/merchant/products/${encodeURIComponent(productId)}/submit-review`, { sendTransaction: false });
    });
    const resolvedId = result?.id || result?.productId || savedDraft?.id || savedDraft?.productId || current?.id;
    state.lastSubmission = {
      ...(current || {}),
      ...(savedDraft || {}),
      ...(result || {}),
      ...(resolvedId ? { id: resolvedId } : {}),
      status: result?.status || savedDraft?.status || current?.status || (operation === 'submit-review' ? 'PendingReview' : 'Draft'),
      locked: result?.locked ?? (operation === 'submit-review'),
      payload
    };
    state.productLockError = '';
    state.productSourceId = state.lastSubmission.id || state.lastSubmission.productId || null;
    showToast(result?.message || (operation === 'submit-review' ? '商品已提交平台审核' : '商品草稿已保存'));
    state.resources.delete('dashboard');
    drawActiveView();
  } catch (error) {
    if (savedDraft) {
      state.lastSubmission = { ...(current || {}), ...savedDraft, payload };
      state.productSourceId = savedDraft.id || savedDraft.productId || current?.id || null;
      drawActiveView();
      showToast(`草稿已保存，但送审未完成：${errorText(error)}`, 'error');
      return;
    }
    if (error?.message === 'MERCHANT_SINGLE_PRODUCT_LOCKED') {
      state.lastSubmission = null;
      state.productLockError = errorText(error);
      drawActiveView();
    }
    showToast(errorText(error), 'error');
  }
}

async function requestProductTakedown(form, button) {
  const values = Object.fromEntries(new FormData(form));
  const productId = String(values.productId || '');
  const reason = String(values.reason || '').trim();
  if (!productId) return showToast('商品 ID 缺失，请刷新后重试', 'error');
  if (!reason) return showToast('请填写下架原因', 'error');
  try {
    const result = await busy(button, '提交申请...', () => signedAction('merchant.product.takedown', { productId, reason }, `/api/merchant/products/${encodeURIComponent(productId)}/takedown`, { sendTransaction: false }));
    state.lastSubmission = { ...(state.lastSubmission || state.resources.get('product')?.data || {}), ...result };
    state.productTakedownId = '';
    state.resources.delete('dashboard');
    showToast(result.message || '下架申请已提交');
    drawActiveView();
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

function validateProductDraft(draft) {
  if (!/^[a-zA-Z0-9:._-]{3,96}$/.test(draft.storeId)) throw new Error('门店 ID 需为 3 至 96 位字母、数字或 : . _ -');
  if (!draft.title || draft.title.length > 60) throw new Error('商品标题需为 1 至 60 个字符');
  if (!draft.fulfillmentModes.length) throw new Error('至少选择一种履约模式');
  const imageUrls = draft.imageUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (imageUrls.length > 5) throw new Error('主图最多 5 张');
  for (const url of imageUrls) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      throw new Error(`主图 URL 无效：${url}`);
    }
  }
  if (!draft.skus.length) throw new Error('至少保留一个 SKU');
  const skus = draft.skus.map((sku, index) => {
    const price = Number(sku.settlementPriceNpl);
    const stock = Number(sku.stock);
    if (!sku.name) throw new Error(`第 ${index + 1} 个 SKU 缺少规格名称`);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`第 ${index + 1} 个 SKU 结算价必须大于 0`);
    if (!Number.isSafeInteger(stock) || stock <= 0) throw new Error(`第 ${index + 1} 个 SKU 库存必须为正整数`);
    return { name: sku.name, settlementPriceNpl: String(sku.settlementPriceNpl), stock };
  });
  const stock = skus.reduce((total, sku) => total + sku.stock, 0);
  return {
    storeId: draft.storeId,
    title: draft.title,
    sku: skus[0].name,
    priceNpl: skus[0].settlementPriceNpl,
    stock,
    seckillStock: stock,
    skus,
    fulfillmentModes: draft.fulfillmentModes,
    imageUrl: imageUrls[0] || undefined,
    imageUrls,
    descriptionHtml: draft.descriptionHtml
  };
}

async function submitShipment(form, button) {
  const values = Object.fromEntries(new FormData(form));
  const orderId = String(values.orderId || '');
  const electronicWaybill = Boolean(form.elements.electronicWaybill?.checked);
  const payload = {
    carrier: String(values.carrier || '').trim(),
    trackingNo: String(values.trackingNo || '').trim(),
    electronicWaybill,
    templateId: String(values.templateId || '').trim(),
    monthlyAccount: String(values.monthlyAccount || '').trim()
  };
  if (!payload.carrier || (!payload.trackingNo && !electronicWaybill)) return showToast('请填写物流单号，或启用电子面单生成', 'error');
  try {
    const result = await busy(button, '等待二次签名...', () => signedAction('merchant.order.ship', payload, `/api/merchant/orders/${encodeURIComponent(orderId)}/ship`));
    showToast(`订单 ${result.orderId || orderId} 已更新为 ${statusLabel(result.status)}`);
    state.orderPanel = null;
    invalidateAfterFulfillment();
    await loadView('orders', true);
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

async function submitCloudPrint(form, button) {
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    orderId: String(values.orderId || ''),
    jobType: String(values.jobType || ''),
    copies: Number(values.copies || 1),
    deviceId: String(values.deviceId || '').trim() || undefined
  };
  try {
    state.lastPrintJob = await busy(button, '等待二次签名...', () => signedAction('merchant.print.submit', payload, '/api/merchant/print-jobs'));
    state.orderPanel = null;
    state.resources.delete('settings');
    const tone = state.lastPrintJob.status === 'Failed' ? 'error' : (state.lastPrintJob.status === 'ConfigurationRequired' ? 'warning' : 'success');
    showToast(`打印任务状态：${statusLabel(state.lastPrintJob.status)}`, tone);
    drawActiveView();
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

async function submitForceSign(form, button) {
  const values = Object.fromEntries(new FormData(form));
  const orderId = String(values.orderId || '');
  const payload = { reason: String(values.reason || '').trim() };
  if (!payload.reason) return showToast('请填写申请原因', 'error');
  try {
    const result = await busy(button, '等待二次签名...', () => signedAction('merchant.order.force-sign-request', payload, `/api/merchant/orders/${encodeURIComponent(orderId)}/force-sign-request`));
    showToast(`申请已进入 ${statusLabel(result.status)}`);
    state.orderPanel = null;
    invalidateAfterFulfillment();
    await loadView('orders', true);
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

async function submitPickup(form, button) {
  const values = Object.fromEntries(new FormData(form));
  const resource = state.resources.get('pickup')?.data || {};
  const order = (resource.orders || []).find((item) => String(item.orderId || item.id) === values.orderId);
  if (!order) return showToast('所选订单已不在待核销列表，请刷新', 'error');
  const payload = { orderId: String(values.orderId), code: String(values.code || '').trim(), ...(order.storeId ? { storeId: order.storeId } : {}) };
  if (!/^[a-zA-Z0-9._-]{4,64}$/.test(payload.code)) return showToast('核销码格式无效', 'error');
  try {
    state.pickupResult = await busy(button, '等待二次签名...', () => signedAction('merchant.pickup.verify', payload, '/api/merchant/pickup/verify'));
    showToast(`订单 ${state.pickupResult.orderId || payload.orderId} 核销接口已返回`);
    invalidateAfterFulfillment();
    await loadView('pickup', true);
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

function invalidateAfterFulfillment() {
  state.resources.delete('dashboard');
  state.resources.delete('assets');
  state.resources.delete('settings');
}

function openStoreEditor(storeId) {
  const stores = state.resources.get('stores')?.data || [];
  const store = stores.find((item) => item.id === storeId);
  if (!store) return showToast('门店数据已变化，请刷新', 'error');
  state.storeEditor = { mode: 'edit', store };
  state.printerStoreId = '';
  drawActiveView();
}

async function submitStore(form, button) {
  const values = Object.fromEntries(new FormData(form));
  const editing = state.storeEditor?.mode === 'edit';
  const existing = state.storeEditor?.store || {};
  const payload = {
    storeId: String(values.storeId || '').trim(),
    name: String(values.name || '').trim(),
    country: String(values.country || '').trim(),
    city: String(values.city || '').trim(),
    district: String(values.district || '').trim(),
    regionCode: editing ? String(existing.regionCode) : String(values.regionCode || '').trim(),
    address: String(values.address || '').trim(),
    hours: String(values.hours || '').trim(),
    phone: String(values.phone || '').trim(),
    lat: Number(values.lat),
    lng: Number(values.lng)
  };
  try {
    validateStore(payload);
    const result = await busy(button, '等待二次签名...', () => signedAction('merchant.store.upsert', payload, '/api/merchant/stores'));
    showToast(`门店配置已写入，审计状态：${result.audit || '未返回'}`);
    state.storeEditor = null;
    state.resources.delete('pickup');
    state.resources.delete('settings');
    await loadView('stores', true);
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

function validateStore(payload) {
  if (!/^[a-zA-Z0-9:._-]{3,96}$/.test(payload.storeId)) throw new Error('门店 ID 格式无效');
  if (!payload.name || !payload.address || !payload.hours || !payload.phone) throw new Error('请完整填写门店名称、地址、营业时间和电话');
  if (!/^\d{6}$/.test(payload.regionCode)) throw new Error('行政区编码必须为 6 位数字');
  if (!Number.isFinite(payload.lat) || Math.abs(payload.lat) > 90) throw new Error('纬度无效');
  if (!Number.isFinite(payload.lng) || Math.abs(payload.lng) > 180) throw new Error('经度无效');
}

function openSettingsPrinter() {
  const select = document.querySelector('#settings-store-select');
  if (!select?.value) return showToast('请先选择门店', 'error');
  state.printerStoreId = select.value;
  state.printerResult = null;
  navigate('stores');
}

async function submitPrinter(form, button) {
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    storeId: String(values.storeId || ''),
    provider: String(values.provider || ''),
    deviceId: String(values.deviceId || '').trim(),
    templateId: String(values.templateId || '').trim()
  };
  if (!payload.storeId || !payload.deviceId) return showToast('门店和 Device ID 不能为空', 'error');
  try {
    state.printerResult = await busy(button, '等待二次签名...', () => signedAction('merchant.printer.configure', payload, '/api/merchant/printer'));
    showToast('打印机配置请求已写入审计');
    drawActiveView();
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

async function submitProfile(form, button) {
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    name: String(values.name || '').trim(),
    logoUrl: String(values.logoUrl || '').trim(),
    contactPhone: String(values.contactPhone || '').trim(),
    supportUrl: String(values.supportUrl || '').trim(),
    announcement: String(values.announcement || '').trim()
  };
  if (!payload.name) return showToast('店铺名称不能为空', 'error');
  if (payload.contactPhone && !/^\+?[0-9 ()-]{6,24}$/.test(payload.contactPhone)) return showToast('联系电话格式无效', 'error');
  try {
    state.profileResult = await busy(button, '等待二次签名...', () => signedAction('merchant.profile.update', payload, '/api/merchant/profile', { method: 'PATCH', sendTransaction: false }));
    state.resources.delete('dashboard');
    showToast(state.profileResult.message || '店铺资料已保存');
    await loadView('settings', true);
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

async function queryClaimStatus(claimId) {
  const id = String(claimId || '');
  if (!id) return showToast('Claim ID 缺失，请刷新后重试', 'error');
  state.claimInspection = { claimId: id, status: 'loading' };
  drawActiveView();
  try {
    const data = await api(`/api/merchant/claims/${encodeURIComponent(id)}/status`);
    state.claimInspection = { claimId: id, status: 'success', data };
  } catch (error) {
    state.claimInspection = { claimId: id, status: 'error', error };
    showToast(errorText(error), 'error');
  }
  drawActiveView();
}

async function retryPendingClaimIntent(button, claimId) {
  const id = String(claimId || '');
  if (!id) return showToast('Claim ID 缺失，请刷新后重试', 'error');
  const claims = state.resources.get('assets')?.data?.claimState?.claims || [];
  const claim = claims.find((item) => item.id === id);
  let request = null;
  try {
    await busy(button, '重新获取 intent...', async () => {
      request = await signedAction('merchant.claim.retry', { claimId: id }, `/api/merchant/claims/${encodeURIComponent(id)}/retry-intent`, { sendTransaction: false });
      if (!request.transactionIntent && request.intent) request = { ...request, transactionIntent: request.intent };
      if (!request.transactionIntent) throw new Error('CLAIM_TRANSACTION_INTENT_MISSING');
      state.claimRetry = { claimId: id, rewardId: claim?.rewardId || request.claim?.rewardId, request };
      const transaction = await sendTransactionIntent(request.transactionIntent);
      await syncMerchantClaimTransaction(id, transaction.transactionHash);
      state.claimResult = { request, transaction };
      state.claimRetry = null;
      state.claimInspection = null;
      showToast('Claim 交易已确认，等待账本事件同步');
      await loadView('assets', true);
    });
  } catch (error) {
    if (request?.transactionIntent) drawActiveView();
    showToast(`Claim intent 重试未完成：${errorText(error)}`, 'error');
  }
}

async function cancelPendingClaim(button, claimId) {
  const id = String(claimId || '');
  if (!id) return showToast('Claim ID 缺失，请刷新后重试', 'error');
  if (!window.confirm('确认取消这笔 Pending Claim？取消后对应收益将按后端规则恢复。')) return;
  try {
    const result = await busy(button, '取消中...', () => signedAction('merchant.claim.cancel', { claimId: id }, `/api/merchant/claims/${encodeURIComponent(id)}/cancel`, { sendTransaction: false }));
    state.claimRetry = null;
    state.claimInspection = null;
    showToast(result.message || 'Pending Claim 已取消');
    await loadView('assets', true);
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

async function runClaim(button) {
  const data = state.resources.get('assets')?.data || {};
  const entry = (data.claimState?.rewards || []).find((item) => item.id === state.claimConfirm?.rewardId && item.state === 'Available');
  if (!entry) return showToast('该流水已不再可提取，请刷新', 'error');
  let request = null;
  try {
    await busy(button, '准备链上 intent...', async () => {
      request = await signedAction('merchant.claim.request', { rewardId: entry.id }, '/api/merchant/claims', { sendTransaction: false });
      if (!request.transactionIntent) throw new Error('CLAIM_TRANSACTION_INTENT_MISSING');
      state.claimRetry = { claimId: request.claim?.id, rewardId: entry.id, request };
      const transaction = await sendTransactionIntent(request.transactionIntent);
      await syncMerchantClaimTransaction(request.claim?.id, transaction.transactionHash);
      state.claimResult = { request, transaction };
      state.claimRetry = null;
      state.claimConfirm = null;
      showToast('Claim 交易已确认，等待账本事件同步');
      await loadView('assets', true);
    });
  } catch (error) {
    if (request) {
      state.claimConfirm = null;
      if (state.claimRetry) drawActiveView();
      else await loadView('assets', true);
      showToast(`Claim 请求已记录，但链上交易未完成：${errorText(error)}`, 'error');
    } else {
      showToast(errorText(error), 'error');
    }
  }
}

async function retryClaimTransaction(button) {
  const retry = state.claimRetry;
  if (!retry?.request?.transactionIntent) return showToast('本次会话中没有可恢复的交易 intent', 'error');
  try {
    await busy(button, '等待钱包确认...', async () => {
      const transaction = await sendTransactionIntent(retry.request.transactionIntent);
      await syncMerchantClaimTransaction(retry.claimId || retry.request.claim?.id, transaction.transactionHash);
      state.claimResult = { request: retry.request, transaction };
      state.claimRetry = null;
      showToast('Claim 交易已确认，等待账本事件同步');
      await loadView('assets', true);
    });
  } catch (error) {
    showToast(`链上交易仍未完成：${errorText(error)}`, 'error');
  }
}

async function syncMerchantClaimTransaction(claimId, txHash) {
  if (!claimId || !txHash) throw new Error('CLAIM_TRANSACTION_STATUS_INPUT_MISSING');
  return api(`/api/merchant/claims/${encodeURIComponent(claimId)}/status?txHash=${encodeURIComponent(txHash)}`);
}

function filteredOrders(orders) {
  const filters = state.orderFilters;
  const query = filters.query.trim().toLowerCase();
  const start = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : null;
  const end = filters.to ? new Date(`${filters.to}T23:59:59.999`).getTime() : null;
  return orders.filter((order) => {
    if (filters.mode !== 'all' && (order.fulfillmentMode || 'delivery') !== filters.mode) return false;
    if (filters.status && order.status !== filters.status) return false;
    if (query && ![order.orderId, order.id, order.buyerAddress, order.txHash, order.fundTxHash].some((value) => String(value || '').toLowerCase().includes(query))) return false;
    const timestamp = Date.parse(order.createdAt || '');
    if (start !== null && Number.isFinite(timestamp) && timestamp < start) return false;
    if (end !== null && Number.isFinite(timestamp) && timestamp > end) return false;
    return true;
  });
}

function rowsForBatch(filtered) {
  const selected = filtered.filter((order) => state.selectedOrders.has(String(order.orderId || order.id)));
  return selected.length ? selected : filtered;
}

function pruneSelectedOrders(orders) {
  const ids = new Set(orders.map((order) => String(order.orderId || order.id)));
  for (const id of state.selectedOrders) if (!ids.has(id)) state.selectedOrders.delete(id);
}

async function exportOrders(format, button) {
  const filters = state.orderFilters;
  const payload = {
    format,
    status: filters.status,
    fulfillmentMode: filters.mode === 'all' ? '' : filters.mode,
    sku: filters.sku.trim(),
    from: filters.from,
    to: filters.to
  };
  try {
    const result = await busy(button, '等待二次签名...', () => signedAction('merchant.orders.export', payload, '/api/merchant/export', { sendTransaction: false }));
    const content = result && typeof result === 'object' && 'content' in result ? result.content : result;
    if (typeof content !== 'string' && !(content instanceof Blob)) throw new Error('MERCHANT_EXPORT_CONTENT_MISSING');
    const extension = format === 'excel' ? 'xls' : 'csv';
    const fileName = result && typeof result === 'object' && result.fileName ? result.fileName : `24k-orders-${dateStamp()}.${extension}`;
    const contentType = result && typeof result === 'object' && result.contentType
      ? result.contentType
      : (format === 'excel' ? 'application/vnd.ms-excel;charset=utf-8' : 'text/csv;charset=utf-8');
    downloadBlob(content, fileName, contentType);
    showToast(`${format === 'excel' ? 'Excel' : 'CSV'} 完整订单已下载${Number.isFinite(Number(result?.rowCount)) ? `，共 ${numberText(result.rowCount)} 行` : ''}`);
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

function printOrders() {
  const orders = state.resources.get('orders')?.data || [];
  const rows = rowsForBatch(filteredOrders(orders));
  if (!rows.length) return showToast('没有可打印的订单', 'warning');
  printSheet('24K 商家订单履约单', ['订单号', '状态', '履约', '买家', '金额', '行政区', '下单时间'], rows.map((row) => [
    row.orderId || row.id,
    statusLabel(row.status),
    fulfillmentLabel(row.fulfillmentMode, false),
    row.buyerAddress || '',
    formatAmount(row.amountNpl, 'NPL'),
    row.regionCode || '',
    formatDate(row.createdAt)
  ]));
}

function printPickupResult() {
  const result = state.pickupResult;
  if (!result) return;
  printSheet('24K 门店自提核销单', ['订单号', '门店 ID', '核销码', '状态', '核销时间'], [[
    result.orderId || result.target,
    result.storeId || '',
    result.code || '',
    statusLabel(result.status),
    formatDate(result.verifiedAt)
  ]]);
}

function printSheet(title, headings, rows) {
  document.querySelector('#merchant-print-sheet')?.remove();
  const sheet = document.createElement('section');
  sheet.id = 'merchant-print-sheet';
  sheet.innerHTML = `<header><img src="/api/logo" alt="24K Mall" /><div><h1>${escapeHtml(title)}</h1><p>打印数据来自当前 API 响应</p></div></header><table><thead><tr>${headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  document.body.appendChild(sheet);
  document.body.classList.add('merchant-printing');
  const cleanup = () => {
    document.body.classList.remove('merchant-printing');
    sheet.remove();
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(() => window.print(), 0);
  setTimeout(() => { if (sheet.isConnected) cleanup(); }, 60_000);
}

async function busy(button, label, operation) {
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.textContent = label;
  }
  try {
    return await operation();
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

function statusBadge(status) {
  const normalized = String(status || 'Unknown');
  return `<span class="badge ${statusTone(normalized)}">${escapeHtml(statusLabel(normalized))}</span>`;
}

function statusTone(status) {
  if (['Available', 'Claimed', 'Released', 'Completed', 'success', 'Approved', 'Submitted', 'Online', 'Configured'].includes(status)) return 'success';
  if (['PendingReview', 'Scheduled', 'PaidLocked', 'AwaitingShipment', 'PendingClaim', 'AwaitingWalletTransaction', 'pending', 'Pending', 'PickupReady', 'ConfigurationRequired', 'TakedownRequested'].includes(status)) return 'warning';
  if (['Rejected', 'Failed', 'failed', 'Cancelled', 'cancelled', 'expired', 'ForcedRefunded', 'EmergencyRefunded', 'Offline', 'Error', 'TakenDown', 'Withdrawn'].includes(status)) return 'danger';
  if (['Shipped', 'Live'].includes(status)) return 'info';
  return '';
}

function statusLabel(status) {
  return STATUS_LABELS[String(status || '')] || String(status || '未返回');
}

function fulfillmentLabel(mode, html = true) {
  const label = mode === 'pickup' ? '到店自提' : '快递邮寄';
  return html ? `<span class="badge ${mode === 'pickup' ? 'info' : ''}">${label}</span>` : label;
}

function txLink(txHash) {
  const hash = String(txHash || '');
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) return `<span class="muted mono">${escapeHtml(hash ? shortAddress(hash) : '未返回')}</span>`;
  return `<a class="tx-link mono" href="https://bscscan.com/tx/${encodeURIComponent(hash)}" target="_blank" rel="noreferrer" title="${escapeHtml(hash)}">${escapeHtml(shortAddress(hash))}${icon('external')}</a>`;
}

function formatMetric(value, unit) {
  if (unit === 'NPL') return formatAmount(value, unit);
  const number = Number(value);
  return `${Number.isFinite(number) ? number.toLocaleString('zh-CN') : '0'} ${unit}`;
}

function numberText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('zh-CN') : '0';
}

function formatDate(value) {
  if (!value) return '未返回';
  const raw = String(value);
  const normalized = /^\d{10,13}$/.test(raw)
    ? Number(raw) * (raw.length === 10 ? 1000 : 1)
    : (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
        ? `${raw.replace(' ', 'T')}Z`
        : raw);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function dateStamp() {
  const date = new Date();
  const parts = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')];
  return parts.join('');
}

function compactValue(value) {
  if (value === null || value === undefined) return '未返回';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function errorText(error) {
  const code = String(error?.message || error || 'UNKNOWN_ERROR');
  const map = {
    MERCHANT_SINGLE_PRODUCT_LOCKED: '当前门店已有审核中或已上架单品，后端已执行一店一商品死锁。',
    MERCHANT_PRODUCT_LOCKED: '商品已被平台锁定，当前状态不允许修改。',
    INVALID_SUBMISSION_STATUS: '商品当前状态不允许执行该操作，请刷新后重试。',
    PRODUCT_DRAFT_ID_MISSING: '草稿保存响应缺少商品 ID，已停止送审。',
    MERCHANT_EXPORT_CONTENT_MISSING: '服务端未返回可下载的订单文件内容。',
    MERCHANT_PROFILE_IMMUTABLE_FIELD: '结算钱包、商家状态和商家 ID 不允许在资料页修改。',
    INVALID_CONTACT_PHONE: '联系电话格式无效。',
    ORDER_NOT_PAID: '订单尚未进入可履约状态，请刷新订单后重试。',
    ORDER_NOT_DELIVERY_MODE: '该订单不是快递履约模式。',
    ORDER_NOT_PICKUP_MODE: '该订单不是自提履约模式。',
    ORDER_SELLER_MISMATCH: '订单不属于当前商家钱包。',
    STORE_MISMATCH: '订单绑定门店与所选门店不一致。',
    STORE_REQUIRED: '订单未绑定自提门店。',
    STORE_REGION_CODE_LOCKED: '门店行政区编码已永久锁定，不能更换。',
    STORE_COORDINATES_REQUIRED: '生产环境必须提供有效门店经纬度。',
    INVALID_PICKUP_CODE: '核销码与订单凭证不匹配。',
    ELECTRONIC_WAYBILL_NOT_CONFIGURED: '电子面单服务尚未配置，请改为手工录入物流单号。',
    WAITING_7_DAYS_AFTER_PAYMENT: '付款后尚未满 7 天，暂不能申请强制签收。',
    MERCHANT_FORCE_SIGN_STATUS_INELIGIBLE: '订单当前状态不允许申请强制签收。',
    CLAIMS_PAUSED: '平台已暂停 Claim，请等待恢复。',
    NO_AVAILABLE_REWARD: '该收益已不再处于 Available 状态。',
    REWARD_LEDGER_ADDRESS_NOT_CONFIGURED: '后端未配置 RewardLedger 合约地址，无法生成链上 Claim intent。',
    REWARD_ID_NOT_ONCHAIN_ENTRY: '该收益 ID 无法映射到链上 RewardLedger 条目。',
    CLAIM_TRANSACTION_INTENT_MISSING: '后端没有返回 Claim 交易 intent，已停止广播。',
    CLAIM_NOT_PENDING: '该 Claim 已不再处于 Pending 状态，请刷新记录。',
    CLAIM_TRANSACTION_ALREADY_BROADCAST: '该 Claim 已记录链上交易，不能取消。',
    MERCHANT_WALLET_NOT_WHITELISTED: '当前钱包不在已审核商家白名单中。',
    SESSION_EXPIRED: '登录会话已过期，请重新签名。',
    ACTION_NONCE_REPLAYED: '二次签名 nonce 已使用，请重新发起操作。',
    TRANSACTION_REVERTED: '链上交易执行失败。',
    TRANSACTION_CONFIRMATION_TIMEOUT: '交易已广播，但确认等待超时，请在 BscScan 核对。'
  };
  if (Number(error?.code) === 4001) return '钱包已取消本次操作。';
  if (map[code]) return map[code];
  return code.includes('_') && /^[A-Z0-9_]+$/.test(code) ? code.replaceAll('_', ' ') : code;
}

function renderInlineEmpty(message) {
  return `<div class="empty-state inline-empty"><h3>暂无数据</h3><p>${escapeHtml(message)}</p></div>`;
}

function installMerchantStyles() {
  if (document.querySelector('#merchant-module-styles')) return;
  const style = document.createElement('style');
  style.id = 'merchant-module-styles';
  style.textContent = `
    .merchant-console .ui-icon { width: 17px; height: 17px; flex: 0 0 17px; }
    .merchant-console .nav-button { display: flex; align-items: center; gap: 10px; }
    .merchant-console .sidebar-brand span { letter-spacing: 0; }
    .merchant-topbar h1:focus { outline: 0; }
    .session-pill { min-height: 32px; display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); padding: 0 10px; font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .session-pill i, .connection-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px rgba(22,115,83,.12); }
    .dashboard-intro { display: flex; justify-content: space-between; align-items: flex-end; gap: 18px; margin-bottom: 18px; }
    .dashboard-intro h2 { margin: 3px 0 0; font-size: 28px; line-height: 1.1; }
    .dashboard-generated { margin: 6px 0 0; color: var(--muted); font-size: 11px; }
    .eyebrow.dark { color: var(--amber); margin-bottom: 5px; }
    .connection-state { display: inline-flex; align-items: center; gap: 9px; color: var(--green); font-size: 12px; font-weight: 750; }
    .merchant-metrics { grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .workflow-list { display: grid; }
    .workflow-row { width: 100%; display: grid; grid-template-columns: 34px 1fr 18px; align-items: center; gap: 12px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--ink); padding: 13px 2px; text-align: left; }
    .workflow-row:first-child { border-top: 1px solid var(--line); }
    .workflow-row:hover { background: var(--subtle); }
    .workflow-index { color: var(--amber); font: 750 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .workflow-row b, .workflow-row small { display: block; }
    .workflow-row b { font-size: 13px; }
    .workflow-row small { margin-top: 4px; color: var(--muted); font-size: 11px; }
    .detail-list { margin: 0; }
    .detail-list > div { display: grid; grid-template-columns: minmax(95px, .45fr) minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .detail-list > div:first-child { border-top: 1px solid var(--line); }
    .detail-list dt { color: var(--muted); font-size: 11px; }
    .detail-list dd { margin: 0; text-align: right; font-size: 12px; overflow-wrap: anywhere; }
    .plain-list, .number-list { margin: 0; padding: 0; list-style: none; }
    .plain-list li { display: flex; align-items: flex-start; gap: 8px; border-bottom: 1px solid var(--line); padding: 9px 0; font-size: 12px; }
    .plain-list li:first-child { border-top: 1px solid var(--line); }
    .plain-list .ui-icon { color: var(--green); width: 14px; height: 14px; margin-top: 1px; }
    .api-gap, .lock-result, .result-panel { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 13px; box-shadow: none; }
    .api-gap { background: #fff8e9; border-color: #ead7a8; }
    .api-gap > div:first-child, .lock-result > div:first-child, .result-panel > div:first-child { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; background: rgba(155,104,25,.1); color: var(--amber); }
    .api-gap h3, .api-gap p, .lock-result h3, .lock-result p, .result-panel h3, .result-panel p { margin: 0; }
    .api-gap h3, .lock-result h3, .result-panel h3 { font-size: 13px; }
    .api-gap p, .lock-result p, .result-panel p { margin-top: 4px; color: var(--muted); font-size: 11px; line-height: 1.55; }
    .product-state-strip, .rules-header { display: flex; justify-content: space-between; align-items: center; gap: 20px; box-shadow: none; }
    .product-state-strip h2, .rules-header h2 { margin: 2px 0 0; font-size: 21px; }
    .clean-fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
    .clean-fieldset[disabled] { opacity: .68; }
    .subsection-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 22px 0 8px; }
    .subsection-head h3, .subsection-head p { margin: 0; }
    .subsection-head p { margin-top: 3px; color: var(--muted); font-size: 11px; }
    .sku-editor { border-top: 1px solid var(--line); }
    .sku-row { display: grid; grid-template-columns: minmax(150px, 1.3fr) minmax(130px, .8fr) minmax(110px, .6fr) 40px; gap: 10px; align-items: end; padding: 12px 0; border-bottom: 1px solid var(--line); }
    .mode-fieldset { border: 0; margin: 20px 0 0; padding: 0; }
    .mode-fieldset legend { margin-bottom: 9px; color: var(--muted); font-size: 11px; font-weight: 720; }
    .mode-fieldset label { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; margin-right: 18px; font-size: 12px; }
    .mode-fieldset input, [data-order-select], [data-select-all] { width: 16px; height: 16px; accent-color: var(--black); }
    .check-field { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; color: var(--ink); font-size: 12px; }
    .check-field input { width: 16px; height: 16px; accent-color: var(--black); }
    .form-footer { display: flex; justify-content: space-between; align-items: center; gap: 15px; margin-top: 18px; }
    .form-footer p { max-width: 70ch; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .action-availability { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0 16px; box-shadow: none; }
    .action-availability > div { padding: 11px 0; border-bottom: 1px solid var(--line); }
    .action-availability > div:nth-last-of-type(1) { border-bottom: 0; }
    .action-availability b, .action-availability span { display: block; }
    .action-availability b { font-size: 12px; }
    .action-availability span { margin-top: 3px; color: var(--muted); font-size: 11px; }
    .filter-grid { display: grid; grid-template-columns: minmax(200px, 1.4fr) repeat(4, minmax(130px, .75fr)); gap: 10px; align-items: end; }
    .filter-actions { display: flex; justify-content: flex-end; gap: 8px; grid-column: 1 / -1; }
    .notice { border: 1px solid var(--line); border-radius: 5px; background: var(--subtle); color: var(--muted); padding: 11px 12px; font-size: 11px; line-height: 1.55; }
    .notice.compact { margin: 10px 0 14px; }
    .notice.warning { border-color: #e6c982; background: #fff8e9; color: #694914; }
    .notice.success { border-color: #acd6c5; background: #edf8f3; color: #10563e; }
    .orders-table { min-width: 1060px; }
    .row-actions { display: flex; align-items: center; flex-wrap: nowrap; gap: 6px; }
    .row-actions .button { white-space: nowrap; }
    .tx-link { display: inline-flex; align-items: center; gap: 4px; color: var(--blue); text-decoration: none; }
    .tx-link .ui-icon { width: 12px; height: 12px; }
    .table-sub { display: block; margin-top: 4px; color: var(--muted); font-size: 10px; line-height: 1.4; }
    .action-panel { border-color: #c6c8c1; box-shadow: none; }
    .one-column { grid-template-columns: 1fr; }
    .inline-empty { min-height: 150px; }
    .inline-empty h3, .inline-empty p { margin: 0; }
    .inline-empty p { font-size: 11px; }
    .compact-list { border-top: 1px solid var(--line); }
    .compact-list > div { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid var(--line); padding: 11px 0; }
    .compact-list b, .compact-list small { display: block; }
    .compact-list b { font-size: 12px; }
    .compact-list small { margin-top: 3px; color: var(--muted); font-size: 10px; }
    .compact-list code { font-size: 11px; }
    .result-panel > div:first-child { background: rgba(22,115,83,.1); color: var(--green); }
    .dashboard-asset-row, .merchant-five-state { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .dashboard-asset-row > div, .merchant-five-state > div { min-width: 0; padding: 17px 13px; border-right: 1px solid var(--line); }
    .dashboard-asset-row > div:last-child, .merchant-five-state > div:last-child { border-right: 0; }
    .dashboard-asset-row span, .dashboard-asset-row strong, .merchant-five-state span, .merchant-five-state strong, .merchant-five-state small { display: block; }
    .dashboard-asset-row span, .merchant-five-state span { color: var(--muted); font-size: 10px; }
    .dashboard-asset-row strong, .merchant-five-state strong { margin-top: 7px; font-size: 17px; overflow-wrap: anywhere; }
    .merchant-five-state small { margin-top: 4px; color: var(--muted); font-size: 9px; }
    .asset-secondary { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 12px; color: var(--muted); font-size: 11px; }
    .asset-secondary b { margin-left: 5px; color: var(--ink); }
    .claim-review { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .claim-review > div { padding: 13px; border-right: 1px solid var(--line); }
    .claim-review > div:last-child { border-right: 0; }
    .claim-review span, .claim-review b { display: block; }
    .claim-review span { color: var(--muted); font-size: 10px; }
    .claim-review b { margin-top: 5px; font-size: 13px; overflow-wrap: anywhere; }
    .settings-printer-button { margin-top: 12px; }
    .compact-error { min-height: 160px; }
    .compact-error .ui-icon, .error-state > .ui-icon { width: 25px; height: 25px; }
    .rules-header p { margin: 7px 0 0; color: var(--muted); font-size: 11px; }
    .rules-body { margin: 0; max-height: 520px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); font: 400 13px/1.8 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
    .number-list { counter-reset: rules; }
    .number-list li { counter-increment: rules; display: grid; grid-template-columns: 25px 1fr; gap: 8px; border-bottom: 1px solid var(--line); padding: 10px 0; font-size: 12px; line-height: 1.55; }
    .number-list li:first-child { border-top: 1px solid var(--line); }
    .number-list li::before { content: counter(rules, decimal-leading-zero); color: var(--amber); font: 750 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .loading-panel { min-height: 220px; display: grid; align-content: center; gap: 12px; }
    .loading-panel .skeleton-title { width: 32%; height: 24px; }
    .loading-panel .skeleton-short { width: 58%; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    #merchant-print-sheet { display: none; }
    @media (max-width: 1180px) {
      .merchant-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .filter-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      .merchant-console .sidebar nav { padding-bottom: 2px; }
      .merchant-console .nav-button { min-height: 44px; }
      .merchant-console .button.small, .merchant-console .segmented button { min-height: 44px; }
      .merchant-console .button.small.icon { width: 44px; }
      .merchant-topbar { flex-direction: column; }
      .merchant-topbar .topbar-actions { width: 100%; justify-content: space-between; }
      .session-pill { max-width: 150px; overflow: hidden; }
      .dashboard-intro { align-items: flex-start; flex-direction: column; }
      .merchant-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .merchant-metrics .metric:last-child { grid-column: 1 / -1; }
      .api-gap, .lock-result, .result-panel { grid-template-columns: 32px minmax(0, 1fr); }
      .api-gap > :last-child, .lock-result > :last-child, .result-panel > :last-child { grid-column: 1 / -1; }
      .product-state-strip, .rules-header, .subsection-head { align-items: flex-start; flex-direction: column; }
      .sku-row { grid-template-columns: 1fr 1fr; }
      .sku-row .field:first-child { grid-column: 1 / -1; }
      .sku-row .button.icon { justify-self: end; }
      .filter-grid { grid-template-columns: 1fr; }
      .filter-actions { grid-column: auto; }
      .filter-actions .button { flex: 1; }
      .form-footer { align-items: stretch; flex-direction: column; }
      .form-footer .button { width: 100%; }
      .action-availability { grid-template-columns: minmax(0, 1fr) auto; }
      .dashboard-asset-row, .merchant-five-state { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .dashboard-asset-row > div, .merchant-five-state > div { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
      .dashboard-asset-row > div:nth-child(even), .merchant-five-state > div:nth-child(even) { border-right: 0; }
      .dashboard-asset-row > div:last-child, .merchant-five-state > div:last-child { grid-column: 1 / -1; border-right: 0; border-bottom: 0; }
      .claim-review { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .claim-review > div:nth-child(2) { border-right: 0; }
      .claim-review > div:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
      .field input, .field select, .field textarea, .input { min-height: 44px; font-size: 16px; }
    }
    @media print {
      @page { margin: 14mm; }
      body.merchant-printing { background: #fff; }
      body.merchant-printing #console-root, body.merchant-printing #global-toast { display: none !important; }
      body.merchant-printing #merchant-print-sheet { display: block; color: #111; }
      #merchant-print-sheet header { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
      #merchant-print-sheet header img { width: 42px; height: 42px; object-fit: cover; }
      #merchant-print-sheet h1, #merchant-print-sheet p { margin: 0; }
      #merchant-print-sheet h1 { font-size: 19px; }
      #merchant-print-sheet p { margin-top: 3px; color: #555; font-size: 10px; }
      #merchant-print-sheet table { font-size: 10px; }
      #merchant-print-sheet th, #merchant-print-sheet td { border: 1px solid #bbb; padding: 7px; }
    }
  `;
  document.head.appendChild(style);
}

window.addEventListener('hashchange', () => {
  const requested = location.hash.slice(1);
  if (state.context && VIEW_META[requested] && requested !== state.active) navigate(requested, { updateHash: false });
});

bootConsole({ role: 'merchant', render });
