# V2 Decision Registry

Status: frozen for the function-first rewrite from `v2/core@1cab34d` on
2026-07-14. Source PRDs remain unchanged and are indexed by the three
Requirement Matrices.

| Decision ID | Frozen decision | Overrides or resolves |
|---|---|---|
| D-V2-001 | BSC 56; fixed USDT/NPL addresses; verified PancakeSwap V2 NPL/USDT pair | Missing network, token and Oracle-pair identity |
| D-V2-002 | Launch buyer payment is exactly 70% USDT plus 30% Oracle-equivalent NPL; no unfunded policy may reduce NPL below 30%; first insufficient allowance defaults to MaxUint256 with disclosure and revocation | Mixed payment ratios and incomplete approval wording |
| D-V2-003 | Immutable PaymentRouter atomically sends USDT to Custody Safe, 20%-of-list-price NPL to Burn and 10%-of-list-price NPL to Reward Safe and normally retains zero balance | Old escrow/vault and payment-final 20/80-of-NPL-leg model |
| D-V2-004 | No business refunds or refund interface; technical recovery is not a mall workflow | Mall line 4 and 109; platform lines 37, 94 and 97-103; stale interface proposals |
| D-V2-005 | Seven-day no-shipment starts platform takeover, freezes merchant listing/new-order/settlement-request permissions while preserving independent buyer prize eligibility, and records debt instead of refunding | Mall line 4 and platform forced-refund center |
| D-V2-006 | Merchant forced receipt is request-only after seven days from logistics delivery; platform reviews evidence; pickup and final arbitration use ordinary finality | Mall lines 4 and 140; merchant lines 50-52 |
| D-V2-007 | Former transferable-asset Claims are gasless signed settlement requests with Locked/Available/Requested/Batched/Settled ledger states and final Safe TxHash; prize availability waits for final session settlement | Mall/merchant direct on-chain Claim and Gas wording |
| D-V2-008 | BNM is existing backend points at 1:1 USDT list price: Locked at payment and Available at fulfillment; no BNM ERC-20, mint, Safe transfer or on-chain Claim | Mall lines 34, 117-130 and 167-168; merchant lines 69-76; undeployed old V2 BNMToken/ClaimVault |
| D-V2-009 | Reward Safe receives 10%-of-list-price NPL allocated as genesis 2%, direct 1%, district 1.2%, city .8%, province .6%, region .4%, operations 4%; missing beneficiaries and rounding go to circulation pool | Mall lines 131-144 and platform lines 60-63 |
| D-V2-010 | ERC-721/ERC-1155 genesis eligibility, referral, region codes and beneficiaries snapshot at payment; no self/cyclic referral | Mall lines 131-140 and merchant line 60 |
| D-V2-011 | Seckill intent binds seckill and retail fallback quotes; block time classifies; post-deadline payment atomically uses ordinary price/inventory and no prize | Mall lines 30-34 and 165-169 |
| D-V2-012 | Oracle is the fixed pair with 30-minute TWAP, 5% deviation, 5-minute quote, 10-minute max age and 50,000-USDT minimum USDT-side liquidity | Missing Oracle safety details and mutable Chainlink-only wording |
| D-V2-013 | Main session 60 minutes; relay 60 seconds; chain-final purchase adds 30 seconds; relay cap 60 seconds and main-deadline cap; prize settles in 5-10 minutes | Mall line 24 and platform line 69 |
| D-V2-014 | Policy/high-risk changes require RBAC, exact secondary EIP-712 signature and Safe multisig; new policyVersion is future-only | Platform mutable-control wording |
| D-V2-015 | EIP-712, nonce, deadline, domain isolation and ERC-1271; never tx.origin | Platform line 79 |
| D-V2-016 | Independent breakers cover new payment, seckill purchase and new settlement batch; fulfillment/takeover/arbitration/reconciliation/audit/finality remain available | Old Claim-specific breaker topology and general pause wording |
| D-V2-017 | Immutable quote/order/session/batch snapshots plus receipt/event/block/15-confirmation/reorg evidence define finality | TxHash-as-success and current-config recalculation risks |
| D-V2-018 | Merchant guarantee minimum is 1,000 USDT; 10-minute Oracle age, 50,000-USDT liquidity and 15 confirmations are frozen; only listed commercial proportions/accounts remain DecisionBlocked | Previously unresolved safety thresholds |
| D-V2-019 | Three Safe/Owner/role addresses, BNM backend integration, accounts, devices, domains, RPC and encrypted backup storage remain ExternalBlocked; provider absence returns ConfigurationRequired | External service and release dependencies |
| D-V2-020 | Major loss consumes guarantee, frozen receivables and future proceeds in order; platform advance is merchant debt; below 1,000-USDT guarantee blocks listing and new orders | Missing merchant-default funding order |
| D-V2-021 | Frontends render signed Core values, previews and allowedActions; they never own financial truth, eligibility or finality | Every product surface |
| D-V2-022 | Merchant concession is 0-100% of merchant base receivable, never changes buyer 70/30, reduces merchant net and credits configured USDT ledger destinations | New Goal merchant concession rule |
| D-V2-023 | PostgreSQL append-only double-entry ledger plus immutable Safe MultiSend batches are the only settlement execution path; all postings balance and corrections reverse | Old contract-vault/pull-Claim execution model |
| D-V2-024 | Coverage means verified Safe assets divided by unsettled ledger liabilities per asset; below 100% pauses new payment and new settlement batches | Platform leverage/liquidation wording |
| D-V2-025 | Category/tag lock applies while seckill or Locked funds exist; historical products delist logically; funds/policies/batches/chain/audit evidence never delete | Broad batch-delete wording |
| D-V2-026 | Risk thresholds are 24h high-Gas restriction, >5 wallets per IP/device in 1 minute blacklist, and 3 cancellations/5 minutes or frequent address/store changes causing a 2h payment restriction | Platform qualitative risk wording |
| D-V2-027 | External settlement links are wallet-bound, one-use, expiring signed requests and cannot bypass Safe batching or eligibility | Platform no-login direct-Claim wording |
| D-V2-028 | Undeployed pre-rewrite V2 funds runtime has no compatibility path; only `legacy/v1-npl-only` remains read-only | Prevents preserving the wrong funds model |
| D-V2-029 | A merchant settlement wallet becomes permanently immutable when the application is approved. No merchant, platform role, secondary signer or Safe may change it; an incorrect pre-approval address requires rejecting the application and creating a new one | Removes governed wallet migration, emergency rebinding and post-settlement rebinding |
| D-V2-030 | The first successful SIWE session with a BUYER role atomically creates one global, permanent numeric UID bound to that wallet. UID is off-chain display and exact-search identity only; it never participates in funds or signatures | Resolves buyer accountId and Admin new-UID/search gaps |

## Closure

No frozen business rule above is open for reinterpretation. Missing commercial
weights/accounts are `DecisionBlocked`; missing external systems are
`ExternalBlocked` or `ConfigurationRequired`. Neither status authorizes a
default, fixture, disabled placeholder or simulated success.
