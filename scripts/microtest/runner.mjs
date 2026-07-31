#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, JsonRpcProvider, keccak256, Wallet } from 'ethers';
import { projectRootFromScript, readEnvFile } from './env-utils.mjs';
import { runAbuV2Preflight } from './preflight.mjs';
import { appendTxLog, assertTxBudget, nativeToWei, updateTxLog, withExclusiveTxExecution } from './tx-guard.mjs';

const DEFAULT_PACKET = 'platform-v2/deployments/bsc-eoa-micro-packet-private.json';
const MAX_TOKEN_VALUE_USDT = 3n * 10n ** 18n;
const REQUIRED_CONFIRMATIONS = 15;
const ARTIFACT_DIR = 'test-artifacts';
const RAW_TX_LOG = path.join(ARTIFACT_DIR, 'signed-raw-transactions.json');
export const PRIVATE_KEY_ENV = Object.freeze([
  'PLATFORM_TECH_PRIVATE_KEY',
  'WALLET_2_PRIVATE_KEY',
  'WALLET_3_PRIVATE_KEY',
  'WALLET_4_PRIVATE_KEY',
  'MICROTEST_BUYER_1_PRIVATE_KEY',
  'MICROTEST_BUYER_2_PRIVATE_KEY',
  'MICROTEST_BUYER_3_PRIVATE_KEY',
]);

