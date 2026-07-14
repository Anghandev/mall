# Core Artifacts

Version `2.0.0-fulfillment.1` is the coordinated local fulfillment checkpoint for
OpenAPI, generated public types, state/error catalogs, the fail-closed
WebSocket protocol, ABI/event/role bundles, manifests and SHA-256 checksums.

It includes the payment checkpoint plus merchant stores, encrypted delivery and
pickup targets, wallet-scoped orders, shipment/logistics, pickup verification,
exchange/delay, arbitration, forced receipt, takeover and BNM
Locked-to-Available synchronization. Settlement and live WebSocket capabilities
remain unpublished and fail closed.

The payment policy explicitly binds `seckillPrizePoolAccount`; generated USDT
allocations use the closed `POLICY_ALLOCATION | SECKILL_PRIZE_LIABILITY`
purpose set. Fulfillment keeps the latter Locked. Pickup verification requires
the snapshotted store and invalidates a credential after five failed attempts.

This package does not authorize deployment. Contract addresses, production
accounts, providers, devices and domains remain `ExternalBlocked`; unresolved
commercial allocation decisions remain `DecisionBlocked`.
Products must verify the coordinated manifest and keep unpublished capabilities
fail closed. They must not add parallel schemas or copy ABIs into product code.
