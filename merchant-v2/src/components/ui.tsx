import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CircleCheck, DatabaseZap, LoaderCircle } from 'lucide-react';
import { coreBoundary } from '../core-boundary';
import { useCoreRuntime } from '../core-runtime';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function CoreUnavailable({ compact = false }: { compact?: boolean }) {
  const { bootstrap } = useCoreRuntime();
  const available = bootstrap.phase === 'ready';
  const Icon = available ? CircleCheck : DatabaseZap;
  return (
    <div className={`${compact ? 'system-notice compact' : 'system-notice'}${available ? ' ready' : ''}`} role="status">
      <Icon aria-hidden="true" size={18} />
      <div>
        <span hidden data-core-boundary={coreBoundary.auditReason} />
        <strong>{bootstrap.phase === 'checking' ? '正在检查系统连接' : available ? '系统已连接' : '系统连接失败'}</strong>
        <span>
          {available
            ? `${coreBoundary.reason}。没有权限或条件不满足的按钮会自动禁用。`
            : bootstrap.phase === 'offline'
              ? bootstrap.error
              : '正在确认当前后台是否可用。'}
        </span>
      </div>
    </div>
  );
}

export function Metric({
  label,
  hint,
  linkLabel,
  value,
}: {
  label: string;
  hint: string;
  linkLabel?: string;
  value?: string | undefined;
}) {
  return (
    <article className="metric">
      <p>{label}</p>
      <strong aria-label={value === undefined ? `${label}未返回数据` : `${label}${value}`}>{value ?? '--'}</strong>
      <span>{hint}</span>
      {linkLabel ? (
        <span className="metric-link">
          {linkLabel} <ArrowRight aria-hidden="true" size={14} />
        </span>
      ) : null}
    </article>
  );
}

export function EmptyState({
  title,
  description,
  blocked = false,
}: {
  title: string;
  description: string;
  blocked?: boolean;
}) {
  const Icon = blocked ? AlertTriangle : DatabaseZap;
  return (
    <div className="empty-state">
      <Icon aria-hidden="true" size={24} />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

export function LoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div aria-label="正在加载" className="loading-rows" role="status">
      <LoaderCircle aria-hidden="true" size={18} />
      {Array.from({ length: count }, (_, index) => (
        <span className="skeleton" key={index} />
      ))}
    </div>
  );
}

export function BlockedButton({ children }: { children: ReactNode }) {
  return (
    <button className="button primary" disabled type="button">
      {children}
    </button>
  );
}

export function FieldHelp({ children }: { children: ReactNode }) {
  return <span className="field-help">{children}</span>;
}
