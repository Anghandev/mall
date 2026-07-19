import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { merchantDeployment } from './bootstrap';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root application mount');
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={merchantDeployment.routerBasename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
