import {
  CircleDollarSign,
  Flame,
  MapPin,
  ShoppingBag,
  WalletCards,
  Zap,
} from 'lucide-react';
import { BrowserRouter, Link, Navigate, useLocation } from 'react-router-dom';

import { BlockBurstScreen } from './block-burst';
import { productBaseline } from './bootstrap';
import { brandAssetUrl, mallBasePath } from './deployment-paths';
import { MallRuntimeProvider, useMallRuntime, type MallServices } from './mall-runtime';
import {
  ActivityScreen,
  AddressScreen,
  AssetsScreen,
  CheckoutScreen,
  MallScreen,
  NotFoundScreen,
  NotificationsScreen,
  OrdersScreen,
  ProductDetailScreen,
  ReviewScreen,
  RewardsScreen,
  SeckillScreen,
  StoresScreen,
} from './screens';

const tabs = [
  { path: '/seckill', label: '秒杀', icon: Flame },
  { path: '/mall', label: '商城', icon: ShoppingBag },
  { path: '/stores', label: '门店', icon: MapPin },
  { path: '/block-blast', label: '爆区块', icon: Zap },
  { path: '/assets', label: '资产', icon: CircleDollarSign },
] as const;

const primaryPaths = new Set(tabs.map((tab) => tab.path));

export function App() {
  return (
    <BrowserRouter basename={mallBasePath}>
      <MallApp />
    </BrowserRouter>
  );
}

export function MallApp({ services }: { services?: MallServices } = {}) {
  return (
    <MallRuntimeProvider {...(services ? { services } : {})}>
      <MallShell />
    </MallRuntimeProvider>
  );
}

function MallShell() {
  const location = useLocation();
  const isPrimary = primaryPaths.has(location.pathname as (typeof tabs)[number]['path']);
  const activeRoot = getActiveRoot(location.pathname);
  const runtime = useMallRuntime();

  if (location.pathname === '/') {
    return <Navigate to="/seckill" replace />;
  }

  return (
    <div className="site-shell">
      <div className="app-frame">
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <header className="app-bar">
          <Link className="brand" to="/seckill" aria-label="24K商城首页">
            <img src={brandAssetUrl('logo-mark.png')} alt="" />
            <span>
              <strong>24K商城</strong>
              <small>商城 V2</small>
            </span>
          </Link>
          <button
            className="wallet-button"
            type="button"
            aria-label={runtime.session ? `重新验证或切换钱包，当前 ${runtime.session.walletAddress}` : '连接钱包'}
            disabled={runtime.busy}
            onClick={() => void runtime.connectWallet()}
          >
            <WalletCards aria-hidden="true" size={17} />
            {runtime.session ? shortenAddress(runtime.session.walletAddress) : runtime.busy ? '连接中' : '连接钱包'}
          </button>
        </header>

        <main id="main-content" className="app-content" tabIndex={-1}>
          {runtime.error ? (
            <div className="runtime-error" role="alert">
              <span>{runtime.error}</span>
              <button type="button" onClick={runtime.clearError}>关闭</button>
            </div>
          ) : null}
          {runtime.pendingSubmission ? (
            <section className="runtime-pending" aria-labelledby="pending-submission-title">
              <div className="runtime-pending__info">
                <strong id="pending-submission-title">链上交易待恢复跟踪</strong>
                <span>{shortenHash(runtime.pendingSubmission.txHash)}</span>
              </div>
              <div className="runtime-pending__actions">
                <button type="button" onClick={() => void runtime.retrySubmission()} disabled={runtime.busy || !runtime.session}>
                  {runtime.pendingSubmission.phase === 'PENDING_CORE_SUBMISSION' ? '重试提交' : '刷新投影'}
                </button>
              </div>
            </section>
          ) : null}
          <div className="primary-screens" hidden={!isPrimary}>
            {isPrimary && activeRoot === '/seckill' ? (
              <section aria-label="秒杀大厅">
                <SeckillScreen />
              </section>
            ) : null}
            {isPrimary && activeRoot === '/mall' ? (
              <section aria-label="常规商城">
                <MallScreen />
              </section>
            ) : null}
            {isPrimary && activeRoot === '/stores' ? (
              <section aria-label="线下门店">
                <StoresScreen />
              </section>
            ) : null}
            {isPrimary && activeRoot === '/block-blast' ? (
              <section aria-label="爆区块">
                <BlockBurstScreen />
              </section>
            ) : null}
            {isPrimary && activeRoot === '/assets' ? (
              <section aria-label="我的资产">
                <AssetsScreen />
              </section>
            ) : null}
          </div>

          {!isPrimary ? <DetailRoute pathname={location.pathname} /> : null}
        </main>

        <nav className="bottom-nav" aria-label="主要导航">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeRoot === tab.path;
            return (
              <Link
                key={tab.path}
                className={active ? 'bottom-nav__item is-active' : 'bottom-nav__item'}
                to={tab.path}
                aria-current={active ? 'page' : undefined}
              >
                <Icon aria-hidden="true" size={21} />
                <span>{tab.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

function DetailRoute({ pathname }: { pathname: string }) {
  const productMatch = /^\/mall\/products\/([^/]+)$/.exec(pathname);
  if (productMatch) {
    return <ProductDetailScreen productId={decodeURIComponent(productMatch[1]!)} />;
  }

  switch (pathname) {
    case '/assets/addresses':
      return <AddressScreen />;
    case '/assets/orders':
      return <OrdersScreen />;
    case '/assets/activity':
      return <ActivityScreen />;
    case '/assets/rewards':
      return <RewardsScreen />;
    case '/assets/notifications':
      return <NotificationsScreen />;
    case '/checkout':
      return <CheckoutScreen />;
    case '/checkout/review':
      return <ReviewScreen />;
    default:
      return <NotFoundScreen />;
  }
}

function getActiveRoot(pathname: string) {
  if (pathname.startsWith('/assets')) return '/assets';
  if (pathname.startsWith('/checkout')) return '/mall';
  if (pathname.startsWith('/stores')) return '/stores';
  if (pathname.startsWith('/block-blast')) return '/block-blast';
  if (pathname.startsWith('/mall')) return '/mall';
  return '/seckill';
}

export const mallRuntimeBoundary = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  executableOrderActions: productBaseline.executableOrderActions,
  deploymentAuthorized: productBaseline.deploymentAuthorized,
  paymentCapabilities: productBaseline.paymentCapabilities,
  settlementAdminCapabilities: productBaseline.settlementAdminCapabilities,
  sharedInterface: '@abu24k/core-artifacts',
} as const);

export const routeEvidence = Object.freeze({
  primary: tabs.map((tab) => tab.path),
  protected: ['/assets/addresses', '/assets/orders', '/assets/activity', '/assets/rewards', '/assets/notifications'],
  checkout: ['/mall/products/:productId', '/checkout', '/checkout/review'],
});

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortenHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}
