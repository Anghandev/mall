#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readEnvFile } from './microtest/env-utils.mjs';

const OUT_DIR = process.env.DAPP_DEPLOY_READINESS_OUT_DIR || 'test-artifacts';
const JSON_OUT = resolve(OUT_DIR, 'dapp-deploy-readiness.json');
const MD_OUT = resolve(OUT_DIR, 'dapp-deploy-readiness.md');
const ENV_TODO_OUT = resolve(OUT_DIR, 'dapp-deploy-public.todo.env');
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const env = { ...readEnvFile('.env'), ...process.env };

fs.mkdirSync(OUT_DIR, { recursive: true });

const productionCheck = runJson('scripts/check-dapp-production-env.mjs');
const deployments = {
  escrow: readJson('deployments/mainnet-micro-test.json'),
  rewards: readJson('deployments/rewards-mainnet-micro-test.json'),
  seckill: readJson('deployments/seckill-mainnet-micro-test.json')
};

const configured = {
  chainId: String(env.EXPO_PUBLIC_BSC_CHAIN_ID || env.CHAIN_ID || '56'),
  apiBaseUrl: env.DAPP_BASE_URL || env.EXPO_PUBLIC_API_BASE_URL || '',
  walletEntryUrl: env.DAPP_ENTRY_URL || env.FRONTEND_URL || env.DAPP_QR_URL || '',
  reownProjectIdConfigured: hasValue(env.EXPO_PUBLIC_REOWN_PROJECT_ID),
  adminWalletConfigured: isAddress(env.ADMIN_WALLET_ADDRESS),
  chainEventRpcConfigured: hasValue(env.CHAIN_EVENT_RPC_URL || env.BSC_RPC_URL),
  genesisNodeConfigured: isAddress(env.GENESIS_NODE_CONTRACT),
  genesisNodeStandard: String(env.GENESIS_NODE_TOKEN_STANDARD || 'erc721').toLowerCase(),
  genesisNodeTokenIdConfigured: String(env.GENESIS_NODE_TOKEN_STANDARD || 'erc721').toLowerCase() !== 'erc1155' || /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(String(env.GENESIS_NODE_TOKEN_ID || '')),
  seckillMaxGasPriceWei: env.SECKILL_MAX_GAS_PRICE_WEI || '',
  explorerMonitoringConfigured: hasValue(env.EXPLORER_API_KEY || env.BSCSCAN_API_KEY),
  ownerWalletsConfigured: ['ESCROW_OWNER_ADDRESS', 'REWARDS_OWNER_ADDRESS', 'SECKILL_OWNER_ADDRESS'].every((key) => isAddress(env[key])),
  ownerWallets: {
    escrow: env.ESCROW_OWNER_ADDRESS || '',
    rewards: env.REWARDS_OWNER_ADDRESS || '',
    seckill: env.SECKILL_OWNER_ADDRESS || ''
  },
  noPrivateKeyForServer: !hasValue(env.PRIVATE_KEY) || env.ALLOW_PRIVATE_KEY_IN_PROD_CHECK === 'true',
  orderSigning: {
    webhookConfigured: hasValue(env.ORDER_SIGNING_WEBHOOK_URL) && hasValue(env.ORDER_SIGNING_WEBHOOK_TOKEN),
    signerAddress: env.ORDER_SIGNER_ADDRESS || '',
    splitVersion: env.ESCROW_SPLIT_VERSION || ''
  },
  contracts: {
    npl: fixedNpl,
    escrow: env.EXPO_PUBLIC_ESCROW_ADDRESS || '',
    seckill: env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS || '',
    bnm: env.EXPO_PUBLIC_BNM_BSC_ADDRESS || '',
    rewardLedger: env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS || ''
  },
  fromBlocks: {
    escrow: env.ESCROW_FROM_BLOCK || deployments.escrow?.blockNumber || '',
    rewardLedger: env.REWARD_LEDGER_FROM_BLOCK || deployments.rewards?.fromBlock || '',
    seckill: env.SECKILL_FROM_BLOCK || deployments.seckill?.blockNumber || ''
  }
};

const steps = buildSteps();
const blockers = steps.filter((step) => step.status === 'missing').map((step) => ({ name: step.name, fix: step.fix }));
const warnings = (productionCheck.checks || [])
  .filter((entry) => entry.level === 'warn')
  .map((entry) => ({ name: entry.name, fix: entry.fix || '' }));
