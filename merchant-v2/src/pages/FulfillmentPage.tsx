import { useState } from 'react';
import type { AllowedAction } from '@abu24k/core-artifacts';
import {
  Box,
  Download,
  FileSpreadsheet,
  PackageCheck,
  Printer,
  ScanLine,
  Search,
  Send,
} from 'lucide-react';
import { EmptyState, LoadingRows, PageHeader } from '../components/ui';
import { canExecuteOrderAction } from '../core-boundary';
import { readableError, useCoreRuntime } from '../core-runtime';

const deliveryColumns = ['订单号', 'TxHash', '收货人', '电话', '详细地址', '数量', '下单时间', '物流单号', '核销状态', '操作'];
const pickupColumns = ['订单号', '核销门店', '核销状态', '核销时间', '操作'];

export function FulfillmentPage() {
  const [tab, setTab] = useState<'delivery' | 'pickup'>('delivery');
  const [orderId, setOrderId] = useState('');
  const [actionLookup, setActionLookup] = useState<
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'ready'; actions: readonly AllowedAction[] }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  const { api, session } = useCoreRuntime();
  const columns = tab === 'delivery' ? deliveryColumns : pickupColumns;

  async function lookupOrderActions() {
    if (!session || orderId.trim().length === 0) return;
    setActionLookup({ phase: 'loading' });
    try {
      setActionLookup({
        phase: 'ready',
        actions: await api.getOrderAllowedActions(orderId.trim(), session.token),
      });
    } catch (error) {
      setActionLookup({ phase: 'error', message: readableError(error) });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <div className="button-group">
            <button className="button secondary" disabled type="button"><Printer aria-hidden="true" size={16} /> 批量打印</button>
            <button className="button primary" disabled type="button"><Download aria-hidden="true" size={16} /> 导出 Excel</button>
          </div>
        )}
        description="秒杀与常规订单统一履约。商家不能改价、退款或直接完成签收。"
        eyebrow="03 / 订单与发货"
        title="履约交付"
      />

      <section className="section-block order-check" aria-labelledby="order-check-title">
        <div className="section-heading"><div><p className="eyebrow">Payment checkpoint</p><h2 id="order-check-title">订单权限核验</h2></div><span>实时 Core 读取</span></div>
        <p className="section-intro">输入订单号后读取服务端 `allowedActions`。支付批次尚未发布商家订单列表或商家可见的支付投影，本页不使用买家专用接口越权查询。</p>
        <form className="order-check-form" onSubmit={(event) => { event.preventDefault(); void lookupOrderActions(); }}>
          <div className="field"><label htmlFor="order-action-id">订单 ID</label><input autoComplete="off" id="order-action-id" onChange={(event) => setOrderId(event.target.value)} placeholder="输入 Core 订单 ID" type="text" value={orderId} /></div>
          <button className="button secondary" disabled={!session || orderId.trim().length === 0 || actionLookup.phase === 'loading'} type="submit">核验可用操作</button>
        </form>
        {actionLookup.phase === 'loading' ? <LoadingRows count={3} /> : null}
        {actionLookup.phase === 'error' ? <p className="form-error" role="alert">{actionLookup.message}</p> : null}
        {actionLookup.phase === 'ready' ? <AllowedActionsTable actions={actionLookup.actions} /> : null}
      </section>

      <section className="section-block fulfillment-workspace" aria-labelledby="orders-title">
        <div className="tabs" role="group" aria-label="履约方式">
          <button aria-controls="fulfillment-orders" aria-pressed={tab === 'delivery'} className={tab === 'delivery' ? 'active' : undefined} id="delivery-tab" onClick={() => setTab('delivery')} type="button"><Box aria-hidden="true" size={17} /> 快递邮寄</button>
          <button aria-controls="fulfillment-orders" aria-pressed={tab === 'pickup'} className={tab === 'pickup' ? 'active' : undefined} id="pickup-tab" onClick={() => setTab('pickup')} type="button"><ScanLine aria-hidden="true" size={17} /> 到店自提</button>
        </div>
        <h2 className="sr-only" id="orders-title">订单列表</h2>
        <div className="filter-bar" aria-label="订单筛选">
          <div className="search-field"><Search aria-hidden="true" size={17} /><input disabled aria-label="搜索订单号或交易哈希" placeholder="搜索订单号 / TxHash" type="search" /></div>
          <label><span>时间范围</span><input disabled aria-label="开始日期" type="date" /></label>
          <label><span>SKU</span><select disabled aria-label="SKU"><option>全部 SKU</option></select></label>
          <label><span>订单状态</span><select disabled aria-label="订单状态"><option>全部状态</option></select></label>
          <label><span>履约模式</span><select disabled aria-label="履约模式"><option>全部模式</option></select></label>
          <button className="button secondary" disabled type="button">应用筛选</button>
        </div>
        <div className="selection-bar">
          <span>已选择 0 笔</span>
          {tab === 'delivery' ? (
            <div className="button-group">
              <button className="button secondary" disabled={!canExecuteOrderAction('RECORD_SHIPMENT')} type="button"><Send aria-hidden="true" size={16} /> 批量发货</button>
              <button className="button secondary" disabled type="button"><FileSpreadsheet aria-hidden="true" size={16} /> 电子面单</button>
            </div>
          ) : (
            <button className="button secondary" disabled type="button"><Printer aria-hidden="true" size={16} /> 补打双联小票</button>
          )}
        </div>
        <div aria-live="polite" className="table-wrap" id="fulfillment-orders">
          <table>
            <thead><tr><th scope="col"><input aria-label="选择全部订单" disabled type="checkbox" /></th>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody><tr><td colSpan={columns.length + 1}><EmptyState blocked description="订单查询、PII 授权、分页与导出能力尚未发布。" title="订单数据不可用" /></td></tr></tbody>
          </table>
        </div>
      </section>

      {tab === 'delivery' ? (
        <div className="two-panel-grid">
          <section className="section-block compact-section" aria-labelledby="shipment-title">
            <div className="section-heading"><div><p className="eyebrow">Shipment evidence</p><h2 id="shipment-title">提交发货证据</h2></div><PackageCheck aria-hidden="true" size={19} /></div>
            <div className="field"><label htmlFor="tracking-number">快递物流单号</label><input disabled id="tracking-number" placeholder="选择订单后录入或生成" type="text" /></div>
            <button className="button primary wide" disabled={!canExecuteOrderAction('RECORD_SHIPMENT')} type="button">去发货</button>
            <p className="panel-note">发货只提交幂等履约证据，不代表签收或资产结算。</p>
          </section>
          <section className="section-block compact-section" aria-labelledby="receipt-title">
            <div className="section-heading"><div><p className="eyebrow">Receipt review</p><h2 id="receipt-title">申请平台确认签收</h2></div></div>
            <p>物流确认送达满 7 天后，商家仅可提交证据申请，由平台审核。仲裁期间资产继续 Locked。</p>
            <button className="button secondary wide" disabled={!canExecuteOrderAction('REQUEST_FORCED_RECEIPT')} type="button">申请平台审核</button>
            <p className="panel-note">本工作台没有“商家强制签收”或直接完成订单的操作。</p>
          </section>
        </div>
      ) : (
        <div className="two-panel-grid">
          <section className="section-block compact-section" aria-labelledby="scan-title">
            <div className="section-heading"><div><p className="eyebrow">Pickup verification</p><h2 id="scan-title">扫码核销自提</h2></div><ScanLine aria-hidden="true" size={19} /></div>
            <div className="field"><label htmlFor="pickup-code">手工核销码</label><input disabled id="pickup-code" placeholder="等待门店签名挑战" type="text" /></div>
            <button className="button primary wide" disabled={!canExecuteOrderAction('VERIFY_PICKUP')} type="button">启动扫码</button>
            <p className="panel-note">相机或手工核销必须绑定签名挑战、订单和当前门店，不能离线提交。</p>
          </section>
          <section className="section-block compact-section" aria-labelledby="pickup-print-title">
            <div className="section-heading"><div><p className="eyebrow">Two-copy receipt</p><h2 id="pickup-print-title">核销双联小票</h2></div><Printer aria-hidden="true" size={19} /></div>
            <p>核销最终确认后生成一笔双联打印任务，一联门店留存，一联交付用户。</p>
            <button className="button secondary wide" disabled type="button">检查打印设备</button>
            <p className="panel-note">真实设备、供应商账号和物理出单证据为 ConfigurationRequired。</p>
          </section>
        </div>
      )}

      <div className="provider-strip" role="status">
        <span><i className="provider-dot warning" />快递接口：ConfigurationRequired</span>
        <span><i className="provider-dot warning" />云打印机：ConfigurationRequired</span>
        <span><i className="provider-dot offline" />Core 订单流：Unavailable</span>
      </div>
    </div>
  );
}

function AllowedActionsTable({ actions }: { actions: readonly AllowedAction[] }) {
  return (
    <div aria-live="polite" className="table-wrap compact-table">
      <table>
        <thead><tr><th scope="col">操作</th><th scope="col">Core 判定</th><th scope="col">原因</th><th scope="col">截止时间</th></tr></thead>
        <tbody>
          {actions.map((action) => (
            <tr key={action.action}>
              <td><code>{action.action}</code></td>
              <td><span className={action.enabled ? 'state-text success' : 'state-text blocked'}>{action.enabled ? '允许' : '阻断'}</span></td>
              <td>{action.reasonCode ?? '—'}</td>
              <td>{action.deadline ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
