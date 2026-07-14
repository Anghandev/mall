# Platform Admin Core Gaps

The platform-admin product is a consumer. It cannot add shared endpoints,
schemas, financial logic, calldata, signers or database behavior.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-ADM-001 | Admin-wide projection/action consumer contract after coordinated `2.0.0-payment.1`; payment readiness, public catalog and wallet-bound payment trace are published | Published payment reads work; unpublished Admin reads and writes remain disabled |
| GAP-ADM-002 | Admin-resource RBAC and permissions; SIWE/JWT role binding is published | Public payment reads remain available; protected Admin resources are unavailable |
| GAP-ADM-003 | Resource/list/batch allowedActions and disabled reasons | Controls disabled with Core reason |
| GAP-ADM-004 | Secondary-signature and Safe proposal/execution evidence contract | High-risk actions cannot begin |
| GAP-ADM-005 | Dashboard business/risk/infrastructure aggregates | Values unavailable, never synthetic |
| GAP-ADM-006 | Merchant qualification/level/detail/proceeds/takeover projections | Merchant module read-only unavailable |
| GAP-ADM-007 | Admin Product/SKU/inventory/category/tag/lock/version projection and writes; public active catalog read is published | Active catalog is read-only; all Admin catalog writes remain disabled |
| GAP-ADM-008 | ProductPolicy and signed AllocationSnapshot validation/publication | Policy save/publish disabled |
| GAP-ADM-009 | Seckill session/quotes/inventory/prize/rules/breaker controls | Publish/inject/force-close disabled |
| GAP-ADM-010 | MerchantTakeoverCase, guarantees/reserve/debt, fulfillment evidence/finality | Takeover actions disabled; case remains visible as unavailable |
| GAP-ADM-011 | Risk event, blacklist, trade-lock and breaker action contracts | Risk writes disabled |
| GAP-ADM-012 | Provider readiness, carriers, addresses, freight, shipment and print jobs | ConfigurationRequired; no fake success |
| GAP-ADM-013 | CMS placement/content/version/publish/rollback contracts | CMS writes disabled |
| GAP-ADM-014 | Notification campaign/audience/gateway/delivery contracts | Send disabled; ConfigurationRequired where applicable |
| GAP-ADM-015 | Typed business/RPC/Oracle/Gas/Safe/contract/integration config; payment bootstrap publishes chain/assets/readiness | Published identity/readiness is visible; config writes and unpublished values remain unavailable |
| GAP-ADM-016 | Append-only operation/login/RPC/error/financial/takeover/recovery audit streams | Read-only unavailable; no local proof generation |
| GAP-ADM-017 | Admin-wide PaymentRouter audit, Safe approvals, policy diffs, signed settlement and reconciliation | Buyer-wallet payment trace is available; Admin audit evidence and execution remain disabled |
| GAP-ADM-018 | Host/Redis/MQ/database/API/block-sync monitoring | Probe unavailable, never healthy by default |
