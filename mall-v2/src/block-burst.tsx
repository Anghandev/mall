import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Trophy,
  WalletCards,
} from "lucide-react";
import { useLocation } from "react-router-dom";

import { DisabledAction, ScreenHeader, StatusNotice } from "./components";

const BLOCK_BURST_ROUTE = "/block-blast";
const DEFAULT_CHAIN_ID = 56;
const DEFAULT_NPL_TOKEN = "0x4e8277ab31e4956b2cd48449793a57656dfc03d2";
const NPL_DECIMALS = 18;
const NPL_BASE = 10n ** BigInt(NPL_DECIMALS);
const TRILLION = 1_000_000_000_000n;
const INITIAL_TARGET_NPL = 100_000_000_000_000n;
const INITIAL_TARGET_RAW = INITIAL_TARGET_NPL * NPL_BASE;
const RELEASE_DAYS = 100;
const PRODUCTION_RELEASE_DURATION_SECONDS = RELEASE_DAYS * 24 * 60 * 60;
const TX_RECEIPT_ATTEMPTS = 60;
const TX_RECEIPT_INTERVAL_MS = 2_000;
const BLOCK_BURST_REFRESH_MS = 15_000;
const PHASES = Array.from({ length: 10 }, (_, index) => {
  const phase = index + 1;
  const target = 100n * 2n ** BigInt(index);
  return { phase, target, reward: target / 10n };
});

const blockBurstAbiFragments = [
  "function getPoolState() view returns (tuple(address token,address owner,uint256 currentPhase,uint256 maxPhases,uint256 initialTarget,uint256 currentTarget,uint256 rewardBps,uint256 releaseDuration,uint256 accRewardPerShare,uint256 totalActivePrincipal,uint256 totalDeposited,uint256 reservedRewards,uint256 unallocatedNpl,bool pausedDeposit,bool pausedExplode,bool pausedClaimPrincipal,bool pausedClaimReward))",
  "function getNextExplosionState() view returns (tuple(uint256 phase,uint256 target,uint256 reward,uint256 activePrincipal,uint256 unallocatedNpl,bool principalReady,bool rewardReady,bool canExplode))",
  "function getUserState(address user) view returns (tuple(address wallet,uint256 activePrincipal,uint256 rewardCredit,uint256 rewardDebt,uint256 pendingReward,uint256 positionCount))",
  "function getUserPositions(address user) view returns (tuple(uint256 id,uint256 amount,uint256 claimedPrincipal,uint256 activePrincipal,uint256 depositedAt,uint256 joinedPhase,bool closed,uint256 claimablePrincipal)[])",
  "function deposit(uint256 amount) returns (uint256 positionId,uint256 received)",
  "function claimPrincipal(uint256[] positionIds) returns (uint256 amount)",
  "function claimReward() returns (uint256 amount)",
  "function explode() returns (uint256 phase,uint256 reward)",
] as const;

const erc20AbiFragments = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
] as const;

let blockBurstInterfacePromise: Promise<import("ethers").Interface> | null =
  null;
let erc20InterfacePromise: Promise<import("ethers").Interface> | null = null;

type BlockBurstConfig = Readonly<{
  chainId: number;
  nplToken: string;
  proxy: string | null;
  rpcUrl: string | null;
  writesEnabled: boolean;
  errors: readonly string[];
}>;

type PoolState = Readonly<{
  token: string;
  owner: string;
  currentPhase: number;
  maxPhases: number;
  initialTarget: bigint;
  currentTarget: bigint;
  rewardBps: number;
  releaseDuration: number;
  totalActivePrincipal: bigint;
  totalDeposited: bigint;
  reservedRewards: bigint;
  unallocatedNpl: bigint;
  pausedDeposit: boolean;
  pausedExplode: boolean;
  pausedClaimPrincipal: boolean;
  pausedClaimReward: boolean;
}>;

type NextExplosionState = Readonly<{
  phase: number;
  target: bigint;
  reward: bigint;
  activePrincipal: bigint;
  unallocatedNpl: bigint;
  principalReady: boolean;
  rewardReady: boolean;
  canExplode: boolean;
}>;

type UserState = Readonly<{
  wallet: string;
  activePrincipal: bigint;
  pendingReward: bigint;
  positionCount: number;
}>;

type UserPosition = Readonly<{
  id: number;
  amount: bigint;
  claimedPrincipal: bigint;
  activePrincipal: bigint;
  depositedAt: number;
  joinedPhase: number;
  closed: boolean;
  claimablePrincipal: bigint;
}>;

type ChainReadState =
  | Readonly<{ kind: "idle" | "not-configured" | "loading" }>
  | Readonly<{
      kind: "ready";
      pool: PoolState;
      next: NextExplosionState;
      user: UserState | null;
      positions: readonly UserPosition[];
    }>
  | Readonly<{ kind: "error"; message: string }>;

type WalletSnapshotState =
  | Readonly<{ kind: "idle" | "loading" }>
  | Readonly<{ kind: "ready"; allowance: bigint; balance: bigint }>
  | Readonly<{ kind: "error"; message: string }>;

type WriteAction = "deposit" | "claimPrincipal" | "claimReward" | "explode";

type WriteState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "pending"; action: WriteAction; message: string }>
  | Readonly<{
      kind: "success";
      action: WriteAction;
      message: string;
      txHashes: readonly string[];
    }>
  | Readonly<{ kind: "error"; message: string }>;

type WriteResult = Readonly<{ message: string; txHashes: readonly string[] }>;

type Eip1193ProviderLike = Readonly<{
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
}>;

type JsonRpcResponse<T> = Readonly<{
  result?: T;
  error?: { message?: string; code?: number };
}>;

type TransactionReceiptRpc = Readonly<{
  transactionHash?: string;
  from?: string;
  to?: string;
  status?: string;
  blockNumber?: string;
  blockHash?: string;
}>;

type TransactionRpc = Readonly<{
  hash?: string;
  from?: string;
  to?: string;
  input?: string;
}>;

type PendingWriteStep = "approve" | "action";

type PendingWrite = Readonly<{
  version: 1;
  action: WriteAction;
  step: PendingWriteStep;
  wallet: string;
  chainId: number;
  target: string;
  txHash: string;
  selector: string;
  amount?: string;
  createdAt: number;
}>;

