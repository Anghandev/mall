import { AlertTriangle, Check, FileDiff, KeyRound, LockKeyhole, ShieldCheck, WalletCards } from 'lucide-react';

const governanceSteps = [
  { label: 'RBAC 授权', detail: '精确资源与变更范围', icon: ShieldCheck },
  { label: '二次钱包签名', detail: 'EIP-712 / nonce / deadline', icon: KeyRound },
  { label: 'Safe 多签', detail: '完整 owners approval evidence', icon: WalletCards },
  { label: '发布 policyVersion', detail: '仅未来报价、订单和场次', icon: FileDiff },
] as const;

export function PolicyPage() {
  return (
    <>
      <header className="page-header">
        <div className="page-icon"><FileDiff aria-hidden="true" /></div>
        <div><p className="eyebrow">版本化资金规则</p><h1>政策治理工作台</h1><p>所有比例与地址由 Core 验证。前端只展示精确 diff、审批证据和生效边界。</p></div>
        <div className="requirement-list"><code>ADM-POL-001—005</code><code>D-V2-014 / D-V2-021</code></div>
      </header>

      <section className="policy-layout">
        <article className="panel policy-editor" aria-labelledby="policy-title">
          <div className="panel-heading"><div><p className="section-kicker">Policy draft</p><h2 id="policy-title">未创建版本</h2></div><span className="status-chip status-blocked"><LockKeyhole aria-hidden="true" /> DecisionBlocked</span></div>
          <fieldset disabled>
            <legend>未来版本参数</legend>
            <div className="form-grid">
              <label>商品 / 场次资源<input placeholder="等待 Core resource projection" /></label>
              <label>商家结算成本 · USDT<input inputMode="decimal" placeholder="由 Core canonical amount 提供" /></label>
              <label>买家 USDT payment leg<input inputMode="decimal" placeholder="由 signed policy 提供" /></label>
              <label>买家 NPL payment leg<input inputMode="decimal" placeholder="由 signed policy 提供" /></label>
              <label>NPL Burn<input value="20% · launch policy" readOnly /></label>
              <label>NPL Route<input value="80% · launch policy" readOnly /></label>
              <label>平台服务费<input placeholder="DecisionBlocked" /></label>
              <label>秒杀奖池比例<input placeholder="DecisionBlocked" /></label>
              <label>商家店铺奖励比例<input placeholder="DecisionBlocked" /></label>
              <label>Oracle maxAge / minimum liquidity<input placeholder="DecisionBlocked" /></label>
            </div>
          </fieldset>
          <p className="field-note"><AlertTriangle aria-hidden="true" /> 平台不得在界面预设未冻结商业值，也不得计算总和、路由或受益资格。</p>
        </article>

        <aside className="panel governance-panel">
          <p className="section-kicker">Publish evidence</p><h2>四道发布门</h2>
          <ol className="governance-steps">
            {governanceSteps.map(({ label, detail, icon: Icon }, index) => (
              <li key={label}><span className="step-index">{index + 1}</span><Icon aria-hidden="true" /><div><strong>{label}</strong><small>{detail}</small></div><span className="step-state">等待 Core</span></li>
            ))}
          </ol>
          <button className="button button-primary button-full" type="button" disabled><Check aria-hidden="true" /> 发布新 policyVersion</button>
          <p className="button-explanation">GAP-ADM-004 / 008 / 017 未完成，发布不能开始。</p>
        </aside>
      </section>

      <section className="snapshot-rule">
        <LockKeyhole aria-hidden="true" />
        <div><strong>不可变快照边界</strong><p>新版本只影响未来报价、新订单和新场次；历史订单与进行中场次永久使用原快照。</p></div>
      </section>
    </>
  );
}
