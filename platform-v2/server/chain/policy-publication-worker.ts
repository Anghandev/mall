import { Interface, id, keccak256 } from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { PolicyService } from '../data/policy-service.ts';

export interface PolicySafeProposal {
  draftId: string;
  policyVersion: number;
  safeAddress: string;
  policyRegistryAddress: string;
  calldata: string;
  calldataHash: string;
  policyHash: string;
  operationsHash: string;
}

export interface PolicySafeProposalResult {
  safeTxHash: string;
  proposalHash: string;
}

export interface PolicySafeProposer {
  propose(input: PolicySafeProposal): Promise<PolicySafeProposalResult>;
}

export type PolicyChainObservation =
  | { state: 'NOT_FOUND' }
  | {
      state: 'MINED' | 'FINAL';
      safeTxHash: string;
      executionTxHash: string;
      blockNumber: number;
      blockHash: string;
      confirmations: number;
      canonical: true;
      policyVersion: number;
      policyHash: string;
      operationsHash: string;
      decisionEvidenceHash: string;
      safeExecutor: string;
    }
  | {
      state: 'REORGED';
      safeTxHash: string;
      executionTxHash?: string;
      blockNumber?: number;
      blockHash?: string;
      canonicalBlockHash?: string;
      confirmations: number;
      canonical: false;
      policyVersion: number;
      policyHash: string;
      operationsHash: string;
      decisionEvidenceHash: string;
      safeExecutor: string;
    };

export interface PolicyFinalityCandidate {
  draftId: string;
  policyVersion: number;
  safeTxHash: string;
  policyRegistryAddress: string;
  policyHash: string;
  operationsHash: string;
  decisionEvidenceHash: string;
  safeAddress: string;
  priorState: 'SAFE_PROPOSED' | 'FINALITY_PENDING' | 'REORGED' | 'PUBLISHED';
  priorFinality?: {
    executionTxHash: string;
    blockNumber: number;
    blockHash: string;
  };
}

export interface PolicyChainSource {
  observe(input: PolicyFinalityCandidate): Promise<PolicyChainObservation>;
}

