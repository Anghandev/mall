# 24K Product Requirements Matrix

Frozen: 2026-07-13

Sources:

- `test-artifacts/requirements/qingque-mall.txt`
- `test-artifacts/requirements/qingque-merchant.txt`
- `test-artifacts/requirements/qingque-admin.txt`
- Goal override: every USDT payment, price, refund and GMV requirement is implemented as NPL-only.

Status is restricted to `Done`, `Partial`, `Missing`, or `ExternalBlocked`. This matrix is the only full requirements audit for the implementation phase. No new requirement may be added unless it is present in a source document or fixes a P0 funds, authorization, or consistency defect.

## Customer App

| requirementId | Original requirement | Acceptance criteria | Code evidence | Test evidence | Status | Blocker |
|---|---|---|---|---|---|---|
| MALL-001 | Four bottom tabs: seckill, mall, stores, assets | All four tabs are reachable and preserve app state | `App.tsx`; `src/components/BottomTabs.tsx` | `scripts/check-app-ux.mjs` | Done | None |
| MALL-002 | Embedded DApp wallet connection | Connect, disconnect, account change and BSC switch work in a mobile wallet | `App.tsx`; `src/config/web3.ts`; Reown AppKit | `DEVICE_UX_CHECKLIST.md` | ExternalBlocked | Reown project id and physical wallet test |
| MALL-003 | Seckill phase UI | Upcoming, live, relay, settling and settled states render; settlement report blocks for 30 seconds | `src/screens/SeckillScreen.tsx`; `dappSeckillState` | `scripts/check-app-ux.mjs` | Partial | Blocking report and winner celebration are incomplete |
| MALL-004 | Main and relay countdown | Main duration and per-purchase relay extension match chain session timestamps | `Abu24KSeckill.sol`; `SeckillScreen.tsx` | `test/Abu24KSystem.t.sol` | Done | None |
| MALL-005 | Real-time purchase wall | New purchases appear without a page refresh and reconnect with fallback | SSE stream plus polling fallback in `SeckillScreen.tsx`; server feed stream | `scripts/check-backend.mjs` | Done | SSE is accepted as the real-time transport |
| MALL-006 | Seckill rules modal | Full current CMS rules display and user can acknowledge them | `SeckillScreen.tsx`; `seckillRules` | `scripts/check-backend.mjs` | Partial | Full acknowledgement flow is incomplete |
| MALL-007 | Historical battle reports | Customer can open a report history list and inspect a report | `/api/seckill/reports`; report data in `SeckillScreen.tsx` | Backend report assertions | Missing | Customer history view is absent |
| MALL-008 | Real seckill purchase | NPL payOrder and recordPurchase broadcast from wallet and finalize on chain | `createSeckillIntent`; payment helpers; Seckill contract | Anvil checkout tests | ExternalBlocked | Mainnet contracts, NPL balance and wallet test |
| MALL-009 | Horizontal mall categories | Category rail filters products | `MallScreen.tsx`; mall-state API | App source check | Done | None |
| MALL-010 | Product waterfall cards and BNM return badge | Cards show image, NPL price, BNM return and stable layout | `MallScreen.tsx`; product assets | Screenshot checks | Partial | Return badge needs the specified visual treatment |
| MALL-011 | Seckill product lock overlay | Locked mall product cannot be bought and links to seckill | `Product.seckillLocked`; mall-state API | None | Missing | Product card does not render the overlay |
| MALL-012 | Product detail persistent buy bar | Detail view keeps total and buy action visible | `MallScreen.tsx` detail modal | App check | Partial | CTA is not a persistent bottom action bar |
| MALL-013 | SKU selection | User selects an in-stock SKU and quote uses it | Mall/cart screens; stock preflight | Local checkout E2E | Done | None |
| MALL-014 | Quantity and live total | Stepper enforces stock and updates NPL total | Mall/cart screens | Local checkout E2E | Done | None |
| MALL-015 | Delivery and pickup selection | Only supported modes can be selected and are included in final check | Mall/cart screens; fulfillment APIs | Backend and local E2E | Done | None |
| MALL-016 | Default address | Current wallet default address preselects for delivery | `App.tsx`; assets state | DApp frontend consumption check | Done | None |
| MALL-017 | Pasted address parsing and review | Parsed address is reviewed; missing fields block save | `AssetsScreen.tsx`; address parse API | Backend flow checks | Done | None |
| MALL-018 | Nearest pickup recommendation | GPS result sorts stores and nearest eligible store is recommended | Store API distance sorting | None | Partial | Customer UI does not default the nearest store |
| MALL-019 | Country-city-district filters | Three linked selectors constrain store query | Store API accepts filters | None | Missing | UI only exposes city filtering |
| MALL-020 | GPS distance | Permission, location and distance work on device | `StoresScreen.tsx`; distance API | Browser screenshot only | ExternalBlocked | Physical device permission test |
| MALL-021 | Call and navigation | Phone dialer and native map open correct store | `StoresScreen.tsx` linking actions | Checklist only | ExternalBlocked | Physical device test |
| MALL-022 | Personal center and address CRUD | Create, edit, delete, default and select are wallet-bound | Assets screen; address APIs; signed resource binding | Backend checks | Done | None |
| MALL-023 | Four order states | Pending payment, shipment, receipt and after-sale counts match orders | Assets state and order cards | Backend checks | Done | None |
| MALL-024 | Logistics summary in receipt card | Carrier, tracking number and latest event show in order card | Fulfillment API | None | Missing | Card does not consume logistics detail |
| MALL-025 | Seckill order image badge | Seckill-origin order shows product image and source badge | Order and seckill records | None | Missing | Order card lacks source/image metadata |
| MALL-026 | Confirm receipt on chain | Wallet sends completeOrder; finality releases escrow and rewards | Complete intent, polling, contracts | Anvil local E2E | ExternalBlocked | Mainnet wallet transaction test |
| MALL-027 | Exchange/delay only after-sale | No no-reason refund; exchange sends disputeOrder and waits finality; rewards stay locked | Two-phase after-sale API and Assets screen | `scripts/e2e/full-business-flow.mjs` | Done | None |
| MALL-028 | Seckill participation result | Each participation clearly shows lost or won | Seckill records API and assets rows | Backend checks | Partial | Explicit won/lost labels are incomplete |
| MALL-029 | Winner prize claim | Winner signs and broadcasts RewardLedger claim with status polling | Claim intent and assets screen | Anvil local E2E | ExternalBlocked | Mainnet RewardLedger and wallet test |
| MALL-030 | Shopping record BNM release | Record clearly shows locked BNM before receipt and released amount after | Shopping records and release preview | Backend checks | Partial | Customer record copy/state emphasis incomplete |
| MALL-031 | Reward buckets and ledger states | Required buckets expose Locked, Available, PendingClaim, Claimed and Burned | Assets state; RewardLedger | Contract and backend tests | Done | None |
| MALL-032 | Genesis credential entitlement | ERC20/ERC721/ERC1155 balance gates genesis bucket | Genesis entitlement RPC implementation | Local ERC20-style check | ExternalBlocked | Real credential contract, standard and token id |
| MALL-033 | Region binding | Delivery address or pickup store region is immutable in order authorization | Checkout/final check/order digest | Local checkout E2E | Done | None |
| MALL-034 | Stock preflight lock | Invalid SKU, region, address or stock blocks checkout | `stockPreflight`; final check | Backend tests | Done | None |
| MALL-035 | Five-factor final confirmation | Product, SKU, quantity, fulfillment and NPL quote are confirmed before wallet | Cart final-check flow | DApp backend flow | Done | None |
| MALL-036 | Allowance skip and NPL approval | Sufficient allowance skips approve; insufficient allowance sends MaxUint256 approve | Payment helpers and intent | Unit/source checks and Anvil | ExternalBlocked | Mainnet wallet tests for both branches |
| MALL-037 | Transaction result metadata | TxHash, pending, confirmations, success and failure are consistent across actions | Cart, seckill and assets polling | Local E2E | Partial | Unified final transaction presentation incomplete |
| MALL-038 | Contract security and circuit breakers | Non-reentrant funds paths, explicit pause roles and recovery actions are tested | Four Solidity contracts | Foundry suite | Done | None |
| MALL-039 | Seven-day no-shipment refund | Buyer signs request; platform forceRefund burns locked rewards and restores stock | Timeout request, admin refund, Escrow | Contract/backend tests | ExternalBlocked | Mainnet forceRefund test |
| MALL-040 | Merchant force-sign after buyer timeout | Merchant request reaches platform; platform completes only through chain intent | Settlement request APIs | Backend partial tests | Partial | Admin UI completion action and mainnet test incomplete |
| MALL-041 | CMS placements and forced update | Banner, popup, FAQ, legal and update target by region/version; failures are visible | CMS server and `CmsPlacements.tsx` | Backend CMS tests | Partial | Customer fetch failure is silently hidden |
| MALL-042 | Error/loading/empty/rejection states | API failure, empty data, chain mismatch and rejected signature never show fake success | All customer screens | App/source checks | Done | None |
| MALL-043 | Mobile wallet acceptance | All 14 device checklist items pass on production HTTPS | Device checklist/results | `device:check` currently fails | ExternalBlocked | Production URL and physical wallet |
| MALL-044 | Production customer runtime | HTTPS API/app, contracts, RPC and indexer are live | Strict gate and launch kit | Strict gate currently fails | ExternalBlocked | See external dependency register |

