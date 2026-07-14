# Merchant Workbench Core Gaps

The merchant product consumes Core's coordinated `2.0.0-fulfillment.1` artifact
workspace package. Bootstrap, SIWE, public Catalog/SKU/inventory reads and
session-bound fulfillment `allowedActions` are connected through their
published HTTP surface. Fulfillment controls also require the selected order's
enabled server action; an absent session, missing action or finality block keeps
the control disabled.
It must not implement the remaining shared capabilities below. Each affected
action stays unavailable with the stated reason until its coordinated runtime
capability is published.

| Gap ID | Required Core capability | Fail-closed behavior |
|---|---|---|
| GAP-MER-001 | Coordinated merchant runtime endpoints beyond the payment and fulfillment surfaces | Published payment/fulfillment reads and SIWE are live; unpublished writes remain disabled |
| GAP-MER-002 | Secondary-signature intents plus production merchant allowlist and domain configuration | SIWE client is live; unauthorized/rejected/wrong-chain states fail closed and sensitive actions remain unavailable |
| GAP-MER-003 | Merchant dashboard aggregate with authoritative timezone/day and product state | Values show unavailable, never fake zero |
| GAP-MER-004 | Merchant-bound unique product slot, signed uploads, save/submit/lock state and authoritative concession preview | Public catalog/SKU/inventory is read live without pretending a product belongs to the current merchant; writes and financial preview stay unavailable |
| GAP-MER-005 | Cursor-paginated merchant order filters, PII-safe export and batch shipment contract | Order `allowedActions` can be checked by ID; missing list/export/batch product flows stay unavailable and buyer-only payment projection is never called |
| GAP-MER-006 | Settlement outbox and settlement finality projection | Fulfillment eligibility is server-authoritative; merchant cannot complete an order directly or present settlement |
| GAP-MER-007 | Pickup signed challenge and camera/manual verification contract | Scanner cannot submit |
| GAP-MER-008 | AMap reverse geocode plus signed immutable six-digit region | Region read-only; store save disabled |
| GAP-MER-009 | Feie device binding/status/two-copy print job/retry contract | Printer controls ConfigurationRequired |
| GAP-MER-010 | Kuaidi100 waybill, callback signature and delivery evidence | Shipment provider controls ConfigurationRequired |
| GAP-MER-011 | Merchant USDT five-state proceeds projection | Financial values unavailable, never locally calculated |
| GAP-MER-012 | Merchant signed settlement-request action, ordered intent, Safe batch, replacement and finality | Settlement request disabled; no local calldata or simulated Safe result |
| GAP-MER-013 | Separate transferable NPL reward and settlement projections | Order-scoped BNM lifecycle is published; unpublished transferable reward rails remain unavailable independently from USDT |
| GAP-MER-014 | Shop profile, immutable settlement wallet and governed migration intent | Wallet read-only; profile writes disabled |
| GAP-MER-015 | Merchant append-only audit read model with signature/Tx proof | Audit unavailable, never local fake history |
| GAP-MER-016 | Versioned rules/help content | Shows policy content unavailable |
| GAP-MER-017 | Signed media upload and owned-asset metadata | Local preview only; submit disabled |
| GAP-MER-018 | Provider accounts/devices, authorized merchant wallet, RPC/domain/Safe inputs | ExternalBlocked; no simulated success |
