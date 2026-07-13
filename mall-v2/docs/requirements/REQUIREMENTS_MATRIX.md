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
| MAL-OVR-001 | 4 | Payment lock, prize timing, 7-day receipt request, 7-day no-shipment handling | D-V2-004, D-V2-005, D-V2-006, D-V2-007 | No refund action exists; no-shipment creates takeover; merchant force-receipt is request-only; Claims obey frozen finality | Overridden | GAP-MAL-006, GAP-MAL-008 |
| MAL-SHELL-001 | 5-10 | Embedded mobile DApp; persistent Seckill/Mall/Stores/Assets tabs; each listed tab capability | - | Four tabs remain reachable and preserve view state | Frozen | GAP-MAL-002 |
| MAL-SEK-001 | 11-17 | PREHEAT, LIVE, SETTLING 5-10 min, SETTLED; countdown, dashboard, rule/history/payment buttons, pool, 30s modal, winner/non-winner variants, daily-buy transition | D-V2-007 | Every phase has distinct copy/actions; prize Claim only after final settlement | Frozen | GAP-MAL-004, GAP-MAL-005 |
| MAL-SEK-002 | 18-21 | Large/bold SlideUpFade wall, exact +30s event copy, WebSocket event insertion | D-V2-013 | Ordered/deduped event stream, reconnect/cursor recovery, reduced-motion fallback | Frozen | GAP-MAL-005 |
| MAL-SEK-003 | 22-24 | Main and relay timers; 60-minute main; source 60-minute relay; +30s after final TxHash | D-V2-013 | Main 60 min; relay initial/cap 60 sec; +30 sec per final purchase; never past main deadline | Overridden | GAP-MAL-005 |
| MAL-SEK-004 | 25-34 | Rules button/modal/acknowledgement; chain timestamp; fallback retail classification; dual approval wording; 1:1 BNM wording | D-V2-002, D-V2-008, D-V2-011, D-V2-017 | Modal shows frozen rules and both quotes; chain classifies; BNM is described as Locked until fulfillment | Overridden | GAP-MAL-003, GAP-MAL-004 |
| MAL-CAT-001 | 35-39 | Horizontal multilevel categories, product waterfall, BNM badge, seckill overlay and route | - | Category filtering works; active seckill blocks ordinary checkout | Frozen | GAP-MAL-002, GAP-MAL-004 |
| MAL-CAT-002 | 40-42 | Product detail, sticky Buy action, seckill-disabled state, SlideUp configuration sheet | - | Action remains reachable and follows authoritative product state | Frozen | GAP-MAL-002 |
| MAL-CHK-001 | 43-49 | Confirmation prerequisite; SKU matrix/manual selection; +/- quantity; delivery/pickup; default full address fields; empty-address guidance; nearest store/address/hours/detail | D-V2-021 | No confirmation without valid SKU, quantity, mode and authoritative address/store; totals come from signed quote | Frozen | GAP-MAL-003, GAP-MAL-006, GAP-MAL-010 |
| MAL-STORE-001 | 50-53 | Country/city/district selectors; GPS 1.2km display; Call and Navigation buttons; JSBridge AMap/Baidu launch | - | Permission/loading/denial/unavailable states and native fallbacks are tested | ExternalBlocked | GAP-MAL-010, GAP-MAL-016 |
| MAL-ASSET-001 | 54-64 | Assets shell; avatar, nickname, account ID, address entry; four order groups/counts; View All | - | Profile and canonical counts render from Core projection | Frozen | GAP-MAL-007 |
| MAL-ASSET-002 | 65-70 | Seckill/shopping tabs; session number; USDT+NPL input; Locked BNM; winner/prize and non-winner state labels | D-V2-007, D-V2-008 | Exact integer/canonical amounts and allowed prize action only | Frozen | GAP-MAL-007, GAP-MAL-009 |
| MAL-ASSET-003 | 71-74 | Three-state BNM totals, provenance link and BNM Claim button | D-V2-008 | Cumulative/Available/Locked render; Claim only for Available | Frozen | GAP-MAL-009 |
| MAL-ASSET-004 | 76-78 | Genesis 2% NPL, three totals, credential visibility, NPL Claim | D-V2-007, D-V2-009, D-V2-010 | Hidden for ordinary user; payment snapshot and fulfillment finality govern availability | Overridden | GAP-MAL-009 |
| MAL-ASSET-005 | 80-82 | Regional NPL totals, receipt/arbitration explanation and Claim | D-V2-006, D-V2-007, D-V2-009 | Four regional roles use signed snapshot and finality | Frozen | GAP-MAL-009 |
| MAL-ASSET-006 | 84-86 | Direct-referral 1% NPL totals, source next-block wording and Claim | D-V2-007, D-V2-009, D-V2-010 | 1% remains Locked until fulfillment finality | Overridden | GAP-MAL-009 |
| MAL-ASSET-007 | 88-90 | Operations 4% NPL totals, source daily multisig wording and operation-only Claim | D-V2-007, D-V2-009 | 4% is snapshotted and not claimable before fulfillment finality | Overridden | GAP-MAL-009 |
| MAL-ADDR-001 | 93-101 | Paste textarea; name/phone/province-city-district/detail parsing; 11-digit phone; review modal exact fields/copy; missing-field red error; edit/delete/default | - | PII-safe parser and CRUD; incomplete parse cannot silently save | Frozen | GAP-MAL-007, GAP-MAL-011 |
| MAL-ORDER-001 | 102-107 | Pending Payment/Shipment/Receipt/After-sale groups; seckill badge; inline carrier/latest logistics; Support/Exchange and Confirm Receipt buttons | - | Actions render only from allowedActions; loading/empty/error states covered | Frozen | GAP-MAL-006, GAP-MAL-007 |
| MAL-AFTER-001 | 108-111 | No no-reason action; Exchange or Delay only; arbitration state and linked reward lock | D-V2-004, D-V2-006 | No business-refund entry point; arbitration retains Locked projection | Frozen | GAP-MAL-006, GAP-MAL-008 |
| MAL-TRACK-001 | 112-118 | Seckill product/session/input/result; USDT prize Claim; Locked BNM amount | D-V2-007, D-V2-008 | Prize Claim follows final session settlement; BNM remains Locked until fulfillment | Overridden | GAP-MAL-007, GAP-MAL-009 |
| MAL-TRACK-002 | 119-122 | Ordinary shopping rows; `+ BNM` pending release; released state | D-V2-006, D-V2-008 | State changes only after authoritative fulfillment finality refresh | Frozen | GAP-MAL-007, GAP-MAL-009 |
| MAL-RWD-001 | 123-127 | Reward-center layout; cumulative, Available and Locked metrics | - | Every reward rail exposes all three exact metrics | Frozen | GAP-MAL-009 |
| MAL-RWD-002 | 128-130 | BNM source, Locked/Available rule, BNM Claim, provenance TxHash/timestamp | D-V2-008 | Order-linked BNM follows frozen lifecycle | Frozen | GAP-MAL-009 |
| MAL-RWD-003 | 131-134 | Genesis credential visibility; 2% NPL; source session-timing copy; node Claim/Gas | D-V2-007, D-V2-009, D-V2-010 | Payment snapshot plus fulfillment finality; ordinary wallets see no module | Overridden | GAP-MAL-009 |
| MAL-RWD-004 | 135-137 | Direct-referral shop 1% NPL; source next-block availability; Claim/Gas | D-V2-007, D-V2-009, D-V2-010 | No self/cycle; payment snapshot; fulfillment finality | Overridden | GAP-MAL-009 |
| MAL-RWD-005 | 138-141 | District 1.2%, city .8%, province .6%, region .4%; receipt/platform arbitration; Claim/Gas | D-V2-006, D-V2-007, D-V2-009 | Signed region snapshot and finality govern exact allocation | Frozen | GAP-MAL-009 |
| MAL-RWD-006 | 142-144 | Operations 4%; multiple weighted addresses; source daily distribution and multisig withdrawal | D-V2-007, D-V2-009, D-V2-014 | 4% payment snapshot; availability after fulfillment; policy publishing is governed | Overridden | GAP-MAL-009 |
| MAL-STOCK-001 | 145-148 | Pay-before inventory check; SKU/quantity; exact sold-out error message | D-V2-017 | Signed reservation, not a read-only check, prevents oversell; error is actionable | Overridden | GAP-MAL-003 |
| MAL-REVIEW-001 | 149-157 | Full-screen final review; product/SKU, quantity/total, fulfillment, full delivery fields or store/address/notice, immutable-region warning, Confirm Address/Specs and Pay/Broadcast buttons | D-V2-002, D-V2-017 | Five factors bind the reservation and signed quotes; no local recomputation | Frozen | GAP-MAL-003, GAP-MAL-004 |
| MAL-REGION-001 | 158-159 | Pickup store province/city/district binding and regional beneficiary attribution | D-V2-010, D-V2-017 | Signed store region is immutable in the order snapshot | Frozen | GAP-MAL-003, GAP-MAL-010 |
| MAL-WALLET-001 | 160-164 | Pay/Broadcast button; USDT then NPL then payment; unlimited first approval; allowance recheck/revocation fallback | D-V2-001, D-V2-002 | Zero legs omitted; each insufficient leg defaults to MaxUint256 after disclosure | Frozen | GAP-MAL-001, GAP-MAL-004 |
| MAL-TX-001 | 165-169 | Seckill/ordinary/boundary result modal; +30s copy; BNM copy; WebSocket broadcast; full TxHash block | D-V2-008, D-V2-011, D-V2-013, D-V2-017 | Submitted is not final; authoritative classification and Locked BNM wording; full selectable explorer hash | Overridden | GAP-MAL-005, GAP-MAL-012 |
| MAL-SEC-001 | 170-174 | Reentrancy guard; no business refund; no same-transaction rewards except Burn; source session/next-block distribution timing | D-V2-003, D-V2-004, D-V2-007, D-V2-015 | Frontend consumes intents only; reward availability follows frozen finality | Overridden | GAP-MAL-001, GAP-MAL-009 |
| MAL-FLOW-001 | 175-180 | Detail entry; sticky Buy; SKU/quantity; delivery/default address; pickup/nearest store; Confirm Order | - | Flow is ordered, resumable and preserves configuration | Frozen | GAP-MAL-002, GAP-MAL-003 |
| MAL-FLOW-002 | 181-186 | Inventory preflight under 200ms; exact insufficient-stock feedback; five-factor review; allowance; wallet payment; TxHash | D-V2-017 | Reservation expiration/concurrency and pending finality are explicit | Frozen | GAP-MAL-003, GAP-MAL-012 |
| MAL-FLOW-003 | 187-192 | Every beneficiary ledger starts Locked; receipt/pickup/final arbitration; Completed and Available states; one-click Claim | D-V2-006, D-V2-007, D-V2-017 | No release before fulfillment finality; claims use allowedActions and ordered intents | Frozen | GAP-MAL-006, GAP-MAL-009 |
| MAL-GOAL-001 | Final Goal | React + TypeScript Web DApp; mobile full-screen; desktop max about 430px centered; 375/393/430 acceptance | - | Typecheck plus Playwright at required widths with no overlap/overflow | Frozen | GAP-MAL-002 |
| MAL-GOAL-002 | Final Goal | Wallet connect, wrong chain, rejection, MaxUint256 disclosure/revocation, ERC-1271-compatible provider | D-V2-002, D-V2-015 | Browser consumer tests cover every wallet state | Frozen | GAP-MAL-001, GAP-MAL-012 |
| MAL-GOAL-003 | Final Goal | Keyboard/focus/labels/reduced motion/safe areas; no production fixtures; no business-refund entry | D-V2-004 | Accessibility and production-bundle negative tests pass | Frozen | GAP-MAL-002 |
| MAL-GOAL-004 | Final Goal | Physical wallet, GPS, call/navigation and production HTTPS/WSS acceptance | D-V2-019 | Real device/provider evidence only | ExternalBlocked | GAP-MAL-016 |

## Completion Rule

A row becomes `Verified` only with real code plus the listed automated or
external evidence. Every row that depends on Core remains fail closed until the
same coordinated artifact version passes the Mall consumer test.
