import {
  adminResourceTypes,
  artifactVersion,
  type AdminBatchAction,
  type AdminExportFormat,
  type AdminGlobalSearchResponse,
  type AdminProductBatchTagResult,
  type AdminProductLifecycleBatchResult,
  type AdminResourceSummary,
  type AdminResourceType,
  type CatalogTag,
  type CatalogReviewDecision,
} from '@abu24k/core-artifacts';
import {
  AlertTriangle,
  Archive,
  Ban,
  CalendarDays,
  Check,
  ClipboardCheck,
  Download,
  EyeOff,
  FileSpreadsheet,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Search,
  SearchCheck,
  Send,
  ShieldCheck,
  Tags,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  batchAddAdminProductTags,
  batchApplyAdminProductLifecycle,
  downloadAdminResourceExport,
  exportAdminGlobalResources,
  searchAdminGlobalResources,
  type AdminGlobalSearchFilters,
} from '../adminGlobalOperationsApi';
import { fetchAdminCatalogTags } from '../catalogAdminApi';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';

const quickRanges = ['今日', '昨日', '近 7 天', '近 30 天'] as const;
type QuickRange = (typeof quickRanges)[number];
type PendingReviewFilter = '' | 'true' | 'false';
const reasonCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/;
const lifecycleActions = [
  { action: 'APPROVE', capability: 'APPROVE_PRODUCTS', label: '审核通过', Icon: Check },
  { action: 'REJECT', capability: 'REJECT_PRODUCTS', label: '审核驳回', Icon: XCircle },
  { action: 'PUBLISH', capability: 'PUBLISH_PRODUCTS', label: '发布商品', Icon: Send },
  { action: 'HIDE', capability: 'HIDE_PRODUCTS', label: '隐藏商品', Icon: EyeOff },
  { action: 'DELIST', capability: 'DELIST_PRODUCTS', label: '下架商品', Icon: Archive },
] as const satisfies readonly { action: CatalogReviewDecision; capability: AdminBatchAction; label: string; Icon: typeof Check }[];

type SearchForm = {
  resourceTypes: AdminResourceType[];
  relation: 'AND' | 'OR';
  orderId: string;
  productId: string;
  merchantId: string;
  txHash: string;
  wallet: string;
  walletMatch: 'EXACT' | 'FUZZY';
  from: string;
  to: string;
  pendingReview: PendingReviewFilter;
};

const emptySearchForm: SearchForm = {
  resourceTypes: [...adminResourceTypes],
  relation: 'AND',
  orderId: '',
  productId: '',
  merchantId: '',
  txHash: '',
  wallet: '',
  walletMatch: 'EXACT',
  from: '',
  to: '',
  pendingReview: '',
};

