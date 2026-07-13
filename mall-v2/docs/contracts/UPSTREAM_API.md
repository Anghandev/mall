# Mall V2 Upstream API Contract

Status: consumer proposal `mall-api-v1`. The customer app fails closed until the platform publishes a compatible version.

## Transport

- Production API uses HTTPS and the event stream uses WSS.
- Every response includes `version`, `requestId`, and `serverTime` (Unix seconds).
- Exact token amounts are decimal integer strings in base units. Display metadata supplies `symbol` and `decimals`.
- Mutation requests require a buyer SIWE session and an `Idempotency-Key` header.
- Unknown enum values render as unavailable and are never coerced to a known financial state.

## Required Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dapp/bootstrap` | Runtime version, chain, token metadata, contract addresses, feature availability |
| GET | `/api/dapp/seckill-state?address=` | Current session, phase, timers, pool, feed cursor, report, rules, CTA, prize claim |
| GET | `/api/dapp/seckill-reports?cursor=` | Historical reports |
| GET | `/api/dapp/mall-state?category=&cursor=` | Categories and paginated products |
| GET | `/api/dapp/products/:productId` | Product, SKU, inventory display, fulfillment availability |
| POST | `/api/dapp/stock-preflight` | Signed short-lived inventory reservation and authoritative quote |
| POST | `/api/dapp/final-check` | Immutable five-factor review payload |
| POST | `/api/dapp/checkout-intent` | Ordinary checkout wallet transaction sequence |
| POST | `/api/dapp/seckill-intent` | Seckill checkout plus optional record-purchase transaction |
| GET | `/api/dapp/stores-state?country=&city=&district=&lat=&lng=` | Linked regions and eligible stores sorted by distance |
| GET | `/api/dapp/assets-state?address=` | Profile, addresses, order groups, activity, reward buckets, claims |
| POST | `/api/dapp/address-parse` | Parse pasted address text without logging raw PII |
| POST | `/api/dapp/addresses` | Add address |
| PATCH | `/api/dapp/addresses/:addressId` | Edit or set default address |
| DELETE | `/api/dapp/addresses/:addressId` | Delete address |
| GET | `/api/dapp/orders/:orderId` | Authoritative detail, timeline, logistics, allowed actions |
| POST | `/api/dapp/orders/:orderId/after-sale` | Exchange or delayed-receipt request |
| POST | `/api/dapp/orders/:orderId/timeout-refund` | Buyer no-shipment refund request when eligible |
| POST | `/api/dapp/orders/:orderId/complete-intent` | Confirm receipt/pickup transaction intent |
| POST | `/api/dapp/claims/:rewardId/intent` | Claim transaction intent |
| GET | `/api/dapp/transactions/:txHash` | Canonical receipt, replacement, confirmation, and finality state |

## Core Shapes

```ts
type ExactAmount = {
  asset: 'USDT' | 'NPL' | 'BNM';
  amount: string;
  decimals: number;
  display: string;
};

type WalletTransaction = {
  key: string;
  chainId: 56;
  to: `0x${string}`;
  data: `0x${string}`;
  value: '0';
  dependsOn?: string[];
  description: string;
};

type AllowedAction = {
  key: 'pay' | 'confirmReceipt' | 'requestExchange' | 'requestDelay' |
    'requestTimeoutRefund' | 'claim' | 'openSeckill';
  enabled: boolean;
  reason?: string;
};
```

`stock-preflight` returns `reservationId`, `expiresAt`, exact `quote`, product/SKU/quantity, fulfillment assertion, immutable region code, and a signed digest. `checkout-intent` must reject expired or mismatched reservations.

An intent returns an ordered `transactions` array. The app checks allowance locally only to decide whether an approval transaction is necessary; it never edits payment calldata or amount fields.

## Event Stream

Connect to `wss://<api>/api/dapp/events?cursor=<lastCursor>&address=<wallet>`.

Each event includes:

```ts
type MallEvent = {
  version: 'mall-event-v1';
  cursor: string;
  id: string;
  sequence: number;
  occurredAt: number;
  type: 'seckill.purchase' | 'seckill.phase' | 'seckill.settled' |
    'order.updated' | 'logistics.updated' | 'reward.updated' | 'transaction.updated';
  payload: unknown;
};
```

Clients deduplicate by `id`, require monotonically increasing `sequence`, reconnect with the last committed cursor, and fetch the affected aggregate after each financial event. The polling fallback reads the same aggregate endpoints and never manufactures events.

## Errors

Errors use `{ error, code, message, requestId, retryable, fieldErrors? }`. Required codes include:

- `AUTH_REQUIRED`, `SESSION_EXPIRED`, `CHAIN_MISMATCH`
- `CONTRACTS_UNAVAILABLE`, `FEATURE_PAUSED`, `UPSTREAM_UNAVAILABLE`
- `QUOTE_EXPIRED`, `RESERVATION_EXPIRED`, `STOCK_CHANGED`, `PRODUCT_LOCKED_FOR_SECKILL`
- `ACTION_NOT_ALLOWED`, `ORDER_STATE_CHANGED`, `CLAIM_NOT_AVAILABLE`
- `TRANSACTION_REVERTED`, `TRANSACTION_REPLACED`, `FINALITY_PENDING`

## Production Fail-Closed Rules

- Missing or invalid bootstrap addresses disable wallet writes.
- Fixture mode is rejected when `NODE_ENV=production` or the API base URL is not explicitly configured.
- A missing `allowedActions` list means no mutation CTA is rendered.
- A missing finality state means the app remains in `confirming` and refreshes; it never shows success.

