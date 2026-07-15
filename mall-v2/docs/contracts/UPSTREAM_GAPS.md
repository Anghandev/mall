# Mall V2 Core Gaps

Mall cannot resolve residual gaps by adding shared endpoints, schemas,
financial logic or custom calldata.

Mall consumes `@abu24k/core-artifacts@2.0.0-settlement-admin.4`. Catalog, SIWE,
payments, stores, checkout targets, order/fulfillment projections and the
fulfillment action catalog are published and consumed. Settlement balances,
signed requests, Safe finality, public CMS and notifications are also consumed.
Seckill session/history/event reads, final-only WebSocket replay, reward
subtypes and BNM account totals are consumed from the same coordinated version.
Public categories/tags and short-lived product/category media reads are also
consumed. Mall now creates buyer evidence through `.4` for exchange, delay,
receipt confirmation and arbitration without exposing raw hashes. Takeover and
pickup verification retain the exact fail-closed boundaries below. `PAY_ORDER` remains
non-executable and the manifest does not authorize deployment.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MAL-001 | Deployment-authorized coordinated artifacts and non-empty executable action publication | Real payment flow is wired; wallet broadcast remains disabled by manifest/action gate |
| GAP-MAL-002 | Typed `CatalogProduct` category/tag associations, rich-detail fields and authoritative seckill overlay beyond the published public products, taxonomy and media IDs | Real taxonomy and media render; filtering and overlay remain unavailable rather than being inferred from `metadata` |
| GAP-MAL-003 | Saved/default address projection and reusable target selection beyond the published one-time delivery/pickup target operations | Checkout creates and consumes real Core target/region hashes; it does not invent saved addresses or defaults |
| GAP-MAL-004 | Deployment-authorized execution of the published ordinary/seckill Router calls | Both signed quote shapes are consumed; no local classification or alternate calldata |
| GAP-MAL-005 | Resolved by `2.0.0-settlement-admin.4` seckill session and realtime publication | Mall renders authoritative phases/timers/history/prize/winner, HTTP replay and final-only `/v2/ws` cursor recovery |
| GAP-MAL-006 | `.4` evidence actions cover `REQUEST_EXCHANGE`, `REQUEST_DELAY`, `CONFIRM_RECEIPT` and `OPEN_ARBITRATION`; `OPEN_TAKEOVER` is absent and `VERIFY_PICKUP` evidence is not buyer-authorized | The four published buyer actions execute only when `allowedActions.enabled`; takeover and buyer pickup stay disabled with the exact contract/authority reason |
| GAP-MAL-007 | Buyer profile, address, order and activity projections beyond published SIWE/session | Wallet login works; unpublished authenticated data remains unavailable |
| GAP-MAL-008 | MerchantTakeoverCase and customer-visible takeover timeline | Shows unavailable reason; no alternate action inferred |
| GAP-MAL-009 | Resolved by `2.0.0-settlement-admin.4` reward subtype and BNM totals publication | Mall renders only Core-projected wallet subtypes and Locked/Available BNM points; BNM remains non-transferable |
| GAP-MAL-010 | Production GPS/device evidence and native AMap/Baidu navigation bridge beyond published stores | Browser distance is calculated only after permission; denial and native navigation remain ExternalBlocked |
| GAP-MAL-011 | PII-safe address parser and retention contract | Parsing disabled in production |
| GAP-MAL-012 | Resolved in current `.4` Safe-settlement projection | Mall renders request, immutable batch identity, Settled state and final Safe TxHash from Core |
| GAP-MAL-013 | Configured production providers behind published readiness and typed ConfigurationRequired errors | Provider-dependent action disabled |
| GAP-MAL-014 | Circuit Breaker recovery/read projections beyond published payment readiness | Payment readiness blocks new quotes; later breaker controls remain unavailable |
| GAP-MAL-015 | Consumer tests for every remaining Mall capability | Affected Requirement IDs cannot become Verified |
| GAP-MAL-016 | Real wallet/GPS/native links/devices/domains/HTTPS-WSS/RPC inputs | ExternalBlocked; no simulated success |
