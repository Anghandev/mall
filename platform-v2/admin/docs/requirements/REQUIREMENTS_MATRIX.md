# Platform Admin V2 Frozen Requirement Matrix

Authority: `../../../docs/requirements/PLATFORM_ADMIN_SPEC.txt`,
`../../../docs/requirements/SOURCE.md`, `../../../../docs/V2_SYSTEM_CONTRACT.md`
and `../../../../docs/V2_DECISIONS.md`.

This is a traceability index, not a second PRD. `Overridden` retains conflicting
source evidence and binds its replacement. Financial, chain and audit records
are never soft-deletable.

| Requirement ID | Source lines | Field/state/action coverage | Decision | Acceptance and evidence target | Status | Core gap |
|---|---:|---|---|---|---|---|
| ADM-SRC-001 | 1-3 | Platform-admin title and global-spec scope | - | Local source hash equals SOURCE record | Frozen | - |
| ADM-GLOBAL-001 | 4-8 | AND/OR search; exact order ID/product ID/TxHash; fuzzy/exact wallet; exact UID/phone; start/end and Today/Yesterday/7d/30d; PendingReview/Yellow/BreakerRed status | - | Shared list shell serializes filters server-side and preserves PII authorization | Frozen | GAP-ADM-003 |
| ADM-GLOBAL-002 | 9-11 | List batch engine; Export Excel/CSV; batch electronic-waybill/pickup printing | - | Resource capability and selected rows come from allowedActions; exports/prints are audited | Frozen | GAP-ADM-003, GAP-ADM-012 |
| ADM-GLOBAL-003 | 12 | Batch modify/list/delist/review approve-reject/soft delete | D-V2-017, D-V2-021 | Soft delete only for ordinary resources explicitly authorized; funds/chain/audit never delete | Overridden | GAP-ADM-003 |
| ADM-DASH-001 | 14-17 | Today orders, GMV USDT, ship rate, seckill sessions, new UID users and merchants | - | Authoritative timezone and canonical values; unavailable is not zero | Frozen | GAP-ADM-005 |
| ADM-DASH-002 | 18-19 | Pending merchant/product reviews, after-sale cases and low-stock products | D-V2-004 | After-sale excludes business refunds and includes exchange/delay/arbitration/takeover queues | Overridden | GAP-ADM-005 |
| ADM-DASH-003 | 20-21 | Today signed settlement requests and Safe-settled USDT; chain failures; abnormal orders; blacklist blocks; per-asset Safe-assets/unsettled-liabilities coverage and breaker state | D-V2-007, D-V2-016, D-V2-024 | Coverage uses verified Safe assets and append-only liabilities; below 100% pauses new payments and new settlement batches without reporting healthy | Overridden | GAP-ADM-005, GAP-ADM-011, GAP-ADM-017 |
| ADM-DASH-004 | 22-24 | RPC latency ms, Oracle deviation %, high-Gas blocks, bot orders, CPU, memory, Redis hit, MQ backlog and block height | D-V2-012 | Readiness never reports healthy without real probes | Frozen | GAP-ADM-005, GAP-ADM-018 |
| ADM-MER-001 | 26-31 | Pending/Approved/Rejected/Blacklist menus; shop, license image, legal name/ID, phone, settlement wallet; approved wallet immutability | D-V2-014, D-V2-015 | PII access is RBAC scoped; wallet changes use governed intent | Verified | - |
| ADM-MER-002 | 32-33 | V1-V5 levels; per-product max USDT settlement price; monthly seckill quota | - | Validation and version history are authoritative and audited | Verified | - |
| ADM-MER-003 | 34-36 | Ordinary/seckill cumulative orders, cumulative USDT flow, today sales; pending/transit/signed/pickup counts and 48H fast-ship rate | - | Drilldown reconciles dashboard totals | Verified | - |
| ADM-MER-004 | 37 | Source forced-refund count, USDT penalties and abnormal-order rate | D-V2-004, D-V2-005, D-V2-018, D-V2-020 | Replace with takeover cases, 1,000-USDT guarantee status, frozen-receivable/future-proceeds deductions, merchant debt and abnormal-order rate; no business-refund or risk-reserve metric | Overridden | GAP-ADM-006, GAP-ADM-010, GAP-ADM-017 |
| ADM-MER-005 | 38 | Historical NPL Burn and successfully Available BNM totals | D-V2-003, D-V2-008 | Totals reconcile indexed final events and order snapshots | Verified | - |
| ADM-MER-006 | 39 | Source Locked/PendingSettlement/Available/Claimed withdrawal view, TxHash and Gas | D-V2-007, D-V2-023 | USDT proceeds use Locked/Available/Requested/Batched/Settled, signed gasless requests and final Safe TxHash; merchant never broadcasts or pays settlement Gas | Overridden | GAP-ADM-006, GAP-ADM-017 |
| ADM-CAT-001 | 41-43 | Three-level category tree; name/icon/sort/enabled/service-fee fields | D-V2-014, D-V2-018 | Fee is DecisionBlocked until versioned; other edits audited | DecisionBlocked | GAP-ADM-007, GAP-ADM-008 |
| ADM-CAT-002 | 44 | Tag library, examples, batch tagging and frontend feed | - | Versioned tags and placement state; no production fixture | Frozen | GAP-ADM-003 (cross-resource batch only) |
| ADM-CAT-003 | 45 | Category/tag delete-disable lock while a seckill product or order with Locked funds exists | D-V2-017, D-V2-025 | Core and UI deny delete/disable with the exact blocking resource; historical products only delist, and funds/policies/batches/chain/audit evidence never delete | Overridden | - |
| ADM-CAT-004 | 46-50 | Create/proxy-list; title/subtitle/main images/video/rich detail/default freight; settlement merchant allowlist; multi-SKU attributes/stock/USDT cost | D-V2-002 | Exact amounts, signed uploads and merchant eligibility required | Frozen | - |
| ADM-CAT-005 | 51 | Platform inventory +/- and USDT cost edit | D-V2-014, D-V2-017 | Cannot mutate active order/session snapshot; new policy/version only | Overridden | - |
| ADM-CAT-006 | 52 | Historical product cannot physically delete; delist/hide only | D-V2-017 | Chain/order evidence remains queryable forever | Frozen | - |
| ADM-POL-001 | 54-57 | Product/session financial-policy panel; merchant base receivable, concession, net receivable and USDT settlement destinations | D-V2-002, D-V2-014, D-V2-022 | Signed Core preview validates exact base/concession/net values, configured destinations, future-only scope and governed publish | Overridden | GAP-ADM-008, GAP-ADM-017 |
| ADM-POL-002 | 58-59 | Source buyer payment weights and NPL Burn/Route control | D-V2-002, D-V2-003, D-V2-014 | Launch buyer payment is fixed 70% USDT plus 30% Oracle-equivalent NPL; Router sends 20%-of-list-price NPL to Burn and 10%-of-list-price NPL to Reward Safe; future changes require governed policyVersion and an NPL leg below 30% requires a funded subsidy | Overridden | GAP-ADM-008 |
| ADM-POL-003 | 60-61 | Platform fee, seckill pool, regional/referral proportions and merchant-concession destination weights | D-V2-009, D-V2-014, D-V2-018, D-V2-022 | Fixed Reward-Safe roles total 10%-of-list-price NPL; unresolved service/prize/store/concession-destination values remain DecisionBlocked and publish future-only | DecisionBlocked | GAP-ADM-008, GAP-ADM-017 |
| ADM-POL-004 | 62 | Multiple NPL reward and USDT concession beneficiary addresses and weights | D-V2-009, D-V2-010, D-V2-014, D-V2-022 | Complete asset-specific destinations, payment snapshots, no self/cycles, exact balance and Safe approval are required; missing NPL beneficiaries/remainders credit the circulation pool | Overridden | GAP-ADM-008, GAP-ADM-017 |
| ADM-POL-005 | 63 | Source address-bound partner/channel no-login Claim link | D-V2-007, D-V2-015, D-V2-023, D-V2-027 | Replace with wallet-bound, one-use, expiring signed settlement request; eligibility, Available balance and Safe batching cannot be bypassed | Overridden | GAP-ADM-008, GAP-ADM-017 |
| ADM-POL-006 | Final Goal | Merchant concession from 0-100%; base receivable, concession amount, net receivable and platform/prize/node/other configured-destination preview | D-V2-022, D-V2-023 | Core computes and signs exact integer preview; UI validates range and renders every balanced ledger destination without changing buyer 70/30 | Frozen | GAP-ADM-008, GAP-ADM-017 |
| ADM-SEK-001 | 65-67 | Create/publish session, assign product and lock activity inventory | D-V2-014, D-V2-017, D-V2-018, D-V2-020, D-V2-024 | Cannot publish without governed policy, signed quotes, atomic inventory, merchant guarantee at least 1,000 USDT and coverage at least 100% | Verified | - |
| ADM-SEK-002 | 68-69 | Main duration, relay initial and per-purchase recharge | D-V2-013, D-V2-014 | Fixed launch 60min/60sec/+30sec/cap60sec/main cap; future policy governance only | Verified | - |
| ADM-SEK-003 | 70-71 | Manual force-close and seckill-purchase breaker | D-V2-014, D-V2-016 | Exact session intent, secondary signature, Safe approval and indexed event; seckill purchase, new payment and new settlement-batch breakers remain independent | Verified | - |
| ADM-SEK-004 | 72 | Inject USDT into current prize pool from Operations Treasury Safe | D-V2-014, D-V2-023, D-V2-024 | Exact asset/amount/session/Safe intent, balanced ledger posting, Safe receipt and prize-liability reconciliation; injection cannot hide coverage below 100% | Verified | - |
| ADM-SEK-005 | 73-74 | Versioned rich-text rules shared by Mall and Merchant | D-V2-013, D-V2-014 | Published content binds same policyVersion and sanitization | Verified | - |
| ADM-RISK-001 | 76-78 | High-Gas/front-running monitor and automatic 24-hour address restriction | D-V2-026 | Explainable risk evidence, exact 24-hour expiry, appeal and authorized override are audited | Frozen | GAP-ADM-011 |
| ADM-RISK-002 | 79 | Source `tx.origin == msg.sender` contract-call ban | D-V2-015 | Never tx.origin; authorization supports ERC-1271; any EOA policy is separate and explicit | Overridden | GAP-ADM-011 |
| ADM-RISK-003 | 80-82 | Anonymous low-history wallet clustering detection/block | - | Risk signal cannot independently forge authorization/finality | Frozen | GAP-ADM-011 |
| ADM-RISK-004 | 83 | Same IP/device switches over 5 wallets in 1 minute then blacklist | D-V2-026 | Strict greater-than-five threshold, one-minute window, evidence, privacy retention, expiry and appeal are auditable | Frozen | GAP-ADM-011 |
| ADM-RISK-005 | 84 | 3 cancellations in 5 minutes or frequent pickup/address changes cause a 2-hour new-payment restriction | D-V2-004, D-V2-026 | Exact window, trigger evidence and expiry are tested; restriction never creates a business refund or blocks fulfillment/reconciliation | Frozen | GAP-ADM-011 |
| ADM-RISK-006 | 85 | Separate wallet/IP-range/device blacklists; manual/automatic lock | - | RBAC, expiry/reason/evidence and immutable audit required | Frozen | GAP-ADM-011 |
| ADM-LOG-001 | 87-90 | SF/JD/YTO/ZTO/STO/EMS enabled states and default carrier | - | Provider readiness and carrier versioning tested | Verified | - |
| ADM-LOG-002 | 91 | Cainiao/Kuaidi100 PartnerID secret reference, monthly waybill account and real tracking-number adapter | D-V2-019 | Adapter validates secret-reference completeness, callback/error handling and typed ConfigurationRequired without storing/rendering secrets; real account acceptance is ADM-GOAL-003 | Verified | - |
| ADM-LOG-003 | 92-93 | Platform/partner warehouse shipping-address library | - | RBAC writes and audit; exact address fields validated | Verified | - |
| ADM-LOG-004 | 94 | Source forced-refund return warehouse | D-V2-004 | No refund destination is emitted; exchange/takeover logistics use their own allowedActions | Overridden | - |
| ADM-LOG-005 | 95 | Per-count/per-weight freight; Dalian pickup free; remote no-delivery rule | D-V2-002, D-V2-022 | DecisionBlocked until freight charging, weight basis and the effects on buyer 70/30 payment, merchant receivable and concession are frozen; frontend must not calculate a substitute | DecisionBlocked | GAP-ADM-012 |
| ADM-TAKE-001 | 97-99 | Source forced-refund center and action | D-V2-004, D-V2-005 | Renamed Merchant Takeover Fulfillment Center; 7-day no-evidence case opens automatically | Overridden | GAP-ADM-010 |
| ADM-TAKE-002 | 100-101 | Source USDT return and Locked BNM burn | D-V2-004, D-V2-005 | Customer payment and rewards remain Locked; platform/replacement merchant fulfills order | Overridden | GAP-ADM-010 |
| ADM-TAKE-003 | 102 | Source merchant pending/guarantee deduction | D-V2-005, D-V2-018, D-V2-020, D-V2-023 | Major loss posts balanced deductions in order from guarantee, frozen receivables and future proceeds; platform advance records merchant debt; no risk-reserve fallback | Overridden | GAP-ADM-010, GAP-ADM-017 |
| ADM-TAKE-004 | 103 | Source unlock and delist | D-V2-005, D-V2-020 | Freeze new orders, listings and merchant settlement requests while preserving independent buyer prize eligibility; below 1,000-USDT guarantee blocks relisting/new orders | Overridden | GAP-ADM-010, GAP-ADM-017 |
| ADM-CMS-001 | 105-107 | Banner, recommended product schedule, splash, timed/frequency/location campaign popup | - | Versioned placement, preview, publish/rollback and audience evidence | Frozen | GAP-ADM-013 |
| ADM-CMS-002 | 108 | Seckill rules, FAQ, service agreement, privacy and About rich text | D-V2-013, D-V2-014 | Sanitized versioned content and approval audit | Frozen | GAP-ADM-013 |
| ADM-CMS-003 | 109 | Release announcements, forced/hot-update notices and contract-upgrade notices | - | Target/version/time and rollback evidence | Frozen | GAP-ADM-013 |
| ADM-NOTIFY-001 | 111-115 | User/region/merchant audiences; payment, shipment+tracking, pickup; transferable-asset settlement states; backend BNM Locked/Available; genesis/referral/region; announcements/maintenance/activity | D-V2-007, D-V2-008, D-V2-023 | Notifications derive from finalized domain/journal/Safe events; BNM never emits token-mint, Safe-transfer or on-chain-Claim copy | Overridden | GAP-ADM-014, GAP-ADM-017 |
| ADM-NOTIFY-002 | 116 | Aliyun/Tencent SMS, SMTP and Firebase/JPush gateway secret-reference adapters | D-V2-019 | Adapters validate configuration, typed ConfigurationRequired, delivery errors/retries and local outbox flow without real send; real-provider acceptance is ADM-GOAL-003 | Frozen | GAP-ADM-014 |
| ADM-SYS-001 | 118-120 | Versioned business config, freight and unpaid-reservation release timeout | D-V2-014 | Changes are typed, validated, audited and future-only | Frozen | GAP-ADM-015 |
| ADM-SYS-002 | 121 | Main/test RPC secret references, fallback routing and health adapter | D-V2-019 | Typed validation, chain-56 check, fallback/error handling and ConfigurationRequired work locally; real RPC health acceptance is ADM-GOAL-003 | Frozen | GAP-ADM-015 |
| ADM-SYS-003 | 122 | Fixed PancakeSwap V2 NPL/USDT pair and Oracle thresholds | D-V2-001, D-V2-012, D-V2-018 | Pair `0x2955e33bb120714abf11ace2766e614e6e5955b2`; 30-minute TWAP, 5% deviation, 5-minute quote, 10-minute max age and at least 50,000 USDT-side liquidity | Overridden | GAP-ADM-015 |
| ADM-SYS-004 | 123 | Seckill maximum Gas control | - | Quote/intent policy rejects above limit; admin cannot control miner inclusion | Frozen | GAP-ADM-015 |
| ADM-SYS-005 | 124-125 | Chain 56; USDT/NPL/pair/PaymentRouter manifest; USDT Custody, NPL Reward and Operations Treasury Safe readiness | D-V2-001, D-V2-003, D-V2-008, D-V2-014, D-V2-019, D-V2-023 | Typed manifest enforces fixed assets, immutable Router and three distinct Safe roles; BNM is backend-only with no V2 contract/Claim; missing production addresses return ExternalBlocked and are accepted under ADM-GOAL-003 | Frozen | GAP-ADM-015, GAP-ADM-017 |
| ADM-SYS-006 | 126 | OSS secret reference, CDN switch and AI support prompt adapters | D-V2-019 | Local validation, secret-safe references, typed ConfigurationRequired and failure handling are required; real-provider acceptance is ADM-GOAL-003 | Frozen | GAP-ADM-015 |
| ADM-AUD-001 | 128-129 | Separate append-only read-only audit database in reverse time | D-V2-017 | Hash-chain verification, retention and backup/restore tests; no delete path | Frozen | GAP-ADM-016 |
| ADM-AUD-002 | 130-133 | Admin operation, wallet login/IP/device, JSON-RPC request/response, database/Oracle/deadlock error stack logs | - | Typed filters, redaction and correlation IDs; no secret/PII leakage | Frozen | GAP-ADM-016 |
| ADM-AUD-003 | 134 | Claim/payment/shipment/source customer-service-refund logs with wallet signature | D-V2-004, D-V2-005 | Replace refund audit with takeover and emergency-recovery audit; every financial action keeps signature proof | Overridden | GAP-ADM-016 |
| ADM-CLEAR-001 | 136-138 | Admin signature/message plus PaymentRouter and Safe MultiSend method/Gas/status audit | D-V2-015, D-V2-017, D-V2-023 | Signature, exact calldata/content hash, receipt, event, Safe nonce and ledger evidence reconcile end to end | Overridden | GAP-ADM-017 |
| ADM-CLEAR-002 | 139 | Safe owner approvals for policy/address changes, guarantee deductions and immutable settlement batches | D-V2-014, D-V2-020, D-V2-023 | Safe proposal/execution binds exact old/new diff or batch content hash and records every required owner approval | Overridden | GAP-ADM-017 |
| ADM-CLEAR-003 | 140 | Config/proportion/concession change actor, old value and new value | D-V2-014, D-V2-022, D-V2-025 | policyVersion, governed approval and future-only effective boundary are included; immutable historical records remain queryable | Overridden | GAP-ADM-017 |
| ADM-CLEAR-004 | 141 | Signed-settlement reconciliation, Safe transfer versus ledger state, per-asset conservation and breaker snapshot | D-V2-003, D-V2-007, D-V2-016, D-V2-023, D-V2-024 | Router/Safe/ledger deltas balance per asset; new-payment, seckill-purchase and new-settlement-batch breakers have independent evidence | Overridden | GAP-ADM-017 |
| ADM-CLEAR-005 | Final Goal | PostgreSQL append-only double-entry journals for custody liabilities, receivables, rewards, guarantees, debt and settlement batches | D-V2-023 | Every asset-specific posting balances, is idempotent and non-negative; corrections append linked reversal/replacement entries and no API edits a balance directly | Frozen | GAP-ADM-017 |
| ADM-CLEAR-006 | Final Goal | Immutable Safe MultiSend batch with batchId, chain/Safe/nonce, orders, assets, recipients, integer amounts, per-asset totals and content hash | D-V2-007, D-V2-017, D-V2-023 | All-or-revert execution; status-1 receipt reaches 15 confirmations; duplicate/replacement/reorg handling is idempotent and final Safe TxHash remains visible | Frozen | GAP-ADM-017 |
| ADM-CLEAR-007 | Final Goal | Verified Safe-assets/unsettled-liabilities coverage per asset and below-100% breaker | D-V2-016, D-V2-024 | Below 100% blocks new payments and new settlement batches while seckill purchase remains independently controllable; fulfillment/takeover/arbitration/reconciliation/audit/finality remain available | Frozen | GAP-ADM-005, GAP-ADM-017 |
| ADM-OPS-001 | 143-144 | CPU curve, memory and disk waterline probe adapter | D-V2-019 | Local collector validates units, thresholds and unavailable/error states; real-host evidence is ADM-GOAL-003 | Frozen | GAP-ADM-018 |
| ADM-OPS-002 | 145 | Redis penetration/hit, MQ backlog and DB-pool active-count probes | D-V2-019 | Local probes, thresholds, timeout/error handling and typed unavailable states are tested; real infrastructure evidence is ADM-GOAL-003 | Frozen | GAP-ADM-018 |
| ADM-OPS-003 | 146 | TPS, QPS, buy/ship average ms and global error-rate probes | D-V2-019 | Window definitions, aggregation, drilldown and unavailable/error states work locally; real-host evidence is ADM-GOAL-003 | Frozen | GAP-ADM-018 |
| ADM-OPS-004 | 147 | RPC versus independent explorer height; red alert over 3 blocks | D-V2-019 | Comparison adapter and alert/recovery logic are locally tested; real RPC/explorer evidence is ADM-GOAL-003 | Frozen | GAP-ADM-018 |
| ADM-GOAL-001 | Final Goal | Desktop operations UI, responsive/mobile fallback, keyboard/focus/labels, complete loading/empty/error/disabled states | - | Type, consumer, accessibility and Playwright tests pass | Frozen | GAP-ADM-001 |
| ADM-GOAL-002 | Final Goal | RBAC, secondary wallet signature, Safe publish, exact allowedActions and no production fixture | D-V2-014, D-V2-021 | Permission negative tests and production-bundle scan pass | Frozen | GAP-ADM-001, GAP-ADM-002, GAP-ADM-004 |
| ADM-GOAL-003 | Final Goal | Real Kuaidi100/Cainiao, SMS/SMTP/Push, OSS/CDN, RPC/explorer, three production Safes/Owners/roles, authorized admin wallets, hosts, middleware, HTTPS/WSS and device evidence | D-V2-019 | Real provider/RPC/Safe/host/device acceptance only after every local adapter, validator, typed ConfigurationRequired path and business flow passes; no fixture may satisfy this row | ExternalBlocked | GAP-ADM-002, GAP-ADM-012, GAP-ADM-014, GAP-ADM-015, GAP-ADM-018 |

