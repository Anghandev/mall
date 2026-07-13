# V2 Decision Registry

Status: frozen by the final execution instruction on 2026-07-14. No item below
is open for reinterpretation. Source locations are indexed in the three
Requirement Matrices.

| Decision ID | Frozen decision | Overrides or resolves |
|---|---|---|
| D-V2-001 | BSC chain 56; fixed USDT and NPL addresses | Missing network/token identity in the PRDs |
| D-V2-002 | USDT list price and merchant cost; versioned exact USDT+NPL buyer legs; zero legs omitted; first insufficient allowance defaults to MaxUint256 with disclosure/revocation | Mixed or incomplete price and approval wording |
| D-V2-003 | Payment-final 20% NPL Burn and Locked 80% circulation/reward routing | PRD next-block/session routing timing conflicts |
| D-V2-004 | No business refunds or refund interface; technical emergency recovery is not a mall workflow | Mall lines 4 and 109; platform lines 37, 94 and 97-103; stale interface proposals |
| D-V2-005 | Seven-day no-shipment creates platform takeover fulfillment and freezes merchant listing/order/Claim permissions | Mall line 4 and platform forced-refund center |
| D-V2-006 | Merchant can request forced receipt only after seven days from logistics delivery; platform reviews evidence; pickup scan and final arbitration use normal finality | Mall lines 4 and 140; merchant lines 50-52 |
| D-V2-007 | Prize Claim follows final session settlement; every other proceeds/reward Claim follows fulfillment finality | Mall lines 117, 133, 136 and 143-144; merchant lines 49-52 |
| D-V2-008 | BNM is ERC-20/18, equals USDT list price 1:1, is Locked at payment, Available at fulfillment finality, minted on Claim and then transferable | Mall lines 34, 117-130 and 167-168; merchant lines 69-76 |
| D-V2-009 | Exact NPL beneficiary percentages, 80% cap and circulation-pool handling for missing beneficiaries and integer/remainder amounts | Mall lines 131-144 and platform lines 60-63 |
| D-V2-010 | Genesis ERC-721/ERC-1155 eligibility, referral and four-level region beneficiaries snapshot at payment; no self/cyclic referral | Mall lines 131-140 and merchant line 60 |
| D-V2-011 | Seckill intent carries seckill and retail fallback quotes; block time classifies; post-deadline path atomically uses retail inventory/price and no prize | Mall lines 30-34 and 165-169 |
| D-V2-012 | Signed exact quote plus 30-minute TWAP, 5% deviation, mandatory maxAge/liquidity; invalid Oracle pauses new orders only | Missing Oracle safety details in product PRDs |
| D-V2-013 | Main session 60 minutes; relay starts 60 seconds; final purchase adds 30 seconds; relay cap 60 seconds and main-deadline cap | Mall line 24 and platform line 69 |
| D-V2-014 | Seckill timing, Burn/Route and revenue changes require RBAC, secondary wallet signature and Safe multisig to publish a new policyVersion; future work only | Platform mutable-control wording |
| D-V2-015 | EIP-712, nonce, deadline, domain isolation and ERC-1271; never tx.origin | Platform line 79 |
| D-V2-016 | Independent breakers for orders, seckill buy/settle, merchant Claim, reward Claim and prize Claim; fulfillment/recovery/reconciliation/audit/finality remain available | Platform manual-stop and general pause wording |
| D-V2-017 | Immutable quote/order/session snapshots plus receipt/event/block/confirmation/reorg evidence define finality | PRD TxHash-as-success and current-config recalculation risks |
| D-V2-018 | Listed production commercial values remain DecisionBlocked and are never guessed | Unspecified fees, guarantees, reserves, Oracle limits and credential IDs |
| D-V2-019 | Accounts, devices, domains, RPC and Safe/role addresses remain ExternalBlocked; provider absence returns ConfigurationRequired | External service and release dependencies |
| D-V2-020 | Guarantee, available unencumbered merchant assets and platform risk reserve fund takeover in that order; advance becomes merchant debt | Missing merchant-default funding order |
| D-V2-021 | All frontends consume signed values and allowedActions and never calculate financial truth or infer eligibility/finality | Every product surface |

## Closure

There are no unresolved Phase 1 business questions. Missing production values
are tracked as `DecisionBlocked`; missing external inputs are tracked as
`ExternalBlocked`. Neither status authorizes a default value.
