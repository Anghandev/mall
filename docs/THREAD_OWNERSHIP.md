# V2 Thread And Path Ownership

The current main conversation owns the single V2 Goal, Core and integration.
Product agents are controlled writers under that Goal.

## Core Main Workspace

Core is the only writer for:

- `docs/**` and root workspace/tooling/release gates;
- `platform-v2/contracts/**`, `platform-v2/server/**`,
  `platform-v2/scripts/**` and `platform-v2/test/**`;
- Schema, migrations, OpenAPI, ABI, manifests and generated types;
- indexer, signer, executor, adapters and cross-product E2E.

Funds, shared interfaces and database state can be changed only by Core.

## Product Worktrees

| Branch | Sole writable path | Forbidden responsibility |
|---|---|---|
| `codex/v2-mall-rewrite` | `mall-v2/**` | Shared API/ABI/Schema, funds or other products |
| `codex/v2-merchant-rewrite` | `merchant-v2/**` | Shared API/ABI/Schema, funds or other products |
| `codex/v2-platform-admin-rewrite` | `platform-v2/admin/**` | Contracts, server, shared API/Schema or other products |

Each worktree has at most one writer. A product reports a missing Core
capability and implements the documented fail-closed behavior; it does not add
the shared capability locally.

## Legacy And Secrets

`legacy/v1-npl-only/**` is read-only. No V2 runtime imports it. Deletion is a
separate cutover task after historical-order and audit-evidence proof.

No writer commits or prints `.env`, private keys, seed phrases, provider
tokens, databases, PEM files, keystores or device secrets.

## Integration Authority

Only Core publishes shared checkpoints, synchronizes product branches,
integrates product commits and updates release gates. Product branches do not
push, deploy, send mainnet transactions, rebase shared history or cherry-pick
shared commits.
