import { Interface, TypedDataEncoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { BSC_CHAIN_ID, CORE_ARTIFACT_VERSION, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from '../data/audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';
import {
  rollPendingSeckillPrizesIntoSession,
  settleMaturedSeckillPrizes,
} from '../data/seckill-prize-service.ts';
import {
  releaseSeckillPlanInventory,
  type SeckillActionRow,
} from '../data/seckill-operations-service.ts';
import { ZERO_ADDRESS, safeTransactionTypes } from './safe-multisend.ts';

const ROUTER = new Interface([
  'event SeckillSessionOpened(bytes32 indexed sessionId,uint64 indexed policyVersion,uint64 startsAt,uint64 mainDeadline,uint64 relayDeadline)',
  'event SeckillPurchasePauseChanged(bool paused,bytes32 indexed evidenceHash)',
  'function seckillPurchasesPaused() view returns (bool)',
]);
const ERC20 = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const SESSION_OPENED_TOPIC = ROUTER.getEvent('SeckillSessionOpened')!.topicHash.toLowerCase();
const SECKILL_PAUSE_TOPIC = ROUTER.getEvent('SeckillPurchasePauseChanged')!.topicHash.toLowerCase();
const TRANSFER_TOPIC = ERC20.getEvent('Transfer')!.topicHash.toLowerCase();

type ActionKind = SeckillActionRow['action_kind'];
type ActionState = SeckillActionRow['state'];

interface OpenExpectation {
  kind: 'OPEN_SESSION';
  startsAt: number;
  mainDeadline: number;
  relayDeadline: number;
}

interface BreakerExpectation {
  kind: 'FORCE_CLOSE' | 'RESUME_PURCHASES';
  targetPaused: boolean;
}

interface PrizeExpectation {
  kind: 'PRIZE_INJECTION';
  amountUsdt: string;
  operationsSafeAddress: string;
  custodySafeAddress: string;
  tokenAddress: string;
}

type SeckillExpectation = OpenExpectation | BreakerExpectation | PrizeExpectation;

export interface SeckillSafeProposal {
  actionId: string;
  sessionId: string;
  actionKind: ActionKind;
  policyVersion: number;
  evidenceHash: string;
  safeAddress: string;
  targetAddress: string;
  calldata: string;
  calldataHash: string;
  minimumSafeNonce: string;
  expected: SeckillExpectation;
}

export interface SeckillSafeProposer {
  propose(input: SeckillSafeProposal): Promise<{
    safeNonce: string;
    safeTxHash: string;
    proposalHash: string;
  }>;
}

export interface SeckillFinalityCandidate extends SeckillSafeProposal {
  safeTxHash: string;
  priorState: 'SAFE_PROPOSED' | 'MINED' | 'FINAL';
  priorFinality?: { executionTxHash: string; blockNumber: number; blockHash: string };
}

export type SeckillObservation =
  | { state: 'NOT_FOUND' }
  | {
      state: 'MINED' | 'FINAL';
      safeTxHash: string;
      executionTxHash: string;
      blockNumber: number;
      blockHash: string;
      confirmations: number;
      canonical: true;
      actionKind: ActionKind;
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
      actionKind: ActionKind;
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
      actionKind: ActionKind;
      evidenceHash: string;
      observationEvidenceHash: string;
      reasonCode: 'EXECUTION_REVERTED';
    };

type CanonicalSeckillObservation = {
  state: 'MINED' | 'FINAL';
  safeTxHash: string;
  executionTxHash: string;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  canonical: true;
  actionKind: ActionKind;
  evidenceHash: string;
  observationEvidenceHash: string;
};

export interface SeckillChainSource {
  observe(input: SeckillFinalityCandidate): Promise<SeckillObservation>;
}

export class HttpSeckillSafeProposer implements SeckillSafeProposer {
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

  async propose(input: SeckillSafeProposal) {
    if (!this.#url || !this.#token) {
      throw new CoreError('ConfigurationRequired', 'Safe seckill proposal service is not configured', 503);
    }
    const url = secureUrl(this.#url, 'Safe seckill proposal service');
    if (!this.#mutualTls) throw new CoreError('ExternalBlocked', 'Safe seckill proposal transport requires mTLS', 503);
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({
        artifactVersion: CORE_ARTIFACT_VERSION,
        chainId: BSC_CHAIN_ID,
        safeAddress: input.safeAddress,
        to: input.targetAddress,
        value: '0',
        operation: 0,
        data: input.calldata,
        dataHash: input.calldataHash,
        resourceType: 'SECKILL_GOVERNANCE_ACTION',
        resourceId: input.actionId,
        sessionId: input.sessionId,
        actionKind: input.actionKind,
        policyVersion: input.policyVersion,
        evidenceHash: input.evidenceHash,
        minimumSafeNonce: input.minimumSafeNonce,
      }),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Safe seckill proposal was rejected', 503);
    const body = await responseJson(response) as Record<string, unknown>;
    if (
      !isCanonicalSafeNonce(body.safeNonce)
      || BigInt(body.safeNonce) < BigInt(input.minimumSafeNonce)
      || !isHash(body.safeTxHash)
      || !isHash(body.proposalHash)
      || body.dataHash !== input.calldataHash
      || body.resourceId !== input.actionId
      || body.sessionId !== input.sessionId
      || body.actionKind !== input.actionKind
      || Number(body.policyVersion) !== input.policyVersion
      || body.evidenceHash !== input.evidenceHash
      || body.minimumSafeNonce !== input.minimumSafeNonce
    ) throw new CoreError('InvalidFinality', 'Safe seckill proposal response is not echo-bound', 502);
    const safeNonce = body.safeNonce;
    const expectedSafeTxHash = seckillSafeTxHash(input, safeNonce);
    if (body.safeTxHash.toLowerCase() !== expectedSafeTxHash) {
      throw new CoreError('InvalidFinality', 'Safe seckill proposal hash does not match its nonce', 502);
    }
    return {
      safeNonce,
      safeTxHash: expectedSafeTxHash,
      proposalHash: body.proposalHash.toLowerCase(),
    };
  }
}

export class ResilientSeckillChainSource implements SeckillChainSource {
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

  async observe(input: SeckillFinalityCandidate): Promise<SeckillObservation> {
    if (!this.#lookupUrl || !this.#lookupToken || !this.#primaryRpcUrl || !this.#fallbackRpcUrl) {
      throw new CoreError('ConfigurationRequired', 'Seckill finality source is not configured', 503);
    }
    const lookup = await this.#fetch(secureUrl(this.#lookupUrl, 'Seckill execution lookup'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#lookupToken}` },
      body: JSON.stringify({ safeTxHash: input.safeTxHash, resourceId: input.actionId }),
    });
    if (!lookup.ok) throw new CoreError('ExternalBlocked', 'Seckill execution lookup failed', 503);
    const lookupBody = await responseJson(lookup) as Record<string, unknown>;
    if (lookupBody.safeTxHash !== input.safeTxHash || lookupBody.resourceId !== input.actionId) {
      throw new CoreError('InvalidFinality', 'Seckill execution lookup is not Safe-hash-bound', 502);
    }
    if (lookupBody.executionTxHash === null) return { state: 'NOT_FOUND' };
    if (!isHash(lookupBody.executionTxHash)) {
      throw new CoreError('InvalidFinality', 'Seckill execution transaction hash is invalid', 502);
    }
    const executionTxHash = lookupBody.executionTxHash.toLowerCase();
    const primary = secureUrl(this.#primaryRpcUrl, 'primary seckill RPC').toString();
    const fallback = secureUrl(this.#fallbackRpcUrl, 'fallback seckill RPC').toString();
    if (normalizedUrl(primary) === normalizedUrl(fallback)) {
      throw new CoreError('ConfigurationRequired', 'Seckill finality requires two distinct RPC providers', 503);
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
      throw new CoreError('InvalidFinality', 'Seckill finality RPC must be BSC chain 56', 409);
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
        throw new CoreError('InvalidFinality', 'Seckill receipt disappeared from a canonical block', 409);
      }
      return reorged(input, input.priorFinality, canonicalBlockHash);
    }
    if (primaryReceipt === null || fallbackReceipt === null || primaryTx === null || fallbackTx === null) {
      throw new CoreError('InvalidFinality', 'Seckill execution differs across RPC providers', 409);
    }
    const receipt = normalizedReceipt(primaryReceipt, executionTxHash);
    const fallbackReceiptEvidence = normalizedReceipt(fallbackReceipt, executionTxHash);
    const transaction = normalizedTransaction(primaryTx, executionTxHash);
    const fallbackTransaction = normalizedTransaction(fallbackTx, executionTxHash);
    if (stableJson(receipt) !== stableJson(fallbackReceiptEvidence) || stableJson(transaction) !== stableJson(fallbackTransaction)) {
      throw new CoreError('InvalidFinality', 'Seckill execution differs across RPC providers', 409);
    }
    if (transaction.to !== input.safeAddress) {
      throw new CoreError('InvalidFinality', 'Seckill execution did not target the frozen Safe', 409);
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
    const base = {
      safeTxHash: input.safeTxHash,
      executionTxHash,
      blockNumber,
      blockHash: receipt.blockHash,
      confirmations,
      canonical: true as const,
      actionKind: input.actionKind,
      evidenceHash: input.evidenceHash,
    };
    if (receipt.status === '0x0') {
      const failure = { ...base, reasonCode: 'EXECUTION_REVERTED' as const };
      return { state: 'FAILED', ...failure, observationEvidenceHash: hashJson(failure) };
    }
    await this.#validateExpectedEvent(input, receipt, primary, fallback);
    return {
      state: confirmations >= 15 ? 'FINAL' : 'MINED',
      ...base,
      observationEvidenceHash: hashJson({ ...base, expected: input.expected }),
    };
  }

  async #validateExpectedEvent(
    input: SeckillFinalityCandidate,
    receipt: ReturnType<typeof normalizedReceipt>,
    primary: string,
    fallback: string,
  ) {
    if (input.expected.kind === 'OPEN_SESSION') {
      const matching = receipt.logs.filter((log) =>
        log.address === input.targetAddress && log.topics[0] === SESSION_OPENED_TOPIC);
      if (matching.length !== 1) throw new CoreError('InvalidFinality', 'Session open must emit exactly one SeckillSessionOpened', 409);
      const event = decodeSessionOpened(matching[0]!);
      if (
        event.sessionId !== input.sessionId
        || event.policyVersion !== input.policyVersion
        || event.startsAt !== input.expected.startsAt
        || event.mainDeadline !== input.expected.mainDeadline
        || event.relayDeadline !== input.expected.relayDeadline
      ) throw new CoreError('InvalidFinality', 'SeckillSessionOpened does not match the frozen schedule', 409);
      return;
    }
    if (input.expected.kind === 'FORCE_CLOSE' || input.expected.kind === 'RESUME_PURCHASES') {
      const matching = receipt.logs.filter((log) =>
        log.address === input.targetAddress && log.topics[0] === SECKILL_PAUSE_TOPIC);
      if (matching.length !== 1) throw new CoreError('InvalidFinality', 'Breaker action must emit exactly one SeckillPurchasePauseChanged', 409);
      const event = decodeSeckillPause(matching[0]!);
      if (event.paused !== input.expected.targetPaused || event.evidenceHash !== input.evidenceHash) {
        throw new CoreError('InvalidFinality', 'SeckillPurchasePauseChanged does not match the frozen action', 409);
      }
      const calldata = ROUTER.encodeFunctionData('seckillPurchasesPaused');
      const [primaryState, fallbackState] = await Promise.all([
        rpc(this.#fetch, primary, 'eth_call', [{ to: input.targetAddress, data: calldata }, receipt.blockNumber]),
        rpc(this.#fetch, fallback, 'eth_call', [{ to: input.targetAddress, data: calldata }, receipt.blockNumber]),
      ]);
      const primaryPaused = Boolean(ROUTER.decodeFunctionResult('seckillPurchasesPaused', stringValue(primaryState, 'router state'))[0]);
      const fallbackPaused = Boolean(ROUTER.decodeFunctionResult('seckillPurchasesPaused', stringValue(fallbackState, 'router state'))[0]);
      if (primaryPaused !== input.expected.targetPaused || fallbackPaused !== input.expected.targetPaused) {
        throw new CoreError('InvalidFinality', 'Router seckill breaker state does not match the finalized action', 409);
      }
      return;
    }
    if (input.expected.kind !== 'PRIZE_INJECTION') {
      throw new CoreError('InvalidFinality', 'Seckill finality expectation is invalid', 409);
    }
    const expected = input.expected;
    if (input.targetAddress !== expected.tokenAddress || expected.tokenAddress !== USDT_ADDRESS) {
      throw new CoreError('InvalidFinality', 'Prize injection token is not frozen BSC USDT', 409);
    }
    const matching = receipt.logs.filter((log) => log.address === expected.tokenAddress && log.topics[0] === TRANSFER_TOPIC)
      .map(decodeTransfer)
      .filter((event) =>
        event.from === expected.operationsSafeAddress
        && event.to === expected.custodySafeAddress
        && event.value === expected.amountUsdt);
    if (matching.length !== 1) {
      throw new CoreError('InvalidFinality', 'Prize injection must contain exactly one matching USDT Transfer', 409);
    }
  }
}

export class SeckillGovernanceWorker {
  readonly #transactions: SqlTransactionRunner;
  readonly #proposer: SeckillSafeProposer;
  readonly #chain: SeckillChainSource;
  readonly #clock: () => Date;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #lastErrorCode: string | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    proposer: SeckillSafeProposer;
    chain: SeckillChainSource;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#proposer = input.proposer;
    this.#chain = input.chain;
    this.#clock = input.clock ?? (() => new Date());
  }

  async pollOnce() {
    let pollErrorCode: string | undefined;
    const proposals = await this.#pendingProposals(10);
    for (const action of proposals) {
      try {
        const proposal = await this.#proposalFor(action);
        const result = await this.#proposer.propose(proposal);
        await this.#recordProposal(action.action_id, result);
      } catch (error) {
        pollErrorCode ??= errorCode(error);
      }
    }
    const finality = await this.#pendingFinality(25);
    for (const action of finality) {
      try {
        const candidate = await this.#finalityCandidate(action);
        const observation = await this.#chain.observe(candidate);
        if (observation.state !== 'NOT_FOUND') await this.#recordObservation(action.action_id, observation);
      } catch (error) {
        pollErrorCode ??= errorCode(error);
      }
    }
    try {
      await this.#settleMaturedSessionInventory();
    } catch (error) {
      pollErrorCode ??= errorCode(error);
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
      await executor.query<SeckillActionRow>(
        `SELECT * FROM core.seckill_governance_actions
         WHERE state = 'PENDING_PROPOSAL' ORDER BY created_at, action_id LIMIT $1`,
        [limit],
      )
    ).rows);
  }

  #pendingFinality(limit: number) {
    return this.#transactions.transaction(async (executor) => (
      await executor.query<SeckillActionRow>(
        `SELECT * FROM core.seckill_governance_actions
         WHERE state IN ('SAFE_PROPOSED','MINED','FINAL')
         ORDER BY CASE WHEN state = 'FINAL' THEN 1 ELSE 0 END, updated_at, action_id LIMIT $1`,
        [limit],
      )
    ).rows);
  }

  #proposalFor(action: SeckillActionRow) {
    return this.#transactions.transaction(async (executor) => {
      const prior = await executor.query<{ max_safe_nonce: string | null; earlier_pending: boolean }>(
        `SELECT
           (SELECT max(safe_nonce)::text FROM core.seckill_governance_actions
            WHERE governance_safe_address = $1 AND safe_nonce IS NOT NULL) AS max_safe_nonce,
           EXISTS (
             SELECT 1 FROM core.seckill_governance_actions earlier
             WHERE earlier.governance_safe_address = $1 AND earlier.state = 'PENDING_PROPOSAL'
               AND (earlier.created_at, earlier.action_id) < ($2, $3)
           ) AS earlier_pending`,
        [action.governance_safe_address, action.created_at, action.action_id],
      );
      if (prior.rows[0]?.earlier_pending) {
        throw new CoreError('FinalityPending', 'Earlier seckill action is awaiting a Safe nonce', 409);
      }
      const minimumSafeNonce = prior.rows[0]?.max_safe_nonce === null
        ? '0'
        : (BigInt(prior.rows[0]!.max_safe_nonce) + 1n).toString();
      return proposalFromRow(executor, action, minimumSafeNonce);
    });
  }

  #recordProposal(actionId: string, proposal: { safeNonce: string; safeTxHash: string; proposalHash: string }) {
    if (!isCanonicalSafeNonce(proposal.safeNonce) || !isHash(proposal.safeTxHash) || !isHash(proposal.proposalHash)) {
      throw new CoreError('InvalidFinality', 'Seckill Safe proposal evidence is invalid', 502);
    }
    return this.#transactions.transaction(async (executor) => {
      const action = await lockedAction(executor, actionId);
      if (action.state !== 'PENDING_PROPOSAL') {
        if (String(action.safe_nonce) === proposal.safeNonce && action.safe_tx_hash === proposal.safeTxHash.toLowerCase()) return;
        throw new CoreError('IdempotencyConflict', 'Seckill action changed during Safe proposal', 409);
      }
      const prior = await executor.query<{ max_safe_nonce: string | null; earlier_pending: boolean }>(
        `SELECT
           (SELECT max(safe_nonce)::text FROM core.seckill_governance_actions
            WHERE governance_safe_address = $1 AND safe_nonce IS NOT NULL) AS max_safe_nonce,
           EXISTS (
             SELECT 1 FROM core.seckill_governance_actions earlier
             WHERE earlier.governance_safe_address = $1 AND earlier.state = 'PENDING_PROPOSAL'
               AND (earlier.created_at, earlier.action_id) < ($2, $3)
           ) AS earlier_pending`,
        [action.governance_safe_address, action.created_at, action.action_id],
      );
      if (
        prior.rows[0]?.earlier_pending
        || (prior.rows[0]?.max_safe_nonce !== null && BigInt(proposal.safeNonce) <= BigInt(prior.rows[0]!.max_safe_nonce))
      ) throw new CoreError('InvalidFinality', 'Seckill Safe nonce does not preserve action order', 409);
      const frozen = await proposalFromRow(executor, action, proposal.safeNonce);
      if (proposal.safeTxHash.toLowerCase() !== seckillSafeTxHash(frozen, proposal.safeNonce)) {
        throw new CoreError('InvalidFinality', 'Seckill Safe hash does not match the frozen action nonce', 409);
      }
      const now = this.#clock();
      await executor.query(
        `UPDATE core.seckill_governance_actions
         SET state = 'SAFE_PROPOSED', safe_nonce = $2, safe_tx_hash = $3,
           proposal_hash = $4, updated_at = $5 WHERE action_id = $1`,
        [actionId, proposal.safeNonce, proposal.safeTxHash.toLowerCase(), proposal.proposalHash.toLowerCase(), now],
      );
      await appendTransition(executor, action, 'SAFE_PROPOSED', proposal, now);
      await enqueueWorkerAudit(executor, action, 'SeckillSafeProposed', 'SYSTEM', proposal, now);
    });
  }

  #finalityCandidate(action: SeckillActionRow) {
    return this.#transactions.transaction(async (executor) => {
      if (action.safe_nonce === null || !action.safe_tx_hash) {
        throw new CoreError('InvalidFinality', 'Seckill Safe nonce or hash is unavailable', 409);
      }
      return {
        ...await proposalFromRow(executor, action, String(action.safe_nonce)),
        safeTxHash: action.safe_tx_hash,
        priorState: action.state as SeckillFinalityCandidate['priorState'],
        ...(action.execution_tx_hash && action.block_number !== null && action.block_hash
          ? {
              priorFinality: {
                executionTxHash: action.execution_tx_hash,
                blockNumber: Number(action.block_number),
                blockHash: action.block_hash,
              },
            }
          : {}),
      };
    });
  }

  #recordObservation(actionId: string, observation: Exclude<SeckillObservation, { state: 'NOT_FOUND' }>) {
    return this.#transactions.transaction(async (executor) => {
      const action = await lockedAction(executor, actionId);
      validateObservation(action, observation);
      if (
        action.state === 'FINAL'
        && observation.state === 'FINAL'
        && action.execution_tx_hash === observation.executionTxHash
        && Number(action.block_number) === observation.blockNumber
        && action.block_hash === observation.blockHash
      ) {
        await executor.query('UPDATE core.seckill_governance_actions SET updated_at = $2 WHERE action_id = $1', [actionId, this.#clock()]);
        return;
      }
      const now = this.#clock();
      await executor.query(
        `UPDATE core.seckill_governance_actions
         SET state = $2, execution_tx_hash = $3, block_number = $4,
           block_hash = $5, confirmations = $6, canonical = $7, updated_at = $8
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
      await enqueueWorkerAudit(
        executor,
        action,
        `SeckillGovernance${observation.state}`,
        observation.state === 'FINAL' ? 'CHAIN_FINAL' : 'CHAIN_OBSERVED',
        observation,
        now,
      );
      if (observation.state === 'FINAL') await finalizeAction(executor, action, observation, now);
      if (observation.state === 'REORGED') await reverseAction(executor, action, observation, now);
      if (observation.state === 'FAILED' && action.action_kind === 'OPEN_SESSION') {
        await releaseSeckillPlanInventory(executor, action.session_id, now, false);
      }
    });
  }

  #settleMaturedSessionInventory() {
    return this.#transactions.transaction(async (executor) => {
      const now = this.#clock();
      await settleMaturedSeckillPrizes(executor, now);
      const sessions = await executor.query<{ session_id: string }>(
        `SELECT session.session_id
         FROM core.seckill_sessions session
         JOIN core.seckill_session_plans plan ON plan.session_id = session.session_id
         JOIN core.seckill_prize_settlements prize ON prize.session_id = session.session_id
         WHERE plan.inventory_lock_state = 'LOCKED'
           AND NOT EXISTS (
             SELECT 1 FROM core.payment_quotes quote
             WHERE quote.session_id = session.session_id
               AND (
                 quote.state = 'SUBMITTED'
                 OR (quote.state IN ('QUOTED','REORGED') AND quote.deadline > $1)
               )
           )
         ORDER BY session.starts_at, session.session_id
         FOR UPDATE OF session`,
        [now],
      );
      for (const session of sessions.rows) {
        await releaseSeckillPlanInventory(executor, session.session_id, now, true);
      }
    });
  }
}

async function proposalFromRow(executor: SqlExecutor, row: SeckillActionRow, minimumSafeNonce: string): Promise<SeckillSafeProposal> {
  let expected: SeckillExpectation;
  if (row.action_kind === 'OPEN_SESSION') {
    const plan = await executor.query<{ starts_at: Date; main_deadline: Date; relay_deadline: Date }>(
      'SELECT starts_at, main_deadline, relay_deadline FROM core.seckill_session_plans WHERE action_id = $1',
      [row.action_id],
    );
    const value = plan.rows[0];
    if (!value) throw new CoreError('InvalidFinality', 'Seckill session plan is unavailable', 409);
    expected = {
      kind: 'OPEN_SESSION',
      startsAt: Math.floor(value.starts_at.getTime() / 1_000),
      mainDeadline: Math.floor(value.main_deadline.getTime() / 1_000),
      relayDeadline: Math.floor(value.relay_deadline.getTime() / 1_000),
    };
  } else if (row.action_kind === 'FORCE_CLOSE' || row.action_kind === 'RESUME_PURCHASES') {
    expected = { kind: row.action_kind, targetPaused: row.action_kind === 'FORCE_CLOSE' };
  } else {
    const injection = await executor.query<{
      amount_usdt: string;
      operations_safe_address: string;
      custody_safe_address: string;
      token_address: string;
    }>(
      `SELECT amount_usdt::text, operations_safe_address, custody_safe_address, token_address
       FROM core.seckill_prize_injections WHERE action_id = $1`,
      [row.action_id],
    );
    const value = injection.rows[0];
    if (!value) throw new CoreError('InvalidFinality', 'Seckill prize injection is unavailable', 409);
    expected = {
      kind: 'PRIZE_INJECTION',
      amountUsdt: value.amount_usdt,
      operationsSafeAddress: value.operations_safe_address,
      custodySafeAddress: value.custody_safe_address,
      tokenAddress: value.token_address,
    };
  }
  return {
    actionId: row.action_id,
    sessionId: row.session_id,
    actionKind: row.action_kind,
    policyVersion: Number(row.policy_version),
    evidenceHash: row.evidence_hash,
    safeAddress: row.governance_safe_address,
    targetAddress: row.target_address,
    calldata: row.calldata,
    calldataHash: row.calldata_hash,
    minimumSafeNonce,
    expected,
  };
}

async function finalizeAction(
  executor: SqlExecutor,
  action: SeckillActionRow,
  observation: CanonicalSeckillObservation,
  at: Date,
) {
  if (action.action_kind === 'OPEN_SESSION') {
    const plan = await executor.query<{
      session_id: string; policy_version: string | number; merchant_id: string;
      product_id: string; sku_id: string; product_policy_hash: string;
      rules_content_hash: string; starts_at: Date; main_deadline: Date;
      relay_deadline: Date; inventory: string | number; seckill_list_price_usdt: string;
      snapshot: unknown;
    }>('SELECT * FROM core.seckill_session_plans WHERE action_id = $1 FOR UPDATE', [action.action_id]);
    const planRow = plan.rows[0];
    if (!planRow) throw new CoreError('InvalidFinality', 'Final session plan is unavailable', 409);
    await executor.query(
      `INSERT INTO core.seckill_sessions (
         session_id, policy_version, merchant_id, product_id, sku_id,
         product_policy_hash, starts_at, main_deadline, relay_deadline,
         inventory, seckill_list_price_usdt, phase, snapshot,
         governance_action_id, rules_content_hash, publication_tx_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
         CASE WHEN $7::timestamptz > $12::timestamptz THEN 'PREHEAT' ELSE 'LIVE' END,$13,$14,$15,$16)
       ON CONFLICT (session_id) DO NOTHING`,
      [
        planRow.session_id,
        planRow.policy_version,
        planRow.merchant_id,
        planRow.product_id,
        planRow.sku_id,
        planRow.product_policy_hash,
        planRow.starts_at,
        planRow.main_deadline,
        planRow.relay_deadline,
        planRow.inventory,
        planRow.seckill_list_price_usdt,
        at,
        JSON.stringify(planRow.snapshot),
        action.action_id,
        planRow.rules_content_hash,
        observation.executionTxHash,
      ],
    );
    await executor.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload,
         idempotency_key, state
       ) VALUES ($1,'SECKILL_SESSION',$2,'SeckillSessionPublished',$3,$1,'PENDING')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        `outbox:seckill-session:${action.action_id}`,
        action.session_id,
        JSON.stringify({ sessionId: action.session_id, actionId: action.action_id, transactionHash: observation.executionTxHash }),
      ],
    );
    await rollPendingSeckillPrizesIntoSession(executor, action.session_id, at);
    return;
  }
  if (action.action_kind === 'FORCE_CLOSE') {
    await executor.query(
      "UPDATE core.seckill_sessions SET phase = 'FORCE_CLOSED', updated_at = $2 WHERE session_id = $1",
      [action.session_id, at],
    );
    await upsertSeckillBreaker(executor, action, true, at);
    return;
  }
  if (action.action_kind === 'RESUME_PURCHASES') {
    const nonOperational = await executor.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM core.breaker_causes
         WHERE scope = 'SECKILL_PURCHASE' AND active AND cause_type <> 'OPERATIONS'
       ) AS exists`,
    );
    if (nonOperational.rows[0]?.exists) {
      throw new CoreError('BreakerActive', 'A non-operational seckill cause prevents finalized recovery', 409);
    }
    await executor.query(
      `UPDATE core.breaker_causes SET active = false, evidence_hash = $2, updated_at = $3
       WHERE scope = 'SECKILL_PURCHASE' AND cause_type = 'OPERATIONS' AND active
         AND updated_at <= $1`,
      [action.created_at, action.evidence_hash, at],
    );
    await upsertSeckillBreaker(executor, action, false, at);
    return;
  }
  await finalizePrizeInjection(executor, action, observation, at);
}

