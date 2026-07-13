# Abu 24K V2 System Contract

Status: cross-project authority for V2 implementation.

This document overrides thread-local plans when they conflict. The source PRDs
remain product requirements, but unresolved contradictions must stay explicit
instead of being silently implemented by one product surface.

## Locked Financial Model

- Product list price and merchant settlement cost are denominated in USDT.
- A versioned product policy defines the buyer payment legs. USDT and NPL basis
  points must sum to 10,000. A zero leg requires no approval or transfer.
- The merchant proceeds ledger is USDT-only and pull-based after fulfillment.
  NPL paid by the buyer is never counted as merchant sales proceeds.
- The NPL leg is routed by a versioned policy. Burn and circulation/reward
  weights must sum to 10,000.
- BNM is a reward credential. It is locked against an order, released only by
  finalized fulfillment, and burned when the associated order is refunded.
- The seckill prize pool and prize claims are denominated in USDT unless a later
  signed product decision explicitly versions a different asset.
- All amounts are integer token units plus canonical decimal strings. Frontends
  never calculate payment splits, allocations, refunds, or reward eligibility.

## Locked Transaction Boundary

- The platform signs an immutable quote, inventory reservation, order digest,
  policy version, payment legs, region binding, and expiration.
- The customer executes only ordered transaction intents returned by the API.
- Merchant fulfillment creates an idempotent settlement outbox item. A separate
  owner or multisig executor broadcasts the settlement transaction.
- Receipt status, expected event identity, resource identity, block hash, and
  required confirmations are all required before a domain state is finalized.
- Authorization must not rely on `tx.origin`. EOA restrictions, when required,
  are an explicit product policy separate from authorization and must document
  smart-account compatibility.

## Circuit Breakers

- New orders, seckill purchases, merchant proceeds claims, and reward claims
  have independent pause scopes.
- Refund, emergency recovery, reconciliation, and read-only audit paths remain
  available while user-facing writes are paused.
- Pause and resume actions require explicit authority and emit indexed events.

## Unresolved P0 Product Decisions

No contract or backend may hard-code these until they are resolved in this file:

1. Whether a merchant-default refund returns the NPL payment leg in full, and
   how an already-funded seckill prize contribution affects that refund.
2. The exact unlock timing for referral, regional, genesis-node, operations,
   and other beneficiary rewards when the PRDs disagree with the global
   fulfillment lock.
3. The complete beneficiary role set and per-role asset for every allocation.
4. The source and cap of a merchant penalty when pending proceeds are
   insufficient.

Until resolved, APIs return signed `refundPreview`, `allocationSnapshot`, and
`allowedActions`; all three user interfaces fail closed and display the reason.

## Versioned Shared Contracts

The core project owns and publishes these artifacts:

- OpenAPI document and generated shared types.
- Web3 ABI bundle and deployment manifest.
- State and error enums.
- Payment, inventory-reservation, settlement, refund, claim, and finality
  consumer-contract tests.

Breaking changes require a new version and coordinated consumer test update.
