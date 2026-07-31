import {
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
import { formatBpsAsPercent, formatUsdt, formatUsdtInput, parseUsdtInput, shortId } from '../display';
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
  stockTotal: string;
  proposedSeckillInventory: string;
};

type ProductDraft = {
  storeId: string;
  merchantId: string;
  title: string;
  subtitle: string;
  mainImageAssetIds: string;
  videoAssetId: string;
  richDetail: string;
  defaultFreightUsdt: string;
  merchantConcessionPercent: string;
  fulfillmentModes: FulfillmentMode[];
  categoryId: string;
  tagIds: string[];
  skus: SkuDraft[];
};

const emptySku = (): SkuDraft => ({
  skuId: '',
  attributes: '',
  listPriceUsdt: '',
  stockTotal: '1',
  proposedSeckillInventory: '1',
});

const emptyDraft = (): ProductDraft => ({
  storeId: '',
  merchantId: '',
  title: '',
  subtitle: '',
  mainImageAssetIds: '',
  videoAssetId: '',
  richDetail: '',
  defaultFreightUsdt: '0',
  merchantConcessionPercent: '0',
  fulfillmentModes: ['DELIVERY'],
  categoryId: '',
  tagIds: [],
  skus: [emptySku()],
});

const decisionIcons = {
  APPROVE: Check,
  REJECT: ShieldAlert,
  PUBLISH: ClipboardCheck,
  HIDE: EyeOff,
  DELIST: Trash2,
} as const;

const reasonPattern = /^[A-Z][A-Z0-9_]{1,63}$/;

