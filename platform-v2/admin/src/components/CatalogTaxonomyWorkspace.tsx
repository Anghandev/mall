import {
  catalogTaxonomyStatuses,
  type CatalogCategory,
  type CatalogTag,
  type CatalogTaxonomyStatus,
} from '@abu24k/core-artifacts';
import { Ban, Check, CircleOff, FolderTree, Plus, Save, Tags } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  saveCatalogCategory,
  saveCatalogTag,
  type CatalogCategoryWrite,
  type CatalogTagWrite,
} from '../catalogAdminApi';
import { CoreApiError } from '../coreApi';
import { formatBpsAsPercent } from '../display';
import { CatalogMediaAccess } from './CatalogMediaAccess';

type Props = Readonly<{
  canWrite: boolean;
  categories: readonly CatalogCategory[];
  tags: readonly CatalogTag[];
  token: string;
  onCategorySaved(category: CatalogCategory): void;
  onError(error: CoreApiError | null): void;
  onNotice(message: string): void;
  onTagSaved(tag: CatalogTag): void;
}>;

const emptyCategory = {
  iconAssetId: '',
  idempotencyKey: '',
  name: '',
  parentCategoryId: '',
  sortOrder: '0',
  status: 'ENABLED' as CatalogTaxonomyStatus,
};

const emptyTag = {
  example: '',
  idempotencyKey: '',
  name: '',
  sortOrder: '0',
  status: 'ENABLED' as CatalogTaxonomyStatus,
};

