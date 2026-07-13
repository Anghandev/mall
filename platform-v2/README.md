# Abu 24K Merchant Workbench V2

This is the independent V2 replacement for the isolated NPL-only merchant system. The active delivery slice is the merchant workbench and its required shared settlement services.

## Boundaries

- No runtime import may reference `../legacy`.
- V2 uses its own environment files, business database, audit database and deployment manifests.
- V1 data migration opens the source database read-only and writes only to a new V2 database.
- Production writes fail closed when RPC, Oracle, multisig or provider configuration is missing.
- Every contract has a documented, narrowly scoped Circuit Breaker and recovery path.
- Product payment and merchant proceeds use USDT only. NPL and BNM exist only in the reward ledger.
- The canonical commerce contracts are `Abu24KPaymentEscrow`, `Abu24KRewardLedger` and `BNMToken`.

## Local Commands

```bash
pnpm install --ignore-scripts
pnpm contracts:test
pnpm verify
pnpm server:dev
```

The local API and admin console use `http://localhost:8788` by default.
