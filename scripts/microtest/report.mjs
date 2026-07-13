#!/usr/bin/env node
import fs from 'node:fs';
import { readEnvFile, targetChain } from './env-utils.mjs';
import { readTxLog, weiToNativeString } from './tx-guard.mjs';

const env = readEnvFile('.env');
const chain = targetChain(env);
const deploymentPath = 'deployments/mainnet-micro-test.json';
const reportPath = 'MAINNET_MICRO_TEST_REPORT.md';
const txLog = readTxLog();
const totalCostWei = txLog.reduce((sum, tx) => sum + BigInt(tx.costWei || 0), 0n);
const deployment = fs.existsSync(deploymentPath) ? JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) : {};

const txRows = txLog.map((tx, index) => (
  `| ${index + 1} | ${tx.operation || ''} | ${tx.functionCall || ''} | ${tx.value || ''} | ${tx.gasUsed || tx.estimatedGas || ''} | ${tx.costWei ? weiToNativeString(BigInt(tx.costWei)) : ''} | ${tx.hash || ''} | ${tx.result || ''} |`
)).join('\n');

const report = `# Mainnet Micro-Test Report

## Final Conclusion

- Status: \`PARTIAL - FIX REQUIRED\`
- Can proceed to production deployment: \`NO\`
- Note: This generated report is a scaffold. Fill in assertions, frontend screenshots, and residual checks after running project-specific tests.

## Summary

- Chain: ${chain.key}
- Chain ID: ${chain.chainId}
- Test wallet: ${deployment.deployer || ''}
- Deployment address: ${deployment.address || ''}
- Frontend URL: ${env.FRONTEND_URL || ''}
- Generated at: ${new Date().toISOString()}
- Total native spend logged: ${weiToNativeString(totalCostWei)} ${chain.native}
- Total tx count: ${txLog.length}

## Deployment

| Field | Value |
|---|---|
| Contract name | ${deployment.contractName || ''} |
| Address | ${deployment.address || ''} |
| Tx hash | ${deployment.txHash || ''} |
| Chain | ${chain.key} |

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
