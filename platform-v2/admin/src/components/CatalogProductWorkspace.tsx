import {
  artifactVersion,
  catalogReviewDecisions,
  type AdminProductSlotInput,
  type CatalogCategory,
  type CatalogProductAction,
  type CatalogReviewDecision,
  type CatalogTag,
  type FulfillmentMode,
  type InventoryAdjustmentProjection,
  type ManagedCatalogProduct,
  type MerchantConcessionPreview,
  type ProductSlotProjection,
} from '@abu24k/core-artifacts';
import {
  Ban,
  Boxes,
  Check,
  ClipboardCheck,
  EyeOff,
  FileSignature,
  History,
  KeyRound,
  PackagePlus,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Tags,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  adjustAdminCatalogInventory,
  createAdminConcessionPreview,
  decideAdminProductReview,
  fetchAdminProductSlot,
  saveAdminProductSlot,
  submitAdminProductReview,
} from '../catalogAdminApi';
import { CoreApiError } from '../coreApi';
import { CatalogMediaAccess } from './CatalogMediaAccess';

type Props = Readonly<{
  canWrite: boolean;
  categories: readonly CatalogCategory[];
  products: readonly ManagedCatalogProduct[];
  tags: readonly CatalogTag[];
  token: string;
  onError(error: CoreApiError | null): void;
  onNotice(message: string): void;
  onProductSaved(product: ManagedCatalogProduct): void;
  onReload(): void;
}>;

type SkuDraft = {
  skuId: string;
  attributes: string;
  listPriceUsdt: string;
  merchantBaseReceivableUsdt: string;
  stockTotal: string;
  proposedSeckillInventory: string;
};

type ProductDraft = {
  storeId: string;
  merchantId: string;
  idempotencyKey: string;
  title: string;
  subtitle: string;
  mainImageAssetIds: string;
  videoAssetId: string;
  richDetail: string;
  defaultFreightUsdt: string;
  merchantConcessionBps: string;
  fulfillmentModes: FulfillmentMode[];
  categoryId: string;
  tagIds: string[];
  skus: SkuDraft[];
};

const emptySku = (): SkuDraft => ({
  skuId: '', attributes: '{}', listPriceUsdt: '', merchantBaseReceivableUsdt: '', stockTotal: '1', proposedSeckillInventory: '1',
});

const emptyDraft = (): ProductDraft => ({
  storeId: '', merchantId: '', idempotencyKey: '', title: '', subtitle: '', mainImageAssetIds: '', videoAssetId: '',
  richDetail: '{}', defaultFreightUsdt: '0', merchantConcessionBps: '0', fulfillmentModes: ['DELIVERY'], categoryId: '', tagIds: [], skus: [emptySku()],
});

const decisionIcons = {
  APPROVE: Check,
  REJECT: ShieldAlert,
  PUBLISH: ClipboardCheck,
  HIDE: EyeOff,
  DELIST: Trash2,
} as const;

