import {
  notificationCampaignTopics,
  notificationDeliveryStates,
  type NotificationCampaignProjection,
  type NotificationCampaignRequest,
  type NotificationInboxItem,
} from '@abu24k/core-artifacts';
import {
  Ban,
  Bell,
  CheckCircle2,
  Inbox,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import {
  createNotificationCampaign,
  fetchNotificationCampaigns,
  fetchNotifications,
  publishNotificationCampaign,
  retryNotificationCampaignDeliveries,
} from '../settlementAdminApi';

type AudienceType = 'ALL' | 'WALLET' | 'MERCHANT' | 'REGION';
type VariableRow = Readonly<{ id: number; key: string; value: string }>;

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const copyKeyPattern = /^[A-Z][A-Z0-9_]{2,95}$/;
const audienceLabels: Record<AudienceType, string> = {
  ALL: '全部用户',
  WALLET: '指定钱包',
  MERCHANT: '指定商家',
  REGION: '指定区域',
};
const deliveryLabels = {
  PENDING: '待发送',
  PROCESSING: '发送中',
  DELIVERED: '已送达',
  RETRY: '待重试',
  CONFIGURATION_REQUIRED: '缺少配置',
  DEAD_LETTER: '死信',
} as const;

let nextVariableId = 1;

export function NotificationsPage() {
  const { connect, session, status } = useCoreSession();
  const [items, setItems] = useState<readonly NotificationInboxItem[]>([]);
  const [campaigns, setCampaigns] = useState<readonly NotificationCampaignProjection[]>([]);
  const [topic, setTopic] = useState<(typeof notificationCampaignTopics)[number]>('ANNOUNCEMENT');
  const [audienceType, setAudienceType] = useState<AudienceType>('ALL');
  const [audienceLines, setAudienceLines] = useState('');
  const [titleKey, setTitleKey] = useState('CAMPAIGN_TITLE');
  const [bodyKey, setBodyKey] = useState('CAMPAIGN_BODY');
  const [variables, setVariables] = useState<readonly VariableRow[]>([]);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [evidenceHash, setEvidenceHash] = useState('');
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [loadingData, setLoadingData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const canReadCampaigns = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canWrite = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;
  const selectedCampaign = campaigns.find((campaign) => campaign.campaignId === selectedCampaignId) ?? null;
  const canPublish = canWrite && (selectedCampaign?.allowedActions.includes('PUBLISH') ?? false);
  const canRetry = canWrite && (selectedCampaign?.allowedActions.includes('RETRY_FAILED') ?? false);

  useEffect(() => {
    setItems([]);
    setCampaigns([]);
    setError(null);
    if (!session) return;
    const controller = new AbortController();
    setLoadingData(true);
    void Promise.all([
      fetchNotifications(session.token, 50, controller.signal),
      canReadCampaigns ? fetchNotificationCampaigns(session.token, 50, controller.signal) : Promise.resolve([]),
    ]).then(([nextItems, nextCampaigns]) => {
      setItems(nextItems);
      setCampaigns(nextCampaigns);
      setSelectedCampaignId((current) => nextCampaigns.some((campaign) => campaign.campaignId === current)
        ? current
        : nextCampaigns[0]?.campaignId ?? '');
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(asCoreError(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingData(false);
    });
    return () => controller.abort();
  }, [canReadCampaigns, reload, session]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canWrite) return;
    let input: NotificationCampaignRequest;
    try {
      input = buildCampaignRequest({
        topic,
        audienceType,
        audienceLines,
        titleKey,
        bodyKey,
        variables,
        startsAt,
        endsAt,
        idempotencyKey,
      });
    } catch (cause) {
      setError(invalid(cause instanceof Error ? cause.message : '通知活动表单无效'));
      return;
    }
    await run(async () => {
      const result = await createNotificationCampaign(input, session.token);
      setSelectedCampaignId(result.campaignId);
      setNotice(`Core 已创建活动 ${result.campaignId}，状态 ${result.state}`);
      setIdempotencyKey(createIdempotencyKey());
      setReload((value) => value + 1);
    });
  };

  const publish = () => run(async () => {
    if (!session || !selectedCampaign || !canPublish) return;
    const result = await publishNotificationCampaign(selectedCampaign.campaignId, evidenceHash, session.token);
    setNotice(`活动 ${result.campaignId} 已发布`);
    setEvidenceHash('');
    setReload((value) => value + 1);
  });

  const retry = () => run(async () => {
    if (!session || !selectedCampaign || !canRetry) return;
    const result = await retryNotificationCampaignDeliveries(selectedCampaign.campaignId, session.token);
    setNotice(`活动 ${result.campaignId} 已重排 ${result.retriedDeliveries} 条失败投递`);
    setReload((value) => value + 1);
  });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(asCoreError(cause));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <header className="page-header">
      <div className="page-icon"><Bell aria-hidden="true" /></div>
      <div>
        <p className="eyebrow">EVENT-DRIVEN DELIVERY</p>
        <h1>消息通知</h1>
        <p>查看真实投递状态，按 Core 受众快照创建、发布和重试活动。</p>
      </div>
      <div className="requirement-list"><code>ADM-NOTIFY-001 / 002</code></div>
    </header>

    <section className="panel notification-inbox-panel" aria-busy={loadingData}>
      <div className="panel-heading">
        <div><p className="section-kicker">GET /v2/notifications</p><h2>当前钱包收件箱</h2></div>
        {session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loadingData || busy}><RefreshCw aria-hidden="true" />刷新</button> : null}
      </div>
      {!session ? <div className="session-prompt">
        <div><strong>连接平台钱包</strong><p>收件箱按钱包和受众隔离，未连接时不请求 Core 数据。</p></div>
        <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />SIWE 连接</button>
      </div> : loadingData ? <LoadingState label="正在加载钱包收件箱" /> : items.length ? <div className="table-scroll">
        <table className="data-table notification-inbox-table">
          <thead><tr><th>消息</th><th>来源事件</th><th>Topic</th><th>Delivery</th><th>时间</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.messageId}><td><code>{item.messageId}</code></td><td>{item.sourceEventType}</td><td>{item.topic}</td><td><span className={`notification-delivery-state is-${item.deliveryState.toLowerCase()}`}>{deliveryLabels[item.deliveryState]}</span></td><td>{formatDateTime(item.createdAt)}</td></tr>)}</tbody>
        </table>
      </div> : <EmptyState icon="inbox" title="收件箱暂无消息" detail="Core 返回真实空收件箱，不会用本地示例消息替代。" />}
    </section>

    {session && canReadCampaigns ? <section className="notification-workspace">
      <article className="panel notification-campaign-panel" aria-busy={loadingData}>
        <div className="panel-heading">
          <div><p className="section-kicker">GET /v2/admin/notification-campaigns</p><h2>通知活动</h2></div>
          <span className="status-chip">{campaigns.length} 个活动</span>
        </div>
        {loadingData ? <LoadingState label="正在加载通知活动" /> : campaigns.length ? <div className="table-scroll">
          <table className="data-table notification-campaign-table">
            <thead><tr><th>活动</th><th>受众 / 时间</th><th>投递计数</th><th>Core allowedActions</th></tr></thead>
            <tbody>{campaigns.map((campaign) => <CampaignRow
              campaign={campaign}
              key={campaign.campaignId}
              selected={campaign.campaignId === selectedCampaignId}
              onSelect={setSelectedCampaignId}
            />)}</tbody>
          </table>
        </div> : <EmptyState icon="users" title="尚未创建通知活动" detail={canWrite ? '使用下方结构化表单创建第一个活动。' : 'AUDITOR 仅读，当前 Core 列表为空。'} />}

        {canWrite ? <form className="notification-create-form" onSubmit={create}>
          <div className="notification-form-heading"><div><p className="section-kicker">POST /v2/admin/notification-campaigns</p><h3>创建通知活动</h3></div><small>失败重试保留同一幂等键</small></div>
          <div className="notification-form-grid">
            <label>Topic<select value={topic} onChange={(event) => setTopic(event.target.value as typeof topic)}>{notificationCampaignTopics.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>受众类型<select value={audienceType} onChange={(event) => { setAudienceType(event.target.value as AudienceType); setAudienceLines(''); }}>{Object.entries(audienceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {audienceType !== 'ALL' ? <label className="notification-audience-lines">{audienceInputLabel(audienceType)}<textarea rows={4} value={audienceLines} onChange={(event) => setAudienceLines(event.target.value)} required spellCheck={false} placeholder={audiencePlaceholder(audienceType)} /><small>每行一个，空行将被忽略。</small></label> : <p className="notification-all-audience"><Users aria-hidden="true" /><span><strong>全部活跃端点</strong><small>收件人由 Core 在活动投递时生成快照。</small></span></p>}
            <label>标题 Key<input value={titleKey} onChange={(event) => setTitleKey(event.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9_]{2,95}" required /></label>
            <label>正文 Key<input value={bodyKey} onChange={(event) => setBodyKey(event.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9_]{2,95}" required /></label>
          </div>

          <fieldset className="notification-variables">
            <legend>消息变量 <small>最多 32 个</small></legend>
            {variables.map((variable, index) => <div className="notification-variable-row" key={variable.id}>
              <label>{`变量 ${index + 1} Key`}<input value={variable.key} onChange={(event) => setVariables((current) => current.map((item) => item.id === variable.id ? { ...item, key: event.target.value } : item))} required /></label>
              <label>{`变量 ${index + 1} Value`}<input value={variable.value} onChange={(event) => setVariables((current) => current.map((item) => item.id === variable.id ? { ...item, value: event.target.value } : item))} /></label>
              <button className="icon-button" type="button" aria-label={`删除变量 ${index + 1}`} onClick={() => setVariables((current) => current.filter((item) => item.id !== variable.id))}><Trash2 aria-hidden="true" /></button>
            </div>)}
            <button className="button button-quiet" type="button" onClick={() => setVariables((current) => current.length >= 32 ? current : [...current, { id: nextVariableId++, key: '', value: '' }])} disabled={variables.length >= 32}><Plus aria-hidden="true" />添加变量</button>
          </fieldset>

          <div className="notification-form-grid notification-schedule-grid">
            <label>开始时间（可选）<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
            <label>结束时间（可选）<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
            <label className="notification-idempotency">Idempotency key<input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} minLength={8} maxLength={128} pattern="[A-Za-z0-9:_-]{8,128}" required /></label>
          </div>
          <button className="button button-primary" type="submit" disabled={busy || loadingData || idempotencyKey.length < 8}><Plus aria-hidden="true" />创建活动</button>
        </form> : <p className="notification-readonly"><KeyRound aria-hidden="true" /><span><strong>AUDITOR 只读</strong><small>可查看活动、投递计数与 Core 动作目录，不可创建或变更。</small></span></p>}
      </article>

      <aside className="panel notification-action-panel">
        <p className="section-kicker">Campaign operations</p>
        <h2>活动操作</h2>
        {selectedCampaign ? <>
          <label>选择活动<select value={selectedCampaignId} onChange={(event) => setSelectedCampaignId(event.target.value)}>{campaigns.map((campaign) => <option key={campaign.campaignId} value={campaign.campaignId}>{campaign.topic} · {campaign.state} · {shortId(campaign.campaignId)}</option>)}</select></label>
          <dl className="notification-action-facts">
            <div><dt>状态</dt><dd>{selectedCampaign.state}</dd></div>
            <div><dt>Content hash</dt><dd><code>{selectedCampaign.contentHash}</code></dd></div>
            <div><dt>Core allowedActions</dt><dd>{selectedCampaign.allowedActions.length ? selectedCampaign.allowedActions.join(' / ') : '无'}</dd></div>
          </dl>
          <label>发布证据哈希（bytes32）<input value={evidenceHash} onChange={(event) => setEvidenceHash(event.target.value)} disabled={!canPublish || busy} aria-describedby="notification-evidence-help" /></label>
          <button className="button button-primary button-full" type="button" onClick={() => void publish()} disabled={!canPublish || !bytes32Pattern.test(evidenceHash) || busy || loadingData}><Send aria-hidden="true" />发布活动</button>
          <button className="button button-quiet button-full" type="button" onClick={() => void retry()} disabled={!canRetry || busy || loadingData}><RotateCcw aria-hidden="true" />重试失败投递</button>
          <p className="button-explanation" id="notification-evidence-help">按钮同时依赖当前角色与 Core `allowedActions`，页面不根据状态自行推断权限。</p>
        </> : <EmptyState icon="users" title="未选择活动" detail="创建或选择活动后，才能查看 Core 动作目录。" />}
        <p className="notification-provider-note"><Ban aria-hidden="true" /><span><strong>供应商证据不伪造</strong><small>SMS、SMTP 或 Push 缺少生产配置时，Core 保留 `CONFIGURATION_REQUIRED`，页面不显示伪成功。</small></span></p>
      </aside>
    </section> : null}

    {error ? <div className={`resource-state resource-state-error notification-error${error.code === 'ConfigurationRequired' ? ' is-configuration' : ''}`} role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p>{error.correlationId ? <small>Correlation {error.correlationId}</small> : null}</div></div> : null}
    {notice ? <p className="healthy-copy notification-notice" role="status"><CheckCircle2 aria-hidden="true" />{notice}</p> : null}
  </>;
}

function CampaignRow({ campaign, selected, onSelect }: Readonly<{ campaign: NotificationCampaignProjection; selected: boolean; onSelect: (campaignId: string) => void }>) {
  return <tr className={selected ? 'is-selected' : undefined}>
    <td><button className="table-link" type="button" onClick={() => onSelect(campaign.campaignId)}>{campaign.topic}</button><code>{campaign.campaignId}</code><span className={`notification-campaign-state is-${campaign.state.toLowerCase()}`}>{campaign.state}</span><small>{messageSummary(campaign)}</small></td>
    <td><strong>{audienceSummary(campaign)}</strong><small>{scheduleSummary(campaign)}</small></td>
    <td><div className="notification-delivery-counts">{notificationDeliveryStates.map((state) => <span className={`is-${state.toLowerCase()}`} key={state}><small>{deliveryLabels[state]}</small><strong>{campaign.deliveryCounts[state]}</strong></span>)}</div></td>
    <td><div className="notification-allowed-actions">{campaign.allowedActions.length ? campaign.allowedActions.map((action) => <code key={action}>{action}</code>) : <span>无可用操作</span>}</div></td>
  </tr>;
}

function LoadingState({ label }: Readonly<{ label: string }>) {
  return <div className="notification-loading" role="status"><RefreshCw aria-hidden="true" /><strong>{label}</strong><span /><span /></div>;
}

function EmptyState({ icon, title, detail }: Readonly<{ icon: 'inbox' | 'users'; title: string; detail: string }>) {
  const Icon = icon === 'inbox' ? Inbox : Users;
  return <div className="notification-empty"><Icon aria-hidden="true" /><h3>{title}</h3><p>{detail}</p></div>;
}

function buildCampaignRequest(input: Readonly<{
  topic: (typeof notificationCampaignTopics)[number];
  audienceType: AudienceType;
  audienceLines: string;
  titleKey: string;
  bodyKey: string;
  variables: readonly VariableRow[];
  startsAt: string;
  endsAt: string;
  idempotencyKey: string;
}>): NotificationCampaignRequest {
  if (!copyKeyPattern.test(input.titleKey) || !copyKeyPattern.test(input.bodyKey)) throw new Error('标题 Key 与正文 Key 必须为 3-96 位大写字母、数字或下划线');
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)) throw new Error('Idempotency key 必须为 8-128 位字母、数字或 : _ -');
  const variables: Record<string, string> = {};
  for (const variable of input.variables) {
    const key = variable.key.trim();
    if (!key) throw new Error('消息变量 Key 不能为空');
    if (Object.hasOwn(variables, key)) throw new Error(`消息变量 Key 重复：${key}`);
    variables[key] = variable.value;
  }
  const startsAt = optionalIso(input.startsAt);
  const endsAt = optionalIso(input.endsAt);
  if (endsAt && (!startsAt || Date.parse(endsAt) <= Date.parse(startsAt))) throw new Error('结束时间必须晚于开始时间');
  return {
    topic: input.topic,
    audience: buildAudience(input.audienceType, input.audienceLines),
    message: { titleKey: input.titleKey, bodyKey: input.bodyKey, variables },
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    idempotencyKey: input.idempotencyKey,
  };
}

function buildAudience(type: AudienceType, rawLines: string) {
  if (type === 'ALL') return { type };
  const values = [...new Set(rawLines.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  if (!values.length) throw new Error(`${audienceLabels[type]} 至少需要一个值`);
  if (type === 'WALLET') {
    if (!values.every((value) => /^0x[0-9a-fA-F]{40}$/.test(value))) throw new Error('钱包地址必须是 40 位十六进制 EVM 地址');
    return { type, wallets: values.map((value) => value.toLowerCase()) };
  }
  if (type === 'MERCHANT') {
    if (!values.every((value) => /^[A-Za-z0-9:_-]{3,128}$/.test(value))) throw new Error('商家 ID 格式无效');
    return { type, merchantIds: values };
  }
  if (!values.every((value) => /^\d{6}$/.test(value))) throw new Error('区域必须是六位行政区划代码');
  return { type, regionCodes: values };
}

function audienceInputLabel(type: Exclude<AudienceType, 'ALL'>) {
  return type === 'WALLET' ? '钱包地址（每行一个）' : type === 'MERCHANT' ? '商家 ID（每行一个）' : '六位区域代码（每行一个）';
}

function audiencePlaceholder(type: Exclude<AudienceType, 'ALL'>) {
  return type === 'WALLET' ? '0x...' : type === 'MERCHANT' ? 'merchant-001' : '210202';
}

function audienceSummary(campaign: NotificationCampaignProjection) {
  const audience = campaign.audience;
  if (audience.type === 'ALL') return '全部活跃端点';
  if (audience.type === 'WALLET' && Array.isArray(audience.wallets)) return `${audience.wallets.length} 个钱包`;
  if (audience.type === 'MERCHANT' && Array.isArray(audience.merchantIds)) return `${audience.merchantIds.length} 个商家`;
  if (audience.type === 'REGION' && Array.isArray(audience.regionCodes)) return `${audience.regionCodes.length} 个区域`;
  return '受众快照';
}

function messageSummary(campaign: NotificationCampaignProjection) {
  const titleKey = typeof campaign.message.titleKey === 'string' ? campaign.message.titleKey : '未知标题';
  const bodyKey = typeof campaign.message.bodyKey === 'string' ? campaign.message.bodyKey : '未知正文';
  return `${titleKey} / ${bodyKey}`;
}

function scheduleSummary(campaign: NotificationCampaignProjection) {
  if (!campaign.startsAt && !campaign.endsAt) return '立即生效，无结束时间';
  return `${campaign.startsAt ? formatDateTime(campaign.startsAt) : '立即'} - ${campaign.endsAt ? formatDateTime(campaign.endsAt) : '持续'}`;
}

function optionalIso(value: string) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('通知活动时间无效');
  return new Date(timestamp).toISOString();
}

function createIdempotencyKey() {
  return `notification:${Date.now().toString(36)}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value));
}

function shortId(value: string) {
  return value.length <= 18 ? value : `${value.slice(0, 9)}...${value.slice(-6)}`;
}

function invalid(message: string) {
  return new CoreApiError({ code: 'InvalidRequest', message, status: 400 });
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError({ code: 'ExternalBlocked', message: '通知 Core 能力不可用', status: 503 });
}
