# Merchant Workbench Core Gaps

The merchant product consumes Core's coordinated
`2.0.0-settlement-admin.2` artifact workspace package. Bootstrap, SIWE,
Catalog/SKU/inventory reads, wallet-scoped fulfillment, merchant finance,
guarantee-deposit evidence, signed settlement requests and Safe-finality
history are connected through their published HTTP surfaces. The browser
validates generated enums and immutable EIP-712 fields, keeps idempotency keys
stable across retry, and fails closed on wallet, merchant, artifact or unknown
state mismatches.

## Resolved In Settlement/Admin Batch

| Gap ID | Published Core capability | Merchant evidence |
|---|---|---|
| GAP-MER-006 | Settlement outbox, ledger lifecycle and Safe finality projection | Order balances and `/v2/settlements` remain separate; no merchant completion shortcut |
| GAP-MER-011 | Merchant USDT five-state balances plus guarantee, debt and takeover finance | Exact `MERCHANT_RECEIVABLE` rows, finance restrictions and evidence render without browser netting |
| GAP-MER-012 | Merchant settlement intent, EIP-712 request, immutable batch and final Safe TxHash | Wallet signs Core typed data and submits `/v2/settlement-requests`; Requested/Batched/Settled history links final BSC hash |
| GAP-MER-013 (reward/points slice) | NPL reward subtypes and finance-center BNM aggregate | All eight generated NPL subtypes render from `SettlementBalance.rewardSubtype`; Core-projected BNM Locked/Available totals render separately as non-transferable points with no settlement action |
| GAP-MER-016 | Versioned public rules/help content | Wallet-targeted `SECKILL_RULES` CMS content renders with its bound policyVersion; absent or malformed content fails closed |

## Remaining Gaps

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MER-001 | Coordinated merchant runtime endpoints beyond published payment, fulfillment and settlement/admin surfaces | Published reads and writes are live; unpublished writes remain unavailable |
| GAP-MER-002 | Secondary-signature intents plus production merchant allowlist and domain configuration | SIWE client is live; unauthorized/rejected/wrong-chain states fail closed and sensitive actions remain unavailable |
| GAP-MER-003 | Merchant dashboard aggregate with authoritative timezone/day and product state | Values show unavailable, never fake zero |
| GAP-MER-004 | Merchant-bound unique product slot, signed uploads, save/submit/lock state and authoritative concession preview | Public catalog/SKU/inventory is read live without pretending a product belongs to the current merchant; writes and financial preview stay unavailable |
| GAP-MER-005 | Cursor-paginated merchant order filters, PII-safe export and batch shipment contract | Wallet-scoped single-order reads and writes are live; export/batch controls stay unavailable and buyer-only payment projection is never called |
| GAP-MER-007 | Camera challenge/scan transport beyond the published six-digit order/store verification command | Manual order/store-bound verification is live; camera launch stays unavailable |
| GAP-MER-008 | AMap reverse geocode plus signed immutable six-digit region | Region read-only; store save disabled |
| GAP-MER-009 | Feie device binding/status/two-copy print job/retry contract | Printer controls return ConfigurationRequired |
| GAP-MER-010 | Canonical raw tracking-number hashing plus Kuaidi100 waybill and callback integration | Exact precomputed shipment/evidence hashes can submit; raw number generation and provider controls return ConfigurationRequired |
| GAP-MER-013 | Authoritative seckill revenue detail | Published NPL subtype balances and finance-center BNM totals are live; only the unpublished seckill revenue projection remains unavailable |
| GAP-MER-014 | Shop profile, immutable settlement wallet and governed migration intent | Wallet read-only; profile writes disabled |
| GAP-MER-015 | Merchant append-only audit read model with signature/Tx proof | Audit unavailable, never local fake history |
| GAP-MER-017 | Signed media upload and owned-asset metadata | Local preview only; submit disabled |
| GAP-MER-018 | Provider accounts/devices, authorized merchant wallet, RPC/domain/Safe inputs | ExternalBlocked; no simulated success |
