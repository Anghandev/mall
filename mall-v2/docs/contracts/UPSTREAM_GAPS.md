# Mall V2 Core Gaps

Mall cannot resolve residual gaps by adding shared endpoints, schemas,
financial logic or custom calldata.

Mall consumes `@abu24k/core-artifacts@2.0.0-fulfillment.1`. Catalog, SIWE,
payments, stores, checkout targets, order/fulfillment projections and the
fulfillment action catalog are published and consumed. Buyer command bodies
require an evidence hash, but no canonical Mall evidence creation/upload
contract is published, so those writes remain fail closed. `PAY_ORDER` remains
non-executable and the manifest does not authorize deployment.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MAL-001 | Deployment-authorized coordinated artifacts and non-empty executable action publication | Real payment flow is wired; wallet broadcast remains disabled by manifest/action gate |
| GAP-MAL-002 | Category, seckill-overlay and typed product metadata beyond the published product/SKU catalog | Real catalog renders; categories and overlay are not inferred |
| GAP-MAL-003 | Saved/default address projection and reusable target selection beyond the published one-time delivery/pickup target operations | Checkout creates and consumes real Core target/region hashes; it does not invent saved addresses or defaults |
| GAP-MAL-004 | Deployment-authorized execution of the published ordinary/seckill Router calls | Both signed quote shapes are consumed; no local classification or alternate calldata |
| GAP-MAL-005 | Seckill sessions, timer anchors, event cursor, settlement/report/prize projections | Seckill actions unavailable |
| GAP-MAL-006 | Canonical buyer-evidence creation/upload semantics for commands requiring `evidenceHash` | Orders, targets, logistics, balances and `allowedActions` are real; command controls stay disabled even when allowed rather than asking buyers for raw hashes |
| GAP-MAL-007 | Buyer profile, address, order and activity projections beyond published SIWE/session | Wallet login works; unpublished authenticated data remains unavailable |
| GAP-MAL-008 | MerchantTakeoverCase and customer-visible takeover timeline | Shows unavailable reason; no alternate action inferred |
| GAP-MAL-009 | Reward entitlement/lifecycle and signed settlement requests | Values unavailable and settlement actions disabled |
| GAP-MAL-010 | Production GPS/device evidence and native AMap/Baidu navigation bridge beyond published stores | Browser distance is calculated only after permission; denial and native navigation remain ExternalBlocked |
| GAP-MAL-011 | PII-safe address parser and retention contract | Parsing disabled in production |
| GAP-MAL-012 | Safe-settlement finality beyond the consumed fulfillment/order finality projection | Payment and fulfillment projections are real; unpublished Safe-settlement finality remains unavailable |
| GAP-MAL-013 | Configured production providers behind published readiness and typed ConfigurationRequired errors | Provider-dependent action disabled |
| GAP-MAL-014 | Circuit Breaker recovery/read projections beyond published payment readiness | Payment readiness blocks new quotes; later breaker controls remain unavailable |
| GAP-MAL-015 | Consumer tests for every remaining Mall capability | Affected Requirement IDs cannot become Verified |
| GAP-MAL-016 | Real wallet/GPS/native links/devices/domains/HTTPS-WSS/RPC inputs | ExternalBlocked; no simulated success |