const report = {
  kind: '24k-dapp-deploy-readiness',
  generatedAt: new Date().toISOString(),
  fixedNpl,
  privateKeyPrinted: false,
  sendsTransactions: false,
  readyForStrictLaunch: blockers.length === 0,
  configured,
  deployments: summarizeDeployments(deployments),
  steps,
  blockers,
  warnings,
  commands: {
    localSafePlan: 'pnpm micro:plan -- --strict',
    deployRewardsWhenAuthorized: 'pnpm deploy:rewards -- --write-env',
    deployEscrowWhenAuthorized: 'pnpm deploy:escrow -- --write-env',
    deploySeckillWhenAuthorized: 'pnpm deploy:seckill -- --write-env',
    checkRewards: 'pnpm deploy:check-rewards',
    checkSeckill: 'pnpm deploy:check-seckill',
    checkEscrow: 'pnpm deploy:check-escrow',
    exportFrontendPack: 'pnpm dapp:frontend-pack',
    strictWalletLaunch: 'pnpm dapp:wallet-launch -- --strict',
    strictProduction: 'pnpm dapp:prod-check -- --strict'
  },
  artifacts: {
    json: JSON_OUT,
    markdown: MD_OUT,
    publicTodoEnv: ENV_TODO_OUT
  }
};

fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(MD_OUT, renderMarkdown(report));
fs.writeFileSync(ENV_TODO_OUT, renderPublicTodoEnv(report));
assertNoSecretAssignments(fs.readFileSync(ENV_TODO_OUT, 'utf8'));

console.log('DApp deploy readiness export: PASS');
console.log(`readyForStrictLaunch: ${report.readyForStrictLaunch ? 'yes' : 'no'}`);
console.log(`blockers: ${report.blockers.length}`);
console.log(`wrote ${JSON_OUT}`);
console.log(`wrote ${MD_OUT}`);
console.log(`wrote ${ENV_TODO_OUT}`);
console.log('PRIVATE_KEY printed: false');

function buildSteps() {
  const steps = [];
  addStep(steps, {
    name: 'BSC chain and fixed NPL',
    ok: configured.chainId === '56' && configured.contracts.npl.toLowerCase() === fixedNpl,
    evidence: `chainId=${configured.chainId}, NPL=${configured.contracts.npl}`,
    fix: `Set EXPO_PUBLIC_BSC_CHAIN_ID=56 and EXPO_PUBLIC_NPL_BSC_ADDRESS=${fixedNpl}.`
  });
  addStep(steps, {
    name: 'BNMToken + RewardLedger deployed/configured',
    ok: isAddress(configured.contracts.bnm) && isAddress(configured.contracts.rewardLedger),
    evidence: `BNM=${configured.contracts.bnm || '<missing>'}, RewardLedger=${configured.contracts.rewardLedger || '<missing>'}`,
    fix: 'Authorize gas locally and run pnpm deploy:rewards -- --write-env; then pnpm deploy:check-rewards.'
  });
  addStep(steps, {
    name: 'PaymentEscrow deployed/configured after RewardLedger',
    ok: isAddress(configured.contracts.escrow),
    evidence: configured.contracts.escrow || '<missing>',
    fix: 'After rewards, authorize gas locally and run pnpm deploy:escrow -- --write-env; this configures split, seller, ledger operator and unpause; then run pnpm deploy:check-escrow.'
  });
  addStep(steps, {
    name: 'External order signer and split version configured',
    ok: configured.orderSigning.webhookConfigured && isAddress(configured.orderSigning.signerAddress) && /^[1-9][0-9]*$/.test(configured.orderSigning.splitVersion),
    evidence: `webhook=${configured.orderSigning.webhookConfigured ? 'configured' : '<missing>'}, signer=${configured.orderSigning.signerAddress || '<missing>'}, splitVersion=${configured.orderSigning.splitVersion || '<missing>'}`,
    fix: 'Set ORDER_SIGNING_WEBHOOK_URL/TOKEN, ORDER_SIGNER_ADDRESS and ESCROW_SPLIT_VERSION on the server; do not put the signer private key there.'
  });
  addStep(steps, {
    name: 'Seckill deployed/configured',
    ok: isAddress(configured.contracts.seckill) && /^[1-9][0-9]*$/.test(configured.seckillMaxGasPriceWei),
    evidence: `${configured.contracts.seckill || '<missing>'}, maxGasPriceWei=${configured.seckillMaxGasPriceWei || '<missing>'}`,
    fix: 'Set SECKILL_MAX_GAS_PRICE_WEI, authorize gas locally and run pnpm deploy:seckill -- --write-env; then pnpm deploy:check-seckill.'
  });
  addStep(steps, {
    name: 'Genesis credential and multisig owners configured',
    ok: configured.genesisNodeConfigured && configured.genesisNodeTokenIdConfigured && configured.ownerWalletsConfigured,
    evidence: `genesisNode=${configured.genesisNodeConfigured ? 'configured' : '<missing>'}, standard=${configured.genesisNodeStandard}, tokenId=${configured.genesisNodeTokenIdConfigured ? 'configured/not-required' : '<missing>'}, owners=${configured.ownerWalletsConfigured ? 'configured' : '<missing>'}`,
    fix: 'Set GENESIS_NODE_CONTRACT, GENESIS_NODE_TOKEN_STANDARD, ERC1155 token id when required, and all three *_OWNER_ADDRESS values to reviewed production contracts/multisigs.'
  });
  addStep(steps, {
    name: 'Indexer from-blocks configured',
    ok: Boolean(configured.fromBlocks.escrow) && Boolean(configured.fromBlocks.rewardLedger) && Boolean(configured.fromBlocks.seckill),
    evidence: JSON.stringify(configured.fromBlocks),
    fix: 'Set ESCROW_FROM_BLOCK, REWARD_LEDGER_FROM_BLOCK and SECKILL_FROM_BLOCK from deployment receipts.'
  });
  addStep(steps, {
    name: 'HTTPS API and wallet entry',
    ok: isHttps(configured.apiBaseUrl) && isHttps(configured.walletEntryUrl),
    evidence: `api=${configured.apiBaseUrl || '<missing>'}, entry=${configured.walletEntryUrl || '<missing>'}`,
    fix: 'Set DAPP_BASE_URL / EXPO_PUBLIC_API_BASE_URL and DAPP_ENTRY_URL / FRONTEND_URL to HTTPS domains or HTTPS tunnels.'
  });
  addStep(steps, {
    name: 'Wallet UI project id',
    ok: configured.reownProjectIdConfigured,
    evidence: configured.reownProjectIdConfigured ? 'configured' : '<missing>',
    fix: 'Set EXPO_PUBLIC_REOWN_PROJECT_ID.'
  });
  addStep(steps, {
    name: 'Admin and chain-event production settings',
    ok: configured.adminWalletConfigured && configured.chainEventRpcConfigured && configured.explorerMonitoringConfigured,
    evidence: `adminWallet=${configured.adminWalletConfigured ? 'configured' : '<missing>'}, chainEventRpc=${configured.chainEventRpcConfigured ? 'configured' : '<missing>'}, explorer=${configured.explorerMonitoringConfigured ? 'configured' : '<missing>'}`,
    fix: 'Set ADMIN_WALLET_ADDRESS, CHAIN_EVENT_RPC_URL/BSC_RPC_URL and EXPLORER_API_KEY on the production server.'
  });
  addStep(steps, {
    name: 'Production server excludes deploy wallet key',
    ok: configured.noPrivateKeyForServer,
    evidence: configured.noPrivateKeyForServer ? 'server-safe' : 'local deploy key present in current env',
    fix: 'Keep deploy wallet key only in local deployment env; do not put it on the production DApp server.'
  });
  return steps;
}

