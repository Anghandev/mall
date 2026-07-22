import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type TransactionRequest,
} from 'ethers';
import abiBundle from '../../../packages/core-artifacts/contracts/abi-bundle.json' with { type: 'json' };
import contractManifest from '../../../packages/core-artifacts/contracts/contract-manifest.json' with { type: 'json' };
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import {
  verifySettlementExecutionAuthorization,
  type SettlementExecutionAuthorization,
} from '../api/settlement-signing.ts';
import { coverageBreakerExecutionRequestDigest } from '../chain/coverage-breaker-governance.ts';
import { policyExecutionRequestDigest } from '../chain/policy-publication-worker.ts';
import {
  seckillExecutionRequestDigest,
  seckillNonceObservationEvidenceHash,
} from '../chain/seckill-governance.ts';

const host = process.env.HOST ?? '127.0.0.1';
const port = positiveNumber(process.env.PORT ?? '8790', 'PORT');
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('EOA runtime must bind loopback only');

const primaryRpcUrl = required('BSC_RPC_URL');
const fallbackRpcUrl = required('BSC_FALLBACK_RPC_URL');
if (normalizedUrl(primaryRpcUrl) === normalizedUrl(fallbackRpcUrl)) {
  throw new Error('EOA runtime requires two independent BSC RPC endpoints');
}
const provider = new JsonRpcProvider(primaryRpcUrl, 56, { staticNetwork: true });
const fallbackProvider = new JsonRpcProvider(fallbackRpcUrl, 56, { staticNetwork: true });
const governance = wallet('PLATFORM_TECH_PRIVATE_KEY', 'PLATFORM_GOVERNANCE_WALLET_ADDRESS');
const usdtSettlement = wallet('WALLET_2_PRIVATE_KEY', 'USDT_SETTLEMENT_WALLET_ADDRESS');
const nplReward = wallet('WALLET_3_PRIVATE_KEY', 'NPL_REWARD_WALLET_ADDRESS');
const operations = wallet('WALLET_4_PRIVATE_KEY', 'OPERATIONS_GUARANTEE_WALLET_ADDRESS');
const settlementWallets = new Map([
  [usdtSettlement.address.toLowerCase(), { wallet: usdtSettlement, tokenAddress: USDT_ADDRESS }],
  [nplReward.address.toLowerCase(), { wallet: nplReward, tokenAddress: NPL_ADDRESS }],
  [operations.address.toLowerCase(), { wallet: operations, tokenAddress: USDT_ADDRESS }],
]);
const signerToken = required('SIGNER_SERVICE_TOKEN');
const settlementToken = required('SETTLEMENT_EXECUTOR_TOKEN');
const governanceToken = required('GOVERNANCE_EXECUTOR_TOKEN');
const maxGasLimit = BigInt(required('EXECUTOR_MAX_GAS_LIMIT'));
const stateFile = process.env.EXECUTION_STATE_FILE ?? '/var/lib/abu24k/eoa-runtime-state.json';
const transferInterface = new Interface(['function transfer(address recipient,uint256 amount) returns (bool)']);
const contractInterfaces = new Map(Object.entries(abiBundle.contracts).map(([name, abi]) => [name, new Interface(abi)]));
const manifestContracts = new Map(contractManifest.contracts.map((entry) => [entry.name, entry.address?.toLowerCase()]));

type StoredRecord = { requestHash: string; response: Record<string, unknown>; rawTransaction?: string };
type RuntimeErrorCode =
  | 'CHAIN_MISMATCH'
  | 'SIGNATURE_MISMATCH'
  | 'AUTHORIZATION_MISMATCH'
  | 'ROLE_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CALLDATA_MISMATCH'
  | 'NONCE_MISMATCH'
  | 'RECONCILIATION_MISSING'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ENVELOPE';

class RuntimeRequestError extends Error {
  readonly runtimeCode: RuntimeErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(runtimeCode: RuntimeErrorCode, message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RuntimeRequestError';
    this.runtimeCode = runtimeCode;
    this.status = status;
    this.details = Object.freeze({ ...details });
  }
}