export function CatalogProductWorkspace(props: Props) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft);
  const [slot, setSlot] = useState<ProductSlotProjection | null>(null);
  const [preview, setPreview] = useState<MerchantConcessionPreview | null>(null);
  const [previewIdempotencyKey, setPreviewIdempotencyKey] = useState('');
  const [submissionIdempotencyKey, setSubmissionIdempotencyKey] = useState('');
  const [decisionReason, setDecisionReason] = useState('');
  const [decisionIdempotencyKey, setDecisionIdempotencyKey] = useState('');
  const [inventorySkuId, setInventorySkuId] = useState('');
  const [inventoryDelta, setInventoryDelta] = useState('');
  const [inventoryReason, setInventoryReason] = useState('');
  const [inventoryIdempotencyKey, setInventoryIdempotencyKey] = useState('');
  const [adjustment, setAdjustment] = useState<InventoryAdjustmentProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = props.products.find((product) => product.productId === selectedId) ?? null;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return props.products;
    return props.products.filter((product) => [product.productId, product.title, product.merchantId, product.storeId ?? '', product.lifecycleState].some((value) => value.toLowerCase().includes(normalized)));
  }, [props.products, query]);

  useEffect(() => {
    if (selectedId && !props.products.some((product) => product.productId === selectedId)) setSelectedId('');
  }, [props.products, selectedId]);

  useEffect(() => {
    setSlot(null);
  }, [draft.merchantId, draft.storeId]);

  const checkSlot = async () => {
    await run(async () => {
      const projection = await fetchAdminProductSlot(draft.storeId, draft.merchantId, props.token);
      setSlot(projection);
      props.onNotice(projection.product ? `Core 已返回门店当前商品 ${projection.product.productId}` : 'Core 确认该门店商品槽为空');
    });
  };

  const submitProduct = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.canWrite || !slot?.allowedActions.includes('SAVE_DRAFT')) return;
    let input: AdminProductSlotInput;
    try {
      input = productInput(draft);
    } catch (cause) {
      props.onError(invalid(cause instanceof Error ? cause.message : '商品表单无效'));
      return;
    }
    await run(async () => {
      const saved = await saveAdminProductSlot(draft.storeId, input, props.token);
      props.onProductSaved(saved);
      setSelectedId(saved.productId);
      setSlot({ ...slot, product: saved, allowedActions: saved.allowedActions, writeLock: saved.writeLock });
      setDraft((current) => ({ ...current, idempotencyKey: '' }));
      props.onNotice(`Core 已保存商品 ${saved.productId} v${saved.version}`);
    });
  };

  const createPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !can(selected, 'CREATE_CONCESSION_PREVIEW')) return;
    await run(async () => {
      const result = await createAdminConcessionPreview(selected.productId, selected.merchantConcessionBps, previewIdempotencyKey, props.token);
      setPreview(result);
      setPreviewIdempotencyKey('');
      props.onNotice(`Core 已签名让利预览 ${result.previewId}`);
    });
  };

  const submitReview = async () => {
    if (!selected || !preview || !can(selected, 'SUBMIT_REVIEW')) return;
    await run(async () => {
      const saved = await submitAdminProductReview(selected.productId, preview.previewId, submissionIdempotencyKey, props.token);
      props.onProductSaved(saved);
      setSubmissionIdempotencyKey('');
      props.onNotice(`Core 已受理审核提交，状态 ${saved.lifecycleState}`);
    });
  };

  const decide = async (decision: CatalogReviewDecision) => {
    if (!selected || !can(selected, decision)) return;
    await run(async () => {
      const saved = await decideAdminProductReview(selected.productId, decision, decisionReason, decisionIdempotencyKey, props.token);
      props.onProductSaved(saved);
      setDecisionIdempotencyKey('');
      props.onNotice(`Core 已执行 ${decision}，状态 ${saved.lifecycleState}`);
    });
  };

  const adjustInventory = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !can(selected, 'ADJUST_INVENTORY')) return;
    await run(async () => {
      const result = await adjustAdminCatalogInventory(inventorySkuId, inventoryDelta, inventoryReason, inventoryIdempotencyKey, props.token);
      setAdjustment(result);
      setInventoryIdempotencyKey('');
      props.onNotice(`Core 已追加库存调整记录 ${result.adjustmentId}`);
      props.onReload();
    });
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true); props.onError(null);
    try { await action(); } catch (cause) { props.onError(asCoreError(cause)); } finally { setBusy(false); }
  };

  const loadProduct = (product: ManagedCatalogProduct) => {
    setDraft(draftFromProduct(product));
    setSlot(null);
    props.onNotice(`已载入 ${product.productId} 的当前 Core 版本；保存前必须重新读取门店商品槽。`);
  };

  return (
    <div className="catalog-product-layout">
      <section className="panel catalog-product-list" aria-labelledby="managed-products-title">
        <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/catalog/products</p><h2 id="managed-products-title">全商品列表</h2></div><span className="status-chip status-ready">{filtered.length} / {props.products.length}</span></div>
        <label className="catalog-filter"><Search aria-hidden="true" /><span className="sr-only">筛选商品</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="商品 / 商家 / 门店 / 状态" /></label>
        <div className="catalog-product-items">
          {filtered.map((product) => (
            <button className={selectedId === product.productId ? 'catalog-product-row is-selected' : 'catalog-product-row'} key={product.productId} type="button" onClick={() => { setSelectedId(product.productId); setPreview(null); setAdjustment(null); }}>
              <span className="product-row-title"><strong>{product.title}</strong><small>{product.productId}</small></span>
              <span className={`catalog-state catalog-state-${product.lifecycleState.toLowerCase()}`}>{product.lifecycleState}</span>
              <span className="product-row-meta"><small>{product.merchantId}</small><small>v{product.version} · {product.skus.length} SKU</small></span>
              {product.writeLock ? <span className="catalog-row-lock"><ShieldAlert aria-hidden="true" />{product.writeLock.type}: {product.writeLock.id}</span> : null}
            </button>
          ))}
          {filtered.length === 0 ? <div className="catalog-list-empty" role="status"><Ban aria-hidden="true" /><span>{props.products.length ? '没有匹配商品' : 'Core 返回真实空商品列表'}</span></div> : null}
        </div>
      </section>

      <section className="panel catalog-product-detail" aria-labelledby="product-detail-title">
        {selected ? (
          <>
            <div className="panel-heading">
              <div><p className="section-kicker">{selected.productId} · v{selected.version}</p><h2 id="product-detail-title">{selected.title}</h2></div>
              {props.canWrite && selected.allowedActions.includes('SAVE_DRAFT') ? <button className="button button-quiet" type="button" onClick={() => loadProduct(selected)}><RefreshCw aria-hidden="true" />载入代理表单</button> : null}
            </div>
            <ProductSnapshot product={selected} categories={props.categories} tags={props.tags} />
            <ActionBoundary product={selected} />
            <ProductMedia product={selected} token={props.token} />
            <SkuTable product={selected} />
            {props.canWrite ? (
              <div className="catalog-action-stack">
                <ConcessionPanel
                  busy={busy}
                  idempotencyKey={previewIdempotencyKey}
                  preview={preview}
                  product={selected}
                  submissionIdempotencyKey={submissionIdempotencyKey}
                  onCreate={createPreview}
                  onIdempotencyChange={setPreviewIdempotencyKey}
                  onSubmissionIdempotencyChange={setSubmissionIdempotencyKey}
                  onSubmitReview={() => void submitReview()}
                />
                <ReviewPanel busy={busy} product={selected} reason={decisionReason} idempotencyKey={decisionIdempotencyKey} onReasonChange={setDecisionReason} onIdempotencyChange={setDecisionIdempotencyKey} onDecide={(decision) => void decide(decision)} />
                <InventoryPanel adjustment={adjustment} busy={busy} product={selected} skuId={inventorySkuId} delta={inventoryDelta} reason={inventoryReason} idempotencyKey={inventoryIdempotencyKey} onSkuChange={setInventorySkuId} onDeltaChange={setInventoryDelta} onReasonChange={setInventoryReason} onIdempotencyChange={setInventoryIdempotencyKey} onSubmit={adjustInventory} />
              </div>
            ) : <div className="catalog-readonly-note"><Ban aria-hidden="true" /><span>AUDITOR 仅读：Core 已返回完整投影，但界面不渲染审核、库存或商品写入表单。</span></div>}
          </>
        ) : <div className="catalog-detail-empty"><Boxes aria-hidden="true" /><h2 id="product-detail-title">选择商品</h2><p>查看完整版本、SKU、媒体、写锁和 Core allowedActions。</p></div>}
      </section>

      {props.canWrite ? (
        <section className="panel catalog-proxy-editor" aria-labelledby="proxy-product-title">
          <div className="panel-heading"><div><p className="section-kicker">GET / PUT /v2/admin/catalog/stores/:storeId/product-slot</p><h2 id="proxy-product-title">门店代理建品</h2></div><button className="button button-quiet" type="button" onClick={() => { setDraft(emptyDraft()); setSlot(null); }}><Plus aria-hidden="true" />新表单</button></div>
          <form className="catalog-product-form" onSubmit={submitProduct}>
            <fieldset><legend>归属与权威商品槽</legend><div className="form-grid"><label>Store ID<input value={draft.storeId} onChange={(event) => setDraft({ ...draft, storeId: event.target.value })} required /></label><label>Merchant ID<input value={draft.merchantId} onChange={(event) => setDraft({ ...draft, merchantId: event.target.value })} required /></label></div><button className="button button-quiet" type="button" onClick={() => void checkSlot()} disabled={busy || !draft.storeId.trim() || !draft.merchantId.trim()}><KeyRound aria-hidden="true" />读取 Core 商品槽授权</button>{slot ? <SlotEvidence slot={slot} /> : <p className="catalog-form-hint">未读取商品槽时保存始终禁用。</p>}</fieldset>
            <fieldset><legend>商品内容</legend><div className="form-grid"><label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={60} required /></label><label>副标题<input value={draft.subtitle} onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} maxLength={120} /></label><label>默认运费 · USDT atomic<input inputMode="numeric" value={draft.defaultFreightUsdt} onChange={(event) => setDraft({ ...draft, defaultFreightUsdt: event.target.value })} required /></label><label>商家让利 · bps<input type="number" min="0" max="10000" value={draft.merchantConcessionBps} onChange={(event) => setDraft({ ...draft, merchantConcessionBps: event.target.value })} required /></label><label>类目<select value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}><option value="">未分类</option>{props.categories.filter((category) => category.status === 'ENABLED').map((category) => <option key={category.categoryId} value={category.categoryId}>L{category.level} · {category.name}</option>)}</select></label><label>Idempotency key<input value={draft.idempotencyKey} onChange={(event) => setDraft({ ...draft, idempotencyKey: event.target.value })} minLength={8} maxLength={128} required /></label></div><label>主图 asset IDs · 每行一个<textarea rows={3} value={draft.mainImageAssetIds} onChange={(event) => setDraft({ ...draft, mainImageAssetIds: event.target.value })} /></label><label>视频 asset ID<input value={draft.videoAssetId} onChange={(event) => setDraft({ ...draft, videoAssetId: event.target.value })} /></label><label>富详情 · JSON object<textarea rows={5} value={draft.richDetail} onChange={(event) => setDraft({ ...draft, richDetail: event.target.value })} spellCheck={false} required /></label><fieldset className="catalog-checkbox-group"><legend>履约方式</legend>{(['DELIVERY', 'PICKUP'] as const).map((mode) => <label key={mode}><input type="checkbox" checked={draft.fulfillmentModes.includes(mode)} onChange={() => setDraft({ ...draft, fulfillmentModes: toggle(draft.fulfillmentModes, mode) })} />{mode}</label>)}</fieldset><fieldset className="catalog-checkbox-group"><legend>标签</legend>{props.tags.filter((tag) => tag.status === 'ENABLED').map((tag) => <label key={tag.tagId}><input type="checkbox" checked={draft.tagIds.includes(tag.tagId)} onChange={() => setDraft({ ...draft, tagIds: toggle(draft.tagIds, tag.tagId) })} />{tag.name}</label>)}</fieldset></fieldset>
            <fieldset><legend>SKU · 价格和库存由 Core 校验</legend><div className="catalog-sku-editor">{draft.skus.map((sku, index) => <SkuEditor key={index} index={index} sku={sku} canRemove={draft.skus.length > 1} onChange={(next) => setDraft({ ...draft, skus: draft.skus.map((item, itemIndex) => itemIndex === index ? next : item) })} onRemove={() => setDraft({ ...draft, skus: draft.skus.filter((_, itemIndex) => itemIndex !== index) })} />)}</div><button className="button button-quiet" type="button" onClick={() => setDraft({ ...draft, skus: [...draft.skus, emptySku()] })}><Plus aria-hidden="true" />添加 SKU</button></fieldset>
            <button className="button button-primary" type="submit" disabled={busy || !slot?.allowedActions.includes('SAVE_DRAFT') || draft.idempotencyKey.length < 8}><Save aria-hidden="true" />保存 Core 商品版本</button>
            <p className="catalog-form-hint"><History aria-hidden="true" />已有历史订单时，Core 通过 supersedesProductId 创建替代商品，不改写历史快照。</p>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function ProductSnapshot({ product, categories, tags }: { product: ManagedCatalogProduct; categories: readonly CatalogCategory[]; tags: readonly CatalogTag[] }) {
  return <dl className="catalog-product-facts"><div><dt>状态</dt><dd>{product.lifecycleState}</dd></div><div><dt>版本</dt><dd>{product.version}</dd></div><div><dt>商家 / 门店</dt><dd>{product.merchantId}<small>{product.storeId ?? '无门店'}</small></dd></div><div><dt>让利</dt><dd>{product.merchantConcessionBps} bps</dd></div><div><dt>类目</dt><dd>{categories.find((item) => item.categoryId === product.categoryId)?.name ?? product.categoryId ?? '未分类'}</dd></div><div><dt>标签</dt><dd>{product.tagIds.map((id) => tags.find((tag) => tag.tagId === id)?.name ?? id).join(' · ') || '无'}</dd></div><div><dt>Policy hash</dt><dd><code>{product.productPolicyHash}</code></dd></div><div><dt>替代历史商品</dt><dd>{product.supersedesProductId ?? '无'}</dd></div></dl>;
}

function ActionBoundary({ product }: { product: ManagedCatalogProduct }) {
  return <section className="catalog-action-boundary"><div><span>Core allowedActions</span><div className="catalog-action-chips">{product.allowedActions.length ? product.allowedActions.map((action) => <code key={action}>{action}</code>) : <small>无写操作</small>}</div></div><div><span>writeLock / blockingResource</span>{product.writeLock ? <strong><ShieldAlert aria-hidden="true" />{product.writeLock.type} · {product.writeLock.id} · {product.writeLock.state}</strong> : <strong><Check aria-hidden="true" />无写锁</strong>}</div></section>;
}

function ProductMedia({ product, token }: { product: ManagedCatalogProduct; token: string }) {
  if (!product.mainImageAssetIds.length && !product.videoAssetId) return null;
  return <section className="catalog-media-grid" aria-label="商品媒体">{product.mainImageAssetIds.map((assetId, index) => <CatalogMediaAccess assetId={assetId} key={assetId} label={`主图 ${index + 1}`} token={token} />)}{product.videoAssetId ? <CatalogMediaAccess assetId={product.videoAssetId} label="商品视频" token={token} /> : null}</section>;
}

function SkuTable({ product }: { product: ManagedCatalogProduct }) {
  return <div className="table-scroll"><table className="data-table catalog-sku-table"><thead><tr><th>SKU</th><th>售价 / 商家基础应收</th><th>库存</th><th>秒杀提案</th><th>状态</th></tr></thead><tbody>{product.skus.map((sku) => <tr key={sku.skuId}><td><strong>{sku.skuId}</strong><small>{attributeText(sku.attributes)}</small></td><td className="tabular"><strong>{sku.listPriceUsdt}</strong><small>{sku.merchantBaseReceivableUsdt} USDT atomic</small></td><td className="tabular"><strong>{sku.stockAvailable} available</strong><small>{sku.stockReserved} reserved / {sku.stockTotal} total</small></td><td>{sku.proposedSeckillInventory}</td><td>{sku.lifecycleState}</td></tr>)}</tbody></table></div>;
}

function ConcessionPanel(props: { busy: boolean; product: ManagedCatalogProduct; preview: MerchantConcessionPreview | null; idempotencyKey: string; submissionIdempotencyKey: string; onIdempotencyChange(value: string): void; onSubmissionIdempotencyChange(value: string): void; onCreate(event: FormEvent): void; onSubmitReview(): void }) {
  if (!props.product.allowedActions.includes('CREATE_CONCESSION_PREVIEW') && !props.preview) return null;
  return <section className="catalog-command-panel"><div className="panel-heading"><div><p className="section-kicker">SIGNED CORE PROJECTION</p><h3>商家让利预览</h3></div><FileSignature aria-hidden="true" /></div>{props.product.allowedActions.includes('CREATE_CONCESSION_PREVIEW') ? <form className="inline-query-form" onSubmit={props.onCreate}><label>Idempotency key<input value={props.idempotencyKey} onChange={(event) => props.onIdempotencyChange(event.target.value)} minLength={8} required /></label><button className="button button-primary" type="submit" disabled={props.busy || props.idempotencyKey.length < 8}><FileSignature aria-hidden="true" />请求签名预览</button></form> : null}{props.preview ? <><PreviewEvidence preview={props.preview} /><div className="inline-query-form"><label>审核提交 idempotency key<input value={props.submissionIdempotencyKey} onChange={(event) => props.onSubmissionIdempotencyChange(event.target.value)} minLength={8} /></label><button className="button button-primary" type="button" onClick={props.onSubmitReview} disabled={props.busy || !props.product.allowedActions.includes('SUBMIT_REVIEW') || props.submissionIdempotencyKey.length < 8}><ClipboardCheck aria-hidden="true" />用此 previewId 提交审核</button></div></> : null}</section>;
}

function PreviewEvidence({ preview }: { preview: MerchantConcessionPreview }) {
  return <div className="catalog-preview"><dl className="definition-grid"><div><dt>Preview ID</dt><dd><code>{preview.previewId}</code></dd></div><div><dt>Policy version</dt><dd>{preview.policyVersion}</dd></div><div><dt>Signer</dt><dd><code>{preview.authorization.signer}</code></dd></div><div><dt>Digest</dt><dd><code>{preview.authorization.digest}</code></dd></div><div><dt>Catalog fingerprint</dt><dd><code>{preview.catalogFingerprint}</code></dd></div><div><dt>过期</dt><dd>{formatDate(preview.expiresAt)}</dd></div></dl><div className="table-scroll"><table className="data-table"><thead><tr><th>SKU</th><th>基础应收</th><th>让利</th><th>净应收</th><th>目的账户分配</th></tr></thead><tbody>{preview.payload.items.map((item) => <tr key={item.skuId}><td>{item.skuId}</td><td>{item.merchantBaseReceivableUsdt}</td><td>{item.merchantConcessionAmount}</td><td>{item.merchantNetReceivableUsdt}</td><td>{item.allocations.map((allocation) => <small key={allocation.account}><code>{allocation.account}</code> {allocation.amount}</small>)}</td></tr>)}</tbody></table></div></div>;
}

function ReviewPanel(props: { busy: boolean; product: ManagedCatalogProduct; reason: string; idempotencyKey: string; onReasonChange(value: string): void; onIdempotencyChange(value: string): void; onDecide(decision: CatalogReviewDecision): void }) {
  const decisions = catalogReviewDecisions.filter((decision) => props.product.allowedActions.includes(decision));
  if (!decisions.length) return null;
  return <section className="catalog-command-panel"><div className="panel-heading"><div><p className="section-kicker">AUTHORITATIVE STATE MACHINE</p><h3>审核与发布</h3></div><ClipboardCheck aria-hidden="true" /></div><div className="form-grid"><label>原因代码<input value={props.reason} onChange={(event) => props.onReasonChange(event.target.value.toUpperCase())} placeholder="UPPERCASE_REASON" required /></label><label>Idempotency key<input value={props.idempotencyKey} onChange={(event) => props.onIdempotencyChange(event.target.value)} minLength={8} required /></label></div><div className="button-row">{decisions.map((decision) => { const Icon = decisionIcons[decision]; return <button className={decision === 'REJECT' || decision === 'HIDE' || decision === 'DELIST' ? 'button button-danger' : 'button button-primary'} key={decision} type="button" onClick={() => props.onDecide(decision)} disabled={props.busy || !/^[A-Z][A-Z0-9_]{1,63}$/.test(props.reason) || props.idempotencyKey.length < 8}><Icon aria-hidden="true" />{decision}</button>; })}</div></section>;
}

function InventoryPanel(props: { adjustment: InventoryAdjustmentProjection | null; busy: boolean; product: ManagedCatalogProduct; skuId: string; delta: string; reason: string; idempotencyKey: string; onSkuChange(value: string): void; onDeltaChange(value: string): void; onReasonChange(value: string): void; onIdempotencyChange(value: string): void; onSubmit(event: FormEvent): void }) {
  if (!props.product.allowedActions.includes('ADJUST_INVENTORY')) return null;
  return <section className="catalog-command-panel"><div className="panel-heading"><div><p className="section-kicker">APPEND-ONLY INVENTORY EVENT</p><h3>平台库存调整</h3></div><PackagePlus aria-hidden="true" /></div><form className="form-grid" onSubmit={props.onSubmit}><label>SKU<select value={props.skuId} onChange={(event) => props.onSkuChange(event.target.value)} required><option value="">选择 SKU</option>{props.product.skus.map((sku) => <option key={sku.skuId} value={sku.skuId}>{sku.skuId}</option>)}</select></label><label>增减数量<input inputMode="numeric" value={props.delta} onChange={(event) => props.onDeltaChange(event.target.value)} placeholder="10 或 -3" required /></label><label>原因代码<input value={props.reason} onChange={(event) => props.onReasonChange(event.target.value.toUpperCase())} required /></label><label>Idempotency key<input value={props.idempotencyKey} onChange={(event) => props.onIdempotencyChange(event.target.value)} minLength={8} required /></label><button className="button button-primary" type="submit" disabled={props.busy || !props.skuId || !/^-?[1-9][0-9]*$/.test(props.delta) || !/^[A-Z][A-Z0-9_]{1,63}$/.test(props.reason) || props.idempotencyKey.length < 8}><PackagePlus aria-hidden="true" />追加调整记录</button></form>{props.adjustment ? <p className="healthy-copy" role="status"><Check aria-hidden="true" />{props.adjustment.skuId}: {props.adjustment.beforeAvailable} → {props.adjustment.afterAvailable} available</p> : null}</section>;
}

function SlotEvidence({ slot }: { slot: ProductSlotProjection }) {
  return <div className="catalog-slot-evidence"><div><span>当前商品</span><strong>{slot.product?.productId ?? '空槽'}</strong></div><div><span>allowedActions</span><strong>{slot.allowedActions.join(' · ') || '无'}</strong></div><div><span>writeLock</span><strong>{slot.writeLock ? `${slot.writeLock.type} · ${slot.writeLock.id} · ${slot.writeLock.state}` : '无'}</strong></div></div>;
}

function SkuEditor({ index, sku, canRemove, onChange, onRemove }: { index: number; sku: SkuDraft; canRemove: boolean; onChange(value: SkuDraft): void; onRemove(): void }) {
  return <article><div className="catalog-sku-editor-heading"><strong>SKU {index + 1}</strong>{canRemove ? <button className="icon-button" type="button" onClick={onRemove} aria-label={`删除 SKU ${index + 1}`} title="删除 SKU"><Trash2 aria-hidden="true" /></button> : null}</div><div className="form-grid"><label>SKU ID · 编辑时保留<input value={sku.skuId} onChange={(event) => onChange({ ...sku, skuId: event.target.value })} /></label><label>属性 · JSON object<input value={sku.attributes} onChange={(event) => onChange({ ...sku, attributes: event.target.value })} required /></label><label>售价 · USDT atomic<input inputMode="numeric" value={sku.listPriceUsdt} onChange={(event) => onChange({ ...sku, listPriceUsdt: event.target.value })} required /></label><label>商家基础应收 · USDT atomic<input inputMode="numeric" value={sku.merchantBaseReceivableUsdt} onChange={(event) => onChange({ ...sku, merchantBaseReceivableUsdt: event.target.value })} required /></label><label>总库存<input type="number" min="1" value={sku.stockTotal} onChange={(event) => onChange({ ...sku, stockTotal: event.target.value })} required /></label><label>提议秒杀库存<input type="number" min="1" value={sku.proposedSeckillInventory} onChange={(event) => onChange({ ...sku, proposedSeckillInventory: event.target.value })} required /></label></div></article>;
}

function productInput(draft: ProductDraft): AdminProductSlotInput {
  const richDetail = parseObject(draft.richDetail, '富详情');
  const mainImageAssetIds = lines(draft.mainImageAssetIds);
  const skus = draft.skus.map((sku, index) => ({
    ...(sku.skuId.trim() ? { skuId: sku.skuId.trim() } : {}),
    attributes: parseObject(sku.attributes, `SKU ${index + 1} 属性`),
    listPriceUsdt: sku.listPriceUsdt,
    merchantBaseReceivableUsdt: sku.merchantBaseReceivableUsdt,
    stockTotal: Number(sku.stockTotal),
    proposedSeckillInventory: Number(sku.proposedSeckillInventory),
  }));
  return {
    merchantId: draft.merchantId.trim(), idempotencyKey: draft.idempotencyKey, title: draft.title.trim(),
    ...(draft.subtitle.trim() ? { subtitle: draft.subtitle.trim() } : {}),
    ...(mainImageAssetIds.length ? { mainImageAssetIds } : {}),
    ...(draft.videoAssetId.trim() ? { videoAssetId: draft.videoAssetId.trim() } : {}),
    richDetail, defaultFreightUsdt: draft.defaultFreightUsdt, merchantConcessionBps: Number(draft.merchantConcessionBps),
    fulfillmentModes: draft.fulfillmentModes,
    ...(draft.categoryId ? { categoryId: draft.categoryId } : {}),
    ...(draft.tagIds.length ? { tagIds: draft.tagIds } : {}),
    skus,
  };
}

function draftFromProduct(product: ManagedCatalogProduct): ProductDraft {
  return {
    storeId: product.storeId ?? '', merchantId: product.merchantId, idempotencyKey: '', title: product.title, subtitle: product.subtitle,
    mainImageAssetIds: product.mainImageAssetIds.join('\n'), videoAssetId: product.videoAssetId ?? '', richDetail: JSON.stringify(product.richDetail, null, 2),
    defaultFreightUsdt: product.defaultFreightUsdt, merchantConcessionBps: String(product.merchantConcessionBps), fulfillmentModes: [...product.fulfillmentModes],
    categoryId: product.categoryId ?? '', tagIds: [...product.tagIds], skus: product.skus.map((sku) => ({
      skuId: sku.skuId, attributes: JSON.stringify(sku.attributes), listPriceUsdt: sku.listPriceUsdt,
      merchantBaseReceivableUsdt: sku.merchantBaseReceivableUsdt, stockTotal: sku.stockTotal, proposedSeckillInventory: sku.proposedSeckillInventory,
    })),
  };
}

function parseObject(value: string, label: string) { const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON object`); return parsed as Record<string, unknown>; }
function lines(value: string) { return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean); }
function toggle<T extends string>(values: readonly T[], value: T): T[] { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function can(product: ManagedCatalogProduct, action: CatalogProductAction) { return product.allowedActions.includes(action); }
function attributeText(attributes: Readonly<Record<string, unknown>>) { return Object.entries(attributes).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || '无属性'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: `Catalog Core 能力不可用（${artifactVersion}）`, status: 503 }); }
