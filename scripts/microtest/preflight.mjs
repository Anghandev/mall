#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, keccak256 } from 'ethers';
import { projectRootFromScript, readEnvFile } from './env-utils.mjs';

const require = createRequire(import.meta.url);
const REQUIRED_ENV = [
  'CHAIN_ID',
  'TARGET_CHAIN',
  'BSC_RPC_URL',
  'BSC_FALLBACK_RPC_URL',
  'DATABASE_URL',
  'AUDIT_DATABASE_URL',
  'REDIS_URL',
  'QUEUE_URL',
  'SIGNER_SERVICE_URL',
  'SIGNER_SERVICE_TOKEN',
  'SETTLEMENT_EXECUTOR_URL',
  'SETTLEMENT_EXECUTOR_TOKEN',
  'GOVERNANCE_EXECUTOR_URL',
  'GOVERNANCE_EXECUTOR_TOKEN',
  'BNM_AVAILABILITY_URL',
  'BNM_API_TOKEN',
  'BNM_PROJECT_ID',
  'BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH',
  'PLATFORM_GOVERNANCE_WALLET_ADDRESS',
  'PLATFORM_SERVICE_FEE_WALLET_ADDRESS',
  'USDT_SETTLEMENT_WALLET_ADDRESS',
  'NPL_REWARD_WALLET_ADDRESS',
  'OPERATIONS_GUARANTEE_WALLET_ADDRESS',
  'MAINNET_MICROTEST_MERCHANT_ID',
  'MAINNET_MICROTEST_MERCHANT_WALLET',
  'MAINNET_MICROTEST_PRODUCT_ID',
  'MAINNET_MICROTEST_BUYER_WALLETS',
  'MAINNET_MICROTEST_EXPIRES_AT',
  'MAINNET_MICROTEST_MAX_LIST_PRICE_USDT',
  'MAINNET_MICROTEST_MAX_FREIGHT_USDT',
  'MAINNET_MICROTEST_MAX_STOCK',
  'MAINNET_MICROTEST_SECKILL_INVENTORY',
  'MAINNET_MICROTEST_EVIDENCE_HASH',
  'MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX',
  'MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB',
  'MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB',
];

const ROLE_ADDRESS_ENV = [
  'PLATFORM_GOVERNANCE_WALLET_ADDRESS',
  'PLATFORM_SERVICE_FEE_WALLET_ADDRESS',
  'USDT_SETTLEMENT_WALLET_ADDRESS',
  'NPL_REWARD_WALLET_ADDRESS',
  'OPERATIONS_GUARANTEE_WALLET_ADDRESS',
];
const MAX_MICROTEST_USDT = 3n * 10n ** 18n;
const DEFAULT_PACKET = 'platform-v2/deployments/bsc-eoa-micro-packet-private.json';
const REQUIRED_BUYER_LABELS = Object.freeze(['W5', 'W1', 'W6']);

