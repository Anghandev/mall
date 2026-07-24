#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, getAddress } from 'ethers';
import pg from 'pg';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '../..');

export function assertCleanupSnapshot(snapshot) {
  if (!snapshot.primaryChain56 || !snapshot.fallbackChain56) {
    throw new Error('Cleanup gate requires two BSC chain-56 RPC observations');
  }
  if (!snapshot.primaryPaymentsPaused || !snapshot.fallbackPaymentsPaused) {
    throw new Error('Cleanup gate requires the Router new-payment breaker paused on both RPCs');
  }
  if (!snapshot.databasePaymentsPaused) {
    throw new Error('Cleanup gate requires the Core new-payment breaker projection paused');
  }
  if (!['HIDDEN', 'DELISTED'].includes(snapshot.productState)) {
    throw new Error('Cleanup gate requires the micro-test product delisted');
  }
  if (snapshot.now < snapshot.entitlementExpiresAt) {
    throw new Error('Cleanup gate requires the entitlement and every bounded quote deadline to expire');
  }
  if (snapshot.activeQuotes !== 0 || snapshot.activeReservations !== 0) {
    throw new Error('Cleanup gate found a live micro-test quote or reservation');
  }
  if (snapshot.activeSettlementRequests !== 0) {
    throw new Error('Cleanup gate found a non-terminal micro-test settlement request');
  }
  if (snapshot.unsettledTransfers !== 0) {
    throw new Error('Cleanup gate found an unsettled micro-test transfer');
  }
}

export async function runCleanupGate(env = process.env, now = new Date()) {
  const scope = cleanupScope(env);
  const databaseUrl = required(env.DATABASE_URL, 'DATABASE_URL');
  const primaryRpcUrl = httpsUrl(env.BSC_RPC_URL, 'BSC_RPC_URL');
  const fallbackRpcUrl = httpsUrl(env.BSC_FALLBACK_RPC_URL, 'BSC_FALLBACK_RPC_URL');
  if (normalizeUrl(primaryRpcUrl) === normalizeUrl(fallbackRpcUrl)) {
    throw new Error('Cleanup gate requires distinct BSC RPC URLs');
  }
  const manifest = JSON.parse(readFileSync(
    resolve(repoRoot, 'packages/core-artifacts/contracts/contract-manifest.json'),
    'utf8',
  ));
  const routerAddress = getAddress(required(
    manifest.contracts?.find((entry) => entry.name === 'PaymentRouterV2')?.address,
    'PaymentRouter deployment address',
  ));
  const [primary, fallback] = await Promise.all([
    observeRouter(primaryRpcUrl, routerAddress),
    observeRouter(fallbackRpcUrl, routerAddress),
  ]);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT
         (SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_PAYMENT') AS payments_paused,
         (SELECT lifecycle_state FROM core.products
           WHERE product_id = $1 AND merchant_id = $2) AS product_state,
         (SELECT count(*)::int FROM core.payment_quotes
           WHERE product_id = $1 AND lower(buyer_wallet) = ANY($3::text[])
             AND state = 'QUOTED' AND deadline > $4) AS active_quotes,
         (SELECT count(*)::int
           FROM core.inventory_reservations reservation
           JOIN core.payment_quote_legs leg ON leg.reservation_id = reservation.reservation_id
           JOIN core.payment_quotes quote ON quote.order_id = leg.order_id
           WHERE quote.product_id = $1 AND lower(quote.buyer_wallet) = ANY($3::text[])
             AND reservation.state = 'ACTIVE' AND reservation.expires_at > $4) AS active_reservations,
         (SELECT count(DISTINCT request.request_id)::int
           FROM core.settlement_requests request
           JOIN core.settlement_request_items item ON item.request_id = request.request_id
           JOIN core.orders micro_order ON micro_order.order_id = item.order_id
           WHERE micro_order.product_id = $1 AND micro_order.merchant_id = $2
             AND lower(micro_order.buyer_wallet) = ANY($3::text[])
             AND request.state NOT IN ('SETTLED', 'FAILED_CLOSED')) AS active_settlement_requests,
         (SELECT count(*)::int FROM core.settlement_transfers
           WHERE authorization_mode = 'MAINNET_MICROTEST' AND state <> 'SETTLED') AS unsettled_transfers`,
      [scope.productId, scope.merchantId, scope.buyerWallets, now],
    );
    const row = result.rows[0] ?? {};
    const snapshot = {
      now,
      entitlementExpiresAt: scope.expiresAt,
      primaryChain56: primary.chainId === 56n,
      fallbackChain56: fallback.chainId === 56n,
      primaryPaymentsPaused: primary.paused,
      fallbackPaymentsPaused: fallback.paused,
      databasePaymentsPaused: row.payments_paused === true,
      productState: row.product_state ?? null,
      activeQuotes: Number(row.active_quotes ?? -1),
      activeReservations: Number(row.active_reservations ?? -1),
      activeSettlementRequests: Number(row.active_settlement_requests ?? -1),
      unsettledTransfers: Number(row.unsettled_transfers ?? -1),
    };
    assertCleanupSnapshot(snapshot);
    return snapshot;
  } finally {
    await client.end();
  }
}

async function observeRouter(url, routerAddress) {
  const provider = new JsonRpcProvider(url, 56, { staticNetwork: true });
  try {
    const [network, paused] = await Promise.all([
      provider.getNetwork(),
      new Contract(routerAddress, ['function newPaymentsPaused() view returns (bool)'], provider)
        .newPaymentsPaused(),
    ]);
    return { chainId: network.chainId, paused: paused === true };
  } finally {
    provider.destroy();
  }
}

function cleanupScope(env) {
  const merchantId = boundedId(env.MAINNET_MICROTEST_MERCHANT_ID, 'merchant ID');
  const productId = boundedId(env.MAINNET_MICROTEST_PRODUCT_ID, 'product ID');
  const buyers = required(env.MAINNET_MICROTEST_BUYER_WALLETS, 'buyer wallets')
    .split(',')
    .map((value) => getAddress(value.trim()).toLowerCase());
  if (new Set(buyers).size !== 3) throw new Error('Cleanup gate requires exactly three buyer wallets');
  const expiresAt = new Date(required(env.MAINNET_MICROTEST_EXPIRES_AT, 'expiry'));
  if (!Number.isFinite(expiresAt.getTime())) throw new Error('Cleanup gate expiry is invalid');
  return { merchantId, productId, buyerWallets: buyers, expiresAt };
}

function boundedId(value, label) {
  const normalized = required(value, label).trim();
  if (normalized.length < 8 || normalized.length > 128 || !/^[a-z0-9:-]+$/i.test(normalized)) {
    throw new Error(`Cleanup gate ${label} is invalid`);
  }
  return normalized;
}

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Cleanup gate requires ${label}`);
  return value.trim();
}

function httpsUrl(value, label) {
  const parsed = new URL(required(value, label));
  if (parsed.protocol !== 'https:') throw new Error(`Cleanup gate ${label} must use HTTPS`);
  return parsed.toString();
}

function normalizeUrl(value) {
  const parsed = new URL(value);
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString();
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runCleanupGate()
    .then(() => console.log('OK mainnet micro-test cleanup gate'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Mainnet micro-test cleanup gate failed');
      process.exitCode = 1;
    });
}
