# Abu 24K V2 Core API Contract

Status: coordinated settlement/admin checkpoint `2.0.0-settlement-admin.16`. OpenAPI,
generated types, ABI, manifests, enums, the fail-closed WebSocket protocol and
consumer tests share this version. This checkpoint does not authorize a
new deployment or transaction.

## Authority

Core is authoritative for catalog identity/state, price, inventory, signed
merchant-concession previews, payment legs, allocations, policy and
beneficiary snapshots, reservations, seckill boundary classification, chain
finality, fulfillment targets, order transitions and ledger release. Products
submit user choices, wallet signatures, transaction hashes and immutable
fulfillment evidence. They do not calculate funds, choose a classification,
infer success from a transaction hash or release balances locally.

Token amounts are unsigned integer decimal strings. IDs used by the Router are
`bytes32`. BSC finality is fixed at 15 canonical confirmations. Missing policy
decisions return `DecisionBlocked`; missing configured EOA executor, signer, RPC or provider inputs
return `ExternalBlocked` or `ConfigurationRequired`.

## Authentication

- SIWE binds the configured domain and URI, BSC chain 56, wallet, one-use nonce,
  issue time and five-minute expiry.
- JWT sessions bind the wallet and server-owned roles. Buyer payment endpoints
  require a `BUYER` role.
- Kuaidi100 and Cainiao callbacks use `x-provider-signature`, calculated over
  the exact raw request body with the configured HMAC secret. They do not use a
  product JWT.
- Trusted chain, edge-auth and order services submit risk observations with the
  separate opaque `RISK_SIGNAL_TOKEN`. That token cannot access Admin routes,
  and an Admin JWT cannot submit an internal observation.
- Every response includes `x-correlation-id`. Errors use the generated Core
  error-code catalog and fail closed.

## Payment Contract

For a signed launch quote:

```text
product USDT leg   = 70% of USDT list price
platform fee       = 1% of list price -> Platform Service Fee EOA
Custody product    = product USDT leg - platform fee -> USDT Custody EOA
delivery freight  = product defaultFreightUsdt; pickup freight = 0
buyer USDT payment = product USDT leg + freight
buyer NPL payment  = 30% of the exact Core-quoted NPL equivalent
NPL Burn           = 20% of the same Core quote
NPL Reward EOA     = 10% of the same Core quote
BNM Locked         = USDT list price, as backend points only
```

Freight is pure USDT outside the product 70/30 base. It never changes NPL,
Burn, reward, BNM, concession or prize amounts. Merchant concession never
changes buyer payment. Core returns merchant base receivable, concession, net
receivable, freight receivable and exact versioned allocation entries.
The NPL reward allocation balances exactly to the NPL Reward EOA amount; missing
beneficiaries and rounding remainder use the frozen circulation pool.
For a seckill quote, governed `seckillPrizePoolAccount` and `seckillPrizeBps`
create an exact `SECKILL_PRIZE_LIABILITY` entry. Ordinary and fallback-retail
quotes never create that entry. The prize account is included in the
policy-published allocation-set hash and is never inferred from array position or
destination weight.

An ordinary quote contains the exact `CanonicalPaymentIntent`, including
`productUsdtPaymentAmount`, `freightUsdt` and total `usdtPaymentAmount`, Router address,
snapshot hash, EIP-712 authorization digest, quote signature and two approval
requirements. Each requirement includes the exact amount, MaxUint256 approval
policy, `ONLY_IF_ALLOWANCE_BELOW_REQUIRED`, unlimited-allowance risk and an
ERC-20 `approve(0)` revocation instruction. Products must not request another
approval when the current allowance is sufficient.

The response also publishes the complete wallet EIP-712 domain, types, readable
message and ABI-shaped `routerCall`. Consumers recompute the digest before
signing and encode `pay` or `paySeckill` directly with the coordinated ABI. They
must not handwrite tuple order, calldata or a parallel signing schema.

A seckill quote contains signed seckill and retail-fallback intents with
independent reservations. The approval requirement covers the larger amount of
the two possible branches. `PaymentRouterV2` uses block timestamp to select the
branch atomically; products never select it.

