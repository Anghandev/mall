# Abu 24K V2 Core API Contract

Status: coordinated local artifact `2.0.0-rc.1`. The implemented HTTP surface,
generated types and consumer checks are frozen together. This file does not
authorize deployment or production signing.

## Authority

Core is authoritative for exact amounts, policy/session/order snapshots,
inventory reservations, classification, finality and `allowedActions`.
Products submit user choices and signatures; they never submit a trusted order
state, calculate an allocation, classify a boundary transaction or infer
finality from a transaction hash.
The production confirmation threshold is `DecisionBlocked`; local test values
must never be treated as a deployment default.

Every response carries a correlation ID. Unknown states and missing artifacts,
decisions, credentials, providers, Safe evidence or chain evidence fail closed.

## Authentication And Governance

- SIWE messages bind domain, URI, BSC chain 56, wallet, random nonce, issued
  time and five-minute expiration. PostgreSQL consumes the nonce atomically.
- JWT sessions use a minimum 32-byte secret, 15-minute expiry, issuer/audience,
  wallet subject, server-authoritative roles and a unique session ID.
- Sensitive actions bind action, exact resource, policy version, old/new value
  hashes, Safe, nonce and deadline in EIP-712. A valid secondary signature may
  create a Safe proposal; indexed Safe execution remains separate evidence.
- API processes never load or store an owner/deployer/quote/finality private
  key. Signer and executor workers are separate boundaries.

## Quotes And Reservations

The Core quote builder accepts only bytes32 on-chain identifiers, valid wallet
addresses, future deadlines and a complete frozen policy. All token amounts are
`bigint` internally and decimal strings on the wire.

For each order it proves:

```text
USDT payment = merchant USDT + platform USDT + optional prize USDT + remainder
NPL payment  = exact Burn NPL + Locked route NPL
BNM Locked   = product USDT list price
```

Seckill acknowledgement contains both complete intents and two distinct atomic
reservations. The active session's policy snapshot governs both the seckill and
fallback intent even after a newer policy is published. Chain timestamp alone
selects the final branch.

## Fulfillment And Finality

Delivery takeover becomes eligible only after seven days from payment finality
without shipment evidence. Pickup timeout evidence is not frozen and returns
`PickupTakeoverDecisionBlocked`. Merchant forced receipt is a request after
seven days from delivery and can never finalize directly.

A final transaction must bind chain, contract, expected event, resource, block
hash, status `1`, confirmations and canonical-block evidence. Replacement and
reorg states are explicit; a transaction hash is never success by itself.

## Breakers And Claims

New orders, seckill purchase/settlement and the three Claim scopes are
independent. Shipment, pickup, arbitration, takeover, finality,
reconciliation, audit reads and technical recovery do not consult those
customer-facing breakers. Merchant freeze blocks merchant/reward/BNM Claims,
but not a prize won by the same address as a buyer.

## Initial HTTP Surface

- `GET /v2/bootstrap`: artifact identity and redacted readiness only.
- `POST /v2/auth/nonce`: bounded SIWE challenge.
- `POST /v2/auth/verify`: one-use SIWE verification and scoped session.
- `POST /v2/actions/order`: authenticated order ID; Core loads the projection
  and server clock before returning `allowedActions`.

OpenAPI, generated types, ABI, manifest, WebSocket protocol and the complete
consumer-test surface are published together in the coordinated artifact
checkpoint. Provider calls return `ConfigurationRequired` until their complete
secret reference set and adapter are available.
