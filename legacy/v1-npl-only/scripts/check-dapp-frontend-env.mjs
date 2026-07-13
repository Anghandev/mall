#!/usr/bin/env node
import fs from 'node:fs';
import { dirname } from 'node:path';
import { readEnvFile } from './microtest/env-utils.mjs';

const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const strict = process.argv.includes('--strict') || process.env.DAPP_FRONTEND_ENV_STRICT === 'true';
const shouldFetch = process.argv.includes('--fetch') || process.env.DAPP_FRONTEND_ENV_FETCH === 'true';
const file = argValue('--file') || process.env.DAPP_FRONTEND_ENV_FILE || 'test-artifacts/dapp-frontend.env';
const reportFile = process.env.DAPP_FRONTEND_ENV_CHECK_REPORT || 'test-artifacts/dapp-frontend-env-check.report.json';
const checks = [];
let apiBaseUrl = '';
let entryUrl = '';

if (!fs.existsSync(file)) {
  check('Frontend env file exists', false, `Run pnpm dapp:frontend-env first or set DAPP_FRONTEND_ENV_FILE. Missing: ${file}`);
  finish();
}

const source = fs.readFileSync(file, 'utf8');
const env = readEnvFile(file);
check('Frontend env file exists', true);
check('No PRIVATE_KEY or server secrets are present', noForbiddenSecrets(source), 'Remove PRIVATE_KEY / INDEXER_SECRET / ADMIN_SECRET / JWT_SECRET / raw server RPC secrets from the frontend env.');
check('BSC chain id is 56', value(env.EXPO_PUBLIC_BSC_CHAIN_ID || env.NEXT_PUBLIC_BSC_CHAIN_ID || env.VITE_BSC_CHAIN_ID) === '56', 'Set BSC chain id to 56.');
check('NPL address is fixed docs contract', lower(env.EXPO_PUBLIC_NPL_BSC_ADDRESS || env.NEXT_PUBLIC_24K_NPL_ADDRESS || env.VITE_24K_NPL_ADDRESS) === fixedNpl, `Set NPL to ${fixedNpl}.`);

apiBaseUrl = env.EXPO_PUBLIC_24K_API_BASE_URL || env.EXPO_PUBLIC_API_BASE_URL || env.NEXT_PUBLIC_24K_API_BASE_URL || env.VITE_24K_API_BASE_URL || '';
entryUrl = env.EXPO_PUBLIC_24K_DAPP_ENTRY_URL || env.NEXT_PUBLIC_24K_DAPP_ENTRY_URL || env.VITE_24K_DAPP_ENTRY_URL || '';
check('API base URL configured', isUrl(apiBaseUrl), 'Set EXPO_PUBLIC_24K_API_BASE_URL / NEXT_PUBLIC_24K_API_BASE_URL / VITE_24K_API_BASE_URL.');
check('API base URL uses HTTPS or local dev URL', isHttpsOrLocal(apiBaseUrl), 'Use HTTPS for deployed DApp API; localhost/LAN is only for local testing.');
check('Wallet browser entry URL configured', isUrl(entryUrl), 'Set EXPO_PUBLIC_24K_DAPP_ENTRY_URL / NEXT_PUBLIC_24K_DAPP_ENTRY_URL / VITE_24K_DAPP_ENTRY_URL.');
check('Wallet browser entry URL uses HTTPS or local dev URL', isHttpsOrLocal(entryUrl), 'Use HTTPS for deployed DEX/wallet browser entry; localhost/LAN is only for local testing.');
check('Strict wallet browser entry URL is HTTPS', !strict || isHttps(entryUrl), 'For production/Dex browser use, set the entry URL to HTTPS.');

check('Reown project id configured', !isPlaceholder(env.EXPO_PUBLIC_REOWN_PROJECT_ID || env.NEXT_PUBLIC_REOWN_PROJECT_ID || env.VITE_REOWN_PROJECT_ID), 'Set Reown project id for wallet connection UI.');
check('Escrow address configured', isAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS || env.NEXT_PUBLIC_24K_ESCROW_ADDRESS || env.VITE_24K_ESCROW_ADDRESS), 'Set deployed Abu24KPaymentEscrow address.');
check('Seckill address configured', isAddress(env.EXPO_PUBLIC_SECKILL_ADDRESS || env.NEXT_PUBLIC_24K_SECKILL_ADDRESS || env.VITE_24K_SECKILL_ADDRESS), 'Set deployed Abu24KSeckill address when ready.');
check('BNM address configured', isAddress(env.EXPO_PUBLIC_BNM_BSC_ADDRESS || env.NEXT_PUBLIC_24K_BNM_ADDRESS || env.VITE_24K_BNM_ADDRESS), 'Set deployed BNMToken address when ready.');
check('RewardLedger address configured', isAddress(env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.NEXT_PUBLIC_24K_REWARD_LEDGER_ADDRESS || env.VITE_24K_REWARD_LEDGER_ADDRESS), 'Set deployed Abu24KRewardLedger address when ready.');

