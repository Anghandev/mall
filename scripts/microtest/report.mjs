#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readEnvFile, targetChain } from './env-utils.mjs';
import { readTxLog, weiToNativeString } from './tx-guard.mjs';

const env = readEnvFile('.env');
const chain = targetChain(env);
const packetPath = env.MAINNET_MICROTEST_PACKET_PATH || 'platform-v2/deployments/bsc-eoa-micro-packet-private.json';
const reportPath = 'MAINNET_MICRO_TEST_REPORT.md';
const txLog = readTxLog();
const totalCostWei = txLog.reduce((sum, tx) => sum + BigInt(tx.totalSpentWei), 0n);
const packet = fs.existsSync(packetPath) ? JSON.parse(fs.readFileSync(packetPath, 'utf8')) : {};
const packetSha256 = fs.existsSync(packetPath)
  ? createHash('sha256').update(fs.readFileSync(packetPath)).digest('hex')
  : '';

const txRows = txLog.map((tx, index) => (
  `| ${index + 1} | ${tx.operation || ''} | ${tx.functionCall || ''} | ${weiToNativeString(BigInt(tx.valueWei))} | ${tx.gasUsed || tx.estimatedGas || ''} | ${weiToNativeString(BigInt(tx.totalSpentWei))} | ${tx.hash || ''} | ${tx.status || ''} |`
)).join('\n');

const report = `# Abu 24K V2 Mainnet Micro-Test Report

## Final Conclusion

- Status: \`NO-GO UNTIL FILLED AND VERIFIED\`
- Can proceed to production deployment: \`NO\`
- Note: This generated report is a local scaffold. A Go decision requires the
  Abu V2 preflight-bound MICROTEST_BUYER_1/2/3 packet, real receipt evidence, cleanup gate
  and 600-second production observation.

## Summary

- Chain: ${chain.key}
- Chain ID: ${chain.chainId}
- Artifact version: ${packet.artifactVersion || ''}
- Git commit: ${packet.gitCommit || ''}
- Packet path: ${packetPath}
- Packet sha256: ${packetSha256}
- Buyer wallet count: ${Array.isArray(packet.buyerWallets) ? packet.buyerWallets.length : ''}
- Generated at: ${new Date().toISOString()}
- Total native spend logged: ${weiToNativeString(totalCostWei)} ${chain.native}
- Total tx count: ${txLog.length}

## Packet Binding

| Field | Value |
|---|---|
| Schema | ${packet.schema || ''} |
| Broadcast authorized | ${String(packet.broadcastAuthorized ?? '')} |
| Artifact version | ${packet.artifactVersion || ''} |
| Commit | ${packet.gitCommit || ''} |
| Chain | ${chain.key} |

## Transactions

| # | Operation | Function | Value | Gas Used | Cost | Hash | Result |
|---:|---|---|---:|---:|---:|---|---:|
${txRows}

## Required Manual Sections

- \`pnpm micro:preflight\` output bound to the same packet hash
- MICROTEST_BUYER_1/2/3 funding, BNM, approval and payment tx hashes
- PaymentReceiptWorker 15-confirmation evidence
- Router, Service Fee, Custody, Burn and Reward wallet balance deltas
- Order, fulfillment, ledger and settlement reconciliation
- Admin/Merchant/Mall browser evidence
- Cleanup gate and 600-second production observation
`;

fs.writeFileSync(reportPath, report);
console.log(`wrote ${reportPath}`);
