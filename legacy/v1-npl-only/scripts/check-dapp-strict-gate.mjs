#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const OUT_DIR = resolve(process.env.DAPP_STRICT_GATE_OUT_DIR || 'test-artifacts');
const JSON_OUT = resolve(OUT_DIR, 'dapp-strict-gate.report.json');
const MD_OUT = resolve(OUT_DIR, 'dapp-strict-gate.md');
const reportOnly = process.argv.includes('--report-only') || process.env.DAPP_STRICT_GATE_REPORT_ONLY === 'true';
const failOnBlocker = !reportOnly;
const skipLocalTransactions = process.argv.includes('--no-local-transactions')
  || process.env.DAPP_STRICT_GATE_SKIP_LOCAL_TX === 'true';
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const commandTimeoutMs = positiveInteger(process.env.DAPP_STRICT_GATE_COMMAND_TIMEOUT_MS, 180_000);
const productionEnvFile = resolve(process.env.DAPP_PROD_ENV_FILE || '.env.production');
const knownSecrets = loadKnownSecrets();
const portOffset = process.pid % 5_000;

fs.mkdirSync(OUT_DIR, { recursive: true });

const deployReadinessRun = runNode({
  id: 'deploy-readiness-export',
  label: 'deploy:readiness export',
  display: 'pnpm dapp:deploy-readiness',
  script: 'scripts/export-dapp-deploy-readiness.mjs',
  extraEnv: { DAPP_DEPLOY_READINESS_OUT_DIR: OUT_DIR }
});
const launchStatusRun = runNode({
  id: 'runtime-launch-status-export',
  label: 'runtime launch status export',
  display: 'pnpm dapp:launch-status',
  script: 'scripts/export-dapp-launch-status.mjs',
  extraEnv: {
    DAPP_LAUNCH_STATUS_OUT_DIR: OUT_DIR,
    DAPP_LAUNCH_STATUS_PORT: String(23_000 + portOffset)
  }
});
const walletLaunchRun = runNode({
  id: 'wallet-launch-export',
  label: 'wallet launch export',
  display: 'pnpm dapp:wallet-launch',
  script: 'scripts/export-dapp-wallet-launch.mjs',
  extraEnv: {
    DAPP_WALLET_LAUNCH_OUT_DIR: OUT_DIR,
    DAPP_FRONTEND_ENV_OUT_DIR: OUT_DIR
  }
});
const frontendEnvExportRun = runNode({
  id: 'frontend-env-export',
  label: 'frontend env export',
  display: 'pnpm dapp:frontend-env',
  script: 'scripts/export-dapp-frontend-env.mjs',
  extraEnv: { DAPP_FRONTEND_ENV_OUT_DIR: OUT_DIR }
});
const productionEnvExportRun = runNode({
  id: 'production-env-export',
  label: 'production env export',
  display: 'pnpm dapp:prod-env',
  script: 'scripts/export-production-env.mjs',
  extraEnv: { DAPP_PROD_ENV_OUT_DIR: OUT_DIR }
});
const frontendEnvStrictRun = runNode({
  id: 'frontend-env-strict',
  label: 'frontend public env strict',
  display: 'pnpm dapp:frontend-env-check -- --strict',
  script: 'scripts/check-dapp-frontend-env.mjs',
  args: ['--strict'],
  extraEnv: {
    DAPP_FRONTEND_ENV_FILE: resolve(OUT_DIR, 'dapp-frontend.env'),
    DAPP_FRONTEND_ENV_CHECK_REPORT: resolve(OUT_DIR, 'dapp-frontend-env-check.report.json')
  }
});
const productionStrictRun = runNode({
  id: 'production-env-strict',
  label: 'production env strict',
  display: 'pnpm dapp:prod-check',
  script: 'scripts/check-dapp-production-env.mjs',
  args: ['--strict', '--file', productionEnvFile]
});

const deployReadiness = readJson(resolve(OUT_DIR, 'dapp-deploy-readiness.json'))
  || parseJson(deployReadinessRun.stdout)
  || {};
const launchStatus = readJson(resolve(OUT_DIR, 'dapp-launch-status.json'))
  || parseJson(launchStatusRun.stdout)
  || {};
const walletLaunch = readJson(resolve(OUT_DIR, 'dapp-wallet-launch.json'))
  || parseJson(walletLaunchRun.stdout)
  || {};
const frontendEnvStrict = parseJson(frontendEnvStrictRun.stdout)
  || readJson(resolve(OUT_DIR, 'dapp-frontend-env-check.report.json'))
  || {};
const productionStrict = parseJson(productionStrictRun.stdout) || {};

