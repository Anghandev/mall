# Abu 24K V2 Repository Rules

Read these files before planning or editing:

- `docs/V2_SYSTEM_CONTRACT.md`
- `docs/THREAD_OWNERSHIP.md`
- `docs/INTEGRATION_PROTOCOL.md`

## Authority

The shared V2 system contract overrides thread-local plans when they conflict.
Do not restore the V1 NPL-only model or invent a third payment model.

The locked V2 interpretation is:

- product price, merchant base receivable and concession are denominated in USDT;
- launch payment is exactly 70% USDT plus 30% Oracle-equivalent NPL;
- immutable PaymentRouter sends funds directly to the Custody/Reward Safes and
  normally retains zero balance;
- settlement uses the append-only double-entry ledger and Safe MultiSend, not a
  contract pull-Claim;
- BNM is existing backend points with Locked/Available states, not an ERC-20,
  mint or on-chain Claim.

Missing production decisions in the system contract must fail closed. Do not
guess fund allocations, reward timing, guarantee thresholds or beneficiary
eligibility. V2 has no business-refund model.

## Path Ownership

- Core/integration owns root tooling, `docs/`, `platform-v2/contracts/`,
  `platform-v2/server/`, `platform-v2/scripts/`, and `platform-v2/test/`.
- Mall thread may write only `mall-v2/`.
- Merchant thread may write only `merchant-v2/`.
- Platform admin thread may write only `platform-v2/admin/`.
- `legacy/v1-npl-only/` is read-only.

When a product thread needs a shared API, contract, database, signer or indexer
change, report the gap to the core thread. Do not implement it outside the core
branch. A fail-closed placeholder is temporary and never proves a Requirement
complete; it must be replaced when the corresponding Core batch is published.

## Safety

- Never commit or print `.env`, private keys, seed phrases, provider tokens,
  databases, PEM files or keystores.
- Do not deploy or send mainnet transactions until the combined release gate
  passes and the user explicitly approves the bounded transaction plan.
- Do not use `tx.origin` for authorization.
- Circuit breakers must keep fulfillment, takeover, recovery, reconciliation,
  finality synchronization and audit reads available as documented by the
  shared system contract.
- Do not delete V1 until a separate cutover task proves historical orders and
  audit evidence are safe.

## Integration

Each product branch must commit only its owned paths and report requirement IDs,
tests, commit hash, contract gaps and external blockers. Only the core thread
merges branches and updates shared release gates.
