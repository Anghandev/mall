import fs from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR = 'test-artifacts';
const TX_LOG = path.join(ARTIFACT_DIR, 'tx-log.json');

export function readTxLog() {
  if (!fs.existsSync(TX_LOG)) return [];
  return JSON.parse(fs.readFileSync(TX_LOG, 'utf8'));
}

export function appendTxLog(entry) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const log = readTxLog();
  log.push({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(TX_LOG, JSON.stringify(log, null, 2));
}

export function nativeToWei(value) {
  const [whole, fraction = ''] = String(value).split('.');
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
  const maxTxValueWei = nativeToWei(env.MAX_TX_VALUE_NATIVE || '0.0001');
  const maxTotalWei = nativeToWei(env.MAX_TOTAL_BUDGET_NATIVE || '0.001');
  const maxGasCostWei = nativeToWei(env.MAX_GAS_COST_PER_TX_NATIVE || '0.0002');
  const gasCostWei = BigInt(estimatedGas) * BigInt(maxFeePerGasWei);
  const log = readTxLog();
  const spentWei = log.reduce((sum, tx) => sum + BigInt(tx.costWei || 0), 0n);
  const projectedWei = spentWei + gasCostWei + BigInt(valueWei || 0);

  console.log('--- tx preflight ---');
  console.log(`operation: ${operation}`);
  console.log(`function: ${functionCall}`);
  console.log(`target: ${target}`);
  console.log(`value: ${weiToNativeString(BigInt(valueWei || 0))}`);
  console.log(`estimated gas: ${estimatedGas}`);
  console.log(`max fee per gas wei: ${maxFeePerGasWei}`);
  console.log(`estimated max gas cost: ${weiToNativeString(gasCostWei)}`);
  console.log(`current cumulative spend: ${weiToNativeString(spentWei)}`);
  console.log(`projected cumulative spend: ${weiToNativeString(projectedWei)}`);
  console.log(`expected result: ${expectedResult}`);

  if (BigInt(valueWei || 0) > maxTxValueWei) {
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
