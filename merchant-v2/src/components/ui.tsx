import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, DatabaseZap, LoaderCircle } from 'lucide-react';
import { coreBoundary } from '../core-boundary';

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
  return (
    <div className={compact ? 'system-notice compact' : 'system-notice'} role="status">
      <DatabaseZap aria-hidden="true" size={18} />
      <div>
        <strong>Core 数据通道未发布</strong>
        <span>{coreBoundary.reason}。金额、状态、权限与写入操作全部按失败关闭处理。</span>
      </div>
    </div>
  );
}

export function Metric({
  label,
  hint,
  linkLabel,
}: {
  label: string;
  hint: string;
  linkLabel?: string;
}) {
  return (
    <article className="metric">
      <p>{label}</p>
      <strong aria-label={`${label}不可用`}>--</strong>
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
