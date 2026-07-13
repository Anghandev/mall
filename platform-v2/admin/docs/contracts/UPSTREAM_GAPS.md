# Platform Admin Core Gaps

The platform-admin product is a consumer. It cannot add shared endpoints,
schemas, financial logic, calldata, signers or database behavior.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-ADM-001 | Coordinated OpenAPI/types/ABI/manifest/enums/WebSocket artifacts | Disconnected contract state; all writes disabled |
| GAP-ADM-002 | Admin SIWE/JWT/RBAC role and permissions | Protected navigation/actions unavailable |
| GAP-ADM-003 | Resource/list/batch allowedActions and disabled reasons | Controls disabled with Core reason |
| GAP-ADM-004 | Secondary-signature and Safe proposal/execution evidence contract | High-risk actions cannot begin |
| GAP-ADM-005 | Dashboard business/risk/infrastructure aggregates | Values unavailable, never synthetic |
| GAP-ADM-006 | Merchant qualification/level/detail/proceeds/takeover projections | Merchant module read-only unavailable |
| GAP-ADM-007 | Product/SKU/inventory/category/tag/lock/version projections | Catalog writes disabled |
| GAP-ADM-008 | ProductPolicy and signed AllocationSnapshot validation/publication | Policy save/publish disabled |
| GAP-ADM-009 | Seckill session/quotes/inventory/prize/rules/breaker controls | Publish/inject/force-close disabled |
| GAP-ADM-010 | MerchantTakeoverCase, guarantees/reserve/debt, fulfillment evidence/finality | Takeover actions disabled; case remains visible as unavailable |
| GAP-ADM-011 | Risk event, blacklist, trade-lock and breaker action contracts | Risk writes disabled |
| GAP-ADM-012 | Provider readiness, carriers, addresses, freight, shipment and print jobs | ConfigurationRequired; no fake success |
| GAP-ADM-013 | CMS placement/content/version/publish/rollback contracts | CMS writes disabled |
| GAP-ADM-014 | Notification campaign/audience/gateway/delivery contracts | Send disabled; ConfigurationRequired where applicable |
| GAP-ADM-015 | Typed business/RPC/Oracle/Gas/chain/Safe/contract/integration config | Config writes disabled and values unavailable |
| GAP-ADM-016 | Append-only operation/login/RPC/error/financial/takeover/recovery audit streams | Read-only unavailable; no local proof generation |
| GAP-ADM-017 | Safe approvals, contract calls, policy diffs, Claims and reconciliation | Evidence unavailable; execution disabled |
| GAP-ADM-018 | Host/Redis/MQ/database/API/block-sync monitoring | Probe unavailable, never healthy by default |
