# Abu 24K V2 Contract Freeze

> **SUPERSEDED FUNDS MODEL:** The `2.0.0-rc.2` contract graph below predates
> the function-first rewrite and must not be used for implementation or
> deployment. `docs/V2_SYSTEM_CONTRACT.md` is authoritative. This file remains
> temporarily as removal/rewrite evidence for the payment batch.

Status: coordinated local artifact `2.0.0-rc.2`. This freeze implements the
Phase 1 system authority and is included in the coordinated local publication.
It does not prove product consumption or authorize deployment or a transaction.

## Requirement And Decision Coverage

The contract set implements the on-chain portions of:

- `MAL-SEK-003` through `MAL-SEK-004`, `MAL-STOCK-001`, `MAL-WALLET-001`,
  `MAL-TX-001`, `MAL-SEC-001` and `MAL-FLOW-003`;
- `MER-FUL-001`, `MER-FUL-006`, `MER-ASSET-001` through `MER-CLAIM-001`;
- `ADM-POL-001` through `ADM-POL-005`, `ADM-SEK-001` through
  `ADM-SEK-004`, `ADM-TAKE-001` through `ADM-TAKE-004`, `ADM-CLEAR-001`
  through `ADM-CLEAR-004`;
- `D-V2-001` through `D-V2-021` where the decision has an on-chain effect.

Database, API, indexer, signer and executor evidence is maintained by their
separate Core gates. Product consumption and provider evidence remain later
integration work. A contract event alone is not final product evidence.

## Contracts

| Contract | Responsibility | Funds held |
|---|---|---|
| `PolicyRegistryV2` | Immutable policy versions; Safe, RBAC and secondary-signature publication | None |
| `BeneficiaryRegistryV2` | Referral-cycle prevention, region binding and ERC-721/ERC-1155 credential validation | None |
| `TwapOracleAdapterV2` | Fixed 30-minute NPL/USDT TWAP, max-age, liquidity and 5% deviation validation | None |
| `BNMTokenV2` | ERC-20/18 BNM minted only by `ClaimVaultV2` | Mint authority only |
| `ClaimVaultV2` | Signed merchant, reward, prize and BNM Claims with independent pause scopes | Available USDT and NPL liabilities |
| `RewardLedgerV2` | Order-linked Locked NPL and fulfillment-final reward routing | Locked 80% NPL route |
| `MerchantGuaranteeVaultV2` | Guarantee, merchant available proceeds, risk reserve and takeover debt | Guarantee, reserve and takeover funds |
| `PaymentEscrowV2` | Exact dual-leg payment, Burn, reservation replay protection, takeover and fulfillment finality | Locked order USDT |
| `SeckillV2` | Dual-quote chain-time classification, inventory, relay time, prize and settlement | Unsettled USDT prize pools |

No V2 contract exposes a business-refund method. Safe technical recovery can
move only token balance above the contract's recorded liabilities.

## Payment Conservation

For every signed order:

```text
USDT payment
  = merchant proceeds
  + platform amount
  + seckill prize contribution when applicable
  + versioned USDT remainder

NPL payment
  = exact Burn amount
  + Locked route amount

Locked route
  = all Available NPL Claims after fulfillment finality
  + circulation pool amount
```

`PaymentEscrowV2` rejects any amount tuple that does not satisfy these
equalities. It also rejects an NPL amount whose versioned Burn cannot be
represented exactly in integer token units. Reward capacity is proven before
payment, so a valid payment cannot later fail fulfillment because its reward
allocation exceeds the Locked route.

A zero payment leg is neither transferred nor sent to its downstream ledger.
The zero-NPL policy path does not call the Oracle.

## Snapshots And Replay Protection

The signed order binds policy and oracle versions, product/SKU/quantity, fulfillment
target, immutable region, product policy hash, reservation ID and hash,
reservation deadline, nonce, exact amounts, session identity and every
beneficiary. Used buyer nonces and reservation IDs cannot be replayed.

Referral and region relationships are validated at payment, then the exact
beneficiary tuple and policy version are stored with the order. Later registry
or policy changes do not alter the stored reward source.

Operations beneficiary sets are capped at 32 positive-weight accounts so the
entire reward release remains executable inside the tested finalization gas
budget. A policy with a larger set fails publication.

EIP-712 authorization uses the BSC chain-specific domain and contract address.
`SignatureChecker` supports EOAs and ERC-1271 contract wallets. There is no
`tx.origin` authorization.

