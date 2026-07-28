# BSC Mainnet EOA Deployment And Micro-Test Plan

Status: historical packets remain lineage only. Current `.30` acceptance uses
new `MICROTEST_BUYER_1/2/3` wallets, an external `MICROTEST_AUTHORIZED`
release-authorization file and one clean non-zero prize run.

The completed acceptance run is bound to artifact
`2.0.0-fulfillment-launch.30`, commit
`54961bab58a9c32c38fccf099759795a81a8b788` and the five-role EOA architecture
in `V2_SYSTEM_CONTRACT.md`. The historical evidence below was produced under
`2.0.0-settlement-admin.16` and did not authorize or substitute for the new run.
This document alone does not authorize a transaction.

## Current Gate For This Goal

- `pnpm micro:preflight` is now the Abu V2 gate, not the old generic Web3
  template. It must bind the same `.30` artifact, release commit,
  mode-600 packet hash, five distinct production EOAs, MICROTEST_BUYER_1/2/3 buyer set,
  maximum value plus Gas ceiling, dual BSC RPC runtime code hashes, BNM and local
  DB/Redis/signer/executor configuration before any runner is valid.
- A runner that skips this preflight, uses W3 as a buyer, points at a stale
  packet, mismatches commit/artifact/runtime hash, or exceeds the 3-USDT
  maximum value plus Gas ceiling is No-Go.
- Production deployment authorization remains external to the artifact during
  the bounded micro-test. The runner may broadcast only when the signed external
  release authorization is `MICROTEST_AUTHORIZED`, the mode-600 packet has
  `broadcastAuthorized=true`, carries a bytes32 evidence hash and matches the
  env-bound packet SHA-256. A production `GO` authorization must not bypass
  packet and preflight gates.
- Broadcast preflight derives the canonical MICROTEST_BUYER_1/2/3 buyer
  addresses from the ignored local MICROTEST_BUYER_1/2/3 private-key env and
  rejects any old `WALLET_1..6` or `MICROTEST_WALLET_6` address as a buyer.
- Full local `pnpm verify` also requires `POSTGRES_ADMIN_URL` for the real
  PostgreSQL gates. The tests read it from the shell or ignored local env files
  (`.env`, `.env.runtime`, `.env.wallets.local`) and must never print the URL.

## Historical Evidence Below (Not Current Go)

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
- The bounded breaker packet paused and resumed new payments, then paused and
  resumed seckill purchases. Each governance event and state transition matched,
  both breakers finished unpaused and all receipts reached 15 confirmations on
  both RPCs.
- In the historical run, the ordinary payment event was consumed by the then-current PGlite Indexer, projected
  to a final order and completed through pickup verification. The same order
  unlocked the merchant USDT payable and one NPL beneficiary payable.
- Both signed settlement requests passed Coverage, the settlement breaker
  blocked creation while paused and recovered after resume, and the Scheduler
  created exactly one `MERCHANT_USDT` and one `REWARD_NPL` transfer. Both EOA
  transfers succeeded with exact sender/recipient deltas, reached at least 15
  confirmations, reconciled to their TxHashes and moved both requests and the
  balanced ledger to `SETTLED`.

## Deployment State

The earlier Safe-bound deployments are historical evidence only:

- `platform-v2/deployments/bsc-payment-v2-safe-superseded.json` is
  `SUPERSEDED`;
- those contracts had no published policy and no user funds at replacement;
- they must not receive a policy, payment, settlement or governance action.

The active deployment manifest is
`platform-v2/deployments/bsc-payment-v2.json`; it remains historical deployment
lineage for the deployed EOA contracts. The `.30` coordinated artifact remains immutable and externally authorized only. A signed release authorization may later mark the same artifact SHA as GO after MICROTEST_BUYER_1/2/3 non-zero prize evidence, cleanup and local release gate pass. Current split:

