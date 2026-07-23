import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getAddress } from 'ethers';

const ARTIFACT_DIR = 'test-artifacts';
const TX_LOG = path.join(ARTIFACT_DIR, 'tx-log.json');
const TX_LOCK = path.join(ARTIFACT_DIR, 'tx-execution.lock');
const DEFAULT_PACKET = 'platform-v2/deployments/bsc-eoa-micro-packet-private.json';
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

export function updateTxLog(hash, patch) {
  requireExecutionLock();
  const log = readTxLog();
  const normalizedHash = String(hash ?? '').toLowerCase();
  const index = log.findIndex((item) => item.hash.toLowerCase() === normalizedHash);
  if (index === -1) throw new Error('Submitted transaction hash is missing from spend ledger');
  const { totalSpentWei: _previousTotalSpentWei, ...current } = log[index];
  const updated = validateLogEntry({ ...current, ...patch, hash: log[index].hash });
  log[index] = updated;
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
  preflightResult,
  operation,
  functionCall,
  wallet,
  target,
  calldataHash,
  nonce,
  valueWei,
  estimatedGas,
  maxFeePerGasWei,
  expectedResult,
}) {
  requireExecutionLock();
  const packetBudget = readApprovedPacketBudget(env, preflightResult);
  assertPacketTransactionBinding(packetBudget.packet, {
    operation,
    functionCall,
    wallet,
    target,
    calldataHash,
    nonce,
    valueWei,
    estimatedGas,
    maxFeePerGasWei,
  });
  const envMaxNativeValueWei = requiredNativeBudget(env.MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX, 'MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX');
  const envMaxGasCostWei = requiredNativeBudget(env.MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB, 'MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB');
  const envMaxTotalNativeSpendWei = requiredNativeBudget(env.MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB, 'MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB');
  assertEnvBudgetWithinPacket(envMaxNativeValueWei, 'MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX', packetBudget.maxNativeValuePerTxWei, 'packet maxNativeValuePerTxBnb');
  assertEnvBudgetWithinPacket(envMaxGasCostWei, 'MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB', packetBudget.maxGasCostPerTxWei, 'packet maxGasCostPerTxBnb');
  assertEnvBudgetWithinPacket(envMaxTotalNativeSpendWei, 'MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB', packetBudget.maxTotalNativeSpendWei, 'packet maxTotalNativeSpendBnb');
  const maxNativeValueWei = minBigInt(envMaxNativeValueWei, BigInt(packetBudget.maxNativeValuePerTxWei));
  const maxGasCostWei = minBigInt(envMaxGasCostWei, BigInt(packetBudget.maxGasCostPerTxWei));
  const maxTotalNativeSpendWei = minBigInt(envMaxTotalNativeSpendWei, BigInt(packetBudget.maxTotalNativeSpendWei));
  const value = runtimeUint(valueWei, 'valueWei');
  const gas = runtimeUint(estimatedGas, 'estimatedGas');
  const maxFee = runtimeUint(maxFeePerGasWei, 'maxFeePerGasWei');
  const gasCostWei = gas * maxFee;
  const log = readTxLog();
  const spentWei = cumulativeSpendWei(log);
  const projectedWei = spentWei + gasCostWei + value;

  console.log('--- tx preflight ---');
  console.log(`operation: ${operation}`);
  console.log(`function: ${functionCall}`);
  console.log(`target: ${redactAddress(target)}`);
  console.log(`value: ${weiToNativeString(value)}`);
  console.log(`estimated gas: ${estimatedGas}`);
  console.log(`max fee per gas wei: ${maxFeePerGasWei}`);
  console.log(`estimated max gas cost: ${weiToNativeString(gasCostWei)}`);
  console.log(`current cumulative spend: ${weiToNativeString(spentWei)}`);
  console.log(`projected cumulative spend: ${weiToNativeString(projectedWei)}`);
  console.log(`packet sha256: ${packetBudget.packetSha256}`);
  console.log(`max gas cost per tx: ${weiToNativeString(maxGasCostWei)}`);
  console.log(`max total native spend: ${weiToNativeString(maxTotalNativeSpendWei)}`);
  console.log('gas policy: enforce approved packet BNB ceilings; Abu V2 token-value limits are enforced by micro:preflight');
  console.log(`expected result: ${redactSensitive(expectedResult)}`);

  if (value > maxNativeValueWei) {
    throw new Error(`Refusing tx: native value exceeds MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX=${env.MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX}`);
  }
  if (gasCostWei > maxGasCostWei) {
    throw new Error(`Refusing tx: estimated gas cost exceeds MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB=${env.MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB}`);
  }
  if (projectedWei > maxTotalNativeSpendWei) {
    throw new Error(`Refusing tx: projected native spend exceeds MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB=${env.MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB}`);
  }

  return { gasCostWei, projectedWei, spentWei, packetSha256: packetBudget.packetSha256 };
}

