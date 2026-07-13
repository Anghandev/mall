#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

const target = process.env.DAPP_PROD_ENV_FILE || '.env.production';
const template = '.env.production.example';
const force = process.argv.includes('--force');

if (!fs.existsSync(template)) throw new Error(`${template} is missing`);
if (fs.existsSync(target) && !force) {
  fs.chmodSync(target, 0o600);
  console.log(`${target} already exists; values were not overwritten`);
  process.exit(0);
}

const source = parseEnv('.env');
const values = parseEnv(template);
for (const key of [
  'EXPO_PUBLIC_REOWN_PROJECT_ID',
  'EXPO_PUBLIC_BSC_RPC_URL',
  'EXPO_PUBLIC_BSC_EXPLORER_URL',
  'MERCHANT_RECEIVER_ADDRESS',
  'EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS'
]) {
  if (source[key]) values[key] = source[key];
}

for (const key of [
  'JWT_SECRET',
  'ADMIN_SECRET',
  'INDEXER_SECRET',
  'LOGISTICS_CALLBACK_SECRET',
  'ORDER_SIGNING_WEBHOOK_TOKEN',
  'ELECTRONIC_WAYBILL_WEBHOOK_TOKEN',
  'SHIPMENT_WEBHOOK_TOKEN',
  'PRINT_WEBHOOK_TOKEN',
  'NOTIFICATION_WEBHOOK_TOKEN'
]) {
  values[key] = `24k_${randomBytes(32).toString('hex')}`;
}

const rendered = fs.readFileSync(template, 'utf8').split(/\r?\n/).map((line) => {
  const match = line.match(/^([A-Z0-9_]+)=/);
  return match ? `${match[1]}=${values[match[1]] || ''}` : line;
}).join('\n');

fs.writeFileSync(target, rendered.endsWith('\n') ? rendered : `${rendered}\n`, { mode: 0o600 });
fs.chmodSync(target, 0o600);
console.log(`created ${target} with generated server secrets (values hidden)`);
console.log('contract addresses, HTTPS domains, multisig wallets and provider credentials remain intentionally empty');

function parseEnv(file) {
  if (!fs.existsSync(file)) return {};
  const result = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}
