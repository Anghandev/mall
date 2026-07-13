import {
  bootConsole,
  api,
  signedAction,
  sendTransactionIntent,
  escapeHtml,
  formatAmount,
  shortAddress,
  downloadArtifact,
  printHtmlArtifact,
  showToast,
  getSession
} from '/backstage/common.js';

const NAVIGATION = [
  {
    label: '运营总览',
    items: [
      ['dashboard', '工作台', 'layout-dashboard'],
      ['search', '组合检索', 'search']
    ]
  },
  {
    label: '交易与供给',
    items: [
      ['merchants', '商家中心', 'store'],
      ['catalog', '商品与类目', 'package'],
      ['allocation', '比例与受益人', 'split'],
      ['seckill', '秒杀控盘', 'zap']
    ]
  },
  {
    label: '履约与安全',
    items: [
      ['risk', '风控与黑名单', 'shield-alert'],
      ['logistics', '物流配置', 'truck'],
      ['refunds', '售后与退款', 'rotate-ccw']
    ]
  },
  {
    label: '内容与系统',
    items: [
      ['cms', 'CMS 内容', 'file-text'],
      ['notifications', '通知中心', 'bell'],
      ['system', '系统配置', 'settings']
    ]
  },
  {
    label: '审计与运维',
    items: [
      ['audit', '审计日志', 'scroll-text'],
      ['operations', '运维监控', 'activity']
    ]
  }
];

const ROUTES = Object.fromEntries(
  NAVIGATION.flatMap((group) => group.items.map(([id, label, iconName]) => [id, { id, label, iconName }]))
);

const state = {
  context: null,
  route: 'dashboard',
  requestSequence: 0,
  loadedAt: null,
  selected: new Map(),
  filters: {
    logic: 'AND',
    keyword: '',
    orderId: '',
    productId: '',
    txHash: '',
    wallet: '',
    uid: '',
    phone: '',
    status: '',
    from: '',
    to: ''
  },
  searchTab: 'all',
  merchantTab: 'all',
  catalogTab: 'products',
  beneficiaries: [],
  lastAction: null,
  currentData: null,
  authRefreshing: false,
  breakers: {}
};

const ICON_PATHS = {
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  store: '<path d="M3 9l2-5h14l2 5"/><path d="M5 13v8h14v-8"/><path d="M9 21v-6h6v6"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>',
  package: '<path d="m7.5 4.3 9 5.2"/><path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  split: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.8-1.6l9-12a.5.5 0 0 1 .9.4l-1.7 6.8a1 1 0 0 0 1 1.2H20a1 1 0 0 1 .8 1.6l-9 12a.5.5 0 0 1-.9-.4l1.7-6.8a1 1 0 0 0-1-1.2Z"/>',
  'shield-alert': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  truck: '<path d="M10 17h4V5H2v12h3"/><path d="M14 9h4l4 4v4h-3"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="17.5" r="2.5"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  'file-text': '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h8M8 9h2"/>',
  bell: '<path d="M10.3 21a2 2 0 0 0 3.4 0"/><path d="M4 17h16c-1.5-1.5-2-3-2-7a6 6 0 0 0-12 0c0 4-0.5 5.5-2 7"/>',
  settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.2a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.2a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.2a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.2a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  'scroll-text': '<path d="M15 12h-5M15 8h-5M13 16h-3"/><path d="M8 21h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H8"/><path d="M6 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2V5a2 2 0 0 0-2-2Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  refresh: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
  logout: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  alert: '<path d="m21.7 16-7-12a3 3 0 0 0-5.2 0l-7 12A3 3 0 0 0 5 20h14a3 3 0 0 0 2.7-4Z"/><path d="M12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/>'
};

function icon(name, size = 18) {
  const paths = ICON_PATHS[name] || ICON_PATHS.activity;
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function injectAdminStyles() {
  if (document.querySelector('#admin-console-styles')) return;
  const style = document.createElement('style');
  style.id = 'admin-console-styles';
  style.textContent = `
    .ui-icon{display:block;flex:0 0 auto}.sidebar{display:flex;flex-direction:column}.sidebar nav{gap:14px}.nav-group{display:grid;gap:3px}.nav-group-label{padding:0 12px 5px;color:#77786f;font-size:9px;font-weight:850;text-transform:uppercase}.nav-button{display:flex;align-items:center;gap:10px}.nav-button .ui-icon{width:16px;height:16px}.sidebar-session{margin-top:auto}.sidebar-session .button{width:100%;margin-top:8px;border-color:#3b3c36;color:#d8d8d2}.workspace{max-width:1800px;width:100%;margin:0 auto}.topbar{position:relative}.topbar-actions{justify-content:flex-end}.connection{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 10px;border:1px solid var(--line);border-radius:5px;background:var(--surface);font-size:11px;font-weight:750}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(22,115,83,.12)}.status-dot.warning{background:var(--amber);box-shadow:0 0 0 3px rgba(155,104,25,.12)}.status-dot.danger{background:var(--red);box-shadow:0 0 0 3px rgba(181,61,54,.12)}
    .source-strip{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:-8px 0 18px;color:var(--muted);font-size:10px}.source-strip code{padding:4px 6px;border:1px solid var(--line);border-radius:4px;background:var(--surface)}.endpoint-state{display:flex;align-items:flex-start;gap:10px;border-left:3px solid var(--amber);background:#fff8e9;padding:10px 12px;color:#6b4d16;font-size:11px;line-height:1.5}.endpoint-state.error{border-color:var(--red);background:#fff0ee;color:#812c27}.endpoint-state.success{border-color:var(--green);background:#eaf7f1;color:#10563e}.endpoint-state .ui-icon{margin-top:1px}
    .metric.compact strong{font-size:22px}.metric.signal-safe{border-top:3px solid var(--green)}.metric.signal-warning{border-top:3px solid var(--amber)}.metric.signal-danger{border-top:3px solid var(--red)}.metric strong.unavailable{color:#a4a59f;font-size:21px}.metric small{min-height:14px}.content-grid+.content-grid{margin-top:14px}.panel.no-shadow{box-shadow:none}.panel.flush{padding:0}.panel.flush .panel-head{padding:18px 18px 0}.panel.flush .table-wrap{padding:0 18px 18px}.panel-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}.panel-toolbar .field{min-width:160px}.compact-list{display:grid}.compact-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(90px,auto);align-items:center;gap:14px;min-height:44px;border-bottom:1px solid var(--line);font-size:12px}.compact-row:last-child{border-bottom:0}.compact-row span{color:var(--muted)}.compact-row strong{text-align:right}.monitor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 22px}.monitor-row{display:grid;grid-template-columns:minmax(120px,1fr) auto;align-items:center;gap:12px;min-height:42px;border-bottom:1px solid var(--line);font-size:11px}.monitor-row span{color:var(--muted)}.monitor-row b{font-variant-numeric:tabular-nums}.progress-track{height:5px;background:#e8e9e4;overflow:hidden}.progress-track i{display:block;height:100%;background:var(--green)}.progress-track i.warning{background:var(--amber)}.progress-track i.danger{background:var(--red)}
    .filter-panel{margin-bottom:14px}.filter-grid{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px}.filter-grid .field:first-child{grid-column:span 2}.filter-actions{display:flex;align-items:flex-end;gap:8px}.quick-dates{display:flex;gap:5px;flex-wrap:wrap}.quick-dates button{min-height:28px;border:1px solid var(--line);border-radius:4px;background:var(--surface);padding:0 8px;font-size:10px}.tabbar{display:flex;gap:3px;overflow:auto;border-bottom:1px solid var(--line);margin-bottom:14px}.tabbar button{flex:0 0 auto;min-height:38px;border:0;border-bottom:2px solid transparent;background:transparent;padding:0 12px;color:var(--muted);font-size:11px;font-weight:780}.tabbar button.active{border-bottom-color:var(--gold);color:var(--ink)}
    .checkbox{width:16px;height:16px;accent-color:var(--black)}.batch-bar{position:sticky;z-index:5;bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding:10px 12px;border:1px solid #cfd0ca;border-radius:6px;background:rgba(255,255,255,.97);box-shadow:0 12px 34px rgba(22,24,19,.14)}.batch-count{min-width:88px;font-size:11px;font-weight:800}.batch-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}.button .ui-icon{width:15px;height:15px}.button.busy{pointer-events:none}.button.busy .ui-icon{animation:admin-spin .8s linear infinite}@keyframes admin-spin{to{transform:rotate(360deg)}}
    .cell-title{display:grid;gap:3px}.cell-title strong{font-size:12px}.cell-title small{color:var(--muted);font-size:10px}.address{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.numeric{font-variant-numeric:tabular-nums;white-space:nowrap}.table-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px}.table-actions .button{white-space:nowrap}.record-type{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:10px}.required-mark{color:var(--red)}
    .ratio-total{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:12px}.ratio-total strong.invalid{color:var(--red)}.beneficiary-list{display:grid;gap:8px;margin-top:12px}.beneficiary-row{display:grid;grid-template-columns:minmax(220px,2fr) minmax(120px,1fr) 120px 40px;gap:8px;align-items:end}.beneficiary-row .button.icon{min-height:40px}.danger-actions{display:grid;gap:8px}.danger-action{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--line)}.danger-action:last-child{border-bottom:0}.danger-action b{display:block;font-size:12px}.danger-action small{display:block;margin-top:3px;color:var(--muted);font-size:10px}.code-block{max-height:240px;overflow:auto;margin:0;padding:12px;border:1px solid var(--line);background:#f8f9f6;font:10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}.action-receipt{margin-bottom:14px}.action-receipt a{color:var(--blue);font-weight:750}.timeline{display:grid}.timeline-row{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr);gap:10px;padding:0 0 16px}.timeline-row:not(:last-child):before{content:"";position:absolute;left:10px;top:20px;bottom:0;width:1px;background:var(--line)}.timeline-marker{position:relative;z-index:1;width:21px;height:21px;display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;background:var(--surface);color:var(--muted)}.timeline-marker .ui-icon{width:12px;height:12px}.timeline-copy b{font-size:11px}.timeline-copy p{margin:3px 0 0;color:var(--muted);font-size:10px;line-height:1.5}
    dialog.admin-dialog{width:min(620px,calc(100vw - 28px));max-height:calc(100dvh - 40px);overflow:auto;border:1px solid var(--line);border-radius:7px;padding:0;background:var(--surface);color:var(--ink);box-shadow:0 28px 80px rgba(0,0,0,.28)}dialog.admin-dialog::backdrop{background:rgba(12,13,10,.55)}.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px;border-bottom:1px solid var(--line)}.dialog-head h2{margin:0;font-size:17px}.dialog-head p{margin:4px 0 0;color:var(--muted);font-size:11px}.dialog-body{padding:18px}.dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid var(--line)}.dialog-close{border:0;background:transparent;width:36px;height:36px;display:grid;place-items:center;color:var(--muted)}
    .json-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.json-summary div{border-bottom:1px solid var(--line);padding:8px 0}.json-summary span{display:block;color:var(--muted);font-size:10px}.json-summary b{display:block;margin-top:3px;font-size:11px;overflow-wrap:anywhere}.switch-line{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:44px;border-bottom:1px solid var(--line)}.switch-line:last-child{border-bottom:0}.switch-line span{font-size:11px}.switch{position:relative;width:38px;height:22px;appearance:none;border:1px solid var(--line);border-radius:999px;background:#d9dad5;transition:background .18s ease}.switch:checked{background:var(--green);border-color:var(--green)}.switch:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s ease}.switch:checked:after{transform:translateX(16px)}
    .risk-event-data{display:grid;gap:4px;margin:0}.risk-event-data div{display:grid;grid-template-columns:80px minmax(0,1fr);gap:8px}.risk-event-data dt{color:var(--muted);font-size:9px}.risk-event-data dd{margin:0;font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.payload-details{margin-top:7px}.payload-details summary{width:max-content;color:var(--blue);font-size:10px;font-weight:750;cursor:pointer}.payload-details .code-block{max-width:420px;margin-top:6px}.ops-chain-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}.ops-chain-grid>div{min-height:72px;display:grid;align-content:center;gap:8px;padding:12px;background:var(--surface)}.ops-chain-grid span:first-child{color:var(--muted);font-size:10px}.ops-chain-grid strong{font-size:13px;overflow-wrap:anywhere}.ops-component span b,.ops-component span small{display:block}.ops-component span small{margin-top:3px;color:var(--muted);font-size:9px;font-weight:500}
    @media(max-width:1180px){.filter-grid{grid-template-columns:repeat(2,minmax(140px,1fr))}.filter-grid .field:first-child{grid-column:auto}.beneficiary-row{grid-template-columns:1fr 120px 100px 40px}}
    @media(max-width:760px){.sidebar nav{display:flex;gap:8px}.nav-group{display:flex}.nav-group-label{display:none}.nav-button{min-height:40px}.topbar{display:grid}.topbar-actions{justify-content:flex-start}.connection{max-width:100%}.filter-grid{grid-template-columns:1fr}.monitor-grid{grid-template-columns:1fr}.batch-bar{position:static;align-items:flex-start;display:grid}.batch-actions{justify-content:flex-start}.beneficiary-row{grid-template-columns:1fr 1fr}.beneficiary-row .field:first-child{grid-column:1/-1}.table-wrap table{min-width:760px}.json-summary{grid-template-columns:1fr}.ops-chain-grid{grid-template-columns:1fr 1fr}}
  `;
  document.head.appendChild(style);
}

function renderShell(context) {
  const session = getSession('admin');
  context.root.innerHTML = `
    <div class="console-layout">
      <aside class="sidebar" aria-label="平台后台导航">
        <a class="sidebar-brand" href="#dashboard" data-route="dashboard" aria-label="24K 平台运营后台">
          <img src="/api/logo" alt="24K Mall" />
          <span><b>24K Console</b><span>PLATFORM OPERATIONS</span></span>
        </a>
        <nav>${NAVIGATION.map((group) => `
          <section class="nav-group">
            <div class="nav-group-label">${escapeHtml(group.label)}</div>
            ${group.items.map(([id, label, iconName]) => `
              <button class="nav-button" type="button" data-route="${id}">${icon(iconName)}<span>${escapeHtml(label)}</span></button>
            `).join('')}
          </section>
        `).join('')}</nav>
        <div class="sidebar-session">
          <span>ADMIN WALLET · BSC 56</span>
          <code title="${escapeHtml(context.address)}">${escapeHtml(shortAddress(context.address))}</code>
          <button class="button ghost small" type="button" data-logout>${icon('logout')}退出登录</button>
        </div>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div><h1 data-page-title>工作台</h1><p data-page-subtitle>平台业务、资金安全与基础设施状态</p></div>
          <div class="topbar-actions">
            <span class="connection" title="${escapeHtml(session?.address || context.address)}"><i class="status-dot"></i>BSC 56 · ${escapeHtml(shortAddress(session?.address || context.address))}</span>
            <button class="button icon" type="button" data-refresh title="刷新当前页面" aria-label="刷新当前页面">${icon('refresh')}</button>
          </div>
        </header>
        <div id="admin-view"></div>
      </main>
    </div>
    <dialog id="admin-dialog" class="admin-dialog" aria-labelledby="dialog-title"></dialog>`;
}

const PAGE_META = {
  dashboard: ['工作台', '平台业务、资金安全与基础设施状态'],
  search: ['组合检索', '订单、商品、交易哈希与身份标识统一查询'],
  merchants: ['商家中心', '资质审核、等级限额与穿透式经营数据'],
  catalog: ['商品与类目', '商品主数据、三级类目、标签和库存规格'],
  allocation: ['比例与受益人', 'NPL 路由、平台分配与 Claim 受益人配置'],
  seckill: ['秒杀控盘', '场次排期、奖池、规则和应急熔断'],
  risk: ['风控与黑名单', 'Web3 攻击、刷单识别与全网交易锁定'],
  logistics: ['物流配置', '承运商、电子面单、地址库与运费模板'],
  refunds: ['售后与退款', '售后仲裁、强制退款与链上逆向清算'],
  cms: ['CMS 内容', '视觉位、活动触点、法务内容和发版公告'],
  notifications: ['通知中心', '受众、业务模板与多通道消息网关'],
  system: ['系统配置', '链、合约、Oracle、Gas 与基础设施参数'],
  audit: ['审计日志', '签名操作、登录、RPC、资金与多签轨迹'],
  operations: ['运维监控', '服务、中间件、吞吐和区块同步水位']
};

const LOADERS = {
  dashboard: loadDashboard,
  search: loadSearch,
  merchants: loadMerchants,
  catalog: loadCatalog,
  allocation: loadAllocation,
  seckill: loadSeckill,
  risk: loadRisk,
  logistics: loadLogistics,
  refunds: loadRefunds,
  cms: loadCms,
  notifications: loadNotifications,
  system: loadSystem,
  audit: loadAudit,
  operations: loadOperations
};

const RENDERERS = {
  dashboard: renderDashboard,
  search: renderSearch,
  merchants: renderMerchants,
  catalog: renderCatalog,
  allocation: renderAllocation,
  seckill: renderSeckill,
  risk: renderRisk,
  logistics: renderLogistics,
  refunds: renderRefunds,
  cms: renderCms,
  notifications: renderNotifications,
  system: renderSystem,
  audit: renderAudit,
  operations: renderOperations
};

async function render(context) {
  state.context = context;
  injectAdminStyles();
  renderShell(context);
  bindShellEvents(context.root);
  const requested = location.hash.replace(/^#/, '');
  await navigate(ROUTES[requested] ? requested : 'dashboard', { updateHash: !ROUTES[requested] });
}

function bindShellEvents(root) {
  root.addEventListener('click', (event) => {
    handleClick(event).catch((error) => {
      if (!error?.uiHandled) showToast(errorText(error), 'error');
    });
  });
  root.addEventListener('change', handleChange);
  root.addEventListener('input', handleInput);
  root.addEventListener('submit', handleSubmit);
}

async function navigate(route, options = {}) {
  const next = ROUTES[route] ? route : 'dashboard';
  state.route = next;
  if (options.updateHash !== false && location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
  document.querySelectorAll('[data-route]').forEach((button) => button.classList.toggle('active', button.dataset.route === next));
  const [title, subtitle] = PAGE_META[next];
  const titleNode = document.querySelector('[data-page-title]');
  const subtitleNode = document.querySelector('[data-page-subtitle]');
  if (titleNode) titleNode.textContent = title;
  if (subtitleNode) subtitleNode.textContent = subtitle;
  const view = document.querySelector('#admin-view');
  if (!view) return;
  const sequence = ++state.requestSequence;
  view.innerHTML = renderLoadingState('正在读取平台数据');
  try {
    const data = await LOADERS[next]();
    if (sequence !== state.requestSequence) return;
    state.currentData = data;
    state.loadedAt = new Date();
    view.innerHTML = `${renderActionReceipt()}${RENDERERS[next](data)}`;
  } catch (error) {
    if (sequence !== state.requestSequence) return;
    view.innerHTML = renderPageError(error);
  }
}

function adminSession() {
  return getSession('admin') || {
    role: 'admin',
    address: state.context?.address,
    token: state.context?.token,
    expiresAt: Number.MAX_SAFE_INTEGER
  };
}

async function request(path, options = {}) {
  try {
    return await api(path, { ...options, session: adminSession() });
  } catch (error) {
    if (error?.status === 401 && !state.authRefreshing) {
      state.authRefreshing = true;
      Promise.resolve(state.context?.refresh()).finally(() => { state.authRefreshing = false; });
    }
    throw error;
  }
}

async function settled(path, options = {}) {
  try {
    return { ok: true, path, data: await request(path, options) };
  } catch (error) {
    return { ok: false, path, error };
  }
}

async function settleMap(entries) {
  const pairs = await Promise.all(Object.entries(entries).map(async ([key, path]) => [key, await settled(path)]));
  return Object.fromEntries(pairs);
}

function dataOf(result, fallback = null) {
  return result?.ok ? result.data : fallback;
}

function arrayOf(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}

function configValue(rows, key, fallback = {}) {
  const entries = arrayOf(rows);
  const match = entries.find((entry) => entry?.key === key);
  return match?.value || match?.payload || fallback;
}

function configEntries(rows, prefix) {
  return arrayOf(rows).filter((entry) => String(entry?.key || '').startsWith(prefix));
}

function errorText(error) {
  const code = String(error?.message || error || 'UNKNOWN_ERROR');
  return `${error?.status ? `HTTP ${error.status} · ` : ''}${code}`;
}

function renderLoadingState(label) {
  return `<section class="panel wide" aria-busy="true"><div class="loading-state"><div>${icon('refresh', 22)}</div><strong>${escapeHtml(label)}</strong><div style="width:min(360px,70vw)" class="skeleton"></div><div style="width:min(260px,55vw)" class="skeleton"></div></div></section>`;
}

function renderPageError(error) {
  return `<section class="panel wide"><div class="error-state" role="alert">${icon('alert', 24)}<h3>数据加载失败</h3><p>${escapeHtml(errorText(error))}</p><button class="button" type="button" data-refresh>${icon('refresh')}重新加载</button></div></section>`;
}

function renderEmptyState(title = '暂无数据', detail = '当前查询没有返回记录。') {
  return `<div class="empty-state">${icon('search', 22)}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p></div>`;
}

function renderEndpointState(result, label) {
  if (result?.ok) return '';
  return `<div class="endpoint-state error" role="status">${icon('alert')}<div><strong>${escapeHtml(label)}</strong><br><span class="mono">${escapeHtml(result?.path || '')}</span> · ${escapeHtml(errorText(result?.error))}</div></div>`;
}

function renderSourceStrip(paths = []) {
  return `<div class="source-strip"><span>数据源</span>${paths.map((path) => `<code>${escapeHtml(path)}</code>`).join('')}<span>更新于 ${escapeHtml(formatDateTime(state.loadedAt || new Date()))}</span></div>`;
}

function renderActionReceipt() {
  const receipt = state.lastAction;
  if (!receipt || receipt.route !== state.route) return '';
  const transactionHash = receipt.transaction?.transactionHash || receipt.result?.transactionHash || receipt.result?.txHash;
  return `<section class="endpoint-state ${receipt.tone === 'warning' ? '' : 'success'} action-receipt" role="status">
    ${icon(receipt.tone === 'warning' ? 'clock' : 'check')}
    <div><strong>${escapeHtml(receipt.label)}</strong><br>${escapeHtml(receipt.detail || '服务端已受理并写入审计。')}
    ${transactionHash ? ` · <a href="https://bscscan.com/tx/${encodeURIComponent(transactionHash)}" target="_blank" rel="noreferrer">${escapeHtml(shortAddress(transactionHash))} ${icon('external', 12)}</a>` : ''}</div>
  </section>`;
}

function formatDateTime(value) {
  if (!value) return '--';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function firstValue(source, paths, fallback = null) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function displayMetric(value, suffix = '', emptyLabel = '--') {
  if (value === undefined || value === null || value === '') return `<strong class="unavailable">${escapeHtml(emptyLabel)}</strong>`;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value)))) {
    const formatted = !suffix && Number.isInteger(numeric) ? numeric.toLocaleString('zh-CN') : formatAmount(numeric, suffix);
    return `<strong>${escapeHtml(formatted)}</strong>`;
  }
  return `<strong>${escapeHtml(suffix ? `${value} ${suffix}` : value)}</strong>`;
}

