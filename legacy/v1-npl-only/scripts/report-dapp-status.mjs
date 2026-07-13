#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const outDir = process.env.DAPP_STATUS_OUT_DIR || 'test-artifacts';
const jsonOut = resolve(outDir, 'dapp-status.report.json');
const mdOut = resolve(outDir, 'dapp-status.md');
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

fs.mkdirSync(outDir, { recursive: true });

runArtifactScript('scripts/export-dapp-launch-status.mjs', {
  DAPP_LAUNCH_STATUS_OUT_DIR: outDir
});
const frontendEnvCheck = runJson('scripts/check-dapp-frontend-env.mjs');
const productionCheck = runJson('scripts/check-dapp-production-env.mjs');
const readiness = readJson(`${outDir}/dapp-readiness.json`);
const launchStatus = readJson(`${outDir}/dapp-launch-status.json`);
const frontendConsumption = readJson(`${outDir}/dapp-frontend-consumption.report.json`);
const frontendEnvReport = readJson(`${outDir}/dapp-frontend-env.report.json`);
const handoff = readJson(`${outDir}/dapp-handoff.json`);
const strictGate = readJson(`${outDir}/dapp-strict-gate.report.json`);

const handoffFiles = [
  'dapp-frontend-thread-prompt.md',
  'dapp-frontend.env',
  'dapp-sdk.ts',
  'dapp-types.d.ts',
  'dapp-frontend-handoff.bundle.json',
  'dapp-contracts.json',
  'dapp-openapi.json',
  'dapp-launch-kit.json',
  'dapp-launch-status.json',
  'dapp-launch-status.md',
  'dapp-wallet-launch.md',
  'dapp-wallet-launch.env',
  'dapp-wallet-launch.json',
  'dapp-deploy-readiness.md',
  'dapp-deploy-readiness.json',
  'dapp-deploy-public.todo.env',
  'dapp-strict-gate.md',
  'dapp-strict-gate.report.json'
].map((name) => ({
  name,
  path: `${outDir}/${name}`,
  exists: fs.existsSync(resolve(outDir, name))
}));

const warnings = [
  ...warningNames(frontendEnvCheck, 'frontend-env'),
  ...warningNames(productionCheck, 'production-env'),
  ...entryUrlWarnings(frontendEnvCheck?.entryUrl || productionCheck?.urls?.walletEntryUrl || '')
];
const localBlockers = [
  ...failNames(frontendEnvCheck, 'frontend-env'),
  ...failNames(productionCheck, 'production-env'),
  ...(readiness?.blockers || []).map((name) => ({ source: 'readiness', name }))
];
const strictLaunchBlockers = (strictGate?.blockers || []).map((entry) => ({
  source: entry.gate ? `strict:${entry.gate}` : 'strict-gate',
  name: entry.name || String(entry),
  fix: entry.fix || ''
}));
const blockers = localBlockers;
const allBlockers = [...localBlockers, ...strictLaunchBlockers];

