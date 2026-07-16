# Abu 24K Mall V2

React + TypeScript mobile-size Web DApp. Business work follows the frozen Mall
Requirement Matrix and consumes only coordinated Core artifacts.

## Current Runtime Boundary

- Production consumes coordinated Core artifacts `2.0.0-settlement-admin.11` and derives
  its HTTP paths from the published OpenAPI document.
- The public catalog consumes active products/SKUs, enabled three-level
  categories, enabled tags, field-level product associations, rich detail,
  freight, fulfillment modes and SKU-level seckill overlays. Category/tag
  filtering and ordinary-checkout blocking use only those Core fields. Every image or
  video URL comes from Core's short-lived media-read endpoint and is checked
  against the expected asset, resource, purpose and content type; the Mall does
  not construct an OSS/CDN path.
- The real payment consumer covers SIWE, product/SKU reads, ordinary and dual
  seckill quotes, atomic reservations, approval requirements, ABI-shaped
  `routerCall`, transaction submission and indexed payment projections.
- Prices, payment legs, allocation amounts and finality are rendered exactly
  from Core responses. The Mall does not recalculate them or treat a submitted
  TxHash as final.
- The Mall consumes published stores, browser-location-backed delivery/pickup
  targets and stable wallet order pages keyed by `(createdAt, orderId)`. Complete
  order rows carry quantity, kind, payment TxHash, logistics, balances and
  authoritative `allowedActions`; no second action lookup or local state
  inference is used. The checkpoint's carrier, provider, warehouse, waybill
  and print administration remains platform-only and is not exposed by Mall.
- The coordinated artifact includes the merchant-only order export operation,
  but Mall strips every `/v2/merchant/**` path and `merchant*` capability before
  bundling. Merchant export PII schemas and fixtures are not part of Mall
  production code.
- Admin payment, settlement-request and settlement-batch clearing reads remain
  platform-only. Mall strips every `/v2/admin/**` path before bundling and has no
  clearing operation, schema, UI or fixture.
- Admin takeover assignment and replacement-merchant fulfillment remain outside
  the Mall consumer. Buyer order rows continue to use only the buyer-scoped
  takeover timeline and receipt-confirmation API.
- Transferable balances now render Core-projected Locked, Available, Requested,
  Batched and Settled states. Available NPL reward and USDT prize balances use
  a wallet-bound EIP-712 settlement intent; the Mall never creates settlement
  calldata or pays Safe Gas. Settled requests show the final Safe TxHash.
- Seckill current/history/session/event reads and `/v2/ws` use the same artifact
  version. The consumer performs HTTP replay before WebSocket delivery,
  deduplicates `eventId`, resumes from the last numeric cursor, accepts only
  `FINAL` events and reloads artifacts after close `4409`.
- Published CMS content, the wallet notification inbox and the IN_APP/CORE
  endpoint are consumed from the same OpenAPI and generated-types checkpoint.
  Reward sub-type attribution renders only when Core projects the wallet's
  genesis, direct, district, city, province, region, operations or rounding
  subtype. BNM account totals render only Locked/Available and never enter a
  settlement action.
- Enabled `REQUEST_EXCHANGE`, `REQUEST_DELAY`, `CONFIRM_RECEIPT` and
  `OPEN_ARBITRATION` actions use the `.9` write-once upload, verification,
  order-evidence envelope and command endpoints. The browser hashes optional
  JPG/PNG/WebP/PDF evidence locally and never asks the buyer to paste a hash.
  `OPEN_TAKEOVER` remains fail closed because it is absent from the published
  evidence-action schema; `VERIFY_PICKUP` evidence is authorized only for
  merchant/platform roles.
- The coordinated manifest still has `deploymentAuthorized=false` and no
  executable `PAY_ORDER`. Wallet broadcast therefore remains fail closed until
  Core publishes deployment evidence. Native navigation, production-device GPS
  evidence remain externally blocked rather than using production fixtures.
- The copied brand assets in `public/brand/` have no runtime dependency on the
  read-only legacy tree.

## Routes

- `/seckill`, `/mall`, `/stores`, `/assets`
- `/assets/addresses`, `/assets/orders`, `/assets/activity`, `/assets/rewards`,
  `/assets/notifications`
- `/checkout`, `/checkout/review`

## Local Verification

```bash
pnpm --filter @abu24k/mall check
pnpm --filter @abu24k/mall test:e2e
```

The browser suite starts Vite on `127.0.0.1:4311` and verifies 375, 393 and
430 pixel mobile widths plus a 430 pixel centered frame on desktop.
