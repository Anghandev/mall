import { Interface, JsonRpcProvider, getAddress, id, keccak256 } from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { PolicyService } from '../data/policy-service.ts';

export interface PolicyExecutionRequest {
  draftId: string;
  policyVersion: number;
  governanceWallet: string;
  policyRegistryAddress: string;
  calldata: string;
  calldataHash: string;
  policyHash: string;
  operationsHash: string;
  gasLimit: string;
}

export interface PolicyExecutionResult {
  executionTxHash: string;
  executorWallet: string;
  executorNonce: string;
  executionEvidenceHash: string;
}

export interface PolicyEoaExecutor {
  execute(input: PolicyExecutionRequest): Promise<PolicyExecutionResult>;
}

export type PolicyChainObservation =
  | { state: 'NOT_FOUND' }
  | {
      state: 'MINED' | 'FINAL';
      executionTxHash: string;
      blockNumber: number;
      blockHash: string;
      confirmations: number;
      canonical: true;
      policyVersion: number;
      policyHash: string;
      operationsHash: string;
      decisionEvidenceHash: string;
      governanceExecutor: string;
    }
  | {
      state: 'REORGED';
      executionTxHash: string;
      blockNumber?: number;
      blockHash?: string;
      canonicalBlockHash?: string;
      confirmations: number;
      canonical: false;
      policyVersion: number;
      policyHash: string;
      operationsHash: string;
      decisionEvidenceHash: string;
      governanceExecutor: string;
    };

export interface PolicyFinalityCandidate {
  draftId: string;
  policyVersion: number;
  executionTxHash: string;
  policyRegistryAddress: string;
  executionCalldata: string;
  executionCalldataHash: string;
  policyHash: string;
  operationsHash: string;
  decisionEvidenceHash: string;
  governanceWallet: string;
  priorState: 'SUBMITTED' | 'FINALITY_PENDING' | 'REORGED' | 'PUBLISHED';
  priorFinality?: {
    executionTxHash: string;
    blockNumber: number;
    blockHash: string;
  };
}

export interface PolicyChainSource {
  observe(input: PolicyFinalityCandidate): Promise<PolicyChainObservation>;
}

export class HttpPolicyEoaExecutor implements PolicyEoaExecutor {
  readonly #url: string;
  readonly #token: string;
  readonly #maxGasLimit: bigint;
  readonly #fetch: typeof fetch;

  constructor(input: {
    url?: string;
    token?: string;
    maxGasLimit: bigint;
    fetchImpl?: typeof fetch;
  }) {
    this.#url = secureExecutorUrl(input.url, 'policy EOA executor');
    if (!input.token) throw new CoreError('ConfigurationRequired', 'Policy EOA executor token is unavailable', 503);
    this.#token = input.token;
    this.#maxGasLimit = input.maxGasLimit;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async execute(input: PolicyExecutionRequest) {
    validateExecutionRequest(input, this.#maxGasLimit);
    const requestDigest = policyExecutionRequestDigest(input);
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({
        artifactVersion: CORE_ARTIFACT_VERSION,
        chainId: 56,
        resourceType: 'POLICY',
        resourceId: input.draftId,
        from: input.governanceWallet,
        to: input.policyRegistryAddress,
        value: '0',
        data: input.calldata,
        dataHash: input.calldataHash,
        gasLimit: input.gasLimit,
        policyVersion: input.policyVersion,
        policyHash: input.policyHash,
        operationsHash: input.operationsHash,
        requestDigest,
      }),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Policy EOA executor rejected the request', 503);
    const body = await response.json() as Record<string, unknown>;
    if (
      !isHash(body.executionTxHash)
      || !isAddress(body.executorWallet)
      || !isNonce(body.executorNonce)
      || !isHash(body.executionEvidenceHash)
      || body.requestDigest !== requestDigest
      || body.dataHash !== input.calldataHash
      || body.resourceId !== input.draftId
    ) throw new CoreError('InvalidFinality', 'Policy EOA executor response is not request-bound', 502);
    if (address(body.executorWallet, 'policy executor wallet') !== address(input.governanceWallet, 'governance wallet')) {
      throw new CoreError('InvalidFinality', 'Policy was submitted by the wrong EOA', 502);
    }
    return {
      executionTxHash: body.executionTxHash.toLowerCase(),
      executorWallet: address(body.executorWallet, 'policy executor wallet'),
      executorNonce: body.executorNonce,
      executionEvidenceHash: body.executionEvidenceHash.toLowerCase(),
    };
  }
}

export function policyExecutionRequestDigest(input: PolicyExecutionRequest) {
  return keccak256(new TextEncoder().encode(JSON.stringify({
    artifactVersion: CORE_ARTIFACT_VERSION,
    chainId: 56,
    ...input,
  }))).toLowerCase();
}

export class ResilientPolicyChainSource implements PolicyChainSource {
  readonly #providers: readonly JsonRpcProvider[];

