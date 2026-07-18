import { useEffect, useId, useRef, type ReactNode } from 'react';
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

export function RulesDisclosure({ onOpen }: { onOpen(): void }) {
  return (
    <button className="button button--secondary rules-disclosure" type="button" aria-haspopup="dialog" onClick={onOpen}>
      <CircleHelp aria-hidden="true" size={18} />
      规则说明
    </button>
  );
}

export function RulesDialog({
  open,
  confirmationRequired,
  onClose,
  onConfirm,
}: {
  open: boolean;
  confirmationRequired: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocusRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      returnFocus?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="rules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-dialog-title"
        aria-describedby="rules-dialog-description"
      >
        <header>
          <div>
            <p className="eyebrow">SECKILL RULES</p>
            <h2 id="rules-dialog-title">{confirmationRequired ? '进入配置前确认规则' : '秒杀规则'}</h2>
          </div>
        </header>
        <p id="rules-dialog-description">最终报价和金额仍在双报价订单核对页中确认，本弹窗不计算付款金额。</p>
        <ul>
          <li>主场固定 60 分钟，接力初始 60 秒。</li>
          <li>每笔链上最终确认的秒杀购买增加 30 秒，接力最高 60 秒且不超过主场截止。</li>
          <li>区块时间决定订单归类。截止后的交易只可按已签名的日常报价与库存原子执行。</li>
          <li>商品付款基数为 70% USDT + 30% 等值 NPL；秒杀与日常均使用 Core 签名的五分钟精确报价。</li>
          <li>BNM 是按商品 USDT 标价 1:1 记录的后台积分，不是代币，履约最终确认前保持 Locked。</li>
          <li>TxHash 仅代表已提交，最终结果以链上确认和业务状态同步为准。</li>
        </ul>
        <div className="rules-dialog__actions">
          <button ref={initialFocusRef} className="button button--secondary" type="button" onClick={onClose}>
            {confirmationRequired ? '取消' : '关闭'}
          </button>
          {confirmationRequired ? (
            <button className="button button--primary" type="button" onClick={onConfirm}>我已阅读并确认规则</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function slug(value: string) {
  return value
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