if (isCliEntry()) {
  try {
    await runAbuV2Preflight();
  } catch (error) {
    console.error(`preflight: FAIL - ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function isCliEntry() {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export async function runAbuV2Preflight(options = {}) {
  const root = options.cwd ?? projectRootFromScript(import.meta.url);
  const env = options.env ?? loadLocalEnv(root);
  const result = validateAbuV2Preflight({
    cwd: root,
    env,
    gitCommit: options.gitCommit,
    packetPath: options.packetPath,
    requireBroadcastAuthorized: options.requireBroadcastAuthorized ?? false,
  });
  if (options.skipRpc !== true) await verifyBscRuntime(result, env, options.rpc ?? rpc);
  if (result.broadcastRequired) {
    await verifyExternalDependencies(result, env, options.externalProbe ?? defaultExternalProbe);
  }
  printSummary(result, options.skipRpc === true);
  return result;
}

export function validateAbuV2Preflight({
  cwd,
  env,
  gitCommit,
  packetPath,
  requireBroadcastAuthorized = false,
}) {
  const root = cwd ?? process.cwd();
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing Abu V2 preflight env: ${missing.join(', ')}`);
  if ((env.TARGET_CHAIN ?? '').toLowerCase() !== 'bsc' || String(env.CHAIN_ID) !== '56') {
    throw new Error('Abu V2 mainnet micro-test must target BSC chainId 56');
  }
  if (normalizedUrl(env.BSC_RPC_URL) === normalizedUrl(env.BSC_FALLBACK_RPC_URL)) {
    throw new Error('BSC_RPC_URL and BSC_FALLBACK_RPC_URL must be independent endpoints');
  }

  const artifactVersion = readJson(root, 'packages/core-artifacts/package.json').version;
  const manifest = readJson(root, 'packages/core-artifacts/contracts/contract-manifest.json');
  const coordinated = readJson(root, 'packages/core-artifacts/coordinated-manifest.json');
  if (coordinated.artifactVersion !== artifactVersion) {
    throw new Error('coordinated manifest artifactVersion does not match package artifactVersion');
  }
  if (manifest.artifactVersion !== artifactVersion) {
    throw new Error('contract manifest artifactVersion does not match package artifactVersion');
  }
  if (Number(manifest.chain?.chainId) !== 56) {
    throw new Error('contract manifest must bind BSC chainId 56');
  }
  if (manifest.deploymentStatus !== 'DEPLOYED') {
    throw new Error('contract manifest deploymentStatus must be DEPLOYED for mainnet micro-test');
  }
  const contracts = ['PolicyRegistryV2', 'BeneficiaryRegistryV2', 'PaymentRouterV2'].map((name) => {
    const contract = manifest.contracts?.find((entry) => entry.name === name);
    if (!contract?.address || !/^0x[0-9a-fA-F]{40}$/.test(contract.address)) throw new Error(`${name} address is unavailable`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(contract.deployedCodeHash ?? '')) throw new Error(`${name} runtime code hash is unavailable`);
    if (contract.status !== 'DEPLOYED') throw new Error(`${name} deployment status must be DEPLOYED`);
    return { name, address: getAddress(contract.address), deployedCodeHash: contract.deployedCodeHash.toLowerCase() };
  });

  const roleAddresses = ROLE_ADDRESS_ENV.map((name) => [name, address(env[name], name)]);
  assertDistinct(roleAddresses, 'production role wallet');

  const merchantWallet = address(env.MAINNET_MICROTEST_MERCHANT_WALLET, 'MAINNET_MICROTEST_MERCHANT_WALLET');
  const buyerWallets = env.MAINNET_MICROTEST_BUYER_WALLETS.split(',').map((value, index) => address(value.trim(), `MAINNET_MICROTEST_BUYER_WALLETS[${index}]`));
  if (buyerWallets.length !== 3) throw new Error('MAINNET_MICROTEST_BUYER_WALLETS must contain exactly three buyers ordered W5,W1,W6');
  assertDistinct(buyerWallets.map((value, index) => [`buyer:${index + 1}`, value]), 'mainnet micro-test buyer');
  if (buyerWallets.some((buyer) => buyer.toLowerCase() === merchantWallet.toLowerCase())) {
    throw new Error('mainnet micro-test buyer cannot equal merchant wallet');
  }
  const protocolRoleMap = new Map(roleAddresses.map(([name, value]) => [value.toLowerCase(), name]));
  for (const buyer of buyerWallets) {
    const role = protocolRoleMap.get(buyer.toLowerCase());
    if (role) throw new Error(`mainnet micro-test buyer conflicts with protocol role ${role}`);
  }

  const expiresAt = new Date(env.MAINNET_MICROTEST_EXPIRES_AT);
  const now = new Date();
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now || expiresAt.getTime() - now.getTime() > 24 * 60 * 60 * 1_000) {
    throw new Error('MAINNET_MICROTEST_EXPIRES_AT must be within the next 24 hours');
  }
  const maxListPriceUsdt = atomicAmount(env.MAINNET_MICROTEST_MAX_LIST_PRICE_USDT, 'MAINNET_MICROTEST_MAX_LIST_PRICE_USDT', false);
  const maxFreightUsdt = atomicAmount(env.MAINNET_MICROTEST_MAX_FREIGHT_USDT, 'MAINNET_MICROTEST_MAX_FREIGHT_USDT', true);
  if (maxListPriceUsdt + maxFreightUsdt > MAX_MICROTEST_USDT) {
    throw new Error('mainnet micro-test token-value exceeds 3 USDT');
  }
  const maxStock = boundedInteger(env.MAINNET_MICROTEST_MAX_STOCK, 'MAINNET_MICROTEST_MAX_STOCK', 1, 10);
  boundedInteger(env.MAINNET_MICROTEST_SECKILL_INVENTORY, 'MAINNET_MICROTEST_SECKILL_INVENTORY', 1, maxStock);
  bytes32(env.MAINNET_MICROTEST_EVIDENCE_HASH, 'MAINNET_MICROTEST_EVIDENCE_HASH');
  bytes32(env.BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH, 'BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH');

  const releaseCommit = gitCommit ?? currentGitCommit(root);
  const resolvedPacketPath = path.resolve(root, packetPath ?? env.MAINNET_MICROTEST_PACKET_PATH ?? DEFAULT_PACKET);
  const packet = readPrivatePacket(resolvedPacketPath);
  if (packet.chainId !== 56) throw new Error('micro-test packet must bind BSC chainId 56');
  if (packet.artifactVersion !== artifactVersion) throw new Error(`micro-test packet artifactVersion ${packet.artifactVersion} does not match ${artifactVersion}`);
  if (packet.gitCommit !== releaseCommit) throw new Error('micro-test packet gitCommit does not match the current release commit');
  if (requireBroadcastAuthorized) assertCoordinatedBroadcastAuthorized(coordinated);
  if (requireBroadcastAuthorized && packet.broadcastAuthorized !== true) throw new Error('micro-test packet is not broadcastAuthorized');
  const packetBuyers = packetBuyerEntries(packet).map((entry, index) => ({
    label: buyerLabel(entry.label, `packet buyer label[${index}]`),
    wallet: address(entry.wallet, `packet buyer[${index}]`),
  }));
  if (packetBuyers.length !== 3) {
    throw new Error('micro-test packet must explicitly bind exactly three W5/W1/W6 buyer wallets');
  }
  assertPacketBuyerLabels(packetBuyers);
  const envBuyersByLabel = new Map(REQUIRED_BUYER_LABELS.map((label, index) => [label, buyerWallets[index].toLowerCase()]));
  for (const packetBuyer of packetBuyers) {
    if (packetBuyer.wallet.toLowerCase() !== envBuyersByLabel.get(packetBuyer.label)) {
      throw new Error(`micro-test packet ${packetBuyer.label} buyer wallet does not match MAINNET_MICROTEST_BUYER_WALLETS order W5,W1,W6`);
    }
  }
  const packetBnbBudget = readPacketBnbBudget(packet);
  assertEnvBnbBudgetWithinPacket(env, packetBnbBudget);
  const packetSha256 = sha256File(resolvedPacketPath);

  return Object.freeze({
    artifactVersion,
    gitCommit: releaseCommit,
    broadcastRequired: requireBroadcastAuthorized,
    packetPath: resolvedPacketPath,
    packetSha256,
    packetBnbBudget,
    releaseGateStatus: coordinated.releaseGateStatus ?? 'UNSPECIFIED',
    deploymentAuthorized: coordinated.deploymentAuthorized === true,
    buyerWallets,
    roleAddresses,
    contracts,
    maxListPriceUsdt: maxListPriceUsdt.toString(),
    maxFreightUsdt: maxFreightUsdt.toString(),
  });
}

