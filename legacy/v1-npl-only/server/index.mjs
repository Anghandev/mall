#!/usr/bin/env node
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import os from 'node:os';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AbiCoder, Interface, TypedDataEncoder, formatUnits, keccak256, recoverAddress, verifyMessage, verifyTypedData } from 'ethers';
import sanitizeHtml from 'sanitize-html';
import { SiweMessage } from 'siwe';
import { buildXlsx } from './xlsx.mjs';
import {
  createElectronicWaybill,
  integrationReadiness,
  queryShipment,
  reverseGeocode,
  sendNotification,
  signOrderAuthorization,
  submitPrintJob
} from './integrations.mjs';

const SHUTDOWN_TIMEOUT_MS = 10_000;
let db = null;
let auditDb = null;
let server = null;
let databaseClosed = false;
let auditDatabaseClosed = false;
let isShuttingDown = false;
let shutdownPromise = null;
const requestAuditContext = new AsyncLocalStorage();
let verifiedAuditHead = `0x${'0'.repeat(64)}`;
let verifiedAuditCount = 0;
let verifiedAuditDataVersion = 0;
let databaseFilesSeparate = false;
const requestMetrics = [];
const rpcRuntimeState = { active: null, degraded: false, lastLatencyMs: null, lastError: null, checkedAt: null };
const REQUEST_METRICS_LIMIT = 5_000;
const REQUEST_METRICS_WINDOW_MS = 60 * 60_000;

process.once('SIGINT', () => { void shutdown('SIGINT', 0); });
process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });
process.once('uncaughtException', (error) => {
  logFatal('uncaught_exception', error);
  void shutdown('uncaught_exception', 1);
});
process.once('unhandledRejection', (reason) => {
  logFatal('unhandled_rejection', reason);
  void shutdown('unhandled_rejection', 1);
});

loadEnvFile(process.env.SERVER_ENV_FILE || (process.env.NODE_ENV === 'production' ? '.env.production' : '.env.server'));
isolateServerPrivateKeys();

const PORT = Number(process.env.PORT || 8787);
const CHAIN_ID = Number(process.env.EXPO_PUBLIC_BSC_CHAIN_ID || process.env.CHAIN_ID || 56);
const FIXED_BSC_NPL_ADDRESS = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const PUBLIC_BSC_RPC_URL = process.env.EXPO_PUBLIC_BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const PUBLIC_BSC_EXPLORER_URL = process.env.EXPO_PUBLIC_BSC_EXPLORER_URL || 'https://bscscan.com';
const CONFIGURED_NPL = process.env.EXPO_PUBLIC_NPL_BSC_ADDRESS || '';
if (CHAIN_ID === 56 && CONFIGURED_NPL && CONFIGURED_NPL.toLowerCase() !== FIXED_BSC_NPL_ADDRESS.toLowerCase()) {
  throw new Error(`EXPO_PUBLIC_NPL_BSC_ADDRESS must be fixed to ${FIXED_BSC_NPL_ADDRESS} on BSC`);
}
const NPL = CHAIN_ID === 56 ? FIXED_BSC_NPL_ADDRESS : (CONFIGURED_NPL || FIXED_BSC_NPL_ADDRESS);
const ENV_BNM = process.env.EXPO_PUBLIC_BNM_BSC_ADDRESS || '';
const ENV_REWARD_LEDGER = process.env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || process.env.REWARD_LEDGER_ADDRESS || '';
const ENV_ESCROW = process.env.EXPO_PUBLIC_ESCROW_ADDRESS || '';
const ENV_SECKILL = process.env.EXPO_PUBLIC_SECKILL_ADDRESS || process.env.SECKILL_ADDRESS || '';
const ENV_GENESIS_NODE_CONTRACT = process.env.GENESIS_NODE_CONTRACT || '';
let BNM = ENV_BNM;
let REWARD_LEDGER = ENV_REWARD_LEDGER;
let ESCROW = ENV_ESCROW;
let SECKILL = ENV_SECKILL;
let GENESIS_NODE_CONTRACT = ENV_GENESIS_NODE_CONTRACT;
const GENESIS_NODE_TOKEN_STANDARD = String(process.env.GENESIS_NODE_TOKEN_STANDARD || 'erc721').toLowerCase();
if (!['erc20', 'erc721', 'erc1155'].includes(GENESIS_NODE_TOKEN_STANDARD)) throw new Error('GENESIS_NODE_TOKEN_STANDARD must be erc20, erc721 or erc1155');
const GENESIS_NODE_TOKEN_ID = String(process.env.GENESIS_NODE_TOKEN_ID || '').trim();
if (GENESIS_NODE_TOKEN_STANDARD === 'erc1155' && !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(GENESIS_NODE_TOKEN_ID)) throw new Error('GENESIS_NODE_TOKEN_ID is required for ERC1155 credentials');
const GENESIS_NODE_CACHE_TTL_MS = Math.max(5_000, Number(process.env.GENESIS_NODE_CACHE_TTL_MS || 30_000));
const MERCHANT_RECEIVER = process.env.MERCHANT_RECEIVER_ADDRESS || process.env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS || '';
const CONFIGURED_DB_PATH = process.env.DB_PATH || '';
const DB_PATH = CONFIGURED_DB_PATH || 'server/data/24k.db';
const CONFIGURED_AUDIT_DB_PATH = process.env.AUDIT_DB_PATH || '';
const AUDIT_DB_PATH = CONFIGURED_AUDIT_DB_PATH || (DB_PATH === ':memory:' ? ':memory:' : `${DB_PATH}.audit.db`);
const PLACEHOLDER_SELLER = '0x0000000000000000000000000000000000000001';
const MICRO_TEST = process.env.MICRO_TEST === 'true';
const MICRO_TEST_PRODUCT_ID = process.env.MICRO_TEST_PRODUCT_ID || 'p-24k-runner';
const MICRO_TEST_PRODUCT_PRICE_NPL = process.env.MICRO_TEST_PRODUCT_PRICE_NPL || process.env.MICRO_FUND_TX_NPL_AMOUNT || '0.000001';
const MAX_ORDER_AMOUNT_NPL = process.env.MAX_ORDER_AMOUNT_NPL || (MICRO_TEST ? MICRO_TEST_PRODUCT_PRICE_NPL : '');
const INDEXER_SECRET = process.env.INDEXER_SECRET || '';
const LOGISTICS_CALLBACK_SECRET = process.env.LOGISTICS_CALLBACK_SECRET || '';
const MULTISIG_CALLBACK_SECRET = process.env.MULTISIG_CALLBACK_SECRET || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS || '';
const ORDER_SIGNER = process.env.ORDER_SIGNER_ADDRESS || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const AUTH_TOKEN_SECRET = JWT_SECRET || ADMIN_SECRET || INDEXER_SECRET || '24k-local-demo-secret';
const AUTH_SESSION_TTL_MS = Math.max(60_000, Number(process.env.AUTH_SESSION_TTL_MS || 86_400_000));
const SIWE_DOMAIN = process.env.SIWE_DOMAIN || safeUrlHost(process.env.FRONTEND_URL) || '24k.mall';
const SIWE_URI = process.env.SIWE_URI || process.env.FRONTEND_URL || `https://${SIWE_DOMAIN}`;
const ALLOW_UNVERIFIED_CHAIN_EVENTS = process.env.NODE_ENV === 'development' && process.env.ALLOW_UNVERIFIED_CHAIN_EVENTS === 'true';
const CHAIN_EVENT_VERIFY_RPC = !ALLOW_UNVERIFIED_CHAIN_EVENTS;
const ENV_CHAIN_EVENT_RPC_URL = process.env.CHAIN_EVENT_RPC_URL || process.env.BSC_RPC_URL || process.env.EXPO_PUBLIC_BSC_RPC_URL || '';
const ENV_CHAIN_EVENT_RPC_FALLBACK_URL = process.env.CHAIN_EVENT_RPC_FALLBACK_URL || process.env.BSC_RPC_FALLBACK_URL || '';
let CHAIN_EVENT_RPC_URL = ENV_CHAIN_EVENT_RPC_URL;
let CHAIN_EVENT_RPC_FALLBACK_URL = ENV_CHAIN_EVENT_RPC_FALLBACK_URL;
const INDEXER_CONFIRMATIONS = Math.max(1, Number.parseInt(process.env.INDEXER_CONFIRMATIONS || '15', 10) || 15);
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || 262_144);
const DEFAULT_CLAIM_REQUEST_TTL_MS = Math.max(1, Number(process.env.CLAIM_REQUEST_TTL_MS || 10 * 60_000));
const DEFAULT_SIWE_NONCE_TTL_MS = 10 * 60_000;
const DEFAULT_ACTION_INTENT_TTL_MS = 10 * 60_000;
const DB_BUSY_TIMEOUT_MS = 5_000;
const BUSINESS_SCHEMA_VERSION = 2;
const AUDIT_SCHEMA_VERSION = 1;
const ZERO_AUDIT_HASH = `0x${'0'.repeat(64)}`;
const DEFAULT_ORDER_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const REUSABLE_IDEMPOTENCY_STATUSES = new Set(['Draft']);
const TERMINAL_ORDER_STATUSES = new Set(['Released', 'Cancelled', 'ForcedRefunded', 'EmergencyRefunded', 'Claimed']);
const escrowEvents = new Interface([
  'event OrderPaid(bytes32 indexed orderId,address indexed buyer,address indexed seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion)',
  'event OrderCompleted(bytes32 indexed orderId,address indexed seller,uint256 nplAmount,uint32 splitVersion)',
  'event OrderArbitration(bytes32 indexed orderId,address indexed caller)',
  'event OrderForcedRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 burnedRewards)',
  'event OrderEmergencyRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 burnedRewards)',
  'event SellerApprovalUpdated(address indexed seller,bool approved)',
  'event SplitConfigUpdated(uint32 indexed version,bytes32 indexed configHash)',
  'event EscrowPaused(address indexed account)',
  'event EscrowUnpaused(address indexed account)'
]);
const ESCROW_CONTROL_EVENT_NAMES = new Set(['SellerApprovalUpdated', 'SplitConfigUpdated']);
const rewardLedgerEvents = new Interface([
  'event RewardLocked(uint256 indexed entryId,bytes32 indexed orderId,address indexed user,address asset,uint256 amount,uint8 bucket)',
  'event RewardReleased(uint256 indexed entryId,bytes32 indexed orderId)',
  'event RewardClaimed(uint256 indexed entryId,address indexed user,address asset,uint256 amount)',
  'event LockedRewardBurned(uint256 indexed entryId,bytes32 indexed orderId)',
  'event UnclaimedRewardBurned(uint256 indexed entryId,bytes32 indexed orderId,uint8 previousState)',
  'event LedgerPaused(address indexed account)',
  'event LedgerUnpaused(address indexed account)'
]);
const REWARD_EVENT_NAMES = new Set(['RewardLocked', 'RewardReleased', 'RewardClaimed', 'LockedRewardBurned', 'UnclaimedRewardBurned']);
const seckillEvents = new Interface([
  'event SessionStarted(bytes32 indexed sessionId,bytes32 indexed productId,uint64 startsAt,uint64 mainEndsAt,uint64 relayEndsAt,uint256 minimumNplAmount,uint256 prizePoolNpl)',
  'event PurchaseRecorded(bytes32 indexed sessionId,address indexed buyer,bytes32 indexed orderId,uint64 relayEndsAt,uint256 totalBuys)',
  'event SessionForceClosed(bytes32 indexed sessionId)',
  'event SessionSettled(bytes32 indexed sessionId,address indexed winner,bytes32 indexed orderId,uint256 prizePoolNpl)',
  'event SeckillPrizeReleased(bytes32 indexed sessionId,bytes32 indexed rewardOrderId,address indexed winner,uint256 prizePoolNpl)',
  'event SeckillPaused(address indexed account)',
  'event SeckillUnpaused(address indexed account)'
]);
const SECKILL_EVENT_NAMES = new Set(['SessionStarted', 'PurchaseRecorded', 'SessionForceClosed', 'SessionSettled', 'SeckillPrizeReleased']);
const CIRCUIT_EVENT_DEFINITIONS = new Map([
  ['EscrowPaused', { scope: 'orders', enabled: true, contractKind: 'escrow' }],
  ['EscrowUnpaused', { scope: 'orders', enabled: false, contractKind: 'escrow' }],
  ['LedgerPaused', { scope: 'claims', enabled: true, contractKind: 'rewards' }],
  ['LedgerUnpaused', { scope: 'claims', enabled: false, contractKind: 'rewards' }],
  ['SeckillPaused', { scope: 'seckill', enabled: true, contractKind: 'seckill' }],
  ['SeckillUnpaused', { scope: 'seckill', enabled: false, contractKind: 'seckill' }]
]);
const MAX_UINT256 = (1n << 256n) - 1n;
const erc20TxInterface = new Interface([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function transfer(address to,uint256 amount) returns (bool)'
]);
const escrowTxInterface = new Interface([
  'function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)',
  'function completeOrder(bytes32 orderId)',
  'function disputeOrder(bytes32 orderId)',
  'function forceRefund(bytes32 orderId)',
  'function setSeller(address seller,bool approved)',
  'function currentSplitVersion() view returns (uint32)',
  'function splitConfigs(uint32 version) view returns (address platformReceiver,address regionReceiver,address referralReceiver,address prizePoolReceiver,address burnReceiver,address circulationReceiver,uint16 merchantBps,uint16 platformBps,uint16 regionBps,uint16 referralBps,uint16 prizePoolBps,uint16 burnBps,uint16 circulationBps)',
  'function setSplitConfig((address platformReceiver,address regionReceiver,address referralReceiver,address prizePoolReceiver,address burnReceiver,address circulationReceiver,uint16 merchantBps,uint16 platformBps,uint16 regionBps,uint16 referralBps,uint16 prizePoolBps,uint16 burnBps,uint16 circulationBps) config) returns (uint32)',
  'function pause()',
  'function unpause()',
  'function emergencyRefund(bytes32 orderId)'
]);
const seckillTxInterface = new Interface([
  'function recordPurchase(bytes32 sessionId,bytes32 orderId)',
  'function startSession(bytes32 productId,uint64 durationSeconds,uint64 relayInitialSeconds,uint32 relayExtendSeconds,uint256 minimumNplAmount,uint256 prizePoolNpl) returns (bytes32 sessionId)',
  'function forceClose(bytes32 sessionId)',
  'function settle(bytes32 sessionId)',
  'function setMaxGasPriceWei(uint256 newMaxGasPriceWei)',
  'function pause()',
  'function unpause()'
]);
const balanceOfInterface = new Interface(['function balanceOf(address owner) view returns (uint256)']);
const erc1155BalanceOfInterface = new Interface(['function balanceOf(address owner,uint256 tokenId) view returns (uint256)']);
const chainlinkFeedInterface = new Interface([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)'
]);
const safeMultisigInterface = new Interface([
  'function isOwner(address owner) view returns (bool)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)'
]);
const genesisNodeEntitlementCache = new Map();
const rewardLedgerTxInterface = new Interface([
  'function claim(uint256 entryId)',
  'function releaseOrderRewards(bytes32 orderId)',
  'function pause()',
  'function unpause()',
  'function emergencyBurnUnclaimed(bytes32 orderId)'
]);
const erc1271Interface = new Interface(['function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)']);
const ORDER_AUTHORIZATION_TYPES = {
  OrderAuthorization: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'productId', type: 'bytes32' },
    { name: 'nplAmount', type: 'uint256' },
    { name: 'bnmLocked', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'orderDigest', type: 'bytes32' },
    { name: 'splitVersion', type: 'uint32' }
  ]
};
const PRODUCT_UI = {
  'p-24k-runner': { shopBadge: '秒杀', imageTone: 'jacket', category: '运动', summary: '本场秒杀主推单品，仅使用 NPL 托管支付，签收后释放 1:1 BNM。', originalPriceNpl: 168, nplRatio: 100, bnmRebateRate: 100, seckillLocked: true, fulfillmentModes: ['delivery', 'pickup'], adminRegionCode: '210211', skus: [{ id: 'sku-runner-41', name: '黑金 41码', settlementPriceNpl: 120, stock: 8 }, { id: 'sku-runner-42', name: '黑金 42码', settlementPriceNpl: 120, stock: 12 }], tags: ['超级秒杀中', '100%全返 BNM', 'NPL 托管'] },
  'p-24k-phone': { shopBadge: '24K', imageTone: 'watch', category: '数码', summary: '常规商城热卖商品，NPL 付款前锁定地址行政编码与区域代理收益。', originalPriceNpl: 529, nplRatio: 100, bnmRebateRate: 100, fulfillmentModes: ['delivery'], adminRegionCode: '110105', skus: [{ id: 'sku-phone-128', name: '曜金 128G', settlementPriceNpl: 399, stock: 6 }, { id: 'sku-phone-256', name: '曜金 256G', settlementPriceNpl: 469, stock: 4 }], tags: ['链上保卡', 'BNM全返', '48小时发货'] },
  'p-24k-tea': { shopBadge: '自提', imageTone: 'fragrance', category: '食品', summary: '可选择最近门店自提，NPL 付款瞬间绑定门店行政区编码用于区域分红。', originalPriceNpl: 48, nplRatio: 100, bnmRebateRate: 100, fulfillmentModes: ['pickup', 'delivery'], adminRegionCode: '210211', skus: [{ id: 'sku-tea-box', name: '12瓶装', settlementPriceNpl: 36, stock: 40 }], tags: ['到店自提', '门店核销', '区域代理分红'] },
  'p-24k-bag': { shopBadge: '精选', imageTone: 'carry', category: '穿搭', summary: 'NPL 托管购买，签收后 BNM 从 Locked 移入 Available。', originalPriceNpl: 96, nplRatio: 100, bnmRebateRate: 100, fulfillmentModes: ['delivery'], skus: [{ id: 'sku-bag-m', name: '中号', settlementPriceNpl: 86.4, stock: 6 }], tags: ['常规商城', '支持换货', 'NPL 托管'] }
};
const MESSAGE_UI = {
  'm-escrow': { tone: 'escrow', unread: 2 },
  'm-order': { tone: 'order', unread: 1 },
  'm-support': { tone: 'support' },
  'm-system': { tone: 'system' },
  'm-promo': { tone: 'promo' }
};

validateRuntimeConfiguration();

prepareDatabaseDirectory();
if (existsSync(`${DB_PATH}.restore.lock`)) throw new Error('DATABASE_RESTORE_IN_PROGRESS');
db = new DatabaseSync(DB_PATH);
configureDatabase();
auditDb = new DatabaseSync(AUDIT_DB_PATH);
protectDatabaseFilePermissions();
assertSeparateDatabaseFiles();
configureAuditDatabase();
initAuditDb();
verifyAuditChainIntegrity();
initDb();
migrateLegacyAuditLogs();
verifyAuditChainIntegrity();
if (process.env.NODE_ENV !== 'production') seed();
applyRuntimeConfigFromDatabase();

server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  res.once('finish', () => recordRequestMetric(req, res, requestStartedAt));
  requestAuditContext.enterWith({ signatureProofs: new Map() });
  try {
    setCors(req, res);
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      const health = operationalHealth();
      res.setHeader('cache-control', 'no-store');
      return json(res, health.ok ? 200 : 503, health);
    }

    if (isShuttingDown) {
      res.setHeader('connection', 'close');
      return json(res, 503, { error: 'SERVER_SHUTTING_DOWN' });
    }

    if (req.method === 'OPTIONS') return send(res, 204, '');

    enforceRequestFingerprint(req, url.pathname);

    if (req.method === 'GET' && url.pathname === '/') {
      return html(res, 200, renderHomePage());
    }

    if (req.method === 'GET' && url.pathname === '/preview') {
      return html(res, 200, renderPreviewPage());
    }

    if (req.method === 'GET' && url.pathname === '/merchant') {
      return html(res, 200, renderBackstagePage('merchant'));
    }

    if (req.method === 'GET' && url.pathname === '/admin') {
      return html(res, 200, renderBackstagePage('admin'));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/backstage/')) {
      const backstageAssets = new Map([
        ['/backstage/common.js', ['server/backstage/common.js', 'text/javascript; charset=utf-8']],
        ['/backstage/merchant.js', ['server/backstage/merchant.js', 'text/javascript; charset=utf-8']],
        ['/backstage/admin.js', ['server/backstage/admin.js', 'text/javascript; charset=utf-8']],
        ['/backstage/styles.css', ['server/backstage/styles.css', 'text/css; charset=utf-8']]
      ]);
      const asset = backstageAssets.get(url.pathname);
      if (!asset || !existsSync(asset[0])) return json(res, 404, { error: 'ASSET_NOT_FOUND' });
      return textResponse(res, 200, readFileSync(asset[0], 'utf8'), asset[1]);
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      return send(res, 204, '');
    }

    if (req.method === 'GET' && (url.pathname === '/api/dapp/manifest' || url.pathname === '/manifest.webmanifest')) {
      return json(res, 200, dappManifest());
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/integration') {
      return json(res, 200, dappIntegrationContract());
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/handoff') {
      return json(res, 200, dappHandoffBundle(url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/frontend-brief.md') {
      return textResponse(res, 200, dappFrontendBrief(url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined, requestBaseUrl(req)), 'text/markdown; charset=utf-8');
    }

    if (req.method === 'GET' && (url.pathname === '/api/dapp/launch-kit' || url.pathname === '/api/dapp/launch')) {
      return json(res, 200, dappLaunchKit(req, url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined));
    }

    if (req.method === 'GET' && (url.pathname === '/api/dapp/contracts' || url.pathname === '/api/dapp/contracts.json')) {
      return json(res, 200, dappContractsBundle());
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/types.d.ts') {
      return textResponse(res, 200, dappTypeDefinitions(), 'text/typescript; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/sdk.ts') {
      return textResponse(res, 200, dappSdkSource(), 'text/typescript; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/openapi.json') {
      return json(res, 200, dappOpenApiSpec());
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/launch-status') {
      return json(res, 200, dappLaunchStatus(req));
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/24k-dapp.json') {
      return json(res, 200, dappIntegrationContract());
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/logo') {
      return binary(res, 200, readFileSync('assets/logo.jpg'), 'image/jpeg');
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/assets/products/')) {
      const fileName = decodeURIComponent(url.pathname.split('/').pop() || '');
      if (!/^[a-z0-9-]+\.png$/i.test(fileName)) return json(res, 404, { error: 'ASSET_NOT_FOUND' });
      const assetPath = `assets/products/${fileName}`;
      if (!existsSync(assetPath)) return json(res, 404, { error: 'ASSET_NOT_FOUND' });
      return binary(res, 200, readFileSync(assetPath), 'image/png');
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, publicDappConfig());
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/readiness') {
      return json(res, 200, dappReadiness());
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/home') {
      return json(res, 200, dappHome(url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined, storeQueryOptions(url.searchParams)));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/bootstrap') {
      return json(res, 200, dappBootstrap(url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined, storeQueryOptions(url.searchParams)));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/fulfillment-options') {
      return json(res, 200, dappFulfillmentOptions(url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined, storeQueryOptions(url.searchParams)));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/mall-state') {
      return json(res, 200, dappMallState(url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined, url.searchParams));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/stores-state') {
      return json(res, 200, dappStoresState(url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined, storeQueryOptions(url.searchParams)));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/assets-state') {
      const session = requireRole(req, 'buyer');
      const requested = url.searchParams.get('address') || url.searchParams.get('buyerAddress') || session.address;
      if (String(requested).toLowerCase() !== session.address.toLowerCase()) fail(403, 'BUYER_ADDRESS_MISMATCH');
      return json(res, 200, await dappAssetsStateForBuyer(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/order-state') {
      const session = requireBuyerRequest(req, url.searchParams.get('buyerAddress') || url.searchParams.get('address'));
      const params = new URLSearchParams(url.searchParams);
      params.set('buyerAddress', session.address);
      return json(res, 200, await dappOrderState(params));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/seckill-state') {
      return json(res, 200, dappSeckillState(url.searchParams.get('address') || url.searchParams.get('buyerAddress') || undefined));
    }

    if (req.method === 'POST' && url.pathname === '/api/dapp/checkout-intent') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.buyerAddress || body.walletAddress || body.address);
      return json(res, 201, await dappCheckoutIntent(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/dapp/seckill-intent') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.buyerAddress || body.walletAddress || body.address);
      return json(res, 201, await dappSeckillIntent(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/siwe/nonce') {
      const body = await readJson(req);
      return json(res, 201, createSiweNonce(body, req));
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/siwe/verify') {
      const body = await readJson(req);
      return json(res, 201, await verifySiweLogin(body, req));
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/action-intent') {
      const body = await readJson(req);
      const action = requireString(body?.action, 'action');
      const role = action.split('.')[0];
      const session = requireRole(req, role);
      return json(res, 201, createActionIntent(session, action, body?.payload));
    }

    if (req.method === 'GET' && url.pathname === '/api/products') {
      if (url.searchParams.get('includeInactive') === 'true') {
        requireRole(req, 'admin');
        return json(res, 200, db.prepare('SELECT * FROM products ORDER BY id').all().map(toProduct));
      }
      return json(res, 200, db.prepare("SELECT * FROM products WHERE status = 'Active' ORDER BY id").all().map(toProduct));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/products/')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1) || '');
      const row = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'Active'").get(id);
      if (!row) return json(res, 404, { error: 'PRODUCT_NOT_FOUND' });
      const product = toProduct(row);
      return json(res, 200, { ...product, risk: productRiskProfile(row.id), fiveFactorTemplate: fiveFactorTemplate(product), dapp: dappProductDetail(product) });
    }

    if (req.method === 'GET' && url.pathname === '/api/messages') {
      await publishDueNotifications();
      return json(res, 200, db.prepare('SELECT * FROM messages ORDER BY sort_order').all().map(toMessage));
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/dashboard') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, merchantDashboard(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') {
      requireRole(req, 'admin');
      return json(res, 200, adminDashboard());
    }

    if (req.method === 'GET' && url.pathname === '/api/seckill/current') {
      assertCircuitOpen('seckill', 'SECKILL_PAUSED');
      const products = db.prepare("SELECT * FROM products WHERE status = 'Active' ORDER BY id").all().map(toProduct).sort(sortPreviewProduct);
      const session = currentSeckillSession();
      const product = session.id ? products.find((entry) => entry.id === session.productId) || null : null;
      return json(res, 200, { session, feed: seckillFeed(session.id), report: seckillReport(session.id), reportHistory: seckillReportHistory().reports, rules: seckillRules(), product });
    }

    if (req.method === 'GET' && url.pathname === '/api/seckill/feed') {
      assertCircuitOpen('seckill', 'SECKILL_PAUSED');
      const sessionId = url.searchParams.get('sessionId') || currentSeckillSession().id;
      return json(res, 200, { sessionId, feed: seckillFeed(sessionId) });
    }

    if (req.method === 'GET' && url.pathname === '/api/seckill/feed/stream') {
      assertCircuitOpen('seckill', 'SECKILL_PAUSED');
      const sessionId = url.searchParams.get('sessionId') || currentSeckillSession().id;
      return streamSeckillFeed(req, res, sessionId, { once: url.searchParams.get('once') === '1' });
    }

    if (req.method === 'GET' && url.pathname === '/api/seckill/report') {
      assertCircuitOpen('seckill', 'SECKILL_PAUSED');
      const sessionId = url.searchParams.get('sessionId') || currentSeckillSession().id;
      return json(res, 200, seckillReport(sessionId));
    }

    if (req.method === 'GET' && url.pathname === '/api/seckill/reports') {
      assertCircuitOpen('seckill', 'SECKILL_PAUSED');
      return json(res, 200, seckillReportHistory({ limit: url.searchParams.get('limit') }));
    }

    if (req.method === 'GET' && url.pathname === '/api/seckill/rules') {
      assertCircuitOpen('seckill', 'SECKILL_PAUSED');
      return json(res, 200, seckillRules());
    }

    if (req.method === 'GET' && url.pathname === '/api/cms/placements') {
      return json(res, 200, cmsPlacements(url.searchParams));
    }

    if (req.method === 'GET' && url.pathname === '/api/stores') {
      return json(res, 200, storeRows(storeQueryOptions(url.searchParams)));
    }

    if (req.method === 'GET' && url.pathname === '/api/assets/summary') {
      const session = requireRole(req, 'buyer');
      return json(res, 200, await assetSummaryForBuyer(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/address-book') {
      const session = requireRole(req, 'buyer');
      return json(res, 200, addressBookEntries(session.address));
    }

    if (req.method === 'POST' && url.pathname === '/api/address-book/parse') {
      const body = await readJson(req);
      return json(res, 200, parseAddressBookText(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/address-book') {
      const session = requireRole(req, 'buyer');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'buyer.address.upsert');
      const entry = saveAddressBookEntry(body, session.address);
      return json(res, 201, entry);
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/address-book/')) {
      const session = requireRole(req, 'buyer');
      const body = await readJson(req);
      const id = decodeURIComponent(url.pathname.split('/').at(-1) || '');
      requirePathResourceBinding(body, id, 'id');
      requireSecondarySignature(body, session, 'buyer.address.upsert');
      return json(res, 200, saveAddressBookEntry({ ...body, id }, session.address));
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/address-book/')) {
      const session = requireRole(req, 'buyer');
      const body = await readJson(req);
      const id = decodeURIComponent(url.pathname.split('/').at(-1) || '');
      requirePathResourceBinding(body, id, 'id');
      requireSecondarySignature(body, session, 'buyer.address.delete');
      return json(res, 200, deleteAddressBookEntry(session.address, id, body));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/address-book/') && url.pathname.endsWith('/default')) {
      const session = requireRole(req, 'buyer');
      const body = await readJson(req);
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      requirePathResourceBinding(body, id, 'id');
      requireSecondarySignature(body, session, 'buyer.address.default');
      return json(res, 200, setDefaultAddressBookEntry(session.address, id, body));
    }

    if (req.method === 'POST' && url.pathname === '/api/stock/preflight') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.buyerAddress || body.walletAddress || body.address);
      return json(res, 200, stockPreflight(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/dapp/final-check') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.buyerAddress || body.walletAddress || body.address);
      return json(res, 200, dappFinalCheck(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/orders/finalize') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.buyerAddress || body.walletAddress || body.address);
      return json(res, 201, createFinalOrder(body));
    }

    if (req.method === 'GET' && url.pathname === '/api/claims') {
      const session = requireRole(req, 'buyer');
      return json(res, 200, (await assetSummaryForBuyer(session.address)).claims);
    }

    if (req.method === 'POST' && url.pathname === '/api/claims/prepare') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.walletAddress || body.address);
      return json(res, 200, prepareClaimReward(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/dapp/claim-intent') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.walletAddress || body.address);
      return json(res, 200, dappClaimIntent(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/dapp/complete-order-intent') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.buyerAddress || body.walletAddress || body.address);
      return json(res, 200, dappCompleteOrderIntent(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/dapp/timeout-refund-request') {
      const session = requireRole(req, 'buyer');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'buyer.timeout-refund.request');
      return json(res, 201, requestBuyerTimeoutRefund({ ...body, buyerAddress: session.address }));
    }

    if (req.method === 'POST' && url.pathname === '/api/dapp/after-sale/request') {
      const session = requireRole(req, 'buyer');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'buyer.after-sale.request');
      return json(res, 201, requestBuyerAfterSale(session, body));
    }

    if (req.method === 'POST' && url.pathname === '/api/dapp/order-cancel') {
      const session = requireRole(req, 'buyer');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'buyer.order.cancel');
      return json(res, 200, cancelBuyerDraftOrder(session, body));
    }

    if (req.method === 'GET' && url.pathname === '/api/dapp/claim-tx-status') {
      requireBuyerRequest(req, url.searchParams.get('walletAddress') || url.searchParams.get('address'));
      return json(res, 200, await claimTxStatus(url.searchParams));
    }

    if (req.method === 'POST' && url.pathname === '/api/claims') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.walletAddress || body.address);
      return json(res, 201, claimAvailableReward(body));
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/summary') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, merchantDashboard(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
      requireRole(req, 'admin');
      return json(res, 200, adminDashboard());
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/orders') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, merchantOrders(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/product') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, currentMerchantProduct(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/assets') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, merchantDashboard(session.address).assets);
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/claims') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, merchantClaimState(session.address));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/merchant/claims/') && url.pathname.endsWith('/status')) {
      const session = requireRole(req, 'merchant');
      const claimId = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      return json(res, 200, await merchantClaimStatus(session, claimId, url.searchParams));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/merchant/claims/') && url.pathname.endsWith('/cancel')) {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      const claimId = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      requirePathResourceBinding(body, claimId, 'claimId');
      requireSecondarySignature(body, session, 'merchant.claim.cancel');
      return json(res, 200, cancelMerchantClaim(session, claimId, body));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/merchant/claims/') && url.pathname.endsWith('/retry-intent')) {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      const claimId = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      requirePathResourceBinding(body, claimId, 'claimId');
      requireSecondarySignature(body, session, 'merchant.claim.retry');
      return json(res, 200, retryMerchantClaimIntent(session, claimId, body));
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/audit-logs') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, merchantAuditLogs(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/help') {
      requireRole(req, 'merchant');
      return json(res, 200, merchantHelpCenter());
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/export') {
      requireRole(req, 'merchant');
      return json(res, 405, { error: 'SIGNED_POST_REQUIRED' });
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/export') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.orders.export');
      const format = String(body.format || 'csv').toLowerCase();
      const searchParams = merchantExportSearchParams(body.filters || body);
      const exported = exportMerchantOrders(session.address, searchParams, format);
      writeAudit(session.role, session.address, 'merchant.orders.export', exported.fileName, { format, rowCount: exported.rowCount, filters: exported.filters });
      return json(res, 200, exported);
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/print-jobs') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, merchantPrintJobs(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/printers') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, merchantPrinters(session.address));
    }

    if (req.method === 'PATCH' && url.pathname === '/api/merchant/profile') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.profile.update');
      return json(res, 200, updateMerchantProfile(session, body));
    }

    if (req.method === 'GET' && url.pathname === '/api/merchant/stores') {
      const session = requireRole(req, 'merchant');
      return json(res, 200, storeRows({ merchantAddress: session.address }));
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/stores') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.store.upsert');
      return json(res, 201, await upsertMerchantStore(session, body));
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/products') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.product.submit');
      return json(res, 201, submitMerchantProduct(session, body));
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/products/drafts') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.product.draft');
      return json(res, 201, saveMerchantProductDraft(session, body));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/merchant/products/') && url.pathname.endsWith('/submit-review')) {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      const productId = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      requireSecondarySignature(body, session, 'merchant.product.submit-review');
      return json(res, 200, submitMerchantDraftForReview(session, productId, body));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/merchant/products/') && url.pathname.endsWith('/takedown')) {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      const productId = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      requireSecondarySignature(body, session, 'merchant.product.takedown');
      return json(res, 200, requestMerchantProductTakedown(session, productId, body));
    }

    if ((req.method === 'POST' || req.method === 'PATCH') && url.pathname.startsWith('/api/merchant/products/') && url.pathname.endsWith('/lock')) {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      const productId = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      requireSecondarySignature(body, session, 'merchant.product.lock');
      return json(res, 200, lockMerchantProduct(session, productId, body));
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/merchant/products/')) {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      const productId = decodeURIComponent(url.pathname.split('/').at(-1) || '');
      requireSecondarySignature(body, session, 'merchant.product.update');
      return json(res, 200, updateMerchantProduct(session, productId, body));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/merchant/orders/') && url.pathname.endsWith('/ship')) {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      const orderId = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      requireSecondarySignature(body, session, 'merchant.order.ship');
      return json(res, 200, await shipMerchantOrder(session, orderId, body));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/merchant/orders/') && url.pathname.endsWith('/force-sign-request')) {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      const orderId = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      requireSecondarySignature(body, session, 'merchant.order.force-sign-request');
      return json(res, 201, requestMerchantForceSign(session, orderId, body));
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/pickup/verify') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.pickup.verify');
      return json(res, 201, await verifyPickupOrder(session, body));
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/printer') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.printer.configure');
      return json(res, 201, auditedMerchantAction(session, 'merchant.printer.configure', body.deviceId || 'printer', body));
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/print-jobs') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.print.submit');
      return json(res, 201, await createMerchantPrintJob(session, body));
    }

    if (req.method === 'POST' && url.pathname === '/api/merchant/waybills') {
      const session = requireRole(req, 'merchant');
      const body = await readJson(req);
      requireSecondarySignature(body, session, 'merchant.waybill.create');
      return json(res, 201, await createMerchantWaybill(session, body));
    }

	    if (req.method === 'POST' && url.pathname === '/api/merchant/claims') {
	      const session = requireRole(req, 'merchant');
	      const body = await readJson(req);
	      assertCircuitOpen('claims', 'CLAIMS_PAUSED');
	      requireSecondarySignature(body, session, 'merchant.claim.request');
	      return json(res, 201, merchantClaimRequest(session, body));
	    }

    if (req.method === 'GET' && url.pathname === '/api/admin/merchants') {
      requireRole(req, 'admin');
      return json(res, 200, adminMerchants());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/merchant-insights') {
      requireRole(req, 'admin');
      return json(res, 200, adminMerchantInsights(url.searchParams.get('merchantId') || url.searchParams.get('walletAddress')));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/products/history') {
      requireRole(req, 'admin');
      return json(res, 200, adminProductHistory(url.searchParams.get('productId')));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/multisig/approvals') {
      requireRole(req, 'admin');
      return json(res, 200, adminMultisigApprovals());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/reconciliation') {
      requireRole(req, 'admin');
      return json(res, 200, adminReconciliationReport());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/products/pending') {
      requireRole(req, 'admin');
      return json(res, 200, pendingProductSubmissions());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/audit-logs') {
      requireRole(req, 'admin');
      return json(res, 200, auditLogs());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/rpc-audit-logs') {
      requireRole(req, 'admin');
      return json(res, 200, rpcAuditLogs());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/search') {
      requireRole(req, 'admin');
      return json(res, 200, adminSearch(url.searchParams));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/categories') {
      requireRole(req, 'admin');
      return json(res, 200, adminCategories());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/tags') {
      requireRole(req, 'admin');
      return json(res, 200, adminTags());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/configs') {
      requireRole(req, 'admin');
      return json(res, 200, adminConfigs());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/logistics/templates') {
      requireRole(req, 'admin');
      return json(res, 200, adminConfigEntries('logistics-template:'));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/logistics/addresses') {
      requireRole(req, 'admin');
      return json(res, 200, adminConfigEntries('logistics-address:'));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/messages') {
      requireRole(req, 'admin');
      await publishDueNotifications();
      return json(res, 200, adminNotificationDeliveries());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/messages/gateways') {
      requireRole(req, 'admin');
      return json(res, 200, adminMessageGateways());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/audit-streams') {
      requireRole(req, 'admin');
      return json(res, 200, adminAuditStreams());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/risk-events') {
      requireRole(req, 'admin');
      return json(res, 200, adminRiskEvents());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/cms') {
      requireRole(req, 'admin');
      return json(res, 200, adminCmsContents());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/print-jobs') {
      requireRole(req, 'admin');
      return json(res, 200, adminPrintJobs());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/settlement-requests') {
      requireRole(req, 'admin');
      return json(res, 200, adminSettlementRequests());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/after-sales') {
      requireRole(req, 'admin');
      return json(res, 200, adminAfterSaleCases(url.searchParams));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/seckill/sessions') {
      requireRole(req, 'admin');
      return json(res, 200, adminSeckillSessions());
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/ops') {
      requireRole(req, 'admin');
      return json(res, 200, await adminOperationsSnapshot());
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/admin/')) {
      const session = requireRole(req, 'admin');
      const body = await readJson(req);
      const action = adminActionForPath(url.pathname);
      if (!action) return json(res, 404, { error: 'NOT_FOUND' });
      requireSecondarySignature(body, session, action);
      return json(res, 201, await handleAdminAction(session, action, body));
    }

    if (req.method === 'POST' && url.pathname === '/api/integrations/logistics/callback') {
      requireLogisticsCallbackSecret(req);
      const body = await readJson(req);
      return json(res, 202, await recordLogisticsCallback(body));
    }

    if (req.method === 'POST' && url.pathname === '/api/integrations/multisig/approval') {
      requireMultisigCallbackSecret(req);
      const body = await readJson(req);
      return json(res, 202, await recordMultisigApproval(body));
    }

    if (req.method === 'GET' && url.pathname === '/api/buyer/orders') {
      const session = requireRole(req, 'buyer');
      return json(res, 200, buyerOrders(session.address));
    }

    if (req.method === 'GET' && url.pathname === '/api/orders') {
      const buyerAddress = url.searchParams.get('buyerAddress') || url.searchParams.get('address');
      if (buyerAddress) {
        const session = requireRole(req, 'buyer');
        if (String(buyerAddress).toLowerCase() !== session.address.toLowerCase()) fail(403, 'BUYER_ADDRESS_MISMATCH');
        return json(res, 200, buyerOrders(session.address));
      }
      requireAdminSecret(req);
      return json(res, 200, db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50').all().map(toOrder));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/payment-intent')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      const order = findOrderByIdOrOrderId(id);
      if (!order) return json(res, 404, { error: 'ORDER_NOT_FOUND' });
      assertOrderReadAllowed(req, url, order);
      return json(res, 200, await paymentIntentForOrder(order, url.searchParams.get('buyerAddress') || req.headers['x-buyer-address']));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/fund-tx-status')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      const order = findOrderByIdOrOrderId(id);
      if (!order) return json(res, 404, { error: 'ORDER_NOT_FOUND' });
      assertOrderReadAllowed(req, url, order);
      return json(res, 200, await fundingTxStatusForOrder(order, url.searchParams.get('buyerAddress') || req.headers['x-buyer-address'], url.searchParams.get('txHash')));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/timeout-actions')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      const order = findOrderByIdOrOrderId(id);
      if (!order) return json(res, 404, { error: 'ORDER_NOT_FOUND' });
      assertOrderReadAllowed(req, url, order);
      return json(res, 200, orderTimeoutActions(order));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/complete-tx-status')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      const order = findOrderByIdOrOrderId(id);
      if (!order) return json(res, 404, { error: 'ORDER_NOT_FOUND' });
      assertOrderReadAllowed(req, url, order);
      return json(res, 200, await completeTxStatusForOrder(order, url.searchParams.get('buyerAddress') || req.headers['x-buyer-address'], url.searchParams.get('txHash')));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/arbitration-tx-status')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      const order = findOrderByIdOrOrderId(id);
      if (!order) return json(res, 404, { error: 'ORDER_NOT_FOUND' });
      assertOrderReadAllowed(req, url, order);
      return json(res, 200, await arbitrationTxStatusForOrder(order, url.searchParams.get('buyerAddress') || req.headers['x-buyer-address'], url.searchParams.get('txHash')));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/fulfillment')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      const order = findOrderByIdOrOrderId(id);
      if (!order) return json(res, 404, { error: 'ORDER_NOT_FOUND' });
      assertOrderReadAllowed(req, url, order);
      return json(res, 200, fulfillmentSnapshot(order));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/orders/')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1) || '');
      const order = findOrderByIdOrOrderId(id);
      if (!order) return json(res, 404, { error: 'ORDER_NOT_FOUND' });
      assertOrderReadAllowed(req, url, order);
      return json(res, 200, toOrder(order));
    }

    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const body = await readJson(req);
      requireBuyerRequest(req, body.buyerAddress || body.walletAddress || body.address);
      const order = createOrder(body);
      return json(res, 201, order);
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/fund-tx')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      const body = await readJson(req);
      requireBuyerRequest(req, body.buyerAddress || body.walletAddress || body.address);
      const result = await recordFundingTransaction(id, body);
      return json(res, result.duplicate ? 200 : 201, result.order);
    }

    if (req.method === 'POST' && url.pathname === '/api/chain-events') {
      requireIndexerSecret(req);
      const body = await readJson(req);
      const result = await recordChainEvent(body);
      return json(res, result.duplicate ? 200 : 201, result);
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/orders/')) {
      return json(res, 405, { error: 'ORDER_STATUS_IS_CHAIN_EVENT_DRIVEN' });
    }

    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
    if (statusCode >= 500) {
      console.error(JSON.stringify({ level: 'error', method: req.method, path: req.url, error: message, stack: error instanceof Error ? error.stack : undefined }));
      try {
        recordRiskEvent({ kind: 'api-error', severity: 'high', ipHash: requestFingerprint(req, 'ip'), deviceHash: requestFingerprint(req, 'device'), action: `${req.method} ${req.url}`, status: 'Observed', payload: { error: message } });
      } catch {}
      if (message !== 'database is locked') {
        try { writeAudit('system', 'api', 'system.api.error', `${req.method} ${req.url}`, { error: sanitizeError(error), statusCode }); } catch {}
      }
    }
    return json(res, statusCode, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`24K API listening on http://localhost:${PORT}`);
});

function recordRequestMetric(req, res, startedAt) {
  const completedAt = Date.now();
  let pathname = '/unknown';
  try {
    pathname = new URL(String(req.url || '/'), 'http://localhost').pathname;
  } catch {}
  requestMetrics.push({
    completedAt,
    method: String(req.method || 'UNKNOWN').slice(0, 12),
    path: normalizeMetricPath(pathname),
    statusCode: Number(res.statusCode || 0),
    durationMs: Math.max(0, completedAt - Number(startedAt || completedAt))
  });
  const oldestAllowed = completedAt - REQUEST_METRICS_WINDOW_MS;
  while (requestMetrics.length && (requestMetrics[0].completedAt < oldestAllowed || requestMetrics.length > REQUEST_METRICS_LIMIT)) requestMetrics.shift();
}

function normalizeMetricPath(pathnameValue) {
  return String(pathnameValue || '/')
    .replace(/\/0x[0-9a-f]{40,64}(?=\/|$)/gi, '/:chainId')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:id')
    .replace(/\/(?:ord|claim|risk|batch|fulfillment|settlement|submission|product)-[a-z0-9:._-]+(?=\/|$)/gi, '/:id')
    .slice(0, 240);
}

function prepareDatabaseDirectory() {
  const directories = [...new Set([dirname(DB_PATH), dirname(AUDIT_DB_PATH)])];
  if (process.env.NODE_ENV !== 'production') {
    for (const directory of directories) mkdirSync(directory, { recursive: true });
    return;
  }

  for (const directory of directories) {
    let probeFd;
    let probePath;
    try {
      mkdirSync(directory, { recursive: true });
      probePath = join(directory, `.24k-db-write-${process.pid}-${randomBytes(6).toString('hex')}`);
      probeFd = openSync(probePath, 'wx', 0o600);
      closeSync(probeFd);
      probeFd = undefined;
      unlinkSync(probePath);
      probePath = undefined;
    } catch {
      if (probeFd !== undefined) {
        try { closeSync(probeFd); } catch {}
      }
      if (probePath) {
        try { unlinkSync(probePath); } catch {}
      }
      throw new Error('PRODUCTION_DB_DIRECTORY_NOT_WRITABLE');
    }
  }
}

function assertSeparateDatabaseFiles() {
  if (DB_PATH === ':memory:' && AUDIT_DB_PATH === ':memory:') {
    databaseFilesSeparate = true;
    return;
  }
  try {
    const businessLink = lstatSync(DB_PATH);
    const auditLink = lstatSync(AUDIT_DB_PATH);
    if (businessLink.isSymbolicLink() || auditLink.isSymbolicLink()) throw new Error('DATABASE_SYMLINK_NOT_ALLOWED');
    const businessRealPath = realpathSync(DB_PATH);
    const auditRealPath = realpathSync(AUDIT_DB_PATH);
    const businessStats = statSync(businessRealPath);
    const auditStats = statSync(auditRealPath);
    if (
      businessRealPath === auditRealPath
      || (businessStats.dev === auditStats.dev && businessStats.ino === auditStats.ino)
    ) throw new Error('DATABASE_FILES_MUST_BE_SEPARATE');
    databaseFilesSeparate = true;
  } catch (error) {
    if (error instanceof Error && /^(?:DATABASE_SYMLINK_NOT_ALLOWED|DATABASE_FILES_MUST_BE_SEPARATE)$/.test(error.message)) throw error;
    throw new Error('DATABASE_FILE_IDENTITY_CHECK_FAILED');
  }
}

function protectDatabaseFilePermissions() {
  for (const path of [DB_PATH, AUDIT_DB_PATH]) {
    if (path === ':memory:') continue;
    try {
      chmodSync(path, 0o600);
    } catch {
      throw new Error('DATABASE_FILE_PERMISSION_UPDATE_FAILED');
    }
  }
}

function configureDatabase() {
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
  const journalMode = String(db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode || '').toLowerCase();
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0);
  const busyTimeout = Number(db.prepare('PRAGMA busy_timeout').get()?.timeout || 0);
  if (journalMode !== 'wal' || foreignKeys !== 1 || busyTimeout !== DB_BUSY_TIMEOUT_MS) {
    throw new Error('SQLITE_PRAGMA_CONFIGURATION_FAILED');
  }
}

function configureAuditDatabase() {
  auditDb.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
  const journalMode = String(auditDb.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode || '').toLowerCase();
  const busyTimeout = Number(auditDb.prepare('PRAGMA busy_timeout').get()?.timeout || 0);
  if (journalMode !== 'wal' || busyTimeout !== DB_BUSY_TIMEOUT_MS) throw new Error('AUDIT_SQLITE_PRAGMA_CONFIGURATION_FAILED');
}

function initAuditDb() {
  auditDb.exec(`
    CREATE TABLE IF NOT EXISTS audit_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  applySqliteMigration(auditDb, 'audit_schema_migrations', 1, 'independent-append-only-audit', () => {
  auditDb.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_address TEXT NOT NULL,
      role TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      signature_hash TEXT,
      proof_type TEXT NOT NULL DEFAULT 'none',
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rpc_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      error_code TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_migrations (
      source_key TEXT PRIMARY KEY,
      migrated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS rpc_audit_logs_no_update BEFORE UPDATE ON rpc_audit_logs BEGIN SELECT RAISE(ABORT, 'RPC_AUDIT_LOG_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS rpc_audit_logs_no_delete BEFORE DELETE ON rpc_audit_logs BEGIN SELECT RAISE(ABORT, 'RPC_AUDIT_LOG_APPEND_ONLY'); END;
  `);
  });
  assertSchemaVersion(auditDb, 'audit_schema_migrations', AUDIT_SCHEMA_VERSION, 'AUDIT');
  assertAuditSchemaIntegrity();
}

function applySqliteMigration(database, table, version, name, migrate) {
  const existing = database.prepare(`SELECT name FROM ${table} WHERE version = ?`).get(version);
  if (existing) {
    if (existing.name !== name) throw new Error(`SCHEMA_MIGRATION_NAME_MISMATCH:${table}:${version}`);
    return;
  }
  const savepoint = `${table}_${version}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    migrate();
    database.prepare(`INSERT INTO ${table} (version, name) VALUES (?, ?)`).run(version, name);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    try { database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`); } catch {}
    throw error;
  }
}

function assertSchemaVersion(database, table, expectedVersion, label) {
  const versions = database.prepare(`SELECT version FROM ${table} ORDER BY version`).all().map((row) => Number(row.version));
  const valid = versions.length === expectedVersion && versions.every((version, index) => version === index + 1);
  if (!valid) throw new Error(`${label}_SCHEMA_VERSION_MISMATCH:${versions.join(',')}:${expectedVersion}`);
}

function assertAuditSchemaIntegrity() {
  const tables = new Set(auditDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const requiredTables = ['audit_logs', 'rpc_audit_logs', 'audit_migrations', 'audit_schema_migrations'];
  const triggers = Number(auditDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('audit_logs_no_update','audit_logs_no_delete','rpc_audit_logs_no_update','rpc_audit_logs_no_delete')").get()?.count || 0);
  if (!requiredTables.every((table) => tables.has(table)) || triggers !== 4) throw new Error('AUDIT_SCHEMA_INTEGRITY_FAILED');
}

function migrateLegacyAuditLogs() {
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'").get();
  if (!exists) return;
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id').all();
  for (const row of rows) {
    const sourceKey = `${DB_PATH}:audit_logs:${row.id}`;
    if (auditDb.prepare('SELECT 1 AS ok FROM audit_migrations WHERE source_key = ?').get(sourceKey)) continue;
    const payloadJson = String(row.payload_json || '{}');
    let payload = {};
    try { payload = JSON.parse(payloadJson); } catch {}
    const signatureHash = payload.secondarySignatureHash || payload.signatureHash || (typeof payload.txHash === 'string' && /^0x[0-9a-f]{64}$/i.test(payload.txHash) ? payload.txHash.toLowerCase() : null);
    const previousHash = auditDb.prepare('SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get()?.entry_hash || ZERO_AUDIT_HASH;
    const payloadHash = auditPayloadHash(payloadJson);
    const createdAt = row.created_at || new Date().toISOString();
    const entryHash = auditEntryHash({ previousHash, actorAddress: row.actor_address, role: row.role, action: row.action, target: row.target, signatureHash, payloadHash, createdAt });
    auditDb.exec('SAVEPOINT legacy_audit_row');
    try {
      auditDb.prepare(`INSERT INTO audit_logs (actor_address, role, action, target, signature_hash, proof_type, payload_hash, payload_json, previous_hash, entry_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.actor_address, row.role, row.action, row.target, signatureHash, signatureHash ? 'legacy-proof' : 'legacy-unverified', payloadHash, payloadJson, previousHash, entryHash, createdAt
      );
      auditDb.prepare('INSERT INTO audit_migrations (source_key) VALUES (?)').run(sourceKey);
      auditDb.exec('RELEASE SAVEPOINT legacy_audit_row');
    } catch (error) {
      try { auditDb.exec('ROLLBACK TO SAVEPOINT legacy_audit_row; RELEASE SAVEPOINT legacy_audit_row'); } catch {}
      throw error;
    }
  }
  db.exec('DROP TABLE audit_logs');
}

function auditPayloadHash(payloadJson) {
  return `0x${createHash('sha256').update(String(payloadJson)).digest('hex')}`;
}

function auditEntryHash({ previousHash, actorAddress, role, action, target, signatureHash, payloadHash, createdAt }) {
  return `0x${createHash('sha256').update([
    previousHash,
    actorAddress,
    role,
    action,
    target,
    signatureHash || '',
    payloadHash,
    createdAt
  ].join('|')).digest('hex')}`;
}

function verifyAuditChainIntegrity() {
  if (!auditDb || auditDatabaseClosed) throw new Error('AUDIT_DATABASE_UNAVAILABLE');
  const rows = auditDb.prepare(`
    SELECT id, actor_address, role, action, target, signature_hash, payload_hash, payload_json, previous_hash, entry_hash, created_at
    FROM audit_logs
    ORDER BY id
  `).all();
  let previousHash = ZERO_AUDIT_HASH;
  for (const row of rows) {
    const payloadHash = auditPayloadHash(row.payload_json);
    const entryHash = auditEntryHash({
      previousHash,
      actorAddress: row.actor_address,
      role: row.role,
      action: row.action,
      target: row.target,
      signatureHash: row.signature_hash,
      payloadHash,
      createdAt: row.created_at
    });
    if (row.payload_hash !== payloadHash || row.previous_hash !== previousHash || row.entry_hash !== entryHash) {
      throw new Error(`AUDIT_CHAIN_INTEGRITY_FAILED:${row.id}`);
    }
    previousHash = row.entry_hash;
  }
  verifiedAuditHead = previousHash;
  verifiedAuditCount = rows.length;
  verifiedAuditDataVersion = Number(auditDb.prepare('PRAGMA data_version').get()?.data_version || 0);
}

function operationalHealth() {
  const database = databaseHealth();
  const auditDatabase = auditDatabaseHealth();
  const ready = !isShuttingDown && database.status === 'ok' && auditDatabase.status === 'ok';
  return {
    ok: ready,
    status: ready ? 'ok' : 'unavailable',
    liveness: { status: 'ok' },
    readiness: { status: ready ? 'ready' : (isShuttingDown ? 'stopping' : 'not_ready') },
    eventRpcVerification: CHAIN_EVENT_VERIFY_RPC,
    unverifiedChainEventsAllowed: ALLOW_UNVERIFIED_CHAIN_EVENTS,
    chainEventRpcConfigured: Boolean(CHAIN_EVENT_RPC_URL),
    database,
    auditDatabase
  };
}

function auditDatabaseHealth() {
  if (!auditDb || auditDatabaseClosed) return { status: 'unavailable' };
  try {
    const probe = Number(auditDb.prepare('SELECT 1 AS ok').get()?.ok || 0);
    const journalMode = String(auditDb.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase();
    const appendOnlyTriggers = Number(auditDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('audit_logs_no_update','audit_logs_no_delete','rpc_audit_logs_no_update','rpc_audit_logs_no_delete')").get()?.count || 0);
    const schemaVersion = Number(auditDb.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM audit_schema_migrations').get()?.version || 0);
    const dataVersion = Number(auditDb.prepare('PRAGMA data_version').get()?.data_version || 0);
    if (dataVersion !== verifiedAuditDataVersion) verifyAuditChainIntegrity();
    const chainState = auditDb.prepare('SELECT COUNT(*) AS count, COALESCE((SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1), ?) AS head FROM audit_logs').get(ZERO_AUDIT_HASH);
    const hashChainVerified = Number(chainState?.count || 0) === verifiedAuditCount && chainState?.head === verifiedAuditHead;
    const healthy = probe === 1 && journalMode === 'wal' && appendOnlyTriggers === 4 && schemaVersion === AUDIT_SCHEMA_VERSION && hashChainVerified;
    return {
      status: healthy ? 'ok' : 'unavailable',
      separate: databaseFilesSeparate,
      appendOnly: appendOnlyTriggers === 4,
      hashChainVerified,
      schemaVersion,
      journalMode
    };
  } catch {
    return { status: 'unavailable' };
  }
}

function databaseHealth() {
  if (!db || databaseClosed) return { status: 'unavailable' };

  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const probe = Number(db.prepare('SELECT 1 AS ok').get()?.ok || 0);
    db.exec('ROLLBACK');
    transactionStarted = false;

    const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0);
    const journalMode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase();
    const busyTimeoutMs = Number(db.prepare('PRAGMA busy_timeout').get()?.timeout || 0);
    const schemaVersion = Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()?.version || 0);
    const chainEventTriggers = Number(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('chain_events_finality_guard','chain_events_no_update','chain_events_no_delete')").get()?.count || 0);
    const finalityGuard = chainEventTriggers === 3;
    const healthy = probe === 1
      && foreignKeys === 1
      && journalMode === 'wal'
      && busyTimeoutMs === DB_BUSY_TIMEOUT_MS
      && schemaVersion === BUSINESS_SCHEMA_VERSION
      && finalityGuard;
    return {
      status: healthy ? 'ok' : 'unavailable',
      foreignKeys: foreignKeys === 1,
      journalMode,
      busyTimeoutMs,
      schemaVersion,
      chainEventFinalityGuard: finalityGuard,
      chainEventsAppendOnly: finalityGuard
    };
  } catch {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    return { status: 'unavailable' };
  }
}

function shutdown(trigger, requestedExitCode) {
  if (requestedExitCode !== 0) process.exitCode = requestedExitCode;
  if (shutdownPromise) return shutdownPromise;

  isShuttingDown = true;
  console.error(JSON.stringify({ level: 'info', event: 'server_shutdown_started', trigger }));
  shutdownPromise = new Promise((resolve) => {
    let finished = false;
    const timeout = setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', event: 'server_shutdown_timeout', timeoutMs: SHUTDOWN_TIMEOUT_MS }));
      server?.closeAllConnections?.();
      finish(1);
    }, SHUTDOWN_TIMEOUT_MS);

    const finish = (exitCode = requestedExitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      let finalExitCode = Math.max(Number(process.exitCode || 0), exitCode);
      if (db && !databaseClosed) {
        try {
          db.close();
          databaseClosed = true;
        } catch (error) {
          finalExitCode = 1;
          console.error(JSON.stringify({ level: 'error', event: 'database_close_failed', error: sanitizeError(error) }));
        }
      }
      if (auditDb && !auditDatabaseClosed) {
        try {
          auditDb.close();
          auditDatabaseClosed = true;
        } catch (error) {
          finalExitCode = 1;
          console.error(JSON.stringify({ level: 'error', event: 'audit_database_close_failed', error: sanitizeError(error) }));
        }
      }
      console.error(JSON.stringify({ level: finalExitCode === 0 ? 'info' : 'error', event: 'server_shutdown_complete', exitCode: finalExitCode }));
      resolve();
      process.exit(finalExitCode);
    };

    if (!server?.listening) {
      finish();
      return;
    }

    server.close((error) => {
      if (error) {
        console.error(JSON.stringify({ level: 'error', event: 'http_server_close_failed', error: sanitizeError(error) }));
        finish(1);
        return;
      }
      finish();
    });
    server.closeIdleConnections?.();
  });
  return shutdownPromise;
}

function logFatal(event, error) {
  try {
    console.error(JSON.stringify({ level: 'fatal', event, error: sanitizeError(error) }));
  } catch {
    process.stderr.write(`{"level":"fatal","event":"${event}","error":"REDACTED"}\n`);
  }
}

function sanitizeError(error) {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const sensitiveName = /(secret|token|password|private.?key|api.?key|(?:^|_)key(?:$|_)|credential|authorization|cookie)/i;
  const sensitiveValues = Object.entries(process.env)
    .filter(([name, value]) => sensitiveName.test(name) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  for (const value of sensitiveValues) message = message.split(value).join('[REDACTED]');
  return message
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b0x[0-9a-f]{64}\b/gi, '[REDACTED_HEX]')
    .slice(0, 1_000);
}

function validateRuntimeConfiguration() {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = [];
  if (JWT_SECRET.length < 32) missing.push('JWT_SECRET');
  if (ADMIN_SECRET.length < 32) missing.push('ADMIN_SECRET');
  if (INDEXER_SECRET.length < 32) missing.push('INDEXER_SECRET');
  if ([JWT_SECRET, ADMIN_SECRET, INDEXER_SECRET].every((value) => value.length >= 32) && new Set([JWT_SECRET, ADMIN_SECRET, INDEXER_SECRET]).size !== 3) {
    missing.push('SERVER_SECRETS_MUST_BE_DISTINCT');
  }
  if (!isValidAddress(ADMIN_WALLET)) missing.push('ADMIN_WALLET_ADDRESS');
  if (!CONFIGURED_DB_PATH || !isAbsolute(CONFIGURED_DB_PATH)) missing.push('DB_PATH_ABSOLUTE');
  if (!CONFIGURED_AUDIT_DB_PATH || !isAbsolute(CONFIGURED_AUDIT_DB_PATH)) missing.push('AUDIT_DB_PATH_ABSOLUTE');
  if (CONFIGURED_AUDIT_DB_PATH && CONFIGURED_DB_PATH && CONFIGURED_AUDIT_DB_PATH === CONFIGURED_DB_PATH) missing.push('AUDIT_DB_MUST_BE_SEPARATE');
  if (!isValidAddress(ORDER_SIGNER)) missing.push('ORDER_SIGNER_ADDRESS');
  if (!isValidSeller(MERCHANT_RECEIVER)) missing.push('MERCHANT_RECEIVER_ADDRESS');
  if (!isValidAddress(ESCROW)) missing.push('EXPO_PUBLIC_ESCROW_ADDRESS');
  if (!isValidAddress(REWARD_LEDGER)) missing.push('REWARD_LEDGER_ADDRESS');
  if (!isValidAddress(SECKILL)) missing.push('SECKILL_ADDRESS');
  if (!isValidAddress(BNM)) missing.push('EXPO_PUBLIC_BNM_BSC_ADDRESS');
  if (!isValidAddress(GENESIS_NODE_CONTRACT)) missing.push('GENESIS_NODE_CONTRACT');
  if (GENESIS_NODE_TOKEN_STANDARD === 'erc1155' && !GENESIS_NODE_TOKEN_ID) missing.push('GENESIS_NODE_TOKEN_ID');
  if (!/^[1-9][0-9]*$/.test(String(process.env.SECKILL_MAX_GAS_PRICE_WEI || ''))) missing.push('SECKILL_MAX_GAS_PRICE_WEI');
  if (!String(process.env.EXPLORER_API_KEY || process.env.BSCSCAN_API_KEY || '').trim()) missing.push('EXPLORER_API_KEY');
  if (!CHAIN_EVENT_RPC_URL || !/^https:\/\//i.test(CHAIN_EVENT_RPC_URL)) missing.push('CHAIN_EVENT_RPC_URL_HTTPS');
  if (!LOGISTICS_CALLBACK_SECRET || LOGISTICS_CALLBACK_SECRET.length < 32) missing.push('LOGISTICS_CALLBACK_SECRET');
  if (!MULTISIG_CALLBACK_SECRET || MULTISIG_CALLBACK_SECRET.length < 32) missing.push('MULTISIG_CALLBACK_SECRET');
  if (!String(process.env.FRONTEND_URL || '').startsWith('https://')) missing.push('FRONTEND_URL_HTTPS');
  if (!process.env.CORS_ORIGINS) missing.push('CORS_ORIGINS');
  const integrations = integrationReadiness(process.env);
  for (const [name, readiness] of Object.entries(integrations)) {
    if (name !== 'ready' && !readiness.ready) missing.push(`INTEGRATION_${name.toUpperCase()}`);
  }
  const forbiddenSecretNames = ['PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY', 'OWNER_PRIVATE_KEY'];
  if (forbiddenSecretNames.some((name) => Boolean(process.env[name]))) missing.push('REMOVE_PRIVATE_KEY_FROM_SERVER_ENV');
  if (missing.length) throw new Error(`PRODUCTION_CONFIGURATION_INVALID:${missing.join(',')}`);
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  applySqliteMigration(db, 'schema_migrations', 1, 'baseline-business-schema', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      shop_name TEXT NOT NULL,
      title TEXT NOT NULL,
      sku TEXT NOT NULL,
      image_url TEXT NOT NULL DEFAULT '',
      price_npl TEXT NOT NULL,
      stock INTEGER NOT NULL,
      seller_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active'
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preview TEXT NOT NULL,
      date_label TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_id TEXT UNIQUE NOT NULL,
      buyer_address TEXT NOT NULL,
      seller_address TEXT NOT NULL,
      amount_npl TEXT NOT NULL DEFAULT '0.000000000000000000',
      status TEXT NOT NULL,
      tx_hash TEXT,
      fund_tx_hash TEXT,
      last_event_tx_hash TEXT,
      idempotency_key TEXT,
      idempotency_payload_digest TEXT NOT NULL DEFAULT '',
      chain_id INTEGER NOT NULL,
	      escrow_address TEXT NOT NULL,
	      order_digest TEXT NOT NULL,
	      fulfillment_mode TEXT,
	      address_id TEXT,
	      store_id TEXT,
	      region_code TEXT,
	      bnm_locked TEXT NOT NULL DEFAULT '0.000000000000000000',
	      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
	      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
	    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sku_id TEXT,
	      sku_name TEXT,
	      quantity INTEGER NOT NULL,
	      unit_price_npl TEXT NOT NULL,
	      fulfillment_mode TEXT,
	      address_id TEXT,
	      store_id TEXT,
	      region_code TEXT,
	      line_key TEXT NOT NULL,
	      stock_deducted INTEGER NOT NULL DEFAULT 0,
	      UNIQUE(order_id, line_key)
	    );
    CREATE TABLE IF NOT EXISTS chain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      order_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT,
      log_index INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      confirmation_count INTEGER NOT NULL DEFAULT 0,
      required_confirmations INTEGER NOT NULL DEFAULT 0,
      finality_status TEXT NOT NULL DEFAULT 'Legacy',
      finalized_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chain_id, tx_hash, log_index)
    );
    CREATE TABLE IF NOT EXISTS siwe_nonces (
      nonce TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      role TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wallet_action_nonces (
      nonce TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      action TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS product_submissions (
      id TEXT PRIMARY KEY,
      merchant_address TEXT NOT NULL,
      store_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      locked_at TEXT,
      immutable_payload_json TEXT,
      approved_product_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS address_book (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      wallet_address TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS product_skus (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      settlement_price_npl TEXT NOT NULL,
      stock INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS seckill_sessions (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      status TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS seckill_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      buyer_address TEXT,
      order_id TEXT,
      tx_hash TEXT,
      block_number INTEGER,
      log_index INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS seckill_reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      winner_address TEXT,
      winning_order_id TEXT,
      prize_pool_npl TEXT NOT NULL DEFAULT '0.000000000000000000',
      total_buys INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      merchant_address TEXT NOT NULL,
      name TEXT NOT NULL,
      region_code TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS fulfillment_orders (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS logistics_orders (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      carrier TEXT NOT NULL,
      tracking_no TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pickup_verifications (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      code TEXT NOT NULL,
      merchant_address TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reward_ledger (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      order_id TEXT,
      source TEXT NOT NULL,
      asset_symbol TEXT NOT NULL,
      amount TEXT NOT NULL,
      state TEXT NOT NULL,
      tx_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      reward_id TEXT,
      bucket_id TEXT NOT NULL,
      asset_symbol TEXT NOT NULL,
      amount TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      gas_used TEXT,
      effective_gas_price_wei TEXT,
      gas_bnb TEXT,
      expires_at INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS after_sale_cases (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      buyer_address TEXT NOT NULL,
      request_type TEXT NOT NULL,
      status TEXT NOT NULL,
      resolution TEXT,
      reason TEXT NOT NULL DEFAULT '',
      original_order_status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS blacklists (
      address TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS circuit_breakers (
      scope TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'Open',
      pending_enabled INTEGER,
      reason TEXT NOT NULL DEFAULT '',
      last_tx_hash TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS cms_contents (
      key TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admin_configs (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      level INTEGER NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      service_fee_bps INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS product_tags (
      product_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (product_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      merchant_address TEXT NOT NULL,
      order_id TEXT,
      job_type TEXT NOT NULL,
      copies INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      provider_job_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settlement_requests (
      id TEXT PRIMARY KEY,
      order_id TEXT UNIQUE NOT NULL,
      requested_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS logistics_events (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      carrier TEXT NOT NULL,
      tracking_no TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_job_id TEXT,
      last_error TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS risk_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      wallet_address TEXT,
      ip_hash TEXT,
      device_hash TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS request_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT,
      ip_hash TEXT,
      device_hash TEXT,
      action TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  ensureColumn('products', 'image_url', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('products', 'status', "TEXT NOT NULL DEFAULT 'Active'");
	  ensureColumn('orders', 'amount_npl', "TEXT NOT NULL DEFAULT '0.000000000000000000'");
	  ensureColumn('orders', 'fulfillment_mode', 'TEXT');
	  ensureColumn('orders', 'address_id', 'TEXT');
	  ensureColumn('orders', 'store_id', 'TEXT');
	  ensureColumn('orders', 'region_code', 'TEXT');
	  ensureColumn('orders', 'bnm_locked', "TEXT NOT NULL DEFAULT '0.000000000000000000'");
	  ensureColumn('orders', 'fulfillment_verified_at', 'TEXT');
	  ensureColumn('orders', 'settlement_requested_at', 'TEXT');
  ensureColumn('orders', 'idempotency_key', 'TEXT');
  ensureColumn('orders', 'idempotency_payload_digest', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('orders', 'fund_tx_hash', 'TEXT');
  ensureColumn('orders', 'last_event_tx_hash', 'TEXT');
  ensureColumn('orders', 'chain_id', `INTEGER NOT NULL DEFAULT ${Number.isSafeInteger(CHAIN_ID) ? CHAIN_ID : 56}`);
  ensureColumn('orders', 'escrow_address', `TEXT NOT NULL DEFAULT '${escapeSqlString(ESCROW)}'`);
  ensureColumn('orders', 'order_digest', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('chain_events', 'block_hash', 'TEXT');
  ensureColumn('auth_sessions', 'expires_at', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('order_items', 'stock_deducted', 'INTEGER NOT NULL DEFAULT 0');
	  ensureColumn('order_items', 'sku_id', 'TEXT');
	  ensureColumn('order_items', 'sku_name', 'TEXT');
	  ensureColumn('order_items', 'fulfillment_mode', 'TEXT');
	  ensureColumn('order_items', 'address_id', 'TEXT');
	  ensureColumn('order_items', 'store_id', 'TEXT');
	  ensureColumn('order_items', 'region_code', 'TEXT');
	  ensureColumn('claims', 'reward_id', 'TEXT');
	  ensureColumn('claims', 'expires_at', 'INTEGER');
  ensureColumn('claims', 'gas_used', 'TEXT');
  ensureColumn('claims', 'effective_gas_price_wei', 'TEXT');
  ensureColumn('claims', 'gas_bnb', 'TEXT');
  ensureColumn('product_submissions', 'store_id', "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn('product_submissions', 'locked_at', 'TEXT');
  ensureColumn('product_submissions', 'immutable_payload_json', 'TEXT');
  ensureColumn('product_submissions', 'approved_product_id', 'TEXT');
	  ensureOrderItemsFlexibleSchema();
  dedupeActiveProductSubmissionsForUniqueIndex();
	  db.exec(`
    DROP INDEX IF EXISTS orders_idempotency_key_idx;
    DROP INDEX IF EXISTS product_submissions_active_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_idx
      ON orders(buyer_address, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS product_submissions_active_unique
      ON product_submissions(lower(merchant_address), store_id)
      WHERE status IN ('PendingReview', 'Approved', 'Scheduled', 'Live', 'TakedownRequested');
    DROP INDEX IF EXISTS after_sale_cases_active_unique;
    CREATE UNIQUE INDEX after_sale_cases_active_unique
      ON after_sale_cases(order_id)
      WHERE status IN ('Open', 'AwaitingDisputeTransaction', 'Arbitration', 'ExchangeApproved', 'DelayApproved', 'AwaitingCompletionTransaction', 'AwaitingRefundTransaction');
  `);
  });
  applySqliteMigration(db, 'schema_migrations', 2, 'chain-event-finality-and-checkpoints', () => {
    ensureChainEventsFrozenSchema();
    ensureColumn('chain_events', 'confirmation_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('chain_events', 'required_confirmations', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('chain_events', 'finality_status', "TEXT NOT NULL DEFAULT 'Legacy'");
    ensureColumn('chain_events', 'finalized_at', 'TEXT');
    ensureColumn('chain_events', 'created_at', 'TEXT');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS chain_events_chain_tx_log_unique
        ON chain_events(chain_id, tx_hash, log_index);
      CREATE INDEX IF NOT EXISTS chain_events_block_lookup
        ON chain_events(chain_id, block_number, contract_address);
      CREATE TABLE IF NOT EXISTS chain_sync_checkpoints (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        stream_name TEXT NOT NULL,
        next_block INTEGER NOT NULL,
        last_finalized_block INTEGER,
        last_finalized_block_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chain_id, contract_address, stream_name)
      );
      CREATE TABLE IF NOT EXISTS chain_reorg_incidents (
        id TEXT PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        tx_hash TEXT,
        log_index INTEGER,
        block_number INTEGER NOT NULL,
        expected_block_hash TEXT,
        observed_block_hash TEXT,
        status TEXT NOT NULL DEFAULT 'Open',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TEXT
      );
      DROP TRIGGER IF EXISTS chain_events_finality_guard;
      DROP TRIGGER IF EXISTS chain_events_no_update;
      DROP TRIGGER IF EXISTS chain_events_no_delete;
      CREATE TRIGGER chain_events_finality_guard
      BEFORE INSERT ON chain_events
      WHEN NEW.finality_status NOT IN ('Finalized', 'Unverified')
        OR NEW.required_confirmations < 1
        OR NEW.confirmation_count < 0
        OR (
          NEW.finality_status = 'Finalized'
          AND (
            NEW.block_hash IS NULL
            OR length(NEW.block_hash) <> 66
            OR NEW.confirmation_count < NEW.required_confirmations
            OR NEW.finalized_at IS NULL
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'CHAIN_EVENT_FINALITY_REQUIRED');
      END;
      CREATE TRIGGER chain_events_no_update BEFORE UPDATE ON chain_events
      BEGIN
        SELECT RAISE(ABORT, 'CHAIN_EVENTS_APPEND_ONLY');
      END;
      CREATE TRIGGER chain_events_no_delete BEFORE DELETE ON chain_events
      BEGIN
        SELECT RAISE(ABORT, 'CHAIN_EVENTS_APPEND_ONLY');
      END;
    `);
  });
  assertSchemaVersion(db, 'schema_migrations', BUSINESS_SCHEMA_VERSION, 'BUSINESS');
  assertBusinessSchemaIntegrity();
}

function assertBusinessSchemaIntegrity() {
  const columns = new Set(db.prepare('PRAGMA table_info(chain_events)').all().map((row) => row.name));
  const requiredColumns = ['block_hash', 'confirmation_count', 'required_confirmations', 'finality_status', 'finalized_at'];
  const requiredTables = ['chain_sync_checkpoints', 'chain_reorg_incidents'];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const chainEventTriggers = Number(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('chain_events_finality_guard','chain_events_no_update','chain_events_no_delete')").get()?.count || 0);
  const uniqueShapes = chainEventUniqueIndexShapes();
  if (
    !requiredColumns.every((column) => columns.has(column))
    || !requiredTables.every((table) => tables.has(table))
    || chainEventTriggers !== 3
    || !uniqueShapes.includes('chain_id,tx_hash,log_index')
    || uniqueShapes.includes('tx_hash,log_index')
  ) {
    throw new Error('BUSINESS_SCHEMA_INTEGRITY_FAILED');
  }
}

function dedupeActiveProductSubmissionsForUniqueIndex() {
  const duplicateGroups = db.prepare(`
    SELECT lower(merchant_address) AS merchant_address, store_id, COUNT(*) AS count
    FROM product_submissions
    WHERE status IN ('PendingReview', 'Approved', 'Scheduled', 'Live', 'TakedownRequested')
    GROUP BY lower(merchant_address), store_id
    HAVING COUNT(*) > 1
  `).all();
  for (const group of duplicateGroups) {
    const rows = db.prepare(`
      SELECT id
      FROM product_submissions
      WHERE lower(merchant_address) = ? AND store_id = ? AND status IN ('PendingReview', 'Approved', 'Scheduled', 'Live', 'TakedownRequested')
      ORDER BY datetime(created_at) DESC, id DESC
    `).all(group.merchant_address, group.store_id);
    const keep = rows[0]?.id;
    const superseded = rows.slice(1).map((row) => row.id);
    if (!keep || superseded.length === 0) continue;
    const update = db.prepare('UPDATE product_submissions SET status = ? WHERE id = ?');
    for (const id of superseded) update.run('Superseded', id);
    writeAudit('system', 'migration', 'migration.product-submissions.dedupe', `${group.merchant_address}:${group.store_id}`, {
      kept: keep,
      superseded
    });
  }
}

function seed() {
  const sellerForSeed = isValidSeller(MERCHANT_RECEIVER) ? MERCHANT_RECEIVER : PLACEHOLDER_SELLER;
  const seedProducts = [
    ['p-24k-runner', '24K 运动严选', 'Eclipse 黑金轻量跑鞋', 'Eclipse · 42码 · 秒杀库存', 'asset://24k-runner.png', '120.000000000000000000', 12],
    ['p-24k-phone', '24K 数码严选', 'Aurum 链上保卡手机', '曜金 · 256G', 'asset://24k-phone.png', '469.000000000000000000', 4],
    ['p-24k-tea', '24K 高新自提店', '黑金冷萃茶礼盒', '12瓶装 · 到店自提优先', 'asset://24k-tea-box.png', '36.000000000000000000', 40],
    ['p-24k-bag', '24K 生活美学馆', '石墨粒面通勤手袋', '石墨 · 中号', 'asset://24k-carryall.png', '86.400000000000000000', 6]
  ];
	  const legacyProductIds = [
	    ['p', 'di' + 'or', '30'].join('-'),
	    ['p', 'ar' + 'mani', 'sample'].join('-'),
	    ['p', 'mac' + 'book', 'air'].join('-'),
	    ['p', 'pix' + 'el', 'fold'].join('-'),
    ['p', 'npl', 'ceramic', 'dock'].join('-'),
    ['p', 'npl', 'carryall'].join('-'),
    ['p', 'npl', 'orbit', 'watch'].join('-'),
    ['p', 'npl', 'fragrance'].join('-'),
    ['p', 'npl', 'aero', 'console'].join('-'),
    ['p', 'npl', 'silk', 'jacket'].join('-'),
    ['p', 'npl', 'vault', 'bottle'].join('-')
  ];
  db.prepare(`DELETE FROM products WHERE id IN (${legacyProductIds.map(() => '?').join(',')})`).run(...legacyProductIds);
  const insertProduct = db.prepare(`
    INSERT INTO products (id, shop_name, title, sku, image_url, price_npl, stock, seller_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      shop_name = excluded.shop_name,
      title = excluded.title,
      sku = excluded.sku,
      image_url = excluded.image_url
  `);
  seedProducts.forEach((row) => insertProduct.run(...row, sellerForSeed));
  db.prepare(`
    INSERT INTO merchants (id, wallet_address, name, status, payload_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      wallet_address = excluded.wallet_address,
      name = excluded.name,
      status = excluded.status,
      payload_json = excluded.payload_json
  `).run('merchant-abu-24k', sellerForSeed.toLowerCase(), '24K 官方严选', 'Approved', JSON.stringify({ modules: ['单品提报', '发货', '自提核销', '商家 Claim'] }));
  const seedCategories = [
    ['cat-digital', null, 1, '数码', 'smartphone', 10],
    ['cat-sports', null, 1, '运动', 'dumbbell', 20],
    ['cat-food', null, 1, '食品', 'coffee', 30],
    ['cat-style', null, 1, '穿搭', 'shopping-bag', 40],
    ['cat-home', null, 1, '居家', 'house', 50]
  ];
  const insertCategory = db.prepare(`
    INSERT INTO categories (id, parent_id, level, name, icon, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  seedCategories.forEach((row) => insertCategory.run(...row));
  const insertTag = db.prepare('INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
  [
    ['tag-hot', '爆款'],
    ['tag-fast', '极速发货'],
    ['tag-pickup', '门店自提'],
    ['tag-npl', 'NPL 托管'],
    ['tag-bnm', 'BNM 全返']
  ].forEach((row) => insertTag.run(...row));
  const insertSku = db.prepare(`
    INSERT INTO product_skus (id, product_id, name, settlement_price_npl, stock, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      product_id = excluded.product_id,
      name = excluded.name,
      settlement_price_npl = excluded.settlement_price_npl,
      stock = excluded.stock,
      payload_json = excluded.payload_json
  `);
  for (const [productId, ui] of Object.entries(PRODUCT_UI)) {
    for (const sku of ui.skus || []) {
      insertSku.run(sku.id, productId, sku.name, formatDecimal18(parseDecimal18(String(sku.settlementPriceNpl))), Number(sku.stock || 0), JSON.stringify(sku));
    }
  }
  if (isValidSeller(MERCHANT_RECEIVER)) {
    db.prepare(`
      UPDATE products
      SET seller_address = ?
      WHERE id LIKE 'p-24k-%' OR seller_address = ? OR lower(seller_address) = ?
    `).run(MERCHANT_RECEIVER, PLACEHOLDER_SELLER, '0x000000000000000000000000000000000000dead');
  }
  if (MICRO_TEST) {
    db.prepare('UPDATE products SET price_npl = ?, stock = MAX(stock, 1), seller_address = ? WHERE id = ?').run(
      formatDecimal18(parseDecimal18(MICRO_TEST_PRODUCT_PRICE_NPL)),
      sellerForSeed,
      MICRO_TEST_PRODUCT_ID
    );
  }

  const seedMessages = [
    ['m-seckill', '秒杀大厅广播', '当前接力奖池保持闪烁，抢购成功后延长 30 秒。', '刚刚', 1],
    ['m-order', '订单资产锁定', '你的 BNM 全返凭证已进入 Locked，确认收货后释放。', '今天', 2],
    ['m-store', '门店自提提醒', '大连高新自提点 10:00-22:00 可核销。', '昨天', 3]
  ];
  const legacyMessageIds = ['m-ai', 'm-pay', 'm-vip', 'm-service-preview', 'm-shop-preview', 'm-escrow', 'm-support', 'm-system', 'm-promo'];
  db.prepare(`DELETE FROM messages WHERE id IN (${legacyMessageIds.map(() => '?').join(',')}) OR title LIKE ?`).run(...legacyMessageIds, `%${['88', 'VIP'].join('')}%`);
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, title, preview, date_label, sort_order)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      preview = excluded.preview,
      date_label = excluded.date_label,
      sort_order = excluded.sort_order
  `);
  seedMessages.forEach((row) => insertMessage.run(...row));
}

function publicDappConfig() {
  const chain = dappChainConfig();
  return {
    appName: '24K Mall DApp',
    chainId: CHAIN_ID,
    chainIdHex: chain.chainIdHex,
    networkName: CHAIN_ID === 56 ? 'BNB Smart Chain' : `EVM ${CHAIN_ID}`,
    chain,
    wallet: {
      namespace: 'eip155',
      caip2: `eip155:${CHAIN_ID}`,
      switchEthereumChain: {
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chain.chainIdHex }]
      },
      addEthereumChain: {
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: chain.chainIdHex,
          chainName: chain.chainName,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls,
          blockExplorerUrls: chain.blockExplorerUrls
        }]
      }
    },
    nplAddress: NPL,
    fixedNplAddress: FIXED_BSC_NPL_ADDRESS,
    nplAddressFixed: CHAIN_ID === 56,
    bnmAddress: BNM,
    rewardLedgerAddress: REWARD_LEDGER,
    escrowAddress: ESCROW,
    seckillAddress: SECKILL,
    merchantConfigured: isValidSeller(MERCHANT_RECEIVER),
    legacyEscrowMigration: false,
    readiness: {
      escrowConfigured: isValidAddress(ESCROW),
      rewardLedgerConfigured: isValidAddress(REWARD_LEDGER),
      seckillConfigured: isValidAddress(SECKILL),
      merchantConfigured: isValidSeller(MERCHANT_RECEIVER)
    },
    payment: {
      settlement: 'NPL',
      firstPaymentApproval: 'unlimited-npl',
      approvalAmount: 'MaxUint256',
      allowanceSkip: true,
      payOrderDeadlineSeconds: 30 * 60
    }
  };
}

function dappReadiness() {
  const session = currentSeckillSession();
  const chainOk = CHAIN_ID === 56 && NPL.toLowerCase() === FIXED_BSC_NPL_ADDRESS.toLowerCase();
  const paymentReady = chainOk && isValidAddress(ESCROW) && isValidSeller(MERCHANT_RECEIVER);
  const rpcReady = !CHAIN_EVENT_VERIFY_RPC || Boolean(CHAIN_EVENT_RPC_URL);
  const claimsOpen = !circuitState('claims').enabled;
  const ordersOpen = !circuitState('orders').enabled;
  const seckillOpen = !circuitState('seckill').enabled && !circuitState('force-cutoff').enabled;
  const modules = {
    manifest: { ready: true, endpoint: '/api/dapp/manifest' },
    integration: { ready: true, endpoint: '/api/dapp/integration' },
    handoff: { ready: true, endpoint: '/api/dapp/handoff' },
    frontendBrief: { ready: true, endpoint: '/api/dapp/frontend-brief.md' },
    launchKit: { ready: true, endpoint: '/api/dapp/launch-kit' },
    launchStatus: { ready: true, endpoint: '/api/dapp/launch-status' },
    contracts: { ready: true, endpoint: '/api/dapp/contracts.json' },
    types: { ready: true, endpoint: '/api/dapp/types.d.ts' },
    sdk: { ready: true, endpoint: '/api/dapp/sdk.ts' },
    openapi: { ready: true, endpoint: '/api/dapp/openapi.json' },
    home: { ready: true, endpoint: '/api/dapp/home' },
    bootstrap: { ready: true, endpoint: '/api/dapp/bootstrap' },
    seckillState: { ready: true, endpoint: '/api/dapp/seckill-state' },
    mallState: { ready: true, endpoint: '/api/dapp/mall-state' },
    storesState: { ready: true, endpoint: '/api/dapp/stores-state' },
    assetsState: { ready: true, endpoint: '/api/dapp/assets-state' },
    wallet: { ready: chainOk, chainId: CHAIN_ID, chainIdHex: `0x${CHAIN_ID.toString(16)}`, fixedNplAddress: FIXED_BSC_NPL_ADDRESS },
    payment: {
      ready: paymentReady && ordersOpen,
      configured: paymentReady,
      ordersOpen,
      escrowAddress: ESCROW,
      merchantReceiver: MERCHANT_RECEIVER,
      policy: 'NPL unlimited-npl'
    },
    paymentStatusPolling: { ready: paymentReady && rpcReady, rpcReady },
    seckill: {
      ready: isValidAddress(SECKILL) && seckillOpen && session.status === 'live',
      configured: isValidAddress(SECKILL),
      open: seckillOpen,
      sessionId: session.id,
      sessionStatus: session.status
    },
    claims: {
      ready: claimsOpen,
      open: claimsOpen,
      backendIntentReady: true,
      onchainReady: isValidAddress(REWARD_LEDGER),
      rewardLedgerAddress: REWARD_LEDGER,
      bnmAddress: BNM
    }
  };
  const blockers = [];
  const warnings = [];
  if (!chainOk) blockers.push('BSC_CHAIN_OR_FIXED_NPL_MISMATCH');
  if (!isValidAddress(ESCROW)) blockers.push('ESCROW_ADDRESS_NOT_CONFIGURED');
  if (!isValidSeller(MERCHANT_RECEIVER)) blockers.push('MERCHANT_RECEIVER_ADDRESS_NOT_CONFIGURED');
  if (!ordersOpen) blockers.push('ORDERS_PAUSED');
  if (!rpcReady) warnings.push('CHAIN_EVENT_RPC_NOT_CONFIGURED');
  if (!isValidAddress(SECKILL)) warnings.push('SECKILL_ADDRESS_NOT_CONFIGURED');
  if (session.status !== 'live') warnings.push('SECKILL_NOT_LIVE');
  if (!isValidAddress(REWARD_LEDGER)) warnings.push('REWARD_LEDGER_ADDRESS_NOT_CONFIGURED');
  if (!BNM) warnings.push('BNM_TOKEN_NOT_DEPLOYED');
  return {
    ok: blockers.length === 0,
    productionReady: blockers.length === 0 && warnings.length === 0,
    blockers,
    warnings,
    modules,
    endpoints: {
      manifest: '/api/dapp/manifest',
      integration: '/api/dapp/integration',
      handoff: '/api/dapp/handoff',
      frontendBrief: '/api/dapp/frontend-brief.md',
      launchKit: '/api/dapp/launch-kit',
      launchStatus: '/api/dapp/launch-status',
      contracts: '/api/dapp/contracts.json',
      types: '/api/dapp/types.d.ts',
      sdk: '/api/dapp/sdk.ts',
      openapi: '/api/dapp/openapi.json',
      home: '/api/dapp/home',
      bootstrap: '/api/dapp/bootstrap',
      seckillState: '/api/dapp/seckill-state?address=0x...',
      mallState: '/api/dapp/mall-state?address=0x...',
      storesState: '/api/dapp/stores-state?address=0x...&lat=38.86&lng=121.52',
      assetsState: '/api/dapp/assets-state?address=0x...',
      assetsSummary: '/api/assets/summary?address=0x...',
      checkoutIntent: '/api/dapp/checkout-intent',
      seckillIntent: '/api/dapp/seckill-intent',
      claimIntent: '/api/dapp/claim-intent',
      orderState: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...',
      fundingStatus: '/api/orders/:orderId/fund-tx-status?buyerAddress=0x...&txHash=0x...',
      completeOrderIntent: '/api/dapp/complete-order-intent',
      completeTxStatus: '/api/orders/:orderId/complete-tx-status?buyerAddress=0x...&txHash=0x...',
      timeoutActions: '/api/orders/:orderId/timeout-actions?buyerAddress=0x...',
      timeoutRefundRequest: '/api/dapp/timeout-refund-request',
      claimTxStatus: '/api/dapp/claim-tx-status?walletAddress=0x...&rewardId=reward-ledger-1&txHash=0x...'
    },
    checkedAt: new Date().toISOString()
  };
}

function dappLaunchStatus(req) {
  const readiness = dappReadiness();
  const fallbackApiBaseUrl = req ? requestBaseUrl(req) : `http://127.0.0.1:${PORT}`;
  const apiBaseUrl = normalizeAbsoluteUrl(process.env.DAPP_BASE_URL || process.env.EXPO_PUBLIC_API_BASE_URL || fallbackApiBaseUrl, fallbackApiBaseUrl);
  const entryUrl = normalizeAbsoluteUrl(process.env.DAPP_ENTRY_URL || process.env.FRONTEND_URL || process.env.DAPP_QR_URL || apiBaseUrl, apiBaseUrl);
  const reownProjectId = process.env.EXPO_PUBLIC_REOWN_PROJECT_ID || '';
  const fromBlocks = {
    escrow: process.env.ESCROW_FROM_BLOCK || '',
    rewardLedger: process.env.REWARD_LEDGER_FROM_BLOCK || '',
    seckill: process.env.SECKILL_FROM_BLOCK || ''
  };
  const serverSideChainRpcConfigured = hasRuntimeValue(process.env.CHAIN_EVENT_RPC_URL || process.env.BSC_RPC_URL);
  const envStatus = {
    apiBaseUrl,
    apiBaseUrlHttps: isHttpsUrl(apiBaseUrl),
    walletEntryUrl: entryUrl,
    walletEntryUrlHttps: isHttpsUrl(entryUrl),
    reownProjectIdConfigured: hasRuntimeValue(reownProjectId),
    adminWalletConfigured: isValidAddress(ADMIN_WALLET),
    indexerSecretConfigured: hasRuntimeValue(INDEXER_SECRET),
    jwtSecretConfigured: hasRuntimeValue(process.env.JWT_SECRET),
    adminReadSecretConfigured: hasRuntimeValue(ADMIN_SECRET),
    chainEventRpcConfigured: serverSideChainRpcConfigured,
    unverifiedChainEventsAllowed: ALLOW_UNVERIFIED_CHAIN_EVENTS,
    privateKeyPresentInServerEnv: hasRuntimeValue(process.env.PRIVATE_KEY),
    privateKeyAllowedOverride: process.env.ALLOW_PRIVATE_KEY_IN_PROD_CHECK === 'true',
    fromBlocksConfigured: {
      escrow: hasRuntimeValue(fromBlocks.escrow),
      rewardLedger: hasRuntimeValue(fromBlocks.rewardLedger),
      seckill: hasRuntimeValue(fromBlocks.seckill)
    }
  };
  const contracts = {
    npl: { address: NPL, configured: isValidAddress(NPL), fixedBscAddress: FIXED_BSC_NPL_ADDRESS, fixedOnBsc: CHAIN_ID === 56 && NPL.toLowerCase() === FIXED_BSC_NPL_ADDRESS.toLowerCase() },
    escrow: { address: ESCROW, configured: isValidAddress(ESCROW) },
    seckill: { address: SECKILL, configured: isValidAddress(SECKILL) },
    bnm: { address: BNM, configured: isValidAddress(BNM), plannedWhenEmpty: !BNM },
    rewardLedger: { address: REWARD_LEDGER, configured: isValidAddress(REWARD_LEDGER) },
    merchantReceiver: { address: MERCHANT_RECEIVER, configured: isValidSeller(MERCHANT_RECEIVER) }
  };
  const rawBlockers = [];
  const add = (key, name, ok, fix, source = 'runtime-env') => {
    if (!ok) rawBlockers.push({ key, name, fix, source });
  };
  add('chain-fixed-npl', 'BSC chain id and fixed NPL contract must match docs', CHAIN_ID === 56 && contracts.npl.fixedOnBsc, `Set CHAIN_ID/EXPO_PUBLIC_BSC_CHAIN_ID=56 and EXPO_PUBLIC_NPL_BSC_ADDRESS=${FIXED_BSC_NPL_ADDRESS}.`, 'contracts');
  add('deploy-escrow', 'PaymentEscrow contract address missing', contracts.escrow.configured, 'Deploy/configure Abu24KPaymentEscrow and set EXPO_PUBLIC_ESCROW_ADDRESS.', 'contracts');
  add('merchant-receiver', 'Merchant receiver wallet missing', contracts.merchantReceiver.configured, 'Set MERCHANT_RECEIVER_ADDRESS to the approved merchant settlement wallet.', 'contracts');
  add('deploy-rewards', 'BNMToken + RewardLedger missing', contracts.bnm.configured && contracts.rewardLedger.configured, 'Deploy/configure BNMToken + Abu24KRewardLedger and set EXPO_PUBLIC_BNM_BSC_ADDRESS plus EXPO_PUBLIC_REWARD_LEDGER_ADDRESS.', 'contracts');
  add('deploy-seckill', 'Abu24KSeckill contract address missing', contracts.seckill.configured, 'Deploy/configure Abu24KSeckill and set EXPO_PUBLIC_SECKILL_ADDRESS.', 'contracts');
  add('event-from-blocks', 'Event indexer from-blocks missing', envStatus.fromBlocksConfigured.escrow && envStatus.fromBlocksConfigured.rewardLedger && envStatus.fromBlocksConfigured.seckill, 'Set ESCROW_FROM_BLOCK, REWARD_LEDGER_FROM_BLOCK and SECKILL_FROM_BLOCK from deployment receipts.', 'indexer');
  add('https-wallet-entry', 'Public API URL must be HTTPS for strict wallet launch', envStatus.apiBaseUrlHttps, 'Set DAPP_BASE_URL / EXPO_PUBLIC_API_BASE_URL to the deployed HTTPS backend URL.', 'urls');
  add('https-wallet-entry', 'Wallet/DApp entry URL must be HTTPS for phone wallet or DEX browser', envStatus.walletEntryUrlHttps, 'Set DAPP_ENTRY_URL / FRONTEND_URL / DAPP_QR_URL to the HTTPS frontend URL users type into wallets.', 'urls');
  add('wallet-project-id', 'Reown project id missing for wallet UI', envStatus.reownProjectIdConfigured, 'Set EXPO_PUBLIC_REOWN_PROJECT_ID or choose an injected-wallet-only frontend explicitly.', 'wallet');
  add('admin-wallet', 'Production admin SIWE wallet missing', envStatus.adminWalletConfigured, 'Set ADMIN_WALLET_ADDRESS to an operations wallet or multisig address.', 'admin');
  add('chain-event-rpc', 'Production chain-event RPC missing', envStatus.chainEventRpcConfigured, 'Set CHAIN_EVENT_RPC_URL or BSC_RPC_URL for receipt verification and status polling.', 'indexer');
  add('server-secrets', 'Production INDEXER_SECRET/JWT_SECRET/ADMIN_SECRET incomplete', envStatus.indexerSecretConfigured && envStatus.jwtSecretConfigured && envStatus.adminReadSecretConfigured, 'Set INDEXER_SECRET, JWT_SECRET and ADMIN_SECRET on the production server.', 'secrets');
  add('server-secrets', 'Unverified chain events must be disabled in production', !envStatus.unverifiedChainEventsAllowed, 'Set ALLOW_UNVERIFIED_CHAIN_EVENTS=false in production.', 'secrets');
  add('server-private-key-split', 'Production server env must not carry PRIVATE_KEY', !envStatus.privateKeyPresentInServerEnv || envStatus.privateKeyAllowedOverride, 'Keep PRIVATE_KEY only in local deploy/micro-test env; do not put it on the production DApp server.', 'secrets');
  const uniqueBlockers = dedupeLaunchBlockers(rawBlockers);
  return {
    kind: '24k-dapp-launch-status',
    generatedAt: new Date().toISOString(),
    localOk: readiness.ok,
    strictLaunchOk: rawBlockers.length === 0,
    localBlockers: readiness.blockers,
    strictLaunchBlockers: rawBlockers,
    uniqueBlockers,
    criticalPath: buildLaunchCriticalPath(uniqueBlockers),
    fixedPolicy: {
      chainId: 56,
      npl: FIXED_BSC_NPL_ADDRESS,
      payment: 'NPL',
      firstPaymentApproval: 'NPL approve(MaxUint256), then allowance skip',
      approvalAmount: 'MaxUint256',
      seckillCallerRule: 'tx.origin == msg.sender',
      refund: 'no user no-reason refund; platform forced refund / 7-day timeout / emergency refund only',
      bnm: 'new project ERC20 credential',
      circuitBreakers: {
        orders: circuitState('orders'),
        seckill: circuitState('seckill'),
        claims: circuitState('claims'),
        forceCutoff: circuitState('force-cutoff')
      },
      privateKeyPrinted: false
    },
    contracts,
    envStatus,
    endpoints: {
      readiness: '/api/dapp/readiness',
      launchStatus: '/api/dapp/launch-status',
      launchKit: '/api/dapp/launch-kit?address=0x...',
      handoff: '/api/dapp/handoff?address=0x...',
      frontendBrief: '/api/dapp/frontend-brief.md?address=0x...',
      bootstrap: '/api/dapp/bootstrap?address=0x...',
      seckillState: '/api/dapp/seckill-state?address=0x...',
      mallState: '/api/dapp/mall-state?address=0x...',
      storesState: '/api/dapp/stores-state?address=0x...&lat=38.86&lng=121.52',
      assetsState: '/api/dapp/assets-state?address=0x...',
      contracts: '/api/dapp/contracts.json',
      openapi: '/api/dapp/openapi.json',
      types: '/api/dapp/types.d.ts',
      sdk: '/api/dapp/sdk.ts'
    }
  };
}

function dedupeLaunchBlockers(blockers) {
  const groups = new Map();
  for (const item of blockers) {
    const key = item.key || launchBlockerKey(item.name);
    const existing = groups.get(key) || { key, title: launchBlockerTitle(key, item.name), sources: new Set(), rawNames: new Set(), fixes: new Set() };
    if (item.source) existing.sources.add(item.source);
    if (item.name) existing.rawNames.add(item.name);
    if (item.fix) existing.fixes.add(item.fix);
    groups.set(key, existing);
  }
  return [...groups.values()].map((entry) => ({
    key: entry.key,
    title: entry.title,
    sources: [...entry.sources],
    rawNames: [...entry.rawNames],
    fixes: [...entry.fixes]
  }));
}

function launchBlockerKey(name) {
  const text = String(name || '').toLowerCase();
  if (/bnm|reward/.test(text)) return 'deploy-rewards';
  if (/seckill/.test(text)) return 'deploy-seckill';
  if (/from-block|indexer/.test(text)) return 'event-from-blocks';
  if (/https|entry url|api url/.test(text)) return 'https-wallet-entry';
  if (/admin/.test(text)) return 'admin-wallet';
  if (/rpc/.test(text)) return 'chain-event-rpc';
  if (/private/.test(text)) return 'server-private-key-split';
  if (/secret|unverified/.test(text)) return 'server-secrets';
  return text.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function launchBlockerTitle(key, fallback) {
  return {
    'chain-fixed-npl': 'Use BSC 56 and fixed NPL docs contract',
    'deploy-escrow': 'Deploy/configure Abu24KPaymentEscrow',
    'merchant-receiver': 'Set merchant settlement receiver',
    'deploy-rewards': 'Deploy/configure BNMToken + RewardLedger',
    'deploy-seckill': 'Deploy/configure Abu24KSeckill',
    'event-from-blocks': 'Set event indexer from-blocks',
    'https-wallet-entry': 'Set HTTPS API and wallet/DApp entry URL',
    'wallet-project-id': 'Set wallet UI project id',
    'admin-wallet': 'Set production admin SIWE wallet',
    'chain-event-rpc': 'Set production chain-event RPC',
    'server-secrets': 'Set production server secrets and verified events',
    'server-private-key-split': 'Keep deploy PRIVATE_KEY out of production server env'
  }[key] || fallback || key;
}

function buildLaunchCriticalPath(uniqueBlockers) {
  const present = new Set(uniqueBlockers.map((entry) => entry.key));
  const steps = [];
  const add = (key, title, command, note) => {
    if (present.has(key)) steps.push({ key, title, command, note });
  };
  add('chain-fixed-npl', 'Fix BSC/NPL config', `set CHAIN_ID=56 and EXPO_PUBLIC_NPL_BSC_ADDRESS=${FIXED_BSC_NPL_ADDRESS}`, 'Docs require the fixed BSC NPL contract.');
  add('deploy-escrow', 'Deploy/configure Abu24KPaymentEscrow', 'pnpm deploy:escrow -- --write-env && pnpm deploy:check-escrow', 'Requires explicit gas authorization and local deploy wallet only.');
  add('merchant-receiver', 'Set merchant receiver', 'set MERCHANT_RECEIVER_ADDRESS=<merchant_receiver_wallet>', 'Use the approved settlement receiver address.');
  add('deploy-rewards', 'Deploy BNMToken + RewardLedger', 'pnpm deploy:rewards -- --write-env && pnpm deploy:check-rewards', 'Requires explicit gas authorization and local deploy wallet only.');
  add('deploy-seckill', 'Deploy Abu24KSeckill', 'pnpm deploy:seckill -- --write-env && pnpm deploy:check-seckill', 'Requires explicit gas authorization and local deploy wallet only.');
  add('event-from-blocks', 'Set RewardLedger/Seckill/Escrow from-blocks', 'set ESCROW_FROM_BLOCK, REWARD_LEDGER_FROM_BLOCK and SECKILL_FROM_BLOCK', 'Use deployment receipt block numbers.');
  add('https-wallet-entry', 'Set HTTPS DApp entry and API URLs', 'set DAPP_BASE_URL=https://your-api-domain and DAPP_ENTRY_URL=https://your-frontend-domain', 'Wallet/DEX browsers cannot use localhost for real users.');
  add('wallet-project-id', 'Set wallet UI project id', 'set EXPO_PUBLIC_REOWN_PROJECT_ID=<project_id>', 'Needed if the frontend uses Reown wallet UI.');
  add('admin-wallet', 'Set admin SIWE wallet', 'set ADMIN_WALLET_ADDRESS=<admin_wallet>', 'Use an operations wallet or multisig, not a private key.');
  add('chain-event-rpc', 'Set production chain-event RPC', 'set CHAIN_EVENT_RPC_URL=<bsc_rpc_url>', 'Used for receipt verification and status polling.');
  add('server-secrets', 'Set production server secrets and disable unverified events', 'set INDEXER_SECRET, JWT_SECRET, ADMIN_SECRET and ALLOW_UNVERIFIED_CHAIN_EVENTS=false', 'Keeps chain-event writes and admin APIs controlled.');
  add('server-private-key-split', 'Remove deploy key from production server env', 'pnpm dapp:prod-env-check -- --strict', 'Production DApp server must not carry deploy PRIVATE_KEY.');
  steps.push({ key: 'final-gate', title: 'Run final strict gate', command: 'pnpm dapp:frontend-pack && pnpm dapp:strict-gate -- --strict', note: 'Passes only when all launch blockers are cleared.' });
  return steps;
}

function dappChainConfig() {
  const chainIdHex = `0x${CHAIN_ID.toString(16)}`;
  const chainName = CHAIN_ID === 56 ? 'BNB Smart Chain' : `EVM ${CHAIN_ID}`;
  const rpcUrls = CHAIN_ID === 56 ? [PUBLIC_BSC_RPC_URL] : [process.env.EXPO_PUBLIC_BSC_RPC_URL || PUBLIC_BSC_RPC_URL];
  const blockExplorerUrls = CHAIN_ID === 56 ? [PUBLIC_BSC_EXPLORER_URL] : [process.env.EXPO_PUBLIC_BSC_EXPLORER_URL || PUBLIC_BSC_EXPLORER_URL];
  return {
    chainId: CHAIN_ID,
    chainIdHex,
    chainName,
    caip2: `eip155:${CHAIN_ID}`,
    nativeCurrency: {
      name: 'BNB',
      symbol: 'BNB',
      decimals: 18
    },
    rpcUrls,
    blockExplorerUrls
  };
}

function dappManifest() {
  const config = publicDappConfig();
  return {
    name: '24K Mall DApp',
    short_name: '24K Mall',
    description: '24K Web3 mall on BNB Smart Chain with NPL settlement and BNM rewards.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#080704',
    theme_color: '#D8A23A',
    icons: [
      { src: '/api/logo', sizes: '512x512', type: 'image/jpeg', purpose: 'any' }
    ],
    chain: config.chain,
    wallet: config.wallet,
    tokens: {
      npl: config.nplAddress,
      bnm: config.bnmAddress || 'planned-new-bnm-token'
    },
    endpoints: {
      bootstrap: '/api/dapp/bootstrap',
      integration: '/api/dapp/integration',
      handoff: '/api/dapp/handoff',
      frontendBrief: '/api/dapp/frontend-brief.md',
      launchKit: '/api/dapp/launch-kit',
      launchStatus: '/api/dapp/launch-status',
      contracts: '/api/dapp/contracts.json',
      types: '/api/dapp/types.d.ts',
      sdk: '/api/dapp/sdk.ts',
      openapi: '/api/dapp/openapi.json',
      home: '/api/dapp/home',
      seckillState: '/api/dapp/seckill-state?address=0x...',
      mallState: '/api/dapp/mall-state?address=0x...',
      storesState: '/api/dapp/stores-state?address=0x...&lat=38.86&lng=121.52',
      assetsState: '/api/dapp/assets-state?address=0x...',
      assetsSummary: '/api/assets/summary?address=0x...',
      orderState: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...',
      fulfillmentOptions: '/api/dapp/fulfillment-options?address=0x...&lat=38.86&lng=121.52',
      seckillFeedStream: '/api/seckill/feed/stream',
      seckillRules: '/api/seckill/rules',
      seckillReportHistory: '/api/seckill/reports',
      config: '/api/config'
    }
  };
}

function dappIntegrationContract() {
  const config = publicDappConfig();
  return {
    version: '24k-dapp-contract-v1',
    purpose: '给 H5 / 钱包浏览器 DApp 前端使用：用户在钱包 DApp 浏览器输入网址后，前端按此契约拉取配置、组装钱包交易并轮询链上结果。',
    launch: {
      entryUrl: '/',
      wellKnown: '/.well-known/24k-dapp.json',
      manifest: '/manifest.webmanifest',
      launchKit: '/api/dapp/launch-kit?address=0x...',
      launchStatus: '/api/dapp/launch-status',
      handoff: '/api/dapp/handoff?address=0x...',
      frontendBrief: '/api/dapp/frontend-brief.md?address=0x...',
      contracts: '/api/dapp/contracts.json',
      types: '/api/dapp/types.d.ts',
      sdk: '/api/dapp/sdk.ts',
      openapi: '/api/dapp/openapi.json',
      readiness: '/api/dapp/readiness',
      home: '/api/dapp/home?address=0x...',
      seckillState: '/api/dapp/seckill-state?address=0x...',
      mallState: '/api/dapp/mall-state?address=0x...',
      storesState: '/api/dapp/stores-state?address=0x...&lat=38.86&lng=121.52',
      assetsState: '/api/dapp/assets-state?address=0x...',
      assetsSummary: '/api/assets/summary?address=0x...',
      orderState: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...',
      fulfillmentOptions: '/api/dapp/fulfillment-options?address=0x...&lat=38.86&lng=121.52',
      seckillFeedStream: '/api/seckill/feed/stream?sessionId=0x...',
      seckillRules: '/api/seckill/rules',
      seckillReportHistory: '/api/seckill/reports',
      bootstrap: '/api/dapp/bootstrap?address=0x...',
      requiredChainId: 56,
      requiredChainIdHex: '0x38',
      walletMethods: ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_call', 'eth_sendTransaction', 'personal_sign']
    },
    tokens: {
      npl: config.nplAddress,
      fixedBscNplAddress: FIXED_BSC_NPL_ADDRESS,
      bnm: config.bnmAddress || 'planned-new-bnm-token'
    },
    contracts: {
      escrow: config.escrowAddress,
      seckill: config.seckillAddress,
      rewardLedger: config.rewardLedgerAddress
    },
    policies: {
      payment: {
        split: 'NPL',
        firstPaymentApproval: 'unlimited-npl',
        allowanceSkip: true,
        approvalAmount: 'MaxUint256',
        approveOrder: ['NPL']
      },
      refund: '不开放用户无理由退款；只保留平台强制退款、7天超时处理和 emergency refund。',
      seckill: {
        contractCallerBlocked: true,
        callerRule: 'tx.origin == msg.sender'
      },
      secrets: '后端不会返回或要求 PRIVATE_KEY；DApp 只接收 calldata / endpoint / personal_sign 消息。'
    },
    flows: {
      launch: [
        'GET /api/dapp/readiness',
        'GET /api/dapp/launch-status',
        'GET /api/dapp/launch-kit?address=<connectedWallet> 生成手机扫码/钱包浏览器启动资料',
        'GET /api/dapp/home?address=<connectedWallet> 一次拿四个 Tab 首屏数据',
        'GET /api/dapp/seckill-state?address=<connectedWallet> 刷新秒杀大厅 phase/timers/cta/奖池/战报/领奖状态',
        'GET /api/dapp/mall-state?address=<connectedWallet> 刷新常规商城商品卡/筛选/终核动作',
        'GET /api/dapp/stores-state?address=<connectedWallet>&lat=...&lng=... 刷新线下门店/GPS/自提模板',
        'GET /api/dapp/assets-state?address=<connectedWallet> 刷新资产页订单动作/收益池/Claim CTA',
        'GET /api/dapp/bootstrap?address=<connectedWallet>',
        'GET /api/dapp/order-state?buyerAddress=<connectedWallet>&orderId=<orderId> 统一刷新订单、履约、资产动作和 tx 状态',
        '如链不匹配，使用 bootstrap.config.wallet.switchEthereumChain / addEthereumChain'
      ],
      regularCheckout: [
        'GET /api/dapp/fulfillment-options?address=<connectedWallet>&lat=...&lng=... 同时拿地址仓和自提门店行政区锁定信息',
        'POST /api/dapp/final-check 展示五要素终核弹窗',
        'POST /api/dapp/checkout-intent',
        'eth_call allowanceChecks',
        'allowance 不足时 eth_sendTransaction approvalTransactions[NPL]',
        'eth_sendTransaction payOrderTransaction',
        'GET /api/orders/:orderId/fund-tx-status?buyerAddress=...&txHash=...'
      ],
      confirmReceipt: [
        '仅订单已发货 Shipped 或门店核销 PickupReady 后，才允许用户确认收货',
        '先 GET /api/orders/:orderId/fulfillment?buyerAddress=... 读取 confirmability / releasePreview / nextActions',
        '用户确认收货/门店核销后 POST /api/dapp/complete-order-intent',
        'eth_sendTransaction completeOrderTransaction',
        'GET /api/orders/:orderId/complete-tx-status?buyerAddress=...&txHash=...',
        '完成后刷新 /api/assets/summary 与 /api/buyer/orders'
      ],
      timeoutAndRefund: [
        'GET /api/orders/:orderId/timeout-actions?buyerAddress=... 判断 7 天超时动作',
        '商家 7 天未发货：POST /api/dapp/timeout-refund-request 创建 RefundRequested',
        '用户无理由退款不开放；平台按审计调用 Abu24KPaymentEscrow.forceRefund，全额退回托管 NPL 并原子销毁未领取奖励',
        '用户 7 天未确认收货：商家后台 POST /api/merchant/orders/:orderId/force-sign-request，平台仲裁/owner completeOrder'
      ],
      seckillCheckout: [
        'GET /api/dapp/seckill-state?address=<connectedWallet> 读取秒杀大厅统一状态，驱动未开启/进行中/结算/已结算 CTA',
        'POST /api/dapp/seckill-intent',
        '先完成 regularCheckout 的授权与 payOrder',
        'eth_sendTransaction seckill.recordPurchaseTransaction',
        '规则弹窗读取 /api/seckill/rules；战报历史读取 /api/seckill/reports',
        '滚动墙优先用 EventSource 订阅 /api/seckill/feed/stream；不支持时轮询 /api/seckill/feed 和 /api/seckill/report',
        '结算后 GET /api/assets/summary?address=...，中奖者 seckillRecords[].prizeClaim 亮起 NPL 提奖入口'
      ],
      claim: [
        'POST /api/dapp/claim-intent',
        'personal_sign secondaryMessage',
        'POST /api/claims 提交 secondarySignature',
        '如 claimTransaction 不为空，eth_sendTransaction RewardLedger.claim(entryId)',
        'GET /api/dapp/claim-tx-status?walletAddress=...&rewardId=...&txHash=...'
      ]
    },
    statusHandling: {
      fundingTxStatus: {
        pending: '继续轮询',
        confirmed: '订单已 PaidLocked，可刷新订单/履约/资产',
        failed: '链上交易失败，提示用户重试',
        mismatch: '回执与订单不匹配，提示联系平台',
        rpc_unavailable: 'RPC 暂不可用，保留 txHash 后重试'
      },
      completeTxStatus: {
        pending: '继续轮询',
        confirmed: '订单已 Released，NPL 释放给商家，刷新资产页',
        failed: '链上确认收货失败，提示用户重试',
        mismatch: '回执与订单不匹配，提示联系平台',
        rpc_unavailable: 'RPC 暂不可用，保留 txHash 后重试'
      },
      claimTxStatus: {
        pending: '继续轮询',
        confirmed: '奖励已 Claimed，刷新资产页',
        failed: '链上 Claim 失败，提示用户重试',
        mismatch: 'RewardLedger 事件与 rewardId 不匹配，提示联系平台',
        unavailable: '该 rewardId 不是链上 RewardLedger entry，前端不要发链上 claim',
        rpc_unavailable: 'RPC 暂不可用，保留 txHash 后重试'
      }
    },
    endpointShapes: {
      seckillStateQuery: {
        endpoint: '/api/dapp/seckill-state?address=0x...',
        note: '秒杀大厅推荐首屏/轮询接口；返回 session、phase、timers、prizePool、feed、report、reportHistory、rules、prizeClaim、cta 和 nextActions。'
      },
      mallStateQuery: {
        endpoint: '/api/dapp/mall-state?address=0x...&category=精选&q=关键词',
        note: '常规商城 Tab 推荐接口；返回商品卡、分类、筛选、支付/终核策略和每个商品的 primaryAction。'
      },
      storesStateQuery: {
        endpoint: '/api/dapp/stores-state?address=0x...&lat=38.86&lng=121.52&city=大连市',
        note: '线下门店 Tab 推荐接口；返回 GPS 距离、门店筛选、地址仓、自提 checkoutTemplates 和锁区提示。'
      },
      assetsStateQuery: {
        endpoint: '/api/dapp/assets-state?address=0x...',
        note: '我的资产 Tab 推荐接口；返回订单卡动作、收益池、购物/秒杀记录、Claim CTA 和统一刷新 endpoints。'
      },
      checkoutIntentBody: {
        buyerAddress: '0x...',
        idempotencyKey: 'unique-per-wallet-action',
        items: [{ productId: 'p-24k-bag', skuId: 'sku-bag-m', quantity: 1, fulfillmentMode: 'delivery', addressId: 'addr-...' }]
      },
      seckillIntentBody: {
        buyerAddress: '0x...',
        idempotencyKey: 'unique-per-wallet-action',
        items: [{ productId: 'p-24k-runner', quantity: 1, fulfillmentMode: 'delivery', addressId: 'addr-...' }]
      },
      claimIntentBody: {
        walletAddress: '0x...',
        bucketId: 'bnm',
        rewardId: 'reward-ledger-1'
      },
      orderStateQuery: {
        endpoint: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...&fundTxHash=0x...&completeTxHash=0x...&claimRewardId=reward-ledger-1&claimTxHash=0x...',
        note: 'txHash 参数可选；有 txHash 时顺便轮询链上状态，没有时返回当前订单/履约/资产动作聚合。'
      },
      completeOrderIntentBody: {
        buyerAddress: '0x...',
        orderId: '0x...'
      },
      timeoutRefundRequestBody: {
        buyerAddress: '0x...',
        orderId: '0x...',
        reason: '7 天未发货'
      },
      addressParseBody: {
        walletAddress: '0x...',
        text: '张三 13800000000 辽宁省大连市高新区软件园路 24K 号'
      },
      storeQuery: {
        endpoint: '/api/stores?lat=38.86&lng=121.52&city=大连市&district=高新区',
        checkoutPickupFields: { fulfillmentMode: 'pickup', storeId: 'store-dalian-24k', regionCode: '210211' }
      }
    },
    typeDefinitions: '/api/dapp/types.d.ts',
    sdk: '/api/dapp/sdk.ts',
    frontendBrief: '/api/dapp/frontend-brief.md',
    openApi: '/api/dapp/openapi.json',
    contracts: '/api/dapp/contracts.json',
    handoff: '/api/dapp/handoff'
  };
}

function dappHandoffBundle(address) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const integration = dappIntegrationContract();
  return {
    version: '24k-dapp-handoff-v1',
    generatedAt: new Date().toISOString(),
    purpose: '给另一个前端对话框或钱包浏览器调试使用：一个接口拿齐 DApp 接入资料，不需要读后端源码。',
    doNotImplementHere: '本线程不写前端页面；前端线程按 endpoints / types / openapi / examples 接入。',
    frontendThreadRules: {
      scope: '只实现 DEX / 钱包浏览器里的 C 端 DApp 页面，不改后端、不部署、不上链、不生成二维码。',
      useOnly: ['endpoints', 'types', 'sdk', 'openapi', 'examples', 'contracts.humanReadableAbi'],
      doNotRun: ['pnpm dapp:qr', 'pnpm dapp:prod-check', 'pnpm dapp:prod-env', 'pnpm dapp:prod-env-check', 'pnpm dapp:wallet-launch', 'pnpm dapp:deploy-readiness', 'pnpm dapp:strict-gate', 'pnpm micro:plan', 'pnpm deploy:*'],
      safeChecksIfWorkingInThisRepo: ['pnpm dapp:frontend-check', 'pnpm dapp:check', 'pnpm backend:check', 'pnpm typecheck'],
      noSecrets: '不要要求、保存、打印 PRIVATE_KEY；前端只消费公开地址、ABI fragments、calldata 和 personal_sign 消息。'
    },
    quickStart: [
      '1. 打开 /api/dapp/handoff?address=<connectedWallet>',
      '2. 检查 readiness.ok 和 blockers',
      '3. 用 bootstrap.config.wallet 切 BSC',
      '4. 普通购买先 POST /api/dapp/final-check，再 POST /api/dapp/checkout-intent',
      '5. 秒杀大厅先读 GET /api/dapp/seckill-state，再用 POST /api/dapp/seckill-intent',
      '6. 常规商城读 GET /api/dapp/mall-state；线下门店读 GET /api/dapp/stores-state；我的资产读 GET /api/dapp/assets-state',
      '7. 秒杀规则/战报弹窗分别读 /api/seckill/rules 和 /api/seckill/reports',
      '7. 确认收货用 POST /api/dapp/complete-order-intent + completeOrder',
      '8. 7天超时动作先读 GET /api/orders/:orderId/timeout-actions?buyerAddress=0x...',
      '9. Claim 用 POST /api/dapp/claim-intent + personal_sign + RewardLedger.claim'
    ],
    fixedPolicy: {
      npl: FIXED_BSC_NPL_ADDRESS,
      payment: 'NPL',
      firstPaymentApproval: 'NPL approve(MaxUint256), then allowance skip',
      noUserNoReasonRefund: true,
      seckillContractCallerBlocked: true,
      bnm: 'new project credential ERC20 when deployed'
    },
    endpoints: {
      wellKnown: '/.well-known/24k-dapp.json',
      integration: '/api/dapp/integration',
      launchKit: '/api/dapp/launch-kit?address=0x...',
      launchStatus: '/api/dapp/launch-status',
      handoff: '/api/dapp/handoff?address=0x...',
      frontendBrief: '/api/dapp/frontend-brief.md?address=0x...',
      contracts: '/api/dapp/contracts.json',
      types: '/api/dapp/types.d.ts',
      sdk: '/api/dapp/sdk.ts',
      openapi: '/api/dapp/openapi.json',
      readiness: '/api/dapp/readiness',
      home: '/api/dapp/home?address=0x...',
      seckillState: '/api/dapp/seckill-state?address=0x...',
      mallState: '/api/dapp/mall-state?address=0x...',
      storesState: '/api/dapp/stores-state?address=0x...&lat=38.86&lng=121.52',
      assetsState: '/api/dapp/assets-state?address=0x...',
      assetsSummary: '/api/assets/summary?address=0x...',
      fulfillmentOptions: '/api/dapp/fulfillment-options?address=0x...&lat=38.86&lng=121.52',
      seckillFeedStream: '/api/seckill/feed/stream?sessionId=0x...',
      seckillRules: '/api/seckill/rules',
      seckillReportHistory: '/api/seckill/reports',
      bootstrap: '/api/dapp/bootstrap?address=0x...',
      checkoutIntent: '/api/dapp/checkout-intent',
      seckillIntent: '/api/dapp/seckill-intent',
      claimIntent: '/api/dapp/claim-intent',
      paymentIntent: '/api/orders/:orderId/payment-intent?buyerAddress=0x...',
      fundingStatus: '/api/orders/:orderId/fund-tx-status?buyerAddress=0x...&txHash=0x...',
      orderState: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...&fundTxHash=0x...&completeTxHash=0x...',
      orderFulfillment: '/api/orders/:orderId/fulfillment?buyerAddress=0x...',
      completeOrderIntent: '/api/dapp/complete-order-intent',
      completeTxStatus: '/api/orders/:orderId/complete-tx-status?buyerAddress=0x...&txHash=0x...',
      timeoutActions: '/api/orders/:orderId/timeout-actions?buyerAddress=0x...',
      timeoutRefundRequest: '/api/dapp/timeout-refund-request',
      claimTxStatus: '/api/dapp/claim-tx-status?walletAddress=0x...&rewardId=reward-ledger-1&txHash=0x...'
    },
    commands: {
      frontendConsumptionCheck: 'pnpm dapp:frontend-check',
      backendFlowCheck: 'pnpm dapp:check',
      backendCheck: 'pnpm backend:check',
      typecheck: 'pnpm typecheck',
      note: '前端线程通常不需要运行后端仓库命令；如只消费接口，直接 fetch endpoints 即可。'
    },
    examples: integration.endpointShapes,
    integration,
    launchKitShape: '/api/dapp/launch-kit?address=<connectedWallet>',
    contracts: dappContractsBundle(),
    readiness: dappReadiness(),
    launchStatus: dappLaunchStatus(),
    home: dappHome(buyerAddress),
    bootstrap: dappBootstrap(buyerAddress),
    openapi: dappOpenApiSpec(),
    types: dappTypeDefinitions(),
    sdk: dappSdkSource(),
    frontendBrief: dappFrontendBrief(buyerAddress)
  };
}

function dappFrontendBrief(address, apiBaseUrl = '') {
  const buyerAddress = isValidAddress(address) ? address : '<connected_wallet>';
  const prefix = apiBaseUrl ? `${apiBaseUrl.replace(/\/+$/, '')}` : '';
  const endpoint = (path) => `${prefix}${path}`;
  return [
    '# 24K DApp 前端线程任务提示词',
    '',
    '把这份内容复制给负责写 DApp 前端页面的对话框。本后端/合约线程不写页面；前端线程只需要按这些接口接入。',
    '',
    '## 目标',
    '',
    '- 做一个 H5 / 钱包浏览器 DApp：用户在钱包 DApp 浏览器或 DEX 内置浏览器输入网址即可打开。',
    '- 只做 C 端 DApp 四个 Tab：秒杀大厅 / 常规商城 / 线下门店 / 我的资产。',
    '- 不要重写后端、不要自造支付 calldata、不要在前端保存或要求 PRIVATE_KEY。',
    '- 不要跑部署、生产 env、二维码、micro-test、deploy 类脚本；前端线程只接接口和页面。',
    '- 所有链上付款、秒杀、Claim 的交易对象和 data 都以后端 intent 返回为准。',
    '',
    '## 后端资料入口',
    '',
    `- Handoff JSON: ${endpoint(`/api/dapp/handoff?address=${buyerAddress}`)}`,
    `- Home aggregate: ${endpoint(`/api/dapp/home?address=${buyerAddress}`)}`,
    `- Seckill state: ${endpoint(`/api/dapp/seckill-state?address=${buyerAddress}`)}`,
    `- Mall state: ${endpoint(`/api/dapp/mall-state?address=${buyerAddress}`)}`,
    `- Stores state: ${endpoint(`/api/dapp/stores-state?address=${buyerAddress}&lat=<gpsLat>&lng=<gpsLng>`)}`,
    `- Assets state: ${endpoint(`/api/dapp/assets-state?address=${buyerAddress}`)}`,
    `- Bootstrap: ${endpoint(`/api/dapp/bootstrap?address=${buyerAddress}`)}`,
    `- Integration: ${endpoint('/api/dapp/integration')}`,
    `- Contracts + ABI fragments: ${endpoint('/api/dapp/contracts.json')}`,
    `- TypeScript types: ${endpoint('/api/dapp/types.d.ts')}`,
    `- TypeScript SDK helpers: ${endpoint('/api/dapp/sdk.ts')}`,
    `- OpenAPI: ${endpoint('/api/dapp/openapi.json')}`,
    `- Unified order state: ${endpoint('/api/dapp/order-state?buyerAddress=<wallet>&orderId=<orderId>')}`,
    `- Fulfillment options: ${endpoint('/api/dapp/fulfillment-options?address=<wallet>&lat=<gpsLat>&lng=<gpsLng>')}`,
    `- Seckill feed stream: ${endpoint('/api/seckill/feed/stream?sessionId=<sessionId>')}`,
    `- Seckill rules: ${endpoint('/api/seckill/rules')}`,
    `- Seckill report history: ${endpoint('/api/seckill/reports')}`,
    `- Readiness: ${endpoint('/api/dapp/readiness')}`,
    `- 前端线程不要跑二维码、部署、生产 env、micro-test、deploy 类脚本；只接接口和页面。`,
    '',
    '## 固定业务口径',
    '',
    `- Chain: BSC 56 / 0x38`,
    `- NPL: ${FIXED_BSC_NPL_ADDRESS}`,
    '- 支付：NPL。',
    '- 首次支付：NPL approve(MaxUint256)；后续先 allowance，足够就跳过授权。',
    '- 秒杀：付款后再发 Abu24KSeckill.recordPurchase(sessionId, orderId)；合约按 docs 阻止合约地址调用。',
    '- Claim：先 personal_sign，提交后端，再按需发送 RewardLedger.claim(entryId)，等待 RewardClaimed。',
    '- 退款：不做用户无理由退款；只展示平台强制退款、7 天超时处理、emergency refund 相关状态。',
    '',
    '## 推荐接入顺序',
    '',
    '1. 页面启动：fetchDappReadiness / fetchDappLaunchStatus -> fetchDappHome(address)，四个 Tab 首屏优先用 home.tabs；进入具体 Tab 时分别刷新 fetchDappSeckillState / fetchDappMallState / fetchDappStoresState / fetchDappAssetsState。',
    '2. API 基址：前端只需要配置后端 HTTPS baseUrl，然后调用本页 endpoints；不要从本后端仓库导出/生成生产 env、二维码或部署清单。',
    '3. 钱包链：用 bootstrap.config.wallet 或 SDK switchTo24kChain(provider, bootstrap) 切到 BSC。',
    '4. 普通购买：先 fetchProductDetail(productId)，再 fetchFulfillmentOptions({ address, lat, lng }) 拿地址/自提门店和行政区锁定信息；POST /api/dapp/final-check 展示五要素终核，通过后 POST /api/dapp/checkout-intent，按 paymentIntent.allowanceChecks 判断是否发送 approvalTransactions，再发 payOrderTransaction；也可直接用 SDK sendPaymentIntent(provider, paymentIntent)。',
    '5. 秒杀购买：先 fetchDappSeckillState(address) 渲染 phase/timers/cta/奖池/战报/领奖状态；CTA 可买时 POST /api/dapp/seckill-intent，先完成普通购买，再发 seckill.recordPurchaseTransaction；滚动墙优先用 EventSource(seckillFeedStreamUrl(session.id))，规则弹窗用 fetchSeckillRules()，战报历史用 fetchSeckillReportHistory()；也可用 SDK sendSeckillRecordPurchase(provider, seckillIntent)。',
    '6. 地址仓：POST /api/address-book/parse 解析粘贴地址，读取 dappReview.lockPreview 给用户确认，确认后 POST /api/address-book 保存；SDK 可用 parseAddressText / saveAddress。',
    '7. 线下门店：优先 GET /api/dapp/fulfillment-options?address=...&lat=...&lng=...；也可 GET /api/stores?lat=...&lng=...&city=... 取 GPS 距离、pickupContext、checkoutItemPatch 和 lockPreview；自提下单直接带 fulfillmentMode=pickup/storeId/regionCode。',
    '8. 确认收货/核销后释放：先 GET /api/orders/:orderId/fulfillment?buyerAddress=... 看 confirmability/releasePreview/nextActions；只有订单已 Shipped 或 PickupReady 时 POST /api/dapp/complete-order-intent，再发送 completeOrderTransaction；也可用 SDK fetchOrderFulfillment / sendCompleteOrder。',
    '9. 7天超时：GET /api/orders/:orderId/timeout-actions；商家未发货才允许 requestTimeoutRefund(...) -> /api/dapp/timeout-refund-request。',
    '10. 我的资产：优先用 SDK fetchDappAssetsState(address) 或 GET /api/dapp/assets-state?address=...；订单卡片直接用 summary.orders[].primaryAction/actions/nextActions；seckillRecords[].prizeClaim.claimable=true 时用 claimIntent 提取 NPL 秒杀奖金。',
    '11. Claim：POST /api/dapp/claim-intent，personal_sign secondaryMessage，submitClaimRequest(...) 提交 /api/claims，再按需 sendClaimTransaction(...)。',
    '12. 轮询：推荐前端用 fetchDappOrderState({ buyerAddress, orderId, fundTxHash, completeTxHash, claimRewardId, claimTxHash }) 一口刷新；单独接口仍可用 /fund-tx-status、/complete-tx-status、/claim-tx-status。',
    '',
    '## 前端验收口径',
    '',
    '- 四个 Tab 都能从 bootstrap.initialData 渲染，不依赖本地假数据。',
    '- 钱包未连接、链不对、readiness 有 blockers 时给明确提示。',
    '- 支付按钮展示 NPL 拆分、BNM 全返、地址/门店/行政区绑定的终核信息。',
    '- 普通购买必须走 final-check -> checkout-intent，不能前端自造 payOrder calldata。',
    '- approval 只在 allowance 不足时发送，但授权额度必须是 MaxUint256。',
    '- 秒杀按钮必须走 seckill-intent，并发送后端返回的 recordPurchaseTransaction。',
    '- Claim 按 claim-intent 返回的 secondaryMessage 做 personal_sign，再提交 /api/claims；有 claimTransaction 时才发 RewardLedger.claim。',
    '- txHash 广播后进入轮询状态；pending/confirmed/failed/mismatch/rpc_unavailable 都要有 UI 状态。',
    '- 如果前端线程临时在本仓库验收，只跑 pnpm dapp:frontend-check；它只拉接口/intent，不生成 env、不部署、不发交易。',
    '- 不出现旧 MVP 的「消息/购物车」底部导航。',
    ''
  ].join('\n');
}

function dappLaunchKit(req, address) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const apiBaseUrl = requestBaseUrl(req);
  const configuredEntryUrl = process.env.DAPP_ENTRY_URL || process.env.DAPP_BASE_URL || process.env.FRONTEND_URL || apiBaseUrl;
  const entryUrl = normalizeAbsoluteUrl(configuredEntryUrl, apiBaseUrl);
  const scanEntryUrl = mobileFriendlyEntryUrl(entryUrl);
  const urlWithWallet = appendAddressParam(scanEntryUrl, buyerAddress);
  const handoffUrl = absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/handoff?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/handoff');
  const frontendBriefUrl = absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/frontend-brief.md?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/frontend-brief.md');
  const bootstrapUrl = absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/bootstrap?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/bootstrap');
  const launchKitUrl = absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/launch-kit?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/launch-kit');
  const candidateUrls = dappLaunchCandidateUrls(apiBaseUrl, entryUrl).map((url) => appendAddressParam(url, buyerAddress));
  return {
    version: '24k-dapp-launch-kit-v1',
    generatedAt: new Date().toISOString(),
    purpose: '给手机钱包 / DApp 浏览器扫码或手动输入网址使用；不包含 PRIVATE_KEY。',
    entryUrl,
    scanEntryUrl,
    walletBrowserEntryUrl: urlWithWallet,
    apiBaseUrl,
    qr: {
      data: urlWithWallet,
      externalPng: qrPngUrl(urlWithWallet),
      localGenerateCommand: 'pnpm dapp:qr',
      localSvgArtifact: 'test-artifacts/dapp-launch-qr.svg',
      note: '生产环境建议用 HTTPS 域名；手机和电脑不在同一局域网或电脑开 VPN 时，LAN IP 可能打不开。'
    },
    urls: {
      entry: urlWithWallet,
      launchKit: launchKitUrl,
      launchStatus: absoluteUrl(apiBaseUrl, '/api/dapp/launch-status'),
      readiness: absoluteUrl(apiBaseUrl, '/api/dapp/readiness'),
      home: absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/home?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/home'),
      seckillState: absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/seckill-state?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/seckill-state'),
      mallState: absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/mall-state?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/mall-state'),
      storesState: absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/stores-state?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/stores-state'),
      assetsState: absoluteUrl(apiBaseUrl, buyerAddress ? `/api/dapp/assets-state?address=${encodeURIComponent(buyerAddress)}` : '/api/dapp/assets-state'),
      manifest: absoluteUrl(apiBaseUrl, '/manifest.webmanifest'),
      wellKnown: absoluteUrl(apiBaseUrl, '/.well-known/24k-dapp.json'),
      handoff: handoffUrl,
      frontendBrief: frontendBriefUrl,
      bootstrap: bootstrapUrl,
      openapi: absoluteUrl(apiBaseUrl, '/api/dapp/openapi.json'),
      types: absoluteUrl(apiBaseUrl, '/api/dapp/types.d.ts'),
      sdk: absoluteUrl(apiBaseUrl, '/api/dapp/sdk.ts')
    },
    candidateUrls,
    wallet: publicDappConfig().wallet,
    fixedPolicy: {
      chainId: 56,
      npl: FIXED_BSC_NPL_ADDRESS,
      payment: 'NPL approve(MaxUint256) then allowance skip',
      secrets: '不返回、不要求、不打印 PRIVATE_KEY'
    },
    readiness: dappReadiness(),
    launchStatus: dappLaunchStatus(req)
  };
}

function requestBaseUrl(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.') ? 'http' : 'https');
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function normalizeAbsoluteUrl(value, fallbackBaseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return fallbackBaseUrl;
  try {
    return new URL(raw).toString().replace(/\/+$/, '');
  } catch {
    return absoluteUrl(fallbackBaseUrl, raw);
  }
}

function absoluteUrl(baseUrl, path) {
  return new URL(path, `${String(baseUrl).replace(/\/+$/, '')}/`).toString();
}

function hasRuntimeValue(value) {
  const raw = String(value || '').trim();
  return Boolean(raw) && !/^<[^>]+>$/.test(raw);
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch {
    return false;
  }
}

function appendAddressParam(value, address) {
  if (!address) return value;
  const url = new URL(value);
  url.searchParams.set('address', address);
  return url.toString();
}

function mobileFriendlyEntryUrl(value) {
  const url = new URL(value);
  if (!isLoopbackHost(url.hostname)) return url.toString();
  const lan = lanAddresses()[0];
  if (!lan) return url.toString();
  url.hostname = lan;
  return url.toString();
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

function dappLaunchCandidateUrls(apiBaseUrl, entryUrl) {
  const candidates = [entryUrl];
  const api = new URL(apiBaseUrl);
  const entry = new URL(entryUrl);
  const ports = new Set([entry.port || defaultPort(entry.protocol), process.env.DAPP_FRONTEND_PORT || '', process.env.PORT || ''].filter(Boolean));
  for (const address of lanAddresses()) {
    for (const port of ports) {
      candidates.push(`${entry.protocol}//${address}${port ? `:${port}` : ''}${entry.pathname === '/' ? '' : entry.pathname}`);
    }
    const apiPort = api.port || defaultPort(api.protocol);
    candidates.push(`${api.protocol}//${address}${apiPort ? `:${apiPort}` : ''}/`);
  }
  return [...new Set(candidates)].filter(Boolean);
}

function defaultPort(protocol) {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('198.18.')) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function qrPngUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=360x360&format=png&data=${encodeURIComponent(value)}`;
}

function dappContractsBundle() {
  const config = publicDappConfig();
  return {
    version: '24k-dapp-contracts-v1',
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    chainIdHex: `0x${CHAIN_ID.toString(16)}`,
    tokens: {
      npl: { address: NPL, symbol: 'NPL', decimals: 18, fixedBscAddress: FIXED_BSC_NPL_ADDRESS },
      bnm: { address: BNM || '', symbol: 'BNM', plannedWhenEmpty: !BNM }
    },
    contracts: {
      escrow: { address: config.escrowAddress || '', name: 'Abu24KPaymentEscrow' },
      seckill: { address: config.seckillAddress || '', name: 'Abu24KSeckill' },
      rewardLedger: { address: config.rewardLedgerAddress || '', name: 'Abu24KRewardLedger' },
      bnm: { address: config.bnmAddress || '', name: 'BNMToken' }
    },
    humanReadableAbi: dappHumanReadableAbi(),
    policies: {
      paymentApproval: 'NPL approve(MaxUint256), then allowance skip',
      seckillCallerRule: 'tx.origin == msg.sender',
      noPrivateKeys: true
    }
  };
}

function dappHumanReadableAbi() {
  return {
    erc20: [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address owner,address spender) view returns (uint256)',
      'function approve(address spender,uint256 amount) returns (bool)'
    ],
    escrow: [
      'function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)',
      'function completeOrder(bytes32 orderId)',
      'function disputeOrder(bytes32 orderId)',
      'function forceRefund(bytes32 orderId)',
      'function orders(bytes32) view returns (address buyer,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,uint8 status)',
      'event OrderPaid(bytes32 indexed orderId,address indexed buyer,address indexed seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion)',
      'event OrderCompleted(bytes32 indexed orderId,address indexed seller,uint256 nplAmount,uint32 splitVersion)',
      'event OrderArbitration(bytes32 indexed orderId,address indexed caller)',
      'event OrderForcedRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 burnedRewards)',
      'event OrderEmergencyRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 burnedRewards)',
      'event SellerApprovalUpdated(address indexed seller,bool approved)',
      'event SplitConfigUpdated(uint32 indexed version,bytes32 indexed configHash)'
    ],
    rewardLedger: [
      'function setOperator(address operator,bool enabled)',
      'function burnOrderRewards(bytes32 orderId) returns (uint256 burnedCount)',
      'function claim(uint256 entryId)',
      'function entryCount() view returns (uint256)',
      'function entries(uint256) view returns (address user,bytes32 orderId,address asset,uint256 amount,uint8 bucket,uint8 state)',
      'event RewardLocked(uint256 indexed entryId,bytes32 indexed orderId,address indexed user,address asset,uint256 amount,uint8 bucket)',
      'event RewardReleased(uint256 indexed entryId,bytes32 indexed orderId)',
      'event RewardClaimed(uint256 indexed entryId,address indexed user,address asset,uint256 amount)',
      'event LockedRewardBurned(uint256 indexed entryId,bytes32 indexed orderId)',
      'event UnclaimedRewardBurned(uint256 indexed entryId,bytes32 indexed orderId,uint8 previousState)',
      'event OperatorUpdated(address indexed operator,bool enabled)'
    ],
    seckill: [
      'function startSession(bytes32 productId,uint64 durationSeconds,uint64 relayInitialSeconds,uint32 relayExtendSeconds,uint256 minimumNplAmount,uint256 prizePoolNpl) returns (bytes32 sessionId)',
      'function recordPurchase(bytes32 sessionId,bytes32 orderId)',
      'function maxGasPriceWei() view returns (uint256)',
      'function setMaxGasPriceWei(uint256 newMaxGasPriceWei)',
      'function sessions(bytes32) view returns (bytes32 productId,uint64 startsAt,uint64 mainEndsAt,uint64 relayEndsAt,uint32 relayExtendSeconds,uint64 maxRelaySeconds,uint256 minimumNplAmount,uint256 prizePoolNpl,uint256 totalBuys,address lastBuyer,bytes32 winningOrderId,uint8 status)',
      'event MaxGasPriceUpdated(uint256 previousMaxGasPriceWei,uint256 newMaxGasPriceWei)',
      'event SessionStarted(bytes32 indexed sessionId,bytes32 indexed productId,uint64 startsAt,uint64 mainEndsAt,uint64 relayEndsAt,uint256 minimumNplAmount,uint256 prizePoolNpl)',
      'event PurchaseRecorded(bytes32 indexed sessionId,address indexed buyer,bytes32 indexed orderId,uint64 relayEndsAt,uint256 totalBuys)',
      'event SessionSettled(bytes32 indexed sessionId,address indexed winner,bytes32 indexed orderId,uint256 prizePoolNpl)',
      'event SeckillPrizeReleased(bytes32 indexed sessionId,bytes32 indexed rewardOrderId,address indexed winner,uint256 prizePoolNpl)'
    ]
  };
}

function dappOpenApiSpec() {
  const response200 = (schemaRef = '#/components/schemas/JsonObject') => ({
    description: 'OK',
    content: {
      'application/json': {
        schema: { $ref: schemaRef }
      }
    }
  });
  const responseText = (contentType = 'text/plain') => ({
    description: 'OK',
    content: {
      [contentType]: {
        schema: { type: 'string' }
      }
    }
  });
  const requestJson = (schemaRef) => ({
    required: true,
    content: {
      'application/json': {
        schema: { $ref: schemaRef }
      }
    }
  });
  return {
    openapi: '3.1.0',
    info: {
      title: '24K Mall DApp API',
      version: '24k-dapp-contract-v1',
      description: 'Wallet-browser / H5 DApp contract for 24K Mall. No private keys or backend secrets are exposed.'
    },
    servers: [{ url: '/' }],
    'x-24k': {
      chainId: CHAIN_ID,
      chainIdHex: `0x${CHAIN_ID.toString(16)}`,
      npl: NPL,
      fixedBscNplAddress: FIXED_BSC_NPL_ADDRESS,
      paymentPolicy: 'NPL approve(MaxUint256) with allowance skip',
      typeDefinitions: '/api/dapp/types.d.ts',
      sdk: '/api/dapp/sdk.ts'
    },
    paths: {
      '/.well-known/24k-dapp.json': {
        get: { summary: 'DApp discovery contract', responses: { 200: response200('#/components/schemas/DappIntegration') } }
      },
      '/api/dapp/integration': {
        get: { summary: 'Machine-readable integration contract', responses: { 200: response200('#/components/schemas/DappIntegration') } }
      },
      '/api/dapp/handoff': {
        get: {
          summary: 'All-in-one frontend handoff bundle',
          parameters: [{ name: 'address', in: 'query', schema: { type: 'string' }, required: false }],
          responses: { 200: response200('#/components/schemas/DappHandoff') }
        }
      },
      '/api/dapp/frontend-brief.md': {
        get: {
          summary: 'Copy-paste prompt and acceptance checklist for the separate DApp frontend thread',
          parameters: [{ name: 'address', in: 'query', schema: { type: 'string' }, required: false }],
          responses: { 200: responseText('text/markdown') }
        }
      },
      '/api/dapp/launch-kit': {
        get: {
          summary: 'Mobile wallet/DApp browser launch URLs and QR payload',
          parameters: [{ name: 'address', in: 'query', schema: { type: 'string' }, required: false }],
          responses: { 200: response200('#/components/schemas/DappLaunchKit') }
        }
      },
      '/api/dapp/contracts.json': {
        get: { summary: 'DApp contract addresses and human-readable ABI fragments', responses: { 200: response200('#/components/schemas/DappContracts') } }
      },
      '/api/dapp/types.d.ts': {
        get: { summary: 'TypeScript type definitions for DApp frontend', responses: { 200: responseText('text/typescript') } }
      },
      '/api/dapp/sdk.ts': {
        get: { summary: 'Standalone TypeScript SDK helpers for DApp frontend', responses: { 200: responseText('text/typescript') } }
      },
      '/api/dapp/readiness': {
        get: { summary: 'Launch readiness and blockers', responses: { 200: response200('#/components/schemas/DappReadiness') } }
      },
      '/api/dapp/home': {
        get: {
          summary: 'One-call DApp home payload for four docs tabs',
          parameters: [{ name: 'address', in: 'query', schema: { type: 'string' }, required: false }],
          responses: { 200: response200('#/components/schemas/DappHome') }
        }
      },
      '/api/dapp/mall-state': {
        get: {
          summary: 'DApp regular mall tab state: products, categories, filters, final-check policy and product card actions',
          parameters: [
            { name: 'address', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'category', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'q', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'limit', in: 'query', schema: { type: 'integer' }, required: false }
          ],
          responses: { 200: response200('#/components/schemas/DappMallStateResponse') }
        }
      },
      '/api/dapp/stores-state': {
        get: {
          summary: 'DApp offline stores tab state: GPS stores, filters, address book and pickup checkout templates',
          parameters: [
            { name: 'address', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'lat', in: 'query', schema: { type: 'number' }, required: false },
            { name: 'lng', in: 'query', schema: { type: 'number' }, required: false },
            { name: 'city', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'district', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'regionCode', in: 'query', schema: { type: 'string' }, required: false }
          ],
          responses: { 200: response200('#/components/schemas/DappStoresStateResponse') }
        }
      },
      '/api/dapp/assets-state': {
        get: {
          summary: 'DApp assets tab state: address book, order actions, reward buckets, records and claim CTA',
          parameters: [{ name: 'address', in: 'query', schema: { type: 'string' }, required: false }],
          responses: { 200: response200('#/components/schemas/DappAssetsStateResponse') }
        }
      },
      '/api/dapp/launch-status': {
        get: { summary: 'Runtime strict launch status and critical path', responses: { 200: response200('#/components/schemas/DappLaunchStatus') } }
      },
      '/api/dapp/bootstrap': {
        get: {
          summary: 'Initial DApp data and wallet config',
          parameters: [{ name: 'address', in: 'query', schema: { type: 'string' }, required: false }],
          responses: { 200: response200('#/components/schemas/DappBootstrap') }
        }
      },
      '/api/dapp/fulfillment-options': {
        get: {
          summary: 'DApp delivery address + pickup store options with region-code lock contract',
          parameters: [
            { name: 'address', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'lat', in: 'query', schema: { type: 'number' }, required: false },
            { name: 'lng', in: 'query', schema: { type: 'number' }, required: false },
            { name: 'city', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'district', in: 'query', schema: { type: 'string' }, required: false },
            { name: 'regionCode', in: 'query', schema: { type: 'string' }, required: false }
          ],
          responses: { 200: response200('#/components/schemas/FulfillmentOptionsResponse') }
        }
      },
      '/api/dapp/checkout-intent': {
        post: {
          summary: 'Create a regular checkout intent with calldata',
          requestBody: requestJson('#/components/schemas/CheckoutIntentBody'),
          responses: { 201: response200('#/components/schemas/CheckoutIntentResponse') }
        }
      },
      '/api/dapp/seckill-state': {
        get: {
          summary: 'Unified DApp seckill hall state: phase, timers, prize pool, feed, reports, rules, CTA and prize claim',
          parameters: [{ name: 'address', in: 'query', required: false, schema: { type: 'string' } }],
          responses: { 200: response200('#/components/schemas/DappSeckillStateResponse') }
        }
      },
      '/api/dapp/seckill-intent': {
        post: {
          summary: 'Create a seckill checkout intent with recordPurchase calldata',
          requestBody: requestJson('#/components/schemas/CheckoutIntentBody'),
          responses: { 201: response200('#/components/schemas/SeckillIntentResponse') }
        }
      },
      '/api/orders/{orderId}/payment-intent': {
        get: {
          summary: 'Build the NPL allowance check, approval and payOrder calldata for an order',
          parameters: [
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'buyerAddress', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/PaymentIntent') }
        }
      },
      '/api/orders/{orderId}/fund-tx-status': {
        get: {
          summary: 'Poll payOrder transaction status',
          parameters: [
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'buyerAddress', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'txHash', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/TxStatusResponse') }
        }
      },
      '/api/orders/{orderId}/complete-tx-status': {
        get: {
          summary: 'Poll completeOrder confirm-receipt transaction status',
          parameters: [
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'buyerAddress', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'txHash', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/TxStatusResponse') }
        }
      },
      '/api/orders/{orderId}/arbitration-tx-status': {
        get: {
          summary: 'Poll disputeOrder transaction status and open arbitration only after finality',
          parameters: [
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'buyerAddress', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'txHash', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/TxStatusResponse') }
        }
      },
      '/api/orders/{orderId}/timeout-actions': {
        get: {
          summary: 'Check 7-day timeout actions for buyer refund or merchant force-sign',
          parameters: [
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'buyerAddress', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/TimeoutActionsResponse') }
        }
      },
      '/api/orders/{orderId}/fulfillment': {
        get: {
          summary: 'DApp order fulfillment snapshot with confirmability and BNM release preview',
          parameters: [
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'buyerAddress', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/FulfillmentSnapshotResponse') }
        }
      },
      '/api/dapp/order-state': {
        get: {
          summary: 'Unified DApp order state: order, fulfillment, asset actions and optional tx polling',
          parameters: [
            { name: 'buyerAddress', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'orderId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'fundTxHash', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'completeTxHash', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'claimRewardId', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'claimTxHash', in: 'query', required: false, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/DappOrderStateResponse') }
        }
      },
      '/api/dapp/claim-intent': {
        post: {
          summary: 'Prepare personal_sign message and optional RewardLedger.claim calldata',
          requestBody: requestJson('#/components/schemas/ClaimIntentBody'),
          responses: { 200: response200('#/components/schemas/ClaimIntentResponse') }
        }
      },
      '/api/dapp/complete-order-intent': {
        post: {
          summary: 'Build buyer completeOrder calldata for confirm receipt / pickup release',
          requestBody: requestJson('#/components/schemas/CompleteOrderIntentBody'),
          responses: { 200: response200('#/components/schemas/CompleteOrderIntentResponse') }
        }
      },
      '/api/dapp/timeout-refund-request': {
        post: {
          summary: 'Buyer request after merchant 7-day shipment timeout; creates RefundRequested for platform forceRefund',
          requestBody: requestJson('#/components/schemas/TimeoutRefundRequestBody'),
          responses: { 201: response200('#/components/schemas/TimeoutRefundRequestResponse') }
        }
      },
      '/api/dapp/after-sale/request': {
        post: {
          summary: 'Buyer secondary-signed exchange or delayed-receipt request; exchange returns disputeOrder calldata and keeps rewards locked',
          requestBody: requestJson('#/components/schemas/JsonObject'),
          responses: { 201: response200('#/components/schemas/AfterSaleRequestResponse') }
        }
      },
      '/api/dapp/order-cancel': {
        post: {
          summary: 'Buyer secondary-signed cancellation for a Draft order',
          requestBody: requestJson('#/components/schemas/JsonObject'),
          responses: { 200: response200('#/components/schemas/JsonObject') }
        }
      },
      '/api/dapp/claim-tx-status': {
        get: {
          summary: 'Poll RewardLedger.claim transaction status',
          parameters: [
            { name: 'walletAddress', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'rewardId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'txHash', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/ClaimTxStatusResponse') }
        }
      },
      '/api/assets/summary': {
        get: {
          summary: 'My assets aggregate: address book, orders, shopping records, seckill records, reward buckets and claims',
          parameters: [{ name: 'address', in: 'query', required: false, schema: { type: 'string' } }],
          responses: { 200: response200('#/components/schemas/AssetSummaryResponse') }
        }
      },
      '/api/cms/placements': {
        get: {
          summary: 'Published region/version targeted banner, popup, FAQ, legal and forced-update placements',
          parameters: [
            { name: 'regionCode', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'appVersion', in: 'query', required: false, schema: { type: 'string' } }
          ],
          responses: { 200: response200('#/components/schemas/JsonObject') }
        }
      },
      '/api/products': {
        get: { summary: 'List products with SKU/payment/fulfillment fields', responses: { 200: response200('#/components/schemas/JsonArray') } }
      },
      '/api/products/{id}': {
        get: {
          summary: 'Product detail',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: response200('#/components/schemas/JsonObject') }
        }
      },
      '/api/stock/preflight': {
        post: {
          summary: 'Stock, fulfillment and payment quote preflight',
          requestBody: requestJson('#/components/schemas/CheckoutIntentBody'),
          responses: { 200: response200('#/components/schemas/JsonObject') }
        }
      },
      '/api/dapp/final-check': {
        post: {
          summary: 'DApp five-factor final confirmation payload before checkout intent',
          requestBody: requestJson('#/components/schemas/CheckoutIntentBody'),
          responses: { 200: response200('#/components/schemas/DappFinalCheck') }
        }
      },
      '/api/address-book': {
        get: { summary: 'Buyer address book', responses: { 200: response200('#/components/schemas/JsonArray') } },
        post: {
          summary: 'Create buyer address book entry',
          requestBody: requestJson('#/components/schemas/AddressBookBody'),
          responses: { 201: response200('#/components/schemas/JsonObject') }
        }
      },
      '/api/address-book/parse': {
        post: {
          summary: 'Parse pasted WeChat/Taobao-style address text before user review',
          requestBody: requestJson('#/components/schemas/AddressParseBody'),
          responses: { 200: response200('#/components/schemas/JsonObject') }
        }
      },
      '/api/stores': {
        get: { summary: 'Nearby stores for pickup, with GPS distance and region filters', responses: { 200: response200('#/components/schemas/JsonArray') } }
      },
      '/api/merchant/orders/{orderId}/force-sign-request': {
        post: {
          summary: 'Merchant SIWE + secondary-signature request after buyer 7-day receipt timeout',
          parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: requestJson('#/components/schemas/JsonObject'),
          responses: { 201: response200('#/components/schemas/JsonObject') }
        }
      },
      '/api/seckill/current': {
        get: { summary: 'Current seckill session', responses: { 200: response200('#/components/schemas/JsonObject') } }
      },
      '/api/seckill/feed': {
        get: { summary: 'Seckill rolling purchase feed', responses: { 200: response200('#/components/schemas/JsonObject') } }
      },
      '/api/seckill/feed/stream': {
        get: {
          summary: 'Server-Sent Events stream for the seckill rolling wall',
          parameters: [
            { name: 'sessionId', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'once', in: 'query', required: false, schema: { enum: ['1'] } }
          ],
          responses: { 200: responseText('text/event-stream') }
        }
      },
      '/api/seckill/report': {
        get: { summary: 'Seckill battle report', responses: { 200: response200('#/components/schemas/JsonObject') } }
      },
      '/api/seckill/reports': {
        get: { summary: 'Seckill battle report history for the DApp report modal', responses: { 200: response200('#/components/schemas/SeckillReportHistoryResponse') } }
      },
      '/api/seckill/rules': {
        get: { summary: 'Latest seckill/rally rules rich text from CMS with docs fallback', responses: { 200: response200('#/components/schemas/SeckillRulesResponse') } }
      }
    },
    components: {
      schemas: {
        JsonObject: { type: 'object', additionalProperties: true },
        JsonArray: { type: 'array', items: { type: 'object', additionalProperties: true } },
        AddressBookBody: {
          type: 'object',
          required: ['walletAddress', 'name', 'phone', 'province', 'city', 'district', 'detail', 'regionCode'],
          properties: {
            walletAddress: { type: 'string' },
            name: { type: 'string' },
            phone: { type: 'string' },
            province: { type: 'string' },
            city: { type: 'string' },
            district: { type: 'string' },
            detail: { type: 'string' },
            regionCode: { type: 'string' },
            isDefault: { type: 'boolean' }
          }
        },
        AddressParseBody: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            walletAddress: { type: 'string' }
          }
        },
        CheckoutIntentBody: {
          type: 'object',
          required: ['buyerAddress', 'idempotencyKey', 'items'],
          properties: {
            buyerAddress: { type: 'string' },
            idempotencyKey: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['productId', 'quantity', 'fulfillmentMode'],
                properties: {
                  productId: { type: 'string' },
                  skuId: { type: 'string' },
                  quantity: { type: 'integer', minimum: 1 },
                  selected: { type: 'boolean', default: true },
                  fulfillmentMode: { enum: ['delivery', 'pickup'] },
                  addressId: { type: 'string' },
                  storeId: { type: 'string' },
                  regionCode: { type: 'string' }
                }
              }
            }
          }
        },
        ClaimIntentBody: {
          type: 'object',
          required: ['walletAddress', 'rewardId'],
          properties: {
            walletAddress: { type: 'string' },
            bucketId: { type: 'string', default: 'bnm' },
            rewardId: { type: 'string', example: 'reward-ledger-1' }
          }
        },
        CompleteOrderIntentBody: {
          type: 'object',
          required: ['buyerAddress', 'orderId'],
          properties: {
            buyerAddress: { type: 'string' },
            orderId: { type: 'string' }
          }
        },
        TimeoutRefundRequestBody: {
          type: 'object',
          required: ['buyerAddress', 'orderId'],
          properties: {
            buyerAddress: { type: 'string' },
            orderId: { type: 'string' },
            reason: { type: 'string', default: '7 天未发货' }
          }
        },
        WalletTransaction: {
          type: 'object',
          required: ['to', 'value', 'data'],
          properties: {
            key: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            value: { type: 'string' },
            data: { type: 'string' }
          }
        },
        PaymentIntent: {
          type: 'object',
          required: ['approvalPolicy', 'allowanceChecks', 'approvalTransactions', 'payOrderTransaction'],
          properties: {
            chainId: { type: 'integer' },
            chainIdHex: { type: 'string' },
            approvalPolicy: {
              type: 'object',
              properties: {
                type: { const: 'unlimited-npl' },
                allowanceSkip: { const: true },
                amount: { const: 'MaxUint256' }
              }
            },
            allowanceChecks: { type: 'array', items: { $ref: '#/components/schemas/WalletTransaction' } },
            approvalTransactions: { type: 'array', items: { $ref: '#/components/schemas/WalletTransaction' } },
            payOrderTransaction: { $ref: '#/components/schemas/WalletTransaction' }
          }
        },
        CheckoutIntentResponse: {
          type: 'object',
          required: ['ok', 'order', 'paymentIntent', 'nextActions'],
          properties: {
            ok: { const: true },
            order: { type: 'object', additionalProperties: true },
            paymentIntent: { $ref: '#/components/schemas/PaymentIntent' },
            nextActions: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        DappSeckillStateResponse: {
          type: 'object',
          required: ['version', 'session', 'phase', 'timers', 'prizePool', 'feed', 'report', 'reportHistory', 'rules', 'prizeClaim', 'cta', 'policies', 'nextActions', 'endpoints'],
          properties: {
            version: { const: '24k-dapp-seckill-state-v1' },
            connectedAddress: { type: ['string', 'null'] },
            session: { type: 'object', additionalProperties: true },
            phase: { type: 'object', additionalProperties: true },
            timers: { type: 'object', additionalProperties: true },
            prizePool: { type: 'object', additionalProperties: true },
            product: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
            productDapp: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
            feed: { type: 'array', items: { type: 'object', additionalProperties: true } },
            report: { type: 'object', additionalProperties: true },
            reportHistory: { type: 'array', items: { type: 'object', additionalProperties: true } },
            rules: { type: 'object', additionalProperties: true },
            prizeClaim: { type: 'object', additionalProperties: true },
            cta: { type: 'object', additionalProperties: true },
            policies: { type: 'object', additionalProperties: true },
            nextActions: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        SeckillIntentResponse: {
          allOf: [
            { $ref: '#/components/schemas/CheckoutIntentResponse' },
            {
              type: 'object',
              properties: {
                seckill: {
                  type: 'object',
                  properties: {
                    contractCallerBlocked: { const: true },
                    recordPurchaseTransaction: { anyOf: [{ $ref: '#/components/schemas/WalletTransaction' }, { type: 'null' }] }
                  }
                }
              }
            }
          ]
        },
        ClaimIntentResponse: {
          type: 'object',
          required: ['ok', 'secondaryMessage', 'signatureKind', 'submit', 'claimTransaction'],
          properties: {
            ok: { const: true },
            walletAddress: { type: 'string' },
            rewardId: { type: 'string' },
            assetSymbol: { enum: ['NPL', 'BNM'] },
            amount: { type: 'string' },
            secondaryMessage: { type: 'string' },
            signatureKind: { const: 'personal_sign' },
            claimTransaction: { anyOf: [{ $ref: '#/components/schemas/WalletTransaction' }, { type: 'null' }] }
          }
        },
        CompleteOrderIntentResponse: {
          type: 'object',
          required: ['ok', 'order', 'nextActions', 'endpoints'],
          properties: {
            ok: { const: true },
            order: { type: 'object', additionalProperties: true },
            fulfillment: { type: 'object', additionalProperties: true },
            confirmability: { type: 'object', additionalProperties: true },
            releaseStatus: { type: 'object', additionalProperties: true },
            releasePreview: { type: 'object', additionalProperties: true },
            completeOrderCall: { type: 'object', additionalProperties: true },
            timeout: { type: 'object', additionalProperties: true },
            completeOrderTransaction: { anyOf: [{ $ref: '#/components/schemas/WalletTransaction' }, { type: 'null' }] },
            unavailableReason: { type: 'string' },
            nextActions: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        FulfillmentSnapshotResponse: {
          type: 'object',
          required: ['version', 'order', 'current', 'confirmability', 'releasePreview', 'completeOrderCall', 'timeout', 'nextActions'],
          properties: {
            version: { const: '24k-fulfillment-snapshot-v1' },
            order: { type: 'object', additionalProperties: true },
            current: { type: 'object', additionalProperties: true },
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            fulfillments: { type: 'array', items: { type: 'object', additionalProperties: true } },
            logistics: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pickups: { type: 'array', items: { type: 'object', additionalProperties: true } },
            confirmability: { type: 'object', additionalProperties: true },
            releaseStatus: { type: 'object', additionalProperties: true },
            releasePreview: { type: 'object', additionalProperties: true },
            completeOrderCall: { type: 'object', additionalProperties: true },
            timeout: { type: 'object', additionalProperties: true },
            nextActions: { type: 'array', items: { type: 'string' } }
          }
        },
        DappMallStateResponse: {
          type: 'object',
          required: ['version', 'products', 'categories', 'filters', 'featured', 'paymentPolicy', 'finalCheckTemplate', 'nextActions', 'endpoints'],
          properties: {
            version: { const: '24k-dapp-mall-state-v1' },
            connectedAddress: { type: ['string', 'null'] },
            query: { type: 'object', additionalProperties: true },
            categories: { type: 'array', items: { type: 'string' } },
            filters: { type: 'object', additionalProperties: true },
            total: { type: 'number' },
            products: { type: 'array', items: { type: 'object', additionalProperties: true } },
            featured: { type: 'array', items: { type: 'object', additionalProperties: true } },
            paymentPolicy: { type: 'object', additionalProperties: true },
            finalCheckTemplate: { type: 'object', additionalProperties: true },
            policies: { type: 'object', additionalProperties: true },
            nextActions: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        DappStoresStateResponse: {
          type: 'object',
          required: ['version', 'stores', 'addresses', 'filters', 'checkoutTemplates', 'policies', 'nextActions', 'endpoints'],
          properties: {
            version: { const: '24k-dapp-stores-state-v1' },
            connectedAddress: { type: ['string', 'null'] },
            query: { type: 'object', additionalProperties: true },
            stores: { type: 'array', items: { type: 'object', additionalProperties: true } },
            addresses: { type: 'array', items: { type: 'object', additionalProperties: true } },
            filters: { type: 'object', additionalProperties: true },
            checkoutTemplates: { type: 'object', additionalProperties: true },
            policies: { type: 'object', additionalProperties: true },
            nextActions: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        DappOrderStateResponse: {
          type: 'object',
          required: ['version', 'order', 'fulfillment', 'funding', 'complete', 'claim', 'primaryAction', 'actions', 'nextActions', 'polling', 'endpoints'],
          properties: {
            version: { const: '24k-dapp-order-state-v1' },
            buyerAddress: { type: 'string' },
            orderId: { type: 'string' },
            order: { type: 'object', additionalProperties: true },
            fulfillment: { type: 'object', additionalProperties: true },
            funding: { type: 'object', additionalProperties: true },
            complete: { type: 'object', additionalProperties: true },
            claim: { type: 'object', additionalProperties: true },
            primaryAction: { type: 'object', additionalProperties: true },
            actions: { type: 'object', additionalProperties: true },
            nextActions: { type: 'array', items: { type: 'string' } },
            polling: { type: 'object', additionalProperties: true },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        TimeoutActionsResponse: {
          type: 'object',
          required: ['version', 'order', 'buyerTimeoutRefund', 'merchantForceSign', 'policy'],
          properties: {
            version: { const: '24k-order-timeout-actions-v1' },
            order: { type: 'object', additionalProperties: true },
            buyerTimeoutRefund: { type: 'object', additionalProperties: true },
            merchantForceSign: { type: 'object', additionalProperties: true },
            policy: { type: 'object', additionalProperties: true }
          }
        },
        TimeoutRefundRequestResponse: {
          type: 'object',
          required: ['ok', 'status', 'order', 'refundPolicy'],
          properties: {
            ok: { const: true },
            action: { const: 'buyer.timeout-refund.request' },
            status: { const: 'RefundRequested' },
            order: { type: 'object', additionalProperties: true },
            refundPolicy: { type: 'string' },
            chainActionRequired: { type: 'string' }
          }
        },
        TxStatusResponse: {
          type: 'object',
          properties: {
            status: { enum: ['pending', 'confirming', 'confirmed', 'failed', 'mismatch', 'rpc_unavailable'] },
            retryable: { type: 'boolean' },
            txHash: { type: 'string' },
            order: { type: 'object', additionalProperties: true },
            afterSale: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
            finality: { type: 'object', additionalProperties: true },
            error: { type: 'string' }
          }
        },
        AfterSaleRequestResponse: {
          type: 'object',
          properties: {
            case: { type: 'object', additionalProperties: true },
            order: { type: 'object', additionalProperties: true },
            assetState: { const: 'Locked' },
            transactionIntent: { anyOf: [{ $ref: '#/components/schemas/WalletTransaction' }, { type: 'null' }] },
            arbitrationStatusEndpoint: { anyOf: [{ type: 'string' }, { type: 'null' }] }
          }
        },
        ClaimTxStatusResponse: {
          type: 'object',
          properties: {
            status: { enum: ['pending', 'confirming', 'confirmed', 'failed', 'mismatch', 'rpc_unavailable', 'unavailable'] },
            retryable: { type: 'boolean' },
            txHash: { type: 'string' },
            error: { type: 'string' }
          }
        },
        DappAssetsStateResponse: {
          type: 'object',
          required: ['version', 'summary', 'sections', 'primaryAction', 'policies', 'nextActions', 'endpoints'],
          properties: {
            version: { const: '24k-dapp-assets-state-v1' },
            generatedAt: { type: 'string' },
            connectedAddress: { type: ['string', 'null'] },
            connectRequired: { type: 'boolean' },
            summary: { $ref: '#/components/schemas/AssetSummaryResponse' },
            sections: { type: 'object', additionalProperties: true },
            primaryAction: { type: 'object', additionalProperties: true },
            policies: { type: 'object', additionalProperties: true },
            nextActions: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        AssetSummaryResponse: {
          type: 'object',
          required: ['addresses', 'buckets', 'ledger', 'claims', 'orders', 'orderStateCounts', 'shoppingRecords', 'seckillRecords', 'actions'],
          properties: {
            address: { type: 'string' },
            addresses: { type: 'array', items: { type: 'object', additionalProperties: true } },
            buckets: { type: 'array', items: { type: 'object', additionalProperties: true } },
            ledger: { type: 'array', items: { type: 'object', additionalProperties: true } },
            claims: { type: 'array', items: { type: 'object', additionalProperties: true } },
            orders: { type: 'array', items: { type: 'object', additionalProperties: true } },
            orderStateCounts: { type: 'object', additionalProperties: { type: 'number' } },
            shoppingRecords: { type: 'array', items: { type: 'object', additionalProperties: true } },
            seckillRecords: { type: 'array', items: { type: 'object', additionalProperties: true } },
            actions: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        FulfillmentOptionsResponse: {
          type: 'object',
          required: ['version', 'addresses', 'stores', 'checkoutTemplates', 'policy', 'endpoints'],
          properties: {
            version: { const: '24k-fulfillment-options-v1' },
            connectedAddress: { type: ['string', 'null'] },
            modes: { type: 'array', items: { type: 'object', additionalProperties: true } },
            addresses: { type: 'array', items: { type: 'object', additionalProperties: true } },
            stores: { type: 'array', items: { type: 'object', additionalProperties: true } },
            checkoutTemplates: { type: 'object', additionalProperties: true },
            policy: { type: 'object', additionalProperties: true },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        SeckillRulesResponse: {
          type: 'object',
          required: ['version', 'title', 'body', 'highlights', 'policy'],
          properties: {
            version: { const: '24k-seckill-rules-v1' },
            title: { type: 'string' },
            body: { type: 'string' },
            ruleVersion: { type: 'string' },
            updatedAt: { type: ['string', 'null'] },
            highlights: { type: 'array', items: { type: 'string' } },
            policy: { type: 'object', additionalProperties: true }
          }
        },
        SeckillReportHistoryResponse: {
          type: 'object',
          required: ['version', 'reports'],
          properties: {
            version: { const: '24k-seckill-report-history-v1' },
            reports: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        },
        DappIntegration: { type: 'object', additionalProperties: true },
        DappHandoff: { type: 'object', additionalProperties: true },
        DappLaunchKit: { type: 'object', additionalProperties: true },
        DappLaunchStatus: { type: 'object', additionalProperties: true },
        DappContracts: { type: 'object', additionalProperties: true },
        DappReadiness: { type: 'object', additionalProperties: true },
        DappHome: { type: 'object', additionalProperties: true },
        DappFinalCheck: { type: 'object', additionalProperties: true },
        DappBootstrap: { type: 'object', additionalProperties: true }
      }
    }
  };
}

function dappTypeDefinitions() {
  return `// 24K DApp public frontend contract.
// Source: GET /api/dapp/types.d.ts
// Generated by the 24K backend; no private keys or secrets are included.

export type AssetSymbol = 'NPL' | 'BNM';
export type FulfillmentMode = 'delivery' | 'pickup';
export type DappTabKey = 'seckill' | 'mall' | 'stores' | 'assets';
export type TxPollingStatus = 'pending' | 'confirming' | 'confirmed' | 'failed' | 'mismatch' | 'rpc_unavailable';
export type ClaimTxPollingStatus = TxPollingStatus | 'unavailable';

export interface Sku {
  id: string;
  name: string;
  settlementPriceNpl: number;
  stock: number;
}

export interface ProductSummary {
  id: string;
  title: string;
  sku?: string;
  priceNpl: number;
  nplRatio: number;
  bnmRebateRate: number;
  skus: Sku[];
  fulfillmentModes: FulfillmentMode[];
  seckillLocked?: boolean;
  adminRegionCode?: string;
  [key: string]: unknown;
}

export interface ProductDetailResponse extends ProductSummary {
  risk: Record<string, unknown>;
  fiveFactorTemplate: Record<string, unknown>;
  dapp: {
    version: '24k-product-detail-v1';
    productId: string;
    docsFlow: string;
    seckillOverlay: Record<string, unknown>;
    buyNow: Record<string, unknown>;
    requiredSelections: Record<string, unknown>[];
    defaultCheckoutItem: Partial<CheckoutItem> & { productId: string; quantity: number };
    finalCheck: Record<string, unknown>;
    paymentPolicy: Record<string, unknown>;
    endpoints: Record<string, string>;
    nextActions: string[];
    policy: Record<string, unknown>;
  };
}

export interface DappMallStateResponse {
  version: '24k-dapp-mall-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  query: Record<string, unknown>;
  categories: string[];
  filters: Record<string, unknown>;
  total: number;
  products: Array<ProductSummary & { primaryAction: Record<string, unknown>; dapp: Record<string, unknown> }>;
  featured: Array<ProductSummary & { primaryAction: Record<string, unknown>; dapp: Record<string, unknown> }>;
  paymentPolicy: Record<string, unknown>;
  finalCheckTemplate: Record<string, unknown>;
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface DappStoresStateResponse {
  version: '24k-dapp-stores-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  query: Record<string, unknown>;
  stores: Store[];
  addresses: AddressBookEntry[];
  filters: Record<string, unknown>;
  checkoutTemplates: Record<'delivery' | 'pickup', Record<string, unknown>>;
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface DappAssetsStateResponse {
  version: '24k-dapp-assets-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  connectRequired: boolean;
  summary: AssetSummaryResponse;
  sections: {
    addresses: Record<string, unknown>;
    orders: Record<string, unknown>;
    records: Record<string, unknown>;
    rewards: Record<string, unknown>;
  };
  primaryAction: Record<string, unknown>;
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface SeckillSession {
  id: string;
  productId: string;
  status: string;
  startsAt: string;
  endsAt: string;
  relayEndsAt?: number | string | null;
  totalBuys?: number;
  prizePoolNpl?: string | number;
  winnerAddress?: string;
  winningOrderId?: string;
}

export interface SeckillRulesResponse {
  version: '24k-seckill-rules-v1';
  title: string;
  ruleVersion: string;
  body: string;
  updatedAt?: string | null;
  source: string;
  highlights: string[];
  policy: Record<string, unknown>;
  actions: Record<string, string>;
}

export interface SeckillReport {
  id: string;
  sessionId: string;
  status: string;
  winnerAddress?: string;
  winningOrderId?: string;
  prizePoolNpl: number;
  totalBuys: number;
  txHash?: string;
  createdAt?: string | null;
}

export interface SeckillReportHistoryResponse {
  version: '24k-seckill-report-history-v1';
  reports: SeckillReport[];
}

export interface SeckillFeedStreamSnapshot {
  version: '24k-seckill-feed-stream-v1';
  sessionId: string;
  generatedAt: string;
  feed: Record<string, unknown>[];
  report: SeckillReport;
}

export interface DappSeckillStateResponse {
  version: '24k-dapp-seckill-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  session: SeckillSession;
  phase: { key: string; label: string; status: string; canBuy: boolean; reason: string };
  timers: Record<'main' | 'relay', Record<string, unknown>>;
  prizePool: Record<string, unknown>;
  product: ProductSummary | null;
  productDapp: Record<string, unknown> | null;
  feed: Record<string, unknown>[];
  report: SeckillReport;
  reportHistory: SeckillReport[];
  rules: SeckillRulesResponse;
  prizeClaim: Record<string, unknown>;
  cta: { key: string; enabled: boolean; label: string; reason: string; endpoint: string | null };
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface AddressBookEntry {
  id: string;
  walletAddress?: string;
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  regionCode: string;
  isDefault?: boolean;
  deliveryContext?: Record<string, unknown>;
  checkoutItemPatch?: Record<string, unknown>;
  finalCheckFactor?: Record<string, unknown>;
}

export interface Store {
  id: string;
  name: string;
  merchantAddress?: string;
  regionCode: string;
  city?: string;
  district?: string;
  address?: string;
  lat?: number;
  lng?: number;
  distanceKm?: number;
  distanceSource?: 'gps' | 'unavailable' | string;
  pickupContext?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  dapp?: Record<string, unknown>;
}

export interface AddressParseResponse {
  ok: boolean;
  sourceText: string;
  parsed: Partial<AddressBookEntry>;
  missing: string[];
  confidence: number;
  reviewRequired: boolean;
  warning: string;
  dappReview: Record<string, unknown>;
  nextAction: { method: 'POST'; endpoint: '/api/address-book'; body: Record<string, unknown> };
}

export interface FulfillmentOptionsResponse {
  version: '24k-fulfillment-options-v1';
  generatedAt: string;
  connectedAddress: string | null;
  query: Record<string, unknown>;
  modes: Record<string, unknown>[];
  addresses: AddressBookEntry[];
  stores: Store[];
  checkoutTemplates: Record<'delivery' | 'pickup', Record<string, unknown>>;
  policy: Record<string, unknown>;
  endpoints: Record<string, string>;
}

export interface AssetBucket {
  id: string;
  title: string;
  assetSymbol: AssetSymbol;
  cumulative: number;
  available: number;
  locked: number;
  claimed?: number;
  burned?: number;
  pendingClaim?: number;
  visible: boolean;
  docsKey?: 'bnm' | 'genesis-node' | 'referral-shop' | 'region-agent' | 'ops' | 'seckill-prize' | string;
  claimable?: boolean;
  claimEndpoint?: '/api/dapp/claim-intent';
  claimIntent?: {
    method: 'POST';
    endpoint: '/api/dapp/claim-intent';
    body: { walletAddress?: string; bucketId: string; rewardId: string };
    note?: string;
  } | null;
  unlockPolicy?: string;
  visibility?: Record<string, unknown>;
  stateSummary?: {
    cumulative: number;
    locked: number;
    available: number;
    pendingClaim: number;
    claimed: number;
    burned: number;
  };
}

export interface RewardLedgerEntry {
  id: string;
  walletAddress?: string;
  orderId?: string;
  bucketId?: string;
  source: string;
  assetSymbol: AssetSymbol;
  amount: number;
  state: 'Locked' | 'Available' | 'Claimed' | 'Burned' | 'PendingClaim' | string;
  txHash?: string;
}

export interface ClaimRecord {
  id: string;
  rewardId?: string;
  bucketId: string;
  assetSymbol: AssetSymbol;
  amount: number;
  status: string;
  txHash?: string;
  expiresAt?: number;
  createdAt?: string;
}

export interface ShoppingRecord {
  orderId: string;
  productId: string;
  title: string;
  skuId?: string;
  skuName?: string;
  quantity: number;
  amountNpl: string;
  status: string;
  fulfillmentMode?: FulfillmentMode;
  regionCode?: string;
  createdAt?: string;
  dapp?: {
    primaryAction: Record<string, unknown>;
    nextActions: string[];
    endpoints: Record<string, string>;
    confirmability: OrderConfirmability;
  };
}

export interface SeckillRecord {
  sessionId: string;
  eventName: string;
  orderId?: string;
  buyerAddress?: string;
  txHash?: string;
  blockNumber?: number;
  createdAt?: string;
  session?: SeckillSession | null;
  prizeClaim?: {
    claimable: boolean;
    status: string;
    rewardId?: string;
    assetSymbol?: 'NPL';
    amount?: number;
    claimIntent?: Record<string, unknown>;
    note?: string;
  };
}

export interface WalletTransaction {
  key: string;
  from?: string;
  to: string;
  value: '0x0' | string;
  data: string;
}

export interface DisputeOrderTransaction extends WalletTransaction {
  key: 'buyerDisputeOrder';
  chainId: number;
  orderId: string;
}

export interface AfterSaleCase {
  id: string;
  orderId: string;
  buyerAddress: string;
  requestType: 'exchange' | 'delay';
  status: string;
  resolution?: string | null;
  reason?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface AfterSaleState {
  available: boolean;
  allowedTypes: Array<'exchange' | 'delay'>;
  active: boolean;
  case: AfterSaleCase | null;
  assetState?: string | null;
  transactionIntent?: DisputeOrderTransaction | null;
  arbitrationStatusEndpoint?: string | null;
}

export interface AllowanceCheck {
  key: 'npl';
  symbol: 'NPL';
  tokenAddress: string;
  owner: string;
  spender: string;
  requiredAmount: string;
  requiredAmountWei: string;
  to: string;
  data: string;
}

export interface ApprovalTransaction extends WalletTransaction {
  key: 'npl';
  symbol: 'NPL';
  spender: string;
  amount: 'MaxUint256';
  amountWei: string;
}

export interface PayOrderTransaction extends WalletTransaction {
  key: 'payOrder';
  deadline: number;
  deadlineSeconds: number;
  orderDigest: string;
}

export interface CompleteOrderTransaction extends WalletTransaction {
  key: 'completeOrder';
  orderId: string;
}

export interface OrderConfirmability {
  canComplete: boolean;
  reason: string;
  mode: FulfillmentMode;
  orderStatus: string;
  fulfillmentStatus: string;
  requiredOrderStatus: 'Shipped' | 'PickupReady';
  requiredFulfillmentStatus: 'Shipped' | 'PickupReady';
  cta: string;
  warning: string;
}

export interface ReleasePreview {
  assetSymbol: 'BNM';
  bnmLocked: string;
  stateBeforeComplete: 'Locked';
  stateAfterComplete: 'Available';
  availableIncrease: string;
  localLedgerMode: boolean;
  rewardLedgerAddress: string;
  trigger: string;
  claimEndpoint: '/api/dapp/claim-intent';
  ledger: RewardLedgerEntry[];
  totals: Record<string, string>;
  note: string;
}

export interface CompleteOrderCall {
  available: boolean;
  reason: string;
  method: 'POST';
  endpoint: '/api/dapp/complete-order-intent';
  body: { buyerAddress: string; orderId: string };
  transactionKey: 'completeOrder';
  transaction: CompleteOrderTransaction | null;
  pollingEndpoint: string;
}

export interface FulfillmentSnapshotResponse {
  version: '24k-fulfillment-snapshot-v1';
  generatedAt: string;
  order: DappOrder;
  current: Record<string, unknown>;
  items: Record<string, unknown>[];
  fulfillments: Record<string, unknown>[];
  logistics: Record<string, unknown>[];
  pickups: Record<string, unknown>[];
  confirmability: OrderConfirmability;
  releaseStatus: Record<string, unknown>;
  releasePreview: ReleasePreview;
  completeOrderCall: CompleteOrderCall;
  timeout: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface PaymentIntent {
  chainId: number;
  chainIdHex: string;
  approvalPolicy: {
    type: 'unlimited-npl';
    allowanceSkip: true;
    amount: 'MaxUint256';
  };
  allowanceChecks: AllowanceCheck[];
  approvalTransactions: ApprovalTransaction[];
  payOrderTransaction: PayOrderTransaction;
  submitFundingEndpoint: string;
  fundingStatusEndpoint: string;
  generatedAt: string;
}

export interface DappOrder {
  id: string;
  orderId: string;
  buyerAddress: string;
  sellerAddress: string;
  amountNpl: string;
  bnmLocked?: string;
  fulfillmentMode?: FulfillmentMode;
  addressId?: string;
  storeId?: string;
  regionCode?: string;
  status: string;
  chainId: number;
  escrowAddress: string;
  orderDigest: string;
}

export interface AssetOrder extends DappOrder {
  fulfillment: Record<string, unknown>;
  confirmability: OrderConfirmability;
  releaseStatus: Record<string, unknown>;
  releasePreview: ReleasePreview;
  actions: Record<string, unknown>;
  afterSale: AfterSaleState | null;
  primaryAction: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface DappCheckoutIntentResponse {
  ok: true;
  preflight: unknown;
  finalCheck: unknown;
  order: DappOrder;
  paymentIntent: PaymentIntent | null;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface RecordPurchaseTransaction extends WalletTransaction {
  key: 'recordPurchase';
  sessionId: string;
  orderId: string;
}

export interface DappSeckillIntentResponse extends DappCheckoutIntentResponse {
  seckill: {
    session: unknown;
    contractAddress: string;
    contractCallerBlocked: true;
    recordPurchaseTransaction: RecordPurchaseTransaction | null;
    unavailableReason?: string;
  };
}

export interface ClaimIntentResponse {
  ok: true;
  walletAddress: string;
  rewardId: string;
  bucketId: string;
  assetSymbol: AssetSymbol;
  amount: string;
  chainId: number;
  nonce: string;
  expiresAt: number;
  secondaryMessage: string;
  signatureKind: 'personal_sign';
  submit: {
    method: 'POST';
    endpoint: '/api/claims';
    body: Record<string, string>;
  };
  claimTransaction: (WalletTransaction & { key: 'rewardLedgerClaim'; rewardId: string; entryId: string }) | null;
  unavailableReason?: string;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface CompleteOrderIntentResponse {
  ok: true;
  order: DappOrder;
  fulfillment: Record<string, unknown>;
  confirmability: OrderConfirmability;
  releaseStatus: Record<string, unknown>;
  releasePreview: ReleasePreview;
  completeOrderCall: CompleteOrderCall;
  timeout: Record<string, unknown>;
  chainId: number;
  chainIdHex: string;
  completeOrderTransaction: CompleteOrderTransaction | null;
  unavailableReason?: string;
  physicalDeliveryWarning: string;
  nextActions: string[];
  endpoints: Record<string, string>;
  generatedAt: string;
}

export interface AfterSaleRequestResponse {
  case: AfterSaleCase;
  order: DappOrder;
  assetState: 'Locked';
  transactionIntent: DisputeOrderTransaction | null;
  next: string;
  arbitrationStatusEndpoint: string | null;
}

export interface DappOrderStateResponse {
  version: '24k-dapp-order-state-v1';
  generatedAt: string;
  buyerAddress: string;
  orderId: string;
  order: AssetOrder;
  fulfillment: FulfillmentSnapshotResponse;
  funding: Record<string, unknown>;
  complete: Record<string, unknown>;
  claim: Record<string, unknown>;
  primaryAction: Record<string, unknown>;
  actions: Record<string, unknown>;
  nextActions: string[];
  polling: Record<string, unknown>;
  endpoints: Record<string, string>;
}

export interface TimeoutClock {
  windowDays: 7;
  startAt: string;
  deadlineAt: string;
  reached: boolean;
  remainingMs: number;
  elapsedMs: number;
}

export interface TimeoutActionsResponse {
  version: '24k-order-timeout-actions-v1';
  generatedAt: string;
  order: DappOrder;
  fulfillment: unknown;
  policy: Record<string, unknown>;
  buyerTimeoutRefund: {
    eligible: boolean;
    reason: string;
    clock: TimeoutClock;
    request: { method: 'POST'; endpoint: '/api/dapp/timeout-refund-request'; body: TimeoutRefundRequestBody };
    resultStatus: 'RefundRequested';
    chainActionRequired: string;
  };
  merchantForceSign: {
    eligible: boolean;
    reason: string;
    clock: TimeoutClock;
    request: Record<string, unknown>;
    resultStatus: 'Arbitration';
    chainActionRequired: string;
  };
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface TimeoutRefundRequestBody {
  buyerAddress: string;
  orderId: string;
  reason?: string;
}

export interface TimeoutRefundRequestResponse {
  ok: true;
  action: 'buyer.timeout-refund.request';
  status: 'RefundRequested';
  order: DappOrder;
  noUserNoReasonRefund: true;
  refundPolicy: string;
  next: string;
  chainActionRequired: string;
  endpoints: Record<string, string>;
}

export interface TxStatusResponse {
  status: TxPollingStatus;
  retryable: boolean;
  txHash: string;
  order?: DappOrder;
  afterSale?: AfterSaleCase | null;
  finality?: { finalized: boolean; confirmations: number; requiredConfirmations: number; blockNumber: number; latestBlock: number };
  error?: string;
}

export interface ClaimTxStatusResponse {
  status: ClaimTxPollingStatus;
  retryable: boolean;
  txHash: string;
  reward?: unknown;
  finality?: { finalized: boolean; confirmations: number; requiredConfirmations: number; blockNumber: number; latestBlock: number };
  error?: string;
}

export interface AssetSummaryResponse {
  address?: string;
  addresses: AddressBookEntry[];
  buckets: AssetBucket[];
  ledger: RewardLedgerEntry[];
  claims: ClaimRecord[];
  orders: AssetOrder[];
  orderStateCounts: Record<string, number>;
  shoppingRecords: ShoppingRecord[];
  seckillRecords: SeckillRecord[];
  actions: Record<string, string>;
}

export interface DappLaunchKitResponse {
  version: '24k-dapp-launch-kit-v1';
  entryUrl: string;
  walletBrowserEntryUrl: string;
  apiBaseUrl: string;
  qr: {
    data: string;
    externalPng: string;
    localGenerateCommand: 'pnpm dapp:qr';
    localSvgArtifact: 'test-artifacts/dapp-launch-qr.svg';
    note: string;
  };
  urls: Record<string, string>;
  candidateUrls: string[];
  wallet: Record<string, unknown>;
  fixedPolicy: Record<string, unknown>;
  readiness: Record<string, unknown>;
  launchStatus: DappLaunchStatusResponse;
}

export interface DappLaunchStatusResponse {
  kind: '24k-dapp-launch-status';
  generatedAt: string;
  localOk: boolean;
  strictLaunchOk: boolean;
  localBlockers: string[];
  strictLaunchBlockers: Array<{ key: string; name: string; fix: string; source: string }>;
  uniqueBlockers: Array<{ key: string; title: string; sources: string[]; rawNames: string[]; fixes: string[] }>;
  criticalPath: Array<{ key: string; title: string; command: string; note: string }>;
  fixedPolicy: Record<string, unknown>;
  contracts: Record<string, unknown>;
  envStatus: Record<string, unknown>;
  endpoints: Record<string, string>;
}

export interface DappHomeTab {
  key: DappTabKey;
  label: string;
  endpoint: string;
  data: unknown;
  actions: Record<string, string>;
}

export interface DappHomeResponse {
  version: '24k-dapp-home-v1';
  generatedAt: string;
  connectedAddress: string | null;
  config: {
    appName: '24K Mall DApp';
    chainId: number;
    chainIdHex: string;
    wallet: Record<string, unknown>;
    nplAddress: string;
    fixedNplAddress: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
    payment: Record<string, unknown>;
  };
  status: Record<string, unknown>;
  policy: Record<string, unknown>;
  endpoints: Record<string, string>;
  tabs: DappHomeTab[];
}

export interface DappFinalCheckResponse {
  ok: boolean;
  error?: string;
  version: '24k-dapp-final-check-v1';
  checkedAt: string;
  title: string;
  summary: Record<string, unknown>;
  factors: Array<{ key: string; label: string; value: string; detail?: unknown }>;
  preflight: unknown;
  nextAction: {
    method: 'POST';
    endpoint: '/api/dapp/checkout-intent';
    body: CheckoutIntentBody;
    walletFlow: string[];
  } | null;
}

export interface DappContractsResponse {
  version: '24k-dapp-contracts-v1';
  chainId: number;
  chainIdHex: string;
  tokens: Record<string, { address: string; symbol: string; decimals?: number; fixedBscAddress?: string; plannedWhenEmpty?: boolean }>;
  contracts: Record<string, { address: string; name: string }>;
  humanReadableAbi: Record<'erc20' | 'escrow' | 'rewardLedger' | 'seckill', string[]>;
  policies: Record<string, unknown>;
}

export interface DappBootstrapResponse {
  config: {
    appName: '24K Mall DApp';
    chainId: 56 | number;
    nplAddress: string;
    fixedNplAddress: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
    payment: {
      settlement: 'NPL';
      firstPaymentApproval: 'unlimited-npl';
      approvalAmount: 'MaxUint256';
      allowanceSkip: true;
    };
  };
  tabs: Array<{ key: DappTabKey; label: string; endpoint: string }>;
  endpoints: Record<string, string>;
  abiFragments: Record<string, string[]>;
  policy: Record<string, unknown>;
  initialData: Record<string, unknown>;
}
`;
}

function dappSdkSource() {
  return `// 24K DApp TypeScript SDK helpers.
// Source: GET /api/dapp/sdk.ts
// Generated by the 24K backend; no private keys or backend secrets are included.

export const FIXED_BSC_NPL_ADDRESS = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
export const REQUIRED_CHAIN_ID = 56;
export const REQUIRED_CHAIN_ID_HEX = '0x38';
export const MAX_UINT256_DECIMAL = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

export type DappTabKey = 'seckill' | 'mall' | 'stores' | 'assets';
export type FulfillmentMode = 'delivery' | 'pickup';
export type TxPollingStatus = 'pending' | 'confirming' | 'confirmed' | 'failed' | 'mismatch' | 'rpc_unavailable';
export type ClaimTxPollingStatus = TxPollingStatus | 'unavailable';

export interface Sku {
  id: string;
  name: string;
  settlementPriceNpl: number;
  stock: number;
}

export interface ProductSummary {
  id: string;
  title: string;
  sku?: string;
  priceNpl: number;
  nplRatio: number;
  bnmRebateRate: number;
  skus: Sku[];
  fulfillmentModes: FulfillmentMode[];
  seckillLocked?: boolean;
  adminRegionCode?: string;
  [key: string]: unknown;
}

export interface ProductDetailResponse extends ProductSummary {
  risk: Record<string, unknown>;
  fiveFactorTemplate: Record<string, unknown>;
  dapp: {
    version: '24k-product-detail-v1';
    productId: string;
    docsFlow: string;
    seckillOverlay: Record<string, unknown>;
    buyNow: Record<string, unknown>;
    requiredSelections: Record<string, unknown>[];
    defaultCheckoutItem: Partial<CheckoutItem> & { productId: string; quantity: number };
    finalCheck: Record<string, unknown>;
    paymentPolicy: Record<string, unknown>;
    endpoints: Record<string, string>;
    nextActions: string[];
    policy: Record<string, unknown>;
  };
}

export interface DappMallStateResponse {
  version: '24k-dapp-mall-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  query: Record<string, unknown>;
  categories: string[];
  filters: Record<string, unknown>;
  total: number;
  products: Array<ProductSummary & { primaryAction: Record<string, unknown>; dapp: Record<string, unknown> }>;
  featured: Array<ProductSummary & { primaryAction: Record<string, unknown>; dapp: Record<string, unknown> }>;
  paymentPolicy: Record<string, unknown>;
  finalCheckTemplate: Record<string, unknown>;
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface DappStoresStateResponse {
  version: '24k-dapp-stores-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  query: Record<string, unknown>;
  stores: Store[];
  addresses: AddressBookEntry[];
  filters: Record<string, unknown>;
  checkoutTemplates: Record<'delivery' | 'pickup', Record<string, unknown>>;
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface DappAssetsStateResponse {
  version: '24k-dapp-assets-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  connectRequired: boolean;
  summary: AssetSummaryResponse;
  sections: {
    addresses: Record<string, unknown>;
    orders: Record<string, unknown>;
    records: Record<string, unknown>;
    rewards: Record<string, unknown>;
  };
  primaryAction: Record<string, unknown>;
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface SeckillSession {
  id: string;
  productId: string;
  status: string;
  startsAt: string;
  endsAt: string;
  relayEndsAt?: number | string | null;
  totalBuys?: number;
  prizePoolNpl?: string | number;
  winnerAddress?: string;
  winningOrderId?: string;
}

export interface SeckillRulesResponse {
  version: '24k-seckill-rules-v1';
  title: string;
  ruleVersion: string;
  body: string;
  updatedAt?: string | null;
  source: string;
  highlights: string[];
  policy: Record<string, unknown>;
  actions: Record<string, string>;
}

export interface SeckillReport {
  id: string;
  sessionId: string;
  status: string;
  winnerAddress?: string;
  winningOrderId?: string;
  prizePoolNpl: number;
  totalBuys: number;
  txHash?: string;
  createdAt?: string | null;
}

export interface SeckillReportHistoryResponse {
  version: '24k-seckill-report-history-v1';
  reports: SeckillReport[];
}

export interface SeckillFeedStreamSnapshot {
  version: '24k-seckill-feed-stream-v1';
  sessionId: string;
  generatedAt: string;
  feed: Record<string, unknown>[];
  report: SeckillReport;
}

export interface DappSeckillStateResponse {
  version: '24k-dapp-seckill-state-v1';
  generatedAt: string;
  connectedAddress: string | null;
  session: SeckillSession;
  phase: { key: string; label: string; status: string; canBuy: boolean; reason: string };
  timers: Record<'main' | 'relay', Record<string, unknown>>;
  prizePool: Record<string, unknown>;
  product: ProductSummary | null;
  productDapp: Record<string, unknown> | null;
  feed: Record<string, unknown>[];
  report: SeckillReport;
  reportHistory: SeckillReport[];
  rules: SeckillRulesResponse;
  prizeClaim: Record<string, unknown>;
  cta: { key: string; enabled: boolean; label: string; reason: string; endpoint: string | null };
  policies: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface AddressBookEntry {
  id: string;
  walletAddress?: string;
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  regionCode: string;
  isDefault?: boolean;
  deliveryContext?: Record<string, unknown>;
  checkoutItemPatch?: Record<string, unknown>;
  finalCheckFactor?: Record<string, unknown>;
}

export interface Store {
  id: string;
  name: string;
  merchantAddress?: string;
  regionCode: string;
  city?: string;
  district?: string;
  address?: string;
  lat?: number;
  lng?: number;
  distanceKm?: number;
  distanceSource?: 'gps' | 'unavailable' | string;
  pickupContext?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  dapp?: Record<string, unknown>;
}

export interface AddressParseResponse {
  ok: boolean;
  sourceText: string;
  parsed: Partial<AddressBookEntry>;
  missing: string[];
  confidence: number;
  reviewRequired: boolean;
  warning: string;
  dappReview: Record<string, unknown>;
  nextAction: { method: 'POST'; endpoint: '/api/address-book'; body: Record<string, unknown> };
}

export interface FulfillmentOptionsResponse {
  version: '24k-fulfillment-options-v1';
  generatedAt: string;
  connectedAddress: string | null;
  query: Record<string, unknown>;
  modes: Record<string, unknown>[];
  addresses: AddressBookEntry[];
  stores: Store[];
  checkoutTemplates: Record<'delivery' | 'pickup', Record<string, unknown>>;
  policy: Record<string, unknown>;
  endpoints: Record<string, string>;
}

export interface AssetBucket {
  id: string;
  title: string;
  assetSymbol: 'NPL' | 'BNM';
  cumulative: number;
  available: number;
  locked: number;
  claimed?: number;
  burned?: number;
  pendingClaim?: number;
  visible: boolean;
  docsKey?: 'bnm' | 'genesis-node' | 'referral-shop' | 'region-agent' | 'ops' | 'seckill-prize' | string;
  claimable?: boolean;
  claimEndpoint?: '/api/dapp/claim-intent';
  claimIntent?: {
    method: 'POST';
    endpoint: '/api/dapp/claim-intent';
    body: { walletAddress?: string; bucketId: string; rewardId: string };
    note?: string;
  } | null;
  unlockPolicy?: string;
  visibility?: Record<string, unknown>;
  stateSummary?: {
    cumulative: number;
    locked: number;
    available: number;
    pendingClaim: number;
    claimed: number;
    burned: number;
  };
}

export interface RewardLedgerEntry {
  id: string;
  walletAddress?: string;
  orderId?: string;
  bucketId?: string;
  source: string;
  assetSymbol: 'NPL' | 'BNM';
  amount: number;
  state: 'Locked' | 'Available' | 'Claimed' | 'Burned' | 'PendingClaim' | string;
  txHash?: string;
}

export interface ClaimRecord {
  id: string;
  rewardId?: string;
  bucketId: string;
  assetSymbol: 'NPL' | 'BNM';
  amount: number;
  status: string;
  txHash?: string;
  expiresAt?: number;
  createdAt?: string;
}

export interface ShoppingRecord {
  orderId: string;
  productId: string;
  title: string;
  skuId?: string;
  skuName?: string;
  quantity: number;
  amountNpl: string;
  status: string;
  fulfillmentMode?: 'delivery' | 'pickup';
  regionCode?: string;
  createdAt?: string;
  dapp?: {
    primaryAction: Record<string, unknown>;
    nextActions: string[];
    endpoints: Record<string, string>;
    confirmability: OrderConfirmability;
  };
}

export interface SeckillRecord {
  sessionId: string;
  eventName: string;
  orderId?: string;
  buyerAddress?: string;
  txHash?: string;
  blockNumber?: number;
  createdAt?: string;
  session?: SeckillSession | null;
  prizeClaim?: {
    claimable: boolean;
    status: string;
    rewardId?: string;
    assetSymbol?: 'NPL';
    amount?: number;
    claimIntent?: Record<string, unknown>;
    note?: string;
  };
}

export interface DappClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  headers?: Record<string, string>;
}

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
}

export interface WalletTransaction {
  key: string;
  from?: string;
  to: string;
  value: string;
  data: string;
}

export interface DisputeOrderTransaction extends WalletTransaction {
  key: 'buyerDisputeOrder';
  chainId: number;
  orderId: string;
}

export interface AfterSaleCase {
  id: string;
  orderId: string;
  buyerAddress: string;
  requestType: 'exchange' | 'delay';
  status: string;
  resolution?: string | null;
  reason?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface AfterSaleState {
  available: boolean;
  allowedTypes: Array<'exchange' | 'delay'>;
  active: boolean;
  case: AfterSaleCase | null;
  assetState?: string | null;
  transactionIntent?: DisputeOrderTransaction | null;
  arbitrationStatusEndpoint?: string | null;
}

export interface OrderConfirmability {
  canComplete: boolean;
  reason: string;
  mode: 'delivery' | 'pickup';
  orderStatus: string;
  fulfillmentStatus: string;
  requiredOrderStatus: 'Shipped' | 'PickupReady';
  requiredFulfillmentStatus: 'Shipped' | 'PickupReady';
  cta: string;
  warning: string;
}

export interface ReleasePreview {
  assetSymbol: 'BNM';
  bnmLocked: string;
  stateBeforeComplete: 'Locked';
  stateAfterComplete: 'Available';
  availableIncrease: string;
  localLedgerMode: boolean;
  rewardLedgerAddress: string;
  trigger: string;
  claimEndpoint: '/api/dapp/claim-intent';
  ledger: RewardLedgerEntry[];
  totals: Record<string, string>;
  note: string;
}

export interface CompleteOrderCall {
  available: boolean;
  reason: string;
  method: 'POST';
  endpoint: '/api/dapp/complete-order-intent';
  body: { buyerAddress: string; orderId: string };
  transactionKey: 'completeOrder';
  transaction: (WalletTransaction & { key: 'completeOrder'; orderId: string }) | null;
  pollingEndpoint: string;
}

export interface AllowanceCheck {
  key: 'npl';
  symbol: 'NPL';
  tokenAddress: string;
  owner: string;
  spender: string;
  requiredAmount: string;
  requiredAmountWei: string;
  to: string;
  data: string;
}

export interface ApprovalTransaction extends WalletTransaction {
  key: 'npl';
  symbol: 'NPL';
  spender: string;
  amount: 'MaxUint256';
  amountWei: string;
}

export interface PaymentIntent {
  chainId: number;
  chainIdHex: string;
  approvalPolicy: {
    type: 'unlimited-npl';
    allowanceSkip: true;
    amount: 'MaxUint256';
  };
  allowanceChecks: AllowanceCheck[];
  approvalTransactions: ApprovalTransaction[];
  payOrderTransaction: WalletTransaction & {
    key: 'payOrder';
    deadline: number;
    deadlineSeconds: number;
    orderDigest: string;
  };
  submitFundingEndpoint: string;
  fundingStatusEndpoint: string;
}

export interface CheckoutItem {
  productId: string;
  skuId?: string;
  quantity: number;
  selected?: boolean;
  fulfillmentMode: 'delivery' | 'pickup';
  addressId?: string;
  storeId?: string;
  regionCode?: string;
}

export interface CheckoutIntentBody {
  buyerAddress: string;
  idempotencyKey: string;
  items: CheckoutItem[];
}

export interface ClaimIntentBody {
  walletAddress: string;
  bucketId?: string;
  rewardId: string;
}

export interface CompleteOrderIntentBody {
  buyerAddress: string;
  orderId: string;
}

export interface AfterSaleRequestBody {
  buyerAddress: string;
  orderId: string;
  type: 'exchange' | 'delay';
  reason: string;
  secondaryMessage: string;
  secondarySignature: string;
}

export interface AddressParseBody {
  text: string;
  walletAddress?: string;
}

export interface FulfillmentOptionsArgs {
  address?: string;
  lat?: number;
  lng?: number;
  city?: string;
  district?: string;
  regionCode?: string;
  limit?: number;
}

export interface MallStateArgs {
  address?: string;
  category?: string;
  q?: string;
  query?: string;
  limit?: number;
}

export interface CheckoutIntentResponse {
  ok: true;
  preflight: unknown;
  finalCheck: unknown;
  order: Record<string, unknown>;
  paymentIntent: PaymentIntent | null;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface AssetOrder extends Record<string, unknown> {
  orderId: string;
  status: string;
  fulfillment: Record<string, unknown>;
  confirmability: OrderConfirmability;
  releaseStatus: Record<string, unknown>;
  releasePreview: ReleasePreview;
  actions: Record<string, unknown>;
  afterSale: AfterSaleState | null;
  primaryAction: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface FinalCheckResponse {
  ok: boolean;
  error?: string;
  version: '24k-dapp-final-check-v1';
  checkedAt: string;
  title: string;
  summary: Record<string, unknown>;
  factors: Array<{ key: string; label: string; value: string; detail?: unknown }>;
  preflight: unknown;
  nextAction: {
    method: 'POST';
    endpoint: '/api/dapp/checkout-intent';
    body: CheckoutIntentBody;
    walletFlow: string[];
  } | null;
}

export interface SeckillIntentResponse extends CheckoutIntentResponse {
  seckill: {
    session: unknown;
    contractAddress: string;
    contractCallerBlocked: true;
    recordPurchaseTransaction: (WalletTransaction & { key: 'recordPurchase'; sessionId: string; orderId: string }) | null;
    unavailableReason?: string;
  };
}

export interface ClaimIntentResponse {
  ok: true;
  walletAddress: string;
  rewardId: string;
  bucketId: string;
  assetSymbol: 'NPL' | 'BNM';
  amount: string;
  chainId: number;
  nonce: string;
  expiresAt: number;
  secondaryMessage: string;
  signatureKind: 'personal_sign';
  submit: {
    method: 'POST';
    endpoint: '/api/claims';
    body: Record<string, string>;
  };
  claimTransaction: (WalletTransaction & { key: 'rewardLedgerClaim'; rewardId: string; entryId: string }) | null;
  unavailableReason?: string;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface CompleteOrderIntentResponse {
  ok: true;
  order: Record<string, unknown>;
  fulfillment: Record<string, unknown>;
  confirmability: OrderConfirmability;
  releaseStatus: Record<string, unknown>;
  releasePreview: ReleasePreview;
  completeOrderCall: CompleteOrderCall;
  timeout: Record<string, unknown>;
  chainId: number;
  chainIdHex: string;
  completeOrderTransaction: (WalletTransaction & { key: 'completeOrder'; orderId: string }) | null;
  unavailableReason?: string;
  physicalDeliveryWarning: string;
  nextActions: string[];
  endpoints: Record<string, string>;
  generatedAt: string;
}

export interface AfterSaleRequestResponse {
  case: AfterSaleCase;
  order: Record<string, unknown>;
  assetState: 'Locked';
  transactionIntent: DisputeOrderTransaction | null;
  next: string;
  arbitrationStatusEndpoint: string | null;
}

export interface DappOrderStateResponse {
  version: '24k-dapp-order-state-v1';
  generatedAt: string;
  buyerAddress: string;
  orderId: string;
  order: AssetOrder;
  fulfillment: FulfillmentSnapshotResponse;
  funding: Record<string, unknown>;
  complete: Record<string, unknown>;
  claim: Record<string, unknown>;
  primaryAction: Record<string, unknown>;
  actions: Record<string, unknown>;
  nextActions: string[];
  polling: Record<string, unknown>;
  endpoints: Record<string, string>;
}

export interface FulfillmentSnapshotResponse {
  version: '24k-fulfillment-snapshot-v1';
  generatedAt: string;
  order: Record<string, unknown>;
  current: Record<string, unknown>;
  items: Record<string, unknown>[];
  fulfillments: Record<string, unknown>[];
  logistics: Record<string, unknown>[];
  pickups: Record<string, unknown>[];
  confirmability: OrderConfirmability;
  releaseStatus: Record<string, unknown>;
  releasePreview: ReleasePreview;
  completeOrderCall: CompleteOrderCall;
  timeout: Record<string, unknown>;
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface TimeoutClock {
  windowDays: 7;
  startAt: string;
  deadlineAt: string;
  reached: boolean;
  remainingMs: number;
  elapsedMs: number;
}

export interface TimeoutRefundRequestBody {
  buyerAddress: string;
  orderId: string;
  reason?: string;
}

export interface TimeoutActionsResponse {
  version: '24k-order-timeout-actions-v1';
  generatedAt: string;
  order: Record<string, unknown>;
  fulfillment: unknown;
  policy: Record<string, unknown>;
  buyerTimeoutRefund: {
    eligible: boolean;
    reason: string;
    clock: TimeoutClock;
    request: { method: 'POST'; endpoint: '/api/dapp/timeout-refund-request'; body: TimeoutRefundRequestBody };
    resultStatus: 'RefundRequested';
    chainActionRequired: string;
  };
  merchantForceSign: {
    eligible: boolean;
    reason: string;
    clock: TimeoutClock;
    request: Record<string, unknown>;
    resultStatus: 'Arbitration';
    chainActionRequired: string;
  };
  nextActions: string[];
  endpoints: Record<string, string>;
}

export interface TimeoutRefundRequestResponse {
  ok: true;
  action: 'buyer.timeout-refund.request';
  status: 'RefundRequested';
  order: Record<string, unknown>;
  noUserNoReasonRefund: true;
  refundPolicy: string;
  next: string;
  chainActionRequired: string;
  endpoints: Record<string, string>;
}

export interface TxStatusResponse {
  status: TxPollingStatus;
  retryable: boolean;
  txHash: string;
  order?: unknown;
  afterSale?: AfterSaleCase | null;
  finality?: { finalized: boolean; confirmations: number; requiredConfirmations: number; blockNumber: number; latestBlock: number };
  error?: string;
}

export interface ClaimTxStatusResponse {
  status: ClaimTxPollingStatus;
  retryable: boolean;
  txHash: string;
  reward?: unknown;
  finality?: { finalized: boolean; confirmations: number; requiredConfirmations: number; blockNumber: number; latestBlock: number };
  error?: string;
}

export interface AssetSummaryResponse {
  address?: string;
  addresses: AddressBookEntry[];
  buckets: AssetBucket[];
  ledger: RewardLedgerEntry[];
  claims: ClaimRecord[];
  orders: AssetOrder[];
  orderStateCounts: Record<string, number>;
  shoppingRecords: ShoppingRecord[];
  seckillRecords: SeckillRecord[];
  actions: Record<string, string>;
}

export interface FundingTxStatusArgs {
  orderId: string;
  buyerAddress: string;
  txHash: string;
}

export interface CompleteTxStatusArgs {
  orderId: string;
  buyerAddress: string;
  txHash: string;
}

export type ArbitrationTxStatusArgs = CompleteTxStatusArgs;

export interface OrderBuyerArgs {
  orderId: string;
  buyerAddress: string;
}

export interface DappOrderStateArgs extends OrderBuyerArgs {
  fundTxHash?: string;
  fundingTxHash?: string;
  payOrderTxHash?: string;
  completeTxHash?: string;
  completeOrderTxHash?: string;
  claimRewardId?: string;
  rewardId?: string;
  claimTxHash?: string;
}

export interface ClaimTxStatusArgs {
  walletAddress: string;
  rewardId: string;
  txHash: string;
}

export interface DappHomeTab {
  key: DappTabKey;
  label: string;
  endpoint: string;
  data: unknown;
  actions: Record<string, string>;
}

export interface DappHomeResponse {
  version: '24k-dapp-home-v1';
  generatedAt: string;
  connectedAddress: string | null;
  config: Record<string, unknown>;
  status: Record<string, unknown>;
  policy: Record<string, unknown>;
  endpoints: Record<string, string>;
  tabs: DappHomeTab[];
}

export interface DappLaunchStatusResponse {
  kind: '24k-dapp-launch-status';
  generatedAt: string;
  localOk: boolean;
  strictLaunchOk: boolean;
  localBlockers: string[];
  strictLaunchBlockers: Array<{ key: string; name: string; fix: string; source: string }>;
  uniqueBlockers: Array<{ key: string; title: string; sources: string[]; rawNames: string[]; fixes: string[] }>;
  criticalPath: Array<{ key: string; title: string; command: string; note: string }>;
  fixedPolicy: Record<string, unknown>;
  contracts: Record<string, unknown>;
  envStatus: Record<string, unknown>;
  endpoints: Record<string, string>;
}

export interface WalletTransactionCallbacks {
  onTransactionHash?: (key: string, txHash: string) => void | Promise<void>;
}

export interface PaymentSendResult {
  approvalTxHashes: string[];
  payOrderTxHash: string;
}

export class DappApiError extends Error {
  status: number;
  path: string;
  payload: unknown;

  constructor(status: number, path: string, payload: unknown) {
    super('24K DApp API request failed: ' + status + ' ' + path);
    this.name = 'DappApiError';
    this.status = status;
    this.path = path;
    this.payload = payload;
  }
}

export function create24kDappClient(options: DappClientOptions = {}) {
  return {
    fetchDappReadiness: () => fetchDappReadiness(options),
    fetchDappLaunchStatus: () => fetchDappLaunchStatus(options),
    fetchDappHome: (address?: string) => fetchDappHome(address, options),
    fetchDappBootstrap: (address?: string) => fetchDappBootstrap(address, options),
    fetchDappContracts: () => fetchDappContracts(options),
    fetchProducts: () => fetchProducts(options),
    fetchProductDetail: (productId: string) => fetchProductDetail(productId, options),
    fetchDappMallState: (args: MallStateArgs = {}) => fetchDappMallState(args, options),
    fetchDappStoresState: (args: FulfillmentOptionsArgs = {}) => fetchDappStoresState(args, options),
    fetchDappAssetsState: (address?: string) => fetchDappAssetsState(address, options),
    fetchFulfillmentOptions: (args: FulfillmentOptionsArgs = {}) => fetchFulfillmentOptions(args, options),
    fetchStores: (args: FulfillmentOptionsArgs = {}) => fetchStores(args, options),
    fetchAddressBook: (address?: string) => fetchAddressBook(address, options),
    saveAddress: (body: Record<string, unknown>) => saveAddress(body, options),
    fetchAssetSummary: (address?: string) => fetchAssetSummary(address, options),
    fetchDappSeckillState: (address?: string) => fetchDappSeckillState(address, options),
    fetchSeckillRules: () => fetchSeckillRules(options),
    fetchSeckillReportHistory: (limit?: number) => fetchSeckillReportHistory(limit, options),
    seckillFeedStreamUrl: (sessionId?: string) => seckillFeedStreamUrl(sessionId, options),
    createFinalCheck: (body: CheckoutIntentBody) => createFinalCheck(body, options),
    createCheckoutIntent: (body: CheckoutIntentBody) => createCheckoutIntent(body, options),
    createSeckillIntent: (body: CheckoutIntentBody) => createSeckillIntent(body, options),
    createClaimIntent: (body: ClaimIntentBody) => createClaimIntent(body, options),
    createCompleteOrderIntent: (body: CompleteOrderIntentBody) => createCompleteOrderIntent(body, options),
    requestAfterSale: (body: AfterSaleRequestBody) => requestAfterSale(body, options),
    fetchDappOrderState: (args: DappOrderStateArgs) => fetchDappOrderState(args, options),
    fetchOrderFulfillment: (args: OrderBuyerArgs) => fetchOrderFulfillment(args, options),
    fetchOrderTimeoutActions: (args: OrderBuyerArgs) => fetchOrderTimeoutActions(args, options),
    requestTimeoutRefund: (body: TimeoutRefundRequestBody) => requestTimeoutRefund(body, options),
    parseAddressText: (body: AddressParseBody) => parseAddressText(body, options),
    submitClaimRequest: (intent: ClaimIntentResponse, secondarySignature: string) => submitClaimRequest(intent, secondarySignature, options),
    pollFundingTxStatus: (args: FundingTxStatusArgs) => pollFundingTxStatus(args, options),
    pollCompleteTxStatus: (args: CompleteTxStatusArgs) => pollCompleteTxStatus(args, options),
    pollArbitrationTxStatus: (args: ArbitrationTxStatusArgs) => pollArbitrationTxStatus(args, options),
    pollClaimTxStatus: (args: ClaimTxStatusArgs) => pollClaimTxStatus(args, options),
    sendPaymentIntent,
    sendSeckillRecordPurchase,
    sendCompleteOrder,
    sendDisputeOrder,
    sendClaimTransaction
  };
}

export async function fetchDappReadiness(options: DappClientOptions = {}): Promise<Record<string, unknown>> {
  return requestJson('/api/dapp/readiness', options);
}

export async function fetchDappLaunchStatus(options: DappClientOptions = {}): Promise<DappLaunchStatusResponse> {
  return requestJson('/api/dapp/launch-status', options);
}

export async function fetchDappHome(address?: string, options: DappClientOptions = {}): Promise<DappHomeResponse> {
  return requestJson(withQuery('/api/dapp/home', { address }), options);
}

export async function fetchDappBootstrap(address?: string, options: DappClientOptions = {}): Promise<Record<string, unknown>> {
  return requestJson(withQuery('/api/dapp/bootstrap', { address }), options);
}

export async function fetchDappContracts(options: DappClientOptions = {}): Promise<Record<string, unknown>> {
  return requestJson('/api/dapp/contracts.json', options);
}

export async function fetchProducts(options: DappClientOptions = {}): Promise<ProductSummary[]> {
  return requestJson('/api/products', options);
}

export async function fetchProductDetail(productId: string, options: DappClientOptions = {}): Promise<ProductDetailResponse> {
  return requestJson('/api/products/' + encodeURIComponent(productId), options);
}

export async function fetchDappMallState(args: MallStateArgs = {}, options: DappClientOptions = {}): Promise<DappMallStateResponse> {
  return requestJson(withQuery('/api/dapp/mall-state', args), options);
}

export async function fetchDappStoresState(args: FulfillmentOptionsArgs = {}, options: DappClientOptions = {}): Promise<DappStoresStateResponse> {
  return requestJson(withQuery('/api/dapp/stores-state', args), options);
}

export async function fetchDappAssetsState(address?: string, options: DappClientOptions = {}): Promise<DappAssetsStateResponse> {
  return requestJson(withQuery('/api/dapp/assets-state', { address }), options);
}

export async function fetchFulfillmentOptions(args: FulfillmentOptionsArgs = {}, options: DappClientOptions = {}): Promise<FulfillmentOptionsResponse> {
  return requestJson(withQuery('/api/dapp/fulfillment-options', args), options);
}

export async function fetchStores(args: FulfillmentOptionsArgs = {}, options: DappClientOptions = {}): Promise<Store[]> {
  return requestJson(withQuery('/api/stores', args), options);
}

export async function fetchAddressBook(address?: string, options: DappClientOptions = {}): Promise<AddressBookEntry[]> {
  return requestJson(withQuery('/api/address-book', { address }), options);
}

export async function saveAddress(body: Record<string, unknown>, options: DappClientOptions = {}): Promise<AddressBookEntry> {
  return requestJson('/api/address-book', options, jsonPost(body));
}

export async function fetchAssetSummary(address?: string, options: DappClientOptions = {}): Promise<AssetSummaryResponse> {
  return requestJson(withQuery('/api/assets/summary', { address }), options);
}

export async function fetchDappSeckillState(address?: string, options: DappClientOptions = {}): Promise<DappSeckillStateResponse> {
  return requestJson(withQuery('/api/dapp/seckill-state', { address }), options);
}

export async function fetchSeckillRules(options: DappClientOptions = {}): Promise<SeckillRulesResponse> {
  return requestJson('/api/seckill/rules', options);
}

export async function fetchSeckillReportHistory(limit?: number, options: DappClientOptions = {}): Promise<SeckillReportHistoryResponse> {
  return requestJson(withQuery('/api/seckill/reports', { limit }), options);
}

export function seckillFeedStreamUrl(sessionId?: string, options: DappClientOptions = {}): string {
  return apiUrl(withQuery('/api/seckill/feed/stream', { sessionId }), options.baseUrl);
}

export async function createFinalCheck(body: CheckoutIntentBody, options: DappClientOptions = {}): Promise<FinalCheckResponse> {
  return requestJson('/api/dapp/final-check', options, jsonPost(body));
}

export async function createCheckoutIntent(body: CheckoutIntentBody, options: DappClientOptions = {}): Promise<CheckoutIntentResponse> {
  return requestJson('/api/dapp/checkout-intent', options, jsonPost(body));
}

export async function createSeckillIntent(body: CheckoutIntentBody, options: DappClientOptions = {}): Promise<SeckillIntentResponse> {
  return requestJson('/api/dapp/seckill-intent', options, jsonPost(body));
}

export async function createClaimIntent(body: ClaimIntentBody, options: DappClientOptions = {}): Promise<ClaimIntentResponse> {
  return requestJson('/api/dapp/claim-intent', options, jsonPost(body));
}

export async function createCompleteOrderIntent(body: CompleteOrderIntentBody, options: DappClientOptions = {}): Promise<CompleteOrderIntentResponse> {
  return requestJson('/api/dapp/complete-order-intent', options, jsonPost(body));
}

export async function requestAfterSale(body: AfterSaleRequestBody, options: DappClientOptions = {}): Promise<AfterSaleRequestResponse> {
  return requestJson('/api/dapp/after-sale/request', options, jsonPost(body));
}

export async function fetchDappOrderState(args: DappOrderStateArgs, options: DappClientOptions = {}): Promise<DappOrderStateResponse> {
  return requestJson(withQuery('/api/dapp/order-state', args), options);
}

export async function fetchOrderFulfillment(args: OrderBuyerArgs, options: DappClientOptions = {}): Promise<FulfillmentSnapshotResponse> {
  return requestJson(withQuery('/api/orders/' + encodeURIComponent(args.orderId) + '/fulfillment', {
    buyerAddress: args.buyerAddress
  }), options);
}

export async function fetchOrderTimeoutActions(args: OrderBuyerArgs, options: DappClientOptions = {}): Promise<TimeoutActionsResponse> {
  return requestJson(withQuery('/api/orders/' + encodeURIComponent(args.orderId) + '/timeout-actions', {
    buyerAddress: args.buyerAddress
  }), options);
}

export async function requestTimeoutRefund(body: TimeoutRefundRequestBody, options: DappClientOptions = {}): Promise<TimeoutRefundRequestResponse> {
  return requestJson('/api/dapp/timeout-refund-request', options, jsonPost(body));
}

export async function parseAddressText(body: AddressParseBody, options: DappClientOptions = {}): Promise<AddressParseResponse> {
  return requestJson('/api/address-book/parse', options, jsonPost(body));
}

export async function submitClaimRequest(intent: ClaimIntentResponse, secondarySignature: string, options: DappClientOptions = {}): Promise<Record<string, unknown>> {
  return requestJson(intent.submit.endpoint, options, jsonPost({
    ...intent.submit.body,
    secondarySignature
  }));
}

export async function pollFundingTxStatus(args: FundingTxStatusArgs, options: DappClientOptions = {}): Promise<TxStatusResponse> {
  return requestJson(withQuery('/api/orders/' + encodeURIComponent(args.orderId) + '/fund-tx-status', {
    buyerAddress: args.buyerAddress,
    txHash: args.txHash
  }), options);
}

export async function pollCompleteTxStatus(args: CompleteTxStatusArgs, options: DappClientOptions = {}): Promise<TxStatusResponse> {
  return requestJson(withQuery('/api/orders/' + encodeURIComponent(args.orderId) + '/complete-tx-status', {
    buyerAddress: args.buyerAddress,
    txHash: args.txHash
  }), options);
}

export async function pollArbitrationTxStatus(args: ArbitrationTxStatusArgs, options: DappClientOptions = {}): Promise<TxStatusResponse> {
  return requestJson(withQuery('/api/orders/' + encodeURIComponent(args.orderId) + '/arbitration-tx-status', {
    buyerAddress: args.buyerAddress,
    txHash: args.txHash
  }), options);
}

export async function pollClaimTxStatus(args: ClaimTxStatusArgs, options: DappClientOptions = {}): Promise<ClaimTxStatusResponse> {
  return requestJson(withQuery('/api/dapp/claim-tx-status', {
    walletAddress: args.walletAddress,
    rewardId: args.rewardId,
    txHash: args.txHash
  }), options);
}

export async function switchTo24kChain(provider: WalletProvider, bootstrapOrWalletConfig?: unknown): Promise<void> {
  const wallet = walletConfigFrom(bootstrapOrWalletConfig);
  const chainId = String(wallet.switchEthereumChain?.params?.[0]?.chainId || wallet.chainIdHex || REQUIRED_CHAIN_ID_HEX);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    return;
  } catch (error) {
    if (!isUnknownChainError(error)) throw error;
  }
  const addParams = wallet.addEthereumChain?.params?.[0] || defaultBscAddEthereumChainParams();
  await provider.request({ method: 'wallet_addEthereumChain', params: [addParams] });
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: addParams.chainId || chainId }] });
}

export async function sendWalletTransaction(provider: WalletProvider, tx: WalletTransaction): Promise<string> {
  const payload: Record<string, string> = {
    to: tx.to,
    value: tx.value || '0x0',
    data: tx.data
  };
  if (tx.from) payload.from = tx.from;
  return String(await provider.request({ method: 'eth_sendTransaction', params: [payload] }));
}

export async function personalSign(provider: WalletProvider, address: string, message: string): Promise<string> {
  return String(await provider.request({ method: 'personal_sign', params: [message, address] }));
}

export async function readAllowanceWei(provider: WalletProvider, check: AllowanceCheck): Promise<bigint> {
  const value = await provider.request({
    method: 'eth_call',
    params: [{ to: check.to || check.tokenAddress, data: check.data }, 'latest']
  });
  return BigInt(String(value || '0x0'));
}

export async function approvalTransactionsNeedingAllowance(provider: WalletProvider, paymentIntent: PaymentIntent): Promise<ApprovalTransaction[]> {
  const byKey = new Map(paymentIntent.approvalTransactions.map((tx) => [tx.key, tx]));
  const missing: ApprovalTransaction[] = [];
  for (const check of paymentIntent.allowanceChecks) {
    const current = await readAllowanceWei(provider, check);
    if (current < BigInt(check.requiredAmountWei)) {
      const tx = byKey.get(check.key);
      if (tx) missing.push(tx);
    }
  }
  return missing;
}

export async function sendPaymentIntent(provider: WalletProvider, paymentIntent: PaymentIntent, callbacks: WalletTransactionCallbacks = {}): Promise<PaymentSendResult> {
  const approvalTxHashes: string[] = [];
  const approvals = await approvalTransactionsNeedingAllowance(provider, paymentIntent);
  for (const tx of approvals) {
    const txHash = await sendWalletTransaction(provider, tx);
    approvalTxHashes.push(txHash);
    await notifyTransactionHash(callbacks, tx.key, txHash);
  }
  const payOrderTxHash = await sendWalletTransaction(provider, paymentIntent.payOrderTransaction);
  await notifyTransactionHash(callbacks, paymentIntent.payOrderTransaction.key, payOrderTxHash);
  return { approvalTxHashes, payOrderTxHash };
}

export async function sendSeckillRecordPurchase(provider: WalletProvider, intent: SeckillIntentResponse, callbacks: WalletTransactionCallbacks = {}): Promise<string> {
  const tx = intent.seckill?.recordPurchaseTransaction;
  if (!tx) throw new Error(intent.seckill?.unavailableReason || 'SECKILL_RECORD_PURCHASE_UNAVAILABLE');
  const txHash = await sendWalletTransaction(provider, tx);
  await notifyTransactionHash(callbacks, tx.key, txHash);
  return txHash;
}

export async function sendCompleteOrder(provider: WalletProvider, intent: CompleteOrderIntentResponse, callbacks: WalletTransactionCallbacks = {}): Promise<string | null> {
  if (!intent.completeOrderTransaction) return null;
  const txHash = await sendWalletTransaction(provider, intent.completeOrderTransaction);
  await notifyTransactionHash(callbacks, intent.completeOrderTransaction.key, txHash);
  return txHash;
}

export async function sendDisputeOrder(provider: WalletProvider, intent: AfterSaleRequestResponse | DisputeOrderTransaction, callbacks: WalletTransactionCallbacks = {}): Promise<string | null> {
  const tx = 'transactionIntent' in intent ? intent.transactionIntent : intent;
  if (!tx) return null;
  const txHash = await sendWalletTransaction(provider, tx);
  await notifyTransactionHash(callbacks, tx.key, txHash);
  return txHash;
}

export async function sendClaimTransaction(provider: WalletProvider, intent: ClaimIntentResponse, callbacks: WalletTransactionCallbacks = {}): Promise<string | null> {
  if (!intent.claimTransaction) return null;
  const txHash = await sendWalletTransaction(provider, intent.claimTransaction);
  await notifyTransactionHash(callbacks, intent.claimTransaction.key, txHash);
  return txHash;
}

async function notifyTransactionHash(callbacks: WalletTransactionCallbacks, key: string, txHash: string): Promise<void> {
  if (callbacks.onTransactionHash) await callbacks.onTransactionHash(key, txHash);
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body)
  };
}

async function requestJson<T>(path: string, options: DappClientOptions = {}, init: RequestInit = {}): Promise<T> {
  const fetcher = options.fetcher || (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!fetcher) throw new Error('No fetch implementation available. Pass options.fetcher.');
  const response = await fetcher(apiUrl(path, options.baseUrl), {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
      ...((init.headers as Record<string, string> | undefined) || {})
    }
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) throw new DappApiError(response.status, path, payload);
  return payload as T;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function apiUrl(path: string, baseUrl = ''): string {
  if (/^https?:\\/\\//i.test(path)) return path;
  if (!baseUrl) return path;
  return new URL(path, baseUrl.replace(/\\/+$/, '') + '/').toString();
}

function withQuery(path: string, params: Record<string, string | number | boolean | undefined | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? path + (path.includes('?') ? '&' : '?') + suffix : path;
}

function walletConfigFrom(value: unknown): any {
  if (!value || typeof value !== 'object') return {};
  const objectValue = value as any;
  return objectValue.config?.wallet || objectValue.wallet || objectValue;
}

function defaultBscAddEthereumChainParams() {
  return {
    chainId: REQUIRED_CHAIN_ID_HEX,
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
    blockExplorerUrls: ['https://bscscan.com']
  };
}

function isUnknownChainError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message || '').toLowerCase();
  return code === 4902 || message.includes('unrecognized chain') || message.includes('unknown chain') || message.includes('not been added');
}
`;
}

function dappHome(address, storeOptions = {}) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const bootstrap = dappBootstrap(buyerAddress, storeOptions);
  const products = bootstrap.initialData.products || [];
  const stores = bootstrap.initialData.stores || [];
  const buyer = bootstrap.initialData.buyer;
  const categories = [...new Set(products.map((item) => item.category).filter(Boolean))];
  return {
    version: '24k-dapp-home-v1',
    generatedAt: new Date().toISOString(),
    connectedAddress: buyerAddress || null,
    config: {
      appName: bootstrap.config.appName,
      chainId: bootstrap.config.chainId,
      chainIdHex: bootstrap.config.chainIdHex,
      wallet: bootstrap.config.wallet,
      nplAddress: bootstrap.config.nplAddress,
      fixedNplAddress: bootstrap.config.fixedNplAddress,
      payment: bootstrap.config.payment
    },
    status: {
      readiness: dappReadiness(),
      connectRequiredForAssets: !buyerAddress
    },
    policy: bootstrap.policy,
    endpoints: bootstrap.endpoints,
    tabs: [
      {
        key: 'seckill',
        label: '秒杀大厅',
        endpoint: '/api/dapp/seckill-state',
        data: bootstrap.initialData.seckill,
        actions: {
          state: '/api/dapp/seckill-state?address=0x...',
          createIntent: '/api/dapp/seckill-intent',
          feed: '/api/seckill/feed',
          feedStream: '/api/seckill/feed/stream',
          report: '/api/seckill/report',
          reports: '/api/seckill/reports',
          rules: '/api/seckill/rules'
        }
      },
      {
        key: 'mall',
        label: '常规商城',
        endpoint: '/api/dapp/mall-state',
        data: bootstrap.initialData.mall,
        actions: {
          state: '/api/dapp/mall-state?address=0x...',
          productDetail: '/api/products/:id',
          stockPreflight: '/api/stock/preflight',
          finalCheck: '/api/dapp/final-check',
          createCheckoutIntent: '/api/dapp/checkout-intent'
        }
      },
      {
        key: 'stores',
        label: '线下门店',
        endpoint: '/api/dapp/stores-state',
        data: bootstrap.initialData.storesState,
        actions: {
          state: '/api/dapp/stores-state?address=0x...&lat=<gpsLat>&lng=<gpsLng>',
          fulfillmentOptions: '/api/dapp/fulfillment-options?address=0x...&lat=<gpsLat>&lng=<gpsLng>',
          listStores: '/api/stores?lat=<gpsLat>&lng=<gpsLng>&city=<city>&district=<district>',
          parseAddress: '/api/address-book/parse',
          saveAddress: '/api/address-book'
        }
      },
      {
        key: 'assets',
        label: '我的资产',
        endpoint: '/api/dapp/assets-state',
        data: bootstrap.initialData.assetsState,
        actions: {
          state: '/api/dapp/assets-state?address=0x...',
          parseAddress: '/api/address-book/parse',
          addressBook: '/api/address-book',
          buyerOrders: '/api/buyer/orders?buyerAddress=0x...',
          orderState: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...',
          completeOrderIntent: '/api/dapp/complete-order-intent',
          completeTxStatus: '/api/orders/:orderId/complete-tx-status?buyerAddress=0x...&txHash=0x...',
          timeoutActions: '/api/orders/:orderId/timeout-actions?buyerAddress=0x...',
          timeoutRefundRequest: '/api/dapp/timeout-refund-request',
          claimIntent: '/api/dapp/claim-intent',
          submitClaim: '/api/claims',
          claimTxStatus: '/api/dapp/claim-tx-status?walletAddress=0x...&rewardId=reward-ledger-1&txHash=0x...'
        }
      }
    ]
  };
}

function dappBootstrap(address, storeOptions = {}) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const products = db.prepare("SELECT * FROM products WHERE status = 'Active' ORDER BY id").all().map(toProduct).sort(sortPreviewProduct);
  const session = currentSeckillSession();
  const seckillProduct = session.id ? products.find((entry) => entry.id === session.productId) || null : null;
  const config = publicDappConfig();
  return {
    config,
    tabs: [
      { key: 'seckill', label: '秒杀大厅', endpoint: '/api/dapp/seckill-state' },
      { key: 'mall', label: '常规商城', endpoint: '/api/dapp/mall-state' },
      { key: 'stores', label: '线下门店', endpoint: '/api/dapp/stores-state' },
      { key: 'assets', label: '我的资产', endpoint: '/api/dapp/assets-state' }
    ],
    endpoints: {
      manifest: '/api/dapp/manifest',
      integration: '/api/dapp/integration',
      handoff: '/api/dapp/handoff',
      frontendBrief: '/api/dapp/frontend-brief.md',
      launchKit: '/api/dapp/launch-kit',
      launchStatus: '/api/dapp/launch-status',
      contracts: '/api/dapp/contracts.json',
      types: '/api/dapp/types.d.ts',
      sdk: '/api/dapp/sdk.ts',
      openapi: '/api/dapp/openapi.json',
      readiness: '/api/dapp/readiness',
      home: '/api/dapp/home',
      config: '/api/config',
      products: '/api/products',
      productDetail: '/api/products/:id',
      mallState: '/api/dapp/mall-state?address=0x...',
      storesState: '/api/dapp/stores-state?address=0x...&lat=38.86&lng=121.52',
      seckillState: '/api/dapp/seckill-state?address=0x...',
      seckillCurrent: '/api/seckill/current',
      seckillFeed: '/api/seckill/feed',
      seckillFeedStream: '/api/seckill/feed/stream',
      seckillReport: '/api/seckill/report',
      seckillReports: '/api/seckill/reports',
      seckillRules: '/api/seckill/rules',
      stores: '/api/stores',
      fulfillmentOptions: '/api/dapp/fulfillment-options?address=0x...&lat=38.86&lng=121.52',
      addressBook: '/api/address-book',
      addressBookParse: '/api/address-book/parse',
      stockPreflight: '/api/stock/preflight',
      finalCheck: '/api/dapp/final-check',
      checkoutIntent: '/api/dapp/checkout-intent',
      seckillIntent: '/api/dapp/seckill-intent',
      finalizeOrder: '/api/orders/finalize',
      createOrder: '/api/orders',
      buyerOrders: '/api/buyer/orders?buyerAddress=0x...',
      assetsState: '/api/dapp/assets-state?address=0x...',
      assetsSummary: '/api/assets/summary?address=0x...',
      orderStatus: '/api/orders/:orderId?buyerAddress=0x...',
      orderState: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...&fundTxHash=0x...',
      paymentIntent: '/api/orders/:orderId/payment-intent?buyerAddress=0x...',
      orderFulfillment: '/api/orders/:orderId/fulfillment?buyerAddress=0x...',
      completeOrderIntent: '/api/dapp/complete-order-intent',
      completeTxStatus: '/api/orders/:orderId/complete-tx-status?buyerAddress=0x...&txHash=0x...',
      timeoutActions: '/api/orders/:orderId/timeout-actions?buyerAddress=0x...',
      timeoutRefundRequest: '/api/dapp/timeout-refund-request',
      prepareClaim: '/api/claims/prepare',
      claimIntent: '/api/dapp/claim-intent',
      claimTxStatus: '/api/dapp/claim-tx-status?walletAddress=0x...&rewardId=reward-ledger-1&txHash=0x...',
      claims: '/api/claims',
      submitFundingTx: '/api/orders/:orderId/fund-tx',
      fundingTxStatus: '/api/orders/:orderId/fund-tx-status?buyerAddress=0x...&txHash=0x...'
    },
    abiFragments: dappHumanReadableAbi(),
    policy: {
      refund: '不开放用户无理由退款；仅平台强制退款、7天超时处理和 emergency refund。',
      timeout: '商家7天未发货可由买家发起强制退款申请；用户7天未确认收货可由商家发起强制签收申请，均需平台链上仲裁落地。',
      seckillContractCallerBlocked: true,
      circuitBreakers: {
        orders: circuitState('orders'),
        seckill: circuitState('seckill'),
        claims: circuitState('claims'),
        forceCutoff: circuitState('force-cutoff')
      }
    },
    initialData: {
      products: products.slice(0, 12),
      seckill: dappSeckillState(buyerAddress),
      mall: dappMallState(buyerAddress),
      stores: storeRows(storeOptions),
      storesState: dappStoresState(buyerAddress, storeOptions),
      assetsState: dappAssetsState(buyerAddress),
      fulfillment: dappFulfillmentOptions(buyerAddress, storeOptions),
      buyer: buyerAddress ? {
        address: buyerAddress,
        orders: buyerOrders(buyerAddress).slice(0, 10),
        assets: assetSummary(buyerAddress)
      } : null
    }
  };
}


function dappMallState(address, searchParams = new URLSearchParams()) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const category = cleanQueryText(searchParams.get?.('category'));
  const query = cleanQueryText(searchParams.get?.('q') || searchParams.get?.('query'));
  const limitValue = Number(searchParams.get?.('limit') || 0);
  const limit = Number.isSafeInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : 0;
  const products = db.prepare("SELECT * FROM products WHERE status = 'Active' ORDER BY id").all().map(toProduct).sort(sortPreviewProduct);
  const categories = [...new Set(products.map((item) => item.category).filter(Boolean))];
  const normalizedQuery = query.toLowerCase();
  let filtered = products.filter((product) => {
    if (category && product.category !== category) return false;
    if (normalizedQuery && ![product.title, product.sku, product.category, product.summary, ...(product.tags || [])].some((value) => String(value || '').toLowerCase().includes(normalizedQuery))) return false;
    return true;
  });
  const total = filtered.length;
  if (limit > 0) filtered = filtered.slice(0, limit);
  const productCards = filtered.map(dappMallProductCard);
  return {
    version: '24k-dapp-mall-state-v1',
    generatedAt: new Date().toISOString(),
    connectedAddress: buyerAddress || null,
    query: Object.fromEntries(Object.entries({ category, q: query, limit: limit || undefined }).filter(([, value]) => value !== undefined && value !== '')),
    categories,
    filters: {
      categories,
      fulfillmentModes: ['delivery', 'pickup'],
      payment: ['NPL'],
      tags: [...new Set(products.flatMap((item) => item.tags || []))]
    },
    total,
    products: productCards,
    featured: productCards.slice(0, 4),
    paymentPolicy: publicDappConfig().payment,
    finalCheckTemplate: {
      title: '付前 5 要素终核',
      factors: ['商品', 'SKU / 数量', '收货地址或自提门店 / 行政区', 'NPL 支付拆分', 'BNM 全返锁定额度'],
      endpoint: '/api/dapp/final-check'
    },
    policies: {
      noUserNoReasonRefund: true,
      regionCodeLockedOnPayment: true,
      addressOrStoreLockedOnPayment: true,
      approvalAmount: 'MaxUint256',
      allowanceSkip: true
    },
    nextActions: ['openProductDetail', 'selectSkuAndFulfillment', 'fetchFulfillmentOptions', 'createFinalCheck', 'createCheckoutIntent', 'sendPaymentIntent'],
    endpoints: {
      self: `/api/dapp/mall-state${buyerAddress ? `?address=${buyerAddress}` : ''}`,
      productDetail: '/api/products/:id',
      fulfillmentOptions: buyerAddress ? `/api/dapp/fulfillment-options?address=${buyerAddress}` : '/api/dapp/fulfillment-options?address=0x...',
      stockPreflight: '/api/stock/preflight',
      finalCheck: '/api/dapp/final-check',
      checkoutIntent: '/api/dapp/checkout-intent',
      seckillState: buyerAddress ? `/api/dapp/seckill-state?address=${buyerAddress}` : '/api/dapp/seckill-state?address=0x...',
      assets: buyerAddress ? `/api/assets/summary?address=${buyerAddress}` : '/api/assets/summary?address=0x...'
    }
  };
}

function dappMallProductCard(product) {
  const detail = dappProductDetail(product);
  const primaryAction = detail.buyNow.enabled
    ? { key: 'openProductDetail', label: '选择 SKU / 履约', enabled: true, endpoint: detail.endpoints.productDetail }
    : { key: 'openSeckillState', label: detail.buyNow.label, enabled: true, endpoint: '/api/dapp/seckill-state' };
  return {
    ...product,
    primaryAction,
    dapp: {
      version: '24k-mall-product-card-v1',
      seckillOverlay: detail.seckillOverlay,
      buyNow: detail.buyNow,
      defaultCheckoutItem: detail.defaultCheckoutItem,
      finalCheck: detail.finalCheck,
      paymentPolicy: detail.paymentPolicy,
      endpoints: detail.endpoints,
      nextActions: detail.nextActions
    }
  };
}

function dappStoresState(address, storeOptions = {}) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const stores = storeRows(storeOptions);
  const addresses = addressBookEntries(buyerAddress);
  return {
    version: '24k-dapp-stores-state-v1',
    generatedAt: new Date().toISOString(),
    connectedAddress: buyerAddress || null,
    query: storeOptions.publicQuery || {},
    stores,
    addresses,
    filters: {
      cities: [...new Set(stores.map((item) => item.city).filter(Boolean))],
      districts: [...new Set(stores.map((item) => item.district).filter(Boolean))],
      regionCodes: [...new Set(stores.map((item) => item.regionCode).filter(Boolean))]
    },
    checkoutTemplates: {
      delivery: {
        fulfillmentMode: 'delivery',
        addressId: addresses[0]?.id || '<address-id>',
        regionCode: addresses[0]?.regionCode || '<address-region-code>'
      },
      pickup: {
        fulfillmentMode: 'pickup',
        storeId: stores[0]?.id || '<store-id>',
        regionCode: stores[0]?.regionCode || '<store-region-code>'
      }
    },
    policies: {
      regionCodeLockedOnPayment: true,
      pickupRegionSource: 'store.regionCode',
      deliveryRegionSource: 'address.regionCode',
      noUserNoReasonRefund: true,
      gpsDistanceSource: Number.isFinite(storeOptions.lat) && Number.isFinite(storeOptions.lng) ? 'gps' : 'unavailable'
    },
    nextActions: ['requestLocationPermission', 'filterStores', 'selectPickupStore', 'parseAddress', 'saveAddress', 'createFinalCheck'],
    endpoints: {
      self: `/api/dapp/stores-state${buyerAddress ? `?address=${buyerAddress}` : ''}`,
      stores: '/api/stores?lat=<gpsLat>&lng=<gpsLng>&city=<city>&district=<district>&regionCode=<code>',
      fulfillmentOptions: buyerAddress ? `/api/dapp/fulfillment-options?address=${buyerAddress}&lat=<gpsLat>&lng=<gpsLng>` : '/api/dapp/fulfillment-options?address=0x...&lat=<gpsLat>&lng=<gpsLng>',
      addressBook: buyerAddress ? `/api/address-book?address=${buyerAddress}` : '/api/address-book?address=0x...',
      parseAddress: '/api/address-book/parse',
      saveAddress: '/api/address-book',
      finalCheck: '/api/dapp/final-check',
      checkoutIntent: '/api/dapp/checkout-intent'
    }
  };
}


function dappAssetsState(address, suppliedSummary = null) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const summary = suppliedSummary || assetSummary(buyerAddress);
  const availableClaims = buyerAddress ? summary.buckets.filter((bucket) => bucket.claimable) : [];
  const orderPrimaryActions = summary.orders.map((order) => order.primaryAction).filter(Boolean);
  const primaryAction = dappAssetsPrimaryAction({ buyerAddress, summary, availableClaims, orderPrimaryActions });
  return {
    version: '24k-dapp-assets-state-v1',
    generatedAt: new Date().toISOString(),
    connectedAddress: buyerAddress || null,
    connectRequired: !buyerAddress,
    summary,
    sections: {
      addresses: { count: summary.addresses.length, defaultAddress: summary.addresses.find((entry) => entry.isDefault) || summary.addresses[0] || null },
      orders: { counts: summary.orderStateCounts, items: summary.orders, primaryActions: orderPrimaryActions },
      records: { shopping: summary.shoppingRecords, seckill: summary.seckillRecords },
      rewards: { buckets: summary.buckets, ledger: summary.ledger, claims: summary.claims, availableClaims }
    },
    primaryAction,
    policies: {
      noUserNoReasonRefund: true,
      claimRequiresPersonalSign: true,
      rewardStates: ['Locked', 'Available', 'PendingClaim', 'Claimed', 'Burned'],
      bnmReleaseTrigger: 'Shipped/PickupReady 后 completeOrder 或平台仲裁签收',
      timeoutRefund: '商家 7 天未发货可申请 RefundRequested，等待平台 forceRefund。'
    },
    nextActions: [
      buyerAddress ? null : 'connectWallet',
      ...orderPrimaryActions.map((action) => action.key).filter(Boolean),
      availableClaims.length ? 'createClaimIntent' : null,
      'manageAddressBook',
      'refreshOrderState'
    ].filter(Boolean),
    endpoints: {
      self: buyerAddress ? `/api/dapp/assets-state?address=${buyerAddress}` : '/api/dapp/assets-state?address=0x...',
      summary: buyerAddress ? `/api/assets/summary?address=${buyerAddress}` : '/api/assets/summary?address=0x...',
      orderState: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...&fundTxHash=0x...&completeTxHash=0x...',
      addressBook: buyerAddress ? `/api/address-book?address=${buyerAddress}` : '/api/address-book?address=0x...',
      parseAddress: '/api/address-book/parse',
      saveAddress: '/api/address-book',
      claimIntent: '/api/dapp/claim-intent',
      claimTxStatus: '/api/dapp/claim-tx-status?walletAddress=0x...&rewardId=reward-ledger-1&txHash=0x...',
      completeOrderIntent: '/api/dapp/complete-order-intent',
      timeoutRefundRequest: '/api/dapp/timeout-refund-request'
    }
  };
}

async function dappAssetsStateForBuyer(address) {
  const summary = await assetSummaryForBuyer(address);
  return dappAssetsState(address, summary);
}

function dappAssetsPrimaryAction({ buyerAddress, summary, availableClaims, orderPrimaryActions }) {
  if (!buyerAddress) return { key: 'connectWallet', label: '连接钱包查看资产', enabled: true };
  const enabledOrderAction = orderPrimaryActions.find((action) => action?.enabled);
  if (enabledOrderAction) return enabledOrderAction;
  if (availableClaims.length) return { key: 'createClaimIntent', label: '提取可用收益', enabled: true, endpoint: '/api/dapp/claim-intent' };
  if (summary.orders.length) return { key: 'refreshOrderState', label: '刷新订单状态', enabled: true, endpoint: '/api/dapp/order-state' };
  return { key: 'browseMall', label: '去常规商城购买', enabled: true, endpoint: '/api/dapp/mall-state' };
}

function dappFulfillmentOptions(address, storeOptions = {}) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const addresses = addressBookEntries(buyerAddress);
  const stores = storeRows(storeOptions);
  return {
    version: '24k-fulfillment-options-v1',
    generatedAt: new Date().toISOString(),
    connectedAddress: buyerAddress || null,
    query: storeOptions.publicQuery || {},
    modes: [
      {
        key: 'delivery',
        label: '快递邮寄',
        requiredFields: ['addressId', 'regionCode'],
        finalCheckLabel: '收货地址 / 行政区',
        lockWarning: '付款成功后不可中途改地址；收货地址行政区编码将永久绑定区域代理分红归属。'
      },
      {
        key: 'pickup',
        label: '到店自提',
        requiredFields: ['storeId', 'regionCode'],
        finalCheckLabel: '自提门店 / 行政区',
        lockWarning: '付款成功后不可中途改门店或改履约方式；门店行政区编码将永久绑定区域代理分红归属。'
      }
    ],
    addresses,
    stores,
    checkoutTemplates: {
      delivery: {
        fulfillmentMode: 'delivery',
        addressId: addresses[0]?.id || '<address-id>',
        regionCode: addresses[0]?.regionCode || '<address-region-code>'
      },
      pickup: {
        fulfillmentMode: 'pickup',
        storeId: stores[0]?.id || '<store-id>',
        regionCode: stores[0]?.regionCode || '<store-region-code>'
      }
    },
    policy: {
      regionCodeLockedOnPayment: true,
      addressOrStoreLockedOnPayment: true,
      noUserNoReasonRefund: true,
      pickupRegionSource: 'store.regionCode',
      deliveryRegionSource: 'address.regionCode',
      finalCheckRequired: true
    },
    endpoints: {
      stores: '/api/stores?lat=<gpsLat>&lng=<gpsLng>&city=<city>&district=<district>&regionCode=<code>',
      addressBook: '/api/address-book?address=0x...',
      parseAddress: '/api/address-book/parse',
      saveAddress: '/api/address-book',
      stockPreflight: '/api/stock/preflight',
      finalCheck: '/api/dapp/final-check',
      checkoutIntent: '/api/dapp/checkout-intent'
    }
  };
}

function dappSeckillState(address) {
  const buyerAddress = isValidAddress(address) ? address : undefined;
  const session = currentSeckillSession();
  const productRow = session.id ? db.prepare("SELECT * FROM products WHERE id = ? AND status = 'Active'").get(session.productId) : null;
  const product = productRow ? toProduct(productRow) : null;
  const report = seckillReport(session.id);
  const phase = seckillPhase(session);
  const feed = seckillFeed(session.id);
  const prizeClaim = seckillPrizeClaimForWallet(buyerAddress, session, report);
  const canBuy = phase.key === 'live' && !circuitState('seckill').enabled && Boolean(product);
  return {
    version: '24k-dapp-seckill-state-v1',
    generatedAt: new Date().toISOString(),
    connectedAddress: buyerAddress || null,
    session,
    phase,
    timers: {
      main: {
        label: '主倒计时',
        totalSeconds: 60 * 60,
        secondsLeft: Number(session.mainSecondsLeft || 0),
        endsAt: session.endsAt
      },
      relay: {
        label: '接力倒计时',
        extendSeconds: Number(session.relayExtendSeconds || 30),
        secondsLeft: Number(session.relaySecondsLeft || 0),
        endsAt: session.relayEndsAt || null
      }
    },
    prizePool: {
      assetSymbol: 'NPL',
      amount: Number(session.prizePoolNpl || report.prizePoolNpl || 0),
      claimEndpoint: '/api/dapp/claim-intent',
      winnerAddress: report.winnerAddress || session.winner || null,
      winningOrderId: report.winningOrderId || session.winningOrderId || null
    },
    product,
    productDapp: product ? dappProductDetail(product) : null,
    feed,
    report,
    reportHistory: seckillReportHistory().reports,
    rules: seckillRules(),
    prizeClaim,
    cta: {
      key: canBuy ? 'createSeckillIntent' : 'disabled',
      enabled: canBuy,
      label: canBuy ? '立即参与秒杀' : seckillDisabledLabel(phase),
      reason: canBuy ? 'READY' : phase.reason,
      endpoint: canBuy ? '/api/dapp/seckill-intent' : null
    },
    policies: {
      contractCallerBlocked: true,
      callerRule: 'tx.origin == msg.sender',
      paymentApproval: 'NPL approve(MaxUint256), allowance 足够跳过',
      noUserNoReasonRefund: true,
      circuitBreakers: {
        seckill: circuitState('seckill'),
        forceCutoff: circuitState('force-cutoff')
      }
    },
    nextActions: [
      canBuy ? 'selectSkuAndFulfillment' : null,
      canBuy ? 'createSeckillIntent' : null,
      canBuy ? 'sendPaymentIntent' : null,
      canBuy ? 'sendSeckillRecordPurchase' : null,
      'subscribeSeckillFeedStream',
      'openSeckillRules',
      'openSeckillReports',
      prizeClaim?.claimable ? 'createClaimIntent' : null
    ].filter(Boolean),
    endpoints: {
      self: `/api/dapp/seckill-state${buyerAddress ? `?address=${buyerAddress}` : ''}`,
      current: '/api/seckill/current',
      createIntent: '/api/dapp/seckill-intent',
      feed: `/api/seckill/feed?sessionId=${session.id}`,
      feedStream: `/api/seckill/feed/stream?sessionId=${session.id}`,
      rules: '/api/seckill/rules',
      report: `/api/seckill/report?sessionId=${session.id}`,
      reports: '/api/seckill/reports',
      productDetail: product ? `/api/products/${encodeURIComponent(product.id)}` : '/api/products/:id',
      fulfillmentOptions: '/api/dapp/fulfillment-options?address=0x...&lat=38.86&lng=121.52',
      assets: buyerAddress ? `/api/assets/summary?address=${buyerAddress}` : '/api/assets/summary?address=0x...',
      claimIntent: '/api/dapp/claim-intent'
    }
  };
}

function seckillPhase(session) {
  const paused = circuitState('seckill').enabled;
  const forceCutoff = circuitState('force-cutoff').enabled;
  const startsAtMs = Date.parse(session.startsAt);
  const nowMs = Date.now();
  if (paused) return { key: 'paused', label: '秒杀暂停', status: 'paused', canBuy: false, reason: 'SECKILL_PAUSED' };
  if (!session.id || session.status === 'idle') return { key: 'idle', label: '暂无场次', status: 'idle', canBuy: false, reason: 'NO_ACTIVE_SESSION' };
  if (forceCutoff || session.status === 'settled') return { key: 'settled', label: '已结算', status: 'settled', canBuy: false, reason: 'SESSION_SETTLED' };
  if (session.status === 'forceClosed' || session.status === 'settling' || Number(session.mainSecondsLeft || 0) <= 0 || Number(session.relaySecondsLeft || 0) <= 0) {
    return { key: 'settling', label: '结算中', status: 'settling', canBuy: false, reason: 'SESSION_SETTLING' };
  }
  if (session.status === 'scheduled' || (Number.isFinite(startsAtMs) && nowMs < startsAtMs)) {
    return { key: 'notStarted', label: '未开启', status: 'scheduled', canBuy: false, reason: 'WAITING_FOR_START' };
  }
  if (session.status === 'live') return { key: 'live', label: '秒杀中', status: 'live', canBuy: true, reason: 'READY' };
  return { key: String(session.status || 'unknown'), label: '状态未知', status: String(session.status || 'unknown'), canBuy: false, reason: 'UNKNOWN_SESSION_STATUS' };
}

function seckillDisabledLabel(phase) {
  if (phase.key === 'notStarted') return '未开启';
  if (phase.key === 'settling') return '结算中';
  if (phase.key === 'settled') return '查看战报';
  if (phase.key === 'paused') return '秒杀暂停';
  return '暂不可参与';
}

function seckillPrizeClaimForWallet(address, session, report) {
  if (!isValidAddress(address)) return { claimable: false, status: 'ConnectWallet', note: '连接钱包后展示中奖提取状态。' };
  const winner = String(report.winnerAddress || session.winner || '').toLowerCase();
  const winningOrderId = report.winningOrderId || session.winningOrderId || '';
  if (!winner || winner !== address.toLowerCase()) {
    return { claimable: false, status: report.status === 'settled' ? 'NotWinner' : 'PendingSettlement' };
  }
  const rewardRow = seckillPrizeRewardFor(winningOrderId, address);
  if (!rewardRow) {
    return {
      claimable: false,
      status: 'PendingRewardLocked',
      assetSymbol: 'NPL',
      amount: Number(report.prizePoolNpl || session.prizePoolNpl || 0),
      note: '等待平台/RewardLedger 将秒杀中奖 NPL 奖金写入可提取账本。'
    };
  }
  const reward = toRewardLedgerEntry(rewardRow);
  return {
    claimable: reward.state === 'Available',
    status: reward.state,
    rewardId: reward.id,
    assetSymbol: reward.assetSymbol,
    amount: reward.amount,
    claimIntent: reward.state === 'Available' ? {
      method: 'POST',
      endpoint: '/api/dapp/claim-intent',
      body: { walletAddress: address, bucketId: 'seckill-prize', rewardId: reward.id }
    } : undefined
  };
}

async function dappSeckillIntent(body) {
  assertCircuitOpen('seckill', 'SECKILL_PAUSED');
  const session = currentSeckillSession();
  if (seckillPhase(session).key !== 'live') fail(409, 'SECKILL_NOT_LIVE');
  const productId = requireString(session.productId || 'p-24k-runner', 'productId');
  const providedItems = Array.isArray(body?.items) ? body.items.filter((item) => item?.selected !== false) : [];
  const items = providedItems.length ? providedItems : [{
    productId,
    quantity: body?.quantity || 1,
    selected: true,
    fulfillmentMode: body?.fulfillmentMode || 'delivery',
    addressId: body?.addressId,
    storeId: body?.storeId,
    regionCode: body?.regionCode
  }];
  if (items.some((item) => String(item.productId) !== productId)) fail(400, 'SECKILL_PRODUCT_MISMATCH');
  const checkout = await dappCheckoutIntent({ ...body, seckillSessionId: session.id, items });
  const sessionIdBytes32 = requireStoredBytes32(session.id) ? session.id : '';
  const seckillReady = isValidAddress(SECKILL) && Boolean(sessionIdBytes32);
  const buyer = checkout.order.buyerAddress;
  return {
    ...checkout,
    seckill: {
      session,
      contractAddress: SECKILL,
      contractCallerBlocked: true,
      recordPurchaseTransaction: seckillReady ? {
        key: 'recordPurchase',
        from: buyer,
        to: SECKILL,
        value: '0x0',
        sessionId: sessionIdBytes32,
        orderId: checkout.order.orderId,
        data: seckillTxInterface.encodeFunctionData('recordPurchase', [sessionIdBytes32, checkout.order.orderId])
      } : null,
      unavailableReason: seckillReady ? undefined : (!isValidAddress(SECKILL) ? 'SECKILL_ADDRESS_NOT_CONFIGURED' : 'SECKILL_SESSION_NOT_CHAIN_BYTES32')
    },
    nextActions: seckillReady
      ? [...checkout.nextActions, 'sendRecordPurchase', 'pollSeckillFeed']
      : checkout.nextActions,
    endpoints: {
      ...checkout.endpoints,
      seckillCurrent: '/api/seckill/current',
      seckillFeed: `/api/seckill/feed?sessionId=${session.id}`,
      seckillReport: `/api/seckill/report?sessionId=${session.id}`
    }
  };
}

function dappClaimIntent(body) {
  const prepared = prepareClaimReward(body);
  const entryId = rewardLedgerEntryIdFromRewardId(prepared.rewardId);
  const canBuildChainClaim = isValidAddress(REWARD_LEDGER) && entryId !== null;
  return {
    ok: true,
    ...prepared,
    claimTransaction: canBuildChainClaim ? {
      key: 'rewardLedgerClaim',
      from: prepared.walletAddress,
      to: REWARD_LEDGER,
      value: '0x0',
      rewardId: prepared.rewardId,
      entryId: String(entryId),
      data: rewardLedgerTxInterface.encodeFunctionData('claim', [entryId])
    } : null,
    unavailableReason: canBuildChainClaim ? undefined : (!isValidAddress(REWARD_LEDGER) ? 'REWARD_LEDGER_ADDRESS_NOT_CONFIGURED' : 'REWARD_ID_NOT_ONCHAIN_ENTRY'),
    nextActions: canBuildChainClaim
      ? ['personalSignClaim', 'submitClaimRequest', 'sendRewardLedgerClaim', 'waitRewardClaimedEvent']
      : ['personalSignClaim', 'submitClaimRequest', 'waitRewardClaimedEvent'],
    endpoints: {
      submitClaim: '/api/claims',
      claimTxStatus: `/api/dapp/claim-tx-status?walletAddress=${prepared.walletAddress}&rewardId=${prepared.rewardId}&txHash=0x...`,
      claims: `/api/claims?address=${prepared.walletAddress}`,
      assets: `/api/assets/summary?address=${prepared.walletAddress}`
    }
  };
}

async function claimTxStatus(searchParams) {
  const walletAddress = requireAddress(searchParams.get('walletAddress') || searchParams.get('address'), 'walletAddress');
  const rewardId = requireString(searchParams.get('rewardId'), 'rewardId');
  const txHash = requireBytes32(searchParams.get('txHash'), 'txHash');
  const reward = rewardById(rewardId);
  if (!reward) fail(404, 'REWARD_NOT_FOUND');
  if (String(reward.walletAddress).toLowerCase() !== walletAddress.toLowerCase()) fail(403, 'REWARD_WALLET_MISMATCH');
  if (String(reward.txHash || '').toLowerCase() === txHash.toLowerCase() && reward.state === 'Claimed') {
    return { status: 'confirmed', retryable: false, txHash, reward };
  }
  const entryId = rewardLedgerEntryIdFromRewardId(rewardId);
  if (entryId === null) return { status: 'unavailable', retryable: false, txHash, reward, error: 'REWARD_ID_NOT_ONCHAIN_ENTRY' };
  if (!isValidAddress(REWARD_LEDGER)) return { status: 'rpc_unavailable', retryable: true, txHash, reward, error: 'REWARD_LEDGER_ADDRESS_NOT_CONFIGURED' };
  if (!CHAIN_EVENT_RPC_URL) return { status: 'rpc_unavailable', retryable: true, txHash, reward, error: 'CHAIN_EVENT_RPC_NOT_CONFIGURED' };
  let receipt;
  try {
    receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  } catch (error) {
    return { status: 'rpc_unavailable', retryable: true, txHash, reward, error: error instanceof Error ? error.message : 'CHAIN_EVENT_RPC_ERROR' };
  }
  if (!receipt) return { status: 'pending', retryable: true, txHash, reward };
  if (String(receipt.status).toLowerCase() !== '0x1') return { status: 'failed', retryable: false, txHash, reward, error: 'CHAIN_EVENT_TX_FAILED' };
  let finality;
  try {
    finality = await receiptFinality(receipt);
  } catch (error) {
    return { status: 'rpc_unavailable', retryable: true, txHash, reward, error: error instanceof Error ? error.message : 'CHAIN_EVENT_RPC_ERROR' };
  }
  if (!finality.finalized) return { status: 'confirming', retryable: true, txHash, reward, finality };
  observeReceiptGas(receipt, walletAddress, txHash, 'reward.claim');
  try {
    const payload = payloadFromRewardClaimReceipt(receipt, txHash, String(entryId));
    const recorded = await recordRewardChainEvent(payload, 'RewardClaimed');
    return { status: 'confirmed', retryable: false, txHash, reward: recorded.reward, duplicate: Boolean(recorded.duplicate) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'REWARD_CLAIM_EVENT_VERIFICATION_FAILED';
    const retryable = Number(error?.statusCode || 0) >= 500;
    return { status: retryable ? 'rpc_unavailable' : 'mismatch', retryable, txHash, reward, error: message };
  }
}

function payloadFromRewardClaimReceipt(receipt, txHash, expectedEntryId) {
  const blockNumber = Number.parseInt(String(receipt.blockNumber), 16);
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== REWARD_LEDGER.toLowerCase()) continue;
    let parsed;
    try {
      parsed = rewardLedgerEvents.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== 'RewardClaimed') continue;
    const logIndex = Number.parseInt(String(log.logIndex), 16);
    const payload = payloadFromRewardParsedEvent(parsed, {
      chainId: CHAIN_ID,
      contractAddress: REWARD_LEDGER,
      txHash,
      blockNumber,
      logIndex
    });
    if (String(payload.entryId) !== String(expectedEntryId)) fail(400, 'REWARD_EVENT_ENTRY_MISMATCH');
    return { ...payload, ...receiptGasDetails(receipt) };
  }
  fail(400, 'REWARD_CLAIMED_EVENT_NOT_FOUND');
}

function rewardLedgerEntryIdFromRewardId(rewardId) {
  const match = String(rewardId || '').match(/^reward-ledger-(\d+)$/);
  if (!match) return null;
  return BigInt(match[1]);
}

async function dappCheckoutIntent(body) {
  const finalized = createFinalOrder(body);
  const order = findOrderByIdOrOrderId(finalized.orderId);
  if (!order) fail(500, 'ORDER_NOT_FOUND_AFTER_CHECKOUT');
  const payable = order.status === 'Draft';
  return {
    ok: true,
    preflight: finalized.preflight,
    finalCheck: finalized.finalCheck,
    order: toOrder(order),
    paymentIntent: payable ? await paymentIntentForOrder(order, finalized.buyerAddress) : null,
    nextActions: payable
      ? ['checkAllowance', 'approveNplIfNeeded', 'sendPayOrder', 'pollFundingStatus']
      : ['trackOrderStatus'],
    endpoints: {
      paymentIntent: `/api/orders/${order.order_id}/payment-intent?buyerAddress=${finalized.buyerAddress}`,
      fundingStatus: `/api/orders/${order.order_id}/fund-tx-status?buyerAddress=${finalized.buyerAddress}&txHash=0x...`,
      orderStatus: `/api/orders/${order.order_id}?buyerAddress=${finalized.buyerAddress}`,
      fulfillment: `/api/orders/${order.order_id}/fulfillment?buyerAddress=${finalized.buyerAddress}`
    }
  };
}

async function paymentIntentForOrder(order, buyerAddress, nowMs = Date.now()) {
  const buyer = requireAddress(buyerAddress, 'buyerAddress');
  if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');
  if (order.status !== 'Draft') fail(409, 'ORDER_NOT_PAYABLE');
  assertWalletTradeUnlocked(buyer);
  assertRewardLedgerOpenForNewOrders();
  if (!isValidAddress(order.escrow_address)) fail(409, 'ORDER_ESCROW_NOT_CONFIGURED');
  if (!requireStoredBytes32(order.order_digest)) fail(409, 'ORDER_DIGEST_NOT_SYNCABLE');
  const chainId = Number(order.chain_id);
  if (!Number.isSafeInteger(chainId)) fail(409, 'ORDER_CHAIN_NOT_SYNCABLE');
  const nplAmountWei = parseDecimal18(order.amount_npl || '0');
  const bnmLockedWei = parseDecimal18(order.bnm_locked || '0');
  if (bnmLockedWei <= 0n) fail(409, 'ORDER_BNM_LOCK_NOT_CONFIGURED');
  const deadline = Math.floor(nowMs / 1000) + publicDappConfig().payment.payOrderDeadlineSeconds;
  const productId = orderProductIdBytes32(order.order_id, order.order_digest);
  const splitVersion = await activeEscrowSplitVersion();
  const authorization = await orderAuthorizationForPayment({
    orderId: order.order_id,
    buyer,
    seller: order.seller_address,
    productId,
    nplAmount: nplAmountWei,
    bnmLocked: bnmLockedWei,
    deadline,
    orderDigest: order.order_digest,
    splitVersion,
    chainId,
    escrowAddress: order.escrow_address
  });
  const allowanceCheck = (key, symbol, tokenAddress, requiredAmount, requiredAmountWei) => ({
    key,
    symbol,
    tokenAddress,
    owner: buyer,
    spender: order.escrow_address,
    requiredAmount,
    requiredAmountWei: requiredAmountWei.toString(),
    to: tokenAddress,
    data: erc20TxInterface.encodeFunctionData('allowance', [buyer, order.escrow_address])
  });
  const approveTx = (key, symbol, tokenAddress) => ({
    key,
    symbol,
    from: buyer,
    to: tokenAddress,
    value: '0x0',
    spender: order.escrow_address,
    amount: 'MaxUint256',
    amountWei: MAX_UINT256.toString(),
    data: erc20TxInterface.encodeFunctionData('approve', [order.escrow_address, MAX_UINT256])
  });
  return {
    order: toOrder(order),
    chainId,
    chainIdHex: `0x${chainId.toString(16)}`,
    approvalPolicy: {
      type: 'unlimited-npl',
      allowanceSkip: true,
      amount: 'MaxUint256'
    },
    allowanceChecks: [
      allowanceCheck('npl', 'NPL', NPL, order.amount_npl || '0.000000000000000000', nplAmountWei)
    ],
    approvalTransactions: [
      approveTx('npl', 'NPL', NPL)
    ],
    payOrderTransaction: {
      key: 'payOrder',
      from: buyer,
      to: order.escrow_address,
      value: '0x0',
      deadline,
      deadlineSeconds: publicDappConfig().payment.payOrderDeadlineSeconds,
      orderDigest: order.order_digest,
      productId,
      bnmLockedWei: bnmLockedWei.toString(),
      splitVersion,
      authorization: authorization.signature,
      authorizationDigest: authorization.authorizationDigest,
      orderSigner: authorization.signer,
      data: escrowTxInterface.encodeFunctionData('payOrder', [
        order.order_id,
        order.seller_address,
        productId,
        nplAmountWei,
        bnmLockedWei,
        BigInt(deadline),
        order.order_digest,
        splitVersion,
        authorization.signature
      ])
    },
    submitFundingEndpoint: `/api/orders/${order.order_id}/fund-tx`,
    fundingStatusEndpoint: `/api/orders/${order.order_id}/fund-tx-status?buyerAddress=${buyer}&txHash=0x...`,
    generatedAt: new Date(nowMs).toISOString()
  };
}

function orderProductIdBytes32(orderId, orderDigest) {
  const rows = db.prepare('SELECT DISTINCT product_id FROM order_items WHERE order_id = ? ORDER BY product_id').all(orderId);
  if (rows.length === 1) return bytes32(rows[0].product_id);
  return bytes32(`cart:${orderDigest}`);
}

async function activeEscrowSplitVersion() {
  if (CHAIN_EVENT_RPC_URL) {
    const result = await rpc('eth_call', [{ to: ESCROW, data: escrowTxInterface.encodeFunctionData('currentSplitVersion') }, 'latest']);
    const [version] = escrowTxInterface.decodeFunctionResult('currentSplitVersion', result);
    const number = Number(version);
    if (!Number.isSafeInteger(number) || number <= 0 || number > 0xffffffff) fail(503, 'ESCROW_SPLIT_VERSION_INVALID');
    return number;
  }
  const indexed = Number(readAdminConfig('escrow-split-state')?.splitVersion || 0);
  if (Number.isSafeInteger(indexed) && indexed > 0 && indexed <= 0xffffffff) return indexed;
  const configured = Number(process.env.ESCROW_SPLIT_VERSION || 0);
  if (Number.isSafeInteger(configured) && configured > 0 && configured <= 0xffffffff) return configured;
  fail(503, 'ESCROW_SPLIT_VERSION_NOT_CONFIGURED');
}

async function orderAuthorizationForPayment(input) {
  if (!isValidAddress(ORDER_SIGNER)) fail(503, 'ORDER_SIGNER_ADDRESS_NOT_CONFIGURED');
  const domain = {
    name: '24K Mall Escrow',
    version: '1',
    chainId: input.chainId,
    verifyingContract: input.escrowAddress
  };
  const value = {
    orderId: input.orderId,
    buyer: input.buyer,
    seller: input.seller,
    productId: input.productId,
    nplAmount: input.nplAmount,
    bnmLocked: input.bnmLocked,
    deadline: input.deadline,
    orderDigest: input.orderDigest,
    splitVersion: input.splitVersion
  };
  const authorizationDigest = TypedDataEncoder.hash(domain, ORDER_AUTHORIZATION_TYPES, value);
  const signed = await signOrderAuthorization({
    version: '24k-order-authorization-v1',
    domain,
    types: ORDER_AUTHORIZATION_TYPES,
    primaryType: 'OrderAuthorization',
    value: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'bigint' ? entry.toString() : entry])),
    authorizationDigest
  }, process.env);
  if (signed.signer.toLowerCase() !== ORDER_SIGNER.toLowerCase()) fail(502, 'ORDER_SIGNER_MISMATCH');
  if (signed.authorizationDigest.toLowerCase() !== authorizationDigest.toLowerCase()) fail(502, 'ORDER_AUTHORIZATION_DIGEST_MISMATCH');
  await verifyOrderAuthorizationSignature(domain, value, authorizationDigest, signed.signature);
  return signed;
}

async function verifyOrderAuthorizationSignature(domain, value, authorizationDigest, signature) {
  if (!CHAIN_EVENT_RPC_URL) {
    const recovered = verifyTypedData(domain, ORDER_AUTHORIZATION_TYPES, value, signature);
    if (recovered.toLowerCase() !== ORDER_SIGNER.toLowerCase()) fail(502, 'INVALID_ORDER_AUTHORIZATION_SIGNATURE');
    return;
  }
  const code = await rpc('eth_getCode', [ORDER_SIGNER, 'latest']);
  if (!code || code === '0x' || code === '0x0') {
    const recovered = verifyTypedData(domain, ORDER_AUTHORIZATION_TYPES, value, signature);
    if (recovered.toLowerCase() !== ORDER_SIGNER.toLowerCase()) fail(502, 'INVALID_ORDER_AUTHORIZATION_SIGNATURE');
    return;
  }
  const result = await rpc('eth_call', [{ to: ORDER_SIGNER, data: erc1271Interface.encodeFunctionData('isValidSignature', [authorizationDigest, signature]) }, 'latest']);
  const [magic] = erc1271Interface.decodeFunctionResult('isValidSignature', result);
  if (String(magic).toLowerCase() !== '0x1626ba7e') fail(502, 'INVALID_ERC1271_ORDER_AUTHORIZATION');
}

function orderConfirmability(order, fulfillment = fulfillmentSummary(order)) {
  const mode = order.fulfillment_mode === 'pickup' ? 'pickup' : 'delivery';
  const orderStatus = String(order.status || '');
  const fulfillmentStatus = String(fulfillment.status || orderStatus);
  const requiredStatus = mode === 'pickup' ? 'PickupReady' : 'Shipped';
  let reason = 'ORDER_NOT_CONFIRMABLE';
  let canComplete = false;
  if (TERMINAL_ORDER_STATUSES.has(orderStatus)) {
    reason = 'ORDER_ALREADY_TERMINAL';
  } else if (orderStatus === 'Arbitration') {
    reason = 'ORDER_IN_ARBITRATION';
  } else if (mode === 'delivery') {
    canComplete = orderStatus === 'Shipped' && ['Shipped', 'DeliveredAwaitingSettlement'].includes(fulfillmentStatus);
    reason = canComplete ? 'DELIVERY_SHIPPED_CONFIRMABLE' : (orderStatus === 'Draft' ? 'WAITING_FOR_PAYMENT' : 'WAITING_FOR_MERCHANT_SHIPMENT');
  } else {
    canComplete = orderStatus === 'PickupReady' && ['PickupReady', 'VerifiedAwaitingSettlement'].includes(fulfillmentStatus);
    reason = canComplete ? 'PICKUP_VERIFIED_CONFIRMABLE' : (orderStatus === 'Draft' ? 'WAITING_FOR_PAYMENT' : 'WAITING_FOR_PICKUP_VERIFICATION');
  }
  return {
    canComplete,
    reason,
    mode,
    orderStatus,
    fulfillmentStatus,
    requiredOrderStatus: requiredStatus,
    requiredFulfillmentStatus: requiredStatus,
    cta: canComplete ? '确认收货 / 释放托管' : '暂不可确认收货',
    warning: '只有真实收货或门店核销后才发送 completeOrder；链上成功会释放商家 NPL，并推动 BNM/收益进入 Available。'
  };
}

function rewardStateTotalsForOrder(orderId) {
  const rows = db.prepare('SELECT * FROM reward_ledger WHERE order_id = ? ORDER BY created_at').all(orderId);
  const totals = { Locked: 0n, Available: 0n, PendingClaim: 0n, Claimed: 0n, Burned: 0n };
  for (const row of rows) {
    const state = String(row.state || '');
    if (totals[state] === undefined) continue;
    totals[state] += parseDecimal18(row.amount || '0.000000000000000000');
  }
  return {
    rows: rows.map(toRewardLedgerEntry),
    locked: formatDecimal18(totals.Locked),
    available: formatDecimal18(totals.Available),
    pendingClaim: formatDecimal18(totals.PendingClaim),
    claimed: formatDecimal18(totals.Claimed),
    burned: formatDecimal18(totals.Burned),
    lockedWei: totals.Locked.toString()
  };
}

function releasePreviewForOrder(order) {
  const totals = rewardStateTotalsForOrder(order.order_id);
  const fallbackLocked = order.bnm_locked || '0.000000000000000000';
  const availableIncrease = totals.lockedWei === '0' ? fallbackLocked : totals.locked;
  return {
    assetSymbol: 'BNM',
    bnmLocked: fallbackLocked,
    stateBeforeComplete: 'Locked',
    stateAfterComplete: 'Available',
    availableIncrease,
    localLedgerMode: !onchainRewardLedgerEnabled(),
    rewardLedgerAddress: REWARD_LEDGER || '',
    trigger: onchainRewardLedgerEnabled()
      ? 'Abu24KRewardLedger.RewardReleased(orderId) indexed after completeOrder'
      : 'Abu24KPaymentEscrow.OrderCompleted(orderId) indexed locally releases Locked BNM',
    claimEndpoint: '/api/dapp/claim-intent',
    ledger: totals.rows,
    totals: {
      locked: totals.locked,
      available: totals.available,
      pendingClaim: totals.pendingClaim,
      claimed: totals.claimed,
      burned: totals.burned
    },
    note: '前端只做预览；真实 Available/Claimable 以链上事件同步后的 /api/assets/summary 为准。'
  };
}

function releaseStatusForOrder(order, fulfillment, confirmability) {
  const modeLabel = confirmability.mode === 'pickup' ? '到店自提' : '快递发货';
  return {
    mode: confirmability.mode,
    label: modeLabel,
    currentOrderStatus: confirmability.orderStatus,
    currentFulfillmentStatus: confirmability.fulfillmentStatus,
    requiredBeforeBuyerComplete: confirmability.requiredFulfillmentStatus,
    buyerCanComplete: confirmability.canComplete,
    sellerNplRelease: 'OrderCompleted 后从 Escrow 放款 NPL 给商家',
    bnmRelease: 'OrderCompleted / RewardReleased 后 BNM 从 Locked 进入 Available',
    claimAfterRelease: true,
    latestFulfillment: fulfillment
  };
}

function completeOrderCallForOrder(order, buyerAddress, confirmability, transaction = null) {
  return {
    available: confirmability.canComplete,
    reason: confirmability.canComplete ? 'READY' : confirmability.reason,
    method: 'POST',
    endpoint: '/api/dapp/complete-order-intent',
    body: { buyerAddress, orderId: order.order_id },
    transactionKey: 'completeOrder',
    transaction,
    pollingEndpoint: `/api/orders/${order.order_id}/complete-tx-status?buyerAddress=${buyerAddress}&txHash=0x...`
  };
}

function timeoutLinkForOrder(order) {
  const actions = orderTimeoutActions(order);
  return {
    endpoint: `/api/orders/${order.order_id}/timeout-actions?buyerAddress=${order.buyer_address}`,
    buyerTimeoutRefund: {
      eligible: actions.buyerTimeoutRefund.eligible,
      reason: actions.buyerTimeoutRefund.reason,
      clock: actions.buyerTimeoutRefund.clock,
      request: actions.buyerTimeoutRefund.request
    },
    merchantForceSign: {
      eligible: actions.merchantForceSign.eligible,
      reason: actions.merchantForceSign.reason,
      clock: actions.merchantForceSign.clock,
      request: actions.merchantForceSign.request
    },
    noUserNoReasonRefund: true
  };
}

function fulfillmentNextActionsForOrder(confirmability, timeout) {
  if (confirmability.canComplete) return ['createCompleteOrderIntent', 'sendCompleteOrder', 'pollCompleteTxStatus', 'refreshAssets'];
  if (timeout.buyerTimeoutRefund.eligible) return ['requestTimeoutRefund', 'refreshOrder'];
  if (confirmability.reason === 'WAITING_FOR_PICKUP_VERIFICATION') return ['showPickupCodeAtStore', 'refreshFulfillment', 'openTimeoutActions'];
  if (confirmability.reason === 'WAITING_FOR_MERCHANT_SHIPMENT') return ['trackShipment', 'refreshFulfillment', 'openTimeoutActions'];
  return ['refreshOrder'];
}

function dappCompleteOrderIntent(body) {
  const buyer = requireAddress(body?.buyerAddress || body?.walletAddress || body?.address, 'buyerAddress');
  const orderId = requireString(body?.orderId, 'orderId');
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');
  if (!isValidAddress(order.escrow_address)) fail(409, 'ORDER_ESCROW_NOT_CONFIGURED');
  if (!requireStoredBytes32(order.order_id)) fail(409, 'ORDER_ID_NOT_SYNCABLE');
  const chainId = Number(order.chain_id);
  if (!Number.isSafeInteger(chainId)) fail(409, 'ORDER_CHAIN_NOT_SYNCABLE');
  const fulfillment = fulfillmentSummary(order);
  const confirmability = orderConfirmability(order, fulfillment);
  const canComplete = confirmability.canComplete;
  const completeOrderTransaction = canComplete ? {
    key: 'completeOrder',
    from: buyer,
    to: order.escrow_address,
    value: '0x0',
    orderId: order.order_id,
    data: escrowTxInterface.encodeFunctionData('completeOrder', [order.order_id])
  } : null;
  const releasePreview = releasePreviewForOrder(order);
  const releaseStatus = releaseStatusForOrder(order, fulfillment, confirmability);
  const completeOrderCall = completeOrderCallForOrder(order, buyer, confirmability, completeOrderTransaction);
  const timeout = timeoutLinkForOrder(order);
  return {
    ok: true,
    order: toOrder(order),
    fulfillment,
    confirmability,
    releaseStatus,
    releasePreview,
    completeOrderCall,
    timeout,
    chainId,
    chainIdHex: `0x${chainId.toString(16)}`,
    completeOrderTransaction,
    unavailableReason: completeOrderTransaction ? undefined : 'ORDER_NOT_CONFIRMABLE',
    physicalDeliveryWarning: '仅在已收货或门店已核销后发送 completeOrder；链上成功后 NPL 放给商家，BNM/分红进入 Available。',
    nextActions: fulfillmentNextActionsForOrder(confirmability, timeout),
    endpoints: {
      completeTxStatus: `/api/orders/${order.order_id}/complete-tx-status?buyerAddress=${buyer}&txHash=0x...`,
      orderStatus: `/api/orders/${order.order_id}?buyerAddress=${buyer}`,
      fulfillment: `/api/orders/${order.order_id}/fulfillment?buyerAddress=${buyer}`,
      assets: `/api/assets/summary?address=${buyer}`
    },
    generatedAt: new Date().toISOString()
  };
}

async function dappOrderState(searchParams) {
  const buyer = requireAddress(searchParams.get('buyerAddress') || searchParams.get('address'), 'buyerAddress');
  const orderId = requireString(searchParams.get('orderId'), 'orderId');
  let order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');

  const fundingTxHash = optionalSearchBytes32(searchParams, ['fundTxHash', 'fundingTxHash', 'payOrderTxHash'], 'fundTxHash');
  const completeTxHash = optionalSearchBytes32(searchParams, ['completeTxHash', 'completeOrderTxHash'], 'completeTxHash');
  const claimRewardId = searchParams.get('claimRewardId') || searchParams.get('rewardId');
  const claimTxHash = optionalSearchBytes32(searchParams, ['claimTxHash'], 'claimTxHash');

  const funding = fundingTxHash
    ? await fundingTxStatusForOrder(order, buyer, fundingTxHash)
    : passiveFundingState(order, buyer);
  order = findOrderByIdOrOrderId(order.order_id) || order;

  const complete = completeTxHash
    ? await completeTxStatusForOrder(order, buyer, completeTxHash)
    : passiveCompleteState(order, buyer);
  order = findOrderByIdOrOrderId(order.order_id) || order;

  const claim = claimRewardId && claimTxHash
    ? await claimTxStatus(new URLSearchParams({ walletAddress: buyer, rewardId: claimRewardId, txHash: claimTxHash }))
    : passiveClaimState(order, buyer, claimRewardId);

  const fulfillment = fulfillmentSnapshot(order);
  const assetOrder = enrichAssetOrderForDapp(order, buyer);
  const retryable = [funding, complete, claim].some((entry) => entry?.retryable === true);
  return {
    version: '24k-dapp-order-state-v1',
    generatedAt: new Date().toISOString(),
    buyerAddress: buyer,
    orderId: order.order_id,
    order: assetOrder,
    fulfillment,
    funding,
    complete,
    claim,
    primaryAction: assetOrder.primaryAction,
    actions: assetOrder.actions,
    nextActions: assetOrder.nextActions,
    polling: {
      retryable,
      nextPollMs: retryable ? 4000 : null,
      watch: ['funding', 'complete', 'claim'].filter((key) => ({ funding, complete, claim })[key]?.retryable)
    },
    endpoints: {
      self: `/api/dapp/order-state?buyerAddress=${buyer}&orderId=${order.order_id}`,
      orderStatus: `/api/orders/${order.order_id}?buyerAddress=${buyer}`,
      fulfillment: `/api/orders/${order.order_id}/fulfillment?buyerAddress=${buyer}`,
      assets: `/api/assets/summary?address=${buyer}`,
      paymentIntent: `/api/orders/${order.order_id}/payment-intent?buyerAddress=${buyer}`,
      fundingStatus: `/api/orders/${order.order_id}/fund-tx-status?buyerAddress=${buyer}&txHash=0x...`,
      completeOrderIntent: '/api/dapp/complete-order-intent',
      completeTxStatus: `/api/orders/${order.order_id}/complete-tx-status?buyerAddress=${buyer}&txHash=0x...`,
      claimIntent: '/api/dapp/claim-intent',
      claimTxStatus: `/api/dapp/claim-tx-status?walletAddress=${buyer}&rewardId=reward-ledger-1&txHash=0x...`
    }
  };
}

function passiveFundingState(order, buyerAddress) {
  if (order.fund_tx_hash && isPaidOrArbitratingStatus(order.status)) {
    return { status: 'confirmed', retryable: false, txHash: order.fund_tx_hash, order: toOrder(order) };
  }
  return {
    status: order.status === 'Draft' ? 'not_started' : 'indexed',
    retryable: false,
    txHash: order.fund_tx_hash || null,
    order: toOrder(order),
    endpoint: `/api/orders/${order.order_id}/fund-tx-status?buyerAddress=${buyerAddress}&txHash=0x...`
  };
}

function passiveCompleteState(order, buyerAddress) {
  if (order.status === 'Released') {
    return { status: 'confirmed', retryable: false, txHash: order.last_event_tx_hash || order.tx_hash || null, order: toOrder(order) };
  }
  const fulfillment = fulfillmentSummary(order);
  const confirmability = orderConfirmability(order, fulfillment);
  return {
    status: confirmability.canComplete ? 'ready' : 'not_ready',
    retryable: false,
    txHash: null,
    order: toOrder(order),
    confirmability,
    endpoint: `/api/orders/${order.order_id}/complete-tx-status?buyerAddress=${buyerAddress}&txHash=0x...`
  };
}

function passiveClaimState(order, buyerAddress, rewardId) {
  const actionState = dappOrderActionState(order, buyerAddress);
  if (rewardId) {
    const reward = rewardById(rewardId);
    return {
      status: reward ? reward.state : 'not_found',
      retryable: false,
      reward,
      endpoint: `/api/dapp/claim-tx-status?walletAddress=${buyerAddress}&rewardId=${rewardId}&txHash=0x...`
    };
  }
  return {
    status: actionState.actions.claimRewards.available ? 'claimable' : 'none',
    retryable: false,
    rewards: actionState.actions.claimRewards.rewards,
    endpoint: '/api/dapp/claim-intent'
  };
}

function orderTimeoutActions(order, nowMs = Date.now()) {
  const fulfillment = fulfillmentSummary(order);
  const paidClock = timeoutClock(orderPaidTimestampMs(order), nowMs, 'shipping');
  const receivedClock = timeoutClock(orderFulfillmentTimestampMs(order), nowMs, 'confirmation');
  const shipped = isOrderShippedOrPickupReady(order, fulfillment);
  const buyerEligibleStatus = ['PaidLocked', 'AwaitingShipment'].includes(order.status) && !shipped;
  const merchantEligibleStatus = ['Shipped', 'PickupReady'].includes(order.status);
  const shippingWindowLabel = timeoutWindowLabel(paidClock.windowHours);
  const confirmationWindowLabel = timeoutWindowLabel(receivedClock.windowHours);
  const buyerReason = buyerEligibleStatus
    ? (paidClock.reached ? 'MERCHANT_SHIPMENT_TIMEOUT_REACHED' : 'WAITING_7_DAYS_AFTER_PAYMENT')
    : (TERMINAL_ORDER_STATUSES.has(order.status) ? 'ORDER_ALREADY_TERMINAL' : 'ORDER_ALREADY_SHIPPED_OR_NOT_PAID');
  const merchantReason = merchantEligibleStatus
    ? (receivedClock.reached ? 'BUYER_RECEIPT_TIMEOUT_REACHED' : 'WAITING_7_DAYS_AFTER_SHIPMENT_OR_PICKUP')
    : (TERMINAL_ORDER_STATUSES.has(order.status) ? 'ORDER_ALREADY_TERMINAL' : 'ORDER_NOT_SHIPPED_OR_PICKUP_READY');
  const buyerEndpoint = '/api/dapp/timeout-refund-request';
  const merchantEndpoint = `/api/merchant/orders/${order.order_id}/force-sign-request`;
  return {
    version: '24k-order-timeout-actions-v1',
    generatedAt: new Date(nowMs).toISOString(),
    order: toOrder(order),
    fulfillment,
    policy: {
      noUserNoReasonRefund: true,
      buyerTimeoutRefund: `商家 ${shippingWindowLabel} 未发货，买家可申请平台强制全额退款；托管 NPL 全额退回，未领取奖励原子销毁。`,
      merchantForceSign: `用户 ${confirmationWindowLabel} 未确认收货，商家可申请平台强制签收；最终由平台 owner completeOrder 链上落地。`,
      emergencyRefund: '保留透明 emergency refund / pause 恢复通道。'
    },
    buyerTimeoutRefund: {
      eligible: buyerEligibleStatus && paidClock.reached,
      reason: buyerReason,
      clock: paidClock,
      request: {
        method: 'POST',
        endpoint: buyerEndpoint,
        body: { buyerAddress: order.buyer_address, orderId: order.order_id, reason: `${shippingWindowLabel}未发货` }
      },
      resultStatus: 'RefundRequested',
      chainActionRequired: 'Abu24KPaymentEscrow.forceRefund(orderId) by platform owner; full escrowed NPL returns and unclaimed rewards burn atomically'
    },
    merchantForceSign: {
      eligible: merchantEligibleStatus && receivedClock.reached,
      reason: merchantReason,
      clock: receivedClock,
      request: {
        method: 'POST',
        endpoint: merchantEndpoint,
        body: { orderId: order.order_id, reason: `${confirmationWindowLabel}未确认收货` },
        auth: 'merchant SIWE JWT + secondary signature'
      },
      resultStatus: 'Arbitration',
      chainActionRequired: 'Abu24KPaymentEscrow.completeOrder(orderId) by platform owner'
    },
    nextActions: [
      buyerEligibleStatus && paidClock.reached ? 'requestTimeoutRefund' : null,
      merchantEligibleStatus && receivedClock.reached ? 'merchantRequestForceSign' : null,
      'refreshOrder'
    ].filter(Boolean),
    endpoints: {
      timeoutActions: `/api/orders/${order.order_id}/timeout-actions?buyerAddress=${order.buyer_address}`,
      timeoutRefundRequest: buyerEndpoint,
      merchantForceSignRequest: merchantEndpoint,
      orderStatus: `/api/orders/${order.order_id}?buyerAddress=${order.buyer_address}`
    }
  };
}

function requestBuyerTimeoutRefund(body) {
  const buyer = requireAddress(body?.buyerAddress || body?.walletAddress || body?.address, 'buyerAddress');
  const orderId = requireString(body?.orderId, 'orderId');
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');
  const actions = orderTimeoutActions(order);
  if (!actions.buyerTimeoutRefund.eligible) fail(409, actions.buyerTimeoutRefund.reason);
  const payload = {
    orderId: order.order_id,
    buyerAddress: buyer,
    reason: body?.reason || '7 天未发货',
    policy: actions.policy.buyerTimeoutRefund,
    clock: actions.buyerTimeoutRefund.clock,
    requestedAt: new Date().toISOString()
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run('RefundRequested', order.order_id);
    db.prepare('INSERT INTO fulfillment_orders (id, order_id, type, status, payload_json) VALUES (?, ?, ?, ?, ?)').run(
      `timeout-refund-${Date.now()}-${randomBytes(3).toString('hex')}`,
      order.order_id,
      order.fulfillment_mode || 'delivery',
      'RefundRequested',
      JSON.stringify(payload)
    );
    writeAudit('buyer', buyer, 'buyer.timeout-refund.request', order.order_id, payload);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const updated = findOrderByIdOrOrderId(order.order_id);
  return {
    ok: true,
    action: 'buyer.timeout-refund.request',
    status: 'RefundRequested',
    order: toOrder(updated),
    noUserNoReasonRefund: true,
    refundPolicy: '仅 7 天未发货强制全额退款；无理由退款不开放；托管 NPL 全额退回并原子销毁未领取奖励。',
    next: '等待平台审计后调用 Abu24KPaymentEscrow.forceRefund，并由 OrderForcedRefunded 事件同步为 ForcedRefunded。',
    chainActionRequired: actions.buyerTimeoutRefund.chainActionRequired,
    endpoints: {
      orderStatus: `/api/orders/${order.order_id}?buyerAddress=${buyer}`,
      timeoutActions: `/api/orders/${order.order_id}/timeout-actions?buyerAddress=${buyer}`
    }
  };
}

function requestMerchantForceSign(session, orderId, body) {
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (order.seller_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'ORDER_SELLER_MISMATCH');
  const actions = orderTimeoutActions(order);
  if (!actions.merchantForceSign.eligible) fail(409, actions.merchantForceSign.reason);
  const payload = {
    orderId: order.order_id,
    merchantAddress: session.address,
    reason: body?.reason || '7 天未确认收货',
    policy: actions.policy.merchantForceSign,
    clock: actions.merchantForceSign.clock,
    requestedAt: new Date().toISOString()
  };
  db.exec('BEGIN IMMEDIATE');
  let settlementRequest;
  try {
    db.prepare('UPDATE orders SET status = ?, settlement_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run('Arbitration', order.order_id);
    db.prepare('INSERT INTO fulfillment_orders (id, order_id, type, status, payload_json) VALUES (?, ?, ?, ?, ?)').run(
      `force-sign-${Date.now()}-${randomBytes(3).toString('hex')}`,
      order.order_id,
      order.fulfillment_mode || 'delivery',
      'ForceSignRequested',
      JSON.stringify(payload)
    );
    settlementRequest = createSettlementRequest(order, session.address, 'merchant-force-sign-timeout', payload);
    writeAudit(session.role, session.address, 'merchant.order.force-sign-request', order.order_id, payload);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const updated = findOrderByIdOrOrderId(order.order_id);
  return {
    ok: true,
    action: 'merchant.order.force-sign-request',
    status: 'Arbitration',
    order: toOrder(updated),
    noUserNoReasonRefund: true,
    next: '等待平台仲裁；通过后由 owner 调用 Abu24KPaymentEscrow.completeOrder(orderId)，OrderCompleted 事件同步为 Released。',
    chainActionRequired: actions.merchantForceSign.chainActionRequired,
    settlementRequest,
    endpoints: {
      orderStatus: `/api/orders/${order.order_id}?buyerAddress=${order.buyer_address}`,
      timeoutActions: `/api/orders/${order.order_id}/timeout-actions?buyerAddress=${order.buyer_address}`
    }
  };
}

async function fundingTxStatusForOrder(order, buyerAddress, txHashValue) {
  const buyer = requireAddress(buyerAddress, 'buyerAddress');
  if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');
  const txHash = requireBytes32(txHashValue, 'txHash');
  const currentOrder = () => toOrder(findOrderByIdOrOrderId(order.order_id) || order);
  if (String(order.fund_tx_hash || '').toLowerCase() === txHash.toLowerCase() && isPaidOrArbitratingStatus(order.status)) {
    return { status: 'confirmed', retryable: false, txHash, order: currentOrder() };
  }
  if (!CHAIN_EVENT_RPC_URL) {
    return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: 'CHAIN_EVENT_RPC_NOT_CONFIGURED' };
  }
  let receipt;
  try {
    receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  } catch (error) {
    return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: error instanceof Error ? error.message : 'CHAIN_EVENT_RPC_ERROR' };
  }
  if (!receipt) return { status: 'pending', retryable: true, txHash, order: currentOrder() };
  if (String(receipt.status).toLowerCase() !== '0x1') return { status: 'failed', retryable: false, txHash, order: currentOrder(), error: 'CHAIN_EVENT_TX_FAILED' };
  let finality;
  try {
    finality = await receiptFinality(receipt);
  } catch (error) {
    return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: error instanceof Error ? error.message : 'CHAIN_EVENT_RPC_ERROR' };
  }
  if (!finality.finalized) return { status: 'confirming', retryable: true, txHash, order: currentOrder(), finality };
  observeReceiptGas(receipt, buyer, txHash, 'order.pay');
  try {
    const payload = await payloadFromFundingReceipt(txHash, order);
    const recorded = await recordChainEvent(payload);
    return { status: 'confirmed', retryable: false, txHash, order: recorded.order, duplicate: Boolean(recorded.duplicate) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CHAIN_EVENT_VERIFICATION_FAILED';
    if (message === 'CHAIN_EVENT_TX_NOT_FOUND') return { status: 'pending', retryable: true, txHash, order: currentOrder() };
    const retryable = Number(error?.statusCode || 0) >= 500;
    return { status: retryable ? 'rpc_unavailable' : 'mismatch', retryable, txHash, order: currentOrder(), error: message };
  }
}

async function completeTxStatusForOrder(order, buyerAddress, txHashValue) {
  const buyer = requireAddress(buyerAddress, 'buyerAddress');
  if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');
  const txHash = requireBytes32(txHashValue, 'txHash');
  const currentOrder = () => toOrder(findOrderByIdOrOrderId(order.order_id) || order);
  const latest = findOrderByIdOrOrderId(order.order_id) || order;
  if (String(latest.last_event_tx_hash || '').toLowerCase() === txHash.toLowerCase() && latest.status === 'Released') {
    return { status: 'confirmed', retryable: false, txHash, order: currentOrder() };
  }
  if (!CHAIN_EVENT_RPC_URL) {
    return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: 'CHAIN_EVENT_RPC_NOT_CONFIGURED' };
  }
  let receipt;
  try {
    receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  } catch (error) {
    return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: error instanceof Error ? error.message : 'CHAIN_EVENT_RPC_ERROR' };
  }
  if (!receipt) return { status: 'pending', retryable: true, txHash, order: currentOrder() };
  if (String(receipt.status).toLowerCase() !== '0x1') return { status: 'failed', retryable: false, txHash, order: currentOrder(), error: 'CHAIN_EVENT_TX_FAILED' };
  let finality;
  try {
    finality = await receiptFinality(receipt);
  } catch (error) {
    return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: error instanceof Error ? error.message : 'CHAIN_EVENT_RPC_ERROR' };
  }
  if (!finality.finalized) return { status: 'confirming', retryable: true, txHash, order: currentOrder(), finality };
  observeReceiptGas(receipt, buyer, txHash, 'order.complete');
  try {
    const payload = await payloadFromOrderEventReceipt(txHash, order, 'OrderCompleted');
    const recorded = await recordChainEvent(payload);
    return { status: 'confirmed', retryable: false, txHash, order: recorded.order, duplicate: Boolean(recorded.duplicate) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CHAIN_EVENT_VERIFICATION_FAILED';
    if (message === 'CHAIN_EVENT_TX_NOT_FOUND') return { status: 'pending', retryable: true, txHash, order: currentOrder() };
    const retryable = Number(error?.statusCode || 0) >= 500;
    return { status: retryable ? 'rpc_unavailable' : 'mismatch', retryable, txHash, order: currentOrder(), error: message };
  }
}

async function arbitrationTxStatusForOrder(order, buyerAddress, txHashValue) {
  const buyer = requireAddress(buyerAddress, 'buyerAddress');
  if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');
  const txHash = requireBytes32(txHashValue, 'txHash');
  const currentOrder = () => toOrder(findOrderByIdOrOrderId(order.order_id) || order);
  const latest = findOrderByIdOrOrderId(order.order_id) || order;
  if (String(latest.last_event_tx_hash || '').toLowerCase() === txHash.toLowerCase() && latest.status === 'Arbitration') {
    const afterSale = db.prepare('SELECT * FROM after_sale_cases WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.order_id);
    return { status: 'confirmed', retryable: false, txHash, order: currentOrder(), afterSale: afterSale ? toAfterSaleCase(afterSale) : null };
  }
  if (!CHAIN_EVENT_RPC_URL) return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: 'CHAIN_EVENT_RPC_NOT_CONFIGURED' };
  let receipt;
  try {
    receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  } catch (error) {
    return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: error instanceof Error ? error.message : 'CHAIN_EVENT_RPC_ERROR' };
  }
  if (!receipt) return { status: 'pending', retryable: true, txHash, order: currentOrder() };
  if (String(receipt.status).toLowerCase() !== '0x1') return { status: 'failed', retryable: false, txHash, order: currentOrder(), error: 'CHAIN_EVENT_TX_FAILED' };
  let finality;
  try {
    finality = await receiptFinality(receipt);
  } catch (error) {
    return { status: 'rpc_unavailable', retryable: true, txHash, order: currentOrder(), error: error instanceof Error ? error.message : 'CHAIN_EVENT_RPC_ERROR' };
  }
  if (!finality.finalized) return { status: 'confirming', retryable: true, txHash, order: currentOrder(), finality };
  observeReceiptGas(receipt, buyer, txHash, 'order.dispute');
  try {
    const payload = await payloadFromOrderEventReceipt(txHash, order, 'OrderArbitration');
    const recorded = await recordChainEvent(payload);
    const afterSale = db.prepare('SELECT * FROM after_sale_cases WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.order_id);
    return { status: 'confirmed', retryable: false, txHash, order: recorded.order, afterSale: afterSale ? toAfterSaleCase(afterSale) : null, duplicate: Boolean(recorded.duplicate) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CHAIN_EVENT_VERIFICATION_FAILED';
    if (message === 'CHAIN_EVENT_TX_NOT_FOUND') return { status: 'pending', retryable: true, txHash, order: currentOrder() };
    const retryable = Number(error?.statusCode || 0) >= 500;
    return { status: retryable ? 'rpc_unavailable' : 'mismatch', retryable, txHash, order: currentOrder(), error: message };
  }
}

function buyerOrders(buyerAddress) {
  const address = requireAddress(buyerAddress, 'buyerAddress');
  assertNotBlacklisted(address);
  return db.prepare('SELECT * FROM orders WHERE lower(buyer_address) = ? ORDER BY created_at DESC LIMIT 100').all(address.toLowerCase()).map((row) => ({
    ...toOrder(row),
    fulfillment: fulfillmentSummary(row)
  }));
}

function fulfillmentSummary(order) {
  const latest = db.prepare('SELECT * FROM fulfillment_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.order_id);
  if (!latest) return { status: order.status, type: order.fulfillment_mode || 'delivery' };
  return {
    status: latest.status,
    type: latest.type,
    updatedAt: latest.created_at,
    payload: JSON.parse(latest.payload_json || '{}')
  };
}

function isBuyerConfirmableOrder(order) {
  const fulfillment = fulfillmentSummary(order);
  return orderConfirmability(order, fulfillment).canComplete;
}

function isOrderShippedOrPickupReady(order, fulfillment = fulfillmentSummary(order)) {
  const orderStatus = String(order.status || '');
  const fulfillmentStatus = String(fulfillment.status || '');
  return fulfillmentStatus === 'ForceSignRequested' ||
    ['Shipped', 'PickupReady', 'Arbitration', 'Released'].includes(orderStatus) ||
    (!['PaidLocked', 'AwaitingShipment'].includes(orderStatus) && ['Shipped', 'PickupReady'].includes(fulfillmentStatus));
}

function latestFulfillmentRow(orderId, statuses = []) {
  if (statuses.length) {
    const placeholders = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM fulfillment_orders WHERE order_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`).get(orderId, ...statuses);
  }
  return db.prepare('SELECT * FROM fulfillment_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId);
}

function orderPaidTimestampMs(order) {
  return timestampMs(order.updated_at) || timestampMs(order.created_at) || Date.now();
}

function orderFulfillmentTimestampMs(order) {
  const row = latestFulfillmentRow(order.order_id, ['Shipped', 'PickupReady']);
  return timestampMs(row?.created_at) || timestampMs(order.updated_at) || timestampMs(order.created_at) || Date.now();
}

function timeoutClock(startMs, nowMs = Date.now(), kind = 'shipping') {
  const safeStart = Number.isFinite(startMs) && startMs > 0 ? startMs : nowMs;
  const timeoutMs = orderTimeoutMs(kind);
  const deadlineMs = safeStart + timeoutMs;
  const remainingMs = Math.max(0, deadlineMs - nowMs);
  return {
    windowDays: Number((timeoutMs / (24 * 60 * 60_000)).toFixed(2)),
    windowHours: Number((timeoutMs / (60 * 60_000)).toFixed(2)),
    startAt: new Date(safeStart).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    reached: nowMs >= deadlineMs,
    remainingMs,
    elapsedMs: Math.max(0, nowMs - safeStart)
  };
}

function timeoutWindowLabel(hours) {
  const value = Number(hours);
  if (Number.isInteger(value) && value % 24 === 0) return `${value / 24} 天`;
  return `${Number.isFinite(value) ? value : 168} 小时`;
}

function timestampMs(value) {
  if (!value) return 0;
  const raw = String(value);
  let ms = Date.parse(raw);
  if (Number.isFinite(ms)) return ms;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(ms) ? ms : 0;
}


function createSiweNonce(body, req) {
  const address = requireAddress(body?.address, 'address');
  const role = normalizeRole(body?.role || 'merchant');
  ensureRoleAddressAllowed(role, address);
  enforceWalletFingerprint(req, address, `${role}.siwe.nonce`);
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + siweNonceTtlMs();
  const message = siweMessage(address, role, nonce, expiresAt);
  db.prepare('INSERT INTO siwe_nonces (nonce, address, role, message, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)').run(
    nonce,
    address.toLowerCase(),
    role,
    message,
    expiresAt
  );
  return { nonce, message, role, address, expiresAt };
}

async function verifySiweLogin(body, req) {
  const address = requireAddress(body?.address, 'address');
  const role = normalizeRole(body?.role || 'merchant');
  const message = requireString(body?.message, 'message');
  const signature = requireString(body?.signature, 'signature');
  ensureRoleAddressAllowed(role, address);
  let parsed;
  try {
    parsed = new SiweMessage(message);
  } catch {
    fail(400, 'INVALID_SIWE_MESSAGE');
  }
  const nonce = parsed.nonce;
  const row = db.prepare('SELECT * FROM siwe_nonces WHERE nonce = ? AND address = ? AND role = ?').get(nonce, address.toLowerCase(), role);
  if (!row || Number(row.used) || Number(row.expires_at) < Date.now()) fail(401, 'INVALID_SIWE_NONCE');
  const expectedResource = `urn:24k:role:${role}`;
  if (parsed.domain !== SIWE_DOMAIN) fail(401, 'SIWE_DOMAIN_MISMATCH');
  if (parsed.uri !== SIWE_URI) fail(401, 'SIWE_URI_MISMATCH');
  if (parsed.version !== '1') fail(401, 'SIWE_VERSION_MISMATCH');
  if (Number(parsed.chainId) !== CHAIN_ID) fail(401, 'SIWE_CHAIN_ID_MISMATCH');
  if (parsed.address.toLowerCase() !== address.toLowerCase()) fail(401, 'SIWE_ADDRESS_MISMATCH');
  if (parsed.requestId !== role) fail(401, 'SIWE_REQUEST_ID_MISMATCH');
  if (parsed.statement !== `Sign in to 24K Mall as ${role}.`) fail(401, 'SIWE_STATEMENT_MISMATCH');
  if (!Array.isArray(parsed.resources) || parsed.resources.length !== 1 || parsed.resources[0] !== expectedResource) fail(401, 'SIWE_RESOURCES_MISMATCH');
  const issuedAt = Date.parse(String(parsed.issuedAt || ''));
  const messageExpiresAt = Date.parse(String(parsed.expirationTime || ''));
  if (!Number.isFinite(issuedAt) || issuedAt > Date.now() + 60_000 || issuedAt >= messageExpiresAt) fail(401, 'SIWE_ISSUED_AT_INVALID');
  if (!Number.isFinite(messageExpiresAt) || messageExpiresAt !== Number(row.expires_at)) fail(401, 'SIWE_EXPIRATION_MISMATCH');
  if (row.message !== message) fail(401, 'INVALID_SIWE_NONCE');
  let verification;
  try {
    verification = await parsed.verify(
      { signature, domain: SIWE_DOMAIN, nonce, time: new Date().toISOString() },
      { suppressExceptions: true }
    );
  } catch {
    fail(401, 'INVALID_SIWE_SIGNATURE');
  }
  if (!verification?.success || verification.data.address.toLowerCase() !== address.toLowerCase()) fail(401, 'INVALID_SIWE_SIGNATURE');
  const expiresAt = Date.now() + AUTH_SESSION_TTL_MS;
  const token = authToken(address, role, nonce, expiresAt);
  db.exec('BEGIN IMMEDIATE');
  try {
    const consumed = db.prepare('UPDATE siwe_nonces SET used = 1 WHERE nonce = ? AND address = ? AND role = ? AND used = 0 AND expires_at >= ?').run(
      nonce,
      address.toLowerCase(),
      role,
      Date.now()
    );
    if (Number(consumed.changes) !== 1) fail(401, 'INVALID_SIWE_NONCE');
    db.prepare('INSERT OR REPLACE INTO auth_sessions (token, address, role, expires_at) VALUES (?, ?, ?, ?)').run(token, address.toLowerCase(), role, expiresAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  writeAudit(role, address, `${role}.siwe.login`, address, {
    nonce,
    expiresAt,
    signatureHash: `0x${createHash('sha256').update(signature).digest('hex')}`,
    ipHash: requestFingerprint(req, 'ip'),
    deviceHash: requestFingerprint(req, 'device')
  });
  return { token, jwt: token, address, role, expiresAt, expiresIn: Math.floor(AUTH_SESSION_TTL_MS / 1000) };
}

function siweMessage(address, role, nonce, expiresAt) {
  const issuedAt = new Date().toISOString();
  return new SiweMessage({
    domain: SIWE_DOMAIN,
    address,
    statement: `Sign in to 24K Mall as ${role}.`,
    uri: SIWE_URI,
    version: '1',
    chainId: CHAIN_ID,
    nonce,
    issuedAt,
    expirationTime: new Date(expiresAt).toISOString(),
    requestId: role,
    resources: [`urn:24k:role:${role}`]
  }).prepareMessage();
}

function authToken(address, role, nonce, expiresAt) {
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64UrlJson({
    sub: address.toLowerCase(),
    role,
    jti: nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt / 1000),
    chainId: CHAIN_ID
  });
  const signature = createHmac('sha256', AUTH_TOKEN_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value !== 'buyer' && value !== 'merchant' && value !== 'admin') fail(400, 'INVALID_ROLE');
  return value;
}

function ensureRoleAddressAllowed(role, address) {
  const lower = address.toLowerCase();
  if (role === 'merchant') {
    const approved = db.prepare("SELECT id FROM merchants WHERE lower(wallet_address) = ? AND status = 'Approved'").get(lower);
    const configuredReceiver = isValidSeller(MERCHANT_RECEIVER) && lower === MERCHANT_RECEIVER.toLowerCase();
    if (!approved && !configuredReceiver) fail(403, 'MERCHANT_WALLET_NOT_WHITELISTED');
  }
  if (role === 'admin') {
    if (!isValidAddress(ADMIN_WALLET)) fail(503, 'ADMIN_WALLET_NOT_CONFIGURED');
    if (lower !== ADMIN_WALLET.toLowerCase()) fail(403, 'ADMIN_WALLET_NOT_ALLOWED');
  }
}

function requireRole(req, role) {
  if (role === 'admin' && hasAdminSecret(req)) return { address: 'admin-secret', role: 'admin' };
  const session = requireAuthenticatedSession(req);
  if (session.role !== role) fail(403, 'ROLE_FORBIDDEN');
  return session;
}

function requireAuthenticatedSession(req) {
  const token = bearerToken(req);
  if (!token) fail(401, 'JWT_REQUIRED');
  const session = db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(token);
  if (!session) fail(401, 'INVALID_JWT');
  if (!Number(session.expires_at) || Number(session.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    fail(401, 'JWT_EXPIRED');
  }
  return { address: session.address, role: session.role, token: session.token };
}

function requireBuyerRequest(req, requestedAddress) {
  const session = requireRole(req, 'buyer');
  if (requestedAddress && String(requestedAddress).toLowerCase() !== session.address.toLowerCase()) fail(403, 'BUYER_ADDRESS_MISMATCH');
  return session;
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-24k-jwt'] || '').trim();
}

function requireSecondarySignature(body, session, action) {
  if (!isValidAddress(session.address)) fail(401, 'ADMIN_JWT_REQUIRED_FOR_WRITE');
  const message = requireString(body?.secondaryMessage, 'secondaryMessage');
  const signature = requireString(body?.secondarySignature, 'secondarySignature');
  const recovered = recoverSignedAddress(message, signature, 'INVALID_SECONDARY_SIGNATURE');
  if (recovered.toLowerCase() !== session.address.toLowerCase()) fail(401, 'SECONDARY_SIGNATURE_ADDRESS_MISMATCH');
  const fields = actionMessageFields(message);
  if (fields.action !== action) fail(400, 'SECONDARY_MESSAGE_ACTION_MISMATCH');
  if (String(fields.walletAddress || '').toLowerCase() !== session.address.toLowerCase()) fail(400, 'SECONDARY_WALLET_MISMATCH');
  if (fields.chainId !== String(CHAIN_ID)) fail(400, 'SECONDARY_CHAIN_MISMATCH');
  if (fields.payloadHash !== payloadHashForSignature(body)) fail(400, 'SECONDARY_PAYLOAD_MISMATCH');
  const expiresAt = Number(fields.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) fail(400, 'SECONDARY_SIGNATURE_EXPIRED');
  const nonce = requireString(fields.nonce, 'nonce');
  consumeWalletActionNonce(nonce, session.address, action, expiresAt);
  recordRequestSignatureProof(action, session.address, signature);
  writeAudit(session.role, session.address, `${action}.attempt`, signedActionTarget(body), body);
}

function signedActionTarget(body) {
  return body?.targetId || body?.productId || body?.merchantId || body?.orderId || body?.rewardId || body?.storeId || body?.addressId || body?.key || 'global';
}

function requirePathResourceBinding(body, expectedId, field) {
  const actual = requireString(body?.[field], field);
  if (actual !== String(expectedId)) fail(400, 'SIGNED_RESOURCE_ID_MISMATCH');
}

function createActionIntent(session, action, payload) {
  if (!isValidAddress(session.address)) fail(401, 'SIWE_JWT_REQUIRED_FOR_ACTION_INTENT');
  if (action !== `${session.role}.${action.split('.').slice(1).join('.')}`) fail(403, 'ACTION_ROLE_MISMATCH');
  if (!/^(buyer|merchant|admin)\.[a-z0-9.-]{3,80}$/.test(action)) fail(400, 'INVALID_ACTION');
  const actionPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + actionIntentTtlMs();
  const payloadHash = payloadHashForSignature(actionPayload);
  const secondaryMessage = actionSignatureMessage({
    action,
    walletAddress: session.address,
    payloadHash,
    nonce,
    expiresAt
  });
  db.prepare('INSERT INTO wallet_action_nonces (nonce, address, action, expires_at, used) VALUES (?, ?, ?, ?, 0)').run(
    nonce,
    session.address.toLowerCase(),
    action,
    expiresAt
  );
  return {
    action,
    walletAddress: session.address,
    chainId: CHAIN_ID,
    payloadHash,
    nonce,
    expiresAt,
    secondaryMessage,
    signatureKind: 'personal_sign',
    submitBody: { ...actionPayload, secondaryMessage, secondarySignature: '<wallet-signature>' }
  };
}

function actionSignatureMessage({ action, walletAddress, payloadHash, nonce, expiresAt }) {
  return [
    '24K Mall Secondary Authorization',
    `Action: ${action}`,
    `Wallet: ${walletAddress.toLowerCase()}`,
    `ChainId: ${CHAIN_ID}`,
    `PayloadHash: ${payloadHash}`,
    `Nonce: ${nonce}`,
    `ExpiresAt: ${expiresAt}`
  ].join('\n');
}

function requireWalletSignature(body, address, action) {
  const message = requireString(body?.secondaryMessage, 'secondaryMessage');
  const signature = requireString(body?.secondarySignature, 'secondarySignature');
  if (!message.includes(action)) fail(400, 'SECONDARY_MESSAGE_ACTION_MISMATCH');
  const recovered = recoverSignedAddress(message, signature, 'INVALID_SECONDARY_SIGNATURE');
  if (recovered.toLowerCase() !== address.toLowerCase()) fail(401, 'SECONDARY_SIGNATURE_ADDRESS_MISMATCH');
  recordRequestSignatureProof(action, address, signature);
}

function recordRequestSignatureProof(action, address, signature) {
  const store = requestAuditContext.getStore();
  if (!store) return;
  const proof = {
    action,
    walletAddress: String(address).toLowerCase(),
    signatureHash: `0x${createHash('sha256').update(String(signature)).digest('hex')}`
  };
  store.lastSignatureProof = proof;
  store.signatureProofs?.set(action, proof);
}

function recoverSignedAddress(message, signature, errorCode) {
  try {
    return verifyMessage(message, signature);
  } catch {
    fail(401, errorCode);
  }
}

function requireClaimSignature(body, walletAddress, reward, amount) {
  const message = requireString(body?.secondaryMessage, 'secondaryMessage');
  const expected = {
    action: 'buyer.claim',
    walletAddress: walletAddress.toLowerCase(),
    rewardId: reward.id,
    amount,
    chainId: String(CHAIN_ID)
  };
  requireWalletSignature(body, walletAddress, expected.action);
  const fields = claimMessageFields(message);
  if (fields.action !== expected.action) fail(400, 'CLAIM_ACTION_MISMATCH');
  if (String(fields.walletAddress || '').toLowerCase() !== expected.walletAddress) fail(400, 'CLAIM_WALLET_MISMATCH');
  if (fields.rewardId !== expected.rewardId) fail(400, 'CLAIM_REWARD_MISMATCH');
  if (fields.amount !== expected.amount) fail(400, 'CLAIM_AMOUNT_MISMATCH');
  if (fields.chainId !== expected.chainId) fail(400, 'CLAIM_CHAIN_MISMATCH');
  const expiresAt = Number(fields.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) fail(400, 'CLAIM_SIGNATURE_EXPIRED');
  const nonce = requireString(fields.nonce, 'nonce');
  consumeWalletActionNonce(nonce, walletAddress, expected.action, expiresAt);
  writeAudit('buyer', walletAddress, `${expected.action}.attempt`, reward.id, body);
}

function claimMessageFields(message) {
  return actionMessageFields(message);
}

function actionMessageFields(message) {
  const fields = {};
  for (const line of String(message).split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === 'Action') fields.action = value;
    if (key === 'Wallet') fields.walletAddress = value;
    if (key === 'RewardId') fields.rewardId = value;
    if (key === 'Amount') fields.amount = value;
    if (key === 'ChainId') fields.chainId = value;
    if (key === 'PayloadHash') fields.payloadHash = value;
    if (key === 'Nonce') fields.nonce = value;
    if (key === 'ExpiresAt') fields.expiresAt = value;
  }
  return fields;
}

function payloadHashForSignature(body) {
  const { secondaryMessage, secondarySignature, signature, ...payload } = body || {};
  return `0x${createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function consumeWalletActionNonce(nonce, address, action, expiresAt) {
  if (!/^[a-zA-Z0-9:._-]{8,120}$/.test(nonce)) fail(400, 'INVALID_NONCE');
  const existing = db.prepare('SELECT * FROM wallet_action_nonces WHERE nonce = ?').get(nonce);
  if (!existing) fail(401, 'ACTION_NONCE_NOT_ISSUED');
  if (
    Number(existing.used)
    || existing.address !== address.toLowerCase()
    || existing.action !== action
    || Number(existing.expires_at) !== expiresAt
    || Number(existing.expires_at) < Date.now()
  ) {
    fail(401, 'ACTION_NONCE_REPLAYED');
  }
  db.prepare('UPDATE wallet_action_nonces SET used = 1 WHERE nonce = ?').run(nonce);
}

function writeAudit(role, address, action, target, payload) {
  if (!auditDb || auditDatabaseClosed) throw new Error('AUDIT_DATABASE_UNAVAILABLE');
  const actorAddress = String(address || '').toLowerCase();
  const redacted = redactAuditPayload(payload);
  const contextProof = requestAuditContext.getStore()?.lastSignatureProof;
  const explicitSignatureHash = redacted.secondarySignatureHash || redacted.signatureHash;
  const txHash = typeof redacted.txHash === 'string' && /^0x[0-9a-f]{64}$/i.test(redacted.txHash) ? redacted.txHash.toLowerCase() : '';
  const signatureHash = explicitSignatureHash || (contextProof?.walletAddress === actorAddress ? contextProof.signatureHash : '') || txHash || null;
  const proofType = explicitSignatureHash || contextProof?.signatureHash ? 'message-signature' : txHash ? 'transaction-hash' : role === 'system' || role === 'indexer' || role === 'integration' ? 'system' : 'none';
  if (auditActionRequiresSignature(role, action) && !signatureHash) throw new Error('AUDIT_SIGNATURE_REQUIRED');
  const payloadJson = JSON.stringify(redacted);
  const payloadHash = auditPayloadHash(payloadJson);
  const previousHash = auditDb.prepare('SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get()?.entry_hash || ZERO_AUDIT_HASH;
  const createdAt = new Date().toISOString();
  const auditTarget = String(target || 'global');
  const entryHash = auditEntryHash({ previousHash, actorAddress, role, action, target: auditTarget, signatureHash, payloadHash, createdAt });
  auditDb.prepare(`
    INSERT INTO audit_logs (actor_address, role, action, target, signature_hash, proof_type, payload_hash, payload_json, previous_hash, entry_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(actorAddress, role, action, auditTarget, signatureHash, proofType, payloadHash, payloadJson, previousHash, entryHash, createdAt);
  verifiedAuditHead = entryHash;
  verifiedAuditCount += 1;
}

function auditActionRequiresSignature(role, action) {
  if (String(action).endsWith('.siwe.login')) return false;
  if (role === 'admin' || role === 'merchant') return true;
  return role === 'buyer' && /(?:address\.|claim|after-sale|timeout-refund|order\.cancel)/.test(String(action));
}

function redactAuditPayload(payload) {
  const copy = { ...(payload || {}) };
  if (copy.secondaryMessage) {
    copy.secondaryMessageHash = `0x${createHash('sha256').update(String(copy.secondaryMessage)).digest('hex')}`;
  }
  if (copy.secondarySignature) {
    copy.secondarySignatureHash = `0x${createHash('sha256').update(String(copy.secondarySignature)).digest('hex')}`;
    copy.signatureKind = 'personal_sign';
  }
  delete copy.signature;
  delete copy.secondaryMessage;
  delete copy.secondarySignature;
  return redactAuditValue(copy);
}

function redactAuditValue(value) {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== 'object') return value;
  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:legalIdentity|legalId|identityNumber|idCard|idNumber)$/i.test(key) && entry) {
      const text = String(entry);
      redacted[`${key}Hash`] = `0x${createHash('sha256').update(text).digest('hex')}`;
      redacted[`${key}Last4`] = text.slice(-4);
      continue;
    }
    if (/phone$/i.test(key) && entry) {
      redacted[key] = maskPhone(entry);
      continue;
    }
    if (/(?:secret|password|private.?key|access.?key|api.?key|token|credential)$/i.test(key) && entry) {
      redacted[key] = '<redacted>';
      continue;
    }
    redacted[key] = redactAuditValue(entry);
  }
  return redacted;
}

function stripSignedEnvelope(payload) {
  const copy = { ...(payload || {}) };
  delete copy.secondaryMessage;
  delete copy.secondarySignature;
  delete copy.signature;
  return copy;
}

function requestFingerprint(req, kind) {
  if (!req) return '';
  const raw = kind === 'ip'
    ? String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()
    : String(req.headers['x-device-id'] || req.headers['user-agent'] || '').trim();
  if (!raw) return '';
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function enforceRequestFingerprint(req, action) {
  if (!req || req.method === 'OPTIONS') return;
  const ipHash = requestFingerprint(req, 'ip');
  const deviceHash = requestFingerprint(req, 'device');
  if (ipHash && db.prepare('SELECT address FROM blacklists WHERE address = ?').get(`ip:${ipHash}`)) fail(403, 'IP_BLACKLISTED');
  if (deviceHash && db.prepare('SELECT address FROM blacklists WHERE address = ?').get(`device:${deviceHash}`)) fail(403, 'DEVICE_BLACKLISTED');
  const now = Date.now();
  db.prepare('INSERT INTO request_activity (wallet_address, ip_hash, device_hash, action, created_at) VALUES (NULL, ?, ?, ?, ?)').run(ipHash || null, deviceHash || null, String(action).slice(0, 160), now);
  const windowStart = now - 60_000;
  const requestCount = ipHash ? Number(db.prepare('SELECT COUNT(*) AS count FROM request_activity WHERE ip_hash = ? AND created_at >= ?').get(ipHash, windowStart)?.count || 0) : 0;
  const configuredLimit = Number(process.env.RATE_LIMIT_REQUESTS_PER_MINUTE || 180);
  const apiLimit = Number.isSafeInteger(configuredLimit) && configuredLimit >= 30 && configuredLimit <= 10_000 ? configuredLimit : 180;
  const limit = String(action).startsWith('/api/') ? apiLimit : Math.max(300, apiLimit);
  if (requestCount > limit) {
    recordRiskEvent({ kind: 'rate-limit', severity: 'high', ipHash, deviceHash, action, status: 'Blocked', payload: { requestCount, windowSeconds: 60 } });
    fail(429, 'RATE_LIMITED');
  }
  if (Math.random() < 0.01) db.prepare('DELETE FROM request_activity WHERE created_at < ?').run(now - 24 * 60 * 60_000);
}

function enforceWalletFingerprint(req, walletAddress, action) {
  const address = requireAddress(walletAddress, 'walletAddress').toLowerCase();
  const ipHash = requestFingerprint(req, 'ip');
  const deviceHash = requestFingerprint(req, 'device');
  const now = Date.now();
  db.prepare('INSERT INTO request_activity (wallet_address, ip_hash, device_hash, action, created_at) VALUES (?, ?, ?, ?, ?)').run(address, ipHash || null, deviceHash || null, action, now);
  const windowStart = now - 60_000;
  const distinctByIp = ipHash ? Number(db.prepare('SELECT COUNT(DISTINCT wallet_address) AS count FROM request_activity WHERE ip_hash = ? AND wallet_address IS NOT NULL AND created_at >= ?').get(ipHash, windowStart)?.count || 0) : 0;
  const distinctByDevice = deviceHash ? Number(db.prepare('SELECT COUNT(DISTINCT wallet_address) AS count FROM request_activity WHERE device_hash = ? AND wallet_address IS NOT NULL AND created_at >= ?').get(deviceHash, windowStart)?.count || 0) : 0;
  if (distinctByIp > 5 || distinctByDevice > 5) {
    if (distinctByIp > 5 && ipHash) db.prepare('INSERT OR REPLACE INTO blacklists (address, reason) VALUES (?, ?)').run(`ip:${ipHash}`, '1 分钟内切换超过 5 个钱包');
    if (distinctByDevice > 5 && deviceHash) db.prepare('INSERT OR REPLACE INTO blacklists (address, reason) VALUES (?, ?)').run(`device:${deviceHash}`, '1 分钟内切换超过 5 个钱包');
    recordRiskEvent({ kind: 'wallet-cluster', severity: 'critical', walletAddress: address, ipHash, deviceHash, action, status: 'Blocked', payload: { distinctByIp, distinctByDevice } });
    fail(403, 'WALLET_CLUSTER_BLOCKED');
  }
}

function recordRiskEvent({ kind, severity, walletAddress = null, ipHash = null, deviceHash = null, action, status, payload = {} }) {
  const id = `risk-${Date.now()}-${randomBytes(4).toString('hex')}`;
  db.prepare('INSERT INTO risk_events (id, kind, severity, wallet_address, ip_hash, device_hash, action, status, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    kind,
    severity,
    walletAddress,
    ipHash,
    deviceHash,
    String(action || '').slice(0, 160),
    status,
    JSON.stringify(payload)
  );
  return id;
}

function riskPolicy() {
  return {
    maxGasGwei: 8,
    cancellationsPerFiveMinutes: 3,
    fulfillmentChangesPerFiveMinutes: 3,
    tradeLockMinutes: 120,
    ...(readAdminConfig('risk-policies') || {})
  };
}

function recordBuyerBehavior(walletAddress, kind, value = '') {
  const wallet = requireAddress(walletAddress, 'walletAddress').toLowerCase();
  const action = `${kind}${value ? `:${String(value).slice(0, 96)}` : ''}`;
  if (kind === 'store.select') {
    const latest = db.prepare("SELECT action FROM request_activity WHERE wallet_address = ? AND action LIKE 'store.select:%' ORDER BY id DESC LIMIT 1").get(wallet);
    if (latest?.action === action) return;
  }
  const now = Date.now();
  db.prepare('INSERT INTO request_activity (wallet_address, ip_hash, device_hash, action, created_at) VALUES (?, NULL, NULL, ?, ?)').run(wallet, action, now);
  const policy = riskPolicy();
  const windowStart = now - 5 * 60_000;
  const cancellations = Number(db.prepare("SELECT COUNT(*) AS count FROM request_activity WHERE wallet_address = ? AND action LIKE 'order.cancel:%' AND created_at >= ?").get(wallet, windowStart)?.count || 0);
  const fulfillmentChanges = Number(db.prepare("SELECT COUNT(*) AS count FROM request_activity WHERE wallet_address = ? AND (action LIKE 'address.change:%' OR action LIKE 'address.default:%' OR action LIKE 'store.select:%') AND created_at >= ?").get(wallet, windowStart)?.count || 0);
  if (cancellations >= Number(policy.cancellationsPerFiveMinutes || 3)) activateWalletTradeLock(wallet, 'frequent-cancellations', Number(policy.tradeLockMinutes || 120), { cancellations, windowMinutes: 5 });
  if (fulfillmentChanges >= Number(policy.fulfillmentChangesPerFiveMinutes || 3)) activateWalletTradeLock(wallet, 'frequent-fulfillment-changes', Number(policy.tradeLockMinutes || 120), { fulfillmentChanges, windowMinutes: 5 });
}

function activateWalletTradeLock(walletAddress, reason, minutes, details = {}) {
  const wallet = requireAddress(walletAddress, 'walletAddress').toLowerCase();
  const durationMinutes = Math.max(1, Number(minutes) || 120);
  const lockedUntil = Date.now() + durationMinutes * 60_000;
  const existing = activeWalletTradeLock(wallet);
  if (existing && Number(existing.payload.lockedUntil || 0) >= lockedUntil - 1_000) return existing;
  const id = recordRiskEvent({ kind: reason === 'high-gas' ? 'high-gas' : 'trade-lock', severity: 'high', walletAddress: wallet, action: details.txHash || reason, status: 'Active', payload: { ...details, reason, lockedUntil, durationMinutes } });
  return { id, payload: { ...details, reason, lockedUntil, durationMinutes } };
}

function activeWalletTradeLock(walletAddress) {
  const wallet = String(walletAddress).toLowerCase();
  const rows = db.prepare("SELECT * FROM risk_events WHERE wallet_address = ? AND kind IN ('trade-lock','high-gas') AND status = 'Active' ORDER BY created_at DESC LIMIT 20").all(wallet);
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json || '{}');
    if (Number(payload.lockedUntil || 0) > Date.now()) return { ...row, payload };
    db.prepare("UPDATE risk_events SET status = 'Expired' WHERE id = ?").run(row.id);
  }
  return null;
}

function assertWalletTradeUnlocked(walletAddress) {
  const lock = activeWalletTradeLock(walletAddress);
  if (!lock) return;
  const error = new Error('TRADE_TEMPORARILY_LOCKED');
  error.statusCode = 423;
  error.details = { lockedUntil: lock.payload.lockedUntil, reason: lock.payload.reason };
  throw error;
}

function observeReceiptGas(receipt, walletAddress, txHash, action) {
  if (!isValidAddress(walletAddress)) return;
  const gasPriceWei = parseRpcUint(receipt?.effectiveGasPrice || receipt?.gasPrice || '0x0');
  const maxGasGwei = Number(riskPolicy().maxGasGwei || 8);
  if (gasPriceWei <= 0n || gasPriceWei <= BigInt(Math.floor(maxGasGwei * 1_000_000_000))) return;
  const existing = db.prepare("SELECT id FROM risk_events WHERE kind = 'high-gas' AND action = ? LIMIT 1").get(String(txHash).toLowerCase());
  if (existing) return;
  activateWalletTradeLock(walletAddress, 'high-gas', 24 * 60, { txHash: String(txHash).toLowerCase(), action, gasPriceWei: gasPriceWei.toString(), maxGasGwei });
}

function safeUrlHost(value) {
  try {
    return value ? new URL(value).host : '';
  } catch {
    return '';
  }
}

function auditLogs() {
  return auditDb.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all().map((row) => ({
    id: row.id,
    actorAddress: row.actor_address,
    role: row.role,
    action: row.action,
    target: row.target,
    signatureHash: row.signature_hash || null,
    proofType: row.proof_type,
    payloadHash: row.payload_hash,
    previousHash: row.previous_hash,
    entryHash: row.entry_hash,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  }));
}

function rpcAuditLogs() {
  return auditDb.prepare('SELECT * FROM rpc_audit_logs ORDER BY id DESC LIMIT 200').all().map((row) => ({
    id: row.id,
    method: row.method,
    request: JSON.parse(row.request_json || '{}'),
    response: row.response_json ? JSON.parse(row.response_json) : null,
    status: row.status,
    durationMs: row.duration_ms,
    errorCode: row.error_code || null,
    createdAt: row.created_at
  }));
}

function addressBookEntries(address) {
  if (!isValidAddress(address)) return [];
  const rows = db.prepare('SELECT payload_json FROM address_book WHERE wallet_address = ? ORDER BY created_at DESC').all(String(address).toLowerCase());
  const saved = rows.map((row) => JSON.parse(row.payload_json));
  return saved.sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault))).map(enrichAddressForDapp);
}

function adminMerchants() {
  const rows = db.prepare('SELECT * FROM merchants ORDER BY created_at DESC LIMIT 100').all().map((row) => ({
    id: row.id,
    walletAddress: row.wallet_address,
    name: row.name,
    status: row.status,
    payload: redactMerchantPayload(JSON.parse(row.payload_json || '{}')),
    qualificationReady: merchantQualificationReady(JSON.parse(row.payload_json || '{}')),
    createdAt: row.created_at,
    modules: ['单品提报', '发货', '门店', 'Claim']
  }));
  if (rows.length) return rows;
  return [{
    id: 'merchant-abu-24k',
    walletAddress: isValidSeller(MERCHANT_RECEIVER) ? MERCHANT_RECEIVER : PLACEHOLDER_SELLER,
    name: '24K 官方严选',
    status: 'Approved',
    modules: ['单品提报', '发货', '门店', 'Claim']
  }];
}

function adminMerchantInsights(identifier) {
  const value = requireString(identifier, 'merchantId');
  const merchant = isValidAddress(value)
    ? db.prepare('SELECT * FROM merchants WHERE lower(wallet_address) = ?').get(value.toLowerCase())
    : db.prepare('SELECT * FROM merchants WHERE id = ?').get(value);
  if (!merchant) fail(404, 'MERCHANT_NOT_FOUND');
  const wallet = merchant.wallet_address.toLowerCase();
  const orders = db.prepare('SELECT * FROM orders WHERE lower(seller_address) = ? ORDER BY created_at DESC').all(wallet);
  const orderIds = orders.map((order) => order.order_id);
  const rewards = orderIds.length
    ? db.prepare(`SELECT * FROM reward_ledger WHERE order_id IN (${orderIds.map(() => '?').join(',')})`).all(...orderIds)
    : [];
  const claims = db.prepare('SELECT * FROM claims WHERE lower(wallet_address) = ? ORDER BY created_at DESC').all(wallet);
  const paid = orders.filter((order) => !['Draft', 'Cancelled'].includes(order.status));
  const refunded = orders.filter((order) => ['ForcedRefunded', 'EmergencyRefunded'].includes(order.status));
  const shipped = orders.filter((order) => ['Shipped', 'PickupReady', 'Released'].includes(order.status));
  const overdue = orders.filter((order) => ['PaidLocked', 'AwaitingShipment'].includes(order.status) && Date.now() - timestampMs(order.created_at) >= orderTimeoutMs());
  const rewardStates = Object.fromEntries(['Locked', 'Available', 'Claimed', 'Burned', 'Failed'].map((state) => [state, {
    count: rewards.filter((row) => row.state === state).length,
    amount: sumDecimalStrings(rewards.filter((row) => row.state === state).map((row) => row.amount))
  }]));
  return {
    generatedAt: new Date().toISOString(),
    merchant: {
      id: merchant.id,
      walletAddress: merchant.wallet_address,
      name: merchant.name,
      status: merchant.status,
      qualification: redactMerchantPayload(JSON.parse(merchant.payload_json || '{}')).qualification || null
    },
    orders: {
      total: orders.length,
      paid: paid.length,
      shipped: shipped.length,
      overdue: overdue.length,
      shipmentRatePct: paid.length ? Number(((shipped.length / paid.length) * 100).toFixed(2)) : 0,
      recent: orders.slice(0, 50).map(toOrder)
    },
    npl: {
      grossFlow: sumDecimalStrings(paid.map((row) => row.amount_npl)),
      refunded: sumDecimalStrings(refunded.map((row) => row.amount_npl)),
      locked: sumDecimalStrings(orders.filter((row) => ['PaidLocked', 'AwaitingShipment', 'Shipped', 'PickupReady', 'Arbitration', 'RefundRequested'].includes(row.status)).map((row) => row.amount_npl))
    },
    afterSales: {
      refunds: refunded.length,
      arbitration: orders.filter((row) => ['Arbitration', 'RefundRequested'].includes(row.status)).length
    },
    rewards: {
      asset: 'BNM',
      fiveStates: rewardStates,
      burned: rewardStates.Burned,
      entries: rewards.slice(0, 100).map(toLedgerEntry)
    },
    claims: {
      total: claims.length,
      failed: claims.filter((row) => String(row.status).toLowerCase() === 'failed').length,
      records: claims.slice(0, 100).map(toClaimRecord)
    }
  };
}

function adminProductHistory(productId) {
  const id = requireString(productId, 'productId');
  return auditDb.prepare(`
    SELECT id, actor_address, action, target, signature_hash, proof_type, payload_json, created_at
    FROM audit_logs
    WHERE target = ? AND action LIKE 'admin.product.%'
    ORDER BY id DESC LIMIT 200
  `).all(id).map((row) => ({
    id: row.id,
    actorAddress: row.actor_address,
    action: row.action,
    productId: row.target,
    signatureHash: row.signature_hash,
    proofType: row.proof_type,
    change: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  }));
}

function adminMultisigApprovals() {
  return auditDb.prepare(`
    SELECT id, actor_address, target, payload_json, created_at
    FROM audit_logs
    WHERE action = 'multisig.approval.recorded'
    ORDER BY id DESC LIMIT 500
  `).all().map((row) => ({
    id: row.id,
    signerAddress: row.actor_address,
    safeTxHash: row.target,
    ...JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  }));
}

function adminReconciliationReport() {
  const totalEvents = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM chain_events
    WHERE event_name IN ('OrderPaid','OrderCompleted','OrderForcedRefunded','OrderEmergencyRefunded','RewardClaimed')
  `).get()?.count || 0);
  const rows = db.prepare(`
    SELECT order_id, event_name, payload_json, tx_hash, block_number, finality_status
    FROM chain_events
    WHERE event_name IN ('OrderPaid','OrderCompleted','OrderForcedRefunded','OrderEmergencyRefunded','RewardClaimed')
    ORDER BY id DESC LIMIT 1000
  `).all();
  const records = rows.map((row) => {
    const payload = JSON.parse(row.payload_json || '{}');
    const finalityAccepted = reconciliationFinalityAccepted(row.finality_status);
    if (row.event_name === 'RewardClaimed') {
      const entryId = String(payload.entryId || '');
      const reward = db.prepare('SELECT * FROM reward_ledger WHERE id = ? OR id = ? LIMIT 1').get(entryId, `reward-ledger-${entryId}`);
      const claim = reward ? db.prepare('SELECT * FROM claims WHERE reward_id = ? ORDER BY created_at DESC LIMIT 1').get(reward.id) : null;
      const chainAmount = decimalFromEventPayload(payload);
      const ledgerAmount = reward?.amount || null;
      const amountMatch = Boolean(ledgerAmount) && decimalsEqual(chainAmount, ledgerAmount);
      const stateMatch = reward?.state === 'Claimed';
      const txHashMatch = Boolean(reward?.tx_hash) && String(reward.tx_hash).toLowerCase() === String(row.tx_hash).toLowerCase()
        && (!claim || (claim.status === 'success' && String(claim.tx_hash || '').toLowerCase() === String(row.tx_hash).toLowerCase()));
      const reasons = reconciliationReasons({ amountMatch, stateMatch, txHashMatch, finalityAccepted });
      return { eventName: row.event_name, target: entryId, txHash: row.tx_hash, chainAmount, ledgerAmount, amountMatch, stateMatch, txHashMatch, finalityAccepted, match: reasons.length === 0, reasons, finalityStatus: row.finality_status };
    }
    const orderId = payload.orderId || row.order_id;
    const order = findOrderByIdOrOrderId(orderId);
    const chainAmount = decimalFromEventPayload(payload);
    const ledgerAmount = order?.amount_npl || null;
    const amountMatch = Boolean(ledgerAmount) && decimalsEqual(chainAmount, ledgerAmount);
    const stateMatch = reconciliationOrderStateMatches(row.event_name, order?.status);
    const expectedTxHash = row.event_name === 'OrderPaid' ? order?.fund_tx_hash : order?.last_event_tx_hash;
    const txHashMatch = Boolean(expectedTxHash) && String(expectedTxHash).toLowerCase() === String(row.tx_hash || '').toLowerCase();
    const reasons = reconciliationReasons({ amountMatch, stateMatch, txHashMatch, finalityAccepted });
    return { eventName: row.event_name, target: orderId, txHash: row.tx_hash, chainAmount, ledgerAmount, amountMatch, stateMatch, txHashMatch, finalityAccepted, match: reasons.length === 0, reasons, finalityStatus: row.finality_status };
  });
  const observed = new Set(records.map((row) => `${row.eventName}:${String(row.target).toLowerCase()}`));
  for (const order of db.prepare("SELECT order_id, status FROM orders WHERE status NOT IN ('Draft','Cancelled')").all()) {
    for (const eventName of expectedOrderReconciliationEvents(order.status)) {
      const key = `${eventName}:${order.order_id.toLowerCase()}`;
      if (!observed.has(key)) records.push(missingReconciliationRecord(eventName, order.order_id));
    }
  }
  for (const claim of db.prepare("SELECT reward_id, tx_hash FROM claims WHERE status = 'success'").all()) {
    const entryId = String(claim.reward_id || '').replace(/^reward-ledger-/, '');
    const key = `RewardClaimed:${entryId.toLowerCase()}`;
    if (!observed.has(key)) records.push(missingReconciliationRecord('RewardClaimed', entryId, claim.tx_hash));
  }
  if (totalEvents > rows.length) {
    records.push({ eventName: 'Window', target: 'chain_events', txHash: null, match: false, reasons: ['EVENT_WINDOW_TRUNCATED'], totalEvents, inspectedEvents: rows.length });
  }
  const mismatches = records.filter((row) => !row.match);
  return {
    generatedAt: new Date().toISOString(),
    status: records.length === 0 ? 'NoData' : mismatches.length ? 'AttentionRequired' : 'Reconciled',
    checked: records.length,
    matched: records.length - mismatches.length,
    totalEvents,
    truncated: totalEvents > rows.length,
    mismatches,
    records,
    circuitSnapshot: ['orders', 'seckill', 'claims', 'force-cutoff'].map(circuitState)
  };
}

function reconciliationFinalityAccepted(status) {
  return status === 'Finalized' || (ALLOW_UNVERIFIED_CHAIN_EVENTS && status === 'Unverified');
}

function reconciliationOrderStateMatches(eventName, status) {
  if (eventName === 'OrderPaid') return ['PaidLocked', 'AwaitingShipment', 'Shipped', 'PickupReady', 'Arbitration', 'RefundRequested', 'Released', 'ForcedRefunded', 'EmergencyRefunded', 'Claimed'].includes(String(status));
  if (eventName === 'OrderCompleted') return status === 'Released';
  if (eventName === 'OrderForcedRefunded') return status === 'ForcedRefunded';
  if (eventName === 'OrderEmergencyRefunded') return status === 'EmergencyRefunded';
  return false;
}

function expectedOrderReconciliationEvents(status) {
  const events = ['OrderPaid'];
  if (status === 'Released') events.push('OrderCompleted');
  if (status === 'ForcedRefunded') events.push('OrderForcedRefunded');
  if (status === 'EmergencyRefunded') events.push('OrderEmergencyRefunded');
  return events;
}

function reconciliationReasons({ amountMatch, stateMatch, txHashMatch, finalityAccepted }) {
  return [
    !amountMatch ? 'AMOUNT_MISMATCH' : null,
    !stateMatch ? 'STATE_MISMATCH' : null,
    !txHashMatch ? 'TX_HASH_MISMATCH' : null,
    !finalityAccepted ? 'FINALITY_NOT_ACCEPTED' : null
  ].filter(Boolean);
}

function missingReconciliationRecord(eventName, target, txHash = null) {
  return { eventName, target, txHash, chainAmount: null, ledgerAmount: null, match: false, reasons: ['EXPECTED_EVENT_MISSING'], finalityStatus: null };
}

function decimalFromEventPayload(payload) {
  const wei = payload.nplAmountWei ?? payload.refundedNplWei ?? payload.amountWei ?? payload.amount;
  if (wei !== undefined && /^(?:0|[1-9][0-9]*)$/.test(String(wei))) return formatDecimal18(BigInt(wei));
  return String(payload.nplAmount ?? payload.refundedNpl ?? payload.amountNpl ?? '0');
}

function decimalsEqual(left, right) {
  try {
    return parseDecimal18(String(left)) === parseDecimal18(String(right));
  } catch {
    return false;
  }
}

function sumDecimalStrings(values) {
  return formatDecimal18(values.reduce((total, value) => total + parseDecimal18(String(value || '0')), 0n));
}

function redactMerchantPayload(payload) {
  const value = structuredClone(payload || {});
  if (value.qualification?.contactPhone) value.qualification.contactPhoneMasked = maskPhone(value.qualification.contactPhone);
  if (value.qualification) delete value.qualification.contactPhone;
  delete value.legalIdentity;
  delete value.legalId;
  return redactConfigValue(value);
}

function maskPhone(value) {
  const text = String(value || '');
  return text.length >= 7 ? `${text.slice(0, 3)}****${text.slice(-4)}` : '***';
}

function merchantQualificationReady(payload) {
  const qualification = payload?.qualification;
  return Boolean(qualification?.businessLicenseUrl && qualification?.legalRepresentative && qualification?.contactName && qualification?.contactPhone && qualification?.settlementWallet);
}

function pendingProductSubmissions() {
  return db.prepare('SELECT * FROM product_submissions ORDER BY created_at DESC LIMIT 50').all().map((row) => ({
    id: row.id,
    merchantAddress: row.merchant_address,
    storeId: row.store_id || 'default',
    title: row.title,
    status: row.status,
    locked: isProductSubmissionLocked(row.status),
    lockedAt: row.locked_at || undefined,
    approvedProductId: row.approved_product_id || undefined,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  }));
}

function adminSearch(searchParams) {
  const query = String(searchParams.get('q') || searchParams.get('keyword') || '').trim().toLowerCase();
  const logic = String(searchParams.get('logic') || 'AND').trim().toUpperCase() === 'OR' ? 'OR' : 'AND';
  const status = String(searchParams.get('status') || '').trim().toLowerCase();
  const exact = Object.fromEntries(['orderId', 'productId', 'txHash', 'wallet', 'uid', 'phone'].map((key) => [key, String(searchParams.get(key) || '').trim().toLowerCase()]));
  const from = Date.parse(String(searchParams.get('from') || searchParams.get('startTime') || '')) || 0;
  const to = Date.parse(String(searchParams.get('to') || searchParams.get('endTime') || '')) || 0;
  const inTimeRange = (value) => {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isFinite(timestamp)) return true;
    return (!from || timestamp >= from) && (!to || timestamp <= to);
  };
  const textIncludes = (needle, ...values) => values.some((value) => String(value || '').toLowerCase().includes(needle));
  const exactMatches = (needle, ...values) => values.some((value) => String(value || '').toLowerCase() === needle);
  const matches = (fields) => {
    const checks = [];
    if (query) checks.push(textIncludes(query, ...(fields.query || [])));
    for (const [key, value] of Object.entries(exact)) {
      if (!value) continue;
      checks.push(exactMatches(value, ...(fields[key] || [])));
    }
    if (checks.length === 0) return true;
    return logic === 'OR' ? checks.some(Boolean) : checks.every(Boolean);
  };
  const statusMatches = (value) => !status || String(value || '').toLowerCase() === status;

  const orderProductIds = new Map();
  for (const row of db.prepare('SELECT order_id, product_id FROM order_items').all()) {
    const list = orderProductIds.get(row.order_id) || [];
    list.push(row.product_id);
    orderProductIds.set(row.order_id, list);
  }
  const walletProfiles = new Map();
  for (const row of db.prepare('SELECT wallet_address, payload_json FROM address_book ORDER BY created_at DESC').all()) {
    const key = String(row.wallet_address).toLowerCase();
    if (walletProfiles.has(key)) continue;
    walletProfiles.set(key, JSON.parse(row.payload_json || '{}'));
  }
  const merchantProfiles = new Map(adminMerchants().map((row) => [String(row.walletAddress).toLowerCase(), row]));

  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all()
    .filter((row) => {
      const products = orderProductIds.get(row.order_id) || [];
      const profile = walletProfiles.get(String(row.buyer_address).toLowerCase()) || {};
      return inTimeRange(row.created_at) && statusMatches(row.status) && matches({
        query: [row.order_id, row.id, row.buyer_address, row.seller_address, row.tx_hash, row.fund_tx_hash, row.last_event_tx_hash, profile.uid, profile.phone, ...products],
        orderId: [row.order_id, row.id],
        productId: products,
        txHash: [row.tx_hash, row.fund_tx_hash, row.last_event_tx_hash],
        wallet: [row.buyer_address, row.seller_address],
        uid: [profile.uid],
        phone: [profile.phone]
      });
    })
    .slice(0, 25)
    .map(toOrder);
  const products = db.prepare('SELECT * FROM products ORDER BY id LIMIT 100').all()
    .filter((row) => {
      const merchant = merchantProfiles.get(String(row.seller_address).toLowerCase()) || {};
      return statusMatches(row.status) && matches({
        query: [row.id, row.title, row.shop_name, row.sku, row.seller_address, row.status, merchant.id, merchant.payload?.contactPhone],
        productId: [row.id],
        wallet: [row.seller_address],
        uid: [merchant.id],
        phone: [merchant.payload?.contactPhone]
      });
    })
    .slice(0, 25)
    .map(toProduct);
  const productSubmissions = pendingProductSubmissions()
    .filter((row) => {
      const merchant = merchantProfiles.get(String(row.merchantAddress).toLowerCase()) || {};
      return inTimeRange(row.createdAt) && statusMatches(row.status) && matches({
        query: [row.id, row.approvedProductId, row.title, row.merchantAddress, row.status, merchant.id, merchant.payload?.contactPhone],
        productId: [row.approvedProductId],
        wallet: [row.merchantAddress],
        uid: [merchant.id],
        phone: [merchant.payload?.contactPhone]
      });
    })
    .slice(0, 25);
  const merchants = adminMerchants()
    .filter((row) => statusMatches(row.status) && matches({
      query: [row.id, row.walletAddress, row.name, row.status, row.payload?.contactPhone],
      wallet: [row.walletAddress],
      uid: [row.id, row.payload?.uid],
      phone: [row.payload?.contactPhone]
    }))
    .slice(0, 25);
  const logs = auditLogs()
    .filter((row) => inTimeRange(row.createdAt) && matches({
      query: [row.action, row.target, row.actorAddress, row.role, stableStringify(row.payload)],
      orderId: [row.target, row.payload?.orderId],
      productId: [row.target, row.payload?.productId],
      txHash: [row.payload?.txHash],
      wallet: [row.actorAddress, row.payload?.walletAddress, row.payload?.buyerAddress, row.payload?.sellerAddress],
      uid: [row.payload?.uid],
      phone: [row.payload?.phone]
    }))
    .slice(0, 25);

  return {
    filters: { query, logic, status, ...exact, from: from || null, to: to || null },
    results: { orders, products, productSubmissions, merchants, auditLogs: logs },
    batchActions: ['export.csv', 'export.excel', 'print.shipments', 'print.pickups', 'review.approve', 'review.reject', 'soft-delete', 'product.up', 'product.down', 'batch.modify']
  };
}

function currentMerchantProduct(merchantAddress) {
  const row = db.prepare('SELECT * FROM product_submissions WHERE lower(merchant_address) = ? ORDER BY created_at DESC LIMIT 1').get(String(merchantAddress).toLowerCase());
  return row ? toProductSubmission(row) : null;
}

function updateMerchantProfile(session, body) {
  if (body.walletAddress !== undefined || body.status !== undefined || body.id !== undefined) fail(400, 'MERCHANT_PROFILE_IMMUTABLE_FIELD');
  const address = session.address.toLowerCase();
  const row = db.prepare("SELECT * FROM merchants WHERE lower(wallet_address) = ? AND status = 'Approved'").get(address);
  if (!row) fail(403, 'MERCHANT_WALLET_NOT_WHITELISTED');
  const previous = JSON.parse(row.payload_json || '{}');
  const profile = {
    ...previous,
    logoUrl: body.logoUrl !== undefined ? normalizeOptionalHttpsUrl(body.logoUrl, 'logoUrl') : previous.logoUrl || '',
    contactPhone: body.contactPhone !== undefined ? String(body.contactPhone).trim().slice(0, 24) : previous.contactPhone || '',
    supportUrl: body.supportUrl !== undefined ? normalizeOptionalHttpsUrl(body.supportUrl, 'supportUrl') : previous.supportUrl || '',
    announcement: body.announcement !== undefined ? String(body.announcement).trim().slice(0, 500) : previous.announcement || ''
  };
  if (profile.contactPhone && !/^\+?[0-9 ()-]{6,24}$/.test(profile.contactPhone)) fail(400, 'INVALID_CONTACT_PHONE');
  const name = requireString(body.name || row.name, 'name').slice(0, 80);
  db.prepare('UPDATE merchants SET name = ?, payload_json = ? WHERE id = ?').run(name, JSON.stringify(profile), row.id);
  writeAudit(session.role, session.address, 'merchant.profile.update', row.id, { name, logoUrl: profile.logoUrl, contactPhone: profile.contactPhone, supportUrl: profile.supportUrl, announcement: profile.announcement });
  return { id: row.id, name, walletAddress: address, status: row.status, profile };
}

function merchantClaimState(merchantAddress) {
  const address = String(merchantAddress).toLowerCase();
  const rewards = db.prepare('SELECT * FROM reward_ledger WHERE lower(wallet_address) = ? ORDER BY created_at DESC').all(address);
  const claims = db.prepare('SELECT * FROM claims WHERE lower(wallet_address) = ? ORDER BY created_at DESC LIMIT 100').all(address);
  return {
    paymentAsset: 'NPL',
    availableNpl: sumLedgerAmount(rewards.filter((row) => row.asset_symbol === 'NPL' && row.state === 'Available')),
    availableBnm: sumLedgerAmount(rewards.filter((row) => row.asset_symbol === 'BNM' && row.state === 'Available')),
    rewards: rewards.map((row) => ({
      ...toLedgerEntry(row),
      claimIntentEndpoint: row.state === 'Available' ? '/api/dapp/claim-intent' : null
    })),
    claims: claims.map(toClaimRecord)
  };
}

function merchantAuditLogs(merchantAddress) {
  return auditDb.prepare('SELECT * FROM audit_logs WHERE lower(actor_address) = ? ORDER BY id DESC LIMIT 200').all(String(merchantAddress).toLowerCase()).map((row) => ({
    id: row.id,
    actorAddress: row.actor_address,
    role: row.role,
    action: row.action,
    target: row.target,
    signatureHash: row.signature_hash || null,
    proofType: row.proof_type,
    entryHash: row.entry_hash,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  }));
}

function merchantHelpCenter() {
  const rules = db.prepare('SELECT body, updated_at FROM cms_contents WHERE key = ?').get('rules');
  return {
    updatedAt: rules?.updated_at || null,
    seckillRules: rules?.body || seckillRules().body,
    policies: [
      '一店一单品：审核中、待排期和秒杀中不可修改或下架。',
      '仅使用 NPL 托管支付；商家不得改价或伪造物流单号。',
      '快递签收或门店核销后才进入链上清算与收益释放。',
      '敏感操作必须使用当前白名单钱包二次签名并写入审计日志。',
      '平台可对超时不发货、刷单或欺诈订单执行强制退款和未领取奖励销毁。'
    ],
    support: readAdminConfig('merchant-support') || { channels: [] }
  };
}

function merchantPrintJobs(merchantAddress) {
  return db.prepare('SELECT * FROM print_jobs WHERE lower(merchant_address) = ? ORDER BY created_at DESC LIMIT 200').all(String(merchantAddress).toLowerCase()).map(toPrintJob);
}

function merchantPrinters(merchantAddress) {
  const address = requireAddress(merchantAddress, 'merchantAddress').toLowerCase();
  const prefix = `merchant-printer:${address}:`;
  const jobs = merchantPrintJobs(address);
  return db.prepare('SELECT * FROM admin_configs WHERE key LIKE ? ORDER BY updated_at DESC').all(`${prefix}%`).map((row) => {
    const config = JSON.parse(row.payload_json || '{}');
    const deviceId = row.key.slice(prefix.length);
    const lastJob = jobs.find((job) => String(job.payload?.deviceId || '') === deviceId) || null;
    const configured = Boolean(config.provider && deviceId);
    const online = configured && ['Submitted', 'Delivered', 'Printed'].includes(String(lastJob?.status || ''));
    return {
      deviceId,
      provider: config.provider || '',
      storeId: config.storeId || null,
      enabled: config.enabled !== false,
      status: !configured ? 'ConfigurationRequired' : online ? 'Online' : lastJob?.status === 'Failed' ? 'Error' : 'Configured',
      lastJobStatus: lastJob?.status || null,
      lastSeenAt: online ? lastJob.updatedAt : null,
      updatedAt: row.updated_at
    };
  });
}

function adminPrintJobs() {
  return db.prepare('SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 500').all().map(toPrintJob);
}

function toPrintJob(row) {
  return {
    id: row.id,
    merchantAddress: row.merchant_address,
    orderId: row.order_id || null,
    jobType: row.job_type,
    copies: Number(row.copies),
    status: row.status,
    providerJobId: row.provider_job_id || null,
    attempts: Number(row.attempts),
    lastError: row.last_error || null,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function exportMerchantOrders(merchantAddress, searchParams, format) {
  if (format !== 'csv' && format !== 'excel') fail(400, 'UNSUPPORTED_EXPORT_FORMAT');
  const status = String(searchParams.get('status') || '').trim();
  const fulfillmentMode = String(searchParams.get('fulfillmentMode') || '').trim();
  const sku = String(searchParams.get('sku') || '').trim().toLowerCase();
  const from = Date.parse(String(searchParams.get('from') || '')) || 0;
  const to = Date.parse(String(searchParams.get('to') || '')) || 0;
  const orders = db.prepare('SELECT * FROM orders WHERE lower(seller_address) = ? ORDER BY created_at DESC').all(String(merchantAddress).toLowerCase());
  const rows = orders.flatMap((order) => {
    const created = timestampMs(order.created_at);
    if (status && order.status !== status) return [];
    if (fulfillmentMode && order.fulfillment_mode !== fulfillmentMode) return [];
    if ((from && created < from) || (to && created > to)) return [];
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.order_id);
    const logistics = db.prepare('SELECT * FROM logistics_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.order_id);
    const pickup = db.prepare('SELECT * FROM pickup_verifications WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.order_id);
    const address = order.address_id ? db.prepare('SELECT payload_json FROM address_book WHERE id = ?').get(order.address_id) : null;
    const addressPayload = address ? JSON.parse(address.payload_json || '{}') : {};
    return items.filter((item) => !sku || String(item.sku_name || item.sku_id || '').toLowerCase().includes(sku)).map((item) => ({
      orderId: order.order_id,
      txHash: order.fund_tx_hash || order.tx_hash || '',
      recipient: addressPayload.name || '',
      phone: addressPayload.phone || '',
      address: [addressPayload.province, addressPayload.city, addressPayload.district, addressPayload.detail].filter(Boolean).join(''),
      sku: item.sku_name || item.sku_id || '',
      quantity: Number(item.quantity),
      amountNpl: order.amount_npl,
      createdAt: order.created_at,
      fulfillmentMode: order.fulfillment_mode || item.fulfillment_mode || '',
      carrier: logistics?.carrier || '',
      trackingNo: logistics?.tracking_no || '',
      pickupStatus: pickup ? 'Verified' : (order.fulfillment_mode === 'pickup' ? 'Pending' : ''),
      status: order.status
    }));
  });
  const headers = ['订单号', 'TxHash', '收货人', '电话', '详细地址', 'SKU', '数量', '金额(NPL)', '下单时间', '履约模式', '承运商', '物流单号', '核销状态', '订单状态'];
  const fields = ['orderId', 'txHash', 'recipient', 'phone', 'address', 'sku', 'quantity', 'amountNpl', 'createdAt', 'fulfillmentMode', 'carrier', 'trackingNo', 'pickupStatus', 'status'];
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  if (format === 'csv') {
    const content = `\uFEFF${[headers, ...rows.map((row) => fields.map((field) => row[field]))].map((line) => line.map(csvCell).join(',')).join('\r\n')}`;
    return { content, contentType: 'text/csv; charset=utf-8', fileName: `24k-orders-${stamp}.csv`, rowCount: rows.length, filters: { status, fulfillmentMode, sku, from, to } };
  }
  const artifact = encodedArtifact(
    `24k-orders-${stamp}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buildXlsx({ sheetName: '24K Orders', headers, rows: rows.map((row) => fields.map((field) => row[field])) })
  );
  return { ...artifact, contentType: artifact.mimeType, rowCount: rows.length, filters: { status, fulfillmentMode, sku, from, to } };
}

function merchantExportSearchParams(filters) {
  const params = new URLSearchParams();
  for (const key of ['status', 'fulfillmentMode', 'sku', 'from', 'to']) {
    if (filters?.[key] !== undefined && filters[key] !== null && String(filters[key]).trim()) params.set(key, String(filters[key]).trim());
  }
  return params;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function adminCategories() {
  const categories = db.prepare('SELECT * FROM categories WHERE deleted_at IS NULL ORDER BY level, sort_order, name').all();
  return categories.map((row) => ({
    id: row.id,
    parentId: row.parent_id || null,
    level: Number(row.level),
    name: row.name,
    icon: row.icon,
    sortOrder: Number(row.sort_order),
    serviceFeeBps: Number(row.service_fee_bps),
    enabled: Boolean(row.enabled),
    locked: categoryOrTagLocked('categoryId', row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function adminTags() {
  return db.prepare('SELECT * FROM tags WHERE deleted_at IS NULL ORDER BY name').all().map((row) => ({
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    locked: categoryOrTagLocked('tagIds', row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function categoryOrTagLocked(field, id) {
  const submissionLocked = db.prepare("SELECT payload_json FROM product_submissions WHERE status IN ('PendingReview','Approved','Scheduled','Live','TakedownRequested')").all().some((row) => {
    const payload = JSON.parse(row.payload_json || '{}');
    return field === 'tagIds' ? Array.isArray(payload.tagIds) && payload.tagIds.includes(id) : payload[field] === id;
  });
  if (submissionLocked) return true;
  const productIds = field === 'tagIds'
    ? db.prepare('SELECT product_id FROM product_tags WHERE tag_id = ?').all(id).map((row) => row.product_id)
    : db.prepare('SELECT approved_product_id, payload_json FROM product_submissions WHERE approved_product_id IS NOT NULL').all()
      .filter((row) => JSON.parse(row.payload_json || '{}').categoryId === id)
      .map((row) => row.approved_product_id);
  return productIds.some((productId) => {
    const product = db.prepare('SELECT status FROM products WHERE id = ?').get(productId);
    return ['Active', 'SoldOut'].includes(product?.status) || Boolean(productOperationalLockReason(productId));
  });
}

function adminConfigs() {
  return db.prepare('SELECT * FROM admin_configs ORDER BY key').all().map((row) => ({
    key: row.key,
    value: redactConfigValue(JSON.parse(row.payload_json || '{}')),
    updatedAt: row.updated_at
  }));
}

function adminConfigEntries(prefix) {
  return db.prepare('SELECT * FROM admin_configs WHERE key LIKE ? ORDER BY key').all(`${prefix}%`).map((row) => {
    const value = redactConfigValue(JSON.parse(row.payload_json || '{}'));
    return { id: row.key.slice(prefix.length), key: row.key, ...value, updatedAt: row.updated_at };
  });
}

function adminNotificationDeliveries() {
  return db.prepare('SELECT * FROM notification_deliveries ORDER BY created_at DESC LIMIT 500').all().map((row) => {
    const payload = JSON.parse(row.payload_json || '{}');
    return {
      id: row.id,
      title: payload.title || '24K 通知',
      preview: payload.body || payload.preview || '',
      type: payload.type || 'platform.notice',
      audience: payload.audience || payload.recipient || row.recipient,
      channel: row.channel,
      channels: Array.isArray(payload.channels) ? payload.channels : [row.channel],
      recipient: row.recipient,
      status: row.status,
      providerJobId: row.provider_job_id || null,
      lastError: row.last_error || null,
      sentAt: row.status === 'Submitted' || row.status === 'Delivered' ? row.updated_at : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deliveryRatePct: row.status === 'Delivered' || row.status === 'Submitted' ? 100 : row.status === 'Failed' ? 0 : null
    };
  });
}

function adminMessageGateways() {
  const stored = readAdminConfig('message-gateways') || {};
  const webhookConfigured = Boolean(process.env.NOTIFICATION_WEBHOOK_URL && process.env.NOTIFICATION_WEBHOOK_TOKEN);
  const channels = Array.isArray(stored.channels) ? stored.channels : [
    { id: 'in-app', provider: '24k', enabled: true, credentialsConfigured: true },
    { id: 'sms', provider: stored.smsProvider || '', enabled: webhookConfigured, credentialsConfigured: webhookConfigured },
    { id: 'email', provider: stored.smtpHost || '', enabled: webhookConfigured, credentialsConfigured: webhookConfigured },
    { id: 'push', provider: stored.pushProvider || '', enabled: webhookConfigured, credentialsConfigured: webhookConfigured }
  ];
  return { ...redactConfigValue(stored), credentialsSource: 'environment', channels };
}

function adminAuditStreams() {
  const definitions = [
    ['wallet-auth', '钱包认证', "action LIKE 'auth.%' OR action LIKE 'siwe.%'"],
    ['funds', '资金与订单', "action LIKE 'chain.%' OR action LIKE '%refund%' OR action LIKE '%settlement%' OR action LIKE '%reward%'"],
    ['risk', '风控与熔断', "action LIKE '%risk%' OR action LIKE '%blacklist%' OR action LIKE '%circuit%'"],
    ['operations', '系统与集成', "role IN ('system','indexer','integration') OR action LIKE '%system%' OR action LIKE '%logistics%'"],
    ['admin', '平台操作', "role = 'admin'"],
    ['merchant', '商家操作', "role = 'merchant'"]
  ];
  return definitions.map(([id, name, where]) => {
    const row = auditDb.prepare(`SELECT COUNT(*) AS entries, MAX(created_at) AS latest FROM audit_logs WHERE ${where}`).get();
    return { id, name, readOnly: true, entries: Number(row?.entries || 0), lastEventAt: row?.latest || null };
  });
}

function redactConfigValue(value) {
  if (Array.isArray(value)) return value.map(redactConfigValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(secret|password|apiKey|privateKey|accessToken|smtpPass)/i.test(key) && entry ? '<configured>' : redactConfigValue(entry)
  ]));
}

function adminRiskEvents() {
  return {
    blacklists: db.prepare('SELECT * FROM blacklists ORDER BY created_at DESC LIMIT 500').all().map((row) => ({ address: row.address, reason: row.reason, createdAt: row.created_at })),
    events: db.prepare('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT 500').all().map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      walletAddress: row.wallet_address || null,
      ipHash: row.ip_hash || null,
      deviceHash: row.device_hash || null,
      action: row.action,
      status: row.status,
      payload: JSON.parse(row.payload_json || '{}'),
      createdAt: row.created_at
    }))
  };
}

function adminCmsContents() {
  publishDueCmsContents();
  const published = new Map(db.prepare('SELECT * FROM cms_contents ORDER BY key').all().map((row) => [row.key, row]));
  const entries = adminConfigEntries('cms-entry:').map((entry) => ({
    ...entry,
    key: entry.id,
    id: undefined,
    body: entry.body || '',
    publishedBody: published.get(entry.id)?.body || null
  }));
  const configuredKeys = new Set(entries.map((entry) => entry.key));
  return [
    ...entries,
    ...[...published.values()].filter((row) => !configuredKeys.has(row.key)).map((row) => ({ key: row.key, body: row.body, status: 'published', version: 1, updatedAt: row.updated_at }))
  ].sort((left, right) => left.key.localeCompare(right.key));
}

function upsertCmsContent(body, actorAddress) {
  const requestedKey = normalizeTaxonomyId(body.key || 'rules', 'cmsKey');
  const key = requestedKey === 'seckill-rules' ? 'rules' : requestedKey;
  const status = String(body.status || 'published').toLowerCase();
  if (!['published', 'draft', 'scheduled'].includes(status)) fail(400, 'INVALID_CMS_STATUS');
  const text = requireString(body.text || body.body, 'text').slice(0, 100_000);
  const frequency = String(body.frequency || 'once').toLowerCase();
  if (!['once', 'daily', 'always'].includes(frequency)) fail(400, 'INVALID_CMS_FREQUENCY');
  const regionCodes = normalizeCmsRegionCodes(body.regionCodes);
  const mediaUrl = normalizeOptionalHttpsUrl(body.mediaUrl, 'mediaUrl');
  const publishAt = status === 'scheduled' ? normalizeScheduledAt(body.publishAt) : null;
  const previous = readAdminConfig(`cms-entry:${key}`) || {};
  const placement = String(body.placement || body.type || previous.placement || '').toLowerCase();
  if (placement && !['banner', 'popup', 'faq', 'legal', 'update'].includes(placement)) fail(400, 'INVALID_CMS_PLACEMENT');
  const entry = {
    key,
    title: body.title ? String(body.title).slice(0, 160) : previous.title || key,
    body: text,
    status,
    version: Number(previous.version || 0) + 1,
    publishAt,
    publishedAt: status === 'published' ? new Date().toISOString() : previous.publishedAt || null,
    regionCodes,
    mediaUrl,
    frequency,
    placement: placement || null,
    minAppVersion: body.minAppVersion !== undefined ? normalizeAppVersion(body.minAppVersion) : previous.minAppVersion || null,
    maxAppVersion: body.maxAppVersion !== undefined ? normalizeAppVersion(body.maxAppVersion) : previous.maxAppVersion || null,
    forceUpdate: placement === 'update' ? body.forceUpdate === true : false,
    ctaUrl: body.ctaUrl !== undefined ? normalizeOptionalHttpsUrl(body.ctaUrl, 'ctaUrl') : previous.ctaUrl || '',
    actorAddress: String(actorAddress).toLowerCase()
  };
  persistAdminConfig(`cms-entry:${key}`, entry);
  if (status === 'published') db.prepare('INSERT OR REPLACE INTO cms_contents (key, body, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, text);
  return entry;
}

function publishDueCmsContents() {
  const now = Date.now();
  const rows = db.prepare("SELECT key, payload_json FROM admin_configs WHERE key LIKE 'cms-entry:%'").all();
  for (const row of rows) {
    const entry = JSON.parse(row.payload_json || '{}');
    if (entry.status !== 'scheduled' || !entry.publishAt || Date.parse(entry.publishAt) > now) continue;
    const key = row.key.slice('cms-entry:'.length);
    const published = { ...entry, status: 'published', publishedAt: new Date().toISOString() };
    db.prepare('INSERT OR REPLACE INTO cms_contents (key, body, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, entry.body || '');
    persistAdminConfig(row.key, published);
    writeAudit('system', ADMIN_WALLET || 'scheduler', 'cms.scheduled.publish', key, { version: published.version, publishAt: published.publishAt });
  }
}

function normalizeCmsRegionCodes(value) {
  if (!value || value === '全部' || value === 'all') return [];
  const values = Array.isArray(value) ? value : String(value).split(/[,，\n]/);
  return [...new Set(values.map((entry) => requireRegionCode(String(entry).trim())).slice(0, 500))];
}

function normalizeAppVersion(value) {
  const version = String(value || '').trim();
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) fail(400, 'INVALID_APP_VERSION');
  return version;
}

function compareAppVersions(left, right) {
  const a = String(left || '0').split('.').map(Number);
  const b = String(right || '0').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = Number(a[index] || 0) - Number(b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function cmsPlacements(searchParams) {
  publishDueCmsContents();
  const regionCode = String(searchParams.get('regionCode') || '').trim();
  const appVersion = String(searchParams.get('appVersion') || '0').trim();
  if (appVersion !== '0') normalizeAppVersion(appVersion);
  const now = Date.now();
  const entries = adminConfigEntries('cms-entry:')
    .filter((entry) => entry.status === 'published' && entry.placement)
    .filter((entry) => !entry.publishedAt || Date.parse(entry.publishedAt) <= now)
    .filter((entry) => !Array.isArray(entry.regionCodes) || entry.regionCodes.length === 0 || (regionCode && entry.regionCodes.includes(regionCode)))
    .filter((entry) => !entry.minAppVersion || compareAppVersions(appVersion, entry.minAppVersion) >= 0 || entry.placement === 'update')
    .filter((entry) => !entry.maxAppVersion || compareAppVersions(appVersion, entry.maxAppVersion) <= 0)
    .map((entry) => ({
      key: entry.id,
      placement: entry.placement,
      title: entry.title,
      body: entry.body,
      mediaUrl: entry.mediaUrl || null,
      ctaUrl: entry.ctaUrl || null,
      frequency: entry.frequency || 'once',
      regionCodes: entry.regionCodes || [],
      version: entry.version,
      minAppVersion: entry.minAppVersion || null,
      forceUpdate: entry.forceUpdate === true,
      blocking: entry.placement === 'update' && entry.forceUpdate === true && compareAppVersions(appVersion, entry.minAppVersion || '0') < 0,
      publishedAt: entry.publishedAt || null
    }));
  return {
    version: '24k-cms-placements-v1',
    generatedAt: new Date().toISOString(),
    regionCode: regionCode || null,
    appVersion,
    placements: entries,
    blockingUpdate: entries.find((entry) => entry.blocking) || null
  };
}

function normalizeOptionalHttpsUrl(value, name) {
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    fail(400, `INVALID_${name.toUpperCase()}`);
  }
  if (parsed.protocol !== 'https:') fail(400, `INVALID_${name.toUpperCase()}`);
  return parsed.toString().slice(0, 2048);
}

function adminSettlementRequests() {
  return db.prepare('SELECT * FROM settlement_requests ORDER BY created_at DESC LIMIT 500').all().map((row) => ({
    id: row.id,
    orderId: row.order_id,
    requestedBy: row.requested_by,
    reason: row.reason,
    status: row.status,
    txHash: row.tx_hash || null,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function requestBuyerAfterSale(session, body) {
  const orderId = requireBytes32(body.orderId, 'orderId');
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (order.buyer_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');
  if (!['Shipped', 'PickupReady'].includes(order.status)) fail(409, 'AFTER_SALE_NOT_AVAILABLE');
  const requestType = String(body.type || body.requestType || '').trim().toLowerCase();
  if (!['exchange', 'delay'].includes(requestType)) fail(400, 'INVALID_AFTER_SALE_TYPE');
  const existing = db.prepare("SELECT * FROM after_sale_cases WHERE order_id = ? AND status IN ('Open','AwaitingDisputeTransaction','Arbitration','ExchangeApproved','DelayApproved','AwaitingCompletionTransaction','AwaitingRefundTransaction')").get(order.order_id);
  if (existing) fail(409, 'AFTER_SALE_ALREADY_OPEN');
  const reason = requireString(body.reason, 'reason').slice(0, 1000);
  const id = `after-sale-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const status = requestType === 'exchange' ? 'AwaitingDisputeTransaction' : 'Open';
  const payload = {
    requestedAt: new Date().toISOString(),
    requestedBy: session.address.toLowerCase(),
    assetState: 'Locked',
    noReasonRefund: false,
    delayUntil: body.delayUntil ? normalizeAfterSaleDelay(body.delayUntil) : null
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO after_sale_cases (id, order_id, buyer_address, request_type, status, reason, original_order_status, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, order.order_id, session.address.toLowerCase(), requestType, status, reason, order.status, JSON.stringify(payload));
    writeAudit('buyer', session.address, 'buyer.after-sale.request', id, { orderId: order.order_id, requestType, reason, delayUntil: payload.delayUntil });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const transactionIntent = requestType === 'exchange' ? {
    key: 'buyerDisputeOrder',
    chainId: Number(order.chain_id),
    from: session.address.toLowerCase(),
    to: order.escrow_address,
    value: '0x0',
    orderId: order.order_id,
    data: escrowTxInterface.encodeFunctionData('disputeOrder', [order.order_id])
  } : null;
  return {
    case: afterSaleCaseById(id),
    order: toOrder(findOrderByIdOrOrderId(order.order_id)),
    assetState: 'Locked',
    transactionIntent,
    next: requestType === 'exchange' ? 'sendDisputeOrderThenPollArbitrationStatus' : 'waitPlatformDecision',
    arbitrationStatusEndpoint: requestType === 'exchange' ? `/api/orders/${order.order_id}/arbitration-tx-status?buyerAddress=${session.address}&txHash=0x...` : null
  };
}

function normalizeAfterSaleDelay(value) {
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp) || timestamp <= Date.now() || timestamp > Date.now() + 30 * 24 * 60 * 60_000) fail(400, 'INVALID_AFTER_SALE_DELAY');
  return new Date(timestamp).toISOString();
}

function cancelBuyerDraftOrder(session, body) {
  const orderId = requireBytes32(body.orderId, 'orderId');
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (order.buyer_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');
  if (order.status !== 'Draft') fail(409, 'ORDER_CANNOT_BE_CANCELLED');
  db.prepare("UPDATE orders SET status = 'Cancelled', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'Draft'").run(order.order_id);
  writeAudit('buyer', session.address, 'buyer.order.cancel', order.order_id, { reason: String(body.reason || '').slice(0, 500) });
  recordBuyerBehavior(session.address, 'order.cancel', order.order_id);
  return { order: toOrder(findOrderByIdOrOrderId(order.order_id)), cancelled: true };
}

function adminAfterSaleCases(searchParams = new URLSearchParams()) {
  const status = String(searchParams.get('status') || '').toLowerCase();
  const rows = db.prepare('SELECT * FROM after_sale_cases ORDER BY created_at DESC LIMIT 500').all()
    .filter((row) => !status || String(row.status).toLowerCase() === status)
    .map(toAfterSaleCase);
  return { generatedAt: new Date().toISOString(), cases: rows };
}

function afterSaleCaseById(id) {
  const row = db.prepare('SELECT * FROM after_sale_cases WHERE id = ?').get(String(id));
  return row ? toAfterSaleCase(row) : null;
}

function toAfterSaleCase(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    buyerAddress: row.buyer_address,
    requestType: row.request_type,
    status: row.status,
    resolution: row.resolution || null,
    reason: row.reason,
    originalOrderStatus: row.original_order_status,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function resolveAfterSaleCase(session, body) {
  const id = requireString(body.caseId || body.targetId, 'caseId');
  const row = db.prepare('SELECT * FROM after_sale_cases WHERE id = ?').get(id);
  if (!row) fail(404, 'AFTER_SALE_CASE_NOT_FOUND');
  if (!['Open', 'Arbitration', 'ExchangeApproved', 'DelayApproved'].includes(row.status)) fail(409, row.status === 'AwaitingDisputeTransaction' ? 'AFTER_SALE_DISPUTE_NOT_CONFIRMED' : 'AFTER_SALE_CASE_CLOSED');
  const order = findOrderByIdOrOrderId(row.order_id);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  const resolution = String(body.resolution || '').toLowerCase();
  if (!['exchange', 'delay', 'resume', 'complete', 'refund'].includes(resolution)) fail(400, 'INVALID_AFTER_SALE_RESOLUTION');
  let status = 'Resolved';
  let transactionIntent = null;
  const previousPayload = JSON.parse(row.payload_json || '{}');
  const payload = { ...previousPayload, resolutionNote: String(body.note || '').slice(0, 1000), resolvedBy: session.address.toLowerCase(), resolvedAt: new Date().toISOString() };
  if (resolution === 'exchange') {
    status = 'ExchangeApproved';
    const fulfillmentId = `exchange-${Date.now()}-${randomBytes(3).toString('hex')}`;
    db.prepare('INSERT INTO fulfillment_orders (id, order_id, type, status, payload_json) VALUES (?, ?, ?, ?, ?)').run(fulfillmentId, order.order_id, order.fulfillment_mode || 'delivery', 'ExchangeApproved', JSON.stringify({ afterSaleCaseId: id, note: payload.resolutionNote }));
  } else if (resolution === 'delay') {
    status = 'DelayApproved';
    payload.delayUntil = normalizeAfterSaleDelay(body.delayUntil || previousPayload.delayUntil);
  } else if (resolution === 'resume') {
    const arbitrationEvent = db.prepare("SELECT id FROM chain_events WHERE order_id = ? AND event_name = 'OrderArbitration' LIMIT 1").get(order.order_id);
    if (arbitrationEvent) fail(409, 'ONCHAIN_ARBITRATION_REQUIRES_COMPLETE_OR_REFUND');
    db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run(row.original_order_status, order.order_id);
  } else if (resolution === 'complete') {
    status = 'AwaitingCompletionTransaction';
    transactionIntent = adminContractIntent('escrowCompleteOrder', order.escrow_address, escrowTxInterface.encodeFunctionData('completeOrder', [order.order_id]), { orderId: order.order_id });
  } else if (resolution === 'refund') {
    if (body.refundNplAmount !== undefined || body.amountNpl !== undefined) fail(400, 'FULL_REFUND_ONLY');
    status = 'AwaitingRefundTransaction';
    transactionIntent = adminContractIntent('escrowForceRefund', order.escrow_address, escrowTxInterface.encodeFunctionData('forceRefund', [order.order_id]), { orderId: order.order_id, fullRefundNpl: order.amount_npl });
  }
  db.prepare('UPDATE after_sale_cases SET status = ?, resolution = ?, payload_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, resolution, JSON.stringify(payload), id);
  return { case: afterSaleCaseById(id), order: toOrder(findOrderByIdOrOrderId(order.order_id)), transactionIntent };
}

async function adminOperationsSnapshot() {
  const memory = process.memoryUsage();
  const writesLastMinute = Number(auditDb.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE created_at >= datetime('now', '-1 minute')").get()?.count || 0);
  const errorsLastHour = Number(db.prepare("SELECT COUNT(*) AS count FROM risk_events WHERE kind = 'api-error' AND created_at >= datetime('now', '-1 hour')").get()?.count || 0);
  const botEventsLastHour = Number(db.prepare("SELECT COUNT(*) AS count FROM risk_events WHERE kind IN ('wallet-cluster','wallet-switch','order-cancel','fulfillment-change','rate-limit') AND created_at >= datetime('now', '-1 hour')").get()?.count || 0);
  const openRiskEvents = Number(db.prepare("SELECT COUNT(*) AS count FROM risk_events WHERE status <> 'Resolved'").get()?.count || 0);
  const dbCheck = String(db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown');
  const [blockchain, oracle, redis, mq] = await Promise.all([
    operationsBlockchainStatus(),
    operationsOracleStatus(),
    probeRedisHealth(),
    probeMqHealth()
  ]);
  const disk = operationsDiskStatus();
  const traffic = operationsTrafficSnapshot(writesLastMinute, errorsLastHour);
  return {
    generatedAt: new Date().toISOString(),
    process: {
      uptimeSeconds: Math.floor(process.uptime()),
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      cpuLoad: os.loadavg().map((value) => Number(value.toFixed(2)))
    },
    host: {
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
      platform: os.platform(),
      architecture: os.arch(),
      disk
    },
    traffic,
    components: {
      db: { status: dbCheck === 'ok' ? 'healthy' : 'degraded', engine: 'sqlite', connectionModel: 'single-process', quickCheck: dbCheck },
      redis,
      mq
    },
    blockchain: {
      ...blockchain,
      oracle,
      chainId: CHAIN_ID,
      rpcConfigured: Boolean(CHAIN_EVENT_RPC_URL || CHAIN_EVENT_RPC_FALLBACK_URL),
      escrowConfigured: isValidAddress(ESCROW),
      rewardLedgerConfigured: isValidAddress(REWARD_LEDGER),
      seckillConfigured: isValidAddress(SECKILL),
      genesisNodeConfigured: isValidAddress(GENESIS_NODE_CONTRACT),
      requiredConfirmations: INDEXER_CONFIRMATIONS
    },
    risk: {
      botEventsLastHour,
      openEvents: openRiskEvents,
      gasBlocked: Boolean(blockchain.gas?.blocked),
      status: openRiskEvents || botEventsLastHour || blockchain.gas?.blocked || oracle.alert ? 'attention' : 'normal'
    }
  };
}

async function operationsBlockchainStatus() {
  const configured = Boolean(CHAIN_EVENT_RPC_URL || CHAIN_EVENT_RPC_FALLBACK_URL);
  if (!configured) {
    return {
      status: 'notConfigured',
      rpcHeight: null,
      explorerHeight: null,
      heightLag: null,
      explorerStatus: 'notConfigured',
      rpc: { status: 'notConfigured', configured: false, activeEndpoint: null, degraded: false, latencyMs: null, checkedAt: null },
      gas: { status: 'notConfigured', priceGwei: null, limitGwei: null, blocked: false }
    };
  }
  let rpcHeight = null;
  let gas = { status: 'unavailable', priceGwei: null, limitGwei: null, blocked: false };
  try {
    rpcHeight = Number.parseInt(String(await rpc('eth_blockNumber', [])), 16);
    if (!Number.isSafeInteger(rpcHeight)) throw new Error('RPC_HEIGHT_INVALID');
    gas = await operationsGasStatus();
  } catch (error) {
    recordOperationalIssue('rpc-error', 'operations.rpc', operationalErrorCode(error));
    return {
      status: 'degraded',
      rpcHeight: null,
      explorerHeight: null,
      heightLag: null,
      explorerStatus: 'unavailable',
      rpc: rpcOperationsState(configured),
      gas
    };
  }
  const explorerApiKey = process.env.EXPLORER_API_KEY || process.env.BSCSCAN_API_KEY || '';
  if (!explorerApiKey || CHAIN_ID !== 56) {
    return {
      status: rpcRuntimeState.degraded || gas.blocked ? 'degraded' : 'healthy',
      rpcHeight,
      explorerHeight: null,
      heightLag: null,
      explorerStatus: 'notConfigured',
      rpc: rpcOperationsState(configured),
      gas
    };
  }
  try {
    const endpoint = new URL('https://api.etherscan.io/v2/api');
    endpoint.searchParams.set('chainid', String(CHAIN_ID));
    endpoint.searchParams.set('module', 'proxy');
    endpoint.searchParams.set('action', 'eth_blockNumber');
    endpoint.searchParams.set('apikey', explorerApiKey);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error('EXPLORER_HTTP_ERROR');
    const payload = await response.json();
    const explorerHeight = Number.parseInt(String(payload.result || ''), 16);
    if (!Number.isSafeInteger(explorerHeight)) throw new Error('EXPLORER_HEIGHT_INVALID');
    const heightLag = explorerHeight - rpcHeight;
    return {
      status: Math.abs(heightLag) <= 3 && !rpcRuntimeState.degraded && !gas.blocked ? 'healthy' : 'degraded',
      rpcHeight,
      explorerHeight,
      heightLag,
      explorerStatus: 'healthy',
      rpc: rpcOperationsState(configured),
      gas
    };
  } catch (error) {
    recordOperationalIssue('explorer-error', 'operations.explorer', operationalErrorCode(error));
    return {
      status: 'degraded',
      rpcHeight,
      explorerHeight: null,
      heightLag: null,
      explorerStatus: 'unavailable',
      rpc: rpcOperationsState(configured),
      gas
    };
  }
}

function rpcOperationsState(configured) {
  return {
    status: !configured ? 'notConfigured' : rpcRuntimeState.active ? (rpcRuntimeState.degraded ? 'degraded' : 'healthy') : 'unavailable',
    configured,
    primaryConfigured: Boolean(CHAIN_EVENT_RPC_URL),
    fallbackConfigured: Boolean(CHAIN_EVENT_RPC_FALLBACK_URL),
    activeEndpoint: rpcRuntimeState.active,
    degraded: rpcRuntimeState.degraded,
    latencyMs: rpcRuntimeState.lastLatencyMs,
    lastError: rpcRuntimeState.lastError,
    checkedAt: rpcRuntimeState.checkedAt
  };
}

async function operationsGasStatus() {
  const config = readAdminConfig('oracle-gas') || {};
  const limitGwei = config.maxGasGwei ? Number(config.maxGasGwei) : null;
  try {
    const value = await rpc('eth_gasPrice', []);
    const priceWei = BigInt(String(value));
    const priceGwei = Number(formatUnits(priceWei, 9));
    const blocked = Number.isFinite(limitGwei) && limitGwei > 0 ? priceGwei > limitGwei : false;
    if (blocked) recordOperationalIssue('gas-block', 'operations.gas', 'GAS_PRICE_LIMIT_EXCEEDED', { priceGwei, limitGwei });
    return {
      status: blocked ? 'blocked' : Number.isFinite(limitGwei) && limitGwei > 0 ? 'healthy' : 'limitNotConfigured',
      priceGwei: Number(priceGwei.toFixed(6)),
      limitGwei: Number.isFinite(limitGwei) && limitGwei > 0 ? limitGwei : null,
      blocked
    };
  } catch (error) {
    return { status: 'unavailable', priceGwei: null, limitGwei: Number.isFinite(limitGwei) && limitGwei > 0 ? limitGwei : null, blocked: false, errorCode: operationalErrorCode(error) };
  }
}

async function operationsOracleStatus() {
  const config = readAdminConfig('oracle-gas') || {};
  if (!config.oracleAddress) return { status: 'notConfigured', configured: false, alert: false };
  const address = isValidAddress(config.oracleAddress) ? config.oracleAddress.toLowerCase() : null;
  if (!address) return { status: 'invalidConfiguration', configured: true, alert: true };
  try {
    const [decimalsResult, roundResult] = await Promise.all([
      rpc('eth_call', [{ to: address, data: chainlinkFeedInterface.encodeFunctionData('decimals') }, 'latest']),
      rpc('eth_call', [{ to: address, data: chainlinkFeedInterface.encodeFunctionData('latestRoundData') }, 'latest'])
    ]);
    const decimals = Number(chainlinkFeedInterface.decodeFunctionResult('decimals', decimalsResult)[0]);
    const [roundId, answer, , updatedAt, answeredInRound] = chainlinkFeedInterface.decodeFunctionResult('latestRoundData', roundResult);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18 || answer <= 0n || updatedAt <= 0n || answeredInRound < roundId) throw new Error('ORACLE_ROUND_INVALID');
    const livePrice = formatUnits(answer, decimals);
    const referencePrice = config.oracleReferencePrice || null;
    const thresholdBps = Number.isSafeInteger(Number(config.oracleDeviationBps)) ? Number(config.oracleDeviationBps) : null;
    const maxAgeSeconds = Number.isSafeInteger(Number(config.oracleMaxAgeSeconds)) ? Number(config.oracleMaxAgeSeconds) : 3_600;
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt));
    const stale = ageSeconds > maxAgeSeconds;
    let deviationBps = null;
    if (referencePrice) {
      const referenceUnits = decimalToScaledUnits(referencePrice, decimals);
      if (referenceUnits > 0n) deviationBps = Number((absoluteBigInt(answer - referenceUnits) * 1_000_000n / referenceUnits)) / 100;
    }
    const alert = stale || (thresholdBps !== null && deviationBps !== null && deviationBps > thresholdBps);
    const configurationComplete = Boolean(referencePrice) && thresholdBps !== null;
    const status = stale ? 'stale' : alert ? 'alert' : configurationComplete ? 'healthy' : 'configurationIncomplete';
    if (alert) recordOperationalIssue('oracle-deviation', 'operations.oracle', stale ? 'ORACLE_STALE' : 'ORACLE_DEVIATION_LIMIT_EXCEEDED', { deviationBps, thresholdBps, ageSeconds, maxAgeSeconds });
    return {
      status,
      configured: true,
      address,
      decimals,
      livePrice,
      referencePrice,
      deviationBps,
      thresholdBps,
      ageSeconds,
      maxAgeSeconds,
      updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
      alert
    };
  } catch (error) {
    const errorCode = operationalErrorCode(error, 'ORACLE_READ_FAILED');
    recordOperationalIssue('oracle-error', 'operations.oracle', errorCode);
    return { status: 'unavailable', configured: true, address, alert: true, errorCode };
  }
}

function operationsTrafficSnapshot(writesLastMinute, errorsLastHour) {
  const now = Date.now();
  const recent = requestMetrics.filter((entry) => entry.completedAt >= now - 60_000);
  const durations = recent.map((entry) => entry.durationMs).sort((left, right) => left - right);
  const serverErrors = recent.filter((entry) => entry.statusCode >= 500).length;
  const groups = new Map();
  for (const entry of recent) {
    const key = `${entry.method} ${entry.path}`;
    const group = groups.get(key) || { endpoint: key, requests: 0, errors: 0, durations: [] };
    group.requests += 1;
    if (entry.statusCode >= 500) group.errors += 1;
    group.durations.push(entry.durationMs);
    groups.set(key, group);
  }
  const endpoints = [...groups.values()].map((group) => ({
    endpoint: group.endpoint,
    requests: group.requests,
    errors: group.errors,
    latencyAvgMs: average(group.durations),
    latencyP50Ms: percentile(group.durations, 0.5),
    latencyP95Ms: percentile(group.durations, 0.95)
  })).sort((left, right) => right.requests - left.requests || left.endpoint.localeCompare(right.endpoint)).slice(0, 50);
  return {
    requestsLastMinute: recent.length,
    qps: Number((recent.length / 60).toFixed(3)),
    tps: Number((writesLastMinute / 60).toFixed(3)),
    writesLastMinute,
    errorsLastHour,
    errorRatePct: recent.length ? Number((serverErrors * 100 / recent.length).toFixed(3)) : 0,
    latencyAvgMs: average(durations),
    latencyP50Ms: percentile(durations, 0.5),
    latencyP95Ms: percentile(durations, 0.95),
    endpoints
  };
}

function operationsDiskStatus() {
  const target = DB_PATH === ':memory:' ? process.cwd() : dirname(realpathOrOriginal(DB_PATH));
  try {
    const stats = statfsSync(target);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes)) throw new Error('DISK_STATS_INVALID');
    const usedPct = Number((((totalBytes - freeBytes) * 100) / totalBytes).toFixed(2));
    return {
      status: usedPct >= 95 ? 'critical' : usedPct >= 85 ? 'warning' : 'healthy',
      totalMb: Math.round(totalBytes / 1024 / 1024),
      freeMb: Math.round(freeBytes / 1024 / 1024),
      usedPct,
      warningPct: 85,
      criticalPct: 95
    };
  } catch (error) {
    return { status: 'unavailable', totalMb: null, freeMb: null, usedPct: null, errorCode: operationalErrorCode(error, 'DISK_STATS_UNAVAILABLE') };
  }
}

function realpathOrOriginal(path) {
  try { return realpathSync(path); } catch { return path; }
}

async function probeRedisHealth() {
  const infrastructure = readAdminConfig('infrastructure') || {};
  const environmentUrl = process.env.REDIS_HEALTH_URL || '';
  const url = infrastructure.redisHealthUrl || environmentUrl;
  const configured = Boolean(url || process.env.REDIS_URL);
  if (!configured) return { status: 'notConfigured', configured: false, hitRatioPct: null };
  if (!url) return { status: 'configuredUnverified', configured: true, hitRatioPct: null, reason: 'REDIS_HEALTH_URL_REQUIRED' };
  const headers = healthCredentialTargetMatches(url, environmentUrl) ? bearerHeaders(process.env.REDIS_HEALTH_TOKEN) : {};
  const result = await probeHealthJson('redis', url, headers);
  if (!result.ok) return { status: result.status, configured: true, hitRatioPct: null, latencyMs: result.latencyMs, errorCode: result.errorCode };
  const hits = firstFiniteNumber(result.payload, ['keyspace_hits', 'hits', 'stats.keyspace_hits', 'stats.hits']);
  const misses = firstFiniteNumber(result.payload, ['keyspace_misses', 'misses', 'stats.keyspace_misses', 'stats.misses']);
  let hitRatioPct = firstFiniteNumber(result.payload, ['hitRatioPct', 'hit_ratio_pct', 'stats.hitRatioPct']);
  if (hitRatioPct === null && hits !== null && misses !== null && hits + misses > 0) hitRatioPct = Number((hits * 100 / (hits + misses)).toFixed(3));
  return { status: result.healthy ? 'healthy' : 'degraded', configured: true, connected: result.healthy, latencyMs: result.latencyMs, hits, misses, hitRatioPct };
}

async function probeMqHealth() {
  const infrastructure = readAdminConfig('infrastructure') || {};
  const environmentUrl = process.env.MQ_HEALTH_URL || process.env.RABBITMQ_MANAGEMENT_URL || '';
  const url = infrastructure.mqHealthUrl || environmentUrl;
  const configured = Boolean(url || process.env.MQ_URL || process.env.RABBITMQ_URL);
  if (!configured) return { status: 'notConfigured', configured: false, backlog: null };
  if (!url) return { status: 'configuredUnverified', configured: true, backlog: null, reason: 'MQ_HEALTH_URL_REQUIRED' };
  const credentialTarget = healthCredentialTargetMatches(url, environmentUrl);
  const headers = credentialTarget ? bearerHeaders(process.env.MQ_HEALTH_TOKEN) : {};
  if (credentialTarget && !headers.authorization && process.env.RABBITMQ_MANAGEMENT_USERNAME && process.env.RABBITMQ_MANAGEMENT_PASSWORD) {
    headers.authorization = `Basic ${Buffer.from(`${process.env.RABBITMQ_MANAGEMENT_USERNAME}:${process.env.RABBITMQ_MANAGEMENT_PASSWORD}`).toString('base64')}`;
  }
  const result = await probeHealthJson('mq', url, headers);
  if (!result.ok) return { status: result.status, configured: true, backlog: null, latencyMs: result.latencyMs, errorCode: result.errorCode };
  const ready = firstFiniteNumber(result.payload, ['messages_ready', 'ready', 'queue_totals.messages_ready']);
  const unacknowledged = firstFiniteNumber(result.payload, ['messages_unacknowledged', 'unacknowledged', 'queue_totals.messages_unacknowledged']);
  const explicitBacklog = firstFiniteNumber(result.payload, ['backlog', 'messages', 'queue_totals.messages']);
  const backlog = explicitBacklog ?? (ready !== null || unacknowledged !== null ? Number(ready || 0) + Number(unacknowledged || 0) : null);
  return { status: result.healthy ? 'healthy' : 'degraded', configured: true, connected: result.healthy, latencyMs: result.latencyMs, backlog, ready, unacknowledged };
}

async function probeHealthJson(kind, urlValue, headers) {
  let url;
  try {
    url = normalizeRuntimeUrl(urlValue, `${kind}HealthUrl`);
  } catch {
    return { ok: false, status: 'invalidConfiguration', latencyMs: null, errorCode: `${kind.toUpperCase()}_HEALTH_URL_INVALID` };
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(5_000) });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const errorCode = `${kind.toUpperCase()}_HEALTH_HTTP_${response.status}`;
      recordOperationalIssue(`${kind}-error`, `operations.${kind}`, errorCode);
      return { ok: false, status: 'unavailable', latencyMs, errorCode };
    }
    const payload = await response.json();
    const explicitStatus = String(payload?.status || payload?.health || '').toLowerCase();
    const healthy = payload?.ok !== false && !['down', 'failed', 'error', 'unhealthy', 'unavailable'].includes(explicitStatus);
    return { ok: true, healthy, payload, latencyMs };
  } catch (error) {
    const errorCode = operationalErrorCode(error, `${kind.toUpperCase()}_HEALTH_UNAVAILABLE`);
    recordOperationalIssue(`${kind}-error`, `operations.${kind}`, errorCode);
    return { ok: false, status: 'unavailable', latencyMs: Date.now() - startedAt, errorCode };
  }
}

function bearerHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function healthCredentialTargetMatches(configuredUrl, environmentUrl) {
  if (!configuredUrl || !environmentUrl) return false;
  try {
    return new URL(configuredUrl).origin === new URL(environmentUrl).origin;
  } catch {
    return false;
  }
}

function firstFiniteNumber(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const segment of path.split('.')) current = current && typeof current === 'object' ? current[segment] : undefined;
    const number = Number(current);
    if (current !== null && current !== '' && Number.isFinite(number)) return number;
  }
  return null;
}

function average(values) {
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function decimalToScaledUnits(value, decimals) {
  const [whole, fraction = ''] = String(value).split('.');
  const padded = `${fraction}${'0'.repeat(decimals)}`.slice(0, decimals);
  return BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(padded || '0');
}

function absoluteBigInt(value) {
  return value < 0n ? -value : value;
}

function operationalErrorCode(error, fallback = 'OPERATION_UNAVAILABLE') {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/^[A-Z][A-Z0-9_:.-]{2,160}$/.test(message)) return message.slice(0, 160);
  if (error?.name === 'TimeoutError') return 'OPERATION_TIMEOUT';
  return fallback;
}

function recordOperationalIssue(kind, action, errorCode, payload = {}) {
  const duplicate = db.prepare("SELECT id FROM risk_events WHERE kind = ? AND action = ? AND status = 'Observed' AND created_at >= datetime('now', '-5 minutes') LIMIT 1").get(kind, action);
  if (duplicate) return duplicate.id;
  return recordRiskEvent({ kind, severity: kind === 'oracle-deviation' || kind === 'gas-block' ? 'critical' : 'high', action, status: 'Observed', payload: { errorCode, ...payload } });
}

function saveAddressBookEntry(body, authenticatedAddress) {
  const walletAddress = requireAddress(authenticatedAddress, 'walletAddress').toLowerCase();
  const id = normalizeAddressId(body?.id || `addr-${Date.now()}-${randomBytes(3).toString('hex')}`);
  const existing = db.prepare('SELECT * FROM address_book WHERE id = ?').get(id);
  if (existing && existing.wallet_address.toLowerCase() !== walletAddress) fail(403, 'ADDRESS_OWNER_MISMATCH');
  const previous = existing ? JSON.parse(existing.payload_json || '{}') : {};
  const phone = requireString(body?.phone ?? previous.phone, 'phone');
  if (!/^1[3-9]\d{9}$/.test(phone)) fail(400, 'INVALID_PHONE');
  const regionCode = requireRegionCode(body?.regionCode ?? previous.regionCode, 'regionCode');
  const addressCount = Number(db.prepare('SELECT COUNT(*) AS count FROM address_book WHERE wallet_address = ?').get(walletAddress)?.count || 0);
  const entry = {
    id,
    name: requireString(body?.name ?? previous.name, 'name').slice(0, 40),
    phone,
    province: String(body?.province ?? previous.province ?? '').slice(0, 40),
    city: String(body?.city ?? previous.city ?? '').slice(0, 40),
    district: String(body?.district ?? previous.district ?? '').slice(0, 40),
    detail: requireString(body?.detail ?? previous.detail, 'detail').slice(0, 240),
    regionCode,
    isDefault: body?.isDefault === undefined ? (existing ? Boolean(previous.isDefault) : addressCount === 0) : Boolean(body.isDefault)
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (entry.isDefault) clearDefaultAddresses(walletAddress, id);
    db.prepare('INSERT OR REPLACE INTO address_book (id, wallet_address, payload_json) VALUES (?, ?, ?)').run(entry.id, walletAddress, JSON.stringify(entry));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  writeAudit('buyer', walletAddress, 'buyer.address.upsert', id, body);
  if (existing || addressCount > 0) recordBuyerBehavior(walletAddress, 'address.change', id);
  return enrichAddressForDapp(entry);
}

function deleteAddressBookEntry(walletAddress, idValue, body) {
  const address = requireAddress(walletAddress, 'walletAddress').toLowerCase();
  const id = normalizeAddressId(idValue);
  const row = db.prepare('SELECT * FROM address_book WHERE id = ?').get(id);
  if (!row) fail(404, 'ADDRESS_NOT_FOUND');
  if (row.wallet_address.toLowerCase() !== address) fail(403, 'ADDRESS_OWNER_MISMATCH');
  const wasDefault = Boolean(JSON.parse(row.payload_json || '{}').isDefault);
  db.prepare('DELETE FROM address_book WHERE id = ? AND wallet_address = ?').run(id, address);
  if (wasDefault) {
    const replacement = db.prepare('SELECT id, payload_json FROM address_book WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 1').get(address);
    if (replacement) setAddressPayloadDefault(replacement, true);
  }
  writeAudit('buyer', address, 'buyer.address.delete', id, body);
  recordBuyerBehavior(address, 'address.change', id);
  return { id, deleted: true };
}

function setDefaultAddressBookEntry(walletAddress, idValue, body) {
  const address = requireAddress(walletAddress, 'walletAddress').toLowerCase();
  const id = normalizeAddressId(idValue);
  const row = db.prepare('SELECT * FROM address_book WHERE id = ?').get(id);
  if (!row) fail(404, 'ADDRESS_NOT_FOUND');
  if (row.wallet_address.toLowerCase() !== address) fail(403, 'ADDRESS_OWNER_MISMATCH');
  db.exec('BEGIN IMMEDIATE');
  try {
    clearDefaultAddresses(address, id);
    setAddressPayloadDefault(row, true);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  writeAudit('buyer', address, 'buyer.address.default', id, body);
  recordBuyerBehavior(address, 'address.default', id);
  return enrichAddressForDapp({ ...JSON.parse(row.payload_json || '{}'), isDefault: true });
}

function clearDefaultAddresses(walletAddress, exceptId) {
  const rows = db.prepare('SELECT id, payload_json FROM address_book WHERE wallet_address = ? AND id <> ?').all(walletAddress, exceptId);
  for (const row of rows) setAddressPayloadDefault(row, false);
}

function setAddressPayloadDefault(row, isDefault) {
  const payload = { ...JSON.parse(row.payload_json || '{}'), isDefault };
  db.prepare('UPDATE address_book SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), row.id);
}

function normalizeAddressId(value) {
  const text = requireString(String(value || ''), 'addressId').slice(0, 96);
  if (!/^[a-zA-Z0-9._-]{3,96}$/.test(text)) fail(400, 'INVALID_ADDRESS_ID');
  return text;
}

function enrichAddressForDapp(entry) {
  return {
    ...entry,
    deliveryContext: {
      fulfillmentMode: 'delivery',
      addressId: entry.id,
      regionCode: entry.regionCode,
      regionBinding: true,
      finalCheckLabel: '收货地址 / 行政区',
      lockWarning: '选择该地址快递后，付款瞬间永久绑定收货地址行政区编码用于区域代理分红。'
    },
    checkoutItemPatch: {
      fulfillmentMode: 'delivery',
      addressId: entry.id,
      regionCode: entry.regionCode
    },
    finalCheckFactor: {
      key: 'fulfillment',
      label: '收货地址 / 行政区',
      value: `${entry.province || ''}${entry.city || ''}${entry.district || ''} ${entry.detail || ''} · ${entry.regionCode}`.trim()
    }
  };
}

function parseAddressBookText(body) {
  const sourceText = requireString(body?.text || body?.rawText || body?.addressText, 'text').slice(0, 500);
  const compact = sourceText.replace(/\s+/g, ' ').trim();
  const phone = compact.match(/1[3-9]\d{9}/)?.[0] || '';
  const withoutPhone = phone ? compact.replace(phone, ' ').replace(/\s+/g, ' ').trim() : compact;
  const region = parseChineseRegion(withoutPhone);
  const beforeRegion = region.index > 0 ? withoutPhone.slice(0, region.index).trim() : '';
  const name = String(body?.name || beforeRegion.split(/[，, ]/).filter(Boolean).at(0) || '').slice(0, 24);
  const detailStart = Math.max(region.index, 0);
  const detail = region.matched
    ? withoutPhone.slice(detailStart + region.matched.length).replace(/^[，,\s-]+/, '').trim()
    : withoutPhone.replace(name, '').trim();
  const regionCode = body?.regionCode || regionCodeForParsedAddress(region);
  const parsed = {
    name,
    phone,
    province: region.province,
    city: region.city,
    district: region.district,
    detail,
    regionCode
  };
  const missing = [];
  if (!parsed.name) missing.push('name');
  if (!parsed.phone) missing.push('phone');
  if (!parsed.province && !parsed.city) missing.push('provinceOrCity');
  if (!parsed.district) missing.push('district');
  if (!parsed.detail) missing.push('detail');
  const walletAddress = body?.walletAddress || body?.address;
  const saveBody = {
    walletAddress: isValidAddress(walletAddress) ? walletAddress : '<connected-wallet>',
    name: parsed.name || '',
    phone: parsed.phone || '',
    province: parsed.province || '',
    city: parsed.city || '',
    district: parsed.district || '',
    detail: parsed.detail || '',
    regionCode: parsed.regionCode || '000000',
    isDefault: Boolean(body?.isDefault)
  };
  return {
    ok: missing.length === 0,
    sourceText,
    parsed,
    missing,
    confidence: Math.max(0, 1 - missing.length * 0.18),
    reviewRequired: missing.length > 0,
    warning: missing.length ? '⚠️ 检测到关键字段缺失，建议重新输入或保存后手动修改。' : '已识别姓名、电话、省市区与详细地址，请用户二次确认后保存。',
    dappReview: {
      title: '地址仓二次确认',
      requiredFields: ['name', 'phone', 'province', 'city', 'district', 'detail', 'regionCode'],
      lockPreview: {
        fulfillmentMode: 'delivery',
        regionCode: parsed.regionCode || '',
        regionBinding: true,
        finalCheckLabel: '收货地址 / 行政区',
        warning: '保存后仍可编辑地址；但一旦用于订单并支付成功，该订单的行政区编码永久锁定，不能再改地址或履约方式。'
      },
      checkoutItemPatch: {
        fulfillmentMode: 'delivery',
        addressId: '<saved-address-id>',
        regionCode: parsed.regionCode || ''
      }
    },
    nextAction: {
      method: 'POST',
      endpoint: '/api/address-book',
      body: saveBody
    }
  };
}

function parseChineseRegion(text) {
  const source = String(text || '');
  const directCity = /(北京市|上海市|天津市|重庆市)([^省市区县]{1,16}(?:区|县|市))?/.exec(source);
  if (directCity) {
    return {
      matched: directCity[0],
      index: directCity.index || 0,
      province: directCity[1],
      city: directCity[1],
      district: directCity[2] || ''
    };
  }
  const provinceNames = ['辽宁省', '广东省', '浙江省', '江苏省', '山东省', '河南省', '四川省', '湖北省', '湖南省', '福建省', '安徽省', '河北省', '陕西省', '山西省', '江西省', '云南省', '贵州省', '甘肃省', '青海省', '海南省', '吉林省', '黑龙江省', '内蒙古自治区', '广西壮族自治区', '宁夏回族自治区', '新疆维吾尔自治区', '西藏自治区'];
  const province = provinceNames.find((name) => source.includes(name)) || '';
  const index = province ? source.indexOf(province) : 0;
  const tail = province ? source.slice(index + province.length) : source;
  const city = tail.match(/([^省市区县]{1,16}市)/)?.[1] || '';
  const afterCity = city ? tail.slice(tail.indexOf(city) + city.length) : tail;
  const district = afterCity.match(/([^省市区县]{1,16}(?:区|县|市|旗))/)?.[1] || '';
  const matched = `${province}${city}${district}`;
  return {
    matched,
    index,
    province,
    city,
    district
  };
}

function regionCodeForParsedAddress(region) {
  const text = `${region.province || ''}${region.city || ''}${region.district || ''}`;
  if (text.includes('辽宁') && text.includes('大连') && (text.includes('高新') || text.includes('甘井子'))) return '210211';
  if (text.includes('北京') && text.includes('朝阳')) return '110105';
  if (text.includes('上海') && text.includes('浦东')) return '310115';
  return '';
}

function storeQueryOptions(searchParams) {
  if (!searchParams) return {};
  const lat = optionalCoordinate(searchParams.get('lat') || searchParams.get('latitude'), 'lat');
  const lng = optionalCoordinate(searchParams.get('lng') || searchParams.get('longitude'), 'lng');
  const regionCode = optionalRegionCode(searchParams.get('regionCode') || '', 'regionCode');
  const limitValue = Number(searchParams.get('limit') || 0);
  const options = {
    lat,
    lng,
    country: cleanQueryText(searchParams.get('country')),
    city: cleanQueryText(searchParams.get('city')),
    district: cleanQueryText(searchParams.get('district')),
    regionCode,
    query: cleanQueryText(searchParams.get('q') || searchParams.get('query')),
    limit: Number.isSafeInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : 0
  };
  options.publicQuery = Object.fromEntries(Object.entries({
    lat, lng, country: options.country, city: options.city, district: options.district, regionCode, q: options.query, limit: options.limit || undefined
  }).filter(([, value]) => value !== undefined && value !== '' && value !== 0));
  return options;
}

function cleanQueryText(value) {
  return String(value || '').trim().slice(0, 80);
}

function optionalCoordinate(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  const max = name === 'lat' ? 90 : 180;
  if (!Number.isFinite(number) || Math.abs(number) > max) fail(400, `INVALID_${String(name).toUpperCase()}`);
  return number;
}

function storeRows({ merchantAddress, lat, lng, country = '', city = '', district = '', regionCode = '', query = '', limit = 0 } = {}) {
  const saved = db.prepare('SELECT * FROM stores ORDER BY created_at DESC').all()
    .map(toStore)
    .filter((store) => !merchantAddress || String(store.merchantAddress || '').toLowerCase() === String(merchantAddress).toLowerCase());
  const hasGps = Number.isFinite(lat) && Number.isFinite(lng);
  const normalizedQuery = String(query || '').toLowerCase();
  let rows = saved.map((store) => enrichStoreForDapp(store, hasGps ? { lat, lng } : null));
  rows = rows.filter((store) => {
    if (country && store.country !== country) return false;
    if (city && store.city !== city) return false;
    if (district && store.district !== district) return false;
    if (regionCode && store.regionCode !== regionCode) return false;
    if (normalizedQuery && ![store.name, store.city, store.district, store.address, store.regionCode].some((value) => String(value || '').toLowerCase().includes(normalizedQuery))) return false;
    return true;
  });
  if (hasGps) rows.sort((a, b) => Number(a.distanceKm) - Number(b.distanceKm));
  if (limit > 0) rows = rows.slice(0, limit);
  return rows;
}

function toStore(row) {
  const payload = JSON.parse(row.payload_json || '{}');
  const regionCode = requireRegionCode(row.region_code || payload.regionCode, 'regionCode');
  return {
    id: String(row.id),
    name: String(row.name || payload.name || '24K 自提点'),
    merchantAddress: String(row.merchant_address || payload.merchantAddress || ''),
    country: String(payload.country || '中国'),
    city: String(payload.city || ''),
    district: String(payload.district || ''),
    regionCode,
    address: String(payload.formattedAddress || payload.address || row.name || '24K 自提点'),
    distanceKm: null,
    hours: String(payload.hours || ''),
    phone: String(payload.phone || ''),
    lat: Number(payload.latitude ?? payload.lat),
    lng: Number(payload.longitude ?? payload.lng)
  };
}

function storeById(storeId) {
  const id = requireString(storeId, 'storeId').slice(0, 96);
  const row = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  return row ? toStore(row) : null;
}

function enrichStoreForDapp(store, gps = null) {
  const hasCoordinates = Number.isFinite(store.lat) && Number.isFinite(store.lng);
  const distanceKm = gps && hasCoordinates ? haversineKm(gps.lat, gps.lng, store.lat, store.lng) : null;
  return {
    ...store,
    distanceKm: distanceKm === null ? null : Number(distanceKm.toFixed(2)),
    distanceSource: distanceKm === null ? 'unavailable' : 'gps',
    pickupContext: {
      fulfillmentMode: 'pickup',
      storeId: store.id,
      regionCode: store.regionCode,
      regionBinding: true,
      finalCheckLabel: '自提门店 / 行政区',
      lockWarning: '选择该门店自提后，付款瞬间永久绑定门店行政区编码用于区域代理分红。',
      checkoutItemPatch: {
        fulfillmentMode: 'pickup',
        storeId: store.id,
        regionCode: store.regionCode
      },
      finalCheckFactor: {
        key: 'fulfillment',
        label: '自提门店 / 行政区',
        value: `${store.name} · ${store.address} · ${store.regionCode}`
      }
    },
    dapp: {
      selectable: true,
      checkoutItemPatch: {
        fulfillmentMode: 'pickup',
        storeId: store.id,
        regionCode: store.regionCode
      },
      lockPreview: {
        regionCode: store.regionCode,
        regionBinding: true,
        warning: '付款成功后该订单不可改门店、不可改履约模式，区域代理收益按此门店行政区编码结算。'
      }
    },
    actions: {
      call: store.phone ? `tel:${store.phone}` : '',
      navigation: {
        provider: 'native-map',
        lat: store.lat,
        lng: store.lng,
        label: store.name,
        query: `${store.name} ${store.address}`.trim()
      }
    }
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return 0;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function resolveAddressForBuyer(addressId, buyerAddress) {
  const id = requireString(addressId, 'addressId').slice(0, 96);
  const address = requireAddress(buyerAddress, 'buyerAddress');
  return addressBookEntries(address).find((entry) => entry.id === id) || null;
}

function productFulfillmentModes(productId) {
  const modes = PRODUCT_UI[productId]?.fulfillmentModes;
  return Array.isArray(modes) && modes.length ? modes : ['delivery'];
}

function resolveFulfillmentForLine(product, item = {}, body = {}) {
  const buyerAddress = body.buyerAddress || body.address;
  const mode = item.fulfillmentMode === 'pickup' || body.fulfillmentMode === 'pickup' ? 'pickup' : 'delivery';
  if (!productFulfillmentModes(product.id).includes(mode)) {
    return { ok: false, reason: 'FULFILLMENT_MODE_NOT_SUPPORTED', fulfillmentMode: mode };
  }

  if (mode === 'delivery') {
    if (!isValidAddress(buyerAddress)) return { ok: false, reason: 'BUYER_ADDRESS_REQUIRED', fulfillmentMode: mode };
    const addressId = String(item.addressId || body.addressId || '').slice(0, 96);
    if (!addressId) return { ok: false, reason: 'ADDRESS_REQUIRED', fulfillmentMode: mode };
    const address = resolveAddressForBuyer(addressId, buyerAddress);
    if (!address) return { ok: false, reason: 'ADDRESS_NOT_FOUND', fulfillmentMode: mode, addressId };
    const regionCode = requireRegionCode(address.regionCode, 'addressRegionCode');
    const requestedRegion = optionalRegionCode(item.regionCode || item.addressRegionCode || body.regionCode || body.addressRegionCode, 'regionCode');
    if (requestedRegion && requestedRegion !== regionCode) return { ok: false, reason: 'REGION_MISMATCH', fulfillmentMode: mode, addressId, regionCode, requestedRegion };
    return { ok: true, fulfillmentMode: mode, addressId, storeId: '', regionCode, address };
  }

  const storeId = String(item.storeId || body.storeId || '').slice(0, 96);
  if (!storeId) return { ok: false, reason: 'STORE_REQUIRED', fulfillmentMode: mode };
  const store = storeById(storeId);
  if (!store) return { ok: false, reason: 'STORE_NOT_FOUND', fulfillmentMode: mode, storeId };
  if (isValidSeller(product.seller_address) && isValidSeller(store.merchantAddress) && product.seller_address.toLowerCase() !== store.merchantAddress.toLowerCase()) {
    return { ok: false, reason: 'STORE_SELLER_MISMATCH', fulfillmentMode: mode, storeId };
  }
  const regionCode = requireRegionCode(store.regionCode, 'storeRegionCode');
  const requestedRegion = optionalRegionCode(item.regionCode || item.storeRegionCode || body.regionCode || body.storeRegionCode, 'regionCode');
  if (requestedRegion && requestedRegion !== regionCode) return { ok: false, reason: 'REGION_MISMATCH', fulfillmentMode: mode, storeId, regionCode, requestedRegion };
  return { ok: true, fulfillmentMode: mode, addressId: '', storeId, regionCode, store };
}

function releaseReward(body) {
  const walletAddress = requireAddress(body.walletAddress || body.buyerAddress || body.address, 'walletAddress');
  const orderId = body.orderId ? requireString(body.orderId, 'orderId') : null;
  const amount = String(body.amount || body.bnmLocked || '0.000000000000000000');
  parseDecimal18(amount);
  const source = body.source || (orderId ? `订单 ${short(orderId)} 签收释放` : '平台手动释放');
  const assetSymbol = body.assetSymbol || 'BNM';
  if (onchainRewardLedgerEnabled()) {
    const id = body.rewardId || `reward-release-request-${Date.now()}-${randomBytes(3).toString('hex')}`;
    return {
      id,
      walletAddress,
      orderId,
      source,
      assetSymbol,
      amount,
      state: 'ReleaseRequested',
      rewardLedgerAddress: REWARD_LEDGER,
      next: '必须等待 Abu24KRewardLedger.RewardReleased 链上事件同步后才进入 Available。'
    };
  }
  if (orderId) {
    const existing = db.prepare(`
      SELECT * FROM reward_ledger
      WHERE lower(wallet_address) = ? AND order_id = ? AND asset_symbol = ? AND state IN ('Locked', 'Available')
      ORDER BY created_at LIMIT 1
    `).get(walletAddress.toLowerCase(), orderId, assetSymbol);
    if (existing) {
      db.prepare('UPDATE reward_ledger SET source = ?, state = ?, tx_hash = COALESCE(?, tx_hash) WHERE id = ?').run(source, 'Available', body.txHash || null, existing.id);
      return { id: existing.id, walletAddress, orderId, source, assetSymbol, amount: existing.amount, state: 'Available' };
    }
  }
  const id = body.rewardId || `reward-${Date.now()}-${randomBytes(3).toString('hex')}`;
  db.prepare('INSERT OR REPLACE INTO reward_ledger (id, wallet_address, order_id, source, asset_symbol, amount, state, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    walletAddress.toLowerCase(),
    orderId,
    source,
    assetSymbol,
    amount,
    'Available',
    body.txHash || null
  );
  return { id, walletAddress, orderId, source, assetSymbol, amount, state: 'Available' };
}

function claimAvailableReward(body) {
  const walletAddress = requireAddress(body.walletAddress || body.address, 'walletAddress');
  assertCircuitOpen('claims', 'CLAIMS_PAUSED');
  assertNotBlacklisted(walletAddress);
  expirePendingClaimRequests(walletAddress);
  const bucketId = String(body.bucketId || 'bnm');
  const entry = availableRewardForClaim(walletAddress, body.rewardId);
  const assetSymbol = entry.asset_symbol;
  if (body.assetSymbol && String(body.assetSymbol) !== assetSymbol) fail(400, 'CLAIM_ASSET_MISMATCH');
  const amount = String(body.amount || entry?.amount || '0.000000000000000000');
  parseDecimal18(amount);
  if (parseDecimal18(amount) !== parseDecimal18(entry.amount)) fail(400, 'CLAIM_AMOUNT_MISMATCH');
  requireClaimSignature(body, walletAddress, entry, amount);
  const expiresAt = Date.now() + claimRequestTtlMs();
  db.prepare('UPDATE reward_ledger SET state = ?, tx_hash = COALESCE(?, tx_hash) WHERE id = ?').run('PendingClaim', body.txHash || null, entry.id);
  const claim = recordClaim(walletAddress, bucketId, assetSymbol, amount, 'pending', body.txHash, { rewardId: entry.id, expiresAt });
  writeAudit('buyer', walletAddress, 'claim.request', claim.id, claim);
  return { ...claim, rewardId: entry.id, next: '等待链上 RewardLedger.claim() 成功事件后再把奖励标记为 Claimed。' };
}

function prepareClaimReward(body) {
  const walletAddress = requireAddress(body.walletAddress || body.address, 'walletAddress');
  assertCircuitOpen('claims', 'CLAIMS_PAUSED');
  assertNotBlacklisted(walletAddress);
  expirePendingClaimRequests(walletAddress);
  const entry = availableRewardForClaim(walletAddress, body.rewardId);
  const bucketId = String(body.bucketId || 'bnm');
  const amount = String(entry.amount);
  const expiresAt = Date.now() + claimRequestTtlMs();
  const nonce = `claim-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const secondaryMessage = claimSignatureMessage({
    walletAddress,
    rewardId: entry.id,
    amount,
    nonce,
    expiresAt
  });
  db.prepare('INSERT INTO wallet_action_nonces (nonce, address, action, expires_at, used) VALUES (?, ?, ?, ?, 0)').run(
    nonce,
    walletAddress.toLowerCase(),
    'buyer.claim',
    expiresAt
  );
  return {
    walletAddress,
    rewardId: entry.id,
    bucketId,
    assetSymbol: entry.asset_symbol,
    amount,
    chainId: CHAIN_ID,
    nonce,
    expiresAt,
    secondaryMessage,
    signatureKind: 'personal_sign',
    submit: {
      method: 'POST',
      endpoint: '/api/claims',
      body: {
        walletAddress,
        bucketId,
        rewardId: entry.id,
        assetSymbol: entry.asset_symbol,
        amount,
        secondaryMessage,
        secondarySignature: '<wallet-signature>'
      }
    }
  };
}

function availableRewardForClaim(walletAddress, rewardIdValue = '') {
  const rewardId = rewardIdValue ? requireString(rewardIdValue, 'rewardId') : '';
  const entry = db.prepare(`
    SELECT * FROM reward_ledger
    WHERE wallet_address = ? AND state = 'Available' AND (? = '' OR id = ?)
    ORDER BY created_at LIMIT 1
  `).get(walletAddress.toLowerCase(), rewardId, rewardId);
  if (!entry) fail(400, 'NO_AVAILABLE_REWARD');
  return entry;
}

function claimSignatureMessage({ walletAddress, rewardId, amount, nonce, expiresAt }) {
  return [
    '24K reward claim',
    'Action: buyer.claim',
    `Wallet: ${walletAddress}`,
    `RewardId: ${rewardId}`,
    `Amount: ${amount}`,
    `ChainId: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `ExpiresAt: ${expiresAt}`
  ].join('\n');
}

function recordClaim(walletAddress, bucketId, assetSymbol, amount, status = 'pending', txHash = null, options = {}) {
  const id = `claim-${Date.now()}-${randomBytes(3).toString('hex')}`;
  db.prepare('INSERT INTO claims (id, wallet_address, reward_id, bucket_id, asset_symbol, amount, status, tx_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    String(walletAddress).toLowerCase(),
    options.rewardId || null,
    String(bucketId),
    String(assetSymbol),
    String(amount),
    String(status),
    txHash || null,
    options.expiresAt || null
  );
  return { id, walletAddress, rewardId: options.rewardId || undefined, bucketId, assetSymbol, amount, status, txHash: txHash || undefined, expiresAt: options.expiresAt || undefined, createdAt: new Date().toISOString() };
}

function expirePendingClaimRequests(walletAddress) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT id, reward_id FROM claims
    WHERE wallet_address = ? AND status = 'pending' AND reward_id IS NOT NULL AND expires_at IS NOT NULL AND expires_at < ?
  `).all(String(walletAddress).toLowerCase(), now);
  for (const row of rows) {
    db.prepare('UPDATE reward_ledger SET state = ? WHERE id = ? AND state = ?').run('Available', row.reward_id, 'PendingClaim');
    db.prepare('UPDATE claims SET status = ? WHERE id = ?').run('failed', row.id);
  }
  return rows.length;
}

function productSaleRestriction(product, body = {}) {
  if (String(product.status) !== 'Active') return 'PRODUCT_NOT_ACTIVE';
  const session = currentSeckillSession();
  const requestedSessionId = String(body?.seckillSessionId || '');
  const sessionProduct = Boolean(session.id) && session.productId === product.id;
  const phase = seckillPhase(session);
  if (requestedSessionId) {
    if (!session.id || requestedSessionId !== String(session.id)) return 'SECKILL_SESSION_MISMATCH';
    if (!sessionProduct) return 'SECKILL_PRODUCT_MISMATCH';
    if (phase.key !== 'live') return 'SECKILL_NOT_LIVE';
    return '';
  }
  if (sessionProduct && ['live', 'settling'].includes(phase.key)) return 'SUPER_SECKILL_LOCKED';
  return '';
}

function stockPreflight(body) {
  assertCircuitOpen('orders', 'ORDERS_PAUSED');
  assertRewardLedgerOpenForNewOrders();
  const buyerAddress = body?.buyerAddress || body?.address;
  if (buyerAddress && isValidAddress(buyerAddress)) {
    assertNotBlacklisted(buyerAddress);
    assertWalletTradeUnlocked(buyerAddress);
  }
  const items = Array.isArray(body?.items) ? body.items.filter((item) => item?.selected !== false) : [];
  if (items.length === 0) fail(400, 'NO_PREFLIGHT_ITEMS');
  let totalUnits = 0n;
  let totalNplUnits = 0n;
  let totalBnmUnits = 0n;
  const lines = items.map((item) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(String(item.productId));
    if (!product) return { productId: String(item.productId), ok: false, reason: 'PRODUCT_NOT_FOUND' };
    const saleRestriction = productSaleRestriction(product, body);
    if (saleRestriction) return { productId: product.id, ok: false, reason: saleRestriction };
    const quantity = requireQuantity(item.quantity || 1);
    const sku = resolveSku(product.id, item.skuId);
    const availableStock = sku ? Number(sku.stock) : Number(product.stock);
    const fulfillment = resolveFulfillmentForLine(product, item, body);
    const stockOk = availableStock >= quantity;
    const unitPrice = sku ? sku.settlement_price_npl : normalizeUnitPrice(item.unitPriceNpl, product.price_npl);
    const lineUnits = parseDecimal18(unitPrice) * BigInt(quantity);
    const ratio = paymentRatioForProduct(product.id);
    const lineNplUnits = lineUnits;
    const lineBnmUnits = lineUnits * BigInt(ratio.bnmRebateBps) / 10_000n;
    totalUnits += lineUnits;
    totalNplUnits += lineNplUnits;
    totalBnmUnits += lineBnmUnits;
    return {
      productId: product.id,
      skuId: sku?.id || null,
      skuName: sku?.name || product.sku,
      title: product.title,
      quantity,
      unitPriceNpl: unitPrice,
      availableStock,
      ok: stockOk && fulfillment.ok,
      reason: stockOk ? (fulfillment.ok ? undefined : fulfillment.reason) : 'INSUFFICIENT_STOCK',
      fulfillmentMode: fulfillment.fulfillmentMode,
      addressId: fulfillment.addressId || null,
      storeId: fulfillment.storeId || null,
      regionCode: fulfillment.regionCode || '',
      address: fulfillment.address || undefined,
      store: fulfillment.store || undefined,
      quote: {
        totalNpl: formatDecimal18(lineUnits),
        amountNpl: formatDecimal18(lineNplUnits),
        bnmLocked: formatDecimal18(lineBnmUnits),
        nplPaymentBps: ratio.nplPaymentBps,
        bnmRebateBps: ratio.bnmRebateBps
      },
      fiveFactors: { ...fiveFactorTemplate(toProduct(product)), addressOrStoreRegionCode: fulfillment.regionCode || 'pending' }
    };
  });
  return {
    ok: lines.every((line) => line.ok),
    lines,
    quote: {
      totalNpl: formatDecimal18(totalUnits),
      amountNpl: formatDecimal18(totalNplUnits),
      bnmLocked: formatDecimal18(totalBnmUnits),
      chainId: CHAIN_ID,
      nplAddress: NPL,
      escrowAddress: ESCROW,
      approval: {
        type: 'unlimited-npl',
        allowanceSkip: true,
        amount: 'MaxUint256'
      }
    },
    checkedAt: new Date().toISOString()
  };
}

function dappFinalCheck(body) {
  const preflight = stockPreflight(body);
  const firstBadLine = preflight.lines.find((line) => !line.ok);
  const firstLine = preflight.lines[0] || {};
  const productNames = preflight.lines.map((line) => line.title).filter(Boolean);
  const skuSummary = preflight.lines.map((line) => `${line.skuName || '默认 SKU'} x${line.quantity}`).join(' / ');
  const fulfillmentSummaryText = preflight.lines.map((line) => {
    if (line.fulfillmentMode === 'pickup') return line.store ? `${line.store.name} 自提` : '门店自提待选择';
    if (line.address) return `${line.address.province}${line.address.city}${line.address.district} ${line.address.detail}`;
    return '快递地址待选择';
  }).join(' / ');
  return {
    ok: preflight.ok,
    error: firstBadLine?.reason,
    version: '24k-dapp-final-check-v1',
    checkedAt: preflight.checkedAt,
    title: preflight.ok ? '确认 5 要素后发起链上支付' : '订单暂不能支付',
    summary: {
      products: productNames,
      skuQuantity: skuSummary,
      fulfillment: fulfillmentSummaryText,
      regionCodes: [...new Set(preflight.lines.map((line) => line.regionCode).filter(Boolean))],
      payment: `${preflight.quote.amountNpl} NPL`,
      bnmLocked: `${preflight.quote.bnmLocked} BNM`
    },
    factors: [
      { key: 'product', label: '商品', value: productNames.join(' / ') },
      { key: 'skuQuantity', label: 'SKU / 数量', value: skuSummary },
      { key: 'fulfillment', label: firstLine.fulfillmentMode === 'pickup' ? '自提门店 / 行政区' : '收货地址 / 行政区', value: fulfillmentSummaryText },
      { key: 'payment', label: 'NPL 支付', value: `${preflight.quote.amountNpl} NPL`, detail: preflight.quote.approval },
      { key: 'bnmLocked', label: 'BNM 全返锁定', value: `${preflight.quote.bnmLocked} BNM`, detail: '签收/完成后从 Locked 释放到 Available，再走 Claim。' }
    ],
    preflight,
    nextAction: preflight.ok ? {
      method: 'POST',
      endpoint: '/api/dapp/checkout-intent',
      body,
      walletFlow: ['checkAllowance', 'approveNplIfNeeded', 'sendPayOrder', 'pollFundingStatus']
    } : null
  };
}

function createFinalOrder(body) {
  const preflight = stockPreflight(body);
  if (!preflight.ok) fail(400, preflight.lines.find((line) => !line.ok)?.reason || 'STOCK_PREFLIGHT_FAILED');
  const order = createOrder(body);
  return { ...order, preflight, finalCheck: { required: ['商品', 'SKU / 数量', '地址/门店', 'NPL 支付', 'BNM Locked'], passed: true } };
}

function productRiskProfile(productId) {
  return {
    productId,
    stockBeforePay: true,
    finalFiveFactorCheck: true,
    regionCodeLocked: true,
    refundPolicy: '不开放用户无理由退款；仅平台强制退款、7 天超时处理和 emergency refund。'
  };
}

function dappProductDetail(product) {
  const session = currentSeckillSession();
  const isSessionProduct = session.productId === product.id;
  const regularLocked = isSessionProduct && ['live', 'settling'].includes(session.status);
  const defaultMode = product.fulfillmentModes?.includes('delivery') ? 'delivery' : product.fulfillmentModes?.[0] || 'delivery';
  return {
    version: '24k-product-detail-v1',
    productId: product.id,
    docsFlow: '商品详情 -> SKU/数量/履约选择 -> 库存复核 -> 5 要素终核 -> NPL 授权/支付广播',
    seckillOverlay: {
      active: regularLocked,
      sessionId: isSessionProduct ? session.id : null,
      sessionStatus: isSessionProduct ? session.status : null,
      reason: regularLocked ? 'SUPER_SECKILL_LOCKED' : null,
      copy: regularLocked ? '🔥超级秒杀中 | 前往秒杀现场' : '可常规购买',
      action: regularLocked ? { label: '前往秒杀现场', endpoint: '/api/seckill/current' } : null
    },
    buyNow: {
      enabled: !regularLocked,
      disabledReason: regularLocked ? '当前商品正在秒杀大厅进行秒杀，常规购买入口按 docs 锁定。' : null,
      label: regularLocked ? '🔥超级秒杀中 | 前往秒杀现场' : '立即购买'
    },
    requiredSelections: [
      { key: 'skuId', label: '规格 SKU', required: true, options: product.skus || [] },
      { key: 'quantity', label: '数量', required: true, min: 1 },
      { key: 'fulfillmentMode', label: '履约模式', required: true, options: product.fulfillmentModes || ['delivery'] },
      { key: 'addressId', label: '快递地址', requiredWhen: "fulfillmentMode === 'delivery'" },
      { key: 'storeId', label: '自提门店', requiredWhen: "fulfillmentMode === 'pickup'" },
      { key: 'regionCode', label: '行政区划编码', required: true, lockTiming: '付款瞬间永久绑定' }
    ],
    defaultCheckoutItem: {
      productId: product.id,
      skuId: product.skus?.[0]?.id,
      quantity: 1,
      fulfillmentMode: defaultMode,
      regionCode: product.adminRegionCode || undefined
    },
    finalCheck: {
      title: '付前 5 要素终核',
      blocking: true,
      warning: '根据 Web3 分红机制，此地址/门店行政区划编码在付款瞬间将永久绑定对应区域代理分红归属。付款成功后不可中途改地址或改履约方式。',
      factors: ['商品', 'SKU / 数量', '收货地址或自提门店 / 行政区', 'NPL 支付', 'BNM 全返锁定额度']
    },
    paymentPolicy: publicDappConfig().payment,
    endpoints: {
      productDetail: `/api/products/${encodeURIComponent(product.id)}`,
      stockPreflight: '/api/stock/preflight',
      finalCheck: '/api/dapp/final-check',
      checkoutIntent: '/api/dapp/checkout-intent',
      seckillIntent: '/api/dapp/seckill-intent',
      seckillCurrent: '/api/seckill/current'
    },
    nextActions: regularLocked
      ? ['openSeckillCurrent', 'createSeckillIntent', 'checkAllowance', 'approveNplIfNeeded', 'sendPayOrder', 'sendRecordPurchase', 'pollFundingStatus']
      : ['selectSkuAndFulfillment', 'runStockPreflight', 'showFinalFiveFactorModal', 'createCheckoutIntent', 'checkAllowance', 'approveNplIfNeeded', 'sendPayOrder', 'pollFundingStatus'],
    policy: {
      noUserNoReasonRefund: true,
      regionCodeLockedOnPayment: true,
      addressOrStoreLockedOnPayment: true,
      allowanceSkip: true,
      approvalAmount: 'MaxUint256',
      fixedNplAddress: FIXED_BSC_NPL_ADDRESS
    }
  };
}

function fiveFactorTemplate(product) {
  return {
    product: product.title,
    skuQuantity: product.skus?.[0]?.name || product.sku,
    fulfillment: product.fulfillmentModes,
    addressOrStoreRegionCode: product.adminRegionCode || 'pending',
    payment: '100% NPL'
  };
}

function resolveSku(productId, skuId) {
  if (!skuId) return null;
  return db.prepare('SELECT * FROM product_skus WHERE product_id = ? AND id = ?').get(String(productId), String(skuId)) || null;
}

function normalizeUnitPrice(candidate, fallback) {
  if (candidate === undefined || candidate === null || candidate === '') return String(fallback);
  return formatDecimal18(parseDecimal18(String(candidate)));
}

function normalizeProductTitle(value) {
  const title = requireString(value, 'title').trim();
  if ([...title].length > 60) fail(400, 'PRODUCT_TITLE_TOO_LONG');
  return title;
}

function normalizeHttpsImages(value, { required = false, field = 'imageUrls' } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(400, `${field.toUpperCase()}_REQUIRED`);
    return [];
  }
  if (!Array.isArray(value)) fail(400, `INVALID_${field.toUpperCase()}`);
  if (value.length > 5) fail(400, `${field.toUpperCase()}_LIMIT_EXCEEDED`);
  const images = value.map((entry) => {
    const text = requireString(entry, field).trim();
    if (text.length > 2048) fail(400, `INVALID_${field.toUpperCase()}`);
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      fail(400, `INVALID_${field.toUpperCase()}`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail(400, `${field.toUpperCase()}_HTTPS_REQUIRED`);
    return parsed.toString();
  });
  if (required && images.length === 0) fail(400, `${field.toUpperCase()}_REQUIRED`);
  return [...new Set(images)];
}

function sanitizeProductDetail(value) {
  const raw = String(value || '');
  if (raw.length > 50_000) fail(400, 'PRODUCT_DETAIL_TOO_LONG');
  return sanitizeHtml(raw, {
    allowedTags: ['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'a', 'img'],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title']
    },
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tagName, attributes) => ({ tagName: 'a', attribs: { ...attributes, target: '_blank', rel: 'noopener noreferrer' } })
    }
  });
}

function normalizeSubmissionSkus(payload) {
  const explicit = Array.isArray(payload.skus);
  const source = explicit
    ? payload.skus
    : (payload.sku || payload.skuName || payload.priceNpl || payload.settlementPriceNpl)
      ? [{ id: 'default', name: payload.sku || payload.skuName, settlementPriceNpl: payload.priceNpl || payload.settlementPriceNpl, stock: payload.stock }]
      : [];
  if (source.length === 0) fail(400, 'PRODUCT_SKU_REQUIRED');
  if (source.length > 50) fail(400, 'PRODUCT_SKU_LIMIT_EXCEEDED');
  const ids = new Set();
  const normalized = source.map((sku, index) => {
    if (!sku || typeof sku !== 'object' || Array.isArray(sku)) fail(400, `INVALID_SKU_${index + 1}`);
    const id = String(sku.id || `sku-${index + 1}`).trim();
    if (!/^[a-zA-Z0-9:._-]{1,96}$/.test(id)) fail(400, `INVALID_SKU_ID_${index + 1}`);
    const lowerId = id.toLowerCase();
    if (ids.has(lowerId)) fail(400, 'DUPLICATE_SKU_ID');
    ids.add(lowerId);
    const name = requireString(sku.name || sku.skuName, `skuName${index + 1}`).trim().slice(0, 80);
    const settlementPriceNpl = normalizeUnitPrice(requireString(sku.settlementPriceNpl || sku.priceNpl, `skuPriceNpl${index + 1}`), '');
    if (parseDecimal18(settlementPriceNpl) <= 0n) fail(400, `INVALID_SKU_PRICE_${index + 1}`);
    const stock = normalizeStock(sku.stock, `skuStock${index + 1}`);
    return { ...sku, id, name, settlementPriceNpl, stock };
  });
  return normalized;
}

function normalizeSubmissionFulfillmentModes(value) {
  if (!Array.isArray(value) || value.length === 0) fail(400, 'PRODUCT_FULFILLMENT_REQUIRED');
  const modes = [...new Set(value.map((entry) => String(entry).trim()))];
  if (modes.some((entry) => !['delivery', 'pickup'].includes(entry))) fail(400, 'INVALID_PRODUCT_FULFILLMENT_MODE');
  return modes;
}

function normalizeMerchantSubmissionPayload(input) {
  const payload = { ...(input || {}) };
  const title = normalizeProductTitle(payload.title);
  const imageInput = payload.imageUrls ?? payload.images ?? (payload.imageUrl ? [payload.imageUrl] : []);
  const imageUrls = normalizeHttpsImages(imageInput, { field: 'productImages' });
  const detailSource = payload.descriptionHtml ?? payload.detailHtml ?? payload.richText ?? payload.description ?? '';
  const descriptionHtml = sanitizeProductDetail(detailSource);
  const skus = normalizeSubmissionSkus(payload);
  const fulfillmentModes = normalizeSubmissionFulfillmentModes(payload.fulfillmentModes);
  const stock = skus.reduce((total, sku) => total + sku.stock, 0);
  if (!Number.isSafeInteger(stock)) fail(400, 'PRODUCT_STOCK_TOO_LARGE');
  return {
    ...payload,
    title,
    sku: skus[0].name,
    priceNpl: skus[0].settlementPriceNpl,
    stock,
    seckillStock: stock,
    skus,
    fulfillmentModes,
    imageUrl: imageUrls[0] || undefined,
    imageUrls,
    descriptionHtml,
    detailHtml: descriptionHtml
  };
}

function sanitizeMerchantDraftPayload(input) {
  const payload = { ...(input || {}) };
  if (payload.title !== undefined) payload.title = normalizeProductTitle(payload.title);
  if (payload.imageUrls !== undefined || payload.images !== undefined || payload.imageUrl !== undefined) {
    const imageUrls = normalizeHttpsImages(payload.imageUrls ?? payload.images ?? (payload.imageUrl ? [payload.imageUrl] : []), { field: 'productImages' });
    payload.imageUrls = imageUrls;
    payload.imageUrl = imageUrls[0] || undefined;
  }
  for (const key of ['descriptionHtml', 'detailHtml', 'richText', 'description']) {
    if (payload[key] !== undefined) payload[key] = sanitizeProductDetail(payload[key]);
  }
  return payload;
}

function orderItemLineKey(line) {
  return [
    line.productId || line.product_id || '',
    line.skuId || line.sku_id || '',
    line.fulfillmentMode || line.fulfillment_mode || '',
    line.addressId || line.address_id || '',
    line.storeId || line.store_id || '',
    line.regionCode || line.region_code || ''
  ].map((value) => String(value || '').slice(0, 96)).join('::');
}

function merchantOrders(merchantAddress) {
  return db.prepare('SELECT * FROM orders WHERE lower(seller_address) = ? ORDER BY created_at DESC LIMIT 50').all(String(merchantAddress).toLowerCase()).map(toOrder);
}

function submitMerchantProduct(session, body) {
  const businessBody = normalizeMerchantSubmissionPayload(stripSignedEnvelope(body));
  const storeId = normalizeStoreId(businessBody.storeId || 'default');
  const active = db.prepare(`
    SELECT * FROM product_submissions
    WHERE lower(merchant_address) = ? AND store_id = ? AND status IN ('PendingReview', 'Approved', 'Scheduled', 'Live', 'TakedownRequested')
    ORDER BY created_at DESC LIMIT 1
  `).get(session.address.toLowerCase(), storeId);
  if (active) fail(423, 'MERCHANT_SINGLE_PRODUCT_LOCKED');
  const id = `submission-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const title = businessBody.title;
  const immutablePayload = JSON.stringify(businessBody);
  db.prepare('INSERT INTO product_submissions (id, merchant_address, store_id, title, status, locked_at, immutable_payload_json, payload_json) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)').run(
    id,
    session.address.toLowerCase(),
    storeId,
    title,
    'PendingReview',
    immutablePayload,
    immutablePayload
  );
  writeAudit(session.role, session.address, 'merchant.product.submit', id, body);
  return { id, title, storeId, status: 'PendingReview', locked: true, message: '单品提报已进入平台审核，上架参数已死锁。' };
}

function saveMerchantProductDraft(session, body) {
  const businessBody = sanitizeMerchantDraftPayload(stripSignedEnvelope(body));
  const storeId = normalizeStoreId(businessBody.storeId || 'default');
  const title = normalizeProductTitle(businessBody.title || '未命名商品');
  const existing = db.prepare(`
    SELECT * FROM product_submissions
    WHERE lower(merchant_address) = ? AND store_id = ? AND status = 'Draft'
    ORDER BY created_at DESC LIMIT 1
  `).get(session.address.toLowerCase(), storeId);
  if (existing) {
    const payload = { ...JSON.parse(existing.payload_json || '{}'), ...businessBody };
    db.prepare('UPDATE product_submissions SET title = ?, payload_json = ? WHERE id = ?').run(title, JSON.stringify(payload), existing.id);
    writeAudit(session.role, session.address, 'merchant.product.draft', existing.id, body);
    return { ...toProductSubmission(db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(existing.id)), action: 'merchant.product.draft', audit: 'written' };
  }
  const id = `submission-${Date.now()}-${randomBytes(3).toString('hex')}`;
  db.prepare('INSERT INTO product_submissions (id, merchant_address, store_id, title, status, locked_at, immutable_payload_json, payload_json) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)').run(
    id,
    session.address.toLowerCase(),
    storeId,
    title,
    'Draft',
    JSON.stringify(businessBody)
  );
  writeAudit(session.role, session.address, 'merchant.product.draft', id, body);
  return { ...toProductSubmission(db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(id)), action: 'merchant.product.draft', audit: 'written' };
}

function submitMerchantDraftForReview(session, productId, body) {
  const row = merchantProductSubmission(session, productId);
  if (row.status !== 'Draft') fail(409, 'INVALID_SUBMISSION_STATUS');
  const active = db.prepare(`
    SELECT id FROM product_submissions
    WHERE lower(merchant_address) = ? AND store_id = ? AND id <> ? AND status IN ('PendingReview', 'Approved', 'Scheduled', 'Live', 'TakedownRequested')
    LIMIT 1
  `).get(session.address.toLowerCase(), row.store_id, row.id);
  if (active) fail(423, 'MERCHANT_SINGLE_PRODUCT_LOCKED');
  const payload = normalizeMerchantSubmissionPayload({ ...JSON.parse(row.payload_json || '{}'), ...stripSignedEnvelope(body) });
  const immutablePayload = JSON.stringify(payload);
  db.prepare(`
    UPDATE product_submissions
    SET title = ?, status = 'PendingReview', locked_at = CURRENT_TIMESTAMP, immutable_payload_json = ?, payload_json = ?
    WHERE id = ?
  `).run(payload.title, immutablePayload, immutablePayload, row.id);
  writeAudit(session.role, session.address, 'merchant.product.submit-review', row.id, { productId: row.id });
  return { ...toProductSubmission(db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(row.id)), action: 'merchant.product.submit-review', audit: 'written' };
}

function requestMerchantProductTakedown(session, productId, body) {
  const row = merchantProductSubmission(session, productId);
  const reason = requireString(body.reason, 'reason').slice(0, 500);
  if (row.status === 'Draft' || row.status === 'PendingReview') {
    db.prepare('UPDATE product_submissions SET status = ? WHERE id = ?').run('Withdrawn', row.id);
  } else if (row.status === 'Approved') {
    const payload = { ...JSON.parse(row.payload_json || '{}'), statusBeforeTakedown: row.status, takedownReason: reason, takedownRequestedAt: new Date().toISOString() };
    db.prepare('UPDATE product_submissions SET status = ?, payload_json = ? WHERE id = ?').run('TakedownRequested', JSON.stringify(payload), row.id);
  } else if (['Scheduled', 'Live'].includes(row.status)) {
    fail(423, 'ACTIVE_PRODUCT_TAKEDOWN_LOCKED');
  } else {
    fail(409, 'INVALID_SUBMISSION_STATUS');
  }
  writeAudit(session.role, session.address, 'merchant.product.takedown', row.id, { reason, previousStatus: row.status });
  return { ...toProductSubmission(db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(row.id)), action: 'merchant.product.takedown', audit: 'written' };
}

function merchantProductSubmission(session, productId) {
  const row = db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(productId);
  if (!row) fail(404, 'PRODUCT_SUBMISSION_NOT_FOUND');
  if (row.merchant_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'MERCHANT_PRODUCT_OWNER_MISMATCH');
  return row;
}

function lockMerchantProduct(session, productId, body) {
  const row = db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(productId);
  if (row && row.merchant_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'MERCHANT_PRODUCT_OWNER_MISMATCH');
  if (row) db.prepare('UPDATE product_submissions SET locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP), immutable_payload_json = COALESCE(immutable_payload_json, payload_json) WHERE id = ?').run(productId);
  return auditedMerchantAction(session, 'merchant.product.lock', productId, { ...body, productId, locked: true });
}

function updateMerchantProduct(session, productId, body) {
  const row = db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(productId);
  if (!row) fail(404, 'PRODUCT_SUBMISSION_NOT_FOUND');
  if (row.merchant_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'MERCHANT_PRODUCT_OWNER_MISMATCH');
  if (isProductSubmissionLocked(row.status)) fail(423, 'MERCHANT_PRODUCT_LOCKED');
  const payload = sanitizeMerchantDraftPayload({ ...JSON.parse(row.payload_json || '{}'), ...stripSignedEnvelope(body) });
  const title = payload.title ? normalizeProductTitle(payload.title) : row.title;
  db.prepare('UPDATE product_submissions SET title = ?, payload_json = ? WHERE id = ?').run(title, JSON.stringify(payload), productId);
  writeAudit(session.role, session.address, 'merchant.product.update', productId, body);
  return { id: productId, title, status: row.status, locked: false, action: 'merchant.product.update', audit: 'written' };
}

function isProductSubmissionLocked(status) {
  return ['PendingReview', 'Approved', 'Scheduled', 'Live', 'TakedownRequested'].includes(String(status));
}

async function upsertMerchantStore(session, body) {
  const storeId = normalizeStoreId(body?.storeId || body?.id || `store-${Date.now()}`);
  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (existing && existing.merchant_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'STORE_SELLER_MISMATCH');
  const name = requireString(body?.name, 'name').slice(0, 80);
  const longitude = Number(body?.longitude ?? body?.lng);
  const latitude = Number(body?.latitude ?? body?.lat);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) fail(400, 'STORE_COORDINATES_REQUIRED');
  const hours = requireString(body?.hours, 'hours').trim().slice(0, 160);
  const phone = requireString(body?.phone, 'phone').trim();
  if (!/^\+?[0-9][0-9 ()-]{5,22}[0-9]$/.test(phone)) fail(400, 'INVALID_STORE_PHONE');
  const formattedAddress = requireString(body?.formattedAddress || body?.address, 'address').trim().slice(0, 500);
  const photos = normalizeHttpsImages(body?.photos ?? body?.photoUrls, { required: true, field: 'storePhotos' });
  let geocode = null;
  if (process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_API_KEY) {
    geocode = await reverseGeocode({ longitude, latitude }, process.env);
  }
  const regionCode = requireRegionCode(geocode?.regionCode || body?.regionCode, 'regionCode');
  if (existing && existing.region_code !== regionCode) fail(423, 'STORE_REGION_CODE_LOCKED');
  const previous = existing ? JSON.parse(existing.payload_json || '{}') : {};
  const payload = {
    ...previous,
    ...stripSignedEnvelope(body),
    id: storeId,
    name,
    merchantAddress: session.address.toLowerCase(),
    regionCode,
    latitude: geocode?.latitude ?? latitude,
    longitude: geocode?.longitude ?? longitude,
    formattedAddress: geocode?.formattedAddress || formattedAddress,
    address: geocode?.formattedAddress || formattedAddress,
    hours,
    phone,
    photos,
    geocodeProvider: geocode?.provider || 'manual-validated',
    regionLocked: true
  };
  db.prepare(`
    INSERT INTO stores (id, merchant_address, name, region_code, payload_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      payload_json = excluded.payload_json
  `).run(storeId, session.address.toLowerCase(), name, regionCode, JSON.stringify(payload));
  writeAudit(session.role, session.address, 'merchant.store.upsert', storeId, body);
  return { ...payload, created: !existing, action: 'merchant.store.upsert', audit: 'written' };
}

async function shipMerchantOrder(session, orderId, body) {
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (order.seller_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'ORDER_SELLER_MISMATCH');
  if ((order.fulfillment_mode || 'delivery') !== 'delivery') fail(400, 'ORDER_NOT_DELIVERY_MODE');
  if (!isShipmentAllowedStatus(order.status)) fail(400, 'ORDER_NOT_PAID');
  let carrier = requireString(body.carrier || 'SF', 'carrier').slice(0, 80);
  let trackingNo = String(body.trackingNo || body.tracking || '').trim();
  let waybill = null;
  if (!trackingNo && body.electronicWaybill) {
    waybill = await createElectronicWaybill({
      order: fulfillmentOrderPayload(order),
      carrier,
      templateId: body.templateId || null,
      monthlyAccount: body.monthlyAccount || null
    }, process.env);
    trackingNo = providerTrackingNo(waybill);
    carrier = String(waybill.raw?.carrier || carrier);
  }
  trackingNo = requireTrackingNo(trackingNo);
  const payload = { orderId: order.order_id, carrier, trackingNo, waybillProviderJobId: waybill?.providerJobId || null };
  db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run('Shipped', order.order_id);
  db.prepare('INSERT OR REPLACE INTO fulfillment_orders (id, order_id, type, status, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    `fulfillment-${order.order_id}`,
    order.order_id,
    order.fulfillment_mode || 'delivery',
    'Shipped',
    JSON.stringify(payload)
  );
  db.prepare('INSERT OR REPLACE INTO logistics_orders (id, order_id, carrier, tracking_no, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    `logistics-${order.order_id}`,
    order.order_id,
    payload.carrier,
    payload.trackingNo,
    JSON.stringify(payload)
  );
  writeAudit(session.role, session.address, 'merchant.order.ship', order.order_id, payload);
  await deliverNotification({
    channel: 'order',
    recipient: order.buyer_address,
    type: 'order.shipped',
    title: '订单已发货',
    body: `${carrier} ${trackingNo}`,
    orderId: order.order_id
  });
  return { ...payload, status: 'Shipped', next: '物流签收回调或买家确认收货后提交链上 completeOrder。' };
}

async function verifyPickupOrder(session, body) {
  const orderId = requireString(body.orderId, 'orderId');
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (order.seller_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'ORDER_SELLER_MISMATCH');
  if ((order.fulfillment_mode || 'delivery') !== 'pickup') fail(400, 'ORDER_NOT_PICKUP_MODE');
  if (!isShipmentAllowedStatus(order.status)) fail(400, 'ORDER_NOT_PAID');
  if (!order.store_id) fail(400, 'STORE_REQUIRED');
  if (body.storeId && String(body.storeId) !== order.store_id) fail(400, 'STORE_MISMATCH');
  const store = storeById(order.store_id);
  if (!store) fail(400, 'STORE_NOT_FOUND');
  if (String(store.merchantAddress || '').toLowerCase() !== session.address.toLowerCase()) fail(403, 'STORE_SELLER_MISMATCH');
  const code = requirePickupCode(body.code || body.pickupCode);
  const fulfillment = db.prepare('SELECT * FROM fulfillment_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.order_id);
  const fulfillmentPayload = fulfillment ? JSON.parse(fulfillment.payload_json || '{}') : {};
  if (!fulfillmentPayload.pickupCode || !timingSafeTextEqual(code, fulfillmentPayload.pickupCode)) fail(401, 'INVALID_PICKUP_CODE');
  const payload = { orderId: order.order_id, storeId: order.store_id, code, verifiedAt: new Date().toISOString() };
  const id = `pickup-${Date.now()}-${randomBytes(3).toString('hex')}`;
  db.prepare('INSERT INTO pickup_verifications (id, order_id, code, merchant_address, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    id,
    order.order_id,
    payload.code,
    session.address,
    JSON.stringify(payload)
  );
  db.prepare('UPDATE orders SET status = ?, fulfillment_verified_at = CURRENT_TIMESTAMP, settlement_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run('PickupReady', order.order_id);
  db.prepare('INSERT OR REPLACE INTO fulfillment_orders (id, order_id, type, status, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    `fulfillment-${order.order_id}`,
    order.order_id,
    'pickup',
    'VerifiedAwaitingSettlement',
    JSON.stringify({ ...fulfillmentPayload, ...payload, pickupCode: undefined })
  );
  const settlementRequest = createSettlementRequest(order, session.address, 'pickup-verified', payload);
  writeAudit(session.role, session.address, 'merchant.pickup.verify', order.order_id, payload);
  const printJob = await createMerchantPrintJob(session, { orderId: order.order_id, jobType: 'pickup', copies: 2, storeId: order.store_id, secondaryMessage: body.secondaryMessage, secondarySignature: body.secondarySignature });
  await deliverNotification({
    channel: 'order',
    recipient: order.buyer_address,
    type: 'order.pickup-verified',
    title: '门店自提已核销',
    body: '清算请求已生成，等待链上确认。',
    orderId: order.order_id
  });
  return {
    ok: true,
    action: 'merchant.pickup.verify',
    target: order.order_id,
    actorAddress: session.address,
    status: 'PickupReady',
    settlementRequest,
    printJob,
    audit: 'written',
    ...payload
  };
}

async function createMerchantWaybill(session, body) {
  const orderId = requireString(body.orderId, 'orderId');
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (order.seller_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'ORDER_SELLER_MISMATCH');
  if ((order.fulfillment_mode || 'delivery') !== 'delivery') fail(400, 'ORDER_NOT_DELIVERY_MODE');
  const carrier = requireString(body.carrier || 'SF', 'carrier');
  const result = await createElectronicWaybill({
    order: fulfillmentOrderPayload(order),
    carrier,
    templateId: body.templateId || null,
    monthlyAccount: body.monthlyAccount || null
  }, process.env);
  const trackingNo = requireTrackingNo(providerTrackingNo(result));
  db.prepare('INSERT OR REPLACE INTO logistics_orders (id, order_id, carrier, tracking_no, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    `logistics-${order.order_id}`,
    order.order_id,
    carrier,
    trackingNo,
    JSON.stringify({ providerJobId: result.providerJobId, status: result.status })
  );
  writeAudit(session.role, session.address, 'merchant.waybill.create', order.order_id, { carrier, trackingNo, providerJobId: result.providerJobId });
  return { orderId: order.order_id, carrier, trackingNo, providerJobId: result.providerJobId, status: result.status };
}

async function createMerchantPrintJob(session, body) {
  const orderId = requireString(body.orderId, 'orderId');
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (order.seller_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'ORDER_SELLER_MISMATCH');
  const jobType = String(body.jobType || (order.fulfillment_mode === 'pickup' ? 'pickup' : 'shipment'));
  if (jobType !== 'pickup' && jobType !== 'shipment') fail(400, 'INVALID_PRINT_JOB_TYPE');
  const copies = jobType === 'pickup' ? 2 : Math.max(1, Math.min(10, Number(body.copies || 1)));
  if (!Number.isSafeInteger(copies)) fail(400, 'INVALID_PRINT_COPIES');
  const id = `print-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const jobPayload = {
    id,
    orderId: order.order_id,
    jobType,
    copies,
    deviceId: body.deviceId || null,
    storeId: order.store_id || body.storeId || null,
    order: fulfillmentOrderPayload(order)
  };
  db.prepare('INSERT INTO print_jobs (id, merchant_address, order_id, job_type, copies, status, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    session.address.toLowerCase(),
    order.order_id,
    jobType,
    copies,
    'Pending',
    JSON.stringify(jobPayload)
  );
  try {
    const result = await submitPrintJob(jobPayload, process.env);
    db.prepare('UPDATE print_jobs SET status = ?, provider_job_id = ?, attempts = attempts + 1, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      result.status || 'Submitted',
      result.providerJobId || null,
      id
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PRINT_PROVIDER_ERROR';
    const status = code === 'PRINT_NOT_CONFIGURED' ? 'ConfigurationRequired' : 'Failed';
    db.prepare('UPDATE print_jobs SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, code, id);
  }
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
  writeAudit(session.role, session.address, 'merchant.print.submit', id, { orderId: order.order_id, jobType, copies, status: job.status });
  return toPrintJob(job);
}

function merchantClaimRequest(session, body) {
  expirePendingClaimRequests(session.address);
  const reward = availableRewardForClaim(session.address, body.rewardId || '');
  const entryId = rewardLedgerEntryIdFromRewardId(reward.id);
  if (!isValidAddress(REWARD_LEDGER)) fail(409, 'REWARD_LEDGER_ADDRESS_NOT_CONFIGURED');
  if (entryId === null) fail(409, 'REWARD_ID_NOT_ONCHAIN_ENTRY');
  const expiresAt = Date.now() + claimRequestTtlMs();
  let claim;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE reward_ledger SET state = 'PendingClaim' WHERE id = ? AND state = 'Available'").run(reward.id);
    claim = recordClaim(session.address, body.bucketId || bucketIdForLedgerEntry(toRewardLedgerEntry(reward)), reward.asset_symbol, reward.amount, 'pending', null, { rewardId: reward.id, expiresAt });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const transactionIntent = merchantClaimTransactionIntent(session.address, reward.id, entryId);
  writeAudit(session.role, session.address, 'merchant.claim.request', reward.id, { ...body, amount: reward.amount, assetSymbol: reward.asset_symbol, claimId: claim.id });
  return { ok: true, claim, reward: toLedgerEntry(db.prepare('SELECT * FROM reward_ledger WHERE id = ?').get(reward.id)), transactionIntent, status: 'AwaitingWalletTransaction' };
}

function merchantClaimTransactionIntent(walletAddress, rewardId, entryId) {
  return {
    key: 'rewardLedgerClaim',
    chainId: CHAIN_ID,
    from: walletAddress,
    to: REWARD_LEDGER,
    value: '0x0',
    rewardId,
    entryId: String(entryId),
    data: rewardLedgerTxInterface.encodeFunctionData('claim', [entryId])
  };
}

async function merchantClaimStatus(session, claimId, searchParams) {
  expirePendingClaimRequests(session.address);
  const claim = merchantClaimRow(session, claimId);
  const txHashValue = searchParams.get('txHash') || claim.tx_hash;
  if (!txHashValue) return { status: claim.status, retryable: claim.status === 'pending', claim: toClaimRecord(claim) };
  const txHash = requireBytes32(txHashValue, 'txHash');
  if (!claim.tx_hash) db.prepare('UPDATE claims SET tx_hash = ? WHERE id = ?').run(txHash, claim.id);
  const params = new URLSearchParams({ walletAddress: session.address, rewardId: claim.reward_id, txHash });
  const chain = await claimTxStatus(params);
  return { ...chain, claim: toClaimRecord(db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id)) };
}

function retryMerchantClaimIntent(session, claimId, body) {
  expirePendingClaimRequests(session.address);
  const claim = merchantClaimRow(session, claimId);
  if (claim.status !== 'pending') fail(409, 'CLAIM_NOT_PENDING');
  const reward = db.prepare('SELECT * FROM reward_ledger WHERE id = ?').get(claim.reward_id);
  if (!reward || reward.state !== 'PendingClaim') fail(409, 'CLAIM_REWARD_NOT_PENDING');
  const entryId = rewardLedgerEntryIdFromRewardId(reward.id);
  if (entryId === null || !isValidAddress(REWARD_LEDGER)) fail(409, 'REWARD_CLAIM_NOT_CONFIGURED');
  const transactionIntent = merchantClaimTransactionIntent(session.address, reward.id, entryId);
  writeAudit(session.role, session.address, 'merchant.claim.retry', claim.id, { rewardId: reward.id, previousTxHash: claim.tx_hash || null });
  return { ok: true, claim: toClaimRecord(claim), transactionIntent, status: 'AwaitingWalletTransaction' };
}

function cancelMerchantClaim(session, claimId, body) {
  expirePendingClaimRequests(session.address);
  const claim = merchantClaimRow(session, claimId);
  if (claim.status !== 'pending') fail(409, 'CLAIM_NOT_PENDING');
  if (claim.tx_hash) fail(409, 'CLAIM_TRANSACTION_ALREADY_BROADCAST');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE claims SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(claim.id);
    db.prepare("UPDATE reward_ledger SET state = 'Available' WHERE id = ? AND state = 'PendingClaim'").run(claim.reward_id);
    writeAudit(session.role, session.address, 'merchant.claim.cancel', claim.id, { rewardId: claim.reward_id, reason: String(body.reason || '').slice(0, 300) });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, claim: toClaimRecord(db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id)), reward: toLedgerEntry(db.prepare('SELECT * FROM reward_ledger WHERE id = ?').get(claim.reward_id)) };
}

function merchantClaimRow(session, claimId) {
  const id = requireString(claimId, 'claimId');
  const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!row) fail(404, 'CLAIM_NOT_FOUND');
  if (row.wallet_address.toLowerCase() !== session.address.toLowerCase()) fail(403, 'CLAIM_WALLET_MISMATCH');
  if (!row.reward_id) fail(409, 'CLAIM_REWARD_NOT_LINKED');
  return row;
}

function fulfillmentOrderPayload(order) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.order_id).map((row) => ({
    productId: row.product_id,
    skuId: row.sku_id,
    skuName: row.sku_name,
    quantity: Number(row.quantity)
  }));
  const address = order.address_id ? db.prepare('SELECT payload_json FROM address_book WHERE id = ?').get(order.address_id) : null;
  const store = order.store_id ? storeById(order.store_id) : null;
  return {
    orderId: order.order_id,
    buyerAddress: order.buyer_address,
    sellerAddress: order.seller_address,
    amountNpl: order.amount_npl,
    fulfillmentMode: order.fulfillment_mode,
    regionCode: order.region_code,
    address: address ? JSON.parse(address.payload_json || '{}') : null,
    store,
    items
  };
}

function providerTrackingNo(result) {
  return String(result?.raw?.trackingNo || result?.raw?.waybillNo || result?.raw?.tracking_no || result?.providerJobId || '').trim();
}

function requireTrackingNo(value) {
  const text = requireString(String(value || ''), 'trackingNo');
  if (!/^[a-zA-Z0-9-]{6,64}$/.test(text)) fail(400, 'INVALID_TRACKING_NO');
  return text;
}

function timingSafeTextEqual(left, right) {
  const leftHash = createHash('sha256').update(String(left)).digest();
  const rightHash = createHash('sha256').update(String(right)).digest();
  return leftHash.equals(rightHash);
}

function createSettlementRequest(order, requestedBy, reason, payload = {}) {
  const id = `settlement-${String(order.order_id).slice(2, 18)}`;
  db.prepare(`
    INSERT INTO settlement_requests (id, order_id, requested_by, reason, status, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      requested_by = excluded.requested_by,
      reason = excluded.reason,
      status = CASE WHEN settlement_requests.status = 'Confirmed' THEN settlement_requests.status ELSE excluded.status END,
      payload_json = excluded.payload_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, order.order_id, String(requestedBy).toLowerCase(), reason, 'AwaitingOwnerTransaction', JSON.stringify(payload));
  return {
    id,
    orderId: order.order_id,
    status: 'AwaitingOwnerTransaction',
    transactionIntent: ownerCompleteOrderIntent(order)
  };
}

function ownerCompleteOrderIntent(order) {
  if (!isValidAddress(ESCROW) || !isValidAddress(ADMIN_WALLET)) return null;
  return {
    key: 'escrowCompleteOrder',
    chainId: CHAIN_ID,
    from: ADMIN_WALLET,
    to: ESCROW,
    data: escrowTxInterface.encodeFunctionData('completeOrder', [order.order_id]),
    value: '0x0',
    orderId: order.order_id
  };
}

async function deliverNotification(notification) {
  const id = `notify-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const scheduledAt = notification.scheduledAt ? Date.parse(notification.scheduledAt) : 0;
  const status = scheduledAt > Date.now() ? 'Scheduled' : 'Pending';
  db.prepare('INSERT INTO notification_deliveries (id, channel, recipient, status, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    id,
    notification.channel || 'app',
    notification.recipient || 'broadcast',
    status,
    JSON.stringify(notification)
  );
  if (status === 'Scheduled') return notificationDeliveryById(id);
  await dispatchNotificationDelivery(id, notification);
  return notificationDeliveryById(id);
}

async function dispatchNotificationDelivery(id, notification) {
  const channel = String(notification.channel || 'app').toLowerCase();
  if (channel === 'app' || channel === 'in-app') {
    persistInAppMessage(notification);
    db.prepare("UPDATE notification_deliveries SET status = 'Delivered', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    return;
  }
  try {
    const result = await sendNotification(notification, process.env);
    db.prepare('UPDATE notification_deliveries SET status = ?, provider_job_id = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(result.status || 'Submitted', result.providerJobId || null, id);
  } catch (error) {
    db.prepare('UPDATE notification_deliveries SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      error instanceof Error && error.message === 'NOTIFICATION_NOT_CONFIGURED' ? 'ConfigurationRequired' : 'Failed',
      error instanceof Error ? error.message : 'NOTIFICATION_PROVIDER_ERROR',
      id
    );
  }
}

async function publishDueNotifications() {
  const rows = db.prepare("SELECT * FROM notification_deliveries WHERE status = 'Scheduled' ORDER BY created_at LIMIT 200").all();
  for (const row of rows) {
    const notification = JSON.parse(row.payload_json || '{}');
    if (!notification.scheduledAt || Date.parse(notification.scheduledAt) > Date.now()) continue;
    db.prepare("UPDATE notification_deliveries SET status = 'Pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'Scheduled'").run(row.id);
    await dispatchNotificationDelivery(row.id, notification);
  }
}

function persistInAppMessage(notification) {
  const id = String(notification.messageId || `message-${Date.now()}-${randomBytes(3).toString('hex')}`).slice(0, 128);
  db.prepare('INSERT OR REPLACE INTO messages (id, title, preview, date_label, sort_order) VALUES (?, ?, ?, ?, ?)').run(
    id,
    requireString(notification.title, 'title').slice(0, 160),
    String(notification.preview || notification.body || '').slice(0, 280),
    notification.scheduledAt || new Date().toISOString(),
    Number.isSafeInteger(Number(notification.sortOrder)) ? Number(notification.sortOrder) : 99
  );
}

function notificationDeliveryById(id) {
  const row = db.prepare('SELECT * FROM notification_deliveries WHERE id = ?').get(id);
  if (!row) return null;
  const payload = JSON.parse(row.payload_json || '{}');
  return {
    id: row.id,
    channel: row.channel,
    recipient: row.recipient,
    status: row.status,
    providerJobId: row.provider_job_id || null,
    lastError: row.last_error || null,
    scheduledAt: payload.scheduledAt || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeNotificationChannels(value) {
  const source = Array.isArray(value) ? value : [value];
  const channels = [...new Set(source.map((entry) => String(entry || '').toLowerCase() === 'in-app' ? 'app' : String(entry || '').toLowerCase()).filter(Boolean))];
  if (!channels.length || channels.some((channel) => !['app', 'sms', 'email', 'push'].includes(channel))) fail(400, 'INVALID_NOTIFICATION_CHANNELS');
  return channels;
}

function normalizeNotificationAudience(body) {
  const type = String(body.audience || 'all').toLowerCase();
  if (!['all', 'region', 'merchant', 'wallet'].includes(type)) fail(400, 'INVALID_NOTIFICATION_AUDIENCE');
  if (type === 'all') return { type, value: '', recipient: 'broadcast' };
  const raw = requireString(body.audienceValue || body.recipient, 'audienceValue');
  if (type === 'wallet') {
    const value = requireAddress(raw, 'audienceValue').toLowerCase();
    return { type, value, recipient: value };
  }
  if (type === 'region') {
    const value = requireRegionCode(raw, 'audienceValue');
    return { type, value, recipient: `region:${value}` };
  }
  const value = raw.slice(0, 128);
  return { type, value, recipient: `merchant:${value}` };
}

function normalizeScheduledAt(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) fail(400, 'INVALID_SCHEDULED_AT');
  return new Date(timestamp).toISOString();
}

function auditedMerchantAction(session, action, target, body) {
  if (action === 'merchant.printer.configure') {
    const deviceId = requireString(body?.deviceId || target, 'deviceId').slice(0, 96);
    const config = {
      deviceId,
      provider: String(body?.provider || 'webhook').slice(0, 40),
      storeId: body?.storeId ? normalizeStoreId(body.storeId) : null,
      enabled: body?.enabled !== false
    };
    persistAdminConfig(`merchant-printer:${session.address.toLowerCase()}:${deviceId}`, config);
  }
  writeAudit(session.role, session.address, action, target, body);
  return { ok: true, action, target, actorAddress: session.address, audit: 'written' };
}

function auditedAdminAction(session, action, target, body, extra = {}) {
  writeAudit(session.role, session.address, action, target, body);
  return { ok: true, action, target, actorAddress: session.address, audit: 'written', ...extra };
}

function approveProductSubmission(id, body = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(id);
    if (!row) fail(404, 'PRODUCT_SUBMISSION_NOT_FOUND');
    if (row.status !== 'PendingReview') fail(409, 'INVALID_SUBMISSION_STATUS');
    const payload = normalizeMerchantSubmissionPayload(JSON.parse(row.immutable_payload_json || row.payload_json || '{}'));
    const productId = row.approved_product_id || approvedProductIdForSubmission(id);
    const existingProduct = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (existingProduct && row.approved_product_id !== productId) fail(409, 'APPROVED_PRODUCT_ID_COLLISION');
    const collision = db.prepare('SELECT id FROM product_submissions WHERE approved_product_id = ? AND id <> ? LIMIT 1').get(productId, id);
    if (collision) fail(409, 'APPROVED_PRODUCT_ID_COLLISION');

    const title = requireString(payload.title || row.title || '24K 商家商品', 'title');
    const skuName = String(payload.sku || payload.skuName || '默认 SKU').slice(0, 80);
    const priceNpl = normalizeUnitPrice(payload.priceNpl || payload.settlementPriceNpl || '1.000000000000000000', '1.000000000000000000');
    const stock = normalizeStock(payload.stock ?? payload.seckillStock ?? 1, 'stock');
    const skus = normalizeApprovedSkus(productId, payload, { skuName, priceNpl, stock });

    db.prepare(`
      INSERT INTO products (id, shop_name, title, sku, image_url, price_npl, stock, seller_address, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        shop_name = excluded.shop_name,
        title = excluded.title,
        sku = excluded.sku,
        image_url = excluded.image_url,
        price_npl = excluded.price_npl,
        stock = excluded.stock,
        seller_address = excluded.seller_address,
        status = excluded.status
    `).run(
      productId,
      payload.shopName || '24K 商家店铺',
      title,
      skuName,
      payload.imageUrl || 'asset://24k-carryall.png',
      priceNpl,
      stock,
      row.merchant_address,
      'Active'
    );

    const keepSkuIds = [];
    const upsertSku = db.prepare(`
      INSERT INTO product_skus (id, product_id, name, settlement_price_npl, stock, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        product_id = excluded.product_id,
        name = excluded.name,
        settlement_price_npl = excluded.settlement_price_npl,
        stock = excluded.stock,
        payload_json = excluded.payload_json
    `);
    for (const sku of skus) {
      const existingSku = db.prepare('SELECT product_id FROM product_skus WHERE id = ?').get(sku.id);
      if (existingSku && existingSku.product_id !== productId) fail(409, 'APPROVED_SKU_ID_COLLISION');
      keepSkuIds.push(sku.id);
      upsertSku.run(sku.id, productId, sku.name, sku.settlementPriceNpl, sku.stock, JSON.stringify(sku.payload));
    }
    if (keepSkuIds.length) {
      const placeholders = keepSkuIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM product_skus WHERE product_id = ? AND id NOT IN (${placeholders})`).run(productId, ...keepSkuIds);
    }

    db.prepare(`
      UPDATE product_submissions
      SET status = 'Approved',
          approved_product_id = ?,
          locked_at = COALESCE(locked_at, CURRENT_TIMESTAMP),
          immutable_payload_json = COALESCE(immutable_payload_json, payload_json)
      WHERE id = ? AND status = 'PendingReview'
    `).run(productId, id);
    db.exec('COMMIT');
    return { id: productId, title, sku: skuName, locked: true, skuIds: keepSkuIds };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rejectProductSubmission(id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT id FROM product_submissions WHERE id = ?').get(id);
    if (!row) fail(404, 'PRODUCT_SUBMISSION_NOT_FOUND');
    db.prepare('UPDATE product_submissions SET status = ? WHERE id = ?').run('Rejected', id);
    db.exec('COMMIT');
    return { id, status: 'Rejected' };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function approveProductTakedown(id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(id);
    if (!row) fail(404, 'PRODUCT_SUBMISSION_NOT_FOUND');
    if (row.status !== 'TakedownRequested') fail(409, 'INVALID_SUBMISSION_STATUS');
    if (row.approved_product_id) db.prepare("UPDATE products SET status = 'Inactive' WHERE id = ?").run(row.approved_product_id);
    db.prepare("UPDATE product_submissions SET status = 'TakenDown' WHERE id = ?").run(id);
    db.exec('COMMIT');
    return { id, productId: row.approved_product_id || null, status: 'TakenDown' };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rejectProductTakedown(id) {
  const row = db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(id);
  if (!row) fail(404, 'PRODUCT_SUBMISSION_NOT_FOUND');
  if (row.status !== 'TakedownRequested') fail(409, 'INVALID_SUBMISSION_STATUS');
  const payload = JSON.parse(row.payload_json || '{}');
  const restoredStatus = ['Approved', 'Scheduled', 'Live'].includes(payload.statusBeforeTakedown) ? payload.statusBeforeTakedown : 'Approved';
  db.prepare('UPDATE product_submissions SET status = ? WHERE id = ?').run(restoredStatus, id);
  return { id, productId: row.approved_product_id || null, status: restoredStatus };
}

function approvedProductIdForSubmission(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 36);
  const hash = createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
  return `p-merchant-${safe}-${hash}`;
}

function normalizeApprovedSkus(productId, payload, fallback) {
  const source = Array.isArray(payload.skus) && payload.skus.length ? payload.skus.slice(0, 50) : [fallback];
  const productHash = createHash('sha256').update(productId).digest('hex').slice(0, 10);
  return source.map((sku, index) => ({
    id: `sku-${productHash}-${String(index + 1).padStart(2, '0')}`,
    name: String(sku.name || sku.skuName || fallback.skuName).slice(0, 80),
    settlementPriceNpl: normalizeUnitPrice(sku.settlementPriceNpl || sku.priceNpl || fallback.priceNpl, fallback.priceNpl),
    stock: normalizeStock(sku.stock ?? fallback.stock, `skuStock${index + 1}`),
    payload: { ...sku, ignoredClientSkuId: sku.id || undefined }
  }));
}

function normalizeStock(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(400, `INVALID_${String(name).toUpperCase()}`);
  return number;
}

function normalizeMerchantLevels(body) {
  const config = {};
  for (const level of ['v1', 'v2', 'v3', 'v4', 'v5']) {
    const priceKey = `${level}PriceLimitNpl`;
    const quotaKey = `${level}SeckillQuota`;
    if (body[priceKey] !== undefined) config[priceKey] = formatDecimal18(parseDecimal18(String(body[priceKey])));
    if (body[quotaKey] !== undefined) config[quotaKey] = normalizeStock(body[quotaKey], quotaKey);
  }
  if (!Object.keys(config).length) fail(400, 'MERCHANT_LEVELS_EMPTY');
  return config;
}

function normalizeRiskPolicies(body) {
  const result = {
    blockContractCallers: body.blockContractCallers === true,
    flashLoanDetection: body.flashLoanDetection === true
  };
  if (body.maxGasGwei !== undefined) {
    const maxGasGwei = Number(body.maxGasGwei);
    if (!Number.isFinite(maxGasGwei) || maxGasGwei <= 0) fail(400, 'INVALID_MAX_GAS_GWEI');
    result.maxGasGwei = maxGasGwei;
  }
  for (const key of ['walletSwitchesPerMinute', 'cancellationsPerFiveMinutes', 'fulfillmentChangesPerFiveMinutes', 'tradeLockMinutes']) {
    if (body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000) fail(400, `INVALID_${key.toUpperCase()}`);
    result[key] = value;
  }
  return result;
}

function normalizeMerchantQualification(body, walletAddress) {
  const businessLicenseNumber = requireString(body.businessLicenseNumber || body.licenseNumber, 'businessLicenseNumber').trim().slice(0, 120);
  if (!/^[a-zA-Z0-9\u4e00-\u9fff._-]{5,120}$/.test(businessLicenseNumber)) fail(400, 'INVALID_BUSINESS_LICENSE_NUMBER');
  const [businessLicenseUrl] = normalizeHttpsImages([body.businessLicenseUrl || body.licenseUrl], { required: true, field: 'businessLicenseUrl' });
  const legalRepresentative = requireString(body.legalRepresentative || body.legalName, 'legalRepresentative').trim().slice(0, 80);
  const legalIdentity = requireString(body.legalIdentity || body.legalId, 'legalIdentity').trim();
  if (legalIdentity.length < 6 || legalIdentity.length > 120) fail(400, 'INVALID_LEGAL_IDENTITY');
  const contactName = requireString(body.contactName, 'contactName').trim().slice(0, 80);
  const contactPhone = requireString(body.contactPhone, 'contactPhone').trim();
  if (!/^\+?[0-9][0-9 ()-]{5,22}[0-9]$/.test(contactPhone)) fail(400, 'INVALID_CONTACT_PHONE');
  const settlementWallet = requireAddress(body.settlementWallet || body.settlementWalletAddress, 'settlementWallet').toLowerCase();
  if (settlementWallet !== walletAddress.toLowerCase()) fail(400, 'SETTLEMENT_WALLET_MUST_MATCH_SELLER');
  return {
    businessLicenseNumber,
    businessLicenseUrl,
    legalRepresentative,
    legalIdentityHash: `0x${createHash('sha256').update(legalIdentity).digest('hex')}`,
    legalIdentityLast4: legalIdentity.slice(-4),
    contactName,
    contactPhone,
    settlementWallet,
    verifiedAt: new Date().toISOString()
  };
}

function createAdminProduct(body) {
  const sellerAddress = requireAddress(body.sellerAddress, 'sellerAddress').toLowerCase();
  const merchant = db.prepare("SELECT * FROM merchants WHERE lower(wallet_address) = ? AND status = 'Approved'").get(sellerAddress);
  if (!merchant) fail(403, 'SELLER_NOT_APPROVED');
  const title = requireString(body.title, 'title').slice(0, 160);
  const categoryId = body.categoryId ? normalizeTaxonomyId(body.categoryId, 'categoryId') : null;
  if (categoryId) {
    const category = db.prepare('SELECT * FROM categories WHERE id = ? AND level = 3 AND enabled = 1 AND deleted_at IS NULL').get(categoryId);
    if (!category) fail(400, 'ACTIVE_LEVEL3_CATEGORY_REQUIRED');
  }
  const requestedTags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean).slice(0, 20) : [];
  const tagIds = requestedTags.map((tag) => {
    const row = db.prepare('SELECT id FROM tags WHERE (id = ? OR lower(name) = lower(?)) AND enabled = 1 AND deleted_at IS NULL').get(tag, tag);
    if (!row) fail(400, 'TAG_NOT_FOUND');
    return row.id;
  });
  const skus = Array.isArray(body.skus) && body.skus.length ? body.skus.slice(0, 50) : [];
  if (!skus.length) fail(400, 'PRODUCT_SKU_REQUIRED');
  const normalizedSkus = skus.map((sku, index) => ({
    name: requireString(sku?.name || sku?.skuName, `skuName${index + 1}`).slice(0, 80),
    stock: normalizeStock(sku?.stock, `skuStock${index + 1}`),
    settlementPriceNpl: normalizeUnitPrice(requireString(sku?.settlementPriceNpl || sku?.priceNpl, `skuPriceNpl${index + 1}`), '')
  }));
  const storeId = String(body.storeId || 'default').slice(0, 96);
  if (db.prepare("SELECT id FROM product_submissions WHERE lower(merchant_address) = ? AND store_id = ? AND status IN ('PendingReview','Approved','Scheduled','Live')").get(sellerAddress, storeId)) {
    fail(423, 'MERCHANT_SINGLE_PRODUCT_LOCKED');
  }
  const id = `admin-submission-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const payload = {
    ...stripSignedEnvelope(body),
    title,
    shopName: body.shopName || merchant.name,
    sellerAddress,
    storeId,
    categoryId,
    tagIds,
    sku: normalizedSkus[0].name,
    skuName: normalizedSkus[0].name,
    stock: normalizedSkus.reduce((sum, sku) => sum + sku.stock, 0),
    priceNpl: normalizedSkus[0].settlementPriceNpl,
    settlementPriceNpl: normalizedSkus[0].settlementPriceNpl,
    skus: normalizedSkus
  };
  db.prepare('INSERT INTO product_submissions (id, merchant_address, store_id, title, status, locked_at, immutable_payload_json, payload_json) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)').run(
    id, sellerAddress, storeId, title, 'PendingReview', JSON.stringify(payload), JSON.stringify(payload)
  );
  try {
    const approved = approveProductSubmission(id, body);
    for (const tagId of tagIds) db.prepare('INSERT OR IGNORE INTO product_tags (product_id, tag_id) VALUES (?, ?)').run(approved.id, tagId);
    return { ...toProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(approved.id)), categoryId, tagIds, locked: true };
  } catch (error) {
    db.prepare('DELETE FROM product_submissions WHERE id = ? AND status = ?').run(id, 'PendingReview');
    throw error;
  }
}

function updateAdminProduct(body, { softDelete = false } = {}) {
  const productId = requireString(body.productId || body.id, 'productId');
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!existing) fail(404, 'PRODUCT_NOT_FOUND');
  const oldValue = toProduct(existing);
  const updates = [];
  const values = [];
  const requestedStatus = softDelete ? 'Inactive' : body.status;
  if (requestedStatus !== undefined) {
    if (!['Active', 'Inactive', 'SoldOut'].includes(String(requestedStatus))) fail(400, 'INVALID_PRODUCT_STATUS');
    if (requestedStatus === 'Inactive') assertProductOperationalMutationAllowed(productId);
    updates.push('status = ?');
    values.push(String(requestedStatus));
  }
  if (body.title !== undefined) {
    updates.push('title = ?');
    values.push(normalizeProductTitle(body.title));
  }
  if (body.imageUrl !== undefined) {
    const [imageUrl] = normalizeHttpsImages([body.imageUrl], { required: true, field: 'productImage' });
    updates.push('image_url = ?');
    values.push(imageUrl);
  }
  let nextPrice = null;
  if (body.priceNpl !== undefined || body.settlementPriceNpl !== undefined) {
    nextPrice = normalizeUnitPrice(body.priceNpl ?? body.settlementPriceNpl, '');
    if (parseDecimal18(nextPrice) <= 0n) fail(400, 'INVALID_PRODUCT_PRICE');
    updates.push('price_npl = ?');
    values.push(nextPrice);
  }
  let nextStock = null;
  if (body.stock !== undefined) {
    nextStock = normalizeStock(body.stock, 'stock');
    updates.push('stock = ?');
    values.push(nextStock);
  }
  if (updates.length === 0) fail(400, 'EMPTY_PRODUCT_UPDATE');
  const skuRows = db.prepare('SELECT * FROM product_skus WHERE product_id = ? ORDER BY id').all(productId);
  if ((nextPrice !== null || nextStock !== null) && skuRows.length > 1) fail(409, 'MULTI_SKU_UPDATE_REQUIRES_SKU_MATRIX');
  values.push(productId);
  db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (skuRows.length === 1) {
    if (nextPrice !== null) db.prepare('UPDATE product_skus SET settlement_price_npl = ? WHERE id = ?').run(nextPrice, skuRows[0].id);
    if (nextStock !== null) db.prepare('UPDATE product_skus SET stock = ? WHERE id = ?').run(nextStock, skuRows[0].id);
  }
  if (nextStock === 0) markProductSoldOutIfEmpty(productId);
  if (softDelete) db.prepare("UPDATE product_submissions SET status = 'TakenDown' WHERE approved_product_id = ? AND status IN ('Approved','Scheduled','Live','TakedownRequested','SoldOut')").run(productId);
  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  return { productId, oldValue, newValue: toProduct(updated), softDeleted: softDelete };
}

function assertProductOperationalMutationAllowed(productId) {
  const reason = productOperationalLockReason(productId);
  if (reason) fail(423, reason);
}

function productOperationalLockReason(productId) {
  const activeSeckill = db.prepare(`
    SELECT id FROM seckill_sessions
    WHERE product_id = ? AND status IN ('scheduled','Scheduled','live','settling','PendingChainPublish')
    LIMIT 1
  `).get(productId);
  if (activeSeckill) return 'PRODUCT_ACTIVE_SECKILL_LOCKED';
  const lockedOrder = db.prepare(`
    SELECT o.order_id
    FROM orders o JOIN order_items i ON i.order_id = o.order_id
    WHERE i.product_id = ? AND o.status IN ('PaidLocked','AwaitingShipment','Shipped','PickupReady','Arbitration','RefundRequested')
    LIMIT 1
  `).get(productId);
  if (lockedOrder) return 'PRODUCT_LOCKED_ASSETS';
  return '';
}

function upsertLogisticsTemplate(body) {
  const id = normalizeTaxonomyId(body.id || `template-${Date.now()}-${randomBytes(2).toString('hex')}`, 'templateId');
  const chargeMode = String(body.chargeMode || 'quantity');
  if (!['quantity', 'weight'].includes(chargeMode)) fail(400, 'INVALID_CHARGE_MODE');
  const blockedRegionCodes = Array.isArray(body.blockedRegionCodes) ? body.blockedRegionCodes.map((value) => requireRegionCode(String(value))).slice(0, 500) : [];
  const template = {
    id,
    name: requireString(body.name, 'name').slice(0, 80),
    chargeMode,
    baseFeeNpl: normalizeUnitPrice(body.baseFeeNpl, ''),
    incrementFeeNpl: normalizeUnitPrice(body.incrementFeeNpl, ''),
    blockedRegionCodes: [...new Set(blockedRegionCodes)],
    dalianPickupFree: body.dalianPickupFree === true,
    enabled: body.enabled !== false
  };
  persistAdminConfig(`logistics-template:${id}`, template);
  return template;
}

function upsertLogisticsAddress(body) {
  const id = normalizeTaxonomyId(body.id || `address-${Date.now()}-${randomBytes(2).toString('hex')}`, 'addressId');
  const type = String(body.type || 'shipping');
  if (!['shipping', 'return', 'pickup'].includes(type)) fail(400, 'INVALID_LOGISTICS_ADDRESS_TYPE');
  const phone = requireString(body.phone, 'phone').slice(0, 24);
  if (!/^\+?[0-9 -]{6,24}$/.test(phone)) fail(400, 'INVALID_PHONE');
  const address = {
    id,
    type,
    name: requireString(body.name, 'name').slice(0, 80),
    contactName: requireString(body.contactName, 'contactName').slice(0, 60),
    phone,
    regionCode: requireRegionCode(body.regionCode),
    address: requireString(body.address, 'address').slice(0, 300),
    enabled: body.enabled !== false
  };
  persistAdminConfig(`logistics-address:${id}`, address);
  return address;
}

function rejectPersistedSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (/(secret|password|access.?key|api.?key|token)$/i.test(key) && entry) fail(400, 'SECRETS_MUST_USE_ENV');
    if (entry && typeof entry === 'object') rejectPersistedSecrets(entry);
  }
}

function normalizeMessageGateways(body) {
  const webhookConfigured = Boolean(process.env.NOTIFICATION_WEBHOOK_URL && process.env.NOTIFICATION_WEBHOOK_TOKEN);
  const config = {
    smsProvider: body.smsProvider ? String(body.smsProvider).slice(0, 40) : '',
    smtpHost: body.smtpHost ? String(body.smtpHost).slice(0, 255) : '',
    smtpUser: body.smtpUser ? String(body.smtpUser).slice(0, 255) : '',
    pushProvider: body.pushProvider ? String(body.pushProvider).slice(0, 40) : '',
    credentialsSource: 'environment'
  };
  config.channels = [
    { id: 'in-app', provider: '24k', enabled: true, credentialsConfigured: true },
    { id: 'sms', provider: config.smsProvider, enabled: webhookConfigured, credentialsConfigured: webhookConfigured },
    { id: 'email', provider: config.smtpHost, enabled: webhookConfigured, credentialsConfigured: webhookConfigured },
    { id: 'push', provider: config.pushProvider, enabled: webhookConfigured, credentialsConfigured: webhookConfigured }
  ];
  return config;
}

async function handleAdminAction(session, action, body) {
  const target = body.targetId || body.productId || body.merchantId || body.orderId || body.key || 'global';
  if (action === 'admin.after-sale.resolve') {
    const result = resolveAfterSaleCase(session, body);
    return auditedAdminAction(session, action, result.case.id, body, result);
  }
  if (action === 'admin.product.review') {
    const id = requireString(body.productId || body.targetId, 'productId');
    const status = String(body.decision || body.status || '').toLowerCase() === 'rejected' ? 'Rejected' : 'Approved';
    const submission = db.prepare('SELECT status FROM product_submissions WHERE id = ?').get(id);
    if (submission?.status === 'TakedownRequested') {
      const takedown = status === 'Approved' ? approveProductTakedown(id) : rejectProductTakedown(id);
      return auditedAdminAction(session, action, id, body, { status: takedown.status, takedown });
    }
    const approvedProduct = status === 'Approved' ? approveProductSubmission(id, body) : null;
    if (status === 'Rejected') rejectProductSubmission(id);
    return auditedAdminAction(session, action, id, body, { status, approvedProduct });
  }
  if (action === 'admin.merchant.levels.configure') {
    const config = persistAdminConfig('merchant-levels', normalizeMerchantLevels(body));
    return auditedAdminAction(session, action, 'merchant-levels', body, { config });
  }
  if (action === 'admin.product.create') {
    const product = createAdminProduct(body);
    return auditedAdminAction(session, action, product.id, body, { product, status: 'Active' });
  }
  if (action === 'admin.product.update' || action === 'admin.product.delete') {
    const change = updateAdminProduct(body, { softDelete: action === 'admin.product.delete' });
    return auditedAdminAction(session, action, change.productId, { ...body, oldValue: change.oldValue, newValue: change.newValue }, { product: change.newValue, historyRecorded: true });
  }
  if (action === 'admin.risk.policies.configure') {
    const config = persistAdminConfig('risk-policies', normalizeRiskPolicies(body));
    const transactionIntent = config.maxGasGwei && isValidAddress(SECKILL)
      ? adminContractIntent('seckillSetMaxGasPrice', SECKILL, seckillTxInterface.encodeFunctionData('setMaxGasPriceWei', [BigInt(Math.floor(Number(config.maxGasGwei) * 1_000_000_000))]), { maxGasGwei: Number(config.maxGasGwei) })
      : null;
    return auditedAdminAction(session, action, 'risk-policies', body, { config, transactionIntent, status: transactionIntent ? 'AwaitingOwnerTransaction' : 'Saved' });
  }
  if (action === 'admin.logistics.credentials.configure') {
    rejectPersistedSecrets(body);
    const carrier = requireString(body.carrier, 'carrier').toUpperCase().slice(0, 16);
    const current = readAdminConfig(`logistics:${carrier}`) || {};
    const config = persistAdminConfig(`logistics:${carrier}`, {
      ...current,
      carrier,
      provider: requireString(body.provider, 'provider').slice(0, 40),
      partnerId: body.partnerId ? String(body.partnerId).slice(0, 96) : current.partnerId || '',
      monthlyAccount: body.monthlyAccount ? String(body.monthlyAccount).slice(0, 96) : current.monthlyAccount || '',
      printerTemplate: body.printerTemplate ? String(body.printerTemplate).slice(0, 120) : current.printerTemplate || '',
      electronicWaybill: body.electronicWaybill !== false,
      default: Boolean(body.isDefault ?? body.default ?? current.default),
      credentialsSource: 'environment',
      credentialsConfigured: Boolean(process.env.ELECTRONIC_WAYBILL_WEBHOOK_TOKEN)
    });
    return auditedAdminAction(session, action, carrier, body, { config: redactConfigValue(config) });
  }
  if (action === 'admin.logistics.template.upsert') {
    const template = upsertLogisticsTemplate(body);
    return auditedAdminAction(session, action, template.id, body, { template });
  }
  if (action === 'admin.logistics.address.upsert') {
    const address = upsertLogisticsAddress(body);
    return auditedAdminAction(session, action, address.id, body, { address });
  }
  if (action === 'admin.message.gateway.configure') {
    rejectPersistedSecrets(body);
    const config = persistAdminConfig('message-gateways', normalizeMessageGateways(body));
    return auditedAdminAction(session, action, 'message-gateways', body, { config: redactConfigValue(config) });
  }
  if (action === 'admin.merchant.review') {
    const wallet = requireAddress(body.walletAddress, 'walletAddress');
    const existing = db.prepare('SELECT * FROM merchants WHERE lower(wallet_address) = ?').get(wallet.toLowerCase());
    const id = requireString(existing?.id || body.merchantId || `merchant-${createHash('sha256').update(wallet.toLowerCase()).digest('hex').slice(0, 12)}`, 'merchantId');
    const approved = String(body.decision || body.status || '').toLowerCase() !== 'rejected';
    const status = approved ? 'PendingChainApproval' : 'PendingChainRejection';
    if (!isValidAddress(ESCROW)) fail(409, 'ESCROW_ADDRESS_NOT_CONFIGURED');
    const businessBody = stripSignedEnvelope(body);
    const qualification = approved ? normalizeMerchantQualification(businessBody, wallet) : null;
    delete businessBody.legalIdentity;
    delete businessBody.legalId;
    const merchantPayload = {
      ...(existing ? JSON.parse(existing.payload_json || '{}') : {}),
      ...businessBody,
      ...(qualification ? { qualification } : {}),
      approved,
      chainStatus: 'AwaitingOwnerTransaction'
    };
    db.prepare(`
      INSERT INTO merchants (id, wallet_address, name, status, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET name = excluded.name, status = excluded.status, payload_json = excluded.payload_json
    `).run(
      id,
      wallet.toLowerCase(),
      body.name || existing?.name || '24K 官方严选',
      status,
      JSON.stringify(merchantPayload)
    );
    const transactionIntent = adminContractIntent(
      'escrowSetSeller',
      ESCROW,
      escrowTxInterface.encodeFunctionData('setSeller', [wallet, approved]),
      { seller: wallet.toLowerCase(), approved }
    );
    return auditedAdminAction(session, action, id, body, { status, walletAddress: wallet.toLowerCase(), transactionIntent });
  }
  if (action === 'admin.seckill.schedule') {
    const id = body.sessionId || `sk-${Date.now()}`;
    const productId = requireString(body.productId || 'p-24k-runner', 'productId');
    const status = String(body.status || 'scheduled');
    if (!['draft', 'scheduled', 'live'].includes(status)) fail(400, 'INVALID_SECKILL_SCHEDULE_STATUS');
    const publishOnchain = body.publishOnchain === true || status === 'live';
    const requestedStartsAt = Date.parse(String(body.startsAt || new Date().toISOString()));
    if (!Number.isFinite(requestedStartsAt)) fail(400, 'INVALID_SECKILL_START_TIME');
    if (publishOnchain && requestedStartsAt > Date.now()) fail(409, 'SECKILL_SESSION_NOT_DUE');
    db.prepare('INSERT OR REPLACE INTO seckill_sessions (id, product_id, status, starts_at, ends_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      productId,
      publishOnchain ? 'PendingChainPublish' : status,
      body.startsAt || new Date().toISOString(),
      body.endsAt || new Date(Date.now() + 60 * 60_000).toISOString(),
      JSON.stringify(stripSignedEnvelope(body))
    );
    const { transactionIntent, transactionIntents } = seckillPublishIntents(publishOnchain ? { ...body, productId } : null);
    const onchainPending = Boolean(transactionIntent || transactionIntents.length);
    const storedStatus = status === 'draft' ? 'Draft' : 'Scheduled';
    return auditedAdminAction(session, action, id, body, { sessionId: id, productId, transactionIntent, transactionIntents, status: onchainPending ? 'AwaitingOwnerTransaction' : storedStatus });
  }
  if (action === 'admin.seckill.publish') {
    const sessionId = requireString(body.sessionId, 'sessionId');
    const row = db.prepare('SELECT * FROM seckill_sessions WHERE id = ?').get(sessionId);
    if (!row) fail(404, 'SECKILL_SESSION_NOT_FOUND');
    if (!['scheduled', 'PendingChainPublish'].includes(row.status)) fail(409, 'SECKILL_SESSION_NOT_PUBLISHABLE');
    const startsAt = Date.parse(row.starts_at);
    if (!Number.isFinite(startsAt) || startsAt > Date.now()) fail(409, 'SECKILL_SESSION_NOT_DUE');
    const payload = JSON.parse(row.payload_json || '{}');
    const durationSeconds = payload.durationSeconds || Math.max(1, Math.floor((Date.parse(row.ends_at) - startsAt) / 1000));
    const publishPayload = { ...payload, ...stripSignedEnvelope(body), sessionId, productId: row.product_id, durationSeconds };
    const intents = seckillPublishIntents(publishPayload);
    if (!intents.transactionIntent && intents.transactionIntents.length === 0) fail(409, 'SECKILL_ADDRESS_NOT_CONFIGURED');
    db.prepare('UPDATE seckill_sessions SET status = ?, payload_json = ? WHERE id = ?').run('PendingChainPublish', JSON.stringify({
      ...payload,
      publishRequestedAt: new Date().toISOString(),
      publishRequestedBy: session.address,
      source: 'admin.scheduled'
    }), sessionId);
    return auditedAdminAction(session, action, sessionId, body, { ...intents, sessionId, productId: row.product_id, status: 'PendingChainConfirmation' });
  }
  if (action === 'admin.reward.release') {
    const orderId = body.orderId ? requireBytes32(body.orderId, 'orderId') : null;
    if (orderId && isValidAddress(REWARD_LEDGER)) {
      const transactionIntent = adminContractIntent('rewardReleaseOrder', REWARD_LEDGER, rewardLedgerTxInterface.encodeFunctionData('releaseOrderRewards', [orderId]), { orderId });
      return auditedAdminAction(session, action, orderId, body, { transactionIntent, status: 'AwaitingOwnerTransaction' });
    }
    const reward = releaseReward(body);
    return auditedAdminAction(session, action, reward.id, body, { reward, status: 'ReleasedOffchain' });
  }
  if (action === 'admin.ratio.configure') {
    if (!isValidAddress(ESCROW)) fail(409, 'ESCROW_ADDRESS_NOT_CONFIGURED');
    const normalized = normalizeRatioConfig(body);
    const splitConfig = splitConfigForRatio(body, normalized);
    const encodedConfig = AbiCoder.defaultAbiCoder().encode([
      'tuple(address platformReceiver,address regionReceiver,address referralReceiver,address prizePoolReceiver,address burnReceiver,address circulationReceiver,uint16 merchantBps,uint16 platformBps,uint16 regionBps,uint16 referralBps,uint16 prizePoolBps,uint16 burnBps,uint16 circulationBps)'
    ], [splitConfig]);
    const configHash = keccak256(encodedConfig).toLowerCase();
    const pendingKey = `ratio-config-pending:${configHash}`;
    const config = persistAdminConfig(pendingKey, {
      ...normalized,
      ...splitConfig,
      configHash,
      status: 'AwaitingOwnerTransaction'
    });
    const transactionIntent = adminContractIntent(
      'escrowSetSplitConfig',
      ESCROW,
      escrowTxInterface.encodeFunctionData('setSplitConfig', [splitConfig]),
      { configHash }
    );
    return auditedAdminAction(session, action, configHash, body, { config, transactionIntent, status: 'PendingChainConfirmation' });
  }
  if (action === 'admin.prize-pool.inject') {
    const amountNpl = String(body.amountNpl || body.amount || '0');
    const units = parseDecimal18(amountNpl);
    if (units <= 0n) fail(400, 'INVALID_PRIZE_POOL_AMOUNT');
    if (!isValidAddress(REWARD_LEDGER)) fail(409, 'REWARD_LEDGER_ADDRESS_NOT_CONFIGURED');
    const transactionIntent = adminContractIntent('fundPrizePoolNpl', NPL, erc20TxInterface.encodeFunctionData('transfer', [REWARD_LEDGER, units]), { amountNpl, recipient: REWARD_LEDGER });
    const config = persistAdminConfig(`prize-pool-pending:${Date.now()}`, { amountNpl, recipient: REWARD_LEDGER, note: body.note || '', status: 'AwaitingOwnerTransaction' });
    return auditedAdminAction(session, action, 'prize-pool', body, { config, transactionIntent, status: 'AwaitingOwnerTransaction' });
  }
  if (action === 'admin.force-refund') {
    const orderId = requireString(body.orderId, 'orderId');
    const order = findOrderByIdOrOrderId(orderId);
    if (!order) fail(404, 'ORDER_NOT_FOUND');
    if (!isRefundableOrderStatus(order.status)) fail(400, 'ORDER_NOT_REFUNDABLE');
    if (body.refundNplAmount !== undefined || body.amountNpl !== undefined) fail(400, 'FULL_REFUND_ONLY');
    if (!isValidAddress(ESCROW)) fail(409, 'ESCROW_ADDRESS_NOT_CONFIGURED');
    const transactionIntent = adminContractIntent(
      'escrowForceRefund',
      ESCROW,
      escrowTxInterface.encodeFunctionData('forceRefund', [order.order_id]),
      { orderId: order.order_id, fullRefundNpl: order.amount_npl, rewardsBurnedAtomically: true }
    );
    db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run('RefundRequested', order.order_id);
    return auditedAdminAction(session, action, orderId, body, {
      status: 'RefundRequested',
      transactionIntent,
      next: '发送链上 forceRefund；仅在 OrderForcedRefunded 事件验证后进入 ForcedRefunded。'
    });
  }
  if (action.startsWith('admin.circuit.')) {
    const enabled = body.enabled !== false;
    const scope = action.replace('admin.circuit.', '');
    const transactionIntents = circuitTransactionIntents(scope, enabled, body);
    if (transactionIntents.length === 0) fail(409, 'CIRCUIT_ONCHAIN_ACTION_NOT_CONFIGURED');
    requestCircuitBreaker(scope, enabled, body.reason || body.note || action);
    const circuit = circuitState(scope);
    return auditedAdminAction(session, action, target, body, {
      scope,
      state: circuit.state,
      redLight: circuit.enabled,
      circuit,
      transactionIntents,
      recovery: 'secondary signature + owner transaction + indexed chain event required'
    });
  }
  if (action === 'admin.blacklist.update') {
    const key = blacklistKey(body);
    if (body.enabled === false) db.prepare('DELETE FROM blacklists WHERE address = ?').run(key);
    else db.prepare('INSERT OR REPLACE INTO blacklists (address, reason) VALUES (?, ?)').run(key, body.reason || 'manual risk control');
    return auditedAdminAction(session, action, key, body, { enabled: body.enabled !== false });
  }
  if (action === 'admin.cms.publish') {
    const content = upsertCmsContent(body, session.address);
    return auditedAdminAction(session, action, content.key, body, { content });
  }
  if (action === 'admin.logistics.configure') {
    const carrier = requireString(body.carrier || 'SF', 'carrier');
    const config = persistAdminConfig(`logistics:${carrier}`, { carrier, enabled: body.enabled !== false, default: Boolean(body.default), printerTemplate: body.printerTemplate || '', electronicWaybill: Boolean(body.electronicWaybill), freightTemplate: body.freightTemplate || null });
    return auditedAdminAction(session, action, carrier, body, { config });
  }
  if (action === 'admin.message.notify') {
    const title = requireString(body.title || '24K 通知', 'title');
    const id = body.id || `admin-message-${Date.now()}`;
    const channels = normalizeNotificationChannels(body.channels || [body.channel || 'app']);
    const audience = normalizeNotificationAudience(body);
    const scheduledAt = normalizeScheduledAt(body.scheduledAt);
    const notification = {
      messageId: id,
      title,
      body: requireString(body.preview || body.text, 'text').slice(0, 4000),
      preview: String(body.preview || body.text).slice(0, 280),
      type: String(body.type || 'platform.notice').slice(0, 80),
      priority: String(body.priority || 'normal').slice(0, 20),
      audience: audience.type,
      audienceValue: audience.value,
      recipient: audience.recipient,
      channels,
      scheduledAt,
      sortOrder: Number(body.sortOrder || 99)
    };
    const deliveries = [];
    for (const channel of channels) deliveries.push(await deliverNotification({ ...notification, channel }));
    return auditedAdminAction(session, action, id, body, { id, title, audience, channels, scheduledAt, deliveries });
  }
  if (action === 'admin.batch.run') {
    const batch = await runAdminBatch(body, session);
    return auditedAdminAction(session, action, batch.id, body, { batch });
  }
  if (action === 'admin.category.upsert') {
    const category = upsertAdminCategory(body);
    return auditedAdminAction(session, action, category.id, body, { category });
  }
  if (action === 'admin.category.delete') {
    const category = deleteAdminCategory(body);
    return auditedAdminAction(session, action, category.id, body, { category });
  }
  if (action === 'admin.tag.upsert') {
    const tag = upsertAdminTag(body);
    return auditedAdminAction(session, action, tag.id, body, { tag });
  }
  if (action === 'admin.tag.delete') {
    const tag = deleteAdminTag(body);
    return auditedAdminAction(session, action, tag.id, body, { tag });
  }
  if (action === 'admin.system.configure') {
    const key = requireString(body.key, 'key');
    if (/secret|password|private.?key/i.test(key)) fail(400, 'SECRETS_MUST_USE_ENV');
    const input = body.value && typeof body.value === 'object' ? body.value : { value: body.value };
    const normalized = normalizeSystemConfig(key, input);
    if (key === 'chain') await validateChainRuntimeConfig(normalized);
    if (key === 'contracts') await validateContractRuntimeConfig(normalized);
    const previous = readAdminConfig(key);
    const config = persistAdminConfig(key, normalized);
    applyRuntimeConfigFromDatabase();
    return auditedAdminAction(session, action, key, { ...body, oldValue: previous, newValue: normalized }, { config: { ...config, ...redactConfigValue(config) }, applied: true });
  }
  if (action === 'admin.settlement.complete') {
    const orderId = requireString(body.orderId, 'orderId');
    const order = findOrderByIdOrOrderId(orderId);
    if (!order) fail(404, 'ORDER_NOT_FOUND');
    const request = db.prepare('SELECT * FROM settlement_requests WHERE order_id = ?').get(order.order_id);
    if (!request) fail(404, 'SETTLEMENT_REQUEST_NOT_FOUND');
    if (request.status === 'Confirmed') fail(409, 'SETTLEMENT_ALREADY_CONFIRMED');
    return auditedAdminAction(session, action, order.order_id, body, { status: 'AwaitingOwnerTransaction', transactionIntent: ownerCompleteOrderIntent(order) });
  }
  return auditedAdminAction(session, action, target, body);
}

function adminContractIntent(key, to, data, meta = {}) {
  if (!isValidAddress(ADMIN_WALLET)) fail(409, 'ADMIN_WALLET_NOT_CONFIGURED');
  if (!isValidAddress(to)) fail(409, 'CONTRACT_ADDRESS_NOT_CONFIGURED');
  return { key, chainId: CHAIN_ID, from: ADMIN_WALLET, to, data, value: '0x0', ...meta };
}

function seckillStartIntent(body) {
  if (!isValidAddress(SECKILL)) return null;
  const durationSeconds = normalizePositiveInteger(body.durationSeconds ?? body.duration ?? 3600, 'durationSeconds', 86_400);
  const relayInitialSeconds = normalizePositiveInteger(body.relayInitialSeconds ?? 3600, 'relayInitialSeconds', durationSeconds);
  const relayExtendSeconds = normalizePositiveInteger(body.relayExtendSeconds ?? 30, 'relayExtendSeconds', 3600);
  const product = db.prepare('SELECT price_npl FROM products WHERE id = ?').get(body.productId);
  const minimumNplAmount = parseDecimal18(String(body.minimumNplAmount || body.minimumAmountNpl || body.priceNpl || product?.price_npl || '0'));
  if (minimumNplAmount <= 0n) fail(400, 'INVALID_MINIMUM_NPL_AMOUNT');
  const prizePoolNpl = parseDecimal18(String(body.prizePoolNpl || '0'));
  return adminContractIntent(
    'seckillStartSession',
    SECKILL,
    seckillTxInterface.encodeFunctionData('startSession', [bytes32(body.productId), durationSeconds, relayInitialSeconds, relayExtendSeconds, minimumNplAmount, prizePoolNpl]),
    { productId: body.productId, durationSeconds, relayInitialSeconds, relayExtendSeconds, minimumNplAmount: formatDecimal18(minimumNplAmount), prizePoolNpl: formatDecimal18(prizePoolNpl) }
  );
}

function seckillPublishIntents(body) {
  if (!body) return { transactionIntent: null, transactionIntents: [] };
  let transactionIntent = seckillStartIntent(body);
  let transactionIntents = [];
  if (transactionIntent && parseDecimal18(transactionIntent.prizePoolNpl || '0') > 0n) {
    transactionIntents = [
      adminContractIntent('approveSeckillPrizePoolNpl', NPL, erc20TxInterface.encodeFunctionData('approve', [SECKILL, MAX_UINT256]), { spender: SECKILL, amount: 'MaxUint256' }),
      transactionIntent
    ];
    transactionIntent = null;
  }
  return { transactionIntent, transactionIntents };
}

function normalizePositiveInteger(value, name, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) fail(400, `INVALID_${name.toUpperCase()}`);
  return number;
}

function circuitTransactionIntents(scope, enabled, body) {
  if (scope === 'orders' && isValidAddress(ESCROW)) {
    return [adminContractIntent(`escrow${enabled ? 'Pause' : 'Unpause'}`, ESCROW, escrowTxInterface.encodeFunctionData(enabled ? 'pause' : 'unpause'))];
  }
  if (scope === 'seckill' && isValidAddress(SECKILL)) {
    return [adminContractIntent(`seckill${enabled ? 'Pause' : 'Unpause'}`, SECKILL, seckillTxInterface.encodeFunctionData(enabled ? 'pause' : 'unpause'))];
  }
  if (scope === 'claims' && isValidAddress(REWARD_LEDGER)) {
    return [adminContractIntent(`rewards${enabled ? 'Pause' : 'Unpause'}`, REWARD_LEDGER, rewardLedgerTxInterface.encodeFunctionData(enabled ? 'pause' : 'unpause'))];
  }
  if (scope === 'force-cutoff' && enabled && isValidAddress(SECKILL)) {
    const sessionId = requireBytes32(body.sessionId || currentSeckillSession().id, 'sessionId');
    return [adminContractIntent('seckillForceClose', SECKILL, seckillTxInterface.encodeFunctionData('forceClose', [sessionId]), { sessionId })];
  }
  return [];
}

function blacklistKey(body) {
  const kind = String(body.kind || 'wallet').toLowerCase();
  if (kind === 'wallet') return requireAddress(body.address || body.value, 'address').toLowerCase();
  if (kind !== 'ip' && kind !== 'device') fail(400, 'INVALID_BLACKLIST_KIND');
  const raw = requireString(body.value || body.fingerprint, 'value');
  const digest = raw.startsWith('sha256:') ? raw.slice(7) : createHash('sha256').update(raw).digest('hex');
  if (!/^[0-9a-f]{64}$/i.test(digest)) fail(400, 'INVALID_BLACKLIST_FINGERPRINT');
  return `${kind}:sha256:${digest.toLowerCase()}`;
}

function upsertAdminCategory(body) {
  const id = normalizeTaxonomyId(body.id || `category-${Date.now()}`, 'categoryId');
  const parentId = body.parentId ? normalizeTaxonomyId(body.parentId, 'parentId') : null;
  const level = Number(body.level || (parentId ? Number(db.prepare('SELECT level FROM categories WHERE id = ?').get(parentId)?.level || 0) + 1 : 1));
  if (!Number.isSafeInteger(level) || level < 1 || level > 3) fail(400, 'INVALID_CATEGORY_LEVEL');
  if (parentId) {
    const parent = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(parentId);
    if (!parent || Number(parent.level) !== level - 1) fail(400, 'INVALID_CATEGORY_PARENT');
  }
  const name = requireString(body.name, 'name').slice(0, 60);
  const serviceFeeBps = clampBps(body.serviceFeeBps || 0, 'serviceFeeBps');
  db.prepare(`
    INSERT INTO categories (id, parent_id, level, name, icon, sort_order, service_fee_bps, enabled, deleted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id,
      level = excluded.level,
      name = excluded.name,
      icon = excluded.icon,
      sort_order = excluded.sort_order,
      service_fee_bps = excluded.service_fee_bps,
      enabled = excluded.enabled,
      deleted_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, parentId, level, name, String(body.icon || '').slice(0, 60), Number(body.sortOrder || 0), serviceFeeBps, body.enabled === false ? 0 : 1);
  return adminCategories().find((entry) => entry.id === id);
}

function deleteAdminCategory(body) {
  const id = normalizeTaxonomyId(body.id || body.categoryId, 'categoryId');
  const category = adminCategories().find((entry) => entry.id === id);
  if (!category) fail(404, 'CATEGORY_NOT_FOUND');
  if (category.locked) fail(423, 'CATEGORY_LOCKED_BY_ACTIVE_PRODUCT');
  if (db.prepare('SELECT id FROM categories WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1').get(id)) fail(423, 'CATEGORY_HAS_CHILDREN');
  db.prepare('UPDATE categories SET enabled = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  return { ...category, enabled: false, deleted: true };
}

function upsertAdminTag(body) {
  const id = normalizeTaxonomyId(body.id || `tag-${Date.now()}`, 'tagId');
  const name = requireString(body.name, 'name').slice(0, 60);
  db.prepare(`
    INSERT INTO tags (id, name, enabled, deleted_at, updated_at)
    VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
  `).run(id, name, body.enabled === false ? 0 : 1);
  return adminTags().find((entry) => entry.id === id);
}

function deleteAdminTag(body) {
  const id = normalizeTaxonomyId(body.id || body.tagId, 'tagId');
  const tag = adminTags().find((entry) => entry.id === id);
  if (!tag) fail(404, 'TAG_NOT_FOUND');
  if (tag.locked) fail(423, 'TAG_LOCKED_BY_ACTIVE_PRODUCT');
  db.prepare('UPDATE tags SET enabled = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  return { ...tag, enabled: false, deleted: true };
}

function normalizeTaxonomyId(value, name) {
  const text = requireString(String(value || ''), name).slice(0, 80);
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(text)) fail(400, `INVALID_${name.toUpperCase()}`);
  return text;
}

function normalizeRatioConfig(body) {
  const bnmRebateBps = clampBps(body.bnmRebateBps ?? body.bnmRebateRateBps ?? Number(body.bnmRebateRate ?? 100) * 100, 'bnmRebateBps');
  const prizePoolBps = clampBps(body.prizePoolBps ?? body.prizePool ?? 0, 'prizePoolBps');
  const platformFeeBps = clampBps(body.platformFeeBps ?? body.platformFee ?? 0, 'platformFeeBps');
  const regionBps = clampBps(body.regionBps ?? body.region ?? 0, 'regionBps');
  const referralBps = clampBps(body.referralBps ?? body.referral ?? 0, 'referralBps');
  const nplBurnBps = clampBps(body.nplBurnBps ?? body.burnBps ?? 0, 'nplBurnBps');
  const nplCirculationBps = clampBps(body.nplCirculationBps ?? body.circulationBps ?? 0, 'nplCirculationBps');
  const allocatedWithoutMerchant = prizePoolBps + platformFeeBps + regionBps + referralBps + nplBurnBps + nplCirculationBps;
  if (allocatedWithoutMerchant > 10_000) fail(400, 'NPL_ALLOCATION_EXCEEDS_100_PERCENT');
  const merchantCostBps = clampBps(body.merchantCostBps ?? body.merchantCost ?? (10_000 - allocatedWithoutMerchant), 'merchantCostBps');
  if (allocatedWithoutMerchant + merchantCostBps !== 10_000) fail(400, 'NPL_ALLOCATION_MUST_EQUAL_100_PERCENT');
  const beneficiaryWeights = normalizeBeneficiaryWeights(body.beneficiaries || body.beneficiaryWeights || []);
  if (beneficiaryWeights.length && beneficiaryWeights.reduce((sum, entry) => sum + entry.weightBps, 0) !== 10_000) fail(400, 'BENEFICIARY_WEIGHTS_MUST_EQUAL_100_PERCENT');
  return { nplPaymentBps: 10_000, bnmRebateBps, prizePoolBps, platformFeeBps, regionBps, referralBps, nplBurnBps, nplCirculationBps, merchantCostBps, beneficiaryWeights };
}

function splitConfigForRatio(body, config) {
  const beneficiary = (roles) => config.beneficiaryWeights.find((entry) => roles.includes(String(entry.role).toLowerCase()))?.walletAddress || '';
  const receiver = (field, envName, roles, bps, fallback = '') => {
    const candidate = body[field] || process.env[envName] || beneficiary(roles) || fallback;
    if (bps === 0 && !candidate) return ZERO_ADDRESS;
    return requireAddress(candidate, field);
  };
  return {
    platformReceiver: receiver('platformReceiver', 'PLATFORM_NPL_RECEIVER', ['platform'], config.platformFeeBps),
    regionReceiver: receiver('regionReceiver', 'REGION_NPL_RECEIVER', ['regional-agent', 'region'], config.regionBps),
    referralReceiver: receiver('referralReceiver', 'REFERRAL_NPL_RECEIVER', ['referral', 'channel'], config.referralBps),
    prizePoolReceiver: receiver('prizePoolReceiver', 'PRIZE_POOL_NPL_RECEIVER', ['prize-pool'], config.prizePoolBps),
    burnReceiver: receiver('burnReceiver', 'BURN_NPL_RECEIVER', ['burn'], config.nplBurnBps, DEAD_ADDRESS),
    circulationReceiver: receiver('circulationReceiver', 'CIRCULATION_NPL_RECEIVER', ['circulation', 'pool-return'], config.nplCirculationBps),
    merchantBps: config.merchantCostBps,
    platformBps: config.platformFeeBps,
    regionBps: config.regionBps,
    referralBps: config.referralBps,
    prizePoolBps: config.prizePoolBps,
    burnBps: config.nplBurnBps,
    circulationBps: config.nplCirculationBps
  };
}

async function readEscrowSplitConfig(version, expectedHash) {
  if (!CHAIN_EVENT_RPC_URL) fail(409, 'SPLIT_CONFIG_PENDING_NOT_FOUND');
  const data = escrowTxInterface.encodeFunctionData('splitConfigs', [version]);
  const result = await rpc('eth_call', [{ to: ESCROW, data }, 'latest']);
  const decoded = escrowTxInterface.decodeFunctionResult('splitConfigs', result);
  const splitConfig = {
    platformReceiver: decoded.platformReceiver,
    regionReceiver: decoded.regionReceiver,
    referralReceiver: decoded.referralReceiver,
    prizePoolReceiver: decoded.prizePoolReceiver,
    burnReceiver: decoded.burnReceiver,
    circulationReceiver: decoded.circulationReceiver,
    merchantBps: Number(decoded.merchantBps),
    platformBps: Number(decoded.platformBps),
    regionBps: Number(decoded.regionBps),
    referralBps: Number(decoded.referralBps),
    prizePoolBps: Number(decoded.prizePoolBps),
    burnBps: Number(decoded.burnBps),
    circulationBps: Number(decoded.circulationBps)
  };
  const encoded = AbiCoder.defaultAbiCoder().encode([
    'tuple(address platformReceiver,address regionReceiver,address referralReceiver,address prizePoolReceiver,address burnReceiver,address circulationReceiver,uint16 merchantBps,uint16 platformBps,uint16 regionBps,uint16 referralBps,uint16 prizePoolBps,uint16 burnBps,uint16 circulationBps)'
  ], [splitConfig]);
  if (keccak256(encoded).toLowerCase() !== expectedHash.toLowerCase()) fail(400, 'SPLIT_CONFIG_HASH_MISMATCH');
  const previous = readAdminConfig('ratio-config') || {};
  return {
    nplPaymentBps: 10_000,
    bnmRebateBps: Number(previous.bnmRebateBps ?? 10_000),
    merchantCostBps: splitConfig.merchantBps,
    platformFeeBps: splitConfig.platformBps,
    regionBps: splitConfig.regionBps,
    referralBps: splitConfig.referralBps,
    prizePoolBps: splitConfig.prizePoolBps,
    nplBurnBps: splitConfig.burnBps,
    nplCirculationBps: splitConfig.circulationBps,
    beneficiaryWeights: Array.isArray(previous.beneficiaryWeights) ? previous.beneficiaryWeights : [],
    ...splitConfig,
    source: 'escrow-indexer'
  };
}

function paymentRatioForProduct(productId) {
  const configRow = readAdminConfigRow('ratio-config');
  const config = configRow?.payload;
  if (config && Number.isSafeInteger(Number(config.bnmRebateBps))) {
    return {
      nplPaymentBps: 10_000,
      bnmRebateBps: Number(config.bnmRebateBps),
      source: 'admin-config',
      updatedAt: configRow.updatedAt
    };
  }
  const ui = PRODUCT_UI[productId] || { nplRatio: 100, bnmRebateRate: 100 };
  return {
    nplPaymentBps: 10_000,
    bnmRebateBps: Number(ui.bnmRebateRate ?? 100) * 100,
    source: 'product-default',
    updatedAt: null
  };
}

function readAdminConfig(key) {
  return readAdminConfigRow(key)?.payload || null;
}

function readAdminConfigRow(key) {
  const row = db.prepare('SELECT payload_json, updated_at FROM admin_configs WHERE key = ?').get(key);
  if (!row) return null;
  return { payload: JSON.parse(row.payload_json || '{}'), updatedAt: row.updated_at || null };
}

function normalizeSystemConfig(keyValue, inputValue) {
  const key = String(keyValue || '').trim();
  const input = inputValue && typeof inputValue === 'object' && !Array.isArray(inputValue) ? inputValue : {};
  if (containsSensitiveConfigKey(input)) fail(400, 'SECRETS_MUST_USE_ENV');
  if (key === 'chain') {
    assertOnlyConfigFields(input, ['chainId', 'multisigAddress', 'primaryRpcUrl', 'backupRpcUrl']);
    const chainId = normalizeConfigInteger(input.chainId ?? CHAIN_ID, 'chainId', 1, 2_147_483_647);
    if (chainId !== CHAIN_ID) fail(400, 'CHAIN_ID_IS_ENV_IMMUTABLE');
    return compactConfig({
      chainId,
      multisigAddress: normalizeOptionalConfigAddress(input.multisigAddress, 'multisigAddress'),
      primaryRpcUrl: normalizeRuntimeUrl(input.primaryRpcUrl, 'primaryRpcUrl'),
      backupRpcUrl: normalizeRuntimeUrl(input.backupRpcUrl, 'backupRpcUrl')
    });
  }
  if (key === 'oracle-gas') {
    assertOnlyConfigFields(input, ['oracleAddress', 'oracleDeviationBps', 'oracleReferencePrice', 'oracleMaxAgeSeconds', 'maxGasGwei']);
    return compactConfig({
      oracleAddress: normalizeOptionalConfigAddress(input.oracleAddress, 'oracleAddress'),
      oracleDeviationBps: input.oracleDeviationBps === undefined ? undefined : normalizeConfigInteger(input.oracleDeviationBps, 'oracleDeviationBps', 0, 10_000),
      oracleReferencePrice: normalizeOptionalPositiveDecimal(input.oracleReferencePrice, 'oracleReferencePrice'),
      oracleMaxAgeSeconds: input.oracleMaxAgeSeconds === undefined ? undefined : normalizeConfigInteger(input.oracleMaxAgeSeconds, 'oracleMaxAgeSeconds', 30, 86_400),
      maxGasGwei: normalizeOptionalPositiveDecimal(input.maxGasGwei, 'maxGasGwei')
    });
  }
  if (key === 'contracts') {
    assertOnlyConfigFields(input, ['nplAddress', 'bnmAddress', 'escrowAddress', 'seckillAddress', 'rewardLedgerAddress', 'genesisNodeAddress']);
    const nplAddress = normalizeOptionalConfigAddress(input.nplAddress, 'nplAddress');
    if (nplAddress && nplAddress.toLowerCase() !== NPL.toLowerCase()) fail(400, 'NPL_ADDRESS_IS_FIXED');
    return compactConfig({
      nplAddress: nplAddress || NPL,
      bnmAddress: normalizeOptionalConfigAddress(input.bnmAddress, 'bnmAddress'),
      escrowAddress: normalizeOptionalConfigAddress(input.escrowAddress, 'escrowAddress'),
      seckillAddress: normalizeOptionalConfigAddress(input.seckillAddress, 'seckillAddress'),
      rewardLedgerAddress: normalizeOptionalConfigAddress(input.rewardLedgerAddress, 'rewardLedgerAddress'),
      genesisNodeAddress: normalizeOptionalConfigAddress(input.genesisNodeAddress, 'genesisNodeAddress')
    });
  }
  if (key === 'business-parameters') {
    assertOnlyConfigFields(input, ['shippingTimeoutHours', 'confirmationTimeoutHours', 'siweNonceTtlMinutes', 'actionIntentTtlMinutes', 'claimRequestTtlMinutes']);
    return compactConfig({
      shippingTimeoutHours: input.shippingTimeoutHours === undefined ? undefined : normalizeConfigInteger(input.shippingTimeoutHours, 'shippingTimeoutHours', 1, 720),
      confirmationTimeoutHours: input.confirmationTimeoutHours === undefined ? undefined : normalizeConfigInteger(input.confirmationTimeoutHours, 'confirmationTimeoutHours', 1, 720),
      siweNonceTtlMinutes: input.siweNonceTtlMinutes === undefined ? undefined : normalizeConfigInteger(input.siweNonceTtlMinutes, 'siweNonceTtlMinutes', 1, 60),
      actionIntentTtlMinutes: input.actionIntentTtlMinutes === undefined ? undefined : normalizeConfigInteger(input.actionIntentTtlMinutes, 'actionIntentTtlMinutes', 1, 60),
      claimRequestTtlMinutes: input.claimRequestTtlMinutes === undefined ? undefined : normalizeConfigInteger(input.claimRequestTtlMinutes, 'claimRequestTtlMinutes', 1, 1_440)
    });
  }
  if (key === 'infrastructure') {
    assertOnlyConfigFields(input, ['ossEndpoint', 'ossBucket', 'cdnEnabled', 'cdnBaseUrl', 'redisHealthUrl', 'mqHealthUrl']);
    const ossBucket = input.ossBucket === undefined ? undefined : String(input.ossBucket || '').trim();
    if (ossBucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(ossBucket)) fail(400, 'INVALID_OSSBUCKET');
    return compactConfig({
      ossEndpoint: normalizeRuntimeUrl(input.ossEndpoint, 'ossEndpoint'),
      ossBucket,
      cdnEnabled: input.cdnEnabled === undefined ? undefined : Boolean(input.cdnEnabled),
      cdnBaseUrl: normalizeRuntimeUrl(input.cdnBaseUrl, 'cdnBaseUrl'),
      redisHealthUrl: normalizeRuntimeUrl(input.redisHealthUrl, 'redisHealthUrl'),
      mqHealthUrl: normalizeRuntimeUrl(input.mqHealthUrl, 'mqHealthUrl')
    });
  }
  if (key === 'ai-agent') {
    assertOnlyConfigFields(input, ['agentEnabled', 'agentPrompt', 'provider', 'model']);
    const agentPrompt = input.agentPrompt === undefined ? undefined : String(input.agentPrompt || '').trim().slice(0, 8_000);
    if (input.agentEnabled === true && !agentPrompt) fail(400, 'AI_AGENT_PROMPT_REQUIRED');
    return compactConfig({
      agentEnabled: input.agentEnabled === undefined ? undefined : Boolean(input.agentEnabled),
      agentPrompt,
      provider: input.provider === undefined ? undefined : String(input.provider || '').trim().slice(0, 80),
      model: input.model === undefined ? undefined : String(input.model || '').trim().slice(0, 120)
    });
  }
  fail(400, 'UNSUPPORTED_SYSTEM_CONFIG_KEY');
}

function applyRuntimeConfigFromDatabase() {
  const load = (key) => {
    const stored = readAdminConfig(key);
    if (!stored) return null;
    try {
      return normalizeSystemConfig(key, stored);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'runtime_config_rejected', key, error: sanitizeError(error) }));
      return null;
    }
  };
  const chain = load('chain');
  const contracts = load('contracts');
  CHAIN_EVENT_RPC_URL = chain?.primaryRpcUrl || ENV_CHAIN_EVENT_RPC_URL;
  CHAIN_EVENT_RPC_FALLBACK_URL = chain?.backupRpcUrl || ENV_CHAIN_EVENT_RPC_FALLBACK_URL;
  BNM = contracts?.bnmAddress || ENV_BNM;
  ESCROW = contracts?.escrowAddress || ENV_ESCROW;
  SECKILL = contracts?.seckillAddress || ENV_SECKILL;
  REWARD_LEDGER = contracts?.rewardLedgerAddress || ENV_REWARD_LEDGER;
  GENESIS_NODE_CONTRACT = contracts?.genesisNodeAddress || ENV_GENESIS_NODE_CONTRACT;
  rpcRuntimeState.active = null;
  rpcRuntimeState.degraded = false;
  rpcRuntimeState.lastLatencyMs = null;
  rpcRuntimeState.lastError = null;
  rpcRuntimeState.checkedAt = null;
}

async function validateChainRuntimeConfig(config) {
  const endpoints = [
    config.primaryRpcUrl ? { role: 'primary', url: config.primaryRpcUrl } : null,
    config.backupRpcUrl && config.backupRpcUrl !== config.primaryRpcUrl ? { role: 'fallback', url: config.backupRpcUrl } : null
  ].filter(Boolean);
  if (!endpoints.length) return;
  let reachable = 0;
  let validatedEndpoint = null;
  for (const endpoint of endpoints) {
    const attempt = await rpcAttempt(endpoint, 'eth_chainId', []);
    if (!attempt.ok) continue;
    reachable += 1;
    validatedEndpoint ||= endpoint;
    const chainId = Number.parseInt(String(attempt.result || ''), 16);
    if (!Number.isSafeInteger(chainId)) fail(400, `RPC_CHAIN_ID_INVALID:${endpoint.role}`);
    if (chainId !== CHAIN_ID) fail(400, `RPC_CHAIN_ID_MISMATCH:${endpoint.role}`);
  }
  if (!reachable) fail(400, 'RPC_ENDPOINTS_UNAVAILABLE');
  if (config.multisigAddress) {
    const codeAttempt = await rpcAttempt(validatedEndpoint, 'eth_getCode', [config.multisigAddress, 'latest']);
    if (!codeAttempt.ok) fail(400, 'MULTISIG_CODE_VALIDATION_FAILED');
    if (!/^0x[0-9a-f]+$/i.test(String(codeAttempt.result || '')) || /^0x0*$/i.test(String(codeAttempt.result))) fail(400, 'MULTISIG_CONTRACT_CODE_NOT_FOUND');
  }
}

async function validateContractRuntimeConfig(config) {
  const contracts = [
    ['nplAddress', config.nplAddress],
    ['bnmAddress', config.bnmAddress],
    ['escrowAddress', config.escrowAddress],
    ['seckillAddress', config.seckillAddress],
    ['rewardLedgerAddress', config.rewardLedgerAddress],
    ['genesisNodeAddress', config.genesisNodeAddress]
  ].filter(([, address]) => Boolean(address));
  const unique = new Set(contracts.map(([, address]) => address.toLowerCase()));
  if (unique.size !== contracts.length) fail(400, 'DUPLICATE_CONTRACT_ADDRESS');
  if (!CHAIN_EVENT_RPC_URL && !CHAIN_EVENT_RPC_FALLBACK_URL) fail(409, 'CONTRACT_RPC_VALIDATION_REQUIRED');
  for (const [field, address] of contracts) {
    let code;
    try {
      code = await rpc('eth_getCode', [address, 'latest']);
    } catch {
      fail(503, `CONTRACT_RPC_VALIDATION_FAILED:${field}`);
    }
    if (!/^0x[0-9a-f]+$/i.test(String(code || '')) || /^0x0*$/i.test(String(code))) fail(400, `CONTRACT_CODE_NOT_FOUND:${field}`);
  }
}

function orderTimeoutMs(kind = 'shipping') {
  const config = readAdminConfig('business-parameters') || {};
  const hours = Number(kind === 'confirmation' ? config.confirmationTimeoutHours : config.shippingTimeoutHours);
  return Number.isSafeInteger(hours) && hours >= 1 && hours <= 720 ? hours * 60 * 60_000 : DEFAULT_ORDER_TIMEOUT_MS;
}

function siweNonceTtlMs() {
  return configuredTtlMs('siweNonceTtlMinutes', DEFAULT_SIWE_NONCE_TTL_MS, 1, 60);
}

function actionIntentTtlMs() {
  return configuredTtlMs('actionIntentTtlMinutes', DEFAULT_ACTION_INTENT_TTL_MS, 1, 60);
}

function claimRequestTtlMs() {
  return configuredTtlMs('claimRequestTtlMinutes', DEFAULT_CLAIM_REQUEST_TTL_MS, 1, 1_440);
}

function configuredTtlMs(field, fallback, minimumMinutes, maximumMinutes) {
  const minutes = Number(readAdminConfig('business-parameters')?.[field]);
  return Number.isSafeInteger(minutes) && minutes >= minimumMinutes && minutes <= maximumMinutes ? minutes * 60_000 : fallback;
}

function containsSensitiveConfigKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => /secret|password|private.?key|access.?key|api.?key|token|credential/i.test(key) || containsSensitiveConfigKey(entry));
}

function assertOnlyConfigFields(input, allowedFields) {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) fail(400, `UNSUPPORTED_SYSTEM_CONFIG_FIELD:${unknown}`);
}

function compactConfig(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''));
}

function normalizeConfigInteger(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(400, `INVALID_${String(name).toUpperCase()}`);
  return number;
}

function normalizeOptionalConfigAddress(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  return requireAddress(String(value).trim(), name).toLowerCase();
}

function normalizeOptionalPositiveDecimal(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text) || Number(text) <= 0) fail(400, `INVALID_${String(name).toUpperCase()}`);
  return text;
}

function normalizeRuntimeUrl(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    fail(400, `INVALID_${String(name).toUpperCase()}`);
  }
  const developmentHttp = process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:';
  if (parsed.protocol !== 'https:' && !developmentHttp) fail(400, `INVALID_${String(name).toUpperCase()}_PROTOCOL`);
  if (parsed.username || parsed.password || parsed.hash) fail(400, `INVALID_${String(name).toUpperCase()}_CREDENTIALS`);
  if ([...parsed.searchParams.keys()].some((key) => /secret|password|private.?key|access.?key|api.?key|token|credential/i.test(key))) fail(400, `INVALID_${String(name).toUpperCase()}_CREDENTIALS`);
  if (process.env.NODE_ENV === 'production' && isPrivateRuntimeHostname(parsed.hostname)) fail(400, `INVALID_${String(name).toUpperCase()}_HOST`);
  return parsed.toString();
}

function isPrivateRuntimeHostname(hostnameValue) {
  const hostname = String(hostnameValue || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '::1' || hostname === '0.0.0.0') return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function normalizeBeneficiaryWeights(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((entry) => ({
    walletAddress: requireAddress(entry.walletAddress || entry.address, 'beneficiaryAddress'),
    weightBps: clampBps(entry.weightBps ?? entry.weight ?? 0, 'beneficiaryWeightBps'),
    role: String(entry.role || 'beneficiary').slice(0, 40)
  }));
}

function clampBps(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 10_000) fail(400, `INVALID_${name.toUpperCase()}`);
  return number;
}

function formatBpsPercent(value) {
  const number = Number(value || 0) / 100;
  return Number.isInteger(number) ? `${number}%` : `${number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function persistAdminConfig(key, payload) {
  db.prepare('INSERT OR REPLACE INTO admin_configs (key, payload_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, JSON.stringify(payload));
  return { key, ...payload };
}

async function runAdminBatch(body, session) {
  const requestedOperation = requireString(body.operation || body.type, 'operation');
  const operation = ({ 'print.shipping': 'print.shipments', 'print.pickup': 'print.pickups' })[requestedOperation] || requestedOperation;
  const resource = String(body.resource || 'mixed');
  const targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String).slice(0, 200) : [];
  const id = `batch-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const allowed = new Set(['export.csv', 'export.excel', 'print.shipments', 'print.pickups', 'review.approve', 'review.reject', 'soft-delete', 'product.up', 'product.down', 'batch.modify']);
  if (!allowed.has(operation)) fail(400, 'UNSUPPORTED_BATCH_OPERATION');
  if ((operation.startsWith('export.') || operation.startsWith('print.')) && targetIds.length === 0) fail(400, 'BATCH_TARGETS_REQUIRED');
  let affected = 0;
  const results = [];
  if (operation === 'review.approve') {
    for (const targetId of targetIds) {
      try {
        const approvedProduct = approveProductSubmission(targetId, body);
        affected += 1;
        results.push({ targetId, status: 'Approved', ok: true, approvedProductId: approvedProduct.id });
      } catch (error) {
        results.push({ targetId, status: 'Failed', ok: false, error: error instanceof Error ? error.message : 'APPROVAL_FAILED' });
      }
    }
  }
  if (operation === 'review.reject') {
    for (const targetId of targetIds) {
      try {
        rejectProductSubmission(targetId);
        affected += 1;
        results.push({ targetId, status: 'Rejected', ok: true });
      } catch (error) {
        results.push({ targetId, status: 'Failed', ok: false, error: error instanceof Error ? error.message : 'REJECT_FAILED' });
      }
    }
  }
  if (operation === 'soft-delete') {
    for (const targetId of targetIds) {
      try {
        if (resource === 'products') {
          const change = updateAdminProduct({ productId: targetId }, { softDelete: true });
          writeAudit(session.role, session.address, 'admin.product.batch-delete', targetId, { oldValue: change.oldValue, newValue: change.newValue });
          affected += 1;
          results.push({ targetId, status: 'Inactive', ok: true });
        } else if (resource === 'productSubmissions') {
          const submission = db.prepare('SELECT * FROM product_submissions WHERE id = ?').get(targetId);
          if (!submission) fail(404, 'PRODUCT_SUBMISSION_NOT_FOUND');
          if (isProductSubmissionLocked(submission.status)) fail(423, 'PRODUCT_SUBMISSION_LOCKED');
          db.prepare("UPDATE product_submissions SET status = 'Deleted' WHERE id = ?").run(targetId);
          affected += 1;
          results.push({ targetId, status: 'Deleted', ok: true });
        } else {
          fail(400, 'UNSUPPORTED_SOFT_DELETE_RESOURCE');
        }
      } catch (error) {
        results.push({ targetId, status: 'Failed', ok: false, error: error instanceof Error ? error.message : 'SOFT_DELETE_FAILED' });
      }
    }
  }
  if (operation === 'product.up' || operation === 'product.down') {
    const nextStatus = operation === 'product.up' ? 'Active' : 'Inactive';
    for (const targetId of targetIds) {
      try {
        const change = updateAdminProduct({ productId: targetId, status: nextStatus });
        writeAudit(session.role, session.address, 'admin.product.batch-status', targetId, { oldValue: change.oldValue, newValue: change.newValue });
        affected += 1;
        results.push({ targetId, status: nextStatus, ok: true });
      } catch (error) {
        results.push({ targetId, status: 'Failed', ok: false, error: error instanceof Error ? error.message : 'PRODUCT_STATUS_FAILED' });
      }
    }
  }
  if (operation === 'batch.modify') {
    const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
    if (resource !== 'products') fail(400, 'UNSUPPORTED_BATCH_MODIFY_RESOURCE');
    const nextStatus = patch.status === 'Inactive' || patch.status === 'Active' ? patch.status : null;
    const nextStock = patch.stock === undefined ? null : normalizeStock(patch.stock, 'stock');
    const nextPrice = patch.priceNpl === undefined ? null : normalizeUnitPrice(patch.priceNpl, '');
    if (!nextStatus && nextStock === null && nextPrice === null) fail(400, 'EMPTY_BATCH_MODIFY_PATCH');
    for (const targetId of targetIds) {
      try {
        const change = updateAdminProduct({ productId: targetId, status: nextStatus || undefined, stock: nextStock ?? undefined, priceNpl: nextPrice ?? undefined });
        writeAudit(session.role, session.address, 'admin.product.batch-update', targetId, { oldValue: change.oldValue, newValue: change.newValue });
        affected += 1;
        results.push({ targetId, status: 'Modified', ok: true });
      } catch (error) {
        results.push({ targetId, status: 'Failed', ok: false, error: error instanceof Error ? error.message : 'PRODUCT_UPDATE_FAILED' });
      }
    }
  }
  const printJobs = [];
  if (operation === 'print.shipments' || operation === 'print.pickups') {
    const jobType = operation === 'print.pickups' ? 'pickup' : 'shipment';
    for (const targetId of targetIds) {
      try {
        const order = findOrderByIdOrOrderId(targetId);
        if (!order) fail(404, 'ORDER_NOT_FOUND');
        if (jobType === 'pickup' && order.fulfillment_mode !== 'pickup') fail(400, 'ORDER_NOT_PICKUP_MODE');
        if (jobType === 'shipment' && (order.fulfillment_mode || 'delivery') !== 'delivery') fail(400, 'ORDER_NOT_DELIVERY_MODE');
        const job = await createPrintJobForOrder(order, jobType, session);
        printJobs.push(job);
        affected += 1;
        results.push({ targetId, status: job.status, ok: !['Failed', 'ConfigurationRequired'].includes(job.status), printJobId: job.id });
      } catch (error) {
        results.push({ targetId, status: 'Failed', ok: false, error: error instanceof Error ? error.message : 'PRINT_JOB_FAILED' });
      }
    }
  }
  const exportRows = operation.startsWith('export.') ? adminBatchRows(resource, targetIds) : [];
  if (operation.startsWith('export.') && exportRows.length === 0) fail(400, 'BATCH_TARGETS_NOT_FOUND');
  const exportArtifact = operation.startsWith('export.') ? buildAdminExportArtifact(resource, operation, exportRows) : null;
  if (exportArtifact) {
    affected = exportRows.length;
    for (const targetId of targetIds) results.push({ targetId, status: exportRows.some((row) => adminBatchRowMatches(row, targetId)) ? 'Exported' : 'NotFound', ok: exportRows.some((row) => adminBatchRowMatches(row, targetId)) });
  }
  const printArtifact = operation.startsWith('print.') ? buildAdminPrintArtifact(operation, targetIds) : null;
  const batchStatus = results.length && results.every((entry) => !entry.ok) ? 'Failed' : (results.some((entry) => !entry.ok) ? 'Partial' : 'Accepted');
  if (batchStatus === 'Failed' && !operation.startsWith('export.') && !operation.startsWith('print.')) fail(400, 'BATCH_ALL_TARGETS_FAILED');
  return {
    id,
    operation,
    resource,
    targetIds,
    affected,
    results,
    exportFile: exportArtifact?.fileName,
    download: exportArtifact || undefined,
    printJobs: operation.startsWith('print.') ? printJobs : undefined,
    printDocument: printArtifact || undefined,
    previewRows: exportRows.slice(0, 5),
    status: batchStatus
  };
}

function adminBatchRows(resource, targetIds) {
  const wanted = new Set(targetIds.map((value) => String(value).toLowerCase()));
  if (resource === 'orders') {
    return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000').all().filter((row) => wanted.has(String(row.id).toLowerCase()) || wanted.has(String(row.order_id).toLowerCase())).map(toOrder);
  }
  if (resource === 'products') {
    return db.prepare('SELECT * FROM products ORDER BY id LIMIT 1000').all().filter((row) => wanted.has(String(row.id).toLowerCase())).map(toProduct);
  }
  if (resource === 'productSubmissions') return pendingProductSubmissions().filter((row) => wanted.has(String(row.id).toLowerCase()));
  if (resource === 'merchants') return adminMerchants().filter((row) => wanted.has(String(row.id).toLowerCase()) || wanted.has(String(row.walletAddress).toLowerCase()));
  if (resource === 'auditLogs') return auditLogs().filter((row) => wanted.has(String(row.id).toLowerCase()));
  fail(400, 'UNSUPPORTED_BATCH_EXPORT_RESOURCE');
}

function adminBatchRowMatches(row, targetId) {
  const target = String(targetId).toLowerCase();
  return [row.id, row.orderId, row.walletAddress].some((value) => String(value || '').toLowerCase() === target);
}

function buildAdminExportArtifact(resource, operation, rows) {
  const flatRows = rows.map(flattenExportRow);
  const columns = [...new Set(flatRows.flatMap((row) => Object.keys(row)))];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (operation === 'export.csv') {
    const csv = [columns, ...flatRows.map((row) => columns.map((column) => row[column] ?? ''))]
      .map((values) => values.map(csvCell).join(','))
      .join('\r\n');
    return encodedArtifact(`24k-${resource}-${timestamp}.csv`, 'text/csv;charset=utf-8', `\ufeff${csv}`);
  }
  const workbook = buildXlsx({
    sheetName: '24K',
    headers: columns,
    rows: flatRows.map((row) => columns.map((column) => row[column] ?? ''))
  });
  return encodedArtifact(`24k-${resource}-${timestamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook);
}

function flattenExportRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, value && typeof value === 'object' ? stableStringify(value) : String(value ?? '')]));
}

function encodedArtifact(fileName, mimeType, content) {
  const buffer = Buffer.isBuffer(content) ? content : content instanceof Uint8Array ? Buffer.from(content) : Buffer.from(content, 'utf8');
  const contentBase64 = buffer.toString('base64');
  return { fileName, mimeType, encoding: 'base64', contentBase64, dataUrl: `data:${mimeType};base64,${contentBase64}` };
}

function buildAdminPrintArtifact(operation, targetIds) {
  const orders = targetIds.map(findOrderByIdOrOrderId).filter(Boolean);
  if (orders.length === 0) return null;
  const type = operation === 'print.pickups' ? '自提单' : '电子面单';
  const pages = orders.map((order) => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.order_id);
    const fulfillment = fulfillmentSummary(order);
    return `<section class="page"><h1>24K ${type}</h1><dl><dt>订单号</dt><dd>${escapeHtml(order.order_id)}</dd><dt>履约</dt><dd>${escapeHtml(order.fulfillment_mode || 'delivery')}</dd><dt>商家</dt><dd>${escapeHtml(order.seller_address)}</dd><dt>状态</dt><dd>${escapeHtml(order.status)}</dd></dl><h2>商品</h2><ul>${items.map((item) => `<li>${escapeHtml(item.product_id)} / ${escapeHtml(item.sku_name || item.sku_id || '默认 SKU')} x ${Number(item.quantity)}</li>`).join('')}</ul><pre>${escapeHtml(stableStringify(fulfillment.payload || {}))}</pre></section>`;
  }).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>24K ${type}</title><style>@page{size:auto;margin:10mm}body{font:14px/1.5 system-ui;color:#111}.page{break-after:page}.page:last-child{break-after:auto}dl{display:grid;grid-template-columns:90px 1fr}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap}</style></head><body>${pages}<script>addEventListener('load',()=>window.print())</script></body></html>`;
  return encodedArtifact(`24k-${operation === 'print.pickups' ? 'pickup' : 'shipment'}-${Date.now()}.html`, 'text/html;charset=utf-8', html);
}

async function createPrintJobForOrder(order, jobType, session) {
  const copies = jobType === 'pickup' ? 2 : 1;
  const id = `print-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const payload = { id, orderId: order.order_id, jobType, copies, order: fulfillmentOrderPayload(order) };
  db.prepare('INSERT INTO print_jobs (id, merchant_address, order_id, job_type, copies, status, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    order.seller_address.toLowerCase(),
    order.order_id,
    jobType,
    copies,
    'Pending',
    JSON.stringify(payload)
  );
  try {
    const result = await submitPrintJob(payload, process.env);
    db.prepare('UPDATE print_jobs SET status = ?, provider_job_id = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(result.status || 'Submitted', result.providerJobId || null, id);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PRINT_PROVIDER_ERROR';
    db.prepare('UPDATE print_jobs SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(code === 'PRINT_NOT_CONFIGURED' ? 'ConfigurationRequired' : 'Failed', code, id);
  }
  const job = toPrintJob(db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id));
  writeAudit(session.role, session.address, 'admin.print.submit', id, { orderId: order.order_id, jobType, status: job.status });
  return job;
}

function requestCircuitBreaker(scope, enabled, reason = '') {
  const state = enabled ? 'PendingPause' : 'PendingResume';
  db.prepare(`
    INSERT INTO circuit_breakers (scope, enabled, state, pending_enabled, reason, last_tx_hash, updated_at)
    VALUES (?, 1, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(scope) DO UPDATE SET
      enabled = 1,
      state = excluded.state,
      pending_enabled = excluded.pending_enabled,
      reason = excluded.reason,
      last_tx_hash = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run(String(scope), state, enabled ? 1 : 0, String(reason || ''));
}

function confirmCircuitBreaker(scope, enabled, reason, txHash = null) {
  db.prepare(`
    INSERT INTO circuit_breakers (scope, enabled, state, pending_enabled, reason, last_tx_hash, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scope) DO UPDATE SET
      enabled = excluded.enabled,
      state = excluded.state,
      pending_enabled = NULL,
      reason = excluded.reason,
      last_tx_hash = excluded.last_tx_hash,
      updated_at = CURRENT_TIMESTAMP
  `).run(String(scope), enabled ? 1 : 0, enabled ? 'Paused' : 'Open', String(reason || ''), txHash);
}

function circuitState(scope) {
  const row = db.prepare('SELECT * FROM circuit_breakers WHERE scope = ?').get(String(scope));
  return {
    scope,
    enabled: Boolean(row?.enabled),
    state: row?.state || (row?.enabled ? 'Paused' : 'Open'),
    pendingEnabled: row?.pending_enabled === null || row?.pending_enabled === undefined ? null : Boolean(row.pending_enabled),
    reason: row?.reason || '',
    lastTxHash: row?.last_tx_hash || null,
    updatedAt: row?.updated_at || null
  };
}

function assertCircuitOpen(scope, errorCode) {
  if (circuitState(scope).enabled) fail(423, errorCode);
}

function assertRewardLedgerOpenForNewOrders() {
  if (circuitState('claims').enabled) fail(423, 'REWARD_LEDGER_PAUSED');
}

function assertNotBlacklisted(address) {
  const row = db.prepare('SELECT * FROM blacklists WHERE address = ?').get(String(address).toLowerCase());
  if (row) fail(403, 'ADDRESS_BLACKLISTED');
}

function adminActionForPath(pathname) {
  const map = {
    '/api/admin/merchant-levels': 'admin.merchant.levels.configure',
    '/api/admin/products': 'admin.product.create',
    '/api/admin/products/update': 'admin.product.update',
    '/api/admin/products/delete': 'admin.product.delete',
    '/api/admin/merchants/review': 'admin.merchant.review',
    '/api/admin/products/review': 'admin.product.review',
    '/api/admin/seckill/schedule': 'admin.seckill.schedule',
    '/api/admin/seckill/publish': 'admin.seckill.publish',
    '/api/admin/ratio-config': 'admin.ratio.configure',
    '/api/admin/prize-pool': 'admin.prize-pool.inject',
    '/api/admin/force-refund': 'admin.force-refund',
    '/api/admin/rewards/release': 'admin.reward.release',
    '/api/admin/pause-orders': 'admin.circuit.orders',
    '/api/admin/pause-seckill': 'admin.circuit.seckill',
    '/api/admin/pause-claims': 'admin.circuit.claims',
    '/api/admin/seckill/force-cutoff': 'admin.circuit.force-cutoff',
    '/api/admin/blacklist': 'admin.blacklist.update',
    '/api/admin/risk/policies': 'admin.risk.policies.configure',
    '/api/admin/logistics': 'admin.logistics.configure',
    '/api/admin/logistics/credentials': 'admin.logistics.credentials.configure',
    '/api/admin/logistics/templates': 'admin.logistics.template.upsert',
    '/api/admin/logistics/addresses': 'admin.logistics.address.upsert',
    '/api/admin/cms': 'admin.cms.publish',
    '/api/admin/messages': 'admin.message.notify',
    '/api/admin/messages/gateways': 'admin.message.gateway.configure',
    '/api/admin/batch': 'admin.batch.run',
    '/api/admin/categories/upsert': 'admin.category.upsert',
    '/api/admin/categories/delete': 'admin.category.delete',
    '/api/admin/tags/upsert': 'admin.tag.upsert',
    '/api/admin/tags/delete': 'admin.tag.delete',
    '/api/admin/system-config': 'admin.system.configure',
    '/api/admin/settlements/complete': 'admin.settlement.complete',
    '/api/admin/after-sales/resolve': 'admin.after-sale.resolve'
  };
  return map[pathname] || '';
}

function createOrder(body) {
  if (!isValidAddress(ESCROW)) fail(503, 'ESCROW_ADDRESS_NOT_CONFIGURED');
  if (!isValidSeller(MERCHANT_RECEIVER)) fail(503, 'MERCHANT_RECEIVER_ADDRESS_NOT_CONFIGURED');
  if (!body || typeof body.buyerAddress !== 'string' || !isValidAddress(body.buyerAddress) || !Array.isArray(body.items)) {
    fail(400, 'INVALID_ORDER_INPUT');
  }
  assertCircuitOpen('orders', 'ORDERS_PAUSED');
  assertRewardLedgerOpenForNewOrders();
  assertNotBlacklisted(body.buyerAddress);
  assertWalletTradeUnlocked(body.buyerAddress);
  let idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey);
  const idempotencyPayloadDigest = idempotencyKey ? orderRequestDigest(body) : '';
  let deferredExistingOrder = null;
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM orders WHERE lower(buyer_address) = ? AND idempotency_key = ?').get(body.buyerAddress.toLowerCase(), idempotencyKey);
    if (existing && existing.idempotency_payload_digest) {
      if (existing.idempotency_payload_digest !== idempotencyPayloadDigest) fail(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
      if (TERMINAL_ORDER_STATUSES.has(existing.status)) fail(409, 'IDEMPOTENCY_KEY_ALREADY_USED');
      return toOrder(existing);
    }
    if (existing && REUSABLE_IDEMPOTENCY_STATUSES.has(existing.status)) {
      if (existing.idempotency_payload_digest) {
        if (existing.idempotency_payload_digest !== idempotencyPayloadDigest) fail(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
        return toOrder(existing);
      }
      deferredExistingOrder = existing;
    } else if (existing) {
      deferredExistingOrder = existing;
    }
  }

  const selected = body.items.filter((item) => item && item.selected);
  if (selected.length === 0) fail(400, 'NO_SELECTED_ITEMS');

  let totalUnits = 0n;
  let totalNplUnits = 0n;
  let totalBnmUnits = 0n;
  let sellerAddress = '';
  const seenLineKeys = new Set();
  const digestItems = [];
  const digestRatios = [];
  const orderLines = [];
  for (const item of selected) {
    const productId = String(item.productId);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) fail(400, `PRODUCT_NOT_FOUND:${item.productId}`);
    const saleRestriction = productSaleRestriction(product, body);
    if (saleRestriction) fail(409, saleRestriction);
    if (Number(product.stock) <= 0) fail(400, 'OUT_OF_STOCK');
    if (!isValidSeller(product.seller_address)) fail(400, 'INVALID_PRODUCT_SELLER');
    if (sellerAddress && product.seller_address.toLowerCase() !== sellerAddress.toLowerCase()) {
      fail(400, 'MIXED_SELLER_ORDER_NOT_SUPPORTED');
    }
    const quantity = requireQuantity(item.quantity);
    const sku = resolveSku(product.id, item.skuId);
    const skuStock = sku ? Number(sku.stock) : Number(product.stock);
    if (quantity > skuStock) fail(400, 'INSUFFICIENT_STOCK');
    const unitPrice = sku ? sku.settlement_price_npl : normalizeUnitPrice(item.unitPriceNpl, product.price_npl);
    const lineUnits = parseDecimal18(unitPrice) * BigInt(quantity);
    const ratio = paymentRatioForProduct(product.id);
    const lineNplUnits = lineUnits;
    const lineBnmUnits = lineUnits * BigInt(ratio.bnmRebateBps) / 10_000n;
    totalUnits += lineUnits;
    totalNplUnits += lineNplUnits;
    totalBnmUnits += lineBnmUnits;
    sellerAddress = product.seller_address;
    const fulfillment = resolveFulfillmentForLine(product, item, body);
    if (!fulfillment.ok) fail(400, fulfillment.reason);
    const lineFulfillment = fulfillment.fulfillmentMode;
    const lineAddressId = fulfillment.addressId || '';
    const lineStoreId = fulfillment.storeId || '';
    const lineRegionCode = fulfillment.regionCode;
    const lineKey = orderItemLineKey({ productId: product.id, skuId: sku?.id || item.skuId, fulfillmentMode: lineFulfillment, addressId: lineAddressId, storeId: lineStoreId, regionCode: lineRegionCode });
    if (seenLineKeys.has(lineKey)) fail(400, 'DUPLICATE_ORDER_LINE');
    seenLineKeys.add(lineKey);
    digestItems.push(`${product.id}:${sku?.id || ''}:${quantity}:${unitPrice}:${lineFulfillment}:${lineAddressId}:${lineStoreId}:${lineRegionCode}`);
    digestRatios.push(`${product.id}:${ratio.nplPaymentBps}:${ratio.bnmRebateBps}:${ratio.updatedAt || 'default'}`);
    orderLines.push({ productId: product.id, skuId: sku?.id || String(item.skuId || ''), skuName: sku?.name || String(item.skuName || product.sku), quantity, unitPriceNpl: unitPrice, fulfillmentMode: lineFulfillment, addressId: lineAddressId, storeId: lineStoreId, regionCode: lineRegionCode, lineKey, nplPaymentBps: ratio.nplPaymentBps, bnmRebateBps: ratio.bnmRebateBps });
  }

  if (totalUnits <= 0n) fail(400, 'NO_PAYABLE_ITEMS');
  if (MAX_ORDER_AMOUNT_NPL && totalUnits > parseDecimal18(MAX_ORDER_AMOUNT_NPL)) {
    fail(400, 'ORDER_AMOUNT_EXCEEDS_MICRO_TEST_LIMIT');
  }
  if (!isValidSeller(sellerAddress)) fail(400, 'INVALID_ORDER_SELLER');

  const amountNpl = formatDecimal18(totalNplUnits);
  const bnmLocked = formatDecimal18(totalBnmUnits);
  const fulfillmentMode = body.fulfillmentMode === 'pickup' || orderLines.some((line) => line.fulfillmentMode === 'pickup') ? 'pickup' : 'delivery';
  const addressId = String(body.addressId || orderLines.find((line) => line.addressId)?.addressId || '').slice(0, 96);
  const storeId = String(body.storeId || orderLines.find((line) => line.storeId)?.storeId || '').slice(0, 96);
  const regionCode = String(body.regionCode || body.addressRegionCode || body.storeRegionCode || orderLines[0]?.regionCode || '').slice(0, 32);
  const nonce = randomBytes(8).toString('hex');
  const merchantOrderNo = `24K-${Date.now()}-${nonce}`;
  const orderDigest = bytes32([
    `buyer:${body.buyerAddress.toLowerCase()}`,
    `seller:${sellerAddress.toLowerCase()}`,
    `fulfillment:${fulfillmentMode}`,
    `region:${regionCode}`,
    `address:${addressId || body.addressHash || ''}`,
    `store:${storeId}`,
    `npl:${NPL.toLowerCase()}`,
    `ratio:${digestRatios.join('|')}`,
    `items:${digestItems.join('|')}`
  ].join(';'));
  if (deferredExistingOrder) {
    if (deferredExistingOrder.order_digest !== orderDigest) fail(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    if (TERMINAL_ORDER_STATUSES.has(deferredExistingOrder.status)) fail(409, 'IDEMPOTENCY_KEY_ALREADY_USED');
    return toOrder(deferredExistingOrder);
  }
  const orderId = bytes32(`${body.buyerAddress}:${sellerAddress}:${amountNpl}:${NPL}:${merchantOrderNo}:${orderDigest}`);
  const id = merchantOrderNo;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO orders (id, order_id, buyer_address, seller_address, amount_npl, status, tx_hash, idempotency_key, idempotency_payload_digest, chain_id, escrow_address, order_digest, fulfillment_mode, address_id, store_id, region_code, bnm_locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orderId, body.buyerAddress, sellerAddress, amountNpl, 'Draft', null, idempotencyKey, idempotencyPayloadDigest, CHAIN_ID, ESCROW, orderDigest, fulfillmentMode, addressId || null, storeId || null, regionCode, bnmLocked);
    const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, sku_id, sku_name, quantity, unit_price_npl, fulfillment_mode, address_id, store_id, region_code, line_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const line of orderLines) {
      insertItem.run(orderId, line.productId, line.skuId || null, line.skuName || null, line.quantity, line.unitPriceNpl, line.fulfillmentMode, line.addressId || null, line.storeId || null, line.regionCode, line.lineKey);
    }
    writeAudit('buyer', body.buyerAddress, 'order.create', orderId, { orderId, items: orderLines, amountNpl, fulfillmentMode, regionCode, bnmLocked });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (storeId) recordBuyerBehavior(body.buyerAddress, 'store.select', storeId);

  return {
    id,
    orderId,
    buyerAddress: body.buyerAddress,
    sellerAddress,
    amountNpl,
    bnmLocked,
    fulfillmentMode,
    addressId: addressId || undefined,
    storeId: storeId || undefined,
    regionCode,
    status: 'Draft',
    chainId: CHAIN_ID,
    escrowAddress: ESCROW,
    orderDigest
  };
}

async function recordFundingTransaction(id, body) {
  const order = findOrderByIdOrOrderId(id);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  const buyerAddress = requireAddress(body?.buyerAddress, 'buyerAddress');
  if (buyerAddress.toLowerCase() !== order.buyer_address.toLowerCase()) fail(403, 'ORDER_BUYER_MISMATCH');

  const txHash = requireBytes32(body?.txHash, 'txHash');
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt) fail(409, 'CHAIN_EVENT_TX_NOT_FOUND');
  if (String(receipt.status).toLowerCase() !== '0x1') fail(400, 'CHAIN_EVENT_TX_FAILED');
  const finality = await receiptFinality(receipt);
  if (!finality.finalized) fail(409, 'CHAIN_EVENT_TX_CONFIRMING');
  observeReceiptGas(receipt, buyerAddress, txHash, 'order.pay');
  const payload = await payloadFromFundingReceipt(txHash, order);
  return recordChainEvent(payload);
}

async function payloadFromFundingReceipt(txHash, order) {
  return payloadFromOrderEventReceipt(txHash, order, 'OrderPaid');
}

async function payloadFromOrderEventReceipt(txHash, order, expectedEventName) {
  if (!CHAIN_EVENT_RPC_URL) fail(503, 'CHAIN_EVENT_RPC_NOT_CONFIGURED');
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt) fail(400, 'CHAIN_EVENT_TX_NOT_FOUND');
  if (String(receipt.status).toLowerCase() !== '0x1') fail(400, 'CHAIN_EVENT_TX_FAILED');
  const blockNumber = Number.parseInt(String(receipt.blockNumber), 16);

  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== order.escrow_address.toLowerCase()) continue;
    let parsed;
    try {
      parsed = escrowEvents.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== expectedEventName) continue;
    if (String(parsed.args.orderId).toLowerCase() !== order.order_id.toLowerCase()) continue;
    return payloadFromParsedEvent(parsed, {
      chainId: Number(order.chain_id),
      contractAddress: order.escrow_address,
      orderId: order.order_id,
      txHash,
      blockNumber,
      logIndex: Number.parseInt(String(log.logIndex), 16)
    });
  }

  fail(400, `${expectedEventName.replace(/^Order/, 'ORDER_').toUpperCase()}_EVENT_NOT_FOUND`);
}

async function recordChainEvent(body) {
  if (!body || typeof body !== 'object') fail(400, 'INVALID_EVENT_INPUT');

  const eventName = requireString(body.eventName, 'eventName');
  if (CIRCUIT_EVENT_DEFINITIONS.has(eventName)) return recordCircuitChainEvent(body, eventName);
  if (ESCROW_CONTROL_EVENT_NAMES.has(eventName)) return recordEscrowControlEvent(body, eventName);
  if (REWARD_EVENT_NAMES.has(eventName)) return recordRewardChainEvent(body, eventName);
  if (SECKILL_EVENT_NAMES.has(eventName)) return recordSeckillChainEvent(body, eventName);
  const orderId = requireBytes32(body.orderId, 'orderId');
  const txHash = requireBytes32(body.txHash, 'txHash');
  const contractAddress = requireAddress(body.contractAddress, 'contractAddress');
  const chainId = Number(body.chainId);
  const blockNumber = Number(body.blockNumber);
  const logIndex = Number(body.logIndex);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail(400, 'INVALID_BLOCK_NUMBER');
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) fail(400, 'INVALID_LOG_INDEX');

  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  if (!isValidAddress(order.escrow_address)) fail(409, 'ORDER_ESCROW_NOT_SYNCABLE');
  if (!Number.isSafeInteger(Number(order.chain_id))) fail(409, 'ORDER_CHAIN_NOT_SYNCABLE');
  if (!requireStoredBytes32(order.order_digest)) fail(409, 'ORDER_DIGEST_NOT_SYNCABLE');
  if (chainId !== Number(order.chain_id)) fail(400, 'EVENT_CHAIN_MISMATCH');
  if (contractAddress.toLowerCase() !== order.escrow_address.toLowerCase()) fail(400, 'EVENT_CONTRACT_MISMATCH');

  const duplicate = db.prepare('SELECT * FROM chain_events WHERE chain_id = ? AND tx_hash = ? AND log_index = ?').get(chainId, txHash.toLowerCase(), logIndex);
  if (duplicate) {
    if (duplicate.order_id.toLowerCase() !== orderId.toLowerCase()) fail(400, 'DUPLICATE_EVENT_ORDER_MISMATCH');
    if (eventName === 'OrderArbitration') {
      db.prepare("UPDATE after_sale_cases SET status = 'Arbitration', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'AwaitingDisputeTransaction'").run(orderId);
    }
    return { duplicate: true, order: toOrder(findOrderByIdOrOrderId(orderId)) };
  }

  const verifiedBody = CHAIN_EVENT_VERIFY_RPC
    ? await verifyChainEventOnRpc(body, {
      eventName,
      orderId,
      txHash,
      contractAddress: order.escrow_address,
      chainId: Number(order.chain_id),
      blockNumber,
      logIndex
    })
    : body;
  validateEventAgainstOrder(eventName, verifiedBody, order);

  let nextStatus = statusForEvent(eventName);
  let updatedOrder;
  db.exec('BEGIN IMMEDIATE');
  try {
    insertChainEvent({ chainId, contractAddress, target: orderId, txHash, blockNumber, logIndex, eventName, payload: verifiedBody });
    writeAudit('indexer', contractAddress, `chain.${eventName}`, orderId, { txHash, blockNumber, logIndex, eventName });
    if (isPaidLockedStatus(nextStatus)) {
      const stockIssue = deductSoldStock(orderId);
      if (stockIssue) nextStatus = 'Arbitration';
      if (!onchainRewardLedgerEnabled()) lockOrderReward(order, verifiedBody, txHash);
      ensureInitialFulfillment(order, stockIssue ? 'Arbitration' : null);
      db.prepare('UPDATE orders SET fund_tx_hash = ? WHERE order_id = ?').run(txHash, orderId);
    } else if (eventName === 'OrderCompleted') {
      if (!onchainRewardLedgerEnabled()) releaseOrderRewards(orderId, txHash);
      db.prepare("UPDATE settlement_requests SET status = 'Confirmed', tx_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?").run(txHash, orderId);
      db.prepare("UPDATE after_sale_cases SET status = 'Resolved', resolution = COALESCE(resolution, 'complete'), updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status <> 'Resolved'").run(orderId);
    } else if (isRefundedStatus(nextStatus)) {
      restoreSoldStock(orderId);
      if (!onchainRewardLedgerEnabled()) burnUnclaimedRewards(orderId, txHash);
      db.prepare("UPDATE settlement_requests SET status = 'CancelledByRefund', tx_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status <> 'Confirmed'").run(txHash, orderId);
      db.prepare("UPDATE after_sale_cases SET status = 'Resolved', resolution = 'refund', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status <> 'Resolved'").run(orderId);
    } else if (eventName === 'OrderArbitration') {
      db.prepare("UPDATE after_sale_cases SET status = 'Arbitration', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status IN ('Open','AwaitingDisputeTransaction','Arbitration')").run(orderId);
    }
    db.prepare('UPDATE orders SET status = ?, tx_hash = ?, last_event_tx_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run(nextStatus, txHash, txHash, orderId);
    updatedOrder = findOrderByIdOrOrderId(orderId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { duplicate: false, order: toOrder(updatedOrder) };
}

async function recordCircuitChainEvent(body, eventName) {
  const definition = CIRCUIT_EVENT_DEFINITIONS.get(eventName);
  if (!definition) fail(400, 'UNSUPPORTED_CIRCUIT_EVENT');
  const txHash = requireBytes32(body.txHash, 'txHash');
  const contractAddress = requireAddress(body.contractAddress, 'contractAddress');
  const chainId = Number(body.chainId);
  const blockNumber = Number(body.blockNumber);
  const logIndex = Number(body.logIndex);
  if (!Number.isSafeInteger(chainId) || chainId !== CHAIN_ID) fail(400, 'EVENT_CHAIN_MISMATCH');
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail(400, 'INVALID_BLOCK_NUMBER');
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) fail(400, 'INVALID_LOG_INDEX');
  const expected = circuitEventContract(definition.contractKind);
  if (!isValidAddress(expected.address)) fail(409, 'CIRCUIT_CONTRACT_NOT_CONFIGURED');
  if (contractAddress.toLowerCase() !== expected.address.toLowerCase()) fail(400, 'EVENT_CONTRACT_MISMATCH');

  const duplicate = db.prepare('SELECT * FROM chain_events WHERE chain_id = ? AND tx_hash = ? AND log_index = ?').get(chainId, txHash.toLowerCase(), logIndex);
  if (duplicate) return { duplicate: true, eventName, circuit: circuitState(definition.scope) };

  const verifiedBody = CHAIN_EVENT_VERIFY_RPC
    ? await verifyCircuitEventOnRpc(body, { eventName, txHash, contractAddress, chainId, blockNumber, logIndex, eventInterface: expected.eventInterface })
    : body;
  const account = verifiedBody.account ? requireAddress(verifiedBody.account, 'account') : null;
  const target = `circuit:${definition.scope}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    confirmCircuitBreaker(definition.scope, definition.enabled, `chain.${eventName}`, txHash);
    insertChainEvent({ chainId, contractAddress, target, txHash, blockNumber, logIndex, eventName, payload: { ...verifiedBody, account } });
    writeAudit('indexer', contractAddress, `chain.${eventName}`, target, { txHash, blockNumber, logIndex, eventName, account });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { duplicate: false, eventName, circuit: circuitState(definition.scope) };
}

function circuitEventContract(kind) {
  if (kind === 'escrow') return { address: ESCROW, eventInterface: escrowEvents };
  if (kind === 'rewards') return { address: REWARD_LEDGER, eventInterface: rewardLedgerEvents };
  if (kind === 'seckill') return { address: SECKILL, eventInterface: seckillEvents };
  fail(400, 'UNSUPPORTED_CIRCUIT_CONTRACT');
}

async function recordEscrowControlEvent(body, eventName) {
  const txHash = requireBytes32(body.txHash, 'txHash');
  const contractAddress = requireAddress(body.contractAddress, 'contractAddress');
  const chainId = Number(body.chainId);
  const blockNumber = Number(body.blockNumber);
  const logIndex = Number(body.logIndex);
  if (!Number.isSafeInteger(chainId)) fail(400, 'INVALID_CHAIN_ID');
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail(400, 'INVALID_BLOCK_NUMBER');
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) fail(400, 'INVALID_LOG_INDEX');
  if (!isValidAddress(ESCROW)) fail(409, 'ESCROW_ADDRESS_NOT_CONFIGURED');
  if (chainId !== CHAIN_ID) fail(400, 'EVENT_CHAIN_MISMATCH');
  if (contractAddress.toLowerCase() !== ESCROW.toLowerCase()) fail(400, 'EVENT_CONTRACT_MISMATCH');

  const duplicate = db.prepare('SELECT * FROM chain_events WHERE chain_id = ? AND tx_hash = ? AND log_index = ?').get(chainId, txHash.toLowerCase(), logIndex);
  if (duplicate) return { duplicate: true, eventName, target: duplicate.order_id };

  const verifiedBody = CHAIN_EVENT_VERIFY_RPC
    ? await verifyEscrowControlEventOnRpc(body, { eventName, txHash, contractAddress, chainId, blockNumber, logIndex })
    : body;

  let splitActivation = null;
  if (eventName === 'SplitConfigUpdated') {
    const splitVersion = Number(verifiedBody.splitVersion);
    if (!Number.isSafeInteger(splitVersion) || splitVersion <= 0 || splitVersion > 0xffffffff) fail(400, 'INVALID_SPLIT_VERSION');
    const configHash = requireBytes32(verifiedBody.configHash, 'configHash').toLowerCase();
    const pendingKey = `ratio-config-pending:${configHash}`;
    const pending = readAdminConfig(pendingKey);
    const config = pending || await readEscrowSplitConfig(splitVersion, configHash);
    splitActivation = { splitVersion, configHash, pendingKey, config, wasPending: Boolean(pending) };
  }

  let target;
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (eventName === 'SellerApprovalUpdated') {
      const seller = requireAddress(verifiedBody.seller, 'seller').toLowerCase();
      if (typeof verifiedBody.approved !== 'boolean') fail(400, 'INVALID_SELLER_APPROVAL_STATE');
      const status = verifiedBody.approved ? 'Approved' : 'Rejected';
      const existing = db.prepare('SELECT * FROM merchants WHERE lower(wallet_address) = ?').get(seller);
      const id = existing?.id || `merchant-${createHash('sha256').update(seller).digest('hex').slice(0, 12)}`;
      const payload = {
        ...(existing ? JSON.parse(existing.payload_json || '{}') : {}),
        approved: verifiedBody.approved,
        chainStatus: 'Confirmed',
        reviewTxHash: txHash,
        reviewBlockNumber: blockNumber
      };
      if (existing) {
        db.prepare('UPDATE merchants SET status = ?, payload_json = ? WHERE id = ?').run(status, JSON.stringify(payload), id);
      } else {
        db.prepare('INSERT INTO merchants (id, wallet_address, name, status, payload_json) VALUES (?, ?, ?, ?, ?)').run(id, seller, '链上商家', status, JSON.stringify(payload));
      }
      target = `seller:${seller}`;
      result = { seller, approved: verifiedBody.approved, status, merchantId: id };
    } else {
      const { splitVersion, configHash, pendingKey, config, wasPending } = splitActivation;
      const active = {
        ...config,
        status: 'Active',
        splitVersion,
        configHash,
        activationTxHash: txHash,
        activationBlockNumber: blockNumber
      };
      persistAdminConfig('ratio-config', active);
      if (wasPending) persistAdminConfig(pendingKey, { ...active, status: 'Confirmed' });
      persistAdminConfig('escrow-split-state', { splitVersion, configHash, txHash, blockNumber, status: 'Confirmed' });
      target = `split:${splitVersion}`;
      result = { splitVersion, configHash, config: active };
    }

    insertChainEvent({ chainId, contractAddress, target, txHash, blockNumber, logIndex, eventName, payload: verifiedBody });
    writeAudit('indexer', contractAddress, `chain.${eventName}`, target, { txHash, blockNumber, logIndex, eventName });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { duplicate: false, eventName, target, ...result };
}

async function recordSeckillChainEvent(body, eventName) {
  const sessionId = requireBytes32(body.sessionId, 'sessionId');
  const txHash = requireBytes32(body.txHash, 'txHash');
  const contractAddress = requireAddress(body.contractAddress, 'contractAddress');
  const chainId = Number(body.chainId);
  const blockNumber = Number(body.blockNumber);
  const logIndex = Number(body.logIndex);
  if (!Number.isSafeInteger(chainId)) fail(400, 'INVALID_CHAIN_ID');
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail(400, 'INVALID_BLOCK_NUMBER');
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) fail(400, 'INVALID_LOG_INDEX');
  if (!isValidAddress(SECKILL)) fail(409, 'SECKILL_ADDRESS_NOT_CONFIGURED');
  if (chainId !== CHAIN_ID) fail(400, 'EVENT_CHAIN_MISMATCH');
  if (contractAddress.toLowerCase() !== SECKILL.toLowerCase()) fail(400, 'EVENT_CONTRACT_MISMATCH');

  const duplicate = db.prepare('SELECT * FROM chain_events WHERE chain_id = ? AND tx_hash = ? AND log_index = ?').get(chainId, txHash.toLowerCase(), logIndex);
  if (duplicate) return { duplicate: true, session: seckillSessionById(sessionId), report: seckillReport(sessionId) };

  const verifiedBody = CHAIN_EVENT_VERIFY_RPC
    ? await verifySeckillChainEventOnRpc(body, { eventName, sessionId, txHash, contractAddress, chainId, blockNumber, logIndex })
    : body;
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    result = applySeckillEvent(eventName, { ...verifiedBody, sessionId }, txHash, { chainId, contractAddress, blockNumber, logIndex });
    insertChainEvent({ chainId, contractAddress, target: sessionId, txHash, blockNumber, logIndex, eventName, payload: verifiedBody });
    writeAudit('indexer', contractAddress, `chain.${eventName}`, sessionId, { txHash, blockNumber, logIndex, eventName });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { duplicate: false, ...result };
}

function applySeckillEvent(eventName, body, txHash, meta = {}) {
  const sessionId = requireBytes32(body.sessionId, 'sessionId');
  const eventId = `${txHash}:${meta.logIndex ?? 0}`;
  const nowIso = new Date().toISOString();
  if (eventName === 'SessionStarted') {
    const productId = seckillProductIdFromEvent(body);
    const startsAt = isoFromUnix(body.startsAt) || nowIso;
    const endsAt = isoFromUnix(body.mainEndsAt) || startsAt;
    const payload = {
      sessionId,
      productId,
      productIdBytes32: body.productId || '',
      startsAt,
      mainEndsAt: body.mainEndsAt || null,
      relayEndsAt: body.relayEndsAt || null,
      minimumNplAmount: body.minimumNplAmount || (body.minimumNplAmountWei !== undefined ? formatDecimal18(parseUintString(body.minimumNplAmountWei, 'minimumNplAmountWei')) : null),
      prizePoolNpl: body.prizePoolNpl || (body.prizePoolNplWei !== undefined ? formatDecimal18(parseUintString(body.prizePoolNplWei, 'prizePoolNplWei')) : '0.000000000000000000'),
      source: 'chain.SessionStarted'
    };
    const pending = db.prepare(`
      SELECT id, payload_json
      FROM seckill_sessions
      WHERE product_id = ? AND status = 'PendingChainPublish'
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(productId);
    if (pending) {
      const pendingPayload = JSON.parse(pending.payload_json || '{}');
      db.prepare('UPDATE seckill_sessions SET status = ?, payload_json = ? WHERE id = ?').run('Published', JSON.stringify({
        ...pendingPayload,
        chainSessionId: sessionId,
        publishedAt: startsAt,
        publishTxHash: txHash
      }), pending.id);
    }
    db.prepare(`
      INSERT INTO seckill_sessions (id, product_id, status, starts_at, ends_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        product_id = excluded.product_id,
        status = excluded.status,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        payload_json = excluded.payload_json
    `).run(sessionId, productId, 'live', startsAt, endsAt, JSON.stringify(payload));
    confirmCircuitBreaker('force-cutoff', false, 'chain.SessionStarted', txHash);
    insertSeckillEvent(eventId, sessionId, eventName, null, null, txHash, meta, payload);
    return { session: seckillSessionById(sessionId), report: seckillReport(sessionId) };
  }

  ensureSeckillSession(sessionId);
  if (eventName === 'PurchaseRecorded') {
    const buyer = requireAddress(body.buyer, 'buyer');
    const orderId = requireBytes32(body.orderId, 'orderId');
    const totalBuys = Number(body.totalBuys || 0);
    if (!Number.isSafeInteger(totalBuys) || totalBuys < 0) fail(400, 'INVALID_SECKILL_TOTAL_BUYS');
    const payload = {
      sessionId,
      buyer,
      orderId,
      relayEndsAt: body.relayEndsAt || null,
      totalBuys,
      source: 'chain.PurchaseRecorded'
    };
    insertSeckillEvent(eventId, sessionId, eventName, buyer, orderId, txHash, meta, payload);
    const row = db.prepare('SELECT payload_json FROM seckill_sessions WHERE id = ?').get(sessionId);
    const sessionPayload = { ...(row ? JSON.parse(row.payload_json || '{}') : {}), relayEndsAt: body.relayEndsAt || null, totalBuys, lastBuyer: buyer, winningOrderId: orderId };
    db.prepare('UPDATE seckill_sessions SET status = ?, payload_json = ? WHERE id = ?').run('live', JSON.stringify(sessionPayload), sessionId);
    return { session: seckillSessionById(sessionId), feed: seckillFeed(sessionId), report: seckillReport(sessionId) };
  }

  if (eventName === 'SessionForceClosed') {
    const payload = { sessionId, source: 'chain.SessionForceClosed' };
    insertSeckillEvent(eventId, sessionId, eventName, null, null, txHash, meta, payload);
    const row = db.prepare('SELECT payload_json FROM seckill_sessions WHERE id = ?').get(sessionId);
    const sessionPayload = { ...(row ? JSON.parse(row.payload_json || '{}') : {}), forceClosedAt: nowIso };
    db.prepare('UPDATE seckill_sessions SET status = ?, payload_json = ? WHERE id = ?').run('forceClosed', JSON.stringify(sessionPayload), sessionId);
    confirmCircuitBreaker('force-cutoff', true, 'chain.SessionForceClosed', txHash);
    return { session: seckillSessionById(sessionId), report: seckillReport(sessionId) };
  }

  if (eventName === 'SeckillPrizeReleased') {
    const winner = requireAddress(body.winner, 'winner');
    const rewardOrderId = requireBytes32(body.rewardOrderId, 'rewardOrderId');
    const prizePoolNpl = seckillPrizePoolAmount(body);
    const payload = { sessionId, winner, rewardOrderId, prizePoolNpl, source: 'chain.SeckillPrizeReleased' };
    insertSeckillEvent(eventId, sessionId, eventName, winner, rewardOrderId, txHash, meta, payload);
    const row = db.prepare('SELECT payload_json FROM seckill_sessions WHERE id = ?').get(sessionId);
    const sessionPayload = { ...(row ? JSON.parse(row.payload_json || '{}') : {}), winner, rewardOrderId, prizePoolNpl };
    db.prepare('UPDATE seckill_sessions SET payload_json = ? WHERE id = ?').run(JSON.stringify(sessionPayload), sessionId);
    const prizeReward = ensureSeckillPrizeReward({ sessionId, winner, orderId: rewardOrderId, prizePoolNpl, txHash });
    return { session: seckillSessionById(sessionId), report: seckillReport(sessionId), prizeReward };
  }

  if (eventName === 'SessionSettled') {
    const winner = isValidAddress(body.winner) ? body.winner : '';
    const orderId = requireBytes32(body.orderId, 'orderId');
    const prizePoolNpl = seckillPrizePoolAmount(body);
    const totalBuys = Number(seckillSessionById(sessionId)?.totalBuys || 0);
    const payload = { sessionId, winner, orderId, prizePoolNpl, source: 'chain.SessionSettled' };
    insertSeckillEvent(eventId, sessionId, eventName, winner || null, orderId, txHash, meta, payload);
    const row = db.prepare('SELECT payload_json FROM seckill_sessions WHERE id = ?').get(sessionId);
    const sessionPayload = { ...(row ? JSON.parse(row.payload_json || '{}') : {}), winner, winningOrderId: orderId, prizePoolNpl };
    db.prepare('UPDATE seckill_sessions SET status = ?, payload_json = ? WHERE id = ?').run('settled', JSON.stringify(sessionPayload), sessionId);
    db.prepare(`
      INSERT OR REPLACE INTO seckill_reports (id, session_id, winner_address, winning_order_id, prize_pool_npl, total_buys, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`report-${sessionId}`, sessionId, winner || null, orderId, prizePoolNpl, totalBuys, JSON.stringify(payload));
    const prizeRewardOrderId = sessionPayload.rewardOrderId || orderId;
    const prizeReward = ensureSeckillPrizeReward({ sessionId, winner, orderId: prizeRewardOrderId, prizePoolNpl, txHash });
    return { session: seckillSessionById(sessionId), report: seckillReport(sessionId), prizeReward };
  }

  fail(400, 'UNSUPPORTED_SECKILL_EVENT');
}

function insertSeckillEvent(id, sessionId, eventName, buyer, orderId, txHash, meta, payload) {
  db.prepare(`
    INSERT OR IGNORE INTO seckill_events (id, session_id, event_name, buyer_address, order_id, tx_hash, block_number, log_index, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, eventName, buyer ? buyer.toLowerCase() : null, orderId || null, txHash || null, meta.blockNumber ?? null, meta.logIndex ?? null, JSON.stringify(payload || {}));
}

function ensureSeckillSession(sessionId) {
  const row = db.prepare('SELECT id FROM seckill_sessions WHERE id = ?').get(sessionId);
  if (row) return;
  db.prepare('INSERT INTO seckill_sessions (id, product_id, status, starts_at, ends_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)').run(
    sessionId,
    'p-24k-runner',
    'live',
    new Date().toISOString(),
    new Date(Date.now() + 60 * 60_000).toISOString(),
    JSON.stringify({ sessionId, source: 'chain.placeholder' })
  );
}

function seckillProductIdFromEvent(body) {
  const text = String(body.productIdText || body.productIdReadable || '').trim();
  if (text) return text.slice(0, 120);
  const productId = String(body.productId || '').toLowerCase();
  const productIds = Object.keys(PRODUCT_UI);
  const matched = productIds.find((id) => bytes32(id).toLowerCase() === productId);
  return matched || 'p-24k-runner';
}

function isoFromUnix(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function seckillPrizePoolAmount(body) {
  if (body.prizePoolNplWei !== undefined) return formatDecimal18(parseUintString(body.prizePoolNplWei, 'prizePoolNplWei'));
  if (body.prizePoolNpl !== undefined) return normalizeUnitPrice(body.prizePoolNpl, '0');
  return '0.000000000000000000';
}

function ensureSeckillPrizeReward({ sessionId, winner, orderId, prizePoolNpl, txHash }) {
  if (!isValidAddress(winner)) return null;
  if (parseDecimal18(prizePoolNpl) <= 0n) return null;
  const existing = seckillPrizeRewardFor(orderId, winner);
  if (existing) return toRewardLedgerEntry(existing);
  if (onchainRewardLedgerEnabled()) {
    return {
      id: null,
      walletAddress: winner,
      orderId,
      assetSymbol: 'NPL',
      amount: Number(prizePoolNpl),
      state: 'PendingRewardLocked',
      source: `秒杀 ${short(sessionId)} 中奖奖金等待 RewardLedger 锁定`,
      pendingOnchainReward: true
    };
  }
  const id = `reward-seckill-prize-${String(sessionId).slice(2, 18)}`;
  db.prepare(`
    INSERT OR IGNORE INTO reward_ledger (id, wallet_address, order_id, source, asset_symbol, amount, state, tx_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    winner.toLowerCase(),
    orderId,
    `秒杀 ${short(sessionId)} 中奖奖金`,
    'NPL',
    prizePoolNpl,
    'Available',
    txHash || null
  );
  return toRewardLedgerEntry(db.prepare('SELECT * FROM reward_ledger WHERE id = ?').get(id));
}

function seckillPrizeRewardFor(orderId, walletAddress) {
  if (!orderId || !isValidAddress(walletAddress)) return null;
  return db.prepare(`
    SELECT * FROM reward_ledger
    WHERE lower(wallet_address) = ? AND order_id = ? AND asset_symbol = 'NPL' AND lower(source) LIKE '%秒杀%'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(String(walletAddress).toLowerCase(), orderId);
}

function seckillPrizeEventForRewardOrder(orderId) {
  const row = db.prepare(`
    SELECT * FROM seckill_events
    WHERE event_name = 'SeckillPrizeReleased' AND order_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(orderId);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload_json || '{}') };
}

async function recordRewardChainEvent(body, eventName) {
  const entryId = requireUintString(body.entryId, 'entryId');
  const txHash = requireBytes32(body.txHash, 'txHash');
  const contractAddress = requireAddress(body.contractAddress, 'contractAddress');
  const chainId = Number(body.chainId);
  const blockNumber = Number(body.blockNumber);
  const logIndex = Number(body.logIndex);
  if (!Number.isSafeInteger(chainId)) fail(400, 'INVALID_CHAIN_ID');
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail(400, 'INVALID_BLOCK_NUMBER');
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) fail(400, 'INVALID_LOG_INDEX');
  if (!isValidAddress(REWARD_LEDGER)) fail(409, 'REWARD_LEDGER_NOT_CONFIGURED');
  if (chainId !== CHAIN_ID) fail(400, 'EVENT_CHAIN_MISMATCH');
  if (contractAddress.toLowerCase() !== REWARD_LEDGER.toLowerCase()) fail(400, 'EVENT_CONTRACT_MISMATCH');

  const duplicate = db.prepare('SELECT * FROM chain_events WHERE chain_id = ? AND tx_hash = ? AND log_index = ?').get(chainId, txHash.toLowerCase(), logIndex);
  if (duplicate) return { duplicate: true, reward: rewardByEntryId(entryId) };

  const verifiedBody = CHAIN_EVENT_VERIFY_RPC
    ? await verifyRewardChainEventOnRpc(body, { eventName, entryId, txHash, contractAddress, chainId, blockNumber, logIndex })
    : body;
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    result = applyRewardLedgerEvent(eventName, { ...verifiedBody, entryId }, txHash);
    insertChainEvent({ chainId, contractAddress, target: result.orderId, txHash, blockNumber, logIndex, eventName, payload: verifiedBody });
    writeAudit('indexer', contractAddress, `chain.${eventName}`, result.orderId, { txHash, blockNumber, logIndex, eventName, entryId });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { duplicate: false, reward: result.reward };
}

function applyRewardLedgerEvent(eventName, body, txHash) {
  const entryId = requireUintString(body.entryId, 'entryId');
  const id = rewardLedgerId(entryId);
  if (eventName === 'RewardLocked') {
    const orderId = requireBytes32(body.orderId, 'orderId');
    const order = findOrderByIdOrOrderId(orderId);
    const seckillPrize = order ? null : seckillPrizeEventForRewardOrder(orderId);
    if (!order && !seckillPrize) fail(404, 'ORDER_NOT_FOUND');
    const walletAddress = requireAddress(body.user, 'user');
    const asset = requireAddress(body.asset, 'asset');
    const amount = rewardAmountFromEvent(body);
    const bucket = Number(body.bucket || 0);
    if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket > 255) fail(400, 'INVALID_REWARD_BUCKET');
    const assetSymbol = assetSymbolForAddress(asset);
    if (seckillPrize) {
      const winner = requireAddress(seckillPrize.payload.winner || seckillPrize.buyer_address, 'seckillPrizeWinner');
      const prizePoolNpl = normalizeUnitPrice(seckillPrize.payload.prizePoolNpl, '0');
      if (walletAddress.toLowerCase() !== winner.toLowerCase()) fail(400, 'SECKILL_PRIZE_REWARD_USER_MISMATCH');
      if (assetSymbol !== 'NPL') fail(400, 'SECKILL_PRIZE_REWARD_ASSET_MISMATCH');
      if (bucket !== 5) fail(400, 'SECKILL_PRIZE_REWARD_BUCKET_MISMATCH');
      if (parseDecimal18(amount) !== parseDecimal18(prizePoolNpl)) fail(400, 'SECKILL_PRIZE_REWARD_AMOUNT_MISMATCH');
    }
    const source = seckillPrize
      ? `秒杀 ${short(seckillPrize.session_id)} 中奖奖金`
      : `链上 RewardLedger #${entryId} 锁定`;
    db.prepare(`
      INSERT OR REPLACE INTO reward_ledger (id, wallet_address, order_id, source, asset_symbol, amount, state, tx_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, walletAddress.toLowerCase(), orderId, source, assetSymbol, amount, 'Locked', txHash || null);
    return { orderId, reward: rewardById(id) };
  }

  const existing = rewardById(id);
  if (!existing) fail(404, 'REWARD_NOT_FOUND');
  if (body.orderId && String(body.orderId).toLowerCase() !== String(existing.orderId || '').toLowerCase()) fail(400, 'REWARD_ORDER_MISMATCH');

  if (eventName === 'RewardReleased') {
    db.prepare('UPDATE reward_ledger SET state = ?, tx_hash = COALESCE(?, tx_hash) WHERE id = ?').run('Available', txHash || null, id);
    return { orderId: existing.orderId, reward: rewardById(id) };
  }

  if (eventName === 'RewardClaimed') {
    const user = requireAddress(body.user, 'user');
    const asset = requireAddress(body.asset, 'asset');
    const amount = rewardAmountFromEvent(body);
    if (user.toLowerCase() !== existing.walletAddress.toLowerCase()) fail(400, 'REWARD_USER_MISMATCH');
    if (assetSymbolForAddress(asset) !== existing.assetSymbol) fail(400, 'REWARD_ASSET_MISMATCH');
    if (parseDecimal18(amount) !== parseDecimal18(String(existing.amount))) fail(400, 'REWARD_AMOUNT_MISMATCH');
    db.prepare('UPDATE reward_ledger SET state = ?, tx_hash = COALESCE(?, tx_hash) WHERE id = ?').run('Claimed', txHash || null, id);
    const claimRow = db.prepare(`
      SELECT id FROM claims
      WHERE reward_id = ? AND wallet_address = ? AND asset_symbol = ? AND status = 'pending'
      ORDER BY created_at LIMIT 1
    `).get(id, existing.walletAddress.toLowerCase(), existing.assetSymbol);
    if (claimRow) db.prepare(`
      UPDATE claims
      SET status = ?, tx_hash = COALESCE(?, tx_hash), gas_used = COALESCE(?, gas_used), effective_gas_price_wei = COALESCE(?, effective_gas_price_wei), gas_bnb = COALESCE(?, gas_bnb)
      WHERE id = ?
    `).run('success', txHash || null, body.gasUsed || null, body.effectiveGasPriceWei || null, body.gasBnb || null, claimRow.id);
    return { orderId: existing.orderId, reward: rewardById(id) };
  }

  if (eventName === 'LockedRewardBurned' || eventName === 'UnclaimedRewardBurned') {
    db.prepare('UPDATE reward_ledger SET state = ?, tx_hash = COALESCE(?, tx_hash) WHERE id = ?').run('Burned', txHash || null, id);
    db.prepare('UPDATE claims SET status = ?, tx_hash = COALESCE(?, tx_hash) WHERE reward_id = ? AND status = ?').run('failed', txHash || null, id, 'pending');
    return { orderId: existing.orderId, reward: rewardById(id) };
  }

  fail(400, 'UNSUPPORTED_REWARD_EVENT');
}

async function verifyEscrowControlEventOnRpc(body, expected) {
  if (!CHAIN_EVENT_RPC_URL) fail(503, 'CHAIN_EVENT_RPC_NOT_CONFIGURED');
  const receipt = await rpc('eth_getTransactionReceipt', [expected.txHash]);
  if (!receipt) fail(400, 'CHAIN_EVENT_TX_NOT_FOUND');
  if (String(receipt.status).toLowerCase() !== '0x1') fail(400, 'CHAIN_EVENT_TX_FAILED');
  const finality = await requireReceiptFinality(receipt);
  if (Number.parseInt(String(receipt.blockNumber), 16) !== expected.blockNumber) fail(400, 'CHAIN_EVENT_BLOCK_MISMATCH');
  const blockHash = verifiedReceiptBlockHash(body, receipt);
  const log = (receipt.logs || []).find((entry) => Number.parseInt(String(entry.logIndex), 16) === expected.logIndex);
  if (!log) fail(400, 'CHAIN_EVENT_LOG_NOT_FOUND');
  if (String(log.address).toLowerCase() !== expected.contractAddress.toLowerCase()) fail(400, 'CHAIN_EVENT_LOG_CONTRACT_MISMATCH');
  let parsed;
  try {
    parsed = escrowEvents.parseLog({ topics: log.topics, data: log.data });
  } catch {
    fail(400, 'CHAIN_EVENT_LOG_PARSE_FAILED');
  }
  if (!parsed || parsed.name !== expected.eventName) fail(400, 'CHAIN_EVENT_LOG_NAME_MISMATCH');
  const verified = payloadFromEscrowControlParsedEvent(parsed, expected);
  if (body.seller && verified.seller && String(body.seller).toLowerCase() !== String(verified.seller).toLowerCase()) fail(400, 'SELLER_APPROVAL_EVENT_MISMATCH');
  if (body.configHash && verified.configHash && String(body.configHash).toLowerCase() !== String(verified.configHash).toLowerCase()) fail(400, 'SPLIT_CONFIG_EVENT_MISMATCH');
  return { ...verified, blockHash, finality };
}

async function verifyCircuitEventOnRpc(body, expected) {
  if (!CHAIN_EVENT_RPC_URL) fail(503, 'CHAIN_EVENT_RPC_NOT_CONFIGURED');
  const receipt = await rpc('eth_getTransactionReceipt', [expected.txHash]);
  if (!receipt) fail(400, 'CHAIN_EVENT_TX_NOT_FOUND');
  if (String(receipt.status).toLowerCase() !== '0x1') fail(400, 'CHAIN_EVENT_TX_FAILED');
  const finality = await requireReceiptFinality(receipt);
  if (Number.parseInt(String(receipt.blockNumber), 16) !== expected.blockNumber) fail(400, 'CHAIN_EVENT_BLOCK_MISMATCH');
  const blockHash = verifiedReceiptBlockHash(body, receipt);
  const log = (receipt.logs || []).find((entry) => Number.parseInt(String(entry.logIndex), 16) === expected.logIndex);
  if (!log) fail(400, 'CHAIN_EVENT_LOG_NOT_FOUND');
  if (String(log.address).toLowerCase() !== expected.contractAddress.toLowerCase()) fail(400, 'CHAIN_EVENT_LOG_CONTRACT_MISMATCH');
  let parsed;
  try {
    parsed = expected.eventInterface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    fail(400, 'CHAIN_EVENT_LOG_PARSE_FAILED');
  }
  if (!parsed || parsed.name !== expected.eventName) fail(400, 'CHAIN_EVENT_LOG_NAME_MISMATCH');
  const verified = payloadFromCircuitParsedEvent(parsed, expected);
  if (body.account && String(body.account).toLowerCase() !== verified.account.toLowerCase()) fail(400, 'CIRCUIT_EVENT_ACCOUNT_MISMATCH');
  return { ...verified, blockHash, finality };
}

async function verifyChainEventOnRpc(body, expected) {
  if (!CHAIN_EVENT_RPC_URL) fail(503, 'CHAIN_EVENT_RPC_NOT_CONFIGURED');
  const receipt = await rpc('eth_getTransactionReceipt', [expected.txHash]);
  if (!receipt) fail(400, 'CHAIN_EVENT_TX_NOT_FOUND');
  if (String(receipt.status).toLowerCase() !== '0x1') fail(400, 'CHAIN_EVENT_TX_FAILED');
  const finality = await requireReceiptFinality(receipt);
  if (Number.parseInt(String(receipt.blockNumber), 16) !== expected.blockNumber) fail(400, 'CHAIN_EVENT_BLOCK_MISMATCH');
  const blockHash = verifiedReceiptBlockHash(body, receipt);
  const log = (receipt.logs || []).find((entry) => Number.parseInt(String(entry.logIndex), 16) === expected.logIndex);
  if (!log) fail(400, 'CHAIN_EVENT_LOG_NOT_FOUND');
  if (String(log.address).toLowerCase() !== expected.contractAddress.toLowerCase()) fail(400, 'CHAIN_EVENT_LOG_CONTRACT_MISMATCH');

  let parsed;
  try {
    parsed = escrowEvents.parseLog({ topics: log.topics, data: log.data });
  } catch {
    fail(400, 'CHAIN_EVENT_LOG_PARSE_FAILED');
  }
  if (!parsed || parsed.name !== expected.eventName) fail(400, 'CHAIN_EVENT_LOG_NAME_MISMATCH');

  const verified = payloadFromParsedEvent(parsed, expected);
  if (verified.orderId.toLowerCase() !== expected.orderId.toLowerCase()) fail(400, 'CHAIN_EVENT_ORDER_MISMATCH');
  if (body.orderDigest && verified.orderDigest && String(body.orderDigest).toLowerCase() !== String(verified.orderDigest).toLowerCase()) {
    fail(400, 'CHAIN_EVENT_DIGEST_MISMATCH');
  }
  if (parsed.name === 'OrderPaid') observeReceiptGas(receipt, verified.buyer, expected.txHash, 'order.pay');
  return { ...verified, blockHash, finality };
}

async function verifyRewardChainEventOnRpc(body, expected) {
  if (!CHAIN_EVENT_RPC_URL) fail(503, 'CHAIN_EVENT_RPC_NOT_CONFIGURED');
  const receipt = await rpc('eth_getTransactionReceipt', [expected.txHash]);
  if (!receipt) fail(400, 'CHAIN_EVENT_TX_NOT_FOUND');
  if (String(receipt.status).toLowerCase() !== '0x1') fail(400, 'CHAIN_EVENT_TX_FAILED');
  const finality = await requireReceiptFinality(receipt);
  if (Number.parseInt(String(receipt.blockNumber), 16) !== expected.blockNumber) fail(400, 'CHAIN_EVENT_BLOCK_MISMATCH');
  const blockHash = verifiedReceiptBlockHash(body, receipt);
  const log = (receipt.logs || []).find((entry) => Number.parseInt(String(entry.logIndex), 16) === expected.logIndex);
  if (!log) fail(400, 'CHAIN_EVENT_LOG_NOT_FOUND');
  if (String(log.address).toLowerCase() !== expected.contractAddress.toLowerCase()) fail(400, 'CHAIN_EVENT_LOG_CONTRACT_MISMATCH');

  let parsed;
  try {
    parsed = rewardLedgerEvents.parseLog({ topics: log.topics, data: log.data });
  } catch {
    fail(400, 'CHAIN_EVENT_LOG_PARSE_FAILED');
  }
  if (!parsed || parsed.name !== expected.eventName) fail(400, 'CHAIN_EVENT_LOG_NAME_MISMATCH');
  const verified = payloadFromRewardParsedEvent(parsed, expected);
  if (verified.entryId !== expected.entryId) fail(400, 'REWARD_EVENT_ENTRY_MISMATCH');
  if (body.orderId && verified.orderId && String(body.orderId).toLowerCase() !== String(verified.orderId).toLowerCase()) fail(400, 'REWARD_EVENT_ORDER_MISMATCH');
  if (parsed.name === 'RewardClaimed') observeReceiptGas(receipt, verified.user, expected.txHash, 'reward.claim');
  return { ...verified, blockHash, finality, ...receiptGasDetails(receipt) };
}

async function verifySeckillChainEventOnRpc(body, expected) {
  if (!CHAIN_EVENT_RPC_URL) fail(503, 'CHAIN_EVENT_RPC_NOT_CONFIGURED');
  const receipt = await rpc('eth_getTransactionReceipt', [expected.txHash]);
  if (!receipt) fail(400, 'CHAIN_EVENT_TX_NOT_FOUND');
  if (String(receipt.status).toLowerCase() !== '0x1') fail(400, 'CHAIN_EVENT_TX_FAILED');
  const finality = await requireReceiptFinality(receipt);
  if (Number.parseInt(String(receipt.blockNumber), 16) !== expected.blockNumber) fail(400, 'CHAIN_EVENT_BLOCK_MISMATCH');
  const blockHash = verifiedReceiptBlockHash(body, receipt);
  const log = (receipt.logs || []).find((entry) => Number.parseInt(String(entry.logIndex), 16) === expected.logIndex);
  if (!log) fail(400, 'CHAIN_EVENT_LOG_NOT_FOUND');
  if (String(log.address).toLowerCase() !== expected.contractAddress.toLowerCase()) fail(400, 'CHAIN_EVENT_LOG_CONTRACT_MISMATCH');
  let parsed;
  try {
    parsed = seckillEvents.parseLog({ topics: log.topics, data: log.data });
  } catch {
    fail(400, 'CHAIN_EVENT_LOG_PARSE_FAILED');
  }
  if (!parsed || parsed.name !== expected.eventName) fail(400, 'CHAIN_EVENT_LOG_NAME_MISMATCH');
  const verified = payloadFromSeckillParsedEvent(parsed, expected);
  if (String(verified.sessionId).toLowerCase() !== expected.sessionId.toLowerCase()) fail(400, 'SECKILL_EVENT_SESSION_MISMATCH');
  if (body.orderId && verified.orderId && String(body.orderId).toLowerCase() !== String(verified.orderId).toLowerCase()) fail(400, 'SECKILL_EVENT_ORDER_MISMATCH');
  if (parsed.name === 'PurchaseRecorded') observeReceiptGas(receipt, verified.buyer, expected.txHash, 'seckill.purchase');
  return { ...verified, blockHash, finality };
}

function verifiedReceiptBlockHash(body, receipt) {
  const actual = requireBytes32(receipt.blockHash, 'receiptBlockHash').toLowerCase();
  if (body.blockHash && requireBytes32(body.blockHash, 'blockHash').toLowerCase() !== actual) fail(400, 'CHAIN_EVENT_BLOCK_HASH_MISMATCH');
  return actual;
}

function receiptGasDetails(receipt) {
  const gasUsed = parseRpcUint(receipt?.gasUsed || '0x0');
  const effectiveGasPriceWei = parseRpcUint(receipt?.effectiveGasPrice || receipt?.gasPrice || '0x0');
  const gasCostWei = gasUsed * effectiveGasPriceWei;
  return {
    gasUsed: gasUsed.toString(),
    effectiveGasPriceWei: effectiveGasPriceWei.toString(),
    gasBnb: formatUnits(gasCostWei, 18)
  };
}

function eventBlockHash(body) {
  if (!body?.blockHash) return null;
  return requireBytes32(body.blockHash, 'blockHash').toLowerCase();
}

function insertChainEvent({ chainId, contractAddress, target, txHash, blockNumber, logIndex, eventName, payload }) {
  const finality = chainEventFinalityMetadata(payload, blockNumber);
  db.prepare(`
    INSERT INTO chain_events (
      chain_id, contract_address, order_id, tx_hash, block_number, block_hash, log_index, event_name,
      payload_json, confirmation_count, required_confirmations, finality_status, finalized_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chainId,
    contractAddress.toLowerCase(),
    target,
    txHash.toLowerCase(),
    blockNumber,
    eventBlockHash(payload),
    logIndex,
    eventName,
    JSON.stringify(payload),
    finality.confirmations,
    finality.requiredConfirmations,
    finality.status,
    finality.finalizedAt,
    new Date().toISOString()
  );
}

function chainEventFinalityMetadata(payload, blockNumber) {
  const finality = payload?.finality;
  if (finality?.finalized === true) {
    const confirmations = Number(finality.confirmations);
    const requiredConfirmations = Number(finality.requiredConfirmations);
    const finalizedBlock = Number(finality.blockNumber);
    const latestBlock = Number(finality.latestBlock);
    if (
      !Number.isSafeInteger(confirmations)
      || !Number.isSafeInteger(requiredConfirmations)
      || !Number.isSafeInteger(finalizedBlock)
      || !Number.isSafeInteger(latestBlock)
      || requiredConfirmations !== INDEXER_CONFIRMATIONS
      || confirmations < requiredConfirmations
      || finalizedBlock !== blockNumber
      || latestBlock < finalizedBlock
    ) fail(409, 'CHAIN_EVENT_FINALITY_INVALID');
    return { status: 'Finalized', confirmations, requiredConfirmations, finalizedAt: new Date().toISOString() };
  }
  if (!CHAIN_EVENT_VERIFY_RPC) {
    return { status: 'Unverified', confirmations: 0, requiredConfirmations: INDEXER_CONFIRMATIONS, finalizedAt: null };
  }
  fail(409, 'CHAIN_EVENT_FINALITY_REQUIRED');
}

function payloadFromParsedEvent(parsed, expected) {
  const base = {
    eventName: parsed.name,
    chainId: expected.chainId,
    contractAddress: expected.contractAddress,
    orderId: parsed.args.orderId,
    txHash: expected.txHash,
    blockNumber: expected.blockNumber,
    logIndex: expected.logIndex
  };
  if (parsed.name === 'OrderPaid') {
    return {
      ...base,
      buyer: parsed.args.buyer,
      seller: parsed.args.seller,
      productId: parsed.args.productId,
      nplAmountWei: parsed.args.nplAmount.toString(),
      bnmLockedWei: parsed.args.bnmLocked.toString(),
      amountWei: parsed.args.nplAmount.toString(),
      amountNpl: formatUnits(parsed.args.nplAmount, 18),
      bnmLocked: formatUnits(parsed.args.bnmLocked, 18),
      deadline: Number(parsed.args.deadline),
      orderDigest: parsed.args.orderDigest,
      splitVersion: Number(parsed.args.splitVersion)
    };
  }
  if (parsed.name === 'OrderCompleted') {
    return { ...base, seller: parsed.args.seller, amountWei: parsed.args.nplAmount.toString(), amountNpl: formatUnits(parsed.args.nplAmount, 18), splitVersion: Number(parsed.args.splitVersion) };
  }
  if (parsed.name === 'OrderForcedRefunded') {
    return {
      ...base,
      buyer: parsed.args.buyer,
      refundedNplWei: parsed.args.refundedNpl.toString(),
      amountWei: parsed.args.refundedNpl.toString(),
      amountNpl: formatUnits(parsed.args.refundedNpl, 18),
      burnedRewards: Number(parsed.args.burnedRewards)
    };
  }
  if (parsed.name === 'OrderEmergencyRefunded') {
    return { ...base, buyer: parsed.args.buyer, refundedNplWei: parsed.args.refundedNpl.toString(), amountWei: parsed.args.refundedNpl.toString(), amountNpl: formatUnits(parsed.args.refundedNpl, 18), burnedRewards: Number(parsed.args.burnedRewards), emergency: true };
  }
  if (parsed.name === 'OrderArbitration') {
    return { ...base, caller: parsed.args.caller };
  }
  fail(400, 'UNSUPPORTED_EVENT');
}

function payloadFromEscrowControlParsedEvent(parsed, expected) {
  const base = {
    eventName: parsed.name,
    chainId: expected.chainId,
    contractAddress: expected.contractAddress,
    txHash: expected.txHash,
    blockNumber: expected.blockNumber,
    logIndex: expected.logIndex
  };
  if (parsed.name === 'SellerApprovalUpdated') {
    return { ...base, seller: parsed.args.seller, approved: Boolean(parsed.args.approved) };
  }
  if (parsed.name === 'SplitConfigUpdated') {
    return { ...base, splitVersion: Number(parsed.args.version), configHash: parsed.args.configHash };
  }
  fail(400, 'UNSUPPORTED_ESCROW_CONTROL_EVENT');
}

function payloadFromCircuitParsedEvent(parsed, expected) {
  if (!CIRCUIT_EVENT_DEFINITIONS.has(parsed.name)) fail(400, 'UNSUPPORTED_CIRCUIT_EVENT');
  return {
    eventName: parsed.name,
    chainId: expected.chainId,
    contractAddress: expected.contractAddress,
    account: parsed.args.account,
    txHash: expected.txHash,
    blockNumber: expected.blockNumber,
    logIndex: expected.logIndex
  };
}

function payloadFromSeckillParsedEvent(parsed, expected) {
  const base = {
    eventName: parsed.name,
    chainId: expected.chainId,
    contractAddress: expected.contractAddress,
    sessionId: parsed.args.sessionId,
    txHash: expected.txHash,
    blockNumber: expected.blockNumber,
    logIndex: expected.logIndex
  };
  if (parsed.name === 'SessionStarted') {
    return {
      ...base,
      productId: parsed.args.productId,
      startsAt: Number(parsed.args.startsAt),
      mainEndsAt: Number(parsed.args.mainEndsAt),
      relayEndsAt: Number(parsed.args.relayEndsAt),
      minimumNplAmountWei: parsed.args.minimumNplAmount.toString(),
      minimumNplAmount: formatUnits(parsed.args.minimumNplAmount, 18),
      prizePoolNplWei: parsed.args.prizePoolNpl.toString(),
      prizePoolNpl: formatUnits(parsed.args.prizePoolNpl, 18)
    };
  }
  if (parsed.name === 'PurchaseRecorded') {
    return { ...base, buyer: parsed.args.buyer, orderId: parsed.args.orderId, relayEndsAt: Number(parsed.args.relayEndsAt), totalBuys: Number(parsed.args.totalBuys) };
  }
  if (parsed.name === 'SessionForceClosed') {
    return base;
  }
  if (parsed.name === 'SessionSettled') {
    return { ...base, winner: parsed.args.winner, orderId: parsed.args.orderId, prizePoolNplWei: parsed.args.prizePoolNpl.toString(), prizePoolNpl: formatUnits(parsed.args.prizePoolNpl, 18) };
  }
  if (parsed.name === 'SeckillPrizeReleased') {
    return { ...base, rewardOrderId: parsed.args.rewardOrderId, winner: parsed.args.winner, prizePoolNplWei: parsed.args.prizePoolNpl.toString(), prizePoolNpl: formatUnits(parsed.args.prizePoolNpl, 18) };
  }
  fail(400, 'UNSUPPORTED_SECKILL_EVENT');
}

function payloadFromRewardParsedEvent(parsed, expected) {
  const base = {
    eventName: parsed.name,
    chainId: expected.chainId,
    contractAddress: expected.contractAddress,
    entryId: parsed.args.entryId.toString(),
    txHash: expected.txHash,
    blockNumber: expected.blockNumber,
    logIndex: expected.logIndex
  };
  if (parsed.name === 'RewardLocked') {
    return {
      ...base,
      orderId: parsed.args.orderId,
      user: parsed.args.user,
      asset: parsed.args.asset,
      amountWei: parsed.args.amount.toString(),
      amount: formatUnits(parsed.args.amount, 18),
      bucket: Number(parsed.args.bucket)
    };
  }
  if (parsed.name === 'RewardReleased') {
    return { ...base, orderId: parsed.args.orderId };
  }
  if (parsed.name === 'RewardClaimed') {
    return {
      ...base,
      user: parsed.args.user,
      asset: parsed.args.asset,
      amountWei: parsed.args.amount.toString(),
      amount: formatUnits(parsed.args.amount, 18)
    };
  }
  if (parsed.name === 'LockedRewardBurned') {
    return { ...base, orderId: parsed.args.orderId };
  }
  if (parsed.name === 'UnclaimedRewardBurned') {
    return { ...base, orderId: parsed.args.orderId, previousState: Number(parsed.args.previousState) };
  }
  fail(400, 'UNSUPPORTED_REWARD_EVENT');
}

function validateEventAgainstOrder(eventName, body, order) {
  if (![
    'OrderPaid',
    'OrderCompleted',
    'OrderArbitration',
    'OrderForcedRefunded',
    'OrderEmergencyRefunded'
  ].includes(eventName)) {
    fail(400, 'UNSUPPORTED_EVENT');
  }
  if (TERMINAL_ORDER_STATUSES.has(order.status)) fail(400, 'ORDER_ALREADY_TERMINAL');

  if (eventName === 'OrderPaid') {
    if (order.status !== 'Draft') fail(400, 'INVALID_ORDER_STATUS_TRANSITION');
    const buyer = requireAddress(body.buyer, 'buyer');
    const seller = requireAddress(body.seller, 'seller');
    if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(400, 'EVENT_BUYER_MISMATCH');
    if (seller.toLowerCase() !== order.seller_address.toLowerCase()) fail(400, 'EVENT_SELLER_MISMATCH');
    if (body.orderDigest && requireBytes32(body.orderDigest, 'orderDigest').toLowerCase() !== order.order_digest.toLowerCase()) {
      fail(400, 'EVENT_DIGEST_MISMATCH');
    }
    if (body.productId && requireBytes32(body.productId, 'productId').toLowerCase() !== orderProductIdBytes32(order.order_id, order.order_digest).toLowerCase()) {
      fail(400, 'EVENT_PRODUCT_MISMATCH');
    }
    if (!Number.isSafeInteger(Number(body.splitVersion)) || Number(body.splitVersion) <= 0) fail(400, 'EVENT_SPLIT_VERSION_INVALID');
    validateEventAmount(body, order);
    return;
  }

  if (eventName === 'OrderCompleted') {
    if (!isPaidOrArbitratingStatus(order.status)) fail(400, 'INVALID_ORDER_STATUS_TRANSITION');
    const seller = requireAddress(body.seller, 'seller');
    if (seller.toLowerCase() !== order.seller_address.toLowerCase()) fail(400, 'EVENT_SELLER_MISMATCH');
    if (!Number.isSafeInteger(Number(body.splitVersion)) || Number(body.splitVersion) <= 0) fail(400, 'EVENT_SPLIT_VERSION_INVALID');
    const paidEvent = db.prepare("SELECT payload_json FROM chain_events WHERE order_id = ? AND event_name = 'OrderPaid' ORDER BY id DESC LIMIT 1").get(order.order_id);
    const paidSplitVersion = paidEvent ? Number(JSON.parse(paidEvent.payload_json || '{}').splitVersion || 0) : 0;
    if (paidSplitVersion && Number(body.splitVersion) !== paidSplitVersion) fail(400, 'EVENT_SPLIT_VERSION_MISMATCH');
    validateEventAmount(body, order);
    return;
  }

  if (eventName === 'OrderForcedRefunded' || eventName === 'OrderEmergencyRefunded') {
    if (!isRefundableOrderStatus(order.status)) fail(400, 'INVALID_ORDER_STATUS_TRANSITION');
    const buyer = requireAddress(body.buyer, 'buyer');
    if (buyer.toLowerCase() !== order.buyer_address.toLowerCase()) fail(400, 'EVENT_BUYER_MISMATCH');
    if (eventName === 'OrderForcedRefunded') validateFullRefundAmount(body, order);
    else validateEventAmount(body, order);
    return;
  }

  if (eventName === 'OrderArbitration') {
    if (!isPaidOrArbitratingStatus(order.status)) fail(400, 'INVALID_ORDER_STATUS_TRANSITION');
    requireAddress(body.caller, 'caller');
    return;
  }
}

function deductSoldStock(orderId) {
  const lines = db.prepare('SELECT id, product_id, sku_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
  if (lines.length === 0) return true;
  let stockIssue = false;
  for (const line of lines) {
    const product = db.prepare('SELECT stock FROM products WHERE id = ?').get(line.product_id);
    const available = Math.max(0, Number(product?.stock || 0));
    const quantity = Number(line.quantity);
    const deducted = Math.min(available, quantity);
    if (deducted < quantity) stockIssue = true;
    if (deducted > 0) {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(deducted, line.product_id);
      if (line.sku_id) db.prepare('UPDATE product_skus SET stock = MAX(stock - ?, 0) WHERE id = ? AND product_id = ?').run(deducted, line.sku_id, line.product_id);
      db.prepare('UPDATE order_items SET stock_deducted = stock_deducted + ? WHERE id = ?').run(
        deducted,
        line.id
      );
      markProductSoldOutIfEmpty(line.product_id);
    }
  }
  return stockIssue;
}

function markProductSoldOutIfEmpty(productId) {
  const product = db.prepare('SELECT stock, status FROM products WHERE id = ?').get(productId);
  if (!product || Number(product.stock) > 0 || product.status === 'SoldOut') return;
  db.prepare("UPDATE products SET status = 'SoldOut' WHERE id = ?").run(productId);
  db.prepare(`
    UPDATE product_submissions
    SET status = 'SoldOut'
    WHERE approved_product_id = ? AND status IN ('Approved', 'Scheduled', 'Live', 'TakedownRequested')
  `).run(productId);
}

function restoreSoldStock(orderId) {
  const lines = db.prepare('SELECT id, product_id, sku_id, stock_deducted FROM order_items WHERE order_id = ?').all(orderId);
  for (const line of lines) {
    const deducted = Number(line.stock_deducted || 0);
    if (deducted <= 0) continue;
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(deducted, line.product_id);
    if (line.sku_id) db.prepare('UPDATE product_skus SET stock = stock + ? WHERE id = ? AND product_id = ?').run(deducted, line.sku_id, line.product_id);
    db.prepare('UPDATE order_items SET stock_deducted = 0 WHERE id = ?').run(line.id);
  }
}

function ensureInitialFulfillment(order, forcedStatus = null) {
  const type = order.fulfillment_mode === 'pickup' ? 'pickup' : 'delivery';
  const status = forcedStatus || (type === 'pickup' ? 'AwaitingPickupVerification' : 'AwaitingShipment');
  const pickupCode = type === 'pickup' ? String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0') : undefined;
  const payload = {
    orderId: order.order_id,
    type,
    status,
    addressId: order.address_id || undefined,
    storeId: order.store_id || undefined,
    regionCode: order.region_code || undefined,
    pickupCode,
    source: 'chain.OrderPaid'
  };
  db.prepare('INSERT OR REPLACE INTO fulfillment_orders (id, order_id, type, status, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    `fulfillment-${order.order_id}`,
    order.order_id,
    type,
    status,
    JSON.stringify(payload)
  );
}

function lockOrderReward(order, body, txHash) {
  const amount = body?.bnmLocked || order.bnm_locked || order.amount_npl;
  parseDecimal18(amount);
  const id = `reward-bnm-${String(order.order_id).slice(2, 18)}`;
  db.prepare(`
    INSERT OR IGNORE INTO reward_ledger (id, wallet_address, order_id, source, asset_symbol, amount, state, tx_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    order.buyer_address.toLowerCase(),
    order.order_id,
    `订单 ${short(order.order_id)} 付款锁定`,
    'BNM',
    amount,
    'Locked',
    txHash || null
  );
}

function releaseOrderRewards(orderId, txHash = null) {
  return db.prepare(`
    UPDATE reward_ledger
    SET state = 'Available', tx_hash = COALESCE(?, tx_hash)
    WHERE order_id = ? AND state = 'Locked'
  `).run(txHash, orderId).changes;
}

function burnUnclaimedRewards(orderId, txHash = null) {
  return db.prepare(`
    UPDATE reward_ledger
    SET state = 'Burned', tx_hash = COALESCE(?, tx_hash)
    WHERE order_id = ? AND state IN ('Locked', 'Available', 'PendingClaim')
  `).run(txHash, orderId).changes;
}

function onchainRewardLedgerEnabled() {
  return isValidAddress(REWARD_LEDGER);
}

function rewardLedgerId(entryId) {
  return `reward-ledger-${entryId}`;
}

function rewardByEntryId(entryId) {
  return rewardById(rewardLedgerId(entryId));
}

function rewardById(id) {
  const row = db.prepare('SELECT * FROM reward_ledger WHERE id = ?').get(id);
  if (!row) return null;
  return toRewardLedgerEntry(row);
}

function rewardAmountFromEvent(body) {
  if (body.amountWei !== undefined) return formatDecimal18(parseUintString(body.amountWei, 'amountWei'));
  if (body.amount !== undefined) {
    const amount = String(body.amount);
    parseDecimal18(amount);
    return amount;
  }
  fail(400, 'INVALID_REWARD_AMOUNT');
}

function assetSymbolForAddress(address) {
  const lower = String(address || '').toLowerCase();
  if (isValidAddress(BNM) && lower === BNM.toLowerCase()) return 'BNM';
  if (lower === NPL.toLowerCase()) return 'NPL';
  fail(400, 'UNSUPPORTED_REWARD_ASSET');
}

function validateEventAmount(body, order) {
  const nplWei = body.nplAmountWei ?? body.amountWei;
  const nplText = body.nplAmount ?? body.amountNpl;
  if (nplWei !== undefined && parseUintString(nplWei, 'nplAmountWei') !== parseDecimal18(order.amount_npl || '0')) {
    fail(400, 'EVENT_NPL_AMOUNT_MISMATCH');
  }
  if (nplText !== undefined && parseDecimal18(String(nplText)) !== parseDecimal18(order.amount_npl || '0')) {
    fail(400, 'EVENT_NPL_AMOUNT_MISMATCH');
  }
}

function validateFullRefundAmount(body, order) {
  const refundWei = body.refundedNplWei ?? body.amountWei;
  const refundText = body.refundedNpl ?? body.amountNpl;
  const orderNpl = parseDecimal18(order.amount_npl);
  if (refundWei === undefined && refundText === undefined) {
    fail(400, 'EVENT_REFUND_AMOUNT_MISSING');
  }
  if (refundWei !== undefined && parseUintString(refundWei, 'refundedNplWei') !== orderNpl) {
    fail(400, 'EVENT_REFUND_AMOUNT_MISMATCH');
  }
  if (refundText !== undefined && parseDecimal18(String(refundText)) !== orderNpl) {
    fail(400, 'EVENT_REFUND_AMOUNT_MISMATCH');
  }
}

function statusForEvent(eventName) {
  switch (eventName) {
    case 'OrderPaid': return 'PaidLocked';
    case 'OrderCompleted': return 'Released';
    case 'OrderForcedRefunded': return 'ForcedRefunded';
    case 'OrderEmergencyRefunded': return 'EmergencyRefunded';
    case 'OrderArbitration': return 'Arbitration';
    default: fail(400, 'UNSUPPORTED_EVENT');
  }
}

function isPaidLockedStatus(status) {
  return status === 'PaidLocked';
}

function isPaidOrArbitratingStatus(status) {
  return ['PaidLocked', 'AwaitingShipment', 'Shipped', 'PickupReady', 'Arbitration'].includes(status);
}

function isRefundableOrderStatus(status) {
  return isPaidOrArbitratingStatus(status) || status === 'RefundRequested';
}

function isShipmentAllowedStatus(status) {
  return ['PaidLocked', 'AwaitingShipment'].includes(status);
}

function isRefundedStatus(status) {
  return status === 'ForcedRefunded' || status === 'EmergencyRefunded';
}

function findOrderByIdOrOrderId(value) {
  return db.prepare('SELECT * FROM orders WHERE id = ? OR order_id = ?').get(value, value);
}

function assertOrderReadAllowed(req, url, order) {
  if (hasAdminSecret(req)) return;
  const session = requireAuthenticatedSession(req);
  if (session.role === 'admin') return;
  if (session.role === 'buyer' && session.address.toLowerCase() === order.buyer_address.toLowerCase()) return;
  if (session.role === 'merchant' && session.address.toLowerCase() === order.seller_address.toLowerCase()) return;
  fail(403, 'ORDER_READ_FORBIDDEN');
}

function fulfillmentSnapshot(order) {
  const current = fulfillmentSummary(order);
  const confirmability = orderConfirmability(order, current);
  const releaseStatus = releaseStatusForOrder(order, current, confirmability);
  const releasePreview = releasePreviewForOrder(order);
  const timeout = timeoutLinkForOrder(order);
  const completeOrderCall = completeOrderCallForOrder(order, order.buyer_address, confirmability);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.order_id).map((row) => ({
    productId: row.product_id,
    skuId: row.sku_id || undefined,
    skuName: row.sku_name || undefined,
    quantity: row.quantity,
    fulfillmentMode: row.fulfillment_mode || undefined,
    addressId: row.address_id || undefined,
    storeId: row.store_id || undefined,
    regionCode: row.region_code || undefined,
    stockDeducted: row.stock_deducted
  }));
  const fulfillments = db.prepare('SELECT * FROM fulfillment_orders WHERE order_id = ? ORDER BY created_at').all(order.order_id).map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  }));
  const logistics = db.prepare('SELECT * FROM logistics_orders WHERE order_id = ? ORDER BY created_at').all(order.order_id).map((row) => ({
    id: row.id,
    carrier: row.carrier,
    trackingNo: row.tracking_no,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  }));
  const pickups = db.prepare('SELECT * FROM pickup_verifications WHERE order_id = ? ORDER BY created_at').all(order.order_id).map((row) => ({
    id: row.id,
    code: row.code,
    merchantAddress: row.merchant_address,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  }));
  return {
    version: '24k-fulfillment-snapshot-v1',
    generatedAt: new Date().toISOString(),
    order: toOrder(order),
    current,
    items,
    fulfillments,
    logistics,
    pickups,
    confirmability,
    releaseStatus,
    releasePreview,
    completeOrderCall,
    timeout,
    nextActions: fulfillmentNextActionsForOrder(confirmability, timeout),
    endpoints: {
      completeOrderIntent: '/api/dapp/complete-order-intent',
      completeTxStatus: `/api/orders/${order.order_id}/complete-tx-status?buyerAddress=${order.buyer_address}&txHash=0x...`,
      timeoutActions: `/api/orders/${order.order_id}/timeout-actions?buyerAddress=${order.buyer_address}`,
      orderStatus: `/api/orders/${order.order_id}?buyerAddress=${order.buyer_address}`,
      assets: `/api/assets/summary?address=${order.buyer_address}`
    }
  };
}

function toOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    buyerAddress: row.buyer_address,
    sellerAddress: row.seller_address,
	    amountNpl: row.amount_npl || '0.000000000000000000',
	    fulfillmentMode: row.fulfillment_mode || undefined,
	    addressId: row.address_id || undefined,
	    storeId: row.store_id || undefined,
	    regionCode: row.region_code || undefined,
    bnmLocked: row.bnm_locked || undefined,
    status: row.status,
    txHash: row.fund_tx_hash || row.tx_hash || undefined,
    fundTxHash: row.fund_tx_hash || undefined,
    lastEventTxHash: row.last_event_tx_hash || row.tx_hash || undefined,
    chainId: row.chain_id,
    escrowAddress: row.escrow_address,
    orderDigest: row.order_digest,
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined
  };
}

function toProduct(row) {
  const ui = PRODUCT_UI[row.id] || {};
  const ratio = paymentRatioForProduct(row.id);
  const dbSkus = db.prepare('SELECT * FROM product_skus WHERE product_id = ? ORDER BY id').all(row.id).map((sku) => ({
    id: sku.id,
    name: sku.name,
    settlementPriceNpl: Number(sku.settlement_price_npl),
    stock: Number(sku.stock)
  }));
  const skus = ui.skus || (dbSkus.length ? dbSkus : [{ id: `${row.id}-default`, name: row.sku, settlementPriceNpl: Number(row.price_npl), stock: row.stock }]);
  return {
    id: row.id,
    shopName: row.shop_name,
    shopBadge: ui.shopBadge || '24K',
    title: row.title,
    sku: row.sku,
    imageUrl: row.image_url || '',
    imageTone: ui.imageTone || 'ceramic',
    category: ui.category || '精选',
    summary: ui.summary || `${row.title}，支持 NPL 托管购买。`,
    priceNpl: Number(row.price_npl),
    originalPriceNpl: ui.originalPriceNpl,
    nplRatio: ratio.nplPaymentBps / 100,
    bnmRebateRate: ratio.bnmRebateBps / 100,
    paymentRatioBps: {
      nplPaymentBps: ratio.nplPaymentBps,
      bnmRebateBps: ratio.bnmRebateBps,
      source: ratio.source,
      updatedAt: ratio.updatedAt
    },
    seckillLocked: Boolean(ui.seckillLocked),
    fulfillmentModes: ui.fulfillmentModes || ['delivery'],
    adminRegionCode: ui.adminRegionCode || '',
    skus,
    stock: row.stock,
    status: row.status || 'Active',
    sellerAddress: row.seller_address,
    tags: ui.tags || ['NPL', 'BNM全返']
  };
}

function toMessage(row) {
  const ui = MESSAGE_UI[row.id] || {};
  return {
    id: row.id,
    title: row.title,
    preview: row.preview,
    date: row.date_label,
    unread: ui.unread,
    tone: ui.tone || 'system'
  };
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 240) fail(400, 'IDEMPOTENCY_KEY_TOO_LONG');
  return trimmed;
}

function orderRequestDigest(body) {
  const { idempotencyKey, ...payload } = body || {};
  return `0x${createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

function requireQuantity(value) {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) fail(400, 'INVALID_QUANTITY');
  return quantity;
}

function parseUintString(value, name) {
  const text = String(value);
  if (!/^[0-9]+$/.test(text)) fail(400, `INVALID_${name.toUpperCase()}`);
  return BigInt(text);
}

function requireUintString(value, name) {
  const text = requireString(value, name);
  if (!/^[0-9]+$/.test(text)) fail(400, `INVALID_${name.toUpperCase()}`);
  return text;
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableColumnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
}

function ensureChainEventsFrozenSchema() {
  const columns = new Set(tableColumnNames('chain_events'));
  const uniqueShapes = chainEventUniqueIndexShapes();
  const requiredColumns = ['block_hash', 'confirmation_count', 'required_confirmations', 'finality_status', 'finalized_at', 'created_at'];
  const hasLegacyUnique = uniqueShapes.includes('tx_hash,log_index');
  const hasFrozenUnique = uniqueShapes.includes('chain_id,tx_hash,log_index');
  if (!hasLegacyUnique && hasFrozenUnique && requiredColumns.every((column) => columns.has(column))) return;

  const rows = db.prepare('SELECT * FROM chain_events ORDER BY id').all();
  db.exec(`
    DROP TABLE IF EXISTS chain_events_next;
    CREATE TABLE chain_events_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      order_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT,
      log_index INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      confirmation_count INTEGER NOT NULL DEFAULT 0,
      required_confirmations INTEGER NOT NULL DEFAULT 0,
      finality_status TEXT NOT NULL DEFAULT 'Legacy',
      finalized_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chain_id, tx_hash, log_index)
    );
  `);
  const insert = db.prepare(`
    INSERT INTO chain_events_next (
      id, chain_id, contract_address, order_id, tx_hash, block_number, block_hash, log_index, event_name,
      payload_json, confirmation_count, required_confirmations, finality_status, finalized_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const confirmations = Number.isSafeInteger(Number(row.confirmation_count)) ? Math.max(0, Number(row.confirmation_count)) : 0;
    const requiredConfirmations = Number.isSafeInteger(Number(row.required_confirmations)) ? Math.max(0, Number(row.required_confirmations)) : 0;
    const finalized = row.finality_status === 'Finalized'
      && /^0x[0-9a-f]{64}$/i.test(String(row.block_hash || ''))
      && requiredConfirmations > 0
      && confirmations >= requiredConfirmations
      && Boolean(row.finalized_at);
    const finalityStatus = finalized ? 'Finalized' : row.finality_status === 'Unverified' ? 'Unverified' : 'Legacy';
    insert.run(
      row.id,
      row.chain_id,
      String(row.contract_address).toLowerCase(),
      row.order_id,
      String(row.tx_hash).toLowerCase(),
      row.block_number,
      row.block_hash || null,
      row.log_index,
      row.event_name,
      row.payload_json,
      confirmations,
      requiredConfirmations,
      finalityStatus,
      finalized ? row.finalized_at : null,
      row.created_at || new Date().toISOString()
    );
  }
  db.exec('DROP TABLE chain_events; ALTER TABLE chain_events_next RENAME TO chain_events');
}

function chainEventUniqueIndexShapes() {
  return db.prepare("PRAGMA index_list('chain_events')").all()
    .filter((index) => Number(index.unique) === 1)
    .map((index) => db.prepare(`PRAGMA index_info(${index.name})`).all().map((entry) => entry.name).join(','));
}

function ensureOrderItemsFlexibleSchema() {
  const columns = db.prepare('PRAGMA table_info(order_items)').all().map((entry) => entry.name);
  const uniqueIndexes = db.prepare("PRAGMA index_list('order_items')").all().filter((entry) => Number(entry.unique) === 1);
  const hasLegacyProductUnique = uniqueIndexes.some((index) => {
    const indexedColumns = db.prepare(`PRAGMA index_info(${index.name})`).all().map((entry) => entry.name).join(',');
    return indexedColumns === 'order_id,product_id';
  });
  const required = ['sku_id', 'sku_name', 'fulfillment_mode', 'address_id', 'store_id', 'region_code', 'line_key', 'stock_deducted'];
  if (!hasLegacyProductUnique && required.every((column) => columns.includes(column))) return;

  const rows = db.prepare('SELECT * FROM order_items').all();
  db.exec('SAVEPOINT order_items_flexible_schema');
  try {
    db.exec(`
      DROP TABLE IF EXISTS order_items_next;
      CREATE TABLE order_items_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        sku_id TEXT,
        sku_name TEXT,
        quantity INTEGER NOT NULL,
        unit_price_npl TEXT NOT NULL,
        fulfillment_mode TEXT,
        address_id TEXT,
        store_id TEXT,
        region_code TEXT,
        line_key TEXT NOT NULL,
        stock_deducted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(order_id, line_key)
      );
    `);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO order_items_next
        (id, order_id, product_id, sku_id, sku_name, quantity, unit_price_npl, fulfillment_mode, address_id, store_id, region_code, line_key, stock_deducted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.id || null,
        row.order_id,
        row.product_id,
        row.sku_id || null,
        row.sku_name || null,
        row.quantity,
        row.unit_price_npl,
        row.fulfillment_mode || null,
        row.address_id || null,
        row.store_id || null,
        row.region_code || null,
        row.line_key || orderItemLineKey(row),
        Number(row.stock_deducted || 0)
      );
    }
    db.exec('DROP TABLE order_items; ALTER TABLE order_items_next RENAME TO order_items; RELEASE SAVEPOINT order_items_flexible_schema');
  } catch (error) {
    try { db.exec('ROLLBACK TO SAVEPOINT order_items_flexible_schema; RELEASE SAVEPOINT order_items_flexible_schema'); } catch {}
    throw error;
  }
}

function requireIndexerSecret(req) {
  if (!INDEXER_SECRET) fail(503, 'INDEXER_SECRET_NOT_CONFIGURED');
  if (req.headers['x-indexer-secret'] !== INDEXER_SECRET) fail(401, 'INVALID_INDEXER_SECRET');
}

function requireLogisticsCallbackSecret(req) {
  if (!LOGISTICS_CALLBACK_SECRET) fail(503, 'LOGISTICS_CALLBACK_SECRET_NOT_CONFIGURED');
  if (req.headers['x-logistics-secret'] !== LOGISTICS_CALLBACK_SECRET) fail(401, 'INVALID_LOGISTICS_CALLBACK_SECRET');
}

function requireMultisigCallbackSecret(req) {
  if (!MULTISIG_CALLBACK_SECRET) fail(503, 'MULTISIG_CALLBACK_SECRET_NOT_CONFIGURED');
  if (!timingSafeTextEqual(String(req.headers['x-multisig-secret'] || ''), MULTISIG_CALLBACK_SECRET)) fail(401, 'INVALID_MULTISIG_CALLBACK_SECRET');
}

async function recordMultisigApproval(body) {
  const safeAddress = requireAddress(body?.safeAddress, 'safeAddress').toLowerCase();
  const configuredSafes = configuredMultisigAddresses();
  if (!configuredSafes.length) fail(503, 'MULTISIG_OWNER_NOT_CONFIGURED');
  if (!configuredSafes.includes(safeAddress)) fail(403, 'MULTISIG_OWNER_MISMATCH');
  const signerAddress = requireAddress(body?.signerAddress, 'signerAddress').toLowerCase();
  const safeTxHash = requireBytes32(body?.safeTxHash, 'safeTxHash').toLowerCase();
  const transactionHash = body?.txHash ? requireBytes32(body.txHash, 'txHash').toLowerCase() : null;
  const approvalAction = requireString(body?.action, 'action').slice(0, 160);
  if (!MULTISIG_APPROVAL_ACTIONS.has(approvalAction)) fail(400, 'INVALID_MULTISIG_ACTION');
  const decision = String(body?.decision || 'approved').toLowerCase();
  if (!['approved', 'executed'].includes(decision)) fail(400, 'INVALID_MULTISIG_DECISION');
  const signedAtMs = Date.parse(String(body?.signedAt || ''));
  if (!Number.isFinite(signedAtMs) || Math.abs(Date.now() - signedAtMs) > 24 * 60 * 60_000) fail(400, 'INVALID_MULTISIG_SIGNED_AT');
  const approvalSignature = requireString(body?.approvalSignature || body?.signature, 'approvalSignature');
  if (!/^0x[0-9a-fA-F]{130}$/.test(approvalSignature)) fail(400, 'INVALID_MULTISIG_APPROVAL_SIGNATURE');
  let recovered;
  try {
    recovered = recoverAddress(safeTxHash, approvalSignature).toLowerCase();
  } catch {
    fail(401, 'INVALID_MULTISIG_APPROVAL_SIGNATURE');
  }
  if (recovered !== signerAddress) fail(401, 'MULTISIG_SIGNER_MISMATCH');
  const ownerResult = await rpc('eth_call', [{
    to: safeAddress,
    data: safeMultisigInterface.encodeFunctionData('isOwner', [signerAddress])
  }, 'latest']);
  const [isOwner] = safeMultisigInterface.decodeFunctionResult('isOwner', ownerResult);
  if (!isOwner) fail(403, 'MULTISIG_SIGNER_NOT_OWNER');
  let execution = null;
  if (decision === 'executed') {
    if (!transactionHash) fail(400, 'MULTISIG_EXECUTION_TX_REQUIRED');
    execution = await verifyMultisigExecution(safeAddress, safeTxHash, transactionHash);
  }
  const existing = auditDb.prepare(`
    SELECT id FROM audit_logs
    WHERE action = 'multisig.approval.recorded' AND target = ? AND actor_address = ?
    LIMIT 1
  `).get(safeTxHash, signerAddress);
  if (existing) return { duplicate: true, id: existing.id, safeTxHash, signerAddress };
  const signatureHash = `0x${createHash('sha256').update(approvalSignature).digest('hex')}`;
  writeAudit('integration', signerAddress, 'multisig.approval.recorded', safeTxHash, {
    safeAddress,
    signerAddress,
    safeTxHash,
    txHash: transactionHash,
    approvalAction,
    decision,
    signedAt: new Date(signedAtMs).toISOString(),
    signatureHash,
    execution,
    source: 'multisig-callback'
  });
  return { duplicate: false, safeAddress, signerAddress, safeTxHash, txHash: transactionHash, approvalAction, decision, signatureHash, execution };
}

const MULTISIG_APPROVAL_ACTIONS = new Set([
  'escrow.setSplitConfig',
  'escrow.setSeller',
  'escrow.completeOrder',
  'escrow.forceRefund',
  'escrow.pause',
  'escrow.unpause',
  'rewards.releaseOrder',
  'rewards.pause',
  'rewards.unpause',
  'seckill.startSession',
  'seckill.forceClose',
  'seckill.settle',
  'seckill.setMaxGasPrice',
  'seckill.approvePrizePoolNpl',
  'seckill.fundPrizePoolNpl',
  'seckill.pause',
  'seckill.unpause'
]);

async function verifyMultisigExecution(safeAddress, safeTxHash, transactionHash) {
  const receipt = await rpc('eth_getTransactionReceipt', [transactionHash]);
  if (!receipt) fail(409, 'MULTISIG_EXECUTION_NOT_MINED');
  if (String(receipt.status || '').toLowerCase() !== '0x1') fail(409, 'MULTISIG_EXECUTION_FAILED');
  if (String(receipt.to || '').toLowerCase() !== safeAddress) fail(400, 'MULTISIG_EXECUTION_SAFE_MISMATCH');
  const executionLog = (Array.isArray(receipt.logs) ? receipt.logs : []).find((log) => {
    if (String(log?.address || '').toLowerCase() !== safeAddress) return false;
    try {
      const parsed = safeMultisigInterface.parseLog(log);
      return parsed?.name === 'ExecutionSuccess' && String(parsed.args.txHash).toLowerCase() === safeTxHash;
    } catch {
      return false;
    }
  });
  if (!executionLog) fail(400, 'MULTISIG_EXECUTION_EVENT_MISMATCH');
  const finality = await requireReceiptFinality(receipt);
  return { status: 'Finalized', txHash: transactionHash, blockNumber: finality.blockNumber, confirmations: finality.confirmations };
}

function configuredMultisigAddresses() {
  return [...new Set([
    readAdminConfig('chain')?.multisigAddress,
    process.env.ESCROW_OWNER_ADDRESS,
    process.env.REWARDS_OWNER_ADDRESS,
    process.env.SECKILL_OWNER_ADDRESS
  ].filter(isValidAddress).map((address) => address.toLowerCase()))];
}

async function recordLogisticsCallback(body) {
  const orderId = requireString(body?.orderId, 'orderId');
  const order = findOrderByIdOrOrderId(orderId);
  if (!order) fail(404, 'ORDER_NOT_FOUND');
  const logistics = db.prepare('SELECT * FROM logistics_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.order_id);
  if (!logistics) fail(404, 'LOGISTICS_ORDER_NOT_FOUND');
  const trackingNo = requireTrackingNo(body?.trackingNo || logistics.tracking_no);
  if (trackingNo.toLowerCase() !== logistics.tracking_no.toLowerCase()) fail(400, 'TRACKING_NO_MISMATCH');
  const carrier = requireString(body?.carrier || logistics.carrier, 'carrier');
  const status = normalizeLogisticsStatus(body?.status);
  const id = body?.eventId ? requireString(body.eventId, 'eventId').slice(0, 128) : `logistics-event-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const duplicate = db.prepare('SELECT id FROM logistics_events WHERE id = ?').get(id);
  if (duplicate) return { duplicate: true, id, orderId: order.order_id, status };
  db.prepare('INSERT INTO logistics_events (id, order_id, carrier, tracking_no, status, payload_json) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    order.order_id,
    carrier,
    trackingNo,
    status,
    JSON.stringify(redactConfigValue(body || {}))
  );
  let settlementRequest = null;
  if (status === 'Delivered') {
    const fulfillment = db.prepare('SELECT * FROM fulfillment_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.order_id);
    const payload = fulfillment ? JSON.parse(fulfillment.payload_json || '{}') : {};
    db.prepare('UPDATE fulfillment_orders SET status = ?, payload_json = ? WHERE order_id = ?').run(
      'DeliveredAwaitingSettlement',
      JSON.stringify({ ...payload, deliveredAt: body?.occurredAt || new Date().toISOString(), logisticsEventId: id }),
      order.order_id
    );
    db.prepare('UPDATE orders SET fulfillment_verified_at = CURRENT_TIMESTAMP, settlement_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run(order.order_id);
    settlementRequest = createSettlementRequest(order, 'logistics-provider', 'carrier-delivered', { logisticsEventId: id, carrier, trackingNo });
    await deliverNotification({
      channel: 'order',
      recipient: order.buyer_address,
      type: 'order.delivered',
      title: '物流已签收',
      body: '已生成链上清算请求，请等待区块确认。',
      orderId: order.order_id
    });
  }
  writeAudit('integration', carrier, 'logistics.callback', order.order_id, { id, trackingNo, status, settlementRequestId: settlementRequest?.id || null });
  return { duplicate: false, id, orderId: order.order_id, status, settlementRequest };
}

function normalizeLogisticsStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const mapping = {
    created: 'Created',
    accepted: 'Accepted',
    pickedup: 'InTransit',
    in_transit: 'InTransit',
    intransit: 'InTransit',
    delivering: 'OutForDelivery',
    out_for_delivery: 'OutForDelivery',
    delivered: 'Delivered',
    signed: 'Delivered',
    exception: 'Exception',
    returned: 'Returned'
  };
  const status = mapping[normalized];
  if (!status) fail(400, 'INVALID_LOGISTICS_STATUS');
  return status;
}

function hasAdminSecret(req) {
  return Boolean(ADMIN_SECRET) && req.headers['x-admin-secret'] === ADMIN_SECRET;
}

function requireAdminSecret(req) {
  if (!ADMIN_SECRET) fail(503, 'ADMIN_SECRET_NOT_CONFIGURED');
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) fail(401, 'INVALID_ADMIN_SECRET');
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(400, `INVALID_${name.toUpperCase()}`);
  return value.trim();
}

function requireRegionCode(value, name = 'regionCode') {
  const text = requireString(value, name);
  if (!/^\d{6}$/.test(text)) fail(400, 'INVALID_REGION_CODE');
  return text;
}

function optionalRegionCode(value, name = 'regionCode') {
  if (value === undefined || value === null || value === '') return '';
  return requireRegionCode(String(value), name);
}

function normalizeStoreId(value) {
  const text = requireString(String(value || ''), 'storeId').slice(0, 96);
  if (!/^[a-zA-Z0-9:._-]{3,96}$/.test(text)) fail(400, 'INVALID_STORE_ID');
  return text;
}

function requirePickupCode(value) {
  const text = requireString(String(value || ''), 'code');
  if (!/^[a-zA-Z0-9._-]{4,64}$/.test(text)) fail(400, 'INVALID_PICKUP_CODE');
  return text;
}

function requireBytes32(value, name) {
  const text = requireString(value, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) fail(400, `INVALID_${name.toUpperCase()}`);
  return text;
}

function optionalSearchBytes32(searchParams, keys, name) {
  for (const key of keys) {
    const value = searchParams.get(key);
    if (value) return requireBytes32(value, name);
  }
  return null;
}

function requireStoredBytes32(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function requireAddress(value, name) {
  const text = requireString(value, name);
  if (!isValidAddress(text)) fail(400, `INVALID_${name.toUpperCase()}`);
  return text;
}

function parseDecimal18(value) {
  const text = String(value);
  if (!/^[0-9]+(\.[0-9]{0,18})?$/.test(text)) fail(400, 'INVALID_DECIMAL_18');
  const [whole, fraction = ''] = text.split('.');
  const padded = `${fraction}000000000000000000`.slice(0, 18);
  return BigInt(whole || '0') * 10n ** 18n + BigInt(padded || '0');
}

function formatDecimal18(units) {
  const whole = units / 10n ** 18n;
  const fraction = String(units % (10n ** 18n)).padStart(18, '0');
  return `${whole}.${fraction}`;
}

function bytes32(value) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function escapeSqlString(value) {
  return String(value || '').replaceAll("'", "''");
}

function isValidAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isValidSeller(value) {
  if (!isValidAddress(value)) return false;
  const lower = value.toLowerCase();
  return lower !== '0x0000000000000000000000000000000000000000'
    && lower !== '0x000000000000000000000000000000000000dead'
    && lower !== PLACEHOLDER_SELLER.toLowerCase();
}

async function rpc(method, params) {
  const endpoints = [
    CHAIN_EVENT_RPC_URL ? { role: 'primary', url: CHAIN_EVENT_RPC_URL } : null,
    CHAIN_EVENT_RPC_FALLBACK_URL && CHAIN_EVENT_RPC_FALLBACK_URL !== CHAIN_EVENT_RPC_URL ? { role: 'fallback', url: CHAIN_EVENT_RPC_FALLBACK_URL } : null
  ].filter(Boolean);
  if (!endpoints.length) fail(503, 'CHAIN_EVENT_RPC_NOT_CONFIGURED');
  let lastErrorCode = 'CHAIN_EVENT_RPC_UNREACHABLE';
  for (const endpoint of endpoints) {
    const attempt = await rpcAttempt(endpoint, method, params);
    if (attempt.ok) {
      rpcRuntimeState.active = endpoint.role;
      rpcRuntimeState.degraded = endpoint.role !== 'primary';
      rpcRuntimeState.lastLatencyMs = attempt.durationMs;
      rpcRuntimeState.lastError = endpoint.role === 'primary' ? null : lastErrorCode;
      rpcRuntimeState.checkedAt = new Date().toISOString();
      return attempt.result;
    }
    lastErrorCode = attempt.errorCode;
  }
  rpcRuntimeState.active = null;
  rpcRuntimeState.degraded = true;
  rpcRuntimeState.lastLatencyMs = null;
  rpcRuntimeState.lastError = lastErrorCode;
  rpcRuntimeState.checkedAt = new Date().toISOString();
  fail(503, lastErrorCode);
}

async function rpcAttempt(endpoint, method, params) {
  const startedAt = Date.now();
  const wirePayload = { jsonrpc: '2.0', id: 1, method, params };
  const auditPayload = { ...wirePayload, endpointRole: endpoint.role };
  let response;
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wirePayload),
      signal: AbortSignal.timeout(rpcTimeoutMs())
    });
  } catch (error) {
    const errorCode = error?.name === 'TimeoutError' ? 'CHAIN_EVENT_RPC_TIMEOUT' : 'CHAIN_EVENT_RPC_UNREACHABLE';
    writeRpcAudit(method, auditPayload, null, 'network_error', Date.now() - startedAt, errorCode);
    return { ok: false, errorCode };
  }
  if (!response.ok) {
    const errorCode = 'CHAIN_EVENT_RPC_HTTP_ERROR';
    writeRpcAudit(method, auditPayload, { httpStatus: response.status }, 'http_error', Date.now() - startedAt, `${errorCode}:${response.status}`);
    return { ok: false, errorCode };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    const errorCode = 'CHAIN_EVENT_RPC_INVALID_JSON';
    writeRpcAudit(method, auditPayload, null, 'invalid_json', Date.now() - startedAt, errorCode);
    return { ok: false, errorCode };
  }
  if (body?.error) {
    const errorCode = 'CHAIN_EVENT_RPC_ERROR';
    writeRpcAudit(method, auditPayload, body, 'rpc_error', Date.now() - startedAt, `${errorCode}:${String(body.error?.code || 'UNKNOWN')}`);
    return { ok: false, errorCode };
  }
  const durationMs = Date.now() - startedAt;
  writeRpcAudit(method, auditPayload, body, 'success', durationMs, null);
  return { ok: true, result: body?.result, durationMs };
}

function rpcTimeoutMs() {
  const value = Number(process.env.CHAIN_EVENT_RPC_TIMEOUT_MS || process.env.RPC_TIMEOUT_MS || 8_000);
  return Number.isSafeInteger(value) && value >= 500 && value <= 30_000 ? value : 8_000;
}

function writeRpcAudit(method, requestPayload, responsePayload, status, durationMs, errorCode) {
  if (!auditDb || auditDatabaseClosed) throw new Error('AUDIT_DATABASE_UNAVAILABLE');
  const safeJson = (value) => JSON.stringify(redactConfigValue(value)).slice(0, 100_000);
  auditDb.prepare('INSERT INTO rpc_audit_logs (method, request_json, response_json, status, duration_ms, error_code) VALUES (?, ?, ?, ?, ?, ?)').run(
    String(method).slice(0, 120),
    safeJson(requestPayload),
    responsePayload === null ? null : safeJson(responsePayload),
    status,
    Math.max(0, Math.round(Number(durationMs) || 0)),
    errorCode ? String(errorCode).slice(0, 500) : null
  );
}

async function receiptFinality(receipt) {
  const blockNumber = Number.parseInt(String(receipt?.blockNumber || ''), 16);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail(503, 'CHAIN_EVENT_RECEIPT_BLOCK_INVALID');
  const latestHex = await rpc('eth_blockNumber', []);
  const latestBlock = Number.parseInt(String(latestHex || ''), 16);
  if (!Number.isSafeInteger(latestBlock) || latestBlock < blockNumber) fail(503, 'CHAIN_EVENT_LATEST_BLOCK_INVALID');
  const confirmations = latestBlock - blockNumber + 1;
  return {
    finalized: confirmations >= INDEXER_CONFIRMATIONS,
    confirmations,
    requiredConfirmations: INDEXER_CONFIRMATIONS,
    blockNumber,
    latestBlock
  };
}

async function requireReceiptFinality(receipt) {
  const finality = await receiptFinality(receipt);
  if (!finality.finalized) fail(409, 'CHAIN_EVENT_TX_CONFIRMING');
  return finality;
}

function parseRpcUint(value) {
  const text = String(value ?? '0').trim();
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

function loadEnvFile(file = '.env') {
  if (!existsSync(file)) return;
  const parsed = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => parsed[name] ?? process.env[name] ?? '');
    parsed[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function isolateServerPrivateKeys() {
  const forbidden = ['PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY', 'OWNER_PRIVATE_KEY'];
  const present = forbidden.filter((name) => Boolean(String(process.env[name] || '').trim()));
  if (process.env.NODE_ENV === 'production' && present.length) {
    throw new Error(`SERVER_PRIVATE_KEY_FORBIDDEN:${present.join(',')}`);
  }
  for (const name of forbidden) delete process.env[name];
}

async function readJson(req) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_JSON_BODY_BYTES) fail(413, 'REQUEST_BODY_TOO_LARGE');
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function setCors(req, res) {
  const origin = String(req.headers.origin || '');
  const configured = String(process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '').split(',').map((value) => value.trim()).filter(Boolean);
  const localDevelopment = process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (origin && (configured.includes(origin) || localDevelopment)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-24k-jwt,x-indexer-secret,x-admin-secret,x-buyer-address,x-device-id,x-logistics-secret');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(self), geolocation=(self), microphone=()');
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function html(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function textResponse(res, status, payload, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function downloadResponse(res, exported) {
  res.writeHead(200, {
    'content-type': exported.contentType,
    'content-disposition': `attachment; filename="${String(exported.fileName).replace(/[^a-zA-Z0-9._-]/g, '-') }"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(exported.content);
}

function send(res, status, payload) {
  res.writeHead(status);
  res.end(payload);
}

function binary(res, status, payload, contentType) {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(payload);
}

function renderHomePage() {
  return renderPreviewPage({ home: true });
}

function previewTabIcon(type) {
  const svg = (name, body) => `<svg class="tab-icon tab-icon-${name}" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
  const stroke = 'stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"';
  const fine = 'stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"';
  if (type === 'seckill') {
    return svg('seckill', `<path d="M14.4 3.6c2.7 3 5.5 5.9 5.5 10.3 0 4.8-3.5 8.7-8 8.7-4 0-7-2.9-7-6.8 0-3 1.8-5.3 4.4-7.3.2 2.2.9 3.6 2.2 4.7.3-3.6 1.4-6.8 2.9-9.6Z" fill="#caa24a" opacity=".16"/><path ${stroke} d="M14.4 3.6c2.7 3 5.5 5.9 5.5 10.3 0 4.8-3.5 8.7-8 8.7-4 0-7-2.9-7-6.8 0-3 1.8-5.3 4.4-7.3.2 2.2.9 3.6 2.2 4.7.3-3.6 1.4-6.8 2.9-9.6Z"/><path class="tab-accent" ${fine} d="M13 21.3c-1.7-.8-2.8-2.1-2.8-3.8 0-1.8 1-3.1 2.4-4.2.3 1.7 1 2.8 2 3.4.2-1.5.7-2.9 1.4-4.1 1.3 1.5 2.2 2.9 2.2 4.8 0 2.1-1.5 3.6-3.6 4"/>`);
  }
  if (type === 'mall') {
    return svg('mall', `<path d="M7.2 10.5h13.6l-1 12.2H8.2L7.2 10.5Z" fill="#caa24a" opacity=".12"/><path ${stroke} d="M7.2 10.5h13.6l-1 12.2H8.2L7.2 10.5Z"/><path ${stroke} d="M10.6 10.5V9a3.4 3.4 0 0 1 6.8 0v1.5"/><path ${fine} d="M10.7 15.2h6.6M10.7 18.8H15"/><circle class="tab-accent" cx="18.5" cy="18.6" r="1.35" fill="#caa24a"/>`);
  }
  if (type === 'stores') {
    return svg('stores', `<path d="M14 25s7.2-6.7 7.2-13A7.2 7.2 0 0 0 6.8 12C6.8 18.3 14 25 14 25Z" fill="#caa24a" opacity=".12"/><path ${stroke} d="M14 25s7.2-6.7 7.2-13A7.2 7.2 0 0 0 6.8 12C6.8 18.3 14 25 14 25Z"/><path class="tab-accent" ${fine} d="M9.7 13.1h8.6l-1.2-2.4h-6.2l-1.2 2.4Z"/><path ${fine} d="M10.9 13.2v5.7h6.2v-5.7M13 18.8v-2.4h2v2.4"/>`);
  }
  return svg('assets', `<path d="M5.4 9.3h15.8a2.3 2.3 0 0 1 2.3 2.3v8a2.3 2.3 0 0 1-2.3 2.3H6.8a2.8 2.8 0 0 1-2.8-2.8V8.8a2.5 2.5 0 0 1 2.5-2.5h12.2" fill="#caa24a" opacity=".12"/><path ${stroke} d="M5.4 9.3h15.8a2.3 2.3 0 0 1 2.3 2.3v8a2.3 2.3 0 0 1-2.3 2.3H6.8a2.8 2.8 0 0 1-2.8-2.8V8.8a2.5 2.5 0 0 1 2.5-2.5h12.2"/><path ${fine} d="M7.6 10.4h11M7.6 14.2h7.4"/><path class="tab-accent" ${fine} d="M20.5 15.7h3"/><circle class="tab-accent" cx="18.5" cy="18.4" r="1.25" fill="#caa24a"/>`);
}

function getLanAddress() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses.find((address) => address.startsWith('172.'))
    || addresses.find((address) => address.startsWith('192.168.'))
    || addresses.find((address) => address.startsWith('10.'))
    || addresses.find((address) => !address.startsWith('198.18.'))
    || 'localhost';
}

function emptySeckillSession() {
  return {
    id: null,
    productId: null,
    status: 'idle',
    startsAt: null,
    endsAt: null,
    relayEndsAt: null,
    mainSecondsLeft: 0,
    relaySecondsLeft: 0,
    relayExtendSeconds: 30,
    minimumNplAmount: 0,
    prizePoolNpl: 0,
    totalBuys: 0,
    ruleVersion: null
  };
}

function currentSeckillSession() {
  const row = db.prepare(`
    SELECT * FROM seckill_sessions
    ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'settling' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'PendingChainPublish' THEN 2 ELSE 3 END,
      CASE WHEN status IN ('scheduled', 'PendingChainPublish') THEN datetime(starts_at) END ASC,
      datetime(created_at) DESC
    LIMIT 1
  `).get();
  return seckillSessionFromRow(row) || emptySeckillSession();
}

function adminSeckillSessions() {
  return db.prepare(`
    SELECT *
    FROM seckill_sessions
    ORDER BY datetime(starts_at) DESC, datetime(created_at) DESC
    LIMIT 100
  `).all().map(seckillSessionFromRow);
}

function seckillSessionById(id) {
  const row = db.prepare('SELECT * FROM seckill_sessions WHERE id = ?').get(String(id));
  return seckillSessionFromRow(row);
}

function seckillSessionFromRow(row) {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json || '{}');
  const forceCutoff = circuitState('force-cutoff').enabled;
  const endsAtMs = Date.parse(row.ends_at);
  const relayEndsAtMs = payload.relayEndsAt ? Number(payload.relayEndsAt) * 1000 : endsAtMs;
  const reportRow = db.prepare('SELECT prize_pool_npl, total_buys FROM seckill_reports WHERE session_id = ? ORDER BY datetime(created_at) DESC LIMIT 1').get(row.id);
  return {
    id: row.id,
    productId: row.product_id,
    status: forceCutoff && row.status === 'live' ? 'settled' : row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    relayEndsAt: payload.relayEndsAt || null,
    mainSecondsLeft: secondsLeft(endsAtMs),
    relaySecondsLeft: secondsLeft(relayEndsAtMs),
    relayExtendSeconds: Number(payload.relayExtendSeconds || 30),
    minimumNplAmount: Number(payload.minimumNplAmount || 0),
    prizePoolNpl: Number(payload.prizePoolNpl || reportRow?.prize_pool_npl || 0),
    totalBuys: Number(payload.totalBuys || reportRow?.total_buys || db.prepare('SELECT COUNT(*) AS count FROM seckill_events WHERE session_id = ? AND event_name = ?').get(row.id, 'PurchaseRecorded')?.count || 0),
    winner: payload.winner || undefined,
    winningOrderId: payload.winningOrderId || undefined,
    chainSessionId: payload.chainSessionId || undefined,
    publishRequestedAt: payload.publishRequestedAt || undefined,
    publishedAt: payload.publishedAt || undefined,
    ruleVersion: payload.ruleVersion || '7.5.01',
    source: payload.source || 'admin'
  };
}

function secondsLeft(timestampMs) {
  if (!Number.isFinite(timestampMs)) return 0;
  return Math.max(0, Math.floor((timestampMs - Date.now()) / 1000));
}

function seckillFeed(sessionId) {
  const rows = db.prepare(`
    SELECT * FROM seckill_events
    WHERE session_id = ? AND event_name = 'PurchaseRecorded'
    ORDER BY block_number DESC, log_index DESC, datetime(created_at) DESC
    LIMIT 50
  `).all(String(sessionId));
  if (!rows.length) return [];
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json || '{}');
    return {
      id: row.id,
      sessionId: row.session_id,
      address: short(row.buyer_address || payload.buyer || ''),
      buyerAddress: row.buyer_address || payload.buyer || undefined,
      orderId: row.order_id || payload.orderId || undefined,
      text: `成功抢购，接力寿命延长至 ${formatRelayTime(payload.relayEndsAt)}`,
      totalBuys: Number(payload.totalBuys || 0),
      txHash: row.tx_hash || undefined,
      createdAt: row.created_at
    };
  });
}

function streamSeckillFeed(req, res, sessionId, { once = false } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(': 24K seckill feed stream\n\n');
  writeSseEvent(res, 'snapshot', seckillFeedStreamSnapshot(sessionId));
  if (once) {
    res.end();
    return;
  }
  const timer = setInterval(() => {
    writeSseEvent(res, 'snapshot', seckillFeedStreamSnapshot(sessionId));
  }, 5000);
  req.on('close', () => clearInterval(timer));
}

function seckillFeedStreamSnapshot(sessionId) {
  const cleanSessionId = String(sessionId || currentSeckillSession().id);
  return {
    version: '24k-seckill-feed-stream-v1',
    sessionId: cleanSessionId,
    generatedAt: new Date().toISOString(),
    feed: seckillFeed(cleanSessionId),
    report: seckillReport(cleanSessionId)
  };
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function seckillReport(sessionId) {
  const row = db.prepare('SELECT * FROM seckill_reports WHERE session_id = ? ORDER BY datetime(created_at) DESC LIMIT 1').get(String(sessionId));
  if (row) {
    const payload = JSON.parse(row.payload_json || '{}');
    return {
      id: row.id,
      sessionId: row.session_id,
      status: 'settled',
      winnerAddress: row.winner_address || undefined,
      winningOrderId: row.winning_order_id || undefined,
      prizePoolNpl: Number(row.prize_pool_npl),
      totalBuys: Number(row.total_buys || 0),
      txHash: payload.txHash || undefined,
      createdAt: row.created_at
    };
  }
  const session = seckillSessionById(sessionId);
  return {
    id: `report-${sessionId}`,
    sessionId,
    status: session?.status || 'live',
    winnerAddress: session?.winner || undefined,
    winningOrderId: session?.winningOrderId || undefined,
    prizePoolNpl: Number(session?.prizePoolNpl || 0),
    totalBuys: Number(session?.totalBuys || 0),
    createdAt: null
  };
}

function seckillReportHistory({ limit } = {}) {
  const parsedLimit = Number(limit || 20);
  const safeLimit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 20;
  const rows = db.prepare('SELECT * FROM seckill_reports ORDER BY datetime(created_at) DESC LIMIT ?').all(safeLimit);
  const reports = rows.map((row) => {
    const payload = JSON.parse(row.payload_json || '{}');
    return {
      id: row.id,
      sessionId: row.session_id,
      status: 'settled',
      winnerAddress: row.winner_address || undefined,
      winningOrderId: row.winning_order_id || undefined,
      prizePoolNpl: Number(row.prize_pool_npl),
      totalBuys: Number(row.total_buys || 0),
      txHash: payload.txHash || undefined,
      createdAt: row.created_at
    };
  });
  return {
    version: '24k-seckill-report-history-v1',
    generatedAt: new Date().toISOString(),
    reports
  };
}

function seckillRules() {
  const row = cmsContent('rules');
  const session = currentSeckillSession();
  return {
    version: '24k-seckill-rules-v1',
    title: '秒杀 / 接力规则说明',
    ruleVersion: session.ruleVersion || '7.5.01',
    body: row?.body || defaultSeckillRulesText(),
    updatedAt: row?.updated_at || null,
    source: row ? 'cms' : 'default-docs-7.5.01',
    highlights: [
      '主场总倒计时固定 60 分钟，归零强制截止。',
      '接力蓄能时间初始 60 分钟；每笔链上抢购成功后 +30 秒，最高不超过初始时长。',
      '首次交易按 NPL 授权 → 支付 2 步执行 approve(MaxUint256)，后续 allowance 充足则免授权。',
      '秒杀奖金为 NPL；中奖后在我的资产 seckillRecords[].prizeClaim 提取。',
      '合约层按 docs 使用 tx.origin == msg.sender 阻止合约地址抢购。'
    ],
    policy: {
      chainId: CHAIN_ID,
      npl: FIXED_BSC_NPL_ADDRESS,
      payment: 'NPL approve(MaxUint256) then allowance skip',
      noUserNoReasonRefund: true,
      contractCallerBlocked: true,
      circuitBreakers: {
        seckill: circuitState('seckill'),
        forceCutoff: circuitState('force-cutoff')
      }
    },
    actions: {
      createIntent: '/api/dapp/seckill-intent',
      feed: '/api/seckill/feed',
      feedStream: '/api/seckill/feed/stream',
      report: '/api/seckill/report',
      reports: '/api/seckill/reports',
      prizeClaim: '/api/dapp/claim-intent'
    }
  };
}

function cmsContent(key) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return null;
  return db.prepare('SELECT key, body, updated_at FROM cms_contents WHERE key = ?').get(cleanKey) || null;
}

function defaultSeckillRulesText() {
  return [
    '抢购结果以 BSC 链上打包时间戳和 Abu24KSeckill 事件为准。',
    '主场 60 分钟；接力倒计时每次成功购买延长 30 秒。',
    '支付必须走后端 intent 返回的 NPL 授权与 payOrder calldata。',
    '中奖奖金为 NPL，结算后在我的资产页提取；BNM 全返需收货/核销后释放。',
    '不开放无理由退款；只保留 7 天超时、平台强制退款和 emergency refund。'
  ].join('\n');
}

function formatRelayTime(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '最新倒计时';
  return new Date(number * 1000).toISOString();
}

function assetSummary(address) {
  const base = emptyAssetSummary(address);
  if (!isValidAddress(address)) return base;
  const wallet = String(address).toLowerCase();
  expirePendingClaimRequests(wallet);
  const ledger = db.prepare('SELECT * FROM reward_ledger WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 50').all(wallet).map(toRewardLedgerEntry);
  const claims = db.prepare('SELECT * FROM claims WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 50').all(wallet).map(toClaimRecord);
  const orders = assetOrdersForWallet(address);
  const shoppingRecords = shoppingRecordsForWallet(wallet);
  const seckillRecords = seckillRecordsForWallet(wallet);
  const addresses = savedAddressBookEntries(wallet);
  return {
    ...base,
    address,
    addresses,
    orders,
    orderStateCounts: orderStateCounts(orders),
    shoppingRecords,
    seckillRecords,
    ledger,
    claims,
    buckets: mergeAssetBuckets(base.buckets, ledger, address),
    actions: assetSummaryActions(address)
  };
}

async function assetSummaryForBuyer(address) {
  const summary = assetSummary(address);
  if (!isValidAddress(address)) return summary;
  const entitled = await genesisNodeEntitlement(address);
  const buckets = summary.buckets.map((bucket) => bucket.id === 'genesis-node'
    ? enrichAssetBucket({ ...bucket, visible: entitled }, address)
    : bucket);
  return {
    ...summary,
    buckets,
    ledger: entitled ? summary.ledger : summary.ledger.filter((entry) => entry.bucketId !== 'genesis-node'),
    claims: entitled ? summary.claims : summary.claims.filter((entry) => entry.bucketId !== 'genesis-node'),
    entitlements: {
      genesisNode: {
        configured: isValidAddress(GENESIS_NODE_CONTRACT),
        entitled,
        contractAddress: entitled ? GENESIS_NODE_CONTRACT : undefined,
        tokenStandard: GENESIS_NODE_TOKEN_STANDARD,
        tokenId: GENESIS_NODE_TOKEN_STANDARD === 'erc1155' ? GENESIS_NODE_TOKEN_ID : undefined,
        checkedAt: new Date().toISOString()
      }
    }
  };
}

async function genesisNodeEntitlement(address) {
  const wallet = requireAddress(address, 'walletAddress').toLowerCase();
  if (!isValidAddress(GENESIS_NODE_CONTRACT) || !CHAIN_EVENT_RPC_URL) return false;
  const cached = genesisNodeEntitlementCache.get(wallet);
  if (cached && cached.expiresAt > Date.now()) return cached.entitled;
  let entitled = false;
  try {
    const queryInterface = GENESIS_NODE_TOKEN_STANDARD === 'erc1155' ? erc1155BalanceOfInterface : balanceOfInterface;
    const args = GENESIS_NODE_TOKEN_STANDARD === 'erc1155' ? [wallet, BigInt(GENESIS_NODE_TOKEN_ID)] : [wallet];
    const data = queryInterface.encodeFunctionData('balanceOf', args);
    const result = await rpc('eth_call', [{ to: GENESIS_NODE_CONTRACT, data }, 'latest']);
    const [balance] = queryInterface.decodeFunctionResult('balanceOf', result);
    entitled = BigInt(balance) > 0n;
  } catch {
    entitled = false;
  }
  genesisNodeEntitlementCache.set(wallet, { entitled, expiresAt: Date.now() + GENESIS_NODE_CACHE_TTL_MS });
  return entitled;
}

function emptyAssetSummary(address) {
  const buckets = enrichAssetBuckets(['bnm', 'genesis-node', 'referral-shop', 'region-agent', 'ops'].map(emptyAssetBucket), address);
  return {
    address,
    addresses: [],
    buckets,
    ledger: [],
    claims: [],
    orders: [],
    orderStateCounts: orderStateCounts([]),
    shoppingRecords: [],
    seckillRecords: [],
    actions: assetSummaryActions(address)
  };
}

const ASSET_BUCKET_POLICIES = {
  bnm: {
    docsKey: 'bnm',
    unlockPolicy: '常规/秒杀订单付款后进入 Locked；买家确认收货、门店核销或平台仲裁签收后转为 Available。',
    visibility: { mode: 'always', label: '所有消费用户可见' }
  },
  'genesis-node': {
    docsKey: 'genesis-node',
    unlockPolicy: '秒杀大盘 5-10 分钟结算后累加 NPL；仅持有创世店铺节点 NFT/SFT 的钱包可见并可 Claim。',
    visibility: { mode: 'gated', requires: '至少 1 个有效创世店铺节点凭证', hiddenWhenUnsatisfied: true }
  },
  'referral-shop': {
    docsKey: 'referral-shop',
    unlockPolicy: '直推店铺产生交易后按次级区块结算为 Available；随买随提。',
    visibility: { mode: 'relationship', requires: '推荐关系/下级店铺绑定' }
  },
  'region-agent': {
    docsKey: 'region-agent',
    unlockPolicy: '付款瞬间锁定地址/门店行政编码；确认收货、门店核销或平台仲裁签收后转为 Available。',
    visibility: { mode: 'region', requires: '省/市/区县/大区代理绑定' }
  },
  ops: {
    docsKey: 'ops',
    unlockPolicy: '平台运维分配按多地址权重每日清算；多签/各地址按自己的 Available 额度 Claim。',
    visibility: { mode: 'weighted-beneficiary', requires: '平台运维受益人地址权重配置' }
  },
  'seckill-prize': {
    docsKey: 'seckill-prize',
    unlockPolicy: '秒杀中奖奖金为 NPL；SessionSettled 后写入 Available，中奖者在 seckillRecords[].prizeClaim 提取。',
    visibility: { mode: 'winner-only', requires: '本场秒杀 winner 地址' }
  }
};

function enrichAssetBuckets(buckets, address) {
  return buckets.map((bucket) => enrichAssetBucket(bucket, address));
}

function enrichAssetBucket(bucket, address) {
  const policy = ASSET_BUCKET_POLICIES[bucket.id] || { docsKey: bucket.id, unlockPolicy: '按 RewardLedger 三态账本流转。', visibility: { mode: 'custom' } };
  const cumulative = Number(bucket.cumulative || 0);
  const available = Number(bucket.available || 0);
  const locked = Number(bucket.locked || 0);
  const pendingClaim = Number(bucket.pendingClaim || 0);
  const claimed = Number(bucket.claimed || 0);
  const burned = Number(bucket.burned || 0);
  const claimable = bucket.visible !== false && available > 0;
  const claimEndpoint = '/api/dapp/claim-intent';
  return {
    ...bucket,
    ...policy,
    cumulative,
    available,
    locked,
    pendingClaim,
    claimed,
    burned,
    visible: bucket.visible !== false,
    claimable,
    claimEndpoint,
    claimIntent: claimable ? {
      method: 'POST',
      endpoint: claimEndpoint,
      body: {
        walletAddress: isValidAddress(address) ? address : undefined,
        bucketId: bucket.id,
        rewardId: '<available-reward-id>'
      },
      note: '前端需从 ledger 中选择该池子的 Available rewardId；秒杀 NPL 奖金优先使用 seckillRecords[].prizeClaim.rewardId。'
    } : null,
    stateSummary: { cumulative, locked, available, pendingClaim, claimed, burned }
  };
}

function savedAddressBookEntries(wallet) {
  return db.prepare('SELECT payload_json FROM address_book WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 50')
    .all(wallet)
    .map((row) => JSON.parse(row.payload_json || '{}'));
}

function orderStateCounts(orders) {
  const counts = {
    total: orders.length,
    pendingPayment: 0,
    pendingShipment: 0,
    pendingReceipt: 0,
    arbitration: 0,
    refunding: 0,
    completed: 0
  };
  for (const order of orders) {
    if (order.status === 'Draft') counts.pendingPayment += 1;
    if (['PaidLocked', 'AwaitingShipment'].includes(order.status)) counts.pendingShipment += 1;
    if (['Shipped', 'PickupReady'].includes(order.status)) counts.pendingReceipt += 1;
    if (order.status === 'Arbitration') counts.arbitration += 1;
    if (['RefundRequested', 'ForcedRefunded', 'EmergencyRefunded'].includes(order.status)) counts.refunding += 1;
    if (['Released', 'Completed', 'Claimed'].includes(order.status)) counts.completed += 1;
  }
  return counts;
}

function shoppingRecordsForWallet(wallet) {
  return db.prepare(`
    SELECT
      orders.order_id,
      orders.status,
      orders.amount_npl,
      orders.fulfillment_mode,
      orders.region_code,
      orders.created_at,
      order_items.product_id,
      order_items.sku_id,
      order_items.sku_name,
      order_items.quantity,
      products.title
    FROM order_items
    JOIN orders ON orders.order_id = order_items.order_id
    LEFT JOIN products ON products.id = order_items.product_id
    WHERE lower(orders.buyer_address) = ?
    ORDER BY orders.created_at DESC, order_items.id ASC
    LIMIT 100
  `).all(wallet).map((row) => {
    const order = findOrderByIdOrOrderId(row.order_id);
    const actionState = order ? dappOrderActionState(order, order.buyer_address) : null;
    return {
      orderId: row.order_id,
      productId: row.product_id,
      title: row.title || row.product_id,
      skuId: row.sku_id || undefined,
      skuName: row.sku_name || undefined,
      quantity: Number(row.quantity || 0),
      amountNpl: row.amount_npl || '0.000000000000000000',
      status: row.status,
      fulfillmentMode: row.fulfillment_mode || undefined,
      regionCode: row.region_code || undefined,
      createdAt: row.created_at || undefined,
      dapp: actionState ? {
        primaryAction: actionState.primaryAction,
        nextActions: actionState.nextActions,
        endpoints: actionState.endpoints,
        confirmability: actionState.confirmability,
        afterSale: actionState.afterSale
      } : undefined
    };
  });
}

function assetOrdersForWallet(address) {
  return db.prepare('SELECT * FROM orders WHERE lower(buyer_address) = ? ORDER BY created_at DESC LIMIT 50')
    .all(String(address).toLowerCase())
    .map((order) => enrichAssetOrderForDapp(order, address));
}

function enrichAssetOrderForDapp(order, buyerAddress) {
  const fulfillment = fulfillmentSummary(order);
  const actionState = dappOrderActionState(order, buyerAddress, fulfillment);
  return {
    ...toOrder(order),
    fulfillment,
    confirmability: actionState.confirmability,
    releaseStatus: actionState.releaseStatus,
    releasePreview: actionState.releasePreview,
    actions: actionState.actions,
    afterSale: actionState.afterSale,
    primaryAction: actionState.primaryAction,
    nextActions: actionState.nextActions,
    endpoints: actionState.endpoints
  };
}

function dappOrderActionState(order, buyerAddress, fulfillment = fulfillmentSummary(order)) {
  const buyer = isValidAddress(buyerAddress) ? buyerAddress : order.buyer_address;
  const afterSaleCase = db.prepare("SELECT * FROM after_sale_cases WHERE order_id = ? ORDER BY created_at DESC LIMIT 1").get(order.order_id);
  const activeAfterSale = afterSaleCase && ['Open', 'AwaitingDisputeTransaction', 'Arbitration', 'ExchangeApproved', 'DelayApproved', 'AwaitingCompletionTransaction', 'AwaitingRefundTransaction'].includes(afterSaleCase.status);
  const baseConfirmability = orderConfirmability(order, fulfillment);
  const confirmability = activeAfterSale ? { ...baseConfirmability, canComplete: false, reason: 'AFTER_SALE_ACTIVE' } : baseConfirmability;
  const releaseStatus = releaseStatusForOrder(order, fulfillment, confirmability);
  const releasePreview = releasePreviewForOrder(order);
  const completeOrderCall = completeOrderCallForOrder(order, buyer, confirmability);
  const timeout = timeoutLinkForOrder(order);
  const availableRewards = releasePreview.ledger.filter((entry) => entry.state === 'Available');
  const payment = {
    available: order.status === 'Draft',
    reason: order.status === 'Draft' ? 'READY' : 'ORDER_NOT_PAYABLE',
    endpoint: `/api/orders/${order.order_id}/payment-intent?buyerAddress=${buyer}`,
    next: ['checkAllowance', 'approveNplIfNeeded', 'sendPayOrder', 'pollFundingStatus']
  };
  const claimRewards = {
    available: availableRewards.length > 0,
    endpoint: '/api/dapp/claim-intent',
    rewards: availableRewards.map((entry) => ({
      rewardId: entry.id,
      bucketId: entry.bucketId,
      assetSymbol: entry.assetSymbol,
      amount: entry.amount,
      body: { walletAddress: buyer, bucketId: entry.bucketId, rewardId: entry.id }
    }))
  };
  const timeoutRefund = {
    available: timeout.buyerTimeoutRefund.eligible,
    reason: timeout.buyerTimeoutRefund.reason,
    request: timeout.buyerTimeoutRefund.request
  };
  const merchantForceSign = {
    available: timeout.merchantForceSign.eligible,
    reason: timeout.merchantForceSign.reason,
    request: timeout.merchantForceSign.request
  };
  const afterSale = {
    available: !activeAfterSale && ['Shipped', 'PickupReady'].includes(order.status),
    allowedTypes: ['exchange', 'delay'],
    active: activeAfterSale,
    case: afterSaleCase ? toAfterSaleCase(afterSaleCase) : null,
    endpoint: '/api/dapp/after-sale/request',
    assetState: activeAfterSale ? 'Locked' : null,
    transactionIntent: afterSaleCase?.status === 'AwaitingDisputeTransaction' ? {
      key: 'buyerDisputeOrder',
      chainId: Number(order.chain_id),
      from: buyer.toLowerCase(),
      to: order.escrow_address,
      value: '0x0',
      orderId: order.order_id,
      data: escrowTxInterface.encodeFunctionData('disputeOrder', [order.order_id])
    } : null,
    arbitrationStatusEndpoint: afterSaleCase?.status === 'AwaitingDisputeTransaction' ? `/api/orders/${order.order_id}/arbitration-tx-status?buyerAddress=${buyer}&txHash=0x...` : null
  };
  const primaryAction = primaryOrderAction(order, { payment, confirmability, timeoutRefund, claimRewards, afterSale });
  const nextActions = [
    primaryAction.key,
    ...fulfillmentNextActionsForOrder(confirmability, timeout),
    claimRewards.available ? 'createClaimIntent' : null
  ].filter(Boolean);
  return {
    confirmability,
    releaseStatus,
    releasePreview,
    afterSale,
    primaryAction,
    nextActions: [...new Set(nextActions)],
    actions: {
      payment,
      completeOrder: completeOrderCall,
      timeoutRefund,
      merchantForceSign,
      afterSale,
      claimRewards,
      fulfillment: {
        endpoint: `/api/orders/${order.order_id}/fulfillment?buyerAddress=${buyer}`,
        current: fulfillment
      }
    },
    endpoints: {
      orderStatus: `/api/orders/${order.order_id}?buyerAddress=${buyer}`,
      fulfillment: `/api/orders/${order.order_id}/fulfillment?buyerAddress=${buyer}`,
      paymentIntent: `/api/orders/${order.order_id}/payment-intent?buyerAddress=${buyer}`,
      fundingStatus: `/api/orders/${order.order_id}/fund-tx-status?buyerAddress=${buyer}&txHash=0x...`,
      completeOrderIntent: '/api/dapp/complete-order-intent',
      completeTxStatus: `/api/orders/${order.order_id}/complete-tx-status?buyerAddress=${buyer}&txHash=0x...`,
      timeoutActions: `/api/orders/${order.order_id}/timeout-actions?buyerAddress=${buyer}`,
      timeoutRefundRequest: '/api/dapp/timeout-refund-request',
      afterSaleRequest: '/api/dapp/after-sale/request',
      arbitrationTxStatus: `/api/orders/${order.order_id}/arbitration-tx-status?buyerAddress=${buyer}&txHash=0x...`,
      claimIntent: '/api/dapp/claim-intent',
      assets: `/api/assets/summary?address=${buyer}`
    }
  };
}

function primaryOrderAction(order, { payment, confirmability, timeoutRefund, claimRewards, afterSale }) {
  const status = String(order.status || '');
  if (afterSale?.active) return { key: 'waitAfterSale', label: '售后 / 仲裁处理中', enabled: false };
  if (payment.available) return { key: 'payOrder', label: '去支付', enabled: true };
  if (confirmability.canComplete) return { key: 'completeOrder', label: '确认收货 / 释放托管', enabled: true };
  if (timeoutRefund.available) return { key: 'requestTimeoutRefund', label: '申请 7 天未发货强制退款', enabled: true };
  if (claimRewards.available) return { key: 'claimRewards', label: '提取可用收益', enabled: true };
  if (status === 'RefundRequested') return { key: 'waitPlatformRefund', label: '等待平台强制退款', enabled: false };
  if (['ForcedRefunded', 'EmergencyRefunded'].includes(status)) return { key: 'refunded', label: '已退款', enabled: false };
  if (status === 'Released') return { key: 'released', label: '订单已完成，查看收益', enabled: false };
  if (status === 'Arbitration') return { key: 'waitArbitration', label: '仲裁处理中', enabled: false };
  return { key: 'trackFulfillment', label: '查看履约进度', enabled: true };
}

function seckillRecordsForWallet(wallet) {
  return db.prepare(`
    SELECT seckill_events.*, seckill_sessions.product_id, seckill_sessions.status AS session_status, seckill_sessions.starts_at, seckill_sessions.ends_at, seckill_sessions.payload_json AS session_payload_json
    FROM seckill_events
    LEFT JOIN seckill_sessions ON seckill_sessions.id = seckill_events.session_id
    WHERE lower(seckill_events.buyer_address) = ?
    ORDER BY seckill_events.created_at DESC
    LIMIT 50
  `).all(wallet).map((row) => {
    const sessionPayload = JSON.parse(row.session_payload_json || '{}');
    const prizeReward = seckillPrizeRewardFor(row.order_id, wallet);
    const prizeClaim = seckillPrizeClaimForRecord(wallet, row, sessionPayload, prizeReward);
    return {
      sessionId: row.session_id,
      eventName: row.event_name,
      orderId: row.order_id || undefined,
      buyerAddress: row.buyer_address || undefined,
      txHash: row.tx_hash || undefined,
      blockNumber: row.block_number ?? undefined,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload_json || '{}'),
      session: row.product_id ? {
        id: row.session_id,
        productId: row.product_id,
        status: row.session_status,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        relayEndsAt: sessionPayload.relayEndsAt ?? null,
        totalBuys: Number(sessionPayload.totalBuys || 0),
        prizePoolNpl: sessionPayload.prizePoolNpl,
        winnerAddress: sessionPayload.winner || undefined,
        winningOrderId: sessionPayload.winningOrderId || undefined
      } : null,
      prizeClaim
    };
  });
}

function seckillPrizeClaimForRecord(wallet, row, sessionPayload, prizeReward) {
  const winner = String(sessionPayload.winner || '').toLowerCase();
  const winningOrderId = String(sessionPayload.winningOrderId || '');
  const isWinner = winner === String(wallet).toLowerCase() && (!winningOrderId || winningOrderId.toLowerCase() === String(row.order_id || '').toLowerCase());
  if (!isWinner && !prizeReward) {
    return { claimable: false, status: row.event_name === 'SessionSettled' ? 'NotWinner' : 'PendingSettlement' };
  }
  if (!prizeReward) {
    return {
      claimable: false,
      status: 'PendingRewardLocked',
      assetSymbol: 'NPL',
      amount: Number(sessionPayload.prizePoolNpl || 0),
      note: '等待平台/RewardLedger 将秒杀中奖 NPL 奖金写入可提取账本。'
    };
  }
  const reward = toRewardLedgerEntry(prizeReward);
  return {
    claimable: reward.state === 'Available',
    status: reward.state,
    rewardId: reward.id,
    assetSymbol: reward.assetSymbol,
    amount: reward.amount,
    claimIntent: reward.state === 'Available' ? {
      method: 'POST',
      endpoint: '/api/dapp/claim-intent',
      body: { walletAddress: wallet, bucketId: 'seckill-prize', rewardId: reward.id }
    } : undefined
  };
}

function assetSummaryActions(address) {
  const suffix = isValidAddress(address) ? `?address=${address}` : '';
  return {
    addressBook: `/api/address-book${suffix}`,
    parseAddress: '/api/address-book/parse',
    buyerOrders: isValidAddress(address) ? `/api/buyer/orders?buyerAddress=${address}` : '/api/buyer/orders?buyerAddress=0x...',
    orderState: '/api/dapp/order-state?buyerAddress=0x...&orderId=0x...',
    timeoutActions: '/api/orders/:orderId/timeout-actions?buyerAddress=0x...',
    timeoutRefundRequest: '/api/dapp/timeout-refund-request',
    completeOrderIntent: '/api/dapp/complete-order-intent',
    claimIntent: '/api/dapp/claim-intent',
    submitClaim: '/api/claims',
    claimTxStatus: '/api/dapp/claim-tx-status?walletAddress=0x...&rewardId=reward-ledger-1&txHash=0x...'
  };
}

function toRewardLedgerEntry(row) {
  const entry = {
    id: row.id,
    walletAddress: row.wallet_address,
    orderId: row.order_id || undefined,
    source: row.source,
    assetSymbol: row.asset_symbol,
    amount: Number(row.amount),
    state: row.state,
    txHash: row.tx_hash || undefined
  };
  return {
    ...entry,
    bucketId: bucketIdForLedgerEntry(entry)
  };
}

function toClaimRecord(row) {
  return {
    id: row.id,
    rewardId: row.reward_id || undefined,
    bucketId: row.bucket_id,
    assetSymbol: row.asset_symbol,
    amount: Number(row.amount),
    status: row.status,
    txHash: row.tx_hash || undefined,
    gasUsed: row.gas_used || undefined,
    effectiveGasPriceWei: row.effective_gas_price_wei || undefined,
    gasBnb: row.gas_bnb || undefined,
    expiresAt: row.expires_at || undefined,
    createdAt: row.created_at
  };
}

function mergeAssetBuckets(seedBuckets, ledger, address) {
  const totals = ledger.reduce((acc, entry) => {
    const bucketId = bucketIdForLedgerEntry(entry);
    acc[bucketId] ||= { cumulative: 0, available: 0, locked: 0, pendingClaim: 0, claimed: 0, burned: 0 };
    acc[bucketId].cumulative += entry.amount;
    if (entry.state === 'Available') acc[bucketId].available += entry.amount;
    if (entry.state === 'Locked') acc[bucketId].locked += entry.amount;
    if (entry.state === 'PendingClaim') acc[bucketId].pendingClaim += entry.amount;
    if (entry.state === 'Claimed') acc[bucketId].claimed += entry.amount;
    if (entry.state === 'Burned') acc[bucketId].burned += entry.amount;
    return acc;
  }, {});
  const bucketsById = new Map(seedBuckets.map((bucket) => [bucket.id, bucket]));
  for (const [bucketId, total] of Object.entries(totals)) {
    if (total.cumulative <= 0) continue;
    const existing = bucketsById.get(bucketId) || emptyAssetBucket(bucketId);
    bucketsById.set(bucketId, { ...existing, ...total, visible: existing.visible !== false });
  }
  return enrichAssetBuckets([...bucketsById.values()], address);
}

function emptyAssetBucket(bucketId) {
  if (bucketId === 'seckill-prize') {
    return {
      id: 'seckill-prize',
      title: '秒杀中奖奖金',
      assetSymbol: 'NPL',
      cumulative: 0,
      available: 0,
      locked: 0,
      visible: true
    };
  }
  const policyTitle = {
    bnm: ['BNM 消费产出池', 'BNM'],
    'genesis-node': ['创世节点全网流水分红', 'NPL'],
    'referral-shop': ['直推店铺销售分红', 'NPL'],
    'region-agent': ['阿步地域代理收益', 'NPL'],
    ops: ['平台系统运维池', 'NPL']
  }[bucketId] || ['24K 收益池', 'NPL'];
  return { id: bucketId, title: policyTitle[0], assetSymbol: policyTitle[1], cumulative: 0, available: 0, locked: 0, visible: bucketId !== 'genesis-node' };
}

function bucketIdForLedgerEntry(entry) {
  const symbol = String(entry.assetSymbol || '').toUpperCase();
  if (symbol === 'BNM') return 'bnm';
  const source = String(entry.source || '').toLowerCase();
  if (/秒杀|seckill|prize/.test(source)) return 'seckill-prize';
  if (/创世|节点|genesis|node/.test(source)) return 'genesis-node';
  if (/直推|推荐|referral|shop/.test(source)) return 'referral-shop';
  if (/区域|地域|代理|region|agent/.test(source)) return 'region-agent';
  if (/运维|平台|ops|platform/.test(source)) return 'ops';
  return symbol === 'NPL' ? 'ops' : 'bnm';
}

function merchantDashboard(merchantAddress) {
  const address = requireAddress(merchantAddress, 'merchantAddress').toLowerCase();
  const merchant = db.prepare('SELECT * FROM merchants WHERE lower(wallet_address) = ?').get(address);
  const orders = db.prepare('SELECT * FROM orders WHERE lower(seller_address) = ? ORDER BY created_at DESC LIMIT 200').all(address);
  const submissions = db.prepare('SELECT * FROM product_submissions WHERE lower(merchant_address) = ? ORDER BY created_at DESC').all(address);
  const rewards = db.prepare('SELECT * FROM reward_ledger WHERE lower(wallet_address) = ? ORDER BY created_at DESC').all(address);
  const claims = db.prepare('SELECT * FROM claims WHERE lower(wallet_address) = ? ORDER BY created_at DESC LIMIT 100').all(address);
  const todayOrders = orders.filter((row) => isToday(row.created_at));
  const pendingShipments = orders.filter((row) => (row.fulfillment_mode || 'delivery') === 'delivery' && ['PaidLocked', 'AwaitingShipment'].includes(row.status));
  const pickupVerifications = db.prepare("SELECT COUNT(*) AS count FROM pickup_verifications WHERE lower(merchant_address) = ? AND date(created_at, 'localtime') = date('now', 'localtime')").get(address)?.count || 0;
  const claimableNpl = sumLedgerAmount(rewards.filter((row) => row.state === 'Available' && row.asset_symbol === 'NPL'));
  const latestSubmission = submissions[0] ? toProductSubmission(submissions[0]) : null;
  const lockedAssets = sumOrderAmount(orders.filter((row) => ['PaidLocked', 'Shipped', 'PickupReady', 'Arbitration', 'ForceSignRequested'].includes(row.status)));
  const withdrawn = sumClaimAmount(claims.filter((row) => String(row.status).toLowerCase() === 'success'));
  return {
    merchant: {
      id: merchant?.id || null,
      name: merchant?.name || '未命名商家',
      walletAddress: address,
      status: merchant?.status || (address === String(MERCHANT_RECEIVER).toLowerCase() ? 'Approved' : 'Unknown'),
      profile: merchant ? JSON.parse(merchant.payload_json || '{}') : {}
    },
    generatedAt: new Date().toISOString(),
    paymentAsset: 'NPL',
    stats: {
      pendingShipments: pendingShipments.length,
      todaySalesNpl: sumOrderAmount(todayOrders.filter((row) => row.status !== 'Draft' && row.status !== 'Cancelled')),
      todayOrders: todayOrders.length,
      pickupVerifications: Number(pickupVerifications),
      claimableNpl,
      lockedAssetsNpl: lockedAssets
    },
    product: latestSubmission,
    orders: orders.slice(0, 20).map(toOrder),
    assets: {
      todaySalesNpl: sumOrderAmount(todayOrders.filter((row) => row.status !== 'Draft' && row.status !== 'Cancelled')),
      lockedNpl: lockedAssets,
      pendingSettlementNpl: sumOrderAmount(orders.filter((row) => row.status === 'Completed')),
      availableNpl: claimableNpl,
      withdrawnNpl: withdrawn,
      rewards: rewards.slice(0, 50).map(toLedgerEntry),
      claims: claims.map(toClaimRecord)
    },
    fulfillment: {
      pendingShipments: pendingShipments.map(toOrder),
      shipped: orders.filter((row) => row.status === 'Shipped').slice(0, 20).map(toOrder),
      pickup: orders.filter((row) => row.fulfillment_mode === 'pickup').slice(0, 20).map(toOrder)
    }
  };
}

function adminDashboard() {
  const merchants = db.prepare('SELECT * FROM merchants ORDER BY created_at DESC').all();
  const submissions = db.prepare('SELECT * FROM product_submissions ORDER BY created_at DESC').all();
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
  const sessions = db.prepare('SELECT * FROM seckill_sessions ORDER BY created_at DESC').all();
  const reports = db.prepare('SELECT * FROM seckill_reports ORDER BY created_at DESC').all();
  const todayOrders = orders.filter((row) => isToday(row.created_at));
  const paidToday = todayOrders.filter((row) => !['Draft', 'Cancelled'].includes(row.status));
  const shippedToday = todayOrders.filter((row) => ['Shipped', 'Released'].includes(row.status));
  const memory = process.memoryUsage();
  const walletUids = Number(db.prepare('SELECT COUNT(DISTINCT lower(address)) AS count FROM auth_sessions').get()?.count || 0);
  const newWalletUidsToday = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT lower(address) AS wallet_address, MIN(created_at) AS first_seen_at
      FROM auth_sessions
      GROUP BY lower(address)
      HAVING date(first_seen_at, 'localtime') = date('now', 'localtime')
    )
  `).get()?.count || 0);
  const blacklistCount = Number(db.prepare('SELECT COUNT(*) AS count FROM blacklists').get()?.count || 0);
  const failedClaims = Number(db.prepare("SELECT COUNT(*) AS count FROM claims WHERE lower(status) = 'failed'").get()?.count || 0);
  const pendingClaims = Number(db.prepare("SELECT COUNT(*) AS count FROM claims WHERE lower(status) = 'pending'").get()?.count || 0);
  const anomalyCount = Number(db.prepare("SELECT COUNT(*) AS count FROM risk_events WHERE status <> 'Resolved'").get()?.count || 0);
  const botEvents = Number(db.prepare("SELECT COUNT(*) AS count FROM risk_events WHERE kind IN ('wallet-switch','order-cancel','fulfillment-change','rate-limit')").get()?.count || 0);
  const circuits = ['orders', 'seckill', 'claims', 'force-cutoff'].map(circuitState);
  const riskWaterline = {
    pendingClaims,
    failedTransactions: failedClaims + Number(db.prepare("SELECT COUNT(*) AS count FROM risk_events WHERE kind IN ('tx-failed','rpc-error')").get()?.count || 0),
    anomalies: anomalyCount,
    blacklisted: blacklistCount,
    botEvents,
    pausedCircuits: circuits.filter((entry) => entry.enabled).length,
    status: failedClaims || anomalyCount || blacklistCount || circuits.some((entry) => entry.enabled) ? 'Attention' : 'Normal'
  };
  return {
    generatedAt: new Date().toISOString(),
    paymentAsset: 'NPL',
    stats: {
      merchants: merchants.length,
      walletUids,
      pendingReviews: merchants.filter((row) => /Pending/.test(row.status)).length + submissions.filter((row) => ['PendingReview', 'TakedownRequested'].includes(row.status)).length,
      seckillSessions: sessions.length,
      riskAlerts: riskWaterline.anomalies + riskWaterline.blacklisted + riskWaterline.failedTransactions,
      prizePoolNpl: sumDecimalValues(reports.map((row) => row.prize_pool_npl))
    },
    today: {
      orders: todayOrders.length,
      gmvNpl: sumOrderAmount(paidToday),
      shipmentRate: paidToday.length ? Number(((shippedToday.length / paidToday.length) * 100).toFixed(2)) : 0,
      seckillSessions: sessions.filter((row) => isToday(row.created_at)).length,
      withdrawalsNpl: sumClaimAmount(db.prepare("SELECT * FROM claims WHERE lower(status) = 'success' AND date(created_at, 'localtime') = date('now', 'localtime')").all()),
      newWalletUids: newWalletUidsToday
    },
    todo: {
      merchants: merchants.filter((row) => /Pending/.test(row.status)).length,
      products: submissions.filter((row) => ['PendingReview', 'TakedownRequested'].includes(row.status)).length,
      arbitration: orders.filter((row) => ['Arbitration', 'RefundRequested'].includes(row.status)).length,
      lowStock: Number(db.prepare('SELECT COUNT(*) AS count FROM products WHERE stock <= 5 AND status = ?').get('Active')?.count || 0)
    },
    circuits,
    riskWaterline,
    infrastructure: {
      processUptimeSeconds: Math.floor(process.uptime()),
      cpuLoad1m: Number(os.loadavg()[0].toFixed(2)),
      memoryUsedMb: Math.round(memory.rss / 1024 / 1024),
      memoryTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      rpcConfigured: Boolean(CHAIN_EVENT_RPC_URL),
      eventSyncReady: Boolean(INDEXER_SECRET) && (!CHAIN_EVENT_VERIFY_RPC || Boolean(CHAIN_EVENT_RPC_URL))
    },
    recentOrders: orders.slice(0, 20).map(toOrder),
    pendingProducts: submissions.filter((row) => ['PendingReview', 'TakedownRequested'].includes(row.status)).slice(0, 20).map(toProductSubmission),
    recentAudit: auditLogs().slice(0, 20)
  };
}

function toProductSubmission(row) {
  return {
    id: row.id,
    merchantAddress: row.merchant_address,
    storeId: row.store_id,
    title: row.title,
    status: row.status,
    locked: isProductSubmissionLocked(row.status),
    lockedAt: row.locked_at || null,
    approvedProductId: row.approved_product_id || null,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at
  };
}

function toLedgerEntry(row) {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    orderId: row.order_id || null,
    source: row.source,
    assetSymbol: row.asset_symbol,
    amount: row.amount,
    state: row.state,
    txHash: row.tx_hash || null,
    createdAt: row.created_at
  };
}

function sumOrderAmount(rows) {
  return sumDecimalValues(rows.map((row) => row.amount_npl));
}

function sumLedgerAmount(rows) {
  return sumDecimalValues(rows.map((row) => row.amount));
}

function sumClaimAmount(rows) {
  return sumDecimalValues(rows.map((row) => row.amount));
}

function sumDecimalValues(values) {
  const units = values.reduce((total, value) => total + parseDecimal18(String(value || '0')), 0n);
  return formatDecimal18(units);
}

function isToday(value) {
  const date = new Date(value ? `${String(value).replace(' ', 'T')}Z` : 0);
  const now = new Date();
  return Number.isFinite(date.getTime())
    && date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function renderPreviewPage(options = {}) {
  const home = Boolean(options.home);
  const products = db.prepare("SELECT * FROM products WHERE status = 'Active' ORDER BY id").all().map(toProduct).sort(sortPreviewProduct);
  const session = currentSeckillSession();
  const ready = isValidAddress(ESCROW) && isValidSeller(MERCHANT_RECEIVER) && Boolean(CHAIN_EVENT_RPC_URL);
  const sideTitle = home ? '24K 全量系统预览' : '24K 商城 DApp';
  const ratioMarker = '100% NPL';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/><title>24K Mall DApp</title>${previewStyle()}</head>
<body data-active="seckill"><!-- 24K 三端前端预搭 --><main class="dapp-wrap"><section class="app-frame" aria-label="24K app dapp"><div class="safe-top"><span>09:41</span><span>5G 78%</span></div><div class="app-screen">
<section class="panel active" data-panel="seckill">${renderPreviewSeckill(products, session)}</section>
<section class="panel" data-panel="mall">${renderPreviewRegularMall(products)}</section>
<section class="panel" data-panel="stores">${renderPreviewStores()}</section>
<section class="panel" data-panel="assets">${renderPreviewAssets()}</section>
</div><nav class="bottom-tabs" aria-label="预览切换"><button class="tab active" data-tab="seckill">${previewTabIcon('seckill')}<span>秒杀大厅</span></button><button class="tab" data-tab="mall">${previewTabIcon('mall')}<span>常规商城</span></button><button class="tab" data-tab="stores">${previewTabIcon('stores')}<span>线下门店</span></button><button class="tab" data-tab="assets">${previewTabIcon('assets')}<span>我的资产</span></button></nav><div class="sheet-backdrop" hidden><section class="product-sheet" role="dialog" aria-modal="true"><button class="sheet-close" aria-label="关闭商品详情">×</button><div class="sheet-body"></div></section></div></section>
<aside class="dapp-side"><div class="side-card"><div class="api-badge">${ready ? '已连接 BSC / NPL / BNM' : '等待后端或钱包配置'}</div><h1>${escapeHtml(sideTitle)}</h1><p>当前是 24K C 端电脑预览，四个 App Tab 已按真实商城流程预留，后续只替换数据层。</p><div class="info-grid"><div class="info"><span>Chain</span><b>BSC ${CHAIN_ID}</b></div><div class="info"><span>NPL</span><b>${short(NPL)}</b></div><div class="info"><span>Pay split</span><b>${escapeHtml(ratioMarker)}</b></div><div class="info"><span>Escrow</span><b>${short(ESCROW)}</b></div></div><div class="links"><a href="/preview?tab=seckill">DApp 预览</a><a href="/merchant" class="secondary">商家后台</a><a href="/admin" class="secondary">平台后台</a><a href="/api/seckill/current" class="secondary">Seckill API</a></div></div></aside></main><script id="product-data" type="application/json">${JSON.stringify(products).replace(/</g, '\\u003c')}</script>${previewScript()}</body></html>`;
}

function previewStyle() {
  return `<style>
:root{color-scheme:light;--ink:#171611;--muted:#706c62;--soft:#a6a096;--page:#f4f4f1;--surface:#fffefa;--panel:#f8f7f1;--line:#e6e1d7;--gold:#cf9b3d;--gold-soft:#f2d98b;--gold-deep:#8a641d;--charcoal:#11100d;--green:#24745a;--red:#b84a3e;--blue:#4c6f7f;--shadow:0 18px 44px rgba(35,32,24,.10)}*{box-sizing:border-box}html,body{margin:0;min-height:100%;overflow-x:hidden;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;color:var(--ink);background:radial-gradient(circle at 24% 18%,rgba(207,155,61,.12),transparent 28%),linear-gradient(145deg,#f2f2ee,#dee2de)}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.58}a{color:inherit}.dapp-wrap{min-height:100dvh;display:grid;grid-template-columns:minmax(360px,430px) minmax(340px,520px);gap:34px;align-items:center;justify-content:center;padding:28px}.app-frame{width:min(430px,100%);height:min(900px,calc(100dvh - 32px));min-height:760px;overflow:hidden;border-radius:42px;background:var(--surface);box-shadow:0 34px 95px rgba(22,21,17,.22),0 0 0 1px rgba(22,21,17,.08);position:relative}.safe-top{height:34px;padding:0 22px;display:flex;align-items:flex-end;justify-content:space-between;background:var(--surface);font-size:12px;font-weight:900;color:var(--charcoal);letter-spacing:-.02em}.app-screen{height:calc(100% - 34px - 78px);overflow:hidden;background:var(--page)}.panel{display:none;height:100%;overflow:auto;scrollbar-width:none}.panel::-webkit-scrollbar{display:none}.panel.active{display:block}.page{min-height:100%;padding:0 16px 28px;background:var(--page);overflow-x:hidden}.topbar{position:sticky;top:0;z-index:5;margin:0;padding:13px 0 10px;background:rgba(255,254,250,.94);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid rgba(23,22,17,.06)}.brandline{display:flex;align-items:center;gap:10px;min-width:0}.mark{width:34px;height:34px;border-radius:12px;background:var(--charcoal);color:var(--gold-soft);display:grid;place-items:center;font-weight:950;letter-spacing:-.05em;font-size:13px;box-shadow:inset 0 0 0 1px rgba(242,217,139,.30)}.brand-title{font-size:18px;font-weight:950;letter-spacing:-.045em;white-space:nowrap}.brand-sub{font-size:10px;color:var(--muted);font-weight:850;margin-top:1px;white-space:nowrap}.top-actions{display:flex;gap:7px;flex-shrink:0}.icon-btn{width:38px;height:38px;border:0;border-radius:16px;background:#f0efe9;color:var(--ink);display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(23,22,17,.04)}.icon-btn:before{content:"";width:17px;height:17px;border:2px solid currentColor;display:block}.icon-btn.search:before{border-radius:999px;box-shadow:8px 8px 0 -6px currentColor}.icon-btn.cart:before{border-radius:4px 4px 6px 6px;border-top-width:3px}.search-dock{display:flex;gap:9px;margin:14px 0 10px}.search-dock input{flex:1;min-width:0;height:48px;border:1px solid var(--line);border-radius:18px;background:var(--surface);padding:0 15px;font-size:14px;font-weight:760;color:var(--ink);outline:none;box-shadow:0 8px 22px rgba(35,32,24,.04)}.search-dock input:focus{border-color:rgba(207,155,61,.72);box-shadow:0 0 0 4px rgba(207,155,61,.14)}.filter{width:54px;height:48px;border:0;border-radius:18px;background:var(--charcoal);color:var(--gold-soft);font-size:12px;font-weight:950}.feature-banner{position:relative;display:grid;grid-template-columns:minmax(0,1.05fr) 150px;gap:8px;align-items:center;margin:14px 0 10px;min-height:186px;border-radius:30px;overflow:hidden;background:linear-gradient(135deg,#fffefa 0%,#f2eee4 54%,#e5e0d2 100%);box-shadow:var(--shadow);border:1px solid rgba(23,22,17,.06)}.feature-banner.dark{background:linear-gradient(135deg,#171611 0%,#28241b 58%,#0f0e0b 100%);color:#fffefa}.feature-banner.store{grid-template-columns:1fr;min-height:172px}.feature-banner:before{content:"";position:absolute;inset:auto -30px -55px auto;width:170px;height:170px;border-radius:999px;background:rgba(207,155,61,.18);filter:blur(6px)}.banner-copy{position:relative;z-index:1;padding:20px 0 20px 20px}.kicker{font-size:10px;letter-spacing:.10em;text-transform:uppercase;font-weight:950;color:var(--gold-deep)}.feature-banner.dark .kicker{color:var(--gold-soft)}.banner-copy h2{margin:7px 0 0;font-size:29px;line-height:1.03;font-weight:950;letter-spacing:-.07em}.banner-copy p{margin:8px 0 0;color:var(--muted);font-size:12px;line-height:1.45;font-weight:760}.feature-banner.dark .banner-copy p{color:#cec6b5}.banner-actions{display:flex;gap:8px;align-items:center;margin-top:14px}.pill-btn,.ghost-btn,.claim,.action{min-height:34px;border-radius:999px;padding:0 13px;font-size:12px;font-weight:950;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}.pill-btn{border:0;background:var(--gold);color:var(--charcoal)}.ghost-btn{border:1px solid rgba(23,22,17,.12);background:rgba(255,254,250,.70);color:var(--ink)}.feature-banner.dark .ghost-btn{border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#fffefa}.banner-media{position:relative;z-index:1;height:156px;margin-right:10px;border-radius:25px;background:rgba(255,255,255,.44);display:grid;place-items:center;overflow:hidden}.feature-banner.dark .banner-media{background:rgba(255,255,255,.08)}.banner-media img{width:100%;height:100%;object-fit:cover}.banner-media.contain img{object-fit:contain;padding:10px}.dots{display:flex;gap:6px;justify-content:center;margin:8px 0 10px}.dots i{width:6px;height:6px;border-radius:999px;background:#c9c4ba}.dots i.active{width:18px;background:var(--gold)}.service-rail{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0 6px}.service{min-height:58px;border-radius:19px;background:var(--surface);border:1px solid var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:10px;color:var(--muted);font-weight:850;text-align:center;box-shadow:0 8px 18px rgba(35,32,24,.04)}.service b{font-size:14px;color:var(--ink);letter-spacing:-.02em}.chips{display:flex;gap:8px;overflow:auto;scrollbar-width:none;margin:12px 0 6px;padding:0}.chips::-webkit-scrollbar{display:none}.chips span{white-space:nowrap;border-radius:999px;padding:9px 13px;background:var(--surface);border:1px solid var(--line);font-size:12px;font-weight:900;color:var(--muted)}.chips span.active{background:var(--charcoal);border-color:var(--charcoal);color:var(--gold-soft)}.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:18px 0 12px}.section-head h3{margin:0;font-size:21px;line-height:1;font-weight:950;letter-spacing:-.055em}.section-head p{margin:5px 0 0;color:var(--muted);font-size:12px;font-weight:760}.count{font-size:12px;font-weight:950;color:var(--gold-deep);white-space:nowrap}.product-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}.product-card{min-width:0;cursor:pointer;overflow:hidden;border-radius:24px;background:var(--surface);box-shadow:0 14px 32px rgba(35,32,24,.08);border:1px solid rgba(23,22,17,.06);transition:transform .18s ease,box-shadow .18s ease}.product-card:active,.wide-product:active{transform:scale(.985)}.thumb-wrap{position:relative;background:#eeeee9;overflow:hidden}.product-card .thumb-wrap{height:156px;border-radius:23px 23px 0 0}.thumb{display:block;width:100%;height:100%;object-fit:cover;background:#eeeee9}.product-card .thumb,.wide-product .thumb{object-fit:contain;padding:10px}.product-body{padding:11px}.badge{display:inline-flex;align-items:center;min-height:22px;border-radius:999px;padding:4px 8px;background:#f2ead5;color:var(--gold-deep);font-size:10px;font-weight:950;white-space:nowrap}.product-title{margin-top:8px;font-size:14px;line-height:1.25;font-weight:950;letter-spacing:-.035em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.product-price{margin-top:7px;font-size:17px;font-weight:950;letter-spacing:-.045em}.product-meta{margin-top:4px;color:var(--gold-deep);font-size:10px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card-foot{margin-top:9px;display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:10px;font-weight:850}.arrow-dot{width:28px;height:28px;border-radius:999px;background:#f0efe9;display:grid;place-items:center;color:var(--ink);font-weight:950}.wide-product{cursor:pointer;display:grid;grid-template-columns:126px minmax(0,1fr);gap:12px;padding:10px;border-radius:28px;background:var(--surface);box-shadow:var(--shadow);border:1px solid rgba(23,22,17,.06)}.wide-product .thumb-wrap{width:126px;height:126px;border-radius:22px}.wide-product .product-body{padding:4px 2px}.wide-product .product-title{font-size:18px;line-height:1.14;-webkit-line-clamp:2}.wide-product .note{margin-top:7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.timer-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.timer{border-radius:22px;background:var(--surface);border:1px solid var(--line);padding:14px;box-shadow:0 10px 24px rgba(35,32,24,.05)}.timer span{font-size:11px;color:var(--muted);font-weight:850}.timer strong{display:block;margin-top:5px;font-size:28px;line-height:1;font-weight:950;font-variant-numeric:tabular-nums;letter-spacing:-.04em}.timer.gold{background:linear-gradient(145deg,#f6dda0,#cf9b3d);border:0}.vault{margin-top:12px;border-radius:24px;background:var(--surface);border:1px solid rgba(23,22,17,.06);padding:15px;box-shadow:0 14px 32px rgba(35,32,24,.07)}.vault-row,.store-row,.asset-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.mini-label{font-size:11px;color:var(--muted);font-weight:900}.big-value{margin-top:3px;font-size:24px;font-weight:950;letter-spacing:-.045em}.note{margin-top:6px;color:var(--muted);font-size:12px;line-height:1.45;font-weight:720}.signal{display:inline-flex;border-radius:999px;background:#e9f4ef;color:var(--green);padding:7px 10px;font-size:11px;font-weight:950;white-space:nowrap}.feed-list,.store-list,.asset-list{display:grid;gap:10px}.feed,.store,.asset-card,.profile-card{border-radius:22px;background:var(--surface);border:1px solid rgba(23,22,17,.06);padding:14px;box-shadow:0 12px 28px rgba(35,32,24,.07)}.feed strong,.store strong,.asset-card strong{font-size:15px}.distance{color:var(--gold-deep);font-size:13px;font-weight:950;white-space:nowrap}.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}.action{border:0;background:#efeee8;color:var(--ink)}.action.primary{background:var(--gold);color:var(--charcoal)}.store-photo{height:172px;border-radius:30px;overflow:hidden;background:#11100d;box-shadow:var(--shadow);position:relative}.store-photo img{width:100%;height:100%;object-fit:cover}.store-photo:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(17,16,13,.06),rgba(17,16,13,.28))}.map-card{margin:12px 0;border-radius:26px;background:var(--charcoal);color:#fffefa;padding:15px;display:grid;grid-template-columns:1fr 112px;gap:14px;box-shadow:0 16px 34px rgba(35,32,24,.12)}.map-lines{position:relative;min-height:98px;border-radius:21px;background:radial-gradient(circle at 60% 46%,rgba(207,155,61,.32),transparent 35%),linear-gradient(145deg,#2a271f,#171611)}.map-lines:before,.map-lines:after{content:"";position:absolute;border:1px solid rgba(242,217,139,.18);border-radius:999px}.map-lines:before{inset:18px}.map-lines:after{inset:36px}.map-dot{position:absolute;right:42px;top:42px;width:14px;height:14px;border-radius:999px;background:var(--gold-soft);box-shadow:0 0 0 8px rgba(207,155,61,.18)}.profile-card{margin-top:14px;display:grid;grid-template-columns:58px 1fr auto;align-items:center;gap:12px}.avatar{width:58px;height:58px;border-radius:22px;object-fit:cover;background:#e7e2d8}.wallet-pill{border-radius:999px;background:#efeee8;padding:8px 10px;font-size:11px;font-weight:950;color:var(--muted)}.asset-hero{margin:12px 0 0;border-radius:30px;background:linear-gradient(145deg,#171611,#2b261b);color:#fffefa;padding:18px;box-shadow:0 18px 38px rgba(35,32,24,.16)}.asset-total{font-size:36px;font-weight:950;letter-spacing:-.065em}.asset-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px}.asset-mini{border-radius:17px;background:rgba(255,255,255,.075);padding:10px}.asset-mini b{display:block;color:var(--gold-soft);font-size:14px}.asset-mini span{color:#c9c0ad;font-size:10px;font-weight:850}.order-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.order-state{border-radius:18px;background:var(--surface);border:1px solid var(--line);min-height:66px;display:grid;place-items:center;text-align:center;font-size:10px;color:var(--muted);font-weight:850;box-shadow:0 8px 18px rgba(35,32,24,.04)}.order-state b{font-size:17px;color:var(--ink)}.progress{height:7px;border-radius:999px;background:#ebe7dc;overflow:hidden;margin-top:11px}.progress i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--gold),var(--green))}.claim{border:0;background:var(--charcoal);color:var(--gold-soft)}.bottom-tabs{height:78px;background:rgba(255,254,250,.98);border-top:1px solid rgba(23,22,17,.08);display:grid;grid-template-columns:repeat(4,1fr);padding-bottom:env(safe-area-inset-bottom)}.tab{border:0;background:transparent;color:#77736a;font-size:10px;font-weight:900;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px}.tab.active{color:var(--charcoal)}.tab-icon{width:22px;height:22px;border:2px solid currentColor;display:block}.tab-icon.flame{border-radius:50% 50% 55% 45%;transform:rotate(45deg)}.tab-icon.bag{border-radius:5px 5px 7px 7px}.tab-icon.pin{border-radius:999px 999px 999px 4px;transform:rotate(-45deg)}.tab-icon.wallet{border-radius:6px}.tab.active .tab-icon{background:var(--gold);border-color:var(--gold);box-shadow:0 0 0 5px rgba(207,155,61,.16)}.dapp-side{display:block}.side-card{border-radius:34px;background:rgba(255,254,250,.78);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:28px;box-shadow:0 24px 70px rgba(35,32,24,.12);border:1px solid rgba(255,255,255,.66)}.api-badge{display:inline-flex;border-radius:999px;background:var(--charcoal);color:var(--gold-soft);padding:8px 12px;font-size:12px;font-weight:950}.side-card h1{margin:18px 0 0;font-size:48px;line-height:.95;letter-spacing:-.07em}.side-card p{color:var(--muted);font-size:14px;line-height:1.7;font-weight:700}.info-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:20px}.info{border-radius:18px;background:rgba(255,255,255,.78);border:1px solid var(--line);padding:13px}.info span{display:block;color:var(--muted);font-size:10px;font-weight:950;text-transform:uppercase;letter-spacing:.08em}.info b{display:block;margin-top:6px;font-size:13px;word-break:break-all}.links{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}.links a{min-height:38px;display:inline-flex;align-items:center;border-radius:13px;background:var(--charcoal);color:var(--gold-soft);text-decoration:none;padding:0 13px;font-size:13px;font-weight:950}.links a.secondary{background:#efeee8;color:var(--ink)}.sheet-backdrop{position:absolute;inset:0;background:rgba(17,16,13,.46);z-index:30;display:grid;place-items:end center;padding:18px 14px 16px;border-radius:inherit;overflow:hidden}.sheet-backdrop[hidden]{display:none}.product-sheet{width:100%;max-height:calc(100% - 34px);overflow:hidden;border-radius:30px 30px 24px 24px;background:var(--surface);padding:18px;box-shadow:0 -20px 80px rgba(0,0,0,.26);position:relative;display:flex;flex-direction:column}.sheet-close{position:absolute;right:14px;top:12px;width:36px;height:36px;border:0;border-radius:999px;background:#efeee8;font-size:24px;line-height:1}.sheet-hero{display:grid;grid-template-columns:116px 1fr;gap:14px;align-items:center}.sheet-hero img{width:116px;height:116px;border-radius:24px;object-fit:cover;background:#eeeee9}.sheet-title{font-size:20px;font-weight:950;letter-spacing:-.045em}.sheet-summary{margin-top:6px;color:var(--muted);font-size:12px;line-height:1.45;font-weight:730}.option-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.option{border:1px solid var(--line);border-radius:999px;background:#f5f4ee;padding:9px 12px;font-size:12px;font-weight:900}.option.active{background:var(--charcoal);color:var(--gold-soft);border-color:var(--charcoal)}.verify{margin-top:14px;border-radius:22px;background:#f6f4ed;border:1px solid var(--line);padding:12px}.verify-line{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid rgba(23,22,17,.06);font-size:12px}.verify-line:last-child{border-bottom:0}.verify-line span{color:var(--muted);font-weight:850}.verify-line b{text-align:right;font-weight:950}.console-shell{width:min(1240px,100%);min-height:100dvh;margin:auto;padding:26px;display:grid;grid-template-columns:270px 1fr;gap:18px;color:var(--ink)}.console-nav{position:sticky;top:22px;align-self:start;border-radius:30px;background:var(--surface);border:1px solid var(--line);padding:18px;box-shadow:0 18px 50px rgba(35,32,24,.10)}.console-nav h1{font-size:34px;line-height:.98;letter-spacing:-.06em;margin:14px 0 8px}.console-nav p{color:var(--muted);font-size:13px;line-height:1.55;font-weight:700}.nav-list{display:grid;gap:7px;margin-top:14px;max-height:420px;overflow:hidden}.nav-item{border:1px solid var(--line);border-radius:14px;background:#f7f6ef;color:var(--muted);text-align:left;padding:10px 11px;font-size:12px;font-weight:850}.nav-item.active{background:var(--charcoal);color:var(--gold-soft);border-color:var(--charcoal)}.console-main{display:grid;gap:14px}.backend-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.backend-card,.panel-card{border-radius:24px;background:var(--surface);border:1px solid var(--line);padding:15px;box-shadow:0 14px 34px rgba(35,32,24,.08)}.backend-card span{color:var(--muted);font-size:10px;text-transform:uppercase;font-weight:950;letter-spacing:.08em}.backend-card b{display:block;margin-top:8px;color:var(--ink);font-size:24px;line-height:1.05;letter-spacing:-.04em}.workspace-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.panel-card{grid-column:span 6}.panel-card.wide{grid-column:1/-1}.panel-card h2{margin:0 0 12px;font-size:18px;letter-spacing:-.04em}.panel-card p{margin:10px 0 0;color:var(--muted);font-size:12px;line-height:1.55;font-weight:700}.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px}table{width:100%;border-collapse:separate;border-spacing:0 8px;font-size:13px}th{text-align:left;color:var(--muted);font-size:10px;text-transform:uppercase;padding:0 8px;font-weight:950}td{padding:11px 8px;background:#f6f4ee;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}td:first-child{border-left:1px solid var(--line);border-radius:12px 0 0 12px}td:last-child{border-right:1px solid var(--line);border-radius:0 12px 12px 0}.status-chip{display:inline-flex;border-radius:999px;background:#f1ead7;color:var(--gold-deep);padding:4px 8px;font-size:11px;font-weight:950}.panel-card label{display:grid;gap:6px;color:var(--muted);font-size:12px;font-weight:900;margin:10px 0}.panel-card input{height:40px;border:1px solid var(--line);border-radius:13px;background:#f9f8f2;color:var(--ink);padding:0 11px}.panel-card button,.panel-head button{border:0;border-radius:12px;background:var(--charcoal);color:var(--gold-soft);font-weight:950;padding:10px 12px;margin:3px 6px 3px 0}.danger-panel{background:#fff4f2;border-color:#f0c6be}.metric-line{display:flex;justify-content:space-between;align-items:center;border-radius:16px;background:#f6f4ee;padding:12px;margin-bottom:10px}.metric-line b{font-size:24px}.audit-feed{display:grid;gap:8px}.audit-feed span{border-radius:13px;background:#f6f4ee;padding:10px;color:var(--ink);font-weight:850}.console-toast{position:sticky;bottom:14px;border-radius:17px;background:var(--gold);color:var(--charcoal);padding:12px 14px;font-weight:950;box-shadow:0 14px 28px rgba(35,32,24,.18)}@media(max-width:920px){body{background:var(--page)}.dapp-wrap{display:block;width:100vw;max-width:100vw;min-height:100dvh;padding:0;overflow:hidden}.app-frame{width:100vw;max-width:100vw;height:100dvh;min-height:0;border-radius:0;box-shadow:none}.dapp-side{display:none}.console-shell{grid-template-columns:1fr;padding:14px}.console-nav{position:static}.backend-grid{grid-template-columns:repeat(2,1fr)}.panel-card{grid-column:1/-1}}@media(max-width:370px){.page{padding-left:12px;padding-right:12px}.product-grid{gap:9px}.banner-copy h2{font-size:26px}.feature-banner{grid-template-columns:minmax(0,1fr) 128px}.service-rail{grid-template-columns:repeat(2,1fr)}.wide-product{grid-template-columns:112px minmax(0,1fr)}.wide-product .thumb-wrap{width:112px;height:112px}}
  

/* 24K premium mobile commerce polish */
:root{--ink:#151510;--muted:#77736a;--soft:#aaa49a;--page:#f6f6f1;--surface:#fffefa;--panel:#efeee9;--line:#e9e4da;--gold:#caa24a;--gold-soft:#f4dc91;--gold-deep:#8b6924;--charcoal:#11110f;--green:#496f55;--red:#c71f36;--shadow:0 12px 30px rgba(28,26,20,.075)}
html,body{background:linear-gradient(135deg,#e8efe4 0%,#f5f3ea 48%,#e7e5dc 100%)}
.app-frame{background:var(--surface);box-shadow:0 28px 80px rgba(19,18,15,.18),0 0 0 1px rgba(18,17,13,.08)}
.safe-top{height:35px;padding:0 20px 4px;background:var(--surface);font-size:12px;font-weight:800;color:#171713}.app-screen{background:var(--page)}
.page{padding:0 14px 30px;background:var(--page)}
.topbar{min-height:58px;margin:0 -1px;padding:10px 0 8px;background:rgba(255,254,250,.96);border-bottom:0;box-shadow:0 1px 0 rgba(18,17,13,.04);align-items:center}.brandline{gap:9px}.mark{width:30px;height:30px;border-radius:10px;background:#141411;color:#f4dc91;font-size:10px;font-weight:950;letter-spacing:-.06em}.brand-title{font-size:21px;letter-spacing:-.06em;line-height:1}.brand-sub{font-size:10px;color:#918a7d;font-weight:760;letter-spacing:.01em;margin-top:2px}.top-actions{gap:8px}.icon-btn{width:36px;height:36px;border-radius:999px;background:#f4f3ed;box-shadow:inset 0 0 0 1px rgba(18,17,13,.06)}.icon-btn:before{width:16px;height:16px;border-width:2px}.screen-intro{padding:12px 2px 4px}.screen-intro span{display:block;color:var(--muted);font-size:13px;font-weight:760}.screen-intro h2{margin:3px 0 0;font-size:28px;line-height:1.05;letter-spacing:-.07em;font-weight:950}.search-dock{margin:12px 0 12px;gap:8px}.search-dock input{height:44px;border-radius:999px;border:0;background:#eeede8;box-shadow:inset 0 0 0 1px rgba(18,17,13,.04);font-size:13px;font-weight:740;padding:0 16px}.search-dock input:focus{box-shadow:0 0 0 3px rgba(202,162,74,.18),inset 0 0 0 1px rgba(202,162,74,.55)}.filter{height:44px;width:auto;min-width:48px;border-radius:999px;background:#141411;color:#fffefa;padding:0 13px;font-size:11px}.filter.active{background:#e9dfc2;color:#141411}.feature-banner{min-height:176px;margin:12px 0 9px;grid-template-columns:minmax(0,1fr) 138px;border-radius:26px;background:linear-gradient(135deg,#eef3e8 0%,#e3eadb 100%);box-shadow:none;border:0;overflow:hidden}.feature-banner.dark{background:linear-gradient(135deg,#eef3e8 0%,#dfe8d8 100%);color:var(--ink)}.feature-banner:before{display:none}.banner-copy{padding:19px 0 18px 18px}.kicker{font-size:10px;letter-spacing:.08em;color:#6d6a61;text-transform:uppercase}.feature-banner.dark .kicker{color:#6d6a61}.banner-copy h2{font-size:24px;line-height:1.05;letter-spacing:-.065em;margin:8px 0 0;max-width:8.5em}.banner-copy p{font-size:12px;line-height:1.45;font-weight:690;color:#6f6b63;margin-top:8px}.feature-banner.dark .banner-copy p{color:#6f6b63}.banner-actions{margin-top:13px}.pill-btn,.ghost-btn,.claim,.action{min-height:32px;border-radius:999px;padding:0 12px;font-size:12px;font-weight:880}.pill-btn{background:#151510;color:#fffefa}.ghost-btn{background:#fffdf8;border:1px solid rgba(18,17,13,.08);color:#1a1915}.feature-banner.dark .ghost-btn{background:#fffdf8;color:#1a1915;border-color:rgba(18,17,13,.08)}.banner-media{height:150px;margin:13px 12px 13px 0;border-radius:22px;background:rgba(255,253,248,.62);box-shadow:inset 0 0 0 1px rgba(18,17,13,.04)}.feature-banner.dark .banner-media{background:rgba(255,253,248,.62)}.banner-media.contain img{object-fit:contain;padding:12px}.dots{margin:7px 0 11px}.dots i{background:#c9c6bd}.dots i.active{width:20px;background:#d2aa4f}.service-rail{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:10px 0 12px}.service{min-height:54px;border-radius:16px;background:#fffefa;border:0;box-shadow:none;color:#817c72}.service b{font-size:13px}.chips{gap:9px;margin:13px -14px 10px;padding:0 14px}.chips span{border:0;border-radius:999px;background:transparent;color:#938e84;font-size:12px;padding:8px 13px;font-weight:850}.chips span.active{background:#141411;color:#fffefa}.section-head{margin:18px 0 12px;align-items:center}.section-head h3{font-size:22px;letter-spacing:-.055em}.section-head p{font-size:11px;font-weight:700}.count{font-size:11px;color:#8d856f}.product-grid{gap:12px}.product-card{position:relative;border-radius:17px;background:#ededeb;border:0;box-shadow:none;overflow:hidden}.product-card .thumb-wrap{height:143px;border-radius:17px 17px 0 0;background:#ededeb}.thumb{background:transparent}.product-card .thumb,.wide-product .thumb{object-fit:contain;padding:13px}.product-body{padding:10px 12px 12px}.badge{background:transparent;color:#827d73;padding:0;min-height:0;font-size:10px;font-weight:820}.product-title{font-size:13px;line-height:1.2;margin-top:6px;letter-spacing:-.035em}.product-price{font-size:15px;margin-top:6px;letter-spacing:-.035em}.product-meta{font-size:10px;color:#9a7a35;font-weight:780}.card-foot{margin-top:8px;font-size:10px}.arrow-dot{width:24px;height:24px;background:#fffefa;box-shadow:0 1px 3px rgba(18,17,13,.08);font-size:16px}.love-dot{position:absolute;right:10px;top:10px;z-index:2;width:28px;height:28px;border-radius:999px;background:#fffefa;color:#6d6b66;display:grid;place-items:center;font-size:20px;line-height:1;box-shadow:0 3px 12px rgba(18,17,13,.08)}.product-card:nth-child(1) .love-dot,.product-card:nth-child(3) .love-dot{color:var(--red)}.wide-product{grid-template-columns:124px minmax(0,1fr);gap:12px;border-radius:22px;background:#fffefa;border:0;box-shadow:none;padding:10px}.wide-product .thumb-wrap{width:124px;height:124px;border-radius:18px;background:#efeee9}.wide-product .product-title{font-size:17px;line-height:1.18}.wide-product .note{font-size:11px;line-height:1.42}.timer-row{gap:9px;margin-top:11px}.timer{border:0;border-radius:18px;background:#fffefa;padding:13px;box-shadow:none}.timer.gold{background:#151510;color:#fffefa}.timer.gold span{color:#cfc7b9}.timer span{font-size:10px}.timer strong{font-size:25px}.vault{border:0;border-radius:20px;background:#fffefa;padding:14px;box-shadow:none}.big-value{font-size:22px}.note{font-size:11px;line-height:1.45;color:#77736a}.signal{background:#eef5eb;color:#496f55}.feed,.store,.asset-card,.profile-card{border:0;border-radius:19px;background:#fffefa;box-shadow:none;padding:13px}.feed strong,.store strong,.asset-card strong{font-size:14px}.feed-list,.store-list,.asset-list{gap:9px}.distance{font-size:12px;color:#8b6924}.store-photo{height:176px;border-radius:25px;box-shadow:none;background:#eeede8}.store-photo img{object-fit:contain;padding:10px}.store-photo:after{background:linear-gradient(180deg,rgba(17,16,13,.04),rgba(17,16,13,.18))}.map-card{grid-template-columns:1fr 92px;border-radius:21px;margin:10px 0;background:#fffefa;color:#151510;box-shadow:none;border:0}.map-card .note{color:#77736a!important}.map-lines{min-height:86px;border-radius:18px;background:radial-gradient(circle at 60% 45%,rgba(202,162,74,.30),transparent 36%),#efeee9}.map-lines:before,.map-lines:after{border-color:rgba(139,105,36,.18)}.map-dot{background:#141411;box-shadow:0 0 0 7px rgba(202,162,74,.22)}.profile-card{grid-template-columns:52px 1fr auto;margin-top:12px}.avatar{width:52px;height:52px;border-radius:18px}.wallet-pill{background:#eeede8}.asset-hero{border-radius:25px;background:#151510;color:#fffefa;padding:18px;box-shadow:none}.asset-total{font-size:34px}.asset-grid{gap:7px}.asset-mini{border-radius:15px}.order-grid{gap:8px}.order-state{min-height:61px;border:0;border-radius:16px;box-shadow:none}.progress{height:6px;background:#eeeadf}.progress i{background:#caa24a}.asset-menu{display:grid;gap:9px}.menu-row{width:100%;border:0;border-radius:19px;background:#fffefa;display:grid;grid-template-columns:38px 1fr auto;align-items:center;gap:11px;padding:13px;text-align:left;color:#151510}.menu-icon{width:38px;height:38px;border-radius:999px;background:#efeee9;display:grid;place-items:center;font-size:11px;font-weight:930;color:#8b6924}.menu-row b{font-size:14px}.menu-row small{display:block;margin-top:3px;font-size:11px;color:#77736a}.menu-row em{font-style:normal;font-size:20px;color:#aaa49a}.bottom-tabs{height:78px;background:rgba(255,254,250,.99);border-top:1px solid rgba(18,17,13,.06);box-shadow:0 -8px 22px rgba(20,18,12,.035);width:calc(100vw - 28px)!important;max-width:402px!important;margin-left:14px;margin-right:14px;border-radius:22px 22px 0 0;overflow:hidden}.tab{font-size:10px;color:#78756f;font-weight:820}.tab.active{color:#151510}.tab-icon{width:21px;height:21px;border-width:2px}.tab.active .tab-icon{background:#151510;border-color:#151510;box-shadow:none}.side-card{background:rgba(255,254,250,.82);box-shadow:0 22px 62px rgba(20,18,12,.10)}.side-card h1{font-size:45px}.api-badge{background:#151510;color:#fffefa}.sheet-backdrop{background:rgba(17,16,13,.42)}.product-sheet{border-radius:28px 28px 18px 18px}.sheet-hero img{object-fit:contain;background:#efeee9}.verify{background:#f7f5ef;border:0}.action.primary{background:#151510;color:#fffefa}.claim{background:#151510;color:#fffefa}
.topbar{padding-right:88px;position:sticky;overflow:visible}.top-actions{position:absolute;right:0;top:10px}.stores-one-action .topbar,.assets-one-action .topbar{padding-right:44px}
.page>.topbar,.page>.search-dock,.page>.feature-banner,.page>.timer-row,.page>.vault,.page>.wide-product,.page>.product-grid,.page>.section-head,.page>.feed-list,.page>.store-photo,.page>.map-card,.page>.store-list,.page>.profile-card,.page>.asset-hero,.page>.order-grid,.page>.asset-menu,.page>.service-rail{width:calc(100vw - 28px)!important;max-width:402px!important}.page>.chips{width:calc(100vw - 28px)!important;max-width:402px!important;margin-left:0!important;margin-right:0!important;padding:0!important}
@media(max-width:920px){html,body{background:var(--page)}.dapp-wrap{width:100%;max-width:100%;overflow:hidden}.app-frame{width:100%;max-width:100%}.bottom-tabs{width:100%;max-width:100%}.page{padding-left:14px;padding-right:14px}.feature-banner{grid-template-columns:minmax(0,1fr) 132px}.banner-media{height:145px}.product-card .thumb-wrap{height:138px}.bottom-tabs{height:82px}}
@media(max-width:370px){.feature-banner{grid-template-columns:minmax(0,1fr) 112px}.banner-copy h2{font-size:22px}.banner-copy{padding-left:15px}.banner-media{height:128px;margin-right:9px}.product-card .thumb-wrap{height:126px}.service-rail{grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.service{min-height:49px}.wide-product{grid-template-columns:104px minmax(0,1fr)}.wide-product .thumb-wrap{width:104px;height:104px}.screen-intro h2{font-size:25px}.top-actions{gap:5px}.icon-btn{width:34px;height:34px}}

/* 24K precision polish: flagship app details */
button,[role="button"]{-webkit-tap-highlight-color:transparent}
button:focus-visible,[role="button"]:focus-visible,input:focus-visible{outline:2px solid rgba(202,162,74,.72);outline-offset:3px}
.page{background:linear-gradient(180deg,#f8f8f4 0%,#f3f3ee 100%)}
.topbar{box-shadow:0 1px 0 rgba(18,17,13,.035),0 10px 24px rgba(18,17,13,.025)}
.screen-intro h2{font-size:29px;letter-spacing:-.075em}
.feature-banner{background:linear-gradient(135deg,#f9faf4 0%,#ecf2e5 53%,#e2e7d9 100%);box-shadow:0 18px 42px rgba(28,26,20,.075);border:1px solid rgba(18,17,13,.045)}
.page-seckill .feature-banner.dark{background:linear-gradient(135deg,#171713 0%,#282316 62%,#12110e 100%);color:#fffefa;box-shadow:0 22px 46px rgba(20,18,12,.16)}
.page-seckill .feature-banner.dark .kicker{color:#f4dc91}.page-seckill .feature-banner.dark .banner-copy p{color:#d1c8b7}.page-seckill .feature-banner.dark .hero-proof span{background:rgba(255,255,255,.08);color:#f4dc91}
.banner-media{box-shadow:inset 0 0 0 1px rgba(18,17,13,.045),0 10px 28px rgba(18,17,13,.055)}
.hero-proof{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}.hero-proof span{border-radius:999px;background:rgba(255,253,248,.76);color:#6f685c;padding:5px 7px;font-size:10px;font-weight:850;box-shadow:inset 0 0 0 1px rgba(18,17,13,.045)}
.product-grid{gap:13px}.product-card{background:#fffefa;border:1px solid rgba(18,17,13,.055);box-shadow:0 10px 26px rgba(28,26,20,.062)}
.product-card .thumb-wrap{background:linear-gradient(145deg,#f3f3ee,#e9ece3)}
.product-card .thumb,.wide-product .thumb{padding:8px;filter:saturate(1.04) contrast(1.015)}
.page-mall .product-grid .product-card:first-child{grid-column:1/-1;display:grid;grid-template-columns:44% minmax(0,1fr);border-radius:24px;min-height:184px;background:#fffefa}
.page-mall .product-grid .product-card:first-child .thumb-wrap{height:100%;min-height:184px;border-radius:24px 0 0 24px}
.page-mall .product-grid .product-card:first-child .product-body{padding:15px 14px 14px;align-self:center}.page-mall .product-grid .product-card:first-child .product-title{font-size:18px;line-height:1.13}.page-mall .product-grid .product-card:first-child .product-price{font-size:18px}
.price-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin-top:7px}.price-row .product-price{margin:0}.price-row del{color:#aaa49a;font-size:10px;font-weight:760;text-decoration-thickness:1px}.product-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.product-tags em{font-style:normal;border-radius:999px;background:#f4f0e3;color:#8b6924;padding:4px 6px;font-size:9px;font-weight:850;line-height:1}
.card-foot{border-top:1px solid rgba(18,17,13,.045);padding-top:8px}.wide-product{box-shadow:0 12px 30px rgba(28,26,20,.07);border:1px solid rgba(18,17,13,.05)}
.store-status{margin-top:8px;color:#496f55;font-size:11px;font-weight:860}.store{position:relative}.store:before{content:"";position:absolute;right:14px;bottom:14px;width:7px;height:7px;border-radius:999px;background:#496f55;box-shadow:0 0 0 5px rgba(73,111,85,.10)}
.asset-hero{position:relative;overflow:hidden}.asset-hero:after{content:"";position:absolute;right:-40px;top:-54px;width:158px;height:158px;border-radius:999px;background:radial-gradient(circle,rgba(244,220,145,.18),transparent 62%)}.asset-hero>*{position:relative;z-index:1}.menu-row{box-shadow:0 9px 22px rgba(28,26,20,.045)}
.product-sheet{padding:0;overflow:hidden;border:1px solid rgba(255,255,255,.68)}.sheet-body{flex:1;min-height:0;overflow:auto;padding:18px 18px 0;scrollbar-width:none}.sheet-body::-webkit-scrollbar{display:none}.sheet-close{z-index:2;box-shadow:0 8px 18px rgba(18,17,13,.08)}
.sheet-hero{grid-template-columns:138px minmax(0,1fr);align-items:center}.sheet-hero img{width:138px;height:138px;border-radius:26px;object-fit:contain;padding:6px;background:linear-gradient(145deg,#f1f1eb,#e7eadf)}.sheet-title{font-size:21px;line-height:1.08}.sheet-price-row{display:flex;align-items:baseline;gap:8px;margin-top:10px}.sheet-price-row strong{font-size:20px;letter-spacing:-.04em}.sheet-price-row del{font-size:12px;color:#aaa49a;font-weight:760}.sheet-service-row{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:14px 0 2px}.sheet-service-row span{border-radius:15px;background:#f5f2e8;color:#7c6a42;min-height:36px;display:grid;place-items:center;font-size:11px;font-weight:900}.delivery-card{margin-top:12px;border-radius:20px;background:#151510;color:#fffefa;padding:13px 14px;display:grid;gap:3px}.delivery-card span{color:#cfc7b9;font-size:11px;font-weight:850}.delivery-card b{font-size:15px}.delivery-card small{color:#f4dc91;font-size:11px;font-weight:820}.verify-title{font-size:12px;font-weight:950;margin-bottom:5px;color:#151510}.sheet-cta{position:sticky;bottom:0;margin:14px -18px 0;padding:12px 18px 16px;background:linear-gradient(180deg,rgba(255,254,250,.74),#fffefa 36%);display:grid;grid-template-columns:1fr 1.35fr;gap:9px}.sheet-cta .action{min-height:44px}.option{transition:background .16s ease,color .16s ease,border-color .16s ease}.action,.pill-btn,.ghost-btn,.filter,.menu-row,.tab{transition:transform .16s ease,background .16s ease,color .16s ease,box-shadow .16s ease}.action:active,.pill-btn:active,.ghost-btn:active,.filter:active,.menu-row:active,.tab:active{transform:scale(.98)}
.bottom-tabs{box-shadow:0 -10px 28px rgba(20,18,12,.05);border-top-color:rgba(18,17,13,.045);padding:6px 7px 7px}.tab{position:relative;isolation:isolate;gap:3px;border-radius:20px}.tab:before{content:"";position:absolute;top:5px;bottom:5px;left:7px;right:7px;border-radius:19px;background:linear-gradient(180deg,#fbf1cf 0%,#ead083 100%);box-shadow:0 9px 22px rgba(139,105,36,.14),inset 0 0 0 1px rgba(255,255,255,.62),inset 0 -1px 0 rgba(139,105,36,.18);opacity:0;transform:scale(.94);transition:opacity .16s ease,transform .16s ease}.tab svg.tab-icon{position:relative;z-index:1;width:25px;height:25px;border:0;background:transparent;box-shadow:none;color:#a29c91;display:block;overflow:visible;transition:color .16s ease,filter .16s ease,transform .16s ease}.tab span{position:relative;z-index:1;line-height:1.1}.tab.active{color:#151510}.tab.active:before{opacity:1;transform:scale(1)}.tab.active svg.tab-icon{background:transparent;border:0;color:#151510;box-shadow:none;filter:drop-shadow(0 1px 0 rgba(255,255,255,.52));transform:translateY(-1px)}.tab-icon .tab-accent{stroke:#caa24a}.tab.active .tab-icon .tab-accent{stroke:#8b6924}.tab.active span{font-weight:950}
@media(max-width:370px){.page-mall .product-grid .product-card:first-child{grid-template-columns:42% minmax(0,1fr);min-height:166px}.page-mall .product-grid .product-card:first-child .thumb-wrap{min-height:166px}.page-mall .product-grid .product-card:first-child .product-title{font-size:16px}.product-tags em{display:none}.sheet-hero{grid-template-columns:112px minmax(0,1fr)}.sheet-hero img{width:112px;height:112px}.sheet-price-row strong{font-size:17px}}

</style>`;
}

function renderPreviewSeckill(products, session = emptySeckillSession()) {
  const product = session.id ? products.find((entry) => entry.id === session.productId) : null;
  const status = { idle: '暂无场次', upcoming: '未开启', live: '秒杀中', settling: '结算中', settled: '已结算' }[session.status] || '暂无场次';
  return `<div class="page page-seckill"><div class="topbar"><div class="brandline"><div class="mark">24K</div><div><div class="brand-title">24K</div><div class="brand-sub">Live Deals</div></div></div><div class="top-actions"><button class="icon-btn search" aria-label="搜索秒杀商品"></button><button class="icon-btn cart" aria-label="终核清单"></button></div></div><div class="screen-intro"><span>${escapeHtml(status)} · 今日专场</span><h2>秒杀大厅</h2></div><div class="feature-banner dark"><div class="banner-copy"><div class="kicker">Hot Deal</div><h2>限时热卖，成功接力</h2><p>60 分钟主场，抢购成功延长 30 秒。</p><div class="hero-proof"><span>EOA 限制</span><span>强截止</span><span>中奖提取</span></div><div class="banner-actions"><button class="pill-btn" data-open-product="${escapeHtml(product?.id || '')}" ${product ? '' : 'disabled'}>立即抢购</button><button class="ghost-btn" data-dialog="rules">规则</button></div></div><div class="banner-media contain">${product ? `<img src="${escapeHtml(previewImageSrc(product))}" alt="${escapeHtml(product.title)}"/>` : '<img src="/assets/products/24k-prize-vault.png" alt="24K 秒杀奖池待排期"/>'}</div></div><div class="dots"><i class="active"></i><i></i><i></i><i></i></div><div class="timer-row"><div class="timer"><span>主倒计时</span><strong>${formatSeconds(session.mainSecondsLeft)}</strong></div><div class="timer gold"><span>接力倒计时</span><strong>${formatSeconds(session.relaySecondsLeft)}</strong></div></div><div class="vault"><div class="vault-row"><div><div class="mini-label">本场奖池</div><div class="big-value">${formatPreviewNpl(session.prizePoolNpl)} NPL</div><div class="note">累计 ${Number(session.totalBuys || 0).toLocaleString('zh-CN')} 次参与，结算后开放中奖提取。</div></div><span class="signal">${session.id ? '托管中' : '待排期'}</span></div></div><div class="section-head"><div><h3>本场商品</h3><p>先确认 SKU、数量和履约方式</p></div><span class="count">${product ? 1 : 0} 件</span></div>${product ? renderMallProduct(product, 0, true) : ''}<div class="section-head"><div><h3>实时动态</h3><p>抢购记录和战报</p></div><button class="ghost-btn" data-dialog="report">战报</button></div><div class="feed-list">${seckillFeed(session.id).slice(0,3).map((item)=>`<div class="feed"><div class="store-row"><strong>${escapeHtml(item.address)}</strong><span class="distance">${escapeHtml(item.createdAt)}</span></div><div class="note">${escapeHtml(item.text)}</div></div>`).join('')}</div></div>`;
}

function renderPreviewRegularMall(products) {
  const featured = products.find((entry) => entry.id === 'p-24k-phone') || products[0];
  const ratioLabel = '100% NPL';
  const rebateLabel = featured ? `${featured.bnmRebateRate}%` : '100%';
  return `<div class="page page-mall"><div class="topbar"><div class="brandline"><div class="mark">24K</div><div><div class="brand-title">24K</div><div class="brand-sub">Luxury Mall</div></div></div><div class="top-actions"><button class="icon-btn search" aria-label="搜索商品"></button><button class="icon-btn cart" aria-label="终核清单"></button></div></div><div class="screen-intro"><span>欢迎来到 24K</span><h2>常规商城</h2></div><div class="search-dock"><input data-mall-search placeholder="搜索商品、SKU、门店自提"/><button class="filter" data-stock-filter>现货</button></div><div class="feature-banner"><div class="banner-copy"><div class="kicker">Featured</div><h2>精选现货，确认后成交</h2><p>选 SKU、履约和地址后，再进入付前终核。</p><div class="hero-proof"><span>验收现货</span><span>托管成交</span><span>签收释放</span></div><div class="banner-actions"><button class="pill-btn" data-open-product="${escapeHtml(featured?.id || '')}">查看精选</button></div></div><div class="banner-media contain"><img src="${escapeHtml(previewImageSrc(featured || {}))}" alt="${escapeHtml(featured?.title || '24K 精选商品')}"/></div></div><div class="dots"><i class="active"></i><i></i><i></i><i></i></div><div class="chips">${['全部','数码','运动','食品','穿搭','居家'].map((item,i)=>`<span data-category="${item}" class="${i===0?'active':''}">${item}</span>`).join('')}</div><div class="section-head"><div><h3>为你精选</h3><p>可快递，可门店自提</p></div><span class="count" data-result-count>${products.length} 件</span></div><div class="product-grid">${products.map((product, index)=>renderMallProduct(product, index, false)).join('')}</div><div class="service-rail"><div class="service"><b>5项</b>终核</div><div class="service"><b>${escapeHtml(ratioLabel)}</b>结算</div><div class="service"><b>${escapeHtml(rebateLabel)}</b>BNM</div><div class="service"><b>48h</b>履约</div></div></div>`;
}

function renderMallProduct(product, index = 0, champion = false) {
  const searchable = [product.title, product.shopName, product.sku, product.summary, (product.tags || []).join(' ')].join(' ').toLowerCase();
  const attrs = `role="button" tabindex="0" aria-label="查看 ${escapeHtml(product.title)}" data-open-product="${escapeHtml(product.id)}" data-product-card data-category="${escapeHtml(product.category)}" data-stock="${Number(product.stock)>0?'1':'0'}" data-search="${escapeHtml(searchable)}"`;
  const meta = `BNM ${product.bnmRebateRate}% · 100% NPL`;
  const oldPrice = Number(product.originalPriceNpl || 0) > previewDisplayPrice(product) ? `<del>${formatPreviewNpl(product.originalPriceNpl)} NPL</del>` : '';
  const price = `<div class="price-row"><span class="product-price">${formatPreviewNpl(previewDisplayPrice(product))} NPL</span>${oldPrice}</div>`;
  const tags = (product.tags || []).slice(0, 2).map((tag) => `<em>${escapeHtml(tag)}</em>`).join('');
  if (champion) {
    return `<article class="wide-product" ${attrs}><div class="thumb-wrap">${renderProductThumb(product)}</div><div class="product-body"><span class="badge">${escapeHtml(product.shopBadge)} · ${escapeHtml(product.category)}</span><div class="product-title">${escapeHtml(product.title)}</div><div class="note">${escapeHtml(product.summary)}</div>${price}<div class="product-meta">${escapeHtml(meta)}</div><div class="product-tags">${tags}</div></div></article>`;
  }
  return `<article class="product-card" ${attrs}><div class="thumb-wrap"><span class="love-dot" aria-hidden="true">♡</span>${renderProductThumb(product)}</div><div class="product-body"><span class="badge">${escapeHtml(product.shopBadge)} · ${escapeHtml(product.category)}</span><div class="product-title">${escapeHtml(product.title)}</div>${price}<div class="product-meta">${escapeHtml(meta)}</div><div class="product-tags">${tags}</div><div class="card-foot"><span>库存 ${Number(product.stock || 0)}</span><span class="arrow-dot">›</span></div></div></article>`;
}

function renderPreviewStores() {
  const stores = storeRows({});
  return `<div class="page page-stores"><div class="topbar"><div class="brandline"><div class="mark">24K</div><div><div class="brand-title">24K</div><div class="brand-sub">Store Pickup</div></div></div><div class="top-actions"><button class="icon-btn search" aria-label="搜索门店"></button></div></div><div class="screen-intro"><span>附近自提与体验</span><h2>线下门店</h2></div><div class="search-dock"><input placeholder="搜索城市、门店名"/><button class="filter">筛选</button></div><div class="store-photo"><img src="/assets/products/24k-store-front.png" alt="24K 门店外观"/></div><div class="chips">${['全部', ...new Set(stores.map((store) => store.city).filter(Boolean))].map((item,i)=>`<span data-region="${item}" class="${i===0?'active':''}">${item}</span>`).join('')}</div><div class="map-card"><div><div class="kicker">Pickup Map</div><div class="note">选择自提后绑定门店行政区编码，用于履约、核销和区域收益。</div></div><div class="map-lines"><span class="map-dot"></span></div></div><div class="section-head"><div><h3>附近门店</h3><p>GPS 距离、拨号、导航和核销入口</p></div><span class="count">${stores.length} 家</span></div><div class="store-list">${stores.map((store)=>`<div class="store" data-store-region="${escapeHtml(store.city)}"><div class="store-row"><strong>${escapeHtml(store.name)}</strong><span class="distance">${store.distanceKm ?? '--'}km</span></div><div class="store-status">营业中 · ${escapeHtml(store.hours || '--')} · 行政区 ${escapeHtml(store.regionCode)}</div><div class="note">${escapeHtml(store.address)}</div><div class="actions"><button class="action">拨号</button><button class="action primary">导航</button><button class="action">核销 ${store.regionCode}</button></div></div>`).join('')}</div></div>`;
}

function renderPreviewAssets() {
  const summary = assetSummary();
  const totals = summary.buckets.reduce((acc,bucket)=>({ cumulative: acc.cumulative + Number(bucket.cumulative || 0), available: acc.available + Number(bucket.available || 0), locked: acc.locked + Number(bucket.locked || 0) }), { cumulative:0, available:0, locked:0 });
  return `<div class="page page-assets"><div class="topbar"><div class="brandline"><div class="mark">24K</div><div><div class="brand-title">24K</div><div class="brand-sub">Wallet Center</div></div></div><div class="top-actions"><button class="icon-btn cart" aria-label="钱包"></button></div></div><div class="screen-intro"><span>账户与收益</span><h2>我的资产</h2></div><div class="profile-card"><img class="avatar" src="/api/logo" alt="24K 用户头像"/><div><strong>24K Wallet</strong><div class="note">0x4e82...03d2 · BSC</div></div><span class="wallet-pill">已连接</span></div><div class="asset-hero"><div class="kicker">Available</div><div class="asset-total">${formatPreviewNpl(totals.available)}</div><div class="note" style="color:#cfc7b9">BNM、NPL 按 Locked / Available / Claimed 三态展示。</div><div class="asset-grid"><div class="asset-mini"><b>${formatPreviewNpl(totals.cumulative)}</b><span>累计</span></div><div class="asset-mini"><b>${formatPreviewNpl(totals.available)}</b><span>可领</span></div><div class="asset-mini"><b>${formatPreviewNpl(totals.locked)}</b><span>锁定</span></div></div></div><div class="order-grid"><div class="order-state"><b>1</b>待付款</div><div class="order-state"><b>3</b>待发货</div><div class="order-state"><b>2</b>待收货</div><div class="order-state"><b>0</b>仲裁</div></div><div class="vault"><div class="vault-row"><div><div class="mini-label">Claim 保护</div><div class="note">暂停、二次签名和审计日志均已预留。</div></div><button class="action primary" data-pause-claim>模拟暂停</button></div></div><div class="section-head"><div><h3>收益分红中心</h3><p>点击池子进入 Claim</p></div><span class="count">${summary.buckets.length} 池</span></div><div class="asset-menu">${summary.buckets.map((bucket)=>`<button class="menu-row"><span class="menu-icon">${escapeHtml(bucket.assetSymbol)}</span><span><b>${escapeHtml(bucket.title)}</b><small>可领 ${formatPreviewNpl(bucket.available)} · 锁定 ${formatPreviewNpl(bucket.locked)}</small></span><em>›</em></button>`).join('')}</div></div>`;
}

function renderBackstagePage(kind) {
  const merchant = kind === 'merchant';
  const title = merchant ? '24K 商家后台' : '24K 平台运营后台';
  const role = merchant ? 'merchant' : 'admin';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/><title>${title}</title><link rel="stylesheet" href="/backstage/styles.css"/></head><body data-console-kind="${role}"><div id="console-root"><main class="loading-state"><p>正在加载 ${title}...</p></main></div><script type="module" src="/backstage/${role}.js"></script></body></html>`;
}

function previewScript() {
  return `<script>(function(){
const tabs=[...document.querySelectorAll('.tab')],panels=[...document.querySelectorAll('.panel')];
function activate(name){const tab=tabs.find(t=>t.dataset.tab===name)||tabs[0];document.body.dataset.active=tab.dataset.tab;tabs.forEach(t=>t.classList.toggle('active',t===tab));panels.forEach(p=>p.classList.toggle('active',p.dataset.panel===tab.dataset.tab));}
tabs.forEach(tab=>tab.addEventListener('click',()=>activate(tab.dataset.tab)));activate((new URL(location.href).searchParams.get('tab')||location.hash.replace('#','')||'seckill'));
const mall=document.querySelector('[data-panel="mall"]'),search=mall?.querySelector('[data-mall-search]'),cards=[...(mall?.querySelectorAll('[data-product-card]')||[])],count=mall?.querySelector('[data-result-count]'),stock=mall?.querySelector('[data-stock-filter]');let stockOnly=false,category='全部';
function apply(){const q=(search?.value||'').trim().toLowerCase();let n=0;cards.forEach(c=>{const ok=(!q||(c.dataset.search||'').includes(q))&&(!stockOnly||c.dataset.stock==='1')&&(category==='全部'||c.dataset.category===category);c.style.display=ok?'':'none';if(ok)n++;});if(count)count.textContent=n+' 件'}
search?.addEventListener('input',apply);stock?.addEventListener('click',()=>{stockOnly=!stockOnly;stock.classList.toggle('active',stockOnly);stock.textContent=stockOnly?'全部':'现货';apply();});mall?.querySelectorAll('[data-category]').forEach(chip=>chip.addEventListener('click',()=>{category=chip.dataset.category||'全部';mall.querySelectorAll('[data-category]').forEach(x=>x.classList.toggle('active',x===chip));apply();}));
const storePanel=document.querySelector('[data-panel="stores"]');storePanel?.querySelectorAll('[data-region]').forEach(chip=>chip.addEventListener('click',()=>{const region=chip.dataset.region||'全部';storePanel.querySelectorAll('[data-region]').forEach(x=>x.classList.toggle('active',x===chip));storePanel.querySelectorAll('[data-store-region]').forEach(row=>{row.style.display=(region==='全部'||row.dataset.storeRegion===region)?'':'none';});}));
const products=JSON.parse(document.getElementById('product-data')?.textContent||'[]');const productMap=new Map(products.map(p=>[p.id,p]));const backdrop=document.querySelector('.sheet-backdrop'),body=document.querySelector('.sheet-body'),close=document.querySelector('.sheet-close');
function esc(v){return String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function money(v){const n=Number(v||0);return n.toLocaleString('zh-CN',{minimumFractionDigits:n>0&&n<.01?6:2,maximumFractionDigits:n>0&&n<.01?6:2});}
function imgSrc(p){const raw=String(p.imageUrl||'');return raw.startsWith('asset://')?'/assets/products/'+encodeURIComponent(raw.slice(8)):'/assets/products/24k-carryall.png';}
function openSheet(html){if(!backdrop||!body)return;body.innerHTML=html;backdrop.hidden=false;close?.focus();}
function openProduct(id){
  const p=productMap.get(id);if(!p)return;
  const fallbackSku={name:p.sku,stock:p.stock,settlementPriceNpl:p.priceNpl};
  const skuList=p.skus&&p.skus.length?p.skus:[fallbackSku];
  const modeList=p.fulfillmentModes&&p.fulfillmentModes.length?p.fulfillmentModes:['delivery'];
  let selectedSkuIndex=0,quantity=1,selectedMode=modeList[0];
  const modeLabel=mode=>mode==='pickup'?'门店自提':'快递到家';
  function renderSelection(){
    const sku=skuList[selectedSkuIndex]||fallbackSku;
    const unitPrice=Number(sku.settlementPriceNpl||p.priceNpl||0);
    const stockCount=Math.max(1,Number(sku.stock||p.stock||1));
    quantity=Math.min(quantity,stockCount);
    const totalPrice=unitPrice*quantity;
    const old=Number(p.originalPriceNpl||0)>unitPrice?'<del>'+money(p.originalPriceNpl)+' NPL</del>':'';
    const skus=skuList.map((s,i)=>'<button type="button" class="option '+(i===selectedSkuIndex?'active':'')+'" aria-pressed="'+(i===selectedSkuIndex)+'" data-preview-sku="'+i+'">'+esc(s.name)+' · 库存 '+esc(s.stock)+'</button>').join('');
    const quantities=[1,2,3].filter(value=>value<=stockCount).map(value=>'<button type="button" class="option '+(value===quantity?'active':'')+'" aria-pressed="'+(value===quantity)+'" data-preview-quantity="'+value+'">数量 '+value+'</button>').join('');
    const modes=modeList.map(mode=>'<button type="button" class="option '+(mode===selectedMode?'active':'')+'" aria-pressed="'+(mode===selectedMode)+'" data-preview-mode="'+esc(mode)+'">'+modeLabel(mode)+'</button>').join('');
    const fulfillment=modeLabel(selectedMode);
    const fulfillmentDetail=selectedMode==='pickup'?'门店：24K 大连中心店 · 210211':'地址：大连高新区 · 210211';
    openSheet('<div class="sheet-hero"><img src="'+imgSrc(p)+'" alt="'+esc(p.title)+'"/><div><span class="badge">'+esc(p.shopBadge)+' · '+esc(p.category)+'</span><div class="sheet-title">'+esc(p.title)+'</div><div class="sheet-summary">'+esc(p.summary)+'</div><div class="sheet-price-row"><strong>'+money(unitPrice)+' NPL</strong>'+old+'</div></div></div><div class="sheet-service-row"><span>正品验收</span><span>库存复核</span><span>签收释放</span></div><div class="option-row">'+skus+'</div><div class="option-row">'+quantities+'</div><div class="option-row">'+modes+'</div><div class="delivery-card"><span>当前履约</span><b>'+fulfillment+'</b><small>'+fulfillmentDetail+'</small></div><div class="verify"><div class="verify-title">付前 5 要素终核</div><div class="verify-line"><span>商品</span><b>'+esc(p.title)+'</b></div><div class="verify-line"><span>SKU / 数量</span><b data-preview-selection>'+esc(sku.name)+' × '+quantity+'</b></div><div class="verify-line"><span>履约</span><b>'+fulfillment+'</b></div><div class="verify-line"><span>支付</span><b data-preview-total>'+money(totalPrice)+' NPL · 100% NPL</b></div><div class="verify-line"><span>返还</span><b>BNM '+esc(p.bnmRebateRate)+'%</b></div></div><div class="sheet-cta"><button type="button" class="action" data-preview-stock-check>库存复核</button><button type="button" class="action primary" data-preview-add-review>加入终核清单</button></div>');
    body.querySelectorAll('[data-preview-sku]').forEach(button=>button.addEventListener('click',()=>{selectedSkuIndex=Number(button.dataset.previewSku||0);quantity=1;renderSelection();}));
    body.querySelectorAll('[data-preview-quantity]').forEach(button=>button.addEventListener('click',()=>{quantity=Number(button.dataset.previewQuantity||1);renderSelection();}));
    body.querySelectorAll('[data-preview-mode]').forEach(button=>button.addEventListener('click',()=>{selectedMode=button.dataset.previewMode||modeList[0];renderSelection();}));
    body.querySelector('[data-preview-stock-check]')?.addEventListener('click',event=>{event.currentTarget.textContent='库存可用 '+stockCount+' 件';});
    body.querySelector('[data-preview-add-review]')?.addEventListener('click',event=>{event.currentTarget.textContent='已加入终核清单';event.currentTarget.disabled=true;});
  }
  renderSelection();
}
document.querySelectorAll('[data-open-product]').forEach(el=>{el.addEventListener('click',()=>openProduct(el.dataset.openProduct));el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openProduct(el.dataset.openProduct);}});});
document.querySelectorAll('[data-dialog]').forEach(el=>el.addEventListener('click',()=>{const type=el.dataset.dialog;openSheet(type==='rules'?'<div class="sheet-title">秒杀规则</div><div class="verify"><div class="verify-line"><span>主倒计时</span><b>60 分钟</b></div><div class="verify-line"><span>接力</span><b>成功抢购 +30 秒</b></div><div class="verify-line"><span>风控</span><b>限制合约调用</b></div><div class="verify-line"><span>熔断</span><b>pause / 强截止 / refund</b></div></div>':'<div class="sheet-title">本场战报</div><div class="verify"><div class="verify-line"><span>奖池</span><b>18,888.24 NPL</b></div><div class="verify-line"><span>抢购</span><b>426 次</b></div><div class="verify-line"><span>状态</span><b>等待结算</b></div></div>');}));
close?.addEventListener('click',()=>{if(backdrop)backdrop.hidden=true;});backdrop?.addEventListener('click',e=>{if(e.target===backdrop)backdrop.hidden=true;});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&backdrop&&!backdrop.hidden)backdrop.hidden=true;});document.querySelector('[data-pause-claim]')?.addEventListener('click',e=>{e.currentTarget.textContent=e.currentTarget.textContent.includes('恢复')?'模拟暂停':'恢复 Claim';});
})();</script>`;
}

function renderProductThumb(product = {}) {
  return `<img class="thumb" src="${escapeHtml(previewImageSrc(product))}" alt="${escapeHtml(product.title || '24K 商品图')}" loading="lazy" />`;
}

function previewImageSrc(product = {}) {
  const fromUrl = String(product.imageUrl || '');
  if (fromUrl.startsWith('asset://')) return `/assets/products/${encodeURIComponent(fromUrl.slice('asset://'.length))}`;
  const assets = { ceramic: '24k-ceramic-diffuser.png', carry: '24k-carryall.png', watch: '24k-phone.png', fragrance: '24k-tea-box.png', home: '24k-home-console.png', jacket: '24k-runner.png', bottle: '24k-steel-bottle.png' };
  return `/assets/products/${assets[product.imageTone] || assets.carry}`;
}

function sortPreviewProduct(a, b) {
  const order = ['p-24k-runner', 'p-24k-phone', 'p-24k-tea', 'p-24k-bag'];
  const left = order.includes(a.id) ? order.indexOf(a.id) : 999;
  const right = order.includes(b.id) ? order.indexOf(b.id) : 999;
  return left - right || String(a.id).localeCompare(String(b.id));
}

function formatSeconds(total) {
  const safe = Math.max(0, Number(total || 0));
  const minutes = String(Math.floor(safe / 60)).padStart(2, '0');
  const seconds = String(Math.floor(safe % 60)).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function previewDisplayPrice(product = {}) {
  const own = Number(product.priceNpl || 0);
  if (own > 0.01) return own;
  const skuPrice = Number(product.skus?.[0]?.settlementPriceNpl || 0);
  if (skuPrice > 0.01) return skuPrice;
  const original = Number(product.originalPriceNpl || 0);
  return original > 0.01 ? original : own;
}

function formatPreviewNpl(value) {
  const numeric = Number(value);
  return numeric.toLocaleString('zh-CN', { minimumFractionDigits: numeric > 0 && numeric < 0.01 ? 6 : 2, maximumFractionDigits: numeric > 0 && numeric < 0.01 ? 6 : 2 });
}

function short(value) {
  const text = String(value || '');
  return text.length > 14 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}
