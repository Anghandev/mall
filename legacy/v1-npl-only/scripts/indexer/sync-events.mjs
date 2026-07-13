#!/usr/bin/env node
import { Contract, JsonRpcProvider, formatUnits } from 'ethers';
import { readEnvFile, targetChain } from '../microtest/env-utils.mjs';

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
const escrowAddress = env.EXPO_PUBLIC_ESCROW_ADDRESS;
const rewardLedgerAddress = env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS || '';
const seckillAddress = env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS || '';
const apiBaseUrl = env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8787';

if (!rpcUrl) throw new Error(`Missing RPC URL: ${chain.rpcEnv}`);
if (!/^0x[0-9a-fA-F]{40}$/.test(String(escrowAddress))) throw new Error('Missing EXPO_PUBLIC_ESCROW_ADDRESS');

const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { batchMaxCount: 1 });
const latest = await provider.getBlockNumber();
const confirmations = parsePositiveIntEnv('INDEXER_CONFIRMATIONS', 15);
const finalizedBlock = Math.max(0, latest - confirmations + 1);
const allowUnfinalized = String(env.INDEXER_ALLOW_UNFINALIZED || '').toLowerCase() === 'true';
const defaultFromBlock = Math.max(0, finalizedBlock - 5_000);
const escrowFromBlock = parseBlockEnv('ESCROW_FROM_BLOCK', defaultFromBlock);
const escrowToBlock = parseBlockEnv('ESCROW_TO_BLOCK', finalizedBlock);
const rewardLedgerFromBlock = parseBlockEnv('REWARD_LEDGER_FROM_BLOCK', defaultFromBlock);
const rewardLedgerToBlock = parseBlockEnv('REWARD_LEDGER_TO_BLOCK', escrowToBlock);
const seckillFromBlock = parseBlockEnv('SECKILL_FROM_BLOCK', defaultFromBlock);
const seckillToBlock = parseBlockEnv('SECKILL_TO_BLOCK', escrowToBlock);
const blockChunkSize = parsePositiveIntEnv('INDEXER_BLOCK_CHUNK', 25);
assertBlockRange('escrow', escrowFromBlock, escrowToBlock);
assertBlockRange('rewardLedger', rewardLedgerFromBlock, rewardLedgerToBlock);
assertBlockRange('seckill', seckillFromBlock, seckillToBlock);
if (!allowUnfinalized && Math.max(escrowToBlock, rewardLedgerToBlock, seckillToBlock) > finalizedBlock) {
  throw new Error(`Indexer refuses unfinalized blocks above ${finalizedBlock}; keep INDEXER_ALLOW_UNFINALIZED=false in production.`);
}

const escrowAbi = [
  'event OrderPaid(bytes32 indexed orderId,address indexed buyer,address indexed seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion)',
  'event OrderCompleted(bytes32 indexed orderId,address indexed seller,uint256 nplAmount,uint32 splitVersion)',
  'event OrderAllocation(bytes32 indexed orderId,bytes32 indexed role,address indexed receiver,uint256 amount)',
  'event OrderArbitration(bytes32 indexed orderId,address indexed caller)',
  'event OrderForcedRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 burnedRewards)',
  'event OrderEmergencyRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 burnedRewards)',
  'event SellerApprovalUpdated(address indexed seller,bool approved)',
  'event SplitConfigUpdated(uint32 indexed version,bytes32 indexed configHash)',
  'event OrderSignerUpdated(address indexed signer)',
  'event EscrowPaused(address indexed account)',
  'event EscrowUnpaused(address indexed account)'
];
const rewardLedgerAbi = [
  'event RewardLocked(uint256 indexed entryId,bytes32 indexed orderId,address indexed user,address asset,uint256 amount,uint8 bucket)',
  'event RewardReleased(uint256 indexed entryId,bytes32 indexed orderId)',
  'event RewardClaimed(uint256 indexed entryId,address indexed user,address asset,uint256 amount)',
  'event LockedRewardBurned(uint256 indexed entryId,bytes32 indexed orderId)',
  'event UnclaimedRewardBurned(uint256 indexed entryId,bytes32 indexed orderId,uint8 previousState)',
  'event LedgerPaused(address indexed account)',
  'event LedgerUnpaused(address indexed account)',
  'event OperatorUpdated(address indexed operator,bool enabled)'
];
const seckillAbi = [
  'event SessionStarted(bytes32 indexed sessionId,bytes32 indexed productId,uint64 startsAt,uint64 mainEndsAt,uint64 relayEndsAt,uint256 minimumNplAmount,uint256 prizePoolNpl)',
  'event PurchaseRecorded(bytes32 indexed sessionId,address indexed buyer,bytes32 indexed orderId,uint64 relayEndsAt,uint256 totalBuys)',
  'event SessionForceClosed(bytes32 indexed sessionId)',
  'event SessionSettled(bytes32 indexed sessionId,address indexed winner,bytes32 indexed orderId,uint256 prizePoolNpl)',
  'event SeckillPrizeReleased(bytes32 indexed sessionId,bytes32 indexed rewardOrderId,address indexed winner,uint256 prizePoolNpl)',
  'event SeckillPaused(address indexed account)',
  'event SeckillUnpaused(address indexed account)'
];

