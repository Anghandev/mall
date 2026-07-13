# Abu 24K Platform Core V2

This directory owns the clean V2 contracts, server, data interfaces, chain
workers and the `admin/` product consumer. It must not import V1 runtime code.

## Frozen Boundary

- Product price and merchant settlement cost are USDT-denominated.
- Buyer payment uses exact versioned USDT and NPL legs.
- Payment finality sends 20% NPL to the Burn address and locks 80% for frozen
  circulation/reward routing.
- Merchant proceeds are USDT-only after fulfillment finality.
- BNM is order-linked, Locked at payment, Available at fulfillment finality and
  minted on Claim.
- Merchant default enters takeover fulfillment. V2 has no business-refund
  interface.
- Every write fails closed when its decision, RPC, Oracle, Safe, role or
  provider configuration is unavailable.

The binding authority is `../docs/V2_SYSTEM_CONTRACT.md`. Existing business
source under this directory is not a clean-rewrite baseline until the later
workspace-baseline phase replaces it and its tests pass.