function metricCard(label, value, options = {}) {
  const unavailable = value === null || value === undefined || value === '';
  const emptyLabel = options.emptyLabel || '--';
  return `<article class="metric ${options.signal ? `signal-${options.signal}` : ''}"><span>${escapeHtml(label)}</span>${displayMetric(value, options.suffix || '', emptyLabel)}<small>${escapeHtml(options.detail || (unavailable ? (emptyLabel === 'notConfigured' ? '未配置' : '后端未上报') : '实时 API'))}</small></article>`;
}

function statusBadge(status) {
  const value = String(status || 'Unknown');
  const lower = value.toLowerCase();
  let tone = 'info';
  if (/notconfigured|not configured|disabled/.test(lower)) tone = 'neutral';
  else if (/approved|active|available|released|shipped|settled|success|healthy|ready|open|clear|synced|online|connected/.test(lower)) tone = 'success';
  else if (/pending|review|locked|scheduled|warning|partial|requested|queue|action required|unverified/.test(lower)) tone = 'warning';
  else if (/rejected|failed|paused|blocked|black|error|inactive|deleted|refund|unavailable|degraded|offline/.test(lower)) tone = 'danger';
  return `<span class="badge ${tone}">${escapeHtml(value)}</span>`;
}

function renderGlobalFilters(id = 'global-filter') {
  const filters = state.filters;
  return `<section class="panel wide filter-panel">
    <form data-filter-form="${escapeHtml(id)}">
      <div class="panel-toolbar">
        <div class="segmented" aria-label="组合逻辑">
          <button type="button" data-filter-logic="AND" class="${filters.logic === 'AND' ? 'active' : ''}">AND</button>
          <button type="button" data-filter-logic="OR" class="${filters.logic === 'OR' ? 'active' : ''}">OR</button>
        </div>
        <div class="quick-dates" aria-label="快捷时间范围">
          <button type="button" data-date-range="today">今日</button><button type="button" data-date-range="yesterday">昨日</button><button type="button" data-date-range="7">近 7 天</button><button type="button" data-date-range="30">近 30 天</button>
        </div>
      </div>
      <input type="hidden" name="logic" value="${escapeHtml(filters.logic)}" />
      <div class="filter-grid">
        <label class="field"><span>通用关键词</span><input class="input" name="keyword" value="${escapeHtml(filters.keyword)}" placeholder="订单 / 商品 / 钱包 / TxHash" /></label>
        <label class="field"><span>业务状态</span><select name="status"><option value="">全部状态</option>${['PendingReview','Approved','Rejected','Active','Inactive','Locked','Warning','Paused','RefundRequested'].map((item) => `<option value="${item}" ${filters.status === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label>
        <label class="field"><span>订单号（精确）</span><input name="orderId" value="${escapeHtml(filters.orderId)}" /></label>
        <label class="field"><span>商品 ID（精确）</span><input name="productId" value="${escapeHtml(filters.productId)}" /></label>
        <label class="field"><span>交易哈希 TxHash（精确）</span><input name="txHash" value="${escapeHtml(filters.txHash)}" /></label>
        <label class="field"><span>钱包地址</span><input name="wallet" value="${escapeHtml(filters.wallet)}" /></label>
        <label class="field"><span>用户 UID</span><input name="uid" value="${escapeHtml(filters.uid)}" /></label>
        <label class="field"><span>绑定手机号</span><input name="phone" value="${escapeHtml(filters.phone)}" inputmode="numeric" /></label>
        <label class="field"><span>开始时间</span><input type="datetime-local" name="from" value="${escapeHtml(filters.from)}" /></label>
        <label class="field"><span>结束时间</span><input type="datetime-local" name="to" value="${escapeHtml(filters.to)}" /></label>
        <div class="filter-actions"><button class="button primary" type="submit">${icon('search')}检索</button><button class="button" type="button" data-clear-filters>清空</button></div>
      </div>
    </form>
  </section>`;
}

function selectedSet(resource) {
  if (!state.selected.has(resource)) state.selected.set(resource, new Set());
  return state.selected.get(resource);
}

function renderBatchBar(resource, availableCount = 0) {
  const count = selectedSet(resource).size;
  const actions = {
    orders: [['export.excel', 'download', 'Excel'], ['export.csv', 'download', 'CSV'], ['print.shipments', 'printer', '电子面单'], ['print.pickups', 'printer', '自提单']],
    products: [['export.excel', 'download', 'Excel'], ['export.csv', 'download', 'CSV'], ['batch.modify', '', '批量修改'], ['product.up', '', '批量上架'], ['product.down', '', '批量下架']],
    productSubmissions: [['export.excel', 'download', 'Excel'], ['export.csv', 'download', 'CSV'], ['review.approve', '', '审核通过'], ['review.reject', '', '审核拒绝'], ['soft-delete', '', '逻辑删除']],
    merchants: [['export.excel', 'download', 'Excel'], ['export.csv', 'download', 'CSV']],
    auditLogs: [['export.excel', 'download', 'Excel'], ['export.csv', 'download', 'CSV']]
  }[resource] || [];
  if (!actions.length) return '';
  return `<div class="batch-bar" data-batch-resource="${escapeHtml(resource)}" data-available-count="${Number(availableCount || 0)}">
    <div class="batch-count">已选 ${count} / ${Number(availableCount || 0)}</div>
    <div class="batch-actions">
      ${actions.map(([operation, iconName, label]) => `<button class="button ${operation === 'soft-delete' || operation === 'review.reject' ? 'danger' : ''} small" type="button" data-batch-op="${operation}" ${operation.startsWith('export.') ? (availableCount ? '' : 'disabled') : (count ? '' : 'disabled')}>${iconName ? icon(iconName) : ''}${label}</button>`).join('')}
    </div>
  </div>`;
}

function renderTabs(name, entries, active) {
  return `<div class="tabbar" role="tablist">${entries.map(([id, label, count]) => `<button type="button" role="tab" data-tab-group="${escapeHtml(name)}" data-tab-value="${escapeHtml(id)}" class="${id === active ? 'active' : ''}">${escapeHtml(label)}${count === undefined ? '' : ` · ${Number(count)}`}</button>`).join('')}</div>`;
}

function buildSearchParams(filters = state.filters) {
  const params = new URLSearchParams();
  const values = { ...filters };
  const exactParts = ['orderId', 'productId', 'txHash', 'wallet', 'uid', 'phone'].map((key) => values[key]).filter(Boolean);
  const q = values.keyword || exactParts[0] || '';
  if (q) params.set('q', q);
  for (const key of ['logic', 'orderId', 'productId', 'txHash', 'wallet', 'uid', 'phone']) {
    if (values[key]) params.set(key, values[key]);
  }
  if (values.status) params.set('status', values.status);
  if (values.from) params.set('from', new Date(values.from).toISOString());
  if (values.to) params.set('to', new Date(values.to).toISOString());
  return params;
}

function formValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  form.querySelectorAll('input[type="checkbox"]').forEach((input) => { values[input.name] = input.checked; });
  return values;
}

function setButtonBusy(button, busy, label = '处理中') {
  if (!button) return;
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.classList.add('busy');
    button.innerHTML = `${icon('refresh')}${escapeHtml(label)}`;
    return;
  }
  button.disabled = false;
  button.classList.remove('busy');
  if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
}

async function executeSigned({ action, path, payload, button, label, chainRequired = false, refresh = true, validateResult }) {
  setButtonBusy(button, true, '等待签名');
  try {
    const result = await signedAction(action, payload, path, { sendTransaction: false });
    let transaction = null;
    const transactions = [];
    let transactionError = null;
    const intents = [
      ...(result?.transactionIntent ? [result.transactionIntent] : []),
      ...(Array.isArray(result?.transactionIntents) ? result.transactionIntents : [])
    ];
    for (const intent of intents) {
      try {
        transactions.push(await sendTransactionIntent(intent));
      } catch (error) {
        transactionError = error;
        break;
      }
    }
    transaction = transactions[0] || null;
    const chainPending = chainRequired && intents.length === 0;
    const resultWarning = typeof validateResult === 'function' ? validateResult(result) : '';
    const warning = Boolean(transactionError || chainPending || resultWarning);
    state.lastAction = {
      action,
      route: state.route,
      label,
      result,
      transaction,
      transactions,
      tone: warning ? 'warning' : 'success',
      detail: transactionError
        ? `服务端已受理，但链上交易未完成：${errorText(transactionError)}`
        : transactions.length
        ? `${transactions.length} 笔钱包交易已广播并确认，服务端响应已保留。`
        : resultWarning
          ? resultWarning
          : chainPending
          ? '签名动作已受理，但后端未返回 transactionIntent；链上步骤尚未完成。'
          : '服务端已受理并写入审计日志。'
    };
    showToast(state.lastAction.detail, warning ? 'warning' : 'success');
    if (refresh) await navigate(state.route, { updateHash: false });
    return { result, transaction, transactions, transactionError };
  } catch (error) {
    showToast(errorText(error), 'error');
    if (error && typeof error === 'object') error.uiHandled = true;
    throw error;
  } finally {
    setButtonBusy(button, false);
  }
}

bootConsole({ role: 'admin', render });

async function loadDashboard() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return settleMap({
    dashboard: '/api/admin/dashboard',
    health: '/health',
    today: `/api/admin/search?from=${encodeURIComponent(start.toISOString())}`,
    products: '/api/admin/products/pending',
    merchants: '/api/admin/merchants',
    seckill: '/api/seckill/current',
    audit: '/api/admin/audit-logs',
    operations: '/api/admin/ops'
  });
}

async function loadSearch() {
  return { search: await settled(`/api/admin/search?${buildSearchParams().toString()}`) };
}

async function loadMerchants() {
  const params = buildSearchParams();
  return settleMap({
    merchants: '/api/admin/merchants',
    search: `/api/admin/search?${params.toString()}`,
    levels: '/api/admin/configs'
  });
}

async function loadCatalog() {
  return settleMap({
    products: '/api/products?includeInactive=true',
    submissions: '/api/admin/products/pending',
    catalog: '/api/admin/configs',
    categories: '/api/admin/categories',
    tags: '/api/admin/tags'
  });
}

async function loadAllocation() {
  return settleMap({
    ratio: '/api/admin/configs',
    beneficiaries: '/api/admin/configs',
    config: '/api/config',
    audit: '/api/admin/audit-logs'
  });
}

async function loadSeckill() {
  return settleMap({
    current: '/api/seckill/current',
    reports: '/api/seckill/reports?limit=20',
    rules: '/api/seckill/rules',
    products: '/api/products',
    schedules: '/api/admin/seckill/sessions',
    breakers: '/api/admin/dashboard'
  });
}

async function loadRisk() {
  return settleMap({
    risk: '/api/admin/risk-events',
    policies: '/api/admin/configs',
    breakers: '/api/admin/dashboard'
  });
}

async function loadLogistics() {
  return settleMap({
    logistics: '/api/admin/configs',
    carriers: '/api/admin/configs',
    templates: '/api/admin/logistics/templates',
    addresses: '/api/admin/logistics/addresses',
    stores: '/api/stores',
    printJobs: '/api/admin/print-jobs'
  });
}

async function loadRefunds() {
  const params = buildSearchParams();
  return settleMap({
    search: `/api/admin/search?${params.toString()}`,
    afterSales: '/api/admin/after-sales',
    refunds: '/api/admin/settlement-requests',
    audit: '/api/admin/audit-logs'
  });
}

async function loadCms() {
  return settleMap({ content: '/api/admin/cms' });
}

async function loadNotifications() {
  return settleMap({
    messages: '/api/messages',
    deliveries: '/api/admin/messages',
    gateways: '/api/admin/messages/gateways'
  });
}

async function loadSystem() {
  return settleMap({
    publicConfig: '/api/config',
    adminConfig: '/api/admin/configs',
    health: '/health',
    readiness: '/api/dapp/readiness'
  });
}

async function loadAudit() {
  return settleMap({
    logs: '/api/admin/audit-logs',
    rpcLogs: '/api/admin/rpc-audit-logs',
    search: `/api/admin/search?${buildSearchParams().toString()}`,
    streams: '/api/admin/audit-streams'
  });
}

async function loadOperations() {
  return settleMap({
    health: '/health',
    readiness: '/api/dapp/readiness',
    operations: '/api/admin/ops',
    breakers: '/api/admin/dashboard',
    audit: '/api/admin/audit-logs'
  });
}

function renderDashboard(data) {
  const dashboard = dataOf(data.dashboard, {});
  const stats = dashboard?.stats || dashboard || {};
  const today = dashboard?.today || {};
  const todo = dashboard?.todo || {};
  const health = dataOf(data.health, {});
  const operations = dataOf(data.operations, {});
  const dashboardBlockchain = operations.blockchain && typeof operations.blockchain === 'object' ? operations.blockchain : {};
  const dashboardRpcHeight = firstValue(dashboardBlockchain, ['heights.rpc', 'rpc.height', 'rpcHeight', 'nodeHeight'], null);
  const todayResults = dataOf(data.today, {})?.results || {};
  const orders = arrayOf(todayResults.orders);
  const products = arrayOf(dataOf(data.products, []));
  const merchants = arrayOf(dataOf(data.merchants, []));
  const audit = arrayOf(dataOf(data.audit, dashboard.recentAudit || []));
  const seckill = dataOf(data.seckill, {});
  const session = seckill?.session || {};
  const todayGmv = today.gmvNpl ?? (orders.length ? orders.reduce((total, order) => total + Number(order.amountNpl || order.amount || 0), 0) : null);
  const pendingMerchants = todo.merchants ?? merchants.filter((merchant) => /pending|review/i.test(String(merchant.status))).length;
  const pendingProducts = todo.products ?? products.filter((product) => /pending|review/i.test(String(product.status))).length;
  const failedChainActions = data.audit?.ok ? audit.filter((entry) => /chain|rpc/i.test(String(entry.action)) && /fail|error|revert/i.test(JSON.stringify(entry.payload || {}))).length : null;
  const blacklistBlocks = data.audit?.ok ? audit.filter((entry) => /blacklist|blocked/i.test(String(entry.action))).length : null;
  const riskAlerts = firstValue(stats, ['riskAlerts', 'risk.alerts'], null);
  const prizePool = firstValue(session, ['prizePoolNpl'], firstValue(stats, ['prizePoolNpl'], null));
  captureBreakers(dashboard);
  const sourcePaths = ['/api/admin/dashboard', '/api/admin/search', '/health', '/api/seckill/current', '/api/admin/ops'];

  return `${renderSourceStrip(sourcePaths)}${renderEndpointState(data.seckill, '秒杀状态读取不可用')}
    <section class="metric-grid">
      ${metricCard('今日订单', today.orders ?? orders.length, { detail: 'Dashboard 今日口径' })}
      ${metricCard('今日 GMV', todayGmv, { suffix: 'NPL', detail: todayGmv === null ? '后端未返回订单金额' : 'NPL 结算口径' })}
      ${metricCard('今日发货率', today.shipmentRate ?? firstValue(stats, ['todayShipmentRate', 'shipmentRate'], null), { suffix: '%' })}
      ${metricCard('今日秒杀场次', today.seckillSessions ?? firstValue(stats, ['todaySeckillSessions', 'seckillSessions'], null))}
      ${metricCard('今日新增用户', firstValue(stats, ['todayNewUsers', 'newUsers'], null))}
      ${metricCard('今日新增商家', firstValue(stats, ['todayNewMerchants', 'newMerchants'], null))}
      ${metricCard('今日链上失败', failedChainActions, { signal: failedChainActions ? 'danger' : undefined, detail: data.audit?.ok ? '审计日志聚合' : '后端未返回审计日志' })}
      ${metricCard('黑名单拦截', blacklistBlocks, { detail: data.audit?.ok ? '审计日志聚合' : '后端未返回审计日志' })}
    </section>
    <div class="content-grid">
      <section class="panel third">
        <div class="panel-head"><div><h2>待办事项</h2><p class="panel-subtitle">审核、售后与库存队列</p></div>${statusBadge(pendingMerchants + pendingProducts ? 'Pending' : 'Clear')}</div>
        <div class="compact-list">
          <div class="compact-row"><span>待审核商家</span><strong>${pendingMerchants}</strong></div>
          <div class="compact-row"><span>待审核商品</span><strong>${pendingProducts}</strong></div>
          <div class="compact-row"><span>待处理售后</span><strong>${escapeHtml(todo.arbitration ?? firstValue(stats, ['pendingAfterSales'], '--'))}</strong></div>
          <div class="compact-row"><span>库存预警商品</span><strong>${escapeHtml(todo.lowStock ?? firstValue(stats, ['lowStockProducts'], '--'))}</strong></div>
        </div>
      </section>
      <section class="panel third">
        <div class="panel-head"><div><h2>Web3 资管水位</h2><p class="panel-subtitle">资金、奖池与异常订单</p></div>${statusBadge(riskAlerts ? 'Warning' : 'Monitoring')}</div>
        <div class="compact-list">
          <div class="compact-row"><span>本场奖池</span><strong>${prizePool === null ? '--' : `${escapeHtml(formatAmount(prizePool))} NPL`}</strong></div>
          <div class="compact-row"><span>今日提现</span><strong>${today.withdrawalsNpl == null ? '--' : `${escapeHtml(formatAmount(today.withdrawalsNpl))} NPL`}</strong></div>
          <div class="compact-row"><span>异常订单触发</span><strong>${escapeHtml(riskAlerts ?? '--')}</strong></div>
          <div class="compact-row"><span>杠杆系数状态</span><strong>${escapeHtml(firstValue(stats, ['leverageStatus'], '--'))}</strong></div>
        </div>
      </section>
      <section class="panel third">
        <div class="panel-head"><div><h2>链与认证</h2><p class="panel-subtitle">配置和事件同步状态</p></div>${statusBadge(health.ok ? 'Healthy' : 'Unknown')}</div>
        <div class="compact-list">
          ${healthRow('管理员 SIWE', health.adminSiweReady)}
          ${healthRow('链事件同步', health.eventSyncReady)}
          ${healthRow('支付托管合约', health.escrowConfigured)}
          ${healthRow('秒杀合约', health.seckillConfigured)}
        </div>
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>基础设施与安全监控</h2><p class="panel-subtitle">节点、Oracle、中间件和主机性能</p></div><button class="button small" type="button" data-route="operations">${icon('activity')}运维详情</button></div>
        ${renderEndpointState(data.operations, '运维指标端点不可用')}
        <div class="monitor-grid">
          ${operationalValueRow('QPS', firstValue(operations, ['traffic.qps'], null))}
          ${operationalValueRow('TPS', firstValue(operations, ['traffic.tps'], null))}
          ${operationalValueRow('错误率', firstValue(operations, ['traffic.errorRatePct'], null), '%')}
          ${operationalValueRow('RPC 状态', blockchainEndpointStatus(dashboardBlockchain, 'rpc', dashboardRpcHeight))}
          ${operationalValueRow('数据库', operationStatus(firstValue(operations, ['components.db'], null)))}
          ${operationalValueRow('Redis', operationStatus(firstValue(operations, ['components.redis'], null)))}
          ${operationalValueRow('MQ', operationStatus(firstValue(operations, ['components.mq'], null)))}
          ${operationalValueRow('进程内存', firstValue(operations, ['process.rssMb'], null), 'MB')}
        </div>
      </section>
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>最近审计</h2><p class="panel-subtitle">管理员签名与系统关键轨迹</p></div><button class="button small" type="button" data-route="audit">查看全部</button></div>
        <div class="table-wrap">${renderAuditTable(audit.slice(0, 8), false)}</div>
      </section>
    </div>`;
}

function healthRow(label, value) {
  return `<div class="compact-row"><span>${escapeHtml(label)}</span><strong>${value === undefined ? statusBadge('Unknown') : statusBadge(value ? 'Ready' : 'Not Ready')}</strong></div>`;
}

function flattenSearchResults(search) {
  const results = search?.results || {};
  const definitions = [
    ['orders', '订单', results.orders],
    ['products', '商品', results.products],
    ['productSubmissions', '商品提报', results.productSubmissions],
    ['merchants', '商家', results.merchants],
    ['auditLogs', '审计', results.auditLogs]
  ];
  return definitions.flatMap(([resource, label, values]) => arrayOf(values).map((raw) => ({
    resource,
    label,
    raw,
    id: raw.orderId || raw.id || raw.walletAddress || raw.target || '',
    title: raw.title || raw.name || raw.orderId || raw.action || raw.id || '',
    status: raw.status || raw.role || 'Recorded',
    address: raw.walletAddress || raw.buyerAddress || raw.sellerAddress || raw.merchantAddress || raw.actorAddress || '',
    reference: raw.txHash || raw.fundTxHash || raw.approvedProductId || raw.target || '',
    createdAt: raw.createdAt || raw.updatedAt || ''
  })));
}

function renderSearch(data) {
  const search = dataOf(data.search, {});
  const allRows = flattenSearchResults(search);
  const rows = state.searchTab === 'all' ? allRows : allRows.filter((row) => row.resource === state.searchTab);
  const resultCounts = Object.fromEntries(['orders', 'products', 'productSubmissions', 'merchants', 'auditLogs'].map((key) => [key, allRows.filter((row) => row.resource === key).length]));
  const resource = state.searchTab === 'all' ? 'mixed' : state.searchTab;
  return `${renderSourceStrip(['/api/admin/search'])}${renderGlobalFilters('search')}
    ${renderEndpointState(data.search, '组合检索不可用')}
    <section class="panel wide flush">
      <div class="panel-head"><div><h2>检索结果</h2><p class="panel-subtitle">${allRows.length} 条真实 API 记录</p></div></div>
      <div style="padding:0 18px">${renderTabs('search', [
        ['all', '全部', allRows.length], ['orders', '订单', resultCounts.orders], ['products', '商品', resultCounts.products], ['productSubmissions', '商品提报', resultCounts.productSubmissions], ['merchants', '商家', resultCounts.merchants], ['auditLogs', '审计', resultCounts.auditLogs]
      ], state.searchTab)}</div>
      <div class="table-wrap">${renderSearchTable(rows, resource)}</div>
    </section>
    ${resource === 'mixed' ? '' : renderBatchBar(resource, rows.length)}`;
}

function renderSearchTable(rows, selectionResource) {
  if (!rows.length) return renderEmptyState('没有匹配记录');
  const selected = selectedSet(selectionResource);
  return `<table><thead><tr><th><input class="checkbox" type="checkbox" data-select-all="${escapeHtml(selectionResource)}" aria-label="全选" /></th><th>类型 / 主键</th><th>名称 / 动作</th><th>状态</th><th>钱包</th><th>TxHash / 关联对象</th><th>时间</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr>
      <td><input class="checkbox" type="checkbox" data-select-resource="${escapeHtml(selectionResource)}" data-select-id="${escapeHtml(row.id)}" ${selected.has(String(row.id)) ? 'checked' : ''} aria-label="选择 ${escapeHtml(row.id)}" /></td>
      <td><div class="cell-title"><span class="record-type">${escapeHtml(row.label)}</span><strong class="mono">${escapeHtml(row.id || '--')}</strong></div></td>
      <td>${escapeHtml(row.title || '--')}</td><td>${statusBadge(row.status)}</td>
      <td class="address" title="${escapeHtml(row.address)}">${escapeHtml(shortAddress(row.address) || '--')}</td>
      <td class="address" title="${escapeHtml(row.reference)}">${escapeHtml(shortAddress(row.reference) || '--')}</td>
      <td class="numeric">${escapeHtml(formatDateTime(row.createdAt))}</td>
      <td><button class="button icon small" type="button" data-view-record="${escapeHtml(row.resource)}:${escapeHtml(row.id)}" aria-label="查看记录" title="查看记录">${icon('eye')}</button></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function hasActiveFilters() {
  return Object.entries(state.filters).some(([key, value]) => key !== 'logic' && Boolean(value));
}

function renderMerchants(data) {
  const baseMerchants = arrayOf(dataOf(data.merchants, []));
  const searched = arrayOf(dataOf(data.search, {})?.results?.merchants);
  const merchants = hasActiveFilters() ? searched : baseMerchants;
  const counts = {
    all: merchants.length,
    pending: merchants.filter((row) => /pending|review/i.test(String(row.status))).length,
    approved: merchants.filter((row) => /approved/i.test(String(row.status))).length,
    rejected: merchants.filter((row) => /rejected/i.test(String(row.status))).length,
    blacklist: merchants.filter((row) => /black/i.test(String(row.status))).length
  };
  const visible = state.merchantTab === 'all' ? merchants : merchants.filter((merchant) => {
    const status = String(merchant.status).toLowerCase();
    if (state.merchantTab === 'pending') return /pending|review/.test(status);
    if (state.merchantTab === 'blacklist') return /black/.test(status);
    return status.includes(state.merchantTab);
  });
  const levelConfig = configValue(dataOf(data.levels, []), 'merchant-levels', {});
  return `${renderSourceStrip(['/api/admin/merchants', '/api/admin/search', '/api/admin/configs'])}${renderGlobalFilters('merchants')}
    <div class="content-grid">
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>商家资质与经营状态</h2><p class="panel-subtitle">结算钱包审核通过后进入白名单</p></div></div>
        <div style="padding:0 18px">${renderTabs('merchant', [['all','全部',counts.all],['pending','待审核',counts.pending],['approved','已通过',counts.approved],['rejected','已拒绝',counts.rejected],['blacklist','黑名单',counts.blacklist]], state.merchantTab)}</div>
        <div class="table-wrap">${renderMerchantTable(visible)}</div>
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>商家等级与限额矩阵</h2><p class="panel-subtitle">单品结算上限与每月秒杀场次配额</p></div><button class="button primary small" type="button" data-submit-external-form="merchant-level-form">保存矩阵</button></div>
        ${renderEndpointState(data.levels, '商家等级读取端点不可用')}
        <form id="merchant-level-form" data-action-form="merchant-levels" class="form-grid">
          ${['V1','V2','V3','V4','V5'].map((level) => `<label class="field"><span>${level} 单品结算上限（NPL）</span><input name="${level.toLowerCase()}PriceLimitNpl" inputmode="decimal" value="${escapeHtml(levelConfig[`${level.toLowerCase()}PriceLimitNpl`] ?? '')}" placeholder="未配置" /></label><label class="field"><span>${level} 月秒杀配额</span><input name="${level.toLowerCase()}SeckillQuota" type="number" min="0" value="${escapeHtml(levelConfig[`${level.toLowerCase()}SeckillQuota`] ?? '')}" placeholder="未配置" /></label>`).join('')}
        </form>
      </section>
    </div>
    ${renderBatchBar('merchants', visible.length)}`;
}

function renderMerchantTable(rows) {
  if (!rows.length) return renderEmptyState('暂无商家记录');
  const selected = selectedSet('merchants');
  return `<table><thead><tr><th><input class="checkbox" type="checkbox" data-select-all="merchants" aria-label="全选商家" /></th><th>商家</th><th>结算钱包</th><th>状态</th><th>等级</th><th>单品上限</th><th>月秒杀配额</th><th>经营数据</th><th></th></tr></thead><tbody>
    ${rows.map((merchant) => {
      const payload = merchant.payload || {};
      const id = String(merchant.id || merchant.walletAddress || '');
      return `<tr>
        <td><input class="checkbox" type="checkbox" data-select-resource="merchants" data-select-id="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''} aria-label="选择商家" /></td>
        <td><div class="cell-title"><strong>${escapeHtml(merchant.name || '--')}</strong><small>${escapeHtml(merchant.id || '--')}</small></div></td>
        <td class="address" title="${escapeHtml(merchant.walletAddress)}">${escapeHtml(shortAddress(merchant.walletAddress))}</td>
        <td>${statusBadge(merchant.status)}</td><td>${escapeHtml(payload.level || '--')}</td>
        <td class="numeric">${payload.productPriceLimitNpl == null ? '--' : `${escapeHtml(formatAmount(payload.productPriceLimitNpl))} NPL`}</td>
        <td class="numeric">${escapeHtml(payload.monthlySeckillQuota ?? '--')}</td>
        <td><div class="cell-title"><strong>${escapeHtml(payload.totalOrders ?? '--')} 单</strong><small>${escapeHtml(payload.flashShipRate48h ?? '--')}% 闪发率</small></div></td>
        <td><div class="table-actions">
          <button class="button small" type="button" data-merchant-review="approved" data-id="${escapeHtml(merchant.id)}" data-wallet="${escapeHtml(merchant.walletAddress)}" data-name="${escapeHtml(merchant.name)}">通过</button>
          <button class="button small" type="button" data-merchant-review="rejected" data-id="${escapeHtml(merchant.id)}" data-wallet="${escapeHtml(merchant.walletAddress)}" data-name="${escapeHtml(merchant.name)}">拒绝</button>
          <button class="button icon small" type="button" data-view-merchant="${escapeHtml(merchant.id)}" aria-label="商家详情" title="商家详情">${icon('eye')}</button>
        </div></td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function renderCatalog(data) {
  const products = arrayOf(dataOf(data.products, []));
  const submissions = arrayOf(dataOf(data.submissions, []));
  const categoriesPayload = dataOf(data.categories, dataOf(data.catalog, {})?.categories || []);
  const tagsPayload = dataOf(data.tags, dataOf(data.catalog, {})?.tags || []);
  const categories = arrayOf(categoriesPayload);
  const tags = arrayOf(tagsPayload);
  const counts = { products: products.length, submissions: submissions.length, categories: categories.length, tags: tags.length };
  return `${renderSourceStrip(['/api/products', '/api/admin/products/pending', '/api/admin/categories', '/api/admin/tags'])}${renderGlobalFilters('catalog')}
    <section class="panel wide">
      <div class="panel-head"><div><h2>全局商品主数据</h2><p class="panel-subtitle">商品、提报、三级类目与智能标签</p></div><button class="button primary small" type="button" data-open-form="product-create">${icon('plus')}代上架商品</button></div>
      ${renderTabs('catalog', [['products','全部商品',counts.products],['submissions','待审提报',counts.submissions],['categories','三级类目',counts.categories],['tags','标签库',counts.tags]], state.catalogTab)}
      ${renderCatalogTab(data, { products, submissions, categories, tags })}
    </section>
    ${['products', 'submissions'].includes(state.catalogTab) ? renderBatchBar(state.catalogTab === 'submissions' ? 'productSubmissions' : 'products', counts[state.catalogTab] || 0) : ''}`;
}

function renderCatalogTab(data, values) {
  if (state.catalogTab === 'submissions') return renderSubmissionTable(values.submissions);
  if (state.catalogTab === 'categories') return `${renderEndpointState(data.categories, '三级类目读取端点不可用')}${renderCategoryTable(values.categories)}${renderCategoryForm()}`;
  if (state.catalogTab === 'tags') return `${renderEndpointState(data.tags, '标签读取端点不可用')}${renderTagTable(values.tags)}${renderTagForm()}`;
  return renderProductTable(values.products);
}

function renderProductTable(products) {
  if (!products.length) return renderEmptyState('暂无商品');
  const selected = selectedSet('products');
  return `<div class="table-wrap"><table><thead><tr><th><input class="checkbox" type="checkbox" data-select-all="products" aria-label="全选商品" /></th><th>商品 / ID</th><th>商家钱包</th><th>状态</th><th>SKU</th><th>结算价</th><th>库存</th><th>类目 / 标签</th><th></th></tr></thead><tbody>
    ${products.map((product) => `<tr>
      <td><input class="checkbox" type="checkbox" data-select-resource="products" data-select-id="${escapeHtml(product.id)}" ${selected.has(String(product.id)) ? 'checked' : ''} aria-label="选择商品" /></td>
      <td><div class="cell-title"><strong>${escapeHtml(product.title)}</strong><small class="mono">${escapeHtml(product.id)}</small></div></td>
      <td class="address" title="${escapeHtml(product.sellerAddress)}">${escapeHtml(shortAddress(product.sellerAddress) || '--')}</td>
      <td>${statusBadge(product.status)}</td><td>${escapeHtml(product.sku || product.skus?.length || '--')}</td>
      <td class="numeric">${escapeHtml(formatAmount(product.priceNpl))} NPL</td><td class="numeric">${escapeHtml(product.stock ?? '--')}</td>
      <td><div class="cell-title"><strong>${escapeHtml(product.category || '--')}</strong><small>${escapeHtml((product.tags || []).join(' · ') || '--')}</small></div></td>
      <td><button class="button icon small" type="button" data-view-product="${escapeHtml(product.id)}" title="商品详情" aria-label="商品详情">${icon('eye')}</button></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function renderSubmissionTable(submissions) {
  if (!submissions.length) return renderEmptyState('暂无商品提报');
  const selected = selectedSet('productSubmissions');
  return `<div class="table-wrap"><table><thead><tr><th><input class="checkbox" type="checkbox" data-select-all="productSubmissions" aria-label="全选提报" /></th><th>提报 / ID</th><th>商家钱包</th><th>门店</th><th>状态</th><th>锁定</th><th>创建时间</th><th></th></tr></thead><tbody>
    ${submissions.map((submission) => `<tr>
      <td><input class="checkbox" type="checkbox" data-select-resource="productSubmissions" data-select-id="${escapeHtml(submission.id)}" ${selected.has(String(submission.id)) ? 'checked' : ''} aria-label="选择提报" /></td>
      <td><div class="cell-title"><strong>${escapeHtml(submission.title)}</strong><small class="mono">${escapeHtml(submission.id)}</small></div></td>
      <td class="address" title="${escapeHtml(submission.merchantAddress)}">${escapeHtml(shortAddress(submission.merchantAddress))}</td><td>${escapeHtml(submission.storeId || '--')}</td>
      <td>${statusBadge(submission.status)}</td><td>${statusBadge(submission.locked ? 'Locked' : 'Editable')}</td><td>${escapeHtml(formatDateTime(submission.createdAt))}</td>
      <td><div class="table-actions"><button class="button small" type="button" data-product-review="approved" data-id="${escapeHtml(submission.id)}">通过</button><button class="button small" type="button" data-product-review="rejected" data-id="${escapeHtml(submission.id)}">拒绝</button></div></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function renderCategoryTable(categories) {
  if (!categories.length) return renderEmptyState('暂无类目数据', '类目读取端点未返回记录。');
  const selected = selectedSet('categories');
  return `<div class="table-wrap"><table><thead><tr><th><input class="checkbox" type="checkbox" data-select-all="categories" aria-label="全选类目" /></th><th>层级</th><th>类目名称</th><th>父级</th><th>排序</th><th>服务费率</th><th>状态</th><th>锁定</th><th></th></tr></thead><tbody>${categories.map((category) => `<tr><td><input class="checkbox" type="checkbox" data-select-resource="categories" data-select-id="${escapeHtml(category.id)}" ${selected.has(String(category.id)) ? 'checked' : ''} /></td><td>L${escapeHtml(category.level || '--')}</td><td><strong>${escapeHtml(category.name)}</strong></td><td>${escapeHtml(category.parentId || '--')}</td><td>${escapeHtml(category.sortOrder ?? category.sortWeight ?? '--')}</td><td>${category.serviceFeeBps == null ? '--' : `${Number(category.serviceFeeBps) / 100}%`}</td><td>${statusBadge(category.enabled === false ? 'Inactive' : 'Active')}</td><td>${category.locked ? statusBadge('Locked') : '--'}</td><td><button class="button icon small" type="button" data-category-delete="${escapeHtml(category.id)}" ${category.locked ? 'disabled' : ''} title="删除类目" aria-label="删除类目">${icon('trash')}</button></td></tr>`).join('')}</tbody></table></div>`;
}

function renderCategoryForm() {
  return `<form class="form-grid" data-action-form="category" style="margin-top:16px"><label class="field"><span>层级</span><select name="level" required><option value="1">一级类目</option><option value="2">二级类目</option><option value="3">三级类目</option></select></label><label class="field"><span>父级类目 ID</span><input name="parentId" /></label><label class="field"><span>类目名称 <i class="required-mark">*</i></span><input name="name" required /></label><label class="field"><span>图标 URL</span><input name="iconUrl" type="url" /></label><label class="field"><span>排序权重</span><input name="sortWeight" type="number" value="0" /></label><label class="field"><span>基础服务费率（bps）</span><input name="serviceFeeBps" type="number" min="0" max="10000" value="0" /></label><label class="switch-line"><span>启用类目</span><input class="switch" type="checkbox" name="enabled" checked /></label><div class="filter-actions"><button class="button primary" type="submit">保存类目</button></div></form>`;
}

function renderTagTable(tags) {
  if (!tags.length) return renderEmptyState('暂无标签数据', '标签读取端点未返回记录。');
  const selected = selectedSet('tags');
  return `<div class="table-wrap"><table><thead><tr><th><input class="checkbox" type="checkbox" data-select-all="tags" aria-label="全选标签" /></th><th>标签</th><th>关联商品</th><th>推流权重</th><th>状态</th><th>锁定</th><th></th></tr></thead><tbody>${tags.map((tag) => `<tr><td><input class="checkbox" type="checkbox" data-select-resource="tags" data-select-id="${escapeHtml(tag.id)}" ${selected.has(String(tag.id)) ? 'checked' : ''} /></td><td><strong>${escapeHtml(tag.name)}</strong><br><small class="mono muted">${escapeHtml(tag.id)}</small></td><td>${escapeHtml(tag.productCount ?? '--')}</td><td>${escapeHtml(tag.dispatchWeight ?? '--')}</td><td>${statusBadge(tag.enabled === false ? 'Inactive' : 'Active')}</td><td>${tag.locked ? statusBadge('Locked') : '--'}</td><td><button class="button icon small" type="button" data-tag-delete="${escapeHtml(tag.id)}" ${tag.locked ? 'disabled' : ''} title="删除标签" aria-label="删除标签">${icon('trash')}</button></td></tr>`).join('')}</tbody></table></div>`;
}

function renderTagForm() {
  return `<form class="form-grid" data-action-form="tag" style="margin-top:16px"><label class="field"><span>标签名称 <i class="required-mark">*</i></span><input name="name" required /></label><label class="field"><span>前台推流权重</span><input name="dispatchWeight" type="number" value="0" /></label><label class="switch-line"><span>启用标签</span><input class="switch" type="checkbox" name="enabled" checked /></label><div class="filter-actions"><button class="button primary" type="submit">保存标签</button></div></form>`;
}

function renderAllocation(data) {
  const response = dataOf(data.ratio, []);
  const config = configValue(response, 'ratio-config', {});
  const beneficiaryConfig = configValue(dataOf(data.beneficiaries, []), 'ratio-config', config);
  const backendBeneficiaries = arrayOf(config.beneficiaryWeights || config.beneficiaries || beneficiaryConfig.beneficiaryWeights || []);
  if (!state.beneficiaries.length && backendBeneficiaries.length) {
    state.beneficiaries = backendBeneficiaries.map((entry) => ({
      walletAddress: entry.walletAddress || entry.address || '',
      weightBps: entry.weightBps ?? entry.weight ?? '',
      role: entry.role || 'beneficiary'
    }));
  }
  const audit = arrayOf(dataOf(data.audit, [])).filter((entry) => /ratio|beneficiar|prize-pool/i.test(String(entry.action))).slice(0, 12);
  const burn = config.nplBurnBps ?? config.burnBps ?? '';
  const poolReturn = config.nplCirculationBps ?? config.poolReturnBps ?? config.liquidityPoolBps ?? '';
  const nplTotal = burn === '' || poolReturn === '' ? null : Number(burn) + Number(poolReturn);
  const commissionValues = ['platformFeeBps', 'prizePoolBps', 'regionBps', 'referralBps'].map((key) => config[key]);
  const commissionTotal = commissionValues.some((value) => value === undefined || value === null || value === '')
    ? null
    : commissionValues.reduce((sum, value) => sum + Number(value), 0);

  return `${renderSourceStrip(['/api/admin/configs', '/api/admin/audit-logs'])}
    <form data-action-form="ratio" class="content-grid">
      <section class="panel">
        <div class="panel-head"><div><h2>NPL 支付与销毁路由</h2><p class="panel-subtitle">以 basis points 精确配置，10,000 bps = 100%</p></div>${statusBadge(nplTotal === 10000 ? 'Valid' : nplTotal === null ? 'Unconfigured' : 'Invalid')}</div>
        <div class="form-grid">
          <label class="field"><span>商品结算成本价（NPL）</span><input name="settlementCostNpl" inputmode="decimal" value="${escapeHtml(config.settlementCostNpl ?? '')}" placeholder="按商品配置" /></label>
          <label class="field"><span>NPL 支付比例（bps）</span><input name="nplPaymentBps" type="number" value="${escapeHtml(config.nplPaymentBps ?? 10000)}" readonly /></label>
          <label class="field"><span>销毁 Burn（bps） <i class="required-mark">*</i></span><input name="burnBps" type="number" min="0" max="10000" required value="${escapeHtml(burn)}" placeholder="例如 2000" /></label>
          <label class="field"><span>回流释放池（bps） <i class="required-mark">*</i></span><input name="poolReturnBps" type="number" min="0" max="10000" required value="${escapeHtml(poolReturn)}" placeholder="例如 8000" /></label>
          <label class="field"><span>BNM 返还比例（bps）</span><input name="bnmRebateBps" type="number" min="0" max="10000" value="${escapeHtml(config.bnmRebateBps ?? '')}" placeholder="未配置" /></label>
          <label class="field"><span>商家成本权重（bps）</span><input name="merchantCostBps" type="number" min="0" max="10000" value="${escapeHtml(config.merchantCostBps ?? '')}" placeholder="未配置" /></label>
        </div>
        <div class="ratio-total"><span>销毁 + 回流</span><strong data-npl-route-total class="${nplTotal !== null && nplTotal > 10000 ? 'invalid' : ''}">${nplTotal === null ? '--' : `${(nplTotal / 100).toFixed(2)}%`}</strong></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>四层佣金分配</h2><p class="panel-subtitle">平台、大奖池、区域代理与 Referral</p></div></div>
        <div class="form-grid">
          ${ratioField('平台技术服务费', 'platformFeeBps', config.platformFeeBps)}
          ${ratioField('秒杀大奖池', 'prizePoolBps', config.prizePoolBps)}
          ${ratioField('区域代理结算', 'regionBps', config.regionBps)}
          ${ratioField('Referral 收益', 'referralBps', config.referralBps)}
        </div>
        <div class="ratio-total"><span>四层合计</span><strong data-commission-total class="${commissionTotal !== null && commissionTotal > 10000 ? 'invalid' : ''}">${commissionTotal === null ? '--' : `${(commissionTotal / 100).toFixed(2)}%`}</strong></div>
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>链上收款地址</h2><p class="panel-subtitle">非零分配项必须绑定明确地址，确认后写入 Escrow 版本配置</p></div>${statusBadge(config.status || 'Unconfigured')}</div>
        <div class="form-grid">
          ${ratioReceiverField('平台服务费', 'platformReceiver', config.platformReceiver)}
          ${ratioReceiverField('区域代理', 'regionReceiver', config.regionReceiver)}
          ${ratioReceiverField('Referral', 'referralReceiver', config.referralReceiver)}
          ${ratioReceiverField('秒杀奖池', 'prizePoolReceiver', config.prizePoolReceiver)}
          ${ratioReceiverField('销毁', 'burnReceiver', config.burnReceiver || '0x000000000000000000000000000000000000dEaD')}
          ${ratioReceiverField('回流释放池', 'circulationReceiver', config.circulationReceiver)}
        </div>
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>受益人地址与权重</h2><p class="panel-subtitle">每个地址、角色和权重均进入二次签名 payload</p></div><button class="button small" type="button" data-add-beneficiary>${icon('plus')}添加受益人</button></div>
        <div class="beneficiary-list" data-beneficiary-list>${renderBeneficiaryRows()}</div>
        ${state.beneficiaries.length ? '' : renderEmptyState('尚未添加受益人', '添加地址后配置权重与角色。')}
        <div class="ratio-total"><span>受益人权重合计</span><strong data-beneficiary-total>${formatBeneficiaryTotal()}</strong></div>
        <div class="inline-actions" style="margin-top:14px"><button class="button primary" type="submit">保存比例配置</button></div>
      </section>
    </form>
    <section class="panel wide flush" style="margin-top:14px"><div class="panel-head"><div><h2>比例变更审计</h2><p class="panel-subtitle">旧值、新值、操作钱包与签名摘要</p></div></div><div class="table-wrap">${renderAuditTable(audit, false)}</div></section>`;
}

function ratioField(label, name, value) {
  return `<label class="field"><span>${escapeHtml(label)}（bps）</span><input name="${escapeHtml(name)}" data-commission-bps type="number" min="0" max="10000" value="${escapeHtml(value ?? '')}" placeholder="未配置" /></label>`;
}

function ratioReceiverField(label, name, value) {
  return `<label class="field"><span>${escapeHtml(label)}地址</span><input name="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}" placeholder="0x..." autocomplete="off" /></label>`;
}

function renderBeneficiaryRows() {
  return state.beneficiaries.map((beneficiary, index) => `<div class="beneficiary-row" data-beneficiary-index="${index}">
    <label class="field"><span>钱包地址</span><input name="beneficiaryAddress" value="${escapeHtml(beneficiary.walletAddress)}" placeholder="0x..." required /></label>
    <label class="field"><span>角色</span><select name="beneficiaryRole">${['beneficiary','platform','regional-agent','channel','referral'].map((role) => `<option value="${role}" ${beneficiary.role === role ? 'selected' : ''}>${role}</option>`).join('')}</select></label>
    <label class="field"><span>权重（bps）</span><input name="beneficiaryWeightBps" type="number" min="0" max="10000" value="${escapeHtml(beneficiary.weightBps)}" required /></label>
    <button class="button icon" type="button" data-remove-beneficiary="${index}" aria-label="移除受益人" title="移除">${icon('trash')}</button>
  </div>`).join('');
}

function formatBeneficiaryTotal() {
  if (!state.beneficiaries.length) return '--';
  const total = state.beneficiaries.reduce((sum, entry) => sum + Number(entry.weightBps || 0), 0);
  return `${(total / 100).toFixed(2)}%`;
}

function renderSeckill(data) {
  const current = dataOf(data.current, {});
  const session = current.session || {};
  const product = current.product || {};
  const reportsPayload = dataOf(data.reports, {});
  const reports = arrayOf(reportsPayload.reports || reportsPayload);
  const schedules = configEntries(dataOf(data.schedules, []), 'seckill:').map((entry) => ({ id: entry.key, ...(entry.value || {}) }));
  const products = arrayOf(dataOf(data.products, []));
  const rules = dataOf(data.rules, current.rules || {});
  const rulesText = extractContentText(rules);
  const scheduleRows = schedules.length ? schedules : (session.id ? [session] : []);
  captureBreakers(dataOf(data.breakers, {}));

  return `${renderSourceStrip(['/api/seckill/current', '/api/seckill/reports', '/api/seckill/rules', '/api/admin/configs'])}
    ${renderEndpointState(data.current, '当前秒杀场次读取不可用')}
    ${renderEndpointState(data.reports, '秒杀战报读取不可用')}
    ${renderEndpointState(data.rules, '秒杀规则读取不可用')}
    <section class="metric-grid">
      ${metricCard('当前场次', session.id || null, { detail: session.status || '后端未返回' })}
      ${metricCard('本场奖池', session.prizePoolNpl ?? null, { suffix: 'NPL' })}
      ${metricCard('累计参与', session.totalBuys ?? null, { detail: product.title || '后端未返回商品' })}
      ${metricCard('接力剩余', session.relaySecondsLeft ?? null, { suffix: '秒', signal: Number(session.relaySecondsLeft) < 60 ? 'warning' : undefined })}
    </section>
    <div class="content-grid">
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>场次排期</h2><p class="panel-subtitle">新建、发布、单品指派与活动库存锁定</p></div>${statusBadge(session.status || 'Unknown')}</div>
        ${renderEndpointState(data.schedules, '排期列表端点不可用，以下仅展示当前场次')}
        <div class="table-wrap">${renderScheduleTable(scheduleRows, product)}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>新建秒杀场次</h2><p class="panel-subtitle">日期、库存和三段时间控制</p></div></div>
        <form class="form-grid" data-action-form="seckill-schedule">
          <label class="field"><span>场次 ID</span><input name="sessionId" placeholder="留空由后端生成" /></label>
          <label class="field"><span>指派商品 <i class="required-mark">*</i></span><select name="productId" required><option value="">选择商品</option>${products.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === session.productId ? 'selected' : ''}>${escapeHtml(entry.title)} · ${escapeHtml(entry.id)}</option>`).join('')}</select></label>
          <label class="field"><span>开始时间 <i class="required-mark">*</i></span><input type="datetime-local" name="startsAt" required value="${escapeHtml(formatDateInput(session.startsAt))}" /></label>
          <label class="field"><span>结束时间 <i class="required-mark">*</i></span><input type="datetime-local" name="endsAt" required value="${escapeHtml(formatDateInput(session.endsAt))}" /></label>
          <label class="field"><span>活动锁定库存</span><input type="number" name="lockedStock" min="1" placeholder="未配置" /></label>
          <label class="field"><span>发布状态</span><select name="status"><option value="scheduled">排期</option><option value="live">立即发布</option><option value="draft">草稿</option></select></label>
          <label class="field"><span>最低支付额（NPL）</span><input name="minimumNplAmount" inputmode="decimal" required placeholder="按商品价" /></label>
          <label class="field"><span>本场奖池（NPL）</span><input name="prizePoolNpl" inputmode="decimal" value="0" /></label>
          <label class="field"><span>主场总时长（分钟）</span><input type="number" name="mainDurationMinutes" min="1" placeholder="60" /></label>
          <label class="field"><span>接力初始时长（秒）</span><input type="number" name="relayInitialSeconds" min="1" placeholder="后端默认" /></label>
          <label class="field"><span>单笔充能（秒）</span><input type="number" name="rechargeSeconds" min="0" placeholder="30" /></label>
          <div class="filter-actions"><button class="button primary" type="submit">创建排期</button></div>
        </form>
      </section>
      <section class="panel danger-zone">
        <div class="panel-head"><div><h2>应急控制</h2><p class="panel-subtitle">操作均需钱包二次签名</p></div>${statusBadge('High Risk')}</div>
        ${renderEndpointState(data.breakers, '熔断状态读取端点不可用')}
        <div class="danger-actions">
          ${circuitAction('orders', '下单总开关', '停止新订单进入托管')}
          ${circuitAction('seckill', '秒杀大厅', '停止抢购与接力充能')}
          ${circuitAction('claims', '资产 Claim', '停止收益提取')}
          <div class="danger-action"><div><b>强截止当前场次</b><small>触发 force-cutoff 熔断并保留审计</small></div><button class="button danger small" type="button" data-force-cutoff data-session-id="${escapeHtml(session.id || '')}" ${session.id ? '' : 'disabled'}>强截止</button></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>大奖池注入</h2><p class="panel-subtitle">服务端必须返回链上 transactionIntent</p></div></div>
        <form class="form-grid" data-action-form="prize-pool">
          <label class="field"><span>场次 ID</span><input name="sessionId" value="${escapeHtml(session.id || '')}" required /></label>
          <label class="field"><span>注入金额（NPL）</span><input name="amountNpl" inputmode="decimal" required /></label>
          <label class="field wide"><span>资金说明</span><textarea name="note" required></textarea></label>
          <div class="filter-actions"><button class="button primary" type="submit">签名并发起链上注入</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>规则编辑器</h2><p class="panel-subtitle">C 端与商家端统一规则源</p></div></div>
        <form data-action-form="seckill-rules"><label class="field"><span>秒杀 / 接力规则</span><textarea name="text" required>${escapeHtml(rulesText)}</textarea></label><div class="inline-actions" style="margin-top:12px"><button class="button primary" type="submit">发布规则</button></div></form>
      </section>
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>历史战报</h2><p class="panel-subtitle">中奖钱包、订单、奖池与参与量</p></div></div>
        <div class="table-wrap">${renderSeckillReports(reports)}</div>
      </section>
    </div>`;
}

function renderScheduleTable(rows, currentProduct) {
  if (!rows.length) return renderEmptyState('暂无秒杀排期');
  return `<table><thead><tr><th>场次</th><th>商品</th><th>状态</th><th>开始</th><th>结束</th><th>主倒计时</th><th>接力倒计时</th><th>奖池</th><th>发布</th></tr></thead><tbody>${rows.map((row) => {
    const sessionId = row.id || row.sessionId;
    const due = Number.isFinite(Date.parse(row.startsAt)) && Date.parse(row.startsAt) <= Date.now();
    const publishable = ['scheduled', 'PendingChainPublish'].includes(String(row.status));
    const pending = row.status === 'PendingChainPublish';
    const action = publishable
      ? `<button class="button ${pending ? '' : 'primary'} small" type="button" data-publish-seckill="${escapeHtml(sessionId)}" ${due ? '' : 'disabled'} title="${due ? (pending ? '重试链上发布' : '签名并发布到链上') : '尚未到开始时间'}">${pending ? '重试发布' : '发布'}</button>`
      : '--';
    return `<tr><td class="mono">${escapeHtml(sessionId)}</td><td>${escapeHtml(row.productTitle || (row.productId === currentProduct.id ? currentProduct.title : row.productId) || '--')}</td><td>${statusBadge(row.status)}</td><td>${escapeHtml(formatDateTime(row.startsAt))}</td><td>${escapeHtml(formatDateTime(row.endsAt))}</td><td>${row.mainSecondsLeft == null ? '--' : `${escapeHtml(row.mainSecondsLeft)} 秒`}</td><td>${row.relaySecondsLeft == null ? '--' : `${escapeHtml(row.relaySecondsLeft)} 秒`}</td><td>${row.prizePoolNpl == null ? '--' : `${escapeHtml(formatAmount(row.prizePoolNpl))} NPL`}</td><td>${action}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function renderSeckillReports(reports) {
  if (!reports.length) return renderEmptyState('暂无战报');
  return `<table><thead><tr><th>场次</th><th>中奖钱包</th><th>中奖订单</th><th>奖池</th><th>总参与</th><th>生成时间</th></tr></thead><tbody>${reports.map((report) => `<tr><td class="mono">${escapeHtml(report.sessionId || report.id)}</td><td class="address" title="${escapeHtml(report.winnerAddress)}">${escapeHtml(shortAddress(report.winnerAddress) || '--')}</td><td class="mono">${escapeHtml(report.winningOrderId || '--')}</td><td>${escapeHtml(formatAmount(report.prizePoolNpl))} NPL</td><td>${escapeHtml(report.totalBuys ?? '--')}</td><td>${escapeHtml(formatDateTime(report.createdAt))}</td></tr>`).join('')}</tbody></table>`;
}

function circuitAction(scope, label, detail) {
  const current = state.breakers[scope];
  const pending = String(current?.state || '').startsWith('Pending');
  const status = current?.state || (current?.enabled ? 'Paused' : 'Open');
  return `<div class="danger-action"><div><b>${escapeHtml(label)} ${current ? statusBadge(status) : ''}</b><small>${escapeHtml(detail)}${pending ? ' · 等待链上确认' : ''}${current?.updatedAt ? ` · ${escapeHtml(formatDateTime(current.updatedAt))}` : ''}</small></div><div class="inline-actions"><button class="button small" type="button" data-circuit="${scope}" data-enabled="false" ${pending || (current && !current.enabled) ? 'disabled' : ''}>恢复</button><button class="button danger small" type="button" data-circuit="${scope}" data-enabled="true" ${pending || current?.enabled ? 'disabled' : ''}>暂停</button></div></div>`;
}

function captureBreakers(payload) {
  for (const entry of arrayOf(payload?.circuits || payload?.breakers || [])) {
    if (entry?.scope) state.breakers[entry.scope] = entry;
  }
}

function extractContentText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.text || value.body || value.content || value.markdown || (Array.isArray(value.rules) ? value.rules.join('\n') : '');
}

function renderRisk(data) {
  const risk = dataOf(data.risk, {});
  const blacklists = arrayOf(risk.blacklists);
  const policies = configValue(dataOf(data.policies, []), 'risk-policies', risk.policies || {});
  const incidents = arrayOf(risk.events || risk.incidents).map((entry) => ({
    ...entry,
    type: entry.type || entry.kind || entry.eventType,
    subject: entry.subject || entry.walletAddress || entry.ipHash || entry.deviceHash || entry.payload?.walletAddress,
    reason: entry.reason || entry.payload?.reason || entry.payload?.note,
    payload: entry.payload && typeof entry.payload === 'object' ? entry.payload : {}
  }));
  const highGasEvents = incidents.filter((entry) => String(entry.type).toLowerCase() === 'high-gas');
  const tradeLocks = incidents.filter((entry) => String(entry.type).toLowerCase() === 'trade-lock' && /active|locked|open|blocked/i.test(String(entry.status)));
  captureBreakers(dataOf(data.breakers, {}));
  return `${renderSourceStrip(['/api/admin/risk-events', '/api/admin/configs'])}
    <section class="metric-grid">
      ${metricCard('风险事件', data.risk?.ok ? incidents.length : null, { signal: incidents.length ? 'warning' : 'safe' })}
      ${metricCard('高 Gas 拦截', data.risk?.ok ? highGasEvents.length : null, { signal: highGasEvents.length ? 'danger' : 'safe' })}
      ${metricCard('有效交易锁', data.risk?.ok ? tradeLocks.length : null, { signal: tradeLocks.length ? 'danger' : 'safe' })}
      ${metricCard('黑名单对象', data.risk?.ok ? blacklists.length : null)}
    </section>
    <div class="content-grid">
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>风险事件</h2><p class="panel-subtitle">链上攻击与传统电商作弊统一事件流</p></div>${statusBadge(incidents.length ? 'Action Required' : 'Clear')}</div>
        ${renderEndpointState(data.risk, '风控事件端点不可用')}
        <div class="table-wrap">${renderRiskIncidents(incidents)}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>加入黑名单</h2><p class="panel-subtitle">钱包、IP 段与设备指纹独立维护</p></div></div>
        <form class="form-grid" data-action-form="blacklist">
          <label class="field"><span>对象类型</span><select name="type"><option value="wallet">钱包地址</option><option value="ip">IP / CIDR</option><option value="device">设备指纹</option></select></label>
          <label class="field"><span>对象值 <i class="required-mark">*</i></span><input name="value" required /></label>
          <label class="field wide"><span>锁定原因 <i class="required-mark">*</i></span><textarea name="reason" required></textarea></label>
          <label class="field"><span>锁定时长（小时）</span><input name="durationHours" type="number" min="1" placeholder="留空为长期" /></label>
          <div class="filter-actions"><button class="button danger" type="submit">签名并锁定</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>识别策略</h2><p class="panel-subtitle">高频行为、设备群控与 Gas 阈值</p></div><button class="button primary small" type="button" data-submit-external-form="risk-policy-form">保存策略</button></div>
        ${renderEndpointState(data.policies, '风控策略读取端点不可用')}
        <form id="risk-policy-form" data-action-form="risk-policies" class="form-grid">
          <label class="field"><span>最高 Gas（Gwei）</span><input name="maxGasGwei" inputmode="decimal" value="${escapeHtml(policies.maxGasGwei ?? '')}" /></label>
          <label class="field"><span>1 分钟钱包切换阈值</span><input name="walletSwitchesPerMinute" type="number" min="1" value="${escapeHtml(policies.walletSwitchesPerMinute ?? '')}" /></label>
          <label class="field"><span>5 分钟取消阈值</span><input name="cancellationsPerFiveMinutes" type="number" min="1" value="${escapeHtml(policies.cancellationsPerFiveMinutes ?? '')}" /></label>
          <label class="field"><span>交易锁定时长（分钟）</span><input name="tradeLockMinutes" type="number" min="1" value="${escapeHtml(policies.tradeLockMinutes ?? '')}" /></label>
          <label class="switch-line"><span>阻断合约账户抢购</span><input class="switch" type="checkbox" name="blockContractCallers" ${policies.blockContractCallers === true ? 'checked' : ''} /></label>
          <label class="switch-line"><span>启用 Flash Loan 检测</span><input class="switch" type="checkbox" name="flashLoanDetection" ${policies.flashLoanDetection === true ? 'checked' : ''} /></label>
        </form>
      </section>
      <section class="panel wide danger-zone">
        <div class="panel-head"><div><h2>全网熔断</h2><p class="panel-subtitle">恢复动作同样需要钱包二次签名</p></div></div>
        ${renderEndpointState(data.breakers, '熔断状态读取端点不可用')}
        <div class="danger-actions">${circuitAction('orders', '订单交易', '停止订单创建和资金托管')}${circuitAction('seckill', '秒杀交易', '停止抢购与场次推进')}${circuitAction('claims', '收益提取', '停止所有 Claim 请求')}</div>
      </section>
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>黑名单</h2><p class="panel-subtitle">当前后端返回的有效锁定对象</p></div></div>
        ${renderEndpointState(data.risk, '黑名单读取端点不可用')}
        <div class="table-wrap">${renderBlacklistTable(blacklists)}</div>
      </section>
    </div>`;
}

function renderRiskIncidents(incidents) {
  if (!incidents.length) return renderEmptyState('当前没有风险事件', '风控 API 已返回 0 条记录。');
  return `<table><thead><tr><th>事件</th><th>类型</th><th>对象</th><th>状态</th><th>事件数据</th><th>时间</th></tr></thead><tbody>${incidents.map((incident) => `<tr><td class="mono">${escapeHtml(incident.id || 'notConfigured')}</td><td><div class="cell-title"><strong>${escapeHtml(incident.type || 'notConfigured')}</strong><small>${escapeHtml(incident.severity || 'notConfigured')}</small></div></td><td class="address" title="${escapeHtml(incident.subject)}">${escapeHtml(shortAddress(incident.subject) || 'notConfigured')}</td><td>${riskStatusBadge(incident.status)}</td><td>${renderRiskEventDetails(incident)}</td><td>${escapeHtml(formatDateTime(incident.createdAt))}</td></tr>`).join('')}</tbody></table>`;
}

function riskStatusBadge(status) {
  const value = String(status || 'notConfigured');
  if (/active|locked|blocked|open/i.test(value)) return `<span class="badge danger">${escapeHtml(value)}</span>`;
  if (/resolved|expired|released|closed/i.test(value)) return `<span class="badge success">${escapeHtml(value)}</span>`;
  return statusBadge(value);
}

function renderRiskEventDetails(incident) {
  const payload = incident.payload && typeof incident.payload === 'object' ? incident.payload : {};
  const details = [];
  if (incident.reason) details.push(['原因', incident.reason]);
  if (payload.txHash || incident.action) details.push(['交易 / 动作', payload.txHash || incident.action]);
  if (payload.gasPriceWei !== undefined) details.push(['Gas 价格', formatGasPriceWei(payload.gasPriceWei)]);
  if (payload.maxGasGwei !== undefined) details.push(['Gas 阈值', `${payload.maxGasGwei} Gwei`]);
  if (payload.lockedUntil) details.push(['锁定至', formatDateTime(payload.lockedUntil)]);
  if (payload.durationMinutes !== undefined) details.push(['锁定时长', `${payload.durationMinutes} 分钟`]);
  const summary = details.length
    ? `<dl class="risk-event-data">${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`
    : '<span class="muted">notConfigured</span>';
  if (!Object.keys(payload).length) return summary;
  return `${summary}<details class="payload-details"><summary>完整 payload</summary><pre class="code-block">${escapeHtml(JSON.stringify(payload, null, 2))}</pre></details>`;
}

function formatGasPriceWei(value) {
  const text = String(value ?? '');
  try {
    const wei = BigInt(text);
    const whole = wei / 1_000_000_000n;
    const fraction = String(wei % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
    return `${text} Wei (${whole}${fraction ? `.${fraction}` : ''} Gwei)`;
  } catch {
    return `${text} Wei`;
  }
}

function renderBlacklistTable(rows) {
  if (!rows.length) return renderEmptyState('暂无黑名单记录');
  return `<table><thead><tr><th>类型</th><th>对象</th><th>原因</th><th>来源</th><th>锁定时间</th><th>到期时间</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.type || 'wallet')}</td><td class="address">${escapeHtml(row.address || row.value || row.deviceFingerprint || row.ip)}</td><td>${escapeHtml(row.reason || '--')}</td><td>${escapeHtml(row.source || '--')}</td><td>${escapeHtml(formatDateTime(row.createdAt))}</td><td>${escapeHtml(formatDateTime(row.expiresAt))}</td></tr>`).join('')}</tbody></table>`;
}

function renderLogistics(data) {
  const configRows = dataOf(data.logistics, []);
  const carriers = configEntries(dataOf(data.carriers, configRows), 'logistics:').map((entry) => ({ carrier: entry.key.replace('logistics:', ''), ...(entry.value || {}) }));
  const templates = arrayOf(dataOf(data.templates, [])).length ? arrayOf(dataOf(data.templates, [])) : configEntries(configRows, 'logistics-template:').map((entry) => ({ id: entry.key, ...(entry.value || {}) }));
  const addresses = arrayOf(dataOf(data.addresses, [])).length ? arrayOf(dataOf(data.addresses, [])) : configEntries(configRows, 'logistics-address:').map((entry) => ({ id: entry.key, ...(entry.value || {}) }));
  const stores = arrayOf(dataOf(data.stores, []));
  const printJobs = arrayOf(dataOf(data.printJobs, []));
  return `${renderSourceStrip(['/api/admin/configs', '/api/admin/print-jobs', '/api/stores'])}
    <div class="content-grid">
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>承运商与电子面单</h2><p class="panel-subtitle">接口凭据不在列表中回显</p></div></div>
        ${renderEndpointState(data.carriers, '承运商读取端点不可用')}
        <div class="table-wrap">${renderCarrierTable(carriers)}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>承运商配置</h2><p class="panel-subtitle">商户编码、密钥与月结账号</p></div></div>
        <form class="form-grid" data-action-form="logistics-carrier" autocomplete="off">
          <label class="field"><span>物流公司</span><select name="carrier"><option value="SF">顺丰速运</option><option value="JD">京东快递</option><option value="YTO">圆通速递</option><option value="ZTO">中通快递</option><option value="STO">申通快递</option><option value="EMS">EMS 邮政</option></select></label>
          <label class="field"><span>接口服务商</span><select name="provider"><option value="kuaidi100">快递 100</option><option value="cainiao">菜鸟网络</option></select></label>
          <label class="field"><span>PartnerID</span><input name="partnerId" autocomplete="off" /></label>
          <label class="field"><span>凭据来源</span><input value="服务端环境变量" readonly /></label>
          <label class="field"><span>电子面单月结账号</span><input name="monthlyAccount" /></label>
          <label class="field"><span>打印模板</span><input name="printerTemplate" /></label>
          <label class="switch-line"><span>启用电子面单</span><input class="switch" type="checkbox" name="electronicWaybill" checked /></label>
          <label class="switch-line"><span>设为默认承运商</span><input class="switch" type="checkbox" name="isDefault" /></label>
          <div class="filter-actions"><button class="button primary" type="submit">保存承运商</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>运费模板</h2><p class="panel-subtitle">按件、按重量、自提与区域限制</p></div></div>
        ${renderEndpointState(data.templates, '运费模板读取端点不可用')}
        <form class="form-grid" data-action-form="logistics-template">
          <label class="field"><span>模板名称</span><input name="name" required /></label>
          <label class="field"><span>计费方式</span><select name="chargeMode"><option value="quantity">按件数</option><option value="weight">按重量</option></select></label>
          <label class="field"><span>首件 / 首重运费（NPL）</span><input name="baseFeeNpl" inputmode="decimal" required /></label>
          <label class="field"><span>续件 / 续重运费（NPL）</span><input name="incrementFeeNpl" inputmode="decimal" required /></label>
          <label class="field wide"><span>偏远地区禁发行政区</span><textarea name="blockedRegionCodes" placeholder="行政区代码，每行一个"></textarea></label>
          <label class="switch-line"><span>大连本市到店自提免运费</span><input class="switch" type="checkbox" name="dalianPickupFree" checked /></label>
          <div class="filter-actions"><button class="button primary" type="submit">保存模板</button></div>
        </form>
      </section>
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>物理地址库</h2><p class="panel-subtitle">发货仓、退货仓和门店自提地址</p></div><button class="button small" type="button" data-open-form="logistics-address">${icon('plus')}新增地址</button></div>
        ${renderEndpointState(data.addresses, '物流地址读取端点不可用')}
        <div class="table-wrap">${renderAddressTable(addresses, stores)}</div>
      </section>
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>打印任务</h2><p class="panel-subtitle">电子面单与自提单队列</p></div></div>
        <div class="table-wrap">${renderPrintJobs(printJobs)}</div>
      </section>
    </div>`;
}

function renderPrintJobs(rows) {
  if (!rows.length) return renderEmptyState('暂无打印任务');
  return `<table><thead><tr><th>任务</th><th>类型</th><th>订单</th><th>商家</th><th>份数</th><th>状态</th><th>重试</th><th>更新时间</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.id)}</td><td>${escapeHtml(row.jobType)}</td><td class="mono">${escapeHtml(row.orderId || '--')}</td><td class="address">${escapeHtml(shortAddress(row.merchantAddress))}</td><td>${escapeHtml(row.copies ?? '--')}</td><td>${statusBadge(row.status)}</td><td>${escapeHtml(row.attempts ?? '--')}</td><td>${escapeHtml(formatDateTime(row.updatedAt))}</td></tr>`).join('')}</tbody></table>`;
}

function renderCarrierTable(rows) {
  if (!rows.length) return renderEmptyState('暂无承运商配置');
  return `<table><thead><tr><th>承运商</th><th>接口服务商</th><th>电子面单</th><th>月结账号</th><th>默认</th><th>状态</th><th>更新时间</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.name || row.carrier)}</strong></td><td>${escapeHtml(row.provider || '--')}</td><td>${statusBadge(row.electronicWaybill ? 'Enabled' : 'Disabled')}</td><td>${escapeHtml(row.monthlyAccountMasked || '--')}</td><td>${row.isDefault || row.default ? statusBadge('Default') : '--'}</td><td>${statusBadge(row.enabled === false ? 'Inactive' : 'Active')}</td><td>${escapeHtml(formatDateTime(row.updatedAt))}</td></tr>`).join('')}</tbody></table>`;
}

function renderAddressTable(addresses, stores) {
  const rows = [
    ...addresses.map((row) => ({ ...row, source: 'logistics' })),
    ...stores.map((row) => ({ ...row, type: 'pickup-store', source: 'stores' }))
  ];
  if (!rows.length) return renderEmptyState('暂无物理地址');
  return `<table><thead><tr><th>类型</th><th>名称</th><th>行政区</th><th>地址</th><th>联系人</th><th>来源</th><th>状态</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.type || '--')}</td><td><strong>${escapeHtml(row.name || '--')}</strong></td><td class="mono">${escapeHtml(row.regionCode || '--')}</td><td>${escapeHtml(row.address || row.detail || '--')}</td><td>${escapeHtml(row.contactName || '--')} ${escapeHtml(row.phoneMasked || '')}</td><td class="mono">${escapeHtml(row.source)}</td><td>${statusBadge(row.enabled === false ? 'Inactive' : 'Active')}</td></tr>`).join('')}</tbody></table>`;
}

function renderRefunds(data) {
  const search = dataOf(data.search, {});
  const orders = arrayOf(search.results?.orders);
  const afterSalePayload = dataOf(data.afterSales, {});
  const afterSales = arrayOf(afterSalePayload.cases);
  const refunds = arrayOf(dataOf(data.refunds, []));
  const forceReceipt = state.lastAction?.action === 'admin.force-refund' ? state.lastAction : null;
  const openCases = afterSales.filter((entry) => isAfterSaleResolvable(entry)).length;
  return `${renderSourceStrip(['/api/admin/after-sales', '/api/admin/after-sales/resolve', '/api/admin/search', '/api/admin/force-refund'])}
    <section class="metric-grid">
      ${metricCard('售后案件', data.afterSales?.ok ? afterSales.length : null)}
      ${metricCard('待仲裁', data.afterSales?.ok ? openCases : null, { signal: openCases ? 'warning' : 'safe' })}
      ${metricCard('链上待确认', data.afterSales?.ok ? afterSales.filter((entry) => /^Awaiting/i.test(String(entry.status))).length : null)}
      ${metricCard('已结案', data.afterSales?.ok ? afterSales.filter((entry) => /Resolved|Closed/i.test(String(entry.status))).length : null)}
    </section>
    <div class="content-grid">
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>售后仲裁列表</h2><p class="panel-subtitle">换货、延期、恢复履约、完成交易与退款决议</p></div>${statusBadge(openCases ? 'Action Required' : 'Clear')}</div>
        ${renderEndpointState(data.afterSales, '售后案件读取端点不可用')}
        <div class="table-wrap">${renderAfterSaleCases(afterSales)}</div>
      </section>
    </div>
    ${renderGlobalFilters('refunds')}
    <div class="content-grid">
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>订单与退款队列</h2><p class="panel-subtitle">仅后端判定可退款的订单可进入强退流程</p></div></div>
        ${renderEndpointState(data.refunds, '清算请求读取端点不可用')}
        <div class="table-wrap">${renderRefundOrders(orders, refunds)}</div>
      </section>
      <section class="panel danger-zone">
        <div class="panel-head"><div><h2>平台强制退款</h2><p class="panel-subtitle">请求、链上退款、BNM 销毁与商家扣罚</p></div>${statusBadge('High Risk')}</div>
        <form class="form-grid" data-action-form="force-refund">
          <label class="field wide"><span>订单号 <i class="required-mark">*</i></span><input name="orderId" required /></label>
          <label class="field wide"><span>退款原因 <i class="required-mark">*</i></span><textarea name="reason" required></textarea></label>
          <label class="field"><span>商家扣罚（NPL）</span><input name="merchantPenaltyNpl" inputmode="decimal" /></label>
          <label class="switch-line"><span>要求退回实物</span><input class="switch" type="checkbox" name="returnRequired" /></label>
          <div class="filter-actions"><button class="button danger" type="submit">二次签名并发起强退</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>原子流程状态</h2><p class="panel-subtitle">每一步以服务端响应或链上回执为准</p></div></div>
        <div class="timeline">
          ${refundTimelineRow('强退请求', forceReceipt ? 'Accepted' : 'Waiting', forceReceipt ? '服务端已将订单置为 RefundRequested。' : '等待已签名的退款请求。')}
          ${refundTimelineRow('用户原路返还', forceReceipt?.transaction ? 'Confirmed' : 'Waiting', forceReceipt?.transaction ? '链上交易已确认。' : '等待 transactionIntent 与链上回执。')}
          ${refundTimelineRow('Locked BNM 销毁', firstValue(forceReceipt?.result, ['burnStatus'], 'Waiting'), '等待合约事件或资产账本同步。')}
          ${refundTimelineRow('商家资产扣罚', firstValue(forceReceipt?.result, ['penaltyStatus'], 'Waiting'), '待结算资产或保证金扣减。')}
          ${refundTimelineRow('商品权限释放', firstValue(forceReceipt?.result, ['productUnlockStatus'], 'Waiting'), '商品下架并解除编辑锁。')}
        </div>
      </section>
    </div>
    ${renderBatchBar('orders', orders.length)}`;
}

function renderAfterSaleCases(cases) {
  if (!cases.length) return renderEmptyState('当前没有售后案件', '售后 API 已返回 0 条记录。');
  return `<table><thead><tr><th>案件 / 订单</th><th>请求</th><th>买家</th><th>原因</th><th>状态</th><th>资产 / 延期</th><th>更新时间</th><th></th></tr></thead><tbody>${cases.map((entry) => {
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    const detail = payload.delayUntil ? `延期至 ${formatDateTime(payload.delayUntil)}` : (payload.assetState || entry.originalOrderStatus || 'notConfigured');
    return `<tr><td><div class="cell-title"><strong class="mono">${escapeHtml(entry.id)}</strong><small class="mono">${escapeHtml(entry.orderId || 'notConfigured')}</small></div></td><td>${escapeHtml(entry.requestType || 'notConfigured')}</td><td class="address" title="${escapeHtml(entry.buyerAddress)}">${escapeHtml(shortAddress(entry.buyerAddress) || 'notConfigured')}</td><td>${escapeHtml(entry.reason || 'notConfigured')}</td><td>${afterSaleStatusBadge(entry.status)}</td><td>${escapeHtml(detail)}</td><td class="numeric">${escapeHtml(formatDateTime(entry.updatedAt || entry.createdAt))}</td><td>${isAfterSaleResolvable(entry) ? `<button class="button danger small" type="button" data-after-sale-resolve="${escapeHtml(entry.id)}">仲裁</button>` : `<span class="muted">${escapeHtml(entry.resolution || '已结案')}</span>`}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function isAfterSaleResolvable(entry) {
  return ['open', 'arbitration', 'exchangeapproved', 'delayapproved'].includes(String(entry?.status || '').toLowerCase());
}

function afterSaleStatusBadge(status) {
  const value = String(status || 'notConfigured');
  if (isAfterSaleResolvable({ status: value })) return `<span class="badge warning">${escapeHtml(value)}</span>`;
  return statusBadge(value);
}

function renderRefundOrders(orders, refunds) {
  const rows = refunds.length ? refunds : orders;
  if (!rows.length) return renderEmptyState('暂无订单记录');
  const selected = selectedSet('orders');
  return `<table><thead><tr><th><input class="checkbox" type="checkbox" data-select-all="orders" aria-label="全选订单" /></th><th>订单</th><th>买家</th><th>商家</th><th>金额</th><th>状态</th><th>TxHash</th><th>时间</th><th></th></tr></thead><tbody>${rows.map((order) => {
    const id = String(order.orderId || order.id || '');
    return `<tr><td><input class="checkbox" type="checkbox" data-select-resource="orders" data-select-id="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''} /></td><td class="mono">${escapeHtml(id)}</td><td class="address">${escapeHtml(shortAddress(order.buyerAddress) || '--')}</td><td class="address">${escapeHtml(shortAddress(order.sellerAddress) || '--')}</td><td>${order.amountNpl == null ? '--' : `${escapeHtml(formatAmount(order.amountNpl))} NPL`}</td><td>${statusBadge(order.status)}</td><td class="address">${escapeHtml(shortAddress(order.txHash || order.fundTxHash) || '--')}</td><td>${escapeHtml(formatDateTime(order.createdAt))}</td><td><button class="button danger small" type="button" data-refund-order="${escapeHtml(id)}">强退</button></td></tr>`;
  }).join('')}</tbody></table>`;
}

function refundTimelineRow(label, status, detail) {
  const complete = /confirmed|completed|success|burned|deducted|unlocked/i.test(String(status));
  return `<div class="timeline-row"><span class="timeline-marker">${icon(complete ? 'check' : 'clock')}</span><div class="timeline-copy"><b>${escapeHtml(label)} · ${escapeHtml(status)}</b><p>${escapeHtml(detail)}</p></div></div>`;
}

function renderCms(data) {
  const rows = arrayOf(dataOf(data.content, []));
  const currentMeta = rows.find((entry) => entry.key === 'rules') || rows.find((entry) => entry.key === 'seckill-rules') || { key: 'rules' };
  const currentText = extractContentText(currentMeta);
  const placement = ['banner', 'popup', 'faq', 'legal', 'update'].includes(String(currentMeta.placement)) ? currentMeta.placement : 'faq';
  const status = ['published', 'draft', 'scheduled'].includes(String(currentMeta.status).toLowerCase()) ? String(currentMeta.status).toLowerCase() : 'published';
  const frequency = ['once', 'daily', 'always'].includes(String(currentMeta.frequency)) ? currentMeta.frequency : 'once';
  const regionCodes = Array.isArray(currentMeta.regionCodes) ? currentMeta.regionCodes.join('\n') : String(currentMeta.regionCodes || '');
  return `${renderSourceStrip(['/api/admin/cms'])}
    <div class="content-grid">
      <section class="panel wide">
        <div class="panel-head"><div><h2>CMS 发布规则</h2><p class="panel-subtitle">每个展示位使用独立 Key · ${escapeHtml(formatDateTime(currentMeta?.updatedAt))}</p></div>${statusBadge(currentMeta?.status || (currentText ? 'Published' : 'Draft'))}</div>
        ${renderEndpointState(data.content, 'CMS 内容读取端点不可用')}
        <form class="form-grid" data-action-form="cms">
          <label class="field"><span>内容 Key <i class="required-mark">*</i></span><input name="key" required maxlength="64" pattern="[a-z0-9][a-z0-9._-]{1,63}" value="${escapeHtml(currentMeta.key || 'faq-main')}" /></label>
          <label class="field"><span>展示位 <i class="required-mark">*</i></span><select name="placement" required><option value="banner" ${placement === 'banner' ? 'selected' : ''}>Banner</option><option value="popup" ${placement === 'popup' ? 'selected' : ''}>弹窗</option><option value="faq" ${placement === 'faq' ? 'selected' : ''}>FAQ</option><option value="legal" ${placement === 'legal' ? 'selected' : ''}>法务</option><option value="update" ${placement === 'update' ? 'selected' : ''}>版本更新</option></select></label>
          <label class="field wide"><span>标题</span><input name="title" maxlength="160" value="${escapeHtml(currentMeta.title || '')}" /></label>
          <label class="field"><span>发布状态 <i class="required-mark">*</i></span><select name="status" required><option value="published" ${status === 'published' ? 'selected' : ''}>立即发布</option><option value="draft" ${status === 'draft' ? 'selected' : ''}>保存草稿</option><option value="scheduled" ${status === 'scheduled' ? 'selected' : ''}>定时发布</option></select></label>
          <label class="field" data-cms-schedule ${status === 'scheduled' ? '' : 'hidden'}><span>发布时间 <i class="required-mark">*</i></span><input type="datetime-local" name="publishAt" value="${escapeHtml(formatDateInput(currentMeta.publishAt))}" ${status === 'scheduled' ? 'required' : 'disabled'} /></label>
          <label class="field"><span>展示频次 <i class="required-mark">*</i></span><select name="frequency" required><option value="once" ${frequency === 'once' ? 'selected' : ''}>单次</option><option value="daily" ${frequency === 'daily' ? 'selected' : ''}>每日一次</option><option value="always" ${frequency === 'always' ? 'selected' : ''}>每次打开</option></select></label>
          <label class="field"><span>最低 App 版本</span><input name="minAppVersion" inputmode="numeric" pattern="\\d+(?:\\.\\d+){0,3}" value="${escapeHtml(currentMeta.minAppVersion || '')}" /></label>
          <label class="field wide"><span>行政区代码</span><textarea name="regionCodes" rows="3">${escapeHtml(regionCodes)}</textarea></label>
          <label class="field wide"><span>媒体 URL</span><input name="mediaUrl" type="url" value="${escapeHtml(currentMeta.mediaUrl || '')}" /></label>
          <label class="switch-line wide" data-cms-force-update ${placement === 'update' ? '' : 'hidden'}><span>强制更新</span><input class="switch" type="checkbox" name="forceUpdate" ${currentMeta.forceUpdate === true ? 'checked' : ''} ${placement === 'update' ? '' : 'disabled'} /></label>
          <label class="field wide"><span>内容 <i class="required-mark">*</i></span><textarea name="text" required style="min-height:280px">${escapeHtml(currentText)}</textarea></label>
          <div class="filter-actions"><button class="button primary" type="submit">二次签名并保存</button></div>
        </form>
      </section>
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>发布记录</h2><p class="panel-subtitle">后端返回的内容版本与状态</p></div></div>
        <div class="table-wrap">${renderCmsIndex(rows)}</div>
      </section>
    </div>`;
}

function renderCmsIndex(rows) {
  if (!rows.length) return renderEmptyState('暂无发布记录');
  return `<table><thead><tr><th>Key</th><th>展示位 / 标题</th><th>状态</th><th>版本</th><th>行政区</th><th>App 版本</th><th>发布时间</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.key)}</td><td><div class="cell-title"><strong>${escapeHtml(row.placement || 'notConfigured')}</strong><small>${escapeHtml(row.title || 'notConfigured')}</small></div></td><td>${statusBadge(row.status)}</td><td>${escapeHtml(row.version ?? 'notConfigured')}</td><td>${escapeHtml(Array.isArray(row.regionCodes) && row.regionCodes.length ? row.regionCodes.join(', ') : '全部')}</td><td>${escapeHtml(row.minAppVersion || 'notConfigured')}${row.forceUpdate ? ' · 强更' : ''}</td><td>${escapeHtml(formatDateTime(row.publishAt || row.publishedAt || row.updatedAt))}</td></tr>`).join('')}</tbody></table>`;
}