async function verifyExternalDependencies(result, env, probe) {
  await Promise.all([
    probe.postgres(env.DATABASE_URL, 'business database'),
    probe.postgres(env.AUDIT_DATABASE_URL, 'audit database'),
    probe.redis(env.REDIS_URL, 'Redis'),
    probe.redis(env.QUEUE_URL, 'queue Redis'),
    probe.signer(env.SIGNER_SERVICE_URL, env.SIGNER_SERVICE_TOKEN, env.PLATFORM_GOVERNANCE_WALLET_ADDRESS),
    probe.executor(env.SETTLEMENT_EXECUTOR_URL, env.SETTLEMENT_EXECUTOR_TOKEN, 'settlement executor'),
    probe.executor(env.GOVERNANCE_EXECUTOR_URL, env.GOVERNANCE_EXECUTOR_TOKEN, 'governance executor'),
    probe.bnm(env.BNM_AVAILABILITY_URL, env.BNM_API_TOKEN, {
      projectId: env.BNM_PROJECT_ID,
      evidenceHash: env.BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH,
      buyers: result.buyerWallets,
    }),
  ]);
}

const defaultExternalProbe = Object.freeze({
  postgres: probePostgres,
  redis: probeRedis,
  signer: probeSigner,
  executor: probeExecutor,
  bnm: probeBnm,
});

