import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { CoreApi } from './core-api';
import { WorkspaceShell } from './components/WorkspaceShell';
import { CoreRuntimeProvider, useCoreRuntime } from './core-runtime';
import { LoginPage } from './pages/LoginPage';
import { MerchantApplyPage } from './pages/MerchantApplyPage';

const AssetsPage = lazy(() => import('./pages/AssetsPage').then((module) => ({ default: module.AssetsPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const FulfillmentPage = lazy(() => import('./pages/FulfillmentPage').then((module) => ({ default: module.FulfillmentPage })));
const HelpPage = lazy(() => import('./pages/HelpPage').then((module) => ({ default: module.HelpPage })));
const ProductPage = lazy(() => import('./pages/ProductPage').then((module) => ({ default: module.ProductPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const StoresPage = lazy(() => import('./pages/StoresPage').then((module) => ({ default: module.StoresPage })));
const TakeoverPage = lazy(() => import('./pages/TakeoverPage').then((module) => ({ default: module.TakeoverPage })));

const workspaceRoutes = [
  { path: '/dashboard', Component: DashboardPage },
  { path: '/product', Component: ProductPage },
  { path: '/fulfillment', Component: FulfillmentPage },
  { path: '/takeovers', Component: TakeoverPage },
  { path: '/stores', Component: StoresPage },
  { path: '/assets', Component: AssetsPage },
  { path: '/settings', Component: SettingsPage },
  { path: '/help', Component: HelpPage },
];

function isVisualReview() {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('__merchant_visual_review__') === '1';
}

function AppRoutes() {
  const { session } = useCoreRuntime();
  const canEnterWorkspace = Boolean(session) || isVisualReview();

  return (
    <Routes>
      <Route path="/" element={session ? <Navigate replace to="/dashboard" /> : <LoginPage />} />
      <Route path="/apply" element={session ? <Navigate replace to="/dashboard" /> : <MerchantApplyPage />} />
      {workspaceRoutes.map(({ path, Component }) => (
        <Route
          element={canEnterWorkspace ? <WorkspaceShell><LazyRoute Component={Component} /></WorkspaceShell> : <Navigate replace to="/" />}
          key={path}
          path={path}
        />
      ))}
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}

function LazyRoute({ Component }: { Component: ComponentType }) {
  return (
    <Suspense fallback={<div className="resource-state" role="status">正在加载页面</div>}>
      <Component />
    </Suspense>
  );
}

export function App({ client }: { client?: CoreApi }) {
  return (
    <CoreRuntimeProvider {...(client ? { client } : {})}>
      <AppRoutes />
    </CoreRuntimeProvider>
  );
}