function updateCmsFields(form) {
  if (!form) return;
  const scheduled = form.elements.status?.value === 'scheduled';
  const scheduleField = form.querySelector('[data-cms-schedule]');
  const publishAt = form.elements.publishAt;
  if (scheduleField) scheduleField.hidden = !scheduled;
  if (publishAt) {
    publishAt.disabled = !scheduled;
    publishAt.required = scheduled;
  }
  const isUpdate = form.elements.placement?.value === 'update';
  const forceField = form.querySelector('[data-cms-force-update]');
  const forceUpdate = form.elements.forceUpdate;
  if (forceField) forceField.hidden = !isUpdate;
  if (forceUpdate) {
    forceUpdate.disabled = !isUpdate;
    if (!isUpdate) forceUpdate.checked = false;
  }
}

function renderNotifications(data) {
  const messages = arrayOf(dataOf(data.messages, []));
  const deliveries = arrayOf(dataOf(data.deliveries, []));
  const gateways = dataOf(data.gateways, {});
  return `${renderSourceStrip(['/api/messages', '/api/admin/messages', '/api/admin/messages/gateways'])}
    <section class="metric-grid">
      ${metricCard('已发布消息', messages.length)}
      ${metricCard('待发送', deliveries.filter((entry) => /pending|scheduled/i.test(String(entry.status))).length || null)}
      ${metricCard('发送失败', deliveries.filter((entry) => /failed|error/i.test(String(entry.status))).length || null)}
      ${metricCard('启用通道', arrayOf(gateways.channels).filter((entry) => entry.enabled).length || null)}
    </section>
    <div class="content-grid">
      <section class="panel">
        <div class="panel-head"><div><h2>新建通知</h2><p class="panel-subtitle">业务、Web3 资产与平台宏观通知</p></div></div>
        <form class="form-grid" data-action-form="notification">
          <label class="field"><span>通知类型</span><select name="type"><option value="business">业务通知</option><option value="asset">Web3 资产</option><option value="platform">平台公告</option><option value="maintenance">紧急维护</option><option value="campaign">活动通知</option></select></label>
          <label class="field"><span>优先级</span><select name="priority"><option value="normal">普通</option><option value="high">高</option><option value="critical">紧急</option></select></label>
          <label class="field wide"><span>标题 <i class="required-mark">*</i></span><input name="title" required /></label>
          <label class="field wide"><span>通知正文 <i class="required-mark">*</i></span><textarea name="text" required></textarea></label>
          <label class="field"><span>受众</span><select name="audience"><option value="all">全网用户</option><option value="region">特定区域</option><option value="merchant">特定商家</option><option value="wallet">特定钱包</option></select></label>
          <label class="field"><span>受众值</span><input name="audienceValue" placeholder="行政区 / 商家 / 钱包" /></label>
          <label class="field"><span>计划发送</span><input type="datetime-local" name="scheduledAt" /></label>
          <label class="field"><span>通道</span><span class="inline-actions"><label><input type="checkbox" name="channelInApp" checked /> 站内</label><label><input type="checkbox" name="channelSms" /> 短信</label><label><input type="checkbox" name="channelEmail" /> 邮件</label><label><input type="checkbox" name="channelPush" /> Push</label></span></label>
          <div class="filter-actions"><button class="button primary" type="submit">签名并发送</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>通道网关</h2><p class="panel-subtitle">短信、SMTP、Firebase 与极光 Push</p></div><button class="button primary small" type="button" data-submit-external-form="gateway-form">保存网关</button></div>
        ${renderEndpointState(data.gateways, '消息网关读取端点不可用')}
        <form id="gateway-form" data-action-form="notification-gateway" class="form-grid" autocomplete="off">
          <label class="field"><span>短信服务商</span><select name="smsProvider"><option value="aliyun">阿里云</option><option value="tencent">腾讯云</option></select></label>
          <label class="field"><span>短信凭据</span><input value="服务端环境变量" readonly /></label>
          <label class="field"><span>SMTP Host</span><input name="smtpHost" /></label>
          <label class="field"><span>SMTP User</span><input name="smtpUser" /></label>
          <label class="field"><span>SMTP 凭据</span><input value="服务端环境变量" readonly /></label>
          <label class="field"><span>Push 服务商</span><select name="pushProvider"><option value="firebase">Firebase</option><option value="jpush">极光 Push</option></select></label>
          <label class="field"><span>Push 凭据</span><input value="服务端环境变量" readonly /></label>
        </form>
      </section>
      <section class="panel wide flush">
        <div class="panel-head"><div><h2>消息记录</h2><p class="panel-subtitle">站内消息与后端投递状态</p></div></div>
        ${renderEndpointState(data.deliveries, '投递记录读取端点不可用，以下为公开消息')}
        <div class="table-wrap">${renderMessageTable(deliveries.length ? deliveries : messages)}</div>
      </section>
    </div>`;
}

