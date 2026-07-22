#!/usr/bin/env node
import { runAbuV2Preflight } from './preflight.mjs';

try {
  await runAbuV2Preflight({ requireBroadcastAuthorized: true });
  throw new Error('Abu V2 W5/W1/W6 broadcast executor is not wired into micro:runner; refusing to report runner PASS without tx-guard-bound broadcasts');
} catch (error) {
  console.error(`runner gate: FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
