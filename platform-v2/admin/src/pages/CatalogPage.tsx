import { Ban, Boxes, DatabaseZap, RefreshCw } from 'lucide-react';
import type { CatalogProduct } from '@abu24k/core-artifacts';
import { BatchActionBar } from '../components/BatchActionBar';
import { GlobalSearch } from '../components/GlobalSearch';
import { fetchCatalogProducts } from '../coreApi';
import { useCoreResource } from '../useCoreResource';

export function CatalogPage() {
  const catalog = useCoreResource(fetchCatalogProducts);

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><Boxes aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">Core catalog projection</p>
          <h1>商品主数据</h1>
          <p>读取支付 checkpoint 发布的活跃商品、SKU、原子金额与可用库存。类目、标签和写入仍等待 Admin 契约。</p>
        </div>
        <div className="requirement-list"><code>ADM-CAT-004 · partial</code><code>2.0.0-payment.1</code></div>
      </header>

      <GlobalSearch />

      <section className="panel data-panel" aria-labelledby="catalog-heading">
        <div className="panel-heading">
          <div><p className="section-kicker">GET /v2/catalog/products</p><h2 id="catalog-heading">活跃商品与 SKU</h2></div>
          <button className="button button-quiet" type="button" onClick={catalog.reload} disabled={catalog.loading}>
            <RefreshCw aria-hidden="true" /> {catalog.loading ? '读取中' : '重新读取'}
          </button>
        </div>

        {catalog.loading ? <CatalogLoading /> : null}
        {catalog.error ? (
          <div className="resource-state resource-state-error" role="alert">
            <Ban aria-hidden="true" />
            <div><strong>{catalog.error.code}</strong><p>{catalog.error.message}</p></div>
          </div>
        ) : null}
        {catalog.data?.length === 0 ? (
          <div className="resource-state" role="status">
            <DatabaseZap aria-hidden="true" />
            <div><strong>Core 返回 0 个活跃商品</strong><p>这是服务端真实空结果，不代表商品历史为空。</p></div>
          </div>
        ) : null}
        {catalog.data && catalog.data.length > 0 ? <CatalogTable products={catalog.data} /> : null}
      </section>

      <section className="blocked-callout" aria-labelledby="catalog-write-gap">
        <Ban aria-hidden="true" />
        <div><strong id="catalog-write-gap">GAP-ADM-007 / GAP-ADM-008</strong><p>Admin 商品创建、类目标签、库存调整、结算成本与逐行 allowedActions 尚未发布。</p></div>
        <span>读取已接入，写入禁用</span>
      </section>

      <BatchActionBar ordinarySoftDelete immutable={false} />
    </>
  );
}

function CatalogLoading() {
  return (
    <div className="catalog-loading" role="status" aria-label="正在读取 Core 商品目录">
      <span /><span /><span />
    </div>
  );
}

function CatalogTable({ products }: { products: readonly CatalogProduct[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>商品</th><th>SKU / 属性</th><th>标价</th><th>可用库存</th><th>链上标识</th></tr></thead>
        <tbody>
          {products.map((product) => <ProductRows key={product.productId} product={product} />)}
        </tbody>
      </table>
    </div>
  );
}

function ProductRows({ product }: { product: CatalogProduct }) {
  if (product.skus.length === 0) {
    return (
      <tr>
        <td><strong>{product.title}</strong><code>{product.productId}</code></td>
        <td colSpan={4}><span className="continuation">Core 返回该商品无活跃 SKU</span></td>
      </tr>
    );
  }
  return product.skus.map((sku, index) => (
    <tr key={`${product.productId}:${sku.skuId}`}>
      <td>
        {index === 0 ? <><strong>{product.title}</strong><code>{product.productId}</code></> : <span className="continuation">同上</span>}
      </td>
      <td><strong>{sku.skuId}</strong><small>{attributeText(sku.attributes)}</small></td>
      <td className="tabular"><strong>{sku.listPriceUsdt}</strong><small>USDT atomic</small></td>
      <td className="tabular"><strong>{sku.stockAvailable}</strong><small>Core available</small></td>
      <td><code title={sku.chainSkuId}>{shortHash(sku.chainSkuId)}</code></td>
    </tr>
  ));
}

function attributeText(attributes: Readonly<Record<string, unknown>>) {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return '无属性';
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
