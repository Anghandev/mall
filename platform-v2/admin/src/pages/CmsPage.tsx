import { cmsContentFormats, cmsContentTypes, type CmsVersionProjection } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, Image, KeyRound, Megaphone, Plus, RotateCcw, Search, Send } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { humanizeError, shortId } from '../display';
import { useCoreSession } from '../coreSession';
import { createCmsVersion, fetchCmsVersion, publishCmsVersion, rollbackCmsVersion } from '../settlementAdminApi';

type AudienceType = 'ALL' | 'REGION' | 'MERCHANT' | 'WALLET';

export function CmsPage() {
  const { connect, session, status } = useCoreSession();
  const [versionId, setVersionId] = useState('');
  const [current, setCurrent] = useState<CmsVersionProjection | null>(null);
  const [continueEntry, setContinueEntry] = useState(false);
  const [slug, setSlug] = useState('');
  const [placement, setPlacement] = useState('');
  const [locale, setLocale] = useState('zh-CN');
  const [contentType, setContentType] = useState<(typeof cmsContentTypes)[number]>('BANNER');
  const [contentFormat, setContentFormat] = useState<(typeof cmsContentFormats)[number]>('STRUCTURED_RICH_TEXT');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [imageAssetId, setImageAssetId] = useState('');
  const [imageAlt, setImageAlt] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [audienceType, setAudienceType] = useState<AudienceType>('ALL');
  const [audienceValues, setAudienceValues] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [frequencyCap, setFrequencyCap] = useState('');
  const [policyVersion, setPolicyVersion] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => newKey('cms'));
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canWrite = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;
  const content = useMemo(() => cmsDocument({ title, body, imageAssetId, imageAlt, linkLabel, linkUrl }), [title, body, imageAssetId, imageAlt, linkLabel, linkUrl]);
  const audience = useMemo(() => cmsAudience(audienceType, audienceValues), [audienceType, audienceValues]);

  const lookup = async (event: FormEvent) => {
    event.preventDefault(); if (!session || !canRead) return;
    await run(async () => { const result = await fetchCmsVersion(versionId, session.token); setCurrent(result); hydrate(result); setContinueEntry(true); });
  };
  const create = async (event: FormEvent) => {
    event.preventDefault(); if (!session || !canWrite) return;
    await run(async () => {
      const result = await createCmsVersion({
        ...(continueEntry && current ? { entryId: current.entryId } : {}),
        slug, contentType, placement, locale, contentFormat, content, audience,
        ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}),
        ...(endsAt ? { endsAt: new Date(endsAt).toISOString() } : {}),
        ...(frequencyCap ? { frequencyCap: Number(frequencyCap) } : {}),
        ...(policyVersion ? { policyVersion } : {}),
        idempotencyKey,
      }, session.token);
      setCurrent(result); setVersionId(result.versionId); setContinueEntry(true); setIdempotencyKey(newKey('cms'));
      setNotice(`内容版本已创建：${shortId(result.versionId)}`);
    });
  };
  const publish = () => run(async () => { if (!session || !current) return; const result = await publishCmsVersion(current.versionId, current.contentHash, session.token); setCurrent(result); setNotice(`内容版本 ${shortId(result.versionId)} 已发布`); });
  const rollback = () => run(async () => { if (!session || !current) return; const result = await rollbackCmsVersion(current.versionId, current.contentHash, session.token); setCurrent(result); setNotice(`内容版本 ${shortId(result.versionId)} 已回滚`); });
  const run = async (action: () => Promise<void>) => { setLoading(true); setError(null); setNotice(''); try { await action(); } catch (cause) { setError(asCoreError(cause)); } finally { setLoading(false); } };
  const hydrate = (value: CmsVersionProjection) => {
    setSlug(value.slug); setPlacement(value.placement); setLocale(value.locale); setContentType(value.contentType); setContentFormat(value.contentFormat);
    const extracted = extractContent(value.content); setTitle(extracted.title); setBody(extracted.body); setImageAssetId(extracted.imageAssetId); setImageAlt(extracted.imageAlt); setLinkLabel(extracted.linkLabel); setLinkUrl(extracted.linkUrl);
    const target = extractAudience(value.audience); setAudienceType(target.type); setAudienceValues(target.values);
    setStartsAt(toLocalDateTime(value.startsAt)); setEndsAt(toLocalDateTime(value.endsAt)); setFrequencyCap(value.frequencyCap === null ? '' : String(value.frequencyCap)); setPolicyVersion(value.policyVersion ?? '');
  };

  return <>
    <header className="page-header"><div className="page-icon"><Megaphone aria-hidden="true" /></div><div><p className="eyebrow">内容版本</p><h1>内容中心</h1><p>编辑横幅、弹窗、规则、常见问题、协议和公告的内容、排期、受众与预览。发布时使用系统内容校验编号。</p></div><div className="requirement-list"><code>内容发布</code><code>秒杀规则</code></div></header>
    <section className="workspace-grid"><article className="panel panel-main admin-resource-panel"><div className="panel-heading"><div><p className="section-kicker">内容管理</p><h2>版本编辑与核验</h2></div><span className={canRead ? 'status-chip status-ready' : 'status-chip status-blocked'}>{canRead ? <CheckCircle2 aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{session ? roleListLabel(session.roles) : '需要钱包登录'}</span></div>
      {!session ? <div className="session-prompt"><div><strong>连接平台钱包</strong><p>审核员只读；管理员和运营可创建、发布和回滚。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />钱包登录</button></div>
        : !canRead ? <ErrorView error={invalid('当前会话没有 CMS 权限')} />
          : <><form className="inline-query-form" onSubmit={lookup}><label>版本编号<input value={versionId} onChange={(event) => setVersionId(event.target.value)} required /></label><button className="button button-quiet" type="submit" disabled={loading || !versionId.trim()}><Search aria-hidden="true" />读取版本</button></form>{canWrite ? <form className="governed-form" onSubmit={create}>
            <fieldset><legend>内容身份与位置</legend><div className="form-grid"><label>页面标识<input value={slug} onChange={(event) => setSlug(event.target.value)} required /></label><label>位置<input value={placement} onChange={(event) => setPlacement(event.target.value)} required /></label><label>语言<input value={locale} onChange={(event) => setLocale(event.target.value)} required /></label><label>内容类型<select value={contentType} onChange={(event) => setContentType(event.target.value as typeof contentType)}>{cmsContentTypes.map((value) => <option key={value} value={value}>{contentTypeLabel(value)}</option>)}</select></label><label>内容格式<select value={contentFormat} onChange={(event) => setContentFormat(event.target.value as typeof contentFormat)}>{cmsContentFormats.map((value) => <option key={value} value={value}>{contentFormatLabel(value)}</option>)}</select></label>{current ? <label className="binary-field"><input type="checkbox" checked={continueEntry} onChange={(event) => setContinueEntry(event.target.checked)} />作为 {shortId(current.entryId)} 的新版本</label> : null}</div></fieldset>
            <fieldset><legend>正文与媒体</legend><div className="form-grid"><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>图片资源编号<input value={imageAssetId} onChange={(event) => setImageAssetId(event.target.value)} placeholder="上传后得到的资源编号" /></label><label>图片替代文本<input value={imageAlt} onChange={(event) => setImageAlt(event.target.value)} disabled={!imageAssetId} /></label><label>链接文字<input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} disabled={!linkUrl} /></label><label>链接地址<input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="/path 或 https://…" /></label></div><label>正文<textarea rows={6} value={body} onChange={(event) => setBody(event.target.value)} required /></label></fieldset>
            <fieldset><legend>受众与排期</legend><div className="form-grid"><label>受众类型<select value={audienceType} onChange={(event) => { setAudienceType(event.target.value as AudienceType); setAudienceValues(''); }}><option value="ALL">全部</option><option value="REGION">区域</option><option value="MERCHANT">商家</option><option value="WALLET">钱包</option></select></label><label>{audienceLabel(audienceType)}<textarea rows={3} value={audienceValues} onChange={(event) => setAudienceValues(event.target.value)} disabled={audienceType === 'ALL'} required={audienceType !== 'ALL'} /></label><label>开始时间（可选）<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label><label>结束时间（可选）<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label><label>频次上限（可选）<input inputMode="numeric" value={frequencyCap} onChange={(event) => setFrequencyCap(event.target.value)} /></label><label>秒杀规则编号（必填）<input inputMode="numeric" value={policyVersion} onChange={(event) => setPolicyVersion(event.target.value)} /></label></div></fieldset>
            <button className="button button-primary" type="submit" disabled={loading}><Plus aria-hidden="true" />创建内容版本</button>
          </form> : null}</>}
    </article><aside className="panel evidence-panel"><p className="section-kicker">预览与发布</p><h2>{title || current ? title || `${current!.slug} · v${current!.version}` : '内容预览'}</h2><div className="cms-preview" aria-label="内容预览">{imageAssetId ? <div className="cms-preview-media"><Image aria-hidden="true" /><span>已选择图片</span><small>{imageAlt || '缺少替代文本'}</small><details className="technical-details compact"><summary>图片编号</summary><code>{imageAssetId}</code></details></div> : null}{body ? <p>{body}</p> : <p className="muted-copy">填写正文后在此预览。</p>}{linkUrl ? <a href={safePreviewLink(linkUrl) ? linkUrl : undefined}>{linkLabel || linkUrl}</a> : null}</div>{current ? <><dl className="definition-grid"><div><dt>版本编号</dt><dd title={current.versionId}>{shortId(current.versionId)}</dd></div><div><dt>状态</dt><dd>{current.published ? publishStateLabel(current.publicationType) : '草稿'}</dd></div><div><dt>排期</dt><dd>{current.startsAt ?? '立即'} 至 {current.endsAt ?? '无结束时间'}</dd></div><div><dt>频次</dt><dd>{current.frequencyCap ?? '无限制'}</dd></div><div><dt>规则状态</dt><dd>{current.policyVersion ? '已绑定' : '未绑定'}</dd></div></dl><details className="technical-details compact"><summary>内容核验信息</summary><dl className="definition-grid"><div><dt>内容校验编号</dt><dd><code title={current.contentHash}>{shortId(current.contentHash)}</code></dd></div><div><dt>规则编号</dt><dd>{current.policyVersion ?? '未绑定'}</dd></div></dl></details></> : null}<button className="button button-primary button-full" type="button" onClick={() => void publish()} disabled={!canWrite || !current || loading}><Send aria-hidden="true" />发布版本</button><button className="button button-quiet button-full" type="button" onClick={() => void rollback()} disabled={!canWrite || !current || loading}><RotateCcw aria-hidden="true" />回滚到此版本</button><p className="button-explanation">发布和回滚使用当前内容的系统校验编号，不需要手工填写凭证。</p></aside></section>
    {error ? <ErrorView error={error} /> : null}{notice ? <p className="healthy-copy" role="status">{notice}</p> : null}
  </>;
}