## Merchant Backstage

| requirementId | Original requirement | Acceptance criteria | Code evidence | Test evidence | Status | Blocker |
|---|---|---|---|---|---|---|
| MER-001 | Wallet-only login | Approved merchant signs SIWE and receives scoped JWT | Backstage common auth; server auth | Backend auth tests | Done | None |
| MER-002 | Strict EIP-4361 validation | Domain, URI, chain, nonce, issue/expiry and role resource are parsed and verified | Hand-built SIWE message/parser | Auth tests | Partial | Parser is not a strict EIP-4361 parser |
| MER-003 | Merchant whitelist | Unapproved wallet cannot receive merchant session | `ensureRoleAddressAllowed` | Backend role tests | Done | None |
| MER-004 | JWT authorization | Every merchant read/write endpoint is role-scoped | `requireRole` | Backend role tests | Done | None |
| MER-005 | Secondary signatures | Every merchant write binds action, wallet, payload, nonce and expiry | Action-intent and signature verifier | Backend tests | Done | None |
| MER-006 | Dashboard pending shipment | Today pending shipment count is correct | Merchant dashboard | Backend checks | Done | None |
| MER-007 | Dashboard NPL sales | Today and cumulative NPL sales use exact decimals | Merchant dashboard | Backend checks | Done | None |
| MER-008 | Seckill status | Assigned product reflects platform session lifecycle | Dashboard/submission state | None | Partial | Uses submission state instead of authoritative session mapping |
| MER-009 | Today pickup verification | Today pickup count and records are correct | Merchant dashboard/pickup API | Full business E2E | Done | None |
| MER-010 | One product per store | Active submission uniqueness is enforced by merchant and store | Unique index and submit API | Backend uniqueness tests | Done | None |
| MER-011 | Product title/images/rich text | Title max 60, at most five HTTPS images and sanitized detail are enforced server-side | Submission UI/API | None | Partial | Server validation incomplete |
| MER-012 | SKU matrix | At least one SKU; unique id; positive decimal price; integer nonnegative stock | Submission API | None | Missing | Payload is stored without full SKU validation |
| MER-013 | Fulfillment modes | Only delivery/pickup accepted and at least one selected | Submission API | None | Partial | Server enum validation incomplete |
| MER-014 | Listing deadlock | Pending review and active listing cannot be edited | Submission state machine | Backend tests | Done | None |
| MER-015 | Active takedown deadlock | Merchant cannot remove Scheduled/Live item; platform retains authority | Takedown API | None | Missing | Active states can request takedown |
| MER-016 | Sold-out release | SoldOut automatically releases merchant product slot | Product/submission state | None | Missing | Automatic transition absent |
| MER-017 | Delivery/pickup order tracks | Merchant list distinguishes both tracks and actions | Merchant orders UI/API | Backend E2E | Done | None |
| MER-018 | No merchant repricing/refund | No merchant API changes paid price or directly refunds buyer | Route set | Negative route checks | Done | None |
| MER-019 | Filtered Excel/CSV export | Selected filtered rows export valid CSV and XLSX | Export API | CSV/XLS XML tests | Partial | Excel output is SpreadsheetML `.xls`, not `.xlsx` |
| MER-020 | Required export fields | Quantity, order time, logistics/pickup state and delivery contact are exported | Export builder | Export tests | Partial | Field completeness and source validation incomplete |
| MER-021 | Cloud printer | Signed print job reaches provider and reports provider status | Print integration webhook | Adapter checks only | ExternalBlocked | Real printer provider credentials/device |
| MER-022 | Electronic waybill | Signed request returns real tracking number from provider | Waybill webhook adapter | Adapter checks only | ExternalBlocked | Real waybill provider credentials |
| MER-023 | Shipment entry | Paid order can be shipped once with carrier/tracking | Ship API/UI | Full business E2E | Done | None |
| MER-024 | Pickup verification | Correct store code verifies once and creates settlement request | Pickup API/UI | Full business E2E | Done | None |
| MER-025 | Two-copy pickup receipt | Verification submits exactly two real printer copies | Pickup/print code | Local logic check | ExternalBlocked | Real printer provider/device |
| MER-026 | Delivery-triggered settlement | Delivered callback creates completeOrder owner transaction within SLA | Logistics callback and settlement request | Backend checks | Partial | External owner transaction executor/SLA not complete |
| MER-027 | Pickup-triggered settlement | Pickup verification creates completeOrder owner transaction within SLA | Pickup settlement request | Backend checks | Partial | External owner transaction executor/SLA not complete |
| MER-028 | Rewards Locked to Available | Indexed OrderCompleted releases configured ledger rewards | Chain event handler/contracts | Contract/backend tests | ExternalBlocked | Mainnet contracts and indexer |
| MER-029 | Store required fields | Name, hours, phone, location and store photos are validated | Store UI/API | Partial backend checks | Partial | Photo and field validation incomplete |
| MER-030 | AMap reverse geocode | Coordinates resolve to verified region code | AMap integration | Adapter checks | ExternalBlocked | AMap key and real response |
| MER-031 | Immutable region code | Existing store region cannot be changed | Store API/schema | Backend tests | Done | None |
| MER-032 | Printer device binding | Device belongs to merchant/store and provider reports online state | Printer config | None | ExternalBlocked | Provider API and ownership validation |
| MER-033 | Five-state finance dashboard | Locked, pending, available, withdrawn and historical NPL totals reconcile | Merchant dashboard/assets | Backend checks | Done | None |
| MER-034 | Seckill income detail | Seckill rewards are separately grouped with source/session | Reward ledger UI | None | Partial | Dedicated grouping incomplete |
| MER-035 | Merchant NPL reward pool | Store-generated merchant NPL reward source is explicit and claimable | Reward ledger | Partial tests | Partial | Reward source semantics incomplete |
| MER-036 | BNM release analytics | Returned total and receipt/release rate are shown | Merchant dashboard | None | Partial | Dedicated analytics incomplete |
| MER-037 | Merchant Claim | Secondary signature, wallet transaction, finality and gas history close the claim | Claim API/UI | Local backend tests | ExternalBlocked | Mainnet RewardLedger/wallet test |
| MER-038 | Withdrawal hash and Gas | Claim history stores TxHash, gas used, price and BNB cost | Claim schema/UI | Full business E2E | Done | None |
| MER-039 | Store profile | Name, logo, support and announcement persist | Profile API/UI | Backend checks | Done | None |
| MER-040 | Settlement wallet immutability | Approved settlement wallet cannot be changed by merchant | Merchant profile/approval | Backend checks | Done | None |
| MER-041 | Merchant audit log | Separate append-only DB shows signature/hash proof for writes | Audit DB and merchant audit endpoint | Not yet stage-tested | Partial | Audit migration and fail-closed tests pending |
| MER-042 | Help center | Current seckill rules, merchant notices and penalties render | Help API/UI | Backend checks | Done | None |
| MER-043 | Role isolation | Merchant cannot access buyer/admin resources | Role middleware | Backend negative tests | Done | None |
| MER-044 | Production integrations | Signer, AMap, waybill, shipment, print and notification adapters are live | `server/integrations.mjs` | Strict gate fails | ExternalBlocked | Third-party endpoints and credentials |

