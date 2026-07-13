#!/usr/bin/env node
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { projectRootFromScript } from './env-utils.mjs';

const root = projectRootFromScript(import.meta.url);
process.chdir(root);

const envPath = '.env';
const examplePath = '.env.example';
const gitignorePath = '.gitignore';
const requiredIgnores = ['.env', '.env.*', '!.env.example', 'test-artifacts/', 'deployments/*private*'];

if (!fs.existsSync(envPath)) {
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log('created .env from .env.example');
  } else {
    fs.writeFileSync(envPath, defaultEnv(), { mode: 0o600 });
    console.log('created .env from built-in defaults');
  }
} else {
  console.log('.env already exists; leaving values untouched');
}

try {
  fs.chmodSync(envPath, 0o600);
  console.log('set chmod 600 .env');
} catch (error) {
  console.warn(`warning: could not chmod .env: ${error.message}`);
}

ensureLocalSecrets(envPath);
ensureEnvKeys(envPath, [
  'EXPO_PUBLIC_BNM_BSC_ADDRESS',
  'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS',
  'REWARD_LEDGER_ADDRESS',
  'EXPO_PUBLIC_SECKILL_ADDRESS',
  'SECKILL_ADDRESS',
  'REWARDS_OWNER_ADDRESS',
  'ORDER_SIGNER_ADDRESS',
  'ESCROW_SPLIT_VERSION',
  'PLATFORM_RECEIVER_ADDRESS',
  'REGION_RECEIVER_ADDRESS',
  'REFERRAL_RECEIVER_ADDRESS',
  'PRIZE_POOL_RECEIVER_ADDRESS',
  'BURN_RECEIVER_ADDRESS',
  'CIRCULATION_RECEIVER_ADDRESS',
  'REWARD_LEDGER_FROM_BLOCK',
  'SECKILL_FROM_BLOCK'
]);

let gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
const lines = new Set(gitignore.split(/\r?\n/));
let changed = false;
for (const entry of requiredIgnores) {
  if (!lines.has(entry)) {
    gitignore += `${gitignore.endsWith('\n') || gitignore.length === 0 ? '' : '\n'}${entry}\n`;
    changed = true;
  }
}
if (changed) {
  fs.writeFileSync(gitignorePath, gitignore);
  console.log('updated .gitignore with Web3 secret/artifact ignores');
} else {
  console.log('.gitignore already contains required entries');
}

openEnv();

function openEnv() {
  if (process.env.NO_OPEN_ENV === '1') {
    console.log('NO_OPEN_ENV=1; not opening .env');
    return;
  }
  try {
    execFileSync('command', ['-v', 'code'], { stdio: 'ignore' });
    spawn('code', [envPath], { detached: true, stdio: 'ignore' }).unref();
    console.log('opened .env in VS Code');
    return;
  } catch {}
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'TextEdit', envPath], { detached: true, stdio: 'ignore' }).unref();
    console.log('opened .env in TextEdit');
    return;
  }
  console.log('please open .env locally and fill required secrets');
}

