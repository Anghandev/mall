import { ArrowRight, CircleAlert, PackageCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState, Metric, PageHeader } from '../components/ui';

export function DashboardPage() {
  return (
    <div className="page-stack">
      <PageHeader
        description="单店今日交付与资产快照，数据日界线和统计口径由 Core 返回。"
        eyebrow="01 / 工作台"
        title="运营大盘"
      />
      <section className="metric-grid" aria-label="今日核心数据">
        <Link className="metric-link-wrap" to="/fulfillment"><Metric hint="等待权威订单聚合" label="今日待发货订单" linkLabel="前往履约交付" /></Link>
        <Metric hint="商家五状态 USDT 投影未发布" label="今日销售货款" />
        <Metric hint="唯一商品状态枚举未发布" label="当前单品秒杀状态" />
        <Metric hint="跨门店已核销自提数量" label="今日门店核销" />
      </section>
      <div className="dashboard-grid">
        <section className="section-block" aria-labelledby="delivery-title">
          <div className="section-heading">
            <div><p className="eyebrow">Fulfillment</p><h2 id="delivery-title">今日交付队列</h2></div>
            <Link className="text-link" to="/fulfillment">查看全部 <ArrowRight aria-hidden="true" size={15} /></Link>
          </div>
          <EmptyState blocked description="履约订单已在交付页实时读取；大盘日界聚合与导出统计尚未发布。" title="交付聚合不可用" />
        </section>
        <section className="section-block" aria-labelledby="product-title">
          <div className="section-heading">
            <div><p className="eyebrow">Single product</p><h2 id="product-title">唯一商品</h2></div>
          </div>
          <div className="product-state-row">
            <span className="status-icon"><PackageCheck aria-hidden="true" size={20} /></span>
            <div><strong>状态不可判定</strong><p>未获取生成枚举和 `allowedActions`，商品写入保持锁定。</p></div>
          </div>
          <div className="inline-warning"><CircleAlert aria-hidden="true" size={17} /><span>不可用状态绝不会按“草稿”或“已下架”处理。</span></div>
          <Link className="button secondary wide" to="/product">检查单品表单</Link>
        </section>
      </div>
    </div>
  );
}
