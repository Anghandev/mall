import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'mall-publication-guard-'));
const checkout = path.join(temporary, 'checkout');
const clone = spawnSync('git', ['clone', '--quiet', '--shared', root, checkout], { encoding: 'utf8' });
assert.equal(clone.status, 0, 'isolated local clone must succeed');
copyFileSync(path.join(root, 'scripts/check-workspace-baseline.mjs'), path.join(checkout, 'scripts/check-workspace-baseline.mjs'));
after(() => rmSync(temporary, { recursive: true, force: true }));

function check() {
  const result = spawnSync(process.execPath, ['scripts/check-workspace-baseline.mjs'], {
    cwd: checkout,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function withFile(relative, content, tracked, verify) {
  const target = path.join(checkout, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: 0o600 });
  if (tracked) {
    const result = spawnSync('git', ['add', '-f', '--', relative], { cwd: checkout });
    assert.equal(result.status, 0);
  }
  try {
    verify(check());
  } finally {
    if (tracked) spawnSync('git', ['rm', '--cached', '-f', '--', relative], { cwd: checkout });
    rmSync(target, { force: true });
  }
}

test('sanitized legacy checkpoint and removed-credential markers pass', () => {
  const result = check();
  assert.equal(result.status, 0, result.output);
});

test('tracked environment files are rejected', () => {
  withFile('.env', 'PUBLICATION_TEST=synthetic-only\n', true, (result) => {
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Tracked secret file/);
  });
});

test('tracked generated runtime evidence is rejected', () => {
  withFile('test-artifacts/publication-guard.txt', 'synthetic-only\n', true, (result) => {
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Tracked private data or generated artifact/);
  });
});

test('hardcoded credentials are rejected without printing their values', () => {
  const value = 'synthetic-test-token-not-valid';
  withFile('scripts/publication-guard.txt', `API_TOKEN=${value}\n`, false, (result) => {
    assert.notEqual(result.status, 0);
    assert.match(result.output, /tracked credential value for API_TOKEN/);
    assert.ok(!result.output.includes(value));
  });
});

test('legacy source modifications remain rejected', () => {
  const target = path.join(checkout, 'legacy', 'v1-npl-only', 'README.md');
  const original = readFileSync(target);
  writeFileSync(target, Buffer.concat([original, Buffer.from('\npublication guard test\n')]));
  try {
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /legacy tracked files changed/);
  } finally {
    writeFileSync(target, original);
  }
});