let state = await loadState(stateFile);
let queue = Promise.resolve();

const server = createServer((request, response) => {
  void route(request, response).catch((error) => sendRuntimeError(response, error));
});

server.listen(port, host, () => console.log(`24K商城 EOA runtime listening on ${host}:${port}`));
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());

async function route(request: IncomingMessage, response: ServerResponse) {
  if (request.url === '/sign' && request.method === 'GET') {
    authorize(request, signerToken);
    return send(response, 200, { status: 'READY', signer: governance.address.toLowerCase() });
  }
  if (request.url === '/sign' && request.method === 'POST') {
    authorize(request, signerToken);
    return send(response, 200, await sign(await body(request)));
  }
  if (request.url === '/settlement' && request.method === 'POST') {
    authorize(request, settlementToken);
    return serialized(response, async () => settle(await body(request)));
  }
  if (request.url === '/governance' && request.method === 'POST') {
    authorize(request, governanceToken);
    return serialized(response, async () => govern(await body(request)));
  }
  send(response, 404, { error: 'NOT_FOUND' });
}

async function serialized(response: ServerResponse, operation: () => Promise<Record<string, unknown>>) {
  const run = queue.then(operation, operation);
  queue = run.then(() => undefined, () => undefined);
  send(response, 200, await run);
}

async function sign(input: Record<string, unknown>) {
  const purpose = text(input.purpose, 'purpose');
  const digest = hash(input.digest, 'digest');
  const resourceId = text(input.resourceId, 'resourceId');
  const deadline = positiveNumber(input.deadline, 'deadline');
  const idempotencyKey = identifier(input.idempotencyKey, 'idempotencyKey');
  if (!['ORDER_QUOTE', 'PRODUCT_CONCESSION_PREVIEW', 'FINALITY', 'SENSITIVE_ACTION'].includes(purpose)) {
    throw new Error('unsupported signer purpose');
  }
  if (deadline <= Math.floor(Date.now() / 1000)) throw new Error('expired signer request');
  const requestHash = hashJson({ purpose, digest, resourceId, policyVersion: input.policyVersion, deadline, idempotencyKey });
  const existing = state[`sign:${idempotencyKey}`];
  if (existing) return replay(existing, requestHash);
  const result = { signature: governance.signingKey.sign(digest).serialized };
  await record(`sign:${idempotencyKey}`, requestHash, result);
  return result;
}