export function GlobalOperationsPage() {
  const { connect, error: sessionError, session, status } = useCoreSession();
  const [response, setResponse] = useState<AdminGlobalSearchResponse | null>(null);
  const [activeFilters, setActiveFilters] = useState<AdminGlobalSearchFilters | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [tags, setTags] = useState<readonly CatalogTag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsError, setTagsError] = useState<CoreApiError | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<CoreApiError | null>(null);
  const [operationError, setOperationError] = useState<CoreApiError | null>(null);
  const [operationNotice, setOperationNotice] = useState('');
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const [exportIdempotencyKey, setExportIdempotencyKey] = useState(() => operationKey('global-export'));
  const [tagIdempotencyKey, setTagIdempotencyKey] = useState(() => operationKey('global-tags'));
  const [selectedTagIds, setSelectedTagIds] = useState<readonly string[]>([]);
  const [tagResult, setTagResult] = useState<AdminProductBatchTagResult | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<CatalogReviewDecision | null>(null);
  const [lifecycleReasonCode, setLifecycleReasonCode] = useState('');
  const [lifecycleIdempotencyKey, setLifecycleIdempotencyKey] = useState(() => operationKey('global-lifecycle'));
  const [lifecycleResult, setLifecycleResult] = useState<AdminProductLifecycleBatchResult | null>(null);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canWrite = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;

  useEffect(() => {
    setResponse(null);
    setActiveFilters(null);
    setSelectedKeys(new Set());
    setSearchError(null);
    setOperationError(null);
    setOperationNotice('');
    setTagResult(null);
    setLifecycleAction(null);
    setLifecycleReasonCode('');
    setLifecycleResult(null);
  }, [session?.token]);

  useEffect(() => {
    setTags([]);
    setTagsError(null);
    if (!session || !canWrite) return;
    const controller = new AbortController();
    setTagsLoading(true);
    void fetchAdminCatalogTags(session.token, controller.signal)
      .then(setTags)
      .catch((cause) => {
        if (!controller.signal.aborted) setTagsError(asCoreError(cause, 'Catalog 标签库不可用'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setTagsLoading(false);
      });
    return () => controller.abort();
  }, [canWrite, session]);

  const selectedResources = useMemo(
    () => response?.resources.filter((resource) => selectedKeys.has(resourceKey(resource))) ?? [],
    [response, selectedKeys],
  );
  const enabledTags = tags.filter((tag) => tag.status === 'ENABLED');
  const canExportCsv = hasCapabilityForEvery(selectedResources, 'EXPORT_CSV');
  const canExportExcel = hasCapabilityForEvery(selectedResources, 'EXPORT_EXCEL');
  const allProducts = selectedResources.length > 0 && selectedResources.every((resource) => resource.resourceType === 'PRODUCT');
  const canAddTags = canWrite && allProducts && hasCapabilityForEvery(selectedResources, 'ADD_PRODUCT_TAGS');

  const changeSelection = (value: ReadonlySet<string>) => {
    setSelectedKeys(value);
    if (lifecycleAction) {
      setLifecycleReasonCode('');
      setLifecycleIdempotencyKey(operationKey('global-lifecycle'));
    }
    setLifecycleAction(null);
    setOperationError(null);
  };

  const runSearch = async (filters: AdminGlobalSearchFilters) => {
    if (!session || !canRead) return;
    setSearching(true);
    setSearchError(null);
    setOperationError(null);
    setOperationNotice('');
    setSelectedKeys(new Set());
    try {
      const next = await searchAdminGlobalResources(filters, session.token);
      setResponse(next);
      setActiveFilters(filters);
    } catch (cause) {
      setResponse(null);
      setSearchError(asCoreError(cause, '全局资源检索不可用'));
    } finally {
      setSearching(false);
    }
  };

  const exportSelection = async (format: AdminExportFormat) => {
    if (!session || selectedResources.length < 1) return;
    setPendingOperation(`EXPORT_${format}`);
    setOperationError(null);
    setOperationNotice('');
    try {
      const exported = await exportAdminGlobalResources({
        selection: selectedResources.map(({ resourceType, resourceId }) => ({ resourceType, resourceId })),
        format,
        idempotencyKey: exportIdempotencyKey,
      }, session.token);
      downloadAdminResourceExport(exported);
      setOperationNotice(`${exported.filename} 已下载，共 ${exported.rowCount} 行，内容哈希 ${exported.contentHash}。`);
      setExportIdempotencyKey(operationKey('global-export'));
    } catch (cause) {
      setOperationError(asCoreError(cause, '资源导出不可用'));
    } finally {
      setPendingOperation(null);
    }
  };

  const addTags = async () => {
    if (!session || !canAddTags || selectedTagIds.length < 1) return;
    setPendingOperation('ADD_PRODUCT_TAGS');
    setOperationError(null);
    setOperationNotice('');
    try {
      const result = await batchAddAdminProductTags({
        productIds: selectedResources.map((resource) => resource.resourceId),
        tagIds: selectedTagIds,
        idempotencyKey: tagIdempotencyKey,
      }, session.token);
      setTagResult(result);
      setSelectedTagIds([]);
      setTagIdempotencyKey(operationKey('global-tags'));
      if (activeFilters) await runSearch(activeFilters);
      setOperationNotice(`批量标签操作已完成，${result.changedCount} 个商品写入新版本。`);
    } catch (cause) {
      setOperationError(asCoreError(cause, '商品批量标签写入不可用'));
    } finally {
      setPendingOperation(null);
    }
  };

  const applyLifecycle = async () => {
    if (!session || !lifecycleAction || !canWrite || !allProducts
      || !hasCapabilityForEvery(selectedResources, lifecycleCapability(lifecycleAction))
      || !reasonCodePattern.test(lifecycleReasonCode.trim())) return;
    const productIds = selectedResources.map((resource) => resource.resourceId);
    setPendingOperation(`LIFECYCLE_${lifecycleAction}`);
    setOperationError(null);
    setOperationNotice('');
    try {
      const result = await batchApplyAdminProductLifecycle({
        action: lifecycleAction,
        productIds,
        reasonCode: lifecycleReasonCode.trim(),
        idempotencyKey: lifecycleIdempotencyKey,
      }, session.token);
      setLifecycleResult(result);
      setLifecycleAction(null);
      setLifecycleReasonCode('');
      setLifecycleIdempotencyKey(operationKey('global-lifecycle'));
      if (activeFilters) await runSearch(activeFilters);
      setOperationNotice(`${lifecycleActionLabel(result.action)}完成，${result.changedCount} 个商品已原子更新。`);
    } catch (cause) {
      setOperationError(asCoreError(cause, '商品生命周期批处理不可用'));
    } finally {
      setPendingOperation(null);
    }
  };

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><SearchCheck aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">SERVER-SIDE ADMIN RESOURCE OPERATIONS</p>
          <h1>全局资源操作</h1>
          <p>跨订单、商品与商家执行 AND / OR 检索；选择结果后由 Core 生成审计导出，商品标签与生命周期批处理继续受逐行 allowedActions 约束。</p>
        </div>
        <div className="requirement-list"><code>ADM-GLOBAL-001</code><code>ADM-GLOBAL-002</code><code>ADM-GLOBAL-003</code><code>ADM-CAT-002</code><code>{artifactVersion}</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt global-session-prompt" role="status" aria-label="全局资源操作状态">
          <div><KeyRound aria-hidden="true" /><span><strong>连接平台钱包</strong><small>ADMIN / OPERATOR 可检索、导出和执行授权标签写入；AUDITOR 可检索和导出。</small></span></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '认证中' : 'SIWE 连接'}</button>
        </section>
      ) : !canRead ? (
        <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有全局资源读取权限', status: 403 })} />
      ) : (
        <GlobalResourceSearch enabled={!searching && !pendingOperation} loading={searching} onSearch={(filters) => void runSearch(filters)} onReset={() => { setResponse(null); setActiveFilters(null); setSelectedKeys(new Set()); }} />
      )}

      {sessionError ? <p className="inline-notice" role="alert">{sessionError}</p> : null}
      {searchError ? <ErrorView error={searchError} /> : null}
      {searching ? <SearchLoading /> : null}
      {response ? (
        <>
          {response.truncated ? <p className="global-truncated" role="status"><AlertTriangle aria-hidden="true" /><span><strong>结果已截断</strong>当前仅显示 Core 返回的前 {response.resources.length} 项，请增加精确条件后重新查询。</span></p> : null}
          <ResourceResults
            relation={response.relation}
            resources={response.resources}
            selectionDisabled={Boolean(pendingOperation)}
            selectedKeys={selectedKeys}
            tags={tags}
            onSelectionChange={changeSelection}
          />
          <GlobalBatchActions
            canAddTags={canAddTags}
            canExportCsv={canExportCsv}
            canExportExcel={canExportExcel}
            canWrite={canWrite}
            enabledTags={enabledTags}
            exportIdempotencyKey={exportIdempotencyKey}
            lifecycleAction={lifecycleAction}
            lifecycleIdempotencyKey={lifecycleIdempotencyKey}
            lifecycleReasonCode={lifecycleReasonCode}
            operationError={operationError}
            pendingOperation={pendingOperation}
            selectedCount={selectedResources.length}
            selectedResources={selectedResources}
            selectedTagIds={selectedTagIds}
            tagIdempotencyKey={tagIdempotencyKey}
            tagsError={tagsError}
            tagsLoading={tagsLoading}
            onAddTags={() => void addTags()}
            onExport={(format) => void exportSelection(format)}
            onExportIdempotencyChange={setExportIdempotencyKey}
            onLifecycleActionChange={(action) => { setLifecycleAction(action); setOperationError(null); setOperationNotice(''); }}
            onLifecycleCancel={() => { setLifecycleAction(null); setLifecycleReasonCode(''); setLifecycleIdempotencyKey(operationKey('global-lifecycle')); setOperationError(null); }}
            onLifecycleConfirm={() => void applyLifecycle()}
            onLifecycleIdempotencyChange={setLifecycleIdempotencyKey}
            onLifecycleReasonChange={(value) => setLifecycleReasonCode(value.toUpperCase())}
            onSelectedTagIdsChange={setSelectedTagIds}
            onTagIdempotencyChange={setTagIdempotencyKey}
          />
        </>
      ) : null}

      {operationError ? <ErrorView error={operationError} /> : null}
      {operationNotice ? <p className="healthy-copy global-notice" role="status"><Check aria-hidden="true" />{operationNotice}</p> : null}
      {tagResult ? <BatchTagEvidence result={tagResult} /> : null}
      {lifecycleResult ? <BatchLifecycleEvidence result={lifecycleResult} /> : null}

      <section className="global-unavailable" aria-labelledby="global-unavailable-title">
        <Ban aria-hidden="true" />
        <div><strong id="global-unavailable-title">Unavailable / DecisionBlocked</strong><p>UID、手机号和 Yellow queue 没有冻结定义，界面不发送这些条件，也不执行本地猜测。</p></div>
        <span>UID · PHONE · YELLOW</span>
      </section>
    </>
  );
}

