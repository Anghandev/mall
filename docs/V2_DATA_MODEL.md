# 24K商城 V2 Data Model

Status: current coordinated No-Go repair baseline
`2.0.0-fulfillment-launch.24`. This document describes implemented catalog,
media, payment, fulfillment, settlement and administrative storage and does not
authorize deployment. Historical `2.0.0-settlement-admin.16` artifacts are
lineage evidence only and do not prove the current `.24` release is Go.

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
  USDT list price, Core-derived merchant base receivable, concession rate and
  inventory. Product writes never accept a user-entered merchant base
  receivable; Core derives `floor(list_price_usdt * 7000 / 10000) - floor(list_price_usdt * 100 / 10000)` (nominally 69%).
- New products bind one active `core.merchant_stores` slot. The partial unique
  index permits at most one non-hidden/non-delisted product per store. Product
  states are Draft, Review, Scheduled, Active, SoldOut, Hidden, Delisted and
  Locked; active seckill sessions, reservations and positive Locked/Disputed
  liabilities block merchant writes.
- `core.catalog_categories`/`core.catalog_tags` identify records while their
  version tables are append-only. Product category/tag assignments bind the
  product version. A category or tag containing any seckill product or positive
  Locked/Disputed order liability cannot be disabled or deleted.
- `core.product_review_events`, `core.catalog_inventory_adjustments` and
  `core.catalog_commands` retain every state decision, stock delta and
  idempotency identity. Historical products and SKUs are delisted and linked by
  `supersedes_product_id`; they are never physically deleted.
- `core.merchant_concession_previews` stores an immutable five-minute signed
  preview bound to policy version, product/SKU fingerprint, integer amounts,
  configured destination set, digest and signer. Review submission rejects an
  expired preview or any product/policy drift.
- `core.inventory_reservations` binds buyer, SKU, quantity, policy, hash,
  classification and expiry. PostgreSQL functions reserve, consume, release and
  restore inventory atomically.
- `core.seckill_sessions` owns independent seckill inventory. A dual quote also
  reserves ordinary SKU inventory for fallback. Neither branch borrows the
  other's inventory. Session activation and ordinary quote issuance take the
  same SKU row lock; activation rejects any unexpired submittable ordinary
  quote for that SKU.
- `core.payment_quotes` records one immutable ordinary or seckill quote identity,
  including the order's snapshotted flat `freight_usdt`.
  `core.payment_quote_legs` records the exact ordinary, seckill and fallback
  intent snapshots and distinct reservations.

Quote replay is idempotent only when every bound field matches. A different
request using the same buyer/idempotency key conflicts. Payment consumes one
reservation; the unused dual-quote leg is released only after 15 canonical
confirmations.

## Payment Projection

A canonical `PaymentRouterV2.PaymentCompleted` event creates or restores:

- `core.orders`, including artifact/policy version, buyer, merchant,
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

Business analytics never copy financial facts into a mutable summary table.
Migration `013_business_analytics.sql` adds only query indexes. Merchant and
platform dashboards derive their `Asia/Shanghai` natural-day cohort from the
latest canonical `ORDER_PAYMENT` finality row whose `finalized_at` is inside the
published `[start,end)` window, then sum immutable `orders.exact_amounts`.
Current fulfillment queues are labeled separately from that cohort. This keeps
replacement and reorg evidence from being double-counted and preserves the
distinction between zero and unavailable.
Dashboard coverage resolves the newest snapshot's append-only latest
canonicality observation and applies the same five-minute freshness boundary as
settlement batching. It never falls back to an older canonical snapshot after a
newer observation proves a reorg.

## Double-Entry Ledger

`core.ledger_accounts`, `core.ledger_journals` and `core.ledger_lines` are
append-only. Every journal is idempotent and balanced independently for USDT,
NPL and `BNM_POINTS`.

Funding-asset account IDs include the normalized backing EOA address. Existing
account metadata is verified field by field before posting, so assets cannot be
silently posted into an account bound to another wallet.

The coordinated checkpoints publish these journal events:

- `PAYMENT_LOCKED` records Custody EOA assets, merchant and policy USDT
  liabilities, Reward EOA assets and beneficiary NPL liabilities, Burn, and
  Locked BNM points;
