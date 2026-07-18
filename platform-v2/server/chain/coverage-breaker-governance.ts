import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from '../data/audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';

const ROUTER = new Interface([
  'event PaymentPauseChanged(bool paused,bytes32 indexed evidenceHash)',
  'function newPaymentsPaused() view returns (bool)',
]);
const PAYMENT_PAUSE_TOPIC = ROUTER.getEvent('PaymentPauseChanged')!.topicHash.toLowerCase();

type ActionState =
  | 'PENDING_EXECUTION' | 'SUBMITTED' | 'MINED' | 'FINAL' | 'REORGED' | 'FAILED' | 'SUPERSEDED';

interface CoverageBreakerActionRow {
  action_id: string;
  snapshot_id: string;
  policy_version: string | number;
  action: 'PAUSE' | 'RESUME';
  target_paused: boolean;
  evidence_hash: string;
  governance_wallet_address: string;
  router_address: string;
  calldata: string;
  calldata_hash: string;
  state: ActionState;
  executor_nonce: string | number | null;
  submitted_tx_hash: string | null;
  execution_evidence_hash: string | null;
  execution_tx_hash: string | null;
  block_number: string | number | null;
  block_hash: string | null;
  confirmations: number;
  canonical: boolean | null;
  replaces_action_id: string | null;
  actor_wallet: string | null;
  secondary_signer: string | null;
  secondary_signature_hash: string | null;
  approval_nonce: string | number | null;
  approval_deadline: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CoverageBreakerExecution {
  actionId: string;
  governanceWallet: string;
  routerAddress: string;
  calldata: string;
  calldataHash: string;
  targetPaused: boolean;
  evidenceHash: string;
  policyVersion: number;
  minimumExecutorNonce: string;
}

export interface CoverageBreakerEoaExecutor {
  execute(input: CoverageBreakerExecution): Promise<{
    executorWallet: string;
    executorNonce: string;
    submittedTxHash: string;
    executionEvidenceHash: string;
  }>;
}

export interface CoverageBreakerFinalityCandidate extends CoverageBreakerExecution {
  submittedTxHash: string;
  priorState: 'SUBMITTED' | 'MINED' | 'FINAL';
  priorFinality?: { executionTxHash: string; blockNumber: number; blockHash: string };
}

export type CoverageBreakerObservation =
  | { state: 'NOT_FOUND' }
  | {
      state: 'MINED' | 'FINAL';
      submittedTxHash: string;
      executionTxHash: string;
      blockNumber: number;
      blockHash: string;
      confirmations: number;
      canonical: true;
      targetPaused: boolean;
      evidenceHash: string;
      observationEvidenceHash: string;
    }
  | {
      state: 'REORGED';
      submittedTxHash: string;
      executionTxHash?: string;
      blockNumber?: number;
      blockHash?: string;
      canonicalBlockHash?: string;
      confirmations: 0;
      canonical: false;
      targetPaused: boolean;
      evidenceHash: string;
      observationEvidenceHash: string;
    }
  | {
      state: 'FAILED';
      submittedTxHash: string;
      executionTxHash: string;
      blockNumber: number;
      blockHash: string;
      confirmations: number;
      canonical: true;
      targetPaused: boolean;
      evidenceHash: string;
      observationEvidenceHash: string;
      reasonCode: 'EXECUTION_REVERTED';
    };

export interface CoverageBreakerChainSource {
  observe(input: CoverageBreakerFinalityCandidate): Promise<CoverageBreakerObservation>;
}

export class HttpCoverageBreakerEoaExecutor implements CoverageBreakerEoaExecutor {
  readonly #url: string | undefined;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: {
    url?: string;
    token?: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  }) {
    this.#url = input.url;
    this.#token = input.token;
    this.#fetch = fetchWithDeadline(input.fetchImpl ?? fetch, input.requestTimeoutMs);
  }

  async execute(input: CoverageBreakerExecution) {
    if (!this.#url || !this.#token) {
      throw new CoreError('ConfigurationRequired', 'Coverage-breaker EOA executor is not configured', 503);
    }
    const url = secureUrl(this.#url, 'coverage-breaker EOA executor');
    const requestDigest = coverageBreakerExecutionRequestDigest(input);
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({
        artifactVersion: CORE_ARTIFACT_VERSION,
        chainId: 56,
        from: input.governanceWallet,
        to: input.routerAddress,
        value: '0',
        data: input.calldata,
        dataHash: input.calldataHash,
        resourceType: 'COVERAGE_BREAKER',
        resourceId: input.actionId,
        targetPaused: input.targetPaused,
        evidenceHash: input.evidenceHash,
        policyVersion: input.policyVersion,
        minimumExecutorNonce: input.minimumExecutorNonce,
        requestDigest,
      }),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Coverage-breaker EOA executor rejected the request', 503);
    const body = await responseJson(response) as Record<string, unknown>;
    if (
      !isCanonicalNonce(body.executorNonce)
      || BigInt(body.executorNonce) < BigInt(input.minimumExecutorNonce)
      || !isAddress(body.executorWallet)
      || !isHash(body.submittedTxHash)
      || !isHash(body.executionEvidenceHash)
      || body.dataHash !== input.calldataHash
      || body.resourceId !== input.actionId
      || body.targetPaused !== input.targetPaused
      || body.evidenceHash !== input.evidenceHash
      || Number(body.policyVersion) !== input.policyVersion
      || body.minimumExecutorNonce !== input.minimumExecutorNonce
      || body.requestDigest !== requestDigest
    ) throw new CoreError('InvalidFinality', 'Coverage-breaker EOA executor response is not request-bound', 502);
    const executorWallet = getAddress(body.executorWallet).toLowerCase();
    if (executorWallet !== getAddress(input.governanceWallet).toLowerCase()) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker execution used the wrong EOA', 502);
    }
    return {
      executorWallet,
      executorNonce: body.executorNonce,
      submittedTxHash: body.submittedTxHash.toLowerCase(),
      executionEvidenceHash: body.executionEvidenceHash.toLowerCase(),
    };
  }
}

