# Abu 24K Merchant Workbench V2

React + TypeScript merchant workbench. It owns only this directory, consumes
coordinated Core artifacts and fails closed when a required capability is
unpublished.

## Local checks

```sh
pnpm --filter @abu24k/merchant check
```

The app consumes the coordinated `@abu24k/core-artifacts` workspace package at
`2.0.0-rc.2`.
The production app remains at the wallet gateway while the published SIWE
surface is not connected to this client and executable actions remain
unpublished. For local visual review only, run the dev server and append
`?__merchant_visual_review__=1` to a workspace route such as
`/dashboard?__merchant_visual_review__=1`. Vite
removes this development-only branch from the production bundle, and
`bundle:check` verifies that removal.
