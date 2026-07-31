import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Interface, JsonRpcProvider, Wallet, getAddress, keccak256 } from 'ethers';
import { validateRouterCutover } from './router-cutover.mjs';

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
const sha256 = (value) => `0x${createHash('sha256').update(value).digest('hex')}`;
const runtimeConfigHash = (entries) => sha256(`${entries.join('\n')}\n`);
const requiredSha256 = (name) => {
  const normalized = String(required(name)).trim().toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(normalized)) return normalized;
  if (/^[0-9a-f]{64}$/.test(normalized)) return `0x${normalized}`;
  throw new Error(`${name} must be a SHA-256 hash`);
};
const optionalSha256 = (name) => {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(normalized)) return normalized;
  if (/^[0-9a-f]{64}$/.test(normalized)) return `0x${normalized}`;
  throw new Error(`${name} must be a SHA-256 hash`);
};
const requiredImageDigest = (name) => {
  const value = required(name).trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be sha256:<64 hex>`);
  return value;
};
const writeEnv = async (name, entries) => {
  const path = join(target, name);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(`${entries.join('\n')}\n`); } finally { await file.close(); }
};

function assertDistinctRoleWallets(entries) {
  const seen = new Map();
  for (const [name, value] of entries) {
    let normalized;
    try {
      normalized = getAddress(value).toLowerCase();
    } catch {
      throw new Error(`${name} is invalid`);
    }
    const previous = seen.get(normalized);
    if (previous) throw new Error(`Production role wallet collision: ${previous} and ${name}`);
    seen.set(normalized, name);
  }
}

const signingRoles = [
  ['PLATFORM_TECH_PRIVATE_KEY', 'PLATFORM_GOVERNANCE_WALLET_ADDRESS'],
  ['WALLET_2_PRIVATE_KEY', 'USDT_SETTLEMENT_WALLET_ADDRESS'],
  ['WALLET_3_PRIVATE_KEY', 'NPL_REWARD_WALLET_ADDRESS'],
  ['WALLET_4_PRIVATE_KEY', 'OPERATIONS_GUARANTEE_WALLET_ADDRESS'],
];
const roleAddresses = [
  'PLATFORM_GOVERNANCE_WALLET_ADDRESS',
  'PLATFORM_SERVICE_FEE_WALLET_ADDRESS',
  'USDT_SETTLEMENT_WALLET_ADDRESS',
  'NPL_REWARD_WALLET_ADDRESS',
  'OPERATIONS_GUARANTEE_WALLET_ADDRESS',
];
for (const [key, address] of signingRoles) {
  if (new Wallet(required(key)).address.toLowerCase() !== required(address).toLowerCase()) {
    throw new Error(`${key} does not match ${address}`);
  }
}
assertDistinctRoleWallets(roleAddresses.map((name) => [name, required(name)]));

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
if (
  contractManifest.deploymentStatus !== 'DEPLOYED'
  || contractManifest.deploymentArtifactVersion !== contractManifest.artifactVersion
  || contractManifest.contracts.some((contract) => (
    contract.status !== 'DEPLOYED'
    || typeof contract.runtimeBytecodeHash !== 'string'
    || !contractRuntimeMatchesDeployment(contract)
  ))
) {
  throw new Error('Current contract artifact is not deployed; redeploy and regenerate the manifest before preparing production config');
}
const routerAddress = contractManifest.contracts
  .find((contract) => contract.name === 'PaymentRouterV2')?.address?.toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(routerAddress ?? '')) throw new Error('PaymentRouter deployment is unavailable');
const routerDeploymentBlock = contractManifest.contracts
  .find((contract) => contract.name === 'PaymentRouterV2')?.deploymentBlock;
const routerDeployedCodeHash = contractManifest.contracts
  .find((contract) => contract.name === 'PaymentRouterV2')?.deployedCodeHash?.toLowerCase();
if (!Number.isSafeInteger(routerDeploymentBlock) || routerDeploymentBlock <= 0) {
  throw new Error('PaymentRouter deployment block is unavailable');
}
if (!/^0x[0-9a-f]{64}$/.test(routerDeployedCodeHash ?? '')) {
  throw new Error('PaymentRouter deployed code hash is unavailable');
}
const deploymentEvidence = JSON.parse(await readFile(
  resolve('platform-v2/deployments/bsc-payment-v2.json'),
  'utf8',
));
const cutover = validateRouterCutover(deploymentEvidence.routerCutover, {
  activeRouter: routerAddress,
  platformServiceFeeWallet: required('PLATFORM_SERVICE_FEE_WALLET_ADDRESS'),
  deploymentBlock: routerDeploymentBlock,
  deployedCodeHash: routerDeployedCodeHash,
});
if (routerDeploymentBlock > commonHead) throw new Error('Router deployment is above the agreed RPC head');
const [primaryReceipt, fallbackReceipt, primaryRouterCode, fallbackRouterCode] = await Promise.all([
  provider.getTransactionReceipt(cutover.deploymentTxHash),
  fallbackProvider.getTransactionReceipt(cutover.deploymentTxHash),
  provider.getCode(routerAddress, commonHead),
  fallbackProvider.getCode(routerAddress, commonHead),
]);
if (
  !primaryReceipt || !fallbackReceipt
  || primaryReceipt.status !== 1 || fallbackReceipt.status !== 1
  || primaryReceipt.contractAddress?.toLowerCase() !== routerAddress
  || fallbackReceipt.contractAddress?.toLowerCase() !== routerAddress
  || primaryReceipt.blockNumber !== routerDeploymentBlock
  || fallbackReceipt.blockNumber !== routerDeploymentBlock
  || primaryReceipt.blockHash.toLowerCase() !== fallbackReceipt.blockHash.toLowerCase()
  || primaryRouterCode === '0x' || primaryRouterCode !== fallbackRouterCode
  || keccak256(primaryRouterCode).toLowerCase() !== routerDeployedCodeHash
) throw new Error('Router cutover receipt or runtime code does not match the coordinated manifest');
const recipientCall = new Interface(['function platformServiceFeeWallet() view returns (address)'])
  .encodeFunctionData('platformServiceFeeWallet');
const [primaryRecipient, fallbackRecipient] = await Promise.all([
  provider.call({ to: routerAddress, data: recipientCall }, commonHead),
  fallbackProvider.call({ to: routerAddress, data: recipientCall }, commonHead),
]);
const decodedRecipient = new Interface(['function platformServiceFeeWallet() view returns (address)'])
  .decodeFunctionResult('platformServiceFeeWallet', primaryRecipient)[0].toLowerCase();
if (
  primaryRecipient !== fallbackRecipient
  || decodedRecipient !== required('PLATFORM_SERVICE_FEE_WALLET_ADDRESS').toLowerCase()
) throw new Error('Router service-fee recipient does not match production configuration');

function contractRuntimeMatchesDeployment(contract) {
  const deployedCodeHash = String(contract.deployedCodeHash ?? '').toLowerCase();
  const runtimeBytecodeHash = String(contract.runtimeBytecodeHash ?? '').toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(deployedCodeHash) && runtimeBytecodeHash === deployedCodeHash) return true;
  const normalizedRuntime = String(contract.normalizedRuntimeBytecodeHash ?? '').toLowerCase();
  const deployedNormalizedRuntime = String(contract.deployedNormalizedRuntimeBytecodeHash ?? '').toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalizedRuntime)
    && normalizedRuntime === deployedNormalizedRuntime;
}

const databasePassword = secret();
const redisPassword = secret();
const signerToken = secret();
const settlementToken = secret();
const governanceToken = secret();
const mediaStorageToken = secret();
const mediaStorageSigningKey = secret();
const mediaStorageEncryptionKey = secret();
const databaseUrl = `postgres://abu24k:${databasePassword}@127.0.0.1:54329/abu24k_core`;
const auditDatabaseUrl = `postgres://abu24k:${databasePassword}@127.0.0.1:54329/abu24k_audit`;
const redisUrl = `redis://:${redisPassword}@127.0.0.1:63829/0`;
const releaseGitCommit = required('RELEASE_GIT_COMMIT').trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(releaseGitCommit) || !releaseGitCommit.startsWith(release)) {
  throw new Error('RELEASE_GIT_COMMIT must be the full commit for the ABU24K_RELEASE image tag');
}
const releaseImageDigest = requiredImageDigest('RELEASE_IMAGE_DIGEST');
const releaseAuthorizationPath = required('RELEASE_AUTHORIZATION_PATH');
const releaseAuthorizationSha256 = requiredSha256('RELEASE_AUTHORIZATION_SHA256');
const releaseAuthorizationSigner = getAddress(required('RELEASE_AUTHORIZATION_SIGNER_ADDRESS'));
const releasePacketSha256 = requiredSha256('MAINNET_MICROTEST_PACKET_SHA256');
const releaseEvidenceArchiveSha256 = requiredSha256('RELEASE_EVIDENCE_ARCHIVE_SHA256');