function ensureLocalSecrets(file) {
  let text = fs.readFileSync(file, 'utf8');
  const updates = {
    INDEXER_SECRET: () => randomSecret(),
    ADMIN_SECRET: () => randomSecret(),
  };
  let changed = false;
  for (const [key, valueFactory] of Object.entries(updates)) {
    const next = ensureEnvValue(text, key, valueFactory);
    if (next !== text) {
      text = next;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(file, text, { mode: 0o600 });
    console.log('filled local INDEXER_SECRET/ADMIN_SECRET in .env (values hidden)');
  } else {
    console.log('local INDEXER_SECRET/ADMIN_SECRET already present');
  }
}

function ensureEnvKeys(file, keys) {
  let text = fs.readFileSync(file, 'utf8');
  const existing = new Set(text.split(/\r?\n/).map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter(Boolean));
  const missing = keys.filter((key) => !existing.has(key));
  if (!missing.length) return;
  text = `${text.replace(/\n*$/, '\n')}${missing.map((key) => `${key}=`).join('\n')}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  console.log(`added ${missing.length} current contract/deployment keys to .env without changing existing values`);
}

function ensureEnvValue(text, key, valueFactory) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index === -1) {
    const suffix = text.endsWith('\n') ? '' : '\n';
    return `${text}${suffix}${key}=${valueFactory()}\n`;
  }
  const current = lines[index].slice(key.length + 1).trim();
  if (current) return text;
  lines[index] = `${key}=${valueFactory()}`;
  return lines.join('\n');
}

function randomSecret() {
  return `anghann_${randomBytes(32).toString('hex')}`;
}

function defaultEnv() {
  return `# Expo public values are bundled into the app. Never put private keys here.
EXPO_PUBLIC_REOWN_PROJECT_ID=
EXPO_PUBLIC_API_BASE_URL=http://localhost:8787
DAPP_BASE_URL=
DAPP_ENTRY_URL=
DAPP_QR_URL=
EXPO_PUBLIC_BSC_CHAIN_ID=56
EXPO_PUBLIC_BSC_RPC_URL=https://bsc-dataseed.bnbchain.org
EXPO_PUBLIC_BSC_EXPLORER_URL=https://bscscan.com
EXPO_PUBLIC_NPL_BSC_ADDRESS=0x4e8277ab31e4956b2cd48449793a57656dfc03d2
EXPO_PUBLIC_ESCROW_ADDRESS=
EXPO_PUBLIC_BNM_BSC_ADDRESS=
EXPO_PUBLIC_REWARD_LEDGER_ADDRESS=
REWARD_LEDGER_ADDRESS=
EXPO_PUBLIC_SECKILL_ADDRESS=
SECKILL_ADDRESS=
ESCROW_OWNER_ADDRESS=
REWARDS_OWNER_ADDRESS=
SECKILL_OWNER_ADDRESS=
ORDER_SIGNER_ADDRESS=
ESCROW_SPLIT_VERSION=
MERCHANT_RECEIVER_ADDRESS=
EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS=
PLATFORM_RECEIVER_ADDRESS=
REGION_RECEIVER_ADDRESS=
REFERRAL_RECEIVER_ADDRESS=
PRIZE_POOL_RECEIVER_ADDRESS=
BURN_RECEIVER_ADDRESS=
CIRCULATION_RECEIVER_ADDRESS=
INDEXER_SECRET=
ADMIN_SECRET=
CHAIN_EVENT_RPC_URL=
ALLOW_UNVERIFIED_CHAIN_EVENTS=false
ESCROW_FROM_BLOCK=
REWARD_LEDGER_FROM_BLOCK=
SECKILL_FROM_BLOCK=

TARGET_CHAIN=bsc
CHAIN_ID=56
BSC_RPC_URL=
ETH_RPC_URL=
BASE_RPC_URL=
EXPLORER_API_KEY=REMOVED_FROM_GITHUB
ETHERSCAN_API_KEY=\${EXPLORER_API_KEY}
BSCSCAN_API_KEY=\${EXPLORER_API_KEY}
BASESCAN_API_KEY=\${EXPLORER_API_KEY}
PRIVATE_KEY=
DEV_WALLET=
MARKETING_WALLET=
MICRO_TEST=true
MAX_TX_VALUE_NATIVE=0.0001
MAX_TOTAL_BUDGET_NATIVE=0.001
MAX_GAS_COST_PER_TX_NATIVE=0.0002
MAX_MICRO_NPL_AMOUNT=0.001
MICRO_SMOKE_NPL_AMOUNT=0.000001
MICRO_FUND_TX_NPL_AMOUNT=0.000001
MICRO_SECKILL_DURATION_SECONDS=3600
MICRO_SECKILL_RELAY_INITIAL_SECONDS=30
MICRO_SECKILL_RELAY_EXTEND_SECONDS=30
MICRO_SECKILL_PRIZE_POOL_NPL=0
FRONTEND_URL=http://localhost:8081
`;
}
