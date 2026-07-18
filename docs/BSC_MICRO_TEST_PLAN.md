# BSC Mainnet EOA Deployment And Micro-Test Plan

Status: `EOA_DEPLOYED`; approved setup packet `COMPLETE_15_OF_15`;
recovery packet `EXECUTED`.

This plan is bound to settlement/admin artifact
`2.0.0-settlement-admin.16` and the five-role EOA architecture in
`V2_SYSTEM_CONTRACT.md`. It does not authorize a transaction.

## Current Evidence

- `pnpm verify` passed after all three products consumed the same Core artifact.
- Contract unit, fuzz and invariant tests passed, including per-asset
  conservation, replay protection, permissions and payment pause/resume.
- Database and worker tests passed for append-only settlement transfers,
  replacement, failed-receipt quarantine, 15-confirmation finality, reorg,
  guarantee funding and coverage pause/resume.
- Combined Core and browser E2E passed without a production fixture.
- Same-version backup/restore and mode-600 production-backup gates passed.
- Both configured read-only RPC endpoints report BSC chain ID `56`.
- The five EOA role addresses are derived from ignored local key configuration;
  no private key or complete role address is stored in this document.
- The EOA-bound `PolicyRegistryV2`, `BeneficiaryRegistryV2` and
  `PaymentRouterV2` reached more than 15 canonical confirmations on both RPCs,
  their runtime/immutable bindings and zero contract token balances matched,
  and BscScan shows `Exact Match` source verification.
- Policy V1, the required region snapshot and the test referral snapshot were
  published by the Platform Governance EOA.
- The approved recovery packet completed the NPL funding swap and both Router
  approvals. Its three receipts reached at least 15 confirmations on both RPCs;
  the NPL net output and both exact allowances matched their assertions.
- The bounded payment/seckill packet opened one session, completed one ordinary
  payment and completed one payment inside the real 60-second relay window.
  Both payment events had the intended classification; exact buyer, service-fee,
  Custody, Burn and Reward balance deltas matched with zero Router retention.

## Deployment State

The earlier Safe-bound deployments are historical evidence only:

- `platform-v2/deployments/bsc-payment-v2-safe-superseded.json` is
  `SUPERSEDED`;
- those contracts had no published policy and no user funds at replacement;
- they must not receive a policy, payment, settlement or governance action.

The active deployment manifest is
`platform-v2/deployments/bsc-payment-v2.json`. It is currently:

```text
architecture = FIVE_ROLE_EOA_V2
deploymentStatus = DEPLOYED
deploymentAuthorized = true
contracts = three EOA-bound payment contracts
```

The approved setup packet SHA-256
`a4ae37208136f90810f49a673de35850ea198b7cdca5e5694057dafbb4278328`
executed sequences 1-12. This covered all three deployments, region and Policy
V1 publication, referral binding, minimum role Gas and the USDT funding swap.
Sequence 13 was initially stopped before broadcast because the NPL DEX-pair
buy tax made the approved 95%-of-old-quote `amountOutMin` slightly higher than
the current tax-adjusted net output. This was not evidence of an ordinary
ERC-20 transfer tax: fixed-block fork checks showed exact buyer-to-Router
`transferFrom` and exact Router-to-Burn/Reward delivery. The separately
approved recovery packet then completed sequences 13-15. No payment, seckill,
guarantee or settlement transaction has been broadcast.

## Exact Packet Gate

Before any broadcast, one ignored mode-600 packet must bind every transaction
in execution order. The user has authorized Core to execute these bounded
packets without repeating a chat SHA confirmation, provided each token-value
action remains at or below 3 USDT and the existing Gas/total budgets do not
change. The packet must contain:

```text
chainId = 56
artifact version and git commit
sequence number and total transaction count
from role and derived signer address
current account nonce
target address, contract and function signature
exact constructor arguments or calldata and calldata hash
native value and token integer amounts
eth_estimateGas, gas limit, fee ceiling and maximum BNB cost
per-transaction and cumulative BNB/USDT/NPL budget
expected events and exact role-wallet/Burn/Router balance deltas
post-transaction assertions and stop conditions
```

