# Mall V2 Core Gaps

Mall cannot resolve residual gaps by adding shared endpoints, schemas,
financial logic or custom calldata.

Mall consumes `@abu24k/core-artifacts@2.0.0-settlement-admin.9`. Catalog, SIWE,
payments, stores, checkout targets, order/fulfillment projections and the
fulfillment action catalog are published and consumed. Settlement balances,
signed requests, Safe finality, public CMS and notifications are also consumed.
Seckill session/history/event reads, final-only WebSocket replay, reward
subtypes and BNM account totals are consumed from the same coordinated version.
Public categories/tags, product associations, SKU seckill overlays, stable
order pages and short-lived product/category media reads are also consumed.
Mall creates buyer evidence through `.9` for exchange, delay,
receipt confirmation and arbitration without exposing raw hashes. Takeover and
pickup verification retain the exact fail-closed boundaries below. `PAY_ORDER` remains
non-executable and the manifest does not authorize deployment.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MAL-001 | Deployment-authorized coordinated artifacts and non-empty executable action publication | Real payment flow is wired; wallet broadcast remains disabled by manifest/action gate |
| GAP-MAL-002 | Resolved by `2.0.0-settlement-admin.9` typed product fields and SKU-level seckill overlay | Mall filters only by published associations, renders the published fields and blocks ordinary checkout whenever the SKU overlay is present |
| GAP-MAL-003 | Resolved by `.9` encrypted saved/default address projection and saved-address target creation | Checkout consumes only Core-created target/region hashes and never invents saved addresses, defaults or region identity |
| GAP-MAL-004 | Deployment-authorized execution of the published ordinary/seckill Router calls | Both signed quote shapes are consumed; no local classification or alternate calldata |
| GAP-MAL-005 | Resolved by `2.0.0-settlement-admin.9` seckill session and realtime publication | Mall accepts only sessions with matching snapshot/rules hash plus FINAL governance action and publication TxHash, renders those proofs, authoritative phases/timers/history/prize/winner, HTTP replay and final-only `/v2/ws` cursor recovery |
| GAP-MAL-006 | `.9` evidence actions cover `REQUEST_EXCHANGE`, `REQUEST_DELAY`, `CONFIRM_RECEIPT` and `OPEN_ARBITRATION`; `OPEN_TAKEOVER` is absent and `VERIFY_PICKUP` evidence is not buyer-authorized | The four published buyer actions execute only when row-level `allowedActions.enabled`; takeover and buyer pickup stay disabled with the exact contract/authority reason |
| GAP-MAL-007 | Activity projections beyond the published buyer profile, overview, encrypted address and order projections | `.9` account data is consumed; unpublished activity aggregates remain unavailable |
| GAP-MAL-008 | Resolved by `.9` buyer-scoped takeover timeline | Mall shows only `COMPLETE` / `PARTIAL_LEGACY` and public transitions; internal evidence hashes are rejected |
| GAP-MAL-009 | Resolved by `2.0.0-settlement-admin.9` reward subtype and BNM totals publication | Mall renders only Core-projected wallet subtypes and Locked/Available BNM points; BNM remains non-transferable |
| GAP-MAL-010 | Production GPS/device evidence and native AMap/Baidu navigation bridge beyond published stores | Browser distance is calculated only after permission; denial and native navigation remain ExternalBlocked |
| GAP-MAL-011 | Resolved by `.9` PII-safe parser and encrypted retention contract | Raw pasted text is not stored; incomplete parse cannot be saved and provider absence is `ConfigurationRequired` |
| GAP-MAL-012 | Resolved in current `.9` Safe-settlement projection | Mall renders request, immutable batch identity, Settled state and final Safe TxHash from Core |
| GAP-MAL-013 | Configured production providers behind published readiness and typed ConfigurationRequired errors | Provider-dependent action disabled |
| GAP-MAL-014 | Circuit Breaker recovery/read projections beyond published payment readiness | Payment readiness blocks new quotes; later breaker controls remain unavailable |
| GAP-MAL-015 | Consumer tests for every remaining Mall capability | Affected Requirement IDs cannot become Verified |
| GAP-MAL-016 | Real wallet/GPS/native links/devices/domains/HTTPS-WSS/RPC inputs | ExternalBlocked; no simulated success |