async function settle(input: Record<string, unknown>) {
  if (Number(input.chainId) !== 56) throw new RuntimeRequestError('CHAIN_MISMATCH', 'wrong chain');
  let transferId: string;
  let executorWallet: string;
  let executorNonce: bigint;
  let tokenAddress: string;
  let requestId: string;
  let requestItemIndex: number;
  let orderId: string;
  let accountId: string;
  let backingWalletAddress: string;
  let recipientAddress: string;
  let amount: bigint;
  let transferCalldata: string;
  let requestDigest: string;
  let gasLimit: bigint;
  let idempotencyKey: string;
  let reconciliationOnly: boolean;
  let authorization: SettlementExecutionAuthorization;
  try {
    transferId = hash(input.transferId, 'transferId');
    executorWallet = address(input.executorWallet, 'executorWallet');
    executorNonce = integer(input.executorNonce, 'executorNonce');
    tokenAddress = address(input.tokenAddress, 'tokenAddress');
    requestId = hash(input.requestId, 'requestId');
    requestItemIndex = nonNegativeNumber(input.requestItemIndex, 'requestItemIndex');
    orderId = hash(input.orderId, 'orderId');
    accountId = text(input.accountId, 'accountId');
    backingWalletAddress = address(input.backingWalletAddress, 'backingWalletAddress');
    recipientAddress = address(input.recipientAddress, 'recipientAddress');
    amount = positiveInteger(input.amount, 'amount');
    transferCalldata = bytes(input.transferCalldata, 'transferCalldata');
    requestDigest = hash(input.requestDigest, 'requestDigest');
    gasLimit = boundedGas(input.gasLimit);
    idempotencyKey = identifier(input.idempotencyKey, 'idempotencyKey');
    reconciliationOnly = input.reconciliationOnly === true;
    if (input.reconciliationOnly !== undefined && !reconciliationOnly) {
      throw new Error('invalid reconciliation mode');
    }
    authorization = object(input.authorization, 'authorization') as unknown as SettlementExecutionAuthorization;
  } catch {
    throw new RuntimeRequestError('INVALID_ENVELOPE', 'settlement envelope is invalid');
  }
  const role = settlementWallets.get(executorWallet);
  if (!role || role.tokenAddress !== tokenAddress) throw new RuntimeRequestError('ROLE_MISMATCH', 'settlement role mismatch');
  try {
    verifySettlementExecutionAuthorization(authorization, {
      requestId,
      requestItemIndex,
      orderId,
      accountId,
      backingWalletAddress,
      executorWallet,
      tokenAddress,
      recipientAddress,
      amount: amount.toString(),
    });
  } catch {
    throw new RuntimeRequestError('AUTHORIZATION_MISMATCH', 'settlement authorization mismatch');
  }
  let decoded: ReturnType<typeof transferInterface.decodeFunctionData>;
  try {
    decoded = transferInterface.decodeFunctionData('transfer', transferCalldata);
  } catch {
    throw new RuntimeRequestError('CALLDATA_MISMATCH', 'settlement calldata mismatch');
  }
  if (address(decoded[0], 'calldata recipient') !== recipientAddress) {
    throw new RuntimeRequestError('CALLDATA_MISMATCH', 'settlement calldata recipient mismatch');
  }
  if (BigInt(decoded[1]) !== amount) {
    throw new RuntimeRequestError('AMOUNT_MISMATCH', 'settlement calldata amount mismatch');
  }
  if (
    transferInterface.encodeFunctionData('transfer', decoded).toLowerCase() !== transferCalldata
  ) throw new RuntimeRequestError('CALLDATA_MISMATCH', 'settlement calldata mismatch');
  const canonicalInput = { ...input };
  delete canonicalInput.reconciliationOnly;
  const requestHash = hashJson(canonicalInput);
  const existing = state[`settlement:${idempotencyKey}`];
  if (existing) {
    return reconciliationOnly
      ? replay(existing, requestHash)
      : replayBroadcast(existing, requestHash);
  }
  if (reconciliationOnly) {
    throw new RuntimeRequestError(
      'RECONCILIATION_MISSING',
      'settlement reconciliation has no persisted transaction',
      409,
      { stateRecordPresent: false, idempotencyKey },
    );
  }
  const replacementHash = optionalHash(input.replacementForExecutionTxHash);
  if (replacementHash) {
    try {
      await assertReplacement(replacementHash, role.wallet.address, tokenAddress, transferCalldata, executorNonce);
    } catch {
      throw new RuntimeRequestError('CALLDATA_MISMATCH', 'replacement transaction mismatch');
    }
  }
  const pendingNonce = await dualPendingNonce(role.wallet.address);
  if (!replacementHash && BigInt(pendingNonce) !== executorNonce) {
    throw new RuntimeRequestError('NONCE_MISMATCH', 'settlement nonce drift');
  }
  const signed = await signTransaction(role.wallet, await transactionRequest({
    to: tokenAddress,
    data: transferCalldata,
    gasLimit,
    nonce: Number(executorNonce),
  }, replacementHash));
  const result = {
    executionTxHash: signed.hash,
    executorWallet,
    executorNonce: executorNonce.toString(),
    requestDigest,
    ...(replacementHash ? { replacementForExecutionTxHash: replacementHash } : {}),
  };
  await record(`settlement:${idempotencyKey}`, requestHash, result, signed.rawTransaction);
  await broadcast(signed.rawTransaction, signed.hash);
  return result;
}

