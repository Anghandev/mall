# Mall Core API Publication Boundary

Status: the previous handwritten `mall-api-v1` proposal is retired. Mall now
consumes coordinated Core fulfillment artifacts `2.0.0-fulfillment.1`.

The published boundary currently covers:

- bootstrap/readiness, BSC chain identity and fixed asset identity;
- buyer SIWE challenge and session;
- products/SKUs and authoritative atomic-unit prices/stock;
- ordinary and dual seckill signed quotes with atomic reservations;
- approval requirements and ABI-shaped PaymentRouter calls;
- transaction submission plus replacement/reorg/finality projection.
- store reads and authoritative delivery/pickup checkout targets;
- order, fulfillment-target, shipment, logistics and balance projections;
- fulfillment requests, receipt, pickup, arbitration and takeover actions with
  generated `allowedActions`.

Mall derives endpoint paths from the coordinated OpenAPI document and consumes
the generated response types. It does not maintain a parallel API schema.

The following later batches remain unpublished:

- seckill session state, timers, reports and event cursor;
- saved-address/profile persistence and PII-safe address parsing;
- canonical buyer-evidence generation/upload required before Mall may execute
  exchange, delay, receipt, pickup, arbitration or takeover commands;
- reward and signed-settlement projections;
- settlement `allowedActions` and exact disabled reasons;
- fulfillment and settlement WebSocket cursor replay.

No business-refund endpoint or action is part of V2.