const escrow = new Contract(escrowAddress, escrowAbi, provider);
const filterGroups = [
  { contract: escrow, address: escrowAddress, fromBlock: escrowFromBlock, toBlock: escrowToBlock, filters: [
    escrow.filters.OrderPaid(),
    escrow.filters.OrderCompleted(),
    escrow.filters.OrderArbitration(),
    escrow.filters.OrderForcedRefunded(),
    escrow.filters.OrderEmergencyRefunded(),
    escrow.filters.SellerApprovalUpdated(),
    escrow.filters.SplitConfigUpdated(),
    escrow.filters.EscrowPaused(),
    escrow.filters.EscrowUnpaused()
  ] }
];
if (/^0x[0-9a-fA-F]{40}$/.test(String(rewardLedgerAddress))) {
  const rewardLedger = new Contract(rewardLedgerAddress, rewardLedgerAbi, provider);
  filterGroups.push({ contract: rewardLedger, address: rewardLedgerAddress, fromBlock: rewardLedgerFromBlock, toBlock: rewardLedgerToBlock, filters: [
    rewardLedger.filters.RewardLocked(),
    rewardLedger.filters.RewardReleased(),
    rewardLedger.filters.RewardClaimed(),
    rewardLedger.filters.LockedRewardBurned(),
    rewardLedger.filters.UnclaimedRewardBurned(),
    rewardLedger.filters.LedgerPaused(),
    rewardLedger.filters.LedgerUnpaused()
  ] });
}
if (/^0x[0-9a-fA-F]{40}$/.test(String(seckillAddress))) {
  const seckill = new Contract(seckillAddress, seckillAbi, provider);
  filterGroups.push({ contract: seckill, address: seckillAddress, fromBlock: seckillFromBlock, toBlock: seckillToBlock, filters: [
    seckill.filters.SessionStarted(),
    seckill.filters.PurchaseRecorded(),
    seckill.filters.SessionForceClosed(),
    seckill.filters.SessionSettled(),
    seckill.filters.SeckillPrizeReleased(),
    seckill.filters.SeckillPaused(),
    seckill.filters.SeckillUnpaused()
  ] });
}

const events = [];
for (const group of filterGroups) {
  for (const filter of group.filters) {
    const logs = await queryFilterChunked(group.contract, filter, group.fromBlock, group.toBlock, blockChunkSize);
    for (const log of logs) {
      events.push(eventToPayload(log, chain.chainId, group.address));
    }
  }
}

events.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));

