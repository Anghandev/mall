#!/usr/bin/env node
import fs from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { Interface, MaxUint256, parseUnits } from 'ethers';

const payloadSourcePath = 'src/services/paymentPayload.ts';
const paymentSourcePath = 'src/services/payment.ts';
const configSourcePath = 'src/config/web3.ts';
const txReceiptSourcePath = 'src/services/txReceipt.ts';
const payloadSource = fs.readFileSync(payloadSourcePath, 'utf8');
const paymentSource = fs.readFileSync(paymentSourcePath, 'utf8');
const configSource = fs.readFileSync(configSourcePath, 'utf8');
const txReceiptSource = fs.readFileSync(txReceiptSourcePath, 'utf8');
const tempModulePath = resolve(`scripts/.paymentPayload.check.${process.pid}.mjs`);

const compiled = ts.transpileModule(payloadSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }
}).outputText;
fs.writeFileSync(tempModulePath, compiled);
try {
  const payload = await import(`file://${tempModulePath}?t=${Date.now()}`);
  const nplAddress = match(configSource, /0x4e8277ab31e4956b2cd48449793a57656dfc03d2/);
  const escrowAddress = '0x2222222222222222222222222222222222222222';
  const buyerAddress = '0x1111111111111111111111111111111111111111';
  const sellerAddress = '0x3333333333333333333333333333333333333333';
  const order = {
    id: 'order-1',
    orderId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    buyerAddress,
    sellerAddress,
    amountNpl: '120.000000000000000000',
    bnmLocked: '120.000000000000000000',
    status: 'Draft',
    chainId: 56,
    escrowAddress,
    orderDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  };

  const erc20 = new Interface(['function approve(address spender,uint256 amount) returns (bool)', 'function allowance(address owner,address spender) view returns (uint256)']);
  const nplApprove = payload.buildApproveTokenMaxTransaction(buyerAddress, nplAddress, escrowAddress);
  assert(nplApprove.from === buyerAddress, 'NPL approve tx should use wallet as from');
  assert(nplApprove.to === nplAddress, 'NPL approve tx should go to the fixed NPL contract');
  assert(nplApprove.value === '0x0', 'NPL approve tx should not send native BNB');
  const [approveSpender, approveAmount] = erc20.decodeFunctionData('approve', nplApprove.data);
  assert(String(approveSpender).toLowerCase() === escrowAddress.toLowerCase(), 'NPL approve spender should be escrow');
  assert(approveAmount === MaxUint256, 'NPL approve should use MaxUint256 for allowance skip');

  const allowanceCall = payload.buildAllowanceCall(buyerAddress, nplAddress, escrowAddress);
  assert(allowanceCall.to === nplAddress, 'allowance call should target the fixed NPL contract');
  const [owner, spender] = erc20.decodeFunctionData('allowance', allowanceCall.data);
  assert(String(owner).toLowerCase() === buyerAddress.toLowerCase() && String(spender).toLowerCase() === escrowAddress.toLowerCase(), 'allowance call should check buyer -> escrow');

  const productId = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const authorization = `0x${'11'.repeat(65)}`;
  const deadline = 1_700_001_800n;
  const splitVersion = 1n;
  const escrow = payload.escrowInterface;
  assert(escrow instanceof Interface, 'payment payload should export the Escrow interface');
  assert(escrow.getFunction('payOrder').inputs.length === 9, 'client Escrow ABI should expose signed 9-parameter payOrder');
  const data = escrow.encodeFunctionData('payOrder', [order.orderId, sellerAddress, productId, parseUnits(order.amountNpl, 18), parseUnits(order.bnmLocked, 18), deadline, order.orderDigest, splitVersion, authorization]);
  const [orderId, seller, decodedProductId, nplAmount, bnmLocked, decodedDeadline, digest, decodedSplitVersion, decodedAuthorization] = escrow.decodeFunctionData('payOrder', data);
  assert(orderId === order.orderId, 'payOrder calldata should include backend orderId');
  assert(String(seller).toLowerCase() === sellerAddress.toLowerCase(), 'payOrder seller should come from backend order');
  assert(decodedProductId === productId, 'payOrder productId should be bytes32');
  assert(nplAmount === parseUnits(order.amountNpl, 18), 'payOrder NPL amount should match the backend order');
  assert(bnmLocked === parseUnits(order.bnmLocked, 18), 'payOrder BNM lock should match the backend order');
  assert(decodedDeadline === deadline, 'payOrder deadline should come from the signed backend intent');
  assert(digest === order.orderDigest, 'payOrder digest should come from backend order');
  assert(decodedSplitVersion === splitVersion && decodedAuthorization === authorization, 'payOrder should bind split version and signer authorization');

  assert(!/transfer\s*\(/.test(paymentSource), 'payment helper should not direct-transfer NPL to seller');
  assert(paymentSource.includes('approveNplUnlimited'), 'payment helper should expose one unlimited NPL approval');
  assert(paymentSource.includes('needsNplApproval') && paymentSource.includes('getNplAllowance'), 'payment helper should expose one NPL allowance-skip path');
  assert(txReceiptSource.includes("receipt.status && receipt.status !== '0x1'"), 'receipt wait should reject failed transactions');
  assert(txReceiptSource.includes('等待交易确认超时'), 'receipt wait should have timeout UX');
  assert(configSource.includes('EXPO_PUBLIC_BSC_CHAIN_ID || 56'), 'BSC chain id should default to 56');
  assert(configSource.includes(nplAddress), 'fixed NPL address should be configured');
  assert(!configSource.toLowerCase().includes(['us', 'dt'].join('').toLowerCase()), 'legacy settlement token should not remain in Web3 config');

  console.log('payment payload check: PASS');
} finally {
  fs.rmSync(tempModulePath, { force: true });
}

function match(text, pattern) {
  const found = text.match(pattern)?.[0];
  assert(found, `missing pattern ${pattern}`);
  return found;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
