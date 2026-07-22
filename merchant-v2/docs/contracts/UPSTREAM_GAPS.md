# Merchant Workbench Core Gaps

The merchant product consumes Core's coordinated `2.0.0-fulfillment-launch.23` artifact
workspace package. Bootstrap, SIWE,
merchant-bound Catalog/SKU/inventory management, immutable media, wallet-scoped fulfillment, merchant finance,
guarantee-deposit evidence, signed settlement requests and per-payable EOA-finality
history are connected through their published HTTP surfaces. The browser
validates generated enums and immutable EIP-712 fields, keeps idempotency keys
stable across retry, and fails closed on wallet, merchant, artifact or unknown
state mismatches.

The coordinated payment boundary uses Core-signed exact USDT/NPL amounts and
does not publish an on-chain TWAP dependency. Merchant does not calculate NPL
quotes, add a payment endpoint or infer an oracle version.

Merchant self-service profile remains limited to shop name and owned Logo.
Platform qualification decisions and business-license PII are admin-owned and
have no Merchant write route.
Admin global search/export and product batch-tag operations remain outside the
Merchant API and production bundle.
Admin-wide settlement request/batch reads, governed settlement intents and
coverage-breaker recovery also remain outside the Merchant API and production
bundle. Existing Merchant settlement intent, signed request and history routes
remain unchanged.

## Resolved In Settlement/Admin Batch

| Gap ID | Published Core capability | Merchant evidence |
|---|---|---|
| GAP-MER-006 | Settlement outbox, ledger lifecycle and EOA finality projection | Order balances and `/v2/settlements` remain separate; no merchant completion shortcut |
| GAP-MER-011 | Merchant USDT five-state balances plus guarantee, debt and takeover finance | Exact `MERCHANT_RECEIVABLE` rows, finance restrictions and evidence render without browser netting |
| GAP-MER-012 | Merchant settlement intent, EIP-712 request, immutable per-payable transfer and final EOA execution TxHash | Wallet signs Core typed data and submits `/v2/settlement-requests`; Requested/Submitted/Settled history links the final BSC hash |
| GAP-MER-013 (reward/points slice) | NPL reward subtypes and finance-center BNM aggregate | All eight generated NPL subtypes render from `SettlementBalance.rewardSubtype`; Core-projected BNM Locked/Available totals render separately as non-transferable points with no settlement action |
| GAP-MER-016 | Versioned public rules/help content | Wallet-targeted `SECKILL_RULES` CMS content renders with its bound policyVersion; absent or malformed content fails closed |
| GAP-MER-004 | Merchant-bound unique product slot, save/replacement/review lifecycle, exact write locks and signed concession preview | Product form reads and writes only `/v2/merchant/**`; generated `allowedActions`, `writeLock`, `blockingResource` and signed EIP-712 preview fields fail closed on mismatch |
| GAP-MER-017 | Write-once signed media upload plus owned-asset metadata and controlled reads | Product image/video uses intent -> provider PUT -> completion -> authorized read; purpose/content/resource/owner fields must match before the asset enters the form |
| GAP-MER-005 (order-page/manual-batch slice) | Stable merchant order cursor, date/SKU/state/mode/kind filters, complete authoritative rows and atomic manual-shipment batch | The workbench serializes only published filters, preserves the full cursor, renders quantity/TxHash/kind/actions and submits 1-100 canonical shipment evidence rows with stable retry keys |
| GAP-MER-003 | Merchant business dashboard with authoritative timezone/day, exact payment snapshots, current fulfillment queues and generated product/seckill state | Dashboard and finance Today metric consume `/v2/merchant/dashboard`; zero remains a real Core value while request failure stays visibly unavailable |
| GAP-MER-014 | Tenant-scoped merchant profile, immutable settlement identity and owned Logo media validation | Settings consumes GET/PUT profile with expectedVersion/idempotency; only shopName/logoAssetId are editable and settlement wallet never enters the PUT body |
| GAP-MER-015 | Merchant-scoped reverse-time audit read model and bounded CSV export | Filters/cursor, partial-history label, signature/execution hashes and exact Core CSV download are live without a browser-side audit replica |
| GAP-MER-001 (per-order receivable slice) | Merchant-scoped stable-cursor order statements with frozen amounts, lifecycle, journal and settlement references | Ordinary, fallback-retail and seckill-classified orders render exact Core evidence; tenant/wallet mismatch and authorization failure close the statement without browser netting |