async function govern(input: Record<string, unknown>) {
  if (input.operation === 'PENDING_NONCE') return governancePendingNonce(input);
  const requestDigest = hash(input.requestDigest, 'requestDigest');
  const reconciliationOnly = input.reconciliationOnly === true;
  if (input.reconciliationOnly !== undefined && !reconciliationOnly) {
    throw new RuntimeRequestError('INVALID_ENVELOPE', 'governance reconciliation mode is invalid');
  }
  const requestHash = governanceRequestHash(input);
  const existing = state[`governance:${requestDigest}`];
  if (existing) return replayBroadcast(existing, requestHash);
  if (input.artifactVersion !== CORE_ARTIFACT_VERSION || Number(input.chainId) !== 56 || input.value !== '0') {
    throw new RuntimeRequestError('INVALID_ENVELOPE', 'governance envelope mismatch');
  }
  const from = address(input.from, 'from');
  const to = address(input.to, 'to');
  const data = bytes(input.data, 'data');
  const dataHash = hash(input.dataHash, 'dataHash');
  const resourceId = text(input.resourceId, 'resourceId');
  const resourceType = text(input.resourceType, 'resourceType');
  const gasLimit = boundedGas(input.gasLimit);
  if (keccak256(data).toLowerCase() !== dataHash) {
    throw new Error('governance identity mismatch');
  }
  if (!['POLICY', 'COVERAGE_BREAKER', 'SECKILL_GOVERNANCE_ACTION'].includes(resourceType)) {
    throw new Error('governance resource type is not allowed');
  }
  let executor: Wallet;
  try {
    executor = validateGovernanceRequest(input, {
      from, to, data, dataHash, requestDigest, resourceId, resourceType, gasLimit,
    });
  } catch (error) {
    if (error instanceof RuntimeRequestError) throw error;
    throw new RuntimeRequestError(
      'INVALID_ENVELOPE',
      error instanceof Error ? error.message : 'governance request is invalid',
    );
  }
  const pendingNonce = await dualPendingNonce(executor.address);
  const minimumNonce = input.minimumExecutorNonce === undefined ? 0n : integer(input.minimumExecutorNonce, 'minimumExecutorNonce');
  if (resourceType === 'SECKILL_GOVERNANCE_ACTION' && reconciliationOnly) {
    const relation = BigInt(pendingNonce) < minimumNonce
      ? 'UNSIGNED_UNBROADCAST'
      : BigInt(pendingNonce) > minimumNonce
        ? 'NONCE_CONSUMED_UNKNOWN'
        : 'STATE_RECORD_MISSING';
    throw new RuntimeRequestError(
      'NONCE_MISMATCH',
      'governance reconciliation has no persisted transaction to replay',
      409,
      {
        relation,
        stateRecordPresent: false,
        executorWallet: executor.address.toLowerCase(),
        reservedNonce: minimumNonce.toString(),
        primaryPendingNonce: String(pendingNonce),
        fallbackPendingNonce: String(pendingNonce),
      },
    );
  }
  if (resourceType === 'SECKILL_GOVERNANCE_ACTION' && BigInt(pendingNonce) !== minimumNonce) {
    const relation = BigInt(pendingNonce) < minimumNonce
      ? 'UNSIGNED_UNBROADCAST'
      : 'NONCE_CONSUMED_UNKNOWN';
    throw new RuntimeRequestError(
      'NONCE_MISMATCH',
      'governance nonce does not match the reserved execution nonce',
      409,
      {
        relation,
        stateRecordPresent: false,
        executorWallet: executor.address.toLowerCase(),
        reservedNonce: minimumNonce.toString(),
        primaryPendingNonce: String(pendingNonce),
        fallbackPendingNonce: String(pendingNonce),
      },
    );
  }
  if (resourceType !== 'SECKILL_GOVERNANCE_ACTION' && BigInt(pendingNonce) < minimumNonce) {
    throw new RuntimeRequestError('NONCE_MISMATCH', 'governance nonce is below the approved minimum', 409);
  }
  const signed = await signTransaction(executor, { to, data, value: 0n, gasLimit, nonce: pendingNonce });
  const executionEvidenceHash = hashJson({ requestDigest, transactionHash: signed.hash, executorNonce: pendingNonce });
  const result = {
    ...input,
    executionTxHash: signed.hash,
    submittedTxHash: signed.hash,
    executorWallet: executor.address.toLowerCase(),
    executorNonce: String(pendingNonce),
    executionEvidenceHash,
    resourceId,
    dataHash,
    requestDigest,
  };
  await record(`governance:${requestDigest}`, requestHash, result, signed.rawTransaction);
  await broadcast(signed.rawTransaction, signed.hash);
  return result;
}

