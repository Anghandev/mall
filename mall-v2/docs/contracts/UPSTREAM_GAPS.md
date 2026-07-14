# Mall V2 Core Gaps

Mall cannot resolve residual gaps by adding shared endpoints, schemas,
financial logic or custom calldata.

Mall consumes `@abu24k/core-artifacts@2.0.0-payment.1`. Catalog, SIWE, ordinary
and seckill quotes, reservations, approval requirements, Router calls,
submissions and payment projections are published. The executable order-action
catalog is still empty and the manifest does not authorize deployment.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MAL-001 | Deployment-authorized coordinated artifacts and non-empty executable action publication | Real payment flow is wired; wallet broadcast remains disabled by manifest/action gate |
| GAP-MAL-002 | Category, seckill-overlay and typed product metadata beyond the published product/SKU catalog | Real catalog renders; categories and overlay are not inferred |
| GAP-MAL-003 | Address/store target projections required by the published signed quote request | Quote client is real; checkout refuses to invent fulfillment or region hashes |
| GAP-MAL-004 | Deployment-authorized execution of the published ordinary/seckill Router calls | Both signed quote shapes are consumed; no local classification or alternate calldata |
| GAP-MAL-005 | Seckill sessions, timer anchors, event cursor, settlement/report/prize projections | Seckill actions unavailable |
| GAP-MAL-006 | Order, fulfillment evidence/finality, forced-receipt request, pickup and arbitration projections | Completion/after-sale actions disabled |
| GAP-MAL-007 | Buyer profile, address, order and activity projections beyond published SIWE/session | Wallet login works; unpublished authenticated data remains unavailable |
| GAP-MAL-008 | MerchantTakeoverCase and customer-visible takeover timeline | Shows unavailable reason; no alternate action inferred |
| GAP-MAL-009 | Reward entitlement/lifecycle and signed settlement requests | Values unavailable and settlement actions disabled |
| GAP-MAL-010 | Store/region/geolocation/navigation contract | Location unavailable; no fake nearest store |
| GAP-MAL-011 | PII-safe address parser and retention contract | Parsing disabled in production |
| GAP-MAL-012 | Fulfillment and Safe-settlement finality projections beyond the published payment projection | Payment projection is real; later finality surfaces remain unavailable |
| GAP-MAL-013 | Configured production providers behind published readiness and typed ConfigurationRequired errors | Provider-dependent action disabled |
| GAP-MAL-014 | Circuit Breaker recovery/read projections beyond published payment readiness | Payment readiness blocks new quotes; later breaker controls remain unavailable |
| GAP-MAL-015 | Consumer tests for every remaining Mall capability | Affected Requirement IDs cannot become Verified |
| GAP-MAL-016 | Real wallet/GPS/native links/devices/domains/HTTPS-WSS/RPC inputs | ExternalBlocked; no simulated success |