const typecheckRun = runCommand({
  id: 'typecheck',
  label: 'typecheck',
  display: 'pnpm typecheck',
  command: process.execPath,
  args: ['node_modules/typescript/bin/tsc', '--noEmit']
});
const contractsTestRun = runCommand({
  id: 'contracts-test',
  label: 'contracts:test',
  display: 'pnpm contracts:test',
  command: 'forge',
  args: [
    'test',
    '-vv',
    '--out', resolve(OUT_DIR, 'foundry-out'),
    '--cache-path', resolve(OUT_DIR, 'foundry-cache')
  ],
  extraEnv: { FOUNDRY_ETH_RPC_URL: '', ETH_RPC_URL: '', BSC_RPC_URL: '' }
});
const backendCheckRun = runNode({
  id: 'backend-check',
  label: 'backend:check',
  display: 'pnpm backend:check',
  script: 'scripts/check-backend.mjs',
  extraEnv: { BACKEND_CHECK_PORT: String(25_000 + portOffset) }
});
const serverOperationsRun = runNode({
  id: 'server-operations-check',
  label: 'server:ops-check',
  display: 'pnpm server:ops-check',
  script: 'scripts/check-server-operations.mjs'
});
const auditMvpRun = runNode({
  id: 'audit-mvp',
  label: 'audit:mvp',
  display: 'pnpm audit:mvp',
  script: 'scripts/audit-mvp.mjs'
});
const dappCheckRun = runNode({
  id: 'dapp-check',
  label: 'dapp:check',
  display: 'pnpm dapp:check',
  script: 'scripts/check-dapp-backend-flow.mjs',
  extraEnv: { DAPP_FLOW_PORT: String(28_000 + portOffset) }
});
const e2eLocalRun = skipLocalTransactions
  ? skippedRun({
      id: 'e2e-local',
      label: 'e2e:local',
      display: 'pnpm e2e:local',
      blocks: true,
      reason: 'Local Anvil transaction exercise was disabled by --no-local-transactions / DAPP_STRICT_GATE_SKIP_LOCAL_TX.'
    })
  : runNode({
      id: 'e2e-local',
      label: 'e2e:local',
      display: 'pnpm e2e:local',
      script: 'scripts/e2e/local-checkout.mjs',
      extraEnv: {
        ANVIL_PORT: String(34_000 + portOffset),
        E2E_API_PORT: String(40_000 + portOffset)
      }
    });
const e2eFullRun = runNode({
  id: 'e2e-full',
  label: 'e2e:full',
  display: 'pnpm e2e:full',
  script: 'scripts/e2e/full-business-flow.mjs',
  extraEnv: { FULL_E2E_API_PORT: String(46_000 + portOffset) }
});
const appCheckRun = runNode({
  id: 'app-check',
  label: 'app:check',
  display: 'pnpm app:check',
  script: 'scripts/check-app-ux.mjs'
});
const paymentCheckRun = runNode({
  id: 'payment-check',
  label: 'payment:check',
  display: 'pnpm payment:check',
  script: 'scripts/check-payment-payload.mjs'
});
const txCheckRun = runNode({
  id: 'tx-check',
  label: 'tx:check',
  display: 'pnpm tx:check',
  script: 'scripts/check-tx-receipt.mjs'
});
const frontendCheckRun = runNode({
  id: 'dapp-frontend-check',
  label: 'dapp:frontend-check',
  display: 'pnpm dapp:frontend-check',
  script: 'scripts/check-dapp-frontend-consumption.mjs',
  extraEnv: { DAPP_FRONTEND_CONSUMPTION_OUT_DIR: OUT_DIR }
});
const signerCheckRun = runNode({
  id: 'signer-check',
  label: 'signer:check',
  display: 'pnpm signer:check',
  script: 'scripts/check-production-order-signer.mjs'
});
const nplCheckRun = runNode({
  id: 'npl-check',
  label: 'npl:check',
  display: 'pnpm npl:check',
  script: 'scripts/check-npl-token.mjs',
  args: ['--strict'],
  extraEnv: { NPL_CHECK_ENV_FILE: productionEnvFile }
});
const screenshotsCheckRun = runNode({
  id: 'screenshots-check',
  label: 'screenshots:check',
  display: 'pnpm screenshots:check',
  script: 'scripts/check-screenshots.mjs'
});
const deviceCheckRun = runNode({
  id: 'device-check',
  label: 'device:check',
  display: 'pnpm device:check',
  script: 'scripts/check-device-ux-results.mjs',
  args: ['--require-pass']
});

const configuredContracts = deployReadiness.configured?.contracts || {};
const rewardsDeployCheckRun = isAddress(configuredContracts.bnm) && isAddress(configuredContracts.rewardLedger)
  ? runNode({
      id: 'deploy-check-rewards',
      label: 'deploy:check-rewards',
      display: 'pnpm deploy:check-rewards',
      script: 'scripts/deploy/check-rewards.mjs'
    })
  : skippedRun({
      id: 'deploy-check-rewards',
      label: 'deploy:check-rewards',
      display: 'pnpm deploy:check-rewards',
      blocks: false,
      reason: 'BNMToken and/or RewardLedger address is missing; deploy:readiness owns this blocker.'
    });
const escrowDeployCheckRun = isAddress(configuredContracts.escrow)
  ? runNode({
      id: 'deploy-check-escrow',
      label: 'deploy:check-escrow',
      display: 'pnpm deploy:check-escrow',
      script: 'scripts/deploy/check-escrow.mjs'
    })
  : skippedRun({
      id: 'deploy-check-escrow',
      label: 'deploy:check-escrow',
      display: 'pnpm deploy:check-escrow',
      blocks: false,
      reason: 'PaymentEscrow address is missing; deploy:readiness owns this blocker.'
    });
