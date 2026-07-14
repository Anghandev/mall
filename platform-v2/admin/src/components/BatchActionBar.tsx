import { CheckSquare, Download, FileSpreadsheet, PackageCheck, Printer, Trash2 } from 'lucide-react';

type BatchActionBarProps = {
  ordinarySoftDelete: boolean;
  immutable: boolean;
};

const commonActions = [
  { label: '导出 Excel', icon: FileSpreadsheet },
  { label: '导出 CSV', icon: Download },
  { label: '打印电子面单', icon: Printer },
  { label: '打印自提单', icon: PackageCheck },
  { label: '批量修改', icon: CheckSquare },
  { label: '批量上下架', icon: CheckSquare },
  { label: '审核通过 / 拒绝', icon: CheckSquare },
] as const;

export function BatchActionBar({ ordinarySoftDelete, immutable }: BatchActionBarProps) {
  return (
    <section className="batch-bar" aria-labelledby="batch-title">
      <div>
        <p className="section-kicker" id="batch-title">批处理</p>
        <strong className="tabular">已选择 0 项</strong>
      </div>
      <div className="batch-actions">
        {commonActions.map(({ label, icon: Icon }) => (
          <button key={label} className="button button-quiet" type="button" disabled title="等待 Core allowedActions">
            <Icon aria-hidden="true" /> {label}
          </button>
        ))}
        {ordinarySoftDelete ? (
          <button className="button button-danger" type="button" disabled title="等待 Core allowedActions">
            <Trash2 aria-hidden="true" /> 逻辑软删除 · 等待 allowedActions
          </button>
        ) : null}
      </div>
      <p className="batch-reason">
        {immutable ? '资金、链上、审计或历史证据属于不可删除资源。' : '普通资源也必须由 Core 返回逐行与批次 allowedActions 后才能执行。'}
      </p>
    </section>
  );
}
