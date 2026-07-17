# Phase 1 Requirement Freeze Checkpoint

Date: 2026-07-14

## Baseline And WIP Isolation

- Core baseline: `v2/core@b7fa4d732433a22fda47243ffa383572fb60024e`.
- Abandoned four-contract WIP is preserved only on local branch
  `codex/archive-v2-contract-wip-20260714` at commit `64ebfdb`.
- No product worktree may be created from that archive commit.
- Product worktrees are created only after this Phase 1 commit and the clean V2
  workspace baseline, from one shared Core checkpoint.

## Canonical PRDs

| Product | Canonical source | SHA-256 |
|---|---|---|
| Mall | `../mall-v2/docs/requirements/PRD-7.5.01.txt` | `d478b2e60f7c917967ea28e3a20000543556fc67f777cad2d2eff17d7cb773ac` |
| Merchant | `../merchant-v2/docs/requirements/PRD-MERCHANT-WORKBENCH.txt` | `98c70cb430a29a1469e2285b73e5a146537b1e83077c5f51d80deac908745cc7` |
| Platform | `../platform-v2/docs/requirements/PLATFORM_ADMIN_SPEC.txt` | `a0144e57ce7d383703602e054e5bc2d454dea837ee19622c6abdd0d776021d63` |

Each neighboring `SOURCE.md` records provenance. Original PRDs remain
unchanged; conflicts are retained as evidence and marked `Overridden` in the
matrices.

## Confirmed Rule Supplement

The following later business authority overrides only the rules it states
explicitly; every other canonical PRD requirement and frozen decision remains
unchanged.

| Effective date | Canonical source | SHA-256 |
|---|---|---|
| 2026-07-17 | `/Users/ronnie/Desktop/24K商城V2已确认规则与待补资料清单.txt` | `049a20a1b2d7d60f12e043527b0204bf1bf1b6e49df6c8a365543090ee8db100` |

Secrets, private keys, Safe addresses, owners and thresholds are intentionally
not copied into repository documentation.

## Frozen Traceability

- Mall matrix: `../mall-v2/docs/requirements/REQUIREMENTS_MATRIX.md`.
- Merchant matrix:
  `../merchant-v2/docs/requirements/REQUIREMENTS_MATRIX.md`.
- Platform matrix:
  `../platform-v2/admin/docs/requirements/REQUIREMENTS_MATRIX.md`.
- Decisions: `V2_DECISIONS.md`.
- System authority: `V2_SYSTEM_CONTRACT.md`.

The reproducible Phase 1 gate is:

```bash
scripts/node scripts/check-requirements.mjs
```

Passing this checkpoint does not authorize contract/backend/product
implementation, remote push, deployment or a mainnet transaction.