function renderMessageTable(rows) {
  if (!rows.length) return renderEmptyState('暂无消息记录');
  return `<table><thead><tr><th>消息</th><th>类型</th><th>受众</th><th>通道</th><th>状态</th><th>发送 / 创建时间</th><th>送达率</th></tr></thead><tbody>${rows.map((row) => `<tr><td><div class="cell-title"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.preview || row.text || '')}</small></div></td><td>${escapeHtml(row.type || '--')}</td><td>${escapeHtml(row.audience || '--')}</td><td>${escapeHtml(Array.isArray(row.channels) ? row.channels.join(' / ') : row.channel || 'in-app')}</td><td>${statusBadge(row.status || 'Published')}</td><td>${escapeHtml(formatDateTime(row.sentAt || row.createdAt || row.dateLabel))}</td><td>${row.deliveryRatePct == null ? '--' : `${escapeHtml(formatAmount(row.deliveryRatePct))}%`}</td></tr>`).join('')}</tbody></table>`;
}

function renderSystem(data) {
  const publicConfig = dataOf(data.publicConfig, {});
  const adminConfig = dataOf(data.adminConfig, []);
  const health = dataOf(data.health, {});
  const readiness = dataOf(data.readiness, {});
  const config = mergeConfigValues(adminConfig);
  return `${renderSourceStrip(['/api/config', '/api/admin/configs', '/health', '/api/dapp/readiness'])}
    ${renderEndpointState(data.adminConfig, '系统配置读取端点不可用')}
    <div class="content-grid">
      <section class="panel wide">
        <div class="panel-head"><div><h2>当前公开链配置</h2><p class="panel-subtitle">敏感字段已排除，不回显密钥</p></div>${statusBadge(health.ok ? 'Healthy' : 'Unknown')}</div>
        <div class="json-summary">${renderSafeConfigEntries({ ...publicConfig, ...health }, 16)}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Chain 与 RPC</h2><p class="panel-subtitle">主备节点、Chain ID 与官方多签</p></div></div>
        <form class="form-grid" data-action-form="system-config" data-config-section="chain">
          <label class="field"><span>Chain ID</span><input name="chainId" type="number" value="${escapeHtml(config.chainId ?? publicConfig.chainId ?? 56)}" required /></label>
          <label class="field"><span>官方多签钱包</span><input name="multisigAddress" value="${escapeHtml(config.multisigAddress ?? '')}" /></label>
          <label class="field wide"><span>主 RPC URL</span><input name="primaryRpcUrl" type="url" value="${escapeHtml(config.primaryRpcUrl ?? '')}" /></label>
          <label class="field wide"><span>备用 RPC URL</span><input name="backupRpcUrl" type="url" value="${escapeHtml(config.backupRpcUrl ?? '')}" /></label>
          <div class="filter-actions"><button class="button primary" type="submit">保存 Chain 配置</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Oracle 与 Gas</h2><p class="panel-subtitle">喂价地址、偏离阈值和秒杀 Gas 上限</p></div></div>
        <form class="form-grid" data-action-form="system-config" data-config-section="oracle-gas">
          <label class="field wide"><span>Chainlink 喂价合约</span><input name="oracleAddress" value="${escapeHtml(config.oracleAddress ?? '')}" /></label>
          <label class="field"><span>偏离阈值（bps）</span><input name="oracleDeviationBps" type="number" min="0" max="10000" value="${escapeHtml(config.oracleDeviationBps ?? '')}" /></label>
          <label class="field"><span>最高 Gas（Gwei）</span><input name="maxGasGwei" inputmode="decimal" value="${escapeHtml(config.maxGasGwei ?? '')}" /></label>
          <div class="filter-actions"><button class="button primary" type="submit">保存 Oracle / Gas</button></div>
        </form>
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>智能合约地址映射</h2><p class="panel-subtitle">所有地址变更进入高危签名与审计流</p></div></div>
        <form class="form-grid" data-action-form="system-config" data-config-section="contracts">
          ${['NPL','BNM','Escrow','Seckill','RewardLedger'].map((name) => `<label class="field"><span>${name} 合约</span><input name="${name[0].toLowerCase()}${name.slice(1)}Address" value="${escapeHtml(firstValue(config, [`contracts.${name.toLowerCase()}`, `${name[0].toLowerCase()}${name.slice(1)}Address`], firstValue(publicConfig, [`contracts.${name.toLowerCase()}`], '')))}" /></label>`).join('')}
          <div class="filter-actions"><button class="button primary" type="submit">保存合约映射</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>基础设施</h2><p class="panel-subtitle">OSS、CDN 与服务开关</p></div></div>
        <form class="form-grid" data-action-form="system-config" data-config-section="infrastructure" autocomplete="off">
          <label class="field"><span>OSS Endpoint</span><input name="ossEndpoint" /></label><label class="field"><span>OSS Bucket</span><input name="ossBucket" /></label>
          <label class="field"><span>OSS AccessKey</span><input type="password" name="ossAccessKey" autocomplete="new-password" /></label>
          <label class="switch-line"><span>启用 CDN</span><input class="switch" type="checkbox" name="cdnEnabled" /></label>
          <div class="filter-actions"><button class="button primary" type="submit">保存基础设施</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>AI 客服 Agent</h2><p class="panel-subtitle">生产 Prompt 与启用状态</p></div></div>
        <form class="form-grid" data-action-form="system-config" data-config-section="ai-agent">
          <label class="field wide"><span>System Prompt</span><textarea name="agentPrompt"></textarea></label>
          <label class="switch-line"><span>启用 AI 客服</span><input class="switch" type="checkbox" name="agentEnabled" /></label>
          <div class="filter-actions"><button class="button primary" type="submit">保存 Agent 配置</button></div>
        </form>
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>DApp 就绪度</h2><p class="panel-subtitle">后端 readiness 原始输出</p></div></div>
        <pre class="code-block">${escapeHtml(JSON.stringify(readiness, null, 2))}</pre>
      </section>
    </div>`;
}

