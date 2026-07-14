import { useId, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CircleAlert,
  CircleHelp,
  LockKeyhole,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import { Link } from 'react-router-dom';

type ScreenHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  backTo?: string;
  trailing?: ReactNode;
};

export function ScreenHeader({
  eyebrow,
  title,
  description,
  backTo,
  trailing,
}: ScreenHeaderProps) {
  return (
    <header className="screen-header">
      <div className="screen-header__row">
        {backTo ? (
          <Link className="icon-button" to={backTo} aria-label="返回上一页">
            <ArrowLeft aria-hidden="true" size={20} />
          </Link>
        ) : null}
        <div className="screen-header__copy">
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h1>{title}</h1>
        </div>
        {trailing ? <div className="screen-header__trailing">{trailing}</div> : null}
      </div>
      {description ? <p className="screen-header__description">{description}</p> : null}
    </header>
  );
}

type StatusNoticeProps = {
  title: string;
  children: ReactNode;
  tone?: 'neutral' | 'warning';
};

export function StatusNotice({ title, children, tone = 'neutral' }: StatusNoticeProps) {
  const Icon = tone === 'warning' ? AlertTriangle : ShieldCheck;

  return (
    <section className={`status-notice status-notice--${tone}`} aria-labelledby={`notice-${slug(title)}`}>
      <Icon aria-hidden="true" size={20} />
      <div>
        <h2 id={`notice-${slug(title)}`}>{title}</h2>
        <p>{children}</p>
      </div>
    </section>
  );
}

export function UnavailableValue({ label }: { label: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className="metric__value" aria-label={`${label}暂不可用`}>
        --
      </strong>
    </div>
  );
}

type DisabledActionProps = {
  children: ReactNode;
  reason: string;
  icon?: 'wallet' | 'lock';
  className?: string;
};

export function DisabledAction({
  children,
  reason,
  icon = 'lock',
  className = '',
}: DisabledActionProps) {
  const generatedId = useId().replace(/:/g, '');
  const id = `disabled-${slug(String(children))}-${generatedId}`;
  const Icon = icon === 'wallet' ? WalletCards : LockKeyhole;

  return (
    <div className={`disabled-action ${className}`.trim()}>
      <button type="button" className="button button--primary" disabled aria-describedby={id}>
        <Icon aria-hidden="true" size={18} />
        {children}
      </button>
      <p id={id} className="control-reason">
        {reason}
      </p>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  image,
}: {
  title: string;
  children: ReactNode;
  image?: string;
}) {
  return (
    <section className="empty-state">
      {image ? <img src={image} alt="" /> : <CircleAlert aria-hidden="true" size={28} />}
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

export function RulesDisclosure() {
  return (
    <details className="rules-disclosure">
      <summary>
        <CircleHelp aria-hidden="true" size={18} />
        规则说明
      </summary>
      <div className="rules-disclosure__body">
        <ul>
          <li>主场固定 60 分钟，接力初始 60 秒。</li>
          <li>每笔链上最终确认的秒杀购买增加 30 秒，接力最高 60 秒且不超过主场截止。</li>
          <li>区块时间决定订单归类。截止后的交易只可按已签名的日常报价与库存原子执行。</li>
          <li>秒杀与日常报价都须在付款前确认，BNM 在履约最终确认前保持锁定。</li>
          <li>TxHash 仅代表已提交，最终结果以链上确认和业务状态同步为准。</li>
        </ul>
      </div>
    </details>
  );
}

function slug(value: string) {
  return value
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