  constructor(input: { primaryRpcUrl?: string; fallbackRpcUrl?: string }) {
    if (!input.primaryRpcUrl || !input.fallbackRpcUrl) {
      throw new CoreError('ConfigurationRequired', 'Policy finality RPC is unavailable', 503);
    }
    const urls = [input.primaryRpcUrl, input.fallbackRpcUrl].map(policyRpcUrl);
    if (urls[0] === urls[1]) throw new CoreError('ConfigurationRequired', 'Policy finality requires two RPCs', 503);
    this.#providers = urls.map((url) => new JsonRpcProvider(url, 56, { staticNetwork: true }));
  }

  async observe(input: PolicyFinalityCandidate): Promise<PolicyChainObservation> {
    const observations = await Promise.all(this.#providers.map((provider) => observe(provider, input)));
    if (observations.every((item) => item === undefined)) {
      if (input.priorState !== 'PUBLISHED' || !input.priorFinality) return { state: 'NOT_FOUND' };
      const blocks = await Promise.all(this.#providers.map((provider) => provider.getBlock(input.priorFinality!.blockNumber)));
      const hashes = blocks.map((block) => block?.hash?.toLowerCase());
      if (!hashes[0] || hashes[0] !== hashes[1]) {
        throw new CoreError('InvalidFinality', 'Policy RPCs disagree on canonical block', 409);
      }
      if (hashes[0] === input.priorFinality.blockHash.toLowerCase()) {
        throw new CoreError('InvalidFinality', 'Policy receipt disappeared from a canonical block', 409);
      }
      return reorged(input, input.priorFinality.blockNumber, input.priorFinality.blockHash, hashes[0]);
    }
    if (observations.some((item) => item === undefined)) {
      throw new CoreError('InvalidFinality', 'Policy RPCs disagree on receipt availability', 409);
    }
    const [primary, fallback] = observations as [ObservedPolicy, ObservedPolicy];
    const primaryComparable = comparable(primary);
    const fallbackComparable = comparable(fallback);
    if (JSON.stringify(primaryComparable) !== JSON.stringify(fallbackComparable)) {
      throw new CoreError('InvalidFinality', 'Policy RPCs disagree on execution evidence', 409);
    }
    const confirmations = Math.min(primary.confirmations, fallback.confirmations);
    if (!primary.canonical) {
      return reorged(input, primary.blockNumber, primary.blockHash, primary.canonicalBlockHash);
    }
    return {
      state: confirmations >= 15 ? 'FINAL' : 'MINED',
      executionTxHash: input.executionTxHash,
      blockNumber: primary.blockNumber,
      blockHash: primary.blockHash,
      confirmations,
      canonical: true,
      ...primary.decoded,
    };
  }
}

interface ObservedPolicy {
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  canonical: boolean;
  canonicalBlockHash: string;
  decoded: ReturnType<typeof decodePolicyPublishedLog>;
}

async function observe(provider: JsonRpcProvider, input: PolicyFinalityCandidate): Promise<ObservedPolicy | undefined> {
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) throw new CoreError('InvalidFinality', 'Policy RPC is not BSC 56', 409);
  const [transaction, receipt, head] = await Promise.all([
    provider.getTransaction(input.executionTxHash),
    provider.getTransactionReceipt(input.executionTxHash),
    provider.getBlockNumber(),
  ]);
  if (!receipt) return undefined;
  if (!transaction?.to || receipt.status !== 1) {
    throw new CoreError('InvalidFinality', 'Policy execution reverted or is incomplete', 409);
  }
  if (
    address(transaction.from, 'policy sender') !== address(input.governanceWallet, 'governance wallet')
    || address(transaction.to, 'policy target') !== address(input.policyRegistryAddress, 'policy registry')
    || transaction.data.toLowerCase() !== input.executionCalldata.toLowerCase()
    || keccak256(transaction.data).toLowerCase() !== input.executionCalldataHash.toLowerCase()
  ) throw new CoreError('InvalidFinality', 'Policy transaction drifted from its frozen execution', 409);
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block?.hash) throw new CoreError('InvalidFinality', 'Policy block is unavailable', 409);
  const matching = receipt.logs.filter((log) =>
    log.address.toLowerCase() === input.policyRegistryAddress.toLowerCase()
    && log.topics[0]?.toLowerCase() === POLICY_PUBLISHED_TOPIC);
  if (matching.length !== 1) throw new CoreError('InvalidFinality', 'PolicyPublished event is missing or duplicated', 409);
  const decoded = decodePolicyPublishedLog({ topics: matching[0]!.topics, data: matching[0]!.data });
  if (
    decoded.policyVersion !== input.policyVersion
    || decoded.policyHash !== input.policyHash.toLowerCase()
    || decoded.operationsHash !== input.operationsHash.toLowerCase()
    || decoded.decisionEvidenceHash !== input.decisionEvidenceHash.toLowerCase()
    || decoded.governanceExecutor !== input.governanceWallet.toLowerCase()
  ) throw new CoreError('InvalidFinality', 'PolicyPublished event does not match the frozen policy', 409);
  return {
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    confirmations: Math.max(0, head - receipt.blockNumber + 1),
    canonical: block.hash.toLowerCase() === receipt.blockHash.toLowerCase(),
    canonicalBlockHash: block.hash.toLowerCase(),
    decoded,
  };
}

function reorged(
  input: PolicyFinalityCandidate,
  blockNumber: number,
  blockHash: string,
  canonicalBlockHash: string,
): Exclude<PolicyChainObservation, { state: 'NOT_FOUND' | 'MINED' | 'FINAL' }> {
  return {
    state: 'REORGED',
    executionTxHash: input.executionTxHash,
    blockNumber,
    blockHash: blockHash.toLowerCase(),
    canonicalBlockHash: canonicalBlockHash.toLowerCase(),
    confirmations: 0,
    canonical: false,
    policyVersion: input.policyVersion,
    policyHash: input.policyHash,
    operationsHash: input.operationsHash,
    decisionEvidenceHash: input.decisionEvidenceHash,
    governanceExecutor: input.governanceWallet,
  };
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

export const POLICY_PUBLISHED_TOPIC = id(
  'PolicyPublished(uint64,bytes32,bytes32,bytes32,address)',
).toLowerCase();

export function decodePolicyPublishedLog(log: { topics: readonly string[]; data: string }) {
  const iface = new Interface([
    'event PolicyPublished(uint64 indexed version,bytes32 indexed policyHash,bytes32 indexed operationsHash,bytes32 decisionEvidenceHash,address governanceExecutor)',
  ]);
  try {
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed || parsed.name !== 'PolicyPublished') throw new Error('wrong event');
    return {
      policyVersion: Number(parsed.args.version),
      policyHash: String(parsed.args.policyHash).toLowerCase(),
      operationsHash: String(parsed.args.operationsHash).toLowerCase(),
      decisionEvidenceHash: String(parsed.args.decisionEvidenceHash).toLowerCase(),
      governanceExecutor: String(parsed.args.governanceExecutor).toLowerCase(),
    };
  } catch {
    throw new CoreError('InvalidFinality', 'PolicyPublished event is malformed', 409);
  }
}

export function policyCalldataHash(calldata: string) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(calldata)) throw new CoreError('InvalidRequest', 'Policy calldata is invalid');
  return keccak256(calldata).toLowerCase();
}