function GlobalResourceSearch({ enabled, loading, onSearch, onReset }: {
  enabled: boolean;
  loading: boolean;
  onSearch(filters: AdminGlobalSearchFilters): void;
  onReset(): void;
}) {
  const [form, setForm] = useState<SearchForm>(emptySearchForm);
  const [quickRange, setQuickRange] = useState<QuickRange | null>(null);
  const set = <K extends keyof SearchForm>(field: K, value: SearchForm[K]) => setForm((current) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (enabled) onSearch(toFilters(form));
  };
  const reset = () => {
    setForm(emptySearchForm);
    setQuickRange(null);
    onReset();
  };
  const toggleResourceType = (type: AdminResourceType) => {
    setForm((current) => ({
      ...current,
      resourceTypes: current.resourceTypes.includes(type)
        ? current.resourceTypes.filter((item) => item !== type)
        : [...current.resourceTypes, type],
    }));
  };
  const selectQuickRange = (range: QuickRange) => {
    const bounds = rangeBounds(range, new Date());
    setQuickRange(range);
    setForm((current) => ({ ...current, from: localInput(bounds.start), to: localInput(bounds.end) }));
  };

  return (
    <details className="search-panel global-search-panel" open>
      <summary><span className="summary-title"><Search aria-hidden="true" />跨资源检索</span><span className="summary-meta">Core 服务端 AND / OR · 最多 100 项</span></summary>
      <form className="search-form" onSubmit={submit}>
        <div className="global-search-meta">
          <fieldset className="global-resource-types"><legend>资源类型</legend>{adminResourceTypes.map((type) => <label key={type}><input type="checkbox" checked={form.resourceTypes.includes(type)} onChange={() => toggleResourceType(type)} disabled={!enabled} />{resourceTypeLabel(type)}</label>)}</fieldset>
          <fieldset className="segmented-field"><legend>条件关系</legend><div className="segmented">{(['AND', 'OR'] as const).map((relation) => <button key={relation} className={form.relation === relation ? 'is-active' : undefined} type="button" aria-pressed={form.relation === relation} disabled={!enabled} onClick={() => set('relation', relation)}>{relation}</button>)}</div></fieldset>
        </div>
        <div className="search-grid">
          <label>订单号<input value={form.orderId} onChange={(event) => set('orderId', event.target.value)} disabled={!enabled} maxLength={256} autoComplete="off" placeholder="精确匹配" /></label>
          <label>商品 ID<input value={form.productId} onChange={(event) => set('productId', event.target.value)} disabled={!enabled} maxLength={256} autoComplete="off" placeholder="精确匹配" /></label>
          <label>商家 ID<input value={form.merchantId} onChange={(event) => set('merchantId', event.target.value)} disabled={!enabled} maxLength={256} autoComplete="off" placeholder="精确匹配" /></label>
          <label>TxHash<input value={form.txHash} onChange={(event) => set('txHash', event.target.value)} disabled={!enabled} pattern="0x[0-9a-fA-F]{64}" autoComplete="off" placeholder="0x + 64 hex" /></label>
          <label>钱包地址<input aria-label="钱包地址" value={form.wallet} onChange={(event) => set('wallet', event.target.value)} disabled={!enabled} pattern={form.walletMatch === 'EXACT' ? '0x[0-9a-fA-F]{40}' : '(0x)?[0-9a-fA-F]{6,40}'} autoComplete="off" placeholder={form.walletMatch === 'EXACT' ? '0x + 40 hex' : '6-40 位 hex，可含 0x'} aria-describedby="global-wallet-help" /><small id="global-wallet-help">{form.walletMatch === 'EXACT' ? '完整 EVM 地址' : '仅按十六进制片段匹配'}</small></label>
          <label>审核投影<select value={form.pendingReview} onChange={(event) => set('pendingReview', event.target.value as PendingReviewFilter)} disabled={!enabled}><option value="">全部</option><option value="true">待审核</option><option value="false">非待审核</option></select></label>
          <label>开始时间<input value={form.from} onChange={(event) => { setQuickRange(null); set('from', event.target.value); }} disabled={!enabled} type="datetime-local" /></label>
          <label>结束时间<input value={form.to} onChange={(event) => { setQuickRange(null); set('to', event.target.value); }} disabled={!enabled} type="datetime-local" /></label>
          <label>用户 UID<input disabled placeholder="DecisionBlocked" /></label>
          <label>绑定手机号<input disabled placeholder="DecisionBlocked / PII" /></label>
          <label>Yellow queue<input disabled placeholder="Unavailable" /></label>
          <fieldset className="global-wallet-match"><legend>钱包匹配</legend><div className="segmented">{(['EXACT', 'FUZZY'] as const).map((mode) => <button key={mode} className={form.walletMatch === mode ? 'is-active' : undefined} type="button" aria-pressed={form.walletMatch === mode} disabled={!enabled} onClick={() => set('walletMatch', mode)}>{mode === 'EXACT' ? '精确' : '模糊'}</button>)}</div></fieldset>
        </div>
        <div className="search-footer">
          <div className="quick-ranges" aria-label="快捷时间范围"><CalendarDays aria-hidden="true" />{quickRanges.map((range) => <button key={range} type="button" className={quickRange === range ? 'is-active' : ''} aria-pressed={quickRange === range} disabled={!enabled} onClick={() => selectQuickRange(range)}>{range}</button>)}</div>
          <div className="button-row"><button className="button button-quiet" type="button" onClick={reset} disabled={!enabled}><RotateCcw aria-hidden="true" />重置</button><button className="button button-primary" type="submit" disabled={!enabled || form.resourceTypes.length < 1}><Search aria-hidden="true" />{loading ? '查询中' : '查询'}</button></div>
        </div>
      </form>
    </details>
  );
}

