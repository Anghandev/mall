import { useCallback, useEffect, useRef, useState } from 'react';
import {
  printProviders,
  type PrintProvider,
  type PrinterBinding,
  type PrinterBindingChallenge,
  type MerchantStore,
} from '@abu24k/core-artifacts';
import {
  Building2,
  Crosshair,
  ImagePlus,
  MapPin,
  Plus,
  Printer,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { EmptyState, FieldHelp, LoadingRows, PageHeader } from '../components/ui';
import { readableError, useCoreRuntime } from '../core-runtime';

type LoadState<T> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string };

type BindingCommandState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'success'; binding: PrinterBinding; digest: string }
  | { phase: 'error'; message: string };

type BindingAttempt = {
  fingerprint: string;
  challengeKey: string;
  applyKey: string;
  challenge?: PrinterBindingChallenge;
  signature?: string;
};

export function StoresPage() {
  const { api, bootstrap, session, signTypedData } = useCoreRuntime();
  const [storesState, setStoresState] = useState<LoadState<readonly MerchantStore[]>>({ phase: 'idle' });
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [bindingState, setBindingState] = useState<LoadState<PrinterBinding | null>>({ phase: 'idle' });
  const [provider, setProvider] = useState<PrintProvider>('FEIE');
  const [deviceId, setDeviceId] = useState('');
  const [commandState, setCommandState] = useState<BindingCommandState>({ phase: 'idle' });
  const bindingAttempt = useRef<BindingAttempt | undefined>(undefined);
  const sessionTokenRef = useRef(session?.token);
  const selectedStoreRef = useRef(selectedStoreId);
  sessionTokenRef.current = session?.token;
  selectedStoreRef.current = selectedStoreId;

  const loadStores = useCallback(async () => {
    if (!session) {
      setStoresState({ phase: 'idle' });
      setSelectedStoreId('');
      return;
    }
    const token = session.token;
    setStoresState({ phase: 'loading' });
    try {
      const stores = (await api.listMerchantStores()).filter((store) => store.merchantId === session.merchantId);
      if (sessionTokenRef.current !== token) return;
      setStoresState({ phase: 'ready', value: stores });
      setSelectedStoreId((current) => stores.some((store) => store.storeId === current)
        ? current
        : stores[0]?.storeId ?? '');
    } catch (error) {
      if (sessionTokenRef.current === token) setStoresState({ phase: 'error', message: readableError(error) });
    }
  }, [api, session]);

  const loadBinding = useCallback(async (quiet = false) => {
    if (!session || !selectedStoreId) {
      setBindingState({ phase: 'idle' });
      return;
    }
    const token = session.token;
    const storeId = selectedStoreId;
    if (!quiet) setBindingState({ phase: 'loading' });
    try {
      const binding = await api.getMerchantPrinterBinding(storeId, token);
      if (sessionTokenRef.current !== token || selectedStoreRef.current !== storeId) return;
      if (binding && binding.merchantId !== session.merchantId) throw new Error('打印机绑定不属于当前商家。');
      setBindingState({ phase: 'ready', value: binding });
      if (binding) {
        setProvider(binding.provider);
        setDeviceId(binding.deviceId);
      }
    } catch (error) {
      if (sessionTokenRef.current === token && selectedStoreRef.current === storeId) {
        setBindingState({ phase: 'error', message: readableError(error) });
      }
    }
  }, [api, selectedStoreId, session]);

  useEffect(() => {
    void loadStores();
  }, [loadStores]);

  useEffect(() => {
    bindingAttempt.current = undefined;
    setCommandState({ phase: 'idle' });
    void loadBinding();
  }, [loadBinding]);

  const stores = storesState.phase === 'ready' ? storesState.value : [];
  const selectedStore = stores.find((store) => store.storeId === selectedStoreId);
  const currentBinding = bindingState.phase === 'ready' ? bindingState.value : null;
  const providerReadiness = bootstrap.phase === 'ready'
    ? bootstrap.value.readiness.providers[provider]
    : undefined;
  const providerReady = providerReadiness === 'READY';
  const deviceValid = deviceId.trim().length >= 3 && deviceId.trim().length <= 128;
  const submitting = commandState.phase === 'submitting';
  const bindingAllowed = Boolean(
    session
    && selectedStore
    && selectedStore.merchantId === session.merchantId
    && bindingState.phase === 'ready'
    && providerReady
    && deviceValid,
  );

  function selectStore(storeId: string) {
    setSelectedStoreId(storeId);
    setProvider('FEIE');
    setDeviceId('');
    bindingAttempt.current = undefined;
    setCommandState({ phase: 'idle' });
  }

  function updateBindingDraft(update: () => void) {
    bindingAttempt.current = undefined;
    setCommandState({ phase: 'idle' });
    update();
  }

  async function submitBinding() {
    if (!session || !selectedStore || !bindingAllowed || submitting) return;
    const normalizedDeviceId = deviceId.trim();
    const fingerprint = `${selectedStore.storeId}:${provider}:${normalizedDeviceId}`;
    const attempt = bindingAttempt.current?.fingerprint === fingerprint
      ? bindingAttempt.current
      : {
          fingerprint,
          challengeKey: createIdempotencyKey('printer-challenge'),
          applyKey: createIdempotencyKey('printer-apply'),
        };
    bindingAttempt.current = attempt;
    setCommandState({ phase: 'submitting' });
    try {
      const challenge = attempt.challenge ?? await api.createMerchantPrinterBindingChallenge(
        selectedStore.storeId,
        { provider, deviceId: normalizedDeviceId, idempotencyKey: attempt.challengeKey },
        session.token,
      );
      attempt.challenge = challenge;
      if (
        challenge.storeId !== selectedStore.storeId
        || challenge.merchantId !== session.merchantId
        || challenge.signer.toLowerCase() !== session.walletAddress.toLowerCase()
        || Date.parse(challenge.expiresAt) <= Date.now()
      ) {
        throw new Error('打印机绑定挑战与当前商家会话不匹配。');
      }
      const signature = attempt.signature ?? await signTypedData(challenge.typedData);
      attempt.signature = signature;
      const binding = await api.applyMerchantPrinterBinding(selectedStore.storeId, {
        challengeId: challenge.challengeId,
        signature,
        idempotencyKey: attempt.applyKey,
      }, session.token);
      if (
        binding.merchantId !== session.merchantId
        || binding.verifiedByWallet.toLowerCase() !== session.walletAddress.toLowerCase()
        || binding.provider !== provider
        || binding.deviceId !== normalizedDeviceId
      ) {
        throw new Error('打印机绑定结果与签名请求不匹配。');
      }
      bindingAttempt.current = undefined;
      setBindingState({ phase: 'ready', value: binding });
      setCommandState({ phase: 'success', binding, digest: challenge.digest });
    } catch (error) {
      setCommandState({ phase: 'error', message: readableError(error) });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={<button className="button primary" disabled type="button"><Plus aria-hidden="true" size={16} /> 新增门店</button>}
        description="维护允许到店自提的实体网点。打印机更换由当前商家钱包二次签名。"
        eyebrow="04 / 网点设置"
        title="门店管理"
      />
      <div className="store-layout">
        <section className="section-block store-list" aria-labelledby="store-list-title">
          <div className="section-heading"><div><p className="eyebrow">Locations</p><h2 id="store-list-title">旗下门店</h2></div><span>{storesState.phase === 'ready' ? `${stores.length} 家` : '实时 Core 读取'}</span></div>
          {storesState.phase === 'loading' ? <LoadingRows count={3} /> : null}
          {storesState.phase === 'idle' ? <EmptyState blocked description="连接授权商家钱包后读取门店。" title="商家会话不可用" /> : null}
          {storesState.phase === 'error' ? <><EmptyState blocked description={storesState.message} title="门店读取失败" /><button className="button secondary wide" onClick={() => void loadStores()} type="button"><RefreshCw aria-hidden="true" size={16} /> 重试</button></> : null}
          {storesState.phase === 'ready' && stores.length === 0 ? <EmptyState description="Core 未返回归属当前商家的门店。" title="暂无可管理门店" /> : null}
          {stores.length > 0 ? <div className="store-options" role="list">{stores.map((store) => (
            <button aria-pressed={store.storeId === selectedStoreId} className={store.storeId === selectedStoreId ? 'store-option selected' : 'store-option'} key={store.storeId} onClick={() => selectStore(store.storeId)} role="listitem" type="button">
              <strong>{store.name}</strong><span>{store.regionCode} · {store.status}</span><small>{store.address}</small>
            </button>
          ))}</div> : null}
        </section>

        <form className="section-block form-section" onSubmit={(event) => { event.preventDefault(); void submitBinding(); }} aria-labelledby="store-form-title">
          <div className="section-heading"><div><p className="eyebrow">Store details</p><h2 id="store-form-title">门店资料</h2></div><Building2 aria-hidden="true" size={19} /></div>
          <div className="two-column-fields">
            <div className="field"><label htmlFor="store-name">门店名称</label><input disabled id="store-name" placeholder="选择门店后显示" type="text" value={selectedStore?.name ?? ''} readOnly /></div>
            <div className="field"><label htmlFor="store-phone">服务电话</label><input disabled id="store-phone" inputMode="tel" placeholder="选择门店后显示" type="tel" value={selectedStore?.phone ?? ''} readOnly /></div>
          </div>
          <div className="two-column-fields">
            <div className="field"><label htmlFor="store-address">门店地址</label><input disabled id="store-address" placeholder="选择门店后显示" type="text" value={selectedStore?.address ?? ''} readOnly /></div>
            <div className="field"><label htmlFor="coordinates">精准地图坐标</label><div className="input-action"><input disabled id="coordinates" placeholder="由地图定位" type="text" value={selectedStore ? `${selectedStore.longitude}, ${selectedStore.latitude}` : ''} readOnly /><button aria-label="地图定位" className="icon-button" disabled type="button"><Crosshair aria-hidden="true" size={17} /></button></div></div>
          </div>
          <fieldset className="field"><legend>门店实景图</legend><button className="inline-upload" disabled type="button"><ImagePlus aria-hidden="true" size={19} /> 上传门店照片</button></fieldset>

          <div className="immutable-fieldset">
            <div className="immutable-heading"><MapPin aria-hidden="true" size={20} /><div><strong>行政区划绑定</strong><span>当前批次不开放迁址命令</span></div></div>
            <div className="two-column-fields">
              <div className="field"><label htmlFor="region-code">6 位行政区划代码</label><input disabled id="region-code" placeholder="由地图服务反向解析" readOnly type="text" value={selectedStore?.regionCode ?? ''} /><FieldHelp>禁止手工回填。</FieldHelp></div>
              <div className="field"><label htmlFor="region-proof">门店版本</label><input disabled id="region-proof" placeholder="选择门店后显示" readOnly type="text" value={selectedStore ? String(selectedStore.version) : ''} /></div>
            </div>
          </div>

          <section className="printer-binding-panel" aria-labelledby="printer-binding-title">
            <div className="section-heading"><div><p className="eyebrow">Signed device binding</p><h3 id="printer-binding-title">核销云打印机</h3></div><Printer aria-hidden="true" size={20} /></div>
            {bindingState.phase === 'loading' ? <LoadingRows count={2} /> : null}
            {bindingState.phase === 'error' ? <EmptyState blocked description={bindingState.message} title="设备绑定读取失败" /> : null}
            {bindingState.phase === 'ready' && !currentBinding ? <EmptyState description="该门店尚未绑定打印机。" title="暂无设备" /> : null}
            {currentBinding ? <dl className="binding-summary">
              <div><dt>当前设备</dt><dd>{currentBinding.provider} / {currentBinding.deviceId}</dd></div>
              <div><dt>绑定版本</dt><dd>v{currentBinding.version}</dd></div>
              <div><dt>签名摘要</dt><dd><code>{currentBinding.signatureHash}</code></dd></div>
            </dl> : null}
            <div className="two-column-fields">
              <div className="field"><label htmlFor="print-provider">打印服务</label><select disabled={!session || !selectedStore || submitting || bindingState.phase !== 'ready'} id="print-provider" onChange={(event) => updateBindingDraft(() => setProvider(event.target.value as PrintProvider))} value={provider}>{printProviders.map((name) => <option key={name} value={name}>{name}</option>)}</select></div>
              <div className="field"><label htmlFor="printer-device-id">Device ID</label><input autoComplete="off" disabled={!session || !selectedStore || submitting || bindingState.phase !== 'ready'} id="printer-device-id" maxLength={128} minLength={3} onChange={(event) => updateBindingDraft(() => setDeviceId(event.target.value))} placeholder="服务商设备编号" value={deviceId} /></div>
            </div>
            {providerReadiness === 'CONFIGURATION_REQUIRED' ? <p className="form-error" role="alert">ConfigurationRequired：{provider} 生产账号或凭据未配置，绑定命令已关闭。</p> : null}
            {commandState.phase === 'error' ? <p className="form-error" role="alert">{commandState.message}</p> : null}
            {commandState.phase === 'success' ? <div className="binding-success" role="status"><ShieldCheck aria-hidden="true" size={18} /><div><strong>绑定版本 v{commandState.binding.version} 已生效</strong><span>digest {commandState.digest}</span><span>signature {commandState.binding.signatureHash}</span></div></div> : null}
            <button aria-label="绑定设备" className="button primary wide" disabled={!bindingAllowed || submitting} type="submit">{submitting ? <RefreshCw aria-hidden="true" size={16} /> : <ShieldCheck aria-hidden="true" size={16} />} {submitting ? '签名并提交中' : '签名并绑定设备'}</button>
          </section>
          <div className="signature-note"><ShieldCheck aria-hidden="true" size={17} />Core challenge 绑定门店、商家、设备新旧值、nonce 和有效期；浏览器只签署该 typedData。</div>
        </form>
      </div>
    </div>
  );
}

function createIdempotencyKey(scope: string) {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `merchant-${scope}-${random}`;
}
