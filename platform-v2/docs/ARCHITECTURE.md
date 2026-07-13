# Abu 24K Platform V2 Architecture

## Runtime Boundary

V2 is the shared authority for contracts, funds, data, API, indexer, signer and
external integrations. Customer, merchant and admin applications consume its
versioned interfaces. V2 has no runtime dependency on the isolated V1 tree.

## Funds Boundary

- Product prices and merchant settlement costs are denominated in USDT.
- A versioned policy defines buyer USDT and NPL payment legs whose basis points
  sum to 10,000.
- Merchant proceeds are USDT-only and pull-based after finalized fulfillment.
- NPL payment value follows a versioned Burn and circulation/reward policy and
  is never counted as merchant proceeds.
- BNM is locked by order, released on finalized fulfillment and burned on
  refund.
- The cross-project authority is `docs/V2_SYSTEM_CONTRACT.md`.

## Security Boundary

- Customer, merchant and administrator authentication use SIWE and scoped
  wallet-role bindings.
- High-risk writes require a secondary wallet signature and a multisig approval reference.
- Business and audit data use separate SQLite files. Audit entries are append-only and hash chained.
- Escrow, reward, claim and seckill controls have independent pause scopes. Recovery operations remain available while user-facing writes are paused.
- Settlement broadcasts are produced by an idempotent outbox and an external
  execution service; the API never stores an owner or deployer private key.
- Authorization does not rely on `tx.origin`.

## Legacy Boundary

V1 contracts and historical chain events remain readable. V2 never mutates a
V1 database or rewrites finalized V1 chain history. After cutover, only minimal
V1 ABI, address and migration evidence remains in the active tree.
