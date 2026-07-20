# 24K商城 V2 System Contract

Status: frozen authority for the function-first V2 rewrite from
`v2/core@1cab34d`, including the 2026-07-18 replacement of every Safe/multisig
production path with five distinct EOA wallet roles. Decision details and
source conflicts are indexed in `V2_DECISIONS.md`.

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
  accounts, devices, domains, RPC endpoints or configured wallet addresses return
  `ExternalBlocked` or `ConfigurationRequired`. No production path may
  simulate success with a fixture, empty action or disabled placeholder.

## Network, Assets And Launch Payment

- BSC chain ID is `56`.
- USDT is `0x55d398326f99059fF775485246999027B3197955`.
- NPL is `0x4e8277ab31e4956b2cd48449793a57656dfc03d2`.
- The NPL/USDT pricing pair is the verified PancakeSwap V2 pair
  `0x2955e33bb120714abf11ace2766e614e6e5955b2`.
- NPL applies a 5% tax when buying from or selling into its DEX pair. This pair
  tax is not treated as an ordinary ERC-20 transfer tax. Fixed-block fork
  evidence showed the swap recipient receiving the tax-adjusted net amount,
  while buyer-to-Router `transferFrom` and Router-to-Burn/Reward transfers
  arrived exactly. A later bounded BSC payment and live-seckill micro-test
  confirmed the same exact ordinary-transfer deltas on mainnet. Payment intents
  therefore bind the buyer's exact post-swap NPL balance; any future
  ordinary-transfer balance-delta mismatch still reverts and stops the payment
  instead of weakening Router conservation.
- Product list price, merchant base receivable, merchant concession and wallet
  liabilities are denominated in USDT.
- The launch policy requires the buyer to pay exactly 70% of the USDT list
  price in USDT and 30% of the same price as Core-quoted equivalent NPL. Without an
  explicitly funded NPL subsidy, no later policy may set the buyer NPL leg
  below 30%.
- The product USDT leg is split atomically inside the payment transaction.
  `platformServiceFeeUsdt = floor(listPriceUsdt * 100 / 10,000)` goes directly
  to the dedicated Platform Service Fee Wallet. The remainder of the exact buyer
  USDT leg, `buyerProductUsdt - platformServiceFeeUsdt` (nominally 69% of list),
  goes to the USDT Custody/Settlement Wallet. The fee is global and never category-specific.
- Delivery adds the product snapshot's flat `defaultFreightUsdt` once per order
  as pure USDT; pickup freight is zero. This freight is outside the product
  70/30 base, goes only to the USDT Custody/Settlement Wallet and never changes the service
  fee, NPL payment, Burn, reward, BNM, merchant concession or seckill-prize
  calculations. The signed intent binds the buyer product USDT, service-fee
  USDT, Custody product USDT, freight USDT, total USDT and NPL amounts
  separately.
- Quotes use integer token units and canonical decimal strings. They bind
  `policyVersion`, the exact Core-computed NPL amount, reservation, product/SKU/quantity,
  fulfillment mode, beneficiary snapshot, nonce, deadline and exact Router
  payment intent. Quote validity is five minutes.
- First approval for an insufficient allowance defaults to `MaxUint256`. The
  customer must see token, Router spender, amount, risk and revocation route.
  Sufficient allowance is not repeated; revoked or insufficient allowance is
  requested again.

## PaymentRouter And Custody

- `PaymentRouter` is immutable and non-upgradeable. It accepts only signed
  EIP-712 quotes, enforces nonce/deadline/replay protection, atomically transfers
  both payment assets, classifies seckill boundary orders, emits indexed payment
  events and exposes the new-payment breaker. Launch buyer admission and quote
  issuance support ordinary EOA wallets only; the deployed Router is not changed.
- For a successful launch payment, the Router transfers the exact 1%-of-list
  USDT service fee directly to the Platform Service Fee Wallet, transfers the
  remainder of the buyer's product-USDT leg plus delivery freight directly to
  the USDT Custody/Settlement Wallet, transfers NPL equal to 20% of the total USDT list price directly to
  `0x000000000000000000000000000000000000dEaD`, and transfers NPL equal to 10%
  of the same list price directly to the NPL Reward/Distribution Wallet.