const report = {
  kind: '24k-dapp-status',
  generatedAt: new Date().toISOString(),
  fixedPolicy: {
    npl: fixedNpl,
    chainId: 56,
    payment: 'NPL approve(MaxUint256) with allowance skip',
    seckillCallerRule: 'tx.origin == msg.sender',
    refund: 'no user no-reason refund; platform forced refund / 7-day timeout / emergency refund only',
    privateKeyPrinted: false
  },
  ok: blockers.length === 0,
  localOk: localBlockers.length === 0,
  strictLaunchOk: strictGate?.ok === true,
  frontendReady: Boolean(frontendConsumption?.checks?.readinessOk && frontendConsumption?.checks?.sdkHasWalletHelpers),
  readiness: {
    ok: readiness?.ok ?? null,
    productionReady: readiness?.productionReady ?? null,
    blockers: readiness?.blockers || [],
    warnings: readiness?.warnings || []
  },
  launchStatus: {
    localOk: launchStatus?.localOk ?? null,
    strictLaunchOk: launchStatus?.strictLaunchOk ?? null,
    uniqueBlockers: launchStatus?.uniqueBlockers || [],
    criticalPath: launchStatus?.criticalPath || []
  },
  frontendEnv: {
    ok: frontendEnvCheck?.ok ?? null,
    warnings: frontendEnvCheck?.warnings ?? null,
    apiBaseUrl: frontendEnvCheck?.apiBaseUrl || frontendEnvReport?.apiBaseUrl || '',
    entryUrl: frontendEnvCheck?.entryUrl || frontendEnvReport?.entryUrl || ''
  },
  productionEnv: {
    ok: productionCheck?.ok ?? null,
    warnings: productionCheck?.warnings ?? null,
    publicApi: productionCheck?.urls?.publicApi || '',
    walletEntryUrl: productionCheck?.urls?.walletEntryUrl || ''
  },
  strictGate: {
    ok: strictGate?.ok ?? null,
    gates: strictGate?.gates || [],
    blockers: strictLaunchBlockers,
    artifacts: strictGate?.artifacts || {}
  },
  handoff: {
    version: handoff?.version || '',
    hasFrontendBrief: typeof handoff?.frontendBrief === 'string' && handoff.frontendBrief.includes('前端线程任务提示词'),
    hasSdk: typeof handoff?.sdk === 'string' && handoff.sdk.includes('sendPaymentIntent'),
    files: handoffFiles
  },
  blockers,
  localBlockers,
  strictLaunchBlockers,
  allBlockers,
  warnings,
  nextActions: nextActions(localBlockers, warnings, strictLaunchBlockers),
  commands: {
    frontendPrompt: `cat ${outDir}/dapp-frontend-thread-prompt.md`,
    frontendEnv: 'pnpm dapp:frontend-env',
    frontendEnvCheck: 'pnpm dapp:frontend-env-check',
    frontendConsumptionCheck: 'pnpm dapp:frontend-check',
    walletLaunch: 'pnpm dapp:wallet-launch',
    walletLaunchStrict: 'pnpm dapp:wallet-launch -- --strict',
    deployReadiness: 'pnpm dapp:deploy-readiness',
    strictGate: 'pnpm dapp:strict-gate',
    strictGateCi: 'pnpm dapp:strict-gate -- --strict',
    launchCheck: 'pnpm dapp:launch-check',
    backendFlowCheck: 'pnpm dapp:check',
    productionStrictCheck: 'pnpm dapp:prod-check -- --strict',
    productionEnvFileCheck: 'pnpm dapp:prod-env-check -- --strict'
  }
};

fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(mdOut, renderMarkdown(report));

console.log('DApp status report: PASS');
console.log(`wrote ${jsonOut}`);
console.log(`wrote ${mdOut}`);
console.log(`local blockers: ${localBlockers.length}`);
console.log(`strict launch blockers: ${strictLaunchBlockers.length}`);
console.log(`warnings: ${warnings.length}`);

function runJson(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) return { ok: false, failed: 1, warnings: 0, error: result.stderr || result.stdout };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, failed: 1, warnings: 0, error: `Cannot parse ${script} output` };
  }
}

function runArtifactScript(script, extraEnv = {}) {
  spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(resolve(path), 'utf8'));
  } catch {
    return null;
  }
}

function warningNames(summary, source) {
  return (summary?.checks || [])
    .filter((entry) => entry.level === 'warn')
    .map((entry) => ({ source, name: entry.name, fix: entry.fix || '' }));
}

function entryUrlWarnings(entryUrl) {
  return isLocalHttpUrl(entryUrl)
    ? [{ source: 'dapp-entry', name: 'Wallet/DApp entry URL is local HTTP', fix: 'Use an HTTPS frontend domain or tunnel URL before asking users to open it in a phone wallet / DEX browser.' }]
    : [];
}

function failNames(summary, source) {
  return (summary?.checks || [])
    .filter((entry) => entry.level === 'fail')
    .map((entry) => ({ source, name: entry.name, fix: entry.fix || '' }));
}

