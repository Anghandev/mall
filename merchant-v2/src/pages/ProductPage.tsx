import { useCallback, useEffect, useState } from 'react';
import { Bold, ImagePlus, Italic, Link2, LockKeyhole, RefreshCw, Trash2, Underline } from 'lucide-react';
import type { CatalogProduct } from '@abu24k/core-artifacts';
import { BlockedButton, EmptyState, FieldHelp, LoadingRows, PageHeader } from '../components/ui';
import { readableError, useCoreRuntime } from '../core-runtime';

type CatalogState =
  | { phase: 'loading' }
  | { phase: 'ready'; products: readonly CatalogProduct[] }
  | { phase: 'error'; message: string };

export function ProductPage() {
  const [title, setTitle] = useState('');
  const { api, bootstrap } = useCoreRuntime();
  const [catalog, setCatalog] = useState<CatalogState>({ phase: 'loading' });

  const loadCatalog = useCallback(async () => {
    if (bootstrap.phase !== 'ready') {
      setCatalog({ phase: 'error', message: 'Core API 尚未就绪。' });
      return;
    }
    setCatalog({ phase: 'loading' });
    try {
      setCatalog({ phase: 'ready', products: await api.listCatalog() });
    } catch (error) {
      setCatalog({ phase: 'error', message: readableError(error) });
    }
  }, [api, bootstrap.phase]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  function formatDetail(command: 'bold' | 'italic' | 'underline') {
    document.execCommand(command);
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={<div className="header-status locked"><LockKeyhole aria-hidden="true" size={16} /> 写入已锁定</div>}
        description="每个店铺仅维护一个商品位，不提供商品列表。"
        eyebrow="02 / 商品与库存"
        title="单品提报"
      />
      <div className="lock-notice" role="alert">
        <LockKeyhole aria-hidden="true" size={20} />
        <div><strong>无法确认商品状态，已按最严格规则锁定</strong><p>该单品已被平台秒杀锁定，在场次截止前无权篡改数据。仅当 Core 的 `allowedActions` 明确允许编辑时解锁。</p></div>
      </div>
      <section className="section-block catalog-section" aria-labelledby="catalog-title">
        <div className="section-heading">
          <div><p className="eyebrow">Payment checkpoint</p><h2 id="catalog-title">支付批次销售目录</h2></div>
          <button className="button quiet" disabled={catalog.phase === 'loading'} onClick={() => void loadCatalog()} type="button"><RefreshCw aria-hidden="true" size={15} /> 刷新</button>
        </div>
        <p className="section-intro">Core 返回已上架商品、SKU、USDT 原子金额与可用库存。当前接口未返回商家映射，因此不将任何一条冒充为“我的单品”。</p>
        {catalog.phase === 'loading' ? <LoadingRows count={4} /> : null}
        {catalog.phase === 'error' ? <EmptyState blocked description={catalog.message} title="销售目录加载失败" /> : null}
        {catalog.phase === 'ready' && catalog.products.length === 0 ? <EmptyState description="Core 当前没有可售商品。" title="销售目录为空" /> : null}
        {catalog.phase === 'ready' && catalog.products.length > 0 ? <CatalogTable products={catalog.products} /> : null}
      </section>
      <form className="form-layout" onSubmit={(event) => event.preventDefault()}>
        <section className="section-block form-section" aria-labelledby="basic-title">
          <div className="section-heading"><div><p className="eyebrow">Basic</p><h2 id="basic-title">基本信息</h2></div><span>唯一商品位</span></div>
          <div className="field">
            <label htmlFor="product-title">商品标题</label>
            <input id="product-title" maxLength={60} onChange={(event) => setTitle(event.target.value)} placeholder="输入不超过 60 个字的商品标题" type="text" value={title} />
            <FieldHelp>{title.length} / 60</FieldHelp>
          </div>
          <fieldset className="field">
            <legend>商品主图</legend>
            <div className="upload-grid">
              <button className="upload-tile" disabled type="button"><ImagePlus aria-hidden="true" size={22} /><span>上传图片</span><small>最多 5 张</small></button>
              <div className="upload-placeholder">签名上传元数据未发布</div>
            </div>
            <FieldHelp>支持 JPG、PNG、WebP；当前仅可查看界面，不能提交本地文件。</FieldHelp>
          </fieldset>
          <div className="field">
            <span className="field-label" id="product-detail-label">商品详情</span>
            <div className="editor-shell">
              <div className="editor-toolbar" aria-label="富文本格式">
                <button aria-label="加粗" className="icon-button" onMouseDown={(event) => { event.preventDefault(); formatDetail('bold'); }} type="button"><Bold aria-hidden="true" size={17} /></button>
                <button aria-label="斜体" className="icon-button" onMouseDown={(event) => { event.preventDefault(); formatDetail('italic'); }} type="button"><Italic aria-hidden="true" size={17} /></button>
                <button aria-label="下划线" className="icon-button" onMouseDown={(event) => { event.preventDefault(); formatDetail('underline'); }} type="button"><Underline aria-hidden="true" size={17} /></button>
                <button aria-label="插入链接（Core 富文本规则未发布）" className="icon-button" disabled type="button"><Link2 aria-hidden="true" size={17} /></button>
              </div>
              <div aria-labelledby="product-detail-label" aria-multiline="true" className="rich-editor" contentEditable data-placeholder="描述商品材质、规格、使用与履约说明" role="textbox" suppressContentEditableWarning />
            </div>
          </div>
        </section>

        <section className="section-block form-section" aria-labelledby="sku-title">
          <div className="section-heading"><div><p className="eyebrow">SKU & Inventory</p><h2 id="sku-title">规格与库存</h2></div></div>
          <div className="two-column-fields">
            <div className="field"><label htmlFor="sku-name">规格名称</label><input id="sku-name" placeholder="例如：标准款 / 金色" type="text" /></div>
            <div className="field"><label htmlFor="settlement-price">商家基础应收</label><div className="input-suffix"><input disabled id="settlement-price" inputMode="decimal" placeholder="商家商品写入接口未发布" type="text" /><span>USDT</span></div><FieldHelp>销售目录故意不暴露商家成本，前端不从售价反推。</FieldHelp></div>
          </div>
          <div className="field"><label htmlFor="seckill-inventory">秒杀专属库存</label><input disabled id="seckill-inventory" inputMode="numeric" min="1" placeholder="正整数，一次性提报" type="number" /><FieldHelp>提交后不可由商家增改。</FieldHelp></div>
          <fieldset className="field">
            <legend>支持履约模式</legend>
            <div className="choice-row">
              <label><input disabled type="checkbox" /> 快递邮寄</label>
              <label><input disabled type="checkbox" /> 到店自提</label>
            </div>
          </fieldset>
          <div className="field"><label htmlFor="concession-bps">商家让利比例</label><div className="input-suffix"><input disabled id="concession-bps" inputMode="numeric" placeholder="0 - 100" type="number" /><span>%</span></div><FieldHelp>签名预览未发布；基础应收、让利、净应收和分配目的地址全部不做本地计算。</FieldHelp></div>
          <div className="form-actions">
            <button className="button danger-quiet" disabled type="button"><Trash2 aria-hidden="true" size={16} /> 清空并上新</button>
            <button className="button secondary" disabled type="button">下架</button>
            <BlockedButton>保存提报</BlockedButton>
          </div>
        </section>
      </form>
    </div>
  );
}

function CatalogTable({ products }: { products: readonly CatalogProduct[] }) {
  const rows = products.flatMap((product) => product.skus.map((sku) => ({ product, sku })));
  return (
    <div className="table-wrap catalog-table-wrap">
      <table>
        <thead><tr><th scope="col">商品</th><th scope="col">SKU / 属性</th><th scope="col">USDT 售价原子值</th><th scope="col">可用库存</th><th scope="col">链上 SKU ID</th></tr></thead>
        <tbody>
          {rows.map(({ product, sku }) => (
            <tr key={`${product.productId}:${sku.skuId}`}>
              <td><strong>{product.title}</strong><small className="table-secondary">{product.productId}</small></td>
              <td><strong>{sku.skuId}</strong><small className="table-secondary">{formatAttributes(sku.attributes)}</small></td>
              <td className="numeric-cell">{sku.listPriceUsdt}</td>
              <td className="numeric-cell">{sku.stockAvailable}</td>
              <td><code className="hash-value">{sku.chainSkuId}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatAttributes(attributes: Readonly<Record<string, unknown>>) {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return '无属性';
  return entries.map(([key, value]) => `${key}: ${displayAttribute(value)}`).join(' / ');
}

function displayAttribute(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '[结构化属性]';
}
