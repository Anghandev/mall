import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ModuleWorkspace } from './components/ModuleWorkspace';
import { CoreSessionProvider } from './coreSession';
import { launchAdminModules } from './domain/adminModules';
import { CatalogPage } from './pages/CatalogPage';
import { AuditPage } from './pages/AuditPage';
import { CmsPage } from './pages/CmsPage';
import { CoreStatusPage } from './pages/CoreStatusPage';
import { DashboardPage } from './pages/DashboardPage';
import { MerchantFinancePage } from './pages/MerchantFinancePage';
import { GlobalOperationsPage } from './pages/GlobalOperationsPage';
import { MonitoringPage } from './pages/MonitoringPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { PaymentTracePage } from './pages/PaymentTracePage';
import { PolicyPage } from './pages/PolicyPage';
import { RiskPage } from './pages/RiskPage';
import { SeckillPage } from './pages/SeckillPage';
import { SystemConfigPage } from './pages/SystemConfigPage';
import { TakeoverPage } from './pages/TakeoverPage';

export function App() {
  return (
    <CoreSessionProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/merchants" element={<MerchantFinancePage />} />
          <Route path="/global-operations" element={<GlobalOperationsPage />} />
          <Route path="/policy" element={<PolicyPage />} />
          <Route path="/risk" element={<RiskPage />} />
          <Route path="/seckill" element={<SeckillPage />} />
          <Route path="/takeover" element={<TakeoverPage />} />
          <Route path="/cms" element={<CmsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/system" element={<SystemConfigPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/operations" element={<MonitoringPage />} />
          <Route path="/clearing" element={<PaymentTracePage />} />
          <Route path="/core-status" element={<CoreStatusPage />} />
          {launchAdminModules.filter((module) => !['dashboard', 'global', 'merchants', 'catalog', 'policy', 'risk', 'seckill', 'takeover', 'cms', 'notifications', 'system', 'audit', 'operations', 'clearing', 'core'].includes(module.id)).map((module) => (
            <Route key={module.path} path={module.path} element={<ModuleWorkspace module={module} />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </CoreSessionProvider>
  );
}
