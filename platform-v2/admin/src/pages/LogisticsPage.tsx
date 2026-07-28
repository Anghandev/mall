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
import { useSearchParams } from 'react-router-dom';
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
import { humanizeError } from '../display';

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
const emptyprovider: LogisticsProviderConfigRequest = {
  provider: 'KUAIDI100', enabled: true, partnerIdSecretRef: '', credentialSecretRef: '', monthlyAccountSecretRef: '', callbackSecretRef: '', idempotencyKey: '',
};
const emptyWaybill: AdminWaybillBatchRequest = {
  merchantId: '', provider: 'KUAIDI100', carrierCode: 'SF', storeId: '', orderIds: [], idempotencyKey: '',
};

export function LogisticsPage() {
  const { connect, session, status } = useCoreSession();
  const [searchParams] = useSearchParams();
  const presetKey = searchParams.toString();
  const operationsPreset = useMemo(() => readOperationsPreset(searchParams), [searchParams]);
  const [view, setView] = useState<View>(operationsPreset.open ? 'OPERATIONS' : 'CARRIERS');
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
    if (operationsPreset.open) setView('OPERATIONS');
  }, [operationsPreset.open, presetKey]);

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
      .catch((cause) => { if (!controller.signal.aborted) setLoadError(asCoreError(cause, '物流数据暂时无法连接')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canRead, merchantFilter, reloadKey, session]);

  const runAction = async (action: () => Promise<string>) => {
    setLoading(true); setActionError(null); setNotice('');
    try { setNotice(await action()); setReloadKey((value) => value + 1); }
    catch (cause) { setActionError(asCoreError(cause, '物流写入未被系统接受')); }
    finally { setLoading(false); }
  };

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><Truck aria-hidden="true" /></div>
        <div><p className="eyebrow">物流管理</p><h1>物流配置</h1><p>维护承运商、物流服务、仓库、面单和打印重试；页面只展示系统确认结果。</p></div>
        <div className="requirement-list"><code>承运商</code><code>仓库面单</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt logistics-session-prompt" role="status" aria-label="物流数据状态">
          <div><strong>连接平台钱包</strong><p>管理员和运营可维护配置；审计只能查看脱敏信息。</p></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : '钱包登录'}</button>
        </section>
      ) : !canRead ? <CoreErrorState error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有物流读取权限', status: 403 })} /> : (
        <>
          <section className="logistics-toolbar" aria-label="物流工作区导航">
            <div className="merchant-status-tabs" role="tablist" aria-label="物流视图">
              <ViewTab active={view === 'CARRIERS'} onClick={() => setView('CARRIERS')}>承运与物流服务</ViewTab>
              <ViewTab active={view === 'WAREHOUSES'} onClick={() => setView('WAREHOUSES')}>仓库</ViewTab>
              <ViewTab active={view === 'OPERATIONS'} onClick={() => setView('OPERATIONS')}>面单与打印</ViewTab>
            </div>
            <button className="icon-button light-icon-button" type="button" aria-label="刷新物流数据" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}><RefreshCw className={loading ? 'spin' : undefined} aria-hidden="true" /></button>
          </section>
          {isAuditor ? <div className="logistics-auditor-note" role="status"><ShieldCheck aria-hidden="true" /><span><strong>审计只读</strong>仓库联系人、电话和地址已脱敏展示；页面不提供写入控件。</span></div> : null}
          {notice ? <div className="catalog-notice" role="status"><CheckCircle2 aria-hidden="true" />{notice}</div> : null}
          {loadError ? <CoreErrorState error={loadError} /> : null}
          {actionError ? <CoreErrorState error={actionError} /> : null}
          {loading && !data ? <LoadingState /> : null}
          {data && view === 'CARRIERS' ? <CarrierproviderView data={data} token={session.token} canWrite={canWrite} loading={loading} runAction={runAction} /> : null}
          {data && view === 'WAREHOUSES' ? <WarehouseView warehouses={data.warehouses.warehouses} token={session.token} canWrite={canWrite} loading={loading} runAction={runAction} /> : null}
          {data && view === 'OPERATIONS' ? <OperationsView key={presetKey} data={data} token={session.token} canWrite={canWrite} loading={loading} initialMerchantId={operationsPreset.merchantId} initialOrderIds={operationsPreset.orderIds} merchantFilterDraft={merchantFilterDraft} setMerchantFilterDraft={setMerchantFilterDraft} applyMerchantFilter={(event) => { event.preventDefault(); setMerchantFilter(merchantFilterDraft.trim()); }} runAction={runAction} /> : null}
        </>
      )}
    </>
  );
}