export function cumulativeSpendWei(log = readTxLog()) {
  return log.reduce((sum, transaction) => sum + BigInt(validateLogEntry(transaction).totalSpentWei), 0n);
}

function validateLogEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Transaction log entry is invalid');
  const gasCostWei = nonNegativeInteger(entry.gasCostWei, 'gasCostWei');
  const valueWei = nonNegativeInteger(entry.valueWei, 'valueWei');
  if (!['SUBMITTED', 'SUCCESS', 'FAILED'].includes(entry.status)) throw new Error('Transaction log status is invalid');
  if (!/^0x[0-9a-fA-F]{64}$/.test(entry.hash || '')) throw new Error('Transaction log hash is invalid');
  if (entry.chainId !== 56) throw new Error('Transaction log chainId must be BSC 56');
  if (!/^0x[0-9a-fA-F]{40}$/.test(entry.wallet || '')) throw new Error('Transaction log wallet is invalid');
  const totalSpentWei = gasCostWei + (entry.status === 'FAILED' ? 0n : valueWei);
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

function readApprovedPacketBudget(env, preflightResult) {
  if (!preflightResult || typeof preflightResult !== 'object') {
    throw new Error('broadcast tx guard requires the current Abu V2 preflight result');
  }
  if (preflightResult.deploymentAuthorized !== true || String(preflightResult.releaseGateStatus ?? '').toUpperCase() !== 'GO') {
    throw new Error('broadcast tx guard requires a GO preflight result');
  }
  const packetPath = path.resolve(process.cwd(), env.MAINNET_MICROTEST_PACKET_PATH ?? DEFAULT_PACKET);
  const stat = fs.statSync(packetPath);
  if ((stat.mode & 0o077) !== 0) throw new Error('micro-test packet must be mode 600/owner-only');
  const raw = fs.readFileSync(packetPath);
  const packet = JSON.parse(raw.toString('utf8'));
  const packetSha256 = createHash('sha256').update(raw).digest('hex');
  if (preflightResult.packetSha256 !== packetSha256) {
    throw new Error('micro-test packet sha256 does not match the current Abu V2 preflight result');
  }
  if (packet.chainId !== 56) throw new Error('micro-test packet must bind BSC chainId 56');
  if (packet.artifactVersion !== preflightResult.artifactVersion) {
    throw new Error('micro-test packet artifactVersion does not match the current Abu V2 preflight result');
  }
  if (packet.gitCommit !== preflightResult.gitCommit) {
    throw new Error('micro-test packet gitCommit does not match the current Abu V2 preflight result');
  }
  const budget = packet.bnbBudget
    ?? packet.gasBudget
    ?? packet.budget
    ?? packet.mainnetMicrotest?.bnbBudget
    ?? packet.mainnetMicrotest?.gasBudget
    ?? packet.mainnetMicrotest?.budget
    ?? packet.acceptance?.bnbBudget
    ?? packet.acceptance?.gasBudget
    ?? packet.acceptance?.budget;
  if (!budget || typeof budget !== 'object') throw new Error('micro-test packet must bind approved BNB ceilings');
  return Object.freeze({
    packet,
    packetSha256,
    maxNativeValuePerTxWei: nativeToWei(requiredBudgetField(budget, ['maxNativeValuePerTxBnb', 'maxNativeValuePerTxBNB', 'maxNativeValuePerTxNative', 'maxNativeValuePerTx'], 'maxNativeValuePerTxBnb')).toString(),
    maxGasCostPerTxWei: nativeToWei(requiredBudgetField(budget, ['maxGasCostPerTxBnb', 'maxGasCostPerTxBNB', 'maxGasCostPerTx'], 'maxGasCostPerTxBnb')).toString(),
    maxTotalNativeSpendWei: nativeToWei(requiredBudgetField(budget, ['maxTotalNativeSpendBnb', 'maxTotalNativeSpendBNB', 'maxCumulativeNativeSpendBnb', 'maxTotalNativeSpend'], 'maxTotalNativeSpendBnb')).toString(),
  });
}

