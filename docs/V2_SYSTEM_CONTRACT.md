# Abu 24K V2 System Contract

Status: frozen Phase 1 authority for every V2 contract, service, database and
product surface. Decision details and source conflicts are indexed in
`V2_DECISIONS.md`.

## Authority And Failure Mode

- This contract overrides a source PRD only where a Decision ID explicitly
  identifies the conflict. Every non-conflicting PRD requirement remains in
  force.
- Frontends never calculate prices, payment legs, allocations, rewards,
  beneficiary eligibility or finality. They render signed Core projections and
  `allowedActions`.
- Historical orders and in-progress seckill sessions use their immutable
  snapshots. Current admin configuration is never read to recalculate them.
- Missing production business parameters return `DecisionBlocked`. Missing
  credentials, accounts, devices, domains, RPC endpoints or Safe addresses
  return `ExternalBlocked` or `ConfigurationRequired` as specified by the
  consumer contract. No production path may simulate success.

## Network, Assets And Payment

- BSC chain ID is `56`.
- USDT is `0x55d398326f99059fF775485246999027B3197955`.
- NPL is `0x4e8277ab31e4956b2cd48449793a57656dfc03d2`.
- Product list price and merchant settlement cost are denominated in USDT.
- A versioned product policy supplies exact USDT and NPL buyer payment legs.
  The two basis-point weights sum to 10,000. A zero-value leg requires neither
  approval nor transfer.
- The first insufficient allowance defaults to `MaxUint256`. Before approval,
  the customer sees the token, spender, allowance, risk and revocation route.
- Quotes use integer token units and canonical decimal strings. They bind the
  policy version, Oracle version, reservation, product/SKU/quantity,
  fulfillment mode, region, nonce, deadline and exact transaction intents.

## NPL Burn And Routing

- At payment finality, exactly 20% of the order's NPL payment leg is transferred
  to `0x000000000000000000000000000000000000dEaD`.
- The remaining 80% is locked until fulfillment finality and is the maximum
  source for all NPL reward routing for that order.
- The launch policy is fixed at 20% Burn and 80% circulation/reward routing.
  Later changes require a new `policyVersion` under the governance rules below.
- All NPL rewards are calculated from the signed NPL conversion of the order's
  total USDT list price: genesis node 2%, direct-referral shop 1%, district
  agent 1.2%, city agent 0.8%, province agent 0.6%, region agent 0.4% and
  operations 4%.
- Total routed rewards may not exceed the order's 80% NPL balance. Missing
  beneficiaries, integer rounding remainders and every unallocated remainder
  go to the circulation reward pool.
- Referral relationships and all four regional beneficiaries are snapshotted
  at payment. Self-referral and referral cycles are forbidden.

## No Business Refunds

- V2 exposes no no-reason refund, merchant-timeout refund, forced platform
  refund, refund button, refund API, refund reserve or business refund contract
  method.
- Source requirements that describe a seven-day merchant-default refund or a
  forced-refund center are `Overridden` by `D-V2-004`.
- Safe-controlled emergency recovery is limited to a documented technical
  incident. It is not a mall workflow, cannot be advertised as a refund, and
  must preserve append-only audit evidence.

## Merchant Default And Takeover Fulfillment

- The clock starts at payment finality. If no valid shipment evidence exists
  after 7 x 24 hours, the order enters platform takeover fulfillment.
- The merchant immediately loses new-order, product-listing, merchant USDT
  Claim and merchant NPL/BNM-related Claim permissions.
- Takeover funding is consumed in this order: merchant fulfillment guarantee,
  the merchant's available assets not already bound to another liability, then
  the platform fulfillment risk reserve.
- The platform or a replacement merchant completes shipment. Customer payment
  and every associated reward remain Locked until ordinary fulfillment
  finality. Platform advances become merchant debt.
- A product cannot be listed when the merchant guarantee or platform risk
  reserve is below its configured minimum. A disconnected merchant may never
  leave an order without an active takeover case.

## Receipt, Pickup, Arbitration And Finality

- Starting from logistics-confirmed delivery, a customer has 7 x 24 hours to
  confirm receipt. The merchant may then request platform forced receipt but
  cannot complete the order directly.
- Platform forced receipt requires reviewed logistics evidence. Arbitration
  keeps payment and every associated reward Locked.
- Successful in-store pickup scan enters the normal fulfillment-completion
  flow.
- Only a receipt confirmation, pickup verification or final arbitration that
  has reached chain/domain finality can release funds or rewards.
