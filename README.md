# 24K商城 V2

This repository is the clean V2 workspace. Financial and state-machine
authority lives in `docs/V2_SYSTEM_CONTRACT.md`; product traceability lives in
the three frozen Requirement Matrices.

## Workspace

- `platform-v2/`: Core contracts, server, data, workers and integration tests.
- `mall-v2/`: customer mobile-size Web DApp.
- `merchant-v2/`: merchant workbench.
- `platform-v2/admin/`: platform operations UI.
- `packages/core-artifacts/`: Core-owned coordinated consumer publication.
- `legacy/v1-npl-only/`: read-only historical archive, never a workspace
  package or V2 runtime dependency.

## Baseline Gates

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm baseline:check
pnpm requirements:check
pnpm typecheck
```

The remaining named gates intentionally stay fail closed until their real
contracts, data, API, products and tests exist. The final gate is `pnpm verify`.

No command in this repository deploys or sends a mainnet transaction without a
separate user-approved bounded plan.
