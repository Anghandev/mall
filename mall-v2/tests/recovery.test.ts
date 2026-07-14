import { artifactVersion } from '@abu24k/core-artifacts';

import { createBrowserSubmissionStore, type PendingSubmission } from '../src/mall-runtime';

const BUYER = '0x1111111111111111111111111111111111111111';
const OTHER_BUYER = '0x2222222222222222222222222222222222222222';
const ORDER_ID = `0x${'1'.repeat(64)}`;
const TX_HASH = `0x${'2'.repeat(64)}`;

describe('pending payment recovery store', () => {
  beforeEach(() => localStorage.clear());

  it('loads records only for the matching wallet, chain and artifact', () => {
    const store = createBrowserSubmissionStore();
    const pending = record();
    store.save(pending);

    expect(store.load(OTHER_BUYER)).toBeNull();
    expect(store.load(BUYER)).toEqual(pending);

    store.save({ ...pending, artifactVersion: 'stale-artifact' });
    expect(store.load(BUYER)).toBeNull();
  });

  it('removes invalid records instead of locking the checkout', () => {
    const store = createBrowserSubmissionStore();
    store.save({ ...record(), txHash: 'not-a-hash' });

    expect(store.load(BUYER)).toBeNull();
    expect(store.load(BUYER)).toBeNull();
  });
});

function record(): PendingSubmission {
  return {
    artifactVersion,
    chainId: 56,
    walletAddress: BUYER,
    phase: 'PENDING_CORE_SUBMISSION',
    orderId: ORDER_ID,
    txHash: TX_HASH,
  };
}
