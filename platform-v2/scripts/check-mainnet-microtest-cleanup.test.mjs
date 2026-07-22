import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCleanupSnapshot } from './check-mainnet-microtest-cleanup.mjs';

const ready = {
  now: new Date('2026-07-20T01:00:00.000Z'),
  entitlementExpiresAt: new Date('2026-07-20T01:00:00.000Z'),
  primaryChain56: true,
  fallbackChain56: true,
  primaryPaymentsPaused: true,
  fallbackPaymentsPaused: true,
  databasePaymentsPaused: true,
  productState: 'DELISTED',
  activeQuotes: 0,
  activeReservations: 0,
  unsettledTransfers: 0,
};

test('cleanup gate requires pause, expiry, delisting and zero live obligations', () => {
  assert.doesNotThrow(() => assertCleanupSnapshot(ready));
  for (const [field, value] of [
    ['primaryChain56', false],
    ['fallbackChain56', false],
    ['primaryPaymentsPaused', false],
    ['fallbackPaymentsPaused', false],
    ['databasePaymentsPaused', false],
    ['productState', 'ACTIVE'],
    ['activeQuotes', 1],
    ['activeReservations', 1],
    ['unsettledTransfers', 1],
  ]) {
    assert.throws(() => assertCleanupSnapshot({ ...ready, [field]: value }));
  }
  assert.throws(() => assertCleanupSnapshot({
    ...ready,
    now: new Date(ready.entitlementExpiresAt.getTime() - 1),
  }));
  assert.doesNotThrow(() => assertCleanupSnapshot({ ...ready, productState: 'HIDDEN' }));
});
