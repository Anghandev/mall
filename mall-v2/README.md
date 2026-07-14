# Abu 24K Mall V2

React + TypeScript mobile-size Web DApp. Business work follows the frozen Mall
Requirement Matrix and consumes only coordinated Core artifacts.

## Current Runtime Boundary

- Production consumes coordinated Core artifacts `2.0.0-payment.1` and derives
  its HTTP paths from the published OpenAPI document.
- The real payment consumer covers SIWE, product/SKU reads, ordinary and dual
  seckill quotes, atomic reservations, approval requirements, ABI-shaped
  `routerCall`, transaction submission and indexed payment projections.
- Prices, payment legs, allocation amounts and finality are rendered exactly
  from Core responses. The Mall does not recalculate them or treat a submitted
  TxHash as final.
- The coordinated manifest still has `deploymentAuthorized=false` and no
  executable `PAY_ORDER`. Wallet broadcast therefore remains fail closed until
  Core publishes deployment evidence. Address/store targets and seckill-session
  projections also remain unpublished rather than using production fixtures.
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
