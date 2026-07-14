import { ChevronDown, CircleHelp, Menu, Radio, ShieldAlert, WalletCards } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.jpg';
import { coreState } from '../coreState';
import { adminModules } from '../domain/adminModules';

type AppShellProps = { children: ReactNode };

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const currentModule = adminModules.find((module) => module.path === location.pathname) ?? adminModules[0]!;

  useEffect(() => {
    setMobileNavOpen(false);
    mainRef.current?.focus();
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    navigationRef.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMobileNavOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileNavOpen]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="topbar">
        <div className="brand-lockup">
          <img src={logoUrl} alt="阿步 24K" width="42" height="42" />
          <span><strong>ABU 24K</strong><small>PLATFORM OPERATIONS</small></span>
        </div>
        <button ref={menuButtonRef} className="mobile-menu" type="button" aria-label="打开后台模块导航" aria-expanded={mobileNavOpen} aria-controls="primary-navigation" onClick={() => setMobileNavOpen((open) => !open)}>
          <Menu aria-hidden="true" />
        </button>
        <div className="system-strip">
          <span className="status-chip status-blocked"><ShieldAlert aria-hidden="true" /> {coreState.connectionLabel}</span>
          <span className="status-chip"><Radio aria-hidden="true" /> BSC · Chain 56</span>
          <button className="wallet-button" type="button" disabled title="等待 RBAC / SIWE 能力"><WalletCards aria-hidden="true" /> 管理钱包未连接</button>
          <button className="icon-button" type="button" aria-label="查看阻断说明" onClick={() => navigate('/core-status')}><CircleHelp aria-hidden="true" /></button>
        </div>
      </header>

      <aside className={mobileNavOpen ? 'sidebar is-open' : 'sidebar'} id="primary-navigation">
        <nav ref={navigationRef} aria-label="平台后台模块">
          {adminModules.map(({ path, label, icon: Icon, eyebrow }) => (
            <NavLink key={path} to={path} end={path === '/'}>
              <Icon aria-hidden="true" />
              <span><strong>{label}</strong><small>{eyebrow}</small></span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <p>Artifact contract</p>
          <strong>{coreState.artifactStatus.toUpperCase()}</strong>
          <span>所有生产写入 fail-closed</span>
        </div>
      </aside>

      <div className="mobile-route-picker">
        <label htmlFor="module-select">当前模块</label>
        <span><currentModule.icon aria-hidden="true" />
          <select id="module-select" value={currentModule.path} onChange={(event) => navigate(event.target.value)}>
            {adminModules.map((module) => <option key={module.path} value={module.path}>{module.label}</option>)}
          </select>
          <ChevronDown aria-hidden="true" />
        </span>
      </div>

      <main id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
    </div>
  );
}
