import { AlertTriangle, ArrowUpRight, Ban, CheckCircle2, DatabaseZap, LockKeyhole, Rows3 } from 'lucide-react';
import { coreState } from '../coreState';
import type { AdminModule } from '../domain/adminModules';
import { BatchActionBar } from './BatchActionBar';
import { GlobalSearch } from './GlobalSearch';

type ModuleWorkspaceProps = { module: AdminModule };

export function ModuleWorkspace({ module }: ModuleWorkspaceProps) {
  const Icon = module.icon;

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><Icon aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">{module.eyebrow}</p>
          <h1>{module.label}</h1>
          <p>{module.description}</p>
        </div>
        <div className="requirement-list" aria-label="覆盖需求">
          {module.requirements.map((requirement) => <code key={requirement}>{requirement}</code>)}
        </div>
      </header>

      <GlobalSearch />

      <section className="workspace-grid">
        <article className="panel panel-main">
          <div className="panel-heading">
            <div><p className="section-kicker">资源列表</p><h2>等待 Core 投影</h2></div>
            <span className="status-chip status-blocked"><Ban aria-hidden="true" /> Disconnected</span>
          </div>
          <div className="empty-table" role="status">
            <DatabaseZap aria-hidden="true" />
            <h3>没有可验证的生产数据</h3>
            <p>{coreState.reason} 页面不会用静态样例冒充真实记录。</p>
            <button className="button button-primary" type="button" disabled><Rows3 aria-hidden="true" /> 加载资源</button>
          </div>
          <div className="table-skeleton" aria-hidden="true"><span /><span /><span /></div>
        </article>

        <aside className="panel evidence-panel">
          <div className="panel-heading"><div><p className="section-kicker">字段范围</p><h2>消费边界</h2></div><LockKeyhole aria-hidden="true" /></div>
          <ul className="check-list">
            {module.fields.map((field) => <li key={field}><CheckCircle2 aria-hidden="true" /> {field}</li>)}
          </ul>
          <hr />
          <p className="section-kicker">执行证据</p>
          <ul className="evidence-list">
            {module.evidence.map((item) => <li key={item}><ArrowUpRight aria-hidden="true" /> {item}</li>)}
          </ul>
        </aside>
      </section>

      <section className="blocked-callout" aria-labelledby={`${module.id}-blocked`}>
        <AlertTriangle aria-hidden="true" />
        <div><strong id={`${module.id}-blocked`}>所需 Core 能力</strong><p>{module.gap}</p></div>
        <span>所有写入禁用</span>
      </section>

      <BatchActionBar ordinarySoftDelete={module.ordinarySoftDelete === true} immutable={module.immutable === true} />
    </>
  );
}
