# Abu 24K V2 System Contract

Status: frozen authority for the function-first V2 rewrite from
`v2/core@1cab34d`. Decision details and source conflicts are indexed in
`V2_DECISIONS.md`.

## Authority And Failure Mode

- This contract overrides a source PRD only where a Decision ID explicitly
  identifies the conflict. Every non-conflicting PRD requirement remains in
  force.
- The V2 code at `1cab34d` was never deployed and has no historical orders. Its
  old funds runtime is replaced, not migrated or kept behind a compatibility
  path. `legacy/v1-npl-only/**` remains read-only archival evidence.
- Frontends never calculate authoritative prices, payment legs, allocations,
  rewards, liabilities, eligibility or finality. They render signed Core
  projections, previews and `allowedActions`.
- Historical orders and in-progress seckill sessions use immutable snapshots.
  A later policy version never recalculates them.
- Missing business parameters return `DecisionBlocked`. Missing credentials,
  accounts, devices, domains, RPC endpoints or Safe addresses return
  `ExternalBlocked` or `ConfigurationRequired`. No production path may
  simulate success with a fixture, empty action or disabled placeholder.

## Network, Assets And Launch Payment

- BSC chain ID is `56`.
- USDT is `0x55d398326f99059fF775485246999027B3197955`.
- NPL is `0x4e8277ab31e4956b2cd48449793a57656dfc03d2`.
- The NPL/USDT Oracle pair is the verified PancakeSwap V2 pair
  `0x2955e33bb120714abf11ace2766e614e6e5955b2`.
- Product list price, merchant base receivable, merchant concession and Safe
  liabilities are denominated in USDT.
- The launch policy requires the buyer to pay exactly 70% of the USDT list
  price in USDT and 30% of the same price as Oracle-equivalent NPL. Without an
  explicitly funded NPL subsidy, no later policy may set the buyer NPL leg
  below 30%.
- The product USDT leg is split atomically inside the payment transaction.
  `platformServiceFeeUsdt = floor(listPriceUsdt * 100 / 10,000)` goes directly
  to the dedicated Platform Service Fee Safe. The remainder of the exact buyer
  USDT leg, `buyerProductUsdt - platformServiceFeeUsdt` (nominally 69% of list),
  goes to the USDT Custody Safe. The fee is global and never category-specific.
- Delivery adds the product snapshot's flat `defaultFreightUsdt` once per order
  as pure USDT; pickup freight is zero. This freight is outside the product
  70/30 base, goes only to the USDT Custody Safe and never changes the service
  fee, NPL payment, Burn, reward, BNM, merchant concession or seckill-prize
  calculations. The signed intent binds the buyer product USDT, service-fee
  USDT, Custody product USDT, freight USDT, total USDT and NPL amounts
  separately.
- Quotes use integer token units and canonical decimal strings. They bind
  `policyVersion`, Oracle observation, reservation, product/SKU/quantity,
  fulfillment mode, beneficiary snapshot, nonce, deadline and exact Router
  payment intent. Quote validity is five minutes.
- First approval for an insufficient allowance defaults to `MaxUint256`. The
  customer must see token, Router spender, amount, risk and revocation route.
  Sufficient allowance is not repeated; revoked or insufficient allowance is
  requested again.

## PaymentRouter And Custody

- `PaymentRouter` is immutable and non-upgradeable. It accepts only signed
  EIP-712 quotes, enforces nonce/deadline/replay protection, supports ERC-1271,
  atomically transfers both payment assets, classifies seckill boundary orders,
  emits indexed payment events and exposes the new-payment breaker.
- For a successful launch payment, the Router transfers the exact 1%-of-list
  USDT service fee directly to the Platform Service Fee Safe, transfers the
  remainder of the buyer's product-USDT leg plus delivery freight directly to
  the USDT Custody Safe, transfers NPL equal to 20% of the total USDT list price directly to
  `0x000000000000000000000000000000000000dEaD`, and transfers NPL equal to 10%
  of the same list price directly to the NPL Reward Safe.
- The Platform Service Fee Safe receives only the direct 1% fee and is not a
  Custody-backed merchant or reward ledger. The USDT Custody Safe backs merchant
  product/freight receivables, seckill prize, node-reward and reward-reserve
  liabilities. The NPL Reward Safe backs NPL reward liabilities. The Operations
  Treasury Safe funds explicitly posted platform advances and operational
  obligations; it never substitutes for a shortfall in any payment Safe.
