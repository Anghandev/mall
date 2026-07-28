import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleCheck,
  Eye,
  ImagePlus,
  LockKeyhole,
  PackagePlus,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2,
  Video,
} from 'lucide-react';
import type {
  CatalogCategory,
  CatalogProductAction,
  CatalogProductLifecycleState,
  CatalogTag,
  CatalogWriteLock,
  FulfillmentMode,
  ManagedCatalogProduct,
  MediaPurpose,
  MediaReadAccessProjection,
  MerchantConcessionAllocation,
  MerchantConcessionPreview,
  MerchantStore,
  ProductSlotInput,
  ProductSlotProjection,
} from '@abu24k/core-artifacts';
import { EmptyState, FieldHelp, LoadingRows, PageHeader } from '../components/ui';
import {
  CoreApiError,
  putMediaFile,
  sha256File,
  type MediaUploadIntentRequest,
} from '../core-api';
import { readableError, useCoreRuntime } from '../core-runtime';
import { safeIdempotencyKey } from '../idempotency';
import {
  formatBpsAsPercent,
  formatUsdt,
  formatUsdtInput,
  humanizeError,
  parseUsdtInput,
  translateErrorMessage,
} from '../display';

type WorkspaceState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | {
      phase: 'ready';
      merchantId: string;
      stores: readonly MerchantStore[];
      categories: readonly CatalogCategory[];
      tags: readonly CatalogTag[];
    };

type SlotState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; value: ProductSlotProjection };

interface SkuDraft {
  key: string;
  skuId?: string;
  attributes: string;
  listPriceUsdt: string;
  stockTotal: string;
  proposedSeckillInventory: string;
}

interface ProductDraft {
  title: string;
  subtitle: string;
  richDetail: string;
  defaultFreightUsdt: string;
  merchantConcessionBps: string;
  fulfillmentModes: FulfillmentMode[];
  categoryId: string;
  tagIds: string[];
  mainImageAssetIds: string[];
  videoAssetId: string;
  skus: SkuDraft[];
}

interface CommandFeedback {
  tone: 'success' | 'error';
  message: string;
  blockingResource?: CatalogWriteLock;
}

interface ReviewChecklistItem {
  label: string;
  done: boolean;
  help: string;
}

const lifecycleLabels: Record<CatalogProductLifecycleState, string> = {
  DRAFT: '草稿未送审',
  REVIEW: '平台审核中',
  SCHEDULED: '待排期上架',
  ACTIVE: '秒杀大厅进行中',
  SOLD_OUT: '已售罄',
  HIDDEN: '平台隐藏',
  DELISTED: '已下架',
  LOCKED: '已锁定',
};

const actionLabels: Record<CatalogProductAction, string> = {
  SAVE_DRAFT: '保存草稿',
  CREATE_CONCESSION_PREVIEW: '检查让利和应收',
  SUBMIT_REVIEW: '提交审核',
  APPROVE: '审核通过',
  REJECT: '驳回',
  PUBLISH: '发布',
  ADJUST_INVENTORY: '调整库存',
  HIDE: '隐藏',
  DELIST: '下架',
};

const concessionPoolLabels: Record<MerchantConcessionAllocation['pool'], string> = {
  SECKILL_PRIZE: '秒杀奖池 45%',
  NODE_REWARD: '节点奖励池 45%',
  REWARD_RESERVE: '奖励预留池 10%',
};

