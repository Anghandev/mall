# BSC Mainnet Micro-Test Execution Evidence

Status: payment contracts `DEPLOYED_AND_VERIFIED`; payment micro-test
`PREPARATION_REQUIRED`.

This evidence is bound to settlement/admin artifact
`2.0.0-settlement-admin.16`. The three-contract deployment packet completed on
BSC with 15 canonical confirmations, zero token value and `0.0004482491 BNB`
actual Gas. All three contracts are source-verified on BscScan. The completed
redacted checks did not print addresses or private keys. The generic
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
- the exact three-CREATE packet passed a fork deployment before broadcast; each
  transaction's maximum BNB cost was below `0.381 USDT` at the dual-RPC price
  snapshot and therefore within the current Goal's per-transaction `3 USDT`
  authorization;
- every deployment receipt reached 15 confirmations on both RPC providers;
  CREATE addresses, calldata, runtime hashes, immutable bindings and zero
  USDT/NPL balance deltas matched the packet;
- `platform-v2/deployments/bsc-payment-v2.json` binds the authorization,
  packet, receipts and BscScan-verification evidence hashes.

## Current Blockers

New payment execution remains prohibited while any of these is true:

- launch policy version `1` and required region beneficiaries have not been
  published through their real Safe and secondary-signature paths;
- no exact post-deployment packet yet binds the policy/Safe nonce, buyer token
  approvals, signed quote, ordinary/seckill calldata and per-asset deltas;
- the dedicated micro buyer lacks the bounded USDT/NPL balances needed by that
  packet;
- production database/Redis/indexer/signer readiness cannot reproduce the
  deployed manifest and fixed-pair dual-RPC quote snapshot;
- a required Safe action lacks the actual Safe-owner signatures.

The current generic preflight checks only environment, chain, wallet and budget.
It is insufficient for this project and cannot authorize a run.
Map, logistics, printing, notification, media and BNM provider configuration is
not a deployment or payment-micro-test blocker; those features remain honestly
`ConfigurationRequired` until their production acceptance is performed.

## Deployment Evidence

The completed payment contract order was:

1. `PolicyRegistryV2`
2. `BeneficiaryRegistryV2`
3. `PaymentRouterV2`

A project-specific dry run proved constructor arguments, CREATE addresses,
runtime-code hashes, Safe authority and fixed token/pair addresses before the
same packet was broadcast. Core must still read matching fixed-pair reserves
from both RPC providers at one common block and sign the exact NPL amount for
every payment quote.

The final manifest must bind each deployment block and actual runtime code hash.
Runtime readiness must reproduce those values and a matching fixed-pair reserve
snapshot from both configured RPC providers before new quotes are enabled.

The non-secret evidence is recorded in
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

## Remaining Micro-Test Sequence

Every remaining transaction still requires an exact packet. The current Goal
waives a separate confirmation only when each transaction's maximum value plus
Gas is at most `3 USDT`; a larger transaction requires explicit approval.

1. Completed: deploy and verify the three contracts, Router governance-Safe
   binding and Registry Safe-held roles.
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

Failed mined transactions still consume the bounded Gas budget. Resuming after
a stop requires a new evidence package; any transaction above `3 USDT` also
requires explicit user approval.