function CarrierproviderView({ data, token, canWrite, loading, runAction }: { data: LogisticsData; token: string; canWrite: boolean; loading: boolean; runAction(action: () => Promise<string>): Promise<void> }) {
  const [carrierEnabled, setCarrierEnabled] = useState({ ...emptyCarrierState });
  const [defaultCarrierCode, setDefaultCarrierCode] = useState<LogisticsCarrierCode>('SF');
  const [carrierIdempotencyKey, setCarrierIdempotencyKey] = useState(() => logisticsCommandKey('logistics-carriers'));
  const [provider, setprovider] = useState(() => ({ ...emptyprovider, idempotencyKey: logisticsCommandKey('logistics-provider') }));
  useEffect(() => {
    setCarrierEnabled(Object.fromEntries(data.carriers.carriers.map((item) => [item.carrierCode, item.enabled])) as Record<LogisticsCarrierCode, boolean>);
    setDefaultCarrierCode(data.carriers.defaultCarrierCode ?? 'SF');
  }, [data.carriers]);
  const saveCarriers = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const next = await createAdminLogisticsCarrierConfigVersion({ carriers: logisticsCarrierCodes.map((carrierCode) => ({ carrierCode, enabled: carrierEnabled[carrierCode] })), defaultCarrierCode, idempotencyKey: carrierIdempotencyKey }, token);
      setCarrierIdempotencyKey(logisticsCommandKey('logistics-carriers'));
      return `承运商配置已激活为 v${next.version}`;
    });
  };
  const saveprovider = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const next = await createAdminLogisticsProviderConfigVersion(provider, token);
      setprovider({ ...emptyprovider, provider: next.provider, enabled: next.enabled, idempotencyKey: logisticsCommandKey('logistics-provider') });
      return `${next.provider} 密钥引用版本 v${next.version} 已提交；输入已清除`;
    });
  };
  return <section className="logistics-grid logistics-config-grid">
    <article className="panel logistics-panel">
      <div className="panel-heading"><div><p className="section-kicker">承运商开关</p><h2>承运商策略</h2></div><span className={`status-chip ${data.carriers.readiness === 'READY' ? 'status-ready' : 'status-blocked'}`}>{readinessLabel(data.carriers.readiness)}</span></div>
      <p className="muted-copy">当前版本 v{data.carriers.version}。默认承运商必须保持启用，配置始终提交完整六家集合。</p>
      <form className="admin-editor-form logistics-form" onSubmit={saveCarriers}>
        <fieldset className="carrier-toggle-grid" disabled={!canWrite || loading}>
          <legend>六家内置承运商</legend>
          {logisticsCarrierCodes.map((code) => <label className="carrier-toggle" key={code}><input type="checkbox" checked={carrierEnabled[code]} onChange={(event) => setCarrierEnabled({ ...carrierEnabled, [code]: event.target.checked })} /><span>{code}</span></label>)}
        </fieldset>
        <div className="form-grid"><label>默认承运商<select value={defaultCarrierCode} onChange={(event) => setDefaultCarrierCode(event.target.value as LogisticsCarrierCode)} disabled={!canWrite}>{logisticsCarrierCodes.map((code) => <option key={code} disabled={!carrierEnabled[code]}>{code}</option>)}</select></label></div>
        {canWrite ? <button className="button button-primary" type="submit" disabled={loading || !carrierEnabled[defaultCarrierCode]}><Save aria-hidden="true" />保存新版本</button> : null}
      </form>
    </article>
    <article className="panel logistics-panel">
      <div className="panel-heading"><div><p className="section-kicker">物流服务密钥</p><h2>物流服务引用</h2></div><span className="status-chip">{data.providers.providers.length} 个</span></div>
      {!data.providers.providers.length ? <EmptyState icon={ShieldCheck} text="当前没有物流服务配置" /> : <div className="provider-status-list">{data.providers.providers.map((item) => <div className="provider-status" key={item.provider}><span><strong>{item.provider}</strong><small>v{item.version} · {item.enabled ? '已启用' : '已停用'}</small></span><span className={`status-chip ${item.readiness === 'READY' ? 'status-ready' : 'status-blocked'}`}>{readinessLabel(item.readiness)}</span><dl>{Object.entries(item.configuredFields).map(([field, configured]) => <div key={field}><dt>{providerFieldLabel(field)}</dt><dd>{configured ? '已配置' : '缺失'}</dd></div>)}</dl></div>)}</div>}
      {canWrite ? <form className="admin-editor-form logistics-form" onSubmit={saveprovider} autoComplete="off"><h3>提交密钥引用版本</h3><div className="form-grid"><label>物流服务<select value={provider.provider} onChange={(event) => setprovider({ ...provider, provider: event.target.value as WaybillProvider })}>{waybillProviders.map((value) => <option key={value}>{value}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={provider.enabled} onChange={(event) => setprovider({ ...provider, enabled: event.target.checked })} />启用物流服务</label><SecretRef label="合作方账号引用" value={provider.partnerIdSecretRef} onChange={(value) => setprovider({ ...provider, partnerIdSecretRef: value })} /><SecretRef label="接口密钥引用" value={provider.credentialSecretRef} onChange={(value) => setprovider({ ...provider, credentialSecretRef: value })} /><SecretRef label="月结账号引用" value={provider.monthlyAccountSecretRef} onChange={(value) => setprovider({ ...provider, monthlyAccountSecretRef: value })} /><SecretRef label="回调密钥引用" value={provider.callbackSecretRef} onChange={(value) => setprovider({ ...provider, callbackSecretRef: value })} /></div><p className="button-explanation">提交后立即清空输入。系统和页面只显示配置完整度，不回显引用值。</p><button className="button button-primary" type="submit" disabled={loading}><ShieldCheck aria-hidden="true" />提交引用版本</button></form> : null}
    </article>
  </section>;
}

function WarehouseView({ warehouses, token, canWrite, loading, runAction }: { warehouses: readonly LogisticsWarehouse[]; token: string; canWrite: boolean; loading: boolean; runAction(action: () => Promise<string>): Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(warehouses[0]?.warehouseId ?? null);
  const selected = warehouses.find((warehouse) => warehouse.warehouseId === selectedId) ?? null;
  const [input, setInput] = useState(() => ({ ...emptyWarehouse, idempotencyKey: logisticsCommandKey('logistics-warehouse') }));
  useEffect(() => {
    if (!selected || selected.access === 'REDACTED') { setInput({ ...emptyWarehouse, idempotencyKey: logisticsCommandKey('logistics-warehouse') }); return; }
    setInput({ warehouseKind: selected.warehouseKind, name: selected.name, partnerName: selected.partnerName, contactName: selected.contactName ?? '', phone: selected.phone ?? '', regionCode: selected.regionCode, addressLine: selected.addressLine ?? '', enabled: selected.enabled, idempotencyKey: logisticsCommandKey('logistics-warehouse') });
  }, [selected]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      if (selected) {
        const next = await updateAdminLogisticsWarehouse(selected.warehouseId, { ...input, expectedVersion: selected.version }, token);
        setInput((current) => ({ ...current, idempotencyKey: logisticsCommandKey('logistics-warehouse') }));
        return `仓库 ${next.warehouseId} 已更新为 v${next.version}`;
      }
      const next = await createAdminLogisticsWarehouse(input, token);
      setSelectedId(next.warehouseId);
      setInput((current) => ({ ...current, idempotencyKey: logisticsCommandKey('logistics-warehouse') }));
      return `仓库 ${next.warehouseId} 已创建`;
    });
  };
  const deactivate = () => {
    if (!selected) return;
    void runAction(async () => {
      const next = await deactivateAdminLogisticsWarehouse(selected.warehouseId, { expectedVersion: selected.version, idempotencyKey: input.idempotencyKey }, token);
      setInput((current) => ({ ...current, idempotencyKey: logisticsCommandKey('logistics-warehouse') }));
      return `仓库 ${next.warehouseId} 已停用`;
    });
  };
  return <section className="logistics-grid warehouse-grid">
    <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">仓库列表</p><h2>仓库版本</h2></div>{canWrite ? <button className="button button-quiet" type="button" onClick={() => setSelectedId(null)}><Plus aria-hidden="true" />新建仓库</button> : null}</div>
      {!warehouses.length ? <EmptyState icon={Building2} text="当前没有仓库" /> : <div className="warehouse-list" role="list">{warehouses.map((warehouse) => <button type="button" className={selectedId === warehouse.warehouseId ? 'warehouse-row is-selected' : 'warehouse-row'} key={warehouse.warehouseId} onClick={() => setSelectedId(warehouse.warehouseId)}><span><strong>{warehouse.name}</strong><small>{shortId(warehouse.warehouseId)} · v{warehouse.version}</small></span><span className={`status-chip ${warehouse.enabled ? 'status-ready' : 'status-blocked'}`}>{warehouse.enabled ? '已启用' : '已停用'}</span><small>{warehouseKindLabel(warehouse.warehouseKind)} · {warehouse.regionCode} · {accessLabel(warehouse.access)}</small></button>)}</div>}
    </article>
    <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">仓库资料</p><h2>{selected ? '仓库详情与版本' : '创建仓库'}</h2></div>{selected ? <Pencil aria-hidden="true" /> : <PackagePlus aria-hidden="true" />}</div>
      {selected?.access === 'REDACTED' ? <div className="warehouse-redacted"><ShieldCheck aria-hidden="true" /><h3>脱敏资料</h3><dl><div><dt>联系人</dt><dd>已脱敏</dd></div><div><dt>电话</dt><dd>已脱敏</dd></div><div><dt>地址</dt><dd>已脱敏</dd></div><div><dt>资料哈希</dt><dd><code>{selected.payloadHash}</code></dd></div></dl></div> : canWrite ? <form className="admin-editor-form logistics-form" onSubmit={submit}><div className="form-grid"><label>仓库类型<select value={input.warehouseKind} onChange={(event) => setInput({ ...input, warehouseKind: event.target.value as LogisticsWarehouseRequest['warehouseKind'], partnerName: event.target.value === 'PARTNER' ? input.partnerName ?? '' : null })}>{logisticsWarehouseKinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>名称<input value={input.name} onChange={(event) => setInput({ ...input, name: event.target.value })} minLength={2} maxLength={80} required /></label>{input.warehouseKind === 'PARTNER' ? <label>合作方名称<input value={input.partnerName ?? ''} onChange={(event) => setInput({ ...input, partnerName: event.target.value })} minLength={2} maxLength={80} required /></label> : null}<label>联系人<input value={input.contactName} onChange={(event) => setInput({ ...input, contactName: event.target.value })} required /></label><label>电话<input value={input.phone} onChange={(event) => setInput({ ...input, phone: event.target.value })} required /></label><label>地区代码<input value={input.regionCode} onChange={(event) => setInput({ ...input, regionCode: event.target.value })} required /></label><label className="form-span">地址<input value={input.addressLine} onChange={(event) => setInput({ ...input, addressLine: event.target.value })} required /></label><label className="checkbox-label"><input type="checkbox" checked={input.enabled} onChange={(event) => setInput({ ...input, enabled: event.target.checked })} />启用仓库</label></div><div className="logistics-actions"><button className="button button-primary" type="submit" disabled={loading}><Save aria-hidden="true" />{selected ? '保存新版本' : '创建仓库'}</button>{selected?.enabled ? <button className="button button-danger" type="button" onClick={deactivate} disabled={loading}><Power aria-hidden="true" />停用仓库</button> : null}</div></form> : <div className="warehouse-redacted"><ShieldCheck aria-hidden="true" /><h3>只读仓库投影</h3><p>选择左侧仓库查看脱敏状态。</p></div>}
    </article>
  </section>;
}

function OperationsView(props: { data: LogisticsData; token: string; canWrite: boolean; loading: boolean; initialMerchantId: string; initialOrderIds: readonly string[]; merchantFilterDraft: string; setMerchantFilterDraft(value: string): void; applyMerchantFilter(event: FormEvent): void; runAction(action: () => Promise<string>): Promise<void> }) {
  const { data, token, canWrite, loading, initialMerchantId, initialOrderIds, merchantFilterDraft, setMerchantFilterDraft, applyMerchantFilter, runAction } = props;
  const [waybill, setWaybill] = useState(() => ({ ...emptyWaybill, merchantId: initialMerchantId, idempotencyKey: logisticsCommandKey('logistics-waybill') }));
  const [orderIds, setOrderIds] = useState(initialOrderIds.join('\n'));
  const retryableJobs = useMemo(() => data.printJobs.printJobs.filter((job) => ['RETRYABLE', 'FAILED', 'CONFIGURATION_REQUIRED'].includes(job.state)), [data.printJobs.printJobs]);
  const [printJobId, setPrintJobId] = useState('');
  const [retryKey, setRetryKey] = useState(() => logisticsCommandKey('logistics-print-retry'));
  useEffect(() => { if (!retryableJobs.some((job) => job.printJobId === printJobId)) setPrintJobId(retryableJobs[0]?.printJobId ?? ''); }, [printJobId, retryableJobs]);
  const submitWaybill = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const ids = orderIds.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
      const next = await createAdminWaybillBatch({ ...waybill, orderIds: ids }, token);
      setOrderIds(''); setWaybill({ ...emptyWaybill, merchantId: waybill.merchantId, storeId: waybill.storeId, idempotencyKey: logisticsCommandKey('logistics-waybill') });
      return `面单批次 ${next.batchId} 已创建，共 ${next.items.length} 项`;
    });
  };
  const retry = (event: FormEvent) => {
    event.preventDefault(); if (!printJobId) return;
    void runAction(async () => {
      const next = await retryAdminPrintJob(printJobId, { idempotencyKey: retryKey }, token);
      setRetryKey(logisticsCommandKey('logistics-print-retry'));
      return `打印作业 ${next.printJobId} 已进入 ${next.state}`;
    });
  };
  return <>
    <section className="panel logistics-filter"><form className="inline-query-form" role="search" onSubmit={applyMerchantFilter}><label>商家筛选<input value={merchantFilterDraft} onChange={(event) => setMerchantFilterDraft(event.target.value)} maxLength={256} placeholder="留空读取跨商家列表" /></label><button className="button button-quiet" type="submit" disabled={loading}><RefreshCw aria-hidden="true" />读取列表</button></form></section>
    <section className="logistics-grid operations-grid">
      <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">跨商家面单</p><h2>创建面单批次</h2></div><PackagePlus aria-hidden="true" /></div>{canWrite ? <form className="admin-editor-form logistics-form" onSubmit={submitWaybill}><div className="form-grid"><label>商家编号<input value={waybill.merchantId} onChange={(event) => setWaybill({ ...waybill, merchantId: event.target.value })} required /></label><label>门店编号<input value={waybill.storeId} onChange={(event) => setWaybill({ ...waybill, storeId: event.target.value })} required /></label><label>物流服务<select value={waybill.provider} onChange={(event) => setWaybill({ ...waybill, provider: event.target.value as WaybillProvider })}>{waybillProviders.map((value) => <option key={value}>{value}</option>)}</select></label><label>承运商<select value={waybill.carrierCode} onChange={(event) => setWaybill({ ...waybill, carrierCode: event.target.value as LogisticsCarrierCode })}>{logisticsCarrierCodes.map((value) => <option key={value}>{value}</option>)}</select></label></div><label>订单编号，每行或逗号分隔<textarea value={orderIds} onChange={(event) => setOrderIds(event.target.value)} rows={5} required /></label><button className="button button-primary" type="submit" disabled={loading || !orderIds.trim()}><PackagePlus aria-hidden="true" />创建面单批次</button></form> : <p className="muted-copy">当前角色只可读取跨商家面单证据。</p>}</article>
      <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">打印任务</p><h2>打印重试</h2></div><Printer aria-hidden="true" /></div>{canWrite ? <form className="admin-editor-form logistics-form" onSubmit={retry}><label>可重试作业<select value={printJobId} onChange={(event) => setPrintJobId(event.target.value)} disabled={!retryableJobs.length}>{retryableJobs.map((job) => <option key={job.printJobId} value={job.printJobId}>{shortId(job.printJobId)} · {jobStateLabel(job.state)}</option>)}</select></label><button className="button button-primary" type="submit" disabled={loading || !printJobId}><RotateCcw aria-hidden="true" />重试打印作业</button></form> : null}{!retryableJobs.length ? <EmptyState icon={Printer} text="当前没有可重试打印作业" /> : null}</article>
    </section>
    <section className="logistics-lists">
      <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">面单记录</p><h2>面单记录</h2></div><span className="status-chip">{data.waybills.waybills.length}</span></div>{!data.waybills.waybills.length ? <EmptyState icon={PackagePlus} text="当前没有面单记录" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>订单 / 商家</th><th>物流服务 / 承运商</th><th>状态</th><th>运单号</th><th>更新时间</th></tr></thead><tbody>{data.waybills.waybills.map((item) => <tr key={item.requestId}><td><strong>{shortId(item.orderId)}</strong><small>{shortId(item.merchantId)}</small></td><td>{item.provider} / {item.carrierCode}</td><td>{jobStateLabel(item.state)}</td><td>{item.trackingNumber ?? '未生成'}</td><td>{item.updatedAt}</td></tr>)}</tbody></table></div>}</article>
      <article className="panel logistics-panel"><div className="panel-heading"><div><p className="section-kicker">打印作业</p><h2>打印作业</h2><small>作业类型：面单 / 自提单</small></div><span className="status-chip">{data.printJobs.printJobs.length}</span></div>{!data.printJobs.printJobs.length ? <EmptyState icon={Printer} text="当前没有打印作业" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>作业 / 订单</th><th>类型</th><th>物流服务 / 设备</th><th>状态</th><th>尝试</th></tr></thead><tbody>{data.printJobs.printJobs.map((job) => <tr key={job.printJobId}><td><code title={job.printJobId}>{shortId(job.printJobId)}</code><small>{shortId(job.orderId)} · {shortId(job.merchantId)}</small></td><td>{jobKindLabel(job.jobKind)}</td><td>{job.provider ?? '未绑定'} / {job.deviceId ?? '未绑定'}</td><td>{jobStateLabel(job.state)}</td><td>{job.attempts}</td></tr>)}</tbody></table></div>}</article>
    </section>
  </>;
}

