# V2 Clean Workspace Baseline

Date: 2026-07-14

This checkpoint is the only parent permitted for the three product worktrees.
It follows Phase 1 commit `03fb9fb` and excludes the archived contract WIP at
`64ebfdb`.

## Workspace Packages

| Path | Package | Owner |
|---|---|---|
| `platform-v2/` | `@abu24k/core` | Core main workspace |
| `mall-v2/` | `@abu24k/mall` | Mall worktree after this checkpoint |
| `merchant-v2/` | `@abu24k/merchant` | Merchant worktree after this checkpoint |
| `platform-v2/admin/` | `@abu24k/platform-admin` | Admin worktree after this checkpoint |
| `packages/core-artifacts/` | `@abu24k/core-artifacts` | Core only; unpublished and export-free |

`legacy/v1-npl-only/` is intentionally absent from `pnpm-workspace.yaml` and
remains read-only.

## Frozen Toolchain

- Locally audited runtime: Node `24.14.0` through `scripts/node`.
- Package manager: pnpm `10.30.2`.
- TypeScript `6.0.3`.
- React/ReactDOM `19.2.7`, Vite `8.1.4`, Vitest `4.1.10` and Playwright
  `1.61.1` are pinned exactly in the root lockfile.
- Foundry uses Solidity `0.8.26`; real contracts and tests are intentionally
  absent from this baseline.

## Removed Pre-Freeze Runtime

The previous active contracts/interfaces, nested `platform-v2/pnpm-lock.yaml`
and stale generated outputs were removed. Their Git history and the isolated
WIP branch remain available as evidence but are not implementation inputs.

Product packages contain only typed unpublished-artifact bootstrap constants.
They have no fixture data, guessed endpoints, copied ABI or business UI.

## Baseline Gate

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm baseline:check
pnpm requirements:check
pnpm typecheck
```

The named contract, database, API, consumer and E2E gates deliberately fail
closed until their real implementation replaces `scripts/pending-gate.mjs`.
An empty test suite is not completion evidence.

The root ignored `.env` is mode `600`. Provider keys and private keys are not
tracked or printed. No deployment or transaction is authorized by this
checkpoint.