await writeEnv('.env', [line('ABU24K_RELEASE', release), line('ABU24K_RELEASE_IMAGE_DIGEST', releaseImageDigest)]);
await writeEnv('database.env', [
  line('POSTGRES_USER', 'abu24k'),
  line('POSTGRES_PASSWORD', databasePassword),
  line('POSTGRES_DB', 'abu24k_core'),
]);
await writeEnv('redis.env', [line('REDIS_PASSWORD', redisPassword)]);
const coreRuntimeEntries = [
  line('NODE_ENV', 'production'),
  line('HOST', '127.0.0.1'),
  line('PORT', '8788'),
  line('DATABASE_URL', databaseUrl),
  line('AUDIT_DATABASE_URL', auditDatabaseUrl),
  line('REDIS_URL', redisUrl),
  line('QUEUE_URL', redisUrl),
  line('JWT_SECRET', secret()),
  line('AUTH_DOMAIN', 'www.npleon.com'),
  line('AUTH_URI', 'https://www.npleon.com'),
  line('PII_RETENTION_POLICY_VERSION', '2026-07-18-v1'),
  line('DELIVERY_DATA_ENCRYPTION_KEY', secret()),
  line('MERCHANT_PII_ENCRYPTION_KEY', secret()),
  line('TRACKING_HASH_KEY', secret()),
  line('BSC_RPC_URL', rpc),
  line('BSC_FALLBACK_RPC_URL', fallbackRpc),
  ...roleAddresses.map((address) => line(address, required(address))),
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
  line('MEDIA_STORAGE_SIGNER_URL', 'http://127.0.0.1:8791'),
  line('MEDIA_STORAGE_SIGNER_TOKEN', mediaStorageToken),
  line('MEDIA_UPLOAD_MAX_INTENTS_PER_WALLET_HOUR', '20'),
  line('MEDIA_UPLOAD_MAX_BYTES_PER_WALLET_HOUR', '104857600'),
  line('BSC_EXPLORER_API_URL', 'https://api.etherscan.io/v2/api'),
  line('EXPLORER_API_KEY', required('EXPLORER_API_KEY')),
 ];
