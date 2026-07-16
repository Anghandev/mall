import {
  logisticsCarrierCodes,
  logisticsWarehouseKinds,
  waybillProviders,
  type AdminPrintJobList,
  type AdminWaybillBatchRequest,
  type AdminWaybillList,
  type LogisticsCarrierCode,
  type LogisticsCarrierConfig,
  type LogisticsProviderConfigList,
  type LogisticsProviderConfigRequest,
  type LogisticsWarehouse,
  type LogisticsWarehouseList,
  type LogisticsWarehouseRequest,
  type WaybillProvider,
} from '@abu24k/core-artifacts';
import {
  Ban,
  Building2,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  PackagePlus,
  Pencil,
  Plus,
  Power,
  Printer,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Truck,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CoreApiError,
  createAdminLogisticsCarrierConfigVersion,
  createAdminLogisticsProviderConfigVersion,
  createAdminLogisticsWarehouse,
  createAdminWaybillBatch,
  deactivateAdminLogisticsWarehouse,
  fetchAdminLogisticsCarrierConfig,
  fetchAdminLogisticsProviderConfigs,
  fetchAdminLogisticsWarehouses,
  fetchAdminPrintJobs,
  fetchAdminWaybills,
  retryAdminPrintJob,
  updateAdminLogisticsWarehouse,
} from '../coreApi';
import { useCoreSession } from '../coreSession';

type View = 'CARRIERS' | 'WAREHOUSES' | 'OPERATIONS';
type LogisticsData = {
  carriers: LogisticsCarrierConfig;
  providers: LogisticsProviderConfigList;
  warehouses: LogisticsWarehouseList;
  waybills: AdminWaybillList;
  printJobs: AdminPrintJobList;
};

const emptyCarrierState = Object.fromEntries(logisticsCarrierCodes.map((code) => [code, false])) as Record<LogisticsCarrierCode, boolean>;
const emptyWarehouse: LogisticsWarehouseRequest = {
  warehouseKind: 'PLATFORM', name: '', partnerName: null, contactName: '', phone: '', regionCode: '', addressLine: '', enabled: true, idempotencyKey: '',
};
const emptyProvider: LogisticsProviderConfigRequest = {
  provider: 'KUAIDI100', enabled: true, partnerIdSecretRef: '', credentialSecretRef: '', monthlyAccountSecretRef: '', callbackSecretRef: '', idempotencyKey: '',
};
const emptyWaybill: AdminWaybillBatchRequest = {
  merchantId: '', provider: 'KUAIDI100', carrierCode: 'SF', storeId: '', orderIds: [], idempotencyKey: '',
};

