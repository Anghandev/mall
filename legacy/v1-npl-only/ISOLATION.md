# V1 NPL-only Isolation Record

This directory is a frozen, runnable copy of the V1 system. It is not a valid source for V2 product behavior.

## Baseline

- Commit: `43ea7c92c1ba3406fb91f998fe3482147cdd681c`
- Annotated tag: `v1-npl-only-final-20260713`
- API port: `8787`
- Payment model: NPL-only

Before isolation, the following checks passed on 2026-07-13:

- `pnpm typecheck`
- `pnpm backend:check`
- `pnpm database:check`
- `pnpm server:ops-check`
- `pnpm contracts:test` with 19 passing tests

Run legacy commands from this directory, or use the root `v1:*` wrappers. Relative paths and environment loading depend on the legacy directory being the current working directory.

Do not add new product behavior here. Only migration-critical fixes for unresolved V1 orders are allowed.