const seckillDeployCheckRun = isAddress(configuredContracts.seckill)
  ? runNode({
      id: 'deploy-check-seckill',
      label: 'deploy:check-seckill',
      display: 'pnpm deploy:check-seckill',
      script: 'scripts/deploy/check-seckill.mjs'
    })
  : skippedRun({
      id: 'deploy-check-seckill',
      label: 'deploy:check-seckill',
      display: 'pnpm deploy:check-seckill',
      blocks: false,
      reason: 'Seckill address is missing; deploy:readiness owns this blocker.'
    });

const requiredCheckRuns = [
  typecheckRun,
  contractsTestRun,
  backendCheckRun,
  serverOperationsRun,
  auditMvpRun,
  dappCheckRun,
  e2eLocalRun,
  e2eFullRun,
  appCheckRun,
  paymentCheckRun,
  txCheckRun,
  frontendCheckRun,
  signerCheckRun,
  nplCheckRun,
  screenshotsCheckRun,
  deviceCheckRun
];
const deployCheckRuns = [rewardsDeployCheckRun, escrowDeployCheckRun, seckillDeployCheckRun];
const setupRuns = [
  deployReadinessRun,
  launchStatusRun,
  walletLaunchRun,
  frontendEnvExportRun,
  productionEnvExportRun,
  frontendEnvStrictRun,
  productionStrictRun
];
const allRuns = [...setupRuns, ...requiredCheckRuns, ...deployCheckRuns];
const mainnetEvidence = inspectMainnetEvidence(configuredContracts.escrow);

const gates = [
  ...requiredCheckRuns.map(commandGate),
  gate(
    'deploy-readiness',
    'Deploy readiness',
    deployReadiness.readyForStrictLaunch === true,
    deployReadiness.blockers || [],
    'Finish contracts, from-blocks, HTTPS, admin, RPC, and private-key separation from dapp-deploy-readiness.md.',
    'pnpm dapp:deploy-readiness'
  ),
  gate(
    'runtime-launch-status',
    'Runtime launch status',
    launchStatus.strictLaunchOk === true,
    launchStatus.strictLaunchBlockers || [],
    'Fix live backend /api/dapp/launch-status blockers before wallet/DEX launch.',
    'pnpm dapp:launch-status'
  ),
  gate(
    'wallet-browser-launch',
    'Wallet browser launch',
    walletLaunch.readyForPhoneWallet === true,
    walletLaunch.phoneWalletBlockers || [],
    'Use an HTTPS wallet entry and configured BSC contracts from dapp-wallet-launch.md.',
    'pnpm dapp:wallet-launch -- --strict'
  ),
  gate(
    'frontend-env-strict',
    'Frontend public env strict',
    frontendEnvStrict.ok === true,
    failedChecks(frontendEnvStrict),
    'Fix dapp-frontend.env public URLs/contracts and rerun the strict frontend env check.',
    'pnpm dapp:frontend-env-check -- --strict'
  ),
  gate(
    'production-env-strict',
    'Production env strict',
    productionStrict.ok === true,
    failedChecks(productionStrict),
    'Fix .env.production; the production API must not contain PRIVATE_KEY.',
    'pnpm dapp:prod-check'
  ),
  ...deployCheckRuns.map(commandGate),
  gate(
    'mainnet-evidence',
    'Mainnet micro-test evidence',
    mainnetEvidence.ok,
    mainnetEvidence.checks
      .filter((entry) => !entry.ok)
      .map((entry) => ({ key: 'mainnet-evidence', name: entry.name, fix: entry.fix })),
    'Provide a generated PASS report backed by BSC deployment and successful transaction evidence; the template never counts.',
    'pnpm micro:report',
    { evidenceChecks: mainnetEvidence.checks }
  )
];

const gateBlockers = gates.flatMap((entry) => entry.blockers.map((blocker) => ({
  key: blocker.key,
  gateId: entry.id,
  gate: entry.name,
  name: blocker.name,
  fix: blocker.fix || entry.fix
})));
const commandFailures = allRuns
  .filter((run) => !run.skipped && run.status !== 0)
  .map(commandFailureBlocker);
const rawBlockers = dedupeRawBlockers([...gateBlockers, ...commandFailures]);
const blockers = dedupeBlockers(rawBlockers);
const criticalPath = buildCriticalPath(blockers);
const ok = blockers.length === 0 && gates.every((entry) => entry.status !== 'fail');

