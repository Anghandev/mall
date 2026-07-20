# Merchant Workbench V2 Frozen Requirement Matrix

Authority: `PRD-MERCHANT-WORKBENCH.txt`, `SOURCE.md`,
`../../../docs/V2_SYSTEM_CONTRACT.md` and `../../../docs/V2_DECISIONS.md`.

This is a traceability index, not a second PRD. Status meanings match the Mall
matrix. A listed fail-closed state is temporary development evidence only; it
does not complete or verify a Requirement while its Core capability is missing.

| Requirement ID | Source lines | Field/state/action coverage | Decision | Acceptance and evidence target | Status | Core gap |
|---|---:|---|---|---|---|---|
| MER-SRC-001 | 1 | PRD title and complete-source identity | - | Local source hash and terminal section match SOURCE record | Frozen | - |
| MER-AUTH-001 | 2-6 | Web3-only login; Connect Wallet; MetaMask/OKX and supported-wallet launch | D-V2-015 | No password fallback; unsupported/rejected/wrong-chain states fail closed | Frozen | GAP-MER-001, GAP-MER-002 |
| MER-AUTH-002 | 7-10 | Nonce, timestamp, EIP-4361 message, Sign and Login, zero Gas, signature recovery, merchant allowlist and JWT | D-V2-015 | Nonce is one-use/expiring and session role is server-authoritative | Frozen | GAP-MER-002 |
| MER-AUTH-003 | 11 | Secondary wallet signature for printer and region changes | D-V2-014, D-V2-015, D-V2-035, D-V2-038 | Printer binding is Phase 2; store administrative region is permanently locked after creation and has no launch change action | Overridden | - |
| MER-DASH-001 | 12-16 | Default full-screen dashboard; minute-level single-shop data; pending shipment count and drilldown to module 03 | - | Authoritative day boundary and count; no zero-as-unavailable | Verified | - |
| MER-DASH-002 | 17 | Today 00:00-24:00 chain-final buyer product-USDT and freight payments, with the 1%-of-list service fee, post-fee product base and merchant net receivable kept separate | D-V2-003, D-V2-021, D-V2-022, D-V2-031 | Core supplies the authoritative timezone and exact signed service-fee, Custody-product, freight, concession and merchant-net totals; Merchant displays them without netting or recomputation | Overridden | GAP-MER-003 (updated service-fee split and dashboard projection) |
| MER-DASH-003 | 18-19 | Unique-product status: Draft, PendingReview, Scheduled, Live, SoldOut/Delisted | - | Unknown status fails closed; labels use generated enum | Verified | - |
| MER-DASH-004 | 20 | Today's successful pickup-scan count across merchant stores | - | Count links to canonical pickup evidence | Verified | - |
| MER-PROD-001 | 21-24 | One-shop-one-product; no list; one unique maintenance form | - | API and UI both enforce one product slot | Verified | - |
| MER-PROD-002 | 25 | Title max 60, 1-5 main images and rich detail | - | Field validation and signed upload metadata tests | Verified | - |
| MER-PROD-003 | 26-28 | SKU name such as size/color, USDT merchant base receivable, flat default delivery freight, positive integer seckill inventory entered once, delivery/pickup multiselect | D-V2-002, D-V2-021, D-V2-031 | Core supplies canonical decimal/atomic amounts; invalid amount, freight, inventory or fulfillment mode blocks submit | Verified | - |
| MER-PROD-004 | 29-30 | PendingReview/Scheduled/Live write lock; Save/Modify/Delist disabled; Core Update forbidden; exact locked-product error | D-V2-017 | UI and Core reject every product write while locked | Verified | - |
| MER-PROD-005 | 31 | Unlock only after settled/sold out or platform delist; SoldOut/Delisted enables edit/clear/new product | - | Transition comes from Core allowedActions, never local time | Verified | - |
| MER-PROD-006 | New Goal | Merchant concession from 0-100%; buyer 70/30 remains unchanged; concession uses the post-1%-fee product base and allocates platform 0%, seckill prize 45%, node rewards 45% and Locked reward reserve 10% | D-V2-002, D-V2-003, D-V2-021, D-V2-022 | Submit requires a signed Core preview whose version, post-fee base, exact integer concession/net amounts and fixed destination totals reconcile; freight is excluded and the frontend never calculates weights or authoritative amounts | Overridden | GAP-MER-004 (revised post-fee preview and coordinated artifact) |
| MER-FUL-001 | 32-34 | Seckill and ordinary orders; no merchant repricing; no customer self-refund | D-V2-004 | Merchant surface contains no business-refund control | Verified | - |
| MER-FUL-002 | 35-38 | Time/SKU/status/mode filters; Export Excel; exact fields order no., TxHash, consignee, phone, full address, quantity, order time, tracking no., verification status | - | Server-side paginated export is PII-authorized and audit logged | Verified | - |
| MER-FUL-003 | 39-42 | Feie/Yilianyun adapter; batch electronic waybill printing; pickup scan creates one two-copy receipt job | D-V2-019, D-V2-021, D-V2-038 | Phase 2 only; launch UI uses provider-independent manual shipment and does not expose electronic-waybill or printer controls | Overridden | - |
| MER-FUL-004 | 43-45 | Delivery tab; batch/single Ship action; valid tracking input or electronic generation; order state update | D-V2-007, D-V2-017, D-V2-038 | Launch supports single-order manual carrier/tracking/note evidence followed by canonical shipment recording; batch and electronic generation are Phase 2, and shipment cannot release or settle an asset | Overridden | - |
| MER-FUL-005 | 46-47 | Pickup tab fields: order no., bound verification store, PendingPickup/Verified, verification time | - | Camera/manual verification binds signed challenge and store | Verified | - |
| MER-FUL-006 | 48-52 | Source delivered/manual merchant completion and one-block release; pickup scan; Locked to Available | D-V2-006, D-V2-007, D-V2-008, D-V2-017 | Merchant can only request forced receipt after 7 days; platform reviews; fulfillment finality makes transferable proceeds/rewards Available and BNM backend points Available, without a BNM token or Claim | Overridden | GAP-MER-018 (BNM conformance evidence) |
| MER-STORE-001 | 53-57 | Store CRUD scope; name, photos, hours, phone and precise coordinates | - | Required fields, upload ownership and loading/error states tested | Verified | - |
| MER-STORE-002 | 58-60 | Six-digit national region code; AMap reverse geocode; example 210211; permanent lock; pickup regional-beneficiary binding | D-V2-010, D-V2-014, D-V2-017 | No manual region fallback; signed region; later move creates replacement store | Verified | - |
| MER-STORE-003 | 61 | Physical receipt printer Device ID binding and automatic pickup receipt | D-V2-014, D-V2-019, D-V2-021, D-V2-038 | Phase 2; printer binding, device loading and automatic receipt printing are absent from the launch UI and acceptance | Overridden | - |
| MER-ASSET-001 | 62-65 | Financial/reward center; Today plus Locked/Available/Requested/Submitted/Settled transferable-asset dashboard and final EOA execution history | D-V2-007, D-V2-021, D-V2-023, D-V2-031, D-V2-035 | Product net proceeds and freight remain separate canonical USDT liabilities consumed by the same merchant settlement rail; every state and final execution TxHash comes from Core | Verified | - |
| MER-ASSET-002 | 66-70 | Natural-day sales; product/freight payment snapshot; Locked during shipment/transit/pickup; Available after fulfillment finality; Requested, Submitted and cumulative Settled | D-V2-006, D-V2-007, D-V2-017, D-V2-023, D-V2-031, D-V2-035 | Exact Core projection links separate product net and freight amounts to orders, journal evidence, settlement request, immutable per-transfer intent and 15-confirmation EOA execution finality; no frontend netting or premature release | Verified | - |
| MER-ASSET-003 | 71-76 | Source seckill-bonus detail overridden: the merchant receives no extra seckill revenue; normal product/freight receivables, NPL reward subtypes and BNM backend-point Locked/Available totals remain separate | D-V2-007, D-V2-008, D-V2-009, D-V2-010, D-V2-022, D-V2-023 | Obsolete extra-seckill-revenue and DecisionBlocked surfaces are removed; genesis is an NPL ledger subtype with no NFT/token eligibility; generated NPL and Core-projected BNM totals render without frontend aggregation or cross-rail settlement | Overridden | GAP-MER-013 retired by D-V2-022; revised artifact and Merchant consumer pending |
| MER-ASSET-004 | New Goal | 1,000 USDT minimum guarantee; major-loss order guarantee -> frozen receivables -> future proceeds; listing, new orders and settlement requests freeze when required | D-V2-005, D-V2-018, D-V2-020, D-V2-021 | Core projects exact guarantee/debt evidence and allowedActions; below-minimum and takeover states block product listing, new orders and merchant settlement requests without affecting buyer prize eligibility | Frozen | GAP-MER-004 |
| MER-CLAIM-001 | 77-78 | Gasless wallet-signed request to settle Available merchant USDT into the bound settlement wallet | D-V2-007, D-V2-015, D-V2-023, D-V2-035 | Request is wallet/asset/amount bound, nonce-protected, expiring and idempotent; merchant signs but never broadcasts the EOA transfer or pays settlement Gas | Verified | - |
| MER-CLAIM-002 | 79-85 | Settlement columns: request time, asset, exact amount, Requested/Submitted/Settled status, transfer intent ID, final execution TxHash/explorer | D-V2-007, D-V2-017, D-V2-023, D-V2-035 | Generated states and full values reconcile to the immutable per-transfer intent and 15-confirmation execution finality; EOA execution Gas is platform evidence, not a merchant charge | Verified | - |
| MER-CLAIM-003 | 86-97 | Source example rows reinterpreted as Requested, Submitted and Settled settlement-request examples | D-V2-007, D-V2-023, D-V2-035 | Examples exist only as test fixtures; tests cover transfer failure/replacement/reorg and final execution TxHash, and production bundles contain no sample records or simulated success | Overridden | - |
| MER-SET-001 | 98-103 | Settings scope; shop name, Logo; bound contact/settlement wallet immutable by ordinary edit | D-V2-014, D-V2-015 | GET/PUT uses optimistic version plus stable idempotency; Logo uses owned provider-sealed MERCHANT_LOGO media; settlement wallet is read-only and absent from the PUT body | Verified | - |
| MER-AUD-001 | 104-106 | Append-only reverse-time sensitive-action log; time/type/module/detail/signature-hash columns | D-V2-014, D-V2-017, D-V2-035 | Tenant-scoped reverse-time entries, filters, cursor, signature hash, entry hash and EOA execution/chain TxHash come from Core; PARTIAL_PRE_MERCHANT_SCOPE is explicit | Verified | - |
| MER-AUD-002 | 107-110 | Bounded CSV export plus source physical-printer evidence | D-V2-007, D-V2-023, D-V2-038 | Production downloads the exact Core CSV for a required <=31-day, <=1000-row tenant scope; empty/error/permission states fail closed; physical printer evidence is Phase 2 and not launch acceptance | Overridden | - |
| MER-HELP-001 | 111-115 | Help module, current platform seckill rules rich text, including the final-order winner/review/rollover rule and confirmed merchant payment/reward interpretation | D-V2-003, D-V2-010, D-V2-013, D-V2-014, D-V2-022, D-V2-032, D-V2-033 | Published content is bound to the current policyVersion and contains no stale extra-merchant-revenue, Genesis-NFT, V1-V5 or unresolved-allocation wording | Overridden | GAP-MER-016 (revised rules publication and consumer evidence) |
| MER-HELP-002 | 116 | One-product lock, no fake tracking, brush-order penalty, 1,000 USDT guarantee minimum and takeover/debt consequences | D-V2-005, D-V2-018, D-V2-020 | Copy states guarantee -> frozen receivables -> future proceeds, plus listing/new-order/settlement-request freezes, without inventing a deduction cap | Verified | - |
| MER-GOAL-001 | Final Goal | Real runtime for modules 00-07; desktop/tablet/mobile responsive layout; keyboard/focus/labels; complete loading/empty/error/disabled/offline states | D-V2-021 | Type, consumer, accessibility and Playwright tests exercise working reads and allowed writes; disabled, empty, static or review-only surfaces do not satisfy a module | Frozen | GAP-MER-001 |
| MER-GOAL-002 | Final Goal | Production build has no fixture; shared batch artifacts only; no parallel endpoint/schema/calldata/amount logic; all published Core capabilities are actually consumed | D-V2-021, D-V2-023 | Production-bundle negative scan, same-version consumer tests and real local Core integration pass; empty action catalogs, fail-closed placeholders and simulated success are not completion evidence | Frozen | GAP-MER-001 |
| MER-GOAL-003 | Final Goal | Real AMap, Kuaidi100/Cainiao, Feie/Yilianyun, existing BNM backend, authorized merchant wallet, provider account and physical device acceptance | D-V2-019, D-V2-038 | Existing BNM and wallet acceptance remain launch inputs; logistics/map/provider/device acceptance is Phase 2 and cannot block launch manual fulfillment | Overridden | - |

