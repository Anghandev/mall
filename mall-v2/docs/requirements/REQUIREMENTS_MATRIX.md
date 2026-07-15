# Mall V2 Frozen Requirement Matrix

Authority: `PRD-7.5.01.txt`, `SOURCE.md`, `../../../docs/V2_SYSTEM_CONTRACT.md`
and `../../../docs/V2_DECISIONS.md`.

This is a traceability index, not a second PRD. `Frozen` means accepted for
implementation but not yet implemented. `Overridden` preserves a conflicting
source clause and points to the binding Decision ID. `DecisionBlocked` and
`ExternalBlocked` never authorize a guessed value or simulated success.

| Requirement ID | Source lines | Field/state/action coverage | Decision | Acceptance and evidence target | Status | Core gap |
|---|---:|---|---|---|---|---|
| MAL-SRC-001 | 1 | PRD title/version identity | - | Local source hash equals SOURCE record | Frozen | - |
| MAL-OVR-001 | 4 | Payment lock, prize timing, 7-day receipt request, 7-day no-shipment handling and source withdrawal wording | D-V2-004, D-V2-005, D-V2-006, D-V2-007, D-V2-008 | No refund action exists; no-shipment creates takeover; merchant force-receipt is request-only; transferable assets use gasless signed settlement requests after frozen finality; BNM remains backend points | Overridden | GAP-MAL-006, GAP-MAL-008 |
| MAL-SHELL-001 | 5-10 | Embedded mobile DApp; persistent Seckill/Mall/Stores/Assets tabs; each listed tab capability | - | Four tabs remain reachable and preserve view state | Frozen | GAP-MAL-002 |
| MAL-SEK-001 | 11-17 | PREHEAT, LIVE, SETTLING 5-10 min, SETTLED; countdown, dashboard, rule/history/payment buttons, pool, 30s modal, winner/non-winner variants, daily-buy transition | D-V2-007, D-V2-013 | Every phase has distinct copy/actions; prize becomes Available only after final session settlement and its action is a gasless signed settlement request | Frozen | GAP-MAL-004, GAP-MAL-015 |
| MAL-SEK-002 | 18-21 | Large/bold SlideUpFade wall, exact +30s event copy, WebSocket event insertion | D-V2-013 | Ordered/deduped event stream, reconnect/cursor recovery, reduced-motion fallback | Verified | - |
| MAL-SEK-003 | 22-24 | Main and relay timers; 60-minute main; source 60-minute relay; +30s after final TxHash | D-V2-013 | Main 60 min; relay initial/cap 60 sec; +30 sec per final purchase; never past main deadline | Verified | - |
| MAL-SEK-004 | 25-34 | Rules button/modal/acknowledgement; chain timestamp; fallback retail classification; dual approval wording; 70% USDT + 30% NPL and 1:1 backend-BNM wording | D-V2-002, D-V2-008, D-V2-011, D-V2-012, D-V2-017 | Modal shows both five-minute signed quotes, Router classification rule and exact payment intents; BNM is backend points shown as Locked until fulfillment and never as a token payout | Overridden | GAP-MAL-003, GAP-MAL-004 |
| MAL-CAT-001 | 35-39 | Horizontal multilevel categories, product waterfall, BNM badge, seckill overlay and route | - | Category filtering works; active seckill blocks ordinary checkout | Frozen | GAP-MAL-002, GAP-MAL-004 |
| MAL-CAT-002 | 40-42 | Product detail, sticky Buy action, seckill-disabled state, SlideUp configuration sheet | - | Action remains reachable and follows authoritative product state | Frozen | GAP-MAL-002 |
| MAL-CHK-001 | 43-49 | Confirmation prerequisite; SKU matrix/manual selection; +/- quantity; delivery/pickup; default full address fields; empty-address guidance; nearest store/address/hours/detail | D-V2-002, D-V2-012, D-V2-021 | No confirmation without valid SKU, quantity, mode and authoritative address/store; exact 70/30 legs, Oracle snapshot, five-minute expiry and totals come only from the signed Core quote | Frozen | GAP-MAL-003, GAP-MAL-006, GAP-MAL-010 |
| MAL-STORE-001 | 50-53 | Country/city/district selectors; GPS 1.2km display; Call and Navigation buttons; JSBridge AMap/Baidu launch | - | Browser/local tests cover permission, loading, denial, unavailable, deep-link generation and fallback states; real-device proof is tracked only by MAL-GOAL-004 | Frozen | GAP-MAL-010 |
| MAL-ASSET-001 | 54-64 | Assets shell; avatar, nickname, account ID, address entry; four order groups/counts; View All | - | Profile and canonical counts render from Core projection | Frozen | GAP-MAL-007 |
| MAL-ASSET-002 | 65-70 | Seckill/shopping tabs; session number; exact 70% USDT + 30% NPL payment; Locked BNM; winner/prize and non-winner states | D-V2-002, D-V2-007, D-V2-008 | Exact integer/canonical payment amounts render from Core; prize exposes Locked/Available/Requested/Batched/Settled and final Safe TxHash; BNM exposes only Locked/Available | Frozen | GAP-MAL-007, GAP-MAL-015 |
| MAL-ASSET-003 | 71-74 | Source BNM totals, provenance link and withdrawal control | D-V2-008 | BNM is existing backend points with only Locked and Available totals plus order/fulfillment provenance; no token address, mint, Safe transfer or on-chain withdrawal action is rendered | Verified | - |
| MAL-ASSET-004 | 76-78 | Genesis 2% NPL, lifecycle totals, credential visibility and source withdrawal control | D-V2-007, D-V2-009, D-V2-010, D-V2-023 | Hidden for ordinary users; signed payment snapshot and fulfillment finality govern availability; wallet signs a settlement request and UI tracks Requested/Batched/Settled plus Safe TxHash | Verified | - |
| MAL-ASSET-005 | 80-82 | Regional NPL totals, receipt/arbitration explanation and source withdrawal control | D-V2-006, D-V2-007, D-V2-009, D-V2-023 | Four regional roles use the signed snapshot; arbitration remains Disputed/Locked; available NPL follows signed request, Safe batch and 15-confirmation settlement | Verified | - |
| MAL-ASSET-006 | 84-86 | Direct-referral 1% NPL totals, source next-block wording and withdrawal control | D-V2-007, D-V2-009, D-V2-010, D-V2-023 | No self/cycle; 1% remains Locked until fulfillment finality, then uses the gasless signed request and Safe-batch lifecycle | Verified | - |
| MAL-ASSET-007 | 88-90 | Operations 4% NPL totals, source daily multisig wording and operation-only withdrawal control | D-V2-007, D-V2-009, D-V2-014, D-V2-023 | 4% uses the immutable payment snapshot; eligible operations wallets sign requests and track Requested/Batched/Settled with final Safe TxHash | Verified | - |
| MAL-ADDR-001 | 93-101 | Paste textarea; name/phone/province-city-district/detail parsing; 11-digit phone; review modal exact fields/copy; missing-field red error; edit/delete/default | - | PII-safe parser and CRUD; incomplete parse cannot silently save | Frozen | GAP-MAL-007, GAP-MAL-011 |
| MAL-ORDER-001 | 102-107 | Pending Payment/Shipment/Receipt/After-sale groups; seckill badge; inline carrier/latest logistics; Support/Exchange and Confirm Receipt buttons | - | Actions render only from allowedActions; loading/empty/error states covered | Frozen | GAP-MAL-006, GAP-MAL-007 |
| MAL-AFTER-001 | 108-111 | No no-reason action; Exchange or Delay only; arbitration state and linked reward lock | D-V2-004, D-V2-006, D-V2-007 | No business-refund entry point; arbitration is Disputed and retains payment, BNM and every transferable reward as Locked, with no settlement request action | Frozen | GAP-MAL-006, GAP-MAL-008 |
| MAL-TRACK-001 | 112-118 | Seckill product/session/input/result; source USDT prize withdrawal; Locked BNM amount | D-V2-007, D-V2-008, D-V2-013, D-V2-023 | Prize becomes Available only after final session settlement, then follows signed request and Safe-batch states; BNM remains backend points with only Locked/Available | Overridden | GAP-MAL-007, GAP-MAL-015 |
| MAL-TRACK-002 | 119-122 | Ordinary shopping rows; `+ BNM` pending release; released state | D-V2-006, D-V2-008 | BNM changes only from Locked to Available after authoritative fulfillment finality; no token payout or transferable-asset state is implied | Overridden | GAP-MAL-007 |
| MAL-RWD-001 | 123-127 | Reward-center layout and lifecycle metrics | D-V2-007, D-V2-008, D-V2-023 | Each transferable rail exposes exact Locked/Available/Requested/Batched/Settled amounts and final Safe TxHash; BNM exposes only Locked/Available backend-point totals | Verified | - |
| MAL-RWD-002 | 128-130 | BNM source, Locked/Available rule, source withdrawal control and provenance TxHash/timestamp | D-V2-008 | Order-linked backend BNM exposes Locked/Available and payment/fulfillment provenance only; V2 renders no ERC-20, mint, Safe payout or on-chain withdrawal action | Verified | - |
| MAL-RWD-003 | 131-134 | Genesis credential visibility; 2% NPL; source session-timing and withdrawal/Gas wording | D-V2-007, D-V2-009, D-V2-010, D-V2-023 | Payment snapshot plus fulfillment finality govern Locked/Available; ordinary wallets see no module; eligible wallets sign gasless settlement requests and track Safe batch finality | Verified | - |
| MAL-RWD-004 | 135-137 | Direct-referral shop 1% NPL; source next-block availability and withdrawal/Gas wording | D-V2-007, D-V2-009, D-V2-010, D-V2-023 | No self/cycle; payment snapshot and fulfillment finality govern availability; settlement is a gasless signed request, never a direct wallet transaction | Verified | - |
| MAL-RWD-005 | 138-141 | District 1.2%, city .8%, province .6%, region .4%; receipt/platform arbitration; source withdrawal/Gas wording | D-V2-006, D-V2-007, D-V2-009, D-V2-023 | Signed region snapshot and finality govern exact allocation; Disputed remains Locked; each available payout follows Requested/Batched/Settled with final Safe TxHash | Verified | - |
| MAL-RWD-006 | 142-144 | Operations 4%; multiple weighted addresses; source daily distribution and multisig withdrawal | D-V2-007, D-V2-009, D-V2-014, D-V2-023 | The 4% payment snapshot and Core ledger govern availability; eligible operations wallets sign requests and Safe MultiSend settles after 15 confirmations | Verified | - |
| MAL-STOCK-001 | 145-148 | Pay-before inventory check; SKU/quantity; exact sold-out error message | D-V2-017 | Signed reservation, not a read-only check, prevents oversell; error is actionable | Overridden | GAP-MAL-003 |
| MAL-REVIEW-001 | 149-157 | Full-screen final review; product/SKU, quantity/total, fulfillment, full delivery fields or store/address/notice, immutable-region warning, Confirm Address/Specs and Pay/Broadcast buttons | D-V2-002, D-V2-017 | Five factors bind the reservation and signed quotes; no local recomputation | Frozen | GAP-MAL-003, GAP-MAL-004 |
| MAL-REGION-001 | 158-159 | Pickup store province/city/district binding and regional beneficiary attribution | D-V2-010, D-V2-017 | Signed store region is immutable in the order snapshot | Frozen | GAP-MAL-003, GAP-MAL-010 |
| MAL-WALLET-001 | 160-164 | Pay/Broadcast button; exact 70% USDT then 30% NPL Router payment; unlimited first approval; allowance recheck/revocation fallback | D-V2-001, D-V2-002, D-V2-003, D-V2-012 | UI verifies chain 56, published Router spender and five-minute signed intent; each insufficient allowance defaults to MaxUint256 only after risk/revocation disclosure, while sufficient allowance is not repeated | Overridden | GAP-MAL-001, GAP-MAL-004 |
| MAL-TX-001 | 165-169 | Seckill/ordinary/boundary result modal; +30s copy; backend-BNM copy; WebSocket broadcast; full payment TxHash block | D-V2-003, D-V2-008, D-V2-011, D-V2-013, D-V2-017 | Submitted is not final; Router event and canonical block classify the order; +30s appears only after chain-final purchase; BNM is Locked backend points; full selectable payment explorer hash is distinct from later Safe settlement TxHash | Overridden | GAP-MAL-004, GAP-MAL-015 |
| MAL-SEC-001 | 170-174 | Reentrancy guard; atomic dual-asset payment; no business refund; source immediate/session/next-block distribution timing | D-V2-003, D-V2-004, D-V2-007, D-V2-015, D-V2-016, D-V2-023 | Frontend consumes signed intents only; PaymentRouter leaves zero balance and partial transfer reverts; rewards remain ledger Locked until finality; settlement requires signed request and Safe batch, never direct withdrawal calldata | Overridden | GAP-MAL-001, GAP-MAL-014 |
| MAL-FLOW-001 | 175-180 | Detail entry; sticky Buy; SKU/quantity; delivery/default address; pickup/nearest store; Confirm Order | - | Flow is ordered, resumable and preserves configuration | Frozen | GAP-MAL-002, GAP-MAL-003 |
| MAL-FLOW-002 | 181-186 | Inventory preflight under 200ms; exact insufficient-stock feedback; five-factor review; allowance; wallet payment; TxHash | D-V2-017 | Reservation expiration/concurrency and pending finality are explicit | Frozen | GAP-MAL-003 |
| MAL-FLOW-003 | 187-192 | Every beneficiary ledger starts Locked; receipt/pickup/final arbitration; completion, availability and source one-click withdrawal | D-V2-006, D-V2-007, D-V2-008, D-V2-017, D-V2-023 | No release before fulfillment finality; transferable assets progress Locked/Available/Requested/Batched/Settled through signed requests and Safe finality; BNM progresses only Locked/Available | Overridden | GAP-MAL-006 |
| MAL-GOAL-001 | Final Goal | React + TypeScript Web DApp; mobile full-screen; desktop max about 430px centered; 375/393/430 acceptance | - | Typecheck plus Playwright at required widths with no overlap/overflow | Frozen | GAP-MAL-002 |
| MAL-GOAL-002 | Final Goal | Wallet connect, wrong chain, rejection, MaxUint256 disclosure/revocation, ERC-1271-compatible provider | D-V2-002, D-V2-015 | Browser consumer tests cover every wallet state | Frozen | GAP-MAL-001 |
| MAL-GOAL-003 | Final Goal | Keyboard/focus/labels/reduced motion/safe areas; no production fixtures; no business-refund or direct on-chain withdrawal entry | D-V2-004, D-V2-007, D-V2-008 | Accessibility and production-bundle negative tests prove no fixture, empty action, disabled placeholder, BNM token action or direct settlement calldata ships | Frozen | GAP-MAL-002, GAP-MAL-015 |
| MAL-GOAL-004 | Final Goal | Physical wallet, GPS, call/navigation and production HTTPS/WSS acceptance | D-V2-019 | Real wallet, mobile device, native link, provider and production-domain evidence only; local mocks cannot satisfy this row | ExternalBlocked | GAP-MAL-016 |
| MAL-GOAL-005 | Final Goal | Payment batch real Core path: product/SKU -> atomic reservation -> five-minute signed 70/30 quote -> allowance -> PaymentRouter -> indexed event -> order projection | D-V2-001, D-V2-002, D-V2-003, D-V2-011, D-V2-012, D-V2-017, D-V2-021, D-V2-028 | Mall consumer and integration tests use the published payment-batch Core artifact and real local API/indexer; inventory and both assets are atomic; no static fixture, local formula, handwritten calldata or disabled action counts | Frozen | GAP-MAL-001, GAP-MAL-003, GAP-MAL-004, GAP-MAL-015 |
| MAL-GOAL-006 | Final Goal | Transferable-asset ledger lifecycle and BNM backend-points lifecycle | D-V2-007, D-V2-008, D-V2-017, D-V2-023 | USDT/NPL/prize rows prove Locked/Available/Requested/Batched/Settled, immutable batch identity and final 15-confirmation Safe TxHash; BNM proves only Locked/Available with no ERC-20, mint, Safe transfer or on-chain withdrawal | Verified | - |

