# Mall Core API Publication Boundary

Status: the previous handwritten `mall-api-v1` proposal is retired. Mall now
consumes coordinated Core settlement/admin artifacts
`2.0.0-settlement-admin.1`.

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
- wallet settlement balances and requests, signed EIP-712 settlement intents,
  Safe batching state and final Safe TxHash;
- public CMS items, wallet notification inbox and wallet-bound IN_APP endpoint
  registration.

Mall derives endpoint paths from the coordinated OpenAPI document and consumes
the generated response types. It does not maintain a parallel API schema.

The following Mall capabilities remain unpublished:

- seckill session state, timers, reports and event cursor;
- saved-address/profile persistence and PII-safe address parsing;
- canonical buyer-evidence generation/upload required before Mall may execute
  exchange, delay, receipt, pickup, arbitration or takeover commands;
- reward sub-type attribution separating genesis, direct referral, four region
  levels and operations within the aggregate `REWARD_NPL` rail;
- BNM account totals beyond order-linked Locked/Available projections;
- fulfillment and settlement WebSocket cursor replay.

No business-refund endpoint or action is part of V2.