function ResourceResults({ relation, resources, selectionDisabled, selectedKeys, tags, onSelectionChange }: {
  relation: 'AND' | 'OR';
  resources: readonly AdminResourceSummary[];
  selectionDisabled: boolean;
  selectedKeys: ReadonlySet<string>;
  tags: readonly CatalogTag[];
  onSelectionChange(value: ReadonlySet<string>): void;
}) {
  const allSelected = resources.length > 0 && resources.every((resource) => selectedKeys.has(resourceKey(resource)));
  const toggleAll = () => onSelectionChange(allSelected ? new Set() : new Set(resources.map(resourceKey)));
  const toggle = (resource: AdminResourceSummary) => {
    const next = new Set(selectedKeys);
    const key = resourceKey(resource);
    if (next.has(key)) next.delete(key); else next.add(key);
    onSelectionChange(next);
  };
  if (resources.length === 0) return <section className="panel global-empty" role="status"><Search aria-hidden="true" /><h2>没有匹配资源</h2><p>Core 已执行当前 {relation} 条件，未返回订单、商品或商家。</p></section>;
  return (
    <section className="panel global-results" aria-labelledby="global-results-title">
      <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/global/resources</p><h2 id="global-results-title">资源结果</h2></div><span className="status-chip status-ready"><Check aria-hidden="true" />{resources.length} 项</span></div>
      <div className="data-table-wrap"><table className="data-table global-resource-table"><thead><tr><th><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="选择当前全部结果" disabled={selectionDisabled} /></th><th>类型 / 状态</th><th>资源</th><th>归属</th><th>标签</th><th>逐行权限</th><th>创建时间</th></tr></thead><tbody>{resources.map((resource) => (
        <tr key={resourceKey(resource)} className={selectedKeys.has(resourceKey(resource)) ? 'is-selected' : undefined}>
          <td><input type="checkbox" checked={selectedKeys.has(resourceKey(resource))} onChange={() => toggle(resource)} aria-label={`选择 ${resource.resourceType} ${resource.resourceId}`} disabled={selectionDisabled} /></td>
          <td><span className={`global-type global-type-${resource.resourceType.toLowerCase()}`}>{resourceTypeLabel(resource.resourceType)}</span><small>{resource.status}</small></td>
          <td><strong>{resource.title}</strong><code>{resource.resourceId}</code></td>
          <td><small>Merchant</small><code>{resource.merchantId ?? '—'}</code><small>Product</small><code>{resource.productId ?? '—'}</code></td>
          <td>{resource.tagIds.length ? <div className="global-tag-list">{resource.tagIds.map((tagId) => <span key={tagId}>{tags.find((tag) => tag.tagId === tagId)?.name ?? tagId}</span>)}</div> : <small>无标签</small>}</td>
          <td><div className="global-capabilities">{resource.allowedBatchActions.map((capability) => <span key={capability.action} className={capability.enabled ? 'is-enabled' : 'is-blocked'}>{capability.action}<small>{capability.enabled ? 'Allowed' : capability.reasonCode}</small></span>)}</div></td>
          <td>{formatDate(resource.createdAt)}</td>
        </tr>
      ))}</tbody></table></div>
    </section>
  );
}

