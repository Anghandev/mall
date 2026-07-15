# Abu 24K Merchant Workbench V2

React + TypeScript merchant workbench. It owns only this directory, consumes
coordinated Core artifacts and fails closed when a required capability is
unpublished.

## Local checks

```sh
pnpm --filter @abu24k/merchant check
```

The app consumes the coordinated `@abu24k/core-artifacts` workspace package at
`2.0.0-settlement-admin.6`. In addition to Bootstrap, merchant SIWE and the
payment/fulfillment surfaces, the workbench consumes merchant finance,
guarantee-deposit evidence, settlement intents, signed settlement requests and
Safe-finality history. The help center reads wallet-targeted published CMS
rules and displays their bound policy version. The product center consumes the
merchant-bound one-store-one-product slot, generated lifecycle/actions/locks,
complete SKU and inventory fields, write-once media intents, controlled media
reads, signed concession previews, review submission and logical delisting.
Settlement typed data is checked against the immutable
Core intent before the connected merchant wallet signs it. Guarantee, debt,
takeover and five-state balances are rendered as exact Core atomic amounts. NPL
reward rows consume Core's generated subtype enum, while BNM consumes the
Core-projected Locked/Available points totals and remains explicitly
non-transferable with no settlement action. The browser does not aggregate or
recalculate authoritative funds.

The dashboard and finance-center Today metric consume
`GET /v2/merchant/dashboard` directly. Core owns the `Asia/Shanghai` day
window, 15-confirmation payment cohort, exact payment snapshots, current
fulfillment queues, pickup count, product lifecycle/seckill state and shipment
ratio. The UI displays these fields without recomputing amounts or treating an
empty cohort as a zero-percent shipment rate. Platform-only `SAFE_COVERAGE`
availability does not gate the merchant projection.

The fulfillment center consumes Core's stable `(createdAt, orderId)` cursor,
server-side date/SKU/state/mode/order-kind filters, complete quantity/payment
TxHash/order-kind/`allowedActions` rows, and the atomic manual-shipment batch.
Batch retries preserve the batch and item idempotency keys. The browser submits
only Core-issued canonical tracking/evidence hashes and does not derive them.

PII-safe Excel export, electronic-waybill and printer providers, profile
migration and merchant audit remain fail
closed until their coordinated capabilities are
published or configured. The browser never calls the buyer-only payment
projection with a merchant session.

Core is expected on the same origin. A separately hosted local Core can be
selected with `VITE_CORE_API_BASE_URL`; production deployment must provide the
corresponding HTTPS/CORS policy rather than a client-side fallback.

For local visual review only, run the dev server and append
`?__merchant_visual_review__=1` to a workspace route such as
`/dashboard?__merchant_visual_review__=1`. Vite
removes this development-only branch from the production bundle, and
`bundle:check` verifies that removal.