## Completion Rule

No row is `Verified` until its functional code and automated or real external
evidence exist against the same Core batch artifact version consumed by Mall
and Merchant. A disabled control, empty API/action catalog, static record,
fixture-only path or fail-closed placeholder is temporary safety behavior, not
completion evidence. External inputs cannot be replaced by fixture success.

## Fulfillment Checkpoint Consumer Evidence

This earlier evidence was recorded against
`@abu24k/core-artifacts@2.0.0-fulfillment.1`; the current pin is the coordinated
settlement/admin checkpoint below.

- `ADM-SYS-005`: consumes the coordinated manifest plus live bootstrap chain,
  fixed-asset and payment-readiness values; missing deployment/Safe evidence is
  shown as `ExternalBlocked` and never inferred.
- `ADM-CAT-004`: active product, SKU, authoritative price and available-stock
  reads are integrated. Admin creation, merchant binding, media and inventory
  writes remain `GAP-ADM-007`, so the full row is not complete.
- `ADM-CLEAR-001` and `ADM-CLEAR-004`: the wallet-bound payment projection now
  renders submission, reservation, Router call and indexed finality. Admin-wide
  RBAC audit, Gas, Safe and ledger evidence remain `GAP-ADM-017`, so these rows
  are not complete.
- `ADM-TAKE-001` and `ADM-TAKE-002`: ADMIN/OPERATOR sessions consume the
  authoritative fulfillment-order list, shipment/logistics/balance evidence,
  order-level `allowedActions` and idempotent shipment, delivery, after-sale,
  arbitration, forced-receipt and takeover commands. Static action metadata
  never authorizes a button. Merchant guarantee funding, receivable deductions,
  future-proceeds debt and replacement-merchant case projections remain
  `GAP-ADM-010` / `GAP-ADM-017`, so the full rows are not complete.