export function ProductPage() {
  const { api, bootstrap, session } = useCoreRuntime();
  const [workspace, setWorkspace] = useState<WorkspaceState>({ phase: 'loading' });
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [slot, setSlot] = useState<SlotState>({ phase: 'idle' });
  const [draft, setDraft] = useState<ProductDraft>(() => emptyDraft());
  const [preview, setPreview] = useState<MerchantConcessionPreview>();
  const [mediaAccess, setMediaAccess] = useState<Record<string, MediaReadAccessProjection>>({});
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<CommandFeedback>();
  const [delistReason, setDelistReason] = useState('');
  const commandKeys = useRef(new Map<string, { fingerprint: string; key: string }>());

  const loadWorkspace = useCallback(async () => {
    if (bootstrap.phase !== 'ready' || !session) {
      setWorkspace({ phase: 'error', message: '请先使用授权商家钱包登录。' });
      return;
    }
    setWorkspace({ phase: 'loading' });
    try {
      const [finance, stores, categories, tags] = await Promise.all([
        api.getMerchantFinance(session.token),
        api.listMerchantStores(),
        api.listCatalogCategories(),
        api.listCatalogTags(),
      ]);
      const merchantId = finance.merchant.merchant_id;
      const ownedStores = stores.filter((store) => store.merchantId === merchantId);
      setWorkspace({ phase: 'ready', merchantId, stores: ownedStores, categories, tags });
      setSelectedStoreId((current) => ownedStores.some((store) => store.storeId === current)
        ? current
        : ownedStores[0]?.storeId ?? '');
    } catch (error) {
      setWorkspace({ phase: 'error', message: readableError(error) });
    }
  }, [api, bootstrap.phase, session]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const loadSlot = useCallback(async () => {
    if (!selectedStoreId || !session) {
      setSlot({ phase: 'idle' });
      return;
    }
    setSlot({ phase: 'loading' });
    setFeedback(undefined);
    try {
      const value = await api.getMerchantProductSlot(selectedStoreId, session.token);
      setSlot({ phase: 'ready', value });
      setDraft(productDraft(value.product));
      setPreview(undefined);
      setDelistReason('');
    } catch (error) {
      setSlot({ phase: 'error', message: readableError(error) });
    }
  }, [api, selectedStoreId, session]);

  useEffect(() => {
    void loadSlot();
  }, [loadSlot]);

  const product = slot.phase === 'ready' ? slot.value.product : null;
  const allowedActions = slot.phase === 'ready' ? slot.value.allowedActions : [];
  const writeLock = slot.phase === 'ready' ? slot.value.writeLock : null;
  const can = useCallback(
    (action: CatalogProductAction) => allowedActions.includes(action),
    [allowedActions],
  );
  const canEdit = can('SAVE_DRAFT') && !writeLock && !busy;

  useEffect(() => {
    if (!product || !session) {
      setMediaAccess({});
      return;
    }
    const assets = [
      ...product.mainImageAssetIds.map((assetId) => ({ assetId, purpose: 'PRODUCT_IMAGE' as const })),
      ...(product.videoAssetId ? [{ assetId: product.videoAssetId, purpose: 'PRODUCT_VIDEO' as const }] : []),
    ];
    let active = true;
    void Promise.allSettled(assets.map(async ({ assetId, purpose }) => {
      const access = await api.getMediaReadAccess(assetId, session.token, {
        resourceType: 'PRODUCT',
        resourceId: product.productId,
        purpose,
      });
      if (active) setMediaAccess((current) => ({ ...current, [assetId]: access }));
    }));
    return () => { active = false; };
  }, [api, product, session]);

  const edit = useCallback((update: (current: ProductDraft) => ProductDraft) => {
    setDraft(update);
    setPreview(undefined);
    setFeedback(undefined);
  }, []);

  function idempotencyKey(scope: string, payload: unknown) {
    const fingerprint = JSON.stringify(payload);
    const previous = commandKeys.current.get(scope);
    if (previous?.fingerprint === fingerprint) return previous.key;
    const key = safeIdempotencyKey(scope);
    commandKeys.current.set(scope, { fingerprint, key });
    return key;
  }

  function completeCommand(scope: string) {
    commandKeys.current.delete(scope);
  }

  function commandFailure(error: unknown) {
    setFeedback({
      tone: 'error',
      message: readableProductError(error),
      ...(error instanceof CoreApiError && error.blockingResource
        ? { blockingResource: error.blockingResource }
        : {}),
    });
  }

  async function saveDraft() {
    if (!session || !selectedStoreId || !can('SAVE_DRAFT')) return;
    let value: Omit<ProductSlotInput, 'idempotencyKey'>;
    try {
      value = productInput(draft);
    } catch (error) {
      commandFailure(error);
      return;
    }
    const scope = `save-product-${selectedStoreId}`;
    const input = { ...value, idempotencyKey: idempotencyKey(scope, value) };
    setBusy('save');
    setFeedback(undefined);
    try {
      const saved = await api.saveMerchantProductSlot(selectedStoreId, input, session.token);
      completeCommand(scope);
      const value = await api.getMerchantProductSlot(selectedStoreId, session.token);
      setSlot({ phase: 'ready', value });
      setDraft(productDraft(value.product));
      setPreview(undefined);
      setFeedback({
        tone: 'success',
        message: saved.supersedesProductId
          ? `替代商品已保存，历史商品 ${shortHash(saved.supersedesProductId)} 保持不变。`
          : '商品草稿已保存。',
      });
    } catch (error) {
      commandFailure(error);
    } finally {
      setBusy(undefined);
    }
  }

  async function createPreview() {
    if (!session || !product || !can('CREATE_CONCESSION_PREVIEW')) return;
    const concessionBps = parseConcessionPercent(draft.merchantConcessionBps);
    const payload = { productId: product.productId, productVersion: product.version, concessionBps };
    const scope = `preview-${product.productId}`;
    setBusy('preview');
    setFeedback(undefined);
    try {
      const next = await api.createMerchantConcessionPreview(product.productId, {
        merchantConcessionBps: concessionBps,
        idempotencyKey: idempotencyKey(scope, payload),
      }, session.token);
      if (next.productVersion !== product.version || next.merchantId !== product.merchantId) {
        throw new CoreApiError('InvalidResponse', '签名让利预览与当前商品快照不一致。');
      }
      completeCommand(scope);
      setPreview(next);
      setFeedback({ tone: 'success', message: '让利和商家应收已检查完成，可以继续提交平台审核。' });
    } catch (error) {
      commandFailure(error);
    } finally {
      setBusy(undefined);
    }
  }

  async function submitReview() {
    if (!session || !product || !preview || !can('SUBMIT_REVIEW')) return;
    const readiness = productReviewReadiness(draft, Boolean(preview));
    if (!readiness.ready) {
      setFeedback({ tone: 'error', message: readiness.items.find((item) => !item.done)?.help ?? '请先补齐商品资料。' });
      return;
    }
    const payload = { productId: product.productId, previewId: preview.previewId };
    const scope = `submit-review-${product.productId}`;
    setBusy('review');
    setFeedback(undefined);
    try {
      const submitted = await api.submitMerchantProductReview(product.productId, {
        previewId: preview.previewId,
        idempotencyKey: idempotencyKey(scope, payload),
      }, session.token);
      completeCommand(scope);
      const value = await api.getMerchantProductSlot(selectedStoreId, session.token);
      setSlot({ phase: 'ready', value });
      setDraft(productDraft(value.product));
      setPreview(undefined);
      setFeedback({ tone: 'success', message: `商品已送审，当前状态：${lifecycleLabels[submitted.lifecycleState]}。` });
    } catch (error) {
      commandFailure(error);
    } finally {
      setBusy(undefined);
    }
  }

  async function delistProduct() {
    if (!session || !product || !can('DELIST')) return;
    const reasonCode = delistReason.trim() || 'MERCHANT_DELISTED';
    if (!/^[A-Za-z0-9:_-]{2,64}$/.test(reasonCode)) {
      setFeedback({ tone: 'error', message: '下架原因可以不填；如需填写，请使用字母、数字、下划线或短横线。' });
      return;
    }
    const payload = { productId: product.productId, reasonCode };
    const scope = `delist-${product.productId}`;
    setBusy('delist');
    setFeedback(undefined);
    try {
      await api.delistMerchantProduct(product.productId, {
        reasonCode,
        idempotencyKey: idempotencyKey(scope, payload),
      }, session.token);
      completeCommand(scope);
      await loadSlot();
      setFeedback({ tone: 'success', message: '商品已逻辑下架，历史订单和快照保持不变。' });
    } catch (error) {
      commandFailure(error);
    } finally {
      setBusy(undefined);
    }
  }

  async function uploadMedia(file: File, purpose: Extract<MediaPurpose, 'PRODUCT_IMAGE' | 'PRODUCT_VIDEO'>) {
    if (!session || !product || !can('SAVE_DRAFT')) return;
    if (!validMediaFile(file, purpose)) {
      setFeedback({
        tone: 'error',
        message: purpose === 'PRODUCT_IMAGE'
          ? '商品主图仅支持 JPG、PNG 或 WebP，单个文件不超过 10 MB。'
          : '商品视频仅支持 MP4，文件不超过 10 MB。',
      });
      return;
    }
    if (purpose === 'PRODUCT_IMAGE' && draft.mainImageAssetIds.length >= 5) {
      setFeedback({ tone: 'error', message: '商品主图最多 5 张。' });
      return;
    }
    setBusy(purpose === 'PRODUCT_IMAGE' ? 'image' : 'video');
    setFeedback(undefined);
    try {
      const contentSha256 = await sha256File(file);
      const requestValue: Omit<MediaUploadIntentRequest, 'idempotencyKey'> = {
        purpose,
        resourceType: 'PRODUCT',
        resourceId: product.productId,
        contentType: file.type as MediaUploadIntentRequest['contentType'],
        sizeBytes: file.size,
        contentSha256,
      };
      const scope = `media-${purpose}-${product.productId}-${contentSha256}`;
      const intent = await api.createMediaUploadIntent({
        ...requestValue,
        idempotencyKey: idempotencyKey(scope, requestValue),
      }, session.token, session.walletAddress);
      await putMediaFile(intent, file);
      const asset = await api.completeMediaUpload(intent, session.token);
      const access = await api.getMediaReadAccess(asset.assetId, session.token, {
        resourceType: 'PRODUCT',
        resourceId: product.productId,
        purpose,
      });
      completeCommand(scope);
      setMediaAccess((current) => ({ ...current, [asset.assetId]: access }));
      edit((current) => purpose === 'PRODUCT_IMAGE'
        ? { ...current, mainImageAssetIds: [...current.mainImageAssetIds, asset.assetId] }
        : { ...current, videoAssetId: asset.assetId });
      setFeedback({ tone: 'success', message: '媒体已完成上传和系统校验，请保存草稿以绑定到商品。' });
    } catch (error) {
      commandFailure(error);
    } finally {
      setBusy(undefined);
    }
  }

  const selectedStore = workspace.phase === 'ready'
    ? workspace.stores.find((store) => store.storeId === selectedStoreId)
    : undefined;
  const reviewReadiness = productReviewReadiness(draft, Boolean(preview));
  const canSubmitReview = can('SUBMIT_REVIEW') && Boolean(preview) && reviewReadiness.ready && !busy;
  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <div className={`header-status ${writeLock || !can('SAVE_DRAFT') ? 'locked' : 'ready'}`}>
            {writeLock || !can('SAVE_DRAFT')
              ? <LockKeyhole aria-hidden="true" size={16} />
              : <CircleCheck aria-hidden="true" size={16} />}
            {slot.phase === 'ready'
              ? product ? lifecycleLabels[product.lifecycleState] : '可创建草稿'
              : '状态校验中'}
          </div>
        )}
        description="按顺序做：保存草稿 → 上传主图 → 检查让利和应收 → 提交平台审核。"
        eyebrow="02 / 商品与库存"
        title="单品提报"
      />

      <section className="section-block product-context" aria-labelledby="product-context-title">
        <div className="section-heading">
          <div><p className="eyebrow">门店商品位</p><h2 id="product-context-title">当前门店</h2></div>
          <button className="button quiet" disabled={workspace.phase === 'loading' || slot.phase === 'loading'} onClick={() => { void loadWorkspace(); void loadSlot(); }} type="button">
            <RefreshCw aria-hidden="true" size={15} /> 刷新
          </button>
        </div>
        {workspace.phase === 'loading' ? <LoadingRows count={2} /> : null}
        {workspace.phase === 'error' ? <EmptyState blocked description={workspace.message} title="商家上下文不可用" /> : null}
        {workspace.phase === 'ready' && workspace.stores.length === 0 ? (
          <EmptyState blocked description="当前商家还没有可用门店。请先到“门店管理”创建并激活门店，再回来上传商品。" title="没有可管理的门店" />
        ) : null}
        {workspace.phase === 'ready' && workspace.stores.length > 0 ? (
          <div className="product-context-grid">
            <div className="field">
              <label htmlFor="product-store">当前门店</label>
              <select id="product-store" onChange={(event) => setSelectedStoreId(event.target.value)} value={selectedStoreId}>
                {workspace.stores.map((store) => <option key={store.storeId} value={store.storeId}>{store.name} / {shortHash(store.storeId)}</option>)}
              </select>
            </div>
            <details className="technical-details">
              <summary>高级信息</summary>
              <div className="slot-identifiers">
                <span>商家编号<strong>{shortHash(workspace.merchantId)}</strong></span>
                <span>门店区划<strong>{selectedStore?.regionCode ?? '--'}</strong></span>
                <span>商品版本<strong>{product?.version ?? '--'}</strong></span>
              </div>
            </details>
          </div>
        ) : null}
      </section>

      {slot.phase === 'loading' ? <section className="section-block"><LoadingRows count={4} /></section> : null}
      {slot.phase === 'error' ? <EmptyState blocked description={slot.message} title="商品位加载失败" /> : null}
      {slot.phase === 'ready' ? (
        <>
          <ProductStateBand
            slot={slot.value}
            {...(feedback?.blockingResource ? { feedbackBlock: feedback.blockingResource } : {})}
          />
          {product?.supersedesProductId ? (
            <div className="replacement-notice" role="status">
              <PackagePlus aria-hidden="true" size={19} />
              <div><strong>历史替代关系</strong><span>当前商品 {shortHash(product.productId)} 替代 {shortHash(product.supersedesProductId)}；历史订单仍引用原商品快照。</span></div>
            </div>
          ) : null}

          <form className="form-layout" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
            <section className="section-block form-section" aria-labelledby="basic-title">
              <div className="section-heading"><div><p className="eyebrow">商品资料</p><h2 id="basic-title">商品信息</h2></div><span>{draft.title.length} / 60</span></div>
              <div className="field">
                <label htmlFor="product-title">商品标题</label>
                <input disabled={!canEdit} id="product-title" maxLength={60} onChange={(event) => edit((current) => ({ ...current, title: event.target.value }))} required type="text" value={draft.title} />
              </div>
              <div className="field">
                <label htmlFor="product-subtitle">商品副标题</label>
                <input disabled={!canEdit} id="product-subtitle" maxLength={120} onChange={(event) => edit((current) => ({ ...current, subtitle: event.target.value }))} type="text" value={draft.subtitle} />
              </div>
              <div className="field">
                <label htmlFor="product-detail">商品详情</label>
                <textarea disabled={!canEdit} id="product-detail" onChange={(event) => edit((current) => ({ ...current, richDetail: event.target.value }))} spellCheck={false} value={draft.richDetail} />
                <FieldHelp>直接写商品介绍即可；高级结构化内容由系统保存，不需要商家理解格式。</FieldHelp>
              </div>
              <div className="two-column-fields">
                <div className="field">
                  <label htmlFor="default-freight">默认运费（USDT）</label>
                  <input disabled={!canEdit} id="default-freight" inputMode="decimal" onChange={(event) => edit((current) => ({ ...current, defaultFreightUsdt: event.target.value }))} placeholder="例如 0 或 5.00" value={draft.defaultFreightUsdt} />
                </div>
                <div className="field">
                  <label htmlFor="concession-bps">商家让利比例（%）</label>
                  <input disabled={!canEdit} id="concession-bps" inputMode="decimal" max={100} min={0} onChange={(event) => edit((current) => ({ ...current, merchantConcessionBps: event.target.value }))} step="0.01" type="number" value={draft.merchantConcessionBps} />
                  <FieldHelp>填百分比，例如 5 表示让利 5%；买家 70/30 支付规则不变。</FieldHelp>
                </div>
              </div>
              <TaxonomyFields
                canEdit={Boolean(canEdit)}
                categories={workspace.phase === 'ready' ? workspace.categories : []}
                draft={draft}
                edit={edit}
                tags={workspace.phase === 'ready' ? workspace.tags : []}
              />
              <fieldset className="field">
                <legend>支持履约模式</legend>
                <div className="choice-row">
                  {(['DELIVERY', 'PICKUP'] as const).map((mode) => (
                    <label key={mode}>
                      <input
                        checked={draft.fulfillmentModes.includes(mode)}
                        disabled={!canEdit}
                        onChange={(event) => edit((current) => ({
                          ...current,
                          fulfillmentModes: event.target.checked
                            ? [...current.fulfillmentModes, mode]
                            : current.fulfillmentModes.filter((value) => value !== mode),
                        }))}
                        type="checkbox"
                      />
                      {mode === 'DELIVERY' ? '快递邮寄' : '到店自提'}
                    </label>
                  ))}
                </div>
              </fieldset>
            </section>

            <section className="section-block form-section" aria-labelledby="media-title">
              <div className="section-heading"><div><p className="eyebrow">商品媒体</p><h2 id="media-title">图片与视频</h2></div><span>{draft.mainImageAssetIds.length} / 5</span></div>
              {!product ? (
                <div className="inline-warning"><LockKeyhole aria-hidden="true" size={16} />先保存商品草稿，再上传图片或视频。</div>
              ) : null}
              <div className="media-actions">
                <label className={`button secondary file-button${!product || !canEdit ? ' disabled' : ''}`}>
                  <ImagePlus aria-hidden="true" size={16} /> {busy === 'image' ? '上传中…' : '上传主图'}
                  <input
                    accept="image/jpeg,image/png,image/webp"
                    disabled={!product || !canEdit || draft.mainImageAssetIds.length >= 5}
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? [])
                        .slice(0, Math.max(0, 5 - draft.mainImageAssetIds.length));
                      event.target.value = '';
                      void files.reduce(
                        (promise, file) => promise.then(() => uploadMedia(file, 'PRODUCT_IMAGE')),
                        Promise.resolve(),
                      );
                    }}
                    type="file"
                  />
                </label>
                <label className={`button secondary file-button${!product || !canEdit ? ' disabled' : ''}`}>
                  <Video aria-hidden="true" size={16} /> {busy === 'video' ? '上传中…' : '上传 MP4'}
                  <input
                    accept="video/mp4"
                    disabled={!product || !canEdit}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void uploadMedia(file, 'PRODUCT_VIDEO');
                    }}
                    type="file"
                  />
                </label>
              </div>
              <MediaGrid access={mediaAccess} draft={draft} edit={edit} editable={Boolean(canEdit)} />
            </section>
          </form>

          <section className="section-block sku-section" aria-labelledby="sku-title">
            <div className="section-heading">
              <div><p className="eyebrow">规格库存</p><h2 id="sku-title">规格、价格与库存</h2></div>
              <button className="button secondary" disabled={!canEdit || draft.skus.length >= 50} onClick={() => edit((current) => ({ ...current, skus: [...current.skus, emptySku()] }))} type="button">
                <Plus aria-hidden="true" size={16} /> 添加规格
              </button>
            </div>
            <div className="sku-list">
              {draft.skus.map((sku, index) => (
                <SkuEditor
                  canEdit={Boolean(canEdit)}
                  index={index}
                  key={sku.key}
                  onChange={(next) => edit((current) => ({
                    ...current,
                    skus: current.skus.map((item) => item.key === sku.key ? next : item),
                  }))}
                  onRemove={() => edit((current) => ({ ...current, skus: current.skus.filter((item) => item.key !== sku.key) }))}
                  sku={sku}
                />
              ))}
            </div>
          </section>

          <section className="section-block command-section" aria-labelledby="command-title">
            <div className="section-heading"><div><p className="eyebrow">操作区</p><h2 id="command-title">保存、预览与送审</h2></div></div>
            <ReviewChecklist items={reviewReadiness.items} />
            <div className="allowed-action-list" aria-label="现在能做的商品操作">
              {allowedActions.length > 0
                ? allowedActions.map((action) => <span key={action}>{actionLabels[action]}</span>)
                : <span className="blocked">当前没有可点的操作</span>}
            </div>
            {feedback ? (
              <div className={`command-feedback ${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
                <strong>{feedback.tone === 'success' ? '操作已确认' : '操作未执行'}</strong>
                <span>{feedback.message}</span>
                {feedback.blockingResource ? <BlockingResource value={feedback.blockingResource} /> : null}
              </div>
            ) : null}
            <div className="command-grid">
              <button className="button primary" disabled={!canEdit} onClick={() => void saveDraft()} type="button"><Save aria-hidden="true" size={16} /> {busy === 'save' ? '保存中…' : '保存草稿'}</button>
              <button className="button secondary" disabled={!can('CREATE_CONCESSION_PREVIEW') || Boolean(busy)} onClick={() => void createPreview()} type="button"><Eye aria-hidden="true" size={16} /> {busy === 'preview' ? '检查中…' : '检查让利和应收'}</button>
              <button className="button secondary" disabled={!canSubmitReview} onClick={() => void submitReview()} type="button" title={canSubmitReview ? undefined : reviewReadiness.items.find((item) => !item.done)?.help}><Send aria-hidden="true" size={16} /> {busy === 'review' ? '送审中…' : '提交平台审核'}</button>
              {product?.lifecycleState === 'SOLD_OUT' && can('SAVE_DRAFT') ? (
                <button className="button secondary" disabled={Boolean(busy)} onClick={() => edit(() => emptyDraft())} type="button"><PackagePlus aria-hidden="true" size={16} /> 准备替代商品</button>
              ) : null}
            </div>
            {can('DELIST') && product ? (
              <details className="technical-details delist-row">
                <summary>高级下架操作</summary>
                <div className="field"><label htmlFor="delist-reason">下架原因（可不填）</label><input id="delist-reason" onChange={(event) => setDelistReason(event.target.value.toUpperCase())} placeholder="不填则自动生成" value={delistReason} /></div>
                <button className="button danger-quiet" disabled={Boolean(busy)} onClick={() => void delistProduct()} type="button"><Trash2 aria-hidden="true" size={16} /> {busy === 'delist' ? '下架中…' : '下架商品'}</button>
              </details>
            ) : null}
          </section>

          {preview ? <ConcessionPreview value={preview} /> : null}
        </>
      ) : null}
    </div>
  );
}

function ProductStateBand({
  slot,
  feedbackBlock,
}: {
  slot: ProductSlotProjection;
  feedbackBlock?: CatalogWriteLock;
}) {
  const block = feedbackBlock ?? slot.writeLock;
  if (block) {
    return (
      <div className="lock-notice" role="alert">
        <LockKeyhole aria-hidden="true" size={20} />
        <div>
          <strong>商品暂时不能修改</strong>
          <p>保存、预览和送审均禁用；履约、审计和历史快照不受影响。</p>
          <BlockingResource value={block} />
        </div>
      </div>
    );
  }
  return (
    <div className="slot-state-band" role="status">
      <CircleCheck aria-hidden="true" size={18} />
      <div><strong>{slot.product ? lifecycleLabels[slot.product.lifecycleState] : '该门店商品位为空'}</strong><span>能点的就是现在能做的；不能点的按钮会说明还缺什么。</span></div>
    </div>
  );
}

function BlockingResource({ value }: { value: CatalogWriteLock }) {
  return (
    <details className="technical-details compact">
      <summary>高级锁定信息</summary>
      <code className="blocking-resource">锁定资源：{lockTypeLabel(value.type)} / {shortHash(value.id)} / {lockStateLabel(value.state)}</code>
    </details>
  );
}

function ReviewChecklist({ items }: { items: readonly ReviewChecklistItem[] }) {
  return (
    <div className="review-checklist" aria-label="提交审核前检查">
      <strong>提交审核前检查</strong>
      <div>
        {items.map((item) => (
          <span className={item.done ? 'done' : 'todo'} key={item.label}>
            {item.done ? '已完成' : '待完成'}：{item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function TaxonomyFields({
  categories,
  tags,
  draft,
  canEdit,
  edit,
}: {
  categories: readonly CatalogCategory[];
  tags: readonly CatalogTag[];
  draft: ProductDraft;
  canEdit: boolean;
  edit(update: (current: ProductDraft) => ProductDraft): void;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor="product-category">商品分类</label>
        <select disabled={!canEdit} id="product-category" onChange={(event) => edit((current) => ({ ...current, categoryId: event.target.value }))} value={draft.categoryId}>
          <option value="">未选择</option>
          {categories.map((category) => <option key={category.categoryId} value={category.categoryId}>{category.name} / L{category.level}</option>)}
        </select>
      </div>
      <fieldset className="field">
        <legend>商品标签</legend>
        {tags.length > 0 ? (
          <div className="tag-choice-grid">
            {tags.map((tag) => (
              <label key={tag.tagId}>
                <input
                  checked={draft.tagIds.includes(tag.tagId)}
                  disabled={!canEdit}
                  onChange={(event) => edit((current) => ({
                    ...current,
                    tagIds: event.target.checked
                      ? [...current.tagIds, tag.tagId]
                      : current.tagIds.filter((tagId) => tagId !== tag.tagId),
                  }))}
                  type="checkbox"
                />
                <span>{tag.name}<small>{tag.example}</small></span>
              </label>
            ))}
          </div>
        ) : <FieldHelp>暂未配置商品标签。</FieldHelp>}
      </fieldset>
    </>
  );
}

function MediaGrid({
  draft,
  access,
  edit,
  editable,
}: {
  draft: ProductDraft;
  access: Readonly<Record<string, MediaReadAccessProjection>>;
  edit(update: (current: ProductDraft) => ProductDraft): void;
  editable: boolean;
}) {
  const videoAccess = draft.videoAssetId ? access[draft.videoAssetId] : undefined;
  if (draft.mainImageAssetIds.length === 0 && !draft.videoAssetId) {
    return <EmptyState description="送审前需要 1-5 张已校验主图；视频可选。" title="尚未绑定媒体" />;
  }
  return (
    <div className="product-media-grid">
      {draft.mainImageAssetIds.map((assetId, index) => (
        <figure key={assetId}>
          <div className="media-frame">
            {access[assetId]
              ? <img alt={`商品主图 ${index + 1}`} height="160" src={access[assetId].readUrl} width="240" />
              : <span>图片暂不可预览</span>}
          </div>
          <figcaption><span>主图 {index + 1}</span><details className="technical-details compact"><summary>图片编号</summary><code title={assetId}>{shortHash(assetId)}</code></details><button aria-label={`移除商品主图 ${index + 1}`} className="icon-button" disabled={!editable} onClick={() => edit((current) => ({ ...current, mainImageAssetIds: current.mainImageAssetIds.filter((value) => value !== assetId) }))} type="button"><Trash2 aria-hidden="true" size={15} /></button></figcaption>
        </figure>
      ))}
      {draft.videoAssetId ? (
        <figure>
          <div className="media-frame">
            {videoAccess
              ? <video aria-label="商品视频" controls preload="metadata" src={videoAccess.readUrl} />
              : <span>视频暂不可预览</span>}
          </div>
          <figcaption><span>商品视频</span><details className="technical-details compact"><summary>视频编号</summary><code title={draft.videoAssetId}>{shortHash(draft.videoAssetId)}</code></details><button aria-label="移除商品视频" className="icon-button" disabled={!editable} onClick={() => edit((current) => ({ ...current, videoAssetId: '' }))} type="button"><Trash2 aria-hidden="true" size={15} /></button></figcaption>
        </figure>
      ) : null}
    </div>
  );
}

function SkuEditor({
  sku,
  index,
  canEdit,
  onChange,
  onRemove,
}: {
  sku: SkuDraft;
  index: number;
  canEdit: boolean;
  onChange(value: SkuDraft): void;
  onRemove(): void;
}) {
  const set = (key: keyof SkuDraft, value: string) => onChange({ ...sku, [key]: value });
  const derivedBase = derivedMerchantBaseReceivable(sku.listPriceUsdt);
  return (
    <fieldset className="sku-editor">
      <legend>规格 {index + 1}{sku.skuId ? ` / ${shortHash(sku.skuId)}` : ''}</legend>
      <button aria-label={`移除规格 ${index + 1}`} className="icon-button sku-remove" disabled={!canEdit} onClick={onRemove} type="button"><Trash2 aria-hidden="true" size={16} /></button>
      <div className="field sku-attributes"><label htmlFor={`sku-attributes-${sku.key}`}>规格说明</label><input disabled={!canEdit} id={`sku-attributes-${sku.key}`} onChange={(event) => set('attributes', event.target.value)} spellCheck={false} value={sku.attributes} /></div>
      <div className="field"><label htmlFor={`sku-price-${sku.key}`}>商品售价（USDT）</label><input disabled={!canEdit} id={`sku-price-${sku.key}`} inputMode="decimal" onChange={(event) => set('listPriceUsdt', event.target.value)} placeholder="例如 2.00" value={sku.listPriceUsdt} /></div>
      <div className="field"><span id={`sku-receivable-${sku.key}`}>预计基础应收（USDT）</span><output aria-labelledby={`sku-receivable-${sku.key}`}>{derivedBase ?? '输入售价后自动计算'}</output><small>只读：系统按 70% USDT 付款减 1% 服务费派生。</small></div>
      <div className="field"><label htmlFor={`sku-stock-${sku.key}`}>总库存</label><input disabled={!canEdit} id={`sku-stock-${sku.key}`} inputMode="numeric" min={1} onChange={(event) => set('stockTotal', event.target.value)} type="number" value={sku.stockTotal} /></div>
      <div className="field"><label htmlFor={`sku-seckill-${sku.key}`}>提报秒杀库存</label><input disabled={!canEdit} id={`sku-seckill-${sku.key}`} inputMode="numeric" min={1} onChange={(event) => set('proposedSeckillInventory', event.target.value)} type="number" value={sku.proposedSeckillInventory} /></div>
    </fieldset>
  );
}

function ConcessionPreview({ value }: { value: MerchantConcessionPreview }) {
  return (
    <section className="section-block preview-section" aria-labelledby="preview-title">
      <div className="section-heading">
        <div><p className="eyebrow">审核前检查</p><h2 id="preview-title">让利和应收检查</h2></div>
        <span>系统已生成</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">规格</th><th scope="col">基础应收</th><th scope="col">让利</th><th scope="col">净应收</th><th scope="col">让利去向</th></tr></thead>
          <tbody>
            {value.payload.items.map((item) => (
              <tr key={item.skuId}>
                <td><strong>{shortHash(item.skuId)}</strong><small className="table-secondary">让利比例 {formatBpsAsPercent(item.merchantConcessionBps)}</small></td>
                <td className="numeric-cell">{formatUsdt(item.merchantBaseReceivableUsdt)}</td>
                <td className="numeric-cell">{formatUsdt(item.merchantConcessionAmount)}</td>
                <td className="numeric-cell">{formatUsdt(item.merchantNetReceivableUsdt)}</td>
                <td>{item.allocations.length > 0 ? item.allocations.map((allocation) => <span className="allocation-line" key={allocation.pool}><code>{concessionPoolLabels[allocation.pool]}</code><strong>{formatUsdt(allocation.amount)}</strong></span>) : <span>无让利分配</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="technical-details">
        <summary>高级签名凭证</summary>
        <div className="preview-proof">
          <span>预览编号<strong>{shortHash(value.previewId)}</strong></span>
          <span>高级资金规则<strong>{value.policyVersion}</strong></span>
          <span>签名钱包<strong>{shortAddress(value.authorization.signer)}</strong></span>
          <span>到期时间<strong>{formatDate(value.expiresAt)}</strong></span>
          <span>目的地集合<strong>{shortHash(value.destinationSetHash)}</strong></span>
        </div>
        <code className="preview-digest" title={value.authorization.digest}>签名摘要：{shortHash(value.authorization.digest)}</code>
      </details>
    </section>
  );
}

function productDraft(product: ManagedCatalogProduct | null): ProductDraft {
  if (!product) return emptyDraft();
  return {
    title: product.title,
    subtitle: product.subtitle,
    richDetail: objectDraftText(product.richDetail, 'description'),
    defaultFreightUsdt: formatUsdtInput(product.defaultFreightUsdt),
    merchantConcessionBps: bpsToPercent(product.merchantConcessionBps),
    fulfillmentModes: [...product.fulfillmentModes],
    categoryId: product.categoryId ?? '',
    tagIds: [...product.tagIds],
    mainImageAssetIds: [...product.mainImageAssetIds],
    videoAssetId: product.videoAssetId ?? '',
    skus: product.skus.map((sku) => ({
      key: crypto.randomUUID(),
      skuId: sku.skuId,
      attributes: objectDraftText(sku.attributes, 'name'),
      listPriceUsdt: formatUsdtInput(sku.listPriceUsdt),
      stockTotal: sku.stockTotal,
      proposedSeckillInventory: sku.proposedSeckillInventory,
    })),
  };
}

function emptyDraft(): ProductDraft {
  return {
    title: '',
    subtitle: '',
    richDetail: '{}',
    defaultFreightUsdt: '0',
    merchantConcessionBps: '0',
    fulfillmentModes: ['DELIVERY'],
    categoryId: '',
    tagIds: [],
    mainImageAssetIds: [],
    videoAssetId: '',
    skus: [emptySku()],
  };
}

function emptySku(): SkuDraft {
  return {
    key: crypto.randomUUID(),
    attributes: '',
    listPriceUsdt: '',
    stockTotal: '1',
    proposedSeckillInventory: '1',
  };
}

function productInput(draft: ProductDraft): Omit<ProductSlotInput, 'idempotencyKey'> {
  const title = draft.title.trim();
  if (title.length < 1 || title.length > 60) throw new Error('商品标题必须为 1-60 个字符。');
  if (draft.subtitle.length > 120) throw new Error('商品副标题不能超过 120 个字符。');
  if (draft.mainImageAssetIds.length > 5) throw new Error('商品主图不能超过 5 张。');
  if (draft.fulfillmentModes.length === 0) throw new Error('至少选择一种履约模式。');
  if (draft.skus.length < 1 || draft.skus.length > 50) throw new Error('商品必须包含 1 到 50 个规格。');
  const richDetail = parseFlexibleObject(draft.richDetail, '商品详情', 'description');
  const skus = draft.skus.map((sku, index) => {
    const listPriceUsdt = parseUsdtInput(sku.listPriceUsdt, `规格 ${index + 1} 商品售价`, true);
    const stockTotal = parsePositiveInteger(sku.stockTotal, `规格 ${index + 1} 总库存`);
    const proposedSeckillInventory = parsePositiveInteger(sku.proposedSeckillInventory, `规格 ${index + 1} 秒杀库存`);
    if (proposedSeckillInventory > stockTotal) throw new Error(`规格 ${index + 1} 秒杀库存不能超过总库存。`);
    return {
      ...(sku.skuId ? { skuId: sku.skuId } : {}),
      attributes: parseFlexibleObject(sku.attributes, `规格 ${index + 1} 规格说明`, 'name'),
      listPriceUsdt,
      stockTotal,
      proposedSeckillInventory,
    };
  });
  return {
    title,
    ...(draft.subtitle.trim() ? { subtitle: draft.subtitle.trim() } : {}),
    mainImageAssetIds: draft.mainImageAssetIds,
    ...(draft.videoAssetId ? { videoAssetId: draft.videoAssetId } : {}),
    richDetail,
    defaultFreightUsdt: parseUsdtInput(draft.defaultFreightUsdt, '默认运费', false),
    merchantConcessionBps: parseConcessionPercent(draft.merchantConcessionBps),
    fulfillmentModes: [...new Set(draft.fulfillmentModes)],
    ...(draft.categoryId ? { categoryId: draft.categoryId } : {}),
    tagIds: [...new Set(draft.tagIds)],
    skus,
  };
}

function parseFlexibleObject(value: string, label: string, textKey: string) {
  const text = value.trim();
  if (text === '') return {};
  if (!text.startsWith('{')) return { [textKey]: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}可以直接写文字；如果写 JSON，请使用正确的 JSON 对象格式。`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}如果写 JSON，必须是对象格式。`);
  return parsed as ProductSlotInput['richDetail'];
}

function derivedMerchantBaseReceivable(listPriceUsdt: string) {
  try {
    const price = BigInt(parseUsdtInput(listPriceUsdt, '商品售价', true));
    return formatUsdt((price * 7_000n / 10_000n - price * 100n / 10_000n).toString());
  } catch {
    return null;
  }
}

function parsePositiveInteger(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}必须是正整数。`);
  return parsed;
}