const unsafeReport = {
  kind: '24k-dapp-strict-gate',
  generatedAt: new Date().toISOString(),
  fixedNpl,
  ok,
  verdict: ok ? 'PASS' : 'FAIL',
  failOnBlocker,
  blockerCount: blockers.length,
  rawBlockerCount: rawBlockers.length,
  privateKeyPrinted: false,
  transactionScope: {
    mainnetTransactionsSent: false,
    externalTransactionsSent: false,
    localEphemeralAnvilE2E: e2eLocalRun.skipped ? 'skipped-and-blocked' : 'executed'
  },
  gates,
  blockers,
  uniqueBlockers: blockers,
  rawBlockers,
  criticalPath,
  commandFailures,
  strictCommandFailures: commandFailures,
  runs: allRuns.map(summarizeRun),
  mainnetEvidence,
  artifacts: {
    json: JSON_OUT,
    markdown: MD_OUT,
    deployReadiness: resolve(OUT_DIR, 'dapp-deploy-readiness.md'),
    launchStatus: resolve(OUT_DIR, 'dapp-launch-status.md'),
    walletLaunch: resolve(OUT_DIR, 'dapp-wallet-launch.md'),
    frontendEnv: resolve(OUT_DIR, 'dapp-frontend.env'),
    productionEnvTemplate: resolve(OUT_DIR, 'dapp-production.env'),
    productionEnvChecked: productionEnvFile,
    frontendEnvCheck: resolve(OUT_DIR, 'dapp-frontend-env-check.report.json'),
    frontendConsumption: resolve(OUT_DIR, 'dapp-frontend-consumption.report.json'),
    mainnetReport: mainnetEvidence.artifacts.report,
    mainnetDeployment: mainnetEvidence.artifacts.deployment,
    mainnetTransactions: mainnetEvidence.artifacts.transactions
  },
  commands: Object.fromEntries(allRuns.map((run) => [run.id, run.display]))
};
const report = sanitizeValue(unsafeReport);
const jsonText = `${JSON.stringify(report, null, 2)}\n`;
const markdownText = sanitizeText(renderMarkdown(report));
assertNoSecretLeaks(jsonText);
assertNoSecretLeaks(markdownText);

fs.writeFileSync(JSON_OUT, jsonText);
fs.writeFileSync(MD_OUT, markdownText);

console.log(`DApp strict gate report: ${report.verdict}`);
console.log(`ok: ${report.ok ? 'yes' : 'no'}`);
console.log(`blockers: ${report.blockerCount}`);
for (const blocker of report.blockers) {
  console.log(`BLOCKER [${blocker.sources.join(', ')}] ${blocker.title}`);
  if (blocker.rawNames.length) console.log(`  evidence: ${blocker.rawNames.join('; ')}`);
  if (blocker.fixes.length) console.log(`  fix: ${blocker.fixes.join(' | ')}`);
}
console.log(`wrote ${JSON_OUT}`);
console.log(`wrote ${MD_OUT}`);
console.log('PRIVATE_KEY printed: false');
console.log('mainnet transactions sent: false');
if (failOnBlocker && !report.ok) process.exit(1);

function runNode({ id, label, display, script, args = [], extraEnv = {}, timeoutMs }) {
  return runCommand({
    id,
    label,
    display,
    command: process.execPath,
    args: [script, ...args],
    extraEnv,
    timeoutMs,
    script
  });
}

function runCommand({ id, label, display, command, args = [], extraEnv = {}, timeoutMs, script = '' }) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs || commandTimeoutMs,
    killSignal: 'SIGTERM'
  });
  return {
    id,
    label,
    display,
    script: script || command,
    args,
    status: result.status ?? 1,
    signal: result.signal || '',
    errorCode: result.error?.code || '',
    durationMs: Date.now() - startedAt,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    skipped: false,
    blocks: true,
    skipReason: ''
  };
}

function skippedRun({ id, label, display, blocks, reason }) {
  return {
    id,
    label,
    display,
    script: '',
    args: [],
    status: null,
    signal: '',
    errorCode: '',
    durationMs: 0,
    stdout: '',
    stderr: '',
    skipped: true,
    blocks,
    skipReason: reason
  };
}

function commandGate(run) {
  if (run.skipped && !run.blocks) {
    return skippedGate(run.id, run.label, run.display, run.skipReason);
  }
  if (run.skipped) {
    return gate(
      run.id,
      run.label,
      false,
      [{ key: `command-${run.id}`, name: `${run.label} was not executed`, fix: run.skipReason }],
      run.skipReason,
      run.display
    );
  }
  return gate(
    run.id,
    run.label,
    run.status === 0,
    run.status === 0 ? [] : [commandFailureBlocker(run)],
    run.status === 0 ? '' : summarizeFailure(run),
    run.display
  );
}

function commandFailureBlocker(run) {
  return {
    key: `command-${run.id}`,
    gateId: run.id,
    gate: run.label,
    name: `${run.label} command failed`,
    fix: summarizeFailure(run)
  };
}

function summarizeRun(run) {
  return {
    id: run.id,
    name: run.label,
    command: run.display,
    status: run.skipped ? 'skipped' : (run.status === 0 ? 'pass' : 'fail'),
    exitCode: run.skipped ? null : run.status,
    signal: run.signal || undefined,
    durationMs: run.durationMs,
    reason: run.skipped ? run.skipReason : (run.status === 0 ? undefined : summarizeFailure(run))
  };
}

function gate(id, name, ok, gateBlockerInput, fix, command, extra = {}) {
  return {
    id,
    name,
    status: ok ? 'pass' : 'fail',
    ok,
    command,
    blockers: ok ? [] : normalizeBlockers(gateBlockerInput, fix),
    fix: ok ? '' : fix,
    ...extra
  };
}