All test records stay under `tests/**`; no production fixture is shipped.

## Settlement/Admin Checkpoint Evidence

The earlier product checkpoint consumed coordinated artifact
`2.0.0-settlement-admin.2` without a
parallel API or local financial calculation:

- `ADM-MER-004`, `ADM-TAKE-003` and `ADM-TAKE-004`: merchant guarantee,
  ordered takeover funding, platform advance and debt projections are rendered
  from Core; the governed funding action signs Core-issued EIP-712 typed data.
- `ADM-POL-001` through `ADM-POL-006`, `ADM-CLEAR-002` and `ADM-CLEAR-003`:
  policy draft validation, secondary signature and Safe proposal states are
  consumed. Requirements that depend on unresolved commercial values remain
  `DecisionBlocked`, not complete by placeholder.
- `ADM-CMS-001` through `ADM-CMS-003`: version create/read, evidence-bound
  publish and rollback are connected to Core.
- `ADM-SYS-001` through `ADM-SYS-006`: typed version list/create/publish is
  connected; production addresses, RPC and provider accounts remain
  `ExternalBlocked` under `ADM-GOAL-003`.
- `ADM-AUD-001` through `ADM-AUD-003`: filters, cursor result and per-stream
  hash-chain proof are consumed from the read-only audit API; no delete path is
  rendered.