function GlobalBatchActions(props: {
  canAddTags: boolean;
  canExportCsv: boolean;
  canExportExcel: boolean;
  canWrite: boolean;
  enabledTags: readonly CatalogTag[];
  exportIdempotencyKey: string;
  lifecycleAction: CatalogReviewDecision | null;
  lifecycleIdempotencyKey: string;
  lifecycleReasonCode: string;
  operationError: CoreApiError | null;
  pendingOperation: string | null;
  selectedCount: number;
  selectedResources: readonly AdminResourceSummary[];
  selectedTagIds: readonly string[];
  tagIdempotencyKey: string;
  tagsError: CoreApiError | null;
  tagsLoading: boolean;
  onAddTags(): void;
  onExport(format: AdminExportFormat): void;
  onExportIdempotencyChange(value: string): void;
  onLifecycleActionChange(action: CatalogReviewDecision): void;
  onLifecycleCancel(): void;
  onLifecycleConfirm(): void;
  onLifecycleIdempotencyChange(value: string): void;
  onLifecycleReasonChange(value: string): void;
  onSelectedTagIdsChange(value: readonly string[]): void;
  onTagIdempotencyChange(value: string): void;
}) {
  const allProducts = props.selectedCount > 0 && props.selectedResources.every((resource) => resource.resourceType === 'PRODUCT');
  const tagBlock = !props.canWrite ? 'AUDITOR 只读：Forbidden'
    : !allProducts ? '仅支持全部选择为商品'
      : !props.canAddTags ? batchTagBlockReason(props.selectedResources)
        : null;
  const lifecycleBusy = props.pendingOperation?.startsWith('LIFECYCLE_') ?? false;
  const lifecycleAllowed = (action: CatalogReviewDecision) => props.canWrite
    && allProducts
    && hasCapabilityForEvery(props.selectedResources, lifecycleCapability(action));
  const lifecycleSummary = !props.canWrite ? 'AUDITOR 只读：Forbidden'
    : !allProducts ? '仅支持全部选择为商品'
      : '仅开放全部选中行共同授权的动作';
  const selectedLifecycle = lifecycleActions.find((item) => item.action === props.lifecycleAction);
  const SelectedLifecycleIcon = selectedLifecycle?.Icon;
  const toggleTag = (tagId: string) => props.onSelectedTagIdsChange(
    props.selectedTagIds.includes(tagId) ? props.selectedTagIds.filter((id) => id !== tagId) : [...props.selectedTagIds, tagId],
  );
  return (
    <section className="batch-bar global-batch-bar" aria-labelledby="global-batch-title">
      <div><p className="section-kicker" id="global-batch-title">授权批处理</p><strong className="tabular">已选择 {props.selectedCount} 项</strong></div>
      <div className="batch-actions">
        <button className="button button-quiet" type="button" disabled={!props.canExportCsv || Boolean(props.pendingOperation) || props.exportIdempotencyKey.length < 8} onClick={() => props.onExport('CSV')}><Download aria-hidden="true" />{props.pendingOperation === 'EXPORT_CSV' ? '生成中' : '导出 CSV'}</button>
        <button className="button button-quiet" type="button" disabled={!props.canExportExcel || Boolean(props.pendingOperation) || props.exportIdempotencyKey.length < 8} onClick={() => props.onExport('EXCEL')}><FileSpreadsheet aria-hidden="true" />{props.pendingOperation === 'EXPORT_EXCEL' ? '生成中' : '导出 Excel'}</button>
      </div>
      <div className="global-batch-fields">
        <label>导出 idempotency key<input value={props.exportIdempotencyKey} onChange={(event) => props.onExportIdempotencyChange(event.target.value)} minLength={8} maxLength={128} /></label>
        <div><span>导出权限</span><strong>{props.selectedCount < 1 ? '请选择资源' : props.canExportCsv && props.canExportExcel ? 'CSV / Excel allowed' : 'Core row capability denied'}</strong></div>
      </div>
      <div className="global-tag-command">
        <div className="global-tag-heading"><span><Tags aria-hidden="true" /><strong>批量增加商品标签</strong></span><small>{tagBlock ?? '每行 ADD_PRODUCT_TAGS allowed'}</small></div>
        {props.tagsLoading ? <p className="muted-copy">正在读取版本化标签库...</p> : null}
        {props.tagsError ? <p className="batch-preview-error" role="alert">{props.tagsError.code}: {props.tagsError.message}</p> : null}
        <fieldset className="global-tag-options" disabled={!props.canAddTags || Boolean(props.pendingOperation)}><legend>启用标签</legend>{props.enabledTags.length ? props.enabledTags.map((tag) => <label key={tag.tagId}><input type="checkbox" checked={props.selectedTagIds.includes(tag.tagId)} onChange={() => toggleTag(tag.tagId)} />{tag.name}<small>{tag.tagId}</small></label>) : <p>没有可用标签</p>}</fieldset>
        <div className="global-tag-footer"><label>标签 idempotency key<input value={props.tagIdempotencyKey} onChange={(event) => props.onTagIdempotencyChange(event.target.value)} minLength={8} maxLength={128} disabled={!props.canWrite} /></label><button className="button button-primary" type="button" disabled={!props.canAddTags || props.selectedTagIds.length < 1 || props.tagIdempotencyKey.length < 8 || Boolean(props.pendingOperation)} onClick={props.onAddTags}><Tags aria-hidden="true" />{props.pendingOperation === 'ADD_PRODUCT_TAGS' ? '写入中' : '批量加标签'}</button></div>
      </div>
      <div className="global-lifecycle-command">
        <div className="global-tag-heading"><span><ClipboardCheck aria-hidden="true" /><strong>商品生命周期批处理</strong></span><small>{lifecycleSummary}</small></div>
        <div className="global-lifecycle-actions" aria-label="商品生命周期动作">{lifecycleActions.map(({ action, capability, label, Icon }) => {
          const allowed = lifecycleAllowed(action);
          const blockedReason = lifecycleBlockReason(props.selectedResources, capability);
          return <button className={['REJECT', 'HIDE', 'DELIST'].includes(action) ? 'button button-danger' : 'button button-quiet'} key={action} type="button" disabled={!allowed || Boolean(props.pendingOperation) || Boolean(selectedLifecycle)} title={allowed ? `${capability} allowed` : blockedReason} onClick={() => props.onLifecycleActionChange(action)}><Icon aria-hidden="true" />{label}</button>;
        })}</div>
        {selectedLifecycle && SelectedLifecycleIcon ? (
          <section className="global-lifecycle-confirm" aria-labelledby="global-lifecycle-confirm-title" aria-live="polite">
            <div className="global-lifecycle-confirm-heading"><AlertTriangle aria-hidden="true" /><div><strong id="global-lifecycle-confirm-title">确认{selectedLifecycle.label}</strong><p>将对当前选中的 {props.selectedCount} 个商品执行原子批处理；任一商品被 Core 拒绝时全部不生效。</p></div></div>
            <div className="global-lifecycle-fields">
              <label>原因代码<input value={props.lifecycleReasonCode} onChange={(event) => props.onLifecycleReasonChange(event.target.value)} pattern="[A-Z][A-Z0-9_]{1,63}" minLength={2} maxLength={64} placeholder="OPERATIONS_APPROVED" autoComplete="off" disabled={lifecycleBusy || Boolean(props.operationError)} required /></label>
              <label>Lifecycle idempotency key<input value={props.lifecycleIdempotencyKey} onChange={(event) => props.onLifecycleIdempotencyChange(event.target.value)} minLength={8} maxLength={128} disabled={lifecycleBusy || Boolean(props.operationError)} required /></label>
            </div>
            {props.operationError ? <p className="global-lifecycle-retry" role="alert"><Ban aria-hidden="true" /><span><strong>{props.operationError.code}: {props.operationError.message}</strong>当前幂等键已保留；确认请求内容未变时可安全重试。</span></p> : <p className="muted-copy">确认后使用当前幂等键提交；成功后自动刷新当前检索，失败时保留原键供重试。</p>}
            <div className="button-row"><button className="button button-quiet" type="button" onClick={props.onLifecycleCancel} disabled={lifecycleBusy}>取消</button><button className={['REJECT', 'HIDE', 'DELIST'].includes(selectedLifecycle.action) ? 'button button-danger' : 'button button-primary'} type="button" onClick={props.onLifecycleConfirm} disabled={!lifecycleAllowed(selectedLifecycle.action) || !reasonCodePattern.test(props.lifecycleReasonCode.trim()) || props.lifecycleIdempotencyKey.length < 8 || Boolean(props.pendingOperation)}><SelectedLifecycleIcon aria-hidden="true" />{lifecycleBusy ? '原子执行中' : `确认${selectedLifecycle.label}`}</button></div>
          </section>
        ) : null}
      </div>
      <p className="batch-reason">导出内容由 Core 生成并审计；标签和生命周期命令仅接受全商品选择和每行授权。电子面单与自提打印继续由独立物流能力处理。</p>
    </section>
  );
}

