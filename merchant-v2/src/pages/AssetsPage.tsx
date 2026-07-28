import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CircleDollarSign,
  Coins,
  ExternalLink,
  Landmark,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import type {
  BalanceState,
  BnmPointsBalance,
  MerchantBusinessDashboard,
  MerchantFinanceProjection,
  MerchantReceivableStatement,
  MerchantReceivableStatementPage,
  RewardSubtype,
  SettlementBalance,
  SettlementListProjection,
} from '@abu24k/core-artifacts';
import { rewardSubtypes } from '@abu24k/core-artifacts';
import { CoreApiError } from '../core-api';
import { readableError, useCoreRuntime } from '../core-runtime';
import { EmptyState, LoadingRows, Metric, PageHeader } from '../components/ui';
import { formatBnm, formatNpl, formatTokenAmount, formatUsdt, parseUsdtInput } from '../display';

type LoadState<T> =
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string };

type CommandState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string };

const payableStates = ['LOCKED', 'AVAILABLE', 'REQUESTED', 'SUBMITTED', 'SETTLED'] as const;
const bnmPointStates = ['LOCKED', 'AVAILABLE'] as const;

export function AssetsPage() {
  const { api, session, signSettlementTypedData } = useCoreRuntime();
  const [settlementsState, setSettlementsState] = useState<LoadState<SettlementListProjection>>({ phase: 'idle' });
  const [financeState, setFinanceState] = useState<LoadState<MerchantFinanceProjection>>({ phase: 'idle' });
  const [dashboardState, setDashboardState] = useState<LoadState<MerchantBusinessDashboard>>({ phase: 'idle' });
  const [receivableStatementsState, setReceivableStatementsState] = useState<LoadState<MerchantReceivableStatementPage>>({ phase: 'idle' });
  const [receivablePageLoading, setReceivablePageLoading] = useState(false);
  const [receivablePageError, setReceivablePageError] = useState<string>();
  const [settlementAmount, setSettlementAmount] = useState('');
  const [settlementCommand, setSettlementCommand] = useState<CommandState>({ phase: 'idle' });
  const settlementKey = useRef<string | undefined>(undefined);
  const sessionTokenRef = useRef(session?.token);
  sessionTokenRef.current = session?.token;

  const loadData = useCallback(async (quiet = false) => {
    if (!session) {
      setSettlementsState({ phase: 'idle' });
      setFinanceState({ phase: 'idle' });
      setDashboardState({ phase: 'idle' });
      setReceivableStatementsState({ phase: 'idle' });
      setReceivablePageLoading(false);
      setReceivablePageError(undefined);
      return;
    }
    if (!quiet) {
      setSettlementsState({ phase: 'loading' });
      setFinanceState({ phase: 'loading' });
      setDashboardState({ phase: 'loading' });
      setReceivableStatementsState({ phase: 'loading' });
    }
    setReceivablePageError(undefined);
    const token = session.token;
    const [settlementsResult, financeResult, dashboardResult, receivableStatementsResult] = await Promise.allSettled([
      api.listSettlements(token),
      api.getMerchantFinance(token),
      api.getMerchantBusinessDashboard(token),
      api.listMerchantReceivableStatements(token, { limit: 20 }),
    ]);
    if (sessionTokenRef.current !== token) return;

    if (settlementsResult.status === 'fulfilled') {
      if (settlementsResult.value.wallet.toLowerCase() !== session.walletAddress.toLowerCase()) {
        setSettlementsState({ phase: 'error', message: '结算投影与当前钱包不一致。' });
      } else {
        setSettlementsState({ phase: 'ready', value: settlementsResult.value });
      }
    } else {
      setSettlementsState({ phase: 'error', message: readableError(settlementsResult.reason) });
    }

    if (financeResult.status === 'fulfilled') {
      if (financeResult.value.merchant.settlement_wallet.toLowerCase() !== session.walletAddress.toLowerCase()) {
        setFinanceState({ phase: 'error', message: '商家财务归属与当前钱包不一致。' });
      } else {
        setFinanceState({ phase: 'ready', value: financeResult.value });
      }
    } else {
      setFinanceState({ phase: 'error', message: readableError(financeResult.reason) });
    }

    if (dashboardResult.status === 'fulfilled') {
      if (
        financeResult.status === 'fulfilled'
        && dashboardResult.value.merchant.merchantId !== financeResult.value.merchant.merchant_id
      ) {
        setDashboardState({ phase: 'error', message: '今日销售投影与商家财务归属不一致。' });
      } else {
        setDashboardState({ phase: 'ready', value: dashboardResult.value });
      }
    } else {
      setDashboardState({ phase: 'error', message: readableError(dashboardResult.reason) });
    }

    if (receivableStatementsResult.status === 'fulfilled') {
      const scopeError = merchantReceivableScopeError(receivableStatementsResult.value, session);
      setReceivableStatementsState(scopeError
        ? { phase: 'error', message: scopeError }
        : { phase: 'ready', value: receivableStatementsResult.value });
    } else {
      setReceivableStatementsState({
        phase: 'error',
        message: readableError(receivableStatementsResult.reason),
      });
    }
  }, [api, session]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const settlements = settlementsState.phase === 'ready' ? settlementsState.value : undefined;
  const finance = financeState.phase === 'ready' ? financeState.value : undefined;
  const dashboard = dashboardState.phase === 'ready' ? dashboardState.value : undefined;
  const receivableStatements = receivableStatementsState.phase === 'ready'
    ? receivableStatementsState.value
    : undefined;
  const merchantBalances = settlements?.balances.filter((balance) => (
    balance.asset === 'USDT' && balance.purpose === 'MERCHANT_RECEIVABLE'
  )) ?? [];
  const nplBalances = settlements?.balances.filter((balance) => (
    balance.asset === 'NPL' && balance.purpose === 'REWARD_LIABILITY'
  )) ?? [];
  const bnmPoints = settlements?.points ?? [];
  const disputedMerchantBalances = merchantBalances.filter((balance) => balance.state === 'DISPUTED');
  const financeAllowsSettlement = finance?.allowedActions.includes('REQUEST_MERCHANT_USDT') === true;
  const hasAvailableMerchantBalance = merchantBalances.some((balance) => balance.state === 'AVAILABLE');
  const settlementValid = isPositiveUsdtInput(settlementAmount);
  const settlementSubmitting = settlementCommand.phase === 'submitting';
  const canRequestSettlement = Boolean(
    session
    && settlements
    && financeAllowsSettlement
    && hasAvailableMerchantBalance
    && settlementValid
    && !settlementSubmitting,
  );
  function resetSettlementAttempt() {
    settlementKey.current = undefined;
    setSettlementCommand({ phase: 'idle' });
  }

  async function loadMoreReceivableStatements() {
    if (!session || !receivableStatements?.nextCursor || receivablePageLoading) return;
    const token = session.token;
    const cursor = receivableStatements.nextCursor;
    setReceivablePageLoading(true);
    setReceivablePageError(undefined);
    try {
      const nextPage = await api.listMerchantReceivableStatements(token, { cursor, limit: 20 });
      if (sessionTokenRef.current !== token) return;
      const scopeError = merchantReceivableScopeError(nextPage, session);
      if (scopeError) throw new CoreApiError('InvalidResponse', scopeError);
      setReceivableStatementsState((current) => current.phase === 'ready'
        ? {
            phase: 'ready',
            value: {
              ...nextPage,
              statements: [...current.value.statements, ...nextPage.statements],
            },
          }
        : current);
    } catch (error) {
      if (sessionTokenRef.current === token) setReceivablePageError(readableError(error));
    } finally {
      if (sessionTokenRef.current === token) setReceivablePageLoading(false);
    }
  }

  async function submitSettlement(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !canRequestSettlement) return;
    const token = session.token;
    const idempotencyKey = settlementKey.current ?? createIdempotencyKey('settlement-intent');
    settlementKey.current = idempotencyKey;
    setSettlementCommand({ phase: 'submitting' });
    try {
      const projection = await api.createSettlementIntent({
        rail: 'MERCHANT_USDT',
        amount: parseUsdtInput(settlementAmount, '结算申请金额', true),
        idempotencyKey,
      }, token);
      if (projection.intent.wallet.toLowerCase() !== session.walletAddress.toLowerCase()) {
        throw new CoreApiError('InvalidResponse', '结算意图绑定了其他钱包。');
      }
      const signature = await signSettlementTypedData(projection.typedData);
      const request = await api.submitSettlementRequest({
        intentId: projection.intent.intentId,
        signature,
      }, token);
      if (request.wallet_address.toLowerCase() !== session.walletAddress.toLowerCase()) {
        throw new CoreApiError('InvalidResponse', '结算请求返回了其他钱包。');
      }
      settlementKey.current = undefined;
      setSettlementAmount('');
      setSettlementCommand({ phase: 'success', message: `结算请求已提交，状态：${statusLabel(request.state)}，记录号：${shortId(request.request_id)}` });
      void loadData(true);
    } catch (error) {
      setSettlementCommand({ phase: 'error', message: readableError(error) });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <button className="button quiet" disabled={!session} onClick={() => void loadData()} type="button">
            <RefreshCw aria-hidden="true" size={16} /> 刷新数据
          </button>
        )}
        description="这里看货款、奖励和积分。商家只需要签名申请结算；最终到账以系统确认的链上记录为准。"
        eyebrow="05 / 财务与收益"
        title="资产清算中心"
      />

      {finance ? <FinanceRestriction finance={finance} /> : null}

      <section aria-labelledby="proceeds-title">
        <div className="section-label">
          <div><CircleDollarSign aria-hidden="true" size={18} /><h2 id="proceeds-title">USDT 商家货款</h2></div>
          <span>系统账本</span>
        </div>
        <div className="metric-grid finance-intro-grid">
          <Metric
            hint={dashboard
              ? `${dashboard.timezone} / ${dashboard.window.start} 至 ${dashboard.window.end}`
              : dashboardState.phase === 'loading'
                ? '正在读取今日销售数据'
                : dashboardState.phase === 'error'
                  ? dashboardState.message
                  : '需要已验证的商家会话'}
            label="今日销售总价"
            value={formatUsdt(dashboard?.sales.listPriceUsdt)}
          />
          <article className="metric finance-identity">
            <p>结算钱包</p>
            <strong>{finance ? shortAddress(finance.merchant.settlement_wallet) : '--'}</strong>
            <span>{finance ? `${shortId(finance.merchant.merchant_id)} / ${merchantStatusLabel(finance.merchant.status)}` : '请连接商家钱包'}</span>
          </article>
        </div>
        <ProjectionState state={settlementsState}>
          <AssetStateGrid balances={merchantBalances} label="USDT 商家货款" />
          {disputedMerchantBalances.length > 0 ? (
            <div className="inline-warning finance-warning" role="status">
              <AlertTriangle aria-hidden="true" size={17} />
              <span>仲裁锁定：{disputedMerchantBalances.map((item) => formatAssetAmount(item.amount, item.asset)).join(' / ')}</span>
            </div>
          ) : null}
        </ProjectionState>
      </section>

      <section className="section-block finance-section" aria-labelledby="receivable-statements-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">订单应收账本</p>
            <h2 id="receivable-statements-title">逐单应收账单</h2>
          </div>
          <CircleDollarSign aria-hidden="true" size={19} />
        </div>
        <p className="section-intro">
          每笔订单的冻结金额、当前余额、账本生命周期和逐笔结算引用均直接来自系统；本页只展示系统返回的金额，不手动改账。
        </p>
        <ProjectionState state={receivableStatementsState}>
          {receivableStatements?.statements.length ? (
            <div className="receivable-statement-list">
              {receivableStatements.statements.map((statement) => (
                <MerchantReceivableStatementRow key={statement.orderId} statement={statement} />
              ))}
            </div>
          ) : (
            <EmptyState description="系统还没有该商家的逐单应收记录。" title="暂无逐单应收" />
          )}
          {receivableStatements ? (
            <div className="receivable-pagination">
              <span>{receivableStatements.nextCursor ? '还有更早订单可加载' : '已加载全部逐单应收'}</span>
              {receivablePageError ? <p role="alert">{receivablePageError}</p> : null}
              <button
                className="button secondary"
                disabled={!receivableStatements.nextCursor || receivablePageLoading}
                onClick={() => void loadMoreReceivableStatements()}
                type="button"
              >
                {receivablePageLoading ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : null}
                {receivablePageLoading ? '正在加载' : '加载下一页'}
              </button>
            </div>
          ) : null}
        </ProjectionState>
      </section>

      <section className="section-block finance-section" aria-labelledby="settlement-request-title">
        <div className="section-heading">
          <div><p className="eyebrow">免手续费签名</p><h2 id="settlement-request-title">签名结算申请</h2></div>
          <WalletCards aria-hidden="true" size={19} />
        </div>
        <form className="finance-command-form" onSubmit={(event) => void submitSettlement(event)}>
          <div className="field">
            <label htmlFor="settlement-amount">申请金额（USDT）</label>
            <input
              autoComplete="off"
              id="settlement-amount"
              inputMode="decimal"
              onChange={(event) => {
                resetSettlementAttempt();
                setSettlementAmount(event.target.value.trim());
              }}
              placeholder="例如 2.00"
              value={settlementAmount}
            />
            <span className="field-help">系统会校验可申请金额；商家只需要钱包签名，到账转账由平台执行。</span>
          </div>
          <button className="button primary" disabled={!canRequestSettlement} type="submit">
            {settlementSubmitting ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <WalletCards aria-hidden="true" size={16} />}
            {settlementSubmitting ? '等待钱包与系统确认' : '签名并提交结算申请'}
          </button>
        </form>
        {!financeAllowsSettlement && finance ? (
          <p className="command-block-reason" role="status">当前商家状态为 {merchantStatusLabel(finance.merchant.status)}，系统暂不允许申请结算。请联系平台确认商家状态。</p>
        ) : !hasAvailableMerchantBalance && settlements ? (
          <p className="command-block-reason" role="status">当前没有可申请结算的货款。</p>
        ) : null}
        <CommandNotice state={settlementCommand} />
      </section>

      <section className="section-block finance-section" aria-labelledby="settlement-history-title">
        <div className="section-heading">
          <div><p className="eyebrow">打款记录</p><h2 id="settlement-history-title">结算申请与逐笔转账</h2></div>
          <Landmark aria-hidden="true" size={19} />
        </div>
        <ProjectionState state={settlementsState}>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">申请时间</th><th scope="col">类型 / 资产</th><th scope="col">金额</th><th scope="col">状态</th><th scope="col">平台打款</th><th scope="col">到账</th></tr></thead>
              <tbody>
                {settlements?.requests.length ? settlements.requests.map((request) => (
                  <tr key={request.request_id}>
                    <td><time dateTime={request.requested_at}>{formatDateTime(request.requested_at)}</time></td>
                    <td><strong>{railLabel(request.rail)}</strong><small>{assetLabel(request.asset)}</small></td>
                    <td className="mono-value">{formatAssetAmount(request.amount, request.asset)}</td>
                    <td><StatusText state={request.state} /></td>
                    <td><strong>{request.transfer_ids.length ? '平台处理中' : '等待平台处理'}</strong><details className="technical-details compact"><summary>客服核验编号</summary><small>{request.transfer_ids.map(shortId).join(', ') || '--'}</small></details></td>
                    <td>{request.final_execution_tx_hashes.length
                      ? <details className="technical-details compact"><summary>{request.final_execution_tx_hashes.length} 笔已到账</summary>{request.final_execution_tx_hashes.map((txHash) => <ExplorerHash hash={txHash} key={txHash} />)}</details>
                      : '未到账'}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={6}><EmptyState description="系统还没有该钱包的结算申请。" title="暂无结算记录" /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </ProjectionState>
      </section>

      <section className="section-block finance-section" aria-labelledby="takeover-title">
        <div className="section-heading">
          <div><p className="eyebrow">接管债务</p><h2 id="takeover-title">接管、商家债务与未来货款</h2></div>
          <AlertTriangle aria-hidden="true" size={19} />
        </div>
        <ProjectionState state={financeState}>
          <dl className="finance-summary debt-summary">
            <div><dt>累计债务</dt><dd>{formatUsdt(finance?.debt?.incurred_usdt)}</dd></div>
            <div><dt>已追偿</dt><dd>{formatUsdt(finance?.debt?.recovered_usdt)}</dd></div>
            <div><dt>未偿债务</dt><dd>{formatUsdt(finance?.debt?.outstanding_usdt)}</dd></div>
            <div><dt>最新处理记录</dt><dd className="mono-value" title={finance?.debt?.latest_evidence_hash ?? undefined}>{shortId(finance?.debt?.latest_evidence_hash) || '--'}</dd></div>
          </dl>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">案例 / 订单</th><th scope="col">状态</th><th scope="col">需求金额</th><th scope="col">冻结应收</th><th scope="col">未来货款</th><th scope="col">平台垫付 / 债务</th></tr></thead>
              <tbody>
                {finance?.takeovers.length ? finance.takeovers.map((takeover) => (
                  <tr key={takeover.case_id}>
                    <td><strong>{takeover.case_id}</strong><small className="mono-value">{takeover.order_id}</small></td>
                    <td><StatusText state={takeover.state} /></td>
                    <td>{formatUsdt(takeover.required_usdt)}</td>
                    <td>{formatUsdt(takeover.merchant_available_used_usdt)}</td>
                    <td>{formatUsdt(takeover.future_proceeds_used_usdt)}</td>
                    <td>{formatUsdt(takeover.platform_advance_usdt)} / {formatUsdt(takeover.merchant_debt_usdt)}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={6}><EmptyState description="系统还没有接管与债务案例。" title="暂无接管债务" /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </ProjectionState>
      </section>

      <div className="reward-grid">
        <section className="section-block reward-section" aria-labelledby="npl-title">
          <div className="section-heading"><div><p className="eyebrow">NPL 奖励</p><h2 id="npl-title">NPL 收益子类</h2></div><Coins aria-hidden="true" size={19} /></div>
          <ProjectionState state={settlementsState} compact>
            <RewardSubtypeGrid balances={nplBalances} />
          </ProjectionState>
        </section>
        <section className="section-block reward-section" aria-labelledby="bnm-title">
          <div className="section-heading"><div><p className="eyebrow">BNM 积分</p><h2 id="bnm-title">BNM 积分总额</h2></div><LockKeyhole aria-hidden="true" size={19} /></div>
          <ProjectionState state={settlementsState} compact>
            <BnmPointsGrid points={bnmPoints} />
          </ProjectionState>
        </section>
      </div>
    </div>
  );
}

function MerchantReceivableStatementRow({ statement }: { statement: MerchantReceivableStatement }) {
  return (
    <details className="receivable-statement">
      <summary>
        <span className="receivable-order-identity">
          <strong className="mono-value">{shortId(statement.orderId)}</strong>
          <small>{shortId(statement.productId)} / {shortId(statement.skuId)} / 数量 {statement.quantity}</small>
        </span>
        <span className="receivable-order-state">
          <StatusText state={statement.orderKind} />
          <StatusText state={statement.orderState} />
        </span>
        <span className="receivable-order-amount">
          <small>冻结净应收 / 当前应收</small>
          <strong>{formatUsdt(statement.frozenAmounts.merchantNetReceivableUsdt)} / {formatUsdt(statement.currentReceivableUsdt)}</strong>
        </span>
      </summary>
      <div className="receivable-statement-body">
        <dl className="receivable-order-facts">
          <div><dt>创建时间</dt><dd><time dateTime={statement.createdAt}>{formatDateTime(statement.createdAt)}</time></dd></div>
          <div><dt>付款确认</dt><dd><time dateTime={statement.paymentFinalizedAt}>{formatDateTime(statement.paymentFinalizedAt)}</time></dd></div>
          <div><dt>履约确认</dt><dd>{statement.fulfilledAt ? <time dateTime={statement.fulfilledAt}>{formatDateTime(statement.fulfilledAt)}</time> : '--'}</dd></div>
          <div><dt>钱包付款</dt><dd>已确认<details className="technical-details compact"><summary>客服核验编号</summary><ExplorerHash hash={statement.paymentTxHash} /></details></dd></div>
        </dl>

        <section aria-label={`订单 ${statement.orderId} 冻结应收`} className="receivable-evidence-block">
          <h3>冻结金额快照</h3>
          <dl className="receivable-amount-grid">
            <div><dt>商品总价</dt><dd>{formatUsdt(statement.frozenAmounts.listPriceUsdt)}</dd></div>
            <div><dt>商品 USDT</dt><dd>{formatUsdt(statement.frozenAmounts.productUsdtPaymentAmount)}</dd></div>
            <div><dt>平台服务费</dt><dd>{formatUsdt(statement.frozenAmounts.platformServiceFeeUsdt)}</dd></div>
            <div><dt>商家货款 USDT</dt><dd>{formatUsdt(statement.frozenAmounts.custodyProductUsdt)}</dd></div>
            <div><dt>运费 USDT</dt><dd>{formatUsdt(statement.frozenAmounts.freightUsdt)}</dd></div>
            <div><dt>买家实付 USDT</dt><dd>{formatUsdt(statement.frozenAmounts.buyerPaidUsdt)}</dd></div>
            <div><dt>基础应收</dt><dd>{formatUsdt(statement.frozenAmounts.merchantBaseReceivableUsdt)}</dd></div>
            <div><dt>商家让利</dt><dd>{formatUsdt(statement.frozenAmounts.merchantConcessionAmount)}</dd></div>
            <div><dt>净应收</dt><dd>{formatUsdt(statement.frozenAmounts.merchantNetReceivableUsdt)}</dd></div>
            <div><dt>当前应收</dt><dd>{formatUsdt(statement.currentReceivableUsdt)}</dd></div>
            <div><dt>已移出应收</dt><dd>{formatUsdt(statement.removedFromReceivableUsdt)}</dd></div>
          </dl>
        </section>

        <section aria-label={`订单 ${statement.orderId} 应收生命周期`} className="receivable-evidence-block">
          <h3>应收生命周期</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">状态</th><th scope="col">金额</th><th scope="col">账本记录</th></tr></thead>
              <tbody>
                {statement.receivableLifecycle.length ? statement.receivableLifecycle.map((entry) => (
                  <tr key={`${entry.state}:${entry.journalIds.join(':')}`}>
                    <td><StatusText state={entry.state} /></td>
                    <td className="mono-value">{formatUsdt(entry.amount)}</td>
                    <td className="mono-value">{entry.journalIds.length ? entry.journalIds.map(shortId).join(' / ') : '--'}</td>
                  </tr>
                )) : <tr><td colSpan={3}>该订单暂无应收生命周期记录。</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-label={`订单 ${statement.orderId} 账本核验信息`} className="receivable-evidence-block">
          <h3>账本核验信息</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">账本 / 时间</th><th scope="col">事件 / 状态</th><th scope="col">变动金额</th><th scope="col">来源 / 证据</th></tr></thead>
              <tbody>
                {statement.journalEvidence.length ? statement.journalEvidence.map((evidence) => (
                  <tr key={evidence.journalId}>
                    <td><strong className="mono-value">{shortId(evidence.journalId)}</strong><small><time dateTime={evidence.createdAt}>{formatDateTime(evidence.createdAt)}</time></small></td>
                    <td><strong>{eventTypeLabel(evidence.eventType)}</strong><small><StatusText state={evidence.state} /></small></td>
                    <td className="mono-value">{formatSignedUsdt(evidence.delta)}</td>
                    <td><strong>{sourceKindLabel(evidence.sourceKind)}</strong><small className="mono-value">{shortId(evidence.sourceReferenceHash)}</small></td>
                  </tr>
                )) : <tr><td colSpan={4}>该订单暂无账本核验信息。</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-label={`订单 ${statement.orderId} 结算关联记录`} className="receivable-evidence-block">
          <h3>结算核验信息</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">申请 / 金额</th><th scope="col">状态 / 转账</th><th scope="col">账本关联</th><th scope="col">到账记录</th><th scope="col">时间</th></tr></thead>
              <tbody>
                {statement.settlementRefs.length ? statement.settlementRefs.map((reference) => (
                  <tr key={reference.requestId}>
                    <td><strong className="mono-value">{shortId(reference.requestId)}</strong><small>{formatUsdt(reference.amount)}</small></td>
                    <td><StatusText state={reference.state} /><small className="mono-value">{shortId(reference.transferId) || '--'}</small></td>
                    <td className="mono-value">
                      <strong>{shortId(reference.journals.requested)}</strong>
                      <small>{shortId(reference.journals.submitted) || '--'} / {shortId(reference.journals.settled) || '--'}</small>
                    </td>
                    <td>
                      {reference.finalExecutionTxHash ? <details className="technical-details compact"><summary>客服核验编号</summary><ExplorerHash hash={reference.finalExecutionTxHash} /></details> : '--'}
                    </td>
                    <td>
                      <time dateTime={reference.requestedAt}>{formatDateTime(reference.requestedAt)}</time>
                      <small>{formatDateTime(reference.submittedAt) || '--'} / {formatDateTime(reference.settledAt) || '--'}</small>
                    </td>
                  </tr>
                )) : <tr><td colSpan={5}>该订单尚未关联结算申请。</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </details>
  );
}

function merchantReceivableScopeError(
  page: MerchantReceivableStatementPage,
  session: { merchantId: string; walletAddress: string },
) {
  if (page.merchantId !== session.merchantId) return '逐单应收投影与当前商家不一致。';
  if (page.settlementWallet.toLowerCase() !== session.walletAddress.toLowerCase()) {
    return '逐单应收投影与当前结算钱包不一致。';
  }
  return undefined;
}

function RewardSubtypeGrid({ balances }: { balances: readonly SettlementBalance[] }) {
  const unclassified = balances.some((balance) => balance.rewardSubtype === null);
  return (
    <>
      {unclassified ? (
        <div className="inline-warning finance-warning" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>系统返回了未分类的 NPL 奖励余额，已停止展示该行。</span>
        </div>
      ) : null}
      <div aria-label="NPL 奖励收益子类" className="reward-subtype-grid">
        {rewardSubtypes.map((subtype) => {
          const rows = balances.filter((balance) => balance.rewardSubtype === subtype);
          return (
            <article key={subtype}>
              <header><h3>{rewardSubtypeLabel(subtype)}</h3></header>
              {rows.length ? rows.map((row) => (
                <div className="reward-subtype-balance" key={`${subtype}:${row.state}`}>
                  <span><StatusText state={row.state} /></span>
                  <strong>{formatNpl(row.amount)}</strong>
                </div>
              )) : <p>暂无余额</p>}
            </article>
          );
        })}
      </div>
    </>
  );
}

function BnmPointsGrid({ points }: { points: readonly BnmPointsBalance[] }) {
  return (
    <div className="bnm-points-block">
      <div aria-label="BNM 锁定和可用汇总" className="bnm-points-grid">
        {bnmPointStates.map((state) => {
          const rows = points.filter((pointsBalance) => pointsBalance.state === state);
          return (
            <article key={state}>
              <h3>{state === 'LOCKED' ? '锁定总额' : '可用总额'}</h3>
              {rows.length ? rows.map((row) => (
                <div className="state-balance" key={`${row.purpose}:${row.state}`}>
                  <strong>{formatBnm(row.amount)}</strong>
                  <span>BNM</span>
                  <small>{purposeLabel(row.purpose)}</small>
                </div>
              )) : <p>暂无总额</p>}
            </article>
          );
        })}
      </div>
      <p className="bnm-transfer-boundary"><LockKeyhole aria-hidden="true" size={15} />BNM 是后台积分，不能转账，也不能在链上领取。</p>
    </div>
  );
}

function rewardSubtypeLabel(subtype: RewardSubtype) {
  const labels: Record<RewardSubtype, string> = {
    GENESIS: '创世奖励',
    DIRECT_REFERRAL: '直推奖励',
    DISTRICT: '区县奖励',
    CITY: '城市奖励',
    PROVINCE: '省级奖励',
    REGION: '大区奖励',
    OPERATIONS: '运维奖励',
    ROUNDING_REMAINDER: '取整余额',
  };
  return labels[subtype];
}

function ProjectionState<T>({
  state,
  children,
  compact = false,
}: {
  state: LoadState<T>;
  children: React.ReactNode;
  compact?: boolean;
}) {
  if (state.phase === 'loading') return <LoadingRows count={compact ? 2 : 3} />;
  if (state.phase === 'error') return <EmptyState blocked description={state.message} title="系统数据加载失败" />;
  if (state.phase === 'idle') return <EmptyState blocked description="请先连接商家钱包。" title="商家钱包未连接" />;
  return children;
}

function AssetStateGrid({
  balances,
  label,
  compact = false,
}: {
  balances: readonly SettlementBalance[];
  label: string;
  compact?: boolean;
}) {
  return (
    <div aria-label={`${label}五状态余额`} className={compact ? 'balance-state-grid compact' : 'balance-state-grid'}>
      {payableStates.map((state) => {
        const rows = balances.filter((balance) => balance.state === state);
        return (
          <article key={state}>
            <h3>{stateLabel(state)}</h3>
            {rows.length ? rows.map((row) => (
              <div className="state-balance" key={`${row.asset}:${row.purpose}:${row.state}`}>
                <strong>{formatAssetAmount(row.amount, row.asset)}</strong>
                <span>{assetLabel(row.asset)}</span>
                <small>{purposeLabel(row.purpose)}</small>
              </div>
            )) : <p>暂无余额</p>}
          </article>
        );
      })}
    </div>
  );
}

function FinanceRestriction({ finance }: { finance: MerchantFinanceProjection }) {
  if (finance.settlementEligibility.mode === 'FORMAL') {
    return (
      <div className="system-notice ready" role="status">
        <ShieldCheck aria-hidden="true" size={18} />
        <div><strong>商家财务资格正常</strong><span>商家已满足财务要求，结算仍按每笔可用货款校验。</span></div>
      </div>
    );
  }
  if (finance.settlementEligibility.mode === 'MAINNET_MICROTEST') {
    return (
      <div className="system-notice ready" role="status">
        <ShieldCheck aria-hidden="true" size={18} />
        <div>
          <strong>仅授权受控主网微测</strong>
          <span>只能结算系统绑定的测试商品应收，资格到期自动失效。</span>
        </div>
      </div>
    );
  }
  return (
    <div className="lock-notice" role="alert">
      <AlertTriangle aria-hidden="true" size={18} />
      <div>
        <strong>商家财务操作受限</strong>
        <p>当前商家状态为 {merchantStatusLabel(finance.merchant.status)}，新结算申请暂时不能提交；履约、接管、对账仍可查看和处理。</p>
      </div>
    </div>
  );
}




function formatDateTime(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function formatSignedUsdt(amount: string) {
  const sign = amount.startsWith('-') ? '-' : amount.startsWith('+') ? '+' : '';
  const raw = sign ? amount.slice(1) : amount;
  const formatted = formatUsdt(raw);
  return formatted === '--' ? '--' : `${sign}${formatted}`;
}

function formatAssetAmount(amount: string | null | undefined, asset: string) {
  if (asset === 'USDT') return formatUsdt(amount);
  if (asset === 'NPL') return formatNpl(amount);
  if (asset === 'BNM' || asset === 'BNM_POINTS') return formatBnm(amount);
  return formatTokenAmount(amount, asset);
}

function assetLabel(asset: string) {
  if (asset === 'BNM_POINTS') return 'BNM';
  return asset;
}

function railLabel(rail: string) {
  return ({
    MERCHANT_USDT: '商家货款',
    REWARD_NPL: 'NPL 奖励',
    PRIZE_USDT: '秒杀大奖',
  } as Record<string, string>)[rail] ?? rail;
}

function purposeLabel(purpose: string | null | undefined) {
  if (!purpose) return '';
  return ({
    MERCHANT_RECEIVABLE: '商家货款',
    REWARD_LIABILITY: '奖励',
  } as Record<string, string>)[purpose] ?? purpose;
}

function isPositiveUsdtInput(value: string) {
  try {
    return BigInt(parseUsdtInput(value, '金额', true)) > 0n;
  } catch {
    return false;
  }
}

function CommandNotice({ state }: { state: CommandState }) {
  if (state.phase === 'idle' || state.phase === 'submitting') return null;
  return <p className={`command-notice ${state.phase}`} role={state.phase === 'error' ? 'alert' : 'status'}>{state.message}</p>;
}

function StatusText({ state }: { state: string }) {
  return <span className={`status-text status-${state.toLowerCase()}`}>{statusLabel(state)}</span>;
}

function ExplorerHash({ hash }: { hash: string }) {
  return (
    <a className="explorer-hash mono-value" href={`https://bscscan.com/tx/${hash}`} rel="noreferrer" target="_blank" title={hash}>
      {shortId(hash)}<ExternalLink aria-hidden="true" size={14} />
    </a>
  );
}

function stateLabel(state: BalanceState) {
  const labels: Record<(typeof payableStates)[number], string> = {
    LOCKED: '锁定中',
    AVAILABLE: '可申请',
    REQUESTED: '已申请',
    SUBMITTED: '已提交',
    SETTLED: '已结算',
  };
  return state in labels ? labels[state as keyof typeof labels] : state;
}

function createIdempotencyKey(kind: string) {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `merchant-${kind}-${random}`;
}

function shortId(value: string | null | undefined) {
  if (!value) return '';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function shortAddress(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function merchantStatusLabel(value: string | null | undefined) {
  return ({
    APPROVED: '已入驻',
    PENDING: '待审核',
    REJECTED: '已拒绝',
    SUSPENDED: '已暂停',
  } as Record<string, string>)[value ?? ''] ?? (value || '--');
}

function statusLabel(value: string) {
  return ({
    LOCKED: '锁定中',
    AVAILABLE: '可申请',
    REQUESTED: '已申请',
    SUBMITTED: '已提交',
    SETTLED: '已结算',
    DISPUTED: '仲裁中',
    FINAL: '已确认',
    MINED: '确认中',
    PENDING: '处理中',
    FAILED: '失败',
    REORGED: '已回滚',
    ORDINARY: '普通订单',
    SECKILL: '秒杀订单',
    FALLBACK_RETAIL: '常规兜底订单',
  } as Record<string, string>)[value] ?? value;
}

function eventTypeLabel(value: string) {
  return ({
    MERCHANT_RECEIVABLE_LOCKED: '货款锁定',
    MERCHANT_RECEIVABLE_AVAILABLE: '货款可结算',
    SETTLEMENT_REQUESTED: '发起结算',
    SETTLEMENT_SUBMITTED: '提交转账',
    SETTLEMENT_SETTLED: '已到账',
  } as Record<string, string>)[value] ?? value;
}

function sourceKindLabel(value: string) {
  return ({
    ORDER: '订单',
    SETTLEMENT_REQUEST: '结算申请',
    SETTLEMENT_TRANSFER: '结算转账',
    TAKEOVER: '接管',
  } as Record<string, string>)[value] ?? value;
}
