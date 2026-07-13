# Abu 24K Merchant Workbench V2

React + TypeScript merchant workbench. It owns only this directory, consumes
coordinated Core artifacts and fails closed when a required capability is
unpublished.

## Local checks

```sh
pnpm --filter @abu24k/merchant check
```

The production app remains at the wallet gateway until Core publishes one
coordinated artifact set. For local visual review only, run the dev server and
append `?__merchant_visual_review__=1` to a workspace route such as
`/dashboard?__merchant_visual_review__=1`. Vite
removes this development-only branch from the production bundle, and
`bundle:check` verifies that removal.