function mergeConfigValues(rows) {
  const merged = {};
  for (const entry of arrayOf(rows)) {
    if (entry?.value && typeof entry.value === 'object' && !Array.isArray(entry.value)) Object.assign(merged, entry.value);
    merged[String(entry?.key || '')] = entry?.value;
  }
  return merged;
}

function renderSafeConfigEntries(value, limit = 12, emptyLabel = '--') {
  const blocked = /secret|password|private|token|access.?key|api.?key/i;
  return Object.entries(value || {}).filter(([key, item]) => !blocked.test(key) && (typeof item !== 'object' || item === null)).slice(0, limit).map(([key, item]) => `<div><span>${escapeHtml(key)}</span><b>${escapeHtml(typeof item === 'boolean' ? (item ? 'true' : 'false') : item ?? emptyLabel)}</b></div>`).join('') || `<div><span>状态</span><b>${escapeHtml(emptyLabel)}</b></div>`;
}

function renderAudit(data) {
  const direct = arrayOf(dataOf(data.logs, []));
  const searched = arrayOf(dataOf(data.search, {})?.results?.auditLogs);
  const logs = hasActiveFilters() ? searched : direct;
  const rpcLogs = arrayOf(dataOf(data.rpcLogs, []));
  const signatures = logs.filter((entry) => entry.signatureHash || entry.payload?.secondarySignatureHash || entry.payload?.signatureKind).length;
  const highRisk = logs.filter((entry) => /circuit|refund|ratio|blacklist|prize|contract|multisig/i.test(String(entry.action))).length;
  return `${renderSourceStrip(['/api/admin/audit-logs', '/api/admin/rpc-audit-logs', '/api/admin/search'])}${renderGlobalFilters('audit')}
    <section class="metric-grid">
      ${metricCard('审计记录', logs.length)}${metricCard('钱包签名摘要', signatures)}${metricCard('高危动作', highRisk)}${metricCard('只读流', data.streams.ok ? arrayOf(data.streams.data).length : null)}
    </section>
    ${renderEndpointState(data.streams, '独立日志流端点不可用')}
    <section class="panel wide flush">
      <div class="panel-head"><div><h2>全网审计轨迹</h2><p class="panel-subtitle">操作、登录、RPC、异常、资金与多签记录</p></div></div>
      <div class="table-wrap">${renderAuditTable(logs, true)}</div>
    </section>
    <section class="panel wide flush">
      <div class="panel-head"><div><h2>JSON-RPC 独立追加日志</h2><p class="panel-subtitle">请求方法、状态、耗时与脱敏响应</p></div></div>
      <div class="table-wrap">${renderRpcAuditTable(rpcLogs)}</div>
    </section>
    ${renderBatchBar('auditLogs', logs.length)}`;
}