Any change to chain, signer, nonce, target, constructor argument, calldata,
amount, Gas ceiling or total budget invalidates the packet and requires a new
mode-600 packet plus the same full preflight. Complete role addresses remain
only in the ignored packet and local evidence, never in tracked documentation
or chat output.

The final three setup actions were executed from the ignored mode-600 recovery
packet with SHA-256
`77b1fc3fbcc12c602b76f128017783bca10eb821703ab33cec9a61bf0cf5d4ac`.
It used the approved counterparty nonce, a 94%-of-live-gross NPL minimum and the
same Router approvals. The mode-600 receipt evidence has SHA-256
`aeb92addcfac780b732d2f34e9e973f7ee22a3341f02e7da9fe53e14deec4338`.
Actual native value plus Gas was `0.0000471636 BNB`, below the approved
`0.00005447145 BNB` ceiling.

## Intended Sequence

1. Completed: deploy `PolicyRegistryV2` from the Platform Governance EOA.
2. Completed: deploy `BeneficiaryRegistryV2` bound to the new Policy Registry.
3. Completed: deploy `PaymentRouterV2` bound to BSC USDT/NPL, both new registries and the
   four distinct funding EOAs.
4. Completed: wait for 15 canonical confirmations and verify runtime code, constructor
   bindings, roles, zero native value and zero USDT/NPL balances.
5. Completed: publish policy V1 and required beneficiary snapshots through the Platform
   Governance EOA with the exact secondary EIP-712 signature.
6. Completed: fund minimum Gas, USDT and tax-adjusted NPL, then grant both
   Router approvals through the approved recovery packet.
7. Completed: execute one ordinary payment and prove the exact service-fee, Custody,
   freight, NPL Burn and NPL Reward deltas with zero Router retention.
8. Completed: execute the bounded live-seckill flow and prove reservation,
   classification and prize-liability evidence.
9. Prove fulfillment/finality and the local/Fork 1,000-USDT guarantee path;
   the guarantee minimum is never disguised as a mainnet micro amount.
10. Execute one signed settlement request as individual EOA ERC-20 transfers,
    wait for 15 confirmations and reconcile every ledger liability and TxHash.
11. Exercise payment/seckill/settlement pause and recovery while finality,
    reconciliation and audit reads remain available.

Safe proposals, owner signatures, `execTransaction`, MultiSend and Safe nonce
are not part of this sequence.

The payment/seckill packet SHA-256 is
`0827139fded2db88988b02edc368322a63a8a52b4a0be6a941deb6efbb8fc945`.
Its mode-600 receipt evidence SHA-256 is
`f32a3405dbfd957fbbcb0986feb1556f751e592dea4460e979b99de8d40aa866`.
Actual Gas was `0.00003902305 BNB`, below the packet's
`0.0000585345 BNB` ceiling. The ordinary and seckill list prices were `0.01`
and `0.005 USDT`; no fallback payment was used.

## Hard Limits And Stop Conditions

- Each token-value test action remains at or below the project's `3 USDT`
  equivalent ceiling; the approved packet sets a lower exact amount whenever
  the contract permits it.
- Native value is zero except an explicitly listed minimum Gas funding transfer.
- The packet fixes maximum Gas per transaction and a cumulative BNB ceiling.
- Stop before the next broadcast on any failed assertion, status-0 receipt,
  reorg, nonce/replacement drift, chain mismatch, unexpected bytecode or role,
  quote expiry, finality shortfall, unexpected event/balance/liability, Router
  retained balance, RPC disagreement, audit failure or budget excess.
- A failed mined transaction still consumes the packet's Gas budget.

## Non-Blocking Production Configuration

Maps, logistics, waybill/printing, SMS/email/Push, OSS/CDN, BNM backend and
production databases/queues/domains remain `ConfigurationRequired` until their
real accounts and devices are connected. Their absence does not block EOA
contract preparation or the bounded chain test, and no adapter may simulate
success.

There is no business refund, on-chain BNM token or Claim fallback.
