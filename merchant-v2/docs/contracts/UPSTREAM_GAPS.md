# Merchant Workbench Core Gaps

The merchant product consumes Core's coordinated `2.0.0-rc.2` artifact
workspace package, including its version and public action catalog. It must not
implement the remaining shared capabilities below. Each affected action stays
disabled with the stated reason until its runtime capability is published.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MER-001 | Non-empty executable action catalog coordinated with merchant runtime endpoints | Artifact version is exposed; runtime entry and all writes remain disabled |
| GAP-MER-002 | Merchant SIWE nonce/verify, allowlist, JWT/RBAC and secondary-signature intent | Login/sensitive actions unavailable |
| GAP-MER-003 | Merchant dashboard aggregate with authoritative timezone/day and product state | Values show unavailable, never fake zero |
| GAP-MER-004 | Unique product slot, signed uploads, save/submit/lock state and allowedActions | Product writes disabled |
| GAP-MER-005 | Merchant order filters, cursor pagination, PII-safe export and batch shipment | Orders/export unavailable |
| GAP-MER-006 | Fulfillment evidence, forced-receipt request, settlement outbox and finality projection | Merchant cannot complete or present settlement |
| GAP-MER-007 | Pickup signed challenge and camera/manual verification contract | Scanner cannot submit |
| GAP-MER-008 | AMap reverse geocode plus signed immutable six-digit region | Region read-only; store save disabled |
| GAP-MER-009 | Feie device binding/status/two-copy print job/retry contract | Printer controls ConfigurationRequired |
| GAP-MER-010 | Kuaidi100 waybill, callback signature and delivery evidence | Shipment provider controls ConfigurationRequired |
| GAP-MER-011 | Merchant USDT five-state proceeds projection | Financial values unavailable, never locally calculated |
| GAP-MER-012 | Merchant Claim allowedActions, ordered intent, receipt/replacement/finality | Claim disabled; no local calldata |
| GAP-MER-013 | Separate NPL/BNM reward projections and lifecycle | Reward rails unavailable independently from USDT |
| GAP-MER-014 | Shop profile, immutable settlement wallet and governed migration intent | Wallet read-only; profile writes disabled |
| GAP-MER-015 | Merchant append-only audit read model with signature/Tx proof | Audit unavailable, never local fake history |
| GAP-MER-016 | Versioned rules/help content | Shows policy content unavailable |
| GAP-MER-017 | Signed media upload and owned-asset metadata | Local preview only; submit disabled |
| GAP-MER-018 | Provider accounts/devices, authorized merchant wallet, RPC/domain/Safe inputs | ExternalBlocked; no simulated success |