async function governancePendingNonce(input: Record<string, unknown>) {
  if (input.artifactVersion !== CORE_ARTIFACT_VERSION || Number(input.chainId) !== 56) {
    throw new Error('governance nonce envelope mismatch');
  }
  const governanceWallet = address(input.governanceWallet, 'governanceWallet');
  if (![governance.address.toLowerCase(), operations.address.toLowerCase()].includes(governanceWallet)) {
    throw new Error('governance nonce wallet is not allowed');
  }
  const executorNonce = String(await dualPendingNonce(governanceWallet));
  return {
    executorWallet: governanceWallet,
    executorNonce,
    evidenceHash: seckillNonceObservationEvidenceHash(governanceWallet, executorNonce),
  };
}

async function transactionRequest(
  input: { to: string; data: string; gasLimit: bigint; nonce: number },
  replacementHash: string | undefined,
): Promise<TransactionRequest> {
  if (!replacementHash) return { ...input, value: 0n };
  const previous = await provider.getTransaction(replacementHash);
  const fee = await provider.getFeeData();
  const priorGasPrice = previous?.gasPrice ?? 0n;
  const gasPrice = [priorGasPrice * 1125n / 1000n, fee.gasPrice ?? 0n, 50_000_000n]
    .reduce((left, right) => left > right ? left : right);
  return { ...input, value: 0n, gasPrice };
}

