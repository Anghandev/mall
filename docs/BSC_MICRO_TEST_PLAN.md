# BSC Mainnet Micro-Test Approval Plan

Status: `DRAFT`, `NOT AUTHORIZED` and `NON-EXECUTABLE`.

This draft is bound to local settlement/admin artifact
`2.0.0-settlement-admin.1`. It does not
authorize deployment, approval, token transfer or any transaction. No `.env` or
private key is read for this plan. `pnpm micro:preflight` must not be run until
the full local release gate passes and the project-specific preflight described
below is implemented.

## Current Blockers

Execution remains prohibited while any of these is true:

- the coordinated manifest has `deploymentAuthorized: false`;
- any `DecisionBlocked` payment allocation, including the seckill prize-pool
  account, remains;
- governance, USDT Custody, NPL Reward or Operations Treasury Safe addresses
  and owners are unavailable;
- secondary policy signer, quote signer, primary/fallback RPC, production
  domains or isolated signer service are unavailable;
- all three complete product consumers,
  combined E2E, security review, backup/restore and breaker drills are incomplete;
- deployed bytecode, roles, immutable addresses and verified source do not match
  the final coordinated artifact;
- the user has not approved one exact bounded transaction packet.

The current generic preflight checks only environment, chain, wallet and budget.
It is insufficient for this project and cannot authorize a run.

## Future Deployment Evidence

The payment contract order is:

1. `PolicyRegistryV2`
2. `BeneficiaryRegistryV2`
3. `TwapOracleAdapterV2`
4. `PaymentRouterV2`

Before approval, a project-specific dry run must prove constructor arguments,
CREATE addresses, runtime-code hashes, source verification inputs, Safe-held
roles, policy secondary signature, fixed token/pair addresses and Router zero
retention on a BSC fork. Test deployments are never promoted to production when
production Safe inputs change.

The final manifest must bind each deployment block, each actual runtime code
hash and the independently approved TWAP source code hash. Runtime readiness
must reproduce those values from both configured RPC providers before new
quotes are enabled.

After explicit approval, the non-secret evidence is recorded in
`platform-v2/deployments/bsc-payment-v2.json` with the bounded release-evidence
hash. Generated manifests must not be edited directly.

## Required Approval Packet

Every proposed transaction must be listed in execution order with:

```text
chainId = 56
transaction sequence number and total count
from role and expected signer
to address and verified contract name
function signature and 4-byte selector
exact calldata and keccak256 calldata hash
policyVersion, order/session/reservation IDs
USDT and NPL integer amounts
native value
current allowance and requested allowance
replacementForTxHash, if any
eth_estimateGas, gas limit, fee ceiling and maximum BNB cost
expected events and exact wallet/Safe/Burn/Router balance deltas
post-transaction assertion and stop condition
```

The packet also fixes the per-transaction and cumulative BNB, USDT and NPL
budgets. Unknown targets, selectors, trailing calldata, amount drift, allowance
drift, replacement mismatch or a changed Safe nonce invalidates the approval.

## Future Micro-Test Sequence

Only after the complete release gate and separate approval, the bounded run may
cover:

1. deploy and verify the four contracts and Safe-held roles;
2. publish one approved payment policy through RBAC, secondary signature and
   Safe execution;
3. configure one dedicated merchant, SKU, beneficiary and region snapshot;
4. fund only the approved buyer USDT/NPL and micro operational amounts;
5. execute one ordinary payment and prove 70% USDT to Custody Safe, 20% NPL to
   Burn, 10% NPL to Reward Safe and zero Router retention;
6. execute one seckill payment and one deadline fallback using independent
   reservations and prove the 60-minute/60-second/+30-second rules;
7. wait for 15 canonical confirmations and prove event indexing, balanced Locked
   journals, order finality and unused reservation release;
8. execute the separately approved fulfillment and BNM-points path, prove the
   BNM backend rejects a delayed lower `stateVersion`, prove the seckill prize
   liability remains Locked until session settlement, record the evidence hash
   used by the runtime readiness gate, then execute the published
   settlement-request and Safe MultiSend micro paths;
9. exercise payment/seckill/settlement breakers while recovery reads and
   finality continue;
10. revoke temporary token allowances and reconcile every wallet, Safe, Burn,
    ledger liability, event and audit record.

There is no business-refund or on-chain Claim fallback.

## Stop Conditions

Stop before the next broadcast on any failed assertion, receipt status other
than 1, reorg, replacement mismatch, chain mismatch, stale or low-liquidity
Oracle, quote expiry, finality shortfall, unexpected event/balance/liability,
Router retained balance, role drift, Safe nonce drift, provider failure, audit
failure or budget excess.

Failed mined transactions still consume the approved gas budget. Resuming after
a stop requires a new evidence package and explicit user approval. Approval of
this draft alone is never approval to transact.
