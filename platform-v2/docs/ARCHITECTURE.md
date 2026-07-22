# 24K商城 V2 Architecture

## Runtime Boundary

V2 Core is the shared authority for contracts, funds, data, API, payment receipt finality,
signer, executor and external adapters. Mall, merchant and platform-admin
applications consume only its coordinated versioned artifacts. V2 has no
runtime dependency on `legacy/v1-npl-only/`.

## Funds Boundary

- Product prices and merchant settlement costs are denominated in USDT.
- Buyer payment is exactly 70% USDT plus 30% Oracle-equivalent NPL.
- The 1%-of-list USDT fee moves to the Service Fee EOA; remaining product USDT
  plus freight moves to the Custody/Settlement EOA. 20%-of-list NPL is burned
  and 10%-of-list NPL moves to the Reward/Distribution EOA. PaymentRouter
  normally retains zero.
- Merchant proceeds are USDT-only and settle from the append-only double-entry
  ledger through one immutable EOA ERC-20 transfer per payable after the
  required business finality.
- BNM is order-linked backend points, Locked at payment and Available after
  fulfillment finality. It is not an ERC-20 or a Claim payout.
- V2 has no business-refund workflow. Merchant default enters platform takeover
  fulfillment under `docs/V2_SYSTEM_CONTRACT.md`.

## Security Boundary

- SIWE and scoped wallet-role bindings protect product sessions.
- High-risk writes require RBAC, an exact secondary wallet signature and direct
  execution by the configured Platform Governance EOA.
- Business and append-only audit stores are separate; audit records are hash
  chained and cannot be deleted.
- Independent Circuit Breakers leave fulfillment, takeover, emergency
  recovery, reconciliation, audit reads and finality synchronization active.
- An idempotent outbox feeds an external executor. The API never stores an
  owner/deployer private key and authorization never uses `tx.origin`.

## Legacy Boundary

V1 contracts and historical chain events remain readable. V2 never mutates a
V1 database or rewrites finalized V1 history.