function addStep(steps, { name, ok, evidence, fix }) {
  steps.push({ name, status: ok ? 'ok' : 'missing', evidence, fix: ok ? '' : fix });
}

function summarizeDeployments(input) {
  return {
    escrow: input.escrow ? pick(input.escrow, ['contractName', 'address', 'txHash', 'chainId', 'blockNumber', 'createdAt']) : null,
    rewards: input.rewards ? pick(input.rewards, ['contractGroup', 'bnmAddress', 'rewardLedgerAddress', 'setMinterTxHash', 'chainId', 'fromBlock', 'createdAt']) : null,
    seckill: input.seckill ? pick(input.seckill, ['contractName', 'address', 'txHash', 'chainId', 'blockNumber', 'callerRule', 'maxGasPriceWei', 'setMaxGasPriceTxHash', 'createdAt']) : null
  };
}

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key] ?? '']));
}

function runJson(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) return { ok: false, checks: [], error: result.stderr || result.stdout };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, checks: [], error: `Cannot parse ${script} output` };
  }
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(resolve(path), 'utf8'));
  } catch {
    return null;
  }
}

function renderMarkdown(report) {
  const stepRows = report.steps.map((step, index) => `${index + 1}. ${step.status === 'ok' ? '✅' : '⚠️'} **${step.name}** — ${step.evidence}${step.fix ? `\n   - Fix: ${step.fix}` : ''}`).join('\n');
  const blockerRows = report.blockers.length ? report.blockers.map((entry) => `- ${entry.name} — ${entry.fix}`).join('\n') : '- none';
  const warningRows = report.warnings.length ? report.warnings.map((entry) => `- ${entry.name}${entry.fix ? ` — ${entry.fix}` : ''}`).join('\n') : '- none';
  return `# 24K DApp Deploy Readiness

- Generated at: ${report.generatedAt}
- Sends transactions: false
- Ready for strict launch: ${report.readyForStrictLaunch ? 'yes' : 'no'}
- Fixed NPL: \`${report.fixedNpl}\`
- Private key printed: false

## Current steps

${stepRows}

## Blockers

${blockerRows}

## Production warnings

${warningRows}

## Safe order to finish launch

1. Run local no-transaction plan: \`${report.commands.localSafePlan}\`.
2. Only after explicit gas authorization, deploy missing contracts locally. Never paste the deploy wallet key into chat.
3. If rewards are missing: \`${report.commands.deployRewardsWhenAuthorized}\`, then \`${report.commands.checkRewards}\`.
4. If escrow is missing: \`${report.commands.deployEscrowWhenAuthorized}\`, then \`${report.commands.checkEscrow}\`.
5. If seckill is missing: \`${report.commands.deploySeckillWhenAuthorized}\`, then \`${report.commands.checkSeckill}\`.
6. Set HTTPS frontend/API URLs and rerun \`${report.commands.exportFrontendPack}\`.
7. Final gates: \`${report.commands.strictWalletLaunch}\` and \`${report.commands.strictProduction}\`.

## Files

- \`${report.artifacts.markdown}\`
- \`${report.artifacts.json}\`
- \`${report.artifacts.publicTodoEnv}\`
`;
}