export function CatalogTaxonomyWorkspace(props: Props) {
  const orderedCategories = useMemo(() => flattenCategories(props.categories), [props.categories]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [selectedTagId, setSelectedTagId] = useState('');
  const [categoryForm, setCategoryForm] = useState(() => ({ ...emptyCategory, idempotencyKey: catalogCommandKey('catalog-category') }));
  const [tagForm, setTagForm] = useState(() => ({ ...emptyTag, idempotencyKey: catalogCommandKey('catalog-tag') }));
  const [saving, setSaving] = useState(false);
  const selectedCategory = props.categories.find((item) => item.categoryId === selectedCategoryId) ?? null;
  const selectedTag = props.tags.find((item) => item.tagId === selectedTagId) ?? null;

  useEffect(() => {
    if (!selectedCategory) return;
    setCategoryForm({
      iconAssetId: selectedCategory.iconAssetId ?? '',
      idempotencyKey: catalogCommandKey('catalog-category'),
      name: selectedCategory.name,
      parentCategoryId: selectedCategory.parentCategoryId ?? '',
      sortOrder: String(selectedCategory.sortOrder),
      status: selectedCategory.status,
    });
  }, [selectedCategory]);

  useEffect(() => {
    if (!selectedTag) return;
    setTagForm({
      example: selectedTag.example,
      idempotencyKey: catalogCommandKey('catalog-tag'),
      name: selectedTag.name,
      sortOrder: String(selectedTag.sortOrder),
      status: selectedTag.status,
    });
  }, [selectedTag]);

  const submitCategory = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.canWrite) return;
    const input: CatalogCategoryWrite = {
      idempotencyKey: categoryForm.idempotencyKey,
      name: categoryForm.name.trim(),
      sortOrder: Number(categoryForm.sortOrder),
      status: categoryForm.status,
      ...(selectedCategory
        ? { parentCategoryId: categoryForm.parentCategoryId || null }
        : categoryForm.parentCategoryId
          ? { parentCategoryId: categoryForm.parentCategoryId }
          : {}),
      ...(categoryForm.iconAssetId ? { iconAssetId: categoryForm.iconAssetId } : {}),
    };
    await run(async () => {
      const saved = await saveCatalogCategory(selectedCategoryId || null, input, props.token);
      props.onCategorySaved(saved);
      setSelectedCategoryId(saved.categoryId);
      setCategoryForm((current) => ({ ...current, idempotencyKey: catalogCommandKey('catalog-category') }));
      props.onNotice(`系统已保存类目 ${saved.categoryId} v${saved.version}`);
    });
  };

  const submitTag = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.canWrite) return;
    const input: CatalogTagWrite = {
      idempotencyKey: tagForm.idempotencyKey,
      name: tagForm.name.trim(),
      sortOrder: Number(tagForm.sortOrder),
      status: tagForm.status,
      ...(tagForm.example ? { example: tagForm.example.trim() } : {}),
    };
    await run(async () => {
      const saved = await saveCatalogTag(selectedTagId || null, input, props.token);
      props.onTagSaved(saved);
      setSelectedTagId(saved.tagId);
      setTagForm((current) => ({ ...current, idempotencyKey: catalogCommandKey('catalog-tag') }));
      props.onNotice(`系统已保存标签 ${saved.tagId} v${saved.version}`);
    });
  };

  const run = async (action: () => Promise<void>) => {
    setSaving(true);
    props.onError(null);
    try {
      await action();
    } catch (cause) {
      props.onError(asCoreError(cause));
    } finally {
      setSaving(false);
    }
  };

  const resetCategory = () => { setSelectedCategoryId(''); setCategoryForm({ ...emptyCategory, idempotencyKey: catalogCommandKey('catalog-category') }); };
  const resetTag = () => { setSelectedTagId(''); setTagForm({ ...emptyTag, idempotencyKey: catalogCommandKey('catalog-tag') }); };

  return (
    <div className="catalog-taxonomy-grid">
      <section className="panel catalog-taxonomy-panel" aria-labelledby="category-title">
        <div className="panel-heading">
          <div><p className="section-kicker">类目树</p><h2 id="category-title">三级类目树</h2></div>
          {props.canWrite ? <button className="button button-quiet" type="button" onClick={resetCategory}><Plus aria-hidden="true" />新建类目</button> : null}
        </div>
        <div className="catalog-taxonomy-list" role="list" aria-label="类目树">
          {orderedCategories.map((category) => (
            <button
              className={selectedCategoryId === category.categoryId ? 'taxonomy-row is-selected' : 'taxonomy-row'}
              key={category.categoryId}
              type="button"
              onClick={() => setSelectedCategoryId(category.categoryId)}
              style={{ paddingLeft: `${12 + (category.level - 1) * 22}px` }}
            >
              <FolderTree aria-hidden="true" />
              <span><strong>{category.name}</strong><small>L{category.level} · {category.categoryId} · v{category.version}</small></span>
              <Status status={category.status} />
            </button>
          ))}
          {orderedCategories.length === 0 ? <Empty label="当前还没有类目" /> : null}
        </div>
        {props.canWrite ? (
          <form className="catalog-compact-form" onSubmit={submitCategory}>
            <h3>{selectedCategory ? `编辑 ${selectedCategory.name}` : '新建类目版本'}</h3>
            <div className="form-grid">
              <label>类目名称<input value={categoryForm.name} onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })} maxLength={80} required /></label>
              <label>父类目<select value={categoryForm.parentCategoryId} onChange={(event) => setCategoryForm({ ...categoryForm, parentCategoryId: event.target.value })}><option value="">顶级类目</option>{props.categories.filter((category) => category.level < 3 && category.categoryId !== selectedCategoryId && category.status === 'ENABLED').map((category) => <option key={category.categoryId} value={category.categoryId}>L{category.level} · {category.name}</option>)}</select></label>
              <label>图标资源编号<input value={categoryForm.iconAssetId} onChange={(event) => setCategoryForm({ ...categoryForm, iconAssetId: event.target.value })} placeholder="上传后得到的资源编号" /></label>
              <label>排序<input inputMode="numeric" min="0" type="number" value={categoryForm.sortOrder} onChange={(event) => setCategoryForm({ ...categoryForm, sortOrder: event.target.value })} required /></label>
              <label>状态<select value={categoryForm.status} onChange={(event) => setCategoryForm({ ...categoryForm, status: event.target.value as CatalogTaxonomyStatus })}>{catalogTaxonomyStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label>
                          </div>
            <div className="catalog-decision-field"><span>服务费率</span><strong>{selectedCategory?.serviceFee.state ?? '待配置'}</strong><small>{selectedCategory?.serviceFee.valueBps === null || selectedCategory?.serviceFee.valueBps === undefined ? '未决策，界面不提交默认值' : formatBpsAsPercent(selectedCategory.serviceFee.valueBps)}</small></div>
            <p className="catalog-form-hint"><FolderTree aria-hidden="true" />选择“顶级类目”会保存为顶级；未选择父类目时，系统不会猜测归属。</p>
            <button className="button button-primary" type="submit" disabled={saving}><Save aria-hidden="true" />保存类目版本</button>
          </form>
        ) : <ReadOnlyNotice />}
        {selectedCategory?.iconAssetId ? <CatalogMediaAccess assetId={selectedCategory.iconAssetId} label={`${selectedCategory.name} 图标`} token={props.token} /> : null}
      </section>

      <section className="panel catalog-taxonomy-panel" aria-labelledby="tag-title">
        <div className="panel-heading">
          <div><p className="section-kicker">标签库</p><h2 id="tag-title">版本化标签库</h2></div>
          {props.canWrite ? <button className="button button-quiet" type="button" onClick={resetTag}><Plus aria-hidden="true" />新建标签</button> : null}
        </div>
        <div className="catalog-taxonomy-list" role="list" aria-label="标签库">
          {[...props.tags].sort(compareSort).map((tag) => (
            <button className={selectedTagId === tag.tagId ? 'taxonomy-row is-selected' : 'taxonomy-row'} key={tag.tagId} type="button" onClick={() => setSelectedTagId(tag.tagId)}>
              <Tags aria-hidden="true" /><span><strong>{tag.name}</strong><small>{tag.example || '无示例'} · v{tag.version}</small></span><Status status={tag.status} />
            </button>
          ))}
          {props.tags.length === 0 ? <Empty label="当前还没有标签" /> : null}
        </div>
        {props.canWrite ? (
          <form className="catalog-compact-form" onSubmit={submitTag}>
            <h3>{selectedTag ? `编辑 ${selectedTag.name}` : '新建标签版本'}</h3>
            <div className="form-grid">
              <label>标签名称<input value={tagForm.name} onChange={(event) => setTagForm({ ...tagForm, name: event.target.value })} maxLength={60} required /></label>
              <label>排序<input inputMode="numeric" min="0" type="number" value={tagForm.sortOrder} onChange={(event) => setTagForm({ ...tagForm, sortOrder: event.target.value })} required /></label>
              <label>状态<select value={tagForm.status} onChange={(event) => setTagForm({ ...tagForm, status: event.target.value as CatalogTaxonomyStatus })}>{catalogTaxonomyStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label>
                          </div>
            <label>前台示例<input value={tagForm.example} onChange={(event) => setTagForm({ ...tagForm, example: event.target.value })} maxLength={240} /></label>
            <button className="button button-primary" type="submit" disabled={saving}><Save aria-hidden="true" />保存标签版本</button>
          </form>
        ) : <ReadOnlyNotice />}
      </section>
    </div>
  );
}

