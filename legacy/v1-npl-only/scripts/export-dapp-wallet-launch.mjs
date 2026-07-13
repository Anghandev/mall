#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readEnvFile } from './microtest/env-utils.mjs';

const OUT_DIR = process.env.DAPP_WALLET_LAUNCH_OUT_DIR || 'test-artifacts';
const JSON_OUT = resolve(OUT_DIR, 'dapp-wallet-launch.json');
const MD_OUT = resolve(OUT_DIR, 'dapp-wallet-launch.md');
const ENV_OUT = resolve(OUT_DIR, 'dapp-wallet-launch.env');
const strict = process.argv.includes('--strict') || process.env.DAPP_WALLET_LAUNCH_STRICT === 'true';
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const env = { ...readEnvFile('.env'), ...process.env };

fs.mkdirSync(OUT_DIR, { recursive: true });

runNode('scripts/export-dapp-frontend-env.mjs', [], {
  DAPP_FRONTEND_ENV_OUT_DIR: OUT_DIR
});
const frontendEnvCheck = runJson('scripts/check-dapp-frontend-env.mjs', [], {
  DAPP_FRONTEND_ENV_FILE: resolve(OUT_DIR, 'dapp-frontend.env'),
  DAPP_FRONTEND_ENV_CHECK_REPORT: resolve(OUT_DIR, 'dapp-frontend-env-check.report.json')
});
const productionCheck = runJson('scripts/check-dapp-production-env.mjs');

const apiBaseUrl = publicUrl(env.DAPP_BASE_URL || env.EXPO_PUBLIC_API_BASE_URL || frontendEnvCheck.apiBaseUrl || '');
const entryUrl = publicUrl(env.DAPP_ENTRY_URL || env.FRONTEND_URL || env.DAPP_QR_URL || frontendEnvCheck.entryUrl || apiBaseUrl || '');
const commandApiBaseUrl = isHttps(apiBaseUrl) ? apiBaseUrl : 'https://your-api-domain';
const commandEntryUrl = isHttps(entryUrl) ? entryUrl : 'https://your-frontend-domain';
const reownProjectId = env.EXPO_PUBLIC_REOWN_PROJECT_ID || '<reown_project_id>';
const contracts = {
  npl: fixedNpl,
  escrow: env.EXPO_PUBLIC_ESCROW_ADDRESS || '<escrow_address>',
  seckill: env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS || '<seckill_address>',
  bnm: env.EXPO_PUBLIC_BNM_BSC_ADDRESS || '<bnm_address>',
  rewardLedger: env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS || '<reward_ledger_address>'
};

const phoneWalletBlockers = [];
if (!isHttps(apiBaseUrl)) phoneWalletBlockers.push({ name: 'API base URL is not HTTPS', fix: 'Set DAPP_BASE_URL / EXPO_PUBLIC_API_BASE_URL to the deployed HTTPS backend URL.' });
if (!isHttps(entryUrl)) phoneWalletBlockers.push({ name: 'Wallet/DApp entry URL is not HTTPS', fix: 'Set DAPP_ENTRY_URL / FRONTEND_URL / DAPP_QR_URL to the HTTPS URL users type into wallet or DEX browser.' });
if (isPlaceholder(reownProjectId)) phoneWalletBlockers.push({ name: 'Reown project id missing', fix: 'Set EXPO_PUBLIC_REOWN_PROJECT_ID for wallet connection UI.' });
for (const [key, value] of Object.entries({ escrow: contracts.escrow, seckill: contracts.seckill, bnm: contracts.bnm, rewardLedger: contracts.rewardLedger })) {
  if (!isAddress(value)) phoneWalletBlockers.push({ name: `${key} contract address missing`, fix: `Deploy/configure ${key} and set the matching EXPO_PUBLIC_* address.` });
}