async function probePostgres(connectionString, label) {
  const { Client: PgClient } = require('../../platform-v2/node_modules/pg');
  const client = new PgClient({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    throw new Error(`${label} readiness check failed: ${redactedError(error)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function probeRedis(url, label) {
  const { createClient: createRedisClient } = require('../../platform-v2/node_modules/redis');
  const client = createRedisClient({ url });
  client.on('error', () => undefined);
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') throw new Error('PING did not return PONG');
  } catch (error) {
    throw new Error(`${label} readiness check failed: ${redactedError(error)}`);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

async function probeSigner(url, token, expectedSigner) {
  const body = await fetchJson(url, token, { method: 'GET', label: 'remote signer' });
  if (body.status !== 'READY' || getAddress(String(body.signer ?? '')).toLowerCase() !== getAddress(expectedSigner).toLowerCase()) {
    throw new Error('remote signer health identity mismatch');
  }
}

async function probeExecutor(url, token, label) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${label} authentication failed`);
  }
  if (response.status === 404 || response.status === 405) {
    throw new Error(`${label} endpoint mismatch`);
  }
  if (!response.ok && response.status !== 400 && response.status !== 409) {
    throw new Error(`${label} readiness check failed with HTTP ${response.status}`);
  }
}

async function probeBnm(url, token, input) {
  const healthUrl = new URL(url);
  healthUrl.searchParams.set('projectId', input.projectId);
  healthUrl.searchParams.set('evidenceHash', input.evidenceHash);
  healthUrl.searchParams.set('buyers', input.buyers.join(','));
  const body = await fetchJson(healthUrl, token, { method: 'GET', label: 'BNM availability' });
  if (body.status && !['READY', 'OK'].includes(String(body.status).toUpperCase())) {
    throw new Error('BNM availability readiness check failed');
  }
}

async function fetchJson(url, token, { method, label }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new Error(`${label} readiness check failed: ${redactedError(error)}`);
  }
  if (!response.ok) throw new Error(`${label} readiness check failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} readiness check returned malformed JSON`);
  }
}

function loadLocalEnv(root) {
  return {
    ...process.env,
    ...readEnvFile(path.join(root, '.env')),
    ...readEnvFile(path.join(root, '.env.runtime')),
    ...readEnvFile(path.join(root, '.env.wallets.local')),
  };
}

