#!/usr/bin/env node
import fs from 'node:fs';
import { readEnvFile, targetChain } from './env-utils.mjs';
import { readTxLog, weiToNativeString } from './tx-guard.mjs';

const env = readEnvFile('.env');
const chain = targetChain(env);
const deploymentPath = 'deployments/mainnet-micro-test.json';
const reportPath = process.env.MICRO_REPORT_OUT || 'MAINNET_MICRO_TEST_REPORT.md';
const rewardLedgerLocalPath = 'test-artifacts/reward-ledger-local.json';
const txLog = readTxLog();
const totalCostWei = txLog.reduce((sum, tx) => sum + BigInt(tx.costWei || 0), 0n);
const deployment = fs.existsSync(deploymentPath) ? JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) : {};
const rewardLedgerLocal = fs.existsSync(rewardLedgerLocalPath) ? JSON.parse(fs.readFileSync(rewardLedgerLocalPath, 'utf8')) : null;
const hasDeployment = Boolean(deployment.address && deployment.txHash);
const hasEscrowSmoke = ['approve NPL for smoke escrow', 'pay smoke order', 'force-refund smoke order']
  .every((operation) => txLog.some((tx) => tx.operation === operation && tx.result === 'success'));
const hasBackendFundTxE2e = ['approve NPL for backend fund-tx e2e', 'fund backend e2e order', 'refund backend e2e order']
  .every((operation) => txLog.some((tx) => tx.operation === operation && tx.result === 'success'));
const hasRewardLedgerLocal = rewardLedgerLocal?.status === 'PASS';
const finalStatus = hasDeployment && hasEscrowSmoke && hasBackendFundTxE2e && hasRewardLedgerLocal
  ? 'MAINNET NPL PAYMENT MICRO-TEST PASS - DEVICE UX CHECK REQUIRED'
  : hasDeployment && hasEscrowSmoke && hasRewardLedgerLocal
    ? 'CONTRACT MICRO-TEST PASS - DEVICE CHECK REQUIRED'
    : 'PARTIAL - FIX REQUIRED';
const productionReady = hasDeployment && hasEscrowSmoke && hasBackendFundTxE2e && hasRewardLedgerLocal
  ? 'NO - finish real device wallet UX check first'
  : hasDeployment && hasEscrowSmoke && hasRewardLedgerLocal
    ? 'NO - finish real app wallet checkout and backend fund-tx verification first'
    : 'NO';
const finalNote = hasDeployment && hasEscrowSmoke && hasBackendFundTxE2e && hasRewardLedgerLocal
  ? 'Escrow deployed, ultra-small BSC NPL approve/pay/refund smoke passed, backend /fund-tx receipt verification passed, and local BNM/RewardLedger guard passed. RewardLedger and Seckill mainnet checks remain read-only.'
  : hasDeployment && hasEscrowSmoke && hasRewardLedgerLocal
    ? 'Escrow deployed, ultra-small BSC NPL approve/pay/refund smoke passed, and local BNM/RewardLedger guard passed. Remaining gate is backend receipt verification and real app wallet UX evidence.'
    : 'This generated report is a scaffold. Mainnet transaction scope is strictly limited to ultra-small NPL approve/pay/refund.';

const txRows = txLog.map((tx, index) => (
  `| ${index + 1} | ${tx.operation || ''} | ${tx.functionCall || ''} | ${tx.value || ''} | ${tx.gasUsed || tx.estimatedGas || ''} | ${tx.costWei ? weiToNativeString(BigInt(tx.costWei)) : ''} | ${tx.hash || ''} | ${tx.result || ''} |`
)).join('\n');

const report = `# Mainnet Micro-Test Report

## Final Conclusion

- Status: \`${finalStatus}\`
- Can proceed to production deployment: \`${productionReady}\`
- Note: ${finalNote}

## Summary

- Chain: ${chain.key}
- Chain ID: ${chain.chainId}
- Test wallet: ${deployment.deployer || ''}
- Deployment address: ${deployment.address || ''}
- Frontend URL: ${env.FRONTEND_URL || ''}
- Generated at: ${new Date().toISOString()}
- Total native spend logged: ${weiToNativeString(totalCostWei)} ${chain.native}
- Total tx count: ${txLog.length}
- Escrow smoke passed: ${hasEscrowSmoke ? 'yes' : 'no'}
- Backend fund-tx e2e passed: ${hasBackendFundTxE2e ? 'yes' : 'no'}
- Local BNM/RewardLedger guard passed: ${hasRewardLedgerLocal ? 'yes' : 'no'}
- Mainnet reward/seckill transaction tests enabled: no

## Deployment

| Field | Value |
|---|---|
| Contract name | ${deployment.contractName || ''} |
| Address | ${deployment.address || ''} |
| Tx hash | ${deployment.txHash || ''} |
| Chain | ${chain.key} |

## BNM / RewardLedger Guard

| Field | Value |
|---|---|
| Local artifact | ${rewardLedgerLocalPath} |
| Status | ${rewardLedgerLocal?.status || 'not run'} |
| Command | ${rewardLedgerLocal?.command || ''} |
| Note | RewardLedger mainnet verification is read-only; lock/release/claim/burn behavior is covered locally. |

## Mainnet Transaction Scope

- Allowed micro operations: one NPL MaxUint256 approval, one signed 9-parameter payOrder, one NPL refund.
- RewardLedger claim and Seckill record operations are read-only on mainnet.

## Transactions

| # | Operation | Function | Value | Gas Used | Cost | Hash | Result |
|---:|---|---|---:|---:|---:|---|---:|
${txRows}

## Required Manual Sections

- Preflight checks
- Contract function assertions
- Frontend connectivity results
- Browser artifact paths
- Residual exposure check
- Failed items
- Risk points
- Next steps
`;

fs.writeFileSync(reportPath, report);
console.log(`wrote ${reportPath}`);