export function LogisticsPage() {
  const { connect, session, status } = useCoreSession();
  const [view, setView] = useState<View>('CARRIERS');
  const [data, setData] = useState<LogisticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<CoreApiError | null>(null);
  const [actionError, setActionError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [merchantFilterDraft, setMerchantFilterDraft] = useState('');
  const [merchantFilter, setMerchantFilter] = useState('');
  const roles = session?.roles ?? [];
  const canRead = roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role));
  const canWrite = roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role));
  const isAuditor = roles.includes('AUDITOR') && !canWrite;

  useEffect(() => {
    if (!session || !canRead) { setData(null); setLoadError(null); return; }
    const controller = new AbortController();
    setLoading(true); setLoadError(null);
    Promise.all([
      fetchAdminLogisticsCarrierConfig(session.token, controller.signal),
      fetchAdminLogisticsProviderConfigs(session.token, controller.signal),
      fetchAdminLogisticsWarehouses(session.token, controller.signal),
      fetchAdminWaybills(session.token, merchantFilter || undefined, 50, controller.signal),
      fetchAdminPrintJobs(session.token, merchantFilter || undefined, 50, controller.signal),
    ]).then(([carriers, providers, warehouses, waybills, printJobs]) => setData({ carriers, providers, warehouses, waybills, printJobs }))
      .catch((cause) => { if (!controller.signal.aborted) setLoadError(asCoreError(cause, '物流 Core 投影不可用')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canRead, merchantFilter, reloadKey, session]);

  const runAction = async (action: () => Promise<string>) => {
    setLoading(true); setActionError(null); setNotice('');
    try { setNotice(await action()); setReloadKey((value) => value + 1); }
    catch (cause) { setActionError(asCoreError(cause, '物流写入未被 Core 接受')); }
    finally { setLoading(false); }
  };

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><Truck aria-hidden="true" /></div>
        <div><p className="eyebrow">LOGISTICS CONTROL</p><h1>物流配置</h1><p>六家承运商、Provider 密钥引用、加密仓库、跨商家面单与打印重试均直接消费 Core 发布接口。</p></div>
        <div className="requirement-list"><code>ADM-LOG-001</code><code>ADM-LOG-002</code><code>ADM-LOG-003</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt logistics-session-prompt" role="status" aria-label="物流数据状态">
          <div><strong>连接平台钱包</strong><p>ADMIN / OPERATOR 可维护配置和作业；AUDITOR 仅接收脱敏只读投影。</p></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : 'SIWE 连接'}</button>
        </section>
      ) : !canRead ? <CoreErrorState error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有物流读取权限', status: 403 })} /> : (
        <>
          <section className="logistics-toolbar" aria-label="物流工作区导航">
            <div className="merchant-status-tabs" role="tablist" aria-label="物流视图">
              <ViewTab active={view === 'CARRIERS'} onClick={() => setView('CARRIERS')}>承运与 Provider</ViewTab>
              <ViewTab active={view === 'WAREHOUSES'} onClick={() => setView('WAREHOUSES')}>仓库</ViewTab>
              <ViewTab active={view === 'OPERATIONS'} onClick={() => setView('OPERATIONS')}>面单与打印</ViewTab>
            </div>
            <button className="icon-button light-icon-button" type="button" aria-label="刷新物流数据" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}><RefreshCw className={loading ? 'spin' : undefined} aria-hidden="true" /></button>
          </section>
          {isAuditor ? <div className="logistics-auditor-note" role="status"><ShieldCheck aria-hidden="true" /><span><strong>AUDITOR 只读</strong>仓库联系人、电话和地址由 Core 返回脱敏投影；页面不提供写入控件。</span></div> : null}
          {notice ? <div className="catalog-notice" role="status"><CheckCircle2 aria-hidden="true" />{notice}</div> : null}
          {loadError ? <CoreErrorState error={loadError} /> : null}
          {actionError ? <CoreErrorState error={actionError} /> : null}
          {loading && !data ? <LoadingState /> : null}
          {data && view === 'CARRIERS' ? <CarrierProviderView data={data} token={session.token} canWrite={canWrite} loading={loading} runAction={runAction} /> : null}
          {data && view === 'WAREHOUSES' ? <WarehouseView warehouses={data.warehouses.warehouses} token={session.token} canWrite={canWrite} loading={loading} runAction={runAction} /> : null}
          {data && view === 'OPERATIONS' ? <OperationsView data={data} token={session.token} canWrite={canWrite} loading={loading} merchantFilterDraft={merchantFilterDraft} setMerchantFilterDraft={setMerchantFilterDraft} applyMerchantFilter={(event) => { event.preventDefault(); setMerchantFilter(merchantFilterDraft.trim()); }} runAction={runAction} /> : null}
        </>
      )}
    </>
  );
}

