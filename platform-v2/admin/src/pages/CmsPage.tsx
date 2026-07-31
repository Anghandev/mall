import { cmsContentFormats, cmsContentTypes, type CmsVersionProjection } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, Image, KeyRound, Megaphone, Plus, RotateCcw, Search, Send, Sparkles } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CoreApiError } from '../coreApi';
import { humanizeError, shortId } from '../display';
import { useCoreSession } from '../coreSession';
import { createCmsVersion, fetchCmsVersion, publishCmsVersion, rollbackCmsVersion } from '../settlementAdminApi';

type AudienceType = 'ALL' | 'REGION' | 'MERCHANT' | 'WALLET';
type CmsContentType = (typeof cmsContentTypes)[number];
type CmsContentFormat = (typeof cmsContentFormats)[number];
type ContentPresetId = 'SECKILL_RULES' | 'SECKILL_BANNER' | 'ANNOUNCEMENT' | 'FAQ' | 'AGREEMENT';

type ContentPreset = Readonly<{
  id: ContentPresetId;
  title: string;
  description: string;
  slug: string;
  placement: string;
  contentType: CmsContentType;
  contentFormat: CmsContentFormat;
  defaultTitle: string;
  defaultBody: string;
  linkUrl: string;
  linkLabel: string;
}>;

const contentPresets: readonly ContentPreset[] = [
  {
    id: 'SECKILL_RULES',
    title: '秒杀规则',
    description: '商城秒杀页展示的规则说明。发布后，秒杀活动页会自动读取最新版。',
    slug: 'seckill-rules-main',
    placement: 'mall.seckill.rules',
    contentType: 'SECKILL_RULES',
    contentFormat: 'STRUCTURED_RICH_TEXT',
    defaultTitle: '秒杀活动规则',
    defaultBody: '1. 秒杀主场 60 分钟，成功购买后接力时间增加 30 秒。\n\n2. 最终是否秒杀成功，以系统确认的链上付款时间为准。\n\n3. 活动结束后，系统按规则确认中奖和发奖进度。',
    linkUrl: '/mall/seckill',
    linkLabel: '查看秒杀活动',
  },
  {
    id: 'SECKILL_BANNER',
    title: '秒杀横幅',
    description: '商城秒杀页的活动文案或引导。',
    slug: 'seckill-banner-main',
    placement: 'mall.seckill.banner',
    contentType: 'BANNER',
    contentFormat: 'STRUCTURED_RICH_TEXT',
    defaultTitle: '限时秒杀开启',
    defaultBody: '查看当前活动商品，准备好钱包后即可参与。',
    linkUrl: '/mall/seckill',
    linkLabel: '去秒杀',
  },
  {
    id: 'ANNOUNCEMENT',
    title: '公告',
    description: '面向所有用户的普通公告。',
    slug: 'mall-announcement-main',
    placement: 'mall.notice.main',
    contentType: 'RELEASE_ANNOUNCEMENT',
    contentFormat: 'STRUCTURED_RICH_TEXT',
    defaultTitle: '平台公告',
    defaultBody: '请填写公告内容。',
    linkUrl: '',
    linkLabel: '',
  },
  {
    id: 'FAQ',
    title: '常见问题',
    description: '帮助中心或活动说明里的问答内容。',
    slug: 'mall-faq-main',
    placement: 'mall.help.faq',
    contentType: 'FAQ',
    contentFormat: 'STRUCTURED_RICH_TEXT',
    defaultTitle: '常见问题',
    defaultBody: '请填写问题和答案。',
    linkUrl: '',
    linkLabel: '',
  },
  {
    id: 'AGREEMENT',
    title: '协议',
    description: '服务协议、隐私协议等正式文本。',
    slug: 'service-agreement-main',
    placement: 'mall.agreement.service',
    contentType: 'SERVICE_AGREEMENT',
    contentFormat: 'STRUCTURED_RICH_TEXT',
    defaultTitle: '服务协议',
    defaultBody: '请填写协议正文。',
    linkUrl: '',
    linkLabel: '',
  },
] as const;

const defaultPreset = contentPresets[0]!;

