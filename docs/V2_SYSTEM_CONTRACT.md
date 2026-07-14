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
- For a successful launch payment, the Router transfers the 70% USDT buyer leg
  directly to the USDT Custody Safe, transfers NPL equal to 20% of the total
  USDT list price directly to
  `0x000000000000000000000000000000000000dEaD`, and transfers NPL equal to 10%
  of the same list price directly to the NPL Reward Safe.
- The USDT Custody Safe backs buyer-paid USDT liabilities and their authorized
  settlements. The NPL Reward Safe backs NPL reward liabilities. The Operations
  Treasury Safe funds explicitly posted platform advances and operational
  obligations; it never substitutes for a shortfall in either custody Safe.
- The Router never manages logistics, arbitration, BNM, merchant balances,
  settlement requests or arbitrary withdrawals. A normal successful call
  leaves zero USDT and zero NPL in the Router.
- Every transfer is balance-delta checked. Fee-on-transfer behavior, missing
  allowance, stale quote, replay, mismatched snapshot or partial transfer
  reverts the entire payment and does not consume inventory.

## NPL Reward Allocation

- The NPL Reward Safe receives exactly 10% of the order's total USDT list price
  converted by the signed Oracle snapshot.
- The payment snapshot allocates that 10% as: genesis 2%, direct referral 1%,
  district 1.2%, city 0.8%, province 0.6%, region 0.4% and operations 4%.
- Missing beneficiaries, integer rounding remainders and unallocated amounts
  are credited to the circulation reward pool. Allocation entries balance
  exactly to the amount transferred to the Reward Safe.
- Genesis eligibility supports the configured ERC-721 or ERC-1155 credential.
  Credential ownership, referral relationships, all four administrative codes
  and beneficiaries are snapshotted at payment. Later credential transfer does
  not alter an order. Self-referral and referral cycles are forbidden.
- Ordinary customers do not see the genesis module.

## Merchant Concession And Receivable

- Merchant concession does not reduce buyer payment and never changes the
  70/30 buyer legs.
- `concessionAmount = merchantBaseReceivable * merchantConcessionBps / 10,000`,
  using exact integer rules published by Core. The merchant may enter 0-100%.
- Merchant net receivable equals base receivable minus concession. The
  concession is credited in the USDT ledger to versioned platform, prize-pool,
  node or other configured accounts. No frontend invents allocation weights.
- Product maintenance shows the signed Core preview of base receivable,
  concession, net receivable and each configured destination before submit.

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
  on-chain BNM Claim. BNM is not a Safe-transfer liability.

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

## Oracle

- Core uses the specified PancakeSwap V2 pair to calculate a 30-minute
  NPL/USDT TWAP. Maximum deviation is 5%, the observation may be at most 10
  minutes old and USDT-side liquidity must be at least 50,000 USDT.
- Expired quotes, stale observations, excessive deviation or insufficient
  liquidity pause new payments while fulfillment, takeover, arbitration,
  reconciliation, audit and finality synchronization remain available.

## Governance, Risk And Retention

- Policy publication and every high-risk change require RBAC, an exact
  secondary-wallet EIP-712 signature and Safe multisig approval. A new
  `policyVersion` affects only future quotes, orders and sessions.
- High-Gas anomalies restrict the address for 24 hours. More than five wallets
  on the same IP or device within one minute blacklists that IP/device. Three
  cancellations within five minutes or frequent address/store changes restrict
  new payment for two hours. Evidence, expiry, appeal and overrides are audited.
- Category or tag deletion/disable is denied while it contains a seckill
  product or an order with Locked funds. Products with history are logically
  delisted only. Funds, policies, batches, chain evidence and audit records are
  never deleted.
- Authorization never uses `tx.origin`; it uses EIP-712, nonce, deadline,
  ERC-1271, RBAC, secondary signatures and Safe authority as appropriate.

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

- Still `DecisionBlocked`: platform service-fee proportion, seckill prize-pool
  proportion, merchant-store reward proportion, merchant-concession
  destination weights, fixed circulation/remainder accounts and any policy
  beneficiary not frozen above. No default may be inferred.
- `ExternalBlocked`: USDT Custody, NPL Reward and Operations Treasury Safe
  addresses and Owners, role wallets, production RPC/fallback RPC,
  domains/HTTPS/WSS, the existing BNM backend project's API/schema/credentials,
  provider accounts and credentials, approved merchant/admin wallets, encrypted
  backup storage, printers and physical mobile-device evidence.
- Provider absence may return `ConfigurationRequired`, but adapters,
  validation, typed errors and the local business path must still exist.
- Current ignored `.env` wallets are limited to local, fork and separately
  approved micro-tests. Production Safe availability requires a fresh
  production Router deployment; the test Router is never reused.

## Coordinated Core Publications

Core publishes shared artifacts only at the payment, fulfillment and
settlement/admin batch boundaries. Each publication contains the same version
of OpenAPI, Schema, ABI, deployment manifest, generated types, state/error
enums, WebSocket protocol and consumer tests. Products never copy, infer or
handwrite a parallel endpoint, schema, financial formula or calldata.
