# Platform Admin Core Gaps

The platform-admin product is a consumer. It cannot add shared endpoints,
schemas, financial logic, calldata, signers or database behavior.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-ADM-001 | Admin-wide projection/action consumer contract after coordinated `2.0.0-fulfillment.1`; payment reads plus ADMIN/OPERATOR fulfillment-order reads and order commands are published | Published payment/fulfillment paths work; unrelated Admin reads and writes remain disabled |
| GAP-ADM-002 | Admin-resource RBAC and permissions; SIWE/JWT and fulfillment-order role binding are published | Fulfillment orders require ADMIN/OPERATOR in this product; other protected Admin resources remain unavailable |
| GAP-ADM-003 | Resource/list/batch allowedActions and disabled reasons; order-level allowedActions are published | Order commands obey current Core action results; unrelated list/batch controls remain disabled |
| GAP-ADM-004 | Secondary-signature and Safe proposal/execution evidence contract | High-risk actions cannot begin |
| GAP-ADM-005 | Dashboard business/risk/infrastructure aggregates | Values unavailable, never synthetic |
| GAP-ADM-006 | Merchant qualification/level/detail/proceeds/takeover projections | Merchant module read-only unavailable |
| GAP-ADM-007 | Admin Product/SKU/inventory/category/tag/lock/version projection and writes; public active catalog read is published | Active catalog is read-only; all Admin catalog writes remain disabled |
| GAP-ADM-008 | ProductPolicy and signed AllocationSnapshot validation/publication | Policy save/publish disabled |
| GAP-ADM-009 | Seckill session/quotes/inventory/prize/rules/breaker controls | Publish/inject/force-close disabled |
| GAP-ADM-010 | Fulfillment order evidence/finality plus shipment, delivery, after-sale decision, arbitration, forced-receipt and takeover commands are published; MerchantTakeoverCase funding, guarantee, frozen-receivable, future-proceeds, replacement-merchant and debt projections are not | Current-session commands follow Core allowedActions; unpublished case finance and recovery controls remain disabled |
| GAP-ADM-011 | Risk event, blacklist, trade-lock and breaker action contracts | Risk writes disabled |
| GAP-ADM-012 | Order-level shipment/delivery commands are published; provider readiness, carrier configuration, addresses, freight, waybill and print jobs are not | Authorized order commands work; provider/config/print controls stay ConfigurationRequired with no fake success |
| GAP-ADM-013 | CMS placement/content/version/publish/rollback contracts | CMS writes disabled |
| GAP-ADM-014 | Notification campaign/audience/gateway/delivery contracts | Send disabled; ConfigurationRequired where applicable |
| GAP-ADM-015 | Typed business/RPC/Oracle/Gas/Safe/contract/integration config; payment bootstrap publishes chain/assets/readiness | Published identity/readiness is visible; config writes and unpublished values remain unavailable |
| GAP-ADM-016 | Append-only operation/login/RPC/error/financial/takeover/recovery audit streams | Read-only unavailable; no local proof generation |
| GAP-ADM-017 | Admin-wide PaymentRouter audit, Safe approvals, policy diffs, signed settlement and reconciliation | Buyer-wallet payment trace is available; Admin audit evidence and execution remain disabled |
| GAP-ADM-018 | Host/Redis/MQ/database/API/block-sync monitoring | Probe unavailable, never healthy by default |
