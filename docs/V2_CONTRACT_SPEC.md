# Abu 24K V2 Payment Contract Freeze

Status: coordinated local settlement/admin checkpoint
`2.0.0-settlement-admin.16`. The generated
manifest contains no deployment addresses and has `deploymentAuthorized:
false`. This document does not authorize deployment or a transaction.

## Contract Set

| Contract | Responsibility | Funds held |
|---|---|---|
| `PolicyRegistryV2` | Immutable policy versions; Safe/RBAC publication with an exact secondary EIP-712 signature | None |
| `BeneficiaryRegistryV2` | Referral-cycle prevention and immutable region-beneficiary snapshot validation; the legacy genesis field must be zero | None |
| `PaymentRouterV2` | Signed ordinary/seckill payment, replay protection, Safe transfers, boundary classification and payment breakers | Normally zero |

V2 deploys no BNM token, Claim vault, reward ledger, payment escrow, guarantee
vault or separate seckill funds contract. Fulfillment, arbitration, guarantees,
transferable rewards and Safe settlement are published PostgreSQL-ledger/Core
responsibilities; the Router contract set remains limited to payment policy,
beneficiary validation and atomic collection.

## Payment Intent

The Router EIP-712 domain is `Abu24KPaymentRouter`, version `2`, BSC chain 56 and
the deployed Router address. `pay` and `paySeckill` require both the configured
quote signer and the buyer signature. `SignatureChecker` supports EOAs and
ERC-1271 wallets. Authorization never uses `tx.origin`.

The signed `PaymentIntent` binds:

- order and policy version;
- buyer, merchant, product, SKU, quantity and fulfillment mode;
- fulfillment target, region and product-policy hashes;
- reservation ID/hash/deadline, issue time, quote deadline and buyer nonce;
- exact list price, product USDT leg, Platform Service Fee Safe amount, Custody
  product USDT, freight USDT, total USDT debit, NPL payment, Burn, Reward Safe,
  merchant concession and BNM-points amounts;
- concession allocation hash, session identity and six beneficiary addresses.
  The governed allocation-set hash also binds the explicit seckill prize-pool
  account and `SECKILL_PRIZE_LIABILITY_V1` purpose domain; no consumer infers
  that account from an allocation position or weight.

Order IDs, buyer nonces and reservation IDs are one-use. Quote validity is at
most five minutes. Reservation validity must cover the quote. Current policy
and beneficiary validation are checked against the signed snapshots. The Router
does not read any external price contract.

## Funds Conservation

For the frozen launch policy:

```text
product USDT leg = 70% of USDT list price
platform service fee = 1% of list price -> Platform Service Fee Safe
Custody product USDT = product USDT leg - service fee (nominally 69%)
delivery freight = product defaultFreightUsdt; pickup freight = 0
USDT buyer debit = product USDT leg + freight
Custody receipt = Custody product USDT + freight -> USDT Custody Safe
NPL buyer debit  = 30% of the exact Core-quoted NPL equivalent
NPL Burn         = 20% of the same Core quote -> dead address
NPL rewards      = 10% of the same Core quote -> NPL Reward Safe
```

The Router checks buyer and destination balance deltas for every transfer. A
fee-on-transfer token, partial transfer, missing allowance or amount mismatch
reverts the whole call. A successful call leaves the Router's prior USDT and NPL
balances unchanged. There is no arbitrary withdrawal, business refund or
on-chain Claim function.

`PaymentCompleted` records classification, product USDT, service fee, Custody
product USDT, freight USDT, total USDT paid, exact NPL paid/Burn/reward amounts,
BNM Locked points, reservation and immutable snapshot hash.
`MerchantReceivableSnapshotted` records merchant base receivable, concession,
net receivable and allocation hash. These events are evidence for the canonical
off-chain double-entry ledger; they are not settlement authorization.

## Seckill Boundary

`openSeckillSession` snapshots policy version, start, 60-minute main deadline
and 60-second relay deadline. Direct execution by the immutable governance Safe
is required.

A seckill signature binds seckill and retail-fallback payment intents. Identity,
buyer, merchant, product/SKU, quantity, policy, deadlines, nonce, concession and
beneficiaries must match; reservations and prices are independent.

- inclusion strictly before both main and relay deadlines executes seckill;
- inclusion at or after either deadline executes retail fallback atomically;
- a final seckill purchase adds 30 seconds to remaining relay time, capped at 60
  seconds and never beyond the main deadline.

Those values are the immutable launch policy (`policyVersion = 1`). A future
governed policy may change the Burn/Reward split, reward shares and seckill
timers, but only future quotes and sessions use it. Existing quotes, orders and
open sessions keep their original policy snapshot.

Failure of the selected payment leg reverts the transaction. The unused
off-chain reservation is released only after the selected event reaches 15
canonical confirmations.

## Circuit Breakers

`PaymentRouterV2` has independent `newPaymentsPaused` and
`seckillPurchasesPaused` flags. Pause and resume require direct execution by the
immutable governance Safe and a nonzero evidence hash.
They stop only new payment writes. Indexing, finality, reorg recovery,
fulfillment, takeover, reconciliation and audit reads remain outside the Router
and cannot be stopped by these flags.

## Deployment Boundary

The future deployment order is:

1. `PolicyRegistryV2`
2. `BeneficiaryRegistryV2`
3. `PaymentRouterV2`

The five configured Safes and primary/fallback RPC have passed read-only runtime
checks, and the configured technical wallet supplies the local deployment,
secondary-signing, quote-signing and finality roles. Safe owners and thresholds
remain user-managed. There are no current business `DecisionBlocked` entries.
Deployed bytecode, runtime roles and an exact separately approved transaction
packet remain required before broadcast; no deployment or mainnet transaction
is permitted by this document.

Every deployed contract manifest entry must record its address, deployment
block and actual runtime `deployedCodeHash`. Build-artifact hashes alone are not
accepted as runtime deployment evidence.

The frozen Foundry profile uses optimizer runs `1`, IR compilation and no CBOR
metadata. `forge build --sizes` is a release gate; no Router artifact at or
above the EIP-170 runtime limit may be published or deployed.

Deployment evidence is published only through the reviewed
`platform-v2/deployments/bsc-payment-v2.json` input. Both artifact generators
consume that file, so a deployed manifest remains reproducible under
`artifacts:check`; hand-editing generated JSON cannot authorize deployment.

Deterministic ABI, event, role and manifest output is under
`packages/core-artifacts/contracts/`. Product code consumes only the coordinated
artifact package and must not copy or handwrite calldata.
