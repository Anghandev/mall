import { Interface, type FunctionFragment } from 'ethers';
import { CoreError } from '../api/errors.ts';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';

export interface ExecutionRequest {
  chainId: 56;
  to: string;
  data: string;
  value: '0';
  resourceId: string;
  policyVersion: number;
  idempotencyKey: string;
  gasLimit: string;
  amounts: Readonly<Record<string, string>>;
  replacementForTxHash?: string;
}

interface CoordinatedDeploymentManifest {
  artifactVersion: string;
  deploymentAuthorized: boolean;
  chain: { chainId: number };
}

interface ContractDeploymentManifest {
  artifactVersion: string;
  deploymentStatus: string;
  chain: { chainId: number };
  contracts: ReadonlyArray<{ name: string; address: string | null; status: string }>;
}

export interface ExecutorDeploymentPolicy {
  coordinatedManifest: CoordinatedDeploymentManifest;
  contractManifest: ContractDeploymentManifest;
  allowedCalls: Readonly<Record<string, readonly ExecutorCallRule[]>>;
  mutualTls: true;
}

export interface ExecutorCallRule {
  signature: string;
  resourcePath: readonly (string | number)[];
  policyVersionPath: readonly (string | number)[];
  amountPaths: Readonly<Record<string, readonly (string | number)[]>>;
}

interface BoundCall {
  contractInterface: Interface;
  fragment: FunctionFragment;
  rule: ExecutorCallRule;
}

export class RemoteExecutorClient {
  readonly #url: string;
  readonly #token: string;
  readonly #maxGasLimit: bigint;
  readonly #fetch: typeof fetch;
  readonly #allowedCalls: ReadonlyMap<string, ReadonlyMap<string, BoundCall>>;

  constructor(input: {
    url?: string;
    token?: string;
    maxGasLimit: bigint;
    deployment?: ExecutorDeploymentPolicy;
    fetch?: typeof fetch;
  }) {
    if (!input.url || !input.token || !input.deployment) {
      throw new CoreError('ExternalBlocked', 'Remote executor is unavailable', 503);
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new CoreError('ExternalBlocked', 'Remote executor URL is invalid', 503);
    }
    if (url.protocol !== 'https:' || input.deployment.mutualTls !== true) {
      throw new CoreError('ExternalBlocked', 'Remote executor requires HTTPS and mutual TLS', 503);
    }
    this.#url = input.url;
    this.#token = input.token;
    this.#maxGasLimit = input.maxGasLimit;
    this.#fetch = input.fetch ?? fetch;
    this.#allowedCalls = buildCallPolicies(input.deployment);
  }

  async execute(request: ExecutionRequest) {
    if (
      typeof request.to !== 'string' ||
      typeof request.data !== 'string' ||
      typeof request.resourceId !== 'string' ||
      typeof request.idempotencyKey !== 'string' ||
      typeof request.gasLimit !== 'string' ||
      !request.amounts ||
      typeof request.amounts !== 'object' ||
      Array.isArray(request.amounts)
    ) {
      throw new CoreError('InvalidRequest', 'Executor request violates the bounded transaction plan');
    }
    let gasLimit: bigint;
    try {
      gasLimit = BigInt(request.gasLimit);
    } catch {
      throw new CoreError('InvalidRequest', 'Executor request violates the bounded transaction plan');
    }
    const target = request.to.toLowerCase();
    const selector = request.data.slice(0, 10).toLowerCase();
    const boundCall = this.#allowedCalls.get(target)?.get(selector);
    if (
      request.chainId !== 56 ||
      request.value !== '0' ||
      !/^0x[0-9a-fA-F]{40}$/.test(request.to) ||
      !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(request.data) ||
      !boundCall ||
      request.resourceId.trim().length === 0 ||
      request.resourceId.length > 256 ||
      !Number.isSafeInteger(request.policyVersion) ||
      request.policyVersion <= 0 ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(request.idempotencyKey) ||
      gasLimit <= 0n ||
      gasLimit > this.#maxGasLimit ||
      (request.replacementForTxHash !== undefined &&
        (typeof request.replacementForTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(request.replacementForTxHash)))
    ) {
      throw new CoreError('InvalidRequest', 'Executor request violates the bounded transaction plan');
    }
    validateCalldataBindings(boundCall, request);
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Remote executor rejected the request', 503);
    const body = (await response.json()) as { txHash?: string; replacementForTxHash?: string };
    if (!body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      throw new CoreError('InvalidFinality', 'Remote executor returned an invalid transaction hash', 502);
    }
    if ((body.replacementForTxHash ?? undefined) !== (request.replacementForTxHash ?? undefined)) {
      throw new CoreError('InvalidFinality', 'Replacement transaction evidence mismatch', 502);
    }
    return body;
  }
}