function parseConcessionPercent(value: string) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(value.trim())) throw new Error('商家让利比例必须是 0 到 100 之间的数字。');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error('商家让利比例必须是 0 到 100 之间的数字。');
  return Math.round(parsed * 100);
}

function bpsToPercent(value: number) {
  return (value / 100).toString().replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}


function objectDraftText(value: unknown, preferredTextKey: string) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record[preferredTextKey] === 'string' && Object.keys(record).length === 1) return record[preferredTextKey];
    const blocks = record.blocks;
    if (Array.isArray(blocks) && blocks.every((block) => block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string')) {
      return blocks.map((block) => (block as { text: string }).text).join('\n');
    }
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function productReviewReadiness(draft: ProductDraft, hasPreview: boolean) {
  const hasSkuPriceAndStock = draft.skus.length > 0 && draft.skus.every((sku) => {
    const priceOk = isPositiveUsdtInput(sku.listPriceUsdt);
    const stock = Number(sku.stockTotal);
    const seckillStock = Number(sku.proposedSeckillInventory);
    return priceOk && Number.isSafeInteger(stock) && stock > 0 && Number.isSafeInteger(seckillStock) && seckillStock > 0 && seckillStock <= stock;
  });
  const items: ReviewChecklistItem[] = [
    { label: '商品标题', done: draft.title.trim().length > 0, help: '请先填写商品标题。' },
    { label: '商品主图 1 到 5 张', done: draft.mainImageAssetIds.length >= 1 && draft.mainImageAssetIds.length <= 5, help: '请先上传 1 到 5 张商品主图，然后保存草稿。' },
    { label: '价格和库存', done: hasSkuPriceAndStock, help: '请检查商品售价、总库存和秒杀库存。' },
    { label: '让利和应收检查', done: hasPreview, help: '请先点击“检查让利和应收”。' },
  ];
  return { ready: items.every((item) => item.done), items };
}

function readableProductError(error: unknown) {
  if (error instanceof CoreApiError) return humanizeError(error);
  if (error instanceof Error) return translateErrorMessage(error.message);
  return readableError(error);
}

function isPositiveUsdtInput(value: string) {
  try {
    return BigInt(parseUsdtInput(value, '商品售价', true)) > 0n;
  } catch {
    return false;
  }
}

function validMediaFile(file: File, purpose: Extract<MediaPurpose, 'PRODUCT_IMAGE' | 'PRODUCT_VIDEO'>) {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 10 * 1024 * 1024) return false;
  return purpose === 'PRODUCT_IMAGE'
    ? ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
    : file.type === 'video/mp4';
}

function lockTypeLabel(value: string) {
  return ({ SESSION: '活动占用', ORDER: '订单占用', INVENTORY: '库存占用', POLICY: '规则占用' } as Record<string, string>)[value] ?? value;
}

function lockStateLabel(value: string) {
  return ({ LOCKED: '锁定中', SCHEDULED: '已排期', DISPUTED: '争议中', ACTIVE: '生效中' } as Record<string, string>)[value] ?? value;
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function shortAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}
