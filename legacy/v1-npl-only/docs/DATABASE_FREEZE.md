# 24K Database Freeze

Status: frozen; API and indexer consumers must use this schema without inventing new states.

## Runtime Databases

- Business data uses `DB_PATH` and audit data uses a different `AUDIT_DB_PATH`.
- Production requires two absolute persistent paths. The server rejects equal paths, symlinks, hard-link/inode aliases, restore locks and unwritable directories.
- Both databases use SQLite WAL, a 5-second busy timeout and a single API/indexer writer process.
- Runtime database files are forced to owner-only mode `0600`.
- NPL/BNM amounts are stored as exact decimal strings. JavaScript floating-point values are not authoritative ledger values.

## Schema Versions

| Database | Migration table | Frozen version | Migrations |
|---|---|---:|---|
| Business | `schema_migrations` | 2 | `1 baseline-business-schema`; `2 chain-event-finality-and-checkpoints` |
| Audit | `audit_schema_migrations` | 1 | `1 independent-append-only-audit` |

Migrations are forward-only and run once inside SQLite savepoints. Applied versions and names must be contiguous and exact. Startup fails on a missing, renamed or future migration, missing finality guard, missing audit table/trigger or audit hash-chain mismatch. A verified backup of both database files is required before a production migration; rollback restores the reviewed pre-migration pair while the API and indexer are stopped.

## Business Invariants

- `orders.order_id` is unique. `(buyer_address,idempotency_key)` is unique when an idempotency key exists.
- `order_items` is unique by `(order_id,line_key)` so the same product may appear with different SKU/fulfillment lines without duplicate stock deductions.
- `settlement_requests.order_id` is unique. Active after-sale cases are unique per order.
- Chain-driven order, reward and Seckill state changes are committed in the same business transaction as their `chain_events` row.
- `chain_events` is append-only, unique by `(chain_id,tx_hash,log_index)` and stores block hash, accepted confirmations, required confirmations, finality status and finalized timestamp. Reorg evidence is appended to `chain_reorg_incidents`; finalized history is never rewritten in place.

## Chain Finality

- Production RPC verification requires `INDEXER_CONFIRMATIONS` confirmations before any chain event changes business state. The frozen default is 15.
- A production row has `finality_status=Finalized`, a 32-byte block hash, `confirmation_count >= required_confirmations` and non-null `finalized_at`.
- `Unverified` rows are permitted only when the development-only `ALLOW_UNVERIFIED_CHAIN_EVENTS=true` path is active. Production configuration rejects that mode.
- Existing pre-freeze rows migrate as `Legacy`; the insert guard does not permit new Legacy rows.
- `chain_sync_checkpoints` freezes the persistent cursor contract for each chain/contract/stream.
- `chain_reorg_incidents` freezes deep-reorg evidence and resolution fields. The indexer stage must compare persisted finalized block hashes, open an incident and halt affected processing instead of silently rewriting finalized business history.

## Audit Integrity

- `audit_logs` and `rpc_audit_logs` are stored only in the independent audit database.
- UPDATE and DELETE triggers make both logs append-only through SQLite.
- Every business audit entry stores SHA-256 payload hash, previous entry hash and entry hash. Startup recomputes the full chain and fails closed on tampering. During runtime, SQLite `data_version` detects commits from another connection and forces a full re-verification before readiness can remain healthy.
- Legacy business-DB audit rows migrate with an atomic audit-row/savepoint marker and the old business table is dropped only after all rows are recorded.
- High-risk admin/merchant writes require a signature hash or transaction hash. Backend-stage route coverage must preserve this invariant.
- SQLite cannot provide crash-atomic commits across two independent WAL files. New-order and chain-event paths write required audit evidence before committing their business transaction; an audit failure rolls back the business transaction, while an audit-only attempted-action record may remain if a later business commit fails. The backend stage must apply the same ordering to every remaining high-risk route.

## Operations Boundary

- `db:backup` and `db:restore` currently validate one 24K business database per invocation. The operations stage must add a reviewed two-file business/audit runbook and rehearse pair restore before production.
- The API and indexer must be stopped for pair restore. WAL/SHM sidecars, active restore locks, overwrite, hard-link aliasing and corrupt backups are hard failures.
- Persistent indexer checkpoint consumption and deep-reorg handling are implemented in the later indexer/operations stage; their tables and states are frozen here.

## Stage Verification

- `database:check`: migration idempotency, schema versions, old unique-index rebuild, finality trigger rejection, append-only chain events, checkpoint/reorg tables, append-only audit triggers, runtime/startup tamper fail-closed, hard-link alias rejection and one-time legacy audit migration pass.
- `server:ops-check`: health/readiness, WAL/busy timeout, backup, restore, rollback copy, sidecar lockout, corrupt backup rejection, permissions and production path validation pass.
- `requirements:check`: 146-row frozen matrix remains structurally valid.