function assertPacketTransactionBinding(packet, { operation, functionCall, wallet, target, calldataHash, nonce, valueWei, estimatedGas, maxFeePerGasWei }) {
  const normalizedTarget = normalizeAddress(target, 'target');
  const normalizedWallet = normalizeAddress(wallet, 'wallet');
  const normalizedCalldataHash = requiredHash(calldataHash, 'calldataHash');
  const normalizedNonce = String(runtimeUint(nonce, 'nonce'));
  const normalizedValueWei = String(runtimeUint(valueWei, 'valueWei'));
  const normalizedGasLimit = String(runtimeUint(estimatedGas, 'gasLimit'));
  const normalizedMaxFeePerGasWei = String(runtimeUint(maxFeePerGasWei, 'maxFeePerGasWei'));
  const entries = packetTransactionEntries(packet);
  if (!entries.length) throw new Error('micro-test packet must bind transaction targets and signer wallets');
  const matching = entries.find((entry) => {
    const entryTarget = optionalAddress(entry.target);
    const entryWallet = optionalAddress(entry.wallet);
    const entryFunction = String(entry.functionCall ?? '');
    const entryOperation = String(entry.operation ?? '');
    const entryCalldataHash = optionalHash(entry.calldataHash);
    const entryNonce = entry.nonce === undefined ? undefined : String(runtimeUint(entry.nonce, 'packet nonce'));
    const entryValueWei = optionalPacketNativeValue(entry);
    const entryGasLimit = entry.gasLimit === undefined ? undefined : String(runtimeUint(entry.gasLimit, 'packet gasLimit'));
    const entryMaxFeePerGasWei = entry.maxFeePerGasWei === undefined ? undefined : String(runtimeUint(entry.maxFeePerGasWei, 'packet maxFeePerGasWei'));
    return entryTarget === normalizedTarget
      && entryWallet === normalizedWallet
      && entryFunction === String(functionCall)
      && (!entryOperation || entryOperation === String(operation))
      && entryCalldataHash === normalizedCalldataHash
      && entryNonce === normalizedNonce
      && entryValueWei === normalizedValueWei
      && entryGasLimit === normalizedGasLimit
      && entryMaxFeePerGasWei === normalizedMaxFeePerGasWei;
  });
  if (!matching) throw new Error('micro-test packet does not authorize this signer, target, function, calldata, nonce, value and gas cap');
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
  return groups
    .filter(Array.isArray)
    .flatMap((items) => items.map((item) => ({
      operation: item?.operation ?? item?.label ?? item?.name,
      functionCall: item?.functionCall ?? item?.functionSignature ?? item?.function ?? item?.signature,
      target: item?.target ?? item?.to ?? item?.targetAddress ?? item?.contractAddress,
      wallet: item?.wallet ?? item?.from ?? item?.signer ?? item?.signerAddress ?? item?.fromAddress,
      calldataHash: item?.calldataHash ?? item?.dataHash ?? item?.inputHash,
      nonce: item?.nonce ?? item?.accountNonce,
      valueWei: item?.valueWei ?? item?.nativeValueWei,
      valueBnb: item?.valueBnb ?? item?.nativeValueBnb,
      gasLimit: item?.gasLimit,
      maxFeePerGasWei: item?.maxFeePerGasWei ?? item?.gasPriceWei ?? item?.feeCeilingWei,
    })));
}

function normalizeAddress(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`${name} is required`);
  try {
    return getAddress(String(value)).toLowerCase();
  } catch {
    throw new Error(`${name} is invalid`);
  }
}

function optionalAddress(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  try {
    return getAddress(String(value)).toLowerCase();
  } catch {
    return undefined;
  }
}

function requiredHash(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value ?? ''))) throw new Error(`${name} is invalid`);
  return String(value).toLowerCase();
}

function optionalHash(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  return requiredHash(value, 'packet calldataHash');
}

function optionalPacketNativeValue(entry) {
  const atomic = entry.valueWei ?? entry.nativeValueWei;
  const decimal = entry.valueBnb ?? entry.nativeValueBnb;
  if ((atomic === undefined || atomic === null || String(atomic).trim() === '')
    && (decimal === undefined || decimal === null || String(decimal).trim() === '')) {
    return undefined;
  }
  if (atomic !== undefined && atomic !== null && String(atomic).trim() !== ''
    && decimal !== undefined && decimal !== null && String(decimal).trim() !== '') {
    throw new Error('packet transaction must bind native value in exactly one format');
  }
  return atomic !== undefined && atomic !== null && String(atomic).trim() !== ''
    ? String(runtimeUint(atomic, 'packet valueWei'))
    : nativeToWei(String(decimal).trim()).toString();
}

function requiredBudgetField(budget, names, displayName) {
  for (const name of names) {
    if (budget[name] !== undefined && String(budget[name]).trim() !== '') return budget[name];
  }
  throw new Error(`micro-test packet BNB budget is missing ${displayName}`);
}

function assertEnvBudgetWithinPacket(envWei, envName, packetWei, packetName) {
  if (envWei > BigInt(packetWei)) throw new Error(`${envName} exceeds ${packetName} in the mode-600 packet`);
}

function minBigInt(left, right) {
  return left < right ? left : right;
}

function requiredNativeBudget(value, name) {
  if (value === undefined || String(value).trim() === '') throw new Error(`${name} is required`);
  return nativeToWei(String(value).trim());
}

function runtimeUint(value, name) {
  const normalized = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(normalized);
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
