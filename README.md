# Abu 24K V2 Transition Repository

The repository is temporarily split into two independent projects:

- `legacy/v1-npl-only/`: frozen V1 implementation. It remains runnable for historical orders and migration verification only.
- `platform-v2/`: the active Abu 24K platform operations V2 implementation.

V2 must not import code from the legacy directory. Both projects use separate dependencies, environment files, databases, audit databases and deployment manifests.

## Commands

```bash
pnpm v1:typecheck
pnpm v1:contracts:test
pnpm v2:verify
pnpm v2:server
```

The V1 baseline is preserved by the annotated Git tag `v1-npl-only-final-20260713`.
