# Abu 24K V2 Data Model

Status: coordinated local payment checkpoint `2.0.0-payment.1`. This document
describes implemented payment storage only and does not authorize deployment.

## Storage Boundary

The business PostgreSQL database is financial truth. A separate PostgreSQL
audit database stores append-only hash-chained evidence. Redis is limited to
rate limits, locks and transient readiness; it is never inventory, order or
ledger truth.

All token and points amounts use `numeric(78, 0)` and API decimal strings.
Floating-point amounts are forbidden. Immutable quote, policy, allocation and
order snapshots are never recalculated from current configuration.

## Catalog And Reservations

- `core.products` and `core.skus` own the off-chain IDs, immutable chain IDs,
  USDT list price, merchant cost, concession rate and inventory.
- `core.inventory_reservations` binds buyer, SKU, quantity, policy, hash,
  classification and expiry. PostgreSQL functions reserve, consume, release and
  restore inventory atomically.
- `core.seckill_sessions` owns independent seckill inventory. A dual quote also
  reserves ordinary SKU inventory for fallback. Neither branch borrows the
  other's inventory.
- `core.payment_quotes` records one immutable ordinary or seckill quote identity.
  `core.payment_quote_legs` records the exact ordinary, seckill and fallback
  intent snapshots and distinct reservations.

Quote replay is idempotent only when every bound field matches. A different
request using the same buyer/idempotency key conflicts. Payment consumes one
reservation; the unused dual-quote leg is released only after 15 canonical
confirmations.

## Payment Projection

A canonical `PaymentRouterV2.PaymentCompleted` event creates or restores:

- `core.orders`, including artifact/policy/Oracle versions, buyer, merchant,
  product/SKU, fulfillment hashes, nonce, exact quote and allocation snapshots;
- `core.payment_events`, including transaction/log/block identity,
  classification, snapshot hash, confirmations and canonical status;
- `core.transaction_finality`, binding chain 56, Router, event hash, transaction,
  replacement, block, status-1 receipt and the fixed 15 confirmations;
- an outbox event in the same database transaction.

`core.chain_blocks`, `core.chain_events` and `core.chain_reorg_evidence` preserve
canonical history and replacement evidence. The same transaction may be
re-included in a new canonical block. A reorg never deletes evidence: it marks
the old event non-canonical, posts a linked ledger reversal and moves the order
to `REORG_PENDING` until a valid replacement is indexed. A pre-finality reorg
restores the reservation. A post-finality reorg keeps selected inventory
consumed, creates a reconciliation job and quarantines a replacement using a
different signed seckill/fallback leg.

## Double-Entry Ledger

`core.ledger_accounts`, `core.ledger_journals` and `core.ledger_lines` are
append-only. Every journal is idempotent and balanced independently for USDT,
NPL and `BNM_POINTS`.

Safe asset account IDs include the normalized Safe address. Existing account
metadata is verified field by field before posting, so a governed Safe rotation
cannot silently post new assets into an account bound to an old Safe.

The payment checkpoint publishes two journal events:

- `PAYMENT_LOCKED` records Custody Safe assets, merchant and policy USDT
  liabilities, Reward Safe assets and beneficiary NPL liabilities, Burn, and
  Locked BNM points;
- `PAYMENT_REORG_REVERSAL` reverses the exact original lines and links the
  original journal.

BNM is a backend-points liability, not an ERC-20, mint or Safe-transfer asset.
The later lifecycle states `Available`, `Requested`, `Batched` and `Settled`
remain reserved for the fulfillment and settlement checkpoints and are not
published here as executable flows.

## Immutability And Recovery

Database triggers reject updates to published policies, quote legs, order
financial snapshots, chain evidence and audit entries. Corrections use new
linked evidence rather than mutation or deletion. Outbox events and durable jobs
use transactions, bounded leases and retry counters.

Production backup uses `pg_dump` custom format and a SHA-256 manifest. Restore
refuses a non-empty target. Local PGlite restore tests are test evidence only,
not a substitute for production PostgreSQL backup and restore evidence.

## Blocked Inputs

Production PostgreSQL, Redis, encrypted backup storage, Safe addresses, RPCs,
signer services and providers remain `ExternalBlocked`. Missing commercial
allocation inputs remain `DecisionBlocked`. There is no fixture-backed success
path and no business-refund or Claim table/API in V2.