function buildCallPolicies(deployment: ExecutorDeploymentPolicy) {
  const { coordinatedManifest, contractManifest, allowedCalls } = deployment;
  if (
    coordinatedManifest.artifactVersion !== CORE_ARTIFACT_VERSION ||
    contractManifest.artifactVersion !== CORE_ARTIFACT_VERSION ||
    coordinatedManifest.deploymentAuthorized !== true ||
    coordinatedManifest.chain.chainId !== 56 ||
    contractManifest.chain.chainId !== 56 ||
    contractManifest.deploymentStatus !== 'DEPLOYED'
  ) {
    throw new CoreError('ExternalBlocked', 'Executor deployment manifest is not authorized', 503);
  }
  const contracts = new Map(contractManifest.contracts.map((contract) => [contract.name, contract]));
  const result = new Map<string, ReadonlyMap<string, BoundCall>>();
  for (const [name, rules] of Object.entries(allowedCalls)) {
    const contract = contracts.get(name);
    if (
      !contract ||
      contract.status !== 'DEPLOYED' ||
      !contract.address ||
      !/^0x[0-9a-fA-F]{40}$/.test(contract.address) ||
      rules.length === 0
    ) {
      throw new CoreError('ExternalBlocked', 'Executor allowlist is incomplete', 503);
    }
    const calls = new Map<string, BoundCall>();
    for (const rule of rules) {
      try {
        const contractInterface = new Interface([`function ${rule.signature}`]);
        const fragment = contractInterface.getFunction(rule.signature);
        if (!fragment || calls.has(fragment.selector.toLowerCase())) throw new Error('invalid call rule');
        calls.set(fragment.selector.toLowerCase(), { contractInterface, fragment, rule });
      } catch {
        throw new CoreError('ExternalBlocked', 'Executor ABI call rule is invalid', 503);
      }
    }
    result.set(contract.address.toLowerCase(), calls);
  }
  if (result.size === 0) throw new CoreError('ExternalBlocked', 'Executor allowlist is empty', 503);
  return result;
}

function validateCalldataBindings(boundCall: BoundCall, request: ExecutionRequest) {
  let decoded;
  try {
    decoded = boundCall.contractInterface.decodeFunctionData(boundCall.fragment, request.data);
    const canonical = boundCall.contractInterface.encodeFunctionData(boundCall.fragment, decoded);
    if (canonical.toLowerCase() !== request.data.toLowerCase()) throw new Error('non-canonical calldata');
  } catch {
    throw new CoreError('InvalidRequest', 'Executor calldata does not match the authorized ABI');
  }
  const resource = readPath(decoded, boundCall.rule.resourcePath);
  const policyVersion = readPath(decoded, boundCall.rule.policyVersionPath);
  const expectedAmountNames = Object.keys(boundCall.rule.amountPaths).sort();
  const actualAmountNames = Object.keys(request.amounts).sort();
  if (
    String(resource).toLowerCase() !== request.resourceId.toLowerCase() ||
    !sameInteger(policyVersion, String(request.policyVersion)) ||
    expectedAmountNames.length !== actualAmountNames.length ||
    expectedAmountNames.some((name, index) => name !== actualAmountNames[index]) ||
    expectedAmountNames.some((name) => !sameInteger(readPath(decoded, boundCall.rule.amountPaths[name]!), request.amounts[name]!))
  ) {
    throw new CoreError('InvalidRequest', 'Executor calldata bindings do not match the bounded transaction plan');
  }
}

function readPath(value: unknown, path: readonly (string | number)[]) {
  let current = value as Record<string | number, unknown> | undefined;
  for (const part of path) {
    if (current === undefined || current === null || typeof current !== 'object') {
      throw new CoreError('InvalidRequest', 'Executor calldata binding path is invalid');
    }
    const next = current[part];
    if (next === undefined) throw new CoreError('InvalidRequest', 'Executor calldata binding path is invalid');
    current = next as Record<string | number, unknown> | undefined;
  }
  return current;
}

function sameInteger(actual: unknown, expected: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(expected)) return false;
  try {
    return BigInt(String(actual)) === BigInt(expected);
  } catch {
    return false;
  }
}
