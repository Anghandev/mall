# Abu 24K Platform Admin V2

React + TypeScript operations UI. It owns only `platform-v2/admin/**` and never
implements shared funds, contracts, API, Schema or signer behavior.

## Current Product Boundary

- Routes cover Dashboard, merchants, catalog, policy governance, seckill,
  risk, logistics, takeover fulfillment, CMS, notifications, system config,
  append-only audit, clearing evidence, operations monitoring and Core status.
- Production boots from `src/bootstrap.ts` with Core artifacts `unpublished`.
  Reads show unavailable, every write is disabled and no amount, allocation,
  permission, endpoint, calldata or finality is inferred.
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
