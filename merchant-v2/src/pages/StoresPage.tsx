import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type CreateMerchantStoreRequest,
  type MediaReadAccessProjection,
  type MerchantManagedStore,
  type MerchantStoreAction,
  type UpdateMerchantStoreRequest,
} from '@abu24k/core-artifacts';
import {
  Crosshair,
  ImagePlus,
  MapPin,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Store,
  Trash2,
  X,
} from 'lucide-react';
import { EmptyState, FieldHelp, LoadingRows, PageHeader } from '../components/ui';
import {
  CoreApiError,
  putMediaFile,
  sha256File,
  type MediaUploadIntentRequest,
} from '../core-api';
import { readableError, useCoreRuntime } from '../core-runtime';
import { safeIdempotencyKey } from '../idempotency';
import { translateErrorMessage } from '../display';

type LoadState<T> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string; code?: string; status?: number };

type Feedback = { tone: 'success' | 'error' | 'info'; message: string };

type StoreDraft = {
  name: string;
  phone: string;
  businessHours: string;
  imageAssetIds: string[];
};

type CreateDraft = {
  name: string;
  phone: string;
  businessHours: string;
  address: string;
  province: string;
  city: string;
  district: string;
  regionCode: string;
  longitude: string;
  latitude: string;
};

const emptyCreateDraft: CreateDraft = {
  name: '',
  phone: '',
  businessHours: '',
  address: '',
  province: '',
  city: '',
  district: '',
  regionCode: '',
  longitude: '',
  latitude: '',
};

const actionLabels: Record<MerchantStoreAction, string> = {
  UPDATE_PROFILE: '保存门店资料',
  ACTIVATE: '激活门店',
  CLOSE: '关闭门店',
};

const reasonLabels = {
  STORE_PROFILE_INCOMPLETE: '需先填写营业时间并绑定至少 1 张门店实景图',
  STORE_SUSPENDED: '门店已由平台冻结，商家不能修改或激活',
  STORE_CLOSED: '门店已关闭，历史资料只读',
  STORE_STATE_MISMATCH: '当前状态下不可执行',
} as const;