Public catalog products expose typed subtitle, category/tag assignments,
structured rich detail, flat default delivery freight, fulfillment modes and a
nullable SKU-level seckill overlay. `PREHEAT`, `LIVE` and `SETTLING` overlays
set `ordinaryCheckoutAllowed: false`. Core independently rejects an ordinary
quote for the same product/SKU in those effective phases; the overlay is not a
security boundary. Ordinary quote issuance and seckill activation serialize on
the same SKU lock. A session cannot enter a blocking phase while an unexpired
ordinary quote remains submittable.

## HTTP Surface

Public reads:

- `GET /v2/bootstrap`
- `GET /v2/catalog/products`
- `GET /v2/catalog/products/{productId}`
- `GET /v2/catalog/categories`
- `GET /v2/catalog/tags`
- `GET /v2/stores` with an optional six-digit `regionCode`
- `GET /v2/media/assets/{assetId}/access` for referenced public catalog media;
  an optional Bearer session extends access to authorized private resources

Authentication:

- `POST /v2/auth/nonce`
- `POST /v2/auth/verify`

Authenticated Core reads and writes:

- `POST /v2/actions/order`
- `POST /v2/payments/quotes`
- `POST /v2/seckill/quotes`
- `POST /v2/payments/submissions`
- `GET /v2/payments/{orderId}`
- `POST /v2/stores`
- `POST /v2/fulfillment-targets/delivery`
- `POST /v2/fulfillment-targets/pickup`
- `POST /v2/media/upload-intents`
- `POST /v2/media/upload-intents/{uploadIntentId}/complete`
- `GET /v2/orders`
- `GET /v2/orders/{orderId}`
- `GET /v2/orders/{orderId}/fulfillment-target`
- `POST /v2/orders/{orderId}/shipments`
- `POST /v2/orders/{orderId}/delivery`
- `POST /v2/orders/{orderId}/pickup-credential`
- `POST /v2/orders/{orderId}/pickup-verification`
- `POST /v2/orders/{orderId}/exchange-requests`
- `POST /v2/orders/{orderId}/delay-requests`
- `POST /v2/orders/{orderId}/request-decisions`
- `POST /v2/orders/{orderId}/arbitrations`
- `POST /v2/orders/{orderId}/arbitration-decisions`
- `POST /v2/orders/{orderId}/takeover`
- `POST /v2/orders/{orderId}/forced-receipt-requests`
- `POST /v2/orders/{orderId}/forced-receipt-decisions`
- `POST /v2/orders/{orderId}/receipt-confirmation`
- `POST /v2/orders/{orderId}/evidence`
- `POST /v2/orders/{orderId}/tracking-evidence`
- `POST /v2/shipments/batches`

Buyer account and saved-address routes:

- `GET|PUT /v2/buyer/profile`
- `POST /v2/buyer/addresses/parse`
- `GET|POST /v2/buyer/addresses`
- `PUT|DELETE /v2/buyer/addresses/{addressId}`
- `POST /v2/buyer/addresses/{addressId}/default`
- `POST /v2/buyer/addresses/{addressId}/fulfillment-target`
- `GET /v2/buyer/overview`
- `GET /v2/orders/{orderId}/takeover-timeline`

The parser request is ephemeral: raw pasted text is not persisted or written to
audit. Saving requires complete name, mainland mobile number, address and
coordinates plus a current AMap six-digit region result. Nickname and address
PII use AES-256-GCM; one active default address is enforced transactionally.
A saved address creates a fresh 30-minute fulfillment target and never rewrites
the target snapshot of an existing quote or order. The first successful BUYER
SIWE creates one permanent numeric UID for the wallet; buyer profile returns it
as `accountId`. Buyer name, phone and detailed address remain encrypted long
term. Launch performs no automatic day-based masking or deletion; every full
PII read/export revalidates current authorization and atomically writes audit
evidence before returning plaintext. Role-scoped redacted projections remain.

Merchant profile and audit routes:

- `GET|PUT /v2/merchant/profile`
- `GET /v2/merchant/audit/entries`
- `POST /v2/merchant/audit/exports`