function renderPublicTodoEnv(report) {
  return [
    '# 24K DApp public deploy todo env',
    '# This file is safe to share. It intentionally does not contain deploy wallet keys or server secrets.',
    `EXPO_PUBLIC_BSC_CHAIN_ID=56`,
    `EXPO_PUBLIC_NPL_BSC_ADDRESS=${fixedNpl}`,
    `EXPO_PUBLIC_ESCROW_ADDRESS=${configured.contracts.escrow || '<escrow_address>'}`,
    `EXPO_PUBLIC_BNM_BSC_ADDRESS=${configured.contracts.bnm || '<bnm_address>'}`,
    `EXPO_PUBLIC_REWARD_LEDGER_ADDRESS=${configured.contracts.rewardLedger || '<reward_ledger_address>'}`,
    `EXPO_PUBLIC_SECKILL_ADDRESS=${configured.contracts.seckill || '<seckill_address>'}`,
    `GENESIS_NODE_CONTRACT=${env.GENESIS_NODE_CONTRACT || '<genesis_node_contract>'}`,
    `SECKILL_MAX_GAS_PRICE_WEI=${configured.seckillMaxGasPriceWei || '<seckill_max_gas_price_wei>'}`,
    `ESCROW_OWNER_ADDRESS=${configured.ownerWallets.escrow || '<escrow_multisig_owner>'}`,
    `REWARDS_OWNER_ADDRESS=${configured.ownerWallets.rewards || '<rewards_multisig_owner>'}`,
    `SECKILL_OWNER_ADDRESS=${configured.ownerWallets.seckill || '<seckill_multisig_owner>'}`,
    `ESCROW_FROM_BLOCK=${configured.fromBlocks.escrow || '<escrow_from_block>'}`,
    `REWARD_LEDGER_FROM_BLOCK=${configured.fromBlocks.rewardLedger || '<reward_ledger_from_block>'}`,
    `SECKILL_FROM_BLOCK=${configured.fromBlocks.seckill || '<seckill_from_block>'}`,
    `DAPP_BASE_URL=${configured.apiBaseUrl || '<https_api_domain>'}`,
    `DAPP_ENTRY_URL=${configured.walletEntryUrl && isHttps(configured.walletEntryUrl) ? configured.walletEntryUrl : '<https_frontend_domain>'}`,
    `DAPP_QR_URL=${configured.walletEntryUrl && isHttps(configured.walletEntryUrl) ? configured.walletEntryUrl : '<https_frontend_domain>'}`,
    ''
  ].join('\n');
}

function assertNoSecretAssignments(text) {
  const forbidden = [/^PRIVATE_KEY=/m, /^INDEXER_SECRET=/m, /^ADMIN_SECRET=/m, /^JWT_SECRET=/m, /^EXPLORER_API_KEY=/m, /^ETHERSCAN_API_KEY=/m, /^BSCSCAN_API_KEY=/m, /^BASESCAN_API_KEY=/m];
  const leaks = forbidden.filter((pattern) => pattern.test(text)).map(String);
  if (leaks.length) throw new Error(`Deploy readiness env contains server/deploy secret assignments: ${leaks.join(', ')}`);
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

function isHttps(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch {
    return false;
  }
}
