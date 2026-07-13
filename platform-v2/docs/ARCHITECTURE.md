# Abu 24K Platform V2 Architecture

## Runtime Boundary

V2 Core is the shared authority for contracts, funds, data, API, indexer,
signer, executor and external adapters. Mall, merchant and platform-admin
applications consume only its coordinated versioned artifacts. V2 has no
runtime dependency on `legacy/v1-npl-only/`.

## Funds Boundary

- Product prices and merchant settlement costs are denominated in USDT.
- Buyer payment uses exact versioned USDT and NPL legs.
- Merchant proceeds are USDT-only and pull-based after fulfillment finality.
- Payment-final NPL follows the frozen 20% Burn and 80% Locked routing policy.
- BNM is order-linked, Locked at payment and Available after fulfillment
  finality; Claim mints it.
- V2 has no business-refund workflow. Merchant default enters platform takeover
  fulfillment under `docs/V2_SYSTEM_CONTRACT.md`.

## Security Boundary

- SIWE and scoped wallet-role bindings protect product sessions.
- High-risk writes require RBAC, a secondary wallet signature and Safe
  multisig approval.
- Business and append-only audit stores are separate; audit records are hash
  chained and cannot be deleted.
- Independent Circuit Breakers leave fulfillment, takeover, emergency
  recovery, reconciliation, audit reads and finality synchronization active.
- An idempotent outbox feeds an external executor. The API never stores an
  owner/deployer private key and authorization never uses `tx.origin`.

## Legacy Boundary

V1 contracts and historical chain events remain readable. V2 never mutates a
V1 database or rewrites finalized V1 history.
