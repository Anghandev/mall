# Abu 24K V2 Data Model

Status: coordinated local settlement/admin checkpoint
`2.0.0-settlement-admin.1`. This document describes implemented payment,
fulfillment, settlement and administrative storage and does not authorize
deployment.

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

The coordinated checkpoints publish these journal events:

- `PAYMENT_LOCKED` records Custody Safe assets, merchant and policy USDT
  liabilities, Reward Safe assets and beneficiary NPL liabilities, Burn, and
  Locked BNM points;
- `PAYMENT_REORG_REVERSAL` reverses the exact original lines and links the
  original journal.
- fulfillment completion moves eligible order liabilities from `Locked` to
  `Available` with an append-only balanced journal. A
  `SECKILL_PRIZE_LIABILITY` remains `Locked` until session settlement;
- arbitration moves all order liabilities `Locked -> Disputed`. A resume moves
  them back to `Locked`; reviewed fulfillment moves eligible liabilities to
  `Available` but returns the seckill prize liability to `Locked`;
- a deep payment reorg posts linked reversals for every current order balance
  state, including balances already moved by fulfillment.

BNM is a backend-points liability, not an ERC-20, mint or Safe-transfer asset.
BNM publishes only its `Locked -> Available` fulfillment lifecycle.
`Requested`, `Batched` and `Settled` are implemented only for transferable
assets and never apply to BNM. `core.orders.bnm_state_version`
is incremented in the same transaction that appends each BNM state command, and
`core.bnm_state_syncs` records the version acknowledged by the backend. Versions
are order-scoped and never reused, so a timed-out lower-version request cannot
overwrite a later reorg `LOCKED` state.

## Fulfillment Storage

- `core.administrative_regions` records frozen six-digit AMap region evidence.
- `core.merchant_stores` records versioned pickup stores. Historical order
  snapshots do not change when a store later moves or closes.
- `core.fulfillment_targets` binds buyer, delivery/pickup mode, target and
  region hashes, expiry and AES-256-GCM encrypted payload. Plain delivery PII is
  never stored in a database column.
- `core.fulfillment_commands` makes every actor/idempotency-key command
  replay-safe and rejects changed input.
- `core.fulfillment_evidence`, `core.shipments` and `core.logistics_events` are
  immutable. Provider event identity is unique and callback order is preserved.
- `core.pickup_credentials` stores salted hashes, binds the credential to the
  pickup store snapshotted by the order and allows one successful use before
  expiry. `core.pickup_verification_attempts` stores no plaintext code, keeps
  idempotent failure evidence and invalidates the active credential after five
  failed attempts.
- `core.fulfillment_requests` owns exchange, delay, arbitration and forced
  receipt state. Only one open request of each kind exists per order.
- `core.takeover_cases` starts seven days after payment finality when delivery
  has no valid shipment evidence. Opening a case freezes the merchant and its
  active/review products while customer funds and rewards remain Locked.
  Replacement funding uses balanced guarantee, frozen-receivable,
  future-proceeds and platform-advance/debt entries. Each governed command and
  resulting debt recovery remains linked to the takeover evidence.

Fulfillment completion stores the method and immutable evidence, closes an
active takeover case, resolves eligible requests and writes BNM availability to
the outbox in the same business transaction. There is no refund table or
payment-reversal fulfillment action.

## Settlement And Administrative Storage

- `core.settlement_intents`, intent items, wallet nonces, requests and request
  items bind the wallet signature, exact asset/amount, available liabilities,
  expiry and idempotency identity.
- Safe nonce reservations, immutable batches, batch items, approvals and
  execution attempts bind the complete MultiSend content hash. Final
  `Settled` state requires a status-1 canonical receipt and 15 confirmations;
  replacement and reorg exposure remain append-only evidence.
- Coverage snapshots reconcile verified Safe assets against unsettled
  liabilities per asset. Breaker events and causes preserve independent new
  payment, seckill-purchase and new-settlement-batch controls.
- Merchant guarantees, immutable deposit submissions, reorg exposures, debts,
  debt recoveries and takeover-funding items preserve the required funding
  order and never rewrite a prior balance.
- Policy drafts and publication transitions bind RBAC, the secondary wallet
  signature, Safe proposal and future-only `policyVersion` activation.
- CMS versions/publication events, notification endpoints/campaigns/deliveries,
  system-config versions, the audit outbox, monitoring snapshots and alert
  events are versioned or append-only as appropriate.

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
