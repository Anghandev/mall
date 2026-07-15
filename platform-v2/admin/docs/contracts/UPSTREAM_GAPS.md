# Platform Admin Core Gaps

The platform-admin product is a consumer. It cannot add shared endpoints,
schemas, financial logic, calldata, signers or database behavior.

The coordinated consumer is `@abu24k/core-artifacts@2.0.0-settlement-admin.4`.
Published paths still fail closed when Core returns `DecisionBlocked`,
`ExternalBlocked` or `ConfigurationRequired`.

| Gap ID | Current Core capability | Remaining fail-closed behavior |
|---|---|---|
| GAP-ADM-001 | Payment, fulfillment and settlement/admin artifacts, including finalized seckill WebSocket, are coordinated at one version | Production deployment remains unauthorized |
| GAP-ADM-002 | SIWE/JWT plus route-specific ADMIN/OPERATOR/ARBITRATOR/AUDITOR enforcement is published | A role absent from the session never enables a product control |
| GAP-ADM-003 | Order-level `allowedActions` is published | Global resource list/batch `allowedActions`, export and print contracts are absent |
| GAP-ADM-004 | Policy and takeover-funding EIP-712 challenge/signature/Safe proposal evidence is published | Seckill force-close, breaker and prize-injection governance remain absent |
| GAP-ADM-005 | Monitoring metrics and per-asset coverage are published | Business GMV/order/review aggregates and risk queues remain unavailable |
| GAP-ADM-006 | Merchant guarantee, deposit finality, debt and takeover-finance projection is published | Qualification, level, PII, sales and wallet-change governance remain unavailable |
| GAP-ADM-007 | `.4` admin category/tag versions, all managed products, store product slot, signed concession preview, review submission/decisions, delist, inventory adjustment and controlled media reads are published and consumed | `CatalogCategoryInput.parentCategoryId` cannot express `null`, so an existing child cannot move back to the root; UI disables that transition. Global cross-resource batch selection remains `GAP-ADM-003` |
| GAP-ADM-008 | Policy governance plus the product-scoped signed concession preview are published and consumed | Missing service/prize/store/concession-destination commercial decisions remain `DecisionBlocked`; the product never infers them |
| GAP-ADM-009 | Payment quotes plus current/history/session/event HTTP reads and finalized relay WebSocket are published | Admin session scheduling, inventory lock, force-close, prize injection and rule binding remain disabled |
| GAP-ADM-010 | Fulfillment commands plus takeover funding, ordered deductions, platform advance and debt projections are published | Replacement-merchant administration and case-wide list projection remain unavailable |
| GAP-ADM-011 | Monitoring accepts real risk/operations alerts | Risk rule, blacklist, trade-lock and breaker-action contracts remain disabled |
| GAP-ADM-012 | Order shipment/delivery commands are published | Carrier config, warehouse, freight, waybill and print jobs are absent or `ConfigurationRequired` |
| GAP-ADM-013 | CMS create/read/publish/rollback contracts are published and consumed | Real content, audience and production approval evidence must be supplied externally |
| GAP-ADM-014 | Notification endpoints, inbox, campaign create/publish and worker states are published | Real SMS/SMTP/Push accounts remain `ConfigurationRequired` / `ExternalBlocked` |
| GAP-ADM-015 | Typed versioned system-config create/list/publish is published and consumed | Real RPC/Safe/provider secret references and deployment addresses remain external blockers |
| GAP-ADM-016 | Append-only audit query, cursor and per-stream hash-chain proof are published and consumed | Real audit database, retention and backup/restore environment evidence remain external blockers |
| GAP-ADM-017 | Signed settlement projections include reward subtype and non-transferable BNM points; immutable Safe batching/finality, policy evidence, coverage and takeover funding are published | Admin-wide payment search, merchant historical BNM aggregate and a batch-wide settlement list are not published; wallet and resource scope remains enforced |
| GAP-ADM-018 | Host/middleware/HTTP/chain metrics, alerts and acknowledgement are published and consumed | Real production probes and independent explorer credentials remain external blockers |
