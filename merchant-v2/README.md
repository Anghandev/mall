# Abu 24K Merchant Workbench V2

React + TypeScript merchant workbench. It owns only this directory, consumes
coordinated Core artifacts and fails closed when a required capability is
unpublished.

## Local checks

```sh
pnpm --filter @abu24k/merchant check
```

The app consumes the coordinated `@abu24k/core-artifacts` workspace package at
`2.0.0-fulfillment.1`. It connects the published Bootstrap, merchant SIWE,
catalog/SKU/inventory reads, wallet-scoped orders and targets, session-bound
`allowedActions`, shipment evidence, forced-receipt review requests and pickup
verification. Commands require the selected order, immutable target snapshot,
published action catalog and an enabled server action; missing session,
finality, role or target integrity fails closed. Merchant product writes,
pagination/export/batch operations, provider devices and settlement stay
unavailable until their coordinated capabilities are published or configured.
The browser never calls the buyer-only payment projection with a merchant
session.

Core is expected on the same origin. A separately hosted local Core can be
selected with `VITE_CORE_API_BASE_URL`; production deployment must provide the
corresponding HTTPS/CORS policy rather than a client-side fallback.

For local visual review only, run the dev server and append
`?__merchant_visual_review__=1` to a workspace route such as
`/dashboard?__merchant_visual_review__=1`. Vite
removes this development-only branch from the production bundle, and
`bundle:check` verifies that removal.