- `ADM-OPS-001` through `ADM-OPS-004`, `ADM-DASH-003`, `ADM-DASH-004` and
  `ADM-CLEAR-007`: typed unavailable states, alerts, acknowledgement and
  per-asset Safe coverage are consumed without turning missing probes into
  zero or healthy states.
- `ADM-MER-006`, `ADM-CLEAR-004` and `ADM-CLEAR-006`: the wallet-scoped
  settlement projection renders balance states, NPL reward subtype, backend
  BNM Locked/Available points, immutable request states and the final Safe
  TxHash. BNM is never presented as transferable or Safe-settled. Admin-wide
  settlement search remains a Core gap.
- `ADM-SEK-001` through `ADM-SEK-004`: the current/history/session projections,
  canonical timers, inventory, prize liability, numeric-cursor HTTP replay and
  artifact-bound finalized relay WebSocket are rendered. `.9` additionally
  consumes action list/detail, role-scoped session draft and inventory lock,
  force-close, prize injection and seckill-purchase breaker recovery. Each
  action follows Core `allowedActions` through independent secondary-wallet
  EIP-712 signing, Safe proposal and 15-confirmation finality; `REORGED` and
  `FAILED` never render as effective.
- `ADM-SEK-005`: the session draft binds the published CMS rules content hash
  and policy version. The UI never edits the fixed 3600s / 60s / +30s / cap
  60s timers and does not construct calldata or calculate prize allocations.
