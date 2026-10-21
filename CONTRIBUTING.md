# Contributing

Start with the workspace map in `README.md` and the repository rules in
`AGENTS.md`. Business and financial rules are defined in
`docs/V2_SYSTEM_CONTRACT.md`; consumer interfaces are coordinated through
`packages/core-artifacts/`.

## Local Checks

Use Node.js 24 and pnpm 10.30.2. Install dependencies without lifecycle scripts:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm baseline:check
pnpm requirements:check
pnpm typecheck
pnpm micro:guard:test
```

Run the checks for the packages you change. `pnpm contracts:test` requires
Foundry; PostgreSQL integration and browser tests have their own local service
and browser prerequisites. Do not treat an unavailable dependency as a pass.
The combined verification command is `pnpm verify`. It builds output, starts
local test services and runs browser checks. PostgreSQL integration tests read
`POSTGRES_ADMIN_URL` from the shell or local ignored environment files and
create and drop test databases. Use a dedicated disposable PostgreSQL instance;
never point these checks at production or a shared database administrator.

## Pull Requests

- Explain the problem, affected package and relevant Requirement IDs.
- Keep interface, financial-rule and state-machine changes explicit.
- Include the exact checks run and their results, including skipped checks.
- Preserve unrelated changes and the read-only legacy source archive.
- Keep credentials, databases, customer data, deployment bundles and generated
  runtime evidence out of commits. Use synthetic test data only.
- Do not deploy, broadcast transactions or connect tests to a funded wallet.

Public source availability does not authorize testing a live deployment.
Report security vulnerabilities using `SECURITY.md`, not a public issue.
