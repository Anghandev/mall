# 24K商城 V2

An integrated commerce workspace with a customer DApp, merchant workbench,
platform administration, payment contracts and an append-only settlement
ledger. Financial and state-machine authority lives in
`docs/V2_SYSTEM_CONTRACT.md`; product traceability lives in the three frozen
Requirement Matrices.

This source repository is not a turnkey production deployment. Live service
credentials, signing keys, databases and operational configuration are not
included. Local tests are not proof of current production or mainnet safety.

## Workspace

- `platform-v2/`: Core contracts, server, data, workers and integration tests.
- `mall-v2/`: customer mobile-size Web DApp.
- `merchant-v2/`: merchant workbench.
- `platform-v2/admin/`: platform operations UI.
- `packages/core-artifacts/`: Core-owned coordinated consumer publication.
- `legacy/v1-npl-only/`: read-only historical archive, never a workspace
  package or V2 runtime dependency.

## Local Development

Use Node.js 24 (`>=24.14.0 <25`) and pnpm 10.30.2:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm baseline:check
pnpm baseline:test
pnpm requirements:check
pnpm typecheck
pnpm micro:guard:test
```

See each package's scripts for its development server and focused tests.
Foundry is required for contract checks; PostgreSQL and browser integration
checks require their documented local prerequisites. The combined gate is
`pnpm verify`. Missing configuration must fail closed, not simulate success.

Deployment, signing and broadcast scripts are operational tools, not local
smoke tests. Do not run them without a separate user-approved bounded plan.
Never use production credentials or a production database for local checks.

## Repository Hygiene

The published source history excludes private environment files, database
snapshots, deployment archives, dependency directories and generated runtime
evidence. Install dependencies and regenerate build output locally. The
read-only V1 source archive is retained; private runtime data is not.

Do not merge an old backup clone into this repository after a history rewrite.
Removed credentials must not be reused. GitHub-side removal of old sensitive
objects and cached views is a separate publication prerequisite; cleaning the
current branch alone does not satisfy it.

## Contributing And License

See `CONTRIBUTING.md` for checks and contribution scope, and `SECURITY.md` for
private security reporting. Original project code is licensed under MIT;
third-party notices and trademark rights remain separate. See `LICENSE` and
`THIRD_PARTY_NOTICES.md`.
