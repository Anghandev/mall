import fs from 'node:fs';
import path from 'node:path';

export const CHAINS = {
  bsc: {
    chainId: 56,
    rpcEnv: 'BSC_RPC_URL',
    explorer: 'https://bscscan.com',
    native: 'BNB',
  },
  eth: {
    chainId: 1,
    rpcEnv: 'ETH_RPC_URL',
    explorer: 'https://etherscan.io',
    native: 'ETH',
  },
  base: {
    chainId: 8453,
    rpcEnv: 'BASE_RPC_URL',
    explorer: 'https://basescan.org',
    native: 'ETH',
  },
};

export function readEnvFile(file = '.env') {
  if (!fs.existsSync(file)) return {};
  const env = {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = expandValue(value, env);
  }
  return env;
}

function expandValue(value, env) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => env[key] ?? process.env[key] ?? '');
}

export function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }
}

export function targetChain(env) {
  const key = (env.TARGET_CHAIN || 'bsc').toLowerCase();
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(`Unsupported TARGET_CHAIN=${env.TARGET_CHAIN}. Use one of: ${Object.keys(CHAINS).join(', ')}`);
  }
  return { key, ...chain };
}

export function redact(value) {
  if (!value) return '';
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function projectRootFromScript(importMetaUrl) {
  const scriptPath = new URL(importMetaUrl).pathname;
  return path.resolve(path.dirname(scriptPath), '..', '..');
}
