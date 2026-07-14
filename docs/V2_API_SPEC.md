# Abu 24K V2 Core API Contract

Status: coordinated local settlement/admin checkpoint `2.0.0-settlement-admin.1`. OpenAPI,
generated types, ABI, manifests, enums, the fail-closed WebSocket protocol and
consumer tests share this version. This checkpoint does not authorize a
deployment, production signing or a transaction.

## Authority

Core is authoritative for catalog price, payment legs, allocations, policy and
beneficiary snapshots, reservations, seckill boundary classification, chain
finality, fulfillment targets, order transitions and ledger release. Products
submit user choices, wallet signatures, transaction hashes and immutable
fulfillment evidence. They do not calculate funds, choose a classification,
infer success from a transaction hash or release balances locally.

Token amounts are unsigned integer decimal strings. IDs used by the Router are
`bytes32`. BSC finality is fixed at 15 canonical confirmations. Missing policy
decisions return `DecisionBlocked`; missing Safe, signer, RPC or provider inputs
return `ExternalBlocked` or `ConfigurationRequired`.

## Authentication

- SIWE binds the configured domain and URI, BSC chain 56, wallet, one-use nonce,
  issue time and five-minute expiry.
- JWT sessions bind the wallet and server-owned roles. Buyer payment endpoints
  require a `BUYER` role.
- Kuaidi100 and Cainiao callbacks use `x-provider-signature`, calculated over
  the exact raw request body with the configured HMAC secret. They do not use a
  product JWT.
- Every response includes `x-correlation-id`. Errors use the generated Core
  error-code catalog and fail closed.

## Payment Contract

For a signed launch quote:

```text
buyer USDT payment = 70% of USDT list price
buyer NPL payment  = 30% of the Oracle-equivalent NPL quote
NPL Burn           = 20% of the same Oracle-equivalent quote
NPL Reward Safe    = 10% of the same Oracle-equivalent quote
BNM Locked         = USDT list price, as backend points only
```

Merchant concession never changes buyer payment. Core returns merchant base
receivable, concession, net receivable and exact versioned allocation entries.
The NPL reward allocation balances exactly to the Reward Safe amount; missing
beneficiaries and rounding remainder use the frozen circulation pool.
For a seckill quote, governed `seckillPrizePoolAccount` and `seckillPrizeBps`
create an exact `SECKILL_PRIZE_LIABILITY` entry. Ordinary and fallback-retail
quotes never create that entry. The prize account is included in the
Safe-published allocation-set hash and is never inferred from array position or
destination weight.

An ordinary quote contains the exact `CanonicalPaymentIntent`, Router address,
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

## HTTP Surface

Public reads:

- `GET /v2/bootstrap`
- `GET /v2/catalog/products`
- `GET /v2/catalog/products/{productId}`
- `GET /v2/stores` with an optional six-digit `regionCode`

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

Delivery targets require AMap reverse geocoding and encrypted PII storage.
Pickup targets bind an active store snapshot and immutable six-digit region.
Quotes accept only an unexpired target belonging to the authenticated buyer.
Order reads are wallet/role scoped; decrypted target payloads are returned only
to the buyer, bound merchant or authorized platform role.

Every fulfillment write requires an idempotency key and evidence hash. The
server owns roles, state transitions and `allowedActions`. Shipment, delivery,
pickup, exchange/delay, arbitration, forced-receipt review and takeover remain
available while payment or settlement breakers are active. A payment must first
reach 15-confirmation finality. Seven-day delivery takeover starts from that
finality timestamp, not the payment block timestamp. Pickup-timeout takeover is
still `DecisionBlocked`.

Pickup verification includes the order snapshot's exact `storeId`. Core stores
only salted code hashes, persists each idempotent failed attempt and invalidates
the active credential after five failures. A different store cannot release the
order even when it belongs to the same merchant.

## Publication Boundary

The settlement/admin checkpoint includes all payment and fulfillment
capabilities plus signed settlement intents and requests, merchant finance and
guarantee deposits, takeover funding, Safe MultiSend batching and finality,
policy governance, CMS, notifications, versioned system configuration,
append-only audit queries and operations monitoring. The coordinated OpenAPI
publishes 63 HTTP operations and the generated types, state/error enums,
Schema and ABI share the same artifact version.

Live WebSocket delivery remains explicitly fail closed; consumers use the
published HTTP projections until a coordinated WebSocket checkpoint exists.
A disabled control, empty endpoint or fixture does not count as implementation.
V2 exposes no business-refund or on-chain Claim API, and BNM is never a token
payout.
