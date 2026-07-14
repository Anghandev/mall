import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ARTIFACT_DIR = 'test-artifacts';
const TX_LOG = path.join(ARTIFACT_DIR, 'tx-log.json');
const TX_LOCK = path.join(ARTIFACT_DIR, 'tx-execution.lock');
let activeLock = false;

export async function withExclusiveTxExecution(operation) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(ARTIFACT_DIR, 0o700);
  let descriptor;
  try {
    descriptor = fs.openSync(TX_LOCK, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') throw new Error('Another micro transaction execution is active');
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.fsyncSync(descriptor);
    activeLock = true;
    return await operation();
  } finally {
    activeLock = false;
    fs.closeSync(descriptor);
    fs.unlinkSync(TX_LOCK);
  }
}

export function readTxLog() {
  if (!fs.existsSync(TX_LOG)) return [];
  let value;
  try {
    value = JSON.parse(fs.readFileSync(TX_LOG, 'utf8'));
  } catch {
    throw new Error('Transaction log is invalid');
  }
  if (!Array.isArray(value)) throw new Error('Transaction log is invalid');
  return value.map(validateLogEntry);
}

export function appendTxLog(entry) {
  requireExecutionLock();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(ARTIFACT_DIR, 0o700);
  const log = readTxLog();
  const normalized = validateLogEntry({ timestamp: new Date().toISOString(), ...entry });
  if (log.some((item) => item.hash.toLowerCase() === normalized.hash.toLowerCase())) {
    throw new Error('Duplicate transaction hash in spend ledger');
  }
  log.push(normalized);
  atomicWriteLog(log);
}

export function nativeToWei(value) {
  const normalized = String(value);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(normalized)) {
    throw new Error('Native amount must be a non-negative decimal with at most 18 decimal places');
  }
  const [whole, fraction = ''] = normalized.split('.');
  const padded = `${fraction}000000000000000000`.slice(0, 18);
  return BigInt(whole || '0') * 10n ** 18n + BigInt(padded || '0');
}

export function weiToNativeString(wei) {
  const whole = wei / 10n ** 18n;
  const fraction = String(wei % 10n ** 18n).padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function assertTxBudget({
  env,
  operation,
  functionCall,
  target,
  valueWei,
  estimatedGas,
  maxFeePerGasWei,
  expectedResult,
}) {
  requireExecutionLock();
  const maxTxValueWei = nativeToWei(env.MAX_TX_VALUE_NATIVE || '0.0001');
  const maxTotalWei = nativeToWei(env.MAX_TOTAL_BUDGET_NATIVE || '0.001');
  const maxGasCostWei = nativeToWei(env.MAX_GAS_COST_PER_TX_NATIVE || '0.0002');
  const value = runtimeUint(valueWei ?? 0, 'valueWei');
  const gas = runtimeUint(estimatedGas, 'estimatedGas');
  const maxFee = runtimeUint(maxFeePerGasWei, 'maxFeePerGasWei');
  const gasCostWei = gas * maxFee;
  const log = readTxLog();
  const spentWei = cumulativeSpendWei(log);
  const projectedWei = spentWei + gasCostWei + value;

  console.log('--- tx preflight ---');
  console.log(`operation: ${operation}`);
  console.log(`function: ${functionCall}`);
  console.log(`target: ${target}`);
  console.log(`value: ${weiToNativeString(value)}`);
  console.log(`estimated gas: ${estimatedGas}`);
  console.log(`max fee per gas wei: ${maxFeePerGasWei}`);
  console.log(`estimated max gas cost: ${weiToNativeString(gasCostWei)}`);
  console.log(`current cumulative spend: ${weiToNativeString(spentWei)}`);
  console.log(`projected cumulative spend: ${weiToNativeString(projectedWei)}`);
  console.log(`expected result: ${expectedResult}`);

  if (value > maxTxValueWei) {
    throw new Error(`Refusing tx: value exceeds MAX_TX_VALUE_NATIVE=${env.MAX_TX_VALUE_NATIVE}`);
  }
  if (gasCostWei > maxGasCostWei) {
    throw new Error(`Refusing tx: gas cost exceeds MAX_GAS_COST_PER_TX_NATIVE=${env.MAX_GAS_COST_PER_TX_NATIVE}`);
  }
  if (projectedWei > maxTotalWei) {
    throw new Error(`Refusing tx: projected spend exceeds MAX_TOTAL_BUDGET_NATIVE=${env.MAX_TOTAL_BUDGET_NATIVE}`);
  }

  return { gasCostWei, projectedWei, spentWei };
}

export function cumulativeSpendWei(log = readTxLog()) {
  return log.reduce((sum, transaction) => sum + BigInt(validateLogEntry(transaction).totalSpentWei), 0n);
}

function validateLogEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Transaction log entry is invalid');
  const gasCostWei = nonNegativeInteger(entry.gasCostWei, 'gasCostWei');
  const valueWei = nonNegativeInteger(entry.valueWei, 'valueWei');
  if (!['SUCCESS', 'FAILED'].includes(entry.status)) throw new Error('Transaction log status is invalid');
  if (!/^0x[0-9a-fA-F]{64}$/.test(entry.hash || '')) throw new Error('Transaction log hash is invalid');
  if (!Number.isSafeInteger(entry.chainId) || entry.chainId <= 0) throw new Error('Transaction log chainId is invalid');
  if (!/^0x[0-9a-fA-F]{40}$/.test(entry.wallet || '')) throw new Error('Transaction log wallet is invalid');
  const totalSpentWei = gasCostWei + (entry.status === 'SUCCESS' ? valueWei : 0n);
  if (entry.totalSpentWei !== undefined && nonNegativeInteger(entry.totalSpentWei, 'totalSpentWei') !== totalSpentWei) {
    throw new Error('Transaction log total does not match gas and value');
  }
  return {
    ...entry,
    gasCostWei: gasCostWei.toString(),
    valueWei: valueWei.toString(),
    totalSpentWei: totalSpentWei.toString(),
  };
}

function nonNegativeInteger(value, name) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Transaction log ${name} is invalid`);
  }
  return BigInt(value);
}

function runtimeUint(value, name) {
  const normalized = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(normalized);
}

function requireExecutionLock() {
  if (!activeLock) throw new Error('Micro transaction execution lock is required');
}

function atomicWriteLog(log) {
  const temporary = `${TX_LOG}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(log, null, 2));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, TX_LOG);
  fs.chmodSync(TX_LOG, 0o600);
  const directory = fs.openSync(ARTIFACT_DIR, 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