Merchant profile updates accept only shop name and an owned provider-sealed
Logo asset. The settlement wallet is returned read-only and is never an
ordinary profile-update field. After approval it is permanently immutable and
is not exposed as an Admin review action; a wrong pre-approval address requires
rejecting that application and creating a new one. Merchant audit requires a current active wallet
binding and filters by explicit `merchant_id`; actor-wallet filtering cannot
cross that boundary. Responses expose bounded summaries and proof references,
not raw payloads. CSV export requires a time range of at most 31 days, returns
at most 1,000 rows, neutralizes spreadsheet formulas and records the export.
The list proof is tenant-scoped and never returns global stream counts or head
hashes. Until an append-only historical tenant mapping is approved, the API
reports `PARTIAL_PRE_MERCHANT_SCOPE` instead of claiming complete legacy audit
history.

Risk management:

- `POST /v2/internal/risk/observations`
- `GET /v2/admin/risk/overview`
- `POST /v2/admin/risk/restrictions`
- `POST /v2/admin/risk/restrictions/{restrictionId}/override`
- `POST /v2/admin/risk/appeals`
- `POST /v2/admin/risk/appeals/{appealId}/decision`

High-Gas evidence above the published Gas threshold restricts new quotes for
exactly 24 hours. The sixth distinct wallet observed on one IP or device inside
one minute creates a subject blacklist and wallet restrictions. A third
cancellation inside five minutes restricts new quotes for two hours. Duplicate
observation IDs are idempotent. Admin may create or override restrictions and
decide appeals; Operator may submit appeals; Auditor is read-only. These limits
apply to ordinary and seckill quote creation only and never block fulfillment,
takeover, arbitration, reconciliation, finality synchronization or audit reads.

Catalog management:

- `GET|PUT /v2/merchant/stores/{storeId}/product-slot`
- `POST /v2/merchant/products/{productId}/concession-previews`
- `POST /v2/merchant/products/{productId}/review-submissions`
- `POST /v2/merchant/products/{productId}/delist`
- `GET|POST /v2/admin/catalog/categories`
- `PUT /v2/admin/catalog/categories/{categoryId}`
- `GET|POST /v2/admin/catalog/tags`
- `PUT /v2/admin/catalog/tags/{tagId}`
- `GET /v2/admin/catalog/products`
- `GET|PUT /v2/admin/catalog/stores/{storeId}/product-slot`
- `POST /v2/admin/catalog/products/{productId}/concession-previews`
- `POST /v2/admin/catalog/products/{productId}/review-decisions`
- `POST /v2/admin/catalog/products/{productId}/review-submissions`
- `POST /v2/admin/catalog/products/{productId}/delist`
- `POST /v2/admin/catalog/skus/{skuId}/inventory-adjustments`
- `GET /v2/admin/orders`
- `POST /v2/admin/orders/batch-actions/preview`

Merchant routes always execute with a merchant-only actor even when the JWT also
contains a platform role. Admin routes likewise use one platform role and never
splice merchant ownership into platform authority. A store has at most one
non-delisted product slot. Review, scheduled, live-session, active-reservation
and positive Locked/Disputed-liability blockers return `ProductWriteLocked`
with the exact blocking resource. Historical products are logically delisted
and replaced rather than physically deleted or financially rewritten.

Product review requires 1-5 verified write-once main images and a non-expired
Core-signed concession preview bound to the latest canonical policy and exact
product/SKU fingerprint. The preview returns each SKU's integer base,
concession, net receivable and the frozen Custody-backed destinations: platform
0%, seckill prize 45%, node rewards 45% and Locked reward reserve 10%. No UI
supplies or changes those weights.

Provider callbacks:

- `POST /v2/providers/kuaidi100/webhooks/logistics`
- `POST /v2/providers/cainiao/webhooks/logistics`

`POST /v2/payments/submissions` binds the order and transaction hash. A
replacement must bind the previously submitted hash. `GET
/v2/payments/{orderId}` is buyer-owned and returns the ordinary or seckill quote
plus indexed classification, block evidence, canonical status, confirmations
and finality when a `PaymentCompleted` event exists. A submitted hash without
that evidence is not payment success.

The two quote endpoints fail closed unless the payment-only `writesEnabled`
readiness gate is true. This gate does not apply to submission tracking or
reads, so an already broadcast transaction can still be indexed and reconciled
while new quoting is paused.
Both quote endpoints also require the authenticated wallet to be registered in
the existing BNM system. An unregistered wallet receives `Forbidden` before
inventory reservation or quote signing; Core never creates a BNM account.

