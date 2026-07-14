import { BookOpenCheck, ChevronRight, CircleAlert, Clock3, LockKeyhole, PackageCheck, ShieldAlert } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';

export function HelpPage() {
  return (
    <div className="page-stack help-page">
      <PageHeader description="查看当前政策内容与商家履约边界。" eyebrow="07 / 规则对齐" title="帮助中心" />
      <div className="help-layout">
        <section className="section-block rules-section" aria-labelledby="rules-title">
          <div className="section-heading"><div><p className="eyebrow">Published policy</p><h2 id="rules-title">秒杀规则说明</h2></div><BookOpenCheck aria-hidden="true" size={20} /></div>
          <EmptyState blocked description="版本化富文本和 policyVersion 尚未由 Core 协调发布，不能显示旧规则。" title="当前规则内容不可用" />
          <div className="policy-footer"><span>Policy version</span><strong>UNPUBLISHED</strong></div>
        </section>

        <aside className="section-block help-index" aria-labelledby="help-index-title">
          <p className="eyebrow">Quick index</p><h2 id="help-index-title">商家须知</h2>
          <a href="#one-product">一店一单品 <ChevronRight aria-hidden="true" size={16} /></a>
          <a href="#fulfillment-rule">真实履约证据 <ChevronRight aria-hidden="true" size={16} /></a>
          <a href="#takeover-rule">超时接管 <ChevronRight aria-hidden="true" size={16} /></a>
          <a href="#receipt-rule">签收与仲裁 <ChevronRight aria-hidden="true" size={16} /></a>
        </aside>
      </div>

      <section className="merchant-rules" aria-label="商家须知正文">
        <article id="one-product"><span><LockKeyhole aria-hidden="true" size={20} /></span><div><p>01</p><h2>一店一单品</h2><p>审核中、待排期和秒杀进行中的商品不可保存、修改或下架。是否解锁只读取 Core 的 `allowedActions`。</p></div></article>
        <article id="fulfillment-rule"><span><PackageCheck aria-hidden="true" size={20} /></span><div><p>02</p><h2>提交真实履约证据</h2><p>禁止假单号和虚构核销。打印、物流和门店扫描必须关联真实设备或供应商证据。</p></div></article>
        <article id="takeover-rule"><span><Clock3 aria-hidden="true" size={20} /></span><div><p>03</p><h2>7 天未发货进入平台接管</h2><p>支付最终确认后 7 × 24 小时仍无有效发货证据，平台接管履约，并冻结新订单、商品上架和商家结算申请权限。</p></div></article>
        <article id="receipt-rule"><span><ShieldAlert aria-hidden="true" size={20} /></span><div><p>04</p><h2>商家不能直接确认签收</h2><p>物流送达满 7 天后仅可申请平台审核。核销、签收与仲裁达到最终性后，资产才可从 Locked 进入后续状态。</p></div></article>
      </section>
      <div className="compliance-callout"><CircleAlert aria-hidden="true" size={18} /><p>刷单、假履约或规避风控会进入平台责任处置。具体责任和金额必须以已发布政策及审计证据为准，本界面不自行推定。</p></div>
    </div>
  );
}
