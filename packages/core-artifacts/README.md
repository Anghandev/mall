# Core Artifacts

Version `2.0.0-settlement-admin.15` is the coordinated local V2 checkpoint for
OpenAPI, generated public types, state/error catalogs, the fail-closed
WebSocket protocol, ABI/event/role bundles, manifests and SHA-256 checksums.

It includes the payment checkpoint plus merchant stores, encrypted delivery and
pickup targets, wallet-scoped orders, shipment/logistics, pickup verification,
exchange/delay, arbitration, forced receipt, takeover and BNM
Locked-to-Available synchronization. It also publishes the append-only ledger,
signed settlement and Safe-batch projections, governed Admin operations, live
WebSocket events and seckill winner-review, rollover and payout projections.

The payment policy binds the dedicated service-fee Safe, exact Custody amounts
and fixed seckill-prize, node-reward and Locked reward-reserve allocations.
Pickup verification requires the snapshotted store and invalidates a credential
after five failed attempts.

This package does not authorize deployment or a mainnet transaction. Undeployed
contract addresses and missing production services remain fail closed.
Products must verify the coordinated manifest and keep unpublished capabilities
fail closed. They must not add parallel schemas or copy ABIs into product code.