let posted = 0;
let duplicate = 0;
for (const payload of events) {
  const response = await fetch(`${apiBaseUrl}/api/chain-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.INDEXER_SECRET ? { 'x-indexer-secret': env.INDEXER_SECRET } : {})
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`event post failed ${response.status}: ${JSON.stringify(body)}`);
  }
  if (body.duplicate) duplicate += 1;
  else posted += 1;
}

const ranges = filterGroups.map((group) => `${group.address}:${group.fromBlock}-${group.toBlock}`).join(',');
console.log(`synced 24K events: posted=${posted} duplicate=${duplicate} confirmations=${confirmations} finalizedBlock=${finalizedBlock} ranges=${ranges} rewardLedger=${rewardLedgerAddress || 'disabled'} seckill=${seckillAddress || 'disabled'}`);

async function queryFilterChunked(contract, filter, fromBlock, toBlock, chunkSize) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(toBlock, start + chunkSize - 1);
    const chunkLogs = await withRetries(() => contract.queryFilter(filter, start, end), `query logs ${start}-${end}`);
    logs.push(...chunkLogs);
    await sleep(150);
  }
  return logs;
}

async function withRetries(fn, label) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === 4 || !isRetryableRpcError(error)) break;
      await sleep(1_000 * attempt);
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function isRetryableRpcError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /rate limit|limit exceeded|timeout|ETIMEDOUT|ECONNRESET|BAD_DATA|SERVER_ERROR|UNKNOWN_ERROR|missing response/i.test(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventToPayload(log, chainId, contractAddress) {
  const name = log.fragment.name;
  const base = {
    eventName: name,
    chainId,
    contractAddress,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    logIndex: log.index
  };

  if (name === 'OrderPaid') {
    return {
      ...base,
      orderId: log.args.orderId,
      buyer: log.args.buyer,
      seller: log.args.seller,
      productId: log.args.productId,
      nplAmountWei: log.args.nplAmount.toString(),
      bnmLockedWei: log.args.bnmLocked.toString(),
      amountNpl: formatUnits(log.args.nplAmount, 18),
      bnmLocked: formatUnits(log.args.bnmLocked, 18),
      deadline: Number(log.args.deadline),
      orderDigest: log.args.orderDigest,
      splitVersion: Number(log.args.splitVersion)
    };
  }
  if (name === 'OrderCompleted') {
    return { ...base, orderId: log.args.orderId, seller: log.args.seller, amountWei: log.args.nplAmount.toString(), amountNpl: formatUnits(log.args.nplAmount, 18), splitVersion: Number(log.args.splitVersion) };
  }
  if (name === 'OrderForcedRefunded') {
    return {
      ...base,
      orderId: log.args.orderId,
      buyer: log.args.buyer,
      refundedNplWei: log.args.refundedNpl.toString(),
      amountWei: log.args.refundedNpl.toString(),
      amountNpl: formatUnits(log.args.refundedNpl, 18),
      burnedRewards: Number(log.args.burnedRewards)
    };
  }
  if (name === 'OrderEmergencyRefunded') {
    return { ...base, orderId: log.args.orderId, buyer: log.args.buyer, refundedNplWei: log.args.refundedNpl.toString(), amountWei: log.args.refundedNpl.toString(), amountNpl: formatUnits(log.args.refundedNpl, 18), burnedRewards: Number(log.args.burnedRewards), emergency: true };
  }
  if (name === 'OrderArbitration') {
    return { ...base, orderId: log.args.orderId, caller: log.args.caller };
  }
  if (name === 'SellerApprovalUpdated') {
    return { ...base, seller: log.args.seller, approved: Boolean(log.args.approved) };
  }
  if (name === 'SplitConfigUpdated') {
    return { ...base, splitVersion: Number(log.args.version), configHash: log.args.configHash };
  }
  if (['EscrowPaused', 'EscrowUnpaused', 'LedgerPaused', 'LedgerUnpaused', 'SeckillPaused', 'SeckillUnpaused'].includes(name)) {
    return { ...base, account: log.args.account };
  }
  if (name === 'RewardLocked') {
    return { ...base, entryId: log.args.entryId.toString(), orderId: log.args.orderId, user: log.args.user, asset: log.args.asset, amountWei: log.args.amount.toString(), amount: formatUnits(log.args.amount, 18), bucket: Number(log.args.bucket) };
  }
  if (name === 'RewardReleased') {
    return { ...base, entryId: log.args.entryId.toString(), orderId: log.args.orderId };
  }
  if (name === 'RewardClaimed') {
    return { ...base, entryId: log.args.entryId.toString(), user: log.args.user, asset: log.args.asset, amountWei: log.args.amount.toString(), amount: formatUnits(log.args.amount, 18) };
  }
  if (name === 'LockedRewardBurned') {
    return { ...base, entryId: log.args.entryId.toString(), orderId: log.args.orderId };
  }
  if (name === 'UnclaimedRewardBurned') {
    return { ...base, entryId: log.args.entryId.toString(), orderId: log.args.orderId, previousState: Number(log.args.previousState) };
  }
  if (name === 'SessionStarted') {
    return { ...base, sessionId: log.args.sessionId, productId: log.args.productId, startsAt: Number(log.args.startsAt), mainEndsAt: Number(log.args.mainEndsAt), relayEndsAt: Number(log.args.relayEndsAt), minimumNplAmountWei: log.args.minimumNplAmount.toString(), minimumNplAmount: formatUnits(log.args.minimumNplAmount, 18), prizePoolNplWei: log.args.prizePoolNpl.toString(), prizePoolNpl: formatUnits(log.args.prizePoolNpl, 18) };
  }
  if (name === 'PurchaseRecorded') {
    return { ...base, sessionId: log.args.sessionId, buyer: log.args.buyer, orderId: log.args.orderId, relayEndsAt: Number(log.args.relayEndsAt), totalBuys: Number(log.args.totalBuys) };
  }
  if (name === 'SessionForceClosed') {
    return { ...base, sessionId: log.args.sessionId };
  }
  if (name === 'SessionSettled') {
    return { ...base, sessionId: log.args.sessionId, winner: log.args.winner, orderId: log.args.orderId, prizePoolNplWei: log.args.prizePoolNpl.toString(), prizePoolNpl: formatUnits(log.args.prizePoolNpl, 18) };
  }
  if (name === 'SeckillPrizeReleased') {
    return { ...base, sessionId: log.args.sessionId, rewardOrderId: log.args.rewardOrderId, winner: log.args.winner, prizePoolNplWei: log.args.prizePoolNpl.toString(), prizePoolNpl: formatUnits(log.args.prizePoolNpl, 18) };
  }
throw new Error(`unsupported event ${name}`);
}

function parseBlockEnv(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(String(raw))) throw new Error(`${name} must be a non-negative integer block number`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a safe non-negative integer block number`);
  return value;
}

function parsePositiveIntEnv(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(String(raw))) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function assertBlockRange(label, fromBlock, toBlock) {
  if (fromBlock > toBlock) throw new Error(`${label} fromBlock ${fromBlock} cannot be greater than toBlock ${toBlock}`);
}
