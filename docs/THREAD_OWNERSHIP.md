# V2 Thread Ownership

All threads start from the same `v2/core` checkpoint and run in separate Git
worktrees. A thread may not edit another owner's paths.

## Core And Integration

Owner: the coordinating thread.

Writable paths:

- `docs/`
- `platform-v2/contracts/`
- `platform-v2/server/`
- `platform-v2/scripts/`
- `platform-v2/test/`
- shared OpenAPI, ABI, generated types, integration tests, and root tooling

Responsibilities: contracts, funds, database, API, indexer, signer, external
adapters, deployment, cross-project contract tests, and final launch gates.

## Customer Mall

Owner: Mall thread.

Writable path: `mall-v2/` only.

It consumes versioned API and Web3 artifacts. It must not edit contracts,
server code, legacy code, merchant workbench, platform admin, or root tooling.

## Merchant Workbench

Owner: Merchant Workbench thread.

Writable path: `merchant-v2/` only.

It implements merchant UI, local UI adapters, consumer tests, and its own
assets. It reports missing backend capabilities to the core thread and must not
implement shared funds, database, contracts, or indexer logic.

## Platform Operations Admin

Owner: Platform Operations thread.

Writable path: `platform-v2/admin/` only.

It implements admin UI, local UI adapters, consumer tests, and its own assets.
It reports missing backend capabilities to the core thread and must not edit
`platform-v2/contracts/`, `platform-v2/server/`, or shared integration scripts.

## Legacy

`legacy/v1-npl-only/` is read-only. No V2 runtime may import it. Deletion is a
separate cutover task after all historical orders and audit evidence are safe.

## Handoff Protocol

Each implementation thread reports:

- requirement IDs completed;
- commit hash;
- tests run and their result;
- API or Web3 contract gaps;
- external blockers.

Only the core thread updates shared matrices, changes shared contracts, merges
branches, and runs the combined release gate.