function SecretRef({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) { return <label>{label}<input type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete="new-password" minLength={8} maxLength={256} required /></label>; }
function ViewTab({ active, onClick, children }: { active: boolean; onClick(): void; children: string }) { return <button type="button" role="tab" aria-selected={active} className={active ? 'is-active' : ''} onClick={onClick}>{children}</button>; }
function LoadingState() { return <div className="resource-state logistics-loading" role="status" aria-busy="true"><LoaderCircle className="spin" aria-hidden="true" /><div><strong>正在读取物流数据</strong><p>配置、仓库、面单和打印作业均等待真实响应。</p></div></div>; }
function CoreErrorState({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error logistics-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>; }
function EmptyState({ icon: Icon, text }: { icon: typeof Truck; text: string }) { return <div className="logistics-empty" role="status"><Icon aria-hidden="true" /><span>{text}</span></div>; }
function readOperationsPreset(searchParams: URLSearchParams) {
  const orderIds = [...new Set(searchParams.getAll('orderIds').map((value) => value.trim()).filter(Boolean))];
  return {
    open: searchParams.get('view') === 'OPERATIONS',
    merchantId: searchParams.get('merchantId')?.trim() ?? '',
    orderIds,
  };
}
function shortId(value: string) { return `${value.slice(0, 8)}…${value.slice(-6)}`; }
function readinessLabel(value: string) { return ({ READY: '已就绪', CONFIGURATION_REQUIRED: '待配置', EXTERNAL_BLOCKED: '外部服务异常', UNAVAILABLE: '未返回数据' } as Record<string, string>)[value] ?? value; }
function providerFieldLabel(value: string) { return ({ partnerIdSecretRef: '合作方账号', credentialSecretRef: '接口密钥', monthlyAccountSecretRef: '月结账号', callbackSecretRef: '回调密钥' } as Record<string, string>)[value] ?? value; }
function warehouseKindLabel(value: string) { return ({ PLATFORM: '平台仓库', PARTNER: '合作仓库' } as Record<string, string>)[value] ?? value; }
function accessLabel(value: string) { return ({ FULL: '完整可看', REDACTED: '脱敏可看', UNAVAILABLE: '需授权后查看' } as Record<string, string>)[value] ?? value; }
function jobKindLabel(value: string) { return ({ WAYBILL: '面单', PICKUP_SLIP: '自提单' } as Record<string, string>)[value] ?? value; }
function jobStateLabel(value: string) { return ({ CREATED: '已创建', QUEUED: '排队中', PRINTED: '已打印', RETRYABLE: '可重试', FAILED: '失败', CONFIGURATION_REQUIRED: '待配置', CANCELLED: '已取消' } as Record<string, string>)[value] ?? value; }
function asCoreError(cause: unknown, message: string) { if (cause instanceof CoreApiError) return cause; if (cause instanceof Error) return new CoreApiError({ code: 'InvalidRequest', message: cause.message, status: 400 }); return new CoreApiError({ code: 'ExternalBlocked', message, status: 503 }); }
function logisticsCommandKey(scope: string) { return `${scope}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }
