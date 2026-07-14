# Abu 24K V2 Data Model

Status: Core database checkpoint included in coordinated local artifact
`2.0.0-rc.2`. This document does not authorize a deployment.

## Storage Boundary

V2 uses two PostgreSQL databases:

- the business database holds auth bindings, immutable policy/order snapshots,
  catalog, inventory reservations, seckill, fulfillment, takeover, finality,
  Claims, breakers, outbox, persistent jobs and provider readiness;
- the audit database holds append-only, reverse-time-queryable, hash-chained
  evidence. It has no update or delete path for entries.

Redis is never financial truth. It is limited to bounded locks and transient
cache/readiness data. PostgreSQL inventory functions, the transactional outbox
and durable jobs remain authoritative after Redis loss.

## Snapshot And Conservation Rules

`core.orders` stores artifact, policy and Oracle versions, exact signed amounts,
buyer/merchant/product/SKU/quantity, fulfillment target hash, encrypted target,
immutable region, reservation, quote, allocation, seckill data, nonce and
deadline. A database trigger rejects changes to any snapshot field while still
allowing state/finality projections to advance.

Token amounts use `numeric(78, 0)` and are serialized as decimal strings. No
floating-point amount enters a quote, order, takeover, Claim or finality row.
The API and products never recompute financial allocation from current config.
Each transaction-finality row snapshots the configured required confirmation
count; receipt and replacement processing cannot lower it per call.

## Concurrency And Recovery

`core.reserve_inventory` performs the stock decrement and reservation insert in
one PostgreSQL transaction. Replaying the same exact reservation is idempotent;
changing any bound field conflicts; competing reservations cannot oversell.

Outbox events and durable jobs are retained rather than deleted. Workers lease
rows with `FOR UPDATE SKIP LOCKED`, bounded leases and attempt counters. A
worker crash returns work to retry without inventing success.

Production backup uses `pg_dump` custom format plus a SHA-256 manifest.
`database-restore.mjs` verifies the checksum and refuses a non-empty target.
The local gate also restores same-version PGlite physical backups for both
databases. PGlite archives are test evidence only and are not production
PostgreSQL backups.

## Audit Chain

Every audit entry binds stream and sequence, actor role/wallet, resource,
correlation and request hashes, redacted payload, signature/transaction
evidence, previous hash and entry hash. Appends lock the stream head inside one
database transaction. Verification recomputes the full chain; database triggers
reject entry updates and deletes.

Secrets, authorization headers, cookies, private material, legal identity and
phone fields are redacted before hashing and insertion. Provider tables store
secret references only.

## Blocked Inputs

The database represents missing commercial values as `DecisionBlocked` and
missing credentials/providers as `ConfigurationRequired` or `ExternalBlocked`.
It contains no success fixture path. Pickup timeout/takeover evidence and the
allocation of an injected prize in an empty session remain explicitly blocked.
The production fulfillment-finality confirmation count is also
`DecisionBlocked`; test thresholds are never production defaults.

Production PostgreSQL URLs, Redis, backup storage/retention and restore target
are `ExternalBlocked` until supplied outside the repository. No `.env` value is
part of this checkpoint.