export function StoresPage() {
  const { api, session } = useCoreRuntime();
  const [storesState, setStoresState] = useState<LoadState<readonly MerchantManagedStore[]>>({ phase: 'idle' });
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [draft, setDraft] = useState<StoreDraft>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(emptyCreateDraft);
  const [storeBusy, setStoreBusy] = useState<'create' | 'save' | 'upload' | 'activate' | 'close'>();
  const [storeFeedback, setStoreFeedback] = useState<Feedback>();
  const [closeArmed, setCloseArmed] = useState(false);
  const [imageAccess, setImageAccess] = useState<Record<string, MediaReadAccessProjection>>({});
  const commandKeys = useRef(new Map<string, { fingerprint: string; key: string }>());
  const sessionTokenRef = useRef(session?.token);
  const selectedStoreRef = useRef(selectedStoreId);
  sessionTokenRef.current = session?.token;
  selectedStoreRef.current = selectedStoreId;

  const loadStores = useCallback(async (preferredStoreId?: string) => {
    if (!session) {
      setStoresState({ phase: 'idle' });
      setSelectedStoreId('');
      setDraft(undefined);
      return;
    }
    const token = session.token;
    setStoresState({ phase: 'loading' });
    try {
      const stores = await api.listManagedMerchantStores(token);
      if (stores.some((store) => store.merchantId !== session.merchantId)) {
        throw new CoreApiError('InvalidResponse', '门店列表包含不属于当前商家的记录。');
      }
      if (sessionTokenRef.current !== token) return;
      setStoresState({ phase: 'ready', value: stores });
      setSelectedStoreId((current) => {
        const preferred = preferredStoreId && stores.some((store) => store.storeId === preferredStoreId)
          ? preferredStoreId
          : undefined;
        return preferred ?? (stores.some((store) => store.storeId === current) ? current : stores[0]?.storeId ?? '');
      });
    } catch (error) {
      if (sessionTokenRef.current === token) setStoresState(errorState(error));
    }
  }, [api, session]);

  useEffect(() => {
    void loadStores();
  }, [loadStores]);

  const stores = storesState.phase === 'ready' ? storesState.value : [];
  const selectedStore = stores.find((store) => store.storeId === selectedStoreId);

  useEffect(() => {
    setDraft(selectedStore ? storeDraft(selectedStore) : undefined);
    setImageAccess({});
    if (!session || !selectedStore) return;
    const token = session.token;
    const storeId = selectedStore.storeId;
    void Promise.all(selectedStore.imageAssetIds.map(async (assetId) => {
      try {
        const access = await api.getMediaReadAccess(assetId, token, {
          resourceType: 'STORE',
          resourceId: storeId,
          purpose: 'STORE_IMAGE',
        });
        if (sessionTokenRef.current === token && selectedStoreRef.current === storeId) {
          setImageAccess((current) => ({ ...current, [assetId]: access }));
        }
      } catch {
        // The verified asset ID remains visible if temporary read access cannot be issued.
      }
    }));
  }, [api, selectedStore, session]);

  const canUpdate = capabilityEnabled(selectedStore, 'UPDATE_PROFILE');
  const canActivate = capabilityEnabled(selectedStore, 'ACTIVATE');
  const canClose = capabilityEnabled(selectedStore, 'CLOSE');
  const storeFormValid = Boolean(draft && validName(draft.name) && validPhone(draft.phone)
    && validBusinessHours(draft.businessHours) && draft.imageAssetIds.length <= 5);
  const createFormValid = validName(createDraft.name) && validPhone(createDraft.phone)
    && validBusinessHours(createDraft.businessHours)
    && validManualRegion(createDraft);

  function selectStore(storeId: string) {
    setSelectedStoreId(storeId);
    setStoreFeedback(undefined);
    setCloseArmed(false);
  }

  function commandKey(scope: string, payload: unknown) {
    const fingerprint = JSON.stringify(payload);
    const previous = commandKeys.current.get(scope);
    if (previous?.fingerprint === fingerprint) return previous.key;
    const key = safeIdempotencyKey(scope, { prefix: 'merchant' });
    commandKeys.current.set(scope, { fingerprint, key });
    return key;
  }

  function completeCommand(scope: string) {
    commandKeys.current.delete(scope);
  }

  function updateDraft(update: (current: StoreDraft) => StoreDraft) {
    setDraft((current) => current ? update(current) : current);
    setStoreFeedback(undefined);
    setCloseArmed(false);
  }

  async function createStore() {
    if (!session || !createFormValid || storeBusy) return;
    const value = {
      name: createDraft.name.trim(),
      phone: createDraft.phone.trim(),
      businessHours: createDraft.businessHours.trim(),
      address: createDraft.address.trim(),
      province: createDraft.province.trim(),
      city: createDraft.city.trim(),
      district: createDraft.district.trim(),
      regionCode: createDraft.regionCode.trim(),
      longitude: Number(createDraft.longitude.trim()),
      latitude: Number(createDraft.latitude.trim()),
    };
    const scope = 'create-store';
    const input: CreateMerchantStoreRequest = { ...value, idempotencyKey: commandKey(scope, value) };
    setStoreBusy('create');
    setStoreFeedback(undefined);
    try {
      const created = await api.createMerchantStore(input, session.token);
      requireStoreScope(created, session.merchantId);
      if (created.status !== 'DRAFT') throw new CoreApiError('InvalidResponse', '新门店未以 DRAFT 状态返回。');
      completeCommand(scope);
      setCreateDraft(emptyCreateDraft);
      setCreateOpen(false);
      await loadStores(created.storeId);
      setStoreFeedback({ tone: 'success', message: '门店草稿已创建。地址已经固定，搬店时请新建门店。' });
    } catch (error) {
      setStoreFeedback({ tone: 'error', message: readableStoreError(error) });
    } finally {
      setStoreBusy(undefined);
    }
  }

  async function saveStore() {
    if (!session || !selectedStore || !draft || !canUpdate || !storeFormValid || storeBusy) return;
    const value = {
      name: draft.name.trim(),
      phone: draft.phone.trim(),
      businessHours: draft.businessHours.trim(),
      imageAssetIds: draft.imageAssetIds,
      expectedVersion: selectedStore.version,
    };
    const scope = `save-store-${selectedStore.storeId}`;
    const input: UpdateMerchantStoreRequest = { ...value, idempotencyKey: commandKey(scope, value) };
    setStoreBusy('save');
    setStoreFeedback(undefined);
    try {
      const saved = await api.updateMerchantStore(selectedStore.storeId, input, session.token);
      requireStoreScope(saved, session.merchantId, selectedStore.storeId);
      completeCommand(scope);
      await loadStores(saved.storeId);
      setStoreFeedback({ tone: 'success', message: `门店资料已保存为版本 ${saved.version}，位置绑定保持不变。` });
    } catch (error) {
      await handleStoreCommandError(error, selectedStore.storeId);
    } finally {
      setStoreBusy(undefined);
    }
  }

  async function uploadStoreImages(files: readonly File[]) {
    if (!session || !selectedStore || !draft || !canUpdate || storeBusy) return;
    const capacity = 5 - draft.imageAssetIds.length;
    const accepted = files.slice(0, capacity);
    if (accepted.length === 0) {
      setStoreFeedback({ tone: 'error', message: '每家门店最多绑定 5 张实景图。' });
      return;
    }
    if (accepted.some((file) => !validImage(file))) {
      setStoreFeedback({ tone: 'error', message: '门店实景图仅支持 JPG、PNG 或 WebP，单个文件不超过 10 MB。' });
      return;
    }
    setStoreBusy('upload');
    setStoreFeedback(undefined);
    try {
      const uploaded: string[] = [];
      for (const file of accepted) {
        const contentSha256 = await sha256File(file);
        const value: Omit<MediaUploadIntentRequest, 'idempotencyKey'> = {
          purpose: 'STORE_IMAGE',
          resourceType: 'STORE',
          resourceId: selectedStore.storeId,
          contentType: file.type as MediaUploadIntentRequest['contentType'],
          sizeBytes: file.size,
          contentSha256,
        };
        const scope = `store-image-${selectedStore.storeId}-${contentSha256}`;
        const intent = await api.createMediaUploadIntent({
          ...value,
          idempotencyKey: commandKey(scope, value),
        }, session.token, session.walletAddress);
        await putMediaFile(intent, file);
        const asset = await api.completeMediaUpload(intent, session.token);
        const access = await api.getMediaReadAccess(asset.assetId, session.token, {
          resourceType: 'STORE',
          resourceId: selectedStore.storeId,
          purpose: 'STORE_IMAGE',
        });
        completeCommand(scope);
        uploaded.push(asset.assetId);
        setImageAccess((current) => ({ ...current, [asset.assetId]: access }));
      }
      updateDraft((current) => ({ ...current, imageAssetIds: [...current.imageAssetIds, ...uploaded] }));
      setStoreFeedback({ tone: 'info', message: `已完成 ${uploaded.length} 张图片上传和归属校验，请保存资料以绑定。` });
    } catch (error) {
      setStoreFeedback({ tone: 'error', message: readableStoreError(error) });
    } finally {
      setStoreBusy(undefined);
    }
  }

  async function activateStore() {
    if (!session || !selectedStore || !canActivate || storeBusy) return;
    const value = { expectedVersion: selectedStore.version };
    const scope = `activate-store-${selectedStore.storeId}`;
    setStoreBusy('activate');
    setStoreFeedback(undefined);
    try {
      const activated = await api.activateMerchantStore(selectedStore.storeId, {
        ...value,
        idempotencyKey: commandKey(scope, value),
      }, session.token);
      requireStoreScope(activated, session.merchantId, selectedStore.storeId);
      completeCommand(scope);
      await loadStores(activated.storeId);
      setStoreFeedback({ tone: 'success', message: '门店已激活，可作为商品和到店自提的有效网点。' });
    } catch (error) {
      await handleStoreCommandError(error, selectedStore.storeId);
    } finally {
      setStoreBusy(undefined);
    }
  }

  async function closeStore() {
    if (!session || !selectedStore || !canClose || !closeArmed || storeBusy) return;
    const value = { expectedVersion: selectedStore.version };
    const scope = `close-store-${selectedStore.storeId}`;
    setStoreBusy('close');
    setStoreFeedback(undefined);
    try {
      const closed = await api.closeMerchantStore(selectedStore.storeId, {
        ...value,
        idempotencyKey: commandKey(scope, value),
      }, session.token);
      requireStoreScope(closed, session.merchantId, selectedStore.storeId);
      completeCommand(scope);
      setCloseArmed(false);
      await loadStores(closed.storeId);
      setStoreFeedback({ tone: 'success', message: '门店已关闭，历史资料、订单快照和审计证据保留。' });
    } catch (error) {
      await handleStoreCommandError(error, selectedStore.storeId);
    } finally {
      setStoreBusy(undefined);
    }
  }

  async function handleStoreCommandError(error: unknown, storeId: string) {
    if (error instanceof CoreApiError && error.status === 409) await loadStores(storeId);
    setStoreFeedback({ tone: 'error', message: readableStoreError(error) });
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <button className="button primary" disabled={!session || Boolean(storeBusy)} onClick={() => { setCreateOpen((open) => !open); setStoreFeedback(undefined); }} type="button">
            {createOpen ? <X aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
            {createOpen ? '取消新增' : '新增门店'}
          </button>
        )}
        description="先填门店资料，再上传至少 1 张实景图，最后点激活。地址创建后不能直接改。"
        eyebrow="04 / 网点设置"
        title="门店管理"
      />

      {createOpen ? (
        <form className="section-block form-section store-create-panel" onSubmit={(event) => { event.preventDefault(); void createStore(); }} aria-labelledby="create-store-title">
          <div className="section-heading"><div><p className="eyebrow">位置锁定</p><h2 id="create-store-title">新建门店草稿</h2></div><MapPin aria-hidden="true" size={19} /></div>
          <div className="store-create-grid">
            <div className="field"><label htmlFor="create-store-name">门店名称</label><input id="create-store-name" maxLength={100} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))} required value={createDraft.name} /></div>
            <div className="field"><label htmlFor="create-store-phone">服务电话</label><input id="create-store-phone" inputMode="tel" maxLength={20} onChange={(event) => setCreateDraft((current) => ({ ...current, phone: event.target.value }))} pattern="[+]?[0-9-]{7,20}" required value={createDraft.phone} /></div>
            <div className="field"><label htmlFor="create-business-hours">营业时间</label><input id="create-business-hours" maxLength={240} onChange={(event) => setCreateDraft((current) => ({ ...current, businessHours: event.target.value }))} placeholder="09:00-18:00" required value={createDraft.businessHours} /></div>
            <div className="field"><label htmlFor="create-province">省</label><input id="create-province" maxLength={64} onChange={(event) => setCreateDraft((current) => ({ ...current, province: event.target.value }))} required value={createDraft.province} /></div>
            <div className="field"><label htmlFor="create-city">市</label><input id="create-city" maxLength={64} onChange={(event) => setCreateDraft((current) => ({ ...current, city: event.target.value }))} required value={createDraft.city} /></div>
            <div className="field"><label htmlFor="create-district">区县</label><input id="create-district" maxLength={64} onChange={(event) => setCreateDraft((current) => ({ ...current, district: event.target.value }))} required value={createDraft.district} /></div>
            <div className="field"><label htmlFor="create-region-code">地区代码（6 位）</label><input id="create-region-code" inputMode="numeric" maxLength={6} onChange={(event) => setCreateDraft((current) => ({ ...current, regionCode: event.target.value }))} pattern="[0-9]{6}" required value={createDraft.regionCode} /><FieldHelp>不知道就找平台要，不要随便填。</FieldHelp></div>
            <div className="field"><label htmlFor="create-longitude">经度</label><input id="create-longitude" inputMode="decimal" onChange={(event) => setCreateDraft((current) => ({ ...current, longitude: event.target.value }))} placeholder="例如 121.6147" required value={createDraft.longitude} /><FieldHelp>从地图复制门店真实经度，不能乱填。</FieldHelp></div>
            <div className="field"><label htmlFor="create-latitude">纬度</label><input id="create-latitude" inputMode="decimal" onChange={(event) => setCreateDraft((current) => ({ ...current, latitude: event.target.value }))} placeholder="例如 38.9140" required value={createDraft.latitude} /><FieldHelp>从地图复制门店真实纬度。</FieldHelp></div>
          </div>
          <div className="field"><label htmlFor="create-address">详细地址</label><input id="create-address" maxLength={300} minLength={5} onChange={(event) => setCreateDraft((current) => ({ ...current, address: event.target.value }))} required value={createDraft.address} /></div>
          <div className="signature-note"><Crosshair aria-hidden="true" size={17} />经纬度会写进门店证据，请从地图复制真实位置。创建后地址不能直接改，搬店请新建门店。</div>
          {storeFeedback ? <p className={`command-notice ${storeFeedback.tone}`} role={storeFeedback.tone === 'error' ? 'alert' : 'status'}>{storeFeedback.message}</p> : null}
          {!createFormValid ? <p className="field-help" role="status">请先补齐名称、电话、营业时间、省市区、6 位地区代码、详细地址和真实经纬度，按钮才会亮。</p> : null}
          <button className="button primary" disabled={!createFormValid || Boolean(storeBusy)} type="submit">{storeBusy === 'create' ? '创建中…' : '创建草稿'}</button>
        </form>
      ) : null}

      <div className="store-layout">
        <section className="section-block store-list" aria-labelledby="store-list-title">
          <div className="section-heading"><div><p className="eyebrow">门店列表</p><h2 id="store-list-title">旗下门店</h2></div><span>{storesState.phase === 'ready' ? `${stores.length} 家` : '正在读取'}</span></div>
          {storesState.phase === 'loading' ? <LoadingRows count={3} /> : null}
          {storesState.phase === 'idle' ? <EmptyState blocked description="连接授权商家钱包后读取门店。" title="请先连接商家钱包" /> : null}
          {storesState.phase === 'error' ? <><EmptyState blocked description={storesState.message} title={loadErrorTitle(storesState)} /><button className="button secondary wide" onClick={() => void loadStores()} type="button"><RefreshCw aria-hidden="true" size={16} /> 重试</button></> : null}
          {storesState.phase === 'ready' && stores.length === 0 ? <EmptyState description="当前商家尚未创建门店，可从右上角建立第一家门店草稿。" title="暂无可管理门店" /> : null}
          {stores.length > 0 ? <div className="store-options" role="list">{stores.map((store) => (
            <button aria-pressed={store.storeId === selectedStoreId} className={store.storeId === selectedStoreId ? 'store-option selected' : 'store-option'} key={store.storeId} onClick={() => selectStore(store.storeId)} role="listitem" type="button">
              <span className={`store-status status-${store.status.toLowerCase()}`}>{storeStatusLabel(store.status)}</span><strong>{store.name}</strong><span>{store.regionCode} · v{store.version}</span><small>{store.address}</small>
            </button>
          ))}</div> : null}
        </section>

        <div className="store-detail-stack">
          {!selectedStore || !draft ? <section className="section-block"><EmptyState description="从左侧选择门店，或新建门店草稿。" title="选择门店后继续" /></section> : (
            <form className="section-block form-section" onSubmit={(event) => { event.preventDefault(); void saveStore(); }} aria-labelledby="store-form-title">
              <div className="section-heading"><div><p className="eyebrow">资料版本</p><h2 id="store-form-title">门店资料</h2></div><span>{storeStatusLabel(selectedStore.status)} · v{selectedStore.version}</span></div>
              {selectedStore.status === 'SUSPENDED' ? <p className="command-notice error" role="alert">门店已冻结。资料、位置与激活操作均失败关闭，历史读取和履约证据保留。</p> : null}
              {selectedStore.status === 'CLOSED' ? <p className="command-notice error" role="status">门店已关闭。资料和位置永久只读，历史订单快照不受影响。</p> : null}
              <div className="two-column-fields">
                <div className="field"><label htmlFor="store-name">门店名称</label><input disabled={!canUpdate || Boolean(storeBusy)} id="store-name" maxLength={100} onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))} required value={draft.name} /></div>
                <div className="field"><label htmlFor="store-phone">服务电话</label><input disabled={!canUpdate || Boolean(storeBusy)} id="store-phone" inputMode="tel" maxLength={20} onChange={(event) => updateDraft((current) => ({ ...current, phone: event.target.value }))} pattern="[+]?[0-9-]{7,20}" required value={draft.phone} /></div>
              </div>
              <div className="field"><label htmlFor="store-business-hours">营业时间</label><input disabled={!canUpdate || Boolean(storeBusy)} id="store-business-hours" maxLength={240} onChange={(event) => updateDraft((current) => ({ ...current, businessHours: event.target.value }))} required value={draft.businessHours} /><FieldHelp>保存时绑定当前版本 {selectedStore.version}。</FieldHelp></div>

              <fieldset className="field"><legend>门店实景图</legend>
                <div className="media-actions">
                  <label className={`button secondary file-button${!canUpdate || storeBusy ? ' disabled' : ''}`}>
                    <ImagePlus aria-hidden="true" size={16} /> {storeBusy === 'upload' ? '上传中…' : '上传图片'}
                    <input accept="image/jpeg,image/png,image/webp" disabled={!canUpdate || Boolean(storeBusy) || draft.imageAssetIds.length >= 5} multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void uploadStoreImages(files); }} type="file" />
                  </label>
                  <span className="media-count">{draft.imageAssetIds.length} / 5</span>
                </div>
                {draft.imageAssetIds.length === 0 ? <EmptyState description="激活前至少需要 1 张系统校验通过的门店实景图。" title="尚未绑定实景图" /> : (
                  <div className="store-image-grid">{draft.imageAssetIds.map((assetId, index) => (
                    <figure key={assetId}>
                      <div className="store-image-frame">{imageAccess[assetId] ? <img alt={`门店实景图 ${index + 1}`} src={imageAccess[assetId].readUrl} /> : <Store aria-hidden="true" size={28} />}</div>
                      <figcaption><span>实景图 {index + 1}</span><details className="technical-details compact"><summary>图片编号</summary><code>{shortHash(assetId)}</code></details><button aria-label={`移除门店实景图 ${index + 1}`} className="icon-button" disabled={!canUpdate || Boolean(storeBusy)} onClick={() => updateDraft((current) => ({ ...current, imageAssetIds: current.imageAssetIds.filter((id) => id !== assetId) }))} type="button"><Trash2 aria-hidden="true" size={15} /></button></figcaption>
                    </figure>
                  ))}</div>
                )}
              </fieldset>

              <div className="immutable-fieldset">
                <div className="immutable-heading"><MapPin aria-hidden="true" size={20} /><div><strong>地址已固定</strong><span>这里不能直接改地址；门店搬迁请新建门店。</span></div></div>
                <div className="field"><label htmlFor="store-address">详细地址</label><input disabled id="store-address" readOnly value={selectedStore.address} /></div>
                <div className="two-column-fields">
                  <div className="field"><label htmlFor="region-code">地区代码</label><input disabled id="region-code" readOnly value={selectedStore.regionCode} /></div>
                  <details className="technical-details compact"><summary>定位信息</summary><code>{selectedStore.longitude}, {selectedStore.latitude}</code></details>
                </div>
              </div>

              <div className="store-capabilities" aria-label="现在能做的门店操作">{selectedStore.allowedActions.map((capability) => (
                <div key={capability.action}><strong>{actionLabels[capability.action]}</strong><span className={capability.enabled ? 'state-text success' : 'state-text blocked'}>{capabilityStatusText(selectedStore, capability)}</span></div>
              ))}</div>
              {storeFeedback && !createOpen ? <p className={`command-notice ${storeFeedback.tone}`} role={storeFeedback.tone === 'error' ? 'alert' : 'status'}>{storeFeedback.message}</p> : null}
              <div className="store-command-row">
                <button className="button primary" disabled={!canUpdate || !storeFormValid || Boolean(storeBusy)} type="submit"><Save aria-hidden="true" size={16} /> {storeBusy === 'save' ? '保存中…' : '保存资料'}</button>
                <button className="button secondary" disabled={!canActivate || Boolean(storeBusy)} onClick={() => void activateStore()} type="button"><ShieldCheck aria-hidden="true" size={16} /> {storeBusy === 'activate' ? '激活中…' : selectedStore.status === 'ACTIVE' ? '已激活' : '激活门店'}</button>
                <button className="button danger" disabled={!canClose || Boolean(storeBusy)} onClick={() => setCloseArmed(true)} type="button"><Trash2 aria-hidden="true" size={16} /> 关闭门店</button>
              </div>
              {closeArmed ? <div className="store-close-confirm" role="alert"><div><strong>确认关闭 {selectedStore.name}？</strong><span>关闭后资料只读，门店不再进入新商品和自提流程。</span></div><button className="button quiet" disabled={Boolean(storeBusy)} onClick={() => setCloseArmed(false)} type="button">取消</button><button className="button danger" disabled={Boolean(storeBusy)} onClick={() => void closeStore()} type="button">{storeBusy === 'close' ? '关闭中…' : '确认关闭'}</button></div> : null}
            </form>
          )}

        </div>
      </div>
    </div>
  );
}

