#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const strict = process.argv.includes('--strict') || process.env.DAPP_PROD_STRICT === 'true';
const envFile = argValue('--file') || process.env.DAPP_PROD_ENV_FILE || '.env';
const fileEnv = parseEnvFile(envFile);
const env = process.argv.includes('--allow-process-env') ? { ...fileEnv, ...process.env } : fileEnv;
const checks = [];

check('BSC chain id is 56', chainId() === '56', 'Set EXPO_PUBLIC_BSC_CHAIN_ID=56 or CHAIN_ID=56.');
check('NPL address is fixed docs contract', lower(env.EXPO_PUBLIC_NPL_BSC_ADDRESS || fixedNpl) === fixedNpl, `Set EXPO_PUBLIC_NPL_BSC_ADDRESS=${fixedNpl}.`);
const legacyUsdtKeys = [
  'EXPO_PUBLIC_USDT_BSC_ADDRESS',
  'USDT_BSC_ADDRESS',
  'MICRO_SECKILL_PRIZE_POOL_USDT',
  'MICRO_FUND_TX_USDT_AMOUNT',
  'MICRO_SMOKE_USDT_AMOUNT',
  'MAX_MICRO_USDT_AMOUNT'
].filter((key) => hasValue(env[key]));
check('No legacy USDT payment configuration', legacyUsdtKeys.length === 0, 'Remove legacy USDT payment variables; production settlement is NPL-only.');

check('Escrow contract address configured', isAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS), 'Deploy Abu24KPaymentEscrow and set EXPO_PUBLIC_ESCROW_ADDRESS.');
check('Seckill contract address configured', isAddress(env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS), 'Deploy Abu24KSeckill and set EXPO_PUBLIC_SECKILL_ADDRESS.');
check('BNM token address configured', isAddress(env.EXPO_PUBLIC_BNM_BSC_ADDRESS), 'Deploy BNMToken and set EXPO_PUBLIC_BNM_BSC_ADDRESS.');
check('RewardLedger address configured', isAddress(env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS), 'Deploy Abu24KRewardLedger and set EXPO_PUBLIC_REWARD_LEDGER_ADDRESS.');
check('Genesis node credential contract configured', isAddress(env.GENESIS_NODE_CONTRACT), 'Set GENESIS_NODE_CONTRACT to the production NFT/SFT credential contract.');
const genesisStandard = String(env.GENESIS_NODE_TOKEN_STANDARD || 'erc721').toLowerCase();
check('Genesis credential token standard is supported', ['erc20', 'erc721', 'erc1155'].includes(genesisStandard), 'Set GENESIS_NODE_TOKEN_STANDARD to erc20, erc721 or erc1155.');
check('ERC1155 genesis credential token id configured', genesisStandard !== 'erc1155' || isUint(env.GENESIS_NODE_TOKEN_ID), 'Set GENESIS_NODE_TOKEN_ID to the ERC1155/SFT credential token id.');
check('Seckill max gas price configured', isPositiveUint(env.SECKILL_MAX_GAS_PRICE_WEI), 'Set SECKILL_MAX_GAS_PRICE_WEI to the reviewed non-zero chain gas ceiling.');
check('Merchant receiver wallet configured', isAddress(env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS), 'Set MERCHANT_RECEIVER_ADDRESS to the approved merchant settlement wallet.');
check('Admin SIWE wallet configured', isAddress(env.ADMIN_WALLET_ADDRESS), 'Set ADMIN_WALLET_ADDRESS; admin SIWE is closed without it.');
check('Order signer address configured', isAddress(env.ORDER_SIGNER_ADDRESS), 'Set ORDER_SIGNER_ADDRESS to the external EIP-712 signer address configured in Escrow.');
check('Escrow split version configured', isPositiveInteger(env.ESCROW_SPLIT_VERSION), 'Set ESCROW_SPLIT_VERSION to Escrow.currentSplitVersion().');
check('Escrow multisig owner configured', isAddress(env.ESCROW_OWNER_ADDRESS), 'Set ESCROW_OWNER_ADDRESS to the production multisig.');
check('RewardLedger multisig owner configured', isAddress(env.REWARDS_OWNER_ADDRESS), 'Set REWARDS_OWNER_ADDRESS to the production multisig.');
check('Seckill multisig owner configured', isAddress(env.SECKILL_OWNER_ADDRESS), 'Set SECKILL_OWNER_ADDRESS to the production multisig.');