```text
architecture = FIVE_ROLE_EOA_V2
contractManifest.deploymentStatus = DEPLOYED
contractManifest.deploymentAuthorized = false
coordinatedManifest.deploymentAuthorized = false
coordinatedManifest.releaseGateStatus = EXTERNAL_AUTHORIZATION_REQUIRED
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
approved recovery packet then completed sequences 13-15. The later bounded
  payment, seckill, breaker and dual-settlement packets are recorded below; the
  former formal 1,000-USDT guarantee transaction is historical only and is not a current operating gate.

The current launch replaces the former formal capital operating gate with a
0-USDT guarantee requirement. Historical guarantee ingestion can still be
checked with a bounded non-zero micro-transfer when an audit task needs it, but
that check does not authorize or block listing, payment, seckill or settlement.
The report must state that any former formal 1,000-USDT guarantee was not paid
for current launch readiness. Test products are delisted only after
`NEW_PAYMENT` is paused, every bounded quote/reservation has expired, every
micro-test transfer is `SETTLED`, and `check-mainnet-microtest-cleanup.mjs`
passes against both RPCs and the business database. APPROVED merchants can
operate with a 0-USDT guarantee requirement; suspended or blacklisted merchants
remain blocked by merchant status.

## Exact Packet Gate

Before any broadcast, one ignored mode-600 packet must bind every transaction
in execution order. Historical packet approvals and the previous `.22` No-Go
baseline did not carry forward to the current `.30` acceptance. A broadcast
requires this release id, packet SHA-256, MICROTEST_BUYER_1/2/3 buyer set and the
current Goal's standing authorization only while maximum value plus Gas
remains within the <=3-USDT bounded plan. The `.30` artifact never becomes GO
by changing manifest fields; only an external signed `GO` authorization for the
same artifact SHA can follow a passed micro-test. Nonce, target,
amount, assertion or budget drift stops execution. The packet must contain:

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
bytes32 broadcast authorization evidence hash and broadcastAuthorized=true
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
9. Current release gate: submit each buyer txHash to `PaymentReceiptWorker`, verify
   the exact Router receipt and 15-confirmation finality, then project payment
   and pickup fulfillment. The former 1,000-USDT guarantee is historical compatibility evidence only
   and is not disguised as a micro amount or used as a current gate.
10. Completed: execute one signed `MERCHANT_USDT` request and one signed
    `REWARD_NPL` request as individual EOA ERC-20 transfers, wait for at least
    15 confirmations and reconcile both ledger liabilities and TxHashes.
11. Completed: payment, seckill and settlement pause/recovery all passed; every
    breaker ended unpaused.

Safe proposals, owner signatures, `execTransaction`, MultiSend and Safe nonce
are not part of this sequence.

The payment/seckill packet SHA-256 is
`0827139fded2db88988b02edc368322a63a8a52b4a0be6a941deb6efbb8fc945`.
Its mode-600 receipt evidence SHA-256 is
`f32a3405dbfd957fbbcb0986feb1556f751e592dea4460e979b99de8d40aa866`.
Actual Gas was `0.00003902305 BNB`, below the packet's
`0.0000585345 BNB` ceiling. The ordinary and seckill list prices were `0.01`
and `0.005 USDT`; no fallback payment was used.

The payment/seckill breaker packet SHA-256 is
`fe837a8565035d4f3a414fc4b60b0b86aeadec53c67d2df42e48911c6e7e36e1`.
Its mode-600 receipt evidence SHA-256 is
`492ee106b0c7439dc41090ae36881c9b2ba601603b5e400dfadd754ef5d19a91`.
Actual Gas was `0.0000069242 BNB`, below the packet's
`0.0000145301 BNB` ceiling; native value and token value were zero.

The full-chain evidence SHA-256 is
`345428449103de8e8f43c21b718fdcead2fe388c8b97d7002ef2c19c679d1d96`.
The dual-settlement packet SHA-256 is
`8f7077312dd41b1599484c692dfe39af9eb5da5f5be6910c557b858a1f3ebc18`.
Its mode-600 receipt evidence SHA-256 is
`61e3d4291964f07df58d10c19b3a381e697fd36c1004e3c900fbea882fb7608d`.
The two individual EOA transfers used `0.0000056151 BNB` Gas in total,
below their `0.000015 BNB` packet ceiling. The USDT transfer was `0.001 USDT`;
the NPL transfer was the exact available direct-referral payable and remained
within the project's 3-USDT-equivalent ceiling.

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

Maps, logistics, waybill/printing, SMS/email/Push, OSS/CDN and production
databases/queues/domains remain `ConfigurationRequired` until their real
accounts and devices are connected. Their absence does not block EOA contract
preparation or the bounded chain test, and no adapter may simulate success. The
existing BNM backend endpoint and monotonic-state contract are verified through
the Core HTTP adapter; only secure production Core configuration injection and
worker monitoring remain rollout work.

The configured public BSC RPCs support chain, block, receipt and block-receipt
reads but returned `missing trie node` for historical `eth_call`. Active
settlement finality now derives exact deltas from the finalized transaction's
ERC-20 Transfer logs, coverage uses stable dual-RPC `latest` observations and
breaker finality uses the canonical receipt/event. Production requires two
distinct Chain-56 RPC endpoints, not Archive capability; the historical bounded
micro-test evidence remains unchanged.

There is no business refund, on-chain BNM token or Claim fallback.
