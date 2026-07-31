#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const target = process.env.CORE_PROXY_TARGET?.trim();
if (!target) {
  const payload = {
    smoke: 'e2e:real-readonly',
    realReadonly: false,
    status: 'FAIL_CLOSED_NO_CORE_PROXY_TARGET',
    evidence: 'No CORE_PROXY_TARGET was supplied. The smoke did not claim real Core connectivity.',
  };
  console.log(JSON.stringify(payload));
  process.exit(process.env.ALLOW_SKIP_REAL_READONLY_SMOKE === '1' ? 0 : 1);
}

execFileSync(
  process.execPath,
  ['../node_modules/@playwright/test/cli.js', 'test', '--config', 'test/e2e/real-readonly.playwright.config.ts'],
  { cwd: new URL('../..', import.meta.url), env: process.env, stdio: 'inherit' },
);
