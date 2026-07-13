#!/usr/bin/env node
import fs from 'node:fs';
import { id, keccak256, toUtf8Bytes } from 'ethers';

const contracts = {
  BNMToken: {
    artifact: 'out/BNMToken.sol/BNMToken.json',
    abiHash: '0xe1a444f79bc6d1eb30bde895d10deeeabfbd5ef643f67ce474ff020a47bbcf12',
  },
  Abu24KRewardLedger: {
    artifact: 'out/Abu24KRewardLedger.sol/Abu24KRewardLedger.json',
    abiHash: '0xcc15ac5fbe44a9f889e623ba422814a92c248bf1afc021de985df32946474b63',
  },
  Abu24KPaymentEscrow: {
    artifact: 'out/Abu24KPaymentEscrow.sol/Abu24KPaymentEscrow.json',
    abiHash: '0x026e51a4a9a8f89e5ab6e1e041dce037281011c5f7ab646c51be7c61f64d5ea6',
  },
  Abu24KSeckill: {
    artifact: 'out/Abu24KSeckill.sol/Abu24KSeckill.json',
    abiHash: '0xbcdce3e119e6201890be85dbde2ec1f4976b9061caf16fe2689d024ec61c36bf',
  },
};

const freezeDocument = fs.readFileSync('docs/CONTRACT_FREEZE.md', 'utf8');
for (const [name, freeze] of Object.entries(contracts)) {
  const artifact = JSON.parse(fs.readFileSync(freeze.artifact, 'utf8'));
  const actualHash = keccak256(toUtf8Bytes(JSON.stringify(artifact.abi)));
  if (actualHash !== freeze.abiHash) {
    throw new Error(`${name} ABI changed: ${actualHash} !== ${freeze.abiHash}`);
  }
  if (!freezeDocument.includes(freeze.abiHash)) {
    throw new Error(`${name} ABI hash is missing from docs/CONTRACT_FREEZE.md`);
  }
  console.log(`${name}=${actualHash}`);
}

const escrowAbi = JSON.parse(fs.readFileSync(contracts.Abu24KPaymentEscrow.artifact, 'utf8')).abi;
const escrowFunctions = new Set(escrowAbi.filter((item) => item.type === 'function').map((item) => item.name));
const escrowConstructor = escrowAbi.find((item) => item.type === 'constructor');
if (!escrowConstructor || escrowConstructor.inputs.map((input) => input.type).join(',') !== 'address,address,address,address') {
  throw new Error('Escrow constructor is not the frozen four-address ABI');
}
const forceRefunds = escrowAbi.filter((item) => item.type === 'function' && item.name === 'forceRefund');
if (forceRefunds.length !== 1
  || forceRefunds[0].stateMutability !== 'nonpayable'
  || forceRefunds[0].inputs.map((input) => input.type).join(',') !== 'bytes32') {
  throw new Error('Escrow forceRefund must be exactly forceRefund(bytes32)');
}
const forcedRefundEvents = escrowAbi.filter((item) => item.type === 'event' && item.name === 'OrderForcedRefunded');
const forcedRefundEvent = forcedRefundEvents[0];
if (forcedRefundEvents.length !== 1
  || forcedRefundEvent.inputs.map((input) => input.type).join(',') !== 'bytes32,address,uint256,uint256'
  || forcedRefundEvent.inputs.map((input) => Boolean(input.indexed)).join(',') !== 'true,true,false,false') {
  throw new Error('Escrow OrderForcedRefunded event does not match the frozen types/indexed layout');
}
const forceRefundSelector = id('forceRefund(bytes32)').slice(0, 10);
const forcedRefundTopic = id('OrderForcedRefunded(bytes32,address,uint256,uint256)');
if (!freezeDocument.includes(`${forceRefundSelector} forceRefund(bytes32)`)) {
  throw new Error('Frozen forceRefund selector/signature is missing from docs/CONTRACT_FREEZE.md');
}
if (!freezeDocument.includes(`${forcedRefundTopic} OrderForcedRefunded(bytes32,address,uint256,uint256)`)) {
  throw new Error('Frozen OrderForcedRefunded topic/signature is missing from docs/CONTRACT_FREEZE.md');
}
if (escrowFunctions.has('retainedNplReceiver') || escrowFunctions.has('setRetainedNplReceiver')) {
  throw new Error('Removed retained-NPL ABI returned');
}

for (const file of ['scripts/deploy/escrow.mjs', 'scripts/deploy/check-escrow.mjs']) {
  const source = fs.readFileSync(file, 'utf8');
  if (/retainedNpl/i.test(source)) throw new Error(`${file} still contains the removed retained-NPL deployment path`);
}

console.log('contract freeze check: PASS');
