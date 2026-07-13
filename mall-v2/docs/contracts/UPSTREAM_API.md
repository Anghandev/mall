# Mall Core API Publication Boundary

Status: the previous handwritten `mall-api-v1` proposal is retired. It was not
a published Core contract and must not be implemented or copied.

Core will publish one versioned OpenAPI document and generated consumer types
after contracts, Schema and shared states are frozen. Until then Mall exposes
fail-closed UI only and does not guess endpoint paths, payloads, amount fields,
errors or state transitions.

The publication must cover the Requirement Matrix capabilities, including:

- bootstrap/network/artifact version and provider readiness;
- products/SKUs, signed quotes and inventory reservations;
- seckill state, both signed quotes, timers, reports and event cursor;
- addresses, stores, logistics, order/takeover/receipt/arbitration projections;
- reward/Claim projections and ordered transaction intents;
- `allowedActions`, exact disabled reasons and transaction finality;
- idempotency, cursor replay, replacement/reorg and typed errors.

No business-refund endpoint or action is part of V2.
