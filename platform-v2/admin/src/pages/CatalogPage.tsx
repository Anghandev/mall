import type { CatalogCategory, CatalogTag, ManagedCatalogProduct } from '@abu24k/core-artifacts';
import { Ban, Boxes, Check, FolderTree, KeyRound, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  fetchAdminCatalogCategories,
  fetchAdminCatalogProducts,
  fetchAdminCatalogTags,
} from '../catalogAdminApi';
import { CatalogProductWorkspace } from '../components/CatalogProductWorkspace';
import { CatalogTaxonomyWorkspace } from '../components/CatalogTaxonomyWorkspace';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { humanizeError } from '../display';

type View = 'PRODUCTS' | 'TAXONOMY';

export function CatalogPage() {
  const { connect, session, status } = useCoreSession();
  const [categories, setCategories] = useState<readonly CatalogCategory[]>([]);
  const [tags, setTags] = useState<readonly CatalogTag[]>([]);
  const [products, setProducts] = useState<readonly ManagedCatalogProduct[]>([]);
  const [view, setView] = useState<View>('PRODUCTS');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canWrite = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;

  useEffect(() => {
    setCategories([]); setTags([]); setProducts([]); setError(null); setNotice('');
    if (!session || !canRead) return;
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      fetchAdminCatalogCategories(session.token, controller.signal),
      fetchAdminCatalogTags(session.token, controller.signal),
      fetchAdminCatalogProducts(session.token, controller.signal),
    ]).then(([nextCategories, nextTags, nextProducts]) => {
      setCategories(nextCategories); setTags(nextTags); setProducts(nextProducts);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(asCoreError(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [canRead, reload, session]);

  const saveCategory = (saved: CatalogCategory) => {
    setCategories((current) => replaceBy(current, saved, (item) => item.categoryId));
  };
  const saveTag = (saved: CatalogTag) => {
    setTags((current) => replaceBy(current, saved, (item) => item.tagId));
  };
  const saveProduct = (saved: ManagedCatalogProduct) => {
    setProducts((current) => replaceBy(current, saved, (item) => item.productId));
  };

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><Boxes aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">商品管理</p>
          <h1>商品主数据</h1>
          <p>类目、标签、商品、规格、图片、让利预览、审核与库存操作全部以系统返回为准；界面不自己计算金额或猜测权限。</p>
        </div>
        <div className="requirement-list"><code>商品审核</code><code>库存管理</code></div>
      </header>

      {!session ? (
        <section className="panel catalog-session-gate">
          <div><KeyRound aria-hidden="true" /><span><strong>连接平台钱包</strong><small>管理员和运营可操作，审核员只能查看。连接后系统会再次校验当前钱包权限。</small></span></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '连接中' : '连接钱包'}</button>
        </section>
      ) : !canRead ? (
        <CatalogError error={new CoreApiError({ code: 'Forbidden', message: '当前钱包没有商品管理读取权限。', status: 403 })} />
      ) : (
        <>
          <section className="catalog-overview" aria-label="商品管理概览">
            <div><span>商品</span><strong>{loading ? '—' : products.length}</strong><small>全生命周期</small></div>
            <div><span>类目</span><strong>{loading ? '—' : categories.length}</strong><small>三级版本树</small></div>
            <div><span>标签</span><strong>{loading ? '—' : tags.length}</strong><small>版本化状态</small></div>
            <div><span>当前角色</span><strong>{roleListLabel(session.roles)}</strong><small>{canWrite ? '写入仍需系统授权' : '审核员只读'}</small></div>
            <button className="icon-button" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading} aria-label="刷新商品列表" title="刷新商品列表"><RefreshCw className={loading ? 'spin' : undefined} aria-hidden="true" /></button>
          </section>
          <div className="catalog-view-switch" role="tablist" aria-label="商品管理视图">
            <button role="tab" aria-selected={view === 'PRODUCTS'} className={view === 'PRODUCTS' ? 'is-active' : undefined} type="button" onClick={() => setView('PRODUCTS')}><Boxes aria-hidden="true" />商品与库存</button>
            <button role="tab" aria-selected={view === 'TAXONOMY'} className={view === 'TAXONOMY' ? 'is-active' : undefined} type="button" onClick={() => setView('TAXONOMY')}><FolderTree aria-hidden="true" />类目与标签</button>
          </div>
          {loading ? <CatalogLoading /> : view === 'PRODUCTS' ? (
            <CatalogProductWorkspace
              canWrite={canWrite}
              categories={categories}
              products={products}
              tags={tags}
              token={session.token}
              onError={setError}
              onNotice={setNotice}
              onProductSaved={saveProduct}
              onReload={() => setReload((value) => value + 1)}
            />
          ) : (
            <CatalogTaxonomyWorkspace
              canWrite={canWrite}
              categories={categories}
              tags={tags}
              token={session.token}
              onCategorySaved={saveCategory}
              onError={setError}
              onNotice={setNotice}
              onTagSaved={saveTag}
            />
          )}
        </>
      )}
      {error ? <CatalogError error={error} /> : null}
      {notice ? <p className="healthy-copy catalog-notice" role="status"><Check aria-hidden="true" />{notice}</p> : null}
      <section className="catalog-snapshot-rule"><ShieldAlert aria-hidden="true" /><div><strong>精确阻断边界</strong><p>类目、标签、商品和库存如果被活动、预留订单或未结清记录锁定，页面会明确提示原因；历史商品只隐藏或下架，不会物理删除。</p></div></section>
    </>
  );
}

function CatalogLoading() {
  return <div className="panel catalog-page-loading" role="status" aria-label="正在读取商品管理数据"><span /><span /><span /></div>;
}

function CatalogError({ error }: { error: CoreApiError }) {
  const blocking = blockingResource(error);
  return (
    <div className="resource-state resource-state-error catalog-error" role="alert">
      <Ban aria-hidden="true" />
      <div><strong>操作失败</strong><p>{humanizeError(error)}</p>{blocking ? <details className="catalog-technical-evidence"><summary>高级锁定信息</summary><code>锁定资源：{lockResourceTypeLabel(blocking.type)} · {blocking.id} · {lockResourceStateLabel(blocking.state)}</code></details> : null}{error.correlationId ? <small>编号：{error.correlationId}</small> : null}</div>
    </div>
  );
}

function blockingResource(error: CoreApiError) {
  const candidate = error.details?.blockingResource;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const { type, id, state } = candidate as Record<string, unknown>;
  if (typeof type !== 'string' || typeof id !== 'string' || typeof state !== 'string') return null;
  return { type, id, state };
}

function replaceBy<T>(current: readonly T[], saved: T, key: (value: T) => string) {
  return current.some((item) => key(item) === key(saved)) ? current.map((item) => key(item) === key(saved) ? saved : item) : [saved, ...current];
}

function roleListLabel(roles: readonly string[]) {
  return roles.map((role) => ({
    ADMIN: '管理员',
    OPERATOR: '运营',
    AUDITOR: '审核员',
    MERCHANT: '商家',
  } as Record<string, string>)[role] ?? role).join(' / ');
}

function lockResourceTypeLabel(value: string) {
  return ({
    SESSION: '秒杀活动',
    ORDER: '订单',
    INVENTORY: '库存',
    POLICY: '规则',
    PRODUCT: '商品',
  } as Record<string, string>)[value] ?? value;
}

function lockResourceStateLabel(value: string) {
  return ({
    LOCKED: '锁定中',
    SCHEDULED: '已排期',
    ACTIVE: '生效中',
    DISPUTED: '争议中',
  } as Record<string, string>)[value] ?? value;
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '商品管理服务暂时不可用', status: 503 });
}