## Fulfillment And Takeover

- Delivery shipment and delivery evidence are accepted only for delivery
  orders. Pickup uses its signed verification route.
- Customer receipt, pickup verification, reviewed forced receipt or final
  arbitration creates a fulfillment request. A separate finality attestation
  must bind chain 56, resource, expected event, transaction, block hash,
  confirmations, status `1`, nonce, deadline and evidence hash.
- A merchant forced-receipt call only records a request after seven days from
  logistics delivery. It cannot release funds.
- Seven days without shipment evidence on a delivery order lets any caller open
  the deterministic takeover case. Each order reserves full takeover coverage
  at payment. Opening the case locks funds in priority order from guarantee,
  unencumbered merchant Available USDT and then the risk reserve.
- Risk-reserve debt is created only when that reserve is actually disbursed.
  Any unused guarantee, merchant Available USDT and reserve are restored when
  the takeover order reaches fulfillment finality.
- Each actual disbursement requires the Safe-held RBAC role, direct Safe
  execution and a secondary EIP-712 signature binding the order, policy,
  merchant, recipient, amount, previous/next cumulative spend, evidence,
  nonce and deadline. A hot executor role cannot disburse funds by itself.
- The merchant is frozen for new orders and its merchant/reward/BNM Claims while
  any takeover case remains active or platform debt is unpaid. A prize the same
  address won as a buyer remains claimable. Safe can restore the merchant only
  after all takeover orders reach fulfillment finality, debt is zero and both
  versioned reserve thresholds are met.
- Pickup timeout/takeover evidence is not defined by the frozen inputs. Pickup
  takeover therefore fails closed as `PickupTakeoverDecisionBlocked`; successful
  signed pickup verification still follows the normal finality path.

## Seckill Boundary

A purchase signature covers both the seckill and ordinary fallback order. Both
orders share buyer, merchant, order ID, product, SKU, quantity, policy version
and nonce, while their reservation IDs are distinct.

The inclusion timestamp is authoritative:

- before both relay and 60-minute main deadlines, the seckill order consumes
  seckill inventory and contributes to the prize pool;
- at or after either deadline, the ordinary fallback order executes atomically;
- failure of fallback inventory reservation, balance or allowance reverts the
  whole transaction.

The initial relay time and cap are 60 seconds. Each successful canonical
purchase adds 30 seconds to remaining relay time without exceeding 60 seconds
or the main deadline. The last valid seckill buyer receives the pool only after
the final settlement delay. An injected pool in an empty session remains Locked
and settlement returns `NoWinner`. No rollover or recovery path may move it
until a future policy explicitly resolves that `DecisionBlocked` allocation.

## Circuit Breakers

The independent scopes are:

1. new ordinary and seckill orders;
2. seckill purchases;
3. seckill settlement;
4. merchant USDT Claims;
5. NPL and BNM reward Claims;
6. prize USDT Claims.

Shipment, pickup, arbitration, forced-receipt review, takeover, fulfillment
finality, reconciliation evidence, debt repayment and surplus-only recovery do
not read these pause flags. Pause and resume require the Safe-held RBAC role and
emit evidence-bound events.

## Deployment Order

1. `PolicyRegistryV2`
2. `BeneficiaryRegistryV2`
3. `TwapOracleAdapterV2`
4. `BNMTokenV2`
5. `ClaimVaultV2`
6. `RewardLedgerV2`
7. `MerchantGuaranteeVaultV2`
8. `PaymentEscrowV2`
9. `SeckillV2`
10. Execute every post-deployment role grant in `role-catalog.json`.
11. Publish policy version 1 only after every DecisionBlocked value has explicit
    approval evidence.
12. Verify bytecode, role membership, immutable addresses and artifact SHA-256
    before enabling any quote signer or executor.

Production contract addresses remain `null` in the manifest. Safe, secondary
signer, quote signer, finality signer, TWAP source and RPC are ExternalBlocked.

## Generated Artifacts

Run:

```bash
pnpm --filter @abu24k/core contracts:build
pnpm --filter @abu24k/core contracts:artifacts
pnpm --filter @abu24k/core contracts:artifacts:check
```

The deterministic output is under `packages/core-artifacts/contracts/` and
contains nine ABIs, one ABI bundle, deployment manifest, event catalog, role
catalog and `SHA256SUMS`. Product clients must not consume this contract-only
snapshot until Core publishes the coordinated OpenAPI/types/enums/WebSocket and
consumer-test checkpoint.