export class ResilientCoverageBreakerChainSource implements CoverageBreakerChainSource {
  readonly #primaryRpcUrl: string | undefined;
  readonly #fallbackRpcUrl: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: {
    primaryRpcUrl?: string;
    fallbackRpcUrl?: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  }) {
    this.#primaryRpcUrl = input.primaryRpcUrl;
    this.#fallbackRpcUrl = input.fallbackRpcUrl;
    this.#fetch = fetchWithDeadline(input.fetchImpl ?? fetch, input.requestTimeoutMs);
  }

  async observe(input: CoverageBreakerFinalityCandidate): Promise<CoverageBreakerObservation> {
    if (!this.#primaryRpcUrl || !this.#fallbackRpcUrl) {
      throw new CoreError('ConfigurationRequired', 'Coverage-breaker finality source is not configured', 503);
    }
    const executionTxHash = input.submittedTxHash.toLowerCase();
    const primary = secureUrl(this.#primaryRpcUrl, 'primary coverage-breaker RPC').toString();
    const fallback = secureUrl(this.#fallbackRpcUrl, 'fallback coverage-breaker RPC').toString();
    if (normalizedUrl(primary) === normalizedUrl(fallback)) {
      throw new CoreError('ConfigurationRequired', 'Coverage-breaker finality requires two distinct RPC providers', 503);
    }
    const [primaryChainId, fallbackChainId, primaryReceipt, fallbackReceipt, primaryTx, fallbackTx, primaryHead, fallbackHead] =
      await Promise.all([
        rpc(this.#fetch, primary, 'eth_chainId', []),
        rpc(this.#fetch, fallback, 'eth_chainId', []),
        rpc(this.#fetch, primary, 'eth_getTransactionReceipt', [executionTxHash]),
        rpc(this.#fetch, fallback, 'eth_getTransactionReceipt', [executionTxHash]),
        rpc(this.#fetch, primary, 'eth_getTransactionByHash', [executionTxHash]),
        rpc(this.#fetch, fallback, 'eth_getTransactionByHash', [executionTxHash]),
        rpc(this.#fetch, primary, 'eth_blockNumber', []),
        rpc(this.#fetch, fallback, 'eth_blockNumber', []),
      ]);
    if (hexNumber(primaryChainId, 'primary chain id') !== 56 || hexNumber(fallbackChainId, 'fallback chain id') !== 56) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker finality RPC must be BSC chain 56', 409);
    }
    if (primaryReceipt === null && fallbackReceipt === null) {
      if (input.priorState !== 'FINAL' || !input.priorFinality) return { state: 'NOT_FOUND' };
      const canonicalBlockHash = await canonicalBlockHashAt(
        this.#fetch,
        primary,
        fallback,
        input.priorFinality.blockNumber,
      );
      if (canonicalBlockHash === input.priorFinality.blockHash.toLowerCase()) {
        throw new CoreError('InvalidFinality', 'Coverage-breaker receipt disappeared from a canonical block', 409);
      }
      return reorged(input, input.priorFinality, canonicalBlockHash);
    }
    if (primaryReceipt === null || fallbackReceipt === null || primaryTx === null || fallbackTx === null) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker execution differs across RPC providers', 409);
    }
    const receipt = normalizedReceipt(primaryReceipt, executionTxHash);
    const fallbackEvidence = normalizedReceipt(fallbackReceipt, executionTxHash);
    const transaction = normalizedTransaction(primaryTx, executionTxHash);
    const fallbackTransaction = normalizedTransaction(fallbackTx, executionTxHash);
    if (stableJson(receipt) !== stableJson(fallbackEvidence) || stableJson(transaction) !== stableJson(fallbackTransaction)) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker execution differs across RPC providers', 409);
    }
    if (
      transaction.from !== getAddress(input.governanceWallet).toLowerCase()
      || transaction.to !== getAddress(input.routerAddress).toLowerCase()
      || transaction.input !== input.calldata.toLowerCase()
      || transaction.nonce !== input.minimumExecutorNonce
      || transaction.value !== '0'
    ) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker transaction drifted from its frozen EOA execution', 409);
    }
    const blockNumber = Number(BigInt(receipt.blockNumber));
    const canonicalBlockHash = await canonicalBlockHashAt(this.#fetch, primary, fallback, blockNumber);
    if (canonicalBlockHash !== receipt.blockHash) {
      return reorged(input, { executionTxHash, blockNumber, blockHash: receipt.blockHash }, canonicalBlockHash);
    }
    const confirmations = Math.max(
      0,
      Math.min(hexNumber(primaryHead, 'primary head'), hexNumber(fallbackHead, 'fallback head')) - blockNumber + 1,
    );
    const baseEvidence = {
      submittedTxHash: input.submittedTxHash,
      executionTxHash,
      blockNumber,
      blockHash: receipt.blockHash,
      confirmations,
      canonical: true as const,
      targetPaused: input.targetPaused,
      evidenceHash: input.evidenceHash,
    };
    if (receipt.status === '0x0') {
      return {
        state: 'FAILED',
        ...baseEvidence,
        reasonCode: 'EXECUTION_REVERTED',
        observationEvidenceHash: hashJson({ ...baseEvidence, reasonCode: 'EXECUTION_REVERTED' }),
      };
    }
    const matchingLogs = receipt.logs.filter((log) =>
      log.address === input.routerAddress && log.topics[0] === PAYMENT_PAUSE_TOPIC);
    if (matchingLogs.length !== 1) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker execution must emit exactly one PaymentPauseChanged', 409);
    }
    const decoded = decodePaymentPauseChanged(matchingLogs[0]!);
    if (decoded.paused !== input.targetPaused || decoded.evidenceHash !== input.evidenceHash) {
      throw new CoreError('InvalidFinality', 'PaymentPauseChanged does not match the frozen coverage action', 409);
    }
    const blockTag = receipt.blockNumber;
    const stateCalldata = ROUTER.encodeFunctionData('newPaymentsPaused');
    const [primaryState, fallbackState] = await Promise.all([
      rpc(this.#fetch, primary, 'eth_call', [{ to: input.routerAddress, data: stateCalldata }, blockTag]),
      rpc(this.#fetch, fallback, 'eth_call', [{ to: input.routerAddress, data: stateCalldata }, blockTag]),
    ]);
    const primaryPaused = Boolean(ROUTER.decodeFunctionResult('newPaymentsPaused', stringValue(primaryState, 'router state'))[0]);
    const fallbackPaused = Boolean(ROUTER.decodeFunctionResult('newPaymentsPaused', stringValue(fallbackState, 'router state'))[0]);
    if (primaryPaused !== input.targetPaused || fallbackPaused !== input.targetPaused) {
      throw new CoreError('InvalidFinality', 'Router pause state does not match the finalized EOA action', 409);
    }
    return {
      state: confirmations >= 15 ? 'FINAL' : 'MINED',
      ...baseEvidence,
      observationEvidenceHash: hashJson({ ...baseEvidence, paused: decoded.paused }),
    };
  }
}

export class CoverageBreakerGovernanceWorker {
  readonly #transactions: SqlTransactionRunner;
  readonly #executor: CoverageBreakerEoaExecutor;
  readonly #chain: CoverageBreakerChainSource;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #lastErrorCode: string | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    executor: CoverageBreakerEoaExecutor;
    chain: CoverageBreakerChainSource;
  }) {
    this.#transactions = input.transactions;
    this.#executor = input.executor;
    this.#chain = input.chain;
  }

  async pollOnce() {
    let pollErrorCode: string | undefined;
    const executions = await this.#pendingExecutions(10);
    for (const action of executions) {
      try {
        if (!action.target_paused && await this.#hasSupersedingPause(action)) {
          await this.#supersedeResume(action.action_id);
          continue;
        }
        const execution = await this.#executionFor(action);
        const result = await this.#executor.execute(execution);
        await this.#recordExecution(action.action_id, result);
      } catch (error) {
        pollErrorCode ??= errorCode(error);
      }
    }
    const finality = await this.#pendingFinality(25);
    for (const action of finality) {
      try {
        const observation = await this.#chain.observe(finalityCandidate(action));
        if (observation.state !== 'NOT_FOUND') await this.#recordObservation(action.action_id, observation);
      } catch (error) {
        pollErrorCode ??= errorCode(error);
      }
    }
    this.#lastErrorCode = pollErrorCode;
    return { executions: executions.length, finality: finality.length };
  }

  start(intervalMs = 5_000) {
    if (this.#timer || this.#running) return;
    const tick = () => {
      this.#running = this.pollOnce()
        .then(() => undefined)
        .catch((error) => { this.#lastErrorCode = errorCode(error); })
        .finally(() => {
          this.#running = undefined;
          if (this.#timer) this.#timer = setTimeout(tick, intervalMs);
        });
    };
    this.#timer = setTimeout(tick, 0);
  }

  async stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  status() {
    return Object.freeze({ healthy: this.#lastErrorCode === undefined, errorCode: this.#lastErrorCode });
  }

  #pendingExecutions(limit: number) {
    return this.#transactions.transaction(async (executor) => (
      await executor.query<CoverageBreakerActionRow>(
        `SELECT * FROM core.coverage_breaker_actions
         WHERE state = 'PENDING_EXECUTION' ORDER BY created_at, action_id LIMIT $1`,
        [limit],
      )
    ).rows);
  }

  #pendingFinality(limit: number) {
    return this.#transactions.transaction(async (executor) => (
      await executor.query<CoverageBreakerActionRow>(
        `SELECT * FROM core.coverage_breaker_actions
         WHERE state IN ('SUBMITTED','MINED','FINAL')
         ORDER BY CASE WHEN state = 'FINAL' THEN 1 ELSE 0 END, updated_at, action_id LIMIT $1`,
        [limit],
      )
    ).rows);
  }

  #executionFor(action: CoverageBreakerActionRow) {
    return this.#transactions.transaction(async (executor) => {
      const prior = await executor.query<{ max_executor_nonce: string | null; earlier_pending: boolean }>(
        `SELECT
           (SELECT max(executor_nonce)::text FROM core.coverage_breaker_actions
            WHERE governance_wallet_address = $1 AND executor_nonce IS NOT NULL) AS max_executor_nonce,
           EXISTS (
             SELECT 1 FROM core.coverage_breaker_actions earlier
             WHERE earlier.governance_wallet_address = $1
               AND earlier.state = 'PENDING_EXECUTION'
               AND (earlier.created_at, earlier.action_id) < ($2, $3)
           ) AS earlier_pending`,
        [action.governance_wallet_address, action.created_at, action.action_id],
      );
      if (prior.rows[0]?.earlier_pending) {
        throw new CoreError('FinalityPending', 'Earlier coverage-breaker action is awaiting an EOA nonce', 409);
      }
      const minimumExecutorNonce = prior.rows[0]?.max_executor_nonce === null
        ? '0'
        : (BigInt(prior.rows[0]!.max_executor_nonce) + 1n).toString();
      return executionFromRow(action, minimumExecutorNonce);
    });
  }

  #hasSupersedingPause(action: CoverageBreakerActionRow) {
    return this.#transactions.transaction(async (executor) => (
      await executor.query<{ superseded: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM core.coverage_breaker_actions pause_action
           JOIN core.coverage_snapshots pause_snapshot
             ON pause_snapshot.snapshot_id = pause_action.snapshot_id
           JOIN core.coverage_snapshots resume_snapshot
             ON resume_snapshot.snapshot_id = $1
           WHERE pause_action.target_paused
             AND pause_action.state IN ('PENDING_EXECUTION','SUBMITTED','MINED','FINAL')
             AND (
               pause_snapshot.block_number > resume_snapshot.block_number
               OR pause_action.created_at > $2
             )
         ) AS superseded`,
        [action.snapshot_id, action.created_at],
      )
    ).rows[0]?.superseded === true);
  }

  #supersedeResume(actionId: string) {
    return this.#transactions.transaction(async (executor) => {
      const action = await lockedAction(executor, actionId);
      if (action.state !== 'PENDING_EXECUTION' || action.target_paused) return;
      const now = new Date();
      await executor.query(
        `UPDATE core.coverage_breaker_actions SET state = 'SUPERSEDED', updated_at = $2
         WHERE action_id = $1`,
        [actionId, now],
      );
      await appendTransition(executor, action, 'SUPERSEDED', { reasonCode: 'NEWER_PAUSE_ACTION' }, now);
      await enqueueActionAudit(
        executor,
        action,
        'CoverageBreakerResumeSuperseded',
        'SYSTEM',
        { reasonCode: 'NEWER_PAUSE_ACTION' },
        now,
      );
    });
  }

  #recordExecution(actionId: string, execution: {
    executorWallet: string;
    executorNonce: string;
    submittedTxHash: string;
    executionEvidenceHash: string;
  }) {
    if (
      !isAddress(execution.executorWallet)
      || !isCanonicalNonce(execution.executorNonce)
      || !isHash(execution.submittedTxHash)
      || !isHash(execution.executionEvidenceHash)
    ) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker EOA execution evidence is invalid', 502);
    }
    return this.#transactions.transaction(async (executor) => {
      const action = await lockedAction(executor, actionId);
      if (action.state !== 'PENDING_EXECUTION') {
        if (
          String(action.executor_nonce) === execution.executorNonce
          && action.submitted_tx_hash === execution.submittedTxHash.toLowerCase()
        ) return;
        throw new CoreError('IdempotencyConflict', 'Coverage-breaker action changed during EOA execution', 409);
      }
      if (getAddress(execution.executorWallet).toLowerCase() !== getAddress(action.governance_wallet_address).toLowerCase()) {
        throw new CoreError('InvalidFinality', 'Coverage-breaker execution used the wrong EOA', 409);
      }
      const prior = await executor.query<{ max_executor_nonce: string | null; earlier_pending: boolean }>(
        `SELECT
           (SELECT max(executor_nonce)::text FROM core.coverage_breaker_actions
            WHERE governance_wallet_address = $1 AND executor_nonce IS NOT NULL) AS max_executor_nonce,
           EXISTS (
             SELECT 1 FROM core.coverage_breaker_actions earlier
             WHERE earlier.governance_wallet_address = $1
               AND earlier.state = 'PENDING_EXECUTION'
               AND (earlier.created_at, earlier.action_id) < ($2, $3)
           ) AS earlier_pending`,
        [action.governance_wallet_address, action.created_at, action.action_id],
      );
      if (
        prior.rows[0]?.earlier_pending
        || (prior.rows[0]?.max_executor_nonce !== null
          && BigInt(execution.executorNonce) <= BigInt(prior.rows[0]!.max_executor_nonce))
      ) throw new CoreError('InvalidFinality', 'Coverage-breaker EOA nonce does not preserve action order', 409);
      const now = new Date();
      await executor.query(
        `UPDATE core.coverage_breaker_actions
         SET state = 'SUBMITTED', executor_nonce = $2, submitted_tx_hash = $3, execution_evidence_hash = $4, updated_at = $5
         WHERE action_id = $1`,
        [actionId, execution.executorNonce, execution.submittedTxHash.toLowerCase(), execution.executionEvidenceHash.toLowerCase(), now],
      );
      await appendTransition(executor, action, 'SUBMITTED', execution, now);
      await enqueueActionAudit(executor, action, 'CoverageBreakerEoaSubmitted', 'SYSTEM', {
        executorWallet: getAddress(execution.executorWallet).toLowerCase(),
        executorNonce: execution.executorNonce,
        submittedTxHash: execution.submittedTxHash.toLowerCase(),
        executionEvidenceHash: execution.executionEvidenceHash.toLowerCase(),
      }, now);
    });
  }

  #recordObservation(actionId: string, observation: Exclude<CoverageBreakerObservation, { state: 'NOT_FOUND' }>) {
    return this.#transactions.transaction(async (executor) => {
      const action = await lockedAction(executor, actionId);
      validateObservation(action, observation);
      const now = new Date();
      if (
        action.state === 'FINAL'
        && observation.state === 'FINAL'
        && action.execution_tx_hash === observation.executionTxHash
        && Number(action.block_number) === observation.blockNumber
        && action.block_hash === observation.blockHash
        && action.canonical === observation.canonical
      ) {
        await executor.query(
          'UPDATE core.coverage_breaker_actions SET updated_at = $2 WHERE action_id = $1',
          [actionId, now],
        );
        return;
      }
      await executor.query(
        `UPDATE core.coverage_breaker_actions
         SET state = $2, execution_tx_hash = $3, block_number = $4, block_hash = $5,
             confirmations = $6, canonical = $7, updated_at = $8
         WHERE action_id = $1`,
        [
          actionId,
          observation.state,
          observation.executionTxHash ?? action.execution_tx_hash,
          observation.blockNumber ?? action.block_number,
          observation.blockHash ?? action.block_hash,
          observation.confirmations,
          observation.canonical,
          now,
        ],
      );
      await appendTransition(executor, action, observation.state, observation, now);
      await enqueueActionAudit(
        executor,
        action,
        `CoverageBreaker${observation.state}`,
        observation.state === 'FINAL' ? 'CHAIN_FINAL' : 'CHAIN_OBSERVED',
        observation,
        now,
      );
      if (observation.state === 'FINAL' && !action.target_paused) {
        await finalizeResume(executor, action, now);
      }
      if (observation.state === 'REORGED' || observation.state === 'FAILED') {
        if (!action.target_paused) await pauseAfterResumeReversal(executor, action, observation, now);
        await insertReplacement(executor, action, observation, now);
      }
    });
  }
}

function executionFromRow(row: CoverageBreakerActionRow, minimumExecutorNonce: string): CoverageBreakerExecution {
  return {
    actionId: row.action_id,
    governanceWallet: row.governance_wallet_address,
    routerAddress: row.router_address,
    calldata: row.calldata,
    calldataHash: row.calldata_hash,
    targetPaused: row.target_paused,
    evidenceHash: row.evidence_hash,
    policyVersion: Number(row.policy_version),
    minimumExecutorNonce,
  };
}

function finalityCandidate(row: CoverageBreakerActionRow): CoverageBreakerFinalityCandidate {
  if (row.executor_nonce === null || !row.submitted_tx_hash) {
    throw new CoreError('InvalidFinality', 'Coverage-breaker EOA nonce or transaction hash is unavailable', 409);
  }
  return {
    ...executionFromRow(row, String(row.executor_nonce)),
    submittedTxHash: row.submitted_tx_hash,
    priorState: row.state as CoverageBreakerFinalityCandidate['priorState'],
    ...(row.execution_tx_hash && row.block_number !== null && row.block_hash
      ? {
          priorFinality: {
            executionTxHash: row.execution_tx_hash,
            blockNumber: Number(row.block_number),
            blockHash: row.block_hash,
          },
        }
      : {}),
  };
}

export function coverageBreakerExecutionRequestDigest(input: CoverageBreakerExecution) {
  if (
    !input.actionId
    || !isAddress(input.governanceWallet)
    || !isAddress(input.routerAddress)
    || !/^0x(?:[0-9a-fA-F]{2})+$/.test(input.calldata)
    || !isHash(input.calldataHash)
    || !isHash(input.evidenceHash)
    || !Number.isSafeInteger(input.policyVersion)
    || input.policyVersion < 1
    || !isCanonicalNonce(input.minimumExecutorNonce)
  ) throw new CoreError('InvalidRequest', 'Coverage-breaker EOA execution request is invalid');
  if (keccak256(input.calldata).toLowerCase() !== input.calldataHash.toLowerCase()) {
    throw new CoreError('InvalidRequest', 'Coverage-breaker calldata hash does not match the frozen action');
  }
  return hashJson({ artifactVersion: CORE_ARTIFACT_VERSION, chainId: 56, ...input });
}

function isCanonicalNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) < (1n << 256n);
  } catch {
    return false;
  }
}

async function lockedAction(executor: SqlExecutor, actionId: string) {
  const result = await executor.query<CoverageBreakerActionRow>(
    'SELECT * FROM core.coverage_breaker_actions WHERE action_id = $1 FOR UPDATE',
    [actionId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Coverage-breaker action not found', 404);
  return result.rows[0];
}

async function appendTransition(
  executor: SqlExecutor,
  action: CoverageBreakerActionRow,
  toState: ActionState,
  evidence: Record<string, unknown>,
  at: Date,
) {
  const transitionId = hashJson({ actionId: action.action_id, fromState: action.state, toState, evidence });
  await executor.query(
    `INSERT INTO core.coverage_breaker_action_transitions (
       transition_id, action_id, from_state, to_state, evidence, recorded_at
     ) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (transition_id) DO NOTHING`,
    [transitionId, action.action_id, action.state, toState, JSON.stringify(evidence), at],
  );
}

async function enqueueActionAudit(
  executor: SqlExecutor,
  action: CoverageBreakerActionRow,
  eventType: string,
  evidenceProfile: 'SYSTEM' | 'CHAIN_OBSERVED' | 'CHAIN_FINAL',
  evidence: Record<string, unknown>,
  at: Date,
) {
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:coverage-breaker', { actionId: action.action_id, eventType, evidence }),
    streamName: 'governance',
    evidenceProfile,
    eventType,
    resourceType: 'COVERAGE_BREAKER_ACTION',
    resourceId: action.action_id,
    actorWallet: action.governance_wallet_address,
    actorRole: 'GOVERNANCE_EOA',
    correlationId: action.action_id,
    requestHash: action.calldata_hash.slice(2),
    payload: {
      targetPaused: action.target_paused,
      evidenceHash: action.evidence_hash,
      routerAddress: action.router_address,
      ...evidence,
    },
    ...(evidenceProfile === 'SYSTEM'
      ? {}
      : {
          transactionEvidence: {
            txHash: String(evidence.executionTxHash),
            chainId: 56 as const,
            contractAddress: action.router_address,
            selector: action.calldata.slice(0, 10),
            calldataHash: action.calldata_hash,
            resourceId: action.action_id,
            policyVersion: Number(action.policy_version),
            ...(typeof evidence.blockHash === 'string' ? { blockHash: evidence.blockHash } : {}),
            ...(typeof evidence.confirmations === 'number' ? { confirmations: evidence.confirmations } : {}),
          },
        }),
    createdAt: at,
  });
}

async function insertReplacement(
  executor: SqlExecutor,
  action: CoverageBreakerActionRow,
  observation: Exclude<CoverageBreakerObservation, { state: 'NOT_FOUND' }>,
  at: Date,
) {
  const actionId = hashJson({
    domain: 'ABU24K_COVERAGE_BREAKER_REPLACEMENT_V1',
    replacesActionId: action.action_id,
    observationEvidenceHash: observation.observationEvidenceHash,
  });
  await executor.query(
    `INSERT INTO core.coverage_breaker_actions (
       action_id, snapshot_id, policy_version, action, target_paused, evidence_hash,
       governance_wallet_address, router_address, calldata, calldata_hash,
       state, replaces_action_id, actor_wallet, secondary_signer,
       secondary_signature_hash, approval_nonce, approval_deadline, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_EXECUTION',$11,$12,$13,$14,$15,$16,$17,$17)
     ON CONFLICT (action_id) DO NOTHING`,
    [
      actionId,
      action.snapshot_id,
      action.policy_version,
      action.action,
      action.target_paused,
      action.evidence_hash,
      action.governance_wallet_address,
      action.router_address,
      action.calldata,
      action.calldata_hash,
      action.action_id,
      action.actor_wallet,
      action.secondary_signer,
      action.secondary_signature_hash,
      action.approval_nonce,
      action.approval_deadline,
      at,
    ],
  );
  const replacement = await lockedAction(executor, actionId);
  await appendTransition(executor, { ...replacement, state: 'PENDING_EXECUTION' }, 'PENDING_EXECUTION', {
    replacesActionId: action.action_id,
    observationEvidenceHash: observation.observationEvidenceHash,
  }, at);
}

async function finalizeResume(executor: SqlExecutor, action: CoverageBreakerActionRow, at: Date) {
  await executor.query(
    `UPDATE core.breaker_causes SET active = false, evidence_hash = $2, updated_at = $3
     WHERE cause_type = 'COVERAGE' AND active AND updated_at <= $1`,
    [action.created_at, action.evidence_hash, at],
  );
  for (const scope of ['NEW_PAYMENT', 'NEW_SETTLEMENT_BATCH'] as const) {
    const active = await executor.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM core.breaker_causes WHERE scope = $1 AND active
       ) AS blocked`,
      [scope],
    );
    const paused = active.rows[0]?.blocked !== false;
    await executor.query(
      `INSERT INTO core.circuit_breakers (
         scope, paused, evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,$2,$3,$4,'COVERAGE_GOVERNANCE',$5)
       ON CONFLICT (scope) DO UPDATE SET paused = EXCLUDED.paused,
         evidence_hash = EXCLUDED.evidence_hash, policy_version = EXCLUDED.policy_version,
         changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
      [scope, paused, action.evidence_hash, action.policy_version, at],
    );
    if (!paused) {
      const eventId = hashJson({ scope, actionId: action.action_id, action: 'RESUME' });
      await executor.query(
        `INSERT INTO core.breaker_events (
           breaker_event_id, scope, action, cause_type, cause_id,
           evidence_hash, policy_version, changed_by, changed_at
         ) VALUES ($1,$2,'RESUME','COVERAGE',$3,$4,$5,'COVERAGE_GOVERNANCE',$6)
         ON CONFLICT (breaker_event_id) DO NOTHING`,
        [eventId, scope, action.action_id, action.evidence_hash, action.policy_version, at],
      );
    }
  }
}

async function pauseAfterResumeReversal(
  executor: SqlExecutor,
  action: CoverageBreakerActionRow,
  observation: Extract<CoverageBreakerObservation, { state: 'REORGED' | 'FAILED' }>,
  at: Date,
) {
  const causeId = `coverage-resume:${action.action_id}`;
  for (const scope of ['NEW_PAYMENT', 'NEW_SETTLEMENT_BATCH'] as const) {
    await executor.query(
      `INSERT INTO core.breaker_causes (
         scope, cause_type, cause_id, active, evidence_hash, updated_at
       ) VALUES ($1,'COVERAGE',$2,true,$3,$4)
       ON CONFLICT (scope, cause_type, cause_id) DO UPDATE SET active = true,
         evidence_hash = EXCLUDED.evidence_hash, updated_at = EXCLUDED.updated_at`,
      [scope, causeId, observation.observationEvidenceHash, at],
    );
    const eventId = hashJson({ scope, causeId, action: 'PAUSE', evidenceHash: observation.observationEvidenceHash });
    await executor.query(
      `INSERT INTO core.breaker_events (
         breaker_event_id, scope, action, cause_type, cause_id,
         evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,$2,'PAUSE','COVERAGE',$3,$4,$5,'COVERAGE_GOVERNANCE',$6)
       ON CONFLICT (breaker_event_id) DO NOTHING`,
      [eventId, scope, causeId, observation.observationEvidenceHash, action.policy_version, at],
    );
    await executor.query(
      `INSERT INTO core.circuit_breakers (
         scope, paused, evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,true,$2,$3,'COVERAGE_GOVERNANCE',$4)
       ON CONFLICT (scope) DO UPDATE SET paused = true,
         evidence_hash = EXCLUDED.evidence_hash, policy_version = EXCLUDED.policy_version,
         changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
      [scope, observation.observationEvidenceHash, action.policy_version, at],
    );
  }
}

function validateObservation(
  action: CoverageBreakerActionRow,
  observation: Exclude<CoverageBreakerObservation, { state: 'NOT_FOUND' }>,
) {
  if (
    observation.submittedTxHash !== action.submitted_tx_hash
    || observation.targetPaused !== action.target_paused
    || observation.evidenceHash !== action.evidence_hash
    || !isHash(observation.observationEvidenceHash)
  ) throw new CoreError('InvalidFinality', 'Coverage-breaker observation does not match the frozen action', 409);
  if (observation.state === 'FINAL' && observation.confirmations < 15) {
    throw new CoreError('FinalityPending', 'Coverage-breaker action has fewer than 15 confirmations', 409);
  }
  if (observation.state === 'MINED' && observation.confirmations >= 15) {
    throw new CoreError('InvalidFinality', 'Coverage-breaker action must be FINAL at 15 confirmations', 409);
  }
}

function reorged(
  input: CoverageBreakerFinalityCandidate,
  prior: { executionTxHash: string; blockNumber: number; blockHash: string },
  canonicalBlockHash: string,
): CoverageBreakerObservation {
  const evidence = {
    submittedTxHash: input.submittedTxHash,
    executionTxHash: prior.executionTxHash,
    blockNumber: prior.blockNumber,
    blockHash: prior.blockHash,
    canonicalBlockHash,
    confirmations: 0 as const,
    canonical: false as const,
    targetPaused: input.targetPaused,
    evidenceHash: input.evidenceHash,
  };
  return { state: 'REORGED', ...evidence, observationEvidenceHash: hashJson(evidence) };
}

function decodePaymentPauseChanged(log: { topics: readonly string[]; data: string }) {
  try {
    const event = ROUTER.parseLog({ topics: [...log.topics], data: log.data });
    if (!event || event.name !== 'PaymentPauseChanged') throw new Error('wrong event');
    return { paused: Boolean(event.args.paused), evidenceHash: String(event.args.evidenceHash).toLowerCase() };
  } catch {
    throw new CoreError('InvalidFinality', 'PaymentPauseChanged event cannot be decoded', 409);
  }
}

async function canonicalBlockHashAt(
  fetchImpl: typeof fetch,
  primary: string,
  fallback: string,
  blockNumber: number,
) {
  const tag = `0x${blockNumber.toString(16)}`;
  const [primaryBlock, fallbackBlock] = await Promise.all([
    rpc(fetchImpl, primary, 'eth_getBlockByNumber', [tag, false]),
    rpc(fetchImpl, fallback, 'eth_getBlockByNumber', [tag, false]),
  ]);
  const primaryHash = recordValue(primaryBlock, 'primary canonical block').hash;
  const fallbackHash = recordValue(fallbackBlock, 'fallback canonical block').hash;
  if (!isHash(primaryHash) || !isHash(fallbackHash) || primaryHash.toLowerCase() !== fallbackHash.toLowerCase()) {
    throw new CoreError('InvalidFinality', 'Coverage-breaker canonical block differs across RPC providers', 409);
  }
  return primaryHash.toLowerCase();
}

function normalizedReceipt(value: unknown, executionTxHash: string) {
  const receipt = recordValue(value, 'coverage-breaker receipt');
  if (
    !isHash(receipt.transactionHash)
    || receipt.transactionHash.toLowerCase() !== executionTxHash
    || !isHash(receipt.blockHash)
    || !isHexQuantity(receipt.blockNumber)
    || !['0x0', '0x1'].includes(String(receipt.status))
    || !Array.isArray(receipt.logs)
  ) throw new CoreError('InvalidFinality', 'Coverage-breaker receipt is malformed', 409);
  return {
    transactionHash: executionTxHash,
    blockNumber: String(receipt.blockNumber).toLowerCase(),
    blockHash: receipt.blockHash.toLowerCase(),
    status: String(receipt.status).toLowerCase(),
    logs: receipt.logs.map((item) => {
      const log = recordValue(item, 'coverage-breaker log');
      if (!isAddress(log.address) || !Array.isArray(log.topics) || log.topics.some((topic) => !isHash(topic))) {
        throw new CoreError('InvalidFinality', 'Coverage-breaker log is malformed', 409);
      }
      if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(log.data)) {
        throw new CoreError('InvalidFinality', 'Coverage-breaker log data is malformed', 409);
      }
      return {
        address: getAddress(log.address).toLowerCase(),
        topics: log.topics.map((topic) => String(topic).toLowerCase()),
        data: log.data.toLowerCase(),
      };
    }),
  };
}

