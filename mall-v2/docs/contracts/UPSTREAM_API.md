# Mall Core API Publication Boundary

Status: the previous handwritten `mall-api-v1` proposal is retired. Mall now
consumes coordinated Core settlement/admin artifacts
`2.0.0-settlement-admin.7`.

The published boundary currently covers:

- bootstrap/readiness, BSC chain identity and fixed asset identity;
- buyer SIWE challenge and session;
- products/SKUs, authoritative atomic-unit prices/stock, subtitle, rich detail,
  freight, fulfillment modes, category/tag associations, catalog media IDs and
  SKU-level seckill overlays;
- enabled three-level category and tag projections;
- short-lived public media-read targets bound to asset, resource, purpose,
  content type, object version and expiry;
- buyer write-once evidence upload/verification, order-action evidence
  envelopes and the published exchange, delay, receipt-confirmation and
  arbitration commands;
- ordinary and dual seckill signed quotes with atomic reservations;
- approval requirements and ABI-shaped PaymentRouter calls;
- transaction submission plus replacement/reorg/finality projection.
- store reads and authoritative delivery/pickup checkout targets;
- stable `(createdAt, orderId)` wallet order pages with full quantity, order
  kind, payment TxHash, fulfillment-target, shipment, logistics, balance and
  row-level `allowedActions` projections;
- fulfillment requests, receipt, pickup, arbitration and takeover actions with
  generated `allowedActions`.
- encrypted buyer profile reads/writes, provider-sealed `BUYER_AVATAR` media,
  canonical buyer overview counts, encrypted saved-address parse/CRUD/default
  operations and saved-address fulfillment-target creation;
- buyer-scoped takeover timelines with explicit `COMPLETE` /
  `PARTIAL_LEGACY` history status and public transitions only;
- wallet settlement balances and requests, signed EIP-712 settlement intents,
  Safe batching state and final Safe TxHash;
- seckill current/history/session projections, authoritative timer anchors,
  prize/winner state and final-event numeric cursor replay;
- public `/v2/ws` delivery bound to artifact version, session channel and last
  accepted cursor;
- NPL reward subtype attribution and wallet-level BNM Locked/Available totals;
- public CMS items, wallet notification inbox and wallet-bound IN_APP endpoint
  registration.

Mall derives endpoint paths from the coordinated OpenAPI document and consumes
the generated response types. It does not maintain a parallel API schema.

The following Mall capabilities remain incomplete:

- an `OPEN_TAKEOVER` evidence action matching the published takeover command;
- buyer authority for `VERIFY_PICKUP` evidence, if buyer-side pickup execution
  is ever intended; current Core authority is merchant/platform only;
- fulfillment and settlement WebSocket cursor replay beyond the published
  seckill channel.

No business-refund endpoint or action is part of V2.