function flattenCategories(categories: readonly CatalogCategory[]) {
  const ordered: CatalogCategory[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null) => {
    categories.filter((item) => item.parentCategoryId === parentId).sort(compareSort).forEach((item) => {
      if (seen.has(item.categoryId)) return;
      seen.add(item.categoryId); ordered.push(item); visit(item.categoryId);
    });
  };
  visit(null);
  categories.filter((item) => !seen.has(item.categoryId)).sort(compareSort).forEach((item) => ordered.push(item));
  return ordered;
}

function compareSort<T extends { sortOrder: number; name: string }>(left: T, right: T) {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN');
}

function statusLabel(status: CatalogTaxonomyStatus) {
  if (status === 'ENABLED') return '启用';
  if (status === 'DISABLED') return '停用';
  return '逻辑删除';
}

function Status({ status }: { status: CatalogTaxonomyStatus }) {
  return <span className={`taxonomy-status taxonomy-status-${status.toLowerCase()}`}>{status === 'ENABLED' ? <Check aria-hidden="true" /> : <CircleOff aria-hidden="true" />}{statusLabel(status)}</span>;
}

function Empty({ label }: { label: string }) {
  return <div className="catalog-list-empty" role="status"><Ban aria-hidden="true" /><span>{label}</span></div>;
}

function ReadOnlyNotice() {
  return <div className="catalog-readonly-note"><Ban aria-hidden="true" /><span>审核员只读：不显示类目或标签写入表单。</span></div>;
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '类目和标签服务暂时不可用', status: 503 });
}

function catalogCommandKey(scope: string) {
  return `${scope}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