check('Indexer secret is at least 32 characters', strongSecret(env.INDEXER_SECRET), 'Set a unique INDEXER_SECRET with at least 32 characters.');
check('JWT secret is at least 32 characters', strongSecret(env.JWT_SECRET), 'Set a unique JWT_SECRET with at least 32 characters.');
check('Admin read secret is at least 32 characters', strongSecret(env.ADMIN_SECRET), 'Set a unique ADMIN_SECRET with at least 32 characters.');
check('JWT/Admin/Indexer secrets are distinct', distinctValues([env.JWT_SECRET, env.ADMIN_SECRET, env.INDEXER_SECRET]), 'Use three different values for JWT_SECRET, ADMIN_SECRET and INDEXER_SECRET.');
check('Production DB path is absolute', hasValue(env.DB_PATH) && isAbsolute(env.DB_PATH), 'Set DB_PATH to an absolute path on persistent storage, for example /var/lib/24k/24k.db.');
check('Independent audit DB path is absolute', hasValue(env.AUDIT_DB_PATH) && isAbsolute(env.AUDIT_DB_PATH), 'Set AUDIT_DB_PATH to a separate absolute path, for example /var/lib/24k-audit/audit.db.');
check('Audit DB is separate from business DB', hasValue(env.AUDIT_DB_PATH) && hasValue(env.DB_PATH) && env.AUDIT_DB_PATH !== env.DB_PATH, 'AUDIT_DB_PATH must not equal DB_PATH.');
check('Logistics callback secret is at least 32 characters', strongSecret(env.LOGISTICS_CALLBACK_SECRET), 'Set LOGISTICS_CALLBACK_SECRET with at least 32 characters.');
check('CORS origins configured', hasValue(env.CORS_ORIGINS), 'Set CORS_ORIGINS to the exact HTTPS frontend origin list.');
check('Order signing webhook token configured', hasValue(env.ORDER_SIGNING_WEBHOOK_TOKEN), 'Set ORDER_SIGNING_WEBHOOK_TOKEN for the external signer service.');
check('Order signing webhook URL configured', hasValue(env.ORDER_SIGNING_WEBHOOK_URL), 'Set ORDER_SIGNING_WEBHOOK_URL; the production API must not hold the signer private key.');
check('Order signing webhook URL uses HTTPS or local dev URL', isHttpsOrLocal(env.ORDER_SIGNING_WEBHOOK_URL), 'Use HTTPS for the deployed order signer webhook.');
check('Strict production order signing webhook URL is HTTPS', !strict || isHttps(env.ORDER_SIGNING_WEBHOOK_URL), 'In --strict production mode, ORDER_SIGNING_WEBHOOK_URL must be HTTPS.');
check('AMap web-service key configured', hasValue(env.AMAP_WEB_SERVICE_KEY || env.AMAP_API_KEY), 'Set AMAP_WEB_SERVICE_KEY for reverse geocoding and region binding.');
for (const service of [
  ['Electronic waybill', env.ELECTRONIC_WAYBILL_WEBHOOK_URL || env.WAYBILL_WEBHOOK_URL, env.ELECTRONIC_WAYBILL_WEBHOOK_TOKEN || env.WAYBILL_WEBHOOK_TOKEN],
  ['Shipment query', env.SHIPMENT_WEBHOOK_URL, env.SHIPMENT_WEBHOOK_TOKEN],
  ['Cloud print', env.PRINT_WEBHOOK_URL || env.CLOUD_PRINT_WEBHOOK_URL, env.PRINT_WEBHOOK_TOKEN || env.CLOUD_PRINT_WEBHOOK_TOKEN],
  ['Notification', env.NOTIFICATION_WEBHOOK_URL, env.NOTIFICATION_WEBHOOK_TOKEN]
]) {
  const [label, url, token] = service;
  check(`${label} webhook URL configured`, hasValue(url), `Set the ${label} webhook URL.`);
  check(`${label} webhook token configured`, strongSecret(token), `Set the ${label} webhook token with at least 32 characters.`);
  check(`${label} webhook uses HTTPS`, !strict || isHttps(url), `Use HTTPS for the production ${label} webhook.`);
}
check('Server-side chain event RPC configured', hasValue(env.CHAIN_EVENT_RPC_URL || env.BSC_RPC_URL), 'Set CHAIN_EVENT_RPC_URL or BSC_RPC_URL for receipt verification and polling.');
check('Unverified chain events disabled', String(env.ALLOW_UNVERIFIED_CHAIN_EVENTS || '').toLowerCase() !== 'true', 'Set ALLOW_UNVERIFIED_CHAIN_EVENTS=false in production.');
check('Indexer waits at least 12 confirmations', Number.isSafeInteger(Number(env.INDEXER_CONFIRMATIONS)) && Number(env.INDEXER_CONFIRMATIONS) >= 12, 'Set INDEXER_CONFIRMATIONS=15 or higher for BSC event finality.');
check('Unfinalized indexer override disabled', String(env.INDEXER_ALLOW_UNFINALIZED || '').toLowerCase() !== 'true', 'Remove INDEXER_ALLOW_UNFINALIZED or set it to false in production.');
check('Explorer API key configured for height monitoring', hasValue(env.EXPLORER_API_KEY || env.BSCSCAN_API_KEY), 'Set EXPLORER_API_KEY for RPC-vs-explorer block-height monitoring.');