function renderAuditTable(logs, selectable = true) {
  if (!logs.length) return renderEmptyState('暂无审计日志');
  const selected = selectedSet('auditLogs');
  return `<table><thead><tr>${selectable ? '<th><input class="checkbox" type="checkbox" data-select-all="auditLogs" aria-label="全选日志" /></th>' : ''}<th>时间 / ID</th><th>角色</th><th>操作钱包</th><th>动作</th><th>目标</th><th>签名</th><th></th></tr></thead><tbody>${logs.map((entry) => {
    const id = String(entry.id || '');
    const signed = entry.signatureHash || entry.payload?.secondarySignatureHash || entry.payload?.signatureKind || entry.payload?.txHash;
    return `<tr>${selectable ? `<td><input class="checkbox" type="checkbox" data-select-resource="auditLogs" data-select-id="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''} /></td>` : ''}<td><div class="cell-title"><strong>${escapeHtml(formatDateTime(entry.createdAt))}</strong><small>#${escapeHtml(id)}</small></div></td><td>${statusBadge(entry.role)}</td><td class="address" title="${escapeHtml(entry.actorAddress)}">${escapeHtml(shortAddress(entry.actorAddress))}</td><td class="mono">${escapeHtml(entry.action)}</td><td class="mono">${escapeHtml(shortAddress(entry.target) || '--')}</td><td>${signed ? statusBadge('Signed') : statusBadge('Recorded')}</td><td><button class="button icon small" type="button" data-view-audit="${escapeHtml(id)}" title="查看审计 payload" aria-label="查看审计 payload">${icon('eye')}</button></td></tr>`;
  }).join('')}</tbody></table>`;
}

function renderRpcAuditTable(logs) {
  if (!logs.length) return renderEmptyState('暂无 RPC 审计日志');
  return `<table><thead><tr><th>时间 / ID</th><th>方法</th><th>状态</th><th>耗时</th><th>错误</th></tr></thead><tbody>${logs.map((entry) => `<tr><td><div class="cell-title"><strong>${escapeHtml(formatDateTime(entry.createdAt))}</strong><small>#${escapeHtml(entry.id)}</small></div></td><td class="mono">${escapeHtml(entry.method)}</td><td>${statusBadge(entry.status)}</td><td class="numeric">${escapeHtml(entry.durationMs)} ms</td><td class="mono">${escapeHtml(entry.errorCode || '--')}</td></tr>`).join('')}</tbody></table>`;
}

function renderOperations(data) {
  const health = dataOf(data.health, {});
  const readiness = dataOf(data.readiness, {});
  const operations = dataOf(data.operations, {});
  const audit = arrayOf(dataOf(data.audit, []));
  const components = operations.components && typeof operations.components === 'object' ? operations.components : {};
  const traffic = operations.traffic && typeof operations.traffic === 'object' ? operations.traffic : {};
  const blockchain = operations.blockchain && typeof operations.blockchain === 'object' ? operations.blockchain : {};
  const rpcHeight = firstValue(blockchain, ['heights.rpc', 'heights.rpcHeight', 'rpc.height', 'rpc.blockHeight', 'rpcHeight', 'nodeHeight'], null);
  const explorerHeight = firstValue(blockchain, ['heights.explorer', 'heights.explorerHeight', 'explorer.height', 'explorer.blockHeight', 'explorerHeight'], null);
  const rpcStatus = blockchainEndpointStatus(blockchain, 'rpc', rpcHeight);
  const explorerStatus = blockchainEndpointStatus(blockchain, 'explorer', explorerHeight);
  const rpc = blockchain.rpc ?? { status: rpcStatus, configured: blockchain.rpcConfigured };
  const explorer = blockchain.explorer ?? { status: explorerStatus };
  const validHeights = rpcHeight !== null && explorerHeight !== null && Number.isFinite(Number(rpcHeight)) && Number.isFinite(Number(explorerHeight));
  const reportedBlockLag = firstValue(blockchain, ['heights.lag', 'heightLag'], null);
  const blockLag = reportedBlockLag !== null && Number.isFinite(Number(reportedBlockLag)) ? Number(reportedBlockLag) : validHeights ? Number(explorerHeight) - Number(rpcHeight) : null;
  const reportedBlockchainStatus = firstValue(blockchain, ['status'], null);
  const blockchainStatus = reportedBlockchainStatus ? operationStatus(reportedBlockchainStatus) : (validHeights ? (Math.abs(blockLag) > 3 ? 'Warning' : 'Synced') : 'notConfigured');
  const errorRate = firstValue(traffic, ['errorRatePct'], null);
  captureBreakers(dataOf(data.breakers, {}));
  const readinessSummary = { ...health, ...readiness };
  return `${renderSourceStrip(['/health', '/api/dapp/readiness', '/api/admin/ops'])}
    ${renderEndpointState(data.operations, '运维监控端点不可用')}
    <section class="metric-grid">
      ${metricCard('QPS', firstValue(traffic, ['qps'], null), { emptyLabel: 'notConfigured' })}
      ${metricCard('TPS', firstValue(traffic, ['tps'], null), { emptyLabel: 'notConfigured' })}
      ${metricCard('错误率', errorRate, { suffix: '%', emptyLabel: 'notConfigured', signal: errorRate === null ? undefined : Number(errorRate) > 1 ? 'danger' : 'safe' })}
      ${metricCard('进程在线时长', firstValue(operations, ['process.uptimeSeconds'], null), { suffix: 's', emptyLabel: 'notConfigured' })}
    </section>
    <div class="content-grid">
      <section class="panel">
        <div class="panel-head"><div><h2>进程与主机</h2><p class="panel-subtitle">运行时内存、负载与平台信息</p></div>${statusBadge(operationStatus(health))}</div>
        <div class="monitor-grid" style="grid-template-columns:1fr">
          ${operationalValueRow('RSS 内存', firstValue(operations, ['process.rssMb'], null), 'MB')}
          ${operationalValueRow('Heap 内存', firstValue(operations, ['process.heapUsedMb'], null), 'MB')}
          ${operationalValueRow('CPU 1 分钟负载', firstValue(operations, ['process.cpuLoad.0'], null))}
          ${operationalValueRow('主机总内存', firstValue(operations, ['host.totalMemoryMb'], null), 'MB')}
          ${operationalValueRow('平台 / 架构', operationPlatform(operations))}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>中间件真实状态</h2><p class="panel-subtitle">数据库、Redis 与消息队列</p></div></div>
        <div class="compact-list">${renderOpsComponent('数据库', components.db)}${renderOpsComponent('Redis', components.redis)}${renderOpsComponent('MQ', components.mq)}</div>
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>区块链同步</h2><p class="panel-subtitle">RPC 与 Explorer 状态、高度及差值</p></div>${statusBadge(blockchainStatus)}</div>
        <div class="ops-chain-grid">
          <div><span>RPC 状态</span>${statusBadge(operationStatus(rpc))}</div>
          <div><span>RPC 高度</span><strong>${escapeHtml(operationalValue(rpcHeight))}</strong></div>
          <div><span>Explorer 状态</span>${statusBadge(operationStatus(explorer))}</div>
          <div><span>Explorer 高度</span><strong>${escapeHtml(operationalValue(explorerHeight))}</strong></div>
          <div><span>高度差</span><strong class="${blockLag !== null && Math.abs(blockLag) > 3 ? 'danger-text' : ''}">${escapeHtml(operationalValue(blockLag))}</strong></div>
          <div><span>链整体状态</span>${statusBadge(blockchainStatus)}</div>
        </div>
      </section>
      <section class="panel danger-zone">
        <div class="panel-head"><div><h2>熔断器</h2><p class="panel-subtitle">故障隔离与恢复动作</p></div></div>
        ${renderEndpointState(data.breakers, '熔断状态读取端点不可用')}
        <div class="danger-actions">${circuitAction('orders', '订单', '订单创建与托管')}${circuitAction('seckill', '秒杀', '场次抢购与接力')}${circuitAction('claims', 'Claim', '资产领取')}</div>
      </section>
      <section class="panel wide">
        <div class="panel-head"><div><h2>服务就绪矩阵</h2><p class="panel-subtitle">健康检查与 DApp readiness</p></div></div>
        <div class="json-summary">${renderSafeConfigEntries(Object.keys(readinessSummary).length ? readinessSummary : { status: 'notConfigured' }, 24, 'notConfigured')}</div>
      </section>
      <section class="panel wide flush"><div class="panel-head"><div><h2>最近系统事件</h2><p class="panel-subtitle">RPC、索引器、熔断与异常审计</p></div></div><div class="table-wrap">${renderAuditTable(audit.filter((entry) => /rpc|chain|circuit|system|indexer|error/i.test(String(entry.action))).slice(0, 20), false)}</div></section>
    </div>`;
}

function operationStatus(value) {
  if (value === null || value === undefined || value === '') return 'notConfigured';
  if (typeof value === 'boolean') return value ? 'Ready' : 'notConfigured';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const explicit = value.status || value.state || value.health;
  if (explicit) return String(explicit);
  if (value.configured === false) return 'notConfigured';
  if (value.enabled === false) return 'Disabled';
  return String(value.ok === true ? 'Healthy' : value.ok === false ? 'Error' : value.connected === true ? 'Connected' : value.configured === true ? 'Configured' : 'notConfigured');
}

function operationalValue(value, suffix = '') {
  if (value === null || value === undefined || value === '') return 'notConfigured';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const numeric = Number(value);
  const display = Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(String(value)) ? numeric.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : String(value);
  return suffix ? `${display} ${suffix}` : display;
}

function operationalValueRow(label, value, suffix = '') {
  return `<div class="monitor-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(operationalValue(value, suffix))}</b></div>`;
}

