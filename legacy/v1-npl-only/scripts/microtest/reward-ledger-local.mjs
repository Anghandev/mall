#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const artifactPath = 'test-artifacts/reward-ledger-local.json';
const command = 'forge';
const args = ['test', '-vv', '--match-test', 'testRewardLedgerOperatorReleaseClaimAndRecoveryBurn'];

fs.mkdirSync('test-artifacts', { recursive: true });
const startedAt = new Date().toISOString();
const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: { ...process.env, FOUNDRY_ETH_RPC_URL: '' },
  encoding: 'utf8',
  stdio: 'pipe'
});
const passed = result.status === 0;
const artifact = {
  kind: 'reward-ledger-local-microtest',
  command: `${command} ${args.join(' ')}`,
  status: passed ? 'PASS' : 'FAIL',
  startedAt,
  completedAt: new Date().toISOString(),
  checks: [
    'BNMToken deployed locally and RewardLedger set as minter',
    'setOperator authorizes Escrow/Seckill contract callers and rejects unauthorized callers',
    'lockReward creates Locked reward',
    'claim before release reverts',
    'releaseOrderRewards moves reward to Available',
    'claim mints BNM to buyer',
    'pause blocks normal flow but allows emergencyBurnLocked',
    'emergencyBurnUnclaimed burns Available unclaimed reward',
    'burnOrderRewards atomically burns Locked and Available order rewards',
    'burned reward cannot be claimed'
  ],
  stdoutTail: String(result.stdout || '').split(/\r?\n/).slice(-40),
  stderrTail: String(result.stderr || '').split(/\r?\n/).slice(-40)
};
fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
if (!passed) {
  console.error(result.stdout);
  console.error(result.stderr);
  console.error(`reward-ledger local microtest: FAIL wrote ${artifactPath}`);
  process.exit(result.status || 1);
}
console.log(`reward-ledger local microtest: PASS wrote ${artifactPath}`);