function normalizedTransaction(value: unknown, executionTxHash: string) {
  const transaction = recordValue(value, 'coverage-breaker transaction');
  if (
    !isHash(transaction.hash)
    || transaction.hash.toLowerCase() !== executionTxHash
    || !isAddress(transaction.from)
    || !isAddress(transaction.to)
    || typeof transaction.input !== 'string'
    || !/^0x[0-9a-fA-F]*$/.test(transaction.input)
    || !isHexQuantity(transaction.nonce)
    || !isHexQuantity(transaction.value)
  ) {
    throw new CoreError('InvalidFinality', 'Coverage-breaker transaction is malformed', 409);
  }
  return {
    hash: executionTxHash,
    from: getAddress(transaction.from).toLowerCase(),
    to: getAddress(transaction.to).toLowerCase(),
    input: transaction.input.toLowerCase(),
    nonce: BigInt(transaction.nonce).toString(),
    value: BigInt(transaction.value).toString(),
  };
}

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new CoreError('ExternalBlocked', `Coverage-breaker RPC ${method} failed`, 503);
  const body = await responseJson(response) as Record<string, unknown>;
  if (body.error || !Object.prototype.hasOwnProperty.call(body, 'result')) {
    throw new CoreError('ExternalBlocked', `Coverage-breaker RPC ${method} returned an error`, 503);
  }
  return body.result;
}

