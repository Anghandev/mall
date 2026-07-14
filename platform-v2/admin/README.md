# Abu 24K Platform Admin V2

React + TypeScript operations UI. It owns only `platform-v2/admin/**` and never
implements shared funds, contracts, API, Schema or signer behavior.

## Current Product Boundary

- Routes cover Dashboard, merchants, catalog, policy governance, seckill,
  risk, logistics, takeover fulfillment, CMS, notifications, system config,
  append-only audit, clearing evidence, operations monitoring and Core status.
- Production boots from `src/bootstrap.ts` with the coordinated
  `@abu24k/core-artifacts@2.0.0-fulfillment.1` package.
- `GET /v2/bootstrap` drives payment readiness and exact blocked reasons.
  `GET /v2/catalog/products` drives the active product/SKU/price/stock table.
  SIWE/JWT and `GET /v2/payments/{orderId}` drive the wallet-bound submission,
  reservation, Router-call and finality trace.
- `GET /v2/orders` drives the ADMIN/OPERATOR fulfillment-order view.
  `POST /v2/actions/order` is the only authority for the current session's
  order actions. Shipment, delivery, exchange/delay decision, arbitration,
  takeover and forced-receipt commands remain disabled unless the current
  role, order state and matching Core action all permit them. Every command
  carries a stable idempotency key and evidence hash. The static executable
  action catalog is capability metadata only.
- The browser uses `VITE_CORE_API_ORIGIN` when set and otherwise calls the Core
  API on the current origin. JWTs stay in memory and are not persisted.
- The payment projection remains buyer-wallet scoped. Fulfillment orders and
  platform fulfillment commands are ADMIN/OPERATOR scoped; arbitration
  decisions additionally require ADMIN. Guarantee funding, merchant debt,
  monitoring, policy publication, Safe settlement and other Admin writes remain
  unpublished and fail closed. No amount, allocation, permission, endpoint,
  calldata or finality is inferred.
- Ordinary soft-delete controls are visible only as disabled capabilities
  waiting for Core `allowedActions`. Funds, chain, audit and historical evidence
  surfaces render no delete control.
- Test data, when later required by consumer tests, belongs only under
  `tests/**`; the production bundle scanner rejects known sample-data markers.

## Local Verification

```bash
pnpm --filter @abu24k/platform-admin check
pnpm baseline:check
pnpm requirements:check
pnpm --filter @abu24k/platform-admin dev
```

The development server binds to `http://127.0.0.1:4313`.
