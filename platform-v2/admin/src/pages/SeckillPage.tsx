import type { RealtimeEventEnvelope, SeckillSessionHistoryPage, SeckillSessionProjection } from '@abu24k/core-artifacts';
import { AlertTriangle, Ban, CheckCircle2, History, Radio, RefreshCw, RotateCcw, ShieldCheck, TimerReset, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CoreApiError } from '../coreApi';
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
          setStreamError(reason || `WebSocket closed (${code})`);
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
        <div><p className="eyebrow">FINALIZED SESSION CONTROL EVIDENCE</p><h1>秒杀控盘</h1><p>读取 Core 场次快照、历史记录与 15-confirmation 接力事件；前端不推算阶段、倒计时、库存或奖池。</p></div>
        <div className="requirement-list"><code>ADM-SEK-001—005</code><code>HTTP + WS · FINAL</code></div>
      </header>

      <section className="panel admin-resource-panel">
        <div className="panel-heading"><div><p className="section-kicker">GET /v2/seckill/sessions/current</p><h2>当前场次快照</h2></div><button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button></div>
        {loading ? <div className="catalog-loading" aria-label="正在读取秒杀场次"><span /><span /><span /></div> : null}
        {error ? <ErrorView error={error} /> : null}
        {!loading && !error && !current ? <div className="empty-inline"><History aria-hidden="true" /><div><strong>Core 当前没有已发布场次</strong><p>历史场次仍从独立 history endpoint 读取。</p></div></div> : null}
        {current ? <SessionDetail session={current} /> : null}
      </section>

      <SeckillGovernanceWorkspace current={current} onRefresh={() => setReload((value) => value + 1)} />

      <section className="workspace-grid">
        <article className="panel admin-resource-panel">
          <div className="panel-heading"><div><p className="section-kicker">HTTP replay → /v2/ws</p><h2>最终接力事件</h2></div><span className={streamState === 'LIVE' ? 'status-chip status-ready' : 'status-chip status-blocked'}><Radio aria-hidden="true" />{streamState}</span></div>
          {streamError ? <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>Realtime unavailable</strong><p>{streamError}</p></div></div> : null}
          {events.length ? <div className="table-scroll"><table className="data-table seckill-event-table"><thead><tr><th>Cursor / Event</th><th>Finality</th><th>Session</th><th>发生时间</th></tr></thead><tbody>{[...events].reverse().map((event) => <tr key={event.eventId}><td><strong>{event.cursor}</strong><small>{event.eventId}</small></td><td><span className="status-chip status-ready"><CheckCircle2 aria-hidden="true" />{event.finality}</span></td><td><code>{event.resourceId}</code></td><td>{event.occurredAt}</td></tr>)}</tbody></table></div> : <p className="muted-copy">尚无 15-confirmation 接力事件；空列表不表示链路健康。</p>}
        </article>
        <aside className="panel evidence-panel">
          <p className="section-kicker">Immutable timing boundary</p><h2>计时与终局证据</h2>
          <ul className="check-list"><li><ShieldCheck aria-hidden="true" /> 3600s / 60s / +30s / cap 60s 只读</li><li><ShieldCheck aria-hidden="true" /> 接力只接受链上最终购买事件</li><li><ShieldCheck aria-hidden="true" /> `FINAL` 仅由 Core 15-confirmation 投影提供</li></ul>
          <p className="muted-copy">REORGED / FAILED 不改写本地终态；历史场次和进行中快照不随新 policyVersion 重算。</p>
        </aside>
      </section>

      <section className="panel admin-resource-panel">
        <div className="panel-heading"><div><p className="section-kicker">GET /v2/seckill/sessions/history</p><h2>历史场次</h2></div><span className="status-chip"><History aria-hidden="true" />{history.items.length} sessions</span></div>
        {history.items.length ? <div className="table-scroll"><table className="data-table seckill-history-table"><thead><tr><th>场次 / 商品</th><th>阶段</th><th>库存</th><th>奖池 · USDT atomic</th><th>时间边界</th></tr></thead><tbody>{history.items.map((session) => <tr key={session.sessionId}><td><strong>{session.product.title}</strong><code>{session.sessionId}</code></td><td>{session.phase}<small>stored {session.storedPhase}</small></td><td>{session.inventory.sold} / {session.inventory.total}<small>available {session.inventory.available}</small></td><td>{session.prizePoolUsdt}<small>{session.prizeSettlement?.state ?? '尚未冻结结算快照'}</small></td><td>{session.startsAt}<small>{session.mainDeadline}</small></td></tr>)}</tbody></table></div> : <p className="muted-copy">Core 返回真实空历史列表。</p>}
      </section>

    </>
  );
}

