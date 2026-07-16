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
| MER-AUTH-003 | 11 | Secondary wallet signature for printer and region changes | D-V2-014, D-V2-015 | Exact resource/old-new values/digest/expiry are signed; Safe gate applies where policy requires | Frozen | GAP-MER-002 (region changes only; printer binding is live) |
| MER-DASH-001 | 12-16 | Default full-screen dashboard; minute-level single-shop data; pending shipment count and drilldown to module 03 | - | Authoritative day boundary and count; no zero-as-unavailable | Verified | - |
| MER-DASH-002 | 17 | Today 00:00-24:00 chain-final buyer payments and merchant USDT base/net receivable | D-V2-021, D-V2-022 | Core supplies the authoritative timezone, exact payment total and separate signed receivable projection | Verified | - |
| MER-DASH-003 | 18-19 | Unique-product status: Draft, PendingReview, Scheduled, Live, SoldOut/Delisted | - | Unknown status fails closed; labels use generated enum | Verified | - |
| MER-DASH-004 | 20 | Today's successful pickup-scan count across merchant stores | - | Count links to canonical pickup evidence | Verified | - |
| MER-PROD-001 | 21-24 | One-shop-one-product; no list; one unique maintenance form | - | API and UI both enforce one product slot | Verified | - |
| MER-PROD-002 | 25 | Title max 60, 1-5 main images and rich detail | - | Field validation and signed upload metadata tests | Verified | - |
| MER-PROD-003 | 26-28 | SKU name such as size/color, USDT merchant base receivable, positive integer seckill inventory entered once, delivery/pickup multiselect | D-V2-002, D-V2-021 | Core supplies canonical decimal/atomic amounts; invalid amount, inventory or fulfillment mode blocks submit | Verified | - |
| MER-PROD-004 | 29-30 | PendingReview/Scheduled/Live write lock; Save/Modify/Delist disabled; Core Update forbidden; exact locked-product error | D-V2-017 | UI and Core reject every product write while locked | Verified | - |
| MER-PROD-005 | 31 | Unlock only after settled/sold out or platform delist; SoldOut/Delisted enables edit/clear/new product | - | Transition comes from Core allowedActions, never local time | Verified | - |
| MER-PROD-006 | New Goal | Merchant concession from 0-100%; buyer 70/30 remains unchanged; preview base receivable, concession, net receivable and platform/prize-pool/node/configured destinations | D-V2-002, D-V2-021, D-V2-022 | Submit requires a signed Core preview whose version, exact integer amounts and destination totals reconcile; frontend never calculates weights or authoritative amounts | Verified | - |
| MER-FUL-001 | 32-34 | Seckill and ordinary orders; no merchant repricing; no customer self-refund | D-V2-004 | Merchant surface contains no business-refund control | Verified | - |
| MER-FUL-002 | 35-38 | Time/SKU/status/mode filters; Export Excel; exact fields order no., TxHash, consignee, phone, full address, quantity, order time, tracking no., verification status | - | Server-side paginated export is PII-authorized and audit logged | Verified | - |
| MER-FUL-003 | 39-42 | Feie/Yilianyun adapter; batch electronic waybill printing; pickup scan creates one two-copy receipt job | D-V2-019, D-V2-021 | Local adapter, validation, idempotency, retry/error handling and typed ConfigurationRequired paths are implemented and tested; real account/device evidence remains MER-GOAL-003 | Verified | - |
| MER-FUL-004 | 43-45 | Delivery tab; batch/single Ship action; valid tracking input or electronic generation; order state update | D-V2-007, D-V2-017 | Idempotent shipment evidence and verified provider callback update fulfillment only; shipment cannot directly release, request or settle an asset | Verified | - |
| MER-FUL-005 | 46-47 | Pickup tab fields: order no., bound verification store, PendingPickup/Verified, verification time | - | Camera/manual verification binds signed challenge and store | Verified | - |
| MER-FUL-006 | 48-52 | Source delivered/manual merchant completion and one-block release; pickup scan; Locked to Available | D-V2-006, D-V2-007, D-V2-008, D-V2-017 | Merchant can only request forced receipt after 7 days; platform reviews; fulfillment finality makes transferable proceeds/rewards Available and BNM backend points Available, without a BNM token or Claim | Overridden | GAP-MER-018 (BNM conformance evidence) |
| MER-STORE-001 | 53-57 | Store CRUD scope; name, photos, hours, phone and precise coordinates | - | Required fields, upload ownership and loading/error states tested | Verified | - |
| MER-STORE-002 | 58-60 | Six-digit national region code; AMap reverse geocode; example 210211; permanent lock; pickup regional-beneficiary binding | D-V2-010, D-V2-014, D-V2-017 | No manual region fallback; signed region; later move creates replacement store | Verified | - |
| MER-STORE-003 | 61 | Physical receipt printer Device ID binding and automatic pickup receipt | D-V2-014, D-V2-019, D-V2-021 | Local device adapter, binding validation, secondary-signature intent, retry/error handling and typed ConfigurationRequired are tested; physical printer evidence remains MER-GOAL-003 | Verified | - |
| MER-ASSET-001 | 62-65 | Financial/reward center; Today plus Locked/Available/Requested/Batched/Settled transferable-asset dashboard and final Safe transaction history | D-V2-007, D-V2-021, D-V2-023 | USDT merchant proceeds remain a separate canonical liability rail; every state and final Safe TxHash comes from Core | Verified | - |
| MER-ASSET-002 | 66-70 | Natural-day sales; Locked during shipment/transit/pickup; Available after fulfillment finality; Requested, Batched and cumulative Settled | D-V2-006, D-V2-007, D-V2-017, D-V2-023 | Exact Core projection links each state to orders, journal evidence, settlement request, immutable batch and 15-confirmation Safe finality; no frontend netting or premature release | Frozen | GAP-MER-001 (per-order journal linkage) |
| MER-ASSET-003 | 71-76 | Seckill revenue detail; store NPL payable in five settlement states; BNM backend-points total with Locked/Available tracking only | D-V2-007, D-V2-008, D-V2-009, D-V2-023 | All eight generated NPL reward subtypes and Core-projected BNM Locked/Available totals render without frontend aggregation; USDT, NPL and BNM rails never merge; BNM has no ERC-20, Safe transfer, Gas, mint, settlement action or on-chain Claim | Overridden | GAP-MER-013 (seckill revenue detail only) |
| MER-ASSET-004 | New Goal | 1,000 USDT minimum guarantee; major-loss order guarantee -> frozen receivables -> future proceeds; listing, new orders and settlement requests freeze when required | D-V2-005, D-V2-018, D-V2-020, D-V2-021 | Core projects exact guarantee/debt evidence and allowedActions; below-minimum and takeover states block product listing, new orders and merchant settlement requests without affecting buyer prize eligibility | Frozen | GAP-MER-004 |
| MER-CLAIM-001 | 77-78 | Gasless wallet-signed request to settle Available merchant USDT into the bound settlement wallet | D-V2-007, D-V2-015, D-V2-023 | Request is wallet/asset/amount bound, nonce-protected, expiring and idempotent; merchant signs but never broadcasts a Safe transaction or pays settlement Gas | Verified | - |
| MER-CLAIM-002 | 79-85 | Settlement columns: request time, asset, exact amount, Requested/Batched/Settled status, batch ID, final Safe TxHash/explorer | D-V2-007, D-V2-017, D-V2-023 | Generated states and full values reconcile to the immutable Safe batch and 15-confirmation finality; Safe Gas is platform evidence, not a merchant charge | Verified | - |
| MER-CLAIM-003 | 86-97 | Source example rows reinterpreted as Requested, Batched and Settled settlement-request examples | D-V2-007, D-V2-023 | Examples exist only as test fixtures; tests cover batch failure/replacement/reorg and final Safe TxHash, and production bundles contain no sample records or simulated success | Overridden | - |
| MER-SET-001 | 98-103 | Settings scope; shop name, Logo; bound contact/settlement wallet immutable by ordinary edit | D-V2-014, D-V2-015 | GET/PUT uses optimistic version plus stable idempotency; Logo uses owned provider-sealed MERCHANT_LOGO media; settlement wallet is read-only and absent from the PUT body | Verified | - |
| MER-AUD-001 | 104-106 | Append-only reverse-time sensitive-action log; time/type/module/detail/signature-hash columns | D-V2-014, D-V2-017 | Tenant-scoped reverse-time entries, filters, cursor, signature hash, entry hash and Safe/chain TxHash come from Core; PARTIAL_PRE_MERCHANT_SCOPE is explicit | Verified | - |
| MER-AUD-002 | 107-110 | Bounded CSV export plus externally blocked physical printer evidence | D-V2-007, D-V2-023 | Production downloads the exact Core CSV for a required <=31-day, <=1000-row tenant scope; empty/error/permission states fail closed; physical printer remains ExternalBlocked without a production fixture | Verified | MER-GOAL-003 (physical acceptance only) |
| MER-HELP-001 | 111-115 | Help module, current platform seckill rules rich text | D-V2-013, D-V2-014 | Content version matches published policyVersion | Verified | - |
| MER-HELP-002 | 116 | One-product lock, no fake tracking, brush-order penalty, 1,000 USDT guarantee minimum and takeover/debt consequences | D-V2-005, D-V2-018, D-V2-020 | Copy states guarantee -> frozen receivables -> future proceeds, plus listing/new-order/settlement-request freezes, without inventing a deduction cap | Verified | - |
| MER-GOAL-001 | Final Goal | Real runtime for modules 00-07; desktop/tablet/mobile responsive layout; keyboard/focus/labels; complete loading/empty/error/disabled/offline states | D-V2-021 | Type, consumer, accessibility and Playwright tests exercise working reads and allowed writes; disabled, empty, static or review-only surfaces do not satisfy a module | Frozen | GAP-MER-001 |
| MER-GOAL-002 | Final Goal | Production build has no fixture; shared batch artifacts only; no parallel endpoint/schema/calldata/amount logic; all published Core capabilities are actually consumed | D-V2-021, D-V2-023 | Production-bundle negative scan, same-version consumer tests and real local Core integration pass; empty action catalogs, fail-closed placeholders and simulated success are not completion evidence | Frozen | GAP-MER-001 |
| MER-GOAL-003 | Final Goal | Real AMap, Kuaidi100/Cainiao, Feie/Yilianyun, existing BNM backend, authorized merchant wallet, provider account and physical device acceptance | D-V2-019 | Real account, credential, wallet, printer and device evidence only; local adapters and typed ConfigurationRequired paths must already pass before external acceptance | ExternalBlocked | GAP-MER-018 |

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
  preserved signed printer binding. `pnpm --filter @abu24k/merchant check`
  passes 79 tests, typecheck, production build and the no-fixture bundle guard.
- Production AMap/object-storage credentials and network, an authorized merchant
  wallet, and real printer accounts/devices remain `ExternalBlocked` acceptance
  under `MER-GOAL-003`; no production fixture or simulated provider success is
  counted as evidence for those external conditions.

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

## Completion Rule

`Verified` requires real product code plus the listed automated evidence against
the same coordinated Core batch, or the explicitly required real account/device
evidence. A disabled control, empty API/action catalog, static screen or fixture,
review-only bypass, `ConfigurationRequired` display or other fail-closed
placeholder is blocked progress and never completes a Requirement. While a Core
gap remains unpublished, product work may record only `Requirement ID + required
capability + fail-closed behavior`; after publication it must be replaced by the
real consumer path and tests.
