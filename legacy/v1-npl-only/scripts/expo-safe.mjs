#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './microtest/env-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expoCli = path.join(root, 'node_modules', 'expo', 'bin', 'cli');
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('usage: scripts/expo-safe.mjs <expo command> [...args]');
  process.exit(2);
}

const envFile = readEnvFile(path.join(root, '.env'));
const publicEnv = Object.fromEntries(
  Object.entries(envFile).filter(([key]) => key.startsWith('EXPO_PUBLIC_'))
);
const childEnv = {
  ...process.env,
  ...publicEnv,
  EXPO_NO_DOTENV: '1',
};

for (const key of ['PRIVATE_KEY', 'ADMIN_SECRET', 'INDEXER_SECRET']) {
  delete childEnv[key];
}

const child = spawn(process.execPath, [expoCli, ...args], {
  cwd: root,
  env: childEnv,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  scrubExpoLogs();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function scrubExpoLogs() {
  const logsDir = path.join(root, '.expo', 'dev', 'logs');
  if (!fs.existsSync(logsDir)) return;
  for (const name of fs.readdirSync(logsDir)) {
    if (name.endsWith('.log')) {
      fs.rmSync(path.join(logsDir, name), { force: true });
    }
  }
}