## Merchant Stores .1 Verification Evidence

- `@abu24k/core-artifacts@2.0.0-merchant-stores.1` publishes and the Merchant
  consumer uses managed-store list, create, versioned profile update, activate
  and close operations; every response is merchant-scoped and strictly parsed.
- The production UI creates a `DRAFT` from profile fields plus AMap coordinates,
  never accepts a browser-supplied region or address, binds 1-5 provider-sealed
  `STORE_IMAGE` assets, preserves immutable location fields, and executes
  `DRAFT -> ACTIVE -> CLOSED` only through Core capabilities and versions.
- Consumer/UI tests cover exact methods and paths, media ownership, stable
  idempotency, version conflict refresh, 403 failure, activation/close and the
  absence of Phase 2 printer calls from launch.
- Production object storage and an authorized merchant wallet remain rollout
  inputs. Logistics provider and printer accounts/devices are Phase 2; no
  production fixture or simulated provider success is counted as launch evidence.

## Merchant Fulfillment .1 Verification Evidence

- `@abu24k/core-artifacts@2.0.0-merchant-fulfillment.1` publishes
  `exportMerchantOrders`; the Merchant client resolves its path by operationId
  from that same OpenAPI artifact and strictly parses the tenant, filters,
  stable cursor, file metadata, Base64 content and generated enums.
