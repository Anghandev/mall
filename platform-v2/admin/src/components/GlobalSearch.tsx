import {
  breakerScopes,
  fulfillmentModes,
  orderProjectionStates,
  type BreakerScope,
  type FulfillmentMode,
  type OrderKind,
  type OrderProjectionState,
} from '@abu24k/core-artifacts';
import { CalendarDays, RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdminOrderSearchFilters } from '../coreApi';
import { commonStateLabel } from '../display';

const quickRanges = ['今日', '昨日', '近 7 天', '近 30 天'] as const;
const orderKinds = ['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] as const;
type QuickRange = (typeof quickRanges)[number];
type StatusFilter = '' | 'pending-review' | 'breaker';

type SearchForm = {
  orderId: string;
  productId: string;
  skuId: string;
  txHash: string;
  wallet: string;
  start: string;
  end: string;
  state: '' | OrderProjectionState;
  fulfillmentMode: '' | FulfillmentMode;
  orderKind: '' | OrderKind;
  status: StatusFilter;
  breakerScope: BreakerScope;
};

type Props = Readonly<{
  enabled?: boolean;
  loading?: boolean;
  onSearch?(filters: AdminOrderSearchFilters): void;
}>;

const emptyForm: SearchForm = {
  orderId: '', productId: '', skuId: '', txHash: '', wallet: '', start: '', end: '',
  state: '', fulfillmentMode: '', orderKind: '', status: '', breakerScope: breakerScopes[0]!,
};

export function GlobalSearch({ enabled = false, loading = false, onSearch }: Props) {
  const [quickRange, setQuickRange] = useState<QuickRange | null>(null);
  const [form, setForm] = useState<SearchForm>(emptyForm);

  const set = <K extends keyof SearchForm>(field: K, value: SearchForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || !onSearch) return;
    onSearch(toFilters(form));
  };

  const reset = () => {
    setQuickRange(null);
    setForm(emptyForm);
    if (enabled && onSearch) onSearch({});
  };

  const selectQuickRange = (range: QuickRange) => {
    const { start, end } = rangeBounds(range, new Date());
    setQuickRange(range);
    setForm((current) => ({ ...current, start: localInput(start), end: localInput(end) }));
  };

  return (
    <details className="search-panel">
      <summary>
        <span className="summary-title"><SlidersHorizontal aria-hidden="true" /> 更多筛选</span>
        <span className="summary-meta">多条件精确检索 · UID / 手机号仍受限</span>
      </summary>
      <form className="search-form" onSubmit={submit} aria-describedby="search-capability">
        <fieldset className="segmented-field">
          <legend>条件关系</legend>
          <div className="segmented" aria-label="条件关系">
	            <button className="is-active" type="button" aria-pressed="true" disabled={!enabled}>全部满足</button>
	            <button type="button" aria-pressed="false" disabled title="当前只支持全部满足">任一满足</button>
          </div>
        </fieldset>

        <div className="search-grid">
          <label>订单号<input value={form.orderId} onChange={(event) => set('orderId', event.target.value)} disabled={!enabled} autoComplete="off" placeholder="精确匹配" /></label>
	          <label>商品编号<input value={form.productId} onChange={(event) => set('productId', event.target.value)} disabled={!enabled} autoComplete="off" placeholder="精确匹配" /></label>
	          <label>规格编号<input value={form.skuId} onChange={(event) => set('skuId', event.target.value)} disabled={!enabled} autoComplete="off" placeholder="精确匹配" /></label>
	          <label>付款记录编号<input value={form.txHash} onChange={(event) => set('txHash', event.target.value)} disabled={!enabled} autoComplete="off" placeholder="从订单付款记录复制" /><small>不知道这个编号就留空。</small></label>
          <label>
            钱包地址
            <span className="inline-control">
              <input value={form.wallet} onChange={(event) => set('wallet', event.target.value)} disabled={!enabled} autoComplete="off" placeholder="精确匹配" />
              <select aria-label="钱包地址匹配方式" value="精确" disabled><option>精确</option></select>
            </span>
          </label>
          <label>用户 UID<input disabled autoComplete="off" placeholder="请在全局操作中精确查询" /></label>
	          <label>绑定手机号<input disabled type="tel" autoComplete="off" placeholder="当前请用钱包或订单号查询" /></label>
          <label>开始时间<input value={form.start} onChange={(event) => { setQuickRange(null); set('start', event.target.value); }} disabled={!enabled} type="datetime-local" /></label>
          <label>结束时间<input value={form.end} onChange={(event) => { setQuickRange(null); set('end', event.target.value); }} disabled={!enabled} type="datetime-local" /></label>
	          <label>订单状态<select value={form.state} onChange={(event) => set('state', event.target.value as SearchForm['state'])} disabled={!enabled}><option value="">全部</option>{orderProjectionStates.map((state) => <option key={state} value={state}>{stateLabel(state)}</option>)}</select></label>
	          <label>履约方式<select value={form.fulfillmentMode} onChange={(event) => set('fulfillmentMode', event.target.value as SearchForm['fulfillmentMode'])} disabled={!enabled}><option value="">全部</option>{fulfillmentModes.map((mode) => <option key={mode} value={mode}>{fulfillmentModeLabel(mode)}</option>)}</select></label>
	          <label>订单类型<select value={form.orderKind} onChange={(event) => set('orderKind', event.target.value as SearchForm['orderKind'])} disabled={!enabled}><option value="">全部</option>{orderKinds.map((kind) => <option key={kind} value={kind}>{orderKindLabel(kind)}</option>)}</select></label>
          <label>
            业务投影
            <select value={form.status} onChange={(event) => set('status', event.target.value as StatusFilter)} disabled={!enabled}>
              <option value="">全部</option>
              <option value="pending-review">待商品审核</option>
              <option value="warning" disabled>异常黄灯 · 未发布</option>
              <option value="breaker">熔断状态</option>
            </select>
          </label>
	          {form.status === 'breaker' ? <label>安全开关范围<select value={form.breakerScope} onChange={(event) => set('breakerScope', event.target.value as BreakerScope)} disabled={!enabled}>{breakerScopes.map((scope) => <option key={scope} value={scope}>{breakerScopeLabel(scope)}</option>)}</select></label> : null}
        </div>

        <div className="search-footer">
          <div className="quick-ranges" aria-label="快捷时间范围">
            <CalendarDays aria-hidden="true" />
            {quickRanges.map((range) => (
              <button key={range} type="button" className={quickRange === range ? 'is-active' : ''} aria-pressed={quickRange === range} disabled={!enabled} onClick={() => selectQuickRange(range)}>{range}</button>
            ))}
          </div>
          <div className="button-row">
            <button className="button button-quiet" type="button" onClick={reset} disabled={!enabled || loading}><RotateCcw aria-hidden="true" /> 重置</button>
            <button className="button button-primary" type="submit" disabled={!enabled || loading}><Search aria-hidden="true" /> {loading ? '查询中' : '查询'}</button>
          </div>
        </div>
        <p className="inline-notice" id="search-capability">{enabled ? '订单检索由系统按“全部满足”执行。精确 UID、模糊钱包和“任一满足”请使用全局操作；手机号和异常黄灯查询仍保持关闭。' : '连接管理员、运营或审计会话后启用精确订单检索。'}</p>
      </form>
    </details>
  );
}