- A receipt is not final without status `1`, the expected chain, contract,
  event and resource identity, block hash, required confirmations and reorg/
  replacement reconciliation.

## Proceeds, Rewards And BNM

- Merchant proceeds are USDT-only, pull-based and claimable after fulfillment
  finality. Buyer-paid NPL is never merchant sales proceeds.
- The seckill prize pool and prize Claim are USDT-denominated. A prize becomes
  claimable only after final session settlement.
- Merchant proceeds, BNM, genesis, referral, regional, operations and store
  rewards become claimable only after fulfillment finality.
- BNM equals the order's total USDT list price at 1:1, is ERC-20 with 18
  decimals, and is order-linked. Payment creates Locked BNM; fulfillment
  finality makes it Available; Claim mints it; minted BNM is transferable.
- Genesis eligibility supports a configured ERC-721 or ERC-1155 credential and
  is snapshotted at payment. Later credential transfers do not alter history.
  Ordinary customers do not see the genesis module.

## Seckill And Boundary Orders

- A seckill main session lasts exactly 60 minutes.
- Relay time starts at 60 seconds. Each chain-final purchase adds 30 seconds;
  remaining relay time is capped at 60 seconds and may never exceed the main
  session deadline.
- A seckill intent binds both a seckill quote and an ordinary fallback quote.
  Before payment the customer explicitly acknowledges both prices and the
  classification rule.
- Chain block time is authoritative. A transaction included before the
  deadline is seckill. A transaction included after the deadline atomically
  uses the signed ordinary fallback quote and ordinary inventory, does not
  enter or win the prize pool, and calculates BNM from the ordinary quote.
- Insufficient ordinary inventory, balance or allowance reverts the entire
  transaction. A frontend never classifies the order.

## Oracle

- Core signs exact NPL/USDT quotes. On-chain validation uses a 30-minute
  NPL/USDT TWAP with maximum deviation of 5%.
- Production `maxAge` and minimum liquidity are mandatory configuration.
- Expired quotes, excessive deviation or insufficient liquidity pause new
  orders while fulfillment, recovery, reconciliation, audit reads and finality
  synchronization remain available.

## Governance And Authorization

- Seckill time, Burn/Route and revenue proportions can change only when RBAC,
  a secondary wallet signature and Safe multisig approvals publish a new
  `policyVersion`.
- A new version affects only future quotes, orders and sessions. It cannot
  mutate historical orders or in-progress sessions.
- Transaction authorization uses EIP-712 domain separation, nonce and deadline
  and supports ERC-1271. Authorization never uses `tx.origin`.
- Sensitive actions bind the exact resource, old/new values, policy version,
  expiry and approval evidence and emit indexed audit events.

## Circuit Breakers

- New orders, seckill purchases, seckill settlement, merchant proceeds Claims,
  reward Claims and prize Claims have independent pause scopes.
- Fulfillment, takeover fulfillment, emergency recovery, reconciliation,
  append-only audit reads and finality synchronization cannot be paused by a
  customer-facing breaker.
- Pause and resume require explicit RBAC and Safe authority, emit indexed
  events and have tests for blocked writes, allowed recovery, resumption and
  permission failure.

## Production Decision And External Inputs

The following are production `DecisionBlocked` until published in a versioned
policy: platform service fee, seckill prize-pool proportion, merchant-store NPL
reward proportion, merchant guarantee minimum, platform risk-reserve minimum,
guarantee top-up line, fixed remainder accounts, Oracle `maxAge`, Oracle
minimum liquidity and genesis credential contract/token ID.
The required BSC fulfillment-finality confirmation count is also
`DecisionBlocked`; test values are not production defaults.

The following are `ExternalBlocked` until supplied outside the repository:
Safe and role addresses, RPC endpoints, domains/HTTPS, provider accounts and
credentials, approved merchant/admin wallets, physical printer and mobile
device evidence.

## Versioned Core Publications

Core publishes one coordinated version of:

- OpenAPI and generated shared types;
- ABI bundle and deployment manifest;
- state and error enums plus WebSocket protocol;
- `ProductPolicy`, `SignedOrderIntent`, `SeckillQuote`,
  `FallbackRetailQuote`, `InventoryReservation`, `AllocationSnapshot`,
  `FulfillmentEvidence`, `FulfillmentFinality`, `MerchantTakeoverCase`,
  `AllowedAction` and `TransactionFinality`;
- payment, reservation, settlement, takeover, fulfillment, Claim, seckill and
  finality consumer tests.

Breaking changes require a new coordinated artifact version. Product clients
must fail closed when any member of the artifact set is missing or mismatched.
