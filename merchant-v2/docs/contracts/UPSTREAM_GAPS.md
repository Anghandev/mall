# Merchant Workbench Core Gaps

The merchant product consumes Core's coordinated `2.0.0-logistics-admin.1` artifact
workspace package. Bootstrap, SIWE,
merchant-bound Catalog/SKU/inventory management, immutable media, wallet-scoped fulfillment, merchant finance,
guarantee-deposit evidence, signed settlement requests and Safe-finality
history are connected through their published HTTP surfaces. The browser
validates generated enums and immutable EIP-712 fields, keeps idempotency keys
stable across retry, and fails closed on wallet, merchant, artifact or unknown
state mismatches.

Merchant self-service profile remains limited to shop name and owned Logo.
Platform qualification decisions and business-license PII are admin-owned and
have no Merchant write route.

## Resolved In Settlement/Admin Batch

| Gap ID | Published Core capability | Merchant evidence |
|---|---|---|
| GAP-MER-006 | Settlement outbox, ledger lifecycle and Safe finality projection | Order balances and `/v2/settlements` remain separate; no merchant completion shortcut |
| GAP-MER-011 | Merchant USDT five-state balances plus guarantee, debt and takeover finance | Exact `MERCHANT_RECEIVABLE` rows, finance restrictions and evidence render without browser netting |
| GAP-MER-012 | Merchant settlement intent, EIP-712 request, immutable batch and final Safe TxHash | Wallet signs Core typed data and submits `/v2/settlement-requests`; Requested/Batched/Settled history links final BSC hash |
| GAP-MER-013 (reward/points slice) | NPL reward subtypes and finance-center BNM aggregate | All eight generated NPL subtypes render from `SettlementBalance.rewardSubtype`; Core-projected BNM Locked/Available totals render separately as non-transferable points with no settlement action |
| GAP-MER-016 | Versioned public rules/help content | Wallet-targeted `SECKILL_RULES` CMS content renders with its bound policyVersion; absent or malformed content fails closed |
| GAP-MER-004 | Merchant-bound unique product slot, save/replacement/review lifecycle, exact write locks and signed concession preview | Product form reads and writes only `/v2/merchant/**`; generated `allowedActions`, `writeLock`, `blockingResource` and signed EIP-712 preview fields fail closed on mismatch |
| GAP-MER-017 | Write-once signed media upload plus owned-asset metadata and controlled reads | Product image/video uses intent -> provider PUT -> completion -> authorized read; purpose/content/resource/owner fields must match before the asset enters the form |
| GAP-MER-005 (order-page/manual-batch slice) | Stable merchant order cursor, date/SKU/state/mode/kind filters, complete authoritative rows and atomic manual-shipment batch | The workbench serializes only published filters, preserves the full cursor, renders quantity/TxHash/kind/actions and submits 1-100 canonical shipment evidence rows with stable retry keys |
| GAP-MER-003 | Merchant business dashboard with authoritative timezone/day, exact payment snapshots, current fulfillment queues and generated product/seckill state | Dashboard and finance Today metric consume `/v2/merchant/dashboard`; zero remains a real Core value while request failure stays visibly unavailable |
| GAP-MER-014 | Tenant-scoped merchant profile, immutable settlement identity and owned Logo media validation | Settings consumes GET/PUT profile with expectedVersion/idempotency; only shopName/logoAssetId are editable and settlement wallet never enters the PUT body |
| GAP-MER-015 | Merchant-scoped reverse-time audit read model and bounded CSV export | Filters/cursor, partial-history label, signature/Safe-or-chain hashes and exact Core CSV download are live without a browser-side audit replica |

## Resolved In Logistics Batch

| Gap ID | Published Core capability | Merchant evidence |
|---|---|---|
| GAP-MER-009 | Wallet-bound Feie/Yilianyun Device ID binding plus durable one-copy waybill and two-copy pickup print jobs | The connected merchant signs the exact Core challenge; the workbench renders tenant-scoped jobs and retries with stable command keys |
| GAP-MER-010 | Kuaidi100/Cainiao waybill batches, provider tracking evidence and shipment recording | Selected eligible delivery orders submit only published provider/carrier/store/order fields; each authoritative result and failure state is rendered without browser-generated tracking data |

The Merchant consumer uses Core's generated carrier-code enum but does not
read or write platform carrier/provider configuration. A disabled carrier or
incomplete provider configuration is rejected by Core as `InvalidRequest` or
`ConfigurationRequired`; the workbench renders that rejection and does not
create a local success state.

## Remaining Gaps

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MER-001 | Coordinated merchant runtime endpoints beyond published payment, fulfillment and settlement/admin surfaces | Published reads and writes are live; unpublished writes remain unavailable |
| GAP-MER-002 | Secondary-signature intents beyond the published printer binding plus production merchant allowlist and domain configuration | Printer binding signs the exact Core challenge; unpublished region-change intent, unauthorized/rejected/wrong-chain states remain fail closed |
| GAP-MER-005 | PII-authorized, audit-logged server-side Excel export and list-row consignee/contact projection | Cursor/filter/manual-batch reads and writes are live; Excel export stays unavailable and delivery PII is fetched only through the authorized immutable target endpoint |
| GAP-MER-007 | Camera challenge/scan transport beyond the published six-digit order/store verification command | Manual order/store-bound verification is live; camera launch stays unavailable |
| GAP-MER-008 | AMap reverse geocode plus signed immutable six-digit region | Region read-only; store save disabled |
| GAP-MER-013 | Authoritative seckill revenue detail | Published NPL subtype balances and finance-center BNM totals are live; only the unpublished seckill revenue projection remains unavailable |
| GAP-MER-018 | Provider accounts/devices, authorized merchant wallet, RPC/domain/Safe inputs | ExternalBlocked; no simulated success |