- Excel download sends the applied time/SKU/state/mode/kind filters plus the
  current list cursor, preserves one idempotency key on retry, rejects 403/409,
  tenant/filter mismatches and invalid SHA-256, and downloads only Core bytes.
- `pickupVerifiedToday` remains the exact Core dashboard value. Its metric links
  to `/fulfillment?mode=pickup`, which deterministically loads the canonical
  pickup order/store evidence rather than counting browser rows.
- Pickup entry uses native camera permission plus `BarcodeDetector` only to fill
  an exact six-digit code into the existing order/store-bound verification
  command. Unsupported, denied and recognition-failure states remain explicit,
  keep manual entry usable and never simulate a successful device scan.
- Focused Core consumer and Merchant workbench tests cover the real success,
  loading, empty, malformed, 403, 409, cross-tenant, camera and manual paths;
  the production build/bundle guard rejects test export fixtures and obsolete
  artifact versions.

## Settlement Admin .12 Per-Order Receivable Evidence

- `@abu24k/core-artifacts@2.0.0-settlement-admin.12` publishes the
  merchant-scoped `GET /v2/merchant/receivable-statements` operation, paired
  `(createdAt, orderId)` cursor and generated receivable statement DTOs.
- `MER-ASSET-002`: the asset center renders ordinary, fallback-retail and
  seckill-classified orders with frozen base/concession/net values, current
  lifecycle, journal IDs and settlement request/transfer-intent/final execution
  linkage.