- The Router never manages logistics, arbitration, BNM, merchant balances,
  settlement requests or arbitrary withdrawals. A normal successful call
  leaves zero USDT and zero NPL in the Router.
- Every transfer to both USDT Safes, the NPL Burn address and Reward Safe is
  balance-delta checked. Fee-on-transfer behavior, missing
  allowance, stale quote, replay, mismatched snapshot or partial transfer
  reverts the entire payment and does not consume inventory.

## NPL Reward Allocation

- The NPL Reward Safe receives exactly 10% of the order's total USDT list price
  converted by the signed Oracle snapshot.
- The payment snapshot allocates that 10% as: genesis-node pool 2%, direct-shop referral 1%,
  district 1.2%, city 0.8%, province 0.6%, region 0.4% and operations 4%.
- Genesis-node rewards use no NFT, ERC-721, ERC-1155, contract or token-ID
  qualification. The 2% first credits a dedicated NPL Reward-Safe-backed ledger
  pool, then the published node wallet list and weights govern Safe settlement.
- The operations 4% is split equally across four configured operations wallets.
- Missing beneficiaries, integer rounding remainders and unallocated amounts
  are credited to the NPL Reward-Safe-backed circulation ledger pool. Allocation entries balance
  exactly to the amount transferred to the Reward Safe.
- The published node list, referral relationships, all four administrative
  codes and beneficiaries are snapshotted at payment. Self-referral and referral
  cycles are forbidden. Ordinary customers do not see a genesis credential or
  NFT module.

## Merchant Concession And Receivable

- The settlement wallet submitted with a merchant application becomes
  permanently immutable when that application is approved. No merchant,
  platform role, secondary signer or Safe approval can change it. An incorrect
  address must be handled before approval by rejecting the application and
  creating a new application; V2 has no wallet migration or recovery path.
- Merchant concession does not reduce buyer payment and never changes the
  70/30 buyer legs.
- Merchant base receivable is the exact buyer product-USDT leg remaining after
  the 1%-of-list service fee (nominally 69% of list). The merchant may enter a
  0-100% concession and
  `concessionAmount = floor(merchantBaseReceivable * merchantConcessionBps / 10,000)`.
- Merchant net receivable equals that post-fee base minus concession. The
  concession credits fixed USDT Custody-backed ledger pools: platform 0%,
  seckill prize 45%, node rewards 45% and reward reserve 10%. The reward reserve
  remains Locked until a future published reward policy and Safe approval; it
  has no separate Safe. The merchant receives no extra seckill revenue.
- Delivery freight becomes a separate `MERCHANT_FREIGHT_RECEIVABLE` backed by
  the USDT Custody Safe. It follows the order's fulfillment lifecycle and is
  settled with product proceeds through the existing `MERCHANT_USDT` rail;
  it is never concessioned or included in product revenue formulas.
- Product maintenance shows the signed Core preview of base receivable,
  concession, net receivable and each configured destination before submit.
- V1-V5 merchant levels, per-level price ceilings and per-level monthly seckill
  quotas are retired. Historical database/API fields are compatibility-deprecated
  only; no new quote, catalog, seckill or UI behavior may depend on them.

## Append-Only Double-Entry Ledger

- PostgreSQL is the authoritative off-chain ledger for custody liabilities,
  merchant receivables, NPL rewards, prize liabilities, guarantees, debts and
  settlement batches. Balances are derived from append-only balanced entries;
  no endpoint directly edits a balance.
- Every posting is asset-specific, idempotent and balanced. Corrections use a
  linked reversal plus replacement entry. A posting may never create a
  negative available balance or spend a liability twice.
- Payable asset states are `Locked -> Available -> Requested -> Batched ->
  Settled`. Arbitration adds `Disputed` and keeps funds and rewards Locked.
  State transitions retain order, policy, beneficiary and journal evidence.
- BNM is the existing backend points project, valued 1:1 against the product
  USDT list price. Payment records Locked BNM; fulfillment finality makes it
  Available. V2 deploys no BNM ERC-20, performs no BNM mint and exposes no
  on-chain BNM Claim. BNM is not a Safe-transfer liability. Every backend state
  command carries an order-scoped monotonic version; the BNM backend must
  atomically ignore lower versions and acknowledge the effective version/state.
  Missing proof of that behavior is `ExternalBlocked`.