export function BlockBurstScreen() {
  const location = useLocation();
  const [blockBurstWallet, setBlockBurstWallet] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const walletAddress = blockBurstWallet;
  const config = useMemo(readBlockBurstConfig, []);
  const configReady = isReadConfigured(config);
  const configError = config.errors[0] ?? null;
  const [readState, setReadState] = useState<ChainReadState>({
    kind: configReady ? "idle" : "not-configured",
  });
  const [walletSnapshot, setWalletSnapshot] = useState<WalletSnapshotState>({
    kind: "idle",
  });
  const [writeState, setWriteState] = useState<WriteState>({ kind: "idle" });
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);
  const [depositAmount, setDepositAmount] = useState("");
  const isActiveRoute = location.pathname === BLOCK_BURST_ROUTE;

  const refresh = useCallback(
    async (
      signal?: AbortSignal,
      options: { silent?: boolean } = {},
    ) => {
      if (!configReady) {
        setReadState({ kind: "not-configured" });
        return;
      }
      if (!options.silent) setReadState({ kind: "loading" });
      try {
        const snapshot = await readBlockBurstSnapshot(
          config,
          walletAddress,
          signal,
        );
        if (!signal?.aborted) setReadState({ kind: "ready", ...snapshot });
      } catch (error) {
        if (!signal?.aborted) {
          setReadState({
            kind: "error",
            message:
              error instanceof Error ? error.message : "爆区块链上读取失败",
          });
        }
      }
    },
    [config, configReady, walletAddress],
  );

  const refreshWalletSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      if (
        !configReady ||
        !config.writesEnabled ||
        !walletAddress ||
        !isEvmAddress(walletAddress)
      ) {
        setWalletSnapshot({ kind: "idle" });
        return;
      }
      setWalletSnapshot({ kind: "loading" });
      try {
        const [allowance, balance] = await Promise.all([
          callNplAllowance(config, walletAddress, signal),
          callNplBalance(config, walletAddress, signal),
        ]);
        if (!signal?.aborted)
          setWalletSnapshot({ kind: "ready", allowance, balance });
      } catch (error) {
        if (!signal?.aborted) {
          setWalletSnapshot({
            kind: "error",
            message:
              error instanceof Error ? error.message : "NPL 授权或余额读取失败",
          });
        }
      }
    },
    [config, configReady, walletAddress],
  );

  useEffect(() => {
    if (!isActiveRoute) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => {
      void refresh(controller.signal, { silent: true });
    }, BLOCK_BURST_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [isActiveRoute, refresh]);

  useEffect(() => {
    if (!isActiveRoute || readState.kind !== "ready") {
      setWalletSnapshot({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    void refreshWalletSnapshot(controller.signal);
    return () => controller.abort();
  }, [isActiveRoute, readState.kind, refreshWalletSnapshot]);

  useEffect(() => {
    if (!isActiveRoute || !config.proxy || !walletAddress) {
      setPendingWrite(null);
      return;
    }
    setPendingWrite(readPendingWrite(config, walletAddress));
  }, [config, isActiveRoute, walletAddress]);

  const pauseCopy =
    readState.kind === "ready" ? pauseStateCopy(readState.pool) : "未读取";
  const baseWriteReason = blockBurstWriteReason(
    config,
    readState,
    walletAddress,
    pendingWrite,
  );
  const depositAmountResult = parseNplAmountInput(depositAmount);
  const claimablePositionIds =
    readState.kind === "ready"
      ? readState.positions
          .filter((position) => position.claimablePrincipal > 0n)
          .map((position) => position.id)
      : [];
  const claimablePrincipal =
    readState.kind === "ready"
      ? readState.positions.reduce(
          (total, position) => total + position.claimablePrincipal,
          0n,
        )
      : 0n;
  const pendingReward =
    readState.kind === "ready" && readState.user
      ? readState.user.pendingReward
      : 0n;
  const writeBusy = writeState.kind === "pending";
  const nextProgressBps =
    readState.kind === "ready"
      ? progressBps(readState.next.activePrincipal, readState.next.target)
      : 0n;
  const tankTone =
    readState.kind === "ready"
      ? tankToneFor(nextProgressBps)
      : "red";
  const tankLevel = `${Number(nextProgressBps) / 100}%`;
  const tankStyle = { "--tank-level": tankLevel } as CSSProperties;
  const nextDeficit =
    readState.kind === "ready" &&
    readState.next.target > readState.next.activePrincipal
      ? readState.next.target - readState.next.activePrincipal
      : 0n;

  const depositReason = depositActionReason(
    baseWriteReason,
    readState,
    depositAmountResult,
    walletSnapshot,
  );
  const claimPrincipalReason = claimPrincipalActionReason(
    baseWriteReason,
    readState,
    claimablePositionIds.length,
  );
  const claimRewardReason = claimRewardActionReason(
    baseWriteReason,
    readState,
    pendingReward,
  );
  const explodeReason = explodeActionReason(baseWriteReason, readState);

  const runWrite = useCallback(
    async (
      action: WriteAction,
      initialMessage: string,
      job: (setPending: (message: string) => void) => Promise<WriteResult>,
    ) => {
      setWriteState({ kind: "pending", action, message: initialMessage });
      try {
        const result = await job((message) =>
          setWriteState({ kind: "pending", action, message }),
        );
        setWriteState({ kind: "success", action, ...result });
        await refresh();
        await refreshWalletSnapshot();
      } catch (error) {
        setWriteState({
          kind: "error",
          message: error instanceof Error ? error.message : "爆区块交易失败",
        });
      }
    },
    [refresh, refreshWalletSnapshot],
  );

  const handleConnectBlockBurstWallet = useCallback(async () => {
    setWalletConnecting(true);
    try {
      const wallet = await connectBlockBurstWallet(config);
      setBlockBurstWallet(wallet.address);
      setPendingWrite(config.proxy ? readPendingWrite(config, wallet.address) : null);
      setWriteState({ kind: "idle" });
    } catch (error) {
      setWriteState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "爆区块钱包连接失败",
      });
    } finally {
      setWalletConnecting(false);
    }
  }, [config]);

  const handleRecoverPendingWrite = useCallback(async () => {
    if (!pendingWrite) return;
    setWriteState({
      kind: "pending",
      action: pendingWrite.action,
      message: "正在核对上一次未确认交易…",
    });
    try {
      await waitForTransactionReceipt(config, pendingWrite.txHash, pendingWrite);
      clearPendingWrite(config, pendingWrite.wallet);
      setPendingWrite(null);
      setWriteState({
        kind: "success",
        action: pendingWrite.action,
        message: "上一次交易已确认，页面已恢复可操作。",
        txHashes: [pendingWrite.txHash],
      });
      await refresh();
      await refreshWalletSnapshot();
    } catch (error) {
      setWriteState({
        kind: "error",
        message:
          error instanceof Error
            ? `${error.message}。为避免重复打入，本地仍保留该未确认记录。`
            : "未确认交易核对失败。",
      });
    }
  }, [config, pendingWrite, refresh, refreshWalletSnapshot]);

  const handleDeposit = useCallback(async () => {
    if (depositReason) {
      setWriteState({ kind: "error", message: depositReason });
      return;
    }
    if (depositAmountResult.kind !== "ok") return;
    const amount = depositAmountResult.amount;
    await runWrite(
      "deposit",
      "正在校验 NPL 余额和授权…",
      async (setPending) => {
        const wallet = await requireBlockBurstWallet(config, walletAddress);
        const [balance, allowance] = await Promise.all([
          callNplBalance(config, wallet.address),
          callNplAllowance(config, wallet.address),
        ]);
        if (balance < amount)
          throw new Error(
            `NPL 余额不足：当前 ${formatNpl(balance)}，本次需要 ${formatNpl(amount)}。`,
          );

        const txHashes: string[] = [];
        if (allowance < amount) {
          setPending("正在发送 NPL 授权交易…");
          const approveData = await encodeErc20Function("approve", [
            config.proxy,
            amount,
          ]);
          const approveHash = await sendWalletTransaction(
            config,
            wallet.address,
            config.nplToken,
            approveData,
          );
          const approvePending = buildPendingWrite(
            config,
            wallet.address,
            "deposit",
            "approve",
            config.nplToken,
            approveHash,
            approveData,
            amount,
          );
          savePendingWrite(config, wallet.address, approvePending);
          setPendingWrite(approvePending);
          txHashes.push(approveHash);
          setPending("NPL 授权已提交，等待链上确认…");
          await waitForTransactionReceipt(config, approveHash, approvePending);
          clearPendingWrite(config, wallet.address);
          setPendingWrite(null);
          const updatedAllowance = await callNplAllowance(
            config,
            wallet.address,
          );
          if (updatedAllowance < amount)
            throw new Error(
              "NPL 授权交易已确认，但授权额度未生效，请刷新后重试。",
            );
        }

        setPending("正在发送打入区块池交易…");
        const depositData = await encodeBlockBurstFunction("deposit", [amount]);
        const depositHash = await sendWalletTransaction(
          config,
          wallet.address,
          config.proxy,
          depositData,
        );
        const depositPending = buildPendingWrite(
          config,
          wallet.address,
          "deposit",
          "action",
          config.proxy,
          depositHash,
          depositData,
          amount,
        );
        savePendingWrite(config, wallet.address, depositPending);
        setPendingWrite(depositPending);
        txHashes.push(depositHash);
        setPending("打入交易已提交，等待链上确认…");
        await waitForTransactionReceipt(config, depositHash, depositPending);
        clearPendingWrite(config, wallet.address);
        setPendingWrite(null);
        setDepositAmount("");
        return {
          message: `已打入 ${formatNpl(amount)}，该笔本金从确认时间开始按币本位释放。`,
          txHashes,
        };
      },
    );
  }, [config, depositAmountResult, depositReason, runWrite, walletAddress]);

  const handleClaimPrincipal = useCallback(async () => {
    if (claimPrincipalReason) {
      setWriteState({ kind: "error", message: claimPrincipalReason });
      return;
    }
    await runWrite(
      "claimPrincipal",
      "正在发送领取本金交易…",
      async (setPending) => {
        const wallet = await requireBlockBurstWallet(config, walletAddress);
        const data = await encodeBlockBurstFunction("claimPrincipal", [
          claimablePositionIds,
        ]);
        const txHash = await sendWalletTransaction(
          config,
          wallet.address,
          config.proxy,
          data,
        );
        const pending = buildPendingWrite(
          config,
          wallet.address,
          "claimPrincipal",
          "action",
          config.proxy,
          txHash,
          data,
        );
        savePendingWrite(config, wallet.address, pending);
        setPendingWrite(pending);
        setPending("领取本金交易已提交，等待链上确认…");
        await waitForTransactionReceipt(config, txHash, pending);
        clearPendingWrite(config, wallet.address);
        setPendingWrite(null);
        return {
          message: `已领取可释放本金 ${formatNpl(claimablePrincipal)}。`,
          txHashes: [txHash],
        };
      },
    );
  }, [
    claimPrincipalReason,
    claimablePositionIds,
    claimablePrincipal,
    config,
    runWrite,
    walletAddress,
  ]);

  const handleClaimReward = useCallback(async () => {
    if (claimRewardReason) {
      setWriteState({ kind: "error", message: claimRewardReason });
      return;
    }
    await runWrite(
      "claimReward",
      "正在发送领取奖励交易…",
      async (setPending) => {
        const wallet = await requireBlockBurstWallet(config, walletAddress);
        const data = await encodeBlockBurstFunction("claimReward", []);
        const txHash = await sendWalletTransaction(
          config,
          wallet.address,
          config.proxy,
          data,
        );
        const pending = buildPendingWrite(
          config,
          wallet.address,
          "claimReward",
          "action",
          config.proxy,
          txHash,
          data,
        );
        savePendingWrite(config, wallet.address, pending);
        setPendingWrite(pending);
        setPending("领取奖励交易已提交，等待链上确认…");
        await waitForTransactionReceipt(config, txHash, pending);
        clearPendingWrite(config, wallet.address);
        setPendingWrite(null);
        return {
          message: `已领取待领奖励 ${formatNpl(pendingReward)}。`,
          txHashes: [txHash],
        };
      },
    );
  }, [claimRewardReason, config, pendingReward, runWrite, walletAddress]);

  const handleExplode = useCallback(async () => {
    if (explodeReason) {
      setWriteState({ kind: "error", message: explodeReason });
      return;
    }
    const phase = readState.kind === "ready" ? readState.next.phase : 0;
    const reward = readState.kind === "ready" ? readState.next.reward : 0n;
    await runWrite("explode", "正在发送爆区块交易…", async (setPending) => {
      const wallet = await requireBlockBurstWallet(config, walletAddress);
      const data = await encodeBlockBurstFunction("explode", []);
      const txHash = await sendWalletTransaction(
        config,
        wallet.address,
        config.proxy,
        data,
      );
      const pending = buildPendingWrite(
        config,
        wallet.address,
        "explode",
        "action",
        config.proxy,
        txHash,
        data,
      );
      savePendingWrite(config, wallet.address, pending);
      setPendingWrite(pending);
      setPending("爆区块交易已提交，等待链上确认…");
      await waitForTransactionReceipt(config, txHash, pending);
      clearPendingWrite(config, wallet.address);
      setPendingWrite(null);
      return {
        message: `第 ${phase} 期已爆，奖励 ${formatNpl(reward)} 已进入待领权重分配。`,
        txHashes: [txHash],
      };
    });
  }, [config, explodeReason, readState, runWrite, walletAddress]);

  return (
    <div className="screen screen--block-burst">
      <ScreenHeader
        eyebrow="NPL 爆区块"
        title="爆区块"
        description="爆区块是DEFI共识顶层逻辑，全网引爆区块瓜分奖励，每一次爆块都是财富机遇！"
        trailing={
          <span
            className={
              configReady
                ? "status-pill status-pill--success"
                : "status-pill status-pill--locked"
            }
          >
            {configReady
              ? config.writesEnabled
                ? "生产写链"
                : "生产只读"
              : "生产未配置"}
          </span>
        }
      />

      <section
        className="section-block block-burst-account"
        aria-labelledby="block-burst-account-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">我的权重</p>
            <h2 id="block-burst-account-title">我的本金权重</h2>
          </div>
          <span
            className={
              walletAddress
                ? "block-burst-account-pill block-burst-account-pill--connected"
                : "block-burst-account-pill block-burst-account-pill--warning"
            }
          >
            {walletAddress ? (
              <WalletCards aria-hidden="true" size={14} />
            ) : (
              <AlertTriangle aria-hidden="true" size={14} />
            )}
            {walletAddress ? `已连接 ${shortenAddress(walletAddress)}` : "未连接钱包"}
          </span>
        </div>
        <div className="block-burst-wallet-connect">
          <div>
            <span>爆区块钱包</span>
            <strong>{walletAddress ? shortenAddress(walletAddress) : "未连接"}</strong>
          </div>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void handleConnectBlockBurstWallet()}
            disabled={walletConnecting}
          >
            <WalletCards aria-hidden="true" size={18} />
            {walletConnecting
              ? "连接中…"
              : walletAddress
                ? "切换爆区块钱包"
                : "连接爆区块钱包"}
          </button>
        </div>
        <div className="metric-grid metric-grid--four block-burst-weight-metrics">
          <Metric
            label="未领取本金"
            value={
              readState.kind === "ready" && readState.user
                ? formatNpl(readState.user.activePrincipal)
                : null
            }
          />
          <Metric
            label="待领奖励"
            value={
              readState.kind === "ready" && readState.user
                ? formatNpl(readState.user.pendingReward)
                : null
            }
          />
          <Metric
            label="本金单数"
            value={
              readState.kind === "ready" && readState.user
                ? String(readState.user.positionCount)
                : null
            }
          />
          <Metric
            label="可领本金"
            value={
              readState.kind === "ready" ? formatNpl(claimablePrincipal) : "0 NPL"
            }
          />
        </div>
        {walletSnapshot.kind === "ready" ? (
          <dl
            className="block-burst-config-list block-burst-wallet-list"
            aria-label="NPL 余额和授权"
          >
            <div>
              <dt>钱包余额</dt>
              <dd>{formatNpl(walletSnapshot.balance)}</dd>
            </div>
            <div>
              <dt>已授权额度</dt>
              <dd>{formatNpl(walletSnapshot.allowance)}</dd>
            </div>
          </dl>
        ) : config.writesEnabled && walletAddress ? (
          <p className="field-help">NPL 余额和授权会在写链前重新校验。</p>
        ) : null}
        {readState.kind === "ready" && readState.positions.length > 0 ? (
          <div className="block-burst-positions" aria-label="我的爆区块本金单">
            {readState.positions.slice(0, 4).map((position) => (
              <article key={position.id} className="block-burst-position">
                <div>
                  <strong>本金单 #{position.id}</strong>
                  <span>
                    {position.closed
                      ? "已关闭"
                      : `${String(position.joinedPhase).padStart(2, "0")} 期进入`}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>本金</dt>
                    <dd>{formatNpl(position.amount)}</dd>
                  </div>
                  <div>
                    <dt>可领</dt>
                    <dd>{formatNpl(position.claimablePrincipal)}</dd>
                  </div>
                  <div>
                    <dt>剩余权重</dt>
                    <dd>{formatNpl(position.activePrincipal)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      {configError ? (
        <StatusNotice title="爆区块配置无效" tone="warning">
          {configError}
        </StatusNotice>
      ) : null}
      {!configReady && !configError ? (
        <StatusNotice title="生产合约未配置" tone="warning">
          当前商城只展示规则和独立入口。填入生产合约与只读链上节点 后，页面才读取
          BSC 链上状态；测试入口不作为生产入口。
        </StatusNotice>
      ) : null}
      {readState.kind === "error" ? (
        <StatusNotice title="链上读取失败" tone="warning">
          {readState.message}
        </StatusNotice>
      ) : null}
      {walletSnapshot.kind === "error" ? (
        <StatusNotice title="钱包写链预检失败" tone="warning">
          {walletSnapshot.message}
        </StatusNotice>
      ) : null}
      <BlockBurstWriteStatus state={writeState} />
      {pendingWrite ? (
        <section className="block-burst-pending-card" role="status">
          <AlertTriangle aria-hidden="true" size={19} />
          <div>
            <h2>有未确认交易</h2>
            <p>
              {pendingActionCopy(pendingWrite)}
              已提交但本地还没确认。为避免重复打入或重复操作，请先核对这笔交易。
            </p>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void handleRecoverPendingWrite()}
              disabled={writeState.kind === "pending"}
            >
              <RefreshCw aria-hidden="true" size={17} />
              检查未确认交易
            </button>
          </div>
        </section>
      ) : null}

      <section
        className="section-block block-burst-next"
        aria-labelledby="block-burst-next-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">下一期</p>
            <h2 id="block-burst-next-title">下一次爆区块</h2>
          </div>
          {readState.kind === "ready" && readState.next.canExplode ? (
            <span className="status-pill status-pill--success">
              <CheckCircle2 aria-hidden="true" size={14} />
              可爆
            </span>
          ) : (
            <span className="status-pill status-pill--muted">等待条件</span>
          )}
        </div>

        <div className="block-burst-progress-panel">
          <div
            className={`block-burst-tank block-burst-tank--${tankTone}`}
            style={tankStyle}
            aria-label={`本期进度 ${formatProgressBps(nextProgressBps)}`}
          >
            <div className="block-burst-tank__glass" aria-hidden="true">
              <div className="block-burst-tank__water" />
              <div className="block-burst-tank__shine" />
            </div>
            <div className="block-burst-tank__label">
              <strong>
                {formatProgressBps(nextProgressBps)}
              </strong>
              <span>{tankStatusCopy(readState)}</span>
            </div>
          </div>
          <div className="block-burst-progress-copy">
            <p>
              用户打入的未领取本金就是本期水位。水位满格且奖励池足够时，任何用户都可以点爆区块。
            </p>
            <div className="block-burst-readiness" aria-label="爆区块条件">
              <ReadinessItem
                readyLabel="水位已满"
                waitingLabel="水位未满"
                ariaDescription="大家打入的 NPL 是否已经填满本期目标。"
                ready={
                  readState.kind === "ready"
                    ? readState.next.principalReady
                    : false
                }
              />
              <ReadinessItem
                readyLabel="奖励充足"
                waitingLabel="奖励不足"
                ariaDescription="合约里的奖励 NPL 是否够发本期奖励。"
                ready={
                  readState.kind === "ready"
                    ? readState.next.rewardReady
                    : false
                }
              />
              <ReadinessItem
                readyLabel="可以爆块"
                waitingLabel="暂不能爆"
                ariaDescription="水位满、奖励够且未暂停时，点爆区块才会成功。"
                ready={
                  readState.kind === "ready" ? readState.next.canExplode : false
                }
              />
            </div>
          </div>
        </div>

        <div className="metric-grid metric-grid--three block-burst-next-metrics">
          <Metric
            label="当前期数"
            value={
              readState.kind === "ready"
                ? `${readState.pool.currentPhase} / ${readState.pool.maxPhases}`
                : null
            }
          />
          <Metric
            label="本期目标"
            value={
              readState.kind === "ready"
                ? formatNpl(readState.next.target)
                : null
            }
          />
          <Metric
            label="已入本金"
            value={
              readState.kind === "ready"
                ? formatNpl(readState.next.activePrincipal)
                : null
            }
          />
          <Metric
            label="距离爆区块"
            value={
              readState.kind === "ready"
                ? nextDeficit > 0n
                  ? formatNpl(nextDeficit)
                  : "已达标"
                : null
            }
          />
          <Metric
            label="当期奖励"
            value={
              readState.kind === "ready"
                ? formatNpl(readState.next.reward)
                : null
            }
          />
          <Metric label="暂停状态" value={pauseCopy} />
        </div>

        <div className="block-burst-user-actions" aria-label="用户写链入口">
          <div className="section-heading section-heading--compact">
            <div>
              <p className="eyebrow">我的操作</p>
              <h3>打入与领取</h3>
            </div>
          </div>
          {baseWriteReason ? (
            <div className="block-burst-action-grid">
              <DisabledAction reason={baseWriteReason}>打入 NPL</DisabledAction>
              <DisabledAction reason={baseWriteReason}>领取本金</DisabledAction>
              <DisabledAction reason={baseWriteReason}>领取奖励</DisabledAction>
              <DisabledAction reason={baseWriteReason}>爆区块</DisabledAction>
            </div>
          ) : (
            <div className="block-burst-live-actions">
              <div className="block-burst-deposit-form">
                <label htmlFor="block-burst-deposit-amount">
                  打入 NPL 数量
                </label>
                <div>
                  <input
                    id="block-burst-deposit-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="例如 1000"
                    value={depositAmount}
                    onChange={(event) =>
                      setDepositAmount(event.currentTarget.value)
                    }
                    disabled={writeBusy}
                  />
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={() => void handleDeposit()}
                    disabled={writeBusy || Boolean(depositReason)}
                  >
                    <WalletCards aria-hidden="true" size={18} />{" "}
                    {walletSnapshot.kind === "ready" &&
                    depositAmountResult.kind === "ok" &&
                    walletSnapshot.allowance < depositAmountResult.amount
                      ? "授权并打入 NPL"
                      : "打入 NPL"}
                  </button>
                </div>
                <p className="control-reason">
                  {depositReason ??
                    "授权不足时会先弹出 NPL 授权，再弹出打入区块池交易。"}
                </p>
              </div>
              <div className="block-burst-action-grid">
                <BlockBurstActionButton
                  reason={claimPrincipalReason}
                  busy={writeBusy}
                  onClick={() => void handleClaimPrincipal()}
                >
                  领取本金
                </BlockBurstActionButton>
                <BlockBurstActionButton
                  reason={claimRewardReason}
                  busy={writeBusy}
                  onClick={() => void handleClaimReward()}
                >
                  领取奖励
                </BlockBurstActionButton>
                <BlockBurstActionButton
                  reason={explodeReason}
                  busy={writeBusy}
                  onClick={() => void handleExplode()}
                >
                  爆区块
                </BlockBurstActionButton>
              </div>
            </div>
          )}
        </div>
      </section>


      <section
        className="section-block block-burst-rules"
        aria-labelledby="block-burst-rules-title"
      >
        <details className="block-burst-collapsible">
          <summary>
            <span>
              <span className="eyebrow">FIXED RULES</span>
              <strong id="block-burst-rules-title">玩法规则</strong>
            </span>
            <span className="block-burst-summary-note">
              展开查看 1 至 10 期
            </span>
          </summary>
          <div
            className="block-burst-phase-list"
            aria-label="爆区块期数目标和奖励"
          >
            {PHASES.map((phase) => (
              <div key={phase.phase}>
                <span>{String(phase.phase).padStart(2, "0")} 期</span>
                <strong>{phase.target.toString()} 万亿</strong>
                <small>奖励 {phase.reward.toString()} 万亿</small>
              </div>
            ))}
          </div>
          <ul className="block-burst-rule-list">
            <li>
              <ShieldCheck aria-hidden="true" size={17} />
              奖励按未领取本金权重分配，领取出来的本金不再参与后续奖励。
            </li>
            <li>
              <Clock3 aria-hidden="true" size={17} />
              每笔本金从打入成功时间开始释放，满 24 小时释放 1%，100 天释放完。
            </li>
            <li>
              <LockKeyhole aria-hidden="true" size={17} />
              合约保留 owner、暂停、升级和资金管理权限；商城页面不替代合约治理。
            </li>
          </ul>
        </details>
      </section>

      <details className="block-burst-tech-note">
        <summary>合约信息</summary>
        <dl className="block-burst-config-list">
          <div>
            <dt>NPL</dt>
            <dd>
              <AddressLink address={config.nplToken} />
            </dd>
          </div>
          <div>
            <dt>生产合约</dt>
            <dd>
              {config.proxy ? <AddressLink address={config.proxy} /> : "未配置"}
            </dd>
          </div>
          <div>
            <dt>目标链</dt>
            <dd>主网 <small>BSC {config.chainId}</small></dd>
          </div>
          <div>
            <dt>写链开关</dt>
            <dd>{config.writesEnabled ? "已开启" : "关闭"}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong
        className="metric__value"
        aria-label={value ? `${label}${value}` : `${label}暂不可用`}
      >
        {value ?? "待配置"}
      </strong>
    </div>
  );
}

function ReadinessItem({
  readyLabel,
  waitingLabel,
  ariaDescription,
  ready,
}: {
  readyLabel: string;
  waitingLabel: string;
  ariaDescription: string;
  ready: boolean;
}) {
  const Icon = ready ? CheckCircle2 : Clock3;
  const statusCopy = ready ? readyLabel : waitingLabel;
  return (
    <span
      className={
        ready
          ? "block-burst-readiness__item is-ready"
          : "block-burst-readiness__item"
      }
      aria-label={`${statusCopy}：${ariaDescription}`}
    >
      <Icon aria-hidden="true" size={16} />
      <strong>{statusCopy}</strong>
    </span>
  );
}

function BlockBurstActionButton({
  children,
  reason,
  busy,
  onClick,
}: {
  children: string;
  reason: string | null;
  busy: boolean;
  onClick(): void;
}) {
  return (
    <div className="disabled-action block-burst-enabled-action">
      <button
        className="button button--primary"
        type="button"
        onClick={onClick}
        disabled={busy || Boolean(reason)}
      >
        <WalletCards aria-hidden="true" size={18} />
        {children}
      </button>
      <p className="control-reason">
        {reason ?? "每次写链都会弹出钱包确认，并等待链上回执。"}
      </p>
    </div>
  );
}

function BlockBurstWriteStatus({ state }: { state: WriteState }) {
  if (state.kind === "idle") return null;
  const success = state.kind === "success";
  const pending = state.kind === "pending";
  return (
    <section
      className={
        success
          ? "block-burst-write-status is-success"
          : pending
            ? "block-burst-write-status is-pending"
            : "block-burst-write-status is-error"
      }
      role={state.kind === "error" ? "alert" : "status"}
    >
      {success ? (
        <CheckCircle2 aria-hidden="true" size={20} />
      ) : pending ? (
        <RefreshCw aria-hidden="true" size={20} />
      ) : (
        <AlertTriangle aria-hidden="true" size={20} />
      )}
      <div>
        <h2>{success ? "交易已确认" : pending ? "交易处理中" : "交易未完成"}</h2>
        <p>{state.message}</p>
        {success ? (
          <div className="block-burst-tx-list" aria-label="爆区块交易记录">
            {state.txHashes.map((hash) => (
              <a
                key={hash}
                href={`https://bscscan.com/tx/${hash}`}
                target="_blank"
                rel="noreferrer"
              >
                {shortenHash(hash)}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <a href={`https://bscscan.com/address/${address}`} target="_blank" rel="noreferrer">
      {shortenAddress(address)}
    </a>
  );
}

async function getBlockBurstInterface() {
  blockBurstInterfacePromise ??= import("ethers").then(
    ({ Interface }) => new Interface([...blockBurstAbiFragments]),
  );
  return blockBurstInterfacePromise;
}

async function getErc20Interface() {
  erc20InterfacePromise ??= import("ethers").then(
    ({ Interface }) => new Interface([...erc20AbiFragments]),
  );
  return erc20InterfacePromise;
}

function isEvmAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isTxHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isHash(value: unknown) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function readBlockBurstConfig(): BlockBurstConfig {
  const errors: string[] = [];
  const rawChainId = import.meta.env.VITE_BLOCK_BURST_CHAIN_ID;
  const chainId = parseChainId(rawChainId, errors);
  const nplToken =
    normalizeOptionalAddress(import.meta.env.VITE_BLOCK_BURST_NPL_TOKEN, "NPL Token", errors) ?? DEFAULT_NPL_TOKEN;
  const proxy = normalizeOptionalAddress(import.meta.env.VITE_BLOCK_BURST_PROXY, "生产合约", errors);
  const rpcUrl = normalizeOptionalText(import.meta.env.VITE_BLOCK_BURST_RPC_URL);
  const writesEnabled = String(import.meta.env.VITE_BLOCK_BURST_ENABLE_WRITES ?? "").toLowerCase() === "true";

  if (chainId !== DEFAULT_CHAIN_ID) errors.push("爆区块商城入口仅允许 BSC 主网 56。");
  return { chainId, nplToken, proxy, rpcUrl, writesEnabled, errors };
}

function parseChainId(value: unknown, errors: string[]) {
  if (value === undefined || value === null || value === "") return DEFAULT_CHAIN_ID;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push("VITE_BLOCK_BURST_CHAIN_ID 必须是正整数。");
    return DEFAULT_CHAIN_ID;
  }
  return parsed;
}

function normalizeOptionalText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalAddress(value: unknown, label: string, errors: string[]) {
  const trimmed = normalizeOptionalText(value);
  if (!trimmed) return null;
  if (!isEvmAddress(trimmed)) {
    errors.push(`${label} 不是有效 EVM 地址。`);
    return null;
  }
  return trimmed.toLowerCase();
}

function isReadConfigured(config: BlockBurstConfig) {
  return config.errors.length === 0 && Boolean(config.proxy && config.rpcUrl);
}

async function readBlockBurstSnapshot(config: BlockBurstConfig, walletAddress: string | null, signal?: AbortSignal) {
  if (!config.proxy || !config.rpcUrl) throw new Error("生产合约或只读链上节点未配置。");
  const chainIdHex = await rpc<string>(config.rpcUrl, "eth_chainId", [], signal);
  if (normalizeChainId(chainIdHex) !== config.chainId) throw new Error(`链上节点返回的网络编号为 ${chainIdHex}，不是配置的 BSC ${config.chainId}。`);

  const [pool, next] = await Promise.all([callPoolState(config, signal), callNextExplosion(config, signal)]);
  validateBlockBurstPool(config, pool);

  if (!walletAddress || !isEvmAddress(walletAddress)) return { pool, next, user: null, positions: [] };
  const wallet = walletAddress.toLowerCase();
  const [user, positions] = await Promise.all([callUserState(config, wallet, signal), callUserPositions(config, wallet, signal)]);
  return { pool, next, user, positions };
}

async function callPoolState(config: BlockBurstConfig, signal?: AbortSignal): Promise<PoolState> {
  const abi = await getBlockBurstInterface();
  const value = await ethCall(config, abi, "getPoolState", [], signal);
  const result = abi.decodeFunctionResult("getPoolState", value)[0] as unknown as readonly unknown[];
  return {
    token: String(result[0]),
    owner: String(result[1]),
    currentPhase: Number(result[2]),
    maxPhases: Number(result[3]),
    initialTarget: BigInt(String(result[4])),
    currentTarget: BigInt(String(result[5])),
    rewardBps: Number(result[6]),
    releaseDuration: Number(result[7]),
    totalActivePrincipal: BigInt(String(result[9])),
    totalDeposited: BigInt(String(result[10])),
    reservedRewards: BigInt(String(result[11])),
    unallocatedNpl: BigInt(String(result[12])),
    pausedDeposit: Boolean(result[13]),
    pausedExplode: Boolean(result[14]),
    pausedClaimPrincipal: Boolean(result[15]),
    pausedClaimReward: Boolean(result[16]),
  };
}

async function callNextExplosion(config: BlockBurstConfig, signal?: AbortSignal): Promise<NextExplosionState> {
  const abi = await getBlockBurstInterface();
  const value = await ethCall(config, abi, "getNextExplosionState", [], signal);
  const result = abi.decodeFunctionResult("getNextExplosionState", value)[0] as unknown as readonly unknown[];
  return {
    phase: Number(result[0]),
    target: BigInt(String(result[1])),
    reward: BigInt(String(result[2])),
    activePrincipal: BigInt(String(result[3])),
    unallocatedNpl: BigInt(String(result[4])),
    principalReady: Boolean(result[5]),
    rewardReady: Boolean(result[6]),
    canExplode: Boolean(result[7]),
  };
}

async function callUserState(config: BlockBurstConfig, wallet: string, signal?: AbortSignal): Promise<UserState> {
  const abi = await getBlockBurstInterface();
  const value = await ethCall(config, abi, "getUserState", [wallet], signal);
  const result = abi.decodeFunctionResult("getUserState", value)[0] as unknown as readonly unknown[];
  return {
    wallet: String(result[0]),
    activePrincipal: BigInt(String(result[1])),
    pendingReward: BigInt(String(result[4])),
    positionCount: Number(result[5]),
  };
}

async function callUserPositions(config: BlockBurstConfig, wallet: string, signal?: AbortSignal): Promise<readonly UserPosition[]> {
  const abi = await getBlockBurstInterface();
  const value = await ethCall(config, abi, "getUserPositions", [wallet], signal);
  const result = abi.decodeFunctionResult("getUserPositions", value)[0] as unknown as readonly (readonly unknown[])[];
  return result.map((position) => ({
    id: Number(position[0]),
    amount: BigInt(String(position[1])),
    claimedPrincipal: BigInt(String(position[2])),
    activePrincipal: BigInt(String(position[3])),
    depositedAt: Number(position[4]),
    joinedPhase: Number(position[5]),
    closed: Boolean(position[6]),
    claimablePrincipal: BigInt(String(position[7])),
  }));
}

async function callNplAllowance(config: BlockBurstConfig, owner: string, signal?: AbortSignal) {
  if (!config.proxy) throw new Error("生产合约未配置。");
  const abi = await getErc20Interface();
  const value = await ethCallTo(config, config.nplToken, abi.encodeFunctionData("allowance", [owner, config.proxy]), signal);
  return BigInt(String(abi.decodeFunctionResult("allowance", value)[0]));
}

async function callNplBalance(config: BlockBurstConfig, owner: string, signal?: AbortSignal) {
  const abi = await getErc20Interface();
  const value = await ethCallTo(config, config.nplToken, abi.encodeFunctionData("balanceOf", [owner]), signal);
  return BigInt(String(abi.decodeFunctionResult("balanceOf", value)[0]));
}

async function ethCall(config: BlockBurstConfig, abi: import("ethers").Interface, functionName: string, args: readonly unknown[], signal?: AbortSignal) {
  if (!config.proxy) throw new Error("生产合约未配置。");
  const data = abi.encodeFunctionData(functionName, [...args]);
  return ethCallTo(config, config.proxy, data, signal);
}

async function ethCallTo(config: BlockBurstConfig, to: string, data: string, signal?: AbortSignal) {
  if (!config.rpcUrl) throw new Error("只读链上节点未配置。");
  return rpc<string>(config.rpcUrl, "eth_call", [{ to, data }, "latest"], signal);
}

async function rpc<T>(rpcUrl: string, method: string, params: readonly unknown[], signal?: AbortSignal): Promise<T> {
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
  if (signal) requestInit.signal = signal;
  const response = await fetch(rpcUrl, requestInit);
  if (!response.ok) throw new Error(`链上节点请求失败：HTTP ${response.status}`);
  const payload = (await response.json()) as JsonRpcResponse<T>;
  if (payload.error) throw new Error(payload.error.message ?? `链上节点错误 ${payload.error.code ?? ""}`.trim());
  if (payload.result === undefined) throw new Error("链上节点返回内容不完整。");
  return payload.result;
}

function validateBlockBurstPool(config: BlockBurstConfig, pool: PoolState) {
  if (pool.token.toLowerCase() !== config.nplToken.toLowerCase()) {
    throw new Error("爆区块合约 Token 与商城配置的 NPL 不一致，已停止展示链上状态。");
  }
  if (pool.maxPhases !== 10) throw new Error("爆区块合约最大期数不是 10，已停止展示链上状态。");
  if (pool.initialTarget !== INITIAL_TARGET_RAW) throw new Error("爆区块合约第一期目标不是 100 万亿 NPL，已停止展示链上状态。");
  if (pool.rewardBps !== 1000) throw new Error("爆区块合约奖励比例不是 10%，已停止展示链上状态。");
  if (pool.releaseDuration !== PRODUCTION_RELEASE_DURATION_SECONDS) throw new Error("爆区块合约本金释放周期不是 100 天，已停止展示链上状态。");
}

function blockBurstWriteReason(
  config: BlockBurstConfig,
  readState: ChainReadState,
  walletAddress: string | null,
  pendingWrite: PendingWrite | null,
) {
  if (config.errors.length > 0) return "爆区块配置无效，写链入口关闭。";
  if (!config.proxy || !config.rpcUrl) return "生产合约或只读链上节点未配置，写链入口关闭。";
  if (!config.writesEnabled) return "VITE_BLOCK_BURST_ENABLE_WRITES 未显式开启，商城不发送爆区块交易。";
  if (readState.kind !== "ready") return "链上状态未确认，商城不发送爆区块交易。";
  if (!walletAddress) return "请先连接爆区块钱包后再执行爆区块写链。";
  if (pendingWrite) return "检测到上一次爆区块交易尚未确认，请先点“检查未确认交易”。";
  if (!injectedEthereum()) return "未检测到浏览器钱包，写链入口关闭。";
  return null;
}

function depositActionReason(
  baseWriteReason: string | null,
  readState: ChainReadState,
  amount: ReturnType<typeof parseNplAmountInput>,
  walletSnapshot: WalletSnapshotState,
) {
  if (baseWriteReason) return baseWriteReason;
  if (readState.kind !== "ready") return "链上状态未确认。";
  if (readState.pool.pausedDeposit) return "合约当前暂停打入。";
  if (readState.pool.currentPhase >= readState.pool.maxPhases) return "爆区块已达到最大 10 期，不能继续打入。";
  if (amount.kind === "empty") return "请输入要打入的 NPL 数量。";
  if (amount.kind === "error") return amount.message;
  if (walletSnapshot.kind === "ready" && walletSnapshot.balance < amount.amount) {
    return `NPL 余额不足：当前 ${formatNpl(walletSnapshot.balance)}。`;
  }
  return null;
}

function claimPrincipalActionReason(baseWriteReason: string | null, readState: ChainReadState, claimableCount: number) {
  if (baseWriteReason) return baseWriteReason;
  if (readState.kind !== "ready") return "链上状态未确认。";
  if (readState.pool.pausedClaimPrincipal) return "合约当前暂停领取本金。";
  if (claimableCount === 0) return "当前没有可释放本金。";
  return null;
}

function claimRewardActionReason(baseWriteReason: string | null, readState: ChainReadState, pendingReward: bigint) {
  if (baseWriteReason) return baseWriteReason;
  if (readState.kind !== "ready") return "链上状态未确认。";
  if (readState.pool.pausedClaimReward) return "合约当前暂停领取奖励。";
  if (pendingReward === 0n) return "当前没有待领奖励。";
  return null;
}

function explodeActionReason(baseWriteReason: string | null, readState: ChainReadState) {
  if (baseWriteReason) return baseWriteReason;
  if (readState.kind !== "ready") return "链上状态未确认。";
  if (readState.pool.pausedExplode) return "合约当前暂停爆区块。";
  if (!readState.next.canExplode) return "本金或奖励池未达标，当前不能爆区块。";
  return null;
}

function pauseStateCopy(pool: PoolState) {
  const paused = [pool.pausedDeposit, pool.pausedExplode, pool.pausedClaimPrincipal, pool.pausedClaimReward].filter(Boolean).length;
  if (paused === 0) return "全开启";
  if (paused === 4) return "全暂停";
  return `${paused} 项暂停`;
}

function progressBps(active: bigint, target: bigint) {
  if (target <= 0n) return 0n;
  const bps = (active * 10_000n) / target;
  return bps > 10_000n ? 10_000n : bps;
}

function formatProgressBps(bps: bigint) {
  const capped = bps > 10_000n ? 10_000n : bps;
  const integer = capped / 100n;
  const decimal = capped % 100n;
  return decimal === 0n ? `${integer}%` : `${integer}.${decimal.toString().padStart(2, "0").replace(/0$/, "")}%`;
}

function tankToneFor(bps: bigint) {
  if (bps <= 3_000n) return "red";
  if (bps <= 6_000n) return "yellow";
  return "green";
}

function tankStatusCopy(readState: ChainReadState) {
  if (readState.kind !== "ready") return "等待生产合约";
  if (readState.pool.pausedDeposit || readState.pool.pausedExplode) return "暂停中";
  if (readState.next.canExplode) return "水位已满";
  if (!readState.next.rewardReady && readState.next.principalReady) return "待补奖励池";
  return "正在蓄水";
}

function pendingActionCopy(pending: PendingWrite) {
  const action = {
    deposit: pending.step === "approve" ? "NPL 授权" : "打入 NPL",
    claimPrincipal: "领取本金",
    claimReward: "领取奖励",
    explode: "爆区块",
  }[pending.action];
  return `${action}交易 ${shortenHash(pending.txHash)}`;
}

function buildPendingWrite(
  config: BlockBurstConfig,
  wallet: string,
  action: WriteAction,
  step: PendingWriteStep,
  target: string | null,
  txHash: string,
  data: string,
  amount?: bigint,
): PendingWrite {
  if (!target) throw new Error("交易目标合约未配置。");
  const pending: PendingWrite = {
    version: 1,
    action,
    step,
    wallet: wallet.toLowerCase(),
    chainId: config.chainId,
    target: target.toLowerCase(),
    txHash,
    selector: functionSelector(data),
    createdAt: Date.now(),
  };
  return amount === undefined ? pending : { ...pending, amount: amount.toString() };
}

function readPendingWrite(config: BlockBurstConfig, wallet: string) {
  const storage = safeLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingWriteKey(config, wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingWrite;
    if (!isPendingWriteFor(config, wallet, parsed)) {
      storage.removeItem(pendingWriteKey(config, wallet));
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(pendingWriteKey(config, wallet));
    return null;
  }
}

function savePendingWrite(config: BlockBurstConfig, wallet: string, pending: PendingWrite) {
  safeLocalStorage()?.setItem(pendingWriteKey(config, wallet), JSON.stringify(pending));
}

function clearPendingWrite(config: BlockBurstConfig, wallet: string) {
  safeLocalStorage()?.removeItem(pendingWriteKey(config, wallet));
}

function pendingWriteKey(config: BlockBurstConfig, wallet: string) {
  return `block-burst:pending:v1:${config.chainId}:${config.proxy?.toLowerCase() ?? "no-proxy"}:${wallet.toLowerCase()}`;
}

function isPendingWriteFor(config: BlockBurstConfig, wallet: string, value: PendingWrite) {
  return (
    value?.version === 1 &&
    value.chainId === config.chainId &&
    value.wallet?.toLowerCase() === wallet.toLowerCase() &&
    isTxHash(value.txHash) &&
    isEvmAddress(value.target) &&
    /^0x[0-9a-fA-F]{8}$/.test(value.selector)
  );
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseNplAmountInput(value: string):
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ok"; amount: bigint }> {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed) return { kind: "empty" };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { kind: "error", message: "NPL 数量只能填写普通数字，不支持负数或科学计数法。" };
  const [wholePart = "0", fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > NPL_DECIMALS) return { kind: "error", message: `NPL 最多支持 ${NPL_DECIMALS} 位小数。` };
  const whole = BigInt(wholePart);
  const fraction = BigInt((fractionPart || "").padEnd(NPL_DECIMALS, "0") || "0");
  const amount = whole * NPL_BASE + fraction;
  if (amount === 0n) return { kind: "error", message: "打入数量必须大于 0。" };
  return { kind: "ok", amount };
}

async function connectBlockBurstWallet(config: BlockBurstConfig) {
  const ethereum = injectedEthereum();
  if (!ethereum) throw new Error("未检测到浏览器钱包。");
  await ensureBlockBurstChain(ethereum, config.chainId);
  const accounts = await ethereum.request({ method: "eth_requestAccounts" });
  return { ethereum, address: firstWalletAccount(accounts).toLowerCase() };
}

async function requireBlockBurstWallet(config: BlockBurstConfig, expectedWallet: string | null) {
  if (expectedWallet && !isEvmAddress(expectedWallet)) {
    throw new Error("请先连接爆区块钱包后再写链。");
  }
  const wallet = await connectBlockBurstWallet(config);
  if (expectedWallet && wallet.address !== expectedWallet.toLowerCase()) {
    throw new Error("当前浏览器钱包与爆区块连接钱包不一致，请切换爆区块钱包后重试。");
  }
  return wallet;
}

async function ensureBlockBurstChain(ethereum: Eip1193ProviderLike, chainId: number) {
  const expectedHex = `0x${chainId.toString(16)}`;
  const current = await ethereum.request({ method: "eth_chainId" });
  if (normalizeChainId(current) === chainId) return;
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expectedHex }] });
  } catch {
    throw new Error("请将钱包切换到 BSC 主网（56）后重试。");
  }
  const switched = await ethereum.request({ method: "eth_chainId" });
  if (normalizeChainId(switched) !== chainId) throw new Error("钱包未切换到 BSC 主网（56）。");
}

function normalizeChainId(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  return Number.parseInt(value, value.startsWith("0x") ? 16 : 10);
}

function firstWalletAccount(value: unknown) {
  if (!Array.isArray(value) || typeof value[0] !== "string" || !isEvmAddress(value[0])) throw new Error("钱包未返回有效账户。");
  return value[0];
}

async function encodeBlockBurstFunction(functionName: string, args: readonly unknown[]) {
  const abi = await getBlockBurstInterface();
  return abi.encodeFunctionData(functionName, [...args]);
}

async function encodeErc20Function(functionName: string, args: readonly unknown[]) {
  const abi = await getErc20Interface();
  return abi.encodeFunctionData(functionName, [...args]);
}

function functionSelector(data: string) {
  if (!/^0x[0-9a-fA-F]{8}/.test(data)) throw new Error("交易内容缺少函数选择器。");
  return data.slice(0, 10).toLowerCase();
}

async function sendWalletTransaction(config: BlockBurstConfig, from: string, to: string | null, data: string) {
  const ethereum = injectedEthereum();
  if (!ethereum) throw new Error("未检测到浏览器钱包。");
  if (!to || !isEvmAddress(to)) throw new Error("交易目标合约未配置。");
  await ensureBlockBurstChain(ethereum, config.chainId);
  const txHash = await ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from, to, data }],
  });
  if (typeof txHash !== "string" || !isTxHash(txHash)) throw new Error("钱包未返回有效交易编号。");
  return txHash;
}

async function waitForTransactionReceipt(config: BlockBurstConfig, txHash: string, expected?: PendingWrite) {
  if (!config.rpcUrl) throw new Error("只读链上节点未配置，无法确认交易。");
  for (let attempt = 0; attempt < TX_RECEIPT_ATTEMPTS; attempt += 1) {
    const receipt = await rpc<TransactionReceiptRpc | null>(config.rpcUrl, "eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      if (typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error("链上节点返回的交易回执与提交记录不一致，已停止刷新。");
      }
      if (expected) validateReceiptAgainstPending(receipt, expected);
      if (String(receipt.status).toLowerCase() !== "0x1") throw new Error(`链上交易执行失败：${txHash}`);
      if (!isPositiveHexQuantity(receipt.blockNumber)) throw new Error("链上节点返回的交易回执缺少有效区块号。");
      if (!isHash(receipt.blockHash)) throw new Error("链上节点返回的交易回执缺少有效区块哈希。");
      if (expected) {
        const tx = await rpc<TransactionRpc | null>(config.rpcUrl, "eth_getTransactionByHash", [txHash]);
        validateTransactionAgainstPending(tx, expected);
      }
      return receipt;
    }
    await delay(TX_RECEIPT_INTERVAL_MS);
  }
  throw new Error(`交易已提交但暂未确认：${shortenHash(txHash)}。请稍后刷新链上状态。`);
}