function BatchTagEvidence({ result }: { result: AdminProductBatchTagResult }) {
  return <section className="panel global-operation-evidence" aria-labelledby="batch-tag-evidence-title"><div className="panel-heading"><div><p className="section-kicker">POST /v2/admin/catalog/products/batch-tags</p><h2 id="batch-tag-evidence-title">标签版本证据</h2></div><ShieldCheck aria-hidden="true" /></div><dl><div><dt>Operation ID</dt><dd><code>{result.operationId}</code></dd></div><div><dt>Changed</dt><dd>{result.changedCount} / {result.products.length}</dd></div><div><dt>Tags</dt><dd>{result.tagIds.join(' · ')}</dd></div><div><dt>Created</dt><dd>{formatDate(result.createdAt)}</dd></div></dl><div className="global-version-list">{result.products.map((product) => <span key={product.productId}><code>{product.productId}</code><strong>v{product.previousVersion} → v{product.version}</strong><small>{product.addedTagIds.length ? product.addedTagIds.join(' · ') : '没有新增标签'}</small></span>)}</div></section>;
}

function BatchLifecycleEvidence({ result }: { result: AdminProductLifecycleBatchResult }) {
  return <section className="panel global-operation-evidence" aria-labelledby="batch-lifecycle-evidence-title"><div className="panel-heading"><div><p className="section-kicker">POST /v2/admin/catalog/products/batch-lifecycle</p><h2 id="batch-lifecycle-evidence-title">生命周期操作证据</h2></div><ShieldCheck aria-hidden="true" /></div><dl><div><dt>Operation ID</dt><dd><code>{result.operationId}</code></dd></div><div><dt>Changed</dt><dd>{result.changedCount} / {result.products.length}</dd></div><div><dt>Action</dt><dd>{result.action}</dd></div><div><dt>Created</dt><dd>{formatDate(result.createdAt)}</dd></div></dl><div className="global-version-list">{result.products.map((product) => <span key={product.productId}><code>{product.productId}</code><strong>{product.previousState} → {product.state}</strong><small>{lifecycleActionLabel(result.action)}</small></span>)}</div></section>;
}