export class HttpRpcPolicyChainSource implements PolicyChainSource {
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
  }) {
    this.#lookupUrl = input.lookupUrl;
    this.#lookupToken = input.lookupToken;
    this.#primaryRpcUrl = input.primaryRpcUrl;
    this.#fallbackRpcUrl = input.fallbackRpcUrl;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async observe(input: PolicyFinalityCandidate): Promise<PolicyChainObservation> {
    if (!this.#lookupUrl || !this.#lookupToken || !this.#primaryRpcUrl || !this.#fallbackRpcUrl) {
      throw new CoreError('ConfigurationRequired', 'Policy finality source is not configured', 503);
    }
    const lookupUrl = new URL(this.#lookupUrl);
    if (lookupUrl.protocol !== 'https:') throw new CoreError('ExternalBlocked', 'Policy execution lookup requires HTTPS', 503);
    const lookup = await this.#fetch(lookupUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#lookupToken}` },
      body: JSON.stringify({ safeTxHash: input.safeTxHash, resourceId: input.draftId }),
    });
    if (!lookup.ok) throw new CoreError('ExternalBlocked', 'Policy execution lookup failed', 503);
    const lookupBody = await lookup.json() as Record<string, unknown>;
    if (lookupBody.safeTxHash !== input.safeTxHash || lookupBody.resourceId !== input.draftId) {
      throw new CoreError('InvalidFinality', 'Policy execution lookup is not Safe-hash-bound', 502);
    }
    if (lookupBody.executionTxHash === null) return { state: 'NOT_FOUND' };
    if (!isHash(lookupBody.executionTxHash)) throw new CoreError('InvalidFinality', 'Policy execution transaction hash is invalid', 502);
    const executionTxHash = lookupBody.executionTxHash.toLowerCase();
    assertFetchRpcUrl(this.#primaryRpcUrl, 'primary policy RPC');
    assertFetchRpcUrl(this.#fallbackRpcUrl, 'fallback policy RPC');
    if (normalizedUrl(this.#primaryRpcUrl) === normalizedUrl(this.#fallbackRpcUrl)) {
      throw new CoreError('ConfigurationRequired', 'Policy finality requires two distinct RPC providers', 503);
    }
    const [primaryChainId, fallbackChainId, primaryReceipt, fallbackReceipt, primaryHead, fallbackHead] = await Promise.all([
      rpc(this.#fetch, this.#primaryRpcUrl, 'eth_chainId', []),
      rpc(this.#fetch, this.#fallbackRpcUrl, 'eth_chainId', []),
      rpc(this.#fetch, this.#primaryRpcUrl, 'eth_getTransactionReceipt', [executionTxHash]),
      rpc(this.#fetch, this.#fallbackRpcUrl, 'eth_getTransactionReceipt', [executionTxHash]),
      rpc(this.#fetch, this.#primaryRpcUrl, 'eth_blockNumber', []),
      rpc(this.#fetch, this.#fallbackRpcUrl, 'eth_blockNumber', []),
    ]);
    if (hexNumber(primaryChainId, 'primary chain id') !== 56 || hexNumber(fallbackChainId, 'fallback chain id') !== 56) {
      throw new CoreError('InvalidFinality', 'Policy finality RPC must be BSC chain 56', 409);
    }
    if (primaryReceipt === null && fallbackReceipt === null) {
      if (input.priorState !== 'PUBLISHED' || !input.priorFinality) return { state: 'NOT_FOUND' };
      const blockTag = `0x${input.priorFinality.blockNumber.toString(16)}`;
      const [primaryBlock, fallbackBlock] = await Promise.all([
        rpc(this.#fetch, this.#primaryRpcUrl, 'eth_getBlockByNumber', [blockTag, false]),
        rpc(this.#fetch, this.#fallbackRpcUrl, 'eth_getBlockByNumber', [blockTag, false]),
      ]);
      const canonicalBlockHash = agreedCanonicalBlockHash(primaryBlock, fallbackBlock);
      if (canonicalBlockHash === input.priorFinality.blockHash.toLowerCase()) {
        throw new CoreError('InvalidFinality', 'Policy receipt disappeared while its block remains canonical', 409);
      }
      return reorgedObservation(
        input,
        input.priorFinality.executionTxHash,
        input.priorFinality.blockNumber,
        input.priorFinality.blockHash,
        canonicalBlockHash,
      );
    }
    if (primaryReceipt === null || fallbackReceipt === null) {
      throw new CoreError('InvalidFinality', 'Policy receipt differs across RPC providers', 409);
    }
    const primaryEvidence = normalizedReceipt(primaryReceipt, 'primary policy receipt', executionTxHash);
    const fallbackEvidence = normalizedReceipt(fallbackReceipt, 'fallback policy receipt', executionTxHash);
    if (JSON.stringify(primaryEvidence) !== JSON.stringify(fallbackEvidence)) {
      throw new CoreError('InvalidFinality', 'Policy receipt differs across RPC providers', 409);
    }
    const receipt = primaryEvidence;
    const blockNumber = Number(BigInt(receipt.blockNumber));
    const [primaryBlock, fallbackBlock] = await Promise.all([
      rpc(this.#fetch, this.#primaryRpcUrl, 'eth_getBlockByNumber', [receipt.blockNumber, false]),
      rpc(this.#fetch, this.#fallbackRpcUrl, 'eth_getBlockByNumber', [receipt.blockNumber, false]),
    ]);
    const canonicalBlockHash = agreedCanonicalBlockHash(primaryBlock, fallbackBlock);
    if (canonicalBlockHash !== receipt.blockHash) {
      return reorgedObservation(input, executionTxHash, blockNumber, receipt.blockHash, canonicalBlockHash);
    }
    const head = Math.min(hexNumber(primaryHead, 'primary head'), hexNumber(fallbackHead, 'fallback head'));
    const confirmations = Math.max(0, head - blockNumber + 1);
    const matchingLogs = receipt.logs.filter((log) =>
      log.address === input.policyRegistryAddress.toLowerCase()
        && log.topics[0] === POLICY_PUBLISHED_TOPIC);
    if (matchingLogs.length !== 1) throw new CoreError('InvalidFinality', 'Policy execution must emit exactly one PolicyPublished event', 409);
    const log = matchingLogs[0]!;
    const decoded = decodePolicyPublishedLog({
      topics: log.topics,
      data: log.data,
    });
    if (
      decoded.policyVersion !== input.policyVersion
      || decoded.policyHash !== input.policyHash.toLowerCase()
      || decoded.operationsHash !== input.operationsHash.toLowerCase()
      || decoded.decisionEvidenceHash !== input.decisionEvidenceHash.toLowerCase()
      || decoded.safeExecutor !== input.safeAddress.toLowerCase()
    ) throw new CoreError('InvalidFinality', 'PolicyPublished event does not match the frozen proposal', 409);
    return {
      state: confirmations >= 15 ? 'FINAL' : 'MINED',
      safeTxHash: input.safeTxHash,
      executionTxHash,
      blockNumber,
      blockHash: receipt.blockHash,
      confirmations,
      canonical: true,
      ...decoded,
    };
  }
}

export class HttpPolicySafeProposer implements PolicySafeProposer {
  readonly #url: string | undefined;
  readonly #token: string | undefined;
  readonly #mutualTls: boolean;
  readonly #fetch: typeof fetch;

  constructor(input: { url?: string; token?: string; mutualTls?: boolean; fetchImpl?: typeof fetch }) {
    this.#url = input.url;
    this.#token = input.token;
    this.#mutualTls = input.mutualTls === true;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async propose(input: PolicySafeProposal) {
    if (!this.#url || !this.#token) {
      throw new CoreError('ConfigurationRequired', 'Safe policy proposal service is not configured', 503);
    }
    const url = new URL(this.#url);
    if (url.protocol !== 'https:' || !this.#mutualTls) {
      throw new CoreError('ExternalBlocked', 'Safe policy proposal transport requires HTTPS and mTLS', 503);
    }
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({
        artifactVersion: CORE_ARTIFACT_VERSION,
        chainId: 56,
        safeAddress: input.safeAddress,
        to: input.policyRegistryAddress,
        value: '0',
        operation: 0,
        data: input.calldata,
        dataHash: input.calldataHash,
        resourceId: input.draftId,
        policyVersion: input.policyVersion,
        policyHash: input.policyHash,
        operationsHash: input.operationsHash,
      }),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Safe policy proposal service rejected the request', 503);
    const body = await response.json() as Record<string, unknown>;
    if (
      !isHash(body.safeTxHash)
      || !isHash(body.proposalHash)
      || body.dataHash !== input.calldataHash
      || body.resourceId !== input.draftId
      || Number(body.policyVersion) !== input.policyVersion
    ) throw new CoreError('InvalidFinality', 'Safe policy proposal response is not echo-bound', 502);
    return { safeTxHash: body.safeTxHash.toLowerCase(), proposalHash: body.proposalHash.toLowerCase() };
  }
}

export class PolicyFinalityWorker {
  readonly #service: PolicyService;
  readonly #source: PolicyChainSource;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #lastErrorCode: string | undefined;

  constructor(input: { service: PolicyService; source: PolicyChainSource }) {
    this.#service = input.service;
    this.#source = input.source;
  }

  async pollOnce() {
    const pending = await this.#service.pendingFinality(25);
    for (const item of pending) {
      try {
        const observation = await this.#source.observe(item);
        if (observation.state !== 'NOT_FOUND') await this.#service.recordObservation(item.draftId, observation);
        this.#lastErrorCode = undefined;
      } catch (error) {
        this.#lastErrorCode = errorCode(error);
      }
    }
    return pending.length;
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
}

export const POLICY_PUBLISHED_TOPIC = id('PolicyPublished(uint64,bytes32,bytes32,bytes32,address)').toLowerCase();

export function decodePolicyPublishedLog(log: { topics: readonly string[]; data: string }) {
  const iface = new Interface([
    'event PolicyPublished(uint64 indexed version,bytes32 indexed policyHash,bytes32 indexed operationsHash,bytes32 decisionEvidenceHash,address safeExecutor)',
  ]);
  try {
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed || parsed.name !== 'PolicyPublished') throw new Error('wrong event');
    return {
      policyVersion: Number(parsed.args.version),
      policyHash: String(parsed.args.policyHash).toLowerCase(),
      operationsHash: String(parsed.args.operationsHash).toLowerCase(),
      decisionEvidenceHash: String(parsed.args.decisionEvidenceHash).toLowerCase(),
      safeExecutor: String(parsed.args.safeExecutor).toLowerCase(),
    };
  } catch {
    throw new CoreError('InvalidFinality', 'PolicyPublished event cannot be decoded', 409);
  }
}

export function policyCalldataHash(calldata: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(calldata)) throw new CoreError('InvalidRequest', 'Invalid policy calldata');
  return keccak256(calldata).toLowerCase();
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function reorgedObservation(
  input: PolicyFinalityCandidate,
  executionTxHash?: string,
  blockNumber?: number,
  blockHash?: string,
  canonicalBlockHash?: string,
): PolicyChainObservation {
  return {
    state: 'REORGED',
    safeTxHash: input.safeTxHash,
    ...(executionTxHash ? { executionTxHash } : {}),
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(blockHash ? { blockHash } : {}),
    ...(canonicalBlockHash ? { canonicalBlockHash } : {}),
    confirmations: 0,
    canonical: false,
    policyVersion: input.policyVersion,
    policyHash: input.policyHash,
    operationsHash: input.operationsHash,
    decisionEvidenceHash: input.decisionEvidenceHash,
    safeExecutor: input.safeAddress,
  };
}

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new CoreError('ExternalBlocked', 'Policy RPC request failed', 503);
  const body = await response.json() as Record<string, unknown>;
  if (body.error !== undefined || !Object.hasOwn(body, 'result')) throw new CoreError('ExternalBlocked', 'Policy RPC returned an error', 503);
  return body.result;
}

function record(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  return value as Record<string, unknown>;
}

function isHexInteger(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

function hexNumber(value: unknown, name: string) {
  if (!isHexInteger(value)) throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  const result = Number(BigInt(value));
  if (!Number.isSafeInteger(result)) throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  return result;
}

function normalizedReceipt(value: unknown, name: string, expectedTransactionHash: string) {
  const receipt = record(value, name);
  if (
    receipt.status !== '0x1'
    || !isHash(receipt.transactionHash)
    || receipt.transactionHash.toLowerCase() !== expectedTransactionHash
    || !isHash(receipt.blockHash)
    || !isHexInteger(receipt.blockNumber)
    || !Array.isArray(receipt.logs)
  ) throw new CoreError('InvalidFinality', `${name} is unsuccessful or malformed`, 409);
  return Object.freeze({
    transactionHash: receipt.transactionHash.toLowerCase(),
    status: '0x1' as const,
    blockHash: receipt.blockHash.toLowerCase(),
    blockNumber: receipt.blockNumber.toLowerCase(),
    logs: receipt.logs.map((value, index) => {
      const log = record(value, `${name} log ${index}`);
      if (
        typeof log.address !== 'string'
        || !/^0x[0-9a-fA-F]{40}$/.test(log.address)
        || !Array.isArray(log.topics)
        || !log.topics.every(isHash)
        || typeof log.data !== 'string'
        || !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)
      ) throw new CoreError('InvalidFinality', `${name} log is malformed`, 409);
      return Object.freeze({
        address: log.address.toLowerCase(),
        topics: log.topics.map((topic) => topic.toLowerCase()),
        data: log.data.toLowerCase(),
      });
    }),
  });
}

function agreedCanonicalBlockHash(primary: unknown, fallback: unknown) {
  const primaryHash = record(primary, 'primary policy block').hash;
  const fallbackHash = record(fallback, 'fallback policy block').hash;
  if (!isHash(primaryHash) || !isHash(fallbackHash)) {
    throw new CoreError('InvalidFinality', 'Policy canonical block response is malformed', 409);
  }
  if (primaryHash.toLowerCase() !== fallbackHash.toLowerCase()) {
    throw new CoreError('InvalidFinality', 'Policy canonical block differs across RPC providers', 409);
  }
  return primaryHash.toLowerCase();
}

function assertFetchRpcUrl(value: string, name: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CoreError('ConfigurationRequired', `${name} must use HTTP or HTTPS`, 503);
  }
}

function normalizedUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

function errorCode(error: unknown) {
  if (error instanceof CoreError) return error.code;
  return 'PolicyFinalityUnavailable';
}
