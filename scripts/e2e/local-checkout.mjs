#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractFactory, JsonRpcProvider, MaxUint256, Wallet, formatUnits, isHexString, parseUnits } from 'ethers';
import { startOrderSigner } from '../test-support/order-signer.mjs';

const anvilPort = Number(process.env.ANVIL_PORT || 8547);
const apiPort = Number(process.env.E2E_API_PORT || 8798);
const rpcUrl = `http://127.0.0.1:${anvilPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const chainId = 31337;
const tempDir = mkdtempSync(join(tmpdir(), '24k-e2e-local-'));
const dbPath = resolve(tempDir, 'e2e-local.db');
const outPath = resolve(tempDir, 'out');
const cachePath = resolve(tempDir, 'cache');
const indexerSecret = 'local-e2e-indexer-secret';
let defaultBuyerToken = '';

rmSync(dbPath, { force: true });

const children = [];
let localOrderSigner;
try {
  run('forge', ['build', '--out', outPath, '--cache-path', cachePath]);

  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(anvilPort), '--chain-id', String(chainId), '--silent'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(anvil);
  await waitForRpc(rpcUrl);

  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const owner = await provider.getSigner(0);
  const buyer = await provider.getSigner(1);
  const seller = await provider.getSigner(2);
  const ownerAddress = await owner.getAddress();
  const buyerAddress = await buyer.getAddress();
  const sellerAddress = await seller.getAddress();

  const mockNpl = await deploy('MockNPL.sol/MockNPL.json', owner);
  const nplAddress = await mockNpl.getAddress();
  const bnm = await deploy('BNMToken.sol/BNMToken.json', owner, [ownerAddress]);
  const bnmAddress = await bnm.getAddress();
  const rewardLedger = await deploy('Abu24KRewardLedger.sol/Abu24KRewardLedger.json', owner, [bnmAddress, nplAddress, ownerAddress]);
  const rewardLedgerAddress = await rewardLedger.getAddress();
  const orderSignerWallet = Wallet.createRandom();
  const escrow = await deploy('Abu24KPaymentEscrow.sol/Abu24KPaymentEscrow.json', owner, [
    nplAddress,
    rewardLedgerAddress,
    orderSignerWallet.address,
    ownerAddress,
    ownerAddress
  ]);
  const escrowAddress = await escrow.getAddress();

  await (await bnm.connect(owner).setMinter(rewardLedgerAddress, true)).wait();
  await (await rewardLedger.connect(owner).setOperator(escrowAddress, true)).wait();
  await (await escrow.connect(owner).setSeller(sellerAddress, true)).wait();
  await (await escrow.connect(owner).setSplitConfig({
    platformReceiver: ownerAddress,
    regionReceiver: ownerAddress,
    referralReceiver: ownerAddress,
    prizePoolReceiver: ownerAddress,
    burnReceiver: ownerAddress,
    circulationReceiver: ownerAddress,
    merchantBps: 10_000,
    platformBps: 0,
    regionBps: 0,
    referralBps: 0,
    prizePoolBps: 0,
    burnBps: 0,
    circulationBps: 0
  })).wait();
  await (await escrow.connect(owner).unpause()).wait();
  localOrderSigner = await startOrderSigner({ chainId, escrowAddress, wallet: orderSignerWallet });

  const mintAmount = parseUnits('1000', 18);
  await (await mockNpl.connect(owner).mint(buyerAddress, mintAmount)).wait();

  const api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIVATE_KEY: '',
      NODE_ENV: 'test',
      PORT: String(apiPort),
      DB_PATH: dbPath,
      CHAIN_ID: String(chainId),
      EXPO_PUBLIC_BSC_CHAIN_ID: String(chainId),
      EXPO_PUBLIC_NPL_BSC_ADDRESS: nplAddress,
      EXPO_PUBLIC_ESCROW_ADDRESS: escrowAddress,
      EXPO_PUBLIC_BNM_BSC_ADDRESS: bnmAddress,
      EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
      REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
      GENESIS_NODE_CONTRACT: nplAddress,
      MERCHANT_RECEIVER_ADDRESS: sellerAddress,
      ...localOrderSigner.env,
      JWT_SECRET: 'local-e2e-jwt-secret',
      INDEXER_SECRET: indexerSecret,
      INDEXER_CONFIRMATIONS: '2',
      ALLOW_UNVERIFIED_CHAIN_EVENTS: 'false',
      CHAIN_EVENT_RPC_URL: rpcUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(api);
  await waitForHealth(apiUrl);
  const health = await get(`${apiUrl}/health`);
  assert(health.eventRpcVerification === true, 'backend must verify chain events through RPC in e2e');
  assert(health.unverifiedChainEventsAllowed === false, 'e2e must not allow unverified chain events');

  const products = await get(`${apiUrl}/api/products`);
  assert(products[0]?.sellerAddress?.toLowerCase() === sellerAddress.toLowerCase(), 'products API should expose configured seller');
  assert(products[0]?.shopBadge && products[0]?.imageTone && Array.isArray(products[0]?.tags), 'products API should return app-ready UI fields');

  const messages = await get(`${apiUrl}/api/messages`);
  assert(messages[0]?.date && messages[0]?.tone, 'messages API should return app-ready message fields');

  const buyerSession = await siweLogin(apiUrl, buyer, buyerAddress);
  defaultBuyerToken = buyerSession.token;
  const buyerHeaders = { authorization: `Bearer ${buyerSession.token}` };
  const entitledAssets = await get(`${apiUrl}/api/assets/summary`);
  assert(entitledAssets.buckets.find((entry) => entry.id === 'genesis-node')?.visible === true && entitledAssets.entitlements?.genesisNode?.entitled === true, 'wallet holding the configured genesis credential should see the gated reward bucket');
  const zeroBalanceSession = await siweLogin(apiUrl, seller, sellerAddress);
  const zeroBalanceResponse = await fetch(`${apiUrl}/api/assets/summary`, { headers: { authorization: `Bearer ${zeroBalanceSession.token}` } });
  const zeroBalanceAssets = await zeroBalanceResponse.json();
  assert(zeroBalanceResponse.ok && zeroBalanceAssets.buckets.find((entry) => entry.id === 'genesis-node')?.visible === false, 'wallet without the genesis credential must not see the gated reward bucket');
  const addressPayload = {
    walletAddress: buyerAddress,
    name: 'Local E2E Buyer',
    phone: '13800000001',
    province: '辽宁省',
    city: '大连市',
    district: '高新区',
    detail: '软件园路 24K 号',
    regionCode: '210211',
    isDefault: true
  };
  const signedAddress = await withSecondary(apiUrl, buyer, buyerAddress, buyerSession.token, 'buyer.address.upsert', addressPayload);
  const savedAddress = await post(`${apiUrl}/api/address-book`, signedAddress, buyerHeaders, 201);

  const orderInput = {
    buyerAddress,
    idempotencyKey: `local-e2e:${buyerAddress}:p-24k-runner:1`,
    items: [{ productId: 'p-24k-runner', quantity: 1, selected: true, fulfillmentMode: 'delivery', addressId: savedAddress.id, regionCode: '210211' }]
  };
  const order = await post(`${apiUrl}/api/orders`, orderInput, {}, 201);
  assert(order.sellerAddress.toLowerCase() === sellerAddress.toLowerCase(), 'order seller should be the configured seller');
  assert(order.escrowAddress.toLowerCase() === escrowAddress.toLowerCase(), 'order escrow should match deployment');

  const amountNpl = parseUnits(order.amountNpl, 18);
  const paymentIntent = await get(`${apiUrl}/api/orders/${order.orderId}/payment-intent?buyerAddress=${buyerAddress}`);
  assert(paymentIntent.allowanceChecks?.length === 1 && paymentIntent.allowanceChecks[0].key === 'npl', 'payment intent should expose one NPL allowance check');
  assert(paymentIntent.approvalTransactions?.length === 1 && paymentIntent.approvalTransactions[0].key === 'npl', 'payment intent should expose one NPL approval');
  const [approvalSpender, approvalAmount] = mockNpl.interface.decodeFunctionData('approve', paymentIntent.approvalTransactions[0].data);
  assert(String(approvalSpender).toLowerCase() === escrowAddress.toLowerCase() && approvalAmount === MaxUint256, 'NPL approval calldata should grant escrow MaxUint256');
  const [intentOrderId, intentSeller, intentProductId, intentNplAmount, intentBnmLocked, intentDeadline, intentDigest, intentSplitVersion, intentAuthorization] = escrow.interface.decodeFunctionData('payOrder', paymentIntent.payOrderTransaction.data);
  assert(intentOrderId === order.orderId && String(intentSeller).toLowerCase() === sellerAddress.toLowerCase(), 'signed payOrder calldata should bind order and approved seller');
  assert(isHexString(intentProductId, 32) && intentNplAmount === amountNpl && intentBnmLocked === parseUnits(order.bnmLocked, 18), 'signed payOrder calldata should bind product, NPL and BNM amounts');
  assert(intentDeadline > BigInt(Math.floor(Date.now() / 1000)) && intentDigest === order.orderDigest && intentSplitVersion === 1n, 'signed payOrder calldata should bind digest, future deadline and split version');
  assert(isHexString(intentAuthorization) && intentAuthorization.length === 132 && paymentIntent.payOrderTransaction.orderSigner.toLowerCase() === localOrderSigner.address.toLowerCase(), 'payOrder should include the local webhook signer authorization');

  const approveNplReceipt = await (await mockNpl.connect(buyer).approve(escrowAddress, MaxUint256)).wait();
  assert(approveNplReceipt?.status === 1, 'NPL approve should succeed');
  assert((await mockNpl.allowance(buyerAddress, escrowAddress)) === MaxUint256, 'escrow should receive exactly one unlimited NPL allowance');

  const fundedTx = await buyer.sendTransaction({
    to: paymentIntent.payOrderTransaction.to,
    data: paymentIntent.payOrderTransaction.data,
    value: paymentIntent.payOrderTransaction.value
  });
  const fundedReceipt = await fundedTx.wait();
  assert(fundedReceipt?.status === 1, 'payOrder should succeed');

  const eventPayload = eventPayloadFromReceipt(fundedReceipt, escrow, chainId, escrowAddress);
  await post(`${apiUrl}/api/chain-events`, {
    ...eventPayload,
    logIndex: eventPayload.logIndex + 1000
  }, { 'x-indexer-secret': indexerSecret }, 400);

  await post(`${apiUrl}/api/chain-events`, {
    ...eventPayload,
    contractAddress: nplAddress
  }, { 'x-indexer-secret': indexerSecret }, 400);

  await post(`${apiUrl}/api/chain-events`, {
    ...eventPayload,
    eventName: 'OrderCompleted',
    seller: eventPayload.seller
  }, { 'x-indexer-secret': indexerSecret }, 400);

  const otherOrder = await post(`${apiUrl}/api/orders`, {
    buyerAddress,
    idempotencyKey: `local-e2e:${buyerAddress}:forged-order`,
    items: [{ productId: 'p-24k-runner', quantity: 1, selected: true, fulfillmentMode: 'delivery', addressId: savedAddress.id, regionCode: '210211' }]
  }, {}, 201);
  await post(`${apiUrl}/api/chain-events`, {
    ...eventPayload,
    orderId: otherOrder.orderId,
    orderDigest: otherOrder.orderDigest
  }, { 'x-indexer-secret': indexerSecret }, 400);

  await post(`${apiUrl}/api/orders/${order.orderId}/fund-tx`, {
    buyerAddress: sellerAddress,
    txHash: fundedReceipt.hash
  }, {}, 403);

  await post(`${apiUrl}/api/orders/${order.orderId}/fund-tx`, {
    buyerAddress,
    txHash: fundedReceipt.hash
  }, {}, 409);

  const confirmingStatus = await get(`${apiUrl}/api/orders/${order.orderId}/fund-tx-status?buyerAddress=${buyerAddress}&txHash=${fundedReceipt.hash}`);
  assert(confirmingStatus.status === 'confirming' && confirmingStatus.finality?.confirmations === 1 && confirmingStatus.order.status === 'Draft', `fund-tx status must not write an unfinalized receipt: ${JSON.stringify(confirmingStatus)}`);
  await provider.send('evm_mine', []);
  const statusSubmitted = await get(`${apiUrl}/api/orders/${order.orderId}/fund-tx-status?buyerAddress=${buyerAddress}&txHash=${fundedReceipt.hash}`);
  assert(statusSubmitted.status === 'confirmed' && statusSubmitted.finality === undefined && statusSubmitted.order.status === 'PaidLocked', `fund-tx status should mark order PaidLocked after configured confirmations: ${JSON.stringify(statusSubmitted)}`);

  const submittedOrder = await post(`${apiUrl}/api/orders/${order.orderId}/fund-tx`, {
    buyerAddress,
    txHash: fundedReceipt.hash
  }, {}, 200);
  assert(submittedOrder.status === 'PaidLocked', `public fund-tx submit should stay idempotent after status polling: ${JSON.stringify(submittedOrder)}`);

  const duplicateSync = await post(`${apiUrl}/api/chain-events`, eventPayload, { 'x-indexer-secret': indexerSecret }, 200);
  assert(duplicateSync.duplicate === true, 'event sync should be idempotent');

  const storedOrder = await get(`${apiUrl}/api/orders/${order.orderId}?buyerAddress=${buyerAddress}`);
  assert(storedOrder.status === 'PaidLocked', 'GET order should return PaidLocked');
  assert((await mockNpl.balanceOf(escrowAddress)) === amountNpl, 'escrow should hold the exact NPL order amount');

  const rewardLockedPayload = rewardEventPayloadFromReceipt(fundedReceipt, rewardLedger, chainId, rewardLedgerAddress, 'RewardLocked');
  await post(`${apiUrl}/api/chain-events`, rewardLockedPayload, { 'x-indexer-secret': indexerSecret }, 201);

  const completeTx = await escrow.connect(buyer).completeOrder(order.orderId);
  const completeReceipt = await completeTx.wait();
  assert(completeReceipt?.status === 1, 'completeOrder should succeed');
  const completingStatus = await get(`${apiUrl}/api/orders/${order.orderId}/complete-tx-status?buyerAddress=${buyerAddress}&txHash=${completeReceipt.hash}`);
  assert(completingStatus.status === 'confirming' && completingStatus.order.status === 'PaidLocked', 'complete tx must not release an order before configured confirmations');
  await provider.send('evm_mine', []);
  const completedStatus = await get(`${apiUrl}/api/orders/${order.orderId}/complete-tx-status?buyerAddress=${buyerAddress}&txHash=${completeReceipt.hash}`);
  assert(completedStatus.status === 'confirmed' && completedStatus.order.status === 'Released', 'complete tx should release the order after configured confirmations');
  const rewardReleasedPayload = rewardEventPayloadFromReceipt(completeReceipt, rewardLedger, chainId, rewardLedgerAddress, 'RewardReleased');
  await post(`${apiUrl}/api/chain-events`, rewardReleasedPayload, { 'x-indexer-secret': indexerSecret }, 201);

  const claimIntent = await post(`${apiUrl}/api/dapp/claim-intent`, { walletAddress: buyerAddress, bucketId: 'bnm', rewardId: 'reward-ledger-0' }, buyerHeaders, 200);
  const claimSignature = await buyer.signMessage(claimIntent.secondaryMessage);
  const claim = await post(`${apiUrl}/api/claims`, { ...claimIntent.submit.body, secondarySignature: claimSignature }, buyerHeaders, 201);
  assert(claim.status === 'pending', 'claim should remain pending until its chain receipt is finalized');
  const claimTx = await rewardLedger.connect(buyer).claim(0);
  const claimReceipt = await claimTx.wait();
  const confirmingClaim = await get(`${apiUrl}/api/dapp/claim-tx-status?walletAddress=${buyerAddress}&rewardId=reward-ledger-0&txHash=${claimReceipt.hash}`);
  assert(confirmingClaim.status === 'confirming' && confirmingClaim.reward.state === 'PendingClaim', 'claim tx must stay pending before configured confirmations');
  await provider.send('evm_mine', []);
  const confirmedClaim = await get(`${apiUrl}/api/dapp/claim-tx-status?walletAddress=${buyerAddress}&rewardId=reward-ledger-0&txHash=${claimReceipt.hash}`);
  assert(confirmedClaim.status === 'confirmed' && confirmedClaim.reward.state === 'Claimed', 'claim tx should finalize after configured confirmations');
  const finalAssets = await get(`${apiUrl}/api/assets/summary`);
  const finalClaim = finalAssets.claims.find((entry) => entry.id === claim.id);
  assert(finalClaim?.status === 'success' && BigInt(finalClaim.gasUsed || 0) > 0n && BigInt(finalClaim.effectiveGasPriceWei || 0) > 0n && Number(finalClaim.gasBnb) > 0, `claim receipt gas should be persisted: ${JSON.stringify(finalClaim)}`);
  assert((await bnm.balanceOf(buyerAddress)) === parseUnits(order.bnmLocked, 18), 'claim should mint the exact released BNM amount');

  console.log(`local checkout e2e: PASS order=${order.orderId.slice(0, 10)}... npl=${formatUnits(amountNpl, 18)}`);
} finally {
  for (const child of children.reverse()) {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
  }
  if (localOrderSigner) await localOrderSigner.close();
  rmSync(tempDir, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
}

async function deploy(artifactPath, signer, args = []) {
  const artifact = JSON.parse(readFileSync(resolve(outPath, artifactPath), 'utf8'));
  const bytecode = typeof artifact.bytecode === 'object' ? artifact.bytecode.object : artifact.bytecode;
  const factory = new ContractFactory(artifact.abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

function eventPayloadFromReceipt(receipt, escrow, chainId, contractAddress) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    const parsed = escrow.interface.parseLog(log);
    if (parsed?.name !== 'OrderPaid') continue;
    return {
      eventName: parsed.name,
      chainId,
      contractAddress,
      orderId: parsed.args.orderId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      logIndex: log.index,
      buyer: parsed.args.buyer,
      seller: parsed.args.seller,
      productId: parsed.args.productId,
      nplAmountWei: parsed.args.nplAmount.toString(),
      bnmLockedWei: parsed.args.bnmLocked.toString(),
      amountNpl: formatUnits(parsed.args.nplAmount, 18),
      bnmLocked: formatUnits(parsed.args.bnmLocked, 18),
      deadline: Number(parsed.args.deadline),
      orderDigest: parsed.args.orderDigest,
      splitVersion: Number(parsed.args.splitVersion)
    };
  }
  throw new Error('OrderPaid event not found in receipt');
}

function rewardEventPayloadFromReceipt(receipt, rewardLedger, chainId, contractAddress, expectedName) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    let parsed;
    try {
      parsed = rewardLedger.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed?.name !== expectedName) continue;
    const payload = {
      eventName: parsed.name,
      chainId,
      contractAddress,
      entryId: parsed.args.entryId.toString(),
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      logIndex: log.index
    };
    if (parsed.name === 'RewardLocked') {
      return {
        ...payload,
        orderId: parsed.args.orderId,
        user: parsed.args.user,
        asset: parsed.args.asset,
        amountWei: parsed.args.amount.toString(),
        amount: formatUnits(parsed.args.amount, 18),
        bucket: Number(parsed.args.bucket)
      };
    }
    if (parsed.name === 'RewardReleased') return { ...payload, orderId: parsed.args.orderId };
  }
  throw new Error(`${expectedName} event not found in receipt`);
}

async function waitForRpc(url) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
      });
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`anvil RPC did not start at ${url}`);
}

async function waitForHealth(baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`backend did not start at ${baseUrl}`);
}

async function get(url) {
  const response = await fetch(url, { headers: buyerAuthorization({}) });
  const body = await response.json();
  assert(response.ok, `${url} failed ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function siweLogin(baseUrl, signer, address) {
  const nonce = await post(`${baseUrl}/api/auth/siwe/nonce`, { address, role: 'buyer' }, {}, 201);
  const signature = await signer.signMessage(nonce.message);
  return post(`${baseUrl}/api/auth/siwe/verify`, { address, role: 'buyer', message: nonce.message, signature }, {}, 201);
}

async function withSecondary(baseUrl, signer, address, token, action, payload) {
  const headers = { authorization: `Bearer ${token}` };
  const intent = await post(`${baseUrl}/api/auth/action-intent`, { action, payload }, headers, 201);
  assert(intent.action === action && intent.walletAddress?.toLowerCase() === address.toLowerCase(), 'action-intent should bind address action and buyer');
  assert(intent.payloadHash === payloadHashForSignature(payload) && intent.signatureKind === 'personal_sign', 'action-intent should bind exact address payload');
  const secondarySignature = await signer.signMessage(intent.secondaryMessage);
  return { ...payload, secondaryMessage: intent.secondaryMessage, secondarySignature };
}

function payloadHashForSignature(payload) {
  return `0x${createHash('sha256').update(stableStringify(payload || {})).digest('hex')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function post(url, payload, headers = {}, expectedStatus) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buyerAuthorization(headers) },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  assert(response.status === expectedStatus, `${url} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function buyerAuthorization(headers) {
  if (!defaultBuyerToken || headers.authorization) return headers;
  return { authorization: `Bearer ${defaultBuyerToken}`, ...headers };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
