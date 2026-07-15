# Abu 24K Platform Core V2

This directory owns the clean V2 contracts, server, data interfaces, chain
workers and the `admin/` product consumer. It must not import V1 runtime code.

## Frozen Boundary

- Product price and merchant settlement cost are USDT-denominated.
- Buyer payment is exactly 70% USDT plus 30% Oracle-equivalent NPL.
- Payment sends USDT directly to the Custody Safe, 20%-of-list NPL to Burn and
  10%-of-list NPL to the Reward Safe; PaymentRouter normally retains zero.
- Merchant proceeds are USDT-only and later settle from the append-only ledger
  through Safe MultiSend.
- BNM is order-linked backend points, Locked at payment and Available after
  fulfillment finality. Monotonic order state versions fence late provider
  writes. BNM is not a token and is never minted or claimed.
- Seckill prize USDT uses an explicit governed liability purpose and remains
  Locked through order fulfillment until session settlement.
- Pickup verification is bound to the snapshotted store and rate-limited with
  persistent, idempotent failed-attempt evidence.
- Merchant default enters takeover fulfillment. V2 has no business-refund
  interface.
- Every write fails closed when its decision, RPC, Oracle, Safe, role or
  provider configuration is unavailable.

The binding authority is `../docs/V2_SYSTEM_CONTRACT.md`. The current coordinated
settlement/admin checkpoint is `2.0.0-settlement-admin.3`; production execution
remains fail closed until same-version consumers, deployment evidence and the
required external Safe, signer, RPC and provider inputs pass their release
gates.
