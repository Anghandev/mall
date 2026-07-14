import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ModuleWorkspace } from './components/ModuleWorkspace';
import { CoreSessionProvider } from './coreSession';
import { adminModules } from './domain/adminModules';
import { CatalogPage } from './pages/CatalogPage';
import { CoreStatusPage } from './pages/CoreStatusPage';
import { DashboardPage } from './pages/DashboardPage';
import { PaymentTracePage } from './pages/PaymentTracePage';
import { PolicyPage } from './pages/PolicyPage';
import { TakeoverPage } from './pages/TakeoverPage';

export function App() {
  return (
    <CoreSessionProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/policy" element={<PolicyPage />} />
          <Route path="/takeover" element={<TakeoverPage />} />
          <Route path="/clearing" element={<PaymentTracePage />} />
          <Route path="/core-status" element={<CoreStatusPage />} />
          {adminModules.filter((module) => !['dashboard', 'catalog', 'policy', 'takeover', 'clearing', 'core'].includes(module.id)).map((module) => (
            <Route key={module.path} path={module.path} element={<ModuleWorkspace module={module} />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </CoreSessionProvider>
  );
}