export function CatalogProductWorkspace(props: Props) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft);
  const [slot, setSlot] = useState<ProductSlotProjection | null>(null);
  const [preview, setPreview] = useState<MerchantConcessionPreview | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [inventorySkuId, setInventorySkuId] = useState('');
  const [inventoryDelta, setInventoryDelta] = useState('');
  const [inventoryReason, setInventoryReason] = useState('');
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
      props.onNotice(projection.product ? `已读取门店当前商品：${projection.product.title}` : '已确认该门店还没有商品');
    });
  };

  const submitProduct = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.canWrite || !slot?.allowedActions.includes('SAVE_DRAFT')) return;
    let input: AdminProductSlotInput;
    try {
      input = productInput(draft, adminCommandKey('catalog-product-save'));
    } catch (cause) {
      props.onError(invalid(cause instanceof Error ? cause.message : '商品表单无效'));
      return;
    }
    await run(async () => {
      const saved = await saveAdminProductSlot(draft.storeId, input, props.token);
      props.onProductSaved(saved);
      setSelectedId(saved.productId);
      setSlot({ ...slot, product: saved, allowedActions: saved.allowedActions, writeLock: saved.writeLock });
      props.onNotice(`商品已保存：${saved.title} v${saved.version}`);
    });
  };

  const createPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !can(selected, 'CREATE_CONCESSION_PREVIEW')) return;
    await run(async () => {
      const result = await createAdminConcessionPreview(selected.productId, selected.merchantConcessionBps, adminCommandKey('catalog-preview'), props.token);
      setPreview(result);
      props.onNotice(`让利和应收已检查：${selected.title}`);
    });
  };

  const submitReview = async () => {
    if (!selected || !preview || !can(selected, 'SUBMIT_REVIEW')) return;
    await run(async () => {
      const saved = await submitAdminProductReview(selected.productId, preview.previewId, adminCommandKey('catalog-review-submit'), props.token);
      props.onProductSaved(saved);
      props.onNotice(`已提交平台审核，当前状态：${lifecycleText(saved.lifecycleState)}`);
    });
  };

  const decide = async (decision: CatalogReviewDecision) => {
    if (!selected || !can(selected, decision)) return;
    await run(async () => {
      const reasonCode = normalizedReason(decisionReason, defaultReviewReason(decision));
      const saved = await decideAdminProductReview(selected.productId, decision, reasonCode, adminCommandKey(`catalog-${decision.toLowerCase()}`), props.token);
      props.onProductSaved(saved);
      setDecisionReason('');
      props.onNotice(`已执行：${decisionText(decision)}，当前状态：${lifecycleText(saved.lifecycleState)}`);
    });
  };

  const adjustInventory = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !can(selected, 'ADJUST_INVENTORY')) return;
    await run(async () => {
      const result = await adjustAdminCatalogInventory(inventorySkuId, inventoryDelta, normalizedReason(inventoryReason, 'STOCK_ADJUSTMENT'), adminCommandKey('catalog-inventory'), props.token);
      setAdjustment(result);
      props.onNotice(`库存调整已保存：${result.adjustmentId}`);
      props.onReload();
    });
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    props.onError(null);
    try { await action(); } catch (cause) { props.onError(asCoreError(cause)); } finally { setBusy(false); }
  };

  const loadProduct = (product: ManagedCatalogProduct) => {
    setDraft(draftFromProduct(product));
    setSlot(null);
    props.onNotice(`已载入 ${product.title}，保存前请先读取门店商品槽。`);
  };

  return (
    <div className="catalog-product-layout">
      <section className="panel catalog-product-list" aria-labelledby="managed-products-title">
        <div className="panel-heading"><div><p className="section-kicker">商品列表</p><h2 id="managed-products-title">全商品列表</h2></div><span className="status-chip status-ready">{filtered.length} / {props.products.length}</span></div>
        <label className="catalog-filter"><Search aria-hidden="true" /><span className="sr-only">筛选商品</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="商品 / 商家 / 门店 / 状态" /></label>
        <div className="catalog-product-items">
          {filtered.map((product) => (
            <button className={selectedId === product.productId ? 'catalog-product-row is-selected' : 'catalog-product-row'} key={product.productId} type="button" onClick={() => { setSelectedId(product.productId); setPreview(null); setAdjustment(null); }}>
              <span className="product-row-title"><strong>{product.title}</strong><small>v{product.version} · {product.skus.length} 个规格</small></span>
              <span className={`catalog-state catalog-state-${product.lifecycleState.toLowerCase()}`}>{lifecycleText(product.lifecycleState)}</span>
              <span className="product-row-meta"><small>{friendlyEntityId('商家', product.merchantId)}</small><small>{product.storeId ? friendlyEntityId('门店', product.storeId) : '未绑定门店'}</small></span>
              {product.writeLock ? <span className="catalog-row-lock"><ShieldAlert aria-hidden="true" />该商品当前不能改：{lockStateLabel(product.writeLock.state)}</span> : null}
            </button>
          ))}
          {filtered.length === 0 ? <div className="catalog-list-empty" role="status"><Ban aria-hidden="true" /><span>{props.products.length ? '没有匹配商品' : '当前还没有商品'}</span></div> : null}
        </div>
      </section>

      <section className="panel catalog-product-detail" aria-labelledby="product-detail-title">
        {selected ? (
          <>
            <div className="panel-heading">
              <div><p className="section-kicker">商品详情 · v{selected.version}</p><h2 id="product-detail-title">{selected.title}</h2></div>
              {props.canWrite && selected.allowedActions.includes('SAVE_DRAFT') ? <button className="button button-quiet" type="button" onClick={() => loadProduct(selected)}><RefreshCw aria-hidden="true" />载入编辑表单</button> : null}
            </div>
            <ProductSnapshot product={selected} categories={props.categories} tags={props.tags} />
            <ProductAdvancedDetails product={selected} />
            <ProductMedia product={selected} token={props.token} />
            <SkuTable product={selected} />
            {props.canWrite ? (
              <div className="catalog-action-stack">
                <ConcessionPanel busy={busy} preview={preview} product={selected} onCreate={createPreview} onSubmitReview={() => void submitReview()} />
                <ReviewPanel busy={busy} product={selected} reason={decisionReason} onReasonChange={setDecisionReason} onDecide={(decision) => void decide(decision)} />
                <InventoryPanel adjustment={adjustment} busy={busy} product={selected} skuId={inventorySkuId} delta={inventoryDelta} reason={inventoryReason} onSkuChange={setInventorySkuId} onDeltaChange={setInventoryDelta} onReasonChange={setInventoryReason} onSubmit={adjustInventory} />
              </div>
            ) : <div className="catalog-readonly-note"><Ban aria-hidden="true" /><span>审核员只读：可以看商品资料，但不能审核、调库存或修改商品。</span></div>}
          </>
        ) : <div className="catalog-detail-empty"><Boxes aria-hidden="true" /><h2 id="product-detail-title">选择商品</h2><p>查看商品资料、规格、媒体和平台可操作项。</p></div>}
      </section>

      {props.canWrite ? (
        <section className="panel catalog-proxy-editor" aria-labelledby="proxy-product-title">
          <div className="panel-heading"><div><p className="section-kicker">门店商品位</p><h2 id="proxy-product-title">替商家建商品</h2></div><button className="button button-quiet" type="button" onClick={() => { setDraft(emptyDraft()); setSlot(null); }}><Plus aria-hidden="true" />新表单</button></div>
          <form className="catalog-product-form" onSubmit={submitProduct}>
            <fieldset>
              <legend>先确认门店和商家匹配</legend>
              <div className="form-grid">
                <label>门店编号<input value={draft.storeId} onChange={(event) => setDraft({ ...draft, storeId: event.target.value })} required /><small>从商家门店详情复制，不要手打。</small></label>
                <label>商家编号<input value={draft.merchantId} onChange={(event) => setDraft({ ...draft, merchantId: event.target.value })} required /><small>从商家中心复制，保存前必须先确认。</small></label>
              </div>
              <button className="button button-quiet" type="button" onClick={() => void checkSlot()} disabled={busy || !draft.storeId.trim() || !draft.merchantId.trim()}><KeyRound aria-hidden="true" />确认可以保存</button>
              {slot ? <SlotEvidence slot={slot} /> : <p className="catalog-form-hint">先点“确认可以保存”。系统会检查门店和商家是否匹配，避免建错。</p>}
            </fieldset>
            <fieldset>
              <legend>商品内容</legend>
              <div className="form-grid">
                <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={60} required /></label>
                <label>副标题<input value={draft.subtitle} onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} maxLength={120} /></label>
                <label>默认运费（USDT）<input inputMode="decimal" value={draft.defaultFreightUsdt} onChange={(event) => setDraft({ ...draft, defaultFreightUsdt: event.target.value })} placeholder="例如 0 或 5.00" required /></label>
                <label>商家让利比例（%）<input type="number" min="0" max="100" step="0.01" value={draft.merchantConcessionPercent} onChange={(event) => setDraft({ ...draft, merchantConcessionPercent: event.target.value })} required /></label>
                <label>类目<select value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}><option value="">未分类</option>{props.categories.filter((category) => category.status === 'ENABLED').map((category) => <option key={category.categoryId} value={category.categoryId}>L{category.level} · {category.name}</option>)}</select></label>
              </div>
              <details className="catalog-technical-evidence"><summary>媒体核验信息</summary>
                <label>图片资产编号，每行一个<textarea rows={3} value={draft.mainImageAssetIds} onChange={(event) => setDraft({ ...draft, mainImageAssetIds: event.target.value })} /></label>
                <label>视频资产编号，选填<input value={draft.videoAssetId} onChange={(event) => setDraft({ ...draft, videoAssetId: event.target.value })} /></label>
              </details>
              <label>商品详情<textarea rows={5} value={draft.richDetail} onChange={(event) => setDraft({ ...draft, richDetail: event.target.value })} placeholder="写材质、规格、卖点、发货说明。普通文字即可。" /></label>
              <fieldset className="catalog-checkbox-group"><legend>履约方式</legend>{(['DELIVERY', 'PICKUP'] as const).map((mode) => <label key={mode}><input type="checkbox" checked={draft.fulfillmentModes.includes(mode)} onChange={() => setDraft({ ...draft, fulfillmentModes: toggle(draft.fulfillmentModes, mode) })} />{fulfillmentText(mode)}</label>)}</fieldset>
              <fieldset className="catalog-checkbox-group"><legend>标签</legend>{props.tags.filter((tag) => tag.status === 'ENABLED').map((tag) => <label key={tag.tagId}><input type="checkbox" checked={draft.tagIds.includes(tag.tagId)} onChange={() => setDraft({ ...draft, tagIds: toggle(draft.tagIds, tag.tagId) })} />{tag.name}</label>)}</fieldset>
            </fieldset>
            <fieldset><legend>规格、价格和库存</legend><p className="catalog-form-hint">新商品不用填规格编号；编辑已有规格时才保留规格编号。</p><div className="catalog-sku-editor">{draft.skus.map((sku, index) => <SkuEditor key={index} index={index} sku={sku} canRemove={draft.skus.length > 1} onChange={(next) => setDraft({ ...draft, skus: draft.skus.map((item, itemIndex) => itemIndex === index ? next : item) })} onRemove={() => setDraft({ ...draft, skus: draft.skus.filter((_, itemIndex) => itemIndex !== index) })} />)}</div><button className="button button-quiet" type="button" onClick={() => setDraft({ ...draft, skus: [...draft.skus, emptySku()] })}><Plus aria-hidden="true" />添加规格</button></fieldset>
            <button className="button button-primary" type="submit" disabled={busy || !slot?.allowedActions.includes('SAVE_DRAFT')}><Save aria-hidden="true" />保存商品资料</button>
            <p className="catalog-form-hint"><History aria-hidden="true" />有历史订单的商品不会被覆盖，系统会保留旧快照。</p>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function ProductSnapshot({ product, categories, tags }: { product: ManagedCatalogProduct; categories: readonly CatalogCategory[]; tags: readonly CatalogTag[] }) {
  return <dl className="catalog-product-facts"><div><dt>状态</dt><dd>{lifecycleText(product.lifecycleState)}</dd></div><div><dt>版本</dt><dd>{product.version}</dd></div><div><dt>商家 / 门店</dt><dd>{friendlyEntityId('商家', product.merchantId)}<small>{product.storeId ? friendlyEntityId('门店', product.storeId) : '未绑定门店'}</small></dd></div><div><dt>让利比例</dt><dd>{formatBpsAsPercent(product.merchantConcessionBps)}</dd></div><div><dt>类目</dt><dd>{categories.find((item) => item.categoryId === product.categoryId)?.name ?? product.categoryId ?? '未分类'}</dd></div><div><dt>标签</dt><dd>{product.tagIds.map((id) => tags.find((tag) => tag.tagId === id)?.name ?? id).join(' · ') || '无'}</dd></div></dl>;
}

function ProductAdvancedDetails({ product }: { product: ManagedCatalogProduct }) {
  return <details className="catalog-technical-evidence"><summary>系统核验信息：完整编号、锁定和系统凭证</summary><dl className="definition-grid catalog-technical-list"><div><dt>商品编号</dt><dd><code>{product.productId}</code></dd></div><div><dt>商家编号</dt><dd><code>{product.merchantId}</code></dd></div><div><dt>门店编号</dt><dd><code>{product.storeId ?? '未绑定门店'}</code></dd></div><div><dt>商品规则凭证</dt><dd><code>{product.productPolicyHash}</code></dd></div><div><dt>替代历史商品</dt><dd><code>{product.supersedesProductId ?? '无'}</code></dd></div><div><dt>现在能做</dt><dd><span className="catalog-action-chips">{product.allowedActions.length ? product.allowedActions.map((action) => <code key={action}>{catalogActionLabel(action)}</code>) : <small>无写操作</small>}</span></dd></div><div><dt>锁定原因</dt><dd>{product.writeLock ? <span className="catalog-lock-inline"><ShieldAlert aria-hidden="true" />{lockTypeLabel(product.writeLock.type)} · <code>{product.writeLock.id}</code> · {lockStateLabel(product.writeLock.state)}</span> : <span className="catalog-lock-inline"><Check aria-hidden="true" />无锁定原因</span>}</dd></div></dl></details>;
}

function ProductMedia({ product, token }: { product: ManagedCatalogProduct; token: string }) {
  if (!product.mainImageAssetIds.length && !product.videoAssetId) return null;
  return <section className="catalog-media-grid" aria-label="商品媒体">{product.mainImageAssetIds.map((assetId, index) => <CatalogMediaAccess assetId={assetId} key={assetId} label={`主图 ${index + 1}`} token={token} />)}{product.videoAssetId ? <CatalogMediaAccess assetId={product.videoAssetId} label="商品视频" token={token} /> : null}</section>;
}

function SkuTable({ product }: { product: ManagedCatalogProduct }) {
  return <div className="table-scroll"><table className="data-table catalog-sku-table"><thead><tr><th>规格</th><th>售价 / 商家应收</th><th>库存</th><th>秒杀库存</th><th>状态</th></tr></thead><tbody>{product.skus.map((sku, index) => <tr key={sku.skuId}><td><strong>规格 {index + 1}</strong><small>{attributeText(sku.attributes)}</small><details className="catalog-row-technical"><summary>规格编号</summary><code>{sku.skuId}</code></details></td><td className="tabular"><strong>{formatUsdt(sku.listPriceUsdt)}</strong><small>商家应收 {formatUsdt(sku.merchantBaseReceivableUsdt)}</small></td><td className="tabular"><strong>{sku.stockAvailable} 可售</strong><small>{sku.stockReserved} 普通订单锁定 / {sku.stockTotal} 总库存</small></td><td className="tabular"><strong>{sku.proposedSeckillInventory} 提报</strong><small>{sku.stockSeckillLocked} 已被秒杀草稿锁定</small></td><td>{lifecycleText(sku.lifecycleState)}</td></tr>)}</tbody></table></div>;
}

function ConcessionPanel(props: { busy: boolean; product: ManagedCatalogProduct; preview: MerchantConcessionPreview | null; onCreate(event: FormEvent): void; onSubmitReview(): void }) {
  if (!props.product.allowedActions.includes('CREATE_CONCESSION_PREVIEW') && !props.preview) return null;
  return <section className="catalog-command-panel"><div className="panel-heading"><div><p className="section-kicker">审核前确认</p><h3>让利和应收检查</h3></div><FileSignature aria-hidden="true" /></div>{props.product.allowedActions.includes('CREATE_CONCESSION_PREVIEW') ? <form className="inline-query-form" onSubmit={props.onCreate}><p className="catalog-form-hint">先检查让利、商家应收和资金去向，再提交平台审核。</p><button className="button button-primary" type="submit" disabled={props.busy}><FileSignature aria-hidden="true" />检查让利和应收</button></form> : null}{props.preview ? <><PreviewEvidence preview={props.preview} /><div className="inline-query-form"><p className="catalog-form-hint">确认无误后提交，系统会自动带上必要的防重复标记。</p><button className="button button-primary" type="button" onClick={props.onSubmitReview} disabled={props.busy || !props.product.allowedActions.includes('SUBMIT_REVIEW')}><ClipboardCheck aria-hidden="true" />提交平台审核</button></div></> : null}</section>;
}

function PreviewEvidence({ preview }: { preview: MerchantConcessionPreview }) {
  return <div className="catalog-preview"><p className="healthy-copy" role="status"><Check aria-hidden="true" />预览有效期至 {formatDate(preview.expiresAt)}</p><div className="table-scroll"><table className="data-table"><thead><tr><th>规格</th><th>商家基础应收</th><th>让利比例</th><th>商家净应收</th><th>让利去向</th></tr></thead><tbody>{preview.payload.items.map((item, index) => <tr key={item.skuId}><td title={item.skuId}>规格 {index + 1}</td><td>{formatUsdt(item.merchantBaseReceivableUsdt)}</td><td><strong>{formatBpsAsPercent(item.merchantConcessionBps)}</strong><small>折算金额 {formatUsdt(item.merchantConcessionAmount)}</small></td><td>{formatUsdt(item.merchantNetReceivableUsdt)}</td><td>{item.allocations.map((allocation) => <small key={allocation.pool}>{poolText(allocation.pool)}：{formatUsdt(allocation.amount)}（{balanceStateLabel(allocation.balanceState)}）</small>)}</td></tr>)}</tbody></table></div><details className="catalog-technical-evidence"><summary>签名核验信息</summary><dl className="definition-grid"><div><dt>预览编号</dt><dd><code>{shortId(preview.previewId)}</code></dd></div><div><dt>资金规则</dt><dd>{preview.policyVersion}</dd></div><div><dt>签名钱包</dt><dd><code>{shortId(preview.authorization.signer)}</code></dd></div><div><dt>签名摘要</dt><dd><code>{shortId(preview.authorization.digest)}</code></dd></div><div><dt>商品指纹</dt><dd><code>{shortId(preview.catalogFingerprint)}</code></dd></div></dl></details></div>;
}

function ReviewPanel(props: { busy: boolean; product: ManagedCatalogProduct; reason: string; onReasonChange(value: string): void; onDecide(decision: CatalogReviewDecision): void }) {
  const decisions = catalogReviewDecisions.filter((decision) => props.product.allowedActions.includes(decision));
  if (!decisions.length) return null;
  const reasonInvalid = props.reason.trim() !== '' && !reasonPattern.test(props.reason.trim().toUpperCase());
  return <section className="catalog-command-panel"><div className="panel-heading"><div><p className="section-kicker">平台审核</p><h3>审核与发布</h3></div><ClipboardCheck aria-hidden="true" /></div><label>处理意见（可不填）<input value={props.reason} onChange={(event) => props.onReasonChange(event.target.value.toUpperCase())} placeholder="不填则自动生成" /></label>{reasonInvalid ? <p className="catalog-form-error" role="alert">如需填写，请使用大写字母、数字或下划线。</p> : null}<div className="button-row">{decisions.map((decision) => { const Icon = decisionIcons[decision]; return <button className={decision === 'REJECT' || decision === 'HIDE' || decision === 'DELIST' ? 'button button-danger' : 'button button-primary'} key={decision} type="button" onClick={() => props.onDecide(decision)} disabled={props.busy || reasonInvalid}><Icon aria-hidden="true" />{decisionText(decision)}</button>; })}</div></section>;
}

function InventoryPanel(props: { adjustment: InventoryAdjustmentProjection | null; busy: boolean; product: ManagedCatalogProduct; skuId: string; delta: string; reason: string; onSkuChange(value: string): void; onDeltaChange(value: string): void; onReasonChange(value: string): void; onSubmit(event: FormEvent): void }) {
  if (!props.product.allowedActions.includes('ADJUST_INVENTORY')) return null;
  const reasonInvalid = props.reason.trim() !== '' && !reasonPattern.test(props.reason.trim().toUpperCase());
  return <section className="catalog-command-panel"><div className="panel-heading"><div><p className="section-kicker">库存管理</p><h3>平台库存调整</h3></div><PackagePlus aria-hidden="true" /></div><form className="form-grid" onSubmit={props.onSubmit}><label>规格<select value={props.skuId} onChange={(event) => props.onSkuChange(event.target.value)} required><option value="">选择规格</option>{props.product.skus.map((sku, index) => <option key={sku.skuId} value={sku.skuId}>规格 {index + 1} · {attributeText(sku.attributes)}</option>)}</select></label><label>调整数量<input inputMode="numeric" value={props.delta} onChange={(event) => props.onDeltaChange(event.target.value)} placeholder="10 或 -3" required /></label><label>原因（可不填）<input value={props.reason} onChange={(event) => props.onReasonChange(event.target.value.toUpperCase())} placeholder="不填则自动生成" /></label>{reasonInvalid ? <p className="catalog-form-error" role="alert">如需填写，请使用大写字母、数字或下划线。</p> : null}<button className="button button-primary" type="submit" disabled={props.busy || !props.skuId || !/^-?[1-9][0-9]*$/.test(props.delta) || reasonInvalid}><PackagePlus aria-hidden="true" />保存库存调整</button></form>{props.adjustment ? <p className="healthy-copy" role="status"><Check aria-hidden="true" />库存已更新：{props.adjustment.beforeAvailable} → {props.adjustment.afterAvailable} 可售</p> : null}</section>;
}

function SlotEvidence({ slot }: { slot: ProductSlotProjection }) {
  return <div className="catalog-slot-evidence"><div><span>当前商品</span><strong>{slot.product?.title ?? '空槽'}</strong></div><div><span>是否可保存</span><strong>{slot.allowedActions.includes('SAVE_DRAFT') ? '可以保存' : '暂时不能保存'}</strong></div><div><span>写入状态</span><strong>{slot.writeLock ? '被锁定' : '无锁定'}</strong></div><details className="catalog-technical-evidence"><summary>操作核验信息</summary><dl className="definition-grid"><div><dt>现在能做</dt><dd>{slot.allowedActions.map(catalogActionLabel).join(' · ') || '无'}</dd></div><div><dt>写入锁</dt><dd>{slot.writeLock ? `${lockTypeLabel(slot.writeLock.type)} · ${shortId(slot.writeLock.id)} · ${lockStateLabel(slot.writeLock.state)}` : '无'}</dd></div></dl></details></div>;
}

function SkuEditor({ index, sku, canRemove, onChange, onRemove }: { index: number; sku: SkuDraft; canRemove: boolean; onChange(value: SkuDraft): void; onRemove(): void }) {
  const derivedBase = derivedMerchantBaseReceivable(sku.listPriceUsdt);
  return <article><div className="catalog-sku-editor-heading"><strong>规格 {index + 1}</strong>{canRemove ? <button className="icon-button" type="button" onClick={onRemove} aria-label={`删除规格 ${index + 1}`} title="删除规格"><Trash2 aria-hidden="true" /></button> : null}</div><div className="form-grid"><label>规格编号（新建可留空）<input value={sku.skuId} onChange={(event) => onChange({ ...sku, skuId: event.target.value })} /></label><label>规格说明<input value={sku.attributes} onChange={(event) => onChange({ ...sku, attributes: event.target.value })} placeholder="如：42码 / 曜石黑" /></label><label>售价（USDT）<input inputMode="decimal" value={sku.listPriceUsdt} onChange={(event) => onChange({ ...sku, listPriceUsdt: event.target.value })} placeholder="例如 2.00" required /></label><div className="catalog-form-hint"><strong>商家预计应收（USDT）</strong><output>{derivedBase ?? '输入售价后由系统计算'}</output><small>只读，实际金额以系统返回为准。</small></div><label>总库存<input type="number" min="1" step="1" value={sku.stockTotal} onChange={(event) => onChange({ ...sku, stockTotal: event.target.value })} required /></label><label>提报秒杀库存<input type="number" min="1" step="1" value={sku.proposedSeckillInventory} onChange={(event) => onChange({ ...sku, proposedSeckillInventory: event.target.value })} required /></label></div></article>;
}

function productInput(draft: ProductDraft, idempotencyKey: string): AdminProductSlotInput {
  const richDetail = parseLooseObject(draft.richDetail, '商品详情', 'description');
  const mainImageAssetIds = lines(draft.mainImageAssetIds);
  const skus = draft.skus.map((sku, index) => {
    const stockTotal = parsePositiveInteger(sku.stockTotal, `规格 ${index + 1} 总库存`);
    const proposedSeckillInventory = parsePositiveInteger(sku.proposedSeckillInventory, `规格 ${index + 1} 提报秒杀库存`);
    if (proposedSeckillInventory > stockTotal) {
      throw new Error(`规格 ${index + 1} 提报秒杀库存不能大于总库存`);
    }
    return {
      ...(sku.skuId.trim() ? { skuId: sku.skuId.trim() } : {}),
      attributes: parseLooseObject(sku.attributes, `规格 ${index + 1} 说明`, 'spec'),
      listPriceUsdt: parseUsdtInput(sku.listPriceUsdt, `规格 ${index + 1} 售价`, true),
      stockTotal,
      proposedSeckillInventory,
    };
  });
  return {
    merchantId: draft.merchantId.trim(),
    idempotencyKey,
    title: draft.title.trim(),
    ...(draft.subtitle.trim() ? { subtitle: draft.subtitle.trim() } : {}),
    ...(mainImageAssetIds.length ? { mainImageAssetIds } : {}),
    ...(draft.videoAssetId.trim() ? { videoAssetId: draft.videoAssetId.trim() } : {}),
    richDetail,
    defaultFreightUsdt: parseUsdtInput(draft.defaultFreightUsdt, '默认运费', false),
    merchantConcessionBps: percentToBps(draft.merchantConcessionPercent),
    fulfillmentModes: draft.fulfillmentModes,
    ...(draft.categoryId ? { categoryId: draft.categoryId } : {}),
    ...(draft.tagIds.length ? { tagIds: draft.tagIds } : {}),
    skus,
  };
}

function draftFromProduct(product: ManagedCatalogProduct): ProductDraft {
  return {
    storeId: product.storeId ?? '',
    merchantId: product.merchantId,
    title: product.title,
    subtitle: product.subtitle,
    mainImageAssetIds: product.mainImageAssetIds.join('\n'),
    videoAssetId: product.videoAssetId ?? '',
    richDetail: objectDraftText(product.richDetail, 'description'),
    defaultFreightUsdt: formatUsdtInput(product.defaultFreightUsdt),
    merchantConcessionPercent: bpsToPercentInput(product.merchantConcessionBps),
    fulfillmentModes: [...product.fulfillmentModes],
    categoryId: product.categoryId ?? '',
    tagIds: [...product.tagIds],
    skus: product.skus.map((sku) => ({
      skuId: sku.skuId,
      attributes: objectDraftText(sku.attributes, 'spec'),
      listPriceUsdt: formatUsdtInput(sku.listPriceUsdt),
      stockTotal: sku.stockTotal,
      proposedSeckillInventory: sku.proposedSeckillInventory,
    })),
  };
}

function adminCommandKey(prefix: string) {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`.slice(0, 128);
}

function percentToBps(value: string) {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(trimmed)) throw new Error('商家让利比例请填写 0 到 100 之间的数字，最多两位小数');
  const [whole, fraction = ''] = trimmed.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new Error('商家让利比例请填写 0 到 100 之间的数字');
  return bps;
}

function parsePositiveInteger(value: string, label: string) {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) throw new Error(`${label}请填写正整数，不能有小数。`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label}数字太大，请重新填写。`);
  return parsed;
}

