# Abu 24K V2 Transition Repository

The repository is split into one shared core and three product surfaces:

- `platform-v2/`: shared contracts/API core plus the platform operations UI.
- `mall-v2/`: customer mall application.
- `merchant-v2/`: merchant workbench application.
- `legacy/v1-npl-only/`: frozen V1 implementation for history and recovery.

V2 must not import code from the legacy directory. Cross-project financial and
ownership rules are defined in `docs/V2_SYSTEM_CONTRACT.md` and
`docs/THREAD_OWNERSHIP.md`.

## Commands

```bash
pnpm v1:typecheck
pnpm v1:contracts:test
pnpm v2:verify
pnpm v2:server
```

The V1 baseline is preserved by the annotated Git tag `v1-npl-only-final-20260713`.