- product net proceeds use `MERCHANT_RECEIVABLE`; delivery freight uses the
  separate `MERCHANT_FREIGHT_RECEIVABLE`. Both are backed by the Custody EOA,
  follow the same order finality and fulfillment states, and are consumed by
  the existing `MERCHANT_USDT` settlement rail without merging their snapshots;
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

BNM is a backend-points liability, not an ERC-20, mint or EOA-transfer asset.
BNM publishes only its `Locked -> Available` fulfillment lifecycle.
`Requested`, `Submitted` and `Settled` are implemented only for transferable
assets and never apply to BNM. `core.orders.bnm_state_version`
is incremented in the same transaction that appends each BNM state command, and
`core.bnm_state_syncs` records the version acknowledged by the backend. Versions
are order-scoped and never reused, so a timed-out lower-version request cannot
overwrite a later reorg `LOCKED` state.

## Fulfillment Storage

- `core.administrative_regions` records frozen six-digit governed, AMap or
  buyer-declared region evidence. Launch buyer addresses may use audited
  `BUYER_DECLARED` province/city/district/code input without coordinates.
- `core.merchant_stores` records versioned pickup stores. Historical order
  snapshots do not change when a store later moves or closes.
- `core.fulfillment_targets` binds buyer, delivery/pickup mode, target and
  region hashes, expiry and AES-256-GCM encrypted payload. Plain delivery PII is
  never stored in a database column.
- `core.fulfillment_commands` makes every actor/idempotency-key command
  replay-safe and rejects changed input.
- `core.fulfillment_shipment_batches` binds the actor, batch idempotency key,
  exact request hash, item count and immutable result. All item orders are
  locked in canonical ID order and commit or roll back together. A transaction
  advisory lock serializes the actor/batch-idempotency identity before replay
  lookup, and sorted actor/item-idempotency locks serialize command reuse across
  different batches and the single-shipment path.
- `core.fulfillment_evidence`, `core.shipments` and `core.logistics_events` are
  immutable. Launch shipment evidence encrypts the normalized tracking number
  and optional note and retains media asset references for arbitration.
  Provider event identity is unique and callback order is preserved for the
  Phase 2 compatibility path.
- `core.media_upload_intents` requires a signed write-once `PUT` and per-wallet
  rolling quota. Only a provider-sealed object version becomes an immutable
  `core.media_assets` row. Product images/video, category icons, store images
  and order evidence have purpose/resource and MIME bindings. Public catalog
  media is readable only while referenced by an active product or enabled
  category; other assets require an authorized short-lived signed GET. Object
  keys are never exposed to product clients. `core.evidence_envelopes`
  binds the exact order action or normalized tracking hash; tracking data is
  never persisted in plaintext.
- `core.pickup_credentials` stores salted hashes, binds the credential to the
  pickup store snapshotted by the order and allows one successful use before
  expiry. `core.pickup_verification_attempts` stores no plaintext code, keeps
  idempotent failure evidence and invalidates the active credential after five
  failed attempts.
- `core.fulfillment_requests` owns exchange, delay, arbitration and forced
  receipt state. Only one open request of each kind exists per order.
- Order cursor indexes bind merchant, buyer and global scopes to the stable
  `(created_at DESC, order_id DESC)` traversal. Exact product and transaction
  indexes support scoped admin lookup without exposing raw tracking or PII.
- `core.takeover_cases` starts seven days after payment finality when delivery
  has no valid shipment evidence. Opening a case freezes the merchant and its
  active/review products while customer funds and rewards remain Locked.
  Replacement funding uses balanced guarantee, frozen-receivable,
  future-proceeds and platform-advance/debt entries. Each governed command and
  resulting debt recovery remains linked to the takeover evidence.

## Account And Tenant Audit Storage

- `core.buyer_accounts` assigns one database-generated numeric UID to the buyer
  wallet on its first successful BUYER SIWE. The wallet, UID and creation time
  are immutable; UID is off-chain display/search identity only.
- `core.buyer_profiles` stores AES-256-GCM encrypted nicknames and optional
  provider-sealed avatar identity.
- `core.buyer_saved_addresses` stores encrypted address payloads, AMap region
  evidence, logical deletion, optimistic versions and one active transactional
  default per wallet. Raw parser text is never stored. A saved row is not a
  fulfillment snapshot: checkout creates a new expiring `fulfillment_target`.