- `ADM-MER-005`: that earlier checkpoint exposed wallet-scoped BNM points; the
  `.15` evidence below supersedes its missing merchant-wide Burn and
  Available-BNM aggregates.

All test records stay under `tests/**`; no production fixture is shipped.

## Catalog Checkpoint Evidence

The current product consumes coordinated artifact
`@abu24k/core-artifacts@2.0.0-settlement-admin.5` for the Catalog workflow:

- `ADM-CAT-001` and `ADM-CAT-002`: ADMIN/OPERATOR/AUDITOR consume the
  versioned three-level category tree and tag library. ADMIN/OPERATOR can
  create and update name, parent, icon, sort and status. `.5` distinguishes an
  omitted parent on create from explicit `parentCategoryId: null` on update,
  so an existing child can move back to the root. The unresolved service fee
  remains visibly `DecisionBlocked` and is never submitted.
- `ADM-CAT-003` and `ADM-CAT-006`: taxonomy disable/delete, product HIDE and
  DELIST use Core commands. `ProductWriteLocked` retains and renders the exact
  `blockingResource`; no physical-delete endpoint or UI action exists.
- `ADM-CAT-004` and `ADM-CAT-005`: the full managed-product list, authoritative
  store slot, merchant ownership, structured multi-SKU form, exact atomic
  values, category/tags, controlled product image/video reads, append-only
  inventory adjustments and historical `supersedesProductId` are consumed.