function skippedGate(id, name, command, reason) {
  return {
    id,
    name,
    status: 'skip',
    ok: null,
    command,
    blockers: [],
    fix: '',
    reason
  };
}

function normalizeBlockers(input, fallbackFix) {
  if (!Array.isArray(input) || input.length === 0) {
    return [{ name: 'not ready', fix: fallbackFix }];
  }
  return input.map((entry) => {
    if (typeof entry === 'string') return { name: entry, fix: fallbackFix };
    return {
      key: entry.key,
      name: entry.name || entry.gate || 'not ready',
      fix: entry.fix || fallbackFix
    };
  });
}

function failedChecks(summary) {
  return (summary?.checks || []).filter((entry) => entry.level === 'fail');
}

function parseJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {}
    }
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function summarizeFailure(run) {
  if (run.errorCode === 'ETIMEDOUT') return `Timed out after ${run.durationMs}ms.`;
  const lines = `${run.stdout}\n${run.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/ExperimentalWarning/.test(line));
  const output = lines.slice(-12).join(' | ');
  const fallback = `${run.display} exited with ${run.status}${run.signal ? ` (${run.signal})` : ''}.`;
  return sanitizeFailure(output || fallback).slice(0, 4_000);
}

function dedupeRawBlockers(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = [item.key || '', item.gateId || item.gate || '', item.name || '', item.fix || ''].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeBlockers(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.key || blockerKey(item.name);
    const existing = groups.get(key) || {
      key,
      title: blockerTitle(key, item.name),
      sources: [],
      fixes: new Set(),
      rawNames: new Set(),
      occurrences: 0
    };
    existing.sources.push(item.gate);
    if (item.fix) existing.fixes.add(item.fix);
    if (item.name) existing.rawNames.add(item.name);
    existing.occurrences += 1;
    groups.set(key, existing);
  }
  return [...groups.values()].map((entry) => ({
    key: entry.key,
    title: entry.title,
    sources: [...new Set(entry.sources)],
    rawNames: [...entry.rawNames],
    fixes: [...entry.fixes],
    occurrences: entry.occurrences
  }));
}

function blockerKey(name) {
  const text = String(name || '').toLowerCase();
  if (/bnm|rewardledger|reward ledger/.test(text)) return 'deploy-rewards';
  if (/paymentescrow|payment escrow|escrow contract|escrow deployed/.test(text)) return 'deploy-escrow';
  if (/seckill/.test(text)) return 'deploy-seckill';
  if (/order signer|order signing|split version/.test(text)) return 'order-signing';
  if (/from-block|from block|indexer/.test(text) && !/secret/.test(text)) return 'event-from-blocks';
  if (/production server excludes deploy wallet|deploy wallet key|private_key|private key/.test(text)) return 'server-private-key-split';
  if (/admin.*wallet|admin siwe/.test(text)) return 'admin-wallet';
  if (/chain event rpc|chain-event rpc|server-side chain event rpc/.test(text)) return 'chain-event-rpc';
  if (/wallet.*entry|entry url|qr url/.test(text)) return 'https-wallet-entry';
  if (/public dapp\/api|api base url/.test(text)) return 'https-public-api';
  if (/indexer_secret|jwt_secret|admin_secret|unverified chain events/.test(text)) return 'server-secrets';
  if (/production db path/.test(text)) return 'production-db';
  if (/cors origins/.test(text)) return 'cors-origins';
  if (/amap/.test(text)) return 'amap-key';
  if (/electronic waybill/.test(text)) return 'electronic-waybill';
  if (/shipment query/.test(text)) return 'shipment-query';
  if (/cloud print/.test(text)) return 'cloud-print';
  if (/notification webhook/.test(text)) return 'notification-webhook';
  return text.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function blockerTitle(key, fallback) {
  return {
    'deploy-rewards': 'Deploy/configure BNMToken + RewardLedger',
    'deploy-escrow': 'Deploy/configure Abu24KPaymentEscrow',
    'deploy-seckill': 'Deploy/configure Abu24KSeckill',
    'order-signing': 'Configure external order signing webhook',
    'event-from-blocks': 'Set event indexer from-blocks',
    'https-wallet-entry': 'Set HTTPS wallet/DApp entry URL',
    'https-public-api': 'Set HTTPS public DApp/API URL',
    'admin-wallet': 'Set production admin SIWE wallet',
    'chain-event-rpc': 'Set production chain-event RPC',
    'server-secrets': 'Set production server secrets and verified events',
    'server-private-key-split': 'Keep deploy PRIVATE_KEY out of production server env',
    'production-db': 'Set an absolute production database path',
    'cors-origins': 'Configure exact production CORS origins',
    'amap-key': 'Configure AMap web-service key',
    'electronic-waybill': 'Configure electronic waybill integration',
    'shipment-query': 'Configure shipment query integration',
    'cloud-print': 'Configure cloud print integration',
    'notification-webhook': 'Configure notification integration',
    'mainnet-evidence': 'Provide verifiable mainnet micro-test PASS evidence'
  }[key] || fallback || key;
}

function buildCriticalPath(blockerItems) {
  const present = new Set(blockerItems.map((entry) => entry.key));
  const steps = [];
  const add = (key, title, command, note) => {
    if (present.has(key)) steps.push({ key, title, command, note });
  };
  add('deploy-rewards', 'Deploy BNMToken + RewardLedger', 'pnpm deploy:rewards -- --write-env && pnpm deploy:check-rewards', 'Requires explicit gas authorization and a local deploy wallet.');
  add('deploy-escrow', 'Deploy/configure Abu24KPaymentEscrow', 'pnpm deploy:escrow -- --write-env && pnpm deploy:check-escrow', 'Run after RewardLedger; configures split, seller, ledger operator, and unpause.');
  add('deploy-seckill', 'Deploy Abu24KSeckill', 'pnpm deploy:seckill -- --write-env && pnpm deploy:check-seckill', 'Requires explicit gas authorization and a local deploy wallet.');
  add('order-signing', 'Configure external order signer', 'set ORDER_SIGNING_WEBHOOK_URL/TOKEN, ORDER_SIGNER_ADDRESS and ESCROW_SPLIT_VERSION', 'The production API keeps no signer private key.');
  add('event-from-blocks', 'Set RewardLedger/Seckill from-blocks', 'set REWARD_LEDGER_FROM_BLOCK and SECKILL_FROM_BLOCK from deployment receipts', 'Use deployment receipt block numbers.');
  add('https-public-api', 'Set HTTPS public API URL', 'set DAPP_BASE_URL and EXPO_PUBLIC_API_BASE_URL', 'Wallet clients must reach the production API over HTTPS.');
  add('https-wallet-entry', 'Set HTTPS DApp entry URL', 'set DAPP_ENTRY_URL, FRONTEND_URL and DAPP_QR_URL', 'Wallet/DEX browsers cannot use localhost.');
  add('admin-wallet', 'Set admin SIWE wallet', 'set ADMIN_WALLET_ADDRESS=<admin_wallet>', 'Use an operations wallet or multisig address, not a private key.');
  add('chain-event-rpc', 'Set production chain-event RPC', 'set CHAIN_EVENT_RPC_URL=<bsc_rpc_url>', 'Used for receipt verification and status polling.');
  add('server-secrets', 'Set production server secrets and disable unverified events', 'set INDEXER_SECRET, JWT_SECRET, ADMIN_SECRET and ALLOW_UNVERIFIED_CHAIN_EVENTS=false', 'Keep chain-event writes and admin APIs controlled.');
  add('server-private-key-split', 'Remove deploy key from production API env', 'pnpm dapp:prod-env-check -- --strict', 'The generated production API env must not contain PRIVATE_KEY.');
  add('mainnet-evidence', 'Generate the formal mainnet micro-test report', 'pnpm micro:report', 'Only a generated PASS report backed by deployment and transaction hashes counts; the template is rejected.');
  steps.push({
    key: 'final-gate',
    title: 'Run final strict gate',
    command: 'pnpm dapp:strict-gate -- --strict',
    note: 'Passes only when every required gate and evidence check passes.'
  });
  return steps;
}

function inspectMainnetEvidence(expectedEscrow) {
  const artifacts = {
    report: resolve('MAINNET_MICRO_TEST_REPORT.md'),
    template: resolve('MAINNET_MICRO_TEST_REPORT.template.md'),
    deployment: resolve('deployments/mainnet-micro-test.json'),
    transactions: resolve('test-artifacts/tx-log.json'),
    rewardLedgerLocal: resolve('test-artifacts/reward-ledger-local.json')
  };
  const reportText = readText(artifacts.report);
  const templateText = readText(artifacts.template);
  const deployment = readJson(artifacts.deployment) || {};
  const txLogInput = readJson(artifacts.transactions);
  const txLog = Array.isArray(txLogInput) ? txLogInput : [];
  const rewardLedgerLocal = readJson(artifacts.rewardLedgerLocal) || {};
  const deploymentAddress = String(deployment.address || '');
  const deploymentHash = String(deployment.txHash || '');
  const requiredOperations = [
    { name: 'approve NPL for smoke escrow', target: fixedNpl },
    { name: 'pay smoke order', target: deploymentAddress },
    { name: 'force-refund smoke order', target: deploymentAddress },
    { name: 'approve NPL for backend fund-tx e2e', target: fixedNpl },
    { name: 'fund backend e2e order', target: deploymentAddress },
    { name: 'refund backend e2e order', target: deploymentAddress }
  ];
  const operationEvidence = requiredOperations.map((required) => {
    const entry = [...txLog].reverse().find((candidate) => (
      candidate?.operation === required.name
      && candidate?.result === 'success'
      && isHash(candidate?.hash)
      && isAddress(candidate?.target)
      && String(candidate.target).toLowerCase() === String(required.target).toLowerCase()
      && /^[1-9][0-9]*$/.test(String(candidate?.gasUsed || ''))
      && /^[0-9]+$/.test(String(candidate?.costWei || ''))
      && Number.isFinite(Date.parse(candidate?.timestamp || ''))
    ));
    return {
      operation: required.name,
      ok: Boolean(entry),
      hash: entry?.hash || '',
      target: entry?.target || ''
    };
  });
  const generatedAtMatch = reportText.match(/^- Generated at:\s*(\S+)\s*$/mi);
  const generatedAtMs = generatedAtMatch ? Date.parse(generatedAtMatch[1]) : Number.NaN;
  const evidenceTimes = operationEvidence
    .filter((entry) => entry.ok)
    .map((entry) => txLog.find((candidate) => candidate?.hash === entry.hash)?.timestamp)
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  if (deployment.createdAt && Number.isFinite(Date.parse(deployment.createdAt))) {
    evidenceTimes.push(Date.parse(deployment.createdAt));
  }

  const checks = [];
  addEvidenceCheck(
    checks,
    'Formal mainnet micro-test report exists',
    Boolean(reportText),
    'Generate MAINNET_MICRO_TEST_REPORT.md after the authorized micro-test workflow; the .template.md file is not evidence.'
  );
  addEvidenceCheck(
    checks,
    'Template or placeholder report is rejected',
    Boolean(reportText)
      && reportText.trim() !== templateText.trim()
      && !/PASS\s*\|\s*FAIL\s*\|\s*PARTIAL/i.test(reportText),
    'Replace the template/placeholder with the generated formal report.'
  );
  addEvidenceCheck(
    checks,
    'Report conclusion is explicit MAINNET NPL PAYMENT MICRO-TEST PASS',
    /- Status:\s*`MAINNET NPL PAYMENT MICRO-TEST PASS(?: - DEVICE UX CHECK REQUIRED)?`/i.test(reportText),
    'A partial, contract-only, or manually ambiguous status cannot pass the strict gate.'
  );
  addEvidenceCheck(
    checks,
    'Report identifies BSC chain 56',
    /^- Chain:\s*bsc\s*$/mi.test(reportText) && /^- Chain ID:\s*56\s*$/mi.test(reportText),
    'The formal report must identify BSC and chain ID 56.'
  );
  addEvidenceCheck(
    checks,
    'BSC deployment evidence is complete',
    isAddress(deploymentAddress)
      && isHash(deploymentHash)
      && Number(deployment.chainId) === 56
      && Number(deployment.blockNumber) > 0,
    'Provide deployments/mainnet-micro-test.json with BSC address, transaction hash, and block number.'
  );
  addEvidenceCheck(
    checks,
    'Configured escrow matches mainnet deployment evidence',
    !isAddress(expectedEscrow)
      || (isAddress(deploymentAddress) && deploymentAddress.toLowerCase() === expectedEscrow.toLowerCase()),
    'Use the deployed micro-test escrow address consistently in the production/readiness configuration.'
  );
  addEvidenceCheck(
    checks,
    'All six required NPL micro transactions have successful hash evidence',
    operationEvidence.every((entry) => entry.ok),
    `Record successful evidence for: ${requiredOperations.map((entry) => entry.name).join(', ')}.`
  );
  addEvidenceCheck(
    checks,
    'Report contains deployment and transaction hashes',
    isHash(deploymentHash)
      && reportText.includes(deploymentHash)
      && operationEvidence.every((entry) => entry.ok && reportText.includes(entry.hash)),
    'Regenerate the report from the deployment artifact and transaction log so every hash is visible and externally verifiable.'
  );
  addEvidenceCheck(
    checks,
    'Report records all required PASS summary flags',
    [
      'Escrow smoke passed: yes',
      'Backend fund-tx e2e passed: yes',
      'Local BNM/RewardLedger guard passed: yes'
    ].every((marker) => reportText.includes(marker)),
    'The formal report must explicitly confirm escrow smoke, backend fund-tx E2E, and the local reward guard.'
  );
  addEvidenceCheck(
    checks,
    'RewardLedger local guard artifact is PASS',
    rewardLedgerLocal.status === 'PASS',
    'Run the local RewardLedger guard and retain test-artifacts/reward-ledger-local.json with status PASS.'
  );
  addEvidenceCheck(
    checks,
    'Formal report was generated after its evidence',
    Number.isFinite(generatedAtMs)
      && evidenceTimes.length === operationEvidence.length + (deployment.createdAt ? 1 : 0)
      && evidenceTimes.every((timestamp) => timestamp <= generatedAtMs + 5 * 60_000),
    'Regenerate the formal report after the latest deployment and transaction evidence.'
  );

  return {
    ok: checks.every((entry) => entry.ok),
    artifacts,
    checks,
    deployment: {
      address: isAddress(deploymentAddress) ? deploymentAddress : '',
      txHash: isHash(deploymentHash) ? deploymentHash : '',
      chainId: Number(deployment.chainId) || null,
      blockNumber: Number(deployment.blockNumber) || null
    },
    operations: operationEvidence
  };
}

function addEvidenceCheck(checks, name, ok, fix) {
  checks.push({ name, ok: Boolean(ok), fix: ok ? '' : fix });
}

function renderMarkdown(report) {
  const gateRows = report.gates.map((entry) => {
    const state = entry.status.toUpperCase();
    const detail = entry.status === 'fail'
      ? ` - ${entry.fix}`
      : (entry.status === 'skip' ? ` - ${entry.reason}` : '');
    return `- [${state}] **${entry.name}** (\`${entry.command}\`)${detail}`;
  }).join('\n');
  const blockerRows = report.blockers.length
    ? report.blockers.map((entry) => {
        const evidence = entry.rawNames.length ? `\n  - Evidence: ${entry.rawNames.join('; ')}` : '';
        const fixes = entry.fixes.length ? `\n  - Fix: ${entry.fixes.join(' | ')}` : '';
        return `- **${entry.title}** - Sources: ${entry.sources.join(', ')}${evidence}${fixes}`;
      }).join('\n')
    : '- none';
  const criticalRows = report.criticalPath.length
    ? report.criticalPath.map((entry, index) => `${index + 1}. **${entry.title}**\n   - Command: \`${entry.command}\`\n   - Note: ${entry.note}`).join('\n')
    : '- none';
  const evidenceRows = report.mainnetEvidence.checks
    .map((entry) => `- [${entry.ok ? 'PASS' : 'FAIL'}] ${entry.name}${entry.fix ? ` - ${entry.fix}` : ''}`)
    .join('\n');
  const operationRows = report.mainnetEvidence.operations
    .map((entry) => `- [${entry.ok ? 'PASS' : 'FAIL'}] ${entry.operation}: ${entry.hash || '<missing>'}`)
    .join('\n');
  const commandRows = Object.values(report.commands).map((command) => command).join('\n');
  return `# 24K DApp Strict Launch Gate

- Generated at: ${report.generatedAt}
- Verdict: ${report.verdict}
- Overall OK: ${report.ok ? 'yes' : 'no'}
- Unique blockers: ${report.blockerCount}
- Mainnet transactions sent: false
- Local ephemeral Anvil E2E: ${report.transactionScope.localEphemeralAnvilE2E}
- Fixed NPL: \`${report.fixedNpl}\`
- Private key printed: false

## Gates

${gateRows}

## Blockers

${blockerRows}

## Mainnet evidence

${evidenceRows}

### Required transaction evidence

${operationRows}

## Critical path

${criticalRows}

## Commands

\`\`\`bash
${commandRows}
\`\`\`

## Artifacts

- \`${report.artifacts.markdown}\`
- \`${report.artifacts.json}\`
- \`${report.artifacts.deployReadiness}\`
- \`${report.artifacts.launchStatus}\`
- \`${report.artifacts.walletLaunch}\`
- \`${report.artifacts.frontendEnv}\`
- \`${report.artifacts.productionEnvTemplate}\`
- Production env checked locally: \`${report.artifacts.productionEnvChecked}\`
- \`${report.artifacts.mainnetReport}\`
`;
}