function SearchLoading() {
  return <section className="panel global-loading" role="status" aria-label="正在检索全局资源"><RefreshCw className="spin" aria-hidden="true" /><span /><span /><span /></section>;
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error global-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p>{error.correlationId ? <small>Correlation ID: {error.correlationId}</small> : null}</div></div>;
}

function toFilters(form: SearchForm): AdminGlobalSearchFilters {
  return {
    resourceTypes: form.resourceTypes,
    relation: form.relation,
    walletMatch: form.walletMatch,
    limit: 100,
    ...(trim(form.orderId) ? { orderId: trim(form.orderId) } : {}),
    ...(trim(form.productId) ? { productId: trim(form.productId) } : {}),
    ...(trim(form.merchantId) ? { merchantId: trim(form.merchantId) } : {}),
    ...(trim(form.txHash) ? { txHash: trim(form.txHash) } : {}),
    ...(trim(form.wallet) ? { wallet: trim(form.wallet) } : {}),
    ...(form.from ? { from: form.from } : {}),
    ...(form.to ? { to: form.to } : {}),
    ...(form.pendingReview ? { pendingReview: form.pendingReview === 'true' } : {}),
  };
}

function hasCapabilityForEvery(resources: readonly AdminResourceSummary[], action: AdminBatchAction) {
  return resources.length > 0 && resources.every((resource) => resource.allowedBatchActions.some((capability) => capability.action === action && capability.enabled));
}

