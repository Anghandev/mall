import { useEffect, useState, type ReactNode } from 'react';
import type { CmsPublicItem, JsonObject } from '@abu24k/core-artifacts';
import { BookOpenCheck, ChevronRight, CircleAlert, Clock3, LockKeyhole, PackageCheck, ShieldAlert } from 'lucide-react';
import { EmptyState, LoadingRows, PageHeader } from '../components/ui';
import { readableError, useCoreRuntime } from '../core-runtime';

type RulesState =
  | { phase: 'loading' }
  | { phase: 'ready'; value: readonly CmsPublicItem[] }
  | { phase: 'error'; message: string };

export function HelpPage() {
  const { api, session } = useCoreRuntime();
  const [rulesState, setRulesState] = useState<RulesState>({ phase: 'loading' });

  useEffect(() => {
    let current = true;
    setRulesState({ phase: 'loading' });
    void api.listPublicCms(session?.token).then(
      (items) => {
        if (!current) return;
        setRulesState({
          phase: 'ready',
          value: items.filter((item) => item.contentType === 'SECKILL_RULES' && item.locale === 'zh-CN'),
        });
      },
      (error) => {
        if (current) setRulesState({ phase: 'error', message: readableError(error) });
      },
    );
    return () => { current = false; };
  }, [api, session?.token]);

  return (
    <div className="page-stack help-page">
      <PageHeader description="查看 Core 当前已发布的政策内容与商家履约边界。" eyebrow="07 / 规则对齐" title="帮助中心" />
      <div className="help-layout">
        <section className="section-block rules-section" aria-labelledby="rules-title">
          <div className="section-heading"><div><p className="eyebrow">Published policy</p><h2 id="rules-title">秒杀规则说明</h2></div><BookOpenCheck aria-hidden="true" size={20} /></div>
          {rulesState.phase === 'loading' ? <LoadingRows /> : rulesState.phase === 'error' ? (
            <EmptyState blocked description={rulesState.message} title="当前规则加载失败" />
          ) : rulesState.value.length ? rulesState.value.map((item) => (
            <article className="cms-rule-version" key={item.versionId}>
              <CmsRichText content={item.content} />
              <footer className="policy-footer">
                <span>{item.slug} / v{item.version}</span>
                <strong>Policy {item.policyVersion ?? 'UNBOUND'}</strong>
              </footer>
            </article>
          )) : (
            <EmptyState blocked description="Core 尚未发布适用于当前商家的 zh-CN 秒杀规则。" title="当前规则内容不可用" />
          )}
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
      <div className="compliance-callout"><CircleAlert aria-hidden="true" size={18} /><p>商家保证金最低 1,000 USDT。刷单、假履约或重大损失按保证金 → 冻结应收 → 未来货款的顺序处置；保证金不足或接管期间冻结新商品、新订单和商家结算申请。精确金额由 Core 证据投影。</p></div>
    </div>
  );
}

function CmsRichText({ content }: { content: JsonObject }) {
  const root = cmsNode(content);
  if (!root || root.type !== 'doc') {
    return <EmptyState blocked description="Core 返回的结构化内容无法识别。" title="规则格式错误" />;
  }
  return <div className="cms-rich-text">{root.children.map((child, index) => renderCmsNode(child, `cms-${index}`))}</div>;
}

interface CmsNode {
  type: string;
  text?: string;
  marks?: readonly string[];
  href?: string;
  assetId?: string;
  alt?: string;
  level?: number;
  children: readonly CmsNode[];
}

function cmsNode(input: unknown): CmsNode | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.type !== 'string') return undefined;
  const children = Array.isArray(value.children)
    ? value.children.map(cmsNode).filter((child): child is CmsNode => Boolean(child))
    : [];
  return {
    type: value.type,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(Array.isArray(value.marks) && value.marks.every((mark) => typeof mark === 'string')
      ? { marks: value.marks as string[] }
      : {}),
    ...(typeof value.href === 'string' ? { href: value.href } : {}),
    ...(typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
    ...(typeof value.alt === 'string' ? { alt: value.alt } : {}),
    ...(typeof value.level === 'number' ? { level: value.level } : {}),
    children,
  };
}

function renderCmsNode(node: CmsNode, key: string): ReactNode {
  const children = node.children.map((child, index) => renderCmsNode(child, `${key}-${index}`));
  if (node.type === 'text') return <CmsText key={key} marks={node.marks ?? []} text={node.text ?? ''} />;
  if (node.type === 'paragraph') return <p key={key}>{children}</p>;
  if (node.type === 'blockquote') return <blockquote key={key}>{children}</blockquote>;
  if (node.type === 'bulletList') return <ul key={key}>{children}</ul>;
  if (node.type === 'orderedList') return <ol key={key}>{children}</ol>;
  if (node.type === 'listItem') return <li key={key}>{children}</li>;
  if (node.type === 'heading') return <h3 key={key}>{children}</h3>;
  if (node.type === 'link' && node.href && safeCmsLink(node.href)) {
    return <a href={node.href} key={key} rel="noreferrer" target={node.href.startsWith('/') ? undefined : '_blank'}>{children}</a>;
  }
  if (node.type === 'image') return <p className="cms-image-reference" key={key}>{node.alt ?? '政策图像'} <small>{node.assetId}</small></p>;
  return null;
}

function CmsText({ text, marks }: { text: string; marks: readonly string[] }) {
  let value: ReactNode = text;
  if (marks.includes('code')) value = <code>{value}</code>;
  if (marks.includes('bold')) value = <strong>{value}</strong>;
  if (marks.includes('italic')) value = <em>{value}</em>;
  if (marks.includes('underline')) value = <u>{value}</u>;
  return value;
}

function safeCmsLink(value: string) {
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
