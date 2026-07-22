# Abu 24K V2 Mainnet Micro-Test Rules

This repository no longer uses the generic Web3 micro-test template as its
execution gate. Abu 24K V2 uses the project-specific BSC acceptance flow in
`docs/BSC_MICRO_TEST_PLAN.md` and `scripts/microtest/preflight.mjs`.

## Activation

Do not deploy or broadcast any mainnet transaction from this file alone. Enter
execution mode only after the user explicitly approves a bounded Abu V2
transaction plan for the current release artifact, packet hash and buyer set.

## Required Gate

Before any runner is valid, run:

```bash
pnpm micro:preflight
```

The gate must bind all of the following to the same release evidence:

- BSC chain ID `56` and two independent BSC RPC endpoints;
- the current `@abu24k/core-artifacts` version and contract runtime code hashes;
- the current Git commit and a mode-600 private micro-test packet;
- five distinct production role EOAs;
- exactly three buyer EOAs: W5, W1 and W6;
- no buyer collision with merchant, Service Fee, Custody, NPL Reward,
  Governance, Operations/Guarantee or settlement executor roles;
- DB, audit DB, Redis/queue, signer, settlement executor, governance executor
  and BNM availability configuration;
- BNM monotonic conformance evidence;
- micro entitlement evidence and token-value ceiling.

A runner that skips this preflight, uses W3 as a buyer, uses a stale packet,
mismatches artifact/commit/runtime evidence, or exceeds the 3-USDT token-value
ceiling is **No-Go**.

## Wallet And Secret Rules

- W3 is the NPL Reward Wallet and must not be used as a buyer.
- W6 is temporary acceptance infrastructure; keep its private key only in local
  ignored env/secret storage.
- Never ask the user to paste private keys into chat.
- Never print private keys, seed phrases, provider tokens, DB URLs or mode-600
  packet contents.
- It is acceptable to print redacted addresses and SHA-256 hashes.

## Env Initialization

When explicitly starting execution and `.env` does not exist:

1. Create `.env` from `.env.example`.
2. Ensure `.gitignore` protects `.env`, `.env.*`, private deployments and
   `test-artifacts/`.
3. Run `chmod 600 .env`.
4. Open `.env` locally for the user to fill missing local secrets.

The explorer API key is not an RPC URL. RPC URLs must still be supplied in the
ignored local env or runtime secret manager.

## Gas And Value Policy

- The hard token spend gate for Abu V2 acceptance is token-value: every
  token-value action must be `<= 3 USDT` equivalent.
- Do not invent a tiny generic Gas gate. Enforce the currently approved packet's
  per-transaction and cumulative BNB ceilings, and stop if the packet omits
  those ceilings or a transaction would exceed them.
- Estimate gas, calldata, nonce, chain ID, target and signer before broadcast.
- Stop on revert, target/signature/calldata/nonce mismatch, stale packet,
  token-value excess, approved BNB ceiling excess, Router residual anomaly,
  failed reconciliation or missing Core/DB/UI finality.
- Record actual gas in the evidence packet and report.

## Circuit Breakers And Cleanup

Circuit breakers must keep fulfillment, takeover, recovery, reconciliation,
finality synchronization and audit reads available. After the three-buyer run:

1. Pause or block new micro payments as planned.
2. Hide/delist micro products and wait for quotes/reservations to expire.
3. Ensure all micro settlement transfers are `SETTLED`.
4. Clear micro entitlement and excess W6 allowance/temporary qualification when
   applicable.
5. Restart Core, run the cleanup gate, then observe production for 600 seconds.

## Final Report

Use `MAINNET_MICRO_TEST_REPORT.template.md` or `pnpm micro:report` as a local
scaffold only. A final Go report must include preflight output, packet hash,
W5/W1/W6 tx hashes, 15-confirmation receipt evidence, wallet deltas, Router zero
residual, order/fulfillment/ledger/settlement reconciliation, three-browser UI
evidence, cleanup gate and 600-second observation.
