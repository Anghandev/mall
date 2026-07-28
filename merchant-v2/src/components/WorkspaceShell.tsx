import { useEffect, useState } from 'react';
import {
  BadgeHelp,
  Boxes,
  Building2,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  Truck,
  X,
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import logo from '../assets/abu-24k-logo.png';
import { coreBoundary } from '../core-boundary';
import { useCoreRuntime } from '../core-runtime';
import { CoreUnavailable } from './ui';

const navigation = [
  { to: '/dashboard', label: '运营大盘', index: '01', icon: LayoutDashboard },
  { to: '/product', label: '单品提报', index: '02', icon: Boxes },
  { to: '/fulfillment', label: '履约交付', index: '03', icon: ClipboardList },
  { to: '/takeovers', label: '接管履约', index: '04', icon: Truck },
  { to: '/stores', label: '门店管理', index: '05', icon: Building2 },
  { to: '/assets', label: '资产清算', index: '06', icon: CircleDollarSign },
  { to: '/settings', label: '系统配置', index: '07', icon: Settings },
  { to: '/help', label: '帮助中心', index: '08', icon: BadgeHelp },
];

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { bootstrap, session, signOut } = useCoreRuntime();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'} id="workspace-navigation">
        <div className="brand-lockup">
          <img alt="24K商城" src={logo} />
          <div>
            <strong>24K商城</strong>
            <span>商家工作台</span>
          </div>
          <button
            aria-label="关闭导航"
            className="icon-button sidebar-close"
            onClick={() => setMenuOpen(false)}
            type="button"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>

        <nav aria-label="商家工作台导航" className="primary-nav">
          {navigation.map(({ to, label, index, icon: Icon }) => (
            <NavLink className={({ isActive }) => (isActive ? 'active' : undefined)} key={to} to={to}>
              <Icon aria-hidden="true" size={18} />
              <span>{label}</span>
              <small>{index}</small>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="security-chip">
            <ShieldCheck aria-hidden="true" size={16} />
            <span>安全经营模式</span>
          </div>
          <p>系统状态</p>
          <strong>已连接</strong>
          <details className="technical-details compact">
            <summary>高级版本信息</summary>
            <code>{coreBoundary.artifactVersion}</code>
          </details>
        </div>
      </aside>

      {menuOpen ? <button aria-label="关闭导航遮罩" className="nav-scrim" onClick={() => setMenuOpen(false)} type="button" /> : null}

      <div className="workspace">
        <header className="topbar">
          <button aria-controls="workspace-navigation" aria-expanded={menuOpen} aria-label="打开导航" className="icon-button menu-button" onClick={() => setMenuOpen(true)} type="button">
            <Menu aria-hidden="true" size={20} />
          </button>
          <div className="workspace-context">
            <span>当前店铺</span>
            <button disabled type="button">
              门店以系统记录为准 <ChevronDown aria-hidden="true" size={15} />
            </button>
          </div>
          <div className="topbar-actions">
            <span className={bootstrap.phase === 'ready' ? 'connection-state ready' : 'connection-state'}><i /> {session ? shortAddress(session.walletAddress) : bootstrap.phase === 'ready' ? '系统已连接' : '未连接'}</span>
            <button className="button quiet" disabled={!session} onClick={signOut} type="button">
              <LogOut aria-hidden="true" size={16} /> 退出
            </button>
          </div>
        </header>
        <CoreUnavailable compact />
        <main id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