## Retained Phase 2 Logistics Contracts

| Gap ID | Published Core capability | Merchant evidence |
|---|---|---|
| GAP-MER-009 | Wallet-bound Feie/Yilianyun Device ID binding plus durable one-copy waybill and two-copy pickup print jobs | Phase 2; launch UI neither loads nor exposes printer binding or print jobs |
| GAP-MER-010 | Kuaidi100/Cainiao waybill batches and provider tracking evidence | Phase 2; launch uses only provider-independent manual tracking evidence and single-order shipment recording |

The Merchant consumer uses Core's generated carrier-code enum but does not
read or write platform carrier/provider configuration. A disabled carrier or
incomplete provider configuration is rejected by Core as `InvalidRequest` or
`ConfigurationRequired`; the workbench renders that rejection and does not
create a local success state.

## Resolved In Merchant Store Batch

| Gap ID | Published Core capability | Merchant evidence |
|---|---|---|
| GAP-MER-008 | Merchant-scoped store create/update/activate/close, AMap reverse geocode and immutable six-digit region/location | The workbench submits coordinates without a manual region/address fallback, binds 1-5 verified `STORE_IMAGE` assets, uses `expectedVersion` for every mutation and renders Core capabilities plus 403/409 failures |

## Resolved In Merchant Fulfillment Completion Batch

| Gap ID | Published Core capability | Merchant evidence |
|---|---|---|
| GAP-MER-005 | PII-authorized, audit-logged, cursor-paginated server-side Excel export | The workbench resolves `exportMerchantOrders` from the coordinated OpenAPI artifact, preserves applied filters/current list cursor, validates the tenant/filter DTO and SHA-256 before downloading the exact Core bytes; delivery PII remains target/export scoped rather than entering general list rows |
| GAP-MER-007 | Existing order/store-bound six-digit pickup verification command consumed by a real camera/manual entry path | Native `getUserMedia` plus `BarcodeDetector` fills only an exact six-digit code and never auto-submits; unsupported/denied/failed camera states keep the manual command available without simulated device success |

## Resolved In Takeover Fulfillment Batch

| Gap ID | Published Core capability | Merchant evidence |
|---|---|---|
| GAP-MER-001 (replacement-fulfillment slice) | Merchant-scoped assigned takeover queue/detail plus current replacement authority | Queue and detail require the current merchant ID and wallet; revoked or cross-tenant assignments fail closed |
| GAP-MER-005 (replacement-fulfillment slice) | Existing fulfillment-target, tracking-evidence and shipment routes authorize the funded current replacement | The workbench reads the encrypted target, creates wallet-bound tracking evidence and ships only while `FUNDED` and `RECORD_SHIPMENT` is enabled |

## Remaining Gaps

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MER-001 | Coordinated merchant runtime endpoints beyond published payment, fulfillment and settlement/admin surfaces | Published reads and writes are live; unpublished writes remain unavailable |
| GAP-MER-002 | Production merchant allowlist and domain configuration | Unauthorized, rejected and wrong-chain states remain fail closed; printer binding and region-change workflows are not launch capabilities |
| GAP-MER-013 | Authoritative seckill revenue detail | Published NPL subtype balances and finance-center BNM totals are live; only the unpublished seckill revenue projection remains unavailable |
| GAP-MER-018 | Authorized merchant wallet and RPC/domain inputs | ExternalBlocked; no simulated success. Logistics provider accounts/devices are Phase 2 and do not block launch |