const endpointChecks = [
  ['Handoff URL', env.EXPO_PUBLIC_24K_HANDOFF_URL, '/api/dapp/handoff'],
  ['Frontend brief URL', env.EXPO_PUBLIC_24K_FRONTEND_BRIEF_URL, '/api/dapp/frontend-brief.md'],
  ['Launch kit URL', env.EXPO_PUBLIC_24K_LAUNCH_KIT_URL, '/api/dapp/launch-kit'],
  ['Bootstrap URL', env.EXPO_PUBLIC_24K_BOOTSTRAP_URL, '/api/dapp/bootstrap'],
  ['OpenAPI URL', env.EXPO_PUBLIC_24K_OPENAPI_URL, '/api/dapp/openapi.json'],
  ['Types URL', env.EXPO_PUBLIC_24K_TYPES_URL, '/api/dapp/types.d.ts'],
  ['SDK URL', env.EXPO_PUBLIC_24K_SDK_URL, '/api/dapp/sdk.ts']
];
for (const [name, url, path] of endpointChecks) {
  check(`${name} configured`, isUrl(url), `Set ${name} to ${path}.`);
  check(`${name} points to ${path}`, !url || String(url).includes(path), `Set ${name} to a URL containing ${path}.`);
}

if (shouldFetch) {
  await fetchCheck('Readiness endpoint fetches', absoluteUrl(apiBaseUrl, '/api/dapp/readiness'), 'application/json');
  await fetchCheck('Bootstrap endpoint fetches', env.EXPO_PUBLIC_24K_BOOTSTRAP_URL || absoluteUrl(apiBaseUrl, '/api/dapp/bootstrap'), 'application/json');
  await fetchCheck('OpenAPI endpoint fetches', env.EXPO_PUBLIC_24K_OPENAPI_URL || absoluteUrl(apiBaseUrl, '/api/dapp/openapi.json'), 'application/json');
  await fetchCheck('SDK endpoint fetches', env.EXPO_PUBLIC_24K_SDK_URL || absoluteUrl(apiBaseUrl, '/api/dapp/sdk.ts'), 'text');
}

finish();

async function fetchCheck(name, url, expectedKind) {
  if (!isUrl(url)) return check(name, false, `Invalid URL: ${url}`);
  try {
    const response = await fetch(url);
    const text = await response.text();
    const ok = response.ok && (expectedKind === 'application/json' ? looksJson(text) : text.length > 100);
    check(name, ok, `Fetch failed or response shape mismatch: ${url}`);
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : `Fetch failed: ${url}`);
  }
}

function finish() {
  const failed = checks.filter((entry) => entry.level === 'fail');
  const warnings = checks.filter((entry) => entry.level === 'warn');
  const summary = {
    ok: failed.length === 0,
    strict,
    fetch: shouldFetch,
    file,
    failed: failed.length,
    warnings: warnings.length,
    fixedNpl,
    apiBaseUrl,
    entryUrl,
    checks
  };
  fs.mkdirSync(dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length) process.exit(1);
}

function check(name, ok, fix = undefined) {
  const level = ok ? 'pass' : (strict ? 'fail' : 'warn');
  checks.push({ name, level, fix: ok ? undefined : fix });
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function noForbiddenSecrets(text) {
  return ![/^PRIVATE_KEY=/m, /^INDEXER_SECRET=/m, /^ADMIN_SECRET=/m, /^JWT_SECRET=/m, /^BSC_RPC_URL=/m, /^ETH_RPC_URL=/m, /^BASE_RPC_URL=/m, /^EXPLORER_API_KEY=/m, /^ETHERSCAN_API_KEY=/m, /^BSCSCAN_API_KEY=/m, /^BASESCAN_API_KEY=/m].some((pattern) => pattern.test(text));
}

function value(input) {
  return String(input || '').trim();
}

function lower(input) {
  return value(input).toLowerCase();
}

function isPlaceholder(input) {
  const raw = value(input);
  return !raw || /^<[^>]+>$/.test(raw);
}

function isAddress(input) {
  return /^0x[a-fA-F0-9]{40}$/.test(value(input));
}

function isUrl(input) {
  try {
    const url = new URL(value(input));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttps(input) {
  try {
    return new URL(value(input)).protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttpsOrLocal(input) {
  try {
    const url = new URL(value(input));
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname) || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname);
  } catch {
    return false;
  }
}

function absoluteUrl(base, path) {
  if (!isUrl(base)) return '';
  return new URL(path, `${String(base).replace(/\/+$/, '')}/`).toString();
}

function looksJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
