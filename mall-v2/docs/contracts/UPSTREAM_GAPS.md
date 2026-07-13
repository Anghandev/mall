# Mall V2 Core Gaps

Mall cannot resolve these gaps by adding shared endpoints, schemas, financial
logic or calldata. Every affected action remains disabled.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MAL-001 | Coordinated OpenAPI/types/ABI/manifest/enums/WebSocket artifacts | Runtime unavailable; all wallet writes disabled |
| GAP-MAL-002 | Bootstrap, product/category/detail state and shared UI enums | Read-only unavailable shell |
| GAP-MAL-003 | Signed ProductPolicy, exact quotes and atomic InventoryReservation | Checkout disabled |
| GAP-MAL-004 | Signed ordinary/seckill intents and dual-quote boundary consumer test | Payment disabled; no local classification/calldata |
| GAP-MAL-005 | Seckill sessions, timer anchors, event cursor, settlement/report/prize projections | Seckill actions unavailable |
| GAP-MAL-006 | Order, fulfillment evidence/finality, forced-receipt request, pickup and arbitration projections | Completion/after-sale actions disabled |
| GAP-MAL-007 | Buyer SIWE/session, profile, address, order and activity projections | Authenticated views/actions unavailable |
| GAP-MAL-008 | MerchantTakeoverCase and customer-visible takeover timeline | Shows unavailable reason; no alternate action inferred |
| GAP-MAL-009 | AllocationSnapshot, reward entitlement/lifecycle and Claim intents | Values unavailable and Claims disabled |
| GAP-MAL-010 | Store/region/geolocation/navigation contract | Location unavailable; no fake nearest store |
| GAP-MAL-011 | PII-safe address parser and retention contract | Parsing disabled in production |
| GAP-MAL-012 | Transaction receipt/replacement/reorg/finality projection | Submitted transaction never shown as final |
| GAP-MAL-013 | Provider readiness and typed ConfigurationRequired errors | Provider-dependent action disabled |
| GAP-MAL-014 | Circuit Breaker states and allowed recovery/read projections | Writes disabled; reason visible |
| GAP-MAL-015 | Consumer tests for every published capability | Affected Requirement IDs cannot become Verified |
| GAP-MAL-016 | Real wallet/GPS/native links/devices/domains/HTTPS-WSS/RPC inputs | ExternalBlocked; no simulated success |
