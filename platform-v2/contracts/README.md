# V2 Contracts

The active V2 contracts are a clean implementation of
`../../docs/V2_SYSTEM_CONTRACT.md`. Their frozen responsibilities, funds,
roles, events, deployment order and artifact boundary are documented in
`../../docs/V2_CONTRACT_SPEC.md`.

The Foundry gate contains unit, 256-run fuzz and 256-run stateful invariant
tests. Run it through `pnpm contracts:test`; an ABI is accepted only when the
generated artifact check also matches the current compiled bytecode and ABI.