function SessionDetail({ session }: { session: SeckillSessionProjection }) {
  return <><div className="status-overview compact-overview"><article><span>Effective phase</span><strong>{session.phase}</strong><small>stored {session.storedPhase}</small></article><article><span>Product / SKU</span><strong>{session.product.title}</strong><small>{session.product.productId} / {session.product.skuId}</small></article><article><span>Inventory</span><strong>{session.inventory.sold} / {session.inventory.total}</strong><small>reserved {session.inventory.reserved} · available {session.inventory.available}</small></article><article><span>Prize pool · USDT atomic</span><strong>{session.prizePoolUsdt}</strong><small>policy {session.policyVersion}</small></article></div><dl className="definition-grid"><div><dt>Session ID</dt><dd><code>{session.sessionId}</code></dd></div><div><dt>Server time</dt><dd>{session.serverTime}</dd></div><div><dt>Main boundary</dt><dd>{session.startsAt}<small>{session.mainDeadline}</small></dd></div><div><dt>Relay deadline</dt><dd>{session.relayDeadline}</dd></div><div><dt>Launch timers</dt><dd>{session.timers.mainDurationSeconds}s / {session.timers.relayInitialSeconds}s / +{session.timers.relayIncrementSeconds}s / cap {session.timers.relayCapSeconds}s</dd></div><div><dt>Settlement window</dt><dd>{session.settlementEarliestAt}<small>{session.settlementDeadline}</small></dd></div><div><dt>Last buyer</dt><dd><code>{session.lastBuyerWallet ?? '—'}</code></dd></div><div><dt>Winner</dt><dd><code>{session.winnerWallet ?? '尚未最终结算'}</code></dd></div></dl>{session.prizeSettlement ? <PrizeSettlementDetail settlement={session.prizeSettlement} /> : <p className="muted-copy">Core 尚未冻结该场次的中奖候选与奖池结算快照。</p>}{session.allowedActions.length ? <p className="muted-copy">Core allowedActions evidence: <code>{session.allowedActions.join(', ')}</code></p> : <p className="muted-copy">Core 当前没有发布可执行场次动作。</p>}</>;
}

function PrizeSettlementDetail({ settlement }: { settlement: NonNullable<SeckillSessionProjection['prizeSettlement']> }) {
  const candidate = settlement.candidate;
  const review = settlement.review;
  const payout = settlement.payout;
  const rollover = ['ROLLOVER_PENDING', 'ROLLED_OVER'].includes(settlement.state);
  return <section className="seckill-prize-settlement" aria-label="秒杀大奖结算证据"><div className="panel-heading"><div><p className="section-kicker">IMMUTABLE PRIZE SNAPSHOT</p><h3>大奖候选与结算证据</h3></div>{rollover ? <RotateCcw aria-hidden="true" /> : <Trophy aria-hidden="true" />}</div><div className="seckill-action-status"><span className={settlement.state === 'QUARANTINED' ? 'status-chip status-blocked' : settlement.state === 'APPROVED' || settlement.state === 'ROLLED_OVER' ? 'status-chip status-ready' : 'status-chip'}>{settlement.state}</span><span>pool {settlement.poolAmountUsdt} USDT atomic</span></div><dl className="definition-grid seckill-prize-facts"><div><dt>Cutoff / pool snapshot</dt><dd>{settlement.cutoffAt}<small><code>{settlement.poolSnapshotHash}</code></small></dd></div><div><dt>Candidate order</dt><dd><code>{candidate?.orderId ?? '空场，无候选'}</code><small>block {candidate?.blockNumber ?? '—'} / log {candidate?.logIndex ?? '—'}</small></dd></div><div><dt>Candidate wallet</dt><dd><code>{candidate?.buyerWallet ?? '—'}</code></dd></div><div><dt>Payment event / evidence</dt><dd><code>{candidate?.paymentEventKey ?? '—'}</code><small>{candidate?.evidenceHash ?? '—'}</small></dd></div><div><dt>Human review</dt><dd>{review?.decision ?? '待审核'}<small>{review ? `${review.reasonCode} · ${review.reviewedAt}` : '人工不能更换候选人'}</small></dd></div><div><dt>Reviewer / evidence</dt><dd><code>{review?.reviewedBy ?? '—'}</code><small>{review?.evidenceHash ?? '—'}</small></dd></div><div><dt>Award journal</dt><dd><code>{settlement.awardJournalId ?? '—'}</code></dd></div><div><dt>Rollover</dt><dd><code>{settlement.rolloverTargetSessionId ?? '尚无目标场次'}</code><small>{settlement.rolloverJournalId ?? '尚无 rollover 分录'}</small></dd></div><div><dt>Payout state</dt><dd>{payout?.state ?? '未进入普通钱包支付'}<small>request {payout?.requestId ?? '—'} / transfers {payout?.transferIds.length ?? '—'}</small></dd></div><div><dt>Final execution evidence</dt><dd><code>{payout?.finalExecutionTxHashes[0] ?? '—'}</code><small>{payout?.finalExecutionTxHashes.length ?? 0} final transfers</small></dd></div></dl></section>;
}

function isNoCurrentSession(cause: unknown) {
  return cause instanceof CoreApiError && cause.status === 404 && cause.code === 'UnknownState';
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '秒杀 Core 能力不可用', status: 503 });
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p></div></div>;
}
