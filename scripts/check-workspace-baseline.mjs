import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const expectedPackages = new Map([
  ['mall-v2/package.json', '@abu24k/mall'],
  ['merchant-v2/package.json', '@abu24k/merchant'],
  ['platform-v2/package.json', '@abu24k/core'],
  ['platform-v2/admin/package.json', '@abu24k/platform-admin'],
  ['packages/core-artifacts/package.json', '@abu24k/core-artifacts'],
]);
const requiredRootScripts = [
  'typecheck',
  'brand:check',
  'contracts:test',
  'requirements:check',
  'database:check',
  'api:check',
  'admin:check',
  'merchant:check',
  'mall:check',
  'consumer:check',
  'e2e:full',
  'micro:guard:test',
  'verify',
];
// Sanitized Phase 1 checkpoint after the credential-history rewrite.
const legacyCheckpoint = '0430c2407a7b87b65958578795ec45ff07c0febd';

const rootPackage = readJson('package.json');
if (rootPackage.packageManager !== 'pnpm@10.30.2') {
  throw new Error('Root packageManager must match the audited local pnpm 10.30.2 runtime');
}
for (const script of requiredRootScripts) {
  if (typeof rootPackage.scripts?.[script] !== 'string') {
    throw new Error(`Missing root script: ${script}`);
  }
}
if (!rootPackage.scripts.verify.startsWith('pnpm baseline:check && pnpm brand:check &&')) {
  throw new Error('Final verify must begin with the workspace and visible-brand gates');
}

for (const [path, expectedName] of expectedPackages) {
  const manifest = readJson(path);
  if (manifest.name !== expectedName || manifest.private !== true) {
    throw new Error(`${path}: expected private package ${expectedName}`);
  }
}

const workspace = readFileSync('pnpm-workspace.yaml', 'utf8');
for (const path of ['mall-v2', 'merchant-v2', 'platform-v2', 'platform-v2/admin', 'packages/*']) {
  if (!workspace.includes(`- ${path}`)) throw new Error(`Workspace missing ${path}`);
}
if (/legacy/i.test(workspace)) throw new Error('legacy must never be a workspace package');

const tracked = new Set(gitFiles(['ls-files', '-z']));
const working = new Set(gitFiles(['ls-files', '--cached', '--others', '--exclude-standard', '-z']));
for (const path of working) {
  if (!path.startsWith('legacy/') && path !== 'pnpm-lock.yaml' && path.endsWith('/pnpm-lock.yaml')) {
    throw new Error(`Nested lockfile is forbidden: ${path}`);
  }
}
for (const path of tracked) {
  const filename = path.split('/').at(-1);
  if (/^\.env(?:\.|$)/.test(filename) && !filename.endsWith('.example')) {
    throw new Error(`Tracked secret file: ${path}`);
  }
  if (/(^|\/)(node_modules|dist|test-artifacts|test-results|playwright-report|coverage)\//.test(path)
    || /^(output|outputs)\//.test(path)
    || /(^|\/)\.DS_Store$|\.(?:db|sqlite3?)(?:-wal|-shm)?$|\.dump(?:\.sha256)?$/.test(path)) {
    throw new Error(`Tracked private data or generated artifact: ${path}`);
  }
}
statSync('pnpm-lock.yaml');

for (const args of [
  ['diff', '--cached', '--quiet', legacyCheckpoint, '--', 'legacy'],
  ['diff', '--quiet', legacyCheckpoint, '--', 'legacy'],
]) {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
  } catch {
    throw new Error('legacy tracked files changed after the Phase 1 checkpoint');
  }
}

const runtimeExtensions = new Set(['.css', '.html', '.js', '.json', '.jsx', '.mjs', '.sol', '.ts', '.tsx']);
const textExtensions = new Set([...runtimeExtensions, '.example', '.md', '.npmrc', '.sh', '.toml', '.txt', '.yaml', '.yml']);
const excludedPrefixes = ['legacy/', 'docs/', 'mall-v2/docs/', 'merchant-v2/docs/', 'platform-v2/docs/', 'platform-v2/admin/docs/'];
const excludedFiles = new Set([
  'scripts/check-requirements.mjs',
  'scripts/check-workspace-baseline.mjs',
]);
const forbiddenRuntimeTokens = [
  'legacy/v1-npl-only',
  'force' + 'Refund',
  'Forced' + 'Refunded',
  'request' + 'TimeoutRefund',
  'refund' + 'Preview',
  'Refund' + 'Reserve',
  'tx.' + 'origin',
  'React ' + 'Native',
  'Ex' + 'po',
];