Delivery targets require AMap reverse geocoding and encrypted PII storage.
Pickup targets bind an active store snapshot and immutable six-digit region.
Quotes accept only an unexpired target belonging to the authenticated buyer.
Order reads are wallet/role scoped; decrypted target payloads are returned only
to the buyer, bound merchant or authorized platform role.

`GET /v2/orders` is a stable `(createdAt, orderId)` cursor page. Merchant
filters cover date range, SKU, order state, fulfillment mode and authoritative
ordinary/seckill/fallback order kind. Every row includes Core-computed
`allowedActions`; clients do not infer actions from state or local time.
Admin order search adds exact order ID, product ID, transaction hash and wallet
filters, plus explicit product-review and breaker projections. The batch-action
endpoint is read-only and returns each row's actions and their enabled
intersection; it never performs a cross-resource mutation.

Every fulfillment write requires an idempotency key and evidence hash. The
server owns roles, state transitions and `allowedActions`. Shipment, delivery,
pickup, exchange/delay, arbitration, forced-receipt review and takeover remain
available while payment or settlement breakers are active. A payment must first
reach 15-confirmation finality. Seven-day delivery takeover starts from that
finality timestamp, not the payment block timestamp. Pickup-timeout takeover is
still `DecisionBlocked`.

Manual shipment batches contain 1-100 unique orders. Core sorts and locks the
orders, revalidates each canonical tracking-evidence envelope, authorizes every
row and writes every shipment in one database transaction. One invalid item
rolls back the whole batch. The actor wallet and batch idempotency key acquire a
transaction advisory lock before replay lookup, so concurrent identical
requests return the same immutable result. New batches also lock every sorted
actor/item-idempotency identity before command lookup, so different batch keys
cannot duplicate or ambiguously conflict on one shipment command.
Electronic-waybill creation, label printing and raw tracking-number export are
not part of this endpoint.

`GET /v2/merchant/dashboard` and `GET /v2/admin/dashboard` publish an
`Asia/Shanghai` `[start,end)` natural-day window. Today payment counts and
amounts include an order only when its canonical payment reaches 15-confirmation
finality inside that window. Amounts come from immutable `exactAmounts`; current
order queues remain separate from the finality-window cohort. Shipment rates
return numerator, denominator and nullable basis points, so an empty cohort is
not reported as zero percent. The Admin dashboard returns total and today-new
buyer UID counts from immutable buyer-account rows. The low-stock threshold is
fixed below 100 and is alert-only. Until Core publishes the actual count, the
metric returns `ExternalBlocked` rather than a synthetic zero. Risk
observations, blacklist blocks, active restrictions and
pending appeals are derived from append-only risk records and are not inferred
from operations monitoring alerts.
Funding-wallet coverage is included only when the latest snapshot has a fresh canonical
observation; missing, stale or reorged evidence is an explicit
`WALLET_COVERAGE / ExternalBlocked` metric and never reuses an older covered row.
Settlement transaction failures count status-0 `SETTLEMENT_BATCH` finality rows
whose failure evidence was recorded inside the same business-day window; a
quarantined batch is not automatically labeled as a chain failure.

Pickup verification includes the order snapshot's exact `storeId`. Core stores
only salted code hashes, persists each idempotent failed attempt and invalidates
the active credential after five failures. A different store cannot release the
order even when it belongs to the same merchant.

## Publication Boundary

The settlement/admin checkpoint includes catalog/media management and all payment and fulfillment
capabilities plus signed settlement intents and requests, merchant finance and
guarantee deposits, takeover funding, per-payable EOA transfer execution and finality,
policy governance, CMS, notifications, versioned system configuration,
append-only audit queries and operations monitoring. The coordinated OpenAPI
publishes 182 HTTP operations and the generated types, state/error enums,
Schema and ABI share the same artifact version.

Seckill session reads, numeric-cursor HTTP replay and `/v2/ws` publish only
15-confirmation Router relay events. Consumers bind the artifact version,
deduplicate by event ID and resume from the last accepted cursor. A disabled
control, empty endpoint or fixture does not count as implementation. V2 exposes
no business-refund or on-chain Claim API, and BNM is never a token payout.