function nextActions(blockers, warnings, strictLaunchBlockers = []) {
  if (blockers.length) return ['Fix local blockers listed in dapp-status.report.json, then rerun pnpm dapp:status.'];
  const actions = [];
  if (strictLaunchBlockers.length) {
    actions.push('Strict launch is not ready: fix dapp-strict-gate.md blockers, then rerun pnpm dapp:strict-gate -- --strict.');
  }
  if (warnings.some((entry) => /Seckill|BNM|RewardLedger/i.test(entry.name))) {
    actions.push('Deploy or configure Abu24KSeckill, BNMToken and Abu24KRewardLedger, then rerun frontend/prod env checks.');
  }
  if (warnings.some((entry) => /JWT|Admin SIWE|RPC|PRIVATE_KEY/i.test(entry.name))) {
    actions.push('Before production, fill JWT/admin/chain-event RPC settings and keep PRIVATE_KEY off the server env.');
  }
  if (warnings.some((entry) => /entry URL|wallet browser/i.test(entry.name))) {
    actions.push('Use an HTTPS DApp entry URL for phone wallet / DEX browser instead of localhost, then rerun pnpm dapp:wallet-launch -- --strict.');
  }
  actions.push('Give dapp-frontend-thread-prompt.md, dapp-frontend.env, dapp-wallet-launch.md, dapp-sdk.ts and dapp-frontend-handoff.bundle.json to the separate frontend thread.');
  return actions;
}

function renderMarkdown(report) {
  const fileRows = report.handoff.files.map((file) => `- ${file.exists ? '✅' : '⚠️'} \`${file.path}\``).join('\n');
  const blockerRows = report.blockers.length
    ? report.blockers.map((entry) => `- [${entry.source}] ${entry.name}${entry.fix ? ` — ${entry.fix}` : ''}`).join('\n')
    : '- none';
  const strictRows = report.strictLaunchBlockers.length
    ? report.strictLaunchBlockers.map((entry) => `- [${entry.source}] ${entry.name}${entry.fix ? ` — ${entry.fix}` : ''}`).join('\n')
    : '- none';
  const warningRows = report.warnings.length
    ? report.warnings.map((entry) => `- [${entry.source}] ${entry.name}${entry.fix ? ` — ${entry.fix}` : ''}`).join('\n')
    : '- none';
  const actionRows = report.nextActions.map((entry) => `- ${entry}`).join('\n');
  return `# 24K DApp Status

- Generated at: ${report.generatedAt}
- Local handoff OK: ${report.localOk ? 'yes' : 'no'}
- Strict launch OK: ${report.strictLaunchOk ? 'yes' : 'no'}
- Overall OK (local compatibility): ${report.ok ? 'yes' : 'no'}
- Frontend handoff ready: ${report.frontendReady ? 'yes' : 'no'}
- Runtime launch-status strict OK: ${report.launchStatus.strictLaunchOk === null ? 'unknown' : (report.launchStatus.strictLaunchOk ? 'yes' : 'no')}
- Fixed NPL: \`${report.fixedPolicy.npl}\`
- Payment: ${report.fixedPolicy.payment}
- Private key printed: false

## Frontend handoff files

${fileRows}

## Current URLs

- API base: \`${report.frontendEnv.apiBaseUrl || report.productionEnv.publicApi || ''}\`
- Wallet/DApp entry: \`${report.frontendEnv.entryUrl || report.productionEnv.walletEntryUrl || ''}\`

## Local blockers

${blockerRows}

## Strict launch blockers

${strictRows}

## Warnings

${warningRows}

## Next actions

${actionRows}

## Useful commands

\`\`\`bash
pnpm dapp:frontend-check
pnpm dapp:frontend-env
pnpm dapp:frontend-env-check
pnpm dapp:wallet-launch
pnpm dapp:deploy-readiness
pnpm dapp:strict-gate
pnpm dapp:launch-check
pnpm dapp:check
pnpm dapp:prod-check -- --strict
pnpm dapp:prod-env-check -- --strict
\`\`\`
`;
}

function isLocalHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}