- The Platform Service Fee Wallet receives only the direct 1% fee and is not a
  Custody-backed merchant or reward ledger. The USDT Custody/Settlement Wallet
  backs merchant product/freight receivables, seckill prize, node-reward and
  reward-reserve liabilities. The NPL Reward/Distribution Wallet backs NPL
  reward liabilities. The Operations/Guarantee Wallet receives merchant
  guarantees and funds explicitly posted platform advances and operational
  obligations; it never substitutes for a shortfall in another funding wallet.
- The Router never manages logistics, arbitration, BNM, merchant balances,
  settlement requests or arbitrary withdrawals. A normal successful call
  leaves zero USDT and zero NPL in the Router.
- Every transfer to both USDT wallets, the NPL Burn address and NPL Reward Wallet is
  balance-delta checked. Fee-on-transfer behavior, missing
  allowance, stale quote, replay, mismatched snapshot or partial transfer
  reverts the entire payment and does not consume inventory.

## NPL Reward Allocation

- The NPL Reward/Distribution Wallet receives exactly 10% of the order's total USDT list price
  converted by the signed Core quote snapshot.
- The payment snapshot allocates that 10% as: genesis-node pool 2%, direct-shop referral 1%,
  district 1.2%, city 0.8%, province 0.6%, region 0.4% and operations 4%.
- Genesis-node rewards use no NFT, ERC-721, ERC-1155, contract or token-ID
  qualification. The 2% first credits a dedicated NPL Reward-Wallet-backed
  ledger pool, then the published node wallet list and weights govern EOA settlement.
- The operations 4% is split equally across four configured operations wallets.
- Missing beneficiaries, integer rounding remainders and unallocated amounts
  are credited to the NPL Reward-Wallet-backed circulation ledger pool.
  Allocation entries balance exactly to the amount transferred to that wallet.
- The published node list, referral relationships, all four administrative
  codes and beneficiaries are snapshotted at payment. Self-referral and referral
  cycles are forbidden. Ordinary customers do not see a genesis credential or
  NFT module.

## Merchant Concession And Receivable

- The settlement wallet submitted with a merchant application becomes
  permanently immutable when that application is approved. No merchant,
  platform role, secondary signer or governance-wallet execution can change it. An incorrect
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
  remains Locked until a future published reward policy and governed EOA
  execution; it has no separate wallet. The merchant receives no extra seckill revenue.
- Delivery freight becomes a separate `MERCHANT_FREIGHT_RECEIVABLE` backed by
  the USDT Custody/Settlement Wallet. It follows the order's fulfillment lifecycle and is
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
- Payable asset states are `Locked -> Available -> Requested -> Submitted ->
  Settled`. Arbitration adds `Disputed` and keeps funds and rewards Locked.
  State transitions retain order, policy, beneficiary and journal evidence.
- BNM is the existing backend points project, valued 1:1 against the product
  USDT list price. Payment records Locked BNM; fulfillment finality makes it
  Available. V2 deploys no BNM ERC-20, performs no BNM mint and exposes no
  on-chain BNM Claim. A buyer must already have registered the same wallet in
  the existing BNM system. Core verifies that registration before issuing an
  ordinary or seckill quote; an unregistered wallet receives `Forbidden` before
  inventory reservation or signing. V2 never auto-creates or duplicates a BNM
  account. BNM is not an EOA-transfer liability. Every backend state command
  carries an order-scoped monotonic version; the BNM backend must atomically
  ignore lower versions and acknowledge the effective version/state. Missing
  proof of that behavior is `ExternalBlocked`.

## Signed Settlement And EOA Transfers

- Former token/proceeds Claim actions become gasless signed settlement
  requests. Customers, merchants and external beneficiaries never broadcast
  settlement transactions or pay settlement Gas.
- A request is wallet-bound, asset-bound, amount-bound, nonce-protected,
  expiring and idempotent. An external partner link is address-bound, one-use
  and time-limited and cannot bypass eligibility or availability.
- Core converts each Available request item into one immutable ERC-20 transfer
  intent for the asset's configured EOA executor. Each intent binds its request,
  order, policy snapshot, chain, executor wallet, token, recipient, exact integer
  amount, calldata hash, gas cap and idempotency identity. A settlement run may
  group evidence for operations, but it does not create atomic batch semantics.
- The corresponding EOA executor signs and broadcasts exactly one ERC-20
  `transfer` per intent. V2 deploys no MultiSend or generic batch-transfer
  contract. A submitted transfer is immutable; replacements retain the same
  intent identity and cannot settle a liability twice.