function validateExecutionRequest(input: PolicyExecutionRequest, maxGasLimit: bigint) {
  if (
    !input.draftId
    || !Number.isSafeInteger(input.policyVersion)
    || input.policyVersion < 1
    || !isAddress(input.governanceWallet)
    || !isAddress(input.policyRegistryAddress)
    || !/^0x(?:[0-9a-fA-F]{2})+$/.test(input.calldata)
    || policyCalldataHash(input.calldata) !== input.calldataHash.toLowerCase()
    || !isHash(input.policyHash)
    || !isHash(input.operationsHash)
    || !/^[1-9][0-9]*$/.test(input.gasLimit)
    || BigInt(input.gasLimit) > maxGasLimit
  ) throw new CoreError('InvalidRequest', 'Policy EOA execution request is invalid');
}

function secureExecutorUrl(value: string | undefined, name: string) {
  if (!value) throw new CoreError('ConfigurationRequired', `${name} URL is unavailable`, 503);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoreError('ConfigurationRequired', `${name} URL is invalid`, 503);
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new CoreError('ExternalBlocked', `${name} requires HTTPS outside loopback`, 503);
  }
  return url.toString();
}

function policyRpcUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoreError('ConfigurationRequired', 'Policy RPC URL is invalid', 503);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CoreError('ConfigurationRequired', 'Policy RPC requires credential-free HTTPS URL', 503);
  }
  return url.toString();
}

function comparable(value: ObservedPolicy) {
  const { confirmations: _confirmations, ...rest } = value;
  return rest;
}

function address(value: unknown, name: string) {
  try {
    return getAddress(String(value)).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function errorCode(error: unknown) {
  return error instanceof CoreError ? error.code : 'UnknownState';
}