async function verifyBscRuntime(result, env, rpcFn) {
  const [primaryChain, fallbackChain] = await Promise.all([
    rpcFn(env.BSC_RPC_URL, 'eth_chainId', []),
    rpcFn(env.BSC_FALLBACK_RPC_URL, 'eth_chainId', []),
  ]);
  if (Number.parseInt(primaryChain, 16) !== 56 || Number.parseInt(fallbackChain, 16) !== 56) {
    throw new Error('BSC RPC chainId check failed');
  }
  for (const contract of result.contracts) {
    const [primaryCode, fallbackCode] = await Promise.all([
      rpcFn(env.BSC_RPC_URL, 'eth_getCode', [contract.address, 'latest']),
      rpcFn(env.BSC_FALLBACK_RPC_URL, 'eth_getCode', [contract.address, 'latest']),
    ]);
    if (primaryCode === '0x' || fallbackCode === '0x') throw new Error(`${contract.name} runtime code is missing`);
    const primaryHash = keccak256(primaryCode).toLowerCase();
    const fallbackHash = keccak256(fallbackCode).toLowerCase();
    if (primaryHash !== contract.deployedCodeHash || fallbackHash !== contract.deployedCodeHash) {
      throw new Error(`${contract.name} runtime code hash does not match the artifact`);
    }
  }
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status} for ${method}`);
  const json = await response.json();
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message ?? 'unknown'}`);
  return json.result;
}

function printSummary(result, skippedRpc) {
  console.log('=== Abu 24K V2 Mainnet Micro-Test Preflight ===');
  console.log(`artifact: ${result.artifactVersion}`);
  console.log(`commit: ${result.gitCommit.slice(0, 12)}`);
  console.log(`packet sha256: ${result.packetSha256}`);
  console.log(`release gate: ${result.releaseGateStatus}; broadcast authorized: ${result.deploymentAuthorized}`);
  console.log(`buyer wallets: ${result.buyerWallets.map(redactAddress).join(', ')}`);
  console.log(`contracts: ${result.contracts.map((item) => `${item.name}:${redactAddress(item.address)}`).join(', ')}`);
  if (skippedRpc) console.log('runtime RPC check: skipped by caller');
  console.log('preflight: PASS');
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readPrivatePacket(packetPath) {
  const stat = fs.statSync(packetPath);
  if ((stat.mode & 0o077) !== 0) throw new Error('micro-test packet must be mode 600/owner-only');
  return JSON.parse(fs.readFileSync(packetPath, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function currentGitCommit(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function address(value, name) {
  try { return getAddress(String(value)); } catch { throw new Error(`${name} is invalid`); }
}

function bytes32(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value))) throw new Error(`${name} must be bytes32`);
  return String(value).toLowerCase();
}

function atomicAmount(value, name, allowZero) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`${name} must be an atomic integer`);
  const amount = BigInt(value);
  if (!allowZero && amount === 0n) throw new Error(`${name} must be non-zero`);
  if (amount > MAX_MICROTEST_USDT) throw new Error(`${name} exceeds 3 USDT`);
  return amount;
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function assertDistinct(entries, label) {
  const seen = new Map();
  for (const [name, value] of entries) {
    const normalized = value.toLowerCase();
    const previous = seen.get(normalized);
    if (previous) throw new Error(`${label} collision: ${previous} and ${name}`);
    seen.set(normalized, name);
  }
}

function assertCoordinatedBroadcastAuthorized(coordinated) {
  if (coordinated.deploymentAuthorized !== true) {
    throw new Error('coordinated manifest does not authorize broadcast for this artifact');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(coordinated.deploymentAuthorizationEvidenceHash ?? ''))) {
    throw new Error('coordinated manifest is missing deploymentAuthorizationEvidenceHash for broadcast');
  }
  if (String(coordinated.releaseGateStatus ?? '').toUpperCase() !== 'GO') {
    throw new Error(`coordinated manifest release gate is ${coordinated.releaseGateStatus ?? 'UNSPECIFIED'}; broadcast requires GO`);
  }
}

