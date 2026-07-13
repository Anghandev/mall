import { FileClock, ImagePlus, KeyRound, Search, ShieldCheck, Store, WalletCards } from 'lucide-react';
import { EmptyState, FieldHelp, PageHeader } from '../components/ui';

export function SettingsPage() {
  return (
    <div className="page-stack">
      <PageHeader description="维护店铺资料，查看绑定钱包与不可变安全审计。" eyebrow="06 / 店铺与安全" title="系统配置" />
      <div className="settings-grid">
        <form className="section-block form-section" onSubmit={(event) => event.preventDefault()} aria-labelledby="profile-title">
          <div className="section-heading"><div><p className="eyebrow">Profile</p><h2 id="profile-title">店铺基本资料</h2></div><Store aria-hidden="true" size={19} /></div>
          <div className="field"><label htmlFor="shop-name">店铺名称</label><input disabled id="shop-name" placeholder="店铺资料不可用" type="text" /></div>
          <fieldset className="field"><legend>品牌 Logo</legend><button className="inline-upload" disabled type="button"><ImagePlus aria-hidden="true" size={19} /> 上传 Logo</button><FieldHelp>签名上传与资源归属验证尚未发布。</FieldHelp></fieldset>
          <button className="button primary" disabled type="submit">保存资料</button>
        </form>

        <section className="section-block wallet-panel" aria-labelledby="wallet-title">
          <div className="section-heading"><div><p className="eyebrow">Settlement identity</p><h2 id="wallet-title">绑定结算钱包</h2></div><WalletCards aria-hidden="true" size={19} /></div>
          <div className="wallet-address"><span>常驻 Claim 地址</span><strong>地址不可用</strong><small>当前会话未建立</small></div>
          <div className="governance-note"><KeyRound aria-hidden="true" size={18} /><div><strong>普通编辑不可更换</strong><p>钱包变更必须走治理迁移，不是本地表单字段。</p></div></div>
          <button className="button secondary wide" disabled type="button">申请治理迁移</button>
        </section>
      </div>

      <section className="section-block" aria-labelledby="audit-title">
        <div className="section-heading"><div><p className="eyebrow">Security audit</p><h2 id="audit-title">操作日志</h2></div><div className="audit-tools"><div className="search-field"><Search aria-hidden="true" size={16} /><input aria-label="搜索操作日志" disabled placeholder="搜索操作类型或哈希" type="search" /></div><button className="button quiet" disabled type="button"><FileClock aria-hidden="true" size={16} /> 导出日志</button></div></div>
        <div className="append-only-note"><ShieldCheck aria-hidden="true" size={16} />日志按时间倒序读取，不能编辑或删除；签名和交易证明由 Core 关联。</div>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">操作时间</th><th scope="col">操作类型</th><th scope="col">影响模块</th><th scope="col">操作详情</th><th scope="col">签名哈希</th></tr></thead>
            <tbody><tr><td colSpan={5}><EmptyState blocked description="追加式审计读模型尚未发布，不能展示本地历史。" title="审计日志不可用" /></td></tr></tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
