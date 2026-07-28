import {
  adminResourceTypes,
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
import { commonStateLabel, humanizeError, shortId } from '../display';

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
  uid: string;
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
  uid: '',
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
        if (!controller.signal.aborted) setTagsError(asCoreError(cause, '商品标签库不可用'));
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
      || (lifecycleReasonCode.trim() !== '' && !reasonCodePattern.test(lifecycleReasonCode.trim()))) return;
    const productIds = selectedResources.map((resource) => resource.resourceId);
    setPendingOperation(`LIFECYCLE_${lifecycleAction}`);
    setOperationError(null);
    setOperationNotice('');
    try {
      const result = await batchApplyAdminProductLifecycle({
        action: lifecycleAction,
        productIds,
        reasonCode: normalizedReason(lifecycleReasonCode, defaultLifecycleReason(lifecycleAction)),
        idempotencyKey: lifecycleIdempotencyKey,
      }, session.token);
      setLifecycleResult(result);
      setLifecycleAction(null);
      setLifecycleReasonCode('');
      setLifecycleIdempotencyKey(operationKey('global-lifecycle'));
      if (activeFilters) await runSearch(activeFilters);
      setOperationNotice(`${lifecycleActionLabel(result.action)}完成，${result.changedCount} 个商品已整体更新。`);
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
          <p className="eyebrow">全局检索与批处理</p>
          <h1>全局资源操作</h1>
          <p>跨订单、商品与商家检索；选择结果后可导出记录、批量加标签或处理商品状态，所有写入都以系统授权为准。</p>
        </div>
        <div className="requirement-list"><code>检索</code><code>导出</code><code>批处理</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt global-session-prompt" role="status" aria-label="全局资源操作状态">
          <div><KeyRound aria-hidden="true" /><span><strong>连接平台钱包</strong><small>管理员和运营可检索、导出和批处理；审计员只能检索和导出。</small></span></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '连接中' : '连接钱包'}</button>
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
          {response.truncated ? <p className="global-truncated" role="status"><AlertTriangle aria-hidden="true" /><span><strong>结果已截断</strong>当前仅显示前 {response.resources.length} 项，请增加精确条件后重新查询。</span></p> : null}
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
        <div><strong id="global-unavailable-title">暂不开放的能力</strong><p>手机号和特殊队列暂不开放，页面不会自己猜数据。</p></div>
        <span>已保护</span>
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
      <summary><span className="summary-title"><Search aria-hidden="true" />跨资源检索</span><span className="summary-meta">最多 100 项</span></summary>
      <form className="search-form" onSubmit={submit}>
        <div className="global-search-meta">
          <fieldset className="global-resource-types"><legend>资源类型</legend>{adminResourceTypes.map((type) => <label key={type}><input type="checkbox" checked={form.resourceTypes.includes(type)} onChange={() => toggleResourceType(type)} disabled={!enabled} />{resourceTypeLabel(type)}</label>)}</fieldset>
          <fieldset className="segmented-field"><legend>条件关系</legend><div className="segmented">{(['AND', 'OR'] as const).map((relation) => <button key={relation} className={form.relation === relation ? 'is-active' : undefined} type="button" aria-pressed={form.relation === relation} disabled={!enabled || (relation === 'OR' && Boolean(form.uid.trim()))} onClick={() => set('relation', relation)}>{relation === 'AND' ? '全部满足' : '任一满足'}</button>)}</div></fieldset>
        </div>
        <div className="search-grid">
          <label>订单号<input value={form.orderId} onChange={(event) => set('orderId', event.target.value)} disabled={!enabled} maxLength={256} autoComplete="off" placeholder="精确匹配" /></label>
          <label>商品编号<input value={form.productId} onChange={(event) => set('productId', event.target.value)} disabled={!enabled} maxLength={256} autoComplete="off" placeholder="精确匹配" /></label>
          <label>商家编号<input value={form.merchantId} onChange={(event) => set('merchantId', event.target.value)} disabled={!enabled} maxLength={256} autoComplete="off" placeholder="精确匹配" /></label>
          <label>付款记录编号（高级）<input value={form.txHash} onChange={(event) => set('txHash', event.target.value)} disabled={!enabled} pattern="0x[0-9a-fA-F]{64}" autoComplete="off" placeholder="从订单付款记录复制" /><small>不知道这个编号就留空。</small></label>
          <label>钱包地址<input aria-label="钱包地址" value={form.wallet} onChange={(event) => set('wallet', event.target.value)} disabled={!enabled} pattern={form.walletMatch === 'EXACT' ? '0x[0-9a-fA-F]{40}' : '(0x)?[0-9a-fA-F]{6,40}'} autoComplete="off" placeholder={form.walletMatch === 'EXACT' ? '完整钱包地址' : '钱包地址片段'} aria-describedby="global-wallet-help" /><small id="global-wallet-help">{form.walletMatch === 'EXACT' ? '完整钱包地址' : '仅按地址片段匹配'}</small></label>
          <label>审核投影<select value={form.pendingReview} onChange={(event) => set('pendingReview', event.target.value as PendingReviewFilter)} disabled={!enabled}><option value="">全部</option><option value="true">待审核</option><option value="false">非待审核</option></select></label>
          <label>开始时间<input value={form.from} onChange={(event) => { setQuickRange(null); set('from', event.target.value); }} disabled={!enabled} type="datetime-local" /></label>
          <label>结束时间<input value={form.to} onChange={(event) => { setQuickRange(null); set('to', event.target.value); }} disabled={!enabled} type="datetime-local" /></label>
          <label>用户 UID<input value={form.uid} onChange={(event) => setForm((current) => ({ ...current, uid: event.target.value, relation: 'AND', walletMatch: 'EXACT' }))} disabled={!enabled} inputMode="numeric" pattern="[1-9][0-9]{0,18}" autoComplete="off" placeholder="精确 UID" /></label>
          <label>绑定手机号<input disabled placeholder="暂不开放" /></label>
          <label>特殊队列<input disabled placeholder="暂不开放" /></label>
          <fieldset className="global-wallet-match"><legend>钱包匹配</legend><div className="segmented">{(['EXACT', 'FUZZY'] as const).map((mode) => <button key={mode} className={form.walletMatch === mode ? 'is-active' : undefined} type="button" aria-pressed={form.walletMatch === mode} disabled={!enabled || (mode === 'FUZZY' && Boolean(form.uid.trim()))} onClick={() => set('walletMatch', mode)}>{mode === 'EXACT' ? '精确' : '模糊'}</button>)}</div></fieldset>
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
  if (resources.length === 0) return <section className="panel global-empty" role="status"><Search aria-hidden="true" /><h2>没有匹配资源</h2><p>系统已按当前条件查询，未找到订单、商品或商家。</p></section>;
  return (
    <section className="panel global-results" aria-labelledby="global-results-title">
      <div className="panel-heading"><div><p className="section-kicker">查询结果</p><h2 id="global-results-title">资源结果</h2></div><span className="status-chip status-ready"><Check aria-hidden="true" />{resources.length} 项</span></div>
      <div className="data-table-wrap"><table className="data-table global-resource-table"><thead><tr><th><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="选择当前全部结果" disabled={selectionDisabled} /></th><th>类型 / 状态</th><th>资源</th><th>归属</th><th>标签</th><th>逐行权限</th><th>创建时间</th></tr></thead><tbody>{resources.map((resource) => (
        <tr key={resourceKey(resource)} className={selectedKeys.has(resourceKey(resource)) ? 'is-selected' : undefined}>
          <td><input type="checkbox" checked={selectedKeys.has(resourceKey(resource))} onChange={() => toggle(resource)} aria-label={`选择 ${resource.resourceType} ${resource.resourceId}`} disabled={selectionDisabled} /></td>
          <td><span className={`global-type global-type-${resource.resourceType.toLowerCase()}`}>{resourceTypeLabel(resource.resourceType)}</span><small>{commonStateLabel(resource.status)}</small></td>
          <td><strong>{resource.title}</strong><code title={resource.resourceId}>{shortId(resource.resourceId)}</code></td>
          <td><small>商家</small><code title={resource.merchantId ?? undefined}>{resource.merchantId ? shortId(resource.merchantId) : '—'}</code><small>商品</small><code title={resource.productId ?? undefined}>{resource.productId ? shortId(resource.productId) : '—'}</code></td>
          <td>{resource.tagIds.length ? <div className="global-tag-list">{resource.tagIds.map((tagId) => <span key={tagId}>{tags.find((tag) => tag.tagId === tagId)?.name ?? tagId}</span>)}</div> : <small>无标签</small>}</td>
          <td><div className="global-capabilities">{resource.allowedBatchActions.map((capability) => <span key={capability.action} className={capability.enabled ? 'is-enabled' : 'is-blocked'}>{batchActionLabel(capability.action)}<small>{capability.enabled ? '可执行' : reasonLabel(capability.reasonCode)}</small></span>)}</div></td>
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
  const tagBlock = !props.canWrite ? '只读角色，不能写入'
    : !allProducts ? '仅支持全部选择为商品'
      : !props.canAddTags ? batchTagBlockReason(props.selectedResources)
        : null;
  const lifecycleBusy = props.pendingOperation?.startsWith('LIFECYCLE_') ?? false;
  const lifecycleAllowed = (action: CatalogReviewDecision) => props.canWrite
    && allProducts
    && hasCapabilityForEvery(props.selectedResources, lifecycleCapability(action));
  const lifecycleSummary = !props.canWrite ? '只读角色，不能写入'
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
        <button className="button button-quiet" type="button" disabled={!props.canExportCsv || Boolean(props.pendingOperation)} onClick={() => props.onExport('CSV')}><Download aria-hidden="true" />{props.pendingOperation === 'EXPORT_CSV' ? '生成中' : '导出 CSV'}</button>
        <button className="button button-quiet" type="button" disabled={!props.canExportExcel || Boolean(props.pendingOperation)} onClick={() => props.onExport('EXCEL')}><FileSpreadsheet aria-hidden="true" />{props.pendingOperation === 'EXPORT_EXCEL' ? '生成中' : '导出 Excel'}</button>
      </div>
      <div className="global-batch-fields">
        <div><span>导出权限</span><strong>{props.selectedCount < 1 ? '请选择资源' : props.canExportCsv && props.canExportExcel ? '可导出 CSV / Excel' : '当前选择里有资源不允许导出'}</strong></div>
      </div>
      <div className="global-tag-command">
        <div className="global-tag-heading"><span><Tags aria-hidden="true" /><strong>批量增加商品标签</strong></span><small>{tagBlock ?? '当前选择可批量加标签'}</small></div>
        {props.tagsLoading ? <p className="muted-copy">正在读取版本化标签库...</p> : null}
        {props.tagsError ? <p className="batch-preview-error" role="alert">{humanizeError(props.tagsError)}</p> : null}
        <fieldset className="global-tag-options" disabled={!props.canAddTags || Boolean(props.pendingOperation)}><legend>启用标签</legend>{props.enabledTags.length ? props.enabledTags.map((tag) => <label key={tag.tagId}><input type="checkbox" checked={props.selectedTagIds.includes(tag.tagId)} onChange={() => toggleTag(tag.tagId)} />{tag.name}<small>{tag.tagId}</small></label>) : <p>没有可用标签</p>}</fieldset>
        <div className="global-tag-footer"><button className="button button-primary" type="button" disabled={!props.canAddTags || props.selectedTagIds.length < 1 || Boolean(props.pendingOperation)} onClick={props.onAddTags}><Tags aria-hidden="true" />{props.pendingOperation === 'ADD_PRODUCT_TAGS' ? '写入中' : '批量加标签'}</button></div>
      </div>
      <div className="global-lifecycle-command">
        <div className="global-tag-heading"><span><ClipboardCheck aria-hidden="true" /><strong>商品生命周期批处理</strong></span><small>{lifecycleSummary}</small></div>
        <div className="global-lifecycle-actions" aria-label="商品生命周期动作">{lifecycleActions.map(({ action, capability, label, Icon }) => {
          const allowed = lifecycleAllowed(action);
          const blockedReason = lifecycleBlockReason(props.selectedResources, capability);
          return <button className={['REJECT', 'HIDE', 'DELIST'].includes(action) ? 'button button-danger' : 'button button-quiet'} key={action} type="button" disabled={!allowed || Boolean(props.pendingOperation) || Boolean(selectedLifecycle)} title={allowed ? `${capability} 已允许` : blockedReason} onClick={() => props.onLifecycleActionChange(action)}><Icon aria-hidden="true" />{label}</button>;
        })}</div>
        {selectedLifecycle && SelectedLifecycleIcon ? (
          <section className="global-lifecycle-confirm" aria-labelledby="global-lifecycle-confirm-title" aria-live="polite">
            <div className="global-lifecycle-confirm-heading"><AlertTriangle aria-hidden="true" /><div><strong id="global-lifecycle-confirm-title">确认{selectedLifecycle.label}</strong><p>将对当前选中的 {props.selectedCount} 个商品一起处理；任一商品被系统拒绝时全部不生效。</p></div></div>
            <div className="global-lifecycle-fields">
              <label>处理意见，可不填<input value={props.lifecycleReasonCode} onChange={(event) => props.onLifecycleReasonChange(event.target.value)} pattern="[A-Z][A-Z0-9_]{1,63}" minLength={2} maxLength={64} placeholder="不填则自动生成" autoComplete="off" disabled={lifecycleBusy || Boolean(props.operationError)} /></label>

            </div>
            {props.operationError ? <p className="global-lifecycle-retry" role="alert"><Ban aria-hidden="true" /><span><strong>{humanizeError(props.operationError)}</strong>请确认选择和原因没有变，再重试。</span></p> : <p className="muted-copy">确认后系统会自动生成提交编号；成功后自动刷新当前检索。</p>}
            <div className="button-row"><button className="button button-quiet" type="button" onClick={props.onLifecycleCancel} disabled={lifecycleBusy}>取消</button><button className={['REJECT', 'HIDE', 'DELIST'].includes(selectedLifecycle.action) ? 'button button-danger' : 'button button-primary'} type="button" onClick={props.onLifecycleConfirm} disabled={!lifecycleAllowed(selectedLifecycle.action) || (props.lifecycleReasonCode.trim() !== '' && !reasonCodePattern.test(props.lifecycleReasonCode.trim())) || Boolean(props.pendingOperation)}><SelectedLifecycleIcon aria-hidden="true" />{lifecycleBusy ? '执行中' : `确认${selectedLifecycle.label}`}</button></div>
          </section>
        ) : null}
      </div>
      <p className="batch-reason">导出内容由系统生成并记录；标签和商品状态命令只对已授权的商品生效。电子面单与自提打印在物流模块处理。</p>
    </section>
  );
}

function BatchTagEvidence({ result }: { result: AdminProductBatchTagResult }) {
  return <section className="panel global-operation-evidence" aria-labelledby="batch-tag-evidence-title"><div className="panel-heading"><div><p className="section-kicker">批量标签结果</p><h2 id="batch-tag-evidence-title">标签版本凭证</h2></div><ShieldCheck aria-hidden="true" /></div><dl><div><dt>操作编号</dt><dd><code title={result.operationId}>{shortId(result.operationId)}</code></dd></div><div><dt>已变更</dt><dd>{result.changedCount} / {result.products.length}</dd></div><div><dt>标签</dt><dd>{result.tagIds.map((id) => shortId(id)).join(' · ')}</dd></div><div><dt>完成时间</dt><dd>{formatDate(result.createdAt)}</dd></div></dl><div className="global-version-list">{result.products.map((product) => <span key={product.productId}><code title={product.productId}>{shortId(product.productId)}</code><strong>v{product.previousVersion} → v{product.version}</strong><small>{product.addedTagIds.length ? product.addedTagIds.map((id) => shortId(id)).join(' · ') : '没有新增标签'}</small></span>)}</div></section>;
}

function BatchLifecycleEvidence({ result }: { result: AdminProductLifecycleBatchResult }) {
  return <section className="panel global-operation-evidence" aria-labelledby="batch-lifecycle-evidence-title"><div className="panel-heading"><div><p className="section-kicker">批量状态结果</p><h2 id="batch-lifecycle-evidence-title">商品状态凭证</h2></div><ShieldCheck aria-hidden="true" /></div><dl><div><dt>操作编号</dt><dd><code title={result.operationId}>{shortId(result.operationId)}</code></dd></div><div><dt>已变更</dt><dd>{result.changedCount} / {result.products.length}</dd></div><div><dt>操作</dt><dd>{lifecycleActionLabel(result.action)}</dd></div><div><dt>完成时间</dt><dd>{formatDate(result.createdAt)}</dd></div></dl><div className="global-version-list">{result.products.map((product) => <span key={product.productId}><code title={product.productId}>{shortId(product.productId)}</code><strong>{commonStateLabel(product.previousState)} → {commonStateLabel(product.state)}</strong><small>{lifecycleActionLabel(result.action)}</small></span>)}</div></section>;
}

function SearchLoading() {
  return <section className="panel global-loading" role="status" aria-label="正在检索全局资源"><RefreshCw className="spin" aria-hidden="true" /><span /><span /><span /></section>;
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error global-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>;
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
    ...(trim(form.uid) ? { uid: trim(form.uid) } : {}),
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
  return reasonLabel(blocked?.reasonCode) ?? '系统暂未授权批量加标签';
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
  return reasonLabel(blocked?.reasonCode) ?? `系统暂未授权${batchActionLabel(capability)}`;
}

function resourceKey(resource: Pick<AdminResourceSummary, 'resourceType' | 'resourceId'>) {
  return `${resource.resourceType}\u0000${resource.resourceId}`;
}

function resourceTypeLabel(type: AdminResourceType) {
  return ({ ORDER: '订单', PRODUCT: '商品', MERCHANT: '商家' } as const)[type];
}

function batchActionLabel(action: AdminBatchAction) {
  return ({
    ADD_PRODUCT_TAGS: '批量加标签',
    PRODUCT_APPROVE: '批量审核通过',
    PRODUCT_REJECT: '批量审核拒绝',
    PRODUCT_PUBLISH: '批量上架',
    PRODUCT_HIDE: '批量隐藏',
    PRODUCT_DELIST: '批量下架',
    EXPORT: '导出',
  } as Partial<Record<AdminBatchAction, string>>)[action] ?? action;
}

function normalizedReason(value: string, fallback: string) {
  const normalized = value.trim().toUpperCase();
  return reasonCodePattern.test(normalized) ? normalized : fallback;
}

function defaultLifecycleReason(action: CatalogReviewDecision) {
  return ({
    APPROVE: 'OPERATIONS_APPROVED',
    REJECT: 'OPERATIONS_REJECTED',
    PUBLISH: 'OPERATIONS_PUBLISHED',
    HIDE: 'OPERATIONS_HIDDEN',
    DELIST: 'OPERATIONS_DELISTED',
  } as const)[action];
}

function reasonLabel(value: string | null | undefined) {
  if (!value) return null;
  return ({
    LOCKED: '被锁定，暂不可改',
    SCHEDULED: '已有排期，暂不可改',
    STATE_NOT_ALLOWED: '当前状态不允许',
    ROLE_NOT_ALLOWED: '当前角色不允许',
    MISSING_PERMISSION: '缺少操作权限',
    NOT_PRODUCT: '不是商品资源',
  } as Record<string, string>)[value] ?? value.replaceAll('_', ' ').toLowerCase();
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