function storeDraft(store: MerchantManagedStore): StoreDraft {
  return {
    name: store.name,
    phone: store.phone,
    businessHours: store.businessHours,
    imageAssetIds: [...store.imageAssetIds],
  };
}

function capabilityEnabled(store: MerchantManagedStore | undefined, action: MerchantStoreAction) {
  return store?.allowedActions.some((capability) => capability.action === action && capability.enabled) === true;
}

function capabilityStatusText(store: MerchantManagedStore, capability: MerchantManagedStore['allowedActions'][number]) {
  if (capability.enabled) return '可执行';
  if (capability.action === 'ACTIVATE' && capability.reasonCode === 'STORE_STATE_MISMATCH' && store.status === 'ACTIVE') {
    return '已营业，无需重复激活';
  }
  return capability.reasonCode ? reasonLabels[capability.reasonCode] : '不可执行';
}

function requireStoreScope(store: MerchantManagedStore, merchantId: string, storeId?: string) {
  if (store.merchantId !== merchantId || (storeId !== undefined && store.storeId !== storeId)) {
    throw new CoreApiError('InvalidResponse', '门店命令结果与当前商家范围不匹配。');
  }
}

function errorState(error: unknown): Extract<LoadState<never>, { phase: 'error' }> {
  return {
    phase: 'error',
    message: readableStoreError(error),
    ...(error instanceof CoreApiError ? { code: error.code } : {}),
    ...(error instanceof CoreApiError && error.status !== undefined ? { status: error.status } : {}),
  };
}

