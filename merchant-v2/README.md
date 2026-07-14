# Abu 24K Merchant Workbench V2

React + TypeScript merchant workbench. It owns only this directory, consumes
coordinated Core artifacts and fails closed when a required capability is
unpublished.

## Local checks

```sh
pnpm --filter @abu24k/merchant check
```

The app consumes the coordinated `@abu24k/core-artifacts` workspace package at
`2.0.0-settlement-admin.1`. In addition to Bootstrap, merchant SIWE and the
payment/fulfillment surfaces, the workbench consumes merchant finance,
guarantee-deposit evidence, settlement intents, signed settlement requests and
Safe-finality history. The help center reads wallet-targeted published CMS
rules and displays their bound policy version. Settlement typed data is checked against the immutable
Core intent before the connected merchant wallet signs it. Guarantee, debt,
takeover and five-state balances are rendered as exact Core atomic amounts; the
browser does not aggregate or recalculate authoritative funds.

Product writes, merchant dashboard/day aggregates, server-side export/batch
shipping, provider devices, profile migration and merchant audit remain fail
closed until their coordinated capabilities are
published or configured. The browser never calls the buyer-only payment
projection with a merchant session.

Core is expected on the same origin. A separately hosted local Core can be
selected with `VITE_CORE_API_BASE_URL`; production deployment must provide the
corresponding HTTPS/CORS policy rather than a client-side fallback.

For local visual review only, run the dev server and append
`?__merchant_visual_review__=1` to a workspace route such as
`/dashboard?__merchant_visual_review__=1`. Vite
removes this development-only branch from the production bundle, and
`bundle:check` verifies that removal.