function CarrierProviderView({ data, token, canWrite, loading, runAction }: { data: LogisticsData; token: string; canWrite: boolean; loading: boolean; runAction(action: () => Promise<string>): Promise<void> }) {
  const [carrierEnabled, setCarrierEnabled] = useState({ ...emptyCarrierState });
  const [defaultCarrierCode, setDefaultCarrierCode] = useState<LogisticsCarrierCode>('SF');
  const [carrierIdempotencyKey, setCarrierIdempotencyKey] = useState('');
  const [provider, setProvider] = useState({ ...emptyProvider });
  useEffect(() => {
    setCarrierEnabled(Object.fromEntries(data.carriers.carriers.map((item) => [item.carrierCode, item.enabled])) as Record<LogisticsCarrierCode, boolean>);
    setDefaultCarrierCode(data.carriers.defaultCarrierCode ?? 'SF');
  }, [data.carriers]);
  const saveCarriers = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const next = await createAdminLogisticsCarrierConfigVersion({ carriers: logisticsCarrierCodes.map((carrierCode) => ({ carrierCode, enabled: carrierEnabled[carrierCode] })), defaultCarrierCode, idempotencyKey: carrierIdempotencyKey }, token);
      setCarrierIdempotencyKey('');
      return `承运商配置已激活为 v${next.version}`;
    });
  };
  const saveProvider = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const next = await createAdminLogisticsProviderConfigVersion(provider, token);
      setProvider({ ...emptyProvider, provider: next.provider, enabled: next.enabled });
      return `${next.provider} 密钥引用版本 v${next.version} 已提交；输入已清除`;
    });
  };
  return <section className="logistics-grid logistics-config-grid">
    <article className="panel logistics-panel">
      <div className="panel-heading"><div><p className="section-kicker">GET carriers · POST carrier-versions</p><h2>承运商策略</h2></div><span className={`status-chip ${data.carriers.readiness === 'READY' ? 'status-ready' : 'status-blocked'}`}>{data.carriers.readiness}</span></div>
      <p className="muted-copy">当前版本 v{data.carriers.version}。默认承运商必须保持启用，配置始终提交完整六家集合。</p>
      <form className="admin-editor-form logistics-form" onSubmit={saveCarriers}>
        <fieldset className="carrier-toggle-grid" disabled={!canWrite || loading}>
          <legend>六家内置承运商</legend>
          {logisticsCarrierCodes.map((code) => <label className="carrier-toggle" key={code}><input type="checkbox" checked={carrierEnabled[code]} onChange={(event) => setCarrierEnabled({ ...carrierEnabled, [code]: event.target.checked })} /><span>{code}</span></label>)}
        </fieldset>
        <div className="form-grid"><label>默认承运商<select value={defaultCarrierCode} onChange={(event) => setDefaultCarrierCode(event.target.value as LogisticsCarrierCode)} disabled={!canWrite}>{logisticsCarrierCodes.map((code) => <option key={code} disabled={!carrierEnabled[code]}>{code}</option>)}</select></label><label>Idempotency key<input value={carrierIdempotencyKey} onChange={(event) => setCarrierIdempotencyKey(event.target.value)} minLength={8} maxLength={128} disabled={!canWrite} required /></label></div>
        {canWrite ? <button className="button button-primary" type="submit" disabled={loading || carrierIdempotencyKey.length < 8 || !carrierEnabled[defaultCarrierCode]}><Save aria-hidden="true" />保存新版本</button> : null}
      </form>
    </article>
    <article className="panel logistics-panel">
      <div className="panel-heading"><div><p className="section-kicker">GET providers · POST provider-versions</p><h2>Provider 引用</h2></div><span className="status-chip">{data.providers.providers.length} 个</span></div>
      {!data.providers.providers.length ? <EmptyState icon={ShieldCheck} text="Core 返回真实空 Provider 列表" /> : <div className="provider-status-list">{data.providers.providers.map((item) => <div className="provider-status" key={item.provider}><span><strong>{item.provider}</strong><small>v{item.version} · {item.enabled ? 'ENABLED' : 'DISABLED'}</small></span><span className={`status-chip ${item.readiness === 'READY' ? 'status-ready' : 'status-blocked'}`}>{item.readiness}</span><dl>{Object.entries(item.configuredFields).map(([field, configured]) => <div key={field}><dt>{field}</dt><dd>{configured ? '已配置' : '缺失'}</dd></div>)}</dl></div>)}</div>}
      {canWrite ? <form className="admin-editor-form logistics-form" onSubmit={saveProvider} autoComplete="off"><h3>提交密钥引用版本</h3><div className="form-grid"><label>Provider<select value={provider.provider} onChange={(event) => setProvider({ ...provider, provider: event.target.value as WaybillProvider })}>{waybillProviders.map((value) => <option key={value}>{value}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={provider.enabled} onChange={(event) => setProvider({ ...provider, enabled: event.target.checked })} />启用 Provider</label><SecretRef label="Partner ID secret ref" value={provider.partnerIdSecretRef} onChange={(value) => setProvider({ ...provider, partnerIdSecretRef: value })} /><SecretRef label="Credential secret ref" value={provider.credentialSecretRef} onChange={(value) => setProvider({ ...provider, credentialSecretRef: value })} /><SecretRef label="Monthly account secret ref" value={provider.monthlyAccountSecretRef} onChange={(value) => setProvider({ ...provider, monthlyAccountSecretRef: value })} /><SecretRef label="Callback secret ref" value={provider.callbackSecretRef} onChange={(value) => setProvider({ ...provider, callbackSecretRef: value })} /><label>Idempotency key<input value={provider.idempotencyKey} onChange={(event) => setProvider({ ...provider, idempotencyKey: event.target.value })} minLength={8} maxLength={128} required /></label></div><p className="button-explanation">提交后立即清空输入。Core 响应和此页面只显示配置完整度，不回显引用值。</p><button className="button button-primary" type="submit" disabled={loading || provider.idempotencyKey.length < 8}><ShieldCheck aria-hidden="true" />提交引用版本</button></form> : null}
    </article>
  </section>;
}

function WarehouseView({ warehouses, token, canWrite, loading, runAction }: { warehouses: readonly LogisticsWarehouse[]; token: string; canWrite: boolean; loading: boolean; runAction(action: () => Promise<string>): Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(warehouses[0]?.warehouseId ?? null);
  const selected = warehouses.find((warehouse) => warehouse.warehouseId === selectedId) ?? null;
  const [input, setInput] = useState({ ...emptyWarehouse });
  useEffect(() => {
    if (!selected || selected.access === 'REDACTED') { setInput({ ...emptyWarehouse }); return; }
    setInput({ warehouseKind: selected.warehouseKind, name: selected.name, partnerName: selected.partnerName, contactName: selected.contactName ?? '', phone: selected.phone ?? '', regionCode: selected.regionCode, addressLine: selected.addressLine ?? '', enabled: selected.enabled, idempotencyKey: '' });
  }, [selected]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      if (selected) {
        const next = await updateAdminLogisticsWarehouse(selected.warehouseId, { ...input, expectedVersion: selected.version }, token);
        return `仓库 ${next.warehouseId} 已更新为 v${next.version}`;
      }
      const next = await createAdminLogisticsWarehouse(input, token);
      setSelectedId(next.warehouseId);
      return `仓库 ${next.warehouseId} 已创建`;
    });
  };
  const deactivate = () => {
    if (!selected) return;
    void runAction(async () => {
      const next = await deactivateAdminLogisticsWarehouse(selected.warehouseId, { expectedVersion: selected.version, idempotencyKey: input.idempotencyKey }, token);
      return `仓库 ${next.warehouseId} 已停用`;
    });
  };
  return <section className="logistics-grid warehouse-grid">
    <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/logistics/warehouses</p><h2>加密仓库版本</h2></div>{canWrite ? <button className="button button-quiet" type="button" onClick={() => setSelectedId(null)}><Plus aria-hidden="true" />新建仓库</button> : null}</div>
      {!warehouses.length ? <EmptyState icon={Building2} text="Core 返回真实空仓库列表" /> : <div className="warehouse-list" role="list">{warehouses.map((warehouse) => <button type="button" className={selectedId === warehouse.warehouseId ? 'warehouse-row is-selected' : 'warehouse-row'} key={warehouse.warehouseId} onClick={() => setSelectedId(warehouse.warehouseId)}><span><strong>{warehouse.name}</strong><small>{warehouse.warehouseId} · v{warehouse.version}</small></span><span className={`status-chip ${warehouse.enabled ? 'status-ready' : 'status-blocked'}`}>{warehouse.enabled ? 'ACTIVE' : 'INACTIVE'}</span><small>{warehouse.warehouseKind} · {warehouse.regionCode} · {warehouse.access}</small></button>)}</div>}
    </article>
    <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">POST / PUT / deactivate</p><h2>{selected ? '仓库详情与版本' : '创建仓库'}</h2></div>{selected ? <Pencil aria-hidden="true" /> : <PackagePlus aria-hidden="true" />}</div>
      {selected?.access === 'REDACTED' ? <div className="warehouse-redacted"><ShieldCheck aria-hidden="true" /><h3>Core 脱敏投影</h3><dl><div><dt>联系人</dt><dd>已脱敏</dd></div><div><dt>电话</dt><dd>已脱敏</dd></div><div><dt>地址</dt><dd>已脱敏</dd></div><div><dt>Payload hash</dt><dd><code>{selected.payloadHash}</code></dd></div></dl></div> : canWrite ? <form className="admin-editor-form logistics-form" onSubmit={submit}><div className="form-grid"><label>仓库类型<select value={input.warehouseKind} onChange={(event) => setInput({ ...input, warehouseKind: event.target.value as LogisticsWarehouseRequest['warehouseKind'], partnerName: event.target.value === 'PARTNER' ? input.partnerName ?? '' : null })}>{logisticsWarehouseKinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>名称<input value={input.name} onChange={(event) => setInput({ ...input, name: event.target.value })} minLength={2} maxLength={80} required /></label>{input.warehouseKind === 'PARTNER' ? <label>合作方名称<input value={input.partnerName ?? ''} onChange={(event) => setInput({ ...input, partnerName: event.target.value })} minLength={2} maxLength={80} required /></label> : null}<label>联系人<input value={input.contactName} onChange={(event) => setInput({ ...input, contactName: event.target.value })} required /></label><label>电话<input value={input.phone} onChange={(event) => setInput({ ...input, phone: event.target.value })} required /></label><label>地区代码<input value={input.regionCode} onChange={(event) => setInput({ ...input, regionCode: event.target.value })} required /></label><label className="form-span">地址<input value={input.addressLine} onChange={(event) => setInput({ ...input, addressLine: event.target.value })} required /></label><label>Idempotency key<input value={input.idempotencyKey} onChange={(event) => setInput({ ...input, idempotencyKey: event.target.value })} minLength={8} maxLength={128} required /></label><label className="checkbox-label"><input type="checkbox" checked={input.enabled} onChange={(event) => setInput({ ...input, enabled: event.target.checked })} />启用仓库</label></div><div className="logistics-actions"><button className="button button-primary" type="submit" disabled={loading || input.idempotencyKey.length < 8}><Save aria-hidden="true" />{selected ? '保存新版本' : '创建仓库'}</button>{selected?.enabled ? <button className="button button-danger" type="button" onClick={deactivate} disabled={loading || input.idempotencyKey.length < 8}><Power aria-hidden="true" />停用仓库</button> : null}</div></form> : <div className="warehouse-redacted"><ShieldCheck aria-hidden="true" /><h3>只读仓库投影</h3><p>选择左侧仓库查看 Core 返回的脱敏状态。</p></div>}
    </article>
  </section>;
}

function OperationsView(props: { data: LogisticsData; token: string; canWrite: boolean; loading: boolean; merchantFilterDraft: string; setMerchantFilterDraft(value: string): void; applyMerchantFilter(event: FormEvent): void; runAction(action: () => Promise<string>): Promise<void> }) {
  const { data, token, canWrite, loading, merchantFilterDraft, setMerchantFilterDraft, applyMerchantFilter, runAction } = props;
  const [waybill, setWaybill] = useState({ ...emptyWaybill });
  const [orderIds, setOrderIds] = useState('');
  const retryableJobs = useMemo(() => data.printJobs.printJobs.filter((job) => ['RETRYABLE', 'FAILED', 'CONFIGURATION_REQUIRED'].includes(job.state)), [data.printJobs.printJobs]);
  const [printJobId, setPrintJobId] = useState('');
  const [retryKey, setRetryKey] = useState('');
  useEffect(() => { if (!retryableJobs.some((job) => job.printJobId === printJobId)) setPrintJobId(retryableJobs[0]?.printJobId ?? ''); }, [printJobId, retryableJobs]);
  const submitWaybill = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const ids = orderIds.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
      const next = await createAdminWaybillBatch({ ...waybill, orderIds: ids }, token);
      setOrderIds(''); setWaybill({ ...emptyWaybill, merchantId: waybill.merchantId, storeId: waybill.storeId });
      return `面单批次 ${next.batchId} 已创建，共 ${next.items.length} 项`;
    });
  };
  const retry = (event: FormEvent) => {
    event.preventDefault(); if (!printJobId) return;
    void runAction(async () => {
      const next = await retryAdminPrintJob(printJobId, { idempotencyKey: retryKey }, token);
      setRetryKey('');
      return `打印作业 ${next.printJobId} 已进入 ${next.state}`;
    });
  };
  return <>
    <section className="panel logistics-filter"><form className="inline-query-form" role="search" onSubmit={applyMerchantFilter}><label>商家筛选<input value={merchantFilterDraft} onChange={(event) => setMerchantFilterDraft(event.target.value)} maxLength={256} placeholder="留空读取跨商家列表" /></label><button className="button button-quiet" type="submit" disabled={loading}><RefreshCw aria-hidden="true" />读取列表</button></form></section>
    <section className="logistics-grid operations-grid">
      <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">POST /v2/admin/logistics/waybills/batches</p><h2>跨商家面单</h2></div><PackagePlus aria-hidden="true" /></div>{canWrite ? <form className="admin-editor-form logistics-form" onSubmit={submitWaybill}><div className="form-grid"><label>商家 ID<input value={waybill.merchantId} onChange={(event) => setWaybill({ ...waybill, merchantId: event.target.value })} required /></label><label>门店 ID<input value={waybill.storeId} onChange={(event) => setWaybill({ ...waybill, storeId: event.target.value })} required /></label><label>Provider<select value={waybill.provider} onChange={(event) => setWaybill({ ...waybill, provider: event.target.value as WaybillProvider })}>{waybillProviders.map((value) => <option key={value}>{value}</option>)}</select></label><label>承运商<select value={waybill.carrierCode} onChange={(event) => setWaybill({ ...waybill, carrierCode: event.target.value as LogisticsCarrierCode })}>{logisticsCarrierCodes.map((value) => <option key={value}>{value}</option>)}</select></label><label>Idempotency key<input value={waybill.idempotencyKey} onChange={(event) => setWaybill({ ...waybill, idempotencyKey: event.target.value })} minLength={8} maxLength={128} required /></label></div><label>订单 ID · 每行或逗号分隔<textarea value={orderIds} onChange={(event) => setOrderIds(event.target.value)} rows={5} required /></label><button className="button button-primary" type="submit" disabled={loading || waybill.idempotencyKey.length < 8 || !orderIds.trim()}><PackagePlus aria-hidden="true" />创建面单批次</button></form> : <p className="muted-copy">当前角色只可读取跨商家面单证据。</p>}</article>
      <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">GET print-jobs · POST retry</p><h2>打印重试</h2></div><Printer aria-hidden="true" /></div>{canWrite ? <form className="admin-editor-form logistics-form" onSubmit={retry}><label>可重试作业<select value={printJobId} onChange={(event) => setPrintJobId(event.target.value)} disabled={!retryableJobs.length}>{retryableJobs.map((job) => <option key={job.printJobId} value={job.printJobId}>{shortId(job.printJobId)} · {job.state}</option>)}</select></label><label>Idempotency key<input value={retryKey} onChange={(event) => setRetryKey(event.target.value)} minLength={8} maxLength={128} required /></label><button className="button button-primary" type="submit" disabled={loading || !printJobId || retryKey.length < 8}><RotateCcw aria-hidden="true" />重试打印作业</button></form> : null}{!retryableJobs.length ? <EmptyState icon={Printer} text="当前没有可重试打印作业" /> : null}</article>
    </section>
    <section className="logistics-lists">
      <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/logistics/waybills</p><h2>面单记录</h2></div><span className="status-chip">{data.waybills.waybills.length}</span></div>{!data.waybills.waybills.length ? <EmptyState icon={PackagePlus} text="Core 返回真实空面单列表" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>订单 / 商家</th><th>Provider / 承运商</th><th>状态</th><th>运单号</th><th>更新时间</th></tr></thead><tbody>{data.waybills.waybills.map((item) => <tr key={item.requestId}><td><strong>{item.orderId}</strong><small>{item.merchantId}</small></td><td>{item.provider} / {item.carrierCode}</td><td>{item.state}</td><td>{item.trackingNumber ?? '未生成'}</td><td>{item.updatedAt}</td></tr>)}</tbody></table></div>}</article>
      <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/logistics/print-jobs</p><h2>打印作业</h2></div><span className="status-chip">{data.printJobs.printJobs.length}</span></div>{!data.printJobs.printJobs.length ? <EmptyState icon={Printer} text="Core 返回真实空打印列表" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>作业 / 订单</th><th>类型</th><th>Provider / 设备</th><th>状态</th><th>尝试</th></tr></thead><tbody>{data.printJobs.printJobs.map((job) => <tr key={job.printJobId}><td><code>{shortId(job.printJobId)}</code><small>{job.orderId} · {job.merchantId}</small></td><td>{job.jobKind}</td><td>{job.provider ?? '未绑定'} / {job.deviceId ?? '未绑定'}</td><td>{job.state}</td><td>{job.attempts}</td></tr>)}</tbody></table></div>}</article>
    </section>
  </>;
}

function SecretRef({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) { return <label>{label}<input type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete="new-password" minLength={8} maxLength={256} required /></label>; }
function ViewTab({ active, onClick, children }: { active: boolean; onClick(): void; children: string }) { return <button type="button" role="tab" aria-selected={active} className={active ? 'is-active' : ''} onClick={onClick}>{children}</button>; }
function LoadingState() { return <div className="resource-state logistics-loading" role="status" aria-busy="true"><LoaderCircle className="spin" aria-hidden="true" /><div><strong>正在读取 Core 物流投影</strong><p>配置、仓库、面单和打印作业均等待真实响应。</p></div></div>; }
function CoreErrorState({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error logistics-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p>{error.correlationId ? <code>{error.correlationId}</code> : null}</div></div>; }
function EmptyState({ icon: Icon, text }: { icon: typeof Truck; text: string }) { return <div className="logistics-empty" role="status"><Icon aria-hidden="true" /><span>{text}</span></div>; }
function shortId(value: string) { return `${value.slice(0, 8)}…${value.slice(-6)}`; }
function asCoreError(cause: unknown, message: string) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message, status: 503 }); }
