#!/usr/bin/env node
import { readEnvFile, targetChain, redact } from './env-utils.mjs';

const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const strict = process.argv.includes('--strict') || process.env.MICRO_PLAN_STRICT === 'true';
const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
const checks = [];

check('Target chain is BSC', chain.key === 'bsc' && chain.chainId === 56, 'Set TARGET_CHAIN=bsc and CHAIN_ID=56.');
check('CHAIN_ID matches BSC', String(env.CHAIN_ID || '56') === '56', 'Set CHAIN_ID=56.');
check('NPL is fixed docs contract', lower(env.EXPO_PUBLIC_NPL_BSC_ADDRESS || fixedNpl) === fixedNpl, `Set EXPO_PUBLIC_NPL_BSC_ADDRESS=${fixedNpl}.`);
check('RPC URL configured', hasValue(env.BSC_RPC_URL || env.EXPO_PUBLIC_BSC_RPC_URL), 'Set BSC_RPC_URL or EXPO_PUBLIC_BSC_RPC_URL.');
check('MICRO_TEST=true', String(env.MICRO_TEST || '').toLowerCase() === 'true', 'Set MICRO_TEST=true before any micro transaction script.');
check('PRIVATE_KEY present for tx scripts', hasValue(env.PRIVATE_KEY), 'Fill PRIVATE_KEY locally only; never paste it into chat or logs.');
check('Escrow address configured', isAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS), 'Deploy/check Abu24KPaymentEscrow and set EXPO_PUBLIC_ESCROW_ADDRESS.');
check('Escrow order signer configured', isAddress(env.ORDER_SIGNER_ADDRESS), 'Set ORDER_SIGNER_ADDRESS to Escrow.orderSigner; micro payment scripts use the local test wallet through an in-process HTTP signer.');
check('Escrow split version configured', /^[1-9][0-9]*$/.test(String(env.ESCROW_SPLIT_VERSION || '')), 'Set ESCROW_SPLIT_VERSION to Escrow.currentSplitVersion().');
check('Merchant receiver configured', isAddress(env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS), 'Set MERCHANT_RECEIVER_ADDRESS.');
check('Indexer secret configured', hasValue(env.INDEXER_SECRET), 'Set INDEXER_SECRET for backend chain-event writes.');
check('Admin secret configured', hasValue(env.ADMIN_SECRET), 'Set ADMIN_SECRET for protected backend read checks.');
check('Chain event RPC configured', hasValue(env.CHAIN_EVENT_RPC_URL || env.BSC_RPC_URL), 'Set CHAIN_EVENT_RPC_URL or BSC_RPC_URL.');
check('Unverified chain events disabled', String(env.ALLOW_UNVERIFIED_CHAIN_EVENTS || '').toLowerCase() !== 'true', 'Set ALLOW_UNVERIFIED_CHAIN_EVENTS=false for mainnet tests.');
check('Seckill contract configured for read-only verification', isAddress(env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS), 'Deploy/configure Abu24KSeckill before its read-only check.');
check('BNM token configured for read-only RewardLedger verification', isAddress(env.EXPO_PUBLIC_BNM_BSC_ADDRESS), 'Deploy/configure BNMToken before the read-only rewards check.');
check('RewardLedger configured for read-only verification', isAddress(env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS), 'Deploy/configure Abu24KRewardLedger before its read-only check.');

const budget = {
  maxTxValueNative: env.MAX_TX_VALUE_NATIVE || '0.0001',
  maxTotalBudgetNative: env.MAX_TOTAL_BUDGET_NATIVE || '0.001',
  maxGasCostPerTxNative: env.MAX_GAS_COST_PER_TX_NATIVE || '0.0002',
  maxMicroNplAmount: env.MAX_MICRO_NPL_AMOUNT || '0.001',
  microFundTxNplAmount: env.MICRO_FUND_TX_NPL_AMOUNT || '0.000001',
  microSmokeNplAmount: env.MICRO_SMOKE_NPL_AMOUNT || '0.000001',
  microSeckillPrizePoolNpl: env.MICRO_SECKILL_PRIZE_POOL_NPL || '0'
};

const commands = [
  { step: 1, command: 'pnpm micro:preflight', tx: false, purpose: 'RPC, chainId, wallet address and budget sanity check' },
  { step: 2, command: 'pnpm deploy:check-rewards', tx: false, purpose: 'Verify BNM + RewardLedger before dependent contracts' },
  { step: 3, command: 'pnpm deploy:check-escrow', tx: false, purpose: 'Verify Escrow signer/split/seller/RewardLedger operator/unpause configuration' },
  { step: 4, command: 'pnpm deploy:check-seckill', tx: false, purpose: 'Verify Seckill NPL/Escrow/RewardLedger bindings and operator authorization' },
  { step: 5, command: 'pnpm micro:seckill-record', tx: false, purpose: 'Read-only BSC Seckill owner/pause/ABI verification; sends no transaction' },
  { step: 6, command: 'pnpm micro:reward-ledger-local', tx: false, purpose: 'Local BNM/RewardLedger lock/release/claim/burn guard' },
  { step: 7, command: 'pnpm micro:reward-ledger-claim', tx: false, purpose: 'Read-only BSC BNM/NPL/RewardLedger binding verification; sends no transaction' },
  { step: 8, command: 'pnpm micro:escrow-smoke', tx: true, purpose: 'BSC ultra-small NPL approve/pay/refund smoke' },
  { step: 9, command: 'pnpm micro:fund-tx-e2e', tx: true, purpose: 'BSC ultra-small NPL approve/pay/refund with backend receipt verification' },
  { step: 10, command: 'pnpm micro:report', tx: false, purpose: 'Generate MAINNET_MICRO_TEST_REPORT.md' }
];

const warnings = checks.filter((entry) => entry.level === 'warn');
const blockers = checks.filter((entry) => entry.level === 'fail');
const txReady = ['Target chain is BSC', 'CHAIN_ID matches BSC', 'NPL is fixed docs contract', 'RPC URL configured', 'MICRO_TEST=true', 'PRIVATE_KEY present for tx scripts', 'Escrow address configured', 'Escrow order signer configured', 'Escrow split version configured', 'Merchant receiver configured', 'RewardLedger configured for read-only verification', 'Indexer secret configured', 'Admin secret configured', 'Chain event RPC configured', 'Unverified chain events disabled']
  .every((name) => checks.find((entry) => entry.name === name)?.level === 'pass');

console.log(JSON.stringify({
  ok: blockers.length === 0,
  strict,
  txReady,
  rewardLedgerReadReady: isAddress(env.EXPO_PUBLIC_BNM_BSC_ADDRESS) && isAddress(env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS),
  seckillReadReady: isAddress(env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS),
  target: { chain: chain.key, chainId: chain.chainId, native: chain.native },
  rpc: redact(env.BSC_RPC_URL || env.EXPO_PUBLIC_BSC_RPC_URL || ''),
  fixedNpl,
  budget,
  commands,
  checks,
  warnings: warnings.length,
  blockers: blockers.length,
  privateKeyPrinted: false,
  note: txReady ? 'Only the two NPL approve/pay/refund commands may send mainnet transactions; all reward and seckill checks are read-only.' : 'NPL micro-test tx path has missing configuration; no transaction was sent.'
}, null, 2));

if (blockers.length) process.exit(1);

function check(name, ok, fix) {
  checks.push({ name, level: ok ? 'pass' : (strict ? 'fail' : 'warn'), fix: ok ? undefined : fix });
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}
