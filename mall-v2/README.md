# Abu 24K Mall V2

React + TypeScript mobile-size Web DApp. Business work follows the frozen Mall
Requirement Matrix and consumes only coordinated Core artifacts.

## Current Runtime Boundary

- Production consumes coordinated Core artifacts `2.0.0-rc.2`, including its
  version, BSC chain identity and order-action catalogs.
- `executableOrderActionNames` is empty in this release candidate, so every
  wallet write remains disabled. The application does not infer an action from
  the broader known-action catalog.
- The application does not define endpoints, shared schemas, calldata, prices,
  allocations, eligibility or finality.
- Product, session, store, order and reward values remain unavailable instead
  of using production fixtures.
- The copied brand assets in `public/brand/` have no runtime dependency on the
  read-only legacy tree.

## Routes

- `/seckill`, `/mall`, `/stores`, `/assets`
- `/assets/addresses`, `/assets/orders`, `/assets/activity`, `/assets/rewards`
- `/checkout`, `/checkout/review`

## Local Verification

```bash
pnpm --filter @abu24k/mall check
pnpm --filter @abu24k/mall test:e2e
```

The browser suite starts Vite on `127.0.0.1:4311` and verifies 375, 393 and
430 pixel mobile widths plus a 430 pixel centered frame on desktop.