function batchTagBlockReason(resources: readonly AdminResourceSummary[]) {
  const blocked = resources.flatMap((resource) => resource.allowedBatchActions).find((capability) => capability.action === 'ADD_PRODUCT_TAGS' && !capability.enabled);
  return blocked?.reasonCode ?? 'Core 未授权 ADD_PRODUCT_TAGS';
}

function lifecycleCapability(action: CatalogReviewDecision): AdminBatchAction {
  return lifecycleActions.find((item) => item.action === action)!.capability;
}

function lifecycleActionLabel(action: CatalogReviewDecision) {
  return lifecycleActions.find((item) => item.action === action)!.label;
}

function lifecycleBlockReason(resources: readonly AdminResourceSummary[], capability: AdminBatchAction) {
  const blocked = resources.flatMap((resource) => resource.allowedBatchActions)
    .find((item) => item.action === capability && !item.enabled);
  return blocked?.reasonCode ?? `Core 未授权 ${capability}`;
}

function resourceKey(resource: Pick<AdminResourceSummary, 'resourceType' | 'resourceId'>) {
  return `${resource.resourceType}\u0000${resource.resourceId}`;
}

function resourceTypeLabel(type: AdminResourceType) {
  return ({ ORDER: '订单', PRODUCT: '商品', MERCHANT: '商家' } as const)[type];
}

function rangeBounds(range: QuickRange, now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === '昨日') {
    start.setDate(start.getDate() - 1);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  if (range === '近 7 天') start.setDate(start.getDate() - 6);
  if (range === '近 30 天') start.setDate(start.getDate() - 29);
  return { start, end: now };
}

function localInput(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function operationKey(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function trim(value: string) { return value.trim(); }

function asCoreError(cause: unknown, message: string) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message, status: 503 });
}