- `ADM-POL-001` and `ADM-POL-006`: Core signs the exact concession preview;
  the UI renders base receivable, concession, net receivable, every configured
  destination, policy version, fingerprint, signer and digest before review
  submission. It never calculates those values locally.
- `ADM-GOAL-001` and `ADM-GOAL-002`: ADMIN/OPERATOR controls require both the
  current session role and product/store `allowedActions`; AUDITOR receives the
  same reads with no write forms. Desktop/mobile layouts and loading, empty,
  error, blocked and disabled states are covered by product tests.

At that catalog checkpoint, global cross-resource batch tagging/export remained
`GAP-ADM-003`. Missing
commercial decisions remain `DecisionBlocked`; real production media/provider,
wallet, Safe, RPC, domain and device evidence remains `ExternalBlocked` under
`ADM-GOAL-003`. All fixtures remain under `tests/**`.

## Settlement/Admin `.5` Order Operations Evidence

- `ADM-GLOBAL-001`: ADMIN/OPERATOR/AUDITOR sessions consume exact order ID,
  product ID, SKU ID, TxHash and wallet filters, start/end and quick date ranges,
  order state, fulfillment mode, order kind, pending-product-review and breaker
  projections. At the `.5` checkpoint Core combined these server-side with AND;
  the `.13` evidence below supersedes its OR/fuzzy-wallet limitation.
- `ADM-GLOBAL-002`: selected order IDs are sent only to the read-only batch
  preview. The UI renders each row's authoritative `allowedActions` and the
  enabled intersection, but never turns that result into an unpublished write.
  Excel/CSV, waybill/pickup print and arbitrary batch writes remain disabled.
- `ADM-TAKE-001` and `ADM-TAKE-002`: the Admin order table consumes Core-owned
  quantity, creation time, order kind, payment TxHash and row-level
  `allowedActions`. The product no longer performs a second parallel action
  lookup or derives permissions from order state.
- `ADM-GOAL-001` and `ADM-GOAL-002`: `.5` response shape, exact query
  serialization, role denial, nullable category parent and read-only batch
  preview have consumer tests. Production source and bundle contain no fixture.

## Settlement/Admin `.15` Merchant Governance Evidence

The current Admin consumer is pinned to
`@abu24k/core-artifacts@2.0.0-settlement-admin.15` and reuses the existing
merchant lifecycle API and review workspace:

- `ADM-MER-001`: qualification PII remains FULL/REDACTED/UNAVAILABLE by Core
  RBAC. An APPROVED merchant exposes `CHANGE_SETTLEMENT_WALLET` only in the
  ADMIN review workflow; the proposed address is required and then bound to
  the existing challenge, independent secondary EIP-712 signature and Safe
  publication. Create accepts the initial wallet, while ordinary profile
  updates expose no wallet field.
- `ADM-MER-002`: AVAILABLE level policy displays the config ID, version,
  effective time, current level, USDT-atomic per-product settlement maximum and
  monthly seckill quota. A missing published policy remains `DecisionBlocked`.
- `ADM-MER-003`: named order and fulfillment aggregates retain Core values.
  AVAILABLE 48H evidence displays numerator, denominator and bps; a zero
  denominator displays `NO_ELIGIBLE_DELIVERY_ORDERS` and never a synthetic 0%.
- `ADM-MER-005`: finalized NPL Burn and fulfilled Available BNM totals remain
  read-only and ledger-reconciled. Abnormal-order rate remains the sole local
  merchant metric shown as `DecisionBlocked`.

Focused API/page tests cover both metric unions, wallet-change request and Safe
result binding, profile-field isolation, PII role behavior and Burn/BNM reads.
All fixtures remain under `tests/**`.

## Settlement/Admin `.14` Notification Campaign Evidence

The `.14` Admin checkpoint was pinned to
`@abu24k/core-artifacts@2.0.0-settlement-admin.14` and consumes the generated
notification campaign contracts without a parallel endpoint or provider
fixture:

- `ADM-NOTIFY-001`: ADMIN/OPERATOR create structured ALL, WALLET, MERCHANT or
  REGION audiences, controlled title/body copy keys, bounded variables,
  optional schedules and a stable idempotency key. The activity list renders
  the authoritative state, all six delivery-state counts and Core
  `allowedActions`; publish and failed-delivery retry remain disabled unless
  the selected projection publishes the exact action. AUDITOR is read-only.
- `ADM-NOTIFY-002`: the wallet inbox, loading, empty and typed error states are
  retained. `CONFIGURATION_REQUIRED`, retry and dead-letter evidence remain
  visible, and the product never substitutes a synthetic SMS/SMTP/Push success.
  Real provider acceptance remains `ExternalBlocked` under `ADM-GOAL-003`.

Focused API and page tests cover projection validation, structured request
serialization, idempotent retry, role denial, allowed-action denial and the
provider-configuration failure path. All fixtures remain under `tests/**`.

## Settlement/Admin `.13` Global Operations Evidence

The `.13` Admin checkpoint was pinned to
`@abu24k/core-artifacts@2.0.0-settlement-admin.13` and consumes only generated
search and product-lifecycle contracts:

