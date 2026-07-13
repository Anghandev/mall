# 24K Mall V2 Customer Requirements Matrix

Source: `docs/requirements/PRD-7.5.01.txt`

Allowed status values are `Planned`, `Done`, and `ExternalBlocked`. `Done` requires code plus an automated or rendered evidence target. Platform, contract, merchant, database, and operator-console implementation is out of scope; their customer-facing contracts are tracked as upstream dependencies.

| ID | PRD lines | Customer requirement | Acceptance criteria | Evidence target | Status | Upstream |
|---|---:|---|---|---|---|---|
| SCOPE-001 | 5-10 | Embedded mobile DApp with four persistent tabs | Seckill, mall, stores, and assets remain reachable and preserve local view state | App shell source + screenshot set | Planned | No |
| SCOPE-002 | 6 | Mobile safe-area shell | Content and fixed tab bar do not collide with notches or gesture areas | 375/393 screenshots | Planned | No |
| SCOPE-003 | 4,113 | Consumption and assets are visibly linked | Order and activity rows expose locked and released customer-facing states | Fixture state checks | Planned | Yes |
| SCOPE-004 | 4,109-111 | No no-reason refund affordance | Only upstream-authorized exchange, delay, timeout refund, and arbitration actions render | Negative action checks | Planned | Yes |
| SEK-001 | 13-17 | Four seckill phases | PREHEAT, LIVE, SETTLING, and SETTLED each render a distinct CTA and state | Fixture screenshots | Planned | Yes |
| SEK-002 | 14 | Preheat countdown | Disabled CTA shows next-session countdown | Countdown check | Planned | Yes |
| SEK-003 | 15 | Live dashboard and actions | Live state shows market data, rules, history, and payment CTA | UI source + screenshot | Planned | Yes |
| SEK-004 | 16 | Settlement lockout | SETTLING disables purchase while keeping the prize pool visible | Negative CTA check | Planned | Yes |
| SEK-005 | 17 | Settlement report | Settled state shows report, winner variant, and route to prize claim | Winner/loser fixtures | Planned | Yes |
| SEK-006 | 18-21 | Real-time purchase wall | New sequenced events prepend, dedupe, reconnect, and fall back to polling | Stream client checks | Planned | Yes |
| SEK-007 | 22-24 | Main and relay countdowns | Both server-anchored timers render independently using monospaced figures | Timer source check | Planned | Yes |
| SEK-008 | 25-34 | Rules acknowledgement | Rules sheet is readable, dismissible, and records acknowledgement locally | Interaction check | Planned | Yes |
| SEK-009 | 30-31 | Chain timestamp classification | UI displays authoritative upstream classification and never classifies locally | Source guard | Planned | Yes |
| SEK-010 | 33-34 | BNM return wording | Payment success says BNM is locked until receipt, not already spendable | Copy guard | Planned | Yes |
| SEK-011 | 114-118 | Participation history and result | Rows show session, amounts, win/loss, locked BNM, and USDT prize action | Fixture checks | Planned | Yes |
| SEK-012 | 117 | Winner USDT claim | Claim CTA appears only when upstream marks the prize claimable | Allowed-action check | Planned | Yes |
| SEK-013 | 165-169 | Transaction result metadata | Pending/finalized/reverted states and full TxHash are visible | Transaction fixtures | Planned | Yes |
| MALL-001 | 35-39 | Horizontal category rail | Categories filter product results without a visible scrollbar | Interaction + screenshot | Planned | Yes |
| MALL-002 | 38 | BNM return badge | Product cards show a restrained, readable BNM return marker | Screenshot check | Planned | Yes |
| MALL-003 | 39 | Seckill product overlay | Locked products cannot start ordinary checkout and route to seckill | Negative action check | Planned | Yes |
| MALL-004 | 40-42 | Product detail and persistent buy bar | Product details open without losing context; the primary buy action remains reachable | Mobile screenshot | Planned | Yes |
| MALL-005 | 43-49 | Configuration sheet | SKU, quantity, delivery/pickup, address/store, and total are reviewable before order confirmation | Flow check | Planned | Yes |
| MALL-006 | 45 | Required SKU selection | Confirmation is blocked until a valid in-stock SKU is selected | Negative flow check | Planned | Yes |
| MALL-007 | 46 | Quantity stepper | Stepper enforces one-to-stock bounds and updates display quote from upstream-supported units | Unit check | Planned | Yes |
| MALL-008 | 47-49 | Fulfillment switch | Delivery uses selected address; pickup uses selected eligible store | Fixture flow check | Planned | Yes |
| MALL-009 | 146-148 | Stock preflight | Confirmation requests a reservation/preflight and shows actionable stock errors | API contract check | Planned | Yes |
| MALL-010 | 149-157 | Five-factor final review | Product/SKU, quantity/quote, fulfillment, immutable region warning, and payment CTA are present | Final-review screenshot | Planned | Yes |
| MALL-011 | 156,159 | Immutable region assertion | Delivery address or pickup-store region is explicitly shown before payment | Copy/source check | Planned | Yes |
| MALL-012 | 17,152,163 | Dual-asset price | USDT and NPL exact string amounts render without floating-point recomputation | Money formatter tests | Planned | Yes |
| STORE-001 | 50-53 | Store directory | Stores tab renders real store records, not marketing placeholders | Fixture screenshot | Planned | Yes |
| STORE-002 | 51 | Country/city/district filters | Three linked filters constrain results and expose empty state | Interaction checks | Planned | Yes |
| STORE-003 | 52 | GPS distance | Permission, loading, denial, unavailable, and distance states are distinct | Fixture states | Planned | Yes |
| STORE-004 | 48-49,52 | Nearest pickup recommendation | Nearest eligible store is highlighted and can be selected | Fixture flow | Planned | Yes |
| STORE-005 | 53 | Native call and navigation | Call and map buttons use platform links and provide unsupported fallbacks | Source check | Planned | No |
| STORE-006 | 159 | Pickup region binding | Selected store region is shown in the final review | Flow check | Planned | Yes |
| AST-001 | 54-101 | Customer profile and address entry | Assets tab exposes profile and address management entry points | Screenshot | Planned | Yes |
| AST-002 | 95-100 | Paste-and-parse address | Pasted text is parsed, reviewed, and missing fields are highlighted before save | Parser + interaction tests | Planned | Yes |
| AST-003 | 101 | Address CRUD and default | Add, edit, delete, set-default, and select actions are supported | Fixture flow | Planned | Yes |
| AST-004 | 102-107 | Four order groups | Pending payment, shipment, receipt, and after-sale groups show accurate counts | Fixture checks | Planned | Yes |
| AST-005 | 104-107 | Receipt card detail | Seckill badge, latest logistics summary, support, and confirm-receipt actions render when allowed | Fixture screenshot | Planned | Yes |
| AST-006 | 108-111 | Exchange/delay arbitration | Only exchange and delay requests are offered; arbitration visibly keeps linked rewards locked | Negative/positive fixtures | Planned | Yes |
| AST-007 | 112-122 | Dual-track activity records | Seckill participation and ordinary shopping records are separately scannable | Screenshot | Planned | Yes |
| AST-008 | 119-122 | Shopping BNM release | Row changes from locked-until-receipt to released only from upstream state | State check | Planned | Yes |
| AST-009 | 123-130 | BNM reward bucket | Cumulative, available, locked, provenance, and claim action render | Fixture check | Planned | Yes |
| AST-010 | 131-134 | Genesis reward entitlement | Genesis bucket is hidden or disabled according to authoritative entitlement | Entitled/unentitled fixtures | Planned | Yes |
| AST-011 | 135-137 | Referral reward bucket | Referral NPL cumulative/available/locked values and claim action render | Fixture check | Planned | Yes |
| AST-012 | 138-141 | Regional reward bucket | Regional NPL values and receipt-linked release explanation render | Fixture check | Planned | Yes |
| AST-013 | 142-144 | Operations reward bucket | Operations values render only for an authorized customer-facing entitlement | Authorized fixture | Planned | Yes |
| AST-014 | 71-90,123-144 | Five distinct reward sections | BNM, genesis, referral, region, and operations are not collapsed into one ambiguous total | Screenshot check | Planned | Yes |
| AST-015 | 130 | Asset provenance | Reward detail can display TxHash and timestamp supplied upstream | Fixture detail | Planned | Yes |
| AST-016 | 4,138-140,187-192 | Locked-to-available semantics | UI never offers claim for Locked or arbitration-linked entries | Allowed-action guard | Planned | Yes |
| AST-017 | 117,130,134,137,141,144 | Claim progress | Every claim supports awaiting-wallet, submitted, confirming, finalized, reverted, and replaced | Transaction fixtures | Planned | Yes |
| FLOW-001 | 161-164 | Per-token allowance check | USDT and NPL allowances are checked independently | Wallet service tests | Planned | Yes |
| FLOW-002 | 163-164 | Selective approvals | Only insufficient token legs request approval; revoked allowance is detected | Wallet fixtures | Planned | Yes |
| FLOW-003 | 163 | Approval disclosure | Spender, requested amount, and a revocation route are visible before approval | Review screenshot | Planned | Yes |
| FLOW-004 | 165-169 | Intent-driven calldata | App sends only upstream-supplied transaction requests and never constructs settlement calldata | Source guard | Planned | Yes |
| FLOW-005 | 166-169,186 | Finality correctness | TxHash submission never mutates assets before successful confirmed receipt | State-machine tests | Planned | Yes |
| FLOW-006 | 167 | Seckill post-payment step | recordPurchase is executed only when present in the authoritative intent | Wallet service test | Planned | Yes |
| FLOW-007 | 168 | Boundary-order result | UI displays upstream ordinary/seckill classification and corresponding result copy | Fixture check | Planned | Yes |
| FLOW-008 | 169 | Full transaction hash | Full hash is selectable and explorer-linkable | UI source check | Planned | Yes |
| FLOW-009 | 181-186 | Checkout progression | Configuration, stock reservation, final review, wallet actions, and confirmation are ordered and resumable | End-to-end fixture flow | Planned | Yes |
| FLOW-010 | 187-192 | Receipt release refresh | Finalized receipt completion triggers authoritative assets refresh | Client state test | Planned | Yes |
| FLOW-011 | 4 | Seven-day no-shipment refund request | CTA renders only from upstream eligibility and shows prize deduction disclosure for seckill orders | Eligible/ineligible fixtures | Planned | Yes |
| FLOW-012 | 4,140 | Merchant force-receipt visibility | Customer can see request/arbitration status without a local auto-completion path | Fixture check | Planned | Yes |
| FLOW-013 | 108-111 | After-sale lock | Pending after-sale keeps linked rewards visibly locked | Fixture check | Planned | Yes |
| FLOW-014 | 147,181-182 | Preflight latency feedback | A response over 200ms receives non-blocking progress feedback without false success | Interaction check | Planned | Yes |
| NFR-001 | 6 | Mobile-first responsiveness | 375, 393, tablet, and desktop web layouts have no overlap or horizontal page scroll | Screenshot gate | Planned | No |
| NFR-002 | 18-21 | Stream resilience | Disconnect, duplicate, out-of-order, and missed-event recovery are deterministic | Stream unit tests | Planned | Yes |
| NFR-003 | 27,149-157 | Blocking review accessibility | Sheets/dialogs trap focus appropriately, expose labels, and provide a safe exit before payment | Accessibility source check | Planned | No |
| NFR-004 | 17 | Reduced motion | Winner effects have a static reduced-motion alternative | Source + screenshot | Planned | No |
| NFR-005 | 95-100,153-155 | PII handling | Logs and transaction payloads never contain full name, phone, or address unless contractually required off-chain | Source guard | Planned | Yes |
| NFR-006 | 147 | Loading and error states | Every remote surface has loading, empty, retryable error, and unavailable states | Fixture screenshots | Planned | Yes |
| NFR-007 | 169 | Transaction observability | Errors preserve action, stage, safe message, and correlation identifier without secrets | Client tests | Planned | Yes |
| NFR-008 | 19,22-24 | Layout stability | Feed rows, counters, and timers have stable dimensions and cannot resize the shell | Screenshot check | Planned | No |
| NFR-009 | 6,50-53 | Native-device acceptance | Wallet, GPS, call, map, and safe-area flows pass on physical iOS/Android devices | Device checklist | ExternalBlocked | Yes |

