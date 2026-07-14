import { CircleDollarSign, Coins, ExternalLink, Gift, LockKeyhole, WalletCards } from 'lucide-react';
import { EmptyState, Metric, PageHeader } from '../components/ui';
import { canExecuteOrderAction } from '../core-boundary';

export function AssetsPage() {
  return (
    <div className="page-stack">
      <PageHeader
        actions={<button className="button primary" disabled={!canExecuteOrderAction('REQUEST_MERCHANT_SETTLEMENT')} type="button"><WalletCards aria-hidden="true" size={16} /> 签名结算申请</button>}
        description="USDT 商家货款与 NPL、BNM 奖励分轨展示，所有金额和可领取状态来自 Core。"
        eyebrow="05 / 财务与收益"
        title="资产清算中心"
      />
      <section aria-labelledby="proceeds-title">
        <div className="section-label"><div><CircleDollarSign aria-hidden="true" size={18} /><h2 id="proceeds-title">USDT 货款</h2></div><span>独立资产轨</span></div>
        <div className="metric-grid six">
          <Metric hint="自然日权威时区" label="今日销售货款" />
          <Metric hint="已付款，履约未终结" label="Locked 锁定中" />
          <Metric hint="已履约，可签名申请" label="Available 可申请" />
          <Metric hint="已签名，待 Safe 组批" label="Requested 已申请" />
          <Metric hint="已绑定不可变 Safe 批次" label="Batched 已组批" />
          <Metric hint="15 确认后最终入账" label="Settled 已结算" />
        </div>
      </section>

      <div className="reward-grid">
        <section className="section-block reward-section" aria-labelledby="seckill-reward-title">
          <div className="section-heading"><div><p className="eyebrow">USDT</p><h2 id="seckill-reward-title">秒杀收益明细</h2></div><Gift aria-hidden="true" size={19} /></div>
          <EmptyState blocked description="最终场次结算与收益比例未发布。" title="收益投影不可用" />
        </section>
        <section className="section-block reward-section" aria-labelledby="npl-title">
          <div className="section-heading"><div><p className="eyebrow">NPL</p><h2 id="npl-title">门店奖励池</h2></div><Coins aria-hidden="true" size={19} /></div>
          <div className="reward-balance"><span>可领取 NPL</span><strong>--</strong><small>资格与金额不可用</small></div>
        </section>
        <section className="section-block reward-section" aria-labelledby="bnm-title">
          <div className="section-heading"><div><p className="eyebrow">BNM</p><h2 id="bnm-title">释放跟踪</h2></div><LockKeyhole aria-hidden="true" size={19} /></div>
          <dl className="balance-list"><div><dt>Locked</dt><dd>--</dd></div><div><dt>Available</dt><dd>--</dd></div></dl>
        </section>
      </div>

      <section className="section-block" aria-labelledby="settlement-history-title">
        <div className="section-heading"><div><p className="eyebrow">Safe settlement</p><h2 id="settlement-history-title">结算申请与 Safe 批次</h2></div><button className="button quiet" disabled type="button">在区块浏览器查看 <ExternalLink aria-hidden="true" size={15} /></button></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">申请时间</th><th scope="col">资产</th><th scope="col">精确金额</th><th scope="col">状态</th><th scope="col">Safe 批次 ID</th><th scope="col">最终 Safe TxHash</th></tr></thead>
            <tbody><tr><td colSpan={6}><EmptyState blocked description="结算请求、Safe 组批、交易替换和最终性投影尚未发布。" title="结算记录不可用" /></td></tr></tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