const computedRuntimeConfigSha256 = runtimeConfigHash(coreRuntimeEntries);
const expectedRuntimeConfigSha256 = optionalSha256('RELEASE_RUNTIME_CONFIG_SHA256');
if (expectedRuntimeConfigSha256 && expectedRuntimeConfigSha256 !== computedRuntimeConfigSha256) {
  throw new Error('RELEASE_RUNTIME_CONFIG_SHA256 does not match the generated Core runtime configuration');
}
const releaseRuntimeConfigSha256 = expectedRuntimeConfigSha256 ?? computedRuntimeConfigSha256;
const coreReleaseEntries = [
  line('RELEASE_AUTHORIZATION_PATH', releaseAuthorizationPath),
  line('RELEASE_AUTHORIZATION_SHA256', releaseAuthorizationSha256),
  line('RELEASE_AUTHORIZATION_SIGNER_ADDRESS', releaseAuthorizationSigner),
  line('RELEASE_GIT_COMMIT', releaseGitCommit),
  line('RELEASE_IMAGE_DIGEST', releaseImageDigest),
  line('RELEASE_RUNTIME_CONFIG_SHA256', releaseRuntimeConfigSha256),
  line('MAINNET_MICROTEST_PACKET_SHA256', releasePacketSha256),
  line('RELEASE_EVIDENCE_ARCHIVE_SHA256', releaseEvidenceArchiveSha256),
];
await writeEnv('core.env', [...coreRuntimeEntries, ...coreReleaseEntries]);
await writeFile(join(target, 'core-runtime-config.sha256'), `${releaseRuntimeConfigSha256}  core.env\n`, { mode: 0o600 });
await writeEnv('eoa-runtime.env', [
  line('NODE_ENV', 'production'),
  line('HOST', '127.0.0.1'),
  line('PORT', '8790'),
  line('BSC_RPC_URL', rpc),
  line('BSC_FALLBACK_RPC_URL', fallbackRpc),
  line('EXECUTOR_MAX_GAS_LIMIT', '1000000'),
  line('EXECUTION_STATE_FILE', '/var/lib/abu24k/eoa-runtime-state.json'),
  line('SIGNER_SERVICE_TOKEN', signerToken),
  line('SETTLEMENT_EXECUTOR_TOKEN', settlementToken),
  line('GOVERNANCE_EXECUTOR_TOKEN', governanceToken),
  line('PLATFORM_SERVICE_FEE_WALLET_ADDRESS', required('PLATFORM_SERVICE_FEE_WALLET_ADDRESS')),
  ...signingRoles
    .flatMap(([key, address]) => [line(key, required(key)), line(address, required(address))]),
]);
await writeEnv('media-storage.env', [
  line('NODE_ENV', 'production'),
  line('MEDIA_STORAGE_HOST', '127.0.0.1'),
  line('MEDIA_STORAGE_PORT', '8791'),
  line('MEDIA_STORAGE_ROOT', '/var/lib/abu24k-media'),
  line('MEDIA_STORAGE_PUBLIC_BASE_URL', 'https://www.npleon.com'),
  line('MEDIA_STORAGE_SIGNER_TOKEN', mediaStorageToken),
  line('MEDIA_STORAGE_URL_SIGNING_KEY', mediaStorageSigningKey),
  line('MEDIA_STORAGE_ENCRYPTION_KEY', mediaStorageEncryptionKey),
]);

await writeFile(join(target, 'README'), 'Generated production configuration. Keep mode 0600 and never commit or print values.\n', { mode: 0o600 });
console.log(`Prepared ${target} with mode-0600 configuration files`);