## Platform Operations Backstage

| requirementId | Original requirement | Acceptance criteria | Code evidence | Test evidence | Status | Blocker |
|---|---|---|---|---|---|---|
| ADM-001 | Global AND/OR search | Exact/mixed filters for order, product, tx, wallet, UID, phone, time and state work server-side | `adminSearch` | Backend AND/OR tests | Done | None |
| ADM-002 | Batch engine | CSV/XLSX, print, modify, listing, review and soft-delete validate selected ids | Batch API/UI | Partial backend tests | Partial | XLSX and several state operations need completion |
| ADM-003 | Core dashboard metrics | Today order, NPL GMV, shipment rate and seckill count are accurate | Admin dashboard | Backend checks | Done | None |
| ADM-004 | User/merchant metrics | New wallet UID and merchant counts reconcile with auth/merchant records | Admin dashboard | Partial checks | Partial | UID lifecycle analytics incomplete |
| ADM-005 | Todo stream | Pending merchant/product/after-sale and stock warnings are actionable | Admin dashboard | Backend checks | Done | None |
| ADM-006 | Web3 risk waterline | Claims, failed tx, anomalies, blacklist and breaker state are live | Dashboard/risk APIs | Partial checks | Partial | Leverage/waterline semantics incomplete |
| ADM-007 | Infrastructure dashboard | RPC latency, Oracle deviation, Gas blocks, bot events, CPU, memory, Redis, MQ and heights are live | Ops API/UI | DB/height partial checks | Partial | Oracle, Redis/MQ metrics and disk missing |
| ADM-008 | Merchant review lifecycle | Pending, approved, rejected and blacklist views/actions work | Merchant admin API/UI | Backend tests | Done | None |
| ADM-009 | Merchant qualification fields | License, legal identity, contact and settlement wallet are validated and protected | Merchant review API | Partial tests | Partial | Complete document/PII validation incomplete |
| ADM-010 | On-chain seller whitelist | Approval returns setSeller intent and only indexed event finalizes approval | Admin approval/escrow event | Backend tests | ExternalBlocked | Mainnet owner transaction |
| ADM-011 | V1-V5 limits | Price caps and monthly seckill quotas validate and persist | Merchant-level config | Backend tests | Done | None |
| ADM-012 | Penetrating merchant dashboard | Orders, NPL flow, SLA, refunds, burn/BNM and five-state assets reconcile | Admin merchant views | Partial tests | Partial | Several derived analytics incomplete |
| ADM-013 | Three-level categories | Parent/child/depth, order, icon, enable and fee rate persist | Category API/UI | Backend checks | Done | None |
| ADM-014 | Dynamic tags | Tag library, weights and product assignment work | Tag API/UI | Backend checks | Done | None |
| ADM-015 | Category/tag deadlock | Active seckill or locked assets block disable/delete | Taxonomy API | Partial checks | Partial | Full locked-asset coverage incomplete |
| ADM-016 | Product lifecycle CRUD | Platform create/edit inventory/price and soft-delete preserve history | Product admin APIs/UI | Partial tests | Partial | Full create/edit/soft-delete matrix incomplete |
| ADM-017 | NPL-only allocation | Product and platform allocation contain no active USDT branch | Contracts/config/payment APIs | NPL scan and tests | Done | None |
| ADM-018 | Split configuration | All receivers/bps sum correctly; multisig transaction and event finalize version | Escrow split config APIs/contract | Contract/backend tests | ExternalBlocked | Production multisig transaction |
| ADM-019 | Multiple beneficiaries | Multiple addresses and weights validate and persist | Beneficiary config UI/API | Partial tests | Partial | On-chain application/reconciliation incomplete |
| ADM-020 | Claim shortcut link | Address-bound claim link is generated without exposing secrets | DApp launch/claim endpoints | Handoff checks | Done | None |
| ADM-021 | Seckill scheduling | Create, assign product, lock stock and publish intent | Seckill admin API/UI | Backend tests | Done | None |
| ADM-022 | Seckill timing controls | Main, relay initial and extension values validate against contract | Admin/API/contract | Contract tests | Done | None |
| ADM-023 | Emergency force close | Secondary signature plus owner tx; indexed event finalizes close | Seckill admin/contract | Contract/backend tests | ExternalBlocked | Mainnet owner transaction |
| ADM-024 | Prize pool injection | Exact NPL transfer intent and ledger credit are auditable | Prize pool API/UI | Backend tests | ExternalBlocked | Mainnet NPL and owner wallet |
| ADM-025 | Unified rules editor | Published rules appear in customer and merchant surfaces | CMS/rules API/UI | Backend tests | Done | None |
| ADM-026 | High-Gas protection | Contract maxGasPrice and off-chain wallet lock are configured/audited | Seckill contract/risk API | Contract/backend tests | Done | None |
| ADM-027 | Contract caller blocking | Seckill rejects contract callers per latest requirement | Seckill contract | Foundry tests | Done | None |
| ADM-028 | Bot/device behavior engine | Wallet switching, cancellation and fulfillment changes trigger timed locks | Risk event engine | Partial backend tests | Partial | Anonymous wallet history scoring incomplete |
| ADM-029 | Wallet/IP/device blacklists | Independent keys block matching requests and are managed/audited | Blacklist/risk APIs | Backend tests | Done | None |
| ADM-030 | Carrier configuration | Built-in carriers, enabled state and default carrier persist | Logistics admin | Backend tests | Done | None |
| ADM-031 | Logistics credentials | Secrets stay in env and real adapter authenticates | Integrations/config checks | Strict gate | ExternalBlocked | Provider account and credentials |
| ADM-032 | Shipping/return address library | Valid six-digit region and address types persist | Logistics address API/UI | Backend tests | Done | None |
| ADM-033 | Freight templates | Quantity/weight, NPL fees, pickup free and blocked regions validate | Template API/UI | Backend tests | Done | None |
| ADM-034 | Atomic force refund | NPL refund, reward burn, seller penalty and product release are event-driven | Escrow/admin/indexer | Contract/backend tests | ExternalBlocked | Mainnet transaction and operational rehearsal |
| ADM-035 | CMS | Independent keys, placements, schedule, targeting, legal and forced update work | CMS API/admin/customer | Backend CMS tests | Partial | Admin independent-key UI change needs stage verification |
| ADM-036 | Notifications | Audience/channel scheduling and provider delivery status work | Notification API/integration | Local adapter tests | ExternalBlocked | SMS/email/push provider endpoint |
| ADM-037 | Runtime parameters | Shipping, expiry and supported business parameters validate and audit old/new | System config API/UI | Partial tests | Partial | Some values are persisted but not consumed live |
| ADM-038 | RPC primary/fallback routing | Primary/fallback URLs can change safely and health routing is live | Config UI; server env RPC | None | Missing | Stored config does not drive runtime RPC routing |
| ADM-039 | Chainlink Oracle | Feed address, threshold, live price, reference, deviation and alert are implemented | Config UI only | None | Missing | Oracle reader/alert absent |
| ADM-040 | Gas limit configuration | Reviewed nonzero limit reaches contract via owner transaction | Risk API/Seckill | Contract/backend tests | ExternalBlocked | Production owner transaction |
| ADM-041 | Chain and multisig config | Chain id and owner addresses are visible, validated contracts and immutable in API env | Runtime checks | Production env checks | ExternalBlocked | Production addresses |
| ADM-042 | Contract mappings | Latest NPL/BNM/Escrow/RewardLedger/Seckill addresses are validated and consumed | Config and public bundle | Partial checks | Partial | Production values missing and runtime overrides limited |
| ADM-043 | OSS/CDN/AI configuration | Non-secret metadata persists; credentials remain env-only | System config redaction | Backend secret rejection tests | Partial | Real provider adapters not implemented |
| ADM-044 | Independent append-only audit DB | Business DB has no active audit table; separate DB rejects update/delete and hash-chains entries | Audit DB implementation | Not yet stage-tested | Partial | Migration/tamper/fail-closed tests pending |
| ADM-045 | Login logs | Wallet signature hash, IP hash and device hash are recorded | SIWE audit | Auth tests | Done | None |
| ADM-046 | JSON-RPC logs | Every RPC request/result/error is written to independent append-only storage | RPC audit implementation | Not yet stage-tested | Partial | Coverage and redaction tests pending |
| ADM-047 | Error logs | Server/database/oracle errors are captured with sanitized context | API error audit/risk event | Partial tests | Partial | Database and oracle-specific paths incomplete |
| ADM-048 | Signed funds/business logs | Every admin/merchant high-risk entry contains message signature hash or tx hash | Audit proof enforcement | Not yet stage-tested | Partial | Complete action coverage tests pending |
| ADM-049 | Contract call audit | Method/event, status, tx hash and gas are traceable | Chain events, claims gas | Backend E2E | Done | None |
| ADM-050 | Multisig approval audit | Every owner approval/signature for high-risk action is recorded | Transaction intents only | None | Missing | Multisig service integration absent |
| ADM-051 | Parameter change audit | Actor, old/new values and signature proof are recorded | Admin audited actions | Partial tests | Partial | Old/new snapshots not universal |
| ADM-052 | Withdrawal and risk reconciliation | Chain amount equals ledger delta; breaker snapshot is recorded | Claim/indexer/risk APIs | Partial E2E | Partial | Automated reconciliation report incomplete |
| ADM-053 | CPU/memory/disk monitoring | Live values and thresholds display | Ops API/UI | Ops checks | Partial | Disk waterline absent |
| ADM-054 | Redis and MQ monitoring | Real connectivity, Redis hit ratio and MQ backlog are measured | Config placeholders only | None | Missing | Real health probes/metrics absent |
| ADM-055 | TPS/QPS/latency/error rate | Live request and chain throughput metrics display | Request activity/ops API | Ops checks | Partial | Endpoint percentile/average latency incomplete |
| ADM-056 | RPC vs explorer height | Lag over three blocks is a red alert | Ops blockchain status | Backend checks | Done | None |
| ADM-057 | Platform force-sign completion | Settlement request row can sign and broadcast completeOrder | API exists | None | Missing | Admin UI button absent |
| ADM-058 | After-sale arbitration | Pending dispute cannot be resolved; confirmed arbitration can complete/refund/exchange/delay | After-sale admin/customer APIs | Full business E2E | Done | None |

## Frozen Counts

Counts are recalculated by the matrix check script once added. At freeze time the implementation contains substantial `Partial`, `Missing`, and `ExternalBlocked` work; no launch claim is permitted until every row is `Done`.

