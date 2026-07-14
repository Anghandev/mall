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
  fulfillment finality. It is not a token and is never minted or claimed.
- Merchant default enters takeover fulfillment. V2 has no business-refund
  interface.
- Every write fails closed when its decision, RPC, Oracle, Safe, role or
  provider configuration is unavailable.

The binding authority is `../docs/V2_SYSTEM_CONTRACT.md`. The current coordinated
payment checkpoint is `2.0.0-payment.1`; later capabilities remain fail closed
until their matching checkpoint and consumer tests are published.
