import type { OrderBatchActionPreview } from '@abu24k/core-artifacts';
import { CheckSquare, Download, Eye, FileSpreadsheet, PackageCheck, Printer, Trash2 } from 'lucide-react';

type BatchActionBarProps = Readonly<{
  ordinarySoftDelete: boolean;
  immutable: boolean;
  selectedCount?: number;
  preview?: OrderBatchActionPreview | null;
  previewError?: string | null;
  previewLoading?: boolean;
  onPreview?(): void;
}>;

const unavailableActions = [
  { label: '导出 Excel', icon: FileSpreadsheet },
  { label: '导出 CSV', icon: Download },
  { label: '打印电子面单', icon: Printer },
  { label: '打印自提单', icon: PackageCheck },
  { label: '批量修改', icon: CheckSquare },
  { label: '批量上下架', icon: CheckSquare },
  { label: '审核通过 / 拒绝', icon: CheckSquare },
] as const;

export function BatchActionBar({
  ordinarySoftDelete,
  immutable,
  selectedCount = 0,
  preview = null,
  previewError = null,
  previewLoading = false,
  onPreview,
}: BatchActionBarProps) {
  return (
    <section className="batch-bar" aria-labelledby="batch-title">
      <div>
        <p className="section-kicker" id="batch-title">批处理</p>
        <strong className="tabular">已选择 {selectedCount} 项</strong>
      </div>
      <div className="batch-actions">
        {onPreview ? <button className="button button-primary" type="button" disabled={selectedCount < 1 || previewLoading} onClick={onPreview}><Eye aria-hidden="true" />{previewLoading ? '预览中' : '预览共同操作'}</button> : null}
        {unavailableActions.map(({ label, icon: Icon }) => (
          <button key={label} className="button button-quiet" type="button" disabled title="当前订单预览接口未发布该批量命令">
            <Icon aria-hidden="true" /> {label}
          </button>
        ))}
        {ordinarySoftDelete ? (
          <button className="button button-danger" type="button" disabled title="等待系统授权">
            <Trash2 aria-hidden="true" /> 逻辑软删除 · 待授权
          </button>
        ) : null}
      </div>
      {preview ? (
        <div className="batch-preview" role="status">
          <span>共同能做的操作</span>
          <div>{preview.enabledActionIntersection.length ? preview.enabledActionIntersection.map((action) => <code key={action}>{batchActionLabel(action)}</code>) : <strong>无共同可用操作</strong>}</div>
          <small>{preview.rows.length} 行已逐项校验。当前仅展示共同操作预览，不会直接批量写入。</small>
        </div>
      ) : null}
      {previewError ? <p className="batch-preview-error" role="alert">{previewError}</p> : null}
      <p className="batch-reason">
        {immutable ? '资金、链上、审计或历史证据属于不可删除资源。' : '普通资源也必须逐行校验通过后才能执行。'}
        {' '}CSV / Excel 请在全局操作中按资源逐行权限导出；打印、任意批量修改和批量审核在本接口保持禁用。
      </p>
    </section>
  );
}

function batchActionLabel(action: string) {
  return ({
    RECORD_SHIPMENT: '发货',
    REQUEST_FORCED_RECEIPT: '申请平台确认收货',
    VERIFY_PICKUP: '核销自提',
    DECIDE_FULFILLMENT_REQUEST: '处理履约申请',
    DECIDE_FORCED_RECEIPT: '处理强制收货',
    DECIDE_ARBITRATION: '处理仲裁',
    EXPORT: '导出',
    HIDE: '隐藏',
    DELIST: '下架',
    APPROVE: '通过',
    REJECT: '拒绝',
  } as Record<string, string>)[action] ?? action.replace(/_/g, ' ').toLowerCase();
}