- Cross-tenant merchant or settlement-wallet responses and authorization
  failures close only the statement surface. The browser never calculates
  receivables or an extra seckill share, and test fixtures stay outside the
  production bundle.

## Settlement Admin .16 Consumer Boundary

- `@abu24k/core-artifacts@2.0.0-settlement-admin.16` preserves the existing
  Merchant settlement intent, wallet-signed request and tenant-scoped history
  operations without changing Merchant fulfillment or fund calculations. The
  exact buyer NPL quote remains Core-signed; Merchant neither consumes an
  on-chain TWAP field nor calculates a payment amount.
- Admin-wide settlement reads, governed intents, coverage-breaker recovery and
  global catalog/order lifecycle batches remain Admin-only. Notification feed,
  endpoint registration and Admin campaign operations are also excluded because
  Merchant has no notification-page PRD. The Merchant client exposes none of
  these published operation IDs.
- This is `ADM-NOTIFY-001` artifact consumer evidence only. It completes no
  Merchant Requirement ID and adds no parallel endpoint, page, production
  fixture or browser-side amount calculation.

## Settlement Admin .11 Takeover Fulfillment Evidence

- `MER-FUL-004`: the current replacement merchant consumes the assigned-case
  queue/detail, encrypted fulfillment target, Core tracking evidence and the
  existing shipment command. Shipment requires both `FUNDED` and enabled
  `RECORD_SHIPMENT`.
- `MER-ASSET-004` assigned-case slice: current assignment/version/evidence and
  takeover state render directly from Core without browser-side funding or
  compensation calculations.
- Cross-tenant rows, revoked assignments, unfunded cases and unavailable target
  decryption fail closed. Test fixtures remain outside the production bundle.

## Completion Rule

`Verified` requires real product code plus the listed automated evidence against
the same coordinated Core batch, or the explicitly required real account/device
evidence. A disabled control, empty API/action catalog, static screen or fixture,
review-only bypass, `ConfigurationRequired` display or other fail-closed
placeholder is blocked progress and never completes a Requirement. While a Core
gap remains unpublished, product work may record only `Requirement ID + required
capability + fail-closed behavior`; after publication it must be replaced by the
real consumer path and tests.
