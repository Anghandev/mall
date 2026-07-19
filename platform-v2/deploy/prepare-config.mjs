import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { JsonRpcProvider, Wallet, keccak256 } from 'ethers';

process.loadEnvFile(resolve('.env'));
process.loadEnvFile(resolve('.env.wallets.local'));

const target = resolve(process.argv[2] ?? 'output/abu24k-production-config');
const release = process.argv[3];
if (!release || !/^[0-9a-f]{7,40}$/.test(release)) throw new Error('A git commit release ID is required');
await mkdir(target, { recursive: false, mode: 0o700 });

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const secret = () => randomBytes(32).toString('hex');
const line = (name, value) => `${name}=${String(value).replaceAll('\n', '')}`;
const writeEnv = async (name, entries) => {
  const path = join(target, name);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(`${entries.join('\n')}\n`); } finally { await file.close(); }
};

const roles = [
  ['PLATFORM_TECH_PRIVATE_KEY', 'PLATFORM_GOVERNANCE_WALLET_ADDRESS'],
  ['WALLET_1_PRIVATE_KEY', 'PLATFORM_SERVICE_FEE_WALLET_ADDRESS'],
  ['WALLET_2_PRIVATE_KEY', 'USDT_SETTLEMENT_WALLET_ADDRESS'],
  ['WALLET_3_PRIVATE_KEY', 'NPL_REWARD_WALLET_ADDRESS'],
  ['WALLET_4_PRIVATE_KEY', 'OPERATIONS_GUARANTEE_WALLET_ADDRESS'],
];
for (const [key, address] of roles) {
  if (new Wallet(required(key)).address.toLowerCase() !== required(address).toLowerCase()) {
    throw new Error(`${key} does not match ${address}`);
  }
}

const rpc = required('BSC_RPC_URL');
const fallbackRpc = required('BSC_FALLBACK_RPC_URL');
const provider = new JsonRpcProvider(rpc, 56, { staticNetwork: true });
const fallbackProvider = new JsonRpcProvider(fallbackRpc, 56, { staticNetwork: true });
const [primaryNetwork, fallbackNetwork, primaryHead, fallbackHead] = await Promise.all([
  provider.getNetwork(),
  fallbackProvider.getNetwork(),
  provider.getBlockNumber(),
  fallbackProvider.getBlockNumber(),
]);
if (primaryNetwork.chainId !== 56n || fallbackNetwork.chainId !== 56n) throw new Error('BSC RPC is not chain 56');
const commonHead = Math.min(primaryHead, fallbackHead);
const [primaryBlock, fallbackBlock] = await Promise.all([
  provider.getBlock(commonHead),
  fallbackProvider.getBlock(commonHead),
]);
if (!primaryBlock?.hash || primaryBlock.hash.toLowerCase() !== fallbackBlock?.hash?.toLowerCase()) {
  throw new Error('BSC RPCs do not agree on the production cutover block');
}
const usdt = '0x55d398326f99059fF775485246999027B3197955'.toLowerCase();
const npl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2'.toLowerCase();
const [usdtCode, nplCode] = await Promise.all([provider.getCode(usdt), provider.getCode(npl)]);
if (usdtCode === '0x' || nplCode === '0x') throw new Error('Settlement token runtime code is unavailable');

const receipt = JSON.parse(await readFile(
  resolve('platform-v2/deployments/bsc-eoa-full-settlement-receipt-private.json'),
  'utf8',
));
const usdtEvidence = receipt.receipts.find((item) => item.asset === 'USDT')?.finalityEvidenceHash;
const nplEvidence = receipt.receipts.find((item) => item.asset === 'NPL')?.finalityEvidenceHash;
if (!/^0x[0-9a-f]{64}$/.test(usdtEvidence ?? '') || !/^0x[0-9a-f]{64}$/.test(nplEvidence ?? '')) {
  throw new Error('Settlement conformance evidence is unavailable');
}
const contractManifest = JSON.parse(await readFile(
  resolve('packages/core-artifacts/contracts/contract-manifest.json'),
  'utf8',
));
const routerAddress = contractManifest.contracts
  .find((contract) => contract.name === 'PaymentRouterV2')?.address?.toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(routerAddress ?? '')) throw new Error('PaymentRouter deployment is unavailable');
const receiptDirectory = resolve('platform-v2/deployments');
const routerMicrotestBlocks = [];
for (const name of await readdir(receiptDirectory)) {
  if (!name.endsWith('-receipts-private.json')) continue;
  collectRouterBlocks(
    JSON.parse(await readFile(join(receiptDirectory, name), 'utf8')),
    routerAddress,
    routerMicrotestBlocks,
  );
}
if (routerMicrotestBlocks.length === 0) throw new Error('Router microtest cutover evidence is unavailable');
const paymentIndexerStartBlock = Math.max(Math.max(...routerMicrotestBlocks), commonHead) + 1;

const databasePassword = secret();
const redisPassword = secret();
const signerToken = secret();
const settlementToken = secret();
const governanceToken = secret();
const databaseUrl = `postgres://abu24k:${databasePassword}@127.0.0.1:54329/abu24k_core`;
const auditDatabaseUrl = `postgres://abu24k:${databasePassword}@127.0.0.1:54329/abu24k_audit`;

