import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { merchantDeployment } from './bootstrap';
import './styles.css';

export function mountMerchantApp(target: HTMLElement | null = document.getElementById('root')): Root {
  if (!target) {
    throw new Error('Missing #root application mount');
  }
  const root = createRoot(target);
  root.render(
    <StrictMode>
      <BrowserRouter basename={merchantDeployment.routerBasename}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
  return root;
}

if (!import.meta.env.VITEST) mountMerchantApp();
