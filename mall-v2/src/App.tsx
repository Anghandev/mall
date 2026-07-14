import {
  CircleDollarSign,
  Flame,
  MapPin,
  ShoppingBag,
  WalletCards,
} from 'lucide-react';
import { BrowserRouter, Link, Navigate, useLocation } from 'react-router-dom';

import { productBaseline } from './bootstrap';
import {
  ActivityScreen,
  AddressScreen,
  AssetsScreen,
  CheckoutScreen,
  MallScreen,
  NotFoundScreen,
  OrdersScreen,
  ReviewScreen,
  RewardsScreen,
  SeckillScreen,
  StoresScreen,
} from './screens';

const tabs = [
  { path: '/seckill', label: '秒杀', icon: Flame },
  { path: '/mall', label: '商城', icon: ShoppingBag },
  { path: '/stores', label: '门店', icon: MapPin },
  { path: '/assets', label: '资产', icon: CircleDollarSign },
] as const;

const primaryPaths = new Set(tabs.map((tab) => tab.path));

export function App() {
  return (
    <BrowserRouter>
      <MallApp />
    </BrowserRouter>
  );
}

export function MallApp() {
  const location = useLocation();
  const isPrimary = primaryPaths.has(location.pathname as (typeof tabs)[number]['path']);
  const activeRoot = getActiveRoot(location.pathname);

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
          <Link className="brand" to="/seckill" aria-label="阿步 24K 商城首页">
            <img src="/brand/logo-mark.png" alt="" />
            <span>
              <strong>阿步 24K</strong>
              <small>商城 V2</small>
            </span>
          </Link>
          <button
            className="wallet-button"
            type="button"
            disabled
            aria-describedby="wallet-unavailable-reason"
          >
            <WalletCards aria-hidden="true" size={17} />
            连接钱包
          </button>
          <span id="wallet-unavailable-reason" className="sr-only">
            安全配置未发布，钱包连接暂不可用
          </span>
        </header>

        <main id="main-content" className="app-content" tabIndex={-1}>
          <div className="primary-screens" hidden={!isPrimary}>
            <section hidden={activeRoot !== '/seckill'} aria-label="秒杀大厅">
              <SeckillScreen />
            </section>
            <section hidden={activeRoot !== '/mall'} aria-label="常规商城">
              <MallScreen />
            </section>
            <section hidden={activeRoot !== '/stores'} aria-label="线下门店">
              <StoresScreen />
            </section>
            <section hidden={activeRoot !== '/assets'} aria-label="我的资产">
              <AssetsScreen />
            </section>
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
  switch (pathname) {
    case '/assets/addresses':
      return <AddressScreen />;
    case '/assets/orders':
      return <OrdersScreen />;
    case '/assets/activity':
      return <ActivityScreen />;
    case '/assets/rewards':
      return <RewardsScreen />;
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
  if (pathname.startsWith('/mall')) return '/mall';
  return '/seckill';
}

export const mallRuntimeBoundary = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  executableOrderActions: productBaseline.executableOrderActions,
  writesEnabled: false,
  sharedInterface: '@abu24k/core-artifacts',
} as const);

export const routeEvidence = Object.freeze({
  primary: tabs.map((tab) => tab.path),
  protected: ['/assets/addresses', '/assets/orders', '/assets/activity', '/assets/rewards'],
  checkout: ['/checkout', '/checkout/review'],
});