function operationPlatform(operations) {
  const platform = firstValue(operations, ['host.platform'], null);
  const architecture = firstValue(operations, ['host.architecture'], null);
  return [platform, architecture].filter(Boolean).join(' / ') || null;
}

function blockchainEndpointStatus(blockchain, endpoint, height) {
  const explicit = firstValue(blockchain, [`${endpoint}.status`, `${endpoint}Status`], null);
  if (explicit) return operationStatus(explicit);
  if (endpoint === 'rpc' && blockchain.rpcConfigured === false) return 'notConfigured';
  if (height !== null && height !== undefined && height !== '') return 'healthy';
  if (endpoint === 'rpc' && blockchain.rpcConfigured === true) return 'unavailable';
  return 'notConfigured';
}

function renderOpsComponent(label, component) {
  const stateLabel = operationStatus(component);
  const details = component && typeof component === 'object'
    ? Object.entries(component).filter(([key, value]) => !/status|state|health|configured|enabled|ok|connected/i.test(key) && (typeof value !== 'object' || value === null)).slice(0, 3).map(([key, value]) => `${key}: ${operationalValue(value)}`).join(' · ')
    : '';
  return `<div class="compact-row ops-component"><span><b>${escapeHtml(label)}</b><small>${escapeHtml(details || (stateLabel === 'notConfigured' ? '未配置' : '实时状态'))}</small></span><strong>${statusBadge(stateLabel)}</strong></div>`;
}

async function handleClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const routeButton = target.closest('[data-route]');
  if (routeButton) {
    event.preventDefault();
    await navigate(routeButton.dataset.route);
    return;
  }
  if (target.closest('[data-logout]')) {
    state.context?.logout();
    return;
  }
  if (target.closest('[data-refresh]')) {
    await navigate(state.route, { updateHash: false });
    return;
  }
  const logicButton = target.closest('[data-filter-logic]');
  if (logicButton) {
    state.filters.logic = logicButton.dataset.filterLogic;
    const form = logicButton.closest('form');
    form?.querySelectorAll('[data-filter-logic]').forEach((button) => button.classList.toggle('active', button === logicButton));
    const hidden = form?.querySelector('input[name="logic"]');
    if (hidden) hidden.value = state.filters.logic;
    return;
  }
  const rangeButton = target.closest('[data-date-range]');
  if (rangeButton) {
    applyDateRange(rangeButton.closest('form'), rangeButton.dataset.dateRange);
    return;
  }
  if (target.closest('[data-clear-filters]')) {
    state.filters = { logic: 'AND', keyword: '', orderId: '', productId: '', txHash: '', wallet: '', uid: '', phone: '', status: '', from: '', to: '' };
    state.selected.clear();
    await navigate(state.route, { updateHash: false });
    return;
  }
  const tab = target.closest('[data-tab-group]');
  if (tab) {
    const key = { search: 'searchTab', merchant: 'merchantTab', catalog: 'catalogTab' }[tab.dataset.tabGroup];
    if (key) state[key] = tab.dataset.tabValue;
    await navigate(state.route, { updateHash: false });
    return;
  }
  const afterSaleButton = target.closest('[data-after-sale-resolve]');
  if (afterSaleButton) {
    openAfterSaleResolveDialog(afterSaleButton.dataset.afterSaleResolve);
    return;
  }
  if (target.closest('[data-add-beneficiary]')) {
    syncBeneficiariesFromDom();
    state.beneficiaries.push({ walletAddress: '', weightBps: '', role: 'beneficiary' });
    refreshBeneficiaryDom();
    return;
  }
  const removeBeneficiary = target.closest('[data-remove-beneficiary]');
  if (removeBeneficiary) {
    syncBeneficiariesFromDom();
    state.beneficiaries.splice(Number(removeBeneficiary.dataset.removeBeneficiary), 1);
    refreshBeneficiaryDom();
    return;
  }
  const externalSubmit = target.closest('[data-submit-external-form]');
  if (externalSubmit) {
    document.querySelector(`#${CSS.escape(externalSubmit.dataset.submitExternalForm)}`)?.requestSubmit();
    return;
  }
  const merchantReview = target.closest('[data-merchant-review]');
  if (merchantReview) {
    await reviewMerchant(merchantReview);
    return;
  }
  const productReview = target.closest('[data-product-review]');
  if (productReview) {
    await reviewProduct(productReview);
    return;
  }
  const categoryDelete = target.closest('[data-category-delete]');
  if (categoryDelete) {
    const confirmed = await confirmAction('删除类目', categoryDelete.dataset.categoryDelete, '确认逻辑删除', true);
    if (confirmed) await executeSigned({ action: 'admin.category.delete', path: '/api/admin/categories/delete', payload: { id: categoryDelete.dataset.categoryDelete }, button: categoryDelete, label: '类目逻辑删除' });
    return;
  }
  const tagDelete = target.closest('[data-tag-delete]');
  if (tagDelete) {
    const confirmed = await confirmAction('删除标签', tagDelete.dataset.tagDelete, '确认逻辑删除', true);
    if (confirmed) await executeSigned({ action: 'admin.tag.delete', path: '/api/admin/tags/delete', payload: { id: tagDelete.dataset.tagDelete }, button: tagDelete, label: '标签逻辑删除' });
    return;
  }
  const circuitButton = target.closest('[data-circuit]');
  if (circuitButton) {
    await changeCircuit(circuitButton);
    return;
  }
  const cutoffButton = target.closest('[data-force-cutoff]');
  if (cutoffButton) {
    const confirmed = await confirmAction('强截止当前秒杀场次', '场次将立即进入熔断状态，恢复需要再次二次签名。', '确认强截止', true);
    if (confirmed) await executeSigned({ action: 'admin.circuit.force-cutoff', path: '/api/admin/seckill/force-cutoff', payload: { enabled: true, sessionId: cutoffButton.dataset.sessionId, reason: 'manual force cutoff' }, button: cutoffButton, label: '秒杀场次强截止', chainRequired: true });
    return;
  }
  const publishSeckill = target.closest('[data-publish-seckill]');
  if (publishSeckill) {
    const confirmed = await confirmAction('发布秒杀场次', '合约收到交易后会立即开始；只有链上 SessionStarted 被索引后，C 端才显示为进行中。', '签名并发布', true);
    if (confirmed) await executeSigned({
      action: 'admin.seckill.publish',
      path: '/api/admin/seckill/publish',
      payload: { sessionId: publishSeckill.dataset.publishSeckill },
      button: publishSeckill,
      label: '秒杀排期链上发布',
      chainRequired: true
    });
    return;
  }
  const refundOrder = target.closest('[data-refund-order]');
  if (refundOrder) {
    const input = document.querySelector('form[data-action-form="force-refund"] input[name="orderId"]');
    if (input) {
      input.value = refundOrder.dataset.refundOrder;
      input.scrollIntoView({ block: 'center' });
      input.focus({ preventScroll: true });
    }
    return;
  }
  const batchButton = target.closest('[data-batch-op]');
  if (batchButton) {
    const bar = batchButton.closest('[data-batch-resource]');
    await runBatchOperation(batchButton, batchButton.dataset.batchOp, bar?.dataset.batchResource || 'mixed');
    return;
  }
  const openFormButton = target.closest('[data-open-form]');
  if (openFormButton) {
    openFormDialog(openFormButton.dataset.openForm);
    return;
  }
  const viewButton = target.closest('[data-view-record],[data-view-merchant],[data-view-product],[data-view-audit]');
  if (viewButton) {
    const id = viewButton.dataset.viewRecord?.slice(viewButton.dataset.viewRecord.indexOf(':') + 1)
      || viewButton.dataset.viewMerchant || viewButton.dataset.viewProduct || viewButton.dataset.viewAudit;
    openRecordDialog(id);
  }
}

function handleChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  const afterSaleForm = target.closest('form[data-action-form="after-sale-resolve"]');
  if (afterSaleForm && target.name === 'resolution') {
    updateAfterSaleResolutionFields(afterSaleForm);
    return;
  }
  const cmsForm = target.closest('form[data-action-form="cms"]');
  if (cmsForm && (target.name === 'placement' || target.name === 'status')) {
    updateCmsFields(cmsForm);
    return;
  }
  if (target.matches('[data-select-resource]')) {
    const resource = target.dataset.selectResource;
    const id = String(target.dataset.selectId || '');
    const selected = selectedSet(resource);
    if (target.checked) selected.add(id); else selected.delete(id);
    updateBatchBar(resource);
    return;
  }
  if (target.matches('[data-select-all]')) {
    const resource = target.dataset.selectAll;
    const selected = selectedSet(resource);
    document.querySelectorAll(`[data-select-resource="${CSS.escape(resource)}"]`).forEach((checkbox) => {
      checkbox.checked = target.checked;
      const id = String(checkbox.dataset.selectId || '');
      if (target.checked) selected.add(id); else selected.delete(id);
    });
    updateBatchBar(resource);
  }
}

function handleInput(event) {
  const form = event.target instanceof Element ? event.target.closest('form[data-action-form="ratio"]') : null;
  if (!form) return;
  syncBeneficiariesFromDom();
  updateRatioTotals(form);
}

function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.matches('[data-filter-form]')) {
    const values = formValues(form);
    state.filters = {
      logic: String(values.logic || 'AND'), keyword: String(values.keyword || ''), orderId: String(values.orderId || ''),
      productId: String(values.productId || ''), txHash: String(values.txHash || ''), wallet: String(values.wallet || ''),
      uid: String(values.uid || ''), phone: String(values.phone || ''), status: String(values.status || ''),
      from: String(values.from || ''), to: String(values.to || '')
    };
    state.selected.clear();
    navigate(state.route, { updateHash: false });
    return;
  }
  const type = form.dataset.actionForm;
  if (type) submitActionForm(type, form).catch((error) => {
    if (!error?.uiHandled) showToast(errorText(error), 'error');
  });
}

function applyDateRange(form, range) {
  if (!form) return;
  const now = new Date();
  let from = new Date(now);
  let to = new Date(now);
  if (range === 'today') from.setHours(0, 0, 0, 0);
  else if (range === 'yesterday') {
    from.setDate(from.getDate() - 1);
    from.setHours(0, 0, 0, 0);
    to = new Date(from);
    to.setHours(23, 59, 59, 999);
  } else {
    from.setDate(from.getDate() - Math.max(0, Number(range) - 1));
    from.setHours(0, 0, 0, 0);
  }
  const fromInput = form.querySelector('[name="from"]');
  const toInput = form.querySelector('[name="to"]');
  if (fromInput) fromInput.value = formatDateInput(from);
  if (toInput) toInput.value = formatDateInput(to);
}

function updateBatchBar(resource) {
  document.querySelectorAll(`[data-batch-resource="${CSS.escape(resource)}"]`).forEach((bar) => {
    const count = selectedSet(resource).size;
    const available = Number(bar.dataset.availableCount || 0);
    const countNode = bar.querySelector('.batch-count');
    if (countNode) countNode.textContent = `已选 ${count} / ${available}`;
    bar.querySelectorAll('[data-batch-op]').forEach((button) => {
      button.disabled = button.dataset.batchOp.startsWith('export.') ? available === 0 : count === 0;
    });
  });
}

function syncBeneficiariesFromDom() {
  const rows = [...document.querySelectorAll('[data-beneficiary-index]')];
  if (!rows.length) return;
  state.beneficiaries = rows.map((row) => ({
    walletAddress: row.querySelector('[name="beneficiaryAddress"]')?.value.trim() || '',
    role: row.querySelector('[name="beneficiaryRole"]')?.value || 'beneficiary',
    weightBps: row.querySelector('[name="beneficiaryWeightBps"]')?.value || ''
  }));
}

function refreshBeneficiaryDom() {
  const list = document.querySelector('[data-beneficiary-list]');
  if (!list) return;
  list.innerHTML = renderBeneficiaryRows();
  const next = list.nextElementSibling;
  if (next?.classList.contains('empty-state')) next.remove();
  if (!state.beneficiaries.length) list.insertAdjacentHTML('afterend', renderEmptyState('尚未添加受益人', '添加地址后配置权重与角色。'));
  const total = document.querySelector('[data-beneficiary-total]');
  if (total) total.textContent = formatBeneficiaryTotal();
}

function updateRatioTotals(form) {
  const burn = form.elements.burnBps?.value;
  const pool = form.elements.poolReturnBps?.value;
  const routeTotal = burn === '' || pool === '' ? null : Number(burn) + Number(pool);
  const routeNode = form.querySelector('[data-npl-route-total]');
  if (routeNode) {
    routeNode.textContent = routeTotal === null ? '--' : `${(routeTotal / 100).toFixed(2)}%`;
    routeNode.classList.toggle('invalid', routeTotal !== null && routeTotal > 10000);
  }
  const commissionInputs = [...form.querySelectorAll('[data-commission-bps]')];
  const values = commissionInputs.map((input) => input.value);
  const commissionTotal = values.some((value) => value === '') ? null : values.reduce((sum, value) => sum + Number(value), 0);
  const commissionNode = form.querySelector('[data-commission-total]');
  if (commissionNode) {
    commissionNode.textContent = commissionTotal === null ? '--' : `${(commissionTotal / 100).toFixed(2)}%`;
    commissionNode.classList.toggle('invalid', commissionTotal !== null && commissionTotal > 10000);
  }
  const beneficiaryNode = form.querySelector('[data-beneficiary-total]');
  if (beneficiaryNode) beneficiaryNode.textContent = formatBeneficiaryTotal();
}

async function reviewMerchant(button) {
  const decision = button.dataset.merchantReview;
  const confirmed = await confirmAction(`${decision === 'approved' ? '通过' : '拒绝'}商家审核`, `${button.dataset.name || button.dataset.id}\n${button.dataset.wallet || ''}`, '确认并签名', decision !== 'approved');
  if (!confirmed) return;
  await executeSigned({
    action: 'admin.merchant.review', path: '/api/admin/merchants/review', button,
    payload: { merchantId: button.dataset.id, walletAddress: button.dataset.wallet, name: button.dataset.name, decision },
    label: `商家审核 · ${decision}`,
    chainRequired: true
  });
}

async function reviewProduct(button) {
  const decision = button.dataset.productReview;
  const confirmed = await confirmAction(`${decision === 'approved' ? '通过' : '拒绝'}商品提报`, button.dataset.id, '确认并签名', decision !== 'approved');
  if (!confirmed) return;
  await executeSigned({ action: 'admin.product.review', path: '/api/admin/products/review', button, payload: { productId: button.dataset.id, decision }, label: `商品审核 · ${decision}` });
}

async function changeCircuit(button) {
  const scope = button.dataset.circuit;
  const enabled = button.dataset.enabled === 'true';
  const confirmed = await confirmAction(`${enabled ? '暂停' : '恢复'} ${scope}`, enabled ? '对应业务入口将立即停止接受新操作。' : '业务入口将恢复接受新操作。', enabled ? '确认暂停' : '确认恢复', enabled);
  if (!confirmed) return;
  const paths = { orders: '/api/admin/pause-orders', seckill: '/api/admin/pause-seckill', claims: '/api/admin/pause-claims' };
  await executeSigned({ action: `admin.circuit.${scope}`, path: paths[scope], button, payload: { enabled, reason: `manual ${enabled ? 'pause' : 'resume'} from admin console` }, label: `${scope} · ${enabled ? 'Paused' : 'Resumed'}`, chainRequired: true });
}

