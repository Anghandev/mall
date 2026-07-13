# Merchant Workbench V2 Architecture

## Runtime Boundary

V2 is a standalone Node.js, SQLite and Foundry project. The merchant console is served as native ES modules by the API process. It has no runtime dependency on the isolated V1 tree.

## Funds Boundary

- Each order has one immutable USDT payment amount and allocation-policy version.
- `Abu24KPaymentEscrow` is the only active payment contract. It never pulls NPL or BNM from a buyer.
- Merchant USDT proceeds accrue in Escrow after confirmed fulfillment and remain pull-based until the merchant claims them.
- NPL and BNM are reward assets only. `Abu24KRewardLedger` keeps their Locked, Available, Claimed and Burned states separate from merchant proceeds.
- BNM is locked from the signed order authorization, released on completion and burned on refund.

## Security Boundary

- Merchant authentication uses SIWE and wallet-role bindings.
- High-risk writes require a secondary wallet signature and a multisig approval reference.
- Business and audit data use separate SQLite files. Audit entries are append-only and hash chained.
- Escrow, reward, claim and seckill controls have independent pause scopes. Recovery operations remain available while user-facing writes are paused.
- Settlement broadcasts are produced by an idempotent outbox and an external execution service; the API never stores an owner or deployer private key.

## Legacy Boundary

V1 contracts and historical chain events remain readable. V2 never mutates a V1 database or rewrites finalized V1 chain history. After cutover, only minimal V1 ABI, address and migration evidence remains in the active tree.
