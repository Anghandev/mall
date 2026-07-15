import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CircleAlert,
  PackageCheck,
  RefreshCw,
  Truck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  CatalogProductLifecycleState,
  MerchantBusinessDashboard,
  SeckillState,
} from '@abu24k/core-artifacts';
import { readableError, useCoreRuntime } from '../core-runtime';
import { EmptyState, LoadingRows, Metric, PageHeader } from '../components/ui';

type LoadState =
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; value: MerchantBusinessDashboard }
  | { phase: 'error'; message: string };

const productStateLabels: Record<CatalogProductLifecycleState, string> = {
  DRAFT: '草稿未送审',
  REVIEW: '平台审核中',
  SCHEDULED: '待排期上架',
  ACTIVE: '销售进行中',
  SOLD_OUT: '已售罄',
  HIDDEN: '平台隐藏',
  DELISTED: '已下架',
  LOCKED: '已锁定',
};

const seckillStateLabels: Record<SeckillState, string> = {
  PREHEAT: '预热中',
  LIVE: '秒杀进行中',
  SETTLING: '结算中',
  SETTLED: '已结算',
  FORCE_CLOSED: '已强制关闭',
};

export function DashboardPage() {
  const { api, session } = useCoreRuntime();
  const [state, setState] = useState<LoadState>({ phase: 'idle' });
  const sessionTokenRef = useRef(session?.token);
  sessionTokenRef.current = session?.token;

  const loadDashboard = useCallback(async (quiet = false) => {
    if (!session) {
      setState({ phase: 'idle' });
      return;
    }
    if (!quiet) setState({ phase: 'loading' });
    const token = session.token;
    try {
      const value = await api.getMerchantBusinessDashboard(token);
      if (sessionTokenRef.current === token) setState({ phase: 'ready', value });
    } catch (error) {
      if (sessionTokenRef.current === token) setState({ phase: 'error', message: readableError(error) });
    }
  }, [api, session]);

  useEffect(() => {
    void loadDashboard();
    const interval = window.setInterval(() => void loadDashboard(true), 60_000);
    return () => window.clearInterval(interval);
  }, [loadDashboard]);

  const dashboard = state.phase === 'ready' ? state.value : undefined;
  const loadHint = state.phase === 'loading'
    ? '正在读取 Core 权威聚合'
    : state.phase === 'error'
      ? state.message
      : '需要已验证的商家会话';
  const product = dashboard?.product;

  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <button className="button quiet" disabled={!session} onClick={() => void loadDashboard()} type="button">
            <RefreshCw aria-hidden="true" size={16} /> 刷新权威数据
          </button>
        )}
        description="单店支付终局、实时履约队列与资产快照均由 Core 返回，页面每分钟刷新一次。"
        eyebrow="01 / 工作台"
        title="运营大盘"
      />

      <section className="metric-grid" aria-label="商家核心数据">
        <Link className="metric-link-wrap" to="/fulfillment">
          <Metric
            hint={dashboard ? '当前实时待填写快递单号' : loadHint}
            label="快递待发货订单"
            linkLabel="前往履约交付"
            value={dashboard?.orders.pendingShipment}
          />
        </Link>
        <Metric
          hint={dashboard ? `${dashboard.timezone} 链上最终确认订单总价` : loadHint}
          label="今日销售总价（USDT atomic）"
          value={dashboard?.sales.listPriceUsdt}
        />
        <Metric
          hint={dashboard
            ? product?.seckill ? `秒杀阶段：${seckillStateLabels[product.seckill.phase]}` : '当前无进行中的秒杀场次'
            : loadHint}
          label="当前单品状态"
          value={dashboard ? product ? productStateLabels[product.state] : '未提报' : undefined}
        />
        <Metric
          hint={dashboard ? `${dashboard.timezone} 当日成功自提核销` : loadHint}
          label="今日门店核销"
          value={dashboard?.orders.pickupVerifiedToday}
        />
      </section>

      {state.phase === 'loading' ? <LoadingRows count={3} /> : null}
      {state.phase === 'error' ? (
        <EmptyState blocked description={state.message} title="运营聚合加载失败" />
      ) : null}
      {state.phase === 'idle' ? (
        <EmptyState blocked description="需要已验证的商家钱包会话。" title="商家会话不可用" />
      ) : null}

      {dashboard ? (
        <>
          <div className="dashboard-window" role="status">
            <span>统计时区 <strong>{dashboard.timezone}</strong></span>
            <span>日界 <strong>{dashboard.window.start}</strong> 至 <strong>{dashboard.window.end}</strong></span>
            <span>生成于 <strong>{dashboard.window.generatedAt}</strong></span>
          </div>

          <div className="dashboard-grid">
            <section className="section-block" aria-labelledby="delivery-title">
              <div className="section-heading">
                <div><p className="eyebrow">Fulfillment</p><h2 id="delivery-title">当前履约队列</h2></div>
                <Link className="text-link" to="/fulfillment">查看全部 <ArrowRight aria-hidden="true" size={15} /></Link>
              </div>
              <dl className="dashboard-queue">
                <div><dt>待发货</dt><dd>{dashboard.orders.pendingShipment}</dd></div>
                <div><dt>已发货</dt><dd>{dashboard.orders.shipped}</dd></div>
                <div><dt>已送达</dt><dd>{dashboard.orders.delivered}</dd></div>
                <div><dt>已履约</dt><dd>{dashboard.orders.fulfilled}</dd></div>
                <div><dt>仲裁中</dt><dd>{dashboard.orders.arbitration}</dd></div>
                <div><dt>平台接管</dt><dd>{dashboard.orders.takeover}</dd></div>
              </dl>
              <div className="dashboard-authority-summary">
                <div><span>今日最终确认订单</span><strong>{dashboard.orders.finalizedToday}</strong></div>
                <div><span>今日 cohort 发货率</span><strong>{dashboard.shipmentRate.bps === null ? '不可计算' : `${dashboard.shipmentRate.bps} bps`}</strong><small>{dashboard.shipmentRate.numerator} / {dashboard.shipmentRate.denominator}</small></div>
                <div><span>买家 USDT 实付</span><strong>{dashboard.sales.buyerUsdtPaid}</strong><small>atomic</small></div>
                <div><span>商家基础应收</span><strong>{dashboard.sales.merchantBaseReceivableUsdt}</strong><small>USDT atomic</small></div>
                <div><span>商家净应收</span><strong>{dashboard.sales.merchantNetReceivableUsdt}</strong><small>USDT atomic</small></div>
              </div>
            </section>

            <section className="section-block" aria-labelledby="product-title">
              <div className="section-heading">
                <div><p className="eyebrow">Single product</p><h2 id="product-title">唯一商品</h2></div>
              </div>
              {product ? (
                <>
                  <div className="product-state-row">
                    <span className="status-icon"><PackageCheck aria-hidden="true" size={20} /></span>
                    <div>
                      <strong>{product.title}</strong>
                      <p>{productStateLabels[product.state]}{product.seckill ? ` / ${seckillStateLabels[product.seckill.phase]}` : ''}</p>
                    </div>
                  </div>
                  <dl className="dashboard-product-stock">
                    <div><dt>总库存</dt><dd>{product.stock.total}</dd></div>
                    <div><dt>可用</dt><dd>{product.stock.available}</dd></div>
                    <div><dt>已预留</dt><dd>{product.stock.reserved}</dd></div>
                  </dl>
                </>
              ) : (
                <div className="product-state-row">
                  <span className="status-icon"><Truck aria-hidden="true" size={20} /></span>
                  <div><strong>尚未提报商品</strong><p>Core 返回空商品位，可前往单品提报检查可用操作。</p></div>
                </div>
              )}
              <div className="inline-warning">
                <CircleAlert aria-hidden="true" size={17} />
                <span>{dashboard.merchant.status} / {dashboard.merchant.guaranteeStatus}，商品和财务写入仍以各自 Core 授权为准。</span>
              </div>
              <Link className="button secondary wide" to="/product">检查单品表单</Link>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
