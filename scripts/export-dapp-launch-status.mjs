#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT_DIR = process.env.DAPP_LAUNCH_STATUS_OUT_DIR || 'test-artifacts';
const JSON_OUT = resolve(OUT_DIR, 'dapp-launch-status.json');
const MD_OUT = resolve(OUT_DIR, 'dapp-launch-status.md');
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const port = Number(process.env.DAPP_LAUNCH_STATUS_PORT || 8851);
const baseUrl = process.env.DAPP_LAUNCH_STATUS_BASE_URL || process.env.DAPP_BASE_URL || `http://127.0.0.1:${port}`;
const shouldSpawn = !process.env.DAPP_LAUNCH_STATUS_BASE_URL && !process.env.DAPP_BASE_URL;
const strict = process.argv.includes('--strict') || process.env.DAPP_LAUNCH_STATUS_STRICT === 'true';
const tempDir = mkdtempSync(join(tmpdir(), '24k-dapp-launch-status-'));
const dbPath = resolve(tempDir, 'launch-status.db');

fs.mkdirSync(OUT_DIR, { recursive: true });

let server;
let stderr = '';
if (shouldSpawn) {
  rmSync(dbPath, { force: true });
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIVATE_KEY: '',
      PORT: String(port),
      DB_PATH: dbPath,
      MICRO_TEST: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (chunk) => { stderr += chunk; });
}

try {
  await waitForBackend();
  const status = await getJson('/api/dapp/launch-status');
  assert(status.kind === '24k-dapp-launch-status', 'launch-status kind mismatch');
  assert(status.fixedPolicy?.npl?.toLowerCase() === fixedNpl, 'fixed NPL missing from launch-status');
  assert(Array.isArray(status.strictLaunchBlockers) && Array.isArray(status.criticalPath), 'launch-status missing blockers or criticalPath');
  assertNoSecretValues(status);

  const report = {
    ...status,
    sourceBaseUrl: baseUrl,
    artifactKind: '24k-dapp-launch-status-export',
    privateKeyPrinted: false,
    sendsTransactions: false,
    artifacts: {
      json: JSON_OUT,
      markdown: MD_OUT
    }
  };

  fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(report));

  console.log('DApp launch status export: PASS');
  console.log(`source: ${baseUrl}`);
  console.log(`localOk: ${report.localOk ? 'yes' : 'no'}`);
  console.log(`strictLaunchOk: ${report.strictLaunchOk ? 'yes' : 'no'}`);
  console.log(`strict blockers: ${report.strictLaunchBlockers.length}`);
  console.log(`wrote ${JSON_OUT}`);
  console.log(`wrote ${MD_OUT}`);
  console.log('PRIVATE_KEY printed: false');
  if (strict && !report.strictLaunchOk) process.exit(1);
} finally {
  if (server) {
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), 1_000).unref();
  }
  if (stderr && !stderr.includes('ExperimentalWarning')) process.stderr.write(stderr);
  rmSync(tempDir, { recursive: true, force: true });
}

async function waitForBackend() {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return;
    } catch {}
    if (stderr && /EADDRINUSE|Error:/i.test(stderr)) break;
    await sleep(100);
  }
  throw new Error(`DApp backend not reachable at ${baseUrl}\n${stderr}`);
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const payload = await response.json().catch(() => ({}));
  assert(response.status === 200, `GET ${path} expected 200, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function renderMarkdown(report) {
  const uniqueRows = report.uniqueBlockers.length
    ? report.uniqueBlockers.map((entry) => `- **${entry.title}** (${entry.sources.join(', ')})`).join('\n')
    : '- none';
  const blockerRows = report.strictLaunchBlockers.length
    ? report.strictLaunchBlockers.map((entry) => `- [${entry.source}] ${entry.name}${entry.fix ? ` — ${entry.fix}` : ''}`).join('\n')
    : '- none';
  const criticalRows = report.criticalPath.length
    ? report.criticalPath.map((entry, index) => `${index + 1}. **${entry.title}**\n   - Command: \`${entry.command}\`\n   - Note: ${entry.note}`).join('\n')
    : '- none';
  return `# 24K DApp Runtime Launch Status

- Generated at: ${report.generatedAt}
- Source: ${report.sourceBaseUrl}
- Sends transactions: false
- Local OK: ${report.localOk ? 'yes' : 'no'}
- Strict launch OK: ${report.strictLaunchOk ? 'yes' : 'no'}
- Fixed NPL: \`${report.fixedPolicy.npl}\`
- Payment: ${report.fixedPolicy.payment} / ${report.fixedPolicy.firstPaymentApproval}
- Private key printed: false

## Unique blockers

${uniqueRows}

## Raw strict blockers

${blockerRows}

## Critical path

${criticalRows}

## Main endpoints

- Launch status: \`${report.endpoints.launchStatus}\`
- Readiness: \`${report.endpoints.readiness}\`
- Launch kit: \`${report.endpoints.launchKit}\`
- Handoff: \`${report.endpoints.handoff}\`
`;
}

function assertNoSecretValues(value) {
  const text = JSON.stringify(value);
  const forbiddenAssignments = [/PRIVATE_KEY\s*=/, /INDEXER_SECRET\s*=/, /ADMIN_SECRET\s*=/, /JWT_SECRET\s*=/];
  const leak = forbiddenAssignments.find((pattern) => pattern.test(text));
  if (leak) throw new Error(`launch-status appears to contain a secret assignment: ${leak}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
