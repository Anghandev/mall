import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { CoreSessionProvider } from './coreSession';
import { launchAdminModules, type AdminModule } from './domain/adminModules';

const AuditPage = lazy(() => import('./pages/AuditPage').then((module) => ({ default: module.AuditPage })));
const CatalogPage = lazy(() => import('./pages/CatalogPage').then((module) => ({ default: module.CatalogPage })));
const CmsPage = lazy(() => import('./pages/CmsPage').then((module) => ({ default: module.CmsPage })));
const CoreStatusPage = lazy(() => import('./pages/CoreStatusPage').then((module) => ({ default: module.CoreStatusPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const GlobalOperationsPage = lazy(() => import('./pages/GlobalOperationsPage').then((module) => ({ default: module.GlobalOperationsPage })));
const MerchantFinancePage = lazy(() => import('./pages/MerchantFinancePage').then((module) => ({ default: module.MerchantFinancePage })));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage').then((module) => ({ default: module.MonitoringPage })));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage').then((module) => ({ default: module.NotificationsPage })));
const PaymentTracePage = lazy(() => import('./pages/PaymentTracePage').then((module) => ({ default: module.PaymentTracePage })));
const PolicyPage = lazy(() => import('./pages/PolicyPage').then((module) => ({ default: module.PolicyPage })));
const RiskPage = lazy(() => import('./pages/RiskPage').then((module) => ({ default: module.RiskPage })));
const SeckillPage = lazy(() => import('./pages/SeckillPage').then((module) => ({ default: module.SeckillPage })));
const SystemConfigPage = lazy(() => import('./pages/SystemConfigPage').then((module) => ({ default: module.SystemConfigPage })));
const TakeoverPage = lazy(() => import('./pages/TakeoverPage').then((module) => ({ default: module.TakeoverPage })));
const ModuleWorkspace = lazy(() => import('./components/ModuleWorkspace').then((module) => ({ default: module.ModuleWorkspace })));

const routePages = [
  { path: '/', Component: DashboardPage },
  { path: '/catalog', Component: CatalogPage },
  { path: '/merchants', Component: MerchantFinancePage },
  { path: '/global-operations', Component: GlobalOperationsPage },
  { path: '/policy', Component: PolicyPage },
  { path: '/risk', Component: RiskPage },
  { path: '/seckill', Component: SeckillPage },
  { path: '/takeover', Component: TakeoverPage },
  { path: '/cms', Component: CmsPage },
  { path: '/notifications', Component: NotificationsPage },
  { path: '/system', Component: SystemConfigPage },
  { path: '/audit', Component: AuditPage },
  { path: '/operations', Component: MonitoringPage },
  { path: '/clearing', Component: PaymentTracePage },
  { path: '/core-status', Component: CoreStatusPage },
];

const staticRouteModuleIds = new Set([
  'dashboard',
  'global',
  'merchants',
  'catalog',
  'policy',
  'risk',
  'seckill',
  'takeover',
  'cms',
  'notifications',
  'system',
  'audit',
  'operations',
  'clearing',
  'core',
]);

export function App() {
  return (
    <CoreSessionProvider>
      <AppShell>
        <Routes>
          {routePages.map(({ path, Component }) => (
            <Route key={path} path={path} element={<LazyRoute Component={Component} />} />
          ))}
          {launchAdminModules.filter((module) => !staticRouteModuleIds.has(module.id)).map((module) => (
            <Route key={module.path} path={module.path} element={<LazyModuleRoute module={module} />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </CoreSessionProvider>
  );
}

function LazyRoute({ Component }: { Component: ComponentType }) {
  return (
    <Suspense fallback={<div className="empty-table" role="status">正在加载页面</div>}>
      <Component />
    </Suspense>
  );
}

function LazyModuleRoute({ module }: { module: AdminModule }) {
  return (
    <Suspense fallback={<div className="empty-table" role="status">正在加载页面</div>}>
      <ModuleWorkspace module={module} />
    </Suspense>
  );
}