for (const path of working) {
  if (excludedFiles.has(path) || excludedPrefixes.some((prefix) => path.startsWith(prefix))) continue;
  if (!runtimeExtensions.has(extname(path))) continue;
  for (const text of contentVariants(path, tracked.has(path))) {
    for (const token of forbiddenRuntimeTokens) {
      if (containsForbiddenRuntimeToken(text, token)) {
        throw new Error(`${path}: forbidden V2 runtime token ${token}`);
      }
    }
    if (/\/src\//.test(`/${path}`) && /\b(fixtures?|mocks?)\b/i.test(text)) {
      throw new Error(`${path}: production source references fixture/mock data`);
    }
  }
}

for (const path of working) {
  if (!isTextPath(path)) continue;
  for (const text of contentVariants(path, tracked.has(path))) {
    assertNoCredentialValue(path, text);
  }
}

for (const path of [
  'scripts/microtest/env-utils.mjs',
  'scripts/microtest/init-env.mjs',
  'scripts/microtest/preflight.mjs',
  'scripts/microtest/report.mjs',
  'scripts/microtest/tx-guard.mjs',
]) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
}

try {
  execFileSync('git', ['check-ignore', '-q', '.env']);
} catch {
  throw new Error('Root .env must be ignored whether or not it exists');
}
if (existsSync('.env')) {
  const mode = statSync('.env').mode & 0o777;
  if (mode !== 0o600) throw new Error(`Root .env mode must be 600, received ${mode.toString(8)}`);
}

console.log(`OK workspace packages: ${expectedPackages.size}`);
console.log(`OK root gates: ${requiredRootScripts.length}`);
console.log('OK one root lockfile policy and immutable legacy');
console.log('OK index/worktree runtime, fixture and credential guards');
console.log('OK microtest syntax and optional local .env protection');

function containsForbiddenRuntimeToken(text, token) {
  if (token === 'Expo') return /(^|[^A-Za-z0-9_])expo(?=$|[^A-Za-z0-9_])/i.test(text);
  if (token === 'React Native') return /\bReact Native\b|react-native/i.test(text);
  return text.includes(token);
}

function assertNoCredentialValue(path, text) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    const value = rawValue.trim();
    if (!/(?:^|_)(?:KEY|UKEY|ACCESS_KEY_ID|SECRET|TOKEN|PASSWORD|MNEMONIC|SEED_PHRASE|CUSTOMER|USER|USER_ID|RPC_URL|DATABASE_URL|REDIS_URL|SMTP_URL)$/.test(name)) {
      continue;
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
      continue;
    }
    if (name.endsWith('_RPC_URL') && /^\/[A-Za-z0-9/_-]+$/.test(value)) {
      continue;
    }
    if (name.endsWith('_RPC_URL') && /^https:\/\/bsc-dataseed\.bnbchain\.org\/?$/.test(value)) {
      continue;
    }
    if (value !== '' && value !== 'REMOVED_FROM_GITHUB' && !/^\\?\$\{[A-Z][A-Z0-9_]*\}$/.test(value)) {
      throw new Error(`${path}: tracked credential value for ${name}`);
    }
  }
  if (/CAUQ[A-Z0-9]{20,}/.test(text) || /BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY/.test(text)) {
    throw new Error(`${path}: tracked provider token or private key material`);
  }
}

function contentVariants(path, inIndex) {
  const variants = [];
  if (inIndex) {
    variants.push(execFileSync('git', ['show', `:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  }
  if (existsSync(path)) variants.push(readFileSync(path, 'utf8'));
  return [...new Set(variants)];
}

function gitFiles(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function isTextPath(path) {
  return path === '.env.example' || path === '.npmrc' || textExtensions.has(extname(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