if (isCliEntry()) {
  try {
    await runAbuV2Runner();
  } catch (error) {
    console.error(`runner gate: FAIL - ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}

export async function runAbuV2Runner(options = {}) {
  const root = options.cwd ?? projectRootFromScript(import.meta.url);
  const env = options.env ?? loadLocalEnv(root);
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    return await withExclusiveTxExecution(async () => {
      const preflight = await (options.runPreflight ?? runAbuV2Preflight)({
        cwd: root,
        env,
        ...(options.preflightOptions ?? {}),
        requireBroadcastAuthorized: true,
      });
      const provider = options.provider ?? new JsonRpcProvider(env.BSC_RPC_URL, 56, { staticNetwork: true });
      const fallbackProvider = options.fallbackProvider ?? new JsonRpcProvider(env.BSC_FALLBACK_RPC_URL, 56, { staticNetwork: true });
      await assertBscProvider(provider);
      await assertBscProvider(fallbackProvider);
      const packet = readRunnerPacket(preflight.packetPath);
      const transactions = normalizeRunnerTransactions(packet);
      if (!transactions.length) throw new Error('micro-test packet does not contain executable transactions');
      const signerFactory = options.signerFactory ?? defaultSignerFactory(env, provider);
      const hashes = [];
      for (const transaction of transactions) {
        const hash = await executePacketTransaction({
          env,
          preflight,
          provider,
          fallbackProvider,
          signerFactory,
          transaction,
        });
        hashes.push(hash);
      }
      console.log(`runner: PASS - broadcast and dual-RPC finalized ${hashes.length} packet-bound transaction(s)`);
      return { preflight, hashes };
    });
  } finally {
    process.chdir(previousCwd);
  }
}

export function normalizeRunnerTransactions(packet) {
  const entries = packetTransactionEntries(packet);
  const transactions = entries.map((entry, index) => normalizeRunnerTransaction(entry, index, entries.length));
  for (const [index, transaction] of transactions.entries()) {
    if (transaction.sequence !== index + 1) {
      throw new Error(`transactions[${index}].sequence must be ${index + 1}`);
    }
  }
  return transactions;
}

async function executePacketTransaction({ env, preflight, provider, fallbackProvider, signerFactory, transaction }) {
  const signer = await signerFactory(transaction.wallet);
  if (signer.address.toLowerCase() !== transaction.wallet.toLowerCase()) {
    throw new Error(`packet signer key does not match ${transaction.operation}`);
  }
  const pendingNonce = await provider.getTransactionCount(transaction.wallet, 'pending');
  if (transaction.nonce !== BigInt(pendingNonce)) {
    throw new Error(`packet nonce mismatch for ${transaction.operation}: expected ${transaction.nonce}, got ${pendingNonce}`);
  }
  await rpcStep('callStatic', () => provider.call({ from: transaction.wallet, to: transaction.target, data: transaction.calldata, value: transaction.valueWei }));
  const estimatedGas = await rpcStep('estimateGas', () => provider.estimateGas({ from: transaction.wallet, to: transaction.target, data: transaction.calldata, value: transaction.valueWei }));
  const gasLimit = transaction.gasLimit;
  if (estimatedGas > gasLimit) throw new Error(`packet gasLimit is below estimate for ${transaction.operation}`);
  const feeData = await rpcStep('getFeeData', () => provider.getFeeData());
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (gasPrice === undefined || gasPrice === null) throw new Error('BSC gas price is unavailable');
  if (gasPrice > transaction.maxFeePerGasWei) {
    throw new Error(`current gas price exceeds packet maxFeePerGasWei for ${transaction.operation}`);
  }
  const budget = assertTxBudget({
    env,
    preflightResult: preflight,
    operation: transaction.operation,
    functionCall: transaction.functionCall,
    wallet: transaction.wallet,
    target: transaction.target,
    calldataHash: transaction.calldataHash,
    nonce: transaction.nonce.toString(),
    valueWei: transaction.valueWei,
    estimatedGas: gasLimit,
    maxFeePerGasWei: transaction.maxFeePerGasWei,
    expectedResult: transaction.expectedResult,
  });
  console.log(`runner tx: ${transaction.operation} ${redactAddress(transaction.wallet)} -> ${redactAddress(transaction.target)}`);
  const request = {
    to: transaction.target,
    data: transaction.calldata,
    value: transaction.valueWei,
    chainId: 56,
    gasLimit,
    gasPrice,
    nonce: Number(transaction.nonce),
  };
  const signedRawTransaction = await rpcStep('signTransaction', () => signer.signTransaction(request));
  const rawTransactionHash = keccak256(signedRawTransaction);
  persistSignedRawTransaction({
    hash: rawTransactionHash,
    chainId: 56,
    wallet: transaction.wallet,
    target: transaction.target,
    nonce: transaction.nonce.toString(),
    valueWei: transaction.valueWei.toString(),
    gasLimit: gasLimit.toString(),
    gasPriceWei: gasPrice.toString(),
    calldataHash: transaction.calldataHash,
    packetSha256: budget.packetSha256,
    signedRawTransaction,
  });
  const sent = await rpcStep('broadcastTransaction', () => provider.broadcastTransaction(signedRawTransaction));
  if (sent.hash.toLowerCase() !== rawTransactionHash.toLowerCase()) {
    throw new Error('broadcast transaction hash does not match persisted signed raw transaction');
  }
  appendTxLog({
    hash: sent.hash,
    chainId: 56,
    wallet: transaction.wallet,
    status: 'SUBMITTED',
    gasCostWei: budget.gasCostWei.toString(),
    valueWei: transaction.valueWei.toString(),
    operation: transaction.operation,
    functionCall: transaction.functionCall,
    packetCalldataHash: transaction.calldataHash,
    rawTransactionHash,
  });
  const receipt = await rpcStep('waitForReceipt', () => sent.wait(REQUIRED_CONFIRMATIONS));
  await verifyCanonicalReceipt(provider, receipt, sent.hash, 'primary RPC');
  await verifyCanonicalReceipt(fallbackProvider, receipt, sent.hash, 'fallback RPC');
  const receiptGasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? gasPrice;
  updateTxLog(sent.hash, {
    status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
    gasCostWei: (receipt.gasUsed * receiptGasPrice).toString(),
    valueWei: transaction.valueWei.toString(),
  });
  if (receipt.status !== 1) throw new Error(`transaction reverted for ${transaction.operation}: ${sent.hash}`);
  return sent.hash;
}

function persistSignedRawTransaction(entry) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(ARTIFACT_DIR, 0o700);
  const existing = fs.existsSync(RAW_TX_LOG)
    ? JSON.parse(fs.readFileSync(RAW_TX_LOG, 'utf8'))
    : [];
  if (!Array.isArray(existing)) throw new Error('Signed raw transaction log is invalid');
  if (existing.some((item) => String(item.hash ?? '').toLowerCase() === entry.hash.toLowerCase())) {
    return;
  }
  const next = [...existing, { timestamp: new Date().toISOString(), ...entry }];
  const temp = `${RAW_TX_LOG}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, RAW_TX_LOG);
  fs.chmodSync(RAW_TX_LOG, 0o600);
}

async function verifyCanonicalReceipt(provider, expectedReceipt, hash, label) {
  const receipt = await rpcStep(`${label} receipt`, () => provider.getTransactionReceipt(hash));
  if (!receipt) throw new Error(`${label} missing receipt for ${hash}`);
  if (receipt.status !== expectedReceipt.status) throw new Error(`${label} receipt status mismatch for ${hash}`);
  if (receipt.blockNumber !== expectedReceipt.blockNumber) throw new Error(`${label} receipt blockNumber mismatch for ${hash}`);
  if (String(receipt.blockHash).toLowerCase() !== String(expectedReceipt.blockHash).toLowerCase()) {
    throw new Error(`${label} receipt blockHash mismatch for ${hash}`);
  }
  const latest = await rpcStep(`${label} latest block`, () => provider.getBlockNumber());
  const confirmations = latest - receipt.blockNumber + 1;
  if (confirmations < REQUIRED_CONFIRMATIONS) {
    throw new Error(`${label} receipt has only ${confirmations} confirmations for ${hash}`);
  }
  const block = await rpcStep(`${label} canonical block`, () => provider.getBlock(receipt.blockNumber));
  if (!block || String(block.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
    throw new Error(`${label} canonical block hash mismatch for ${hash}`);
  }
}

function normalizeRunnerTransaction(entry, index, total) {
  const operation = text(entry.operation ?? entry.label ?? entry.name ?? `tx-${index + 1}`, `transactions[${index}].operation`);
  const functionCall = text(entry.functionCall ?? entry.functionSignature ?? entry.function ?? entry.signature, `transactions[${index}].functionCall`);
  const wallet = address(entry.wallet ?? entry.from ?? entry.signer ?? entry.signerAddress ?? entry.fromAddress, `transactions[${index}].wallet`);
  const target = address(entry.target ?? entry.to ?? entry.targetAddress ?? entry.contractAddress, `transactions[${index}].target`);
  const calldata = hexData(entry.calldata ?? entry.data ?? entry.input, `transactions[${index}].calldata`);
  const calldataHash = hash(entry.calldataHash ?? entry.dataHash ?? entry.inputHash, `transactions[${index}].calldataHash`);
  if (keccak256(calldata).toLowerCase() !== calldataHash) throw new Error(`transactions[${index}].calldataHash does not match calldata`);
  const nonce = uint(entry.nonce ?? entry.accountNonce, `transactions[${index}].nonce`);
  const valueWei = requiredNativeValue(entry, index);
  const maxFeePerGasWei = uint(entry.maxFeePerGasWei ?? entry.gasPriceWei ?? entry.feeCeilingWei, `transactions[${index}].maxFeePerGasWei`);
  const gasLimit = uint(entry.gasLimit, `transactions[${index}].gasLimit`);
  const tokenValueUsdtAtomic = uint(entry.tokenValueUsdtAtomic ?? entry.maxTokenValueUsdtAtomic, `transactions[${index}].tokenValueUsdtAtomic`);
  if (tokenValueUsdtAtomic > MAX_TOKEN_VALUE_USDT) {
    throw new Error(`transactions[${index}].tokenValueUsdtAtomic exceeds 3 USDT`);
  }
  const sequence = integer(entry.sequence ?? entry.sequenceNumber, `transactions[${index}].sequence`);
  if (sequence !== undefined && (sequence < 1 || sequence > total)) throw new Error(`transactions[${index}].sequence is outside packet bounds`);
  return Object.freeze({
    sequence,
    operation,
    functionCall,
    wallet,
    target,
    calldata,
    calldataHash,
    nonce,
    valueWei,
    maxFeePerGasWei,
    gasLimit,
    tokenValueUsdtAtomic,
    expectedResult: text(entry.expectedResult ?? 'status-1 receipt', `transactions[${index}].expectedResult`),
  });
}

function packetTransactionEntries(packet) {
  const groups = [
    packet.transactions,
    packet.sequence,
    packet.steps,
    packet.operations,
    packet.mainnetMicrotest?.transactions,
    packet.mainnetMicrotest?.sequence,
    packet.mainnetMicrotest?.steps,
    packet.acceptance?.transactions,
    packet.acceptance?.sequence,
    packet.acceptance?.steps,
  ];
  return groups.filter(Array.isArray).flat();
}

function readRunnerPacket(packetPath) {
  const stat = fs.statSync(packetPath);
  if ((stat.mode & 0o077) !== 0) throw new Error('micro-test packet must be mode 600/owner-only');
  return JSON.parse(fs.readFileSync(packetPath, 'utf8'));
}

function defaultSignerFactory(env, provider) {
  const signers = new Map();
  for (const name of PRIVATE_KEY_ENV) {
    if (!env[name]) continue;
    const signer = new Wallet(env[name], provider);
    signers.set(signer.address.toLowerCase(), signer);
  }
  return async (walletAddress) => {
    const signer = signers.get(walletAddress.toLowerCase());
    if (!signer) throw new Error(`No local private key for packet signer ${redactAddress(walletAddress)}`);
    return signer;
  };
}

async function assertBscProvider(provider) {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 56) throw new Error('micro runner provider must be BSC chainId 56');
}

function loadLocalEnv(root) {
  return {
    ...process.env,
    ...readEnvFile(path.join(root, '.env')),
    ...readEnvFile(path.join(root, '.env.runtime')),
    ...readEnvFile(path.join(root, '.env.wallets.local')),
  };
}

function requiredNativeValue(entry, index) {
  const atomic = entry.valueWei ?? entry.nativeValueWei;
  const decimal = entry.valueBnb ?? entry.nativeValueBnb;
  if ((atomic === undefined || atomic === null || String(atomic).trim() === '')
    && (decimal === undefined || decimal === null || String(decimal).trim() === '')) {
    throw new Error(`transactions[${index}].valueWei is required`);
  }
  if (atomic !== undefined && atomic !== null && String(atomic).trim() !== ''
    && decimal !== undefined && decimal !== null && String(decimal).trim() !== '') {
    throw new Error(`transactions[${index}].value must use exactly one format`);
  }
  if (atomic !== undefined && atomic !== null && String(atomic).trim() !== '') {
    return uint(entry.valueWei ?? entry.nativeValueWei, 'valueWei');
  }
  return nativeToWei(String(decimal));
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function address(value, name) {
  try { return getAddress(String(value)); } catch { throw new Error(`${name} is invalid`); }
}

function hash(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value ?? ''))) throw new Error(`${name} is invalid`);
  return String(value).toLowerCase();
}

function hexData(value, name) {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(String(value ?? ''))) throw new Error(`${name} is invalid`);
  return String(value).toLowerCase();
}

function uint(value, name) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value ?? ''))) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(value);
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  return parsed;
}

async function rpcStep(label, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${label} failed: ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
  }
}

function redactAddress(value) {
  const normalized = getAddress(value);
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

function redactSensitive(value) {
  return String(value ?? '')
    .replace(/\b0x[0-9a-fA-F]{64,}\b/g, '0x<redacted-hex>')
    .replace(/\b0x[0-9a-fA-F]{40}\b/g, (match) => redactAddress(match))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b(private[_-]?key|secret|token|password)=([^&\s]+)/gi, '$1=<redacted>')
    .replace(/https?:\/\/[^\s]+/gi, '<redacted-url>');
}

function isCliEntry() {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
