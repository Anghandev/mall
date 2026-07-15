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

type ActionState = 'PENDING_PROPOSAL' | 'SAFE_PROPOSED' | 'MINED' | 'FINAL' | 'REORGED' | 'FAILED';

interface CoverageBreakerActionRow {
  action_id: string;
  snapshot_id: string;
  policy_version: string | number;
  action: 'PAUSE' | 'RESUME';
  target_paused: boolean;
  evidence_hash: string;
  governance_safe_address: string;
  router_address: string;
  calldata: string;
  calldata_hash: string;
  state: ActionState;
  safe_tx_hash: string | null;
  proposal_hash: string | null;
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

export interface CoverageBreakerSafeProposal {
  actionId: string;
  safeAddress: string;
  routerAddress: string;
  calldata: string;
  calldataHash: string;
  targetPaused: boolean;
  evidenceHash: string;
  policyVersion: number;
}

export interface CoverageBreakerSafeProposer {
  propose(input: CoverageBreakerSafeProposal): Promise<{ safeTxHash: string; proposalHash: string }>;
}

export interface CoverageBreakerFinalityCandidate extends CoverageBreakerSafeProposal {
  safeTxHash: string;
  priorState: 'SAFE_PROPOSED' | 'MINED' | 'FINAL';
  priorFinality?: { executionTxHash: string; blockNumber: number; blockHash: string };
}

export type CoverageBreakerObservation =
  | { state: 'NOT_FOUND' }
  | {
      state: 'MINED' | 'FINAL';
      safeTxHash: string;
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
      safeTxHash: string;
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
      safeTxHash: string;
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

export class HttpCoverageBreakerSafeProposer implements CoverageBreakerSafeProposer {
  readonly #url: string | undefined;
  readonly #token: string | undefined;
  readonly #mutualTls: boolean;
  readonly #fetch: typeof fetch;

  constructor(input: {
    url?: string;
    token?: string;
    mutualTls?: boolean;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  }) {
    this.#url = input.url;
    this.#token = input.token;
    this.#mutualTls = input.mutualTls === true;
    this.#fetch = fetchWithDeadline(input.fetchImpl ?? fetch, input.requestTimeoutMs);
  }

  async propose(input: CoverageBreakerSafeProposal) {
    if (!this.#url || !this.#token) {
      throw new CoreError('ConfigurationRequired', 'Safe coverage-breaker proposal service is not configured', 503);
    }
    const url = secureUrl(this.#url, 'Safe coverage-breaker proposal service');
    if (!this.#mutualTls) {
      throw new CoreError('ExternalBlocked', 'Safe coverage-breaker proposal transport requires mTLS', 503);
    }
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({
        artifactVersion: CORE_ARTIFACT_VERSION,
        chainId: 56,
        safeAddress: input.safeAddress,
        to: input.routerAddress,
        value: '0',
        operation: 0,
        data: input.calldata,
        dataHash: input.calldataHash,
        resourceType: 'COVERAGE_BREAKER',
        resourceId: input.actionId,
        targetPaused: input.targetPaused,
        evidenceHash: input.evidenceHash,
        policyVersion: input.policyVersion,
      }),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Safe coverage-breaker proposal was rejected', 503);
    const body = await responseJson(response) as Record<string, unknown>;
    if (
      !isHash(body.safeTxHash)
      || !isHash(body.proposalHash)
      || body.dataHash !== input.calldataHash
      || body.resourceId !== input.actionId
      || body.targetPaused !== input.targetPaused
      || body.evidenceHash !== input.evidenceHash
      || Number(body.policyVersion) !== input.policyVersion
    ) throw new CoreError('InvalidFinality', 'Safe coverage-breaker proposal response is not echo-bound', 502);
    return { safeTxHash: body.safeTxHash.toLowerCase(), proposalHash: body.proposalHash.toLowerCase() };
  }
}

export class ResilientCoverageBreakerChainSource implements CoverageBreakerChainSource {
  readonly #lookupUrl: string | undefined;
  readonly #lookupToken: string | undefined;
  readonly #primaryRpcUrl: string | undefined;
  readonly #fallbackRpcUrl: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: {
    lookupUrl?: string;
    lookupToken?: string;
    primaryRpcUrl?: string;
    fallbackRpcUrl?: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  }) {
    this.#lookupUrl = input.lookupUrl;
    this.#lookupToken = input.lookupToken;
    this.#primaryRpcUrl = input.primaryRpcUrl;
    this.#fallbackRpcUrl = input.fallbackRpcUrl;
    this.#fetch = fetchWithDeadline(input.fetchImpl ?? fetch, input.requestTimeoutMs);
  }

  async observe(input: CoverageBreakerFinalityCandidate): Promise<CoverageBreakerObservation> {
    if (!this.#lookupUrl || !this.#lookupToken || !this.#primaryRpcUrl || !this.#fallbackRpcUrl) {
      throw new CoreError('ConfigurationRequired', 'Coverage-breaker finality source is not configured', 503);
    }
    const lookup = await this.#fetch(secureUrl(this.#lookupUrl, 'Coverage-breaker execution lookup'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#lookupToken}` },
      body: JSON.stringify({ safeTxHash: input.safeTxHash, resourceId: input.actionId }),
    });
    if (!lookup.ok) throw new CoreError('ExternalBlocked', 'Coverage-breaker execution lookup failed', 503);
    const lookupBody = await responseJson(lookup) as Record<string, unknown>;
    if (lookupBody.safeTxHash !== input.safeTxHash || lookupBody.resourceId !== input.actionId) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker execution lookup is not Safe-hash-bound', 502);
    }
    if (lookupBody.executionTxHash === null) return { state: 'NOT_FOUND' };
    if (!isHash(lookupBody.executionTxHash)) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker execution transaction hash is invalid', 502);
    }
    const executionTxHash = lookupBody.executionTxHash.toLowerCase();
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
    if (transaction.to !== input.safeAddress) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker execution did not target the governance Safe', 409);
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
      safeTxHash: input.safeTxHash,
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
      throw new CoreError('InvalidFinality', 'Router pause state does not match the finalized Safe action', 409);
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
  readonly #proposer: CoverageBreakerSafeProposer;
  readonly #chain: CoverageBreakerChainSource;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #lastErrorCode: string | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    proposer: CoverageBreakerSafeProposer;
    chain: CoverageBreakerChainSource;
  }) {
    this.#transactions = input.transactions;
    this.#proposer = input.proposer;
    this.#chain = input.chain;
  }

  async pollOnce() {
    let pollErrorCode: string | undefined;
    const proposals = await this.#pendingProposals(10);
    for (const action of proposals) {
      try {
        const proposal = proposalFromRow(action);
        const result = await this.#proposer.propose(proposal);
        await this.#recordProposal(action.action_id, result);
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
    return { proposals: proposals.length, finality: finality.length };
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

  #pendingProposals(limit: number) {
    return this.#transactions.transaction(async (executor) => (
      await executor.query<CoverageBreakerActionRow>(
        `SELECT * FROM core.coverage_breaker_actions
         WHERE state = 'PENDING_PROPOSAL' ORDER BY created_at, action_id LIMIT $1`,
        [limit],
      )
    ).rows);
  }

  #pendingFinality(limit: number) {
    return this.#transactions.transaction(async (executor) => (
      await executor.query<CoverageBreakerActionRow>(
        `SELECT * FROM core.coverage_breaker_actions
         WHERE state IN ('SAFE_PROPOSED','MINED','FINAL')
         ORDER BY CASE WHEN state = 'FINAL' THEN 1 ELSE 0 END, updated_at, action_id LIMIT $1`,
        [limit],
      )
    ).rows);
  }

  #recordProposal(actionId: string, proposal: { safeTxHash: string; proposalHash: string }) {
    if (!isHash(proposal.safeTxHash) || !isHash(proposal.proposalHash)) {
      throw new CoreError('InvalidFinality', 'Coverage-breaker Safe proposal evidence is invalid', 502);
    }
    return this.#transactions.transaction(async (executor) => {
      const action = await lockedAction(executor, actionId);
      if (action.state !== 'PENDING_PROPOSAL') {
        if (action.safe_tx_hash === proposal.safeTxHash.toLowerCase()) return;
        throw new CoreError('IdempotencyConflict', 'Coverage-breaker action changed during Safe proposal', 409);
      }
      const now = new Date();
      await executor.query(
        `UPDATE core.coverage_breaker_actions
         SET state = 'SAFE_PROPOSED', safe_tx_hash = $2, proposal_hash = $3, updated_at = $4
         WHERE action_id = $1`,
        [actionId, proposal.safeTxHash.toLowerCase(), proposal.proposalHash.toLowerCase(), now],
      );
      await appendTransition(executor, action, 'SAFE_PROPOSED', proposal, now);
      await enqueueActionAudit(executor, action, 'CoverageBreakerSafeProposed', 'SYSTEM', {
        safeTxHash: proposal.safeTxHash.toLowerCase(),
        proposalHash: proposal.proposalHash.toLowerCase(),
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

function proposalFromRow(row: CoverageBreakerActionRow): CoverageBreakerSafeProposal {
  return {
    actionId: row.action_id,
    safeAddress: row.governance_safe_address,
    routerAddress: row.router_address,
    calldata: row.calldata,
    calldataHash: row.calldata_hash,
    targetPaused: row.target_paused,
    evidenceHash: row.evidence_hash,
    policyVersion: Number(row.policy_version),
  };
}

function finalityCandidate(row: CoverageBreakerActionRow): CoverageBreakerFinalityCandidate {
  if (!row.safe_tx_hash) throw new CoreError('InvalidFinality', 'Coverage-breaker Safe hash is unavailable', 409);
  return {
    ...proposalFromRow(row),
    safeTxHash: row.safe_tx_hash,
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
    actorWallet: action.governance_safe_address,
    actorRole: 'SAFE',
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
       governance_safe_address, router_address, calldata, calldata_hash,
       state, replaces_action_id, actor_wallet, secondary_signer,
       secondary_signature_hash, approval_nonce, approval_deadline, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_PROPOSAL',$11,$12,$13,$14,$15,$16,$17,$17)
     ON CONFLICT (action_id) DO NOTHING`,
    [
      actionId,
      action.snapshot_id,
      action.policy_version,
      action.action,
      action.target_paused,
      action.evidence_hash,
      action.governance_safe_address,
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
  await appendTransition(executor, { ...replacement, state: 'PENDING_PROPOSAL' }, 'PENDING_PROPOSAL', {
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
    observation.safeTxHash !== action.safe_tx_hash
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
    safeTxHash: input.safeTxHash,
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
  if (!isHash(transaction.hash) || transaction.hash.toLowerCase() !== executionTxHash || !isAddress(transaction.to)) {
    throw new CoreError('InvalidFinality', 'Coverage-breaker transaction is malformed', 409);
  }
  return { hash: executionTxHash, to: getAddress(transaction.to).toLowerCase() };
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
