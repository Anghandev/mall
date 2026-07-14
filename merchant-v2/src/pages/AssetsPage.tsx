import { CircleDollarSign, Coins, ExternalLink, Gift, LockKeyhole, WalletCards } from 'lucide-react';
import { EmptyState, Metric, PageHeader } from '../components/ui';
import { canExecuteOrderAction } from '../core-boundary';

export function AssetsPage() {
  return (
    <div className="page-stack">
      <PageHeader
        actions={<button className="button primary" disabled={!canExecuteOrderAction('CLAIM_MERCHANT_USDT')} type="button"><WalletCards aria-hidden="true" size={16} /> 签名提取货款 (Claim)</button>}
        description="USDT 商家货款与 NPL、BNM 奖励分轨展示，所有金额和可领取状态来自 Core。"
        eyebrow="05 / 财务与收益"
        title="资产清算中心"
      />
      <section aria-labelledby="proceeds-title">
        <div className="section-label"><div><CircleDollarSign aria-hidden="true" size={18} /><h2 id="proceeds-title">USDT 货款</h2></div><span>独立资产轨</span></div>
        <div className="metric-grid five">
          <Metric hint="自然日权威时区" label="今日销售货款" />
          <Metric hint="已付款，履约未终结" label="Locked 锁定中" />
          <Metric hint="已履约，等待最终性" label="PendingSettlement" />
          <Metric hint="可发起 Claim" label="Available 可提现" />
          <Metric hint="历史成功 Claim" label="Claimed 已提现" />
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
          <dl className="balance-list"><div><dt>Locked</dt><dd>--</dd></div><div><dt>Available</dt><dd>--</dd></div><div><dt>Claimed</dt><dd>--</dd></div></dl>
        </section>
      </div>

      <section className="section-block" aria-labelledby="claim-history-title">
        <div className="section-heading"><div><p className="eyebrow">On-chain records</p><h2 id="claim-history-title">提现记录</h2></div><button className="button quiet" disabled type="button">在区块浏览器查看 <ExternalLink aria-hidden="true" size={15} /></button></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">提现时间</th><th scope="col">提取资产</th><th scope="col">提取金额 (USDT)</th><th scope="col">状态</th><th scope="col">提现 Hash</th><th scope="col">Gas (BNB)</th></tr></thead>
            <tbody><tr><td colSpan={6}><EmptyState blocked description="Claim 意图、交易替换和最终性投影尚未发布。" title="提现记录不可用" /></td></tr></tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