function validateGovernanceRequest(
  input: Record<string, unknown>,
  parsed: {
    from: string;
    to: string;
    data: string;
    dataHash: string;
    requestDigest: string;
    resourceId: string;
    resourceType: string;
    gasLimit: bigint;
  },
) {
  const minimumExecutorNonce = integer(input.minimumExecutorNonce ?? '0', 'minimumExecutorNonce').toString();
  if (parsed.resourceType === 'POLICY') {
    if (parsed.from !== governance.address.toLowerCase() || manifestContracts.get('PolicyRegistryV2') !== parsed.to) {
      throw new Error('policy governance target mismatch');
    }
    canonicalCall(requiredInterface('PolicyRegistryV2'), 'publishPolicy', parsed.data);
    const digest = policyExecutionRequestDigest({
      draftId: parsed.resourceId,
      policyVersion: positiveNumber(input.policyVersion, 'policyVersion'),
      governanceWallet: parsed.from,
      policyRegistryAddress: parsed.to,
      calldata: parsed.data,
      calldataHash: parsed.dataHash,
      policyHash: hash(input.policyHash, 'policyHash'),
      operationsHash: hash(input.operationsHash, 'operationsHash'),
      gasLimit: parsed.gasLimit.toString(),
    });
    if (digest !== parsed.requestDigest) throw new Error('policy request digest mismatch');
    return governance;
  }
  if (parsed.resourceType === 'COVERAGE_BREAKER') {
    if (parsed.from !== governance.address.toLowerCase() || manifestContracts.get('PaymentRouterV2') !== parsed.to) {
      throw new Error('coverage governance target mismatch');
    }
    const targetPaused = boolean(input.targetPaused, 'targetPaused');
    const evidenceHash = hash(input.evidenceHash, 'evidenceHash');
    const decoded = canonicalCall(requiredInterface('PaymentRouterV2'), 'setNewPaymentsPaused', parsed.data);
    if (decoded[0] !== targetPaused || String(decoded[1]).toLowerCase() !== evidenceHash) {
      throw new Error('coverage governance calldata mismatch');
    }
    const digest = coverageBreakerExecutionRequestDigest({
      actionId: parsed.resourceId,
      governanceWallet: parsed.from,
      routerAddress: parsed.to,
      calldata: parsed.data,
      calldataHash: parsed.dataHash,
      targetPaused,
      evidenceHash,
      policyVersion: positiveNumber(input.policyVersion, 'policyVersion'),
      gasLimit: parsed.gasLimit.toString(),
      minimumExecutorNonce,
    });
    if (digest !== parsed.requestDigest) throw new Error('coverage request digest mismatch');
    return governance;
  }

  const sessionId = hash(input.sessionId, 'sessionId');
  const actionKind = seckillActionKind(input.actionKind);
  const evidenceHash = hash(input.evidenceHash, 'evidenceHash');
  const expected = seckillExpectation(actionKind, input.expected);
  const policyVersion = positiveNumber(input.policyVersion, 'policyVersion');
  const execution: Parameters<typeof seckillExecutionRequestDigest>[0] = {
    artifactVersion: text(input.artifactVersion, 'artifactVersion'),
    actionId: parsed.resourceId,
    sessionId,
    actionKind,
    policyVersion,
    evidenceHash,
    governanceWallet: parsed.from,
    targetAddress: parsed.to,
    calldata: parsed.data,
    calldataHash: parsed.dataHash,
    gasLimit: parsed.gasLimit.toString(),
    minimumExecutorNonce,
    expected,
  };
  if (seckillExecutionRequestDigest(execution) !== parsed.requestDigest) {
    throw new Error('seckill request digest mismatch');
  }

  if (actionKind === 'PRIZE_INJECTION') {
    if (
      parsed.from !== operations.address.toLowerCase()
      || parsed.to !== USDT_ADDRESS
      || expected.kind !== 'PRIZE_INJECTION'
      || address(expected.operationsWalletAddress, 'expected operations wallet') !== parsed.from
      || address(expected.settlementWalletAddress, 'expected settlement wallet') !== usdtSettlement.address.toLowerCase()
      || address(expected.tokenAddress, 'expected token') !== USDT_ADDRESS
    ) throw new Error('prize injection target mismatch');
    const amount = positiveInteger(expected.amountUsdt, 'expected prize amount');
    const decoded = canonicalCall(transferInterface, 'transfer', parsed.data);
    if (address(decoded[0], 'prize recipient') !== usdtSettlement.address.toLowerCase() || BigInt(decoded[1]) !== amount) {
      throw new Error('prize injection calldata mismatch');
    }
    return operations;
  }

  if (parsed.from !== governance.address.toLowerCase() || manifestContracts.get('PaymentRouterV2') !== parsed.to) {
    throw new Error('seckill governance target mismatch');
  }
  if (actionKind === 'OPEN_SESSION') {
    if (expected.kind !== 'OPEN_SESSION') throw new Error('seckill opening expectation mismatch');
    const decoded = canonicalCall(requiredInterface('PaymentRouterV2'), 'openSeckillSession', parsed.data);
    if (
      String(decoded[0]).toLowerCase() !== sessionId
      || BigInt(decoded[1]) !== BigInt(policyVersion)
      || Number(decoded[2]) !== expected.startsAt
      || expected.mainDeadline !== expected.startsAt + 3_600
      || expected.relayDeadline !== expected.startsAt + 60
    ) {
      throw new Error('seckill opening calldata mismatch');
    }
  } else {
    const targetPaused = actionKind === 'FORCE_CLOSE';
    if (expected.kind !== actionKind || expected.targetPaused !== targetPaused) {
      throw new Error('seckill breaker expectation mismatch');
    }
    const decoded = canonicalCall(requiredInterface('PaymentRouterV2'), 'setSeckillPurchasesPaused', parsed.data);
    if (decoded[0] !== targetPaused || String(decoded[1]).toLowerCase() !== evidenceHash) {
      throw new Error('seckill breaker calldata mismatch');
    }
  }
  return governance;
}

