# Abu 24K V2 Core API Contract

Status: coordinated local payment checkpoint `2.0.0-payment.1`. OpenAPI,
generated types, ABI, manifests, enums, the fail-closed WebSocket protocol and
consumer tests share this version. This checkpoint does not authorize a
deployment, production signing or a transaction.

## Authority

Core is authoritative for catalog price, payment legs, allocations, policy and
beneficiary snapshots, reservations, seckill boundary classification and chain
finality. Products submit user choices, wallet signatures and transaction
hashes. They do not calculate funds, choose a classification or infer success
from a transaction hash.

Token amounts are unsigned integer decimal strings. IDs used by the Router are
`bytes32`. BSC finality is fixed at 15 canonical confirmations. Missing policy
decisions return `DecisionBlocked`; missing Safe, signer, RPC or provider inputs
return `ExternalBlocked` or `ConfigurationRequired`.

## Authentication

- SIWE binds the configured domain and URI, BSC chain 56, wallet, one-use nonce,
  issue time and five-minute expiry.
- JWT sessions bind the wallet and server-owned roles. Buyer payment endpoints
  require a `BUYER` role.
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

Authentication:

- `POST /v2/auth/nonce`
- `POST /v2/auth/verify`

Authenticated Core reads and writes:

- `POST /v2/actions/order`
- `POST /v2/payments/quotes`
- `POST /v2/seckill/quotes`
- `POST /v2/payments/submissions`
- `GET /v2/payments/{orderId}`

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

## Publication Boundary

Payment checkpoint capabilities are catalog/SKU reads, ordinary and seckill
quotes, atomic reservations, submission tracking, PaymentRouter ABI, payment
indexing, Locked ledger projection and finality reads.

Fulfillment, takeover, arbitration, settlement requests, Safe MultiSend, CMS,
notifications and live WebSocket channels are not published in this checkpoint.
They remain `NOT_PUBLISHED_FAIL_CLOSED`; a disabled control, empty endpoint or
fixture does not count as implementation. V2 exposes no business-refund or
on-chain Claim API, and BNM is never a token payout.