function publishStateLabel(value: string | null) {
  if (!value) return '已发布';
  return ({
    PUBLISHED: '已发布',
    ROLLED_BACK: '已回滚',
    DRAFT: '草稿',
  } as Record<string, string>)[value] ?? value;
}
function cmsDocument(input: { title: string; body: string; imageAssetId: string; imageAlt: string; linkLabel: string; linkUrl: string }) {
  const children: Record<string, unknown>[] = [];
  if (input.title.trim()) children.push({ type: 'heading', level: 2, children: [{ type: 'text', text: input.title.trim(), marks: [] }] });
  for (const paragraph of input.body.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean)) children.push({ type: 'paragraph', children: [{ type: 'text', text: paragraph, marks: [] }] });
  if (input.imageAssetId.trim()) children.push({ type: 'image', assetId: input.imageAssetId.trim(), alt: input.imageAlt.trim() });
  if (input.linkUrl.trim()) children.push({ type: 'paragraph', children: [{ type: 'link', href: input.linkUrl.trim(), children: [{ type: 'text', text: input.linkLabel.trim() || input.linkUrl.trim(), marks: [] }] }] });
  return { type: 'doc', children };
}
function cmsAudience(type: AudienceType, raw: string) { const values = [...new Set(raw.split(/[\n,]/).map((value) => value.trim()).filter(Boolean))].sort(); if (type === 'REGION') return { type, regionCodes: values }; if (type === 'MERCHANT') return { type, merchantIds: values }; if (type === 'WALLET') return { type, wallets: values }; return { type: 'ALL' }; }
function audienceLabel(type: AudienceType) { if (type === 'REGION') return '六位区域代码（每行一个）'; if (type === 'MERCHANT') return '商家编号（每行一个）'; if (type === 'WALLET') return '钱包地址（每行一个）'; return '全部受众'; }
function roleListLabel(roles: readonly string[]) {
  return roles.map((role) => ({ ADMIN: '管理员', OPERATOR: '运营', AUDITOR: '审核员', MERCHANT: '商家' } as Record<string, string>)[role] ?? role).join(' / ');
}
function contentTypeLabel(value: string) {
  return ({
    BANNER: '横幅',
    MODAL: '弹窗',
    FAQ: '常见问题',
    AGREEMENT: '协议',
    ANNOUNCEMENT: '公告',
    SECKILL_RULES: '秒杀规则',
  } as Record<string, string>)[value] ?? value;
}
function contentFormatLabel(value: string) {
  return ({
    STRUCTURED_RICH_TEXT: '结构化正文',
    MARKDOWN: 'Markdown',
    PLAIN_TEXT: '纯文本',
    HTML: 'HTML',
  } as Record<string, string>)[value] ?? value;
}
function extractAudience(value: Record<string, unknown>): { type: AudienceType; values: string } { const type = ['ALL', 'REGION', 'MERCHANT', 'WALLET'].includes(String(value.type)) ? String(value.type) as AudienceType : 'ALL'; const entries = type === 'REGION' ? value.regionCodes : type === 'MERCHANT' ? value.merchantIds : type === 'WALLET' ? value.wallets : []; return { type, values: Array.isArray(entries) ? entries.join('\n') : '' }; }
function extractContent(value: Record<string, unknown>) { const nodes = flattenNodes(value); const heading = nodes.find((node) => node.type === 'heading'); const image = nodes.find((node) => node.type === 'image'); const link = nodes.find((node) => node.type === 'link'); const paragraphs = nodes.filter((node) => node.type === 'paragraph').map(nodeText).filter((text) => text && text !== nodeText(link ?? {})); return { title: heading ? nodeText(heading) : '', body: paragraphs.join('\n\n'), imageAssetId: String(image?.assetId ?? ''), imageAlt: String(image?.alt ?? ''), linkLabel: link ? nodeText(link) : '', linkUrl: String(link?.href ?? '') }; }
function flattenNodes(value: unknown): Record<string, unknown>[] { const node = record(value); return [node, ...(Array.isArray(node.children) ? node.children.flatMap(flattenNodes) : [])]; }
function nodeText(value: Record<string, unknown>): string { if (value.type === 'text') return String(value.text ?? ''); return Array.isArray(value.children) ? value.children.map((child) => nodeText(record(child))).join('') : ''; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function toLocalDateTime(value: string | null) { if (!value) return ''; const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function safePreviewLink(value: string) { return value.startsWith('/') && !value.startsWith('//') || value.startsWith('https://'); }
function newKey(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '内容服务暂时无法连接', status: 503 }); }
function ErrorView({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>; }
