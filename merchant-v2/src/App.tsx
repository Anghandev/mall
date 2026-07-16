import { Navigate, Route, Routes } from 'react-router-dom';
import type { CoreApi } from './core-api';
import { WorkspaceShell } from './components/WorkspaceShell';
import { CoreRuntimeProvider, useCoreRuntime } from './core-runtime';
import { AssetsPage } from './pages/AssetsPage';
import { DashboardPage } from './pages/DashboardPage';
import { FulfillmentPage } from './pages/FulfillmentPage';
import { HelpPage } from './pages/HelpPage';
import { LoginPage } from './pages/LoginPage';
import { ProductPage } from './pages/ProductPage';
import { SettingsPage } from './pages/SettingsPage';
import { StoresPage } from './pages/StoresPage';
import { TakeoverPage } from './pages/TakeoverPage';

const workspaceRoutes = [
  { path: '/dashboard', element: <DashboardPage /> },
  { path: '/product', element: <ProductPage /> },
  { path: '/fulfillment', element: <FulfillmentPage /> },
  { path: '/takeovers', element: <TakeoverPage /> },
  { path: '/stores', element: <StoresPage /> },
  { path: '/assets', element: <AssetsPage /> },
  { path: '/settings', element: <SettingsPage /> },
  { path: '/help', element: <HelpPage /> },
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
      {workspaceRoutes.map(({ path, element }) => (
        <Route
          element={canEnterWorkspace ? <WorkspaceShell>{element}</WorkspaceShell> : <Navigate replace to="/" />}
          key={path}
          path={path}
        />
      ))}
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}

export function App({ client }: { client?: CoreApi }) {
  return (
    <CoreRuntimeProvider {...(client ? { client } : {})}>
      <AppRoutes />
    </CoreRuntimeProvider>
  );
}
