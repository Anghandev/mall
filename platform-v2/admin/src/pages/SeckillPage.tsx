import type { RealtimeEventEnvelope, SeckillSessionHistoryPage, SeckillSessionProjection } from '@abu24k/core-artifacts';
import { AlertTriangle, Ban, CheckCircle2, History, Radio, RefreshCw, RotateCcw, ShieldCheck, TimerReset, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CoreApiError } from '../coreApi';
import { formatUsdt, humanizeError } from '../display';
import { SeckillGovernanceWorkspace } from '../components/SeckillGovernanceWorkspace';
import {
  fetchCurrentSeckillSession,
  fetchSeckillSessionEvents,
  fetchSeckillSessionHistory,
  subscribeSeckillEvents,
} from '../seckillAdminApi';

type StreamState = 'IDLE' | 'REPLAYING' | 'CONNECTING' | 'LIVE' | 'DISCONNECTED' | 'ARTIFACT_MISMATCH';

export function SeckillPage() {
  const [current, setCurrent] = useState<SeckillSessionProjection | null>(null);
  const [history, setHistory] = useState<SeckillSessionHistoryPage>({ items: [], nextCursor: null });
  const [events, setEvents] = useState<readonly RealtimeEventEnvelope[]>([]);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [streamError, setStreamError] = useState('');
  const [streamState, setStreamState] = useState<StreamState>('IDLE');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError(null); setCurrent(null); setHistory({ items: [], nextCursor: null });
    void Promise.allSettled([
      fetchCurrentSeckillSession(controller.signal),
      fetchSeckillSessionHistory({ limit: 50 }, controller.signal),
    ]).then(([currentResult, historyResult]) => {
      if (!active) return;
      if (currentResult.status === 'fulfilled') setCurrent(currentResult.value);
      else if (!isNoCurrentSession(currentResult.reason)) setError(asCoreError(currentResult.reason));
      if (historyResult.status === 'fulfilled') setHistory(historyResult.value);
      else setError(asCoreError(historyResult.reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [reload]);

  const sessionId = current?.sessionId ?? null;
  useEffect(() => {
    if (!sessionId) { setEvents([]); setStreamState('IDLE'); setStreamError(''); return; }
    const controller = new AbortController();
    let active = true;
    let subscription: ReturnType<typeof subscribeSeckillEvents> | null = null;
    setEvents([]); setStreamState('REPLAYING'); setStreamError('');
    void fetchSeckillSessionEvents(sessionId, { cursor: '0', limit: 100 }, controller.signal).then((page) => {
      if (!active) return;
      setEvents(page.items);
      setStreamState('CONNECTING');
      subscription = subscribeSeckillEvents(sessionId, page.nextCursor, {
        onOpen: () => { if (active) setStreamState('LIVE'); },
        onEvent: (event) => {
          if (!active) return;
          setEvents((items) => items.some((item) => item.eventId === event.eventId) ? items : [...items, event].slice(-100));
          void fetchCurrentSeckillSession().then((session) => { if (active && session.sessionId === sessionId) setCurrent(session); }).catch((cause) => { if (active) setStreamError(asCoreError(cause).message); });
        },
        onError: (realtimeError) => { if (active) setStreamError(realtimeError.message); },
        onClose: (code, reason) => {
          if (!active) return;
          setStreamState(code === 4409 ? 'ARTIFACT_MISMATCH' : 'DISCONNECTED');
          setStreamError(reason || `实时连接已断开（${code}）`);
        },
      });
    }).catch((cause) => {
      if (!active || controller.signal.aborted) return;
      setStreamState('DISCONNECTED');
      setStreamError(asCoreError(cause).message);
    });
    return () => { active = false; controller.abort(); subscription?.close(); };
  }, [sessionId, reload]);

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><TimerReset aria-hidden="true" /></div>
        <div><p className="eyebrow">秒杀场次管理</p><h1>秒杀活动管理</h1><p>查看当前秒杀、历史场次和确认记录；页面只展示系统确认结果，不手动改状态。</p></div>
        <div className="requirement-list"><code>场次</code><code>确认记录</code></div>
      </header>

      <section className="panel admin-resource-panel">
        <div className="panel-heading"><div><p className="section-kicker">当前场次</p><h2>当前场次快照</h2></div><button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button></div>
        {loading ? <div className="catalog-loading" aria-label="正在读取秒杀场次"><span /><span /><span /></div> : null}
        {error ? <ErrorView error={error} /> : null}
        {!loading && !error && !current ? <div className="empty-inline"><History aria-hidden="true" /><div><strong>当前没有已发布场次</strong><p>历史场次可继续查看。</p></div></div> : null}
        {current ? <SessionDetail session={current} /> : null}
      </section>

      <SeckillGovernanceWorkspace current={current} onRefresh={() => setReload((value) => value + 1)} />

      <section className="workspace-grid">
        <article className="panel admin-resource-panel">
          <div className="panel-heading"><div><p className="section-kicker">实时记录</p><h2>购买接力记录</h2></div><span className={streamState === 'LIVE' ? 'status-chip status-ready' : 'status-chip status-blocked'}><Radio aria-hidden="true" />{streamStateLabel(streamState)}</span></div>
          {streamError ? <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>实时记录暂不可用</strong><p>{streamError}</p></div></div> : null}
          {events.length ? <div className="table-scroll"><table className="data-table seckill-event-table"><thead><tr><th>记录编号</th><th>确认状态</th><th>场次</th><th>发生时间</th></tr></thead><tbody>{[...events].reverse().map((event) => <tr key={event.eventId}><td><strong>{shortHash(event.eventId)}</strong><small>序号 {event.cursor}</small></td><td><span className="status-chip status-ready"><CheckCircle2 aria-hidden="true" />{finalityLabel(event.finality)}</span></td><td>{shortHash(event.resourceId)}</td><td title={event.occurredAt}>{formatDateTime(event.occurredAt)}</td></tr>)}</tbody></table></div> : <p className="muted-copy">还没有购买接力确认记录。</p>}
        </article>
        <aside className="panel evidence-panel">
          <p className="section-kicker">计时规则</p><h2>计时与确认规则</h2>
          <ul className="check-list"><li><ShieldCheck aria-hidden="true" /> 主场 60 分钟，接力 60 秒，成功购买延长 30 秒</li><li><ShieldCheck aria-hidden="true" /> 接力只接受最终确认的购买记录</li><li><ShieldCheck aria-hidden="true" /> 只有系统确认记录后才更新终局</li></ul>
          <p className="muted-copy">如果链上回滚或执行失败，页面不会自己改结果，只显示系统确认记录。</p>
        </aside>
      </section>

      <section className="panel admin-resource-panel">
        <div className="panel-heading"><div><p className="section-kicker">历史场次</p><h2>历史场次</h2></div><span className="status-chip"><History aria-hidden="true" />{history.items.length} 场</span></div>
        {history.items.length ? <div className="table-scroll"><table className="data-table seckill-history-table"><thead><tr><th>场次 / 商品</th><th>状态</th><th>库存</th><th>奖池</th><th>时间</th></tr></thead><tbody>{history.items.map((session) => <tr key={session.sessionId}><td><strong>{session.product.title}</strong><small>{shortHash(session.sessionId)}</small></td><td>{sessionPhaseLabel(session.phase)}<small>{sessionPhaseLabel(session.storedPhase)}</small></td><td>{session.inventory.sold} / {session.inventory.total}<small>可售 {session.inventory.available}</small></td><td>{formatUsdt(session.prizePoolUsdt)}<small>{session.prizeSettlement?.state ? prizeStateLabel(session.prizeSettlement.state) : '尚未生成结算快照'}</small></td><td title={`${session.startsAt} 至 ${session.mainDeadline}`}>{formatDateTime(session.startsAt)}<small>结束 {formatDateTime(session.mainDeadline)}</small></td></tr>)}</tbody></table></div> : <p className="muted-copy">当前没有历史场次。</p>}
      </section>

    </>
  );
}

function SessionDetail({ session }: { session: SeckillSessionProjection }) {
  return <>
    <div className="status-overview compact-overview">
      <article><span>当前状态</span><strong>{sessionPhaseLabel(session.phase)}</strong><small>系统记录：{sessionPhaseLabel(session.storedPhase)}</small></article>
      <article><span>商品</span><strong>{session.product.title}</strong><small>商品和规格编号在高级信息里</small></article>
      <article><span>库存</span><strong>{session.inventory.sold} / {session.inventory.total}</strong><small>预留 {session.inventory.reserved} · 可售 {session.inventory.available}</small></article>
      <article><span>奖池</span><strong>{formatUsdt(session.prizePoolUsdt)}</strong><small>{session.prizeSettlement ? prizeStateLabel(session.prizeSettlement.state) : '等待结算'}</small></article>
    </div>
    <dl className="definition-grid">
      <div><dt>场次</dt><dd title={session.sessionId}>{shortHash(session.sessionId)}</dd></div>
      <div><dt>系统更新时间</dt><dd title={session.serverTime}>{formatDateTime(session.serverTime)}</dd></div>
      <div><dt>活动时间</dt><dd title={`${session.startsAt} 至 ${session.mainDeadline}`}>{formatDateTime(session.startsAt)}<small>结束 {formatDateTime(session.mainDeadline)}</small></dd></div>
      <div><dt>接力截止</dt><dd title={session.relayDeadline}>{formatDateTime(session.relayDeadline)}</dd></div>
      <div><dt>活动计时</dt><dd>主场 {Math.round(session.timers.mainDurationSeconds / 60)} 分钟，接力 {session.timers.relayInitialSeconds} 秒，成功购买延长 {session.timers.relayIncrementSeconds} 秒</dd></div>
      <div><dt>开奖时间</dt><dd title={`${session.settlementEarliestAt} 至 ${session.settlementDeadline}`}>{formatDateTime(session.settlementEarliestAt)}<small>最晚 {formatDateTime(session.settlementDeadline)}</small></dd></div>
      <div><dt>最后购买钱包</dt><dd>{shortAddress(session.lastBuyerWallet)}</dd></div>
      <div><dt>中奖钱包</dt><dd>{session.winnerWallet ? shortAddress(session.winnerWallet) : '尚未最终结算'}</dd></div>
    </dl>
    <details className="technical-details compact">
      <summary>高级编号</summary>
      <code>商品 {session.product.productId}</code>
      <code>规格 {session.product.skuId}</code>
      <code>规则 {session.policyVersion}</code>
    </details>
    {session.prizeSettlement ? <PrizeSettlementDetail settlement={session.prizeSettlement} /> : <p className="muted-copy">系统还没有生成该场的中奖候选和奖池结算。</p>}
    {session.allowedActions.length ? <p className="muted-copy">现在能做：{session.allowedActions.map(seckillActionLabel).join('、')}</p> : <p className="muted-copy">当前没有需要处理的场次动作。</p>}
  </>;
}

function PrizeSettlementDetail({ settlement }: { settlement: NonNullable<SeckillSessionProjection['prizeSettlement']> }) {
  const candidate = settlement.candidate;
  const review = settlement.review;
  const payout = settlement.payout;
  const rollover = ['ROLLOVER_PENDING', 'ROLLED_OVER'].includes(settlement.state);
  return <section className="seckill-prize-settlement" aria-label="秒杀大奖结算记录"><div className="panel-heading"><div><p className="section-kicker">大奖结算</p><h3>中奖候选与发奖进度</h3></div>{rollover ? <RotateCcw aria-hidden="true" /> : <Trophy aria-hidden="true" />}</div><div className="seckill-action-status"><span className={settlement.state === 'QUARANTINED' ? 'status-chip status-blocked' : settlement.state === 'APPROVED' || settlement.state === 'ROLLED_OVER' ? 'status-chip status-ready' : 'status-chip'}>{prizeStateLabel(settlement.state)}</span><span>奖池 {formatUsdt(settlement.poolAmountUsdt)}</span></div><dl className="definition-grid seckill-prize-facts"><div><dt>截止时间</dt><dd title={settlement.cutoffAt}>{formatDateTime(settlement.cutoffAt)}</dd></div><div><dt>候选订单</dt><dd>{candidate?.orderId ? shortHash(candidate.orderId) : '空场，无候选'}</dd></div><div><dt>候选钱包</dt><dd>{shortAddress(candidate?.buyerWallet)}</dd></div><div><dt>人工审核</dt><dd>{review?.decision ? reviewDecisionLabel(review.decision) : '待审核'}<small>{review ? `已记录原因 · ${formatDateTime(review.reviewedAt)}` : '人工不能更换候选人'}</small></dd></div><div><dt>发奖状态</dt><dd>{payout?.state ? payoutStateLabel(payout.state) : '未进入支付'}</dd></div><div><dt>顺延场次</dt><dd>{settlement.rolloverTargetSessionId ? shortHash(settlement.rolloverTargetSessionId) : '尚无目标场次'}</dd></div></dl><details className="technical-details"><summary>高级结算证据</summary><dl className="definition-grid seckill-prize-facts"><div><dt>奖池快照</dt><dd><code title={settlement.poolSnapshotHash}>{shortHash(settlement.poolSnapshotHash)}</code></dd></div><div><dt>购买事件 / 凭证</dt><dd><code title={candidate?.paymentEventKey ?? undefined}>{shortHash(candidate?.paymentEventKey)}</code><small>{shortHash(candidate?.evidenceHash)}</small></dd></div><div><dt>审核人 / 凭证</dt><dd><code title={review?.reviewedBy ?? undefined}>{shortAddress(review?.reviewedBy)}</code><small>{review?.reasonCode ?? '无原因'} · {shortHash(review?.evidenceHash)}</small></dd></div><div><dt>奖励账本</dt><dd><code title={settlement.awardJournalId ?? undefined}>{shortHash(settlement.awardJournalId) || '—'}</code></dd></div><div><dt>顺延账本</dt><dd>{shortHash(settlement.rolloverJournalId) || '尚无顺延分录'}</dd></div><div><dt>最终转账</dt><dd><code title={payout?.finalExecutionTxHashes[0] ?? undefined}>{shortHash(payout?.finalExecutionTxHashes[0]) || '—'}</code><small>{payout?.finalExecutionTxHashes.length ?? 0} 笔</small></dd></div></dl></details></section>;
}


function streamStateLabel(value: StreamState) {
  return ({
    IDLE: '暂无实时记录',
    REPLAYING: '读取历史中',
    CONNECTING: '连接中',
    LIVE: '实时更新中',
    DISCONNECTED: '连接已断开',
    ARTIFACT_MISMATCH: '版本不一致',
  } as Record<StreamState, string>)[value];
}

function shortHash(value: string | null | undefined) {
  if (!value) return '';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function shortAddress(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function finalityLabel(value: string) {
  return value === 'FINAL' ? '已最终确认' : value;
}

function sessionPhaseLabel(value: string) {
  return ({
    DRAFT: '草稿',
    SCHEDULED: '待开始',
    LIVE: '进行中',
    RELAY: '接力中',
    CLOSED: '已结束',
    SETTLED: '已结算',
    CANCELLED: '已取消',
  } as Record<string, string>)[value] ?? value;
}

function prizeStateLabel(value: string) {
  return ({
    REVIEW_PENDING: '等待审核',
    APPROVED: '已通过',
    QUARANTINED: '已隔离',
    ROLLOVER_PENDING: '等待顺延',
    ROLLED_OVER: '已顺延',
    PAID: '已发奖',
  } as Record<string, string>)[value] ?? value;
}

function reviewDecisionLabel(value: string) {
  return value === 'APPROVE' ? '通过' : value === 'REJECT' ? '拒绝' : value;
}

function payoutStateLabel(value: string) {
  return ({
    REQUESTED: '已申请',
    SUBMITTED: '已提交',
    SETTLED: '已到账',
    RETRYABLE: '等待重试',
    FAILED: '失败',
  } as Record<string, string>)[value] ?? value;
}

function seckillActionLabel(value: string) {
  return ({
    OPEN_SESSION: '开场',
    FORCE_CLOSE: '强制截止',
    RESUME_PURCHASES: '恢复购买',
    REVIEW_WINNER: '审核中奖',
  } as Record<string, string>)[value] ?? value;
}

function isNoCurrentSession(cause: unknown) {
  return cause instanceof CoreApiError && cause.status === 404 && cause.code === 'UnknownState';
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '秒杀服务暂时不可用', status: 503 });
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>;
}