- A payable becomes Settled only after its status-1 transfer receipt reaches 15
  BSC confirmations and the indexer verifies chain, executor, nonce, token,
  recipient, amount, calldata, event, balance deltas, replacement and canonical
  block. Reorgs return affected entries to the last proven state without
  deleting evidence.
- Mall and Merchant surfaces show `Locked`, `Available`, `Requested`,
  `Submitted` and `Settled` plus the final execution TxHash for transferable assets. BNM shows
  only its backend-points lifecycle and is never presented as a token payout.

## Inventory, Fulfillment And No Business Refunds

- Inventory reservation is atomic, SKU-specific, expiring and bound to the
  signed quote. Payment either consumes the reservation and creates the order
  or leaves both assets and inventory unchanged.
- V2 has no no-reason refund, merchant-timeout refund, forced platform refund,
  refund button, refund API, refund reserve or business-refund method.
- Launch delivery fulfillment is manual and provider-independent. An authorized
  merchant records one supported carrier, the raw tracking number and optional
  shipment note/evidence. Core hashes and encrypts the raw tracking data,
  preserves immutable evidence for arbitration and exposes the usable shipment
  details only to currently authorized order participants and platform roles.
  Buyer confirmation, platform forced receipt and takeover remain Core
  `allowedActions`; no UI writes a final state directly.
- Kuaidi100/Cainiao, electronic waybills, printers, automatic logistics
  tracking, GPS sorting and AMap/Baidu navigation are Phase 2. Missing provider,
  device or map configuration never blocks ordering, payment, manual shipment,
  receipt confirmation, takeover, arbitration or launch acceptance. Delivery
  addresses and merchant store creation accept audited manual
  province/city/district/six-digit region input; store coordinates remain
  required and immutable. Map-assisted parsing is optional and cannot be the
  only save path.
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
  ordinary EOA-transfer settlement lifecycle.
- An empty session creates no new prize contribution. Existing rollover and
  governed Operations-Treasury injection remain Locked and roll into the next
  session instead of being cleared or returned. Force-close applies the same
  winner-or-rollover rule.

## Backend NPL Quote

- Launch deploys no `ITwapSourceV2` or `TwapOracleAdapterV2`, and the
  `PaymentRouter` never reads an external TWAP or price contract. Core reads the
  fixed PancakeSwap V2 pair through the configured primary/fallback BSC RPC,
  verifies the pair identity and at least 50,000 USDT-side liquidity, computes
  the exact integer NPL equivalent and signs the complete payment intent.
- Quote validity is exactly five minutes and the buyer nonce, order and
  reservation are one-use. The quote and buyer signatures bind the exact USDT
  and NPL amounts, order, product/SKU/quantity, inventory reservation,
  payer/payee, fulfillment target, `policyVersion`, deadline and nonce.
- Quote-source failure, inconsistent or unavailable pair data, insufficient
  liquidity, expiry or an invalid signature stops only new orders. Existing
  fulfillment, takeover, exchange, arbitration, reconciliation, audit and
  finality synchronization remain available. No third-party TWAP order system
  is introduced.

## Governance, Risk And Retention

- The first successful SIWE session carrying the BUYER role atomically creates
  one globally unique numeric UID bound permanently to that wallet. UID is
  off-chain, display/search only and never participates in payment, settlement,
  signatures or asset ownership.
- Policy publication and every high-risk change require RBAC, an exact
  secondary-wallet EIP-712 signature and direct execution by the configured
  Platform Governance EOA. Launch config maps governance, deployment, quote,
  secondary-signature and finality duties to `PLATFORM_TECH_PRIVATE_KEY`; no
  Safe owner, threshold, proposer or module participates. A new `policyVersion`
  affects only future quotes, orders and sessions.
- Merchant settlement-wallet immutability has no governance exception and is
  not a high-risk action that governance execution can override.
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
  delisted only. Funds, policies, transfer intents, chain evidence and audit records are
  never deleted.
- Authorization never uses `tx.origin`; it uses EOA signatures, EIP-712, nonce,
  deadline, RBAC, secondary signatures and the configured EOA authority as
  appropriate.

## Privacy And Retention

- Buyer name, phone and detailed address remain encrypted long term. Launch has
  no automatic day-based masking or deletion job. Role-scoped redacted
  projections remain separate from retention.
