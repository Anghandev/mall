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
| ADM-DASH-003 | 20-21 | Today USDT Claims, chain failures, abnormal orders, blacklist blocks, leverage safety/warning/breaker | - | Metrics link to typed evidence and generated status enums | Frozen | GAP-ADM-005, GAP-ADM-011 |
| ADM-DASH-004 | 22-24 | RPC latency ms, Oracle deviation %, high-Gas blocks, bot orders, CPU, memory, Redis hit, MQ backlog and block height | D-V2-012 | Readiness never reports healthy without real probes | Frozen | GAP-ADM-005, GAP-ADM-018 |
| ADM-MER-001 | 26-31 | Pending/Approved/Rejected/Blacklist menus; shop, license image, legal name/ID, phone, settlement wallet; approved wallet immutability | D-V2-014, D-V2-015 | PII access is RBAC scoped; wallet changes use governed intent | Frozen | GAP-ADM-006 |
| ADM-MER-002 | 32-33 | V1-V5 levels; per-product max USDT settlement price; monthly seckill quota | - | Validation and version history are authoritative and audited | Frozen | GAP-ADM-006 |
| ADM-MER-003 | 34-36 | Ordinary/seckill cumulative orders, cumulative USDT flow, today sales; pending/transit/signed/pickup counts and 48H fast-ship rate | - | Drilldown reconciles dashboard totals | Frozen | GAP-ADM-006 |
| ADM-MER-004 | 37 | Source forced-refund count, USDT penalties and abnormal-order rate | D-V2-004, D-V2-005, D-V2-020 | Replace with takeover cases, guarantee/risk-reserve use, merchant debt and abnormal-order rate | Overridden | GAP-ADM-006, GAP-ADM-010 |
| ADM-MER-005 | 38 | Historical NPL Burn and successfully Available BNM totals | D-V2-003, D-V2-008 | Totals reconcile indexed final events and order snapshots | Frozen | GAP-ADM-006 |
| ADM-MER-006 | 39 | Locked, PendingSettlement, Available, Claimed plus withdrawal TxHash and Gas | D-V2-007 | USDT proceeds only and canonical five-state projection | Frozen | GAP-ADM-006 |
| ADM-CAT-001 | 41-43 | Three-level category tree; name/icon/sort/enabled/service-fee fields | D-V2-014, D-V2-018 | Fee is DecisionBlocked until versioned; other edits audited | DecisionBlocked | GAP-ADM-007, GAP-ADM-008 |
| ADM-CAT-002 | 44 | Tag library, examples, batch tagging and frontend feed | - | Versioned tags and placement state; no production fixture | Frozen | GAP-ADM-007 |
| ADM-CAT-003 | 45 | Category/tag delete-disable lock while seckill or delegated assets locked | D-V2-017 | Core and UI both deny action with reason | Frozen | GAP-ADM-007 |
| ADM-CAT-004 | 46-50 | Create/proxy-list; title/subtitle/main images/video/rich detail/default freight; settlement merchant allowlist; multi-SKU attributes/stock/USDT cost | D-V2-002 | Exact amounts, signed uploads and merchant eligibility required | Frozen | GAP-ADM-007 |
| ADM-CAT-005 | 51 | Platform inventory +/- and USDT cost edit | D-V2-014, D-V2-017 | Cannot mutate active order/session snapshot; new policy/version only | Overridden | GAP-ADM-007, GAP-ADM-008 |
| ADM-CAT-006 | 52 | Historical product cannot physically delete; delist/hide only | D-V2-017 | Chain/order evidence remains queryable forever | Frozen | GAP-ADM-007 |
| ADM-POL-001 | 54-57 | Product/session financial-policy panel and merchant USDT settlement cost | D-V2-002, D-V2-014 | Policy draft validates future-only scope and governed publish | Frozen | GAP-ADM-008 |
| ADM-POL-002 | 58-59 | Buyer USDT/NPL payment weights; NPL Burn A and Route B sum 100% | D-V2-002, D-V2-003, D-V2-014 | Launch policy 20/80; new policy only through RBAC+secondary signature+Safe | Overridden | GAP-ADM-008 |
| ADM-POL-003 | 60-61 | Platform fee, seckill pool, regional and referral proportions | D-V2-009, D-V2-014, D-V2-018 | Frozen NPL roles prefill launch policy; unspecified commercial values DecisionBlocked; publish future version only | DecisionBlocked | GAP-ADM-008 |
| ADM-POL-004 | 62 | Multiple beneficiary addresses and weights | D-V2-009, D-V2-010, D-V2-014 | Only complete role/asset set, no self/cycles, exact sum/cap and Safe approval can publish | Frozen | GAP-ADM-008 |
| ADM-POL-005 | 63 | Address-bound partner/channel no-login Claim link | D-V2-015 | Signed one-time/expiring claimant intent; no authorization bypass | Overridden | GAP-ADM-008 |
| ADM-SEK-001 | 65-67 | Create/publish session, assign product and lock activity inventory | D-V2-014, D-V2-017 | Cannot publish without policy, quotes, guarantees/reserve and inventory lock | Frozen | GAP-ADM-009 |
| ADM-SEK-002 | 68-69 | Main duration, relay initial and per-purchase recharge | D-V2-013, D-V2-014 | Fixed launch 60min/60sec/+30sec/cap60sec/main cap; future policy governance only | Overridden | GAP-ADM-009 |
| ADM-SEK-003 | 70-71 | Manual force-close and contract breaker | D-V2-014, D-V2-016 | Exact session intent, secondary signature, Safe approval and indexed event | Frozen | GAP-ADM-004, GAP-ADM-009 |
| ADM-SEK-004 | 72 | Inject USDT into current prize pool | D-V2-014 | Exact token/amount/session/Safe intent; receipt and pool reconciliation | Frozen | GAP-ADM-004, GAP-ADM-009 |
| ADM-SEK-005 | 73-74 | Versioned rich-text rules shared by Mall and Merchant | D-V2-013, D-V2-014 | Published content binds same policyVersion and sanitization | Frozen | GAP-ADM-009, GAP-ADM-013 |
| ADM-RISK-001 | 76-78 | High-Gas/front-running monitor and automatic 24-hour address breaker | D-V2-016 | Explainable risk evidence, expiry and authorized override are audited | Frozen | GAP-ADM-011 |
| ADM-RISK-002 | 79 | Source `tx.origin == msg.sender` contract-call ban | D-V2-015 | Never tx.origin; authorization supports ERC-1271; any EOA policy is separate and explicit | Overridden | GAP-ADM-011 |
| ADM-RISK-003 | 80-82 | Anonymous low-history wallet clustering detection/block | - | Risk signal cannot independently forge authorization/finality | Frozen | GAP-ADM-011 |
| ADM-RISK-004 | 83 | Same IP/device switches over 5 wallets in 1 minute then blacklist | - | Threshold, evidence, privacy retention and appeal are auditable | Frozen | GAP-ADM-011 |
| ADM-RISK-005 | 84 | 3 cancellations in 5 minutes, frequent pickup/address change, 2-hour trade lock | D-V2-004 | Applies to permitted pre-payment/ordinary actions only; never creates a business refund | Frozen | GAP-ADM-011 |
| ADM-RISK-006 | 85 | Separate wallet/IP-range/device blacklists; manual/automatic lock | - | RBAC, expiry/reason/evidence and immutable audit required | Frozen | GAP-ADM-011 |
| ADM-LOG-001 | 87-90 | SF/JD/YTO/ZTO/STO/EMS enabled states and default carrier | - | Provider readiness and carrier versioning tested | Frozen | GAP-ADM-012 |
| ADM-LOG-002 | 91 | Cainiao/Kuaidi100 PartnerID, secret reference, monthly waybill account and real tracking numbers | D-V2-019 | Secrets never stored/rendered; missing account ConfigurationRequired | ExternalBlocked | GAP-ADM-012 |
| ADM-LOG-003 | 92-93 | Platform/partner warehouse shipping-address library | - | RBAC writes and audit; exact address fields validated | Frozen | GAP-ADM-012 |
| ADM-LOG-004 | 94 | Source forced-refund return warehouse | D-V2-004 | No refund destination is emitted; exchange/takeover logistics use their own allowedActions | Overridden | GAP-ADM-012 |
| ADM-LOG-005 | 95 | Per-count/per-weight freight; Dalian pickup free; remote no-delivery rule | - | Signed quote consumes versioned freight result; frontend does not calculate | Frozen | GAP-ADM-012 |
| ADM-TAKE-001 | 97-99 | Source forced-refund center and action | D-V2-004, D-V2-005 | Renamed Merchant Takeover Fulfillment Center; 7-day no-evidence case opens automatically | Overridden | GAP-ADM-010 |
| ADM-TAKE-002 | 100-101 | Source USDT return and Locked BNM burn | D-V2-004, D-V2-005 | Customer payment and rewards remain Locked; platform/replacement merchant fulfills order | Overridden | GAP-ADM-010 |
| ADM-TAKE-003 | 102 | Source merchant pending/guarantee deduction | D-V2-005, D-V2-020 | Funding order is guarantee, unencumbered assets, risk reserve; advance records merchant debt | Overridden | GAP-ADM-010 |
| ADM-TAKE-004 | 103 | Source unlock and delist | D-V2-005 | Freeze new orders/listings/all merchant Claims; product cannot relist below reserve thresholds | Overridden | GAP-ADM-010 |
| ADM-CMS-001 | 105-107 | Banner, recommended product schedule, splash, timed/frequency/location campaign popup | - | Versioned placement, preview, publish/rollback and audience evidence | Frozen | GAP-ADM-013 |
| ADM-CMS-002 | 108 | Seckill rules, FAQ, service agreement, privacy and About rich text | D-V2-013, D-V2-014 | Sanitized versioned content and approval audit | Frozen | GAP-ADM-013 |
| ADM-CMS-003 | 109 | Release announcements, forced/hot-update notices and contract-upgrade notices | - | Target/version/time and rollback evidence | Frozen | GAP-ADM-013 |
| ADM-NOTIFY-001 | 111-115 | User/region/merchant audiences; payment, shipment+tracking, pickup; USDT/NPL/BNM availability; genesis/referral/region; announcements/maintenance/activity | D-V2-007, D-V2-008 | Notifications derive from finalized domain events and expose delivery status | Frozen | GAP-ADM-014 |
| ADM-NOTIFY-002 | 116 | Aliyun/Tencent SMS, SMTP and Firebase/JPush gateway secret references | D-V2-019 | Missing provider ConfigurationRequired; no real batch send without approval | ExternalBlocked | GAP-ADM-014 |
| ADM-SYS-001 | 118-120 | Versioned business config, freight and unpaid-reservation release timeout | D-V2-014 | Changes are typed, validated, audited and future-only | Frozen | GAP-ADM-015 |
| ADM-SYS-002 | 121 | Main/test RPC URLs and fallback routing | D-V2-019 | Secret-safe references and live health; missing RPC ExternalBlocked | ExternalBlocked | GAP-ADM-015 |
| ADM-SYS-003 | 122 | Oracle address and deviation threshold | D-V2-012, D-V2-018 | 30-minute TWAP/5%; maxAge and liquidity DecisionBlocked until set | DecisionBlocked | GAP-ADM-015 |
| ADM-SYS-004 | 123 | Seckill maximum Gas control | - | Quote/intent policy rejects above limit; admin cannot control miner inclusion | Frozen | GAP-ADM-015 |
| ADM-SYS-005 | 124-125 | Chain ID, Safe address, Seckill/NPL/BNM address manifest | D-V2-001, D-V2-014, D-V2-019 | Chain 56 and token constants; Safe/role/deployment addresses ExternalBlocked until published | ExternalBlocked | GAP-ADM-015 |
| ADM-SYS-006 | 126 | OSS secret reference, CDN switch and AI support prompt | D-V2-019 | Secrets never rendered/committed; provider absence ConfigurationRequired | ExternalBlocked | GAP-ADM-015 |
| ADM-AUD-001 | 128-129 | Separate append-only read-only audit database in reverse time | D-V2-017 | Hash-chain verification, retention and backup/restore tests; no delete path | Frozen | GAP-ADM-016 |
| ADM-AUD-002 | 130-133 | Admin operation, wallet login/IP/device, JSON-RPC request/response, database/Oracle/deadlock error stack logs | - | Typed filters, redaction and correlation IDs; no secret/PII leakage | Frozen | GAP-ADM-016 |
| ADM-AUD-003 | 134 | Claim/payment/shipment/source customer-service-refund logs with wallet signature | D-V2-004, D-V2-005 | Replace refund audit with takeover and emergency-recovery audit; every financial action keeps signature proof | Overridden | GAP-ADM-016 |
| ADM-CLEAR-001 | 136-138 | Admin wallet signature/Tx/message on each audit; contract method/Gas/status history | D-V2-015, D-V2-017 | Indexed call and signature evidence reconcile to chain | Frozen | GAP-ADM-017 |
| ADM-CLEAR-002 | 139 | Multisig approvals for fee/address changes and guarantee deductions; every owner signature | D-V2-014, D-V2-020 | Safe proposal/execution and exact diff evidence | Frozen | GAP-ADM-017 |
| ADM-CLEAR-003 | 140 | Config/proportion change actor, old value and new value | D-V2-014 | policyVersion and future-only effective boundary included | Frozen | GAP-ADM-017 |
| ADM-CLEAR-004 | 141 | Merchant Claim reconciliation; chain amount vs ledger decrement; breaker attack snapshot | D-V2-016, D-V2-017 | Exact amount conservation and breaker evidence | Frozen | GAP-ADM-017 |
| ADM-OPS-001 | 143-144 | CPU curve, memory and disk waterline | - | Real host metrics, thresholds and unavailable state | ExternalBlocked | GAP-ADM-018 |
| ADM-OPS-002 | 145 | Redis penetration/hit, MQ backlog and DB pool active count | - | Real probes and alert thresholds | ExternalBlocked | GAP-ADM-018 |
| ADM-OPS-003 | 146 | TPS, QPS, buy/ship average ms and global error rate | - | Time-window definitions and drilldown evidence | ExternalBlocked | GAP-ADM-018 |
| ADM-OPS-004 | 147 | RPC vs explorer height; red alert over 3 blocks | - | Independent explorer source and tested alert/recovery | ExternalBlocked | GAP-ADM-018 |
| ADM-GOAL-001 | Final Goal | Desktop operations UI, responsive/mobile fallback, keyboard/focus/labels, complete loading/empty/error/disabled states | - | Type, consumer, accessibility and Playwright tests pass | Frozen | GAP-ADM-001 |
| ADM-GOAL-002 | Final Goal | RBAC, secondary wallet signature, Safe publish, exact allowedActions and no production fixture | D-V2-014, D-V2-021 | Permission negative tests and production-bundle scan pass | Frozen | GAP-ADM-001, GAP-ADM-002, GAP-ADM-004 |

## Completion Rule

No row is `Verified` until its code and evidence exist against the same Core
artifact version used by Mall and Merchant. External inputs cannot be replaced
by fixture success.