function bpsToPercentInput(value: number) {
  const percent = value / 100;
  return Number.isInteger(percent) ? String(percent) : String(percent).replace(/0+$/, '').replace(/\.$/, '');
}

function parseLooseObject(value: string, label: string, plainKey: string) {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (!trimmed.startsWith('{')) return { [plainKey]: trimmed };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label}可以直接写普通文字；如果写系统对象，请保证格式正确。`);
  }
}

function objectDraftText(value: Readonly<Record<string, unknown>>, preferredKey: string) {
  const keys = Object.keys(value);
  if (!keys.length) return '';
  if (keys.length === 1 && typeof value[preferredKey] === 'string') return String(value[preferredKey]);
  return JSON.stringify(value, null, 2);
}

function lines(value: string) { return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean); }
function toggle<T extends string>(values: readonly T[], value: T): T[] { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function can(product: ManagedCatalogProduct, action: CatalogProductAction) { return product.allowedActions.includes(action); }
function friendlyEntityId(label: string, value: string) {
  const raw = value.includes(':') ? value.split(':').pop() ?? value : value;
  return `${label} ${shortId(raw, 6, 4)}`;
}
function attributeText(attributes: Readonly<Record<string, unknown>>) { return Object.entries(attributes).map(([key, value]) => key === 'spec' ? String(value) : `${key}: ${String(value)}`).join(' · ') || '无规格'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '商品管理服务暂时无法连接，请稍后重试。', status: 503 }); }
function derivedMerchantBaseReceivable(listPriceUsdt: string) {
  try {
    const price = BigInt(parseUsdtInput(listPriceUsdt, '售价', true));
    return formatUsdt((price * 7_000n / 10_000n - price * 100n / 10_000n).toString());
  } catch {
    return null;
  }
}
function normalizedReason(value: string, fallback: string) { const normalized = value.trim().toUpperCase(); return reasonPattern.test(normalized) ? normalized : fallback; }
function defaultReviewReason(decision: CatalogReviewDecision) {
  return ({ APPROVE: 'CATALOG_APPROVED', REJECT: 'CATALOG_REJECTED', PUBLISH: 'CATALOG_PUBLISHED', HIDE: 'CATALOG_HIDDEN', DELIST: 'CATALOG_DELISTED' } as const)[decision];
}
function decisionText(decision: CatalogReviewDecision) {
  return ({ APPROVE: '审核通过', REJECT: '驳回商品', PUBLISH: '上架发布', HIDE: '隐藏商品', DELIST: '下架商品' } as const)[decision];
}
function catalogActionLabel(action: string) {
  return ({
    SAVE_DRAFT: '保存草稿',
    CREATE_CONCESSION_PREVIEW: '检查让利和应收',
    SUBMIT_REVIEW: '提交平台审核',
    APPROVE: '审核通过',
    REJECT: '驳回商品',
    PUBLISH: '上架发布',
    HIDE: '隐藏商品',
    DELIST: '下架商品',
    ADJUST_INVENTORY: '调整库存',
  } as Record<string, string>)[action] ?? action;
}
function lifecycleText(value: string) {
  return ({
    DRAFT: '草稿',
    REVIEW: '待审核',
    SCHEDULED: '待上架',
    ACTIVE: '已上架',
    SOLD_OUT: '已售罄',
    HIDDEN: '已隐藏',
    DELISTED: '已下架',
    LOCKED: '已锁定',
  } as Record<string, string>)[value] ?? value;
}
function fulfillmentText(value: FulfillmentMode) { return ({ DELIVERY: '快递发货', PICKUP: '到店自提' } as const)[value] ?? value; }
function poolText(value: string) {
  return ({ SECKILL_PRIZE: '秒杀奖池', NODE_REWARD: '节点奖励池', REWARD_RESERVE: '奖励预留池', PLATFORM: '平台池' } as Record<string, string>)[value] ?? value;
}
function balanceStateLabel(value: string) {
  return ({ LOCKED: '锁定中', AVAILABLE: '可用', REQUESTED: '已申请', SUBMITTED: '已提交', SETTLED: '已结算' } as Record<string, string>)[value] ?? value;
}
function lockStateLabel(value: string) {
  return ({ LOCKED: '锁定中', SCHEDULED: '已排期', DISPUTED: '争议中', ACTIVE: '生效中' } as Record<string, string>)[value] ?? value;
}
function lockTypeLabel(value: string) {
  return ({ SESSION: '活动占用', ORDER: '订单占用', INVENTORY: '库存占用', POLICY: '规则占用' } as Record<string, string>)[value] ?? value;
}
