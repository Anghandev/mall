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
  return `TARGET_CHAIN=bsc
CHAIN_ID=56
BSC_RPC_URL=
ETH_RPC_URL=
BASE_RPC_URL=
EXPLORER_API_KEY=
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
FRONTEND_URL=http://localhost:3000
`;
}
