# Abu 24K Platform Admin V2

React + TypeScript operations UI. It owns only `platform-v2/admin/**` and never
implements shared funds, contracts, API, Schema or signer behavior.

## Current Product Boundary

- Routes cover Dashboard, merchants, catalog, policy governance, seckill,
  risk, logistics, takeover fulfillment, CMS, notifications, system config,
  append-only audit, clearing evidence, operations monitoring and Core status.
- Production boots from `src/bootstrap.ts` with the coordinated
  `@abu24k/core-artifacts@2.0.0-rc.2` package. The artifact version and public
  role, breaker, policy-state and executable-action catalogs come directly from
  that package.
- Admin projections, monitoring, policy publication and write contracts remain
  unpublished. Reads show unavailable and every write remains disabled because
  the coordinated executable-action catalog is empty; no amount, allocation,
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