- Order ID, UID, wallet, TxHash, product and amount snapshots, ledger entries,
  EOA transfer intents/executions, fulfillment/arbitration results, risk evidence and audit logs
  are retained permanently. Before every full PII read, export or decrypt, Core
  revalidates the current resource/role scope and atomically records audit
  evidence; audit failure denies the plaintext response.

## Coverage And Circuit Breakers

- Core calculates coverage per asset from verified funding-wallet assets divided by
  unsettled ledger liabilities. The UI label is `Wallet assets / unsettled
  liabilities coverage`, never a leverage or liquidation coefficient.
- Below 100% coverage, Core pauses new payments and creation of new settlement
  transfer intents. It does not rewrite balances or claim the system is healthy.
- New payments, seckill purchases and new settlement-transfer creation have independent
  breaker scopes. Fulfillment, takeover, exchange, arbitration, reconciliation,
  audit reads and finality synchronization cannot be paused by those breakers.
- Pause and resume require RBAC plus the Platform Governance EOA, emit indexed/audited events
  and retain tests for blocked writes, allowed recovery and permission failure.

## Production And External Inputs

- The service fee, concession destinations, lack of extra merchant seckill
  revenue, genesis-node mechanism, prize winner/payout/rollover, merchant-level
  retirement and PII retention are confirmed, not `DecisionBlocked`.
- Primary and fallback BSC RPC both report chain 56. The five production roles
  remain distinct EOAs. Governance, USDT Custody/Settlement, NPL
  Reward/Distribution and Operations/Guarantee are ignored local signing roles.
  The confirmed Platform Service Fee EOA is receive-only; V2 neither requires
  nor stores its private key. `WALLET_5_PRIVATE_KEY` remains an independent test
  counterparty/backup and is not a sixth production role. Private keys and
  complete addresses are never printed or committed.
- The prior three Safe-bound payment contracts were deployed on BSC from a bounded exact packet,
  source-verified on BscScan and bound to the coordinated manifest by deployment
  block and runtime code hash. They received no policy publication or user
  funds and are permanently `SUPERSEDED`; their evidence remains append-only.
  New EOA-bound contracts require a separate deployment manifest and may not
  reuse the old addresses or authorization evidence.
- Before Mall public launch, while production orders and active seckill sessions
  and all quotes and inventory reservations are zero, the EOA-bound PaymentRouter may be directly superseded from
  the same source, compiler settings and creation bytecode, with its constructor
  differing only in the newly confirmed Platform Service Fee EOA. Immutable
  references must prove runtime differences are confined to that address and
  the deterministic EIP-712 domain separator bound to the replacement contract
  address.
  Policy V2 is future-only and its machine diff from V1 permits only that
  off-chain Router-recipient binding plus required version/decision-evidence
  metadata. Every amount, rate, route, timing and beneficiary field remains
  canonically identical. The prior Router and Policy V1 remain historical
  evidence and are never rewritten.
- The existing BNM backend HTTPS endpoint, schema, ignored local credential and
  monotonic-state conformance evidence are configured and verified against the
  Core HTTP adapter. Production Core deployment must still inject that ignored
  configuration and monitor the worker; it must not copy credentials into a
  manifest or repository file.
- Production domains/HTTPS/WSS, production databases and queues, approved
  merchant/admin wallets and encrypted backup storage remain launch-time
  operational configuration. Logistics providers, printers, GPS and map
  navigation are Phase 2 operational inputs, not launch blockers.
- Provider absence returns `ConfigurationRequired` for the affected feature,
  but adapters, validation, typed errors and the local business path must still
  exist. It does not block unrelated local code completion or a separately
  approved chain micro-test.
- Current ignored `.env` wallets are limited to local, fork and bounded
  micro-tests until the EOA release gate passes. Every mainnet action retains
  an exact local transaction/receipt evidence record and all runtime assertions.
  The current Goal authorizes transactions whose maximum value plus Gas is at
  most `3 USDT` within the fixed project budget; nonce, target, amount, assertion
  or budget drift stops execution. No Safe proposal or owner signature exists.

## Coordinated Core Publications

Core publishes shared artifacts only at the payment, fulfillment and
settlement/admin batch boundaries. Each publication contains the same version
of OpenAPI, Schema, ABI, deployment manifest, generated types, state/error
enums, WebSocket protocol and consumer tests. Products never copy, infer or
handwrite a parallel endpoint, schema, financial formula or calldata.
