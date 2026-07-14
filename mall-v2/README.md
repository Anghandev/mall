# Abu 24K Mall V2

React + TypeScript mobile-size Web DApp. Business work follows the frozen Mall
Requirement Matrix and consumes only coordinated Core artifacts.

## Current Runtime Boundary

- Production consumes coordinated Core artifacts `2.0.0-settlement-admin.1` and derives
  its HTTP paths from the published OpenAPI document.
- The real payment consumer covers SIWE, product/SKU reads, ordinary and dual
  seckill quotes, atomic reservations, approval requirements, ABI-shaped
  `routerCall`, transaction submission and indexed payment projections.
- Prices, payment legs, allocation amounts and finality are rendered exactly
  from Core responses. The Mall does not recalculate them or treat a submitted
  TxHash as final.
- The Mall consumes published stores, browser-location-backed delivery/pickup
  targets, wallet-scoped order/target projections, logistics, balances and
  current-session `allowedActions`. No endpoint, amount or state is duplicated
  locally.
- Transferable balances now render Core-projected Locked, Available, Requested,
  Batched and Settled states. Available NPL reward and USDT prize balances use
  a wallet-bound EIP-712 settlement intent; the Mall never creates settlement
  calldata or pays Safe Gas. Settled requests show the final Safe TxHash.
- Published CMS content, the wallet notification inbox and the IN_APP/CORE
  endpoint are consumed from the same OpenAPI and generated-types checkpoint.
  Reward sub-type attribution remains hidden because Core does not yet project
  genesis/referral/region/operations taxonomy separately.
- Buyer fulfillment commands remain fail closed even when `allowedActions`
  enables them because Core has not published canonical buyer-evidence
  creation/upload semantics for the required `evidenceHash`.
- The coordinated manifest still has `deploymentAuthorized=false` and no
  executable `PAY_ORDER`. Wallet broadcast therefore remains fail closed until
  Core publishes deployment evidence. Native navigation, production-device GPS
  evidence and seckill-session projections also remain externally blocked or
  unpublished rather than using production fixtures.
- The copied brand assets in `public/brand/` have no runtime dependency on the
  read-only legacy tree.

## Routes

- `/seckill`, `/mall`, `/stores`, `/assets`
- `/assets/addresses`, `/assets/orders`, `/assets/activity`, `/assets/rewards`,
  `/assets/notifications`
- `/checkout`, `/checkout/review`

## Local Verification

```bash
pnpm --filter @abu24k/mall check
pnpm --filter @abu24k/mall test:e2e
```

The browser suite starts Vite on `127.0.0.1:4311` and verifies 375, 393 and
430 pixel mobile widths plus a 430 pixel centered frame on desktop.
