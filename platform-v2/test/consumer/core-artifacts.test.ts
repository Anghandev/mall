import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import {
  allowedActionReasonCodes,
  artifactVersion,
  claimRails,
  contractOrderStates,
  executableOrderActionNames,
  finalityStates,
  orderFinalityStatuses,
  orderProjectionStates,
} from '../../../packages/core-artifacts/generated/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const artifactsRoot = join(repoRoot, 'packages/core-artifacts');
const manifest = readJson('coordinated-manifest.json');
const openapi = readJson('openapi/openapi.json');
const websocket = readJson('websocket-protocol.json');
const enums = readJson('state-error-enums.json');
const abiBundle = readJson('contracts/abi-bundle.json');
const contractManifest = readJson('contracts/contract-manifest.json');
const declarations = readFileSync(join(artifactsRoot, 'generated/index.d.ts'), 'utf8');

test('coordinated publication has one identity, resolvable exports and exact checksums', () => {
  assert.equal(artifactVersion, '2.0.0-rc.2');
  assert.equal(manifest.artifactVersion, artifactVersion);
  assert.equal(openapi['x-artifactVersion'], artifactVersion);
  assert.equal(websocket.artifactVersion, artifactVersion);
  assert.equal(enums.artifactVersion, artifactVersion);
  assert.equal(abiBundle.artifactVersion, artifactVersion);
  assert.equal(contractManifest.artifactVersion, artifactVersion);
  assert.deepEqual(
    manifest.consumerTests.map((item: { path: string }) => item.path),
    ['platform-v2/server/api/api.test.ts', 'platform-v2/test/consumer/core-artifacts.test.ts'],
  );
  for (const item of manifest.consumerTests as Array<{ path: string; sha256: string }>) {
    assert.equal(sha256(readFileSync(join(repoRoot, item.path))), item.sha256, item.path);
  }

  const packageJson = readJson('package.json');
  assert.equal(packageJson.version, artifactVersion);
  for (const target of Object.values(packageJson.exports).flatMap(exportTargets)) {
    assert.doesNotThrow(() => readFileSync(join(artifactsRoot, target)));
  }
  for (const line of readFileSync(join(artifactsRoot, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    assert.ok(match, line);
    const expected = match[1]!;
    const path = match[2]!;
    assert.equal(sha256(readFileSync(join(artifactsRoot, path))), expected, path);
  }
});

test('OpenAPI exposes only the four implemented HTTP operations', () => {
  const operations = Object.entries(openapi.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods as Record<string, unknown>).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
  assert.deepEqual(operations, [
    'GET /v2/bootstrap',
    'POST /v2/actions/order',
    'POST /v2/auth/nonce',
    'POST /v2/auth/verify',
  ]);
  assert.equal(openapi.paths['/v2/actions/order'].post.security[0].bearerAuth.length, 0);
  assert.equal(openapi.components.schemas.BootstrapResponse.properties.artifactVersion.const, artifactVersion);
  assert.deepEqual([...executableOrderActionNames], []);
});

test('payment, reservation and settlement consumers receive canonical public types', () => {
  for (const name of [
    'ProductPolicy',
    'ContractOrderIntent',
    'SignedOrderIntent',
    'InventoryReservation',
    'AllocationSnapshot',
  ]) {
    assert.match(declarations, new RegExp(`export interface ${name}\\b`), name);
  }
  for (const field of [
    'usdtPaymentAmount',
    'nplPaymentAmount',
    'burnedNplAmount',
    'routedNplAmount',
    'merchantUsdtAmount',
    'reservationHash',
    'policyVersion',
    'oracleVersion',
  ]) {
    assert.match(declarations, new RegExp(`\\b${field}\\b`), field);
  }
  for (const field of ['operationsBeneficiaries', 'operationsWeights']) {
    assert.match(declarations, new RegExp(`\\b${field}\\b`), field);
  }
  const orderIntentComponents = abiBundle.contracts.PaymentEscrowV2
    .find((item: { type: string; name: string }) => item.type === 'function' && item.name === 'payOrder')
    .inputs[0].components.map((item: { name: string }) => item.name);
  assert.deepEqual(interfaceFields('ContractOrderIntent'), orderIntentComponents);
  for (const field of ['intent', 'quoteSignature', 'buyerSignature']) {
    assert.match(declarations, new RegExp(`\\b${field}\\b`), field);
  }
  assertFunctions('PaymentEscrowV2', ['payOrder', 'hashOrder', 'getOrder']);
  assertFunctions('ClaimVaultV2', ['depositMerchant', 'creditBnm', 'depositReward']);
});

test('takeover and fulfillment consumers preserve blocked branches and chain evidence', () => {
  for (const name of ['MerchantTakeoverCase', 'FulfillmentEvidence', 'FulfillmentFinality', 'AllowedAction']) {
    assert.match(declarations, new RegExp(`export interface ${name}\\b`), name);
  }
  assert.ok(allowedActionReasonCodes.includes('PickupTakeoverDecisionBlocked'));
  assert.ok(manifest.decisionBlocked.includes('PICKUP_TIMEOUT_AND_TAKEOVER_EVIDENCE'));
  assertFunctions('MerchantGuaranteeVaultV2', ['beginTakeover', 'disburseTakeover', 'closeTakeover']);
  assertFunctions('PaymentEscrowV2', ['openTakeover', 'requestCustomerReceipt', 'finalizeFulfillment']);
});

test('Claim consumers distinguish rails, freeze reasons and breaker scopes', () => {
  assert.deepEqual([...claimRails], ['MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT', 'BNM']);
  assert.ok(allowedActionReasonCodes.includes('MerchantFrozen'));
  assertFunctions('ClaimVaultV2', ['claim', 'setClaimPause', 'setMerchantFrozen']);
  assert.equal(JSON.stringify(abiBundle).toLowerCase().includes('refund'), false);
});

test('seckill consumer binds dual quotes, fixed timers and empty-session fail-closed state', () => {
  for (const name of ['SeckillQuote', 'FallbackRetailQuote']) {
    assert.match(declarations, new RegExp(`export interface ${name}\\b`), name);
  }
  for (const timer of ['seckillMainDurationSeconds: 3600', 'relayInitialSeconds: 60', 'relayIncrementSeconds: 30', 'relayCapSeconds: 60']) {
    assert.ok(declarations.includes(timer), timer);
  }
  assert.ok(manifest.decisionBlocked.includes('EMPTY_SESSION_INJECTED_PRIZE_ALLOCATION'));
  assert.ok(manifest.decisionBlocked.includes('REQUIRED_CONFIRMATIONS'));
  assertFunctions('SeckillV2', ['buy', 'settle', 'injectPrize']);
});

test('projection, contract and finality state domains remain separate', () => {
  assert.ok(orderProjectionStates.includes('QUOTED'));
  assert.equal((contractOrderStates as readonly string[]).includes('QUOTED'), false);
  assert.ok(contractOrderStates.includes('NONE'));
  assert.ok(orderFinalityStatuses.includes('NOT_SUBMITTED'));
  assert.ok(finalityStates.includes('SUBMITTED'));
  assert.match(declarations, /export interface TransactionFinality\b/);
  for (const field of [
    'expectedEventHash',
    'eventResourceId',
    'blockHash',
    'confirmations',
    'requiredConfirmations',
    'canonicalBlock',
  ]) {
    assert.match(declarations, new RegExp(`\\b${field}\\b`), field);
  }
});

test('unimplemented transports and product capabilities are explicitly fail closed', () => {
  assert.equal(websocket.endpoint, null);
  assert.deepEqual(websocket.channels, []);
  assert.equal(websocket.publicationStatus, 'FAIL_CLOSED');
  assert.equal(websocket.delivery.deduplicateBy, 'eventId');
  assert.equal(websocket.delivery.unknownEvent, 'FAIL_CLOSED_AND_RESYNC');
  assert.ok(websocket.envelope.required.includes('cursor'));
  for (const [capability, status] of Object.entries(manifest.capabilityStatus)) {
    if (['bootstrap', 'siweAuthentication', 'orderAllowedActions'].includes(capability)) continue;
    assert.equal(status, 'NOT_PUBLISHED_FAIL_CLOSED', capability);
  }
  assert.equal(manifest.deploymentAuthorized, false);
  assert.deepEqual(manifest.executableOrderActionNames, []);
  assert.ok(manifest.externalBlocked.includes('SAFE_AND_ROLE_ADDRESSES'));
  assert.ok(manifest.externalBlocked.includes('PROVIDER_ACCOUNTS_AND_CREDENTIALS'));
});

function assertFunctions(contract: string, expected: string[]) {
  const names = new Set(
    abiBundle.contracts[contract].filter((item: { type: string }) => item.type === 'function').map((item: { name: string }) => item.name),
  );
  for (const name of expected) assert.ok(names.has(name), `${contract}.${name}`);
}

function interfaceFields(name: string) {
  const source = ts.createSourceFile('index.d.ts', declarations, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  assert.ok(declaration, name);
  return declaration.members.map((member) => {
    assert.ok(ts.isPropertySignature(member) && member.name, `${name} contains only property signatures`);
    return member.name.getText(source);
  });
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value.replace(/^\.\//, '')];
  return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
}

function readJson(path: string) {
  return JSON.parse(readFileSync(join(artifactsRoot, path), 'utf8'));
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