function readableStoreError(error: unknown) {
  if (!(error instanceof CoreApiError)) return readableError(error);
  if (error.code === 'ConfigurationRequired') return `门店配置不完整：${translateErrorMessage(error.message)}`;
  if (error.code === 'Forbidden' || error.status === 403) return `当前钱包无权执行：${translateErrorMessage(error.message)}`;
  if (error.status === 409 || error.code === 'IdempotencyConflict') return `门店状态已变化：${translateErrorMessage(error.message)}（已刷新最新门店版本）`;
  return readableError(error);
}

function loadErrorTitle(state: { code?: string; status?: number }) {
  if (state.code === 'ConfigurationRequired') return '门店配置不完整';
  if (state.code === 'Forbidden' || state.status === 403) return '无权读取当前门店';
  if (state.status === 409 || state.code === 'IdempotencyConflict') return '门店状态冲突';
  return '门店数据加载失败';
}

function storeStatusLabel(status: MerchantManagedStore['status']) {
  return { DRAFT: '草稿', ACTIVE: '营业中', SUSPENDED: '已冻结', CLOSED: '已关闭' }[status];
}

function validName(value: string) {
  return value.trim().length >= 1 && value.trim().length <= 100;
}

function validPhone(value: string) {
  return /^[+]?[0-9-]{7,20}$/.test(value.trim());
}

function validBusinessHours(value: string) {
  return value.trim().length >= 1 && value.trim().length <= 240;
}

function validManualRegion(draft: CreateDraft) {
  return draft.address.trim().length >= 5
    && draft.address.length <= 300
    && [draft.province, draft.city, draft.district].every((value) => value.trim().length >= 1 && value.length <= 64)
    && /^[0-9]{6}$/.test(draft.regionCode.trim())
    && validCoordinate(draft.longitude, -180, 180)
    && validCoordinate(draft.latitude, -90, 90);
}

function validCoordinate(value: string, min: number, max: number) {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(value.trim())) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

function validImage(file: File) {
  return Number.isSafeInteger(file.size)
    && file.size >= 1
    && file.size <= 10 * 1024 * 1024
    && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
