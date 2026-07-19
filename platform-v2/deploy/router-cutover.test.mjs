import assert from 'node:assert/strict';
import test from 'node:test';
import { routerCutoverEvidenceHash, validateRouterCutover } from './router-cutover.mjs';

const cutover = {
  status: 'PRE_LAUNCH_DIRECT_REPLACEMENT',
  priorRouter: '0x1000000000000000000000000000000000000001',
  activeRouter: '0x1000000000000000000000000000000000000002',
  platformServiceFeeWallet: '0x1000000000000000000000000000000000000003',
  deploymentTxHash: `0x${'4'.repeat(64)}`,
  deploymentBlock: 123,
  deployedCodeHash: `0x${'5'.repeat(64)}`,
};
const evidence = { ...cutover, evidenceHash: routerCutoverEvidenceHash({ ...cutover, evidenceHash: `0x${'0'.repeat(64)}` }) };
const expected = {
  activeRouter: cutover.activeRouter,
  platformServiceFeeWallet: cutover.platformServiceFeeWallet,
  deploymentBlock: cutover.deploymentBlock,
  deployedCodeHash: cutover.deployedCodeHash,
};

test('Router cutover evidence binds every production field', () => {
  assert.equal(validateRouterCutover(evidence, expected).activeRouter, cutover.activeRouter);
  for (const [field, value] of [
    ['activeRouter', '0x1000000000000000000000000000000000000009'],
    ['platformServiceFeeWallet', '0x1000000000000000000000000000000000000009'],
    ['deploymentTxHash', `0x${'9'.repeat(64)}`],
    ['deploymentBlock', 124],
    ['deployedCodeHash', `0x${'9'.repeat(64)}`],
  ]) {
    assert.throws(() => validateRouterCutover({ ...evidence, [field]: value }, expected));
  }
});