function sanitizeValue(value, key = '') {
  if (isSensitiveKey(key)) return '<redacted>';
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => (
      [entryKey, sanitizeValue(entryValue, entryKey)]
    )));
  }
  return value;
}

function sanitizeFailure(value) {
  return sanitizeText(value).replace(/https?:\/\/[^\s|)"'`]+/gi, '<redacted-url>');
}

function sanitizeText(value) {
  let text = String(value || '');
  for (const secret of knownSecrets) text = text.split(secret).join('<redacted>');
  text = text
    .replace(/\b([A-Z0-9_]*(?:PRIVATE_KEY|SECRET|TOKEN|API_KEY|MNEMONIC|SEED_PHRASE))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;|]+)/gi, '$1=<redacted>')
    .replace(/((?:"|')?[A-Z0-9_]*(?:PRIVATE_KEY|SECRET|TOKEN|API_KEY|MNEMONIC|SEED_PHRASE)(?:"|')?\s*:\s*)(["'])(.*?)\2/gi, '$1$2<redacted>$2')
    .replace(/(authorization\s*:\s*Bearer\s+)[^\s,;|]+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>');
  return text;
}

function loadKnownSecrets() {
  const values = new Set();
  const add = (key, value) => {
    if (!isSensitiveKey(key)) return;
    const normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    if (normalized.length >= 8) values.add(normalized);
  };
  for (const [key, value] of Object.entries(process.env)) add(key, value);
  for (const envFile of [resolve('.env'), productionEnvFile]) {
    const envText = readText(envFile);
    for (const rawLine of envText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index <= 0) continue;
      add(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function isSensitiveKey(key) {
  return /(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE|(?:^|_)(?:SECRET|TOKEN|API_KEY))$/i.test(String(key || ''));
}

function assertNoSecretLeaks(text) {
  for (const secret of knownSecrets) {
    if (secret && text.includes(secret)) throw new Error('Strict gate report contains a known secret value.');
  }
  const unsafeAssignment = text.match(/\b[A-Z0-9_]*(?:PRIVATE_KEY|SECRET|TOKEN|API_KEY|MNEMONIC|SEED_PHRASE)\s*=\s*(?!<redacted>)[^\s,;|]+/i);
  if (unsafeAssignment) throw new Error('Strict gate report contains an unredacted sensitive assignment.');
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

function isHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || ''));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