function requiredInterface(name: string) {
  const value = contractInterfaces.get(name);
  if (!value) throw new Error(`${name} frozen ABI is unavailable`);
  return value;
}

function canonicalCall(contract: Interface, functionName: string, data: string) {
  const fragment = contract.getFunction(functionName);
  if (!fragment || data.slice(0, 10) !== fragment.selector.toLowerCase()) {
    throw new Error('governance selector is not allowed');
  }
  const decoded = contract.decodeFunctionData(fragment, data);
  if (contract.encodeFunctionData(fragment, decoded).toLowerCase() !== data) {
    throw new Error('governance calldata is not canonical');
  }
  return decoded;
}

function seckillExpectation(actionKind: string, value: unknown) {
  const input = object(value, 'expected');
  if (actionKind === 'OPEN_SESSION') return {
    kind: 'OPEN_SESSION' as const,
    startsAt: positiveNumber(input.startsAt, 'expected startsAt'),
    mainDeadline: positiveNumber(input.mainDeadline, 'expected mainDeadline'),
    relayDeadline: positiveNumber(input.relayDeadline, 'expected relayDeadline'),
  };
  if (actionKind === 'FORCE_CLOSE') return {
    kind: 'FORCE_CLOSE' as const,
    targetPaused: boolean(input.targetPaused, 'expected targetPaused'),
  };
  if (actionKind === 'RESUME_PURCHASES') return {
    kind: 'RESUME_PURCHASES' as const,
    targetPaused: boolean(input.targetPaused, 'expected targetPaused'),
  };
  if (actionKind === 'PRIZE_INJECTION') return {
    kind: 'PRIZE_INJECTION' as const,
    amountUsdt: positiveInteger(input.amountUsdt, 'expected prize amount').toString(),
    operationsWalletAddress: address(input.operationsWalletAddress, 'expected operations wallet'),
    settlementWalletAddress: address(input.settlementWalletAddress, 'expected settlement wallet'),
    tokenAddress: address(input.tokenAddress, 'expected token'),
  };
  throw new Error('seckill expectation is not allowed');
}

function seckillActionKind(value: unknown) {
  const actionKind = text(value, 'actionKind');
  if (
    actionKind !== 'OPEN_SESSION'
    && actionKind !== 'FORCE_CLOSE'
    && actionKind !== 'RESUME_PURCHASES'
    && actionKind !== 'PRIZE_INJECTION'
  ) throw new Error('seckill action kind is not allowed');
  return actionKind;
}

async function signTransaction(signer: Wallet, request: TransactionRequest) {
  const populated = await signer.populateTransaction(request);
  delete populated.from;
  const rawTransaction = await signer.signTransaction(populated);
  return { rawTransaction, hash: keccak256(rawTransaction).toLowerCase() };
}

async function broadcast(rawTransaction: string, expectedHash: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(rawTransaction) || keccak256(rawTransaction).toLowerCase() !== expectedHash) {
    throw new Error('stored transaction hash mismatch');
  }
  try {
    const transaction = await provider.broadcastTransaction(rawTransaction);
    if (transaction.hash.toLowerCase() !== expectedHash) throw new Error('broadcast transaction hash mismatch');
  } catch (error) {
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(expectedHash).catch(() => null),
      provider.getTransactionReceipt(expectedHash).catch(() => null),
    ]);
    if (!transaction && !receipt) throw error;
  }
}

async function assertReplacement(hashValue: string, from: string, to: string, data: string, nonce: bigint) {
  const transaction = await provider.getTransaction(hashValue);
  if (
    !transaction
    || transaction.from.toLowerCase() !== from.toLowerCase()
    || transaction.to?.toLowerCase() !== to
    || transaction.data.toLowerCase() !== data
    || BigInt(transaction.nonce) !== nonce
  ) throw new Error('replacement transaction mismatch');
}

async function record(
  key: string,
  requestHash: string,
  response: Record<string, unknown>,
  rawTransaction?: string,
) {
  const nextState = { ...state, [key]: { requestHash, response, ...(rawTransaction ? { rawTransaction } : {}) } };
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(nextState)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, stateFile);
  await chmod(stateFile, 0o600);
  const directory = await open(dirname(stateFile), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  state = nextState;
}

