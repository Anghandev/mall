#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { projectRootFromScript } from './env-utils.mjs';

const root = projectRootFromScript(import.meta.url);
process.chdir(root);

const envPath = '.env';
const examplePath = '.env.example';
const gitignorePath = '.gitignore';
const requiredIgnores = [
  '**/.env',
  '**/.env.*',
  '!.env.example',
  '!**/.env.example',
  '**/test-artifacts/',
  '**/deployments/*private*',
];

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

function defaultEnv() {
  return `# Abu 24K V2 Mainnet Micro-Test local env.
# Fill values only in this ignored file. Never paste private keys into chat.
TARGET_CHAIN=bsc
CHAIN_ID=56
BSC_RPC_URL=
EXPLORER_API_KEY=
ETHERSCAN_API_KEY=\${EXPLORER_API_KEY}
BSCSCAN_API_KEY=\${EXPLORER_API_KEY}
BASESCAN_API_KEY=\${EXPLORER_API_KEY}
BSC_FALLBACK_RPC_URL=
DATABASE_URL=
AUDIT_DATABASE_URL=
POSTGRES_ADMIN_URL=
REDIS_URL=
QUEUE_URL=
SIGNER_SERVICE_URL=
SIGNER_SERVICE_TOKEN=
SETTLEMENT_EXECUTOR_URL=
SETTLEMENT_EXECUTOR_TOKEN=
GOVERNANCE_EXECUTOR_URL=
GOVERNANCE_EXECUTOR_TOKEN=
BNM_AVAILABILITY_URL=
BNM_API_TOKEN=
BNM_PROJECT_ID=
BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH=
PLATFORM_GOVERNANCE_WALLET_ADDRESS=
PLATFORM_SERVICE_FEE_WALLET_ADDRESS=
USDT_SETTLEMENT_WALLET_ADDRESS=
NPL_REWARD_WALLET_ADDRESS=
OPERATIONS_GUARANTEE_WALLET_ADDRESS=
MAINNET_MICROTEST_MERCHANT_ID=
MAINNET_MICROTEST_MERCHANT_WALLET=
MAINNET_MICROTEST_PRODUCT_ID=
MAINNET_MICROTEST_BUYER_WALLETS=
MAINNET_MICROTEST_EXPIRES_AT=
MAINNET_MICROTEST_MAX_LIST_PRICE_USDT=
MAINNET_MICROTEST_MAX_FREIGHT_USDT=
MAINNET_MICROTEST_MAX_STOCK=
MAINNET_MICROTEST_SECKILL_INVENTORY=
MAINNET_MICROTEST_EVIDENCE_HASH=
MAINNET_MICROTEST_PACKET_PATH=platform-v2/deployments/bsc-eoa-micro-packet-private.json
MAINNET_MICROTEST_PACKET_SHA256=
MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX=0
MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB=
MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB=
PLATFORM_TECH_PRIVATE_KEY=
WALLET_1_PRIVATE_KEY=
WALLET_2_PRIVATE_KEY=
WALLET_3_PRIVATE_KEY=
WALLET_4_PRIVATE_KEY=
WALLET_5_PRIVATE_KEY=
WALLET_6_PRIVATE_KEY=
MICROTEST_WALLET_6_PRIVATE_KEY=
`;
}