export function CmsPage() {
  const { connect, session, status } = useCoreSession();
  const [versionId, setVersionId] = useState('');
  const [current, setCurrent] = useState<CmsVersionProjection | null>(null);
  const [continueEntry, setContinueEntry] = useState(false);
  const [presetId, setPresetId] = useState<ContentPresetId>(defaultPreset.id);
  const [slug, setSlug] = useState(defaultPreset.slug);
  const [placement, setPlacement] = useState(defaultPreset.placement);
  const [locale, setLocale] = useState('zh-CN');
  const [contentType, setContentType] = useState<CmsContentType>(defaultPreset.contentType);
  const [contentFormat, setContentFormat] = useState<CmsContentFormat>(defaultPreset.contentFormat);
  const [title, setTitle] = useState(defaultPreset.defaultTitle);
  const [body, setBody] = useState(defaultPreset.defaultBody);
  const [imageAssetId, setImageAssetId] = useState('');
  const [imageAlt, setImageAlt] = useState('');
  const [linkLabel, setLinkLabel] = useState(defaultPreset.linkLabel);
  const [linkUrl, setLinkUrl] = useState(defaultPreset.linkUrl);
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
  const preset = contentPresets.find((item) => item.id === presetId) ?? defaultPreset;
  const currentIsSeckillRules = current?.contentType === 'SECKILL_RULES';
  const currentReadyForSeckill = Boolean(current?.published && current.policyVersion && current.contentType === 'SECKILL_RULES');

  const lookup = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canRead) return;
    await run(async () => {
      const result = await fetchCmsVersion(versionId, session.token);
      setCurrent(result);
      hydrate(result);
      setContinueEntry(true);
    });
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canWrite) return;
    await run(async () => {
      const result = await createCmsVersion({
        ...(continueEntry && current ? { entryId: current.entryId } : {}),
        slug,
        contentType,
        placement,
        locale,
        contentFormat,
        content,
        audience,
        ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}),
        ...(endsAt ? { endsAt: new Date(endsAt).toISOString() } : {}),
        ...(frequencyCap ? { frequencyCap: Number(frequencyCap) } : {}),
        ...(policyVersion ? { policyVersion } : {}),
        idempotencyKey,
      }, session.token);
      setCurrent(result);
      setVersionId(result.versionId);
      setContinueEntry(true);
      setIdempotencyKey(newKey('cms'));
      setNotice(`草稿已保存：${shortId(result.versionId)}。确认无误后点右侧发布。`);
    });
  };

  const publish = () => run(async () => {
    if (!session || !current) return;
    if (current.contentType === 'SECKILL_RULES' && !current.policyVersion) {
      throw invalid('秒杀规则发布前必须绑定资金规则版本。去“规则治理”页读取当前资金规则版本，不要自己编。');
    }
    const result = await publishCmsVersion(current.versionId, current.contentHash, session.token);
    setCurrent(result);
    setNotice(result.contentType === 'SECKILL_RULES'
      ? '秒杀规则已发布，秒杀活动页会自动读取最新版。'
      : `内容版本 ${shortId(result.versionId)} 已发布。`);
  });

  const rollback = () => run(async () => {
    if (!session || !current) return;
    if (current.published) throw invalid('这个版本已经是当前发布内容，不需要恢复。请先读取一个历史版本，再点恢复。');
    const result = await rollbackCmsVersion(current.versionId, current.contentHash, session.token);
    setCurrent(result);
    setNotice(`已恢复到历史版本 ${shortId(result.versionId)}。`);
  });

  const run = async (action: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    setNotice('');
    try { await action(); }
    catch (cause) { setError(asCoreError(cause)); }
    finally { setLoading(false); }
  };

  const hydrate = (value: CmsVersionProjection) => {
    const matchedPreset = contentPresets.find((item) => item.contentType === value.contentType && item.placement === value.placement)
      ?? contentPresets.find((item) => item.contentType === value.contentType)
      ?? defaultPreset;
    setPresetId(matchedPreset.id);
    setSlug(value.slug);
    setPlacement(value.placement);
    setLocale(value.locale);
    setContentType(value.contentType);
    setContentFormat(value.contentFormat);
    const extracted = extractContent(value.content);
    setTitle(extracted.title);
    setBody(extracted.body);
    setImageAssetId(extracted.imageAssetId);
    setImageAlt(extracted.imageAlt);
    setLinkLabel(extracted.linkLabel);
    setLinkUrl(extracted.linkUrl);
    const target = extractAudience(value.audience);
    setAudienceType(target.type);
    setAudienceValues(target.values);
    setStartsAt(toLocalDateTime(value.startsAt));
    setEndsAt(toLocalDateTime(value.endsAt));
    setFrequencyCap(value.frequencyCap === null ? '' : String(value.frequencyCap));
    setPolicyVersion(value.policyVersion ?? '');
  };

  const applyPreset = (nextId: ContentPresetId) => {
    const next = contentPresets.find((item) => item.id === nextId) ?? defaultPreset;
    setPresetId(next.id);
    setSlug(next.slug);
    setPlacement(next.placement);
    setLocale('zh-CN');
    setContentType(next.contentType);
    setContentFormat(next.contentFormat);
    setTitle(next.defaultTitle);
    setBody(next.defaultBody);
    setLinkUrl(next.linkUrl);
    setLinkLabel(next.linkLabel);
    setAudienceType('ALL');
    setAudienceValues('');
  };

  return <>
    <header className="page-header">
      <div className="page-icon"><Megaphone aria-hidden="true" /></div>
      <div><p className="eyebrow">内容发布</p><h1>内容中心</h1><p>选用途、填标题正文、保存草稿、发布。技术编号默认收起来，秒杀活动页会自动读取已发布规则。</p></div>
      <div className="requirement-list"><code>内容发布</code><code>秒杀规则</code></div>
    </header>
    <section className="workspace-grid">
      <article className="panel panel-main admin-resource-panel">
        <div className="panel-heading"><div><p className="section-kicker">傻瓜式发布</p><h2>创建内容</h2></div><span className={canRead ? 'status-chip status-ready' : 'status-chip status-blocked'}>{canRead ? <CheckCircle2 aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{session ? roleListLabel(session.roles) : '需要钱包登录'}</span></div>
        {!session ? <div className="session-prompt"><div><strong>连接平台钱包</strong><p>审核员只读；管理员和运营可创建、发布和回滚。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />钱包登录</button></div>
          : !canRead ? <ErrorView error={invalid('当前会话没有内容中心权限')} />
            : <>
              <form className="inline-query-form" onSubmit={lookup}>
                <label>读取历史内容版本（可选）<input value={versionId} onChange={(event) => setVersionId(event.target.value)} placeholder="粘贴系统生成的版本编号" required /></label>
                <button className="button button-quiet" type="submit" disabled={loading || !versionId.trim()}><Search aria-hidden="true" />读取</button>
              </form>
              {canWrite ? <form className="governed-form" onSubmit={create}>
                <fieldset>
                  <legend>第 1 步：选择用途</legend>
                  <div className="form-grid">
                    <label>我要发布什么<select value={presetId} onChange={(event) => applyPreset(event.target.value as ContentPresetId)}>{contentPresets.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><small>{preset.description}</small></label>
                    {current ? <label className="binary-field"><input type="checkbox" checked={continueEntry} onChange={(event) => setContinueEntry(event.target.checked)} />作为当前内容的新版本</label> : null}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>第 2 步：填写给用户看的内容</legend>
                  <div className="form-grid"><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={preset.defaultTitle} /></label><label>图片（可选，先不填也能发布）<input value={imageAssetId} onChange={(event) => setImageAssetId(event.target.value)} placeholder="高级图片编号，可先留空" /></label><label>图片说明<input value={imageAlt} onChange={(event) => setImageAlt(event.target.value)} disabled={!imageAssetId} /></label><label>跳转链接（可选）<input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="/mall/seckill 或 https://…" /></label><label>链接按钮文字<input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} disabled={!linkUrl} /></label></div>
                  <label>正文<textarea rows={7} value={body} onChange={(event) => setBody(event.target.value)} required /></label>
                </fieldset>
                <details className="technical-details">
                  <summary>高级信息（系统已自动填写，通常不用改）</summary>
                  <fieldset><legend>页面和展示位置</legend><div className="form-grid"><label>页面标识<input value={slug} onChange={(event) => setSlug(event.target.value)} required /></label><label>展示位置<input value={placement} onChange={(event) => setPlacement(event.target.value)} required /></label><label>语言<input value={locale} onChange={(event) => setLocale(event.target.value)} required /></label><label>内容类型<select value={contentType} onChange={(event) => setContentType(event.target.value as CmsContentType)}>{cmsContentTypes.map((value) => <option key={value} value={value}>{contentTypeLabel(value)}</option>)}</select></label><label>内容格式<select value={contentFormat} onChange={(event) => setContentFormat(event.target.value as CmsContentFormat)}>{cmsContentFormats.map((value) => <option key={value} value={value}>{contentFormatLabel(value)}</option>)}</select></label></div></fieldset>
                  <fieldset><legend>受众和排期</legend><div className="form-grid"><label>给谁看<select value={audienceType} onChange={(event) => { setAudienceType(event.target.value as AudienceType); setAudienceValues(''); }}><option value="ALL">全部用户</option><option value="REGION">指定区域</option><option value="MERCHANT">指定商家</option><option value="WALLET">指定钱包</option></select></label><label>{audienceLabel(audienceType)}<textarea rows={3} value={audienceValues} onChange={(event) => setAudienceValues(event.target.value)} disabled={audienceType === 'ALL'} required={audienceType !== 'ALL'} /></label><label>开始时间（可选）<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label><label>结束时间（可选）<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label><label>频次上限（可选）<input inputMode="numeric" value={frequencyCap} onChange={(event) => setFrequencyCap(event.target.value)} /></label><label>资金规则版本号（秒杀规则发布前需要）<input inputMode="numeric" value={policyVersion} onChange={(event) => setPolicyVersion(event.target.value)} placeholder="不是自己编，从规则治理页读取" /><small>普通公告不用填；秒杀规则发布时系统会核对。</small></label></div></fieldset>
                </details>
                <button className="button button-primary" type="submit" disabled={loading}><Plus aria-hidden="true" />保存草稿</button>
              </form> : null}
            </>}
      </article>
      <aside className="panel evidence-panel"><p className="section-kicker">第 3 步：预览和发布</p><h2>{title || current ? title || `${current!.slug} · v${current!.version}` : '内容预览'}</h2><div className="cms-preview" aria-label="内容预览">{imageAssetId ? <div className="cms-preview-media"><Image aria-hidden="true" /><span>已选择图片</span><small>{imageAlt || '缺少图片说明'}</small><details className="technical-details compact"><summary>图片编号</summary><code>{imageAssetId}</code></details></div> : null}{body ? <p>{body}</p> : <p className="muted-copy">填写正文后在此预览。</p>}{linkUrl ? <a href={safePreviewLink(linkUrl) ? linkUrl : undefined}>{linkLabel || linkUrl}</a> : null}</div>{current ? <><dl className="definition-grid"><div><dt>系统版本</dt><dd title={current.versionId}>{shortId(current.versionId)}</dd></div><div><dt>状态</dt><dd>{current.published ? publishStateLabel(current.publicationType) : '草稿/历史版本'}</dd></div><div><dt>排期</dt><dd>{current.startsAt ?? '立即'} 至 {current.endsAt ?? '无结束时间'}</dd></div><div><dt>规则绑定</dt><dd>{current.policyVersion ? `已绑定 ${current.policyVersion}` : currentIsSeckillRules ? '发布前需要绑定资金规则' : '不需要'}</dd></div></dl>{currentReadyForSeckill ? <p className="healthy-copy" role="status"><Sparkles aria-hidden="true" />秒杀活动页会自动读取这条规则。</p> : null}<details className="technical-details compact"><summary>内容核验信息</summary><dl className="definition-grid"><div><dt>内容校验编号</dt><dd><code title={current.contentHash}>{shortId(current.contentHash)}</code></dd></div><div><dt>规则版本</dt><dd>{current.policyVersion ?? '未绑定'}</dd></div></dl></details></> : <p className="muted-copy">先保存草稿，再发布到商城。</p>}<button className="button button-primary button-full" type="button" onClick={() => void publish()} disabled={!canWrite || !current || loading}><Send aria-hidden="true" />发布到商城</button><Link className="button button-quiet button-full" to="/seckill">去创建秒杀活动</Link><button className="button button-quiet button-full" type="button" onClick={() => void rollback()} disabled={!canWrite || !current || current.published || loading}><RotateCcw aria-hidden="true" />恢复到这个历史版本</button><p className="button-explanation">{current?.published ? '当前已经是正在展示的版本；要恢复旧内容，先在左侧读取历史版本编号。' : '发布成功后，商城和秒杀活动页读取系统确认结果，不需要手工改页面。'}</p></aside>
    </section>
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
    RECOMMENDATION: '推荐内容',
    SPLASH: '启动页',
    CAMPAIGN_POPUP: '活动弹窗',
    FAQ: '常见问题',
    SERVICE_AGREEMENT: '服务协议',
    PRIVACY: '隐私协议',
    ABOUT: '关于我们',
    RELEASE_ANNOUNCEMENT: '发布公告',
    UPDATE_NOTICE: '更新通知',
    CONTRACT_NOTICE: '合约通知',
    SECKILL_RULES: '秒杀规则',
  } as Record<string, string>)[value] ?? value;
}
function contentFormatLabel(value: string) {
  return ({
    STRUCTURED_RICH_TEXT: '结构化正文',
    STRUCTURED_CAMPAIGN: '结构化活动',
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