## Settlement/Admin .4 Verification Evidence

- `MAL-CAT-001`, `MAL-CAT-002` partial evidence: the Mall consumes the public
  product/SKU list, enabled three-level categories, enabled tags,
  `mainImageAssetIds`, `videoAssetId` and short-lived media-read targets from the
  same `.4` artifact. Consumer/UI tests reject inactive taxonomy, mismatched
  asset identity, non-public access, wrong resource/purpose and incompatible
  content types. These rows remain `Frozen`, not `Verified`, because the public
  `CatalogProduct` type still lacks category/tag association and authoritative
  seckill-overlay/rich-detail fields required by their full acceptance targets.

- `MAL-ORDER-001`, `MAL-AFTER-001` and `MAL-FLOW-003` partial evidence: enabled
  exchange, delay, receipt-confirmation and arbitration actions now perform the
  `.4` sequence `local SHA-256 -> write-once upload -> Core verification ->
  order evidence envelope -> matching buyer command -> order reload`. No hash
  input or business-refund action exists. These rows remain `Frozen` because
  `OPEN_TAKEOVER` has no matching published evidence action, buyer pickup
  evidence is not authorized, and the wider order/profile/takeover acceptance
  targets still have independent gaps.

- `MAL-SEK-002`, `MAL-SEK-003`: strict OpenAPI-derived HTTP operations,
  final-only event validation, HTTP replay, `eventId` deduplication, last-cursor
  reconnect and `4409` artifact reload are covered by
  `tests/core-client.test.ts`, `tests/seckill-realtime.test.ts` and
  `tests/app.test.tsx`.
- `MAL-ASSET-003` through `MAL-ASSET-007`, `MAL-RWD-001` through
  `MAL-RWD-006`, and `MAL-GOAL-006`: Core-projected `rewardSubtype`, BNM
  Locked/Available totals, eligibility-driven Genesis visibility, gasless
  settlement lifecycle and final Safe TxHash are covered by
  `tests/app.test.tsx` and the production bundle negative gate.
- Responsive evidence is `tests/e2e/mobile.spec.ts` at 375, 393 and 430 pixels
  plus the centered 430-pixel desktop frame. Test fixtures remain under
  `tests/**` and are excluded from the production bundle.

## Completion Rule

A row becomes `Verified` only with real code plus the listed automated or
external evidence. A disabled control, empty API/action catalog, static fixture,
hard-coded projection or fail-closed placeholder is evidence of incompleteness
and never counts as `Verified`. Every row that depends on Core also requires the
same coordinated artifact version to pass the Mall consumer and relevant
integration tests.
