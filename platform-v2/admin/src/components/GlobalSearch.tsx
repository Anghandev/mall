import { CalendarDays, RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import { useState, type FormEvent } from 'react';

const quickRanges = ['今日', '昨日', '近 7 天', '近 30 天'] as const;

export function GlobalSearch() {
  const [logic, setLogic] = useState<'AND' | 'OR'>('AND');
  const [walletMode, setWalletMode] = useState<'模糊' | '精确'>('模糊');
  const [quickRange, setQuickRange] = useState<(typeof quickRanges)[number]>('近 7 天');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

  return (
    <details className="search-panel">
      <summary>
        <span className="summary-title"><SlidersHorizontal aria-hidden="true" /> 高级组合检索</span>
        <span className="summary-meta">AND / OR · 精确主键 · RBAC 保护身份字段</span>
      </summary>
      <form className="search-form" onSubmit={submit} aria-describedby="search-unavailable">
        <fieldset className="segmented-field">
          <legend>条件关系</legend>
          <div className="segmented" aria-label="条件关系">
            {(['AND', 'OR'] as const).map((value) => (
              <button
                key={value}
                className={logic === value ? 'is-active' : ''}
                type="button"
                aria-pressed={logic === value}
                onClick={() => setLogic(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="search-grid">
          <label>订单号<input name="orderId" autoComplete="off" placeholder="精确匹配" /></label>
          <label>商品 ID<input name="productId" autoComplete="off" placeholder="精确匹配" /></label>
          <label>TxHash<input name="txHash" autoComplete="off" placeholder="精确匹配" /></label>
          <label>
            钱包地址
            <span className="inline-control">
              <input name="wallet" autoComplete="off" placeholder={`${walletMode}匹配`} />
              <select aria-label="钱包地址匹配方式" value={walletMode} onChange={(event) => setWalletMode(event.target.value as '模糊' | '精确')}>
                <option>模糊</option><option>精确</option>
              </select>
            </span>
          </label>
          <label>用户 UID<input name="uid" autoComplete="off" placeholder="精确匹配" /></label>
          <label>绑定手机号<input name="phone" type="tel" autoComplete="off" placeholder="RBAC 授权后可查" /></label>
          <label>开始时间<input name="start" type="datetime-local" /></label>
          <label>结束时间<input name="end" type="datetime-local" /></label>
          <label>
            业务状态
            <select name="status" defaultValue="">
              <option value="">全部状态</option>
              <option value="pending-review">待审核</option>
              <option value="warning">异常黄灯</option>
              <option value="breaker">熔断红灯</option>
            </select>
          </label>
        </div>

        <div className="search-footer">
          <div className="quick-ranges" aria-label="快捷时间范围">
            <CalendarDays aria-hidden="true" />
            {quickRanges.map((range) => (
              <button key={range} type="button" className={quickRange === range ? 'is-active' : ''} aria-pressed={quickRange === range} onClick={() => setQuickRange(range)}>
                {range}
              </button>
            ))}
          </div>
          <div className="button-row">
            <button className="button button-quiet" type="reset"><RotateCcw aria-hidden="true" /> 重置</button>
            <button className="button button-primary" type="submit" disabled aria-disabled="true"><Search aria-hidden="true" /> 查询</button>
          </div>
        </div>
        <p className="inline-notice" id="search-unavailable">Core 未发布查询契约与 PII 权限，查询保持禁用。</p>
      </form>
    </details>
  );
}