async function reverseAction(
  executor: SqlExecutor,
  action: SeckillActionRow,
  observation: Extract<SeckillObservation, { state: 'REORGED' }>,
  at: Date,
) {
  if (action.action_kind === 'OPEN_SESSION') {
    await executor.query(
      "UPDATE core.seckill_sessions SET phase = 'FORCE_CLOSED', updated_at = $2 WHERE session_id = $1",
      [action.session_id, at],
    );
    await releaseSeckillPlanInventory(executor, action.session_id, at, true);
    return;
  }
  if (action.action_kind === 'FORCE_CLOSE') {
    await upsertSeckillBreaker(executor, action, true, at, observation.observationEvidenceHash);
    return;
  }
  if (action.action_kind === 'RESUME_PURCHASES') {
    await upsertSeckillBreaker(executor, action, true, at, observation.observationEvidenceHash);
    return;
  }
  await reversePrizeInjection(executor, action, observation, at);
}

async function upsertSeckillBreaker(
  executor: SqlExecutor,
  action: SeckillActionRow,
  paused: boolean,
  at: Date,
  overrideEvidenceHash?: string,
) {
  const evidenceHash = overrideEvidenceHash ?? action.evidence_hash;
  const causeId = `seckill-force-close:${action.session_id}`;
  if (paused) {
    await executor.query(
      `INSERT INTO core.breaker_causes (
         scope, cause_type, cause_id, active, evidence_hash, updated_at
       ) VALUES ('SECKILL_PURCHASE','OPERATIONS',$1,true,$2,$3)
       ON CONFLICT (scope, cause_type, cause_id) DO UPDATE SET active = true,
         evidence_hash = EXCLUDED.evidence_hash, updated_at = EXCLUDED.updated_at`,
      [causeId, evidenceHash, at],
    );
  }
  await executor.query(
    `INSERT INTO core.circuit_breakers (
       scope, paused, evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ('SECKILL_PURCHASE',$1,$2,$3,'SECKILL_GOVERNANCE',$4)
     ON CONFLICT (scope) DO UPDATE SET paused = EXCLUDED.paused,
       evidence_hash = EXCLUDED.evidence_hash, policy_version = EXCLUDED.policy_version,
       changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
    [paused, evidenceHash, action.policy_version, at],
  );
  const eventId = hashJson({ actionId: action.action_id, paused, evidenceHash });
  await executor.query(
    `INSERT INTO core.breaker_events (
       breaker_event_id, scope, action, cause_type, cause_id,
       evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ($1,'SECKILL_PURCHASE',$2,'OPERATIONS',$3,$4,$5,'SECKILL_GOVERNANCE',$6)
     ON CONFLICT (breaker_event_id) DO NOTHING`,
    [eventId, paused ? 'PAUSE' : 'RESUME', causeId, evidenceHash, action.policy_version, at],
  );
}

async function finalizePrizeInjection(
  executor: SqlExecutor,
  action: SeckillActionRow,
  observation: CanonicalSeckillObservation,
  at: Date,
) {
  await requireFullCoverage(executor);
  const injection = await executor.query<{
    amount_usdt: string;
    custody_safe_address: string;
    final_journal_id: string | null;
  }>(
    `SELECT amount_usdt::text, custody_safe_address, final_journal_id
     FROM core.seckill_prize_injections WHERE action_id = $1 FOR UPDATE`,
    [action.action_id],
  );
  const row = injection.rows[0];
  if (!row) throw new CoreError('InvalidFinality', 'Prize injection record is unavailable', 409);
  if (row.final_journal_id) return;
  const safeAccountId = `safe:usdt-custody:${row.custody_safe_address}:usdt`;
  const liabilityAccountId = `seckill-prize:${action.session_id}:usdt`;
  await ensureLedgerAccount(executor, {
    accountId: safeAccountId,
    ownerType: 'SAFE',
    ownerId: row.custody_safe_address,
    purpose: 'SAFE_ASSET',
    safeAddress: row.custody_safe_address,
  });
  await ensureLedgerAccount(executor, {
    accountId: liabilityAccountId,
    ownerType: 'BENEFICIARY',
    ownerId: action.session_id,
    purpose: 'SECKILL_PRIZE_LIABILITY',
    safeAddress: null,
  });
  const journalId = `journal:seckill-prize:${action.action_id}`;
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [
      journalId,
      `seckill-prize:${action.action_id}:final`,
      'SECKILL_PRIZE_INJECTED',
      'SECKILL_SESSION',
      action.session_id,
      null,
      action.policy_version,
      observation.observationEvidenceHash,
      observation.executionTxHash,
      observation.blockHash,
      'CHAIN_EVENT',
      observation.executionTxHash,
      null,
      JSON.stringify({ actionId: action.action_id, sessionId: action.session_id, amountUsdt: row.amount_usdt }),
      JSON.stringify([
        {
          account_id: safeAccountId,
          side: 'DEBIT',
          amount: row.amount_usdt,
          balance_state: 'POSTED',
          backing_safe_address: row.custody_safe_address,
        },
        {
          account_id: liabilityAccountId,
          side: 'CREDIT',
          amount: row.amount_usdt,
          balance_state: 'LOCKED',
          backing_safe_address: row.custody_safe_address,
        },
      ]),
    ],
  );
  await executor.query(
    `UPDATE core.seckill_sessions SET prize_pool_usdt = prize_pool_usdt + $2, updated_at = $3
     WHERE session_id = $1`,
    [action.session_id, row.amount_usdt, at],
  );
  await executor.query(
    `UPDATE core.seckill_prize_injections SET final_journal_id = $2, updated_at = $3
     WHERE action_id = $1`,
    [action.action_id, journalId, at],
  );
}

async function reversePrizeInjection(
  executor: SqlExecutor,
  action: SeckillActionRow,
  observation: Extract<SeckillObservation, { state: 'REORGED' }>,
  at: Date,
) {
  const injection = await executor.query<{
    amount_usdt: string;
    custody_safe_address: string;
    final_journal_id: string | null;
    reversal_journal_id: string | null;
  }>(
    `SELECT amount_usdt::text, custody_safe_address, final_journal_id, reversal_journal_id
     FROM core.seckill_prize_injections WHERE action_id = $1 FOR UPDATE`,
    [action.action_id],
  );
  const row = injection.rows[0];
  if (!row?.final_journal_id || row.reversal_journal_id) return;
  const safeAccountId = `safe:usdt-custody:${row.custody_safe_address}:usdt`;
  const liabilityAccountId = `seckill-prize:${action.session_id}:usdt`;
  const journalId = `journal:seckill-prize-reversal:${action.action_id}`;
  const sourceTxHash = observation.executionTxHash ?? action.execution_tx_hash;
  const sourceBlockHash = observation.blockHash ?? action.block_hash;
  if (!sourceTxHash || !sourceBlockHash) throw new CoreError('InvalidFinality', 'Prize reorg lacks original chain evidence', 409);
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [
      journalId,
      `seckill-prize:${action.action_id}:reorg:${observation.canonicalBlockHash ?? 'unknown'}`,
      'SECKILL_PRIZE_INJECTION_REVERSED',
      'SECKILL_SESSION',
      action.session_id,
      null,
      action.policy_version,
      observation.observationEvidenceHash,
      sourceTxHash,
      sourceBlockHash,
      'CHAIN_EVENT',
      observation.observationEvidenceHash,
      row.final_journal_id,
      JSON.stringify({ actionId: action.action_id, sessionId: action.session_id, amountUsdt: row.amount_usdt }),
      JSON.stringify([
        {
          account_id: liabilityAccountId,
          side: 'DEBIT',
          amount: row.amount_usdt,
          balance_state: 'LOCKED',
          backing_safe_address: row.custody_safe_address,
        },
        {
          account_id: safeAccountId,
          side: 'CREDIT',
          amount: row.amount_usdt,
          balance_state: 'POSTED',
          backing_safe_address: row.custody_safe_address,
        },
      ]),
    ],
  );
  const updated = await executor.query<{ session_id: string }>(
    `UPDATE core.seckill_sessions SET prize_pool_usdt = prize_pool_usdt - $2, updated_at = $3
     WHERE session_id = $1 AND prize_pool_usdt >= $2 RETURNING session_id`,
    [action.session_id, row.amount_usdt, at],
  );
  if (!updated.rows[0]) throw new CoreError('UnknownState', 'Prize pool cannot reverse the reorged injection', 409);
  await executor.query(
    `UPDATE core.seckill_prize_injections SET reversal_journal_id = $2, updated_at = $3
     WHERE action_id = $1`,
    [action.action_id, journalId, at],
  );
}

async function ensureLedgerAccount(
  executor: SqlExecutor,
  input: {
    accountId: string;
    ownerType: 'SAFE' | 'BENEFICIARY';
    ownerId: string;
    purpose: 'SAFE_ASSET' | 'SECKILL_PRIZE_LIABILITY';
    safeAddress: string | null;
  },
) {
  await executor.query(
    `INSERT INTO core.ledger_accounts (
       account_id, owner_type, owner_id, asset, purpose, safe_address
     ) VALUES ($1,$2,$3,'USDT',$4,$5) ON CONFLICT (account_id) DO NOTHING`,
    [input.accountId, input.ownerType, input.ownerId, input.purpose, input.safeAddress],
  );
  const persisted = await executor.query<{
    owner_type: string; owner_id: string; asset: string; purpose: string; safe_address: string | null;
  }>(
    'SELECT owner_type, owner_id, asset, purpose, safe_address FROM core.ledger_accounts WHERE account_id = $1',
    [input.accountId],
  );
  const row = persisted.rows[0];
  if (
    !row
    || row.owner_type !== input.ownerType
    || row.owner_id !== input.ownerId
    || row.asset !== 'USDT'
    || row.purpose !== input.purpose
    || row.safe_address !== input.safeAddress
  ) throw new CoreError('InvalidFinality', 'Prize ledger account identity conflicts with immutable metadata', 409);
}

async function requireFullCoverage(executor: SqlExecutor) {
  const result = await executor.query<{ item_count: string; covered_count: string }>(
    `WITH latest AS (
       SELECT snapshot.snapshot_id
       FROM core.coverage_snapshots snapshot
       WHERE COALESCE((
         SELECT canonical FROM core.coverage_snapshot_canonicality observation
         WHERE observation.snapshot_id = snapshot.snapshot_id
         ORDER BY observed_at DESC, observation_id DESC LIMIT 1
       ), snapshot.canonical)
       ORDER BY snapshot.recorded_at DESC, snapshot.snapshot_id DESC LIMIT 1
     )
     SELECT count(*)::text AS item_count,
       count(*) FILTER (WHERE item.coverage_met)::text AS covered_count
     FROM latest JOIN core.coverage_snapshot_items item USING (snapshot_id)`,
  );
  if (result.rows[0]?.item_count === '0' || result.rows[0]?.item_count !== result.rows[0]?.covered_count) {
    throw new CoreError('BreakerActive', 'Prize injection cannot mask coverage below 100%', 409);
  }
}

export function seckillSafeTxHash(input: SeckillSafeProposal, safeNonce: string) {
  if (!isCanonicalSafeNonce(safeNonce)) throw new CoreError('InvalidFinality', 'Seckill Safe nonce is invalid', 409);
  if (keccak256(input.calldata).toLowerCase() !== input.calldataHash.toLowerCase()) {
    throw new CoreError('InvalidFinality', 'Seckill calldata hash does not match the frozen action', 409);
  }
  return TypedDataEncoder.hash(
    { chainId: BSC_CHAIN_ID, verifyingContract: getAddress(input.safeAddress) },
    safeTransactionTypes,
    {
      to: getAddress(input.targetAddress),
      value: '0',
      data: input.calldata,
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: safeNonce,
    },
  ).toLowerCase();
}

function validateObservation(action: SeckillActionRow, observation: Exclude<SeckillObservation, { state: 'NOT_FOUND' }>) {
  if (
    observation.safeTxHash !== action.safe_tx_hash
    || observation.actionKind !== action.action_kind
    || observation.evidenceHash !== action.evidence_hash
    || !isHash(observation.observationEvidenceHash)
  ) throw new CoreError('InvalidFinality', 'Seckill observation does not match the frozen action', 409);
  if (observation.state === 'FINAL' && observation.confirmations < 15) {
    throw new CoreError('FinalityPending', 'Seckill action has fewer than 15 confirmations', 409);
  }
  if (observation.state === 'MINED' && observation.confirmations >= 15) {
    throw new CoreError('InvalidFinality', 'Seckill action must be FINAL at 15 confirmations', 409);
  }
}

function reorged(
  input: SeckillFinalityCandidate,
  prior: { executionTxHash: string; blockNumber: number; blockHash: string },
  canonicalBlockHash: string,
): SeckillObservation {
  const evidence = {
    safeTxHash: input.safeTxHash,
    executionTxHash: prior.executionTxHash,
    blockNumber: prior.blockNumber,
    blockHash: prior.blockHash,
    canonicalBlockHash,
    confirmations: 0 as const,
    canonical: false as const,
    actionKind: input.actionKind,
    evidenceHash: input.evidenceHash,
  };
  return { state: 'REORGED', ...evidence, observationEvidenceHash: hashJson(evidence) };
}

function decodeSessionOpened(log: { topics: readonly string[]; data: string }) {
  try {
    const event = ROUTER.parseLog({ topics: [...log.topics], data: log.data });
    if (!event || event.name !== 'SeckillSessionOpened') throw new Error('wrong event');
    return {
      sessionId: String(event.args.sessionId).toLowerCase(),
      policyVersion: Number(event.args.policyVersion),
      startsAt: Number(event.args.startsAt),
      mainDeadline: Number(event.args.mainDeadline),
      relayDeadline: Number(event.args.relayDeadline),
    };
  } catch {
    throw new CoreError('InvalidFinality', 'SeckillSessionOpened event cannot be decoded', 409);
  }
}

function decodeSeckillPause(log: { topics: readonly string[]; data: string }) {
  try {
    const event = ROUTER.parseLog({ topics: [...log.topics], data: log.data });
    if (!event || event.name !== 'SeckillPurchasePauseChanged') throw new Error('wrong event');
    return { paused: Boolean(event.args.paused), evidenceHash: String(event.args.evidenceHash).toLowerCase() };
  } catch {
    throw new CoreError('InvalidFinality', 'SeckillPurchasePauseChanged event cannot be decoded', 409);
  }
}

function decodeTransfer(log: { topics: readonly string[]; data: string }) {
  try {
    const event = ERC20.parseLog({ topics: [...log.topics], data: log.data });
    if (!event || event.name !== 'Transfer') throw new Error('wrong event');
    return {
      from: getAddress(String(event.args.from)).toLowerCase(),
      to: getAddress(String(event.args.to)).toLowerCase(),
      value: String(event.args.value),
    };
  } catch {
    throw new CoreError('InvalidFinality', 'USDT Transfer event cannot be decoded', 409);
  }
}

async function lockedAction(executor: SqlExecutor, actionId: string) {
  const result = await executor.query<SeckillActionRow>(
    'SELECT * FROM core.seckill_governance_actions WHERE action_id = $1 FOR UPDATE',
    [actionId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Seckill action was not found', 404);
  return result.rows[0];
}

async function appendTransition(
  executor: SqlExecutor,
  action: SeckillActionRow,
  toState: ActionState,
  evidence: Record<string, unknown>,
  at: Date,
) {
  const transitionId = hashJson({ actionId: action.action_id, fromState: action.state, toState, evidence });
  await executor.query(
    `INSERT INTO core.seckill_governance_transitions (
       transition_id, action_id, from_state, to_state, evidence, recorded_at
     ) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (transition_id) DO NOTHING`,
    [transitionId, action.action_id, action.state, toState, JSON.stringify(evidence), at],
  );
}

async function enqueueWorkerAudit(
  executor: SqlExecutor,
  action: SeckillActionRow,
  eventType: string,
  evidenceProfile: 'SYSTEM' | 'CHAIN_OBSERVED' | 'CHAIN_FINAL',
  evidence: Record<string, unknown>,
  at: Date,
) {
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:seckill-governance-worker', { actionId: action.action_id, eventType, evidence }),
    streamName: 'governance',
    evidenceProfile,
    eventType,
    resourceType: 'SECKILL_GOVERNANCE_ACTION',
    resourceId: action.action_id,
    actorWallet: action.governance_safe_address,
    actorRole: 'SAFE',
    correlationId: action.action_id,
    requestHash: action.calldata_hash.slice(2),
    payload: {
      actionKind: action.action_kind,
      sessionId: action.session_id,
      evidenceHash: action.evidence_hash,
      ...evidence,
    },
    ...(evidenceProfile === 'SYSTEM'
      ? {}
      : {
          transactionEvidence: {
            txHash: String(evidence.executionTxHash),
            chainId: 56 as const,
            contractAddress: action.target_address,
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

function isCanonicalSafeNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) < (1n << 256n);
  } catch {
    return false;
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
    throw new CoreError('InvalidFinality', 'Seckill canonical block differs across RPC providers', 409);
  }
  return primaryHash.toLowerCase();
}

function normalizedReceipt(value: unknown, executionTxHash: string) {
  const receipt = recordValue(value, 'seckill receipt');
  if (
    !isHash(receipt.transactionHash)
    || receipt.transactionHash.toLowerCase() !== executionTxHash
    || !isHash(receipt.blockHash)
    || !isHexQuantity(receipt.blockNumber)
    || !['0x0', '0x1'].includes(String(receipt.status))
    || !Array.isArray(receipt.logs)
  ) throw new CoreError('InvalidFinality', 'Seckill receipt is malformed', 409);
  return {
    transactionHash: executionTxHash,
    blockNumber: String(receipt.blockNumber).toLowerCase(),
    blockHash: receipt.blockHash.toLowerCase(),
    status: String(receipt.status).toLowerCase(),
    logs: receipt.logs.map((item) => {
      const log = recordValue(item, 'seckill log');
      if (!isAddress(log.address) || !Array.isArray(log.topics) || log.topics.some((topic) => !isHash(topic))) {
        throw new CoreError('InvalidFinality', 'Seckill log is malformed', 409);
      }
      if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(log.data)) {
        throw new CoreError('InvalidFinality', 'Seckill log data is malformed', 409);
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
  const transaction = recordValue(value, 'seckill transaction');
  if (!isHash(transaction.hash) || transaction.hash.toLowerCase() !== executionTxHash || !isAddress(transaction.to)) {
    throw new CoreError('InvalidFinality', 'Seckill transaction is malformed', 409);
  }
  return { hash: executionTxHash, to: getAddress(transaction.to).toLowerCase() };
}

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new CoreError('ExternalBlocked', `Seckill RPC ${method} failed`, 503);
  const body = await responseJson(response) as Record<string, unknown>;
  if (body.error || !Object.prototype.hasOwnProperty.call(body, 'result')) {
    throw new CoreError('ExternalBlocked', `Seckill RPC ${method} returned an error`, 503);
  }
  return body.result;
}

function fetchWithDeadline(fetchImpl: typeof fetch, timeoutMs = 10_000): typeof fetch {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new CoreError('InvalidRequest', 'Seckill request timeout is invalid', 500);
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new CoreError('ExternalBlocked', 'Seckill external request timed out', 503);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }) as typeof fetch;
}

function secureUrl(value: string, name: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new CoreError('ExternalBlocked', `${name} requires HTTPS`, 503);
  return url;
}

function normalizedUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

async function responseJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new CoreError('InvalidFinality', 'Seckill external response is not JSON', 502);
  }
}

function recordValue(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string) {
  if (typeof value !== 'string') throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  return value;
}

function hexNumber(value: unknown, name: string) {
  if (!isHexQuantity(value)) throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  return number;
}

function isHexQuantity(value: unknown): value is string {
  return typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function errorCode(error: unknown) {
  return error instanceof CoreError ? error.code : 'SeckillGovernanceUnavailable';
}
