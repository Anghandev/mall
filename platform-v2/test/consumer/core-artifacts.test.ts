import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Interface, TypedDataEncoder } from 'ethers';
import * as ts from 'typescript';
import {
  artifactVersion,
  executableOrderActionNames,
  settlementRails,
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

test('payment checkpoint has one identity, resolvable exports and exact checksums', () => {
  assert.equal(artifactVersion, '2.0.0-payment.1');
  for (const document of [manifest, websocket, enums, abiBundle, contractManifest]) {
    assert.equal(document.artifactVersion, artifactVersion);
  }
  assert.equal(openapi['x-artifactVersion'], artifactVersion);
  assert.equal(manifest.publicationStatus, 'COORDINATED_PAYMENT_CHECKPOINT');
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
    assert.equal(sha256(readFileSync(join(artifactsRoot, match[2]!))), match[1], match[2]);
  }
});

test('OpenAPI publishes only implemented payment checkpoint operations and has no dangling refs', () => {
  const operations = Object.entries(openapi.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods as Record<string, unknown>).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
  assert.deepEqual(operations, [
    'GET /v2/bootstrap',
    'GET /v2/catalog/products',
    'GET /v2/catalog/products/{productId}',
    'GET /v2/payments/{orderId}',
    'POST /v2/actions/order',
    'POST /v2/auth/nonce',
    'POST /v2/auth/verify',
    'POST /v2/payments/quotes',
    'POST /v2/payments/submissions',
    'POST /v2/seckill/quotes',
  ]);
  for (const path of [
    '/v2/actions/order',
    '/v2/payments/quotes',
    '/v2/payments/submissions',
    '/v2/payments/{orderId}',
    '/v2/seckill/quotes',
  ]) {
    const operation = Object.values(openapi.paths[path])[0] as { security?: Array<{ bearerAuth: unknown[] }> };
    assert.deepEqual(operation.security, [{ bearerAuth: [] }], path);
  }
  for (const ref of collectRefs(openapi)) {
    assert.ok(resolveRef(openapi, ref), ref);
  }
  assert.equal(openapi.components.schemas.CanonicalPaymentIntent.properties.requiredConfirmations.const, 15);
  assert.equal(openapi.components.schemas.ApprovalRequirement.properties.approvalMode.const, 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED');
  assert.equal(openapi.components.schemas.ApprovalRequirement.properties.risk.const, 'UNLIMITED_TOKEN_ALLOWANCE');
});

test('generated payment DTOs match the PaymentRouter tuple and current response surface', () => {
  for (const name of [
    'ProductPolicy',
    'CatalogProduct',
    'CatalogSku',
    'InventoryReservation',
    'AllocationSnapshot',
    'PaymentRouterIntent',
    'CanonicalPaymentIntent',
    'PaymentQuoteResponse',
    'CanonicalSeckillIntent',
    'SeckillQuoteResponse',
    'PaymentFinality',
    'ApprovalRequirement',
  ]) {
    assert.match(declarations, new RegExp(`export interface ${name}\\b`), name);
  }
  const pay = contractFunction('PaymentRouterV2', 'pay');
  const routerIntentFields = pay.inputs[0].components.map((item: { name: string }) => item.name);
  assert.deepEqual(interfaceFields('PaymentRouterIntent'), routerIntentFields);
  for (const field of [
    'nplQuoteAmount',
    'nplBurnAmount',
    'nplRewardAmount',
    'merchantBaseReceivableUsdt',
    'merchantConcessionAmount',
    'merchantNetReceivableUsdt',
    'concessionAllocationHash',
    'merchantConcessionAllocations',
    'otherUsdtAllocations',
    'nplRewardAllocations',
    'approvalRequirements',
    'classificationAuthority',
    'canonicalBlock',
  ]) {
    assert.match(declarations, new RegExp(`\\b${field}\\b`), field);
  }
  assert.deepEqual([...settlementRails], ['MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT']);
});

test('published wallet calls encode with the ABI and published EIP-712 messages reproduce authorization digests', () => {
  const router = new Interface(abiBundle.contracts.PaymentRouterV2);
  const paymentIntent = signingVectorRouterIntent();
  const paymentTypes = {
    PaymentAuthorization: [
      { name: 'paymentHash', type: 'bytes32' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'buyer', type: 'address' },
      { name: 'merchant', type: 'address' },
      { name: 'productId', type: 'bytes32' },
      { name: 'skuId', type: 'bytes32' },
      { name: 'quantity', type: 'uint32' },
      { name: 'fulfillmentMode', type: 'uint8' },
      { name: 'listPriceUsdt', type: 'uint256' },
      { name: 'usdtPaymentAmount', type: 'uint256' },
      { name: 'nplPaymentAmount', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
    ],
  };
  const domain = {
    name: 'Abu24KPaymentRouter',
    version: '2',
    chainId: 56,
    verifyingContract: '0x9999999999999999999999999999999999999999',
  };
  const paymentMessage = {
    paymentHash: '0xc125633288a4ba4ccb0602dae00c885dbe1adb7a0a77cc842f34d3d425d9279f',
    orderId: paymentIntent.orderId,
    buyer: paymentIntent.buyer,
    merchant: paymentIntent.merchant,
    productId: paymentIntent.productId,
    skuId: paymentIntent.skuId,
    quantity: paymentIntent.quantity,
    fulfillmentMode: paymentIntent.fulfillmentMode,
    listPriceUsdt: paymentIntent.listPriceUsdt,
    usdtPaymentAmount: paymentIntent.usdtPaymentAmount,
    nplPaymentAmount: paymentIntent.nplPaymentAmount,
    deadline: paymentIntent.deadline,
  };
  const quoteSignature = `0x${'11'.repeat(65)}`;
  const buyerSignature = `0x${'22'.repeat(65)}`;
  const ordinaryResponse = {
    authorizationDigest: '0x3b991a7728e91bdf283431b553258f94dffe4b516b6283ad3c34a588f7cd21a0',
    buyerAuthorization: {
      domain,
      types: paymentTypes,
      primaryType: 'PaymentAuthorization',
      message: paymentMessage,
      digest: '0x3b991a7728e91bdf283431b553258f94dffe4b516b6283ad3c34a588f7cd21a0',
    },
    routerCall: { functionName: 'pay', intent: paymentIntent, quoteSignature },
  };
  assert.equal(
    TypedDataEncoder.hash(
      ordinaryResponse.buyerAuthorization.domain,
      ordinaryResponse.buyerAuthorization.types,
      ordinaryResponse.buyerAuthorization.message,
    ),
    ordinaryResponse.authorizationDigest,
  );
  const payCalldata = router.encodeFunctionData(ordinaryResponse.routerCall.functionName, [
    ordinaryResponse.routerCall.intent,
    ordinaryResponse.routerCall.quoteSignature,
    buyerSignature,
  ]);
  assert.equal(router.parseTransaction({ data: payCalldata })?.name, 'pay');

  const sessionId = hash('5');
  const seckillPayment = { ...paymentIntent, seckill: true, sessionId };
  const fallbackPayment = {
    ...paymentIntent,
    reservationId: hash('6'),
    reservationHash: hash('7'),
  };
  const seckillTypes = {
    SeckillAuthorization: [
      { name: 'seckillHash', type: 'bytes32' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'buyer', type: 'address' },
      { name: 'merchant', type: 'address' },
      { name: 'productId', type: 'bytes32' },
      { name: 'skuId', type: 'bytes32' },
      { name: 'quantity', type: 'uint32' },
      { name: 'fulfillmentMode', type: 'uint8' },
      { name: 'seckillListPriceUsdt', type: 'uint256' },
      { name: 'seckillUsdtPaymentAmount', type: 'uint256' },
      { name: 'seckillNplPaymentAmount', type: 'uint256' },
      { name: 'fallbackListPriceUsdt', type: 'uint256' },
      { name: 'fallbackUsdtPaymentAmount', type: 'uint256' },
      { name: 'fallbackNplPaymentAmount', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
    ],
  };
  const seckillMessage = {
    seckillHash: '0x292fee156f4df5e8469fcff24055093e8820768b91784e417559b0fabd4d1bce',
    orderId: seckillPayment.orderId,
    buyer: seckillPayment.buyer,
    merchant: seckillPayment.merchant,
    productId: seckillPayment.productId,
    skuId: seckillPayment.skuId,
    quantity: seckillPayment.quantity,
    fulfillmentMode: seckillPayment.fulfillmentMode,
    seckillListPriceUsdt: seckillPayment.listPriceUsdt,
    seckillUsdtPaymentAmount: seckillPayment.usdtPaymentAmount,
    seckillNplPaymentAmount: seckillPayment.nplPaymentAmount,
    fallbackListPriceUsdt: fallbackPayment.listPriceUsdt,
    fallbackUsdtPaymentAmount: fallbackPayment.usdtPaymentAmount,
    fallbackNplPaymentAmount: fallbackPayment.nplPaymentAmount,
    deadline: seckillPayment.deadline,
  };
  const seckillResponse = {
    authorizationDigest: '0x8fd49d5723d836b830cc81647eaaad6b4e5e996f560a9bd034402549241e8246',
    buyerAuthorization: {
      domain,
      types: seckillTypes,
      primaryType: 'SeckillAuthorization',
      message: seckillMessage,
      digest: '0x8fd49d5723d836b830cc81647eaaad6b4e5e996f560a9bd034402549241e8246',
    },
    routerCall: {
      functionName: 'paySeckill',
      intent: { sessionId, seckillPayment, fallbackPayment },
      quoteSignature,
    },
  };
  assert.equal(
    TypedDataEncoder.hash(
      seckillResponse.buyerAuthorization.domain,
      seckillResponse.buyerAuthorization.types,
      seckillResponse.buyerAuthorization.message,
    ),
    seckillResponse.authorizationDigest,
  );
  const seckillCalldata = router.encodeFunctionData(seckillResponse.routerCall.functionName, [
    seckillResponse.routerCall.intent,
    seckillResponse.routerCall.quoteSignature,
    buyerSignature,
  ]);
  assert.equal(router.parseTransaction({ data: seckillCalldata })?.name, 'paySeckill');

  for (const [schema, response] of [
    ['PaymentBuyerAuthorization', ordinaryResponse.buyerAuthorization],
    ['OrdinaryRouterCall', ordinaryResponse.routerCall],
    ['SeckillBuyerAuthorization', seckillResponse.buyerAuthorization],
    ['SeckillRouterCall', seckillResponse.routerCall],
  ] as const) assertRequiredSchema(schema, response);
});

test('ABI publication is exactly the four payment contracts and exposes current Router behavior', () => {
  const expectedContracts = [
    'BeneficiaryRegistryV2',
    'PaymentRouterV2',
    'PolicyRegistryV2',
    'TwapOracleAdapterV2',
  ];
  assert.deepEqual(Object.keys(abiBundle.contracts).sort(), expectedContracts);
  assert.deepEqual(
    contractManifest.contracts.map((item: { name: string }) => item.name).sort(),
    expectedContracts,
  );
  assertFunctions('PaymentRouterV2', [
    'getSession',
    'hashPayment',
    'hashSeckill',
    'pay',
    'paySeckill',
    'setNewPaymentsPaused',
    'setSeckillPurchasesPaused',
  ]);
  assertFunctions('PolicyRegistryV2', ['getPolicy', 'publishPolicy']);
  const events = new Set(
    abiBundle.contracts.PaymentRouterV2
      .filter((item: { type: string }) => item.type === 'event')
      .map((item: { name: string }) => item.name),
  );
  for (const name of [
    'PaymentCompleted',
    'MerchantReceivableSnapshotted',
    'SeckillSessionOpened',
    'SeckillRelayExtended',
    'PaymentPauseChanged',
    'SeckillPurchasePauseChanged',
  ]) assert.ok(events.has(name), name);
});

test('publication contains no Claim, BNM token payout, old escrow or old allocation surface', () => {
  const published = JSON.stringify({ manifest, openapi, websocket, enums, abiBundle, contractManifest }) + declarations;
  for (const forbidden of [
    'PaymentEscrowV2',
    'ClaimVaultV2',
    'BNMTokenV2',
    'RewardLedgerV2',
    'MerchantGuaranteeVaultV2',
    'OrderPaid',
    'ClaimProjection',
    'claimRails',
    'merchantUsdtAmount',
    'routedNplAmount',
  ]) {
    assert.equal(published.includes(forbidden), false, forbidden);
  }
  assert.equal(published.toLowerCase().includes('refund'), false);
  assert.equal([...settlementRails].includes('BNM' as never), false);
});

test('unpublished transports and later Core batches stay explicitly fail closed', () => {
  assert.equal(websocket.endpoint, null);
  assert.deepEqual(websocket.channels, []);
  assert.equal(websocket.publicationStatus, 'FAIL_CLOSED');
  const available = new Set([
    'bootstrap',
    'siweAuthentication',
    'orderAllowedActions',
    'catalogHttp',
    'paymentQuoteHttp',
    'inventoryReservation',
    'paymentSubmissionHttp',
    'paymentProjectionHttp',
    'paymentIndexer',
    'seckillQuoteHttp',
  ]);
  for (const [capability, status] of Object.entries(manifest.capabilityStatus)) {
    assert.equal(status, available.has(capability) ? 'AVAILABLE' : 'NOT_PUBLISHED_FAIL_CLOSED', capability);
  }
  assert.equal(manifest.deploymentAuthorized, false);
  assert.equal(manifest.deploymentAuthorizationEvidenceHash, null);
  assert.equal(contractManifest.deploymentAuthorized, false);
  assert.equal(contractManifest.deploymentAuthorizationEvidenceHash, null);
  assert.ok(contractManifest.contracts.every((contract: { deploymentBlock: null; deployedCodeHash: null }) =>
    contract.deploymentBlock === null && contract.deployedCodeHash === null));
  assert.deepEqual([...executableOrderActionNames], []);
  assert.deepEqual(manifest.executableOrderActionNames, []);
  assert.ok(manifest.externalBlocked.includes('GOVERNANCE_AND_THREE_SAFE_ADDRESSES'));
  assert.ok(manifest.externalBlocked.includes('PROVIDER_ACCOUNTS_AND_CREDENTIALS'));
  assert.equal(manifest.decisionBlocked.includes('REQUIRED_CONFIRMATIONS'), false);
});

function contractFunction(contract: string, name: string) {
  const item = abiBundle.contracts[contract].find(
    (candidate: { type: string; name: string }) => candidate.type === 'function' && candidate.name === name,
  );
  assert.ok(item, `${contract}.${name}`);
  return item;
}

function assertFunctions(contract: string, expected: string[]) {
  const names = new Set(
    abiBundle.contracts[contract]
      .filter((item: { type: string }) => item.type === 'function')
      .map((item: { name: string }) => item.name),
  );
  for (const name of expected) assert.ok(names.has(name), `${contract}.${name}`);
}

function interfaceFields(name: string) {
  const source = ts.createSourceFile('index.d.ts', declarations, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  assert.ok(declaration, name);
  return declaration.members.map((member) => {
    assert.ok(ts.isPropertySignature(member) && member.name, `${name} contains only property signatures`);
    return member.name.getText(source);
  });
}

function assertRequiredSchema(name: string, value: Record<string, unknown>) {
  const schema = openapi.components.schemas[name] as { required?: string[] };
  assert.ok(schema, name);
  for (const field of schema.required ?? []) assert.ok(field in value, `${name}.${field}`);
}

function signingVectorRouterIntent() {
  return {
    orderId: hash('a'),
    policyVersion: 1,
    oracleVersion: hash('1'),
    buyer: address('1'),
    merchant: address('2'),
    productId: hash('b'),
    skuId: hash('c'),
    quantity: 2,
    fulfillmentMode: 0,
    fulfillmentTargetHash: hash('d'),
    regionCodeHash: hash('e'),
    productPolicyHash: hash('f'),
    reservationId: hash('2'),
    reservationHash: hash('3'),
    reservationDeadline: 1_800_000_600,
    issuedAt: 1_800_000_000,
    deadline: 1_800_000_300,
    nonce: '7',
    listPriceUsdt: '100000000000000000000',
    usdtPaymentAmount: '70000000000000000000',
    nplQuoteAmount: '1000000000000000000000',
    nplPaymentAmount: '300000000000000000000',
    nplBurnAmount: '200000000000000000000',
    nplRewardAmount: '100000000000000000000',
    merchantBaseReceivableUsdt: '60000000000000000000',
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: '15000000000000000000',
    merchantNetReceivableUsdt: '45000000000000000000',
    concessionAllocationHash: hash('4'),
    bnmAmount: '100000000000000000000',
    seckill: false,
    sessionId: hash('0'),
    beneficiaries: {
      genesis: address('3'),
      directReferral: address('4'),
      district: address('5'),
      city: address('6'),
      province: address('7'),
      region: address('8'),
    },
  };
}

function hash(character: string) {
  return `0x${character.repeat(64)}`;
}

function address(character: string) {
  return `0x${character.repeat(40)}`;
}

function collectRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.$ref === 'string' ? [record.$ref] : []),
    ...Object.values(record).flatMap(collectRefs),
  ];
}

function resolveRef(document: Record<string, unknown>, ref: string) {
  if (!ref.startsWith('#/')) return false;
  return ref.slice(2).split('/').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }, document);
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value.replace(/^\.\//, '')];
  return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
}

function readJson(path: string) {
  return JSON.parse(readFileSync(join(artifactsRoot, path), 'utf8'));
}

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}
