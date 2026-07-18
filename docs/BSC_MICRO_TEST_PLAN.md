# BSC Mainnet EOA Deployment And Micro-Test Plan

Status: `LOCAL_GATES_PASSED`; five-role EOA deployment `PENDING`;
mainnet broadcast `NOT_AUTHORIZED`.

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
deploymentStatus = PENDING
deploymentAuthorized = false
contracts = empty
```

No EOA-bound `PolicyRegistryV2`, `BeneficiaryRegistryV2` or
`PaymentRouterV2` deployment has been broadcast. No EOA policy publication,
token approval, payment, seckill, guarantee or settlement transaction has been
broadcast.

## Exact Packet Gate

Before any broadcast, one ignored mode-600 packet must bind every transaction
in execution order. The user approves the packet by its SHA-256. The packet
must contain:

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
SHA-256 approval. Complete role addresses remain only in the ignored packet
and local evidence, never in tracked documentation or chat output.

## Intended Sequence

1. Deploy `PolicyRegistryV2` from the Platform Governance EOA.
2. Deploy `BeneficiaryRegistryV2` bound to the new Policy Registry.
3. Deploy `PaymentRouterV2` bound to BSC USDT/NPL, both new registries and the
   four distinct funding EOAs.
4. Wait for 15 canonical confirmations and verify runtime code, constructor
   bindings, roles, zero native value and zero USDT/NPL balances.
5. Publish policy V1 and required beneficiary snapshots through the Platform
   Governance EOA with the exact secondary EIP-712 signature.
6. Fund only the minimum Gas and token amounts fixed by the approved packet.
7. Execute one ordinary payment and prove the exact service-fee, Custody,
   freight, NPL Burn and NPL Reward deltas with zero Router retention.
8. Execute the bounded seckill/boundary flow and prove reservation,
   classification and prize-liability evidence.
9. Prove fulfillment/finality and the local/Fork 1,000-USDT guarantee path;
   the guarantee minimum is never disguised as a mainnet micro amount.
10. Execute one signed settlement request as individual EOA ERC-20 transfers,
    wait for 15 confirmations and reconcile every ledger liability and TxHash.
11. Exercise payment/seckill/settlement pause and recovery while finality,
    reconciliation and audit reads remain available.

Safe proposals, owner signatures, `execTransaction`, MultiSend and Safe nonce
are not part of this sequence.

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
