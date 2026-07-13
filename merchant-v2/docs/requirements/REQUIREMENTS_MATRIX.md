# Merchant Workbench V2 Frozen Requirement Matrix

Authority: `PRD-MERCHANT-WORKBENCH.txt`, `SOURCE.md`,
`../../../docs/V2_SYSTEM_CONTRACT.md` and `../../../docs/V2_DECISIONS.md`.

This is a traceability index, not a second PRD. Status meanings match the Mall
matrix. Missing Core capability is implemented only as the listed fail-closed
state.

| Requirement ID | Source lines | Field/state/action coverage | Decision | Acceptance and evidence target | Status | Core gap |
|---|---:|---|---|---|---|---|
| MER-SRC-001 | 1 | PRD title and complete-source identity | - | Local source hash and terminal section match SOURCE record | Frozen | - |
| MER-AUTH-001 | 2-6 | Web3-only login; Connect Wallet; MetaMask/OKX and supported-wallet launch | D-V2-015 | No password fallback; unsupported/rejected/wrong-chain states fail closed | Frozen | GAP-MER-001, GAP-MER-002 |
| MER-AUTH-002 | 7-10 | Nonce, timestamp, EIP-4361 message, Sign and Login, zero Gas, signature recovery, merchant allowlist and JWT | D-V2-015 | Nonce is one-use/expiring and session role is server-authoritative | Frozen | GAP-MER-002 |
| MER-AUTH-003 | 11 | Secondary wallet signature for printer and region changes | D-V2-014, D-V2-015 | Exact resource/old-new values/digest/expiry are signed; Safe gate applies where policy requires | Frozen | GAP-MER-002 |
| MER-DASH-001 | 12-16 | Default full-screen dashboard; minute-level single-shop data; pending shipment count and drilldown to module 03 | - | Authoritative day boundary and count; no zero-as-unavailable | Frozen | GAP-MER-003 |
| MER-DASH-002 | 17 | Today 00:00-24:00 paid USDT including Locked and PendingSettlement | D-V2-021 | Canonical exact amount and timezone from Core | Frozen | GAP-MER-003 |
| MER-DASH-003 | 18-19 | Unique-product status: Draft, PendingReview, Scheduled, Live, SoldOut/Delisted | - | Unknown status fails closed; labels use generated enum | Frozen | GAP-MER-003, GAP-MER-004 |
| MER-DASH-004 | 20 | Today's successful pickup-scan count across merchant stores | - | Count links to canonical pickup evidence | Frozen | GAP-MER-003, GAP-MER-007 |
| MER-PROD-001 | 21-24 | One-shop-one-product; no list; one unique maintenance form | - | API and UI both enforce one product slot | Frozen | GAP-MER-004 |
| MER-PROD-002 | 25 | Title max 60, 1-5 main images and rich detail | - | Field validation and signed upload metadata tests | Frozen | GAP-MER-004, GAP-MER-017 |
| MER-PROD-003 | 26-28 | SKU name such as size/color, USDT settlement price, positive integer seckill inventory entered once, delivery/pickup multiselect | D-V2-002 | Canonical decimal/atomic amount; invalid inventory/mode blocks submit | Frozen | GAP-MER-004 |
| MER-PROD-004 | 29-30 | PendingReview/Scheduled/Live write lock; Save/Modify/Delist disabled; Core Update forbidden; exact locked-product error | D-V2-017 | UI and Core reject every product write while locked | Frozen | GAP-MER-004 |
| MER-PROD-005 | 31 | Unlock only after settled/sold out or platform delist; SoldOut/Delisted enables edit/clear/new product | - | Transition comes from Core allowedActions, never local time | Frozen | GAP-MER-004 |
| MER-FUL-001 | 32-34 | Seckill and ordinary orders; no merchant repricing; no customer self-refund | D-V2-004 | Merchant surface contains no business-refund control | Frozen | GAP-MER-005 |
| MER-FUL-002 | 35-38 | Time/SKU/status/mode filters; Export Excel; exact fields order no., TxHash, consignee, phone, full address, quantity, order time, tracking no., verification status | - | Server-side paginated export is PII-authorized and audit logged | Frozen | GAP-MER-005 |
| MER-FUL-003 | 39-42 | Feie/Yilianyun integration; batch electronic waybill printing; pickup scan triggers two-copy receipt | D-V2-019 | Missing device/account returns ConfigurationRequired; one job/two-copy physical evidence | ExternalBlocked | GAP-MER-009, GAP-MER-010 |
| MER-FUL-004 | 43-45 | Delivery tab; batch/single Ship action; valid tracking input or electronic generation; order state update | - | Idempotent shipment evidence and provider callback; no final settlement claim | Frozen | GAP-MER-005, GAP-MER-006, GAP-MER-010 |
| MER-FUL-005 | 46-47 | Pickup tab fields: order no., bound verification store, PendingPickup/Verified, verification time | - | Camera/manual verification binds signed challenge and store | Frozen | GAP-MER-007 |
| MER-FUL-006 | 48-52 | Source delivered/manual merchant completion and one-block reward release; pickup scan; Locked to Available | D-V2-006, D-V2-007, D-V2-017 | Merchant can only request forced receipt after 7 days; platform reviews; all non-prize rewards wait for fulfillment finality | Overridden | GAP-MER-006 |
| MER-STORE-001 | 53-57 | Store CRUD scope; name, photos, hours, phone and precise coordinates | - | Required fields, upload ownership and loading/error states tested | Frozen | GAP-MER-008, GAP-MER-017 |
| MER-STORE-002 | 58-60 | Six-digit national region code; AMap reverse geocode; example 210211; permanent lock; pickup regional-beneficiary binding | D-V2-010, D-V2-014, D-V2-017 | No manual region fallback; signed region; later move creates replacement store | Frozen | GAP-MER-008 |
| MER-STORE-003 | 61 | Physical receipt printer Device ID binding and automatic pickup receipt | D-V2-014, D-V2-019 | Secondary signature and real device readiness required | ExternalBlocked | GAP-MER-009 |
| MER-ASSET-001 | 62-65 | Financial/reward center; multi-state dashboard plus on-chain withdrawal history; Today/Locked/PendingSettlement/Available/Claimed | D-V2-021 | USDT merchant proceeds are separate, canonical and pull-based | Frozen | GAP-MER-011 |
| MER-ASSET-002 | 66-70 | Natural-day sales, Locked shipment/transit/pickup, PendingSettlement finality, Available Claimable, cumulative Claimed | D-V2-006, D-V2-007, D-V2-017 | Exact Core projection; no frontend netting or premature release | Frozen | GAP-MER-011 |
| MER-ASSET-003 | 71-76 | Seckill revenue detail, store NPL pool, BNM total and released/locked tracking | D-V2-007, D-V2-008, D-V2-009 | Merchant USDT proceeds and separate NPL/BNM rails never merge; availability follows fulfillment | Overridden | GAP-MER-013 |
| MER-CLAIM-001 | 77-78 | Sign to Claim merchant available USDT into bound wallet | D-V2-007, D-V2-015 | Allowed action plus ordered intent, receipt and finality are required | Frozen | GAP-MER-012 |
| MER-CLAIM-002 | 79-85 | Withdrawal columns: time, asset, USDT amount, status, TxHash/explorer, Gas BNB | - | Table uses exact full values and generated status enum | Frozen | GAP-MER-012 |
| MER-CLAIM-003 | 86-97 | Two sample rows, success and packaging/pending states and example values | - | Examples are test-only fixtures and excluded from production bundle | Frozen | GAP-MER-012 |
| MER-SET-001 | 98-103 | Settings scope; shop name, Logo; bound contact/Claim wallet immutable by ordinary edit | D-V2-014, D-V2-015 | Wallet change is a governed migration, not a local form mutation | Frozen | GAP-MER-014, GAP-MER-017 |
| MER-AUD-001 | 104-106 | Append-only reverse-time sensitive-action log; time/type/module/detail/signature-hash columns | D-V2-014, D-V2-017 | Audit rows cannot be deleted or edited and link to proof | Frozen | GAP-MER-015 |
| MER-AUD-002 | 107-110 | Export, printer binding and 5000 USDT Claim example audit rows with timestamp/detail/hash | - | Test fixtures validate rendering only; production reads append-only Core stream | Frozen | GAP-MER-015 |
| MER-HELP-001 | 111-115 | Help module, current platform seckill rules rich text | D-V2-013, D-V2-014 | Content version matches published policyVersion | Frozen | GAP-MER-016 |
| MER-HELP-002 | 116 | One-product lock, no fake tracking and brush-order penalty notice | D-V2-005, D-V2-020 | Copy explains takeover/debt/permission freeze without inventing a deduction cap | Frozen | GAP-MER-016 |
| MER-GOAL-001 | Final Goal | Modules 00-07, desktop/tablet/mobile responsive layout, keyboard/focus/labels and complete loading/empty/error/disabled/offline states | - | Type, consumer, accessibility and Playwright tests pass | Frozen | GAP-MER-001 |
| MER-GOAL-002 | Final Goal | Production build has no fixture; shared artifacts only; no endpoint/calldata/amount guessing | D-V2-021 | Production-bundle negative scan and artifact-version assertion pass | Frozen | GAP-MER-001 |
| MER-GOAL-003 | Final Goal | Real AMap, Kuaidi100, Feie device and authorized merchant wallet acceptance | D-V2-019 | Real provider/device evidence only | ExternalBlocked | GAP-MER-018 |

## Completion Rule

`Verified` requires implementation plus the listed evidence. Product work may
only record `Requirement ID + required capability + fail-closed behavior` while
a Core gap remains unpublished.