- `ADM-GLOBAL-001`: ADMIN/OPERATOR/AUDITOR can choose server-side AND or OR,
  exact EVM-address matching or a 6-40 hex-character wallet fragment, exact
  order/product/merchant IDs and TxHash, PendingReview, start/end and
  Today/Yesterday/7d/30d ranges. The response relation and wallet mode must
  match the request. UID, phone and Yellow queue remain visibly fail-closed,
  so the full source row is not reported complete.
- `ADM-GLOBAL-002`: a cross-resource selection consumes each row's
  `allowedBatchActions`; Core creates the audited CSV/Excel bytes and the
  browser never synthesizes export rows. Electronic-waybill and pickup-print
  portions remain outside this surface, so the full row is not reported
  complete.
- `ADM-GLOBAL-003`: an all-product selection enables approve, reject, publish,
  hide or delist only when every selected row publishes the corresponding
  capability. The UI requires an uppercase reason code, an explicit inline
  confirmation and an idempotency key; Core applies all products or none. A
  failed request retains the same key for a bounded retry. Arbitrary product
  field batch editing and physical delete are not introduced, so only the
  published lifecycle subset is claimed.
- `ADM-GOAL-001` and `ADM-GOAL-002`: AUDITOR retains search/export but receives
  no tag or lifecycle write. Loading, empty, success, error, pending,
  capability-denied and retry states have focused consumer/UI coverage.

All fixtures remain under `tests/**`; the production bundle includes the three
global operation routes and contains no production fixture.

## Settlement/Admin `.9` Business Dashboard, Risk And Seckill Evidence

That batch's product pin was
`@abu24k/core-artifacts@2.0.0-settlement-admin.9`. The authenticated Admin
Dashboard consumes generated `AdminBusinessDashboard` without a local
financial calculation or production fixture:

- `ADM-DASH-001`: renders the exact `Asia/Shanghai` `[start,end)` window,
  15-confirmation finalized-order cohort, immutable list-price GMV,
  buyer-paid USDT, and nullable shipment-rate numerator/denominator/bps. New
  UID identity remains `DecisionBlocked`, so the full row is not reported
  complete.
- `ADM-DASH-002`: renders pending merchant/product review and the current
  exchange, delay, arbitration, forced-receipt and takeover queues. Low-stock
  threshold remains `DecisionBlocked`, so the full row is not reported
  complete.
- `ADM-DASH-003` and `ADM-CLEAR-007`: renders signed-settlement request and
  Safe-final totals, `failedTransactions`, per-asset verified Safe assets,
  unsettled liabilities, coverage evidence and all three independent breaker
  scopes, plus authoritative abnormal-observation, blacklist-block,
  active-restriction and pending-appeal counts. Monitoring alerts are not
  substituted for risk observations.
- `ADM-DASH-004`: remains backed by the separate typed monitoring consumer;
  the business Dashboard does not duplicate or reinterpret infrastructure
  probes as transaction-risk events.
- `ADM-RISK-001`, `ADM-RISK-004`, `ADM-RISK-005` and `ADM-RISK-006`: consumes
  generated observations, `ACTIVE` / `EXPIRED` / `OVERRIDDEN` restrictions,
  appeals and all four published Admin risk writes. UI controls match Core
  RBAC: AUDITOR read-only, OPERATOR appeal-only, ADMIN manual restriction,
  override and appeal decision. Response parsing rejects stale versions,
  unknown fields and invalid generated enum/state values.
- `ADM-RISK-003`: low-history wallet clustering remains `DecisionBlocked`.
  Frequent address/store-change thresholds and the production device
  fingerprint source remain explicit Core blockers; the UI does not infer them.
- `ADM-SEK-001` through `ADM-SEK-005`: ADMIN/OPERATOR/AUDITOR consume generated
  action list/detail projections with strict action/session/artifact binding.
  ADMIN/OPERATOR may create an opening draft; OPERATOR may cancel only an
  unproposed opening. ADMIN owns force-close, prize injection, breaker recovery,
  challenge/signature and Safe proposal. ConfigurationRequired, pending Safe
  finality, `REORGED`, `FAILED` and `CANCELLED` remain explicit UI states.

All unavailable entries preserve Core `DecisionBlocked` / `ExternalBlocked`
reason codes and details. An empty coverage projection is never shown as zero
or healthy. All fixtures remain under `tests/**`.

## Admin Logistics And Printing Closure Evidence

The Admin product consumes the coordinated logistics contracts while remaining
pinned to `@abu24k/core-artifacts@2.0.0-merchant-fulfillment.1`; it does not
publish or copy a parallel API:

- `ADM-LOG-001`: ADMIN and OPERATOR submit the complete SF/JD/YTO/ZTO/STO/EMS
  enabled set, one enabled default carrier and an idempotency key. AUDITOR is
  read-only and every response is artifact/version validated.
- `ADM-LOG-002`: Kuaidi100 and Cainiao consume secret references for partner,
  credential, monthly account and callback signing. Inputs use password fields,
  are cleared after submission and never appear in Core projections. Readiness
  and typed `ConfigurationRequired` remain explicit; real provider accounts are
  `ExternalBlocked` under `ADM-GOAL-003`.
- `ADM-LOG-003`: platform and partner warehouses use encrypted create, versioned
  update and logical deactivate commands. Writes carry `expectedVersion`; a
  stale version remains a visible `409`. AUDITOR receives only the Core
  `REDACTED` projection and no contact, phone, address or write control.
- `ADM-LOG-004`: no refund or return-warehouse control, route or destination is
  rendered. Exchange and takeover retain their separate frozen fulfillment
  behavior.
- Cross-merchant merchant-filtered waybill batches, waybill lists, print-job
  lists and idempotent retry are consumed with exact request bodies. This does
  not complete the broader export/pickup-print scope in `ADM-GLOBAL-002`.