function toFilters(form: SearchForm): AdminOrderSearchFilters {
  return {
    limit: 50,
    ...(trim(form.orderId) ? { orderId: trim(form.orderId) } : {}),
    ...(trim(form.productId) ? { productId: trim(form.productId) } : {}),
    ...(trim(form.skuId) ? { skuId: trim(form.skuId) } : {}),
    ...(trim(form.txHash) ? { txHash: trim(form.txHash) } : {}),
    ...(trim(form.wallet) ? { wallet: trim(form.wallet) } : {}),
    ...(form.start ? { from: new Date(form.start).toISOString() } : {}),
    ...(form.end ? { to: new Date(form.end).toISOString() } : {}),
    ...(form.state ? { state: form.state } : {}),
    ...(form.fulfillmentMode ? { fulfillmentMode: form.fulfillmentMode } : {}),
    ...(form.orderKind ? { orderKind: form.orderKind } : {}),
    ...(form.status === 'pending-review' ? { pendingReview: true } : {}),
    ...(form.status === 'breaker' ? { breakerScope: form.breakerScope } : {}),
  };
}

function rangeBounds(range: QuickRange, now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === '昨日') {
    start.setDate(start.getDate() - 1);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  if (range === '近 7 天') start.setDate(start.getDate() - 6);
  if (range === '近 30 天') start.setDate(start.getDate() - 29);
  return { start, end: now };
}

function localInput(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function trim(value: string) { return value.trim(); }

function stateLabel(state: OrderProjectionState) {
  return commonStateLabel(state);
}

function fulfillmentModeLabel(mode: FulfillmentMode) {
  return ({
    DELIVERY: '快递配送',
    PICKUP: '到店自提',
  } as Record<FulfillmentMode, string>)[mode] ?? mode;
}

function orderKindLabel(kind: OrderKind) {
  return ({
    ORDINARY: '普通订单',
    SECKILL: '秒杀订单',
    FALLBACK_RETAIL: '普通兜底订单',
  } as Record<OrderKind, string>)[kind] ?? kind;
}

function breakerScopeLabel(scope: BreakerScope) {
  return ({
    NEW_PAYMENT: '暂停新支付',
    SECKILL_PURCHASE: '暂停秒杀购买',
    SETTLEMENT_EXECUTION: '暂停结算执行',
    COVERAGE: '资金覆盖保护',
  } as Record<string, string>)[scope] ?? scope;
}
