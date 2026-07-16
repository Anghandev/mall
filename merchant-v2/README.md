# Abu 24K Merchant Workbench V2

React + TypeScript merchant workbench. It owns only this directory, consumes
coordinated Core artifacts and fails closed when a required capability is
unpublished.

## Local checks

```sh
pnpm --filter @abu24k/merchant check
```

The app consumes the coordinated `@abu24k/core-artifacts` workspace package at
`2.0.0-merchant-stores.1`. In addition to Bootstrap, merchant SIWE and the
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

The store center consumes merchant-scoped managed-store reads and versioned
create, profile-update, activate and close commands. Creation submits only the
merchant-entered profile plus AMap coordinates; Core owns reverse geocoding and
returns the immutable six-digit region, formatted address and coordinates.
Store photos use owned `STORE_IMAGE` intent -> provider PUT -> completion ->
controlled-read evidence and are limited to one through five for activation.
Every command preserves its idempotency key on retry, uses the current Core
version and renders Core capabilities, conflicts and authorization failures
without a browser-side state transition. The signed printer-binding flow
remains available as a separate store-scoped command.

The dashboard and finance-center Today metric consume
`GET /v2/merchant/dashboard` directly. Core owns the `Asia/Shanghai` day
window, 15-confirmation payment cohort, exact payment snapshots, current
fulfillment queues, pickup count, product lifecycle/seckill state and shipment
ratio. The UI displays these fields without recomputing amounts or treating an
empty cohort as a zero-percent shipment rate. Platform-only `SAFE_COVERAGE`
availability does not gate the merchant projection.

The fulfillment center consumes Core's stable `(createdAt, orderId)` cursor,
server-side date/SKU/state/mode/order-kind filters, complete quantity/payment
TxHash/order-kind/`allowedActions` rows, the atomic manual-shipment batch,
provider-issued electronic waybills and durable print jobs. Batch and print
retries preserve their idempotency keys. The browser submits only published
provider/carrier/store/order fields or Core-issued canonical tracking/evidence
hashes; it does not derive tracking numbers, print content or financial state.
Carrier codes come from the generated Core enum. Platform carrier enablement
and provider configuration remain Core authority: `ConfigurationRequired` and
`InvalidRequest` responses stay visible and never become a browser-side
success, and the workbench does not consume platform configuration writes.

The settings center consumes the tenant-scoped merchant profile with optimistic
versioning and stable retry keys. Shop name and a provider-sealed,
merchant-owned `MERCHANT_LOGO` asset are editable; the settlement wallet is
always read-only and is never sent in the profile PUT body. Concurrent profile
updates fail closed and require a fresh Core version before resubmission.
Platform qualification review and business-license PII stay in the admin-owned
lifecycle service and are never read or written by this self-service profile.
Platform global search, global exports and product batch-tag operations are
Admin-only and are excluded from the Merchant API and production bundle.

Merchant audit consumes the reverse-time, tenant-scoped entry stream with
server-side time/stream/event/module filters and cursor pagination. The UI
shows signature and Safe/chain transaction hashes while labeling
`PARTIAL_PRE_MERCHANT_SCOPE` accurately instead of presenting a scoped page
count as global chain proof. Bounded CSV export downloads only Core-returned
content for ranges of at most 31 days and at most 1,000 rows.

PII-safe Excel export and governed settlement-wallet migration remain fail
closed. Real provider accounts, authorized production wallets and physical
printer acceptance remain externally blocked. The browser never calls the buyer-only payment
projection with a merchant session.

Core is expected on the same origin. A separately hosted local Core can be
selected with `VITE_CORE_API_BASE_URL`; production deployment must provide the
corresponding HTTPS/CORS policy rather than a client-side fallback.

For local visual review only, run the dev server and append
`?__merchant_visual_review__=1` to a workspace route such as
`/dashboard?__merchant_visual_review__=1`. Vite
removes this development-only branch from the production bundle, and
`bundle:check` verifies that removal.
