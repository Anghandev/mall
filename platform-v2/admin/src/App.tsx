import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ModuleWorkspace } from './components/ModuleWorkspace';
import { adminModules } from './domain/adminModules';
import { DashboardPage } from './pages/DashboardPage';
import { PolicyPage } from './pages/PolicyPage';
import { TakeoverPage } from './pages/TakeoverPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/policy" element={<PolicyPage />} />
        <Route path="/takeover" element={<TakeoverPage />} />
        {adminModules.filter((module) => !['dashboard', 'policy', 'takeover'].includes(module.id)).map((module) => (
          <Route key={module.path} path={module.path} element={<ModuleWorkspace module={module} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