async function loadState(path: string): Promise<Record<string, StoredRecord>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid state');
    return value as Record<string, StoredRecord>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function replay(recordValue: StoredRecord, requestHash: string) {
  if (recordValue.requestHash !== requestHash) {
    throw new RuntimeRequestError('IDEMPOTENCY_CONFLICT', 'idempotency conflict', 409);
  }
  return recordValue.response;
}

async function replayBroadcast(recordValue: StoredRecord, requestHash: string) {
  const response = replay(recordValue, requestHash);
  if (!recordValue.rawTransaction) throw new Error('stored broadcast transaction is unavailable');
  const transactionHash = hash(recordValue.response.executionTxHash, 'stored executionTxHash');
  await broadcast(recordValue.rawTransaction, transactionHash);
  return response;
}

function authorize(request: IncomingMessage, expected: string) {
  const supplied = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('unauthorized');
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 128 * 1024) throw new Error('request too large');
    chunks.push(value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body');
  return value as Record<string, unknown>;
}

function wallet(keyName: string, addressName: string) {
  const value = new Wallet(required(keyName), provider);
  if (value.address.toLowerCase() !== address(required(addressName), addressName)) throw new Error(`${addressName} does not match its key`);
  return value;
}

function boundedGas(value: unknown) {
  const gas = positiveInteger(value, 'gasLimit');
  if (gas > maxGasLimit) throw new Error('gas limit exceeds the configured maximum');
  return gas;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function dualPendingNonce(walletAddress: string) {
  const [primary, fallback] = await Promise.all([
    provider.getTransactionCount(walletAddress, 'pending'),
    fallbackProvider.getTransactionCount(walletAddress, 'pending'),
  ]);
  if (primary !== fallback) {
    throw new RuntimeRequestError('NONCE_MISMATCH', 'BSC RPC sources disagree on the pending nonce', 409, {
      relation: 'RPC_DIVERGENCE',
      stateRecordPresent: false,
      executorWallet: walletAddress.toLowerCase(),
      primaryPendingNonce: String(primary),
      fallbackPendingNonce: String(fallback),
    });
  }
  return primary;
}

function normalizedUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

function governanceRequestHash(input: Record<string, unknown>) {
  const { reconciliationOnly: _reconciliationOnly, ...identity } = input;
  return hashJson(identity);
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error(`${name} is invalid`);
  return value;
}

function identifier(value: unknown, name: string) {
  const result = text(value, name);
  if (!/^[A-Za-z0-9:_-]+$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function address(value: unknown, name: string) {
  try { return getAddress(String(value)).toLowerCase(); } catch { throw new Error(`${name} is invalid`); }
}

function hash(value: unknown, name: string) {
  const result = text(value, name).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function optionalHash(value: unknown) {
  return value === undefined ? undefined : hash(value, 'replacementForExecutionTxHash');
}

function bytes(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 * 1024) {
    throw new Error(`${name} is invalid`);
  }
  const result = value.toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})+$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function integer(value: unknown, name: string) {
  const result = text(String(value), name);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error(`${name} is invalid`);
  return BigInt(result);
}

function positiveInteger(value: unknown, name: string) {
  const result = integer(value, name);
  if (result <= 0n) throw new Error(`${name} is invalid`);
  return result;
}

function positiveNumber(value: unknown, name: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} is invalid`);
  return result;
}

function nonNegativeNumber(value: unknown, name: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} is invalid`);
  return result;
}

function boolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`);
  return value;
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sendRuntimeError(response: ServerResponse, error: unknown) {
  if (error instanceof RuntimeRequestError) {
    return send(response, error.status, {
      error: { code: error.runtimeCode, ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}) },
    });
  }
  return send(response, 500, { error: 'EOA_RUNTIME_FAILURE' });
}

function send(response: ServerResponse, status: number, value: unknown) {
  const payload = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}