const publicApi = env.DAPP_BASE_URL || env.EXPO_PUBLIC_API_BASE_URL || '';
const walletEntryUrl = env.DAPP_ENTRY_URL || env.FRONTEND_URL || env.DAPP_QR_URL || publicApi;
check('Public DApp/API URL configured', hasValue(publicApi), 'Set DAPP_BASE_URL or EXPO_PUBLIC_API_BASE_URL to the HTTPS backend URL used by the DApp.');
check('Public DApp/API URL uses HTTPS or local dev URL', isHttpsOrLocal(publicApi), 'Use HTTPS for deployed backend access; localhost/LAN is only acceptable for local tests.');
check('Wallet browser entry URL configured', hasValue(walletEntryUrl), 'Set DAPP_ENTRY_URL or FRONTEND_URL to the HTTPS URL users open in wallet/DApp browser.');
check('Wallet browser entry URL uses HTTPS or local dev URL', isHttpsOrLocal(walletEntryUrl), 'Use HTTPS for deployed wallet-browser entry; localhost/LAN is only acceptable for local tests.');
check('Strict production API URL is HTTPS', !strict || isHttps(publicApi), 'In --strict production mode, DAPP_BASE_URL / EXPO_PUBLIC_API_BASE_URL must be HTTPS.');
check('Strict production wallet entry URL is HTTPS', !strict || isHttps(walletEntryUrl), 'In --strict production mode, DAPP_ENTRY_URL / FRONTEND_URL must be HTTPS.');
check('Server FRONTEND_URL is HTTPS', isHttps(env.FRONTEND_URL), 'Set FRONTEND_URL to the production HTTPS frontend origin.');
if (hasValue(env.DAPP_QR_URL)) {
  check('DApp QR URL uses HTTPS or local dev URL', isHttpsOrLocal(env.DAPP_QR_URL), 'Set DAPP_QR_URL to an HTTPS domain, tunnel URL, or local LAN URL.');
  check('Strict production QR URL is HTTPS', !strict || isHttps(env.DAPP_QR_URL), 'In --strict production mode, DAPP_QR_URL must be HTTPS.');
}
check('Reown project id configured for wallet UI', hasValue(env.EXPO_PUBLIC_REOWN_PROJECT_ID), 'Set EXPO_PUBLIC_REOWN_PROJECT_ID for wallet connection UI.');

const privateKeyNames = ['PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY', 'OWNER_PRIVATE_KEY'].filter((name) => hasValue(env[name]));
check('No private key in production server env', privateKeyNames.length === 0, 'Production DApp server must not carry PRIVATE_KEY, DEPLOYER_PRIVATE_KEY or OWNER_PRIVATE_KEY.');

const failed = checks.filter((entry) => entry.level === 'fail');
const warnings = checks.filter((entry) => entry.level === 'warn');
const summary = {
  ok: failed.length === 0,
  strict,
  envFile,
  failed: failed.length,
  warnings: warnings.length,
  fixedNpl,
  urls: {
    publicApi,
    walletEntryUrl,
    launchKit: publicApi ? absoluteUrl(publicApi, '/api/dapp/launch-kit?address=0x...') : '',
    handoff: publicApi ? absoluteUrl(publicApi, '/api/dapp/handoff?address=0x...') : '',
    frontendBrief: publicApi ? absoluteUrl(publicApi, '/api/dapp/frontend-brief.md?address=0x...') : '',
    qrUrl: env.DAPP_QR_URL || walletEntryUrl || ''
  },
  checks
};

console.log(JSON.stringify(summary, null, 2));
if (failed.length) process.exit(1);

function check(name, ok, fix) {
  const level = ok ? 'pass' : (strict ? 'fail' : 'warn');
  checks.push({ name, level, fix: ok ? undefined : fix });
}

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  const parsed = {};
  const source = readFileSync(file, 'utf8');
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function chainId() {
  return String(env.EXPO_PUBLIC_BSC_CHAIN_ID || env.CHAIN_ID || '56');
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/^<[^>]+>$/.test(value.trim());
}

function strongSecret(value) {
  return hasValue(value) && String(value).trim().length >= 32;
}

function distinctValues(values) {
  return values.every(strongSecret) && new Set(values.map((value) => String(value).trim())).size === values.length;
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

function isPositiveInteger(value) {
  return /^[1-9][0-9]*$/.test(String(value || '')) && Number(value) <= 0xffffffff;
}

function isPositiveUint(value) {
  return /^[1-9][0-9]*$/.test(String(value || ''));
}

function isUint(value) {
  return /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(String(value || ''));
}

function isHttpsOrLocal(value) {
  if (!hasValue(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname) || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname);
  } catch {
    return false;
  }
}

function isHttps(value) {
  if (!hasValue(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function absoluteUrl(base, pathname) {
  try {
    return new URL(pathname, `${String(base).replace(/\/+$/, '')}/`).toString();
  } catch {
    return '';
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}