function validateReceiptAgainstPending(receipt: TransactionReceiptRpc, expected: PendingWrite) {
  if (receipt.from && receipt.from.toLowerCase() !== expected.wallet.toLowerCase()) {
    throw new Error("链上节点返回的交易发送方与当前钱包不一致。");
  }
  if (receipt.to && receipt.to.toLowerCase() !== expected.target.toLowerCase()) {
    throw new Error("链上节点返回的交易目标与爆区块目标不一致。");
  }
}

function validateTransactionAgainstPending(tx: TransactionRpc | null, expected: PendingWrite) {
  if (!tx) throw new Error("链上节点未返回交易详情，无法校验交易内容。");
  if (typeof tx.hash !== "string" || tx.hash.toLowerCase() !== expected.txHash.toLowerCase()) {
    throw new Error("链上节点返回的交易详情与提交记录不一致。");
  }
  if (typeof tx.from !== "string" || tx.from.toLowerCase() !== expected.wallet.toLowerCase()) {
    throw new Error("交易详情发送方与当前钱包不一致。");
  }
  if (typeof tx.to !== "string" || tx.to.toLowerCase() !== expected.target.toLowerCase()) {
    throw new Error("交易详情目标合约不一致。");
  }
  if (typeof tx.input !== "string" || !tx.input.toLowerCase().startsWith(expected.selector)) {
    throw new Error("交易详情函数选择器不一致。");
  }
}

function injectedEthereum() {
  const maybe = (globalThis as typeof globalThis & { ethereum?: Eip1193ProviderLike }).ethereum;
  return typeof maybe?.request === "function" ? maybe : null;
}

function isPositiveHexQuantity(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return false;
  return BigInt(value) > 0n;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatNpl(value: bigint) {
  const whole = value / NPL_BASE;
  if (whole >= TRILLION) return `${formatBigRatio(whole, TRILLION)} 万亿`;
  if (whole >= 100_000_000n) return `${formatBigRatio(whole, 100_000_000n)} 亿`;
  const cents = (value * 100n + NPL_BASE / 2n) / NPL_BASE;
  if (value > 0n && cents === 0n) return "<0.01 NPL";
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")} NPL`;
}

function formatBigRatio(value: bigint, divisor: bigint) {
  const integer = value / divisor;
  const firstDecimal = ((value % divisor) * 10n) / divisor;
  return firstDecimal > 0n ? `${integer}.${firstDecimal}` : integer.toString();
}

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortenHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}