await writeEnv('.env', [line('ABU24K_RELEASE', release)]);
await writeEnv('database.env', [
  line('POSTGRES_USER', 'abu24k'),
  line('POSTGRES_PASSWORD', databasePassword),
  line('POSTGRES_DB', 'abu24k_core'),
]);
await writeEnv('redis.env', [line('REDIS_PASSWORD', redisPassword)]);
await writeEnv('core.env', [
  line('NODE_ENV', 'production'),
  line('HOST', '127.0.0.1'),
  line('PORT', '8788'),
  line('DATABASE_URL', databaseUrl),
  line('AUDIT_DATABASE_URL', auditDatabaseUrl),
  line('REDIS_URL', `redis://:${redisPassword}@127.0.0.1:63829/0`),
  line('JWT_SECRET', secret()),
  line('AUTH_DOMAIN', 'www.npleon.com'),
  line('AUTH_URI', 'https://www.npleon.com'),
  line('PII_RETENTION_POLICY_VERSION', '2026-07-18-v1'),
  line('DELIVERY_DATA_ENCRYPTION_KEY', secret()),
  line('MERCHANT_PII_ENCRYPTION_KEY', secret()),
  line('TRACKING_HASH_KEY', secret()),
  line('BSC_RPC_URL', rpc),
  line('BSC_FALLBACK_RPC_URL', fallbackRpc),
  line('PAYMENT_INDEXER_START_BLOCK', paymentIndexerStartBlock),
  ...roles.map(([, address]) => line(address, required(address))),
  line('SIGNER_SERVICE_URL', 'http://127.0.0.1:8790/sign'),
  line('SIGNER_SERVICE_TOKEN', signerToken),
  line('SETTLEMENT_EXECUTOR_URL', 'http://127.0.0.1:8790/settlement'),
  line('SETTLEMENT_EXECUTOR_TOKEN', settlementToken),
  line('GOVERNANCE_EXECUTOR_URL', 'http://127.0.0.1:8790/governance'),
  line('GOVERNANCE_EXECUTOR_TOKEN', governanceToken),
  line('EXECUTOR_MAX_GAS_LIMIT', '1000000'),
  line('SETTLEMENT_REPLACEMENT_DELAY_MS', '300000'),
  line('USDT_TOKEN_CODE_HASH', keccak256(usdtCode)),
  line('USDT_TRANSFER_CONFORMANCE_EVIDENCE_HASH', usdtEvidence),
  line('NPL_TOKEN_CODE_HASH', keccak256(nplCode)),
  line('NPL_TRANSFER_CONFORMANCE_EVIDENCE_HASH', nplEvidence),
  line('OPERATIONS_TOKEN_CODE_HASH', keccak256(usdtCode)),
  line('OPERATIONS_TRANSFER_CONFORMANCE_EVIDENCE_HASH', usdtEvidence),
  line('BACKUP_STORAGE_ENCRYPTED', 'true'),
  line('BNM_AVAILABILITY_URL', required('BNM_AVAILABILITY_URL')),
  line('BNM_API_TOKEN', required('BNM_API_TOKEN')),
  line('BNM_PROJECT_ID', required('BNM_PROJECT_ID')),
  line('BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH', required('BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH')),
  line('MEDIA_UPLOAD_MAX_INTENTS_PER_WALLET_HOUR', '20'),
  line('MEDIA_UPLOAD_MAX_BYTES_PER_WALLET_HOUR', '104857600'),
  line('BSC_EXPLORER_API_URL', 'https://api.etherscan.io/v2/api'),
  line('EXPLORER_API_KEY', required('EXPLORER_API_KEY')),
]);
await writeEnv('eoa-runtime.env', [
  line('NODE_ENV', 'production'),
  line('HOST', '127.0.0.1'),
  line('PORT', '8790'),
  line('BSC_RPC_URL', rpc),
  line('EXECUTOR_MAX_GAS_LIMIT', '1000000'),
  line('EXECUTION_STATE_FILE', '/var/lib/abu24k/eoa-runtime-state.json'),
  line('SIGNER_SERVICE_TOKEN', signerToken),
  line('SETTLEMENT_EXECUTOR_TOKEN', settlementToken),
  line('GOVERNANCE_EXECUTOR_TOKEN', governanceToken),
  ...roles
    .filter(([key]) => key !== 'WALLET_1_PRIVATE_KEY')
    .flatMap(([key, address]) => [line(key, required(key)), line(address, required(address))]),
]);

await writeFile(join(target, 'README'), 'Generated production configuration. Keep mode 0600 and never commit or print values.\n', { mode: 0o600 });
console.log(`Prepared ${target} with mode-0600 configuration files`);

function collectRouterBlocks(value, routerAddress, blocks) {
  if (Array.isArray(value)) {
    for (const item of value) collectRouterBlocks(item, routerAddress, blocks);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (
    typeof value.to === 'string'
    && value.to.toLowerCase() === routerAddress
    && Number.isSafeInteger(value.blockNumber)
    && value.blockNumber > 0
  ) blocks.push(value.blockNumber);
  for (const child of Object.values(value)) collectRouterBlocks(child, routerAddress, blocks);
}
