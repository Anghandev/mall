import { ChevronDown, CircleHelp, Menu, Radio, ShieldAlert, WalletCards } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.jpg';
import { coreState } from '../coreState';
import { useCoreSession } from '../coreSession';
import { launchAdminModules } from '../domain/adminModules';

type AppShellProps = { children: ReactNode };

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const { connect, disconnect, error: sessionError, session, status } = useCoreSession();
  const currentModule = launchAdminModules.find((module) => module.path === location.pathname) ?? launchAdminModules[0]!;

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
          <img src={logoUrl} alt="24K商城" width="42" height="42" />
          <span><strong>24K商城</strong><small>平台运营后台</small></span>
        </div>
        <button ref={menuButtonRef} className="mobile-menu" type="button" aria-label="打开后台模块导航" aria-expanded={mobileNavOpen} aria-controls="primary-navigation" onClick={() => setMobileNavOpen((open) => !open)}>
          <Menu aria-hidden="true" />
        </button>
        <div className="system-strip">
          <span className="status-chip"><ShieldAlert aria-hidden="true" /> {coreState.connectionLabel}</span>
          <span className="status-chip"><Radio aria-hidden="true" /> 主网环境</span>
          <button
            className="wallet-button"
            type="button"
            title={sessionError ?? (session ? '断开当前会话' : '连接平台管理钱包')}
            onClick={() => session ? disconnect() : void connect()}
            disabled={status === 'CONNECTING'}
          >
            <WalletCards aria-hidden="true" /> {session ? compactAddress(session.walletAddress) : status === 'CONNECTING' ? '等待签名' : '连接管理钱包'}
          </button>
          <button className="icon-button" type="button" aria-label="查看阻断说明" onClick={() => navigate('/core-status')}><CircleHelp aria-hidden="true" /></button>
        </div>
      </header>

      <aside className={mobileNavOpen ? 'sidebar is-open' : 'sidebar'} id="primary-navigation">
        <nav ref={navigationRef} aria-label="平台后台模块">
          {launchAdminModules.map(({ path, label, icon: Icon, eyebrow }) => (
            <NavLink key={path} to={path} end={path === '/'}>
              <Icon aria-hidden="true" />
              <span><strong>{label}</strong><small>{eyebrow}</small></span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <p>系统状态</p>
          <strong>已连接</strong>
          <span>所有操作以当前钱包权限和系统状态为准</span>
          <details className="technical-details compact">
            <summary>高级版本信息</summary>
            <code>{coreState.artifactVersion}</code>
          </details>
        </div>
      </aside>

      <div className="mobile-route-picker">
        <label htmlFor="module-select">当前模块</label>
        <span><currentModule.icon aria-hidden="true" />
          <select id="module-select" value={currentModule.path} onChange={(event) => navigate(event.target.value)}>
            {launchAdminModules.map((module) => <option key={module.path} value={module.path}>{module.label}</option>)}
          </select>
          <ChevronDown aria-hidden="true" />
        </span>
      </div>

      <main id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
    </div>
  );
}

function compactAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