const report = {
  kind: '24k-dapp-wallet-launch',
  generatedAt: new Date().toISOString(),
  strict,
  readyForPhoneWallet: phoneWalletBlockers.length === 0,
  fixedPolicy: {
    chainId: 56,
    npl: fixedNpl,
    payment: 'NPL approve(MaxUint256), then allowance skip',
    seckillCallerRule: 'tx.origin == msg.sender',
    refund: 'no user no-reason refund; platform forced refund / 7-day timeout / emergency refund only',
    privateKeyPrinted: false
  },
  urls: {
    apiBaseUrl,
    walletEntryUrl: entryUrl,
    userTypedUrl: isHttps(entryUrl) ? entryUrl : '<https_frontend_domain>',
    launchKit: apiBaseUrl ? absoluteUrl(apiBaseUrl, '/api/dapp/launch-kit?address=<wallet>') : '<https_api_domain>/api/dapp/launch-kit?address=<wallet>',
    discovery: apiBaseUrl ? absoluteUrl(apiBaseUrl, '/.well-known/24k-dapp.json') : '<https_api_domain>/.well-known/24k-dapp.json',
    frontendBrief: apiBaseUrl ? absoluteUrl(apiBaseUrl, '/api/dapp/frontend-brief.md?address=<wallet>') : '<https_api_domain>/api/dapp/frontend-brief.md?address=<wallet>'
  },
  contracts,
  phoneWalletBlockers,
  warnings: warningRows(frontendEnvCheck, 'frontend-env').concat(warningRows(productionCheck, 'production-env')),
  commands: {
    generateQr: `DAPP_QR_URL=${shellValue(commandEntryUrl)} pnpm dapp:qr`,
    frontendPackFromDomain: `DAPP_BASE_URL=${shellValue(commandApiBaseUrl)} DAPP_ENTRY_URL=${shellValue(commandEntryUrl)} pnpm dapp:frontend-pack`,
    strictGate: 'pnpm dapp:wallet-launch -- --strict && pnpm dapp:prod-check -- --strict',
    launchCheckFromDomain: `DAPP_BASE_URL=${shellValue(commandApiBaseUrl)} pnpm dapp:launch-check`
  },
  artifacts: {
    json: JSON_OUT,
    markdown: MD_OUT,
    env: ENV_OUT,
    frontendEnv: resolve(OUT_DIR, 'dapp-frontend.env')
  }
};

fs.writeFileSync(ENV_OUT, renderPublicEnv(report));
assertNoSecretAssignments(fs.readFileSync(ENV_OUT, 'utf8'));
fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(MD_OUT, renderMarkdown(report));

console.log('DApp wallet launch export: PASS');
console.log(`readyForPhoneWallet: ${report.readyForPhoneWallet ? 'yes' : 'no'}`);
console.log(`wallet entry: ${report.urls.walletEntryUrl || '<missing>'}`);
console.log(`wrote ${JSON_OUT}`);
console.log(`wrote ${MD_OUT}`);
console.log(`wrote ${ENV_OUT}`);
console.log('PRIVATE_KEY included: false');
if (strict && !report.readyForPhoneWallet) process.exit(1);

function runNode(script, args = [], extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`${script} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout;
}

function runJson(script, args = [], extraEnv = {}) {
  const stdout = runNode(script, args, extraEnv);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${script} did not return JSON\n${stdout}`);
  }
}

function publicUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('<')) return '';
  try {
    return new URL(raw).toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function isHttps(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch {
    return false;
  }
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

function isPlaceholder(value) {
  const raw = String(value || '').trim();
  return !raw || /^<[^>]+>$/.test(raw);
}

function absoluteUrl(base, pathname) {
  try {
    return new URL(pathname, `${String(base).replace(/\/+$/, '')}/`).toString();
  } catch {
    return '';
  }
}

function warningRows(summary, source) {
  return (summary?.checks || [])
    .filter((entry) => entry.level === 'warn')
    .map((entry) => ({ source, name: entry.name, fix: entry.fix || '' }));
}

function shellValue(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function renderPublicEnv(report) {
  return [
    '# 24K DApp wallet-browser launch public env',
    '# Safe to send to the DApp frontend thread. Server secrets and private keys are intentionally absent.',
    kv('DAPP_BASE_URL', report.urls.apiBaseUrl || '<https_api_domain>'),
    kv('EXPO_PUBLIC_API_BASE_URL', report.urls.apiBaseUrl || '<https_api_domain>'),
    kv('DAPP_ENTRY_URL', report.urls.walletEntryUrl || '<https_frontend_domain>'),
    kv('DAPP_QR_URL', report.urls.walletEntryUrl || '<https_frontend_domain>'),
    kv('EXPO_PUBLIC_REOWN_PROJECT_ID', reownProjectId),
    kv('EXPO_PUBLIC_BSC_CHAIN_ID', '56'),
    kv('EXPO_PUBLIC_NPL_BSC_ADDRESS', fixedNpl),
    kv('EXPO_PUBLIC_ESCROW_ADDRESS', contracts.escrow),
    kv('EXPO_PUBLIC_SECKILL_ADDRESS', contracts.seckill),
    kv('EXPO_PUBLIC_BNM_BSC_ADDRESS', contracts.bnm),
    kv('EXPO_PUBLIC_REWARD_LEDGER_ADDRESS', contracts.rewardLedger),
    ''
  ].join('\n');
}

function renderMarkdown(report) {
  const blockers = report.phoneWalletBlockers.length
    ? report.phoneWalletBlockers.map((entry) => `- ${entry.name} — ${entry.fix}`).join('\n')
    : '- none';
  const warnings = report.warnings.length
    ? report.warnings.map((entry) => `- [${entry.source}] ${entry.name}${entry.fix ? ` — ${entry.fix}` : ''}`).join('\n')
    : '- none';
  return `# 24K DApp Wallet / DEX Browser Launch

- Generated at: ${report.generatedAt}
- Ready for phone wallet: ${report.readyForPhoneWallet ? 'yes' : 'no'}
- User typed URL: \`${report.urls.userTypedUrl || '<https_frontend_domain>'}\`
- Current configured entry: \`${report.urls.walletEntryUrl || '<missing>'}\`
- API base URL: \`${report.urls.apiBaseUrl || '<https_api_domain>'}\`
- Fixed NPL: \`${fixedNpl}\`
- Private key printed: false

## DEX / wallet browser user path

1. Open OKX Wallet / TokenPocket / MetaMask wallet browser, or the DEX browser where users normally input a DApp URL.
2. Type or paste: \`${report.urls.userTypedUrl || '<https_frontend_domain>'}\`
3. Connect wallet, switch to BSC 56 when prompted.
4. Normal buy / seckill buy must use backend intent endpoints; first payment sends one NPL approve(MaxUint256), later payments skip approval when allowance is enough.

## Phone-wallet blockers

${blockers}

## Warnings

${warnings}

## Commands

\`\`\`bash
${report.commands.generateQr}
${report.commands.frontendPackFromDomain}
${report.commands.launchCheckFromDomain}
${report.commands.strictGate}
\`\`\`

## Files

- \`${report.artifacts.env}\` — public env to copy into the frontend project.
- \`${report.artifacts.json}\` — machine-readable launch report.
- \`${report.artifacts.markdown}\` — this launch checklist.
`;
}

function kv(key, value) {
  return `${key}=${value ?? ''}`;
}

function assertNoSecretAssignments(text) {
  const forbidden = [/^PRIVATE_KEY=/m, /^INDEXER_SECRET=/m, /^ADMIN_SECRET=/m, /^JWT_SECRET=/m, /^EXPLORER_API_KEY=/m, /^ETHERSCAN_API_KEY=/m, /^BSCSCAN_API_KEY=/m, /^BASESCAN_API_KEY=/m];
  const leaks = forbidden.filter((pattern) => pattern.test(text)).map(String);
  if (leaks.length) throw new Error(`Wallet launch env contains server/deploy secrets: ${leaks.join(', ')}`);
}