- `ADM-LOG-005` remains `DecisionBlocked`: no frontend freight calculator is
  introduced before freight charge, weight basis and its effects on buyer
  70/30, merchant receivable and concession are frozen.

Real Kuaidi100/Cainiao accounts, provider acceptance and physical printer/device
evidence remain `ExternalBlocked`. All fixtures stay under `tests/**`; none is
present in the production bundle.

## Merchant Stores `.1` Consumer Boundary

That batch's product pin was
`@abu24k/core-artifacts@2.0.0-merchant-stores.1`. The shared read status now
includes `DRAFT`, but merchant store list/create/profile/activate/close remain
Merchant-only operations. This checkpoint completes no Admin Requirement ID:

- Admin exposes no store editor and does not call Merchant store-management
  routes.
- Consumer tests prove the coordinated manifest contains the five Merchant
  operations and no Admin alias.
- The production-bundle guard rejects the Merchant store-management route
  prefix, including the base GET/POST path.

Production Safe/RPC/domain/wallets, provider credentials, physical devices and
deployment remain `ExternalBlocked` under `ADM-GOAL-003`. No production fixture
is shipped.

## Settlement/Admin `.10` Global Clearing Evidence

The current Admin consumer is pinned to
`@abu24k/core-artifacts@2.0.0-settlement-admin.10` and uses only generated DTOs
and published OpenAPI paths:

- `ADM-CLEAR-001`: an ADMIN/OPERATOR/AUDITOR can read an exact order payment
  through `GET /v2/admin/payments/{orderId}` without holding the buyer wallet.
  Router method, immutable intent amounts, submitted TxHash and indexed
  finality are rendered from Core; BUYER remains `403`.
- `ADM-CLEAR-002`: filtered request and batch detail renders every published
  Safe owner approval against the immutable Safe TxHash and batch content hash.
  Policy/address old/new diff evidence remains governed by the existing policy
  and audit surfaces; this batch does not relabel unresolved commercial policy
  requirements complete.
- `ADM-CLEAR-004`, `ADM-CLEAR-005`, `ADM-CLEAR-006` and `ADM-CLEAR-007`: the
  workspace renders immutable request items and journal transitions, batch
  orders/recipients/atomic amounts, content and item hashes, chain/Safe/nonce,
  approvals, execution replacement attempts, Core finality, verified coverage,
  all independent breaker projections and Core reconciliation movements. It
  never totals or reconciles money in the browser.
- Both list endpoints apply the generated filters on Core and preserve the
  complete two-field cursor. `MINED 14/15` remains visibly non-final;
  `FAILED` and `REORGED` are explicit ineffective states. No manual transfer,
  batch-build, Safe-submit or balance-edit control exists.
- Matrix row classifications above remain unchanged where full PRD scope or
  production evidence is still unresolved. Merchant historical BNM aggregate
  remains unavailable, while production Safe/RPC/owner/deployment evidence is
  `ExternalBlocked` under `ADM-GOAL-003`.

All fixtures remain in `tests/**` and the production-bundle guard requires the
three new Admin clearing route families while rejecting Merchant-only routes.

## Platform Seckill Operations Closure Evidence

The completed Admin consumer remains pinned to the coordinated
`@abu24k/core-artifacts@2.0.0-merchant-fulfillment.1`; this product-only closure
does not publish or handwrite a parallel shared contract:

- `ADM-SEK-001`: ADMIN and OPERATOR authenticate through SIWE, read the real
  action list/detail, bind an existing published CMS rules projection, and
  create a session draft that Core validates and locks against real inventory.
- `ADM-SEK-002`: the UI exposes 3600s / 60s / +30s / cap 60s as read-only
  evidence. Its strict client rejects any current/history/session-plan response
  whose timer tuple differs from the frozen values.
- `ADM-SEK-003` and `ADM-SEK-004`: ADMIN controls submit exact force-close,
  prize-injection and seckill-breaker-resume bodies. The selected action then
  consumes the Core-issued EIP-712 challenge, an independent wallet signature,
  the secondary-signature response and the Safe-proposal command. Cancellation
  remains restricted to Core `allowedActions`; OPERATOR can cancel only an
  unproposed opening action and AUDITOR is read-only.
- `ADM-SEK-005`: the draft form fetches `SECKILL_RULES` through the existing CMS
  version endpoint, requires a published projection with a bound policyVersion,
  and copies its contentHash and policyVersion into read-only fields. The UI
  never constructs calldata or calculates prize allocations.
- Core `403` / `409`, `FAILED`, `REORGED`, and `MINED 14/15` remain explicit
  non-success states. A `FINAL` projection with fewer than 15 confirmations or
  non-canonical evidence is rejected by the Admin client.
- Production Safe addresses/owners, independent role wallets, RPC/WSS/mTLS,
  governed content and funded Operations Safe remain `ExternalBlocked`. All
  fixtures stay under `tests/**`; none is present in the production bundle.

## Merchant Fulfillment `.1` Consumer Boundary

The current product pin is
`@abu24k/core-artifacts@2.0.0-merchant-fulfillment.1`. Core publishes the
PII-authorized paginated Excel export only as Merchant operation
`POST /v2/merchant/orders/exports` (`exportMerchantOrders`). This checkpoint
completes no Admin Requirement ID:

- Admin exposes no Merchant order-export control, calls no Merchant export
  route and does not consume its generated PII request/response contracts.
- Consumer tests prove the Merchant operation, bearer authentication and exact
  request/response schemas exist while no Admin operation aliases those
  contracts.
- The production-bundle guard rejects both the Merchant route and operation ID.

Production Safe/RPC/domain/wallets, provider credentials, physical devices and
deployment remain `ExternalBlocked` under `ADM-GOAL-003`. No production fixture
is shipped.