## Signed Settlement And Safe MultiSend

- Former token/proceeds Claim actions become gasless signed settlement
  requests. Customers, merchants and external beneficiaries never broadcast
  settlement transactions or pay settlement Gas.
- A request is wallet-bound, asset-bound, amount-bound, nonce-protected,
  expiring and idempotent. An external partner link is address-bound, one-use
  and time-limited and cannot bypass eligibility, availability or Safe review.
- Core groups Available requests into a Safe MultiSend batch. Each batch binds
  `batchId`, chain ID, Safe address and nonce, every order, asset, recipient and
  integer amount, per-asset totals and a canonical content hash.
- A batch is immutable after approval. MultiSend succeeds in full or reverts in
  full. Replacement transactions remain linked to the same batch and Safe
  nonce; duplicate events cannot settle twice.
- A payable becomes Settled only after a status-1 Safe receipt reaches 15 BSC
  confirmations and the indexer verifies chain, Safe, nonce, transaction data,
  batch hash, events, balances, replacement and canonical block. Reorgs return
  affected entries to the last proven state without deleting evidence.
- Mall and Merchant surfaces show `Locked`, `Available`, `Requested`, `Batched`
  and `Settled` plus the final Safe TxHash for transferable assets. BNM shows
  only its backend-points lifecycle and is never presented as a token payout.

## Inventory, Fulfillment And No Business Refunds

- Inventory reservation is atomic, SKU-specific, expiring and bound to the
  signed quote. Payment either consumes the reservation and creates the order
  or leaves both assets and inventory unchanged.
- V2 has no no-reason refund, merchant-timeout refund, forced platform refund,
  refund button, refund API, refund reserve or business-refund method.
- Customers may request exchange or delay and may enter platform arbitration.
  Arbitration keeps payment, BNM and all rewards Locked.
- Seven days after payment finality without valid shipment evidence opens
  platform takeover fulfillment and freezes merchant listing and new-order
  permissions plus merchant settlement requests. Buyer-side prize eligibility
  remains independent. The platform or a replacement merchant completes
  delivery.
- Starting at logistics-confirmed delivery, the customer has seven days to
  confirm receipt. The merchant may then request platform forced receipt but
  cannot finalize the order. Pickup verification and final arbitration use the
  same finality path.
- Major-loss funding consumes the merchant guarantee, frozen receivables and
  future merchant proceeds in that order. Platform advances become merchant
  debt. Merchant guarantee minimum is exactly 1,000 USDT; below it, new product
  listing and new orders are prohibited.
- Successful receipt, pickup verification or final arbitration unlocks
  ordinary receivables, BNM and rewards. The seckill grand prize remains Locked
  until final session settlement.

## Seckill And Boundary Orders

- A seckill main session lasts exactly 60 minutes. Relay time starts at 60
  seconds; each chain-final purchase adds 30 seconds; remaining relay time is
  capped at 60 seconds and never exceeds the main deadline.
- Session phases are PREHEAT, LIVE, SETTLING and SETTLED. Grand-prize settlement
  occurs during the 5-10 minute SETTLING phase and becomes payable only after
  final session settlement.
- A seckill intent binds both seckill and ordinary fallback quotes. Before
  payment, the customer acknowledges both prices and the classification rule.
- Chain block time is authoritative. Inclusion before the deadline is seckill;
  inclusion after it atomically uses the fallback price and ordinary inventory
  and does not enter or win the prize pool. Failure of either required fallback
  condition reverts the whole payment.
- Each session has at most one winner: the last valid order that reaches
  canonical chain finality by the session cutoff. The winner receives the whole
  payable USDT pool for that session. Human review may reject cheating or an
  invalid order but cannot replace the winner; approval enters the ordinary
  Safe-batch payment lifecycle.
- An empty session creates no new prize contribution. Existing rollover and
  governed Operations-Treasury injection remain Locked and roll into the next
  session instead of being cleared or returned. Force-close applies the same
  winner-or-rollover rule.

## Oracle

- Core uses the specified PancakeSwap V2 pair to calculate a 30-minute
  NPL/USDT TWAP. Maximum deviation is 5%, the observation may be at most 10
  minutes old and USDT-side liquidity must be at least 50,000 USDT.