function packetBuyerEntries(packet) {
  const structured = packet.buyers ?? packet.mainnetMicrotest?.buyers ?? packet.acceptance?.buyers;
  if (Array.isArray(structured)) {
    return structured.map((entry) => ({ label: entry?.label, wallet: entry?.wallet ?? entry?.address }));
  }
  const wallets = packet.buyerWallets ?? packet.mainnetMicrotest?.buyerWallets ?? packet.acceptance?.buyerWallets;
  const labels = packet.buyerLabels ?? packet.mainnetMicrotest?.buyerLabels ?? packet.acceptance?.buyerLabels;
  if (!Array.isArray(wallets)) return [];
  return wallets.map((wallet, index) => ({ label: Array.isArray(labels) ? labels[index] : undefined, wallet }));
}

function assertPacketBuyerLabels(packetBuyers) {
  if (packetBuyers.length !== 3) throw new Error('micro-test packet buyer labels must be exactly W5/W1/W6');
  const labelSet = new Set(packetBuyers.map((entry) => entry.label));
  if (labelSet.size !== 3 || REQUIRED_BUYER_LABELS.some((label) => !labelSet.has(label))) {
    throw new Error('micro-test packet buyer labels must be exactly W5/W1/W6 and must not include W3');
  }
}

function buyerLabel(value, name) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!REQUIRED_BUYER_LABELS.includes(normalized)) {
    throw new Error(`${name} must be exactly one of W5/W1/W6 and must not include W3`);
  }
  return normalized;
}


function readPacketBnbBudget(packet) {
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
    maxNativeValuePerTxWei: nativeDecimalToWei(requiredBudgetField(budget, ['maxNativeValuePerTxBnb', 'maxNativeValuePerTxBNB', 'maxNativeValuePerTxNative', 'maxNativeValuePerTx'], 'maxNativeValuePerTxBnb')).toString(),
    maxGasCostPerTxWei: nativeDecimalToWei(requiredBudgetField(budget, ['maxGasCostPerTxBnb', 'maxGasCostPerTxBNB', 'maxGasCostPerTx'], 'maxGasCostPerTxBnb')).toString(),
    maxTotalNativeSpendWei: nativeDecimalToWei(requiredBudgetField(budget, ['maxTotalNativeSpendBnb', 'maxTotalNativeSpendBNB', 'maxCumulativeNativeSpendBnb', 'maxTotalNativeSpend'], 'maxTotalNativeSpendBnb')).toString(),
  });
}

function assertEnvBnbBudgetWithinPacket(env, packetBudget) {
  assertBudgetLimitWithinPacket(env.MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX, 'MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX', packetBudget.maxNativeValuePerTxWei, 'packet maxNativeValuePerTxBnb');
  assertBudgetLimitWithinPacket(env.MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB, 'MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB', packetBudget.maxGasCostPerTxWei, 'packet maxGasCostPerTxBnb');
  assertBudgetLimitWithinPacket(env.MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB, 'MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB', packetBudget.maxTotalNativeSpendWei, 'packet maxTotalNativeSpendBnb');
}

function assertBudgetLimitWithinPacket(envValue, envName, packetWei, packetName) {
  const envWei = nativeDecimalToWei(envValue);
  if (envWei > BigInt(packetWei)) {
    throw new Error(`${envName} exceeds ${packetName} in the mode-600 packet`);
  }
}

function requiredBudgetField(budget, names, displayName) {
  for (const name of names) {
    if (budget[name] !== undefined && String(budget[name]).trim() !== '') return budget[name];
  }
  throw new Error(`micro-test packet BNB budget is missing ${displayName}`);
}

function nativeDecimalToWei(value) {
  const normalized = String(value ?? '').trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(normalized)) {
    throw new Error('BNB budget must be a non-negative decimal with at most 18 decimal places');
  }
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(`${fraction}000000000000000000`.slice(0, 18));
}

function normalizedUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

function redactAddress(value) {
  const normalized = getAddress(value);
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

function redactedError(error) {
  return error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://<redacted>') : 'unknown';
}