async function submitActionForm(type, form) {
  const values = formValues(form);
  const button = form.querySelector('[type="submit"]');
  let options;
  if (type === 'merchant-levels') options = actionOptions('admin.merchant.levels.configure', '/api/admin/merchant-levels', numericPayload(values), button, '商家等级矩阵');
  else if (type === 'category') options = actionOptions('admin.category.upsert', '/api/admin/categories/upsert', compactPayload({ ...numericPayload(values), icon: values.iconUrl, sortOrder: numberOrUndefined(values.sortWeight), iconUrl: undefined, sortWeight: undefined }), button, '三级类目配置');
  else if (type === 'tag') options = {
    ...actionOptions('admin.tag.upsert', '/api/admin/tags/upsert', numericPayload(values), button, '商品标签配置'),
    validateResult: (result) => values.dispatchWeight && result?.tag?.dispatchWeight === undefined ? '标签已保存，但推流权重未被后端回显。' : ''
  };
  else if (type === 'product-create') options = actionOptions('admin.product.create', '/api/admin/products', productFormPayload(values), button, '平台代上架商品');
  else if (type === 'ratio') {
    syncBeneficiariesFromDom();
    const burnBps = Number(values.burnBps);
    const poolReturnBps = Number(values.poolReturnBps);
    const commissionTotal = ['platformFeeBps','prizePoolBps','regionBps','referralBps'].reduce((sum, key) => sum + Number(values[key] || 0), 0);
    const merchantCostBps = values.merchantCostBps === '' ? null : Number(values.merchantCostBps);
    const allocated = burnBps + poolReturnBps + commissionTotal;
    if (allocated > 10000) throw showValidationError('销毁、回流与四层佣金合计不能超过 10,000 bps。');
    if (merchantCostBps !== null && allocated + merchantCostBps !== 10000) throw showValidationError('全部 NPL 分配项与商家成本合计必须为 10,000 bps。');
    const beneficiaryTotal = state.beneficiaries.reduce((sum, entry) => sum + Number(entry.weightBps || 0), 0);
    if (state.beneficiaries.length && beneficiaryTotal !== 10000) throw showValidationError('受益人权重合计必须为 10,000 bps。');
    const payload = numericPayload({ ...values, nplBurnBps: burnBps, nplCirculationBps: poolReturnBps, poolReturnBps: undefined, beneficiaries: state.beneficiaries.map((entry) => ({ walletAddress: entry.walletAddress, role: entry.role, weightBps: Number(entry.weightBps) })) });
    options = {
      ...actionOptions('admin.ratio.configure', '/api/admin/ratio-config', payload, button, 'NPL 比例与受益人配置'),
      chainRequired: true,
      validateResult: (result) => {
        const persisted = result?.config || {};
        const expected = ['nplBurnBps', 'nplCirculationBps', ...(values.settlementCostNpl ? ['settlementCostNpl'] : [])];
        const missing = expected.filter((key) => persisted[key] === undefined);
        return missing.length ? `服务端未回显 ${missing.join(', ')}，这些字段尚未确认持久化。` : '';
      }
    };
  } else if (type === 'seckill-schedule') {
    const payload = numericPayload(values);
    payload.startsAt = new Date(values.startsAt).toISOString();
    payload.endsAt = new Date(values.endsAt).toISOString();
    if (Date.parse(payload.endsAt) <= Date.parse(payload.startsAt)) throw showValidationError('场次结束时间必须晚于开始时间。');
    payload.durationSeconds = values.mainDurationMinutes ? Number(values.mainDurationMinutes) * 60 : Math.floor((Date.parse(payload.endsAt) - Date.parse(payload.startsAt)) / 1000);
    payload.relayExtendSeconds = numberOrUndefined(values.rechargeSeconds);
    payload.publishOnchain = values.status === 'live';
    delete payload.mainDurationMinutes;
    delete payload.rechargeSeconds;
    options = { ...actionOptions('admin.seckill.schedule', '/api/admin/seckill/schedule', payload, button, '秒杀场次排期'), chainRequired: payload.publishOnchain };
  } else if (type === 'prize-pool') options = { ...actionOptions('admin.prize-pool.inject', '/api/admin/prize-pool', compactPayload(values), button, '大奖池链上注入'), chainRequired: true };
  else if (type === 'seckill-rules') options = actionOptions('admin.cms.publish', '/api/admin/cms', { key: 'seckill-rules', text: values.text }, button, '秒杀规则发布');
  else if (type === 'blacklist') {
    options = actionOptions('admin.blacklist.update', '/api/admin/blacklist', compactPayload({ kind: values.type, address: values.type === 'wallet' ? values.value : undefined, value: values.value, reason: values.reason, durationHours: numberOrUndefined(values.durationHours) }), button, '黑名单更新');
  } else if (type === 'risk-policies') options = actionOptions('admin.risk.policies.configure', '/api/admin/risk/policies', numericPayload(values), button, '风控识别策略');
  else if (type === 'logistics-carrier') {
    const hasCredentials = Boolean(values.partnerId || values.monthlyAccount);
    options = hasCredentials
      ? actionOptions('admin.logistics.credentials.configure', '/api/admin/logistics/credentials', compactPayload(values), button, '物流接口凭据')
      : {
          ...actionOptions('admin.logistics.configure', '/api/admin/logistics', compactPayload({ ...values, default: values.isDefault, isDefault: undefined }), button, '承运商配置'),
          validateResult: (result) => result?.config?.provider === undefined ? '承运商基础配置已写入，但接口服务商字段未被后端回显。' : ''
        };
  }
  else if (type === 'logistics-template') options = actionOptions('admin.logistics.template.upsert', '/api/admin/logistics/templates', logisticsTemplatePayload(values), button, '运费模板');
  else if (type === 'logistics-address') options = actionOptions('admin.logistics.address.upsert', '/api/admin/logistics/addresses', compactPayload(values), button, '物流地址');
  else if (type === 'force-refund') {
    const confirmed = await confirmAction('确认平台强制退款', `订单 ${values.orderId}\n该操作需要服务端返回链上 transactionIntent 才能完成资金退款。`, '确认并签名', true);
    if (!confirmed) return;
    options = { ...actionOptions('admin.force-refund', '/api/admin/force-refund', compactPayload(values), button, '平台强制退款请求'), chainRequired: true };
  } else if (type === 'after-sale-resolve') {
    const resolution = String(values.resolution || '').toLowerCase();
    if (resolution === 'delay' && !values.delayUntil) throw showValidationError('延期决议必须填写延期时间。');
    const payload = compactPayload({
      caseId: values.caseId,
      resolution,
      note: String(values.note || '').trim(),
      delayUntil: resolution === 'delay' ? new Date(values.delayUntil).toISOString() : undefined
    });
    options = {
      ...actionOptions('admin.after-sale.resolve', '/api/admin/after-sales/resolve', payload, button, `售后仲裁 · ${resolution}`),
      chainRequired: resolution === 'complete' || resolution === 'refund'
    };
  } else if (type === 'cms') {
    if (values.status === 'scheduled' && !values.publishAt) throw showValidationError('定时发布必须填写发布时间。');
    const payload = compactPayload({
      key: values.key,
      placement: values.placement,
      title: values.title,
      text: values.text,
      status: values.status,
      publishAt: values.status === 'scheduled' ? new Date(values.publishAt).toISOString() : undefined,
      frequency: values.frequency,
      regionCodes: String(values.regionCodes || '').split(/[,\uff0c\n]/).map((item) => item.trim()).filter(Boolean),
      mediaUrl: values.mediaUrl,
      minAppVersion: values.minAppVersion,
      forceUpdate: values.placement === 'update' && values.forceUpdate === true
    });
    options = actionOptions('admin.cms.publish', '/api/admin/cms', payload, button, `CMS 发布 · ${values.placement}`);
  } else if (type === 'notification') {
    const payload = notificationPayload(values);
    options = actionOptions('admin.message.notify', '/api/admin/messages', payload, button, '运营通知发送');
  }
  else if (type === 'notification-gateway') options = actionOptions('admin.message.gateway.configure', '/api/admin/messages/gateways', compactPayload(values), button, '消息通道网关');
  else if (type === 'system-config') {
    const secretFields = [...form.querySelectorAll('input[type="password"]')].filter((input) => input.value.trim());
    if (secretFields.length) throw showValidationError('敏感凭据必须通过服务端环境变量配置，不能写入后台数据库或审计日志。');
    const value = Object.fromEntries(Object.entries(numericPayload(values)).filter(([key]) => !/secret|password|access.?key|private.?key/i.test(key)));
    options = {
      ...actionOptions('admin.system.configure', '/api/admin/system-config', { key: form.dataset.configSection, value }, button, `系统配置 · ${form.dataset.configSection}`),
      validateResult: (result) => form.dataset.configSection === 'contracts' && !result?.transactionIntent ? '合约地址映射已写入配置库，但后端未返回多签或链上 intent。' : ''
    };
  }
  if (!options) return;
  await executeSigned(options);
  if (document.querySelector('#admin-dialog')?.open) document.querySelector('#admin-dialog').close();
}

function actionOptions(action, path, payload, button, label) {
  return { action, path, payload: compactPayload(payload), button, label };
}

function numberOrUndefined(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function numericPayload(value) {
  const numericPattern = /(bps|limit|quota|stock|minutes|seconds|hours|weight|fee|gas|chainId|sortWeight|rate|count)$/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, numericPattern.test(key) ? numberOrUndefined(item) : item]));
}

function compactPayload(value) {
  if (Array.isArray(value)) return value.map(compactPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== '' && item !== undefined).map(([key, item]) => [key, compactPayload(item)]));
}

function productFormPayload(values) {
  return compactPayload({
    title: values.title, subtitle: values.subtitle, imageUrl: values.imageUrl, videoUrl: values.videoUrl,
    details: values.details, sellerAddress: values.sellerAddress, logisticsTemplateId: values.logisticsTemplateId,
    categoryId: values.categoryId, tags: String(values.tags || '').split(/[，,\n]/).map((item) => item.trim()).filter(Boolean),
    skus: [{ name: values.skuName, stock: Number(values.stock), settlementPriceNpl: values.settlementPriceNpl }]
  });
}

function logisticsTemplatePayload(values) {
  return compactPayload({ ...numericPayload(values), blockedRegionCodes: String(values.blockedRegionCodes || '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) });
}

function notificationPayload(values) {
  const channels = [];
  if (values.channelInApp) channels.push('in-app');
  if (values.channelSms) channels.push('sms');
  if (values.channelEmail) channels.push('email');
  if (values.channelPush) channels.push('push');
  return compactPayload({
    ...values,
    preview: values.text,
    channels,
    channel: channels[0] === 'in-app' ? 'app' : (channels[0] || 'app'),
    recipient: values.audienceValue || values.audience,
    regionCode: values.audience === 'region' ? values.audienceValue : undefined,
    scheduledAt: values.scheduledAt ? new Date(values.scheduledAt).toISOString() : undefined
  });
}

function showValidationError(message) {
  showToast(message, 'error');
  const error = new Error(message);
  error.uiHandled = true;
  return error;
}

async function runBatchOperation(button, operation, resource) {
  const selected = [...selectedSet(resource)];
  const targetIds = selected.length ? selected : operation.startsWith('export.') ? visibleBatchTargetIds(resource) : [];
  if (!targetIds.length) {
    showToast('请先选择至少一条记录。', 'warning');
    return;
  }
  let patch;
  if (operation === 'batch.modify') {
    patch = await promptBatchPatch();
    if (!patch) return;
  }
  if (/review\.reject|soft-delete|product\.down/.test(operation)) {
    const confirmed = await confirmAction('确认批量操作', `${operation}\n${targetIds.length} 个对象将被处理。`, '确认并签名', true);
    if (!confirmed) return;
  }
  const { result } = await executeSigned({
    action: 'admin.batch.run', path: '/api/admin/batch', button, refresh: false,
    payload: compactPayload({ operation, resource, targetIds, patch }),
    label: `批处理 · ${operation}`
  });
  const batch = result?.batch || result;
  await handleBatchOutput(operation, batch);
  const failed = arrayOf(batch?.results).filter((entry) => entry.ok === false);
  if (failed.length) {
    const succeeded = arrayOf(batch?.results).filter((entry) => entry.ok === true).length;
    state.lastAction.tone = 'warning';
    state.lastAction.detail = `批处理 ${batch?.status || 'Partial'}：成功 ${succeeded}，失败 ${failed.length}。${failed.slice(0, 3).map((entry) => `${entry.targetId}: ${entry.error || entry.status}`).join('；')}`;
    showToast(state.lastAction.detail, 'warning');
    const selection = selectedSet(resource);
    selection.clear();
    failed.forEach((entry) => selection.add(String(entry.targetId)));
  } else {
    selectedSet(resource).clear();
  }
  await navigate(state.route, { updateHash: false });
}

async function handleBatchOutput(operation, batch) {
  if (operation.startsWith('export.')) {
    const fileName = downloadArtifact(batch?.download);
    state.lastAction.detail = `文件 ${fileName} 已从服务端响应下载。`;
    showToast(state.lastAction.detail);
    return;
  }
  if (operation.startsWith('print.')) {
    const fileName = await printHtmlArtifact(batch?.printDocument);
    state.lastAction.detail = `已加载服务端打印文档 ${fileName || ''}。`;
    showToast('打印对话框已打开。');
  }
}

function visibleBatchTargetIds(resource) {
  return [...document.querySelectorAll(`[data-select-resource="${CSS.escape(resource)}"]`)]
    .map((input) => String(input.dataset.selectId || ''))
    .filter(Boolean);
}

function openAfterSaleResolveDialog(caseId) {
  const payload = dataOf(state.currentData?.afterSales, {});
  const entry = arrayOf(payload.cases).find((item) => String(item.id) === String(caseId));
  if (!entry || !isAfterSaleResolvable(entry)) {
    showToast('案件状态已变更，请刷新后重试。', 'warning');
    return;
  }
  const requestedResolution = String(entry.requestType || '').toLowerCase();
  const initialResolution = ['exchange', 'delay', 'refund'].includes(requestedResolution) ? requestedResolution : 'resume';
  const dialog = document.querySelector('#admin-dialog');
  if (!dialog) return;
  dialog.innerHTML = `<div class="dialog-head"><div><h2 id="dialog-title">售后仲裁</h2><p class="mono">${escapeHtml(entry.id)} · ${escapeHtml(entry.orderId)}</p></div><button class="dialog-close" type="button" aria-label="关闭">${icon('x')}</button></div>
    <form data-action-form="after-sale-resolve">
      <div class="dialog-body form-grid">
        <input type="hidden" name="caseId" value="${escapeHtml(entry.id)}" />
        <div class="endpoint-state wide"><div><strong>${escapeHtml(entry.requestType || '售后请求')} · ${escapeHtml(entry.status)}</strong><br>${escapeHtml(entry.reason || '未填写原因')}</div></div>
        <label class="field wide"><span>仲裁决议 <i class="required-mark">*</i></span><select name="resolution" required><option value="exchange" ${initialResolution === 'exchange' ? 'selected' : ''}>批准换货</option><option value="delay" ${initialResolution === 'delay' ? 'selected' : ''}>批准延期</option><option value="resume" ${initialResolution === 'resume' ? 'selected' : ''}>恢复原履约</option><option value="complete">完成订单</option><option value="refund" ${initialResolution === 'refund' ? 'selected' : ''}>链上退款</option></select></label>
        <label class="field wide" data-resolution-field="delay" hidden><span>延期至 <i class="required-mark">*</i></span><input name="delayUntil" type="datetime-local" value="${escapeHtml(formatDateInput(entry.payload?.delayUntil))}" /></label>
        <div class="endpoint-state wide" data-resolution-field="refund" hidden><div><strong>全额链上退款</strong><br>托管 NPL 将全额退回买家，未领取奖励由合约原子销毁。</div></div>
        <label class="field wide"><span>仲裁备注</span><textarea name="note" maxlength="1000">${escapeHtml(entry.payload?.resolutionNote || '')}</textarea></label>
      </div>
      <div class="dialog-foot"><button class="button" type="button" data-dialog-cancel>取消</button><button class="button danger" type="submit">二次签名并执行</button></div>
    </form>`;
  const form = dialog.querySelector('form[data-action-form="after-sale-resolve"]');
  updateAfterSaleResolutionFields(form);
  dialog.querySelector('.dialog-close')?.addEventListener('click', () => dialog.close(), { once: true });
  dialog.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => dialog.close(), { once: true });
  dialog.showModal();
  requestAnimationFrame(() => form?.elements.resolution?.focus());
}

function updateAfterSaleResolutionFields(form) {
  if (!form) return;
  const resolution = form.elements.resolution?.value;
  form.querySelectorAll('[data-resolution-field]').forEach((field) => {
    const active = field.dataset.resolutionField === resolution;
    field.hidden = !active;
    const input = field.querySelector('input');
    if (input) {
      input.disabled = !active;
      input.required = active && resolution === 'delay';
    }
  });
}

function promptBatchPatch() {
  const dialog = document.querySelector('#admin-dialog');
  if (!dialog) return Promise.resolve(null);
  dialog.innerHTML = `<div class="dialog-head"><div><h2 id="dialog-title">批量修改商品</h2><p>仅提交已填写的状态或库存字段</p></div><button class="dialog-close" type="button" aria-label="关闭">${icon('x')}</button></div>
    <form data-batch-patch-form><div class="dialog-body form-grid"><label class="field"><span>商品状态</span><select name="status"><option value="">保持不变</option><option value="Active">Active</option><option value="Inactive">Inactive</option></select></label><label class="field"><span>统一库存</span><input name="stock" type="number" min="0" placeholder="保持不变" /></label></div><div class="dialog-foot"><button class="button" type="button" data-dialog-cancel>取消</button><button class="button primary" type="submit">继续签名</button></div></form>`;
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (value) => {
      if (dialog.open) dialog.close();
      resolve(value);
    };
    dialog.querySelector('.dialog-close')?.addEventListener('click', () => finish(null), { once: true });
    dialog.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => finish(null), { once: true });
    dialog.querySelector('[data-batch-patch-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = formValues(event.currentTarget);
      const patch = compactPayload({ status: values.status, stock: numberOrUndefined(values.stock) });
      if (!Object.keys(patch).length) {
        showToast('至少填写一个修改字段。', 'error');
        return;
      }
      finish(patch);
    });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); }, { once: true });
  });
}

function confirmAction(title, detail, confirmLabel, danger = false) {
  const dialog = document.querySelector('#admin-dialog');
  if (!dialog) return Promise.resolve(false);
  dialog.innerHTML = `<div class="dialog-head"><div><h2 id="dialog-title">${escapeHtml(title)}</h2><p>${escapeHtml(detail).replaceAll('\n', '<br>')}</p></div><button class="dialog-close" type="button" aria-label="关闭">${icon('x')}</button></div><div class="dialog-body"><div class="endpoint-state ${danger ? 'error' : ''}">${icon(danger ? 'alert' : 'check')}<div>${danger ? '高风险操作将进入管理员钱包二次签名。' : '操作内容将进入管理员钱包二次签名。'}</div></div></div><div class="dialog-foot"><button class="button" type="button" data-dialog-cancel>取消</button><button class="button ${danger ? 'danger' : 'primary'}" type="button" data-dialog-confirm>${escapeHtml(confirmLabel)}</button></div>`;
  dialog.showModal();
  return new Promise((resolve) => {
    let completed = false;
    const finish = (value) => {
      if (completed) return;
      completed = true;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    dialog.querySelector('.dialog-close')?.addEventListener('click', () => finish(false), { once: true });
    dialog.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => finish(false), { once: true });
    dialog.querySelector('[data-dialog-confirm]')?.addEventListener('click', () => finish(true), { once: true });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); }, { once: true });
  });
}

function openRecordDialog(id) {
  const record = findRecord(state.currentData, String(id));
  if (!record) {
    showToast(`未在当前 API 结果中找到记录 ${id}`, 'error');
    return;
  }
  const safe = redactDisplayValue(record);
  openInfoDialog('记录详情', recordIdentifier(record) || id, `<pre class="code-block">${escapeHtml(JSON.stringify(safe, null, 2))}</pre>`);
}

function findRecord(root, id) {
  const queue = [root];
  const seen = new WeakSet();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (recordIdentifier(value) === id) return value;
    if (value.ok === true && value.data) queue.push(value.data);
    else if (Array.isArray(value)) queue.push(...value);
    else queue.push(...Object.values(value));
  }
  return null;
}

function redactDisplayValue(value) {
  if (Array.isArray(value)) return value.map(redactDisplayValue);
  if (!value || typeof value !== 'object') return value;
  const blocked = /secret|password|privateKey|accessKey|apiKey|token$/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, blocked.test(key) ? '[REDACTED]' : redactDisplayValue(item)]));
}

function openInfoDialog(title, subtitle, bodyHtml) {
  const dialog = document.querySelector('#admin-dialog');
  if (!dialog) return;
  dialog.innerHTML = `<div class="dialog-head"><div><h2 id="dialog-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="dialog-close" type="button" aria-label="关闭">${icon('x')}</button></div><div class="dialog-body">${bodyHtml}</div><div class="dialog-foot"><button class="button primary" type="button" data-dialog-close>关闭</button></div>`;
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.querySelector('.dialog-close')?.addEventListener('click', close, { once: true });
  dialog.querySelector('[data-dialog-close]')?.addEventListener('click', close, { once: true });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); }, { once: true });
  dialog.showModal();
}

function openFormDialog(type) {
  if (type === 'product-create') {
    openInfoDialog('平台代上架商品', '商品、权属、物流与首个 SKU', `<form class="form-grid" data-action-form="product-create">
      <label class="field wide"><span>商品标题 <i class="required-mark">*</i></span><input name="title" required /></label><label class="field wide"><span>副标题</span><input name="subtitle" /></label>
      <label class="field"><span>主图 URL</span><input name="imageUrl" type="url" /></label><label class="field"><span>视频 URL</span><input name="videoUrl" type="url" /></label>
      <label class="field wide"><span>详情内容</span><textarea name="details"></textarea></label><label class="field wide"><span>结算商家白名单钱包 <i class="required-mark">*</i></span><input name="sellerAddress" required /></label>
      <label class="field"><span>三级类目 ID</span><input name="categoryId" /></label><label class="field"><span>标签</span><input name="tags" placeholder="逗号分隔" /></label><label class="field"><span>默认物流模板</span><input name="logisticsTemplateId" /></label>
      <label class="field"><span>SKU 名称 <i class="required-mark">*</i></span><input name="skuName" required /></label><label class="field"><span>物理库存 <i class="required-mark">*</i></span><input name="stock" type="number" min="0" required /></label><label class="field"><span>结算底价（NPL） <i class="required-mark">*</i></span><input name="settlementPriceNpl" inputmode="decimal" required /></label>
      <div class="dialog-foot wide" style="padding:14px 0 0"><button class="button primary" type="submit">签名并创建</button></div></form>`);
    return;
  }
  if (type === 'logistics-address') {
    openInfoDialog('新增物流地址', '平台发货仓或官方退货仓', `<form class="form-grid" data-action-form="logistics-address"><label class="field"><span>地址类型</span><select name="type"><option value="shipping">发货仓</option><option value="return">退货仓</option></select></label><label class="field"><span>名称</span><input name="name" required /></label><label class="field"><span>联系人</span><input name="contactName" required /></label><label class="field"><span>联系电话</span><input name="phone" required inputmode="tel" /></label><label class="field"><span>行政区代码</span><input name="regionCode" required /></label><label class="field wide"><span>详细地址</span><textarea name="address" required></textarea></label><label class="switch-line"><span>启用地址</span><input class="switch" type="checkbox" name="enabled" checked /></label><div class="dialog-foot wide" style="padding:14px 0 0"><button class="button primary" type="submit">保存地址</button></div></form>`);
  }
}