- Expired quotes, stale observations, excessive deviation or insufficient
  liquidity pause new payments while fulfillment, takeover, arbitration,
  reconciliation, audit and finality synchronization remain available.

## Governance, Risk And Retention

- The first successful SIWE session carrying the BUYER role atomically creates
  one globally unique numeric UID bound permanently to that wallet. UID is
  off-chain, display/search only and never participates in payment, settlement,
  signatures or asset ownership.
- Policy publication and every high-risk change require RBAC, an exact
  secondary-wallet EIP-712 signature and Safe multisig approval. A new
  `policyVersion` affects only future quotes, orders and sessions.
- Merchant settlement-wallet immutability has no governance exception and is
  not a high-risk action that Safe approval can override.
- High-Gas anomalies restrict the address for 24 hours. More than five wallets
  on the same IP or device within one minute blacklists that IP/device. Three
  cancellations within five minutes restrict new payment for two hours. Ten
  address changes or ten pickup-store changes by the same buyer within 20
  minutes create reminder and audit evidence only; they never debit funds,
  blacklist, close the account or restrict payment. Low stock below 100 and an
  abnormal-order ratio above 30% are also reminder-only. Evidence, expiry,
  appeal and overrides for independent restrictive rules remain audited.
- Category or tag deletion/disable is denied while it contains a seckill
  product or an order with Locked funds. Products with history are logically
  delisted only. Funds, policies, batches, chain evidence and audit records are
  never deleted.
- Authorization never uses `tx.origin`; it uses EIP-712, nonce, deadline,
  ERC-1271, RBAC, secondary signatures and Safe authority as appropriate.

## Privacy And Retention

- Buyer name, phone and detailed address remain encrypted for 60 days after
  order completion. From day 30, Admin defaults to masked values; at day 60,
  plaintext is deleted.
- Order ID, UID, wallet, TxHash, product and amount snapshots, ledger entries,
  Safe batches, fulfillment/arbitration results, risk evidence and audit logs
  are retained permanently. Every authorized PII read, export and decrypt is
  RBAC-scoped and audited.

## Coverage And Circuit Breakers

- Core calculates coverage per asset from verified Safe assets divided by
  unsettled ledger liabilities. The UI label is `Safe assets / unsettled
  liabilities coverage`, never a leverage or liquidation coefficient.
- Below 100% coverage, Core pauses new payments and creation of new settlement
  batches. It does not rewrite balances or claim the system is healthy.
- New payments, seckill purchases and new settlement batches have independent
  breaker scopes. Fulfillment, takeover, exchange, arbitration, reconciliation,
  audit reads and finality synchronization cannot be paused by those breakers.
- Pause and resume require RBAC plus Safe authority, emit indexed/audited events
  and retain tests for blocked writes, allowed recovery and permission failure.

## Production And External Inputs

- The service fee, concession destinations, lack of extra merchant seckill
  revenue, genesis-node mechanism, prize winner/payout/rollover, merchant-level
  retirement and PII retention are confirmed, not `DecisionBlocked`.
- Primary and fallback BSC RPC both report chain 56. Five locally configured
  Safe addresses have runtime code and respond to the required Safe read
  interfaces. Their addresses are secret-safe operational data, while owners
  and thresholds remain user-managed; none are printed or copied here.
- `ExternalBlocked`: production TWAP pair/code/liquidity attestation,
  domains/HTTPS/WSS, production databases and queues, the existing BNM backend project's API/schema/credentials and monotonic-state conformance evidence,
  provider accounts and credentials, approved merchant/admin wallets, encrypted
  backup storage, printers and physical mobile-device evidence.
- Provider absence may return `ConfigurationRequired`, but adapters,
  validation, typed errors and the local business path must still exist.
- Current ignored `.env` wallets are limited to local, fork and separately
  approved micro-tests. No deployment or mainnet transaction is authorized
  until bytecode/configuration checks, complete local gates and an exact bounded
  transaction package receive separate user approval.

## Coordinated Core Publications

Core publishes shared artifacts only at the payment, fulfillment and
settlement/admin batch boundaries. Each publication contains the same version
of OpenAPI, Schema, ABI, deployment manifest, generated types, state/error
enums, WebSocket protocol and consumer tests. Products never copy, infer or
handwrite a parallel endpoint, schema, financial formula or calldata.
