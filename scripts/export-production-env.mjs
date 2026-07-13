#!/usr/bin/env node
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readEnvFile } from './microtest/env-utils.mjs';

const OUT_DIR = process.env.DAPP_PROD_ENV_OUT_DIR || 'test-artifacts';
const OUT_FILE = `${OUT_DIR}/dapp-production.env`;
const REPORT_FILE = `${OUT_DIR}/dapp-production-env.report.json`;
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const sourceEnvFile = process.env.DAPP_PROD_SOURCE_ENV_FILE || (fs.existsSync('.env.production') ? '.env.production' : '.env');
const env = { ...readEnvFile(sourceEnvFile), ...process.env };

fs.mkdirSync(OUT_DIR, { recursive: true });

const generated = {
  INDEXER_SECRET: secret('indexer'),
  ADMIN_SECRET: secret('admin'),
  JWT_SECRET: secret('jwt'),
  ORDER_SIGNING_WEBHOOK_TOKEN: secret('order_signing'),
  LOGISTICS_CALLBACK_SECRET: secret('logistics_callback'),
  ELECTRONIC_WAYBILL_WEBHOOK_TOKEN: secret('waybill'),
  SHIPMENT_WEBHOOK_TOKEN: secret('shipment'),
  PRINT_WEBHOOK_TOKEN: secret('print'),
  NOTIFICATION_WEBHOOK_TOKEN: secret('notification'),
};
const lines = [
  '# 24K DApp production server env',
  '# Generated locally by pnpm dapp:prod-env. Review before deploying.',
  '# IMPORTANT: PRIVATE_KEY is intentionally omitted. Do not put deployer/private wallet keys on the production DApp server.',
  '',
  '# Public DApp / wallet browser URLs',
  kv('EXPO_PUBLIC_REOWN_PROJECT_ID', env.EXPO_PUBLIC_REOWN_PROJECT_ID || '<reown_project_id>'),
  kv('EXPO_PUBLIC_API_BASE_URL', productionUrl(env.EXPO_PUBLIC_API_BASE_URL || env.DAPP_BASE_URL || '<https_api_domain>')),
  kv('DAPP_BASE_URL', productionUrl(env.DAPP_BASE_URL || env.EXPO_PUBLIC_API_BASE_URL || '<https_api_domain>')),
  kv('DAPP_ENTRY_URL', productionUrl(env.DAPP_ENTRY_URL || env.FRONTEND_URL || '<https_frontend_domain>')),
  kv('DAPP_QR_URL', productionUrl(env.DAPP_QR_URL || env.DAPP_ENTRY_URL || env.FRONTEND_URL || '<https_frontend_domain>')),
  kv('FRONTEND_URL', productionUrl(env.FRONTEND_URL || env.DAPP_ENTRY_URL || '<https_frontend_domain>')),
  kv('CORS_ORIGINS', productionUrl(env.FRONTEND_URL || env.DAPP_ENTRY_URL || '<https_frontend_domain>')),
  '',
  '# BSC chain and contracts',
  kv('EXPO_PUBLIC_BSC_CHAIN_ID', '56'),
  kv('EXPO_PUBLIC_BSC_RPC_URL', env.EXPO_PUBLIC_BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org'),
  kv('EXPO_PUBLIC_BSC_EXPLORER_URL', env.EXPO_PUBLIC_BSC_EXPLORER_URL || 'https://bscscan.com'),
  kv('EXPO_PUBLIC_NPL_BSC_ADDRESS', fixedNpl),
  kv('EXPO_PUBLIC_ESCROW_ADDRESS', env.EXPO_PUBLIC_ESCROW_ADDRESS || '<escrow_address>'),
  kv('EXPO_PUBLIC_SECKILL_ADDRESS', env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS || '<seckill_address>'),
  kv('EXPO_PUBLIC_BNM_BSC_ADDRESS', env.EXPO_PUBLIC_BNM_BSC_ADDRESS || '<bnm_address>'),
  kv('EXPO_PUBLIC_REWARD_LEDGER_ADDRESS', env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS || '<reward_ledger_address>'),
  kv('REWARD_LEDGER_ADDRESS', env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS || '<reward_ledger_address>'),
  kv('SECKILL_ADDRESS', env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS || '<seckill_address>'),
  kv('GENESIS_NODE_CONTRACT', env.GENESIS_NODE_CONTRACT || '<genesis_node_contract>'),
  kv('SECKILL_MAX_GAS_PRICE_WEI', env.SECKILL_MAX_GAS_PRICE_WEI || '8000000000'),
  '',
  '# Operating wallets, not private keys',
  kv('MERCHANT_RECEIVER_ADDRESS', env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS || '<merchant_receiver_wallet>'),
  kv('EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS', env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS || env.MERCHANT_RECEIVER_ADDRESS || '<merchant_receiver_wallet>'),
  kv('ADMIN_WALLET_ADDRESS', env.ADMIN_WALLET_ADDRESS || '<admin_siwe_wallet>'),
  kv('ORDER_SIGNER_ADDRESS', env.ORDER_SIGNER_ADDRESS || '<order_signer_address>'),
  kv('ESCROW_SPLIT_VERSION', env.ESCROW_SPLIT_VERSION || '<escrow_split_version>'),
  kv('ESCROW_OWNER_ADDRESS', env.ESCROW_OWNER_ADDRESS || '<escrow_multisig_owner>'),
  kv('REWARDS_OWNER_ADDRESS', env.REWARDS_OWNER_ADDRESS || '<rewards_multisig_owner>'),
  kv('SECKILL_OWNER_ADDRESS', env.SECKILL_OWNER_ADDRESS || '<seckill_multisig_owner>'),
  '',
  '# Server secrets generated locally. Keep server-side only.',
  kv('INDEXER_SECRET', generated.INDEXER_SECRET),
  kv('ADMIN_SECRET', generated.ADMIN_SECRET),
  kv('JWT_SECRET', generated.JWT_SECRET),
  kv('ORDER_SIGNING_WEBHOOK_URL', productionUrl(env.ORDER_SIGNING_WEBHOOK_URL || '<https_order_signing_webhook>')),
  kv('ORDER_SIGNING_WEBHOOK_TOKEN', generated.ORDER_SIGNING_WEBHOOK_TOKEN),
  kv('LOGISTICS_CALLBACK_SECRET', generated.LOGISTICS_CALLBACK_SECRET),
  kv('DB_PATH', env.DB_PATH || '<absolute_persistent_db_path>'),
  kv('AUDIT_DB_PATH', env.AUDIT_DB_PATH || '<separate_absolute_audit_db_path>'),
  '',
  '# Required production provider adapters',
  kv('AMAP_WEB_SERVICE_KEY', env.AMAP_WEB_SERVICE_KEY || env.AMAP_API_KEY || '<amap_web_service_key>'),
  kv('ELECTRONIC_WAYBILL_WEBHOOK_URL', productionUrl(env.ELECTRONIC_WAYBILL_WEBHOOK_URL || env.WAYBILL_WEBHOOK_URL || '<https_waybill_webhook>')),
  kv('ELECTRONIC_WAYBILL_WEBHOOK_TOKEN', generated.ELECTRONIC_WAYBILL_WEBHOOK_TOKEN),
  kv('SHIPMENT_WEBHOOK_URL', productionUrl(env.SHIPMENT_WEBHOOK_URL || '<https_shipment_webhook>')),
  kv('SHIPMENT_WEBHOOK_TOKEN', generated.SHIPMENT_WEBHOOK_TOKEN),
  kv('PRINT_WEBHOOK_URL', productionUrl(env.PRINT_WEBHOOK_URL || env.CLOUD_PRINT_WEBHOOK_URL || '<https_print_webhook>')),
  kv('PRINT_WEBHOOK_TOKEN', generated.PRINT_WEBHOOK_TOKEN),
  kv('NOTIFICATION_WEBHOOK_URL', productionUrl(env.NOTIFICATION_WEBHOOK_URL || '<https_notification_webhook>')),
  kv('NOTIFICATION_WEBHOOK_TOKEN', generated.NOTIFICATION_WEBHOOK_TOKEN),
  '',
  '# Chain event verification. Prefer a production RPC URL here; do not use PRIVATE_KEY.',
  kv('CHAIN_EVENT_RPC_URL', env.CHAIN_EVENT_RPC_URL || env.BSC_RPC_URL || '<bsc_rpc_url_for_receipt_verification>'),
  kv('ALLOW_UNVERIFIED_CHAIN_EVENTS', 'false'),
  kv('INDEXER_CONFIRMATIONS', env.INDEXER_CONFIRMATIONS || '15'),
  kv('INDEXER_ALLOW_UNFINALIZED', 'false'),
  kv('EXPLORER_API_KEY', env.EXPLORER_API_KEY || env.BSCSCAN_API_KEY || 'REMOVED_FROM_GITHUB'),
  '',
  '# Event sync from-blocks after deploy/check scripts',
  kv('ESCROW_FROM_BLOCK', env.ESCROW_FROM_BLOCK || '<escrow_from_block>'),
  kv('REWARD_LEDGER_FROM_BLOCK', env.REWARD_LEDGER_FROM_BLOCK || '<reward_ledger_from_block>'),
  kv('SECKILL_FROM_BLOCK', env.SECKILL_FROM_BLOCK || '<seckill_from_block>'),
  kv('ESCROW_TO_BLOCK', ''),
  kv('REWARD_LEDGER_TO_BLOCK', ''),
  kv('SECKILL_TO_BLOCK', ''),
  '',
  '# Explicitly omitted local-only keys: PRIVATE_KEY, MICRO_TEST and deploy wallet secrets.',
];

fs.writeFileSync(OUT_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
const source = fs.readFileSync(OUT_FILE, 'utf8');
const forbidden = ['PRIVATE_KEY=', 'MICRO_TEST=true', 'ETHERSCAN_API_KEY=', 'BASESCAN_API_KEY='];
const leaks = forbidden.filter((needle) => source.includes(needle));
if (leaks.length) throw new Error(`Production env export contains forbidden local-only keys: ${leaks.join(', ')}`);

const missing = lines
  .filter((line) => /^[A-Z0-9_]+=<[^>]+>$/.test(line))
  .map((line) => line.split('=')[0]);
const report = {
  kind: '24k-dapp-production-env-export',
  outFile: OUT_FILE,
  generatedAt: new Date().toISOString(),
  privateKeyIncluded: false,
  secretsGenerated: Object.keys(generated),
  placeholderKeys: missing,
  sourceEnvFile,
  fixedNpl,
  next: [
    `Fill placeholders in ${OUT_FILE}`,
    'Deploy env to server without PRIVATE_KEY',
    'Copy reviewed values into .env.production and run: pnpm dapp:prod-check'
  ]
};
fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);

console.log('DApp production env export: PASS');
console.log(`wrote ${OUT_FILE}`);
console.log(`wrote ${REPORT_FILE}`);
console.log('PRIVATE_KEY included: false');
console.log(`placeholders remaining: ${missing.length}`);

function secret(label) {
  return `anghann_prod_${label}_${randomBytes(32).toString('hex')}`;
}

function kv(key, value) {
  return `${key}=${value ?? ''}`;
}

function productionUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('<')) return raw || '<https_domain>';
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0')) {
      return '<https_domain>';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return '<https_domain>';
  }
}