- `core.account_write_commands` keeps profile/address write idempotency without
  storing plaintext PII. Persisted PII binds the encrypted long-term retention
  policy version; it has no automatic day-based masking or deletion schedule.
- `core.buyer_account_locks` serializes account/address writes per buyer wallet,
  including concurrent first-address and default-address selection.
- Settlement intents and requests retain the authoritative merchant scope
  resolved from the settlement wallet or immutable order. Per-payable EOA
  transfer evidence appends separate tenant audit entries and never exposes
  another merchant's order, request or recipient.
- `core.merchants.settlement_wallet` is permanently immutable after approval.
  Review actions contain no wallet-change kind, and the database trigger has no
  Admin, signer or governance-EOA exception. Rejected pre-approval applications may be
  replaced by a new application with the correct address.
- `core.takeover_case_transitions` records future state changes append-only.
  Existing pre-migration cases are labeled partial; buyer projection omits
  guarantee sources, debt, funding-wallet internals and internal evidence hashes.
- `audit.entries.merchant_id` and the matching business outbox field carry an
  explicit tenant scope through delivery. Merchant reads require equality with
  the active merchant binding, hide legacy null-scope rows and expose bounded
  summaries instead of the raw audit payload.

Fulfillment completion stores the method and immutable evidence, closes an
active takeover case, resolves eligible requests and writes BNM availability to
the outbox in the same business transaction. There is no refund table or
payment-reversal fulfillment action.

## Settlement And Administrative Storage

- `core.settlement_intents`, intent items, wallet nonces, requests and request
  items bind the wallet signature, exact asset/amount, available liabilities,
  expiry and idempotency identity.
- Immutable transfer intents, EOA nonce reservations and execution attempts
  bind executor, token, recipient, amount, calldata hash and gas cap. Final
  `Settled` state requires a matching status-1 canonical receipt and 15
  confirmations; replacement and reorg exposure remain append-only evidence.
- Coverage snapshots reconcile verified funding-wallet assets against unsettled
  liabilities per asset. Breaker events and causes preserve independent new
  payment, seckill-purchase and new-settlement-transfer controls.
- Merchant guarantees, immutable deposit submissions, reorg exposures, debts,
  debt recoveries and takeover-funding items preserve the required funding
  order and never rewrite a prior balance.
- Policy drafts and publication transitions bind RBAC, the secondary wallet
  signature, Platform Governance EOA execution and future-only `policyVersion`
  activation.
- CMS versions/publication events, notification endpoints/campaigns/deliveries,
  system-config versions, the audit outbox, monitoring snapshots and alert
  events are versioned or append-only as appropriate.
- `core.risk_observations` stores trusted high-Gas, wallet-context and
  cancellation evidence idempotently. `core.risk_subject_wallets` links only
  hashed IP/device subjects to wallets. `core.risk_restrictions` records
  wallet/IP/device limits, exact start/expiry and override evidence;
  `core.risk_restriction_events` retains created, expired and overridden
  transitions. `core.risk_appeals` retains statement, decision and actor
  evidence. Active wallet restrictions are consulted only by ordinary and
  seckill quote creation.

## Immutability And Recovery

Database triggers reject updates to published policies, quote legs, order
financial snapshots, chain evidence and audit entries. Corrections use new
linked evidence rather than mutation or deletion. Outbox events and durable jobs
use transactions, bounded leases and retry counters.

Production backup uses `pg_dump` custom format and a SHA-256 manifest. Restore
refuses a non-empty target. Local PGlite restore tests are test evidence only,
not a substitute for production PostgreSQL backup and restore evidence.

## Blocked Inputs

Production PostgreSQL, Redis, encrypted backup storage, two distinct BSC RPC
endpoints, signer services and other provider accounts remain launch-time
`ExternalBlocked` or `ConfigurationRequired`. The BNM backend schema, HTTPS
endpoint, ignored credential and monotonic conformance evidence are verified;
production Core still requires secure runtime injection and worker monitoring.
The five EOA roles, commercial allocations and PII retention are frozen and are
not `DecisionBlocked`. There is no fixture-backed success path and no
business-refund or Claim table/API in V2.
