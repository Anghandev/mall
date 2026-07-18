# BSC Mainnet Micro-Test Approval Plan

Status: `DRAFT`, `NOT AUTHORIZED` and `NON-EXECUTABLE`.

This draft is bound to local settlement/admin artifact
`2.0.0-settlement-admin.16`. It does not authorize deployment, approval, token
transfer or any transaction. The completed redacted readiness check read local
configuration without printing addresses or private keys. The generic
`pnpm micro:preflight` remains insufficient because it prints wallet addresses
and does not attest this project's contracts or exact transaction packet.

## Proven Readiness

- the full local `pnpm verify`, combined E2E, backup/restore, breaker drills and
  one bounded funds/permissions review passed;
- the coordinated manifest has no `DecisionBlocked` entries;
- both configured RPC providers return BSC chain ID `56`;
- all five configured Safes have runtime code and respond to the required Safe
  read interfaces;
- the deployment key, configured technical wallet and local technical roles
  match without exposing their values;
- the node weight is 100% and the four operations weights are 25% each;
- the deployer native balance exceeds the configured micro-test BNB budget at
  the observed Gas price.

## Current Blockers

Execution remains prohibited while any of these is true:

- the coordinated manifest has `deploymentAuthorized: false`;
- the three payment contracts are not deployed, source-verified or bound to the
  final artifact by deployment block and runtime-code hash;
- the project-specific dry-run packet has not produced exact CREATE nonces,
  constructor calldata, Gas estimates and post-deployment attestations;
- the fixed-pair dual-RPC reserve quote, isolated signer and Router bindings
  have not passed the project-specific fork checks;
- the user has not approved one exact bounded transaction packet.

The current generic preflight checks only environment, chain, wallet and budget.
It is insufficient for this project and cannot authorize a run.
Map, logistics, printing, notification, media and BNM provider configuration is
not a deployment or payment-micro-test blocker; those features remain honestly
`ConfigurationRequired` until their production acceptance is performed.

## Future Deployment Evidence

The payment contract order is:

1. `PolicyRegistryV2`
2. `BeneficiaryRegistryV2`
3. `PaymentRouterV2`

Before approval, a project-specific dry run must prove constructor arguments,
CREATE addresses, runtime-code hashes, source verification inputs, Safe-held
roles, policy secondary signature, fixed token/pair addresses and Router zero
retention on a BSC fork. Core must read matching fixed-pair reserves from both
RPC providers at one common block and sign the exact NPL amount. Test
deployments are never promoted to production when production inputs change.

The final manifest must bind each deployment block and actual runtime code hash.
Runtime readiness must reproduce those values and a matching fixed-pair reserve
snapshot from both configured RPC providers before new quotes are enabled.

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

1. deploy and verify the three contracts and Safe-held roles;
2. publish one approved payment policy through RBAC, secondary signature and
   Safe execution;
3. configure one dedicated merchant, SKU, beneficiary and region snapshot;
4. fund only the approved buyer USDT/NPL and micro operational amounts;
5. execute one ordinary payment and prove 1%-of-list USDT to the Platform
   Service Fee Safe, the remaining 69%-of-list product USDT plus independent
   freight USDT to the Custody Safe, 20% NPL to Burn, 10% NPL to the Reward Safe
   and zero Router retention;
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
The 1,000 USDT merchant guarantee remains a local/fork test and is not reduced
or represented as a mainnet micro amount.

## Stop Conditions

Stop before the next broadcast on any failed assertion, receipt status other
than 1, reorg, replacement mismatch, chain mismatch, inconsistent, empty or
low-liquidity pair reserves, quote expiry, finality shortfall, unexpected event/balance/liability,
Router retained balance, role drift, Safe nonce drift, provider failure, audit
failure or budget excess.

Failed mined transactions still consume the approved gas budget. Resuming after
a stop requires a new evidence package and explicit user approval. Approval of
this draft alone is never approval to transact.