const responseDeadlines = new WeakMap<Response, { controller: AbortController; deadlineAt: number }>();

function fetchWithDeadline(fetchImpl: typeof fetch, timeoutMs = 10_000): typeof fetch {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new CoreError('InvalidRequest', 'Coverage-breaker request timeout is invalid', 500);
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    const response = await withExternalDeadline(
      () => fetchImpl(input, { ...init, signal: controller.signal }),
      controller,
      deadlineAt,
    );
    responseDeadlines.set(response, { controller, deadlineAt });
    return response;
  }) as typeof fetch;
}

function responseJson(response: Response) {
  const deadline = responseDeadlines.get(response);
  return deadline
    ? withExternalDeadline(() => response.json(), deadline.controller, deadline.deadlineAt)
    : response.json();
}

async function withExternalDeadline<T>(request: () => Promise<T>, controller: AbortController, deadlineAt: number) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    controller.abort();
    throw new CoreError('ExternalBlocked', 'Coverage-breaker external request timed out', 503);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CoreError('ExternalBlocked', 'Coverage-breaker external request timed out', 503));
    }, remainingMs);
  });
  try {
    return await Promise.race([request(), deadline]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CoreError('ExternalBlocked', 'Coverage-breaker external request timed out', 503);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recordValue(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('InvalidFinality', `${name} is unavailable`, 409);
  }
  return value as Record<string, any>;
}

function stringValue(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  }
  return value;
}

function hexNumber(value: unknown, name: string) {
  if (!isHexQuantity(value)) throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) throw new CoreError('InvalidFinality', `${name} is too large`, 409);
  return number;
}

function isHexQuantity(value: unknown): value is string {
  return typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    getAddress(value);
    return true;
  } catch {
    return false;
  }
}

function secureUrl(value: string, name: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoreError('ConfigurationRequired', `${name} is invalid`, 503);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CoreError('ExternalBlocked', `${name} requires HTTPS without URL credentials`, 503);
  }
  return url;
}

function normalizedUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  return url.toString();
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function errorCode(error: unknown) {
  return error instanceof CoreError ? error.code : 'ExternalBlocked';
}
