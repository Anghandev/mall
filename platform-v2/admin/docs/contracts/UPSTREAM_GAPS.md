# Platform Admin Core Gaps

The platform-admin product is a consumer. It cannot add shared endpoints,
schemas, financial logic, calldata, signers or database behavior.

The coordinated consumer is `@abu24k/core-artifacts@2.0.0-merchant-fulfillment.1`.
Published paths still fail closed when Core returns `DecisionBlocked`,
`ExternalBlocked` or `ConfigurationRequired`.

| Gap ID | Current Core capability | Remaining fail-closed behavior |
|---|---|---|
| GAP-ADM-001 | Payment, fulfillment and settlement/admin artifacts, including finalized seckill WebSocket, are coordinated at one version | Production deployment remains unauthorized |
| GAP-ADM-002 | SIWE/JWT plus route-specific ADMIN/OPERATOR/ARBITRATOR/AUDITOR enforcement is published | A role absent from the session never enables a product control |
| GAP-ADM-003 | Exact Admin order ID/product ID/TxHash/wallet search, pending-product-review and breaker projections, full order-row `allowedActions`, and read-only batch enabled-intersection preview are published and consumed | OR search, fuzzy wallet, UID/phone PII search, Yellow queue, cross-resource selection, export/print and arbitrary batch-write contracts are absent |
| GAP-ADM-004 | Policy, takeover funding and `.9` seckill actions publish EIP-712 challenge/signature/Safe proposal evidence; the products consume the exact Core typed data and never construct calldata | Production Safe service, Safe addresses and independent secondary signer remain external configuration |
| GAP-ADM-005 | `.9` authenticated Admin Dashboard publishes the `Asia/Shanghai` business window, immutable order/GMV amounts, shipment ratio, merchant/product/seckill counts, fulfillment queues, signed-settlement totals and failures, per-asset coverage, independent breakers, four risk counts and typed unavailable evidence; the product consumes it directly | New UID identity and low-stock threshold remain `DecisionBlocked`; monitoring alerts are not transaction-risk evidence |
| GAP-ADM-006 | Merchant guarantee, deposit finality, debt and takeover-finance projection is published | Qualification, level, PII, sales and wallet-change governance remain unavailable |
| GAP-ADM-007 | `.5` admin category/tag versions, nullable category parent, all managed products, store product slot, signed concession preview, review submission/decisions, delist, inventory adjustment and controlled media reads are published and consumed | Global cross-resource batch selection remains `GAP-ADM-003`; unresolved category service fees remain `DecisionBlocked` |
| GAP-ADM-008 | Policy governance plus the product-scoped signed concession preview are published and consumed | Missing service/prize/store/concession-destination commercial decisions remain `DecisionBlocked`; the product never infers them |
| GAP-ADM-010 | Fulfillment commands plus takeover funding, ordered deductions, platform advance and debt projections are published | Replacement-merchant administration and case-wide list projection remain unavailable |
| GAP-ADM-011 | `.9` retains published risk observations, wallet/IP/device restrictions and blacklists, appeal/override audit evidence, payment enforcement, Admin overview and role-scoped manual restriction/appeal/decision writes; the product consumes generated DTOs and all published Admin paths | Low-history wallet clustering and frequent address/store-change thresholds remain `DecisionBlocked`; production device fingerprint and mempool/RPC high-Gas sources remain external |
| GAP-ADM-012 | Admin now consumes six-carrier/default versioning, Kuaidi100/Cainiao secret-reference readiness, encrypted role-scoped warehouses, cross-merchant waybill batches/lists and durable print-job retry | `ADM-LOG-005` freight charging and weight basis remain `DecisionBlocked`; real provider accounts and physical printer/device acceptance remain `ExternalBlocked`; broader `ADM-GLOBAL-002` export/pickup-print scope is unchanged |
| GAP-ADM-013 | CMS create/read/publish/rollback contracts are published and consumed | Real content, audience and production approval evidence must be supplied externally |
| GAP-ADM-014 | Notification endpoints, inbox, campaign create/publish and worker states are published | Real SMS/SMTP/Push accounts remain `ConfigurationRequired` / `ExternalBlocked` |
| GAP-ADM-015 | Typed versioned system-config create/list/publish is published and consumed | Real RPC/Safe/provider secret references and deployment addresses remain external blockers |
| GAP-ADM-016 | Append-only audit query, cursor and per-stream hash-chain proof are published and consumed | Real audit database, retention and backup/restore environment evidence remain external blockers |
| GAP-ADM-017 | Signed settlement projections include reward subtype and non-transferable BNM points; immutable Safe batching/finality, policy evidence, coverage and takeover funding are published | Admin-wide payment search, merchant historical BNM aggregate and a batch-wide settlement list are not published; wallet and resource scope remains enforced |
| GAP-ADM-018 | Host/middleware/HTTP/chain metrics, alerts and acknowledgement are published and consumed | Real production probes and independent explorer credentials remain external blockers |
