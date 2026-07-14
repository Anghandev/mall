import { AlertTriangle, ArrowRight, Ban, CircleDollarSign, Clock3, FileLock2, PackageCheck, ShieldCheck, Truck } from 'lucide-react';
import { BatchActionBar } from '../components/BatchActionBar';
import { GlobalSearch } from '../components/GlobalSearch';

const stages = [
  { label: '自动建案', detail: 'payment finality 后 7 × 24h 无有效发货证据', icon: Clock3 },
  { label: '冻结商家权限', detail: '新订单、上架与商家结算申请', icon: Ban },
  { label: '顺序筹资', detail: '保证金 → 冻结应收 → 未来货款', icon: CircleDollarSign },
  { label: '完成履约', detail: '平台或替代商家发货，进入普通 finality', icon: Truck },
] as const;

export function TakeoverPage() {
  return (
    <>
      <header className="page-header takeover-header">
        <div className="page-icon"><ShieldCheck aria-hidden="true" /></div>
        <div><p className="eyebrow">MERCHANT TAKEOVER</p><h1>商家接管履约中心</h1><p>接管不是资金返还流程。订单继续履约，支付与全部奖励保持 Locked。</p></div>
        <div className="requirement-list"><code>ADM-TAKE-001—004</code><code>D-V2-004 / 005 / 020</code></div>
      </header>

      <GlobalSearch />

      <section className="takeover-stage-grid" aria-label="接管履约阶段">
        {stages.map(({ label, detail, icon: Icon }, index) => (
          <article key={label}><span className="stage-number">0{index + 1}</span><Icon aria-hidden="true" /><h2>{label}</h2><p>{detail}</p>{index < stages.length - 1 ? <ArrowRight className="stage-arrow" aria-hidden="true" /> : null}</article>
        ))}
      </section>

      <section className="workspace-grid">
        <article className="panel panel-main">
          <div className="panel-heading"><div><p className="section-kicker">Case queue</p><h2>所有接管案件持续可见</h2></div><span className="status-chip status-blocked"><Ban aria-hidden="true" /> Projection unavailable</span></div>
          <div className="empty-table" role="status"><FileLock2 aria-hidden="true" /><h3>无法读取接管案件</h3><p>GAP-ADM-010 尚未发布。系统不把“无数据”解释为“没有逾期案件”。</p><button className="button button-primary" type="button" disabled><PackageCheck aria-hidden="true" /> 打开履约证据</button></div>
        </article>
        <aside className="panel takeover-guard">
          <p className="section-kicker">不可暂停能力</p><h2>履约与恢复通道</h2>
          <ul className="check-list"><li><ShieldCheck aria-hidden="true" /> 接管履约</li><li><ShieldCheck aria-hidden="true" /> 技术恢复与 reconciliation</li><li><ShieldCheck aria-hidden="true" /> finality synchronization</li><li><ShieldCheck aria-hidden="true" /> append-only audit reads</li></ul>
          <div className="debt-note"><AlertTriangle aria-hidden="true" /><p><strong>垫资记为商家债务</strong><br />客户支付、BNM 与其他奖励直到普通履约最终性前保持 Locked。</p></div>
        </aside>
      </section>

      <BatchActionBar ordinarySoftDelete={false} immutable />
    </>
  );
}
