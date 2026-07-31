import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('release authorization create is clean-worktree and current-HEAD bound', async () => {
  const source = await readFile(new URL('./release-authorization.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("if (command === 'create')");
  const end = source.indexOf("} else if (command === 'verify')");
  assert.ok(start >= 0 && end > start, 'create command section is unavailable');
  const createSection = source.slice(start, end);
  assert.match(createSection, /assertCleanGitWorktree\(\)/);
  assert.match(createSection, /const gitCommit = currentGitCommit\(\)/);
  assert.match(createSection, /RELEASE_GIT_COMMIT does not match the current git HEAD/);
  assert.match(createSection, /gitCommit,/);
  assert.doesNotMatch(createSection, /process\.env\.RELEASE_GIT_COMMIT\s*\?\?/);
});
