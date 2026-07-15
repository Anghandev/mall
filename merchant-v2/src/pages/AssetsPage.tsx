import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CircleDollarSign,
  Coins,
  ExternalLink,
  Gift,
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
  MerchantFinanceProjection,
  RewardSubtype,
  SettlementBalance,
  SettlementListProjection,
} from '@abu24k/core-artifacts';
import { rewardSubtypes } from '@abu24k/core-artifacts';
import { CoreApiError } from '../core-api';
import { readableError, useCoreRuntime } from '../core-runtime';
import { EmptyState, LoadingRows, Metric, PageHeader } from '../components/ui';

type LoadState<T> =
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string };

type CommandState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string };

const payableStates = ['LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED'] as const;
const bnmPointStates = ['LOCKED', 'AVAILABLE'] as const;
const positiveAtomicPattern = /^[1-9][0-9]*$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;

export function AssetsPage() {
  const { api, session, signSettlementTypedData } = useCoreRuntime();
  const [settlementsState, setSettlementsState] = useState<LoadState<SettlementListProjection>>({ phase: 'idle' });
  const [financeState, setFinanceState] = useState<LoadState<MerchantFinanceProjection>>({ phase: 'idle' });
  const [settlementAmount, setSettlementAmount] = useState('');
  const [settlementCommand, setSettlementCommand] = useState<CommandState>({ phase: 'idle' });
  const [depositPolicyVersion, setDepositPolicyVersion] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [depositTransactionHash, setDepositTransactionHash] = useState('');
  const [depositCommand, setDepositCommand] = useState<CommandState>({ phase: 'idle' });
  const settlementKey = useRef<string | undefined>(undefined);
  const depositKey = useRef<string | undefined>(undefined);
  const sessionTokenRef = useRef(session?.token);
  sessionTokenRef.current = session?.token;

  const loadData = useCallback(async (quiet = false) => {
    if (!session) {
      setSettlementsState({ phase: 'idle' });
      setFinanceState({ phase: 'idle' });
      return;
    }
    if (!quiet) {
      setSettlementsState({ phase: 'loading' });
      setFinanceState({ phase: 'loading' });
    }
    const token = session.token;
    const [settlementsResult, financeResult] = await Promise.allSettled([
      api.listSettlements(token),
      api.getMerchantFinance(token),
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
  }, [api, session]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const settlements = settlementsState.phase === 'ready' ? settlementsState.value : undefined;
  const finance = financeState.phase === 'ready' ? financeState.value : undefined;
  const merchantBalances = settlements?.balances.filter((balance) => (
    balance.asset === 'USDT' && balance.purpose === 'MERCHANT_RECEIVABLE'
  )) ?? [];
  const nplBalances = settlements?.balances.filter((balance) => (
    balance.asset === 'NPL' && balance.purpose === 'REWARD_LIABILITY'
  )) ?? [];
  const bnmPoints = settlements?.points ?? [];
  const disputedMerchantBalances = merchantBalances.filter((balance) => balance.state === 'DISPUTED');
  const financeAllowsSettlement = finance?.merchant.status === 'APPROVED'
    && finance.merchant.guarantee_status === 'READY';
  const hasAvailableMerchantBalance = merchantBalances.some((balance) => balance.state === 'AVAILABLE');
  const settlementValid = positiveAtomicPattern.test(settlementAmount);
  const settlementSubmitting = settlementCommand.phase === 'submitting';
  const canRequestSettlement = Boolean(
    session
    && settlements
    && financeAllowsSettlement
    && hasAvailableMerchantBalance
    && settlementValid
    && !settlementSubmitting,
  );
  const depositValid = positiveAtomicPattern.test(depositPolicyVersion)
    && positiveAtomicPattern.test(depositAmount)
    && bytes32Pattern.test(depositTransactionHash);
  const depositSubmitting = depositCommand.phase === 'submitting';
  const canSubmitDeposit = Boolean(session && finance && depositValid && !depositSubmitting);
  const operationsSafe = finance?.guarantee?.backing_safe_address
    ?? finance?.guaranteeDeposits[0]?.operations_safe_address;

  function resetSettlementAttempt() {
    settlementKey.current = undefined;
    setSettlementCommand({ phase: 'idle' });
  }

  function resetDepositAttempt() {
    depositKey.current = undefined;
    setDepositCommand({ phase: 'idle' });
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
        amount: settlementAmount,
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
      setSettlementCommand({ phase: 'success', message: `结算请求已进入 ${request.state}：${request.request_id}` });
      void loadData(true);
    } catch (error) {
      setSettlementCommand({ phase: 'error', message: readableError(error) });
    }
  }

  async function submitDeposit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !canSubmitDeposit) return;
    const idempotencyKey = depositKey.current ?? createIdempotencyKey('guarantee-deposit');
    depositKey.current = idempotencyKey;
    setDepositCommand({ phase: 'submitting' });
    try {
      const result = await api.submitGuaranteeDeposit({
        policyVersion: depositPolicyVersion,
        expectedAmountUsdt: depositAmount,
        transactionHash: depositTransactionHash,
        idempotencyKey,
      }, session.token);
      if (finance && result.merchantId !== finance.merchant.merchant_id) {
        throw new CoreApiError('InvalidResponse', '保证金提交返回了其他商家。');
      }
      depositKey.current = undefined;
      setDepositPolicyVersion('');
      setDepositAmount('');
      setDepositTransactionHash('');
      setDepositCommand({
        phase: 'success',
        message: `保证金证据已受理：${result.depositId}（${result.state} / ${result.confirmations} 确认）`,
      });
      void loadData(true);
    } catch (error) {
      setDepositCommand({ phase: 'error', message: readableError(error) });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <button className="button quiet" disabled={!session} onClick={() => void loadData()} type="button">
            <RefreshCw aria-hidden="true" size={16} /> 刷新 Core 证据
          </button>
        )}
        description="USDT 商家货款、NPL 奖励与 BNM 积分分轨展示；结算签名不广播交易，最终性来自 Core 与 Safe 证据。"
        eyebrow="05 / 财务与收益"
        title="资产清算中心"
      />

      {finance ? <FinanceRestriction finance={finance} /> : null}

      <section aria-labelledby="proceeds-title">
        <div className="section-label">
          <div><CircleDollarSign aria-hidden="true" size={18} /><h2 id="proceeds-title">USDT 商家货款</h2></div>
          <span>MERCHANT_RECEIVABLE / Core 原子单位</span>
        </div>
        <div className="metric-grid finance-intro-grid">
          <Metric hint="权威时区和自然日聚合尚未发布" label="今日销售货款" />
          <article className="metric finance-identity">
            <p>结算钱包</p>
            <strong>{finance ? finance.merchant.settlement_wallet : '--'}</strong>
            <span>{finance ? `${finance.merchant.merchant_id} / ${finance.merchant.status}` : '商家财务投影不可用'}</span>
          </article>
        </div>
        <ProjectionState state={settlementsState}>
          <AssetStateGrid balances={merchantBalances} label="USDT 商家货款" />
          {disputedMerchantBalances.length > 0 ? (
            <div className="inline-warning finance-warning" role="status">
              <AlertTriangle aria-hidden="true" size={17} />
              <span>Disputed 仲裁锁定：{disputedMerchantBalances.map((item) => `${item.amount} ${item.asset}`).join(' / ')}</span>
            </div>
          ) : null}
        </ProjectionState>
      </section>

      <section className="section-block finance-section" aria-labelledby="settlement-request-title">
        <div className="section-heading">
          <div><p className="eyebrow">EIP-712 / Gasless</p><h2 id="settlement-request-title">签名结算申请</h2></div>
          <WalletCards aria-hidden="true" size={19} />
        </div>
        <form className="finance-command-form" onSubmit={(event) => void submitSettlement(event)}>
          <div className="field">
            <label htmlFor="settlement-amount">申请金额（USDT 最小单位）</label>
            <input
              autoComplete="off"
              id="settlement-amount"
              inputMode="numeric"
              onChange={(event) => {
                resetSettlementAttempt();
                setSettlementAmount(event.target.value.trim());
              }}
              pattern="[1-9][0-9]*"
              placeholder="例如 1000000000000000000"
              value={settlementAmount}
            />
            <span className="field-help">可申请来源和精确金额由 Core 校验；钱包仅签名，不承担 Safe Gas。</span>
          </div>
          <button className="button primary" disabled={!canRequestSettlement} type="submit">
            {settlementSubmitting ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <WalletCards aria-hidden="true" size={16} />}
            {settlementSubmitting ? '等待钱包与 Core 确认' : '签名并提交结算申请'}
          </button>
        </form>
        {!financeAllowsSettlement && finance ? (
          <p className="command-block-reason" role="status">当前 {finance.merchant.status} / {finance.merchant.guarantee_status}，Core 禁止新商家结算申请。</p>
        ) : !hasAvailableMerchantBalance && settlements ? (
          <p className="command-block-reason" role="status">Core 未返回 Available 商家货款。</p>
        ) : null}
        <CommandNotice state={settlementCommand} />
      </section>

      <section className="section-block finance-section" aria-labelledby="settlement-history-title">
        <div className="section-heading">
          <div><p className="eyebrow">Safe settlement</p><h2 id="settlement-history-title">结算申请与 Safe 批次</h2></div>
          <Landmark aria-hidden="true" size={19} />
        </div>
        <ProjectionState state={settlementsState}>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">申请时间</th><th scope="col">轨道 / 资产</th><th scope="col">精确金额</th><th scope="col">状态</th><th scope="col">Safe 批次 ID</th><th scope="col">最终 Safe TxHash</th></tr></thead>
              <tbody>
                {settlements?.requests.length ? settlements.requests.map((request) => (
                  <tr key={request.request_id}>
                    <td><time dateTime={request.requested_at}>{request.requested_at}</time></td>
                    <td><strong>{request.rail}</strong><small>{request.asset}</small></td>
                    <td className="mono-value">{request.amount}</td>
                    <td><StatusText state={request.state} /></td>
                    <td className="mono-value">{request.batch_id ?? '--'}</td>
                    <td>{request.final_safe_tx_hash ? <ExplorerHash hash={request.final_safe_tx_hash} /> : '--'}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={6}><EmptyState description="Core 尚未返回该钱包的结算申请。" title="暂无结算记录" /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </ProjectionState>
      </section>

      <section className="section-block finance-section" aria-labelledby="guarantee-title">
        <div className="section-heading">
          <div><p className="eyebrow">Operations Safe</p><h2 id="guarantee-title">商家保证金与链上最终性</h2></div>
          <ShieldCheck aria-hidden="true" size={19} />
        </div>
        <ProjectionState state={financeState}>
          <dl className="finance-summary">
            <div><dt>保证金状态</dt><dd>{finance?.merchant.guarantee_status ?? '--'}</dd></div>
            <div><dt>当前余额</dt><dd>{finance?.guarantee?.balance_usdt ?? '--'} <small>USDT atomic</small></dd></div>
            <div><dt>最低要求</dt><dd>{finance?.guarantee?.minimum_usdt ?? '--'} <small>USDT atomic</small></dd></div>
            <div><dt>Operations Safe</dt><dd className="mono-value">{operationsSafe ?? '--'}</dd></div>
          </dl>
          <form className="finance-command-form guarantee-form" onSubmit={(event) => void submitDeposit(event)}>
            <div className="field">
              <label htmlFor="deposit-policy-version">Policy version</label>
              <input id="deposit-policy-version" inputMode="numeric" onChange={(event) => {
                resetDepositAttempt();
                setDepositPolicyVersion(event.target.value.trim());
              }} pattern="[1-9][0-9]*" value={depositPolicyVersion} />
            </div>
            <div className="field">
              <label htmlFor="deposit-amount">预期金额（USDT 最小单位）</label>
              <input id="deposit-amount" inputMode="numeric" onChange={(event) => {
                resetDepositAttempt();
                setDepositAmount(event.target.value.trim());
              }} pattern="[1-9][0-9]*" value={depositAmount} />
            </div>
            <div className="field transaction-field">
              <label htmlFor="deposit-transaction-hash">BSC Transfer TxHash</label>
              <input id="deposit-transaction-hash" onChange={(event) => {
                resetDepositAttempt();
                setDepositTransactionHash(event.target.value.trim());
              }} pattern="0x[0-9a-fA-F]{64}" value={depositTransactionHash} />
            </div>
            <button className="button primary" disabled={!canSubmitDeposit} type="submit">
              {depositSubmitting ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <ShieldCheck aria-hidden="true" size={16} />}
              {depositSubmitting ? '正在验证链上证据' : '提交保证金交易证据'}
            </button>
          </form>
          <CommandNotice state={depositCommand} />
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">提交时间</th><th scope="col">金额 / 政策</th><th scope="col">状态</th><th scope="col">确认</th><th scope="col">链上交易</th><th scope="col">最终证据</th></tr></thead>
              <tbody>
                {finance?.guaranteeDeposits.length ? finance.guaranteeDeposits.map((deposit) => (
                  <tr key={deposit.deposit_id}>
                    <td><time dateTime={deposit.created_at}>{deposit.created_at}</time></td>
                    <td><strong>{deposit.expected_amount_usdt}</strong><small>policy {deposit.policy_version}</small></td>
                    <td><StatusText state={deposit.state} /></td>
                    <td>{deposit.confirmations} / 15</td>
                    <td><ExplorerHash hash={deposit.transaction_hash} /></td>
                    <td className="mono-value">{deposit.transfer_evidence_hash ?? '--'}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={6}><EmptyState description="Core 尚未返回保证金提交记录。" title="暂无保证金记录" /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </ProjectionState>
      </section>

      <section className="section-block finance-section" aria-labelledby="takeover-title">
        <div className="section-heading">
          <div><p className="eyebrow">Takeover liability</p><h2 id="takeover-title">接管、商家债务与未来货款</h2></div>
          <AlertTriangle aria-hidden="true" size={19} />
        </div>
        <ProjectionState state={financeState}>
          <dl className="finance-summary debt-summary">
            <div><dt>累计债务</dt><dd>{finance?.debt?.incurred_usdt ?? '--'}</dd></div>
            <div><dt>已追偿</dt><dd>{finance?.debt?.recovered_usdt ?? '--'}</dd></div>
            <div><dt>未偿债务</dt><dd>{finance?.debt?.outstanding_usdt ?? '--'}</dd></div>
            <div><dt>最新证据</dt><dd className="mono-value">{finance?.debt?.latest_evidence_hash ?? '--'}</dd></div>
          </dl>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">案例 / 订单</th><th scope="col">状态</th><th scope="col">需求金额</th><th scope="col">保证金</th><th scope="col">冻结应收</th><th scope="col">未来货款</th><th scope="col">平台垫付 / 债务</th></tr></thead>
              <tbody>
                {finance?.takeovers.length ? finance.takeovers.map((takeover) => (
                  <tr key={takeover.case_id}>
                    <td><strong>{takeover.case_id}</strong><small className="mono-value">{takeover.order_id}</small></td>
                    <td><StatusText state={takeover.state} /></td>
                    <td>{takeover.required_usdt ?? '--'}</td>
                    <td>{takeover.guarantee_used_usdt ?? '--'}</td>
                    <td>{takeover.merchant_available_used_usdt ?? '--'}</td>
                    <td>{takeover.future_proceeds_used_usdt ?? '--'}</td>
                    <td>{takeover.platform_advance_usdt ?? '--'} / {takeover.merchant_debt_usdt ?? '--'}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={7}><EmptyState description="Core 尚未返回接管与债务案例。" title="暂无接管债务" /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </ProjectionState>
      </section>

      <div className="reward-grid">
        <section className="section-block reward-section" aria-labelledby="seckill-reward-title">
          <div className="section-heading"><div><p className="eyebrow">USDT</p><h2 id="seckill-reward-title">秒杀收益明细</h2></div><Gift aria-hidden="true" size={19} /></div>
          <EmptyState blocked description="最终场次结算与收益比例仍为 DecisionBlocked。" title="收益投影不可用" />
        </section>
        <section className="section-block reward-section" aria-labelledby="npl-title">
          <div className="section-heading"><div><p className="eyebrow">NPL / Reward Safe</p><h2 id="npl-title">NPL 收益子类</h2></div><Coins aria-hidden="true" size={19} /></div>
          <ProjectionState state={settlementsState} compact>
            <RewardSubtypeGrid balances={nplBalances} />
          </ProjectionState>
        </section>
        <section className="section-block reward-section" aria-labelledby="bnm-title">
          <div className="section-heading"><div><p className="eyebrow">BNM / Backend points</p><h2 id="bnm-title">BNM 积分总额</h2></div><LockKeyhole aria-hidden="true" size={19} /></div>
          <ProjectionState state={settlementsState} compact>
            <BnmPointsGrid points={bnmPoints} />
          </ProjectionState>
        </section>
      </div>
    </div>
  );
}

function RewardSubtypeGrid({ balances }: { balances: readonly SettlementBalance[] }) {
  const unclassified = balances.some((balance) => balance.rewardSubtype === null);
  return (
    <>
      {unclassified ? (
        <div className="inline-warning finance-warning" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>Core 返回了未分类的 NPL 奖励余额，已失败关闭该行展示。</span>
        </div>
      ) : null}
      <div aria-label="NPL 奖励收益子类" className="reward-subtype-grid">
        {rewardSubtypes.map((subtype) => {
          const rows = balances.filter((balance) => balance.rewardSubtype === subtype);
          return (
            <article key={subtype}>
              <header><h3>{rewardSubtypeLabel(subtype)}</h3><span>{subtype}</span></header>
              {rows.length ? rows.map((row) => (
                <div className="reward-subtype-balance" key={`${subtype}:${row.state}`}>
                  <span><StatusText state={row.state} /></span>
                  <strong>{row.amount}</strong>
                  <small>NPL atomic</small>
                </div>
              )) : <p>Core 未返回余额</p>}
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
      <div aria-label="BNM Locked/Available 聚合" className="bnm-points-grid">
        {bnmPointStates.map((state) => {
          const rows = points.filter((pointsBalance) => pointsBalance.state === state);
          return (
            <article key={state}>
              <h3>{state === 'LOCKED' ? 'Locked 锁定总额' : 'Available 可用总额'}</h3>
              {rows.length ? rows.map((row) => (
                <div className="state-balance" key={`${row.purpose}:${row.state}`}>
                  <strong>{row.amount}</strong>
                  <span>BNM points</span>
                  <small>{row.purpose}</small>
                </div>
              )) : <p>Core 未返回总额</p>}
            </article>
          );
        })}
      </div>
      <p className="bnm-transfer-boundary"><LockKeyhole aria-hidden="true" size={15} />BNM 是不可转移的后台积分，本页不提供结算、Safe 转账或链上 Claim 操作。</p>
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
  if (state.phase === 'error') return <EmptyState blocked description={state.message} title="Core 投影加载失败" />;
  if (state.phase === 'idle') return <EmptyState blocked description="需要已验证的商家会话。" title="商家会话不可用" />;
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
                <strong>{row.amount}</strong>
                <span>{row.asset} atomic</span>
                <small>{row.purpose}</small>
              </div>
            )) : <p>Core 未返回余额</p>}
          </article>
        );
      })}
    </div>
  );
}

function FinanceRestriction({ finance }: { finance: MerchantFinanceProjection }) {
  const ready = finance.merchant.status === 'APPROVED' && finance.merchant.guarantee_status === 'READY';
  if (ready) {
    return (
      <div className="system-notice ready" role="status">
        <ShieldCheck aria-hidden="true" size={18} />
        <div><strong>商家财务资格正常</strong><span>APPROVED / READY，结算仍由 Core 按可用来源逐笔校验。</span></div>
      </div>
    );
  }
  return (
    <div className="lock-notice" role="alert">
      <AlertTriangle aria-hidden="true" size={18} />
      <div>
        <strong>商家财务操作受限</strong>
        <p>{finance.merchant.status} / {finance.merchant.guarantee_status}：新商品、新订单与新结算申请必须失败关闭；履约、接管、对账和最终性同步保持可用。</p>
      </div>
    </div>
  );
}

function CommandNotice({ state }: { state: CommandState }) {
  if (state.phase === 'idle' || state.phase === 'submitting') return null;
  return <p className={`command-notice ${state.phase}`} role={state.phase === 'error' ? 'alert' : 'status'}>{state.message}</p>;
}

function StatusText({ state }: { state: string }) {
  return <span className={`status-text status-${state.toLowerCase()}`}>{state}</span>;
}

function ExplorerHash({ hash }: { hash: string }) {
  return (
    <a className="explorer-hash mono-value" href={`https://bscscan.com/tx/${hash}`} rel="noreferrer" target="_blank">
      {hash}<ExternalLink aria-hidden="true" size={14} />
    </a>
  );
}

function stateLabel(state: BalanceState) {
  const labels: Record<(typeof payableStates)[number], string> = {
    LOCKED: 'Locked 锁定中',
    AVAILABLE: 'Available 可申请',
    REQUESTED: 'Requested 已申请',
    BATCHED: 'Batched 已组批',
    SETTLED: 'Settled 已结算',
  };
  return state in labels ? labels[state as keyof typeof labels] : state;
}

function createIdempotencyKey(kind: string) {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `merchant-${kind}-${random}`;
}
