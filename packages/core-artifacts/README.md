# Core Artifacts

Version `2.0.0-fulfillment-launch.24` is the current coordinated local V2
No-Go repair baseline for
OpenAPI, generated public types, state/error catalogs, the fail-closed
WebSocket protocol, ABI/event/role bundles, manifests and SHA-256 checksums.
Historical deployment lineage remains recorded under
`2.0.0-settlement-admin.16`; that lineage does not authorize the current
three-buyer mainnet acceptance run or a production Go decision.

It includes the payment checkpoint plus merchant stores, encrypted delivery and
pickup targets, wallet-scoped orders, shipment/logistics, pickup verification,
exchange/delay, arbitration, forced receipt, takeover and BNM
Locked-to-Available synchronization. It also publishes the append-only ledger,
signed settlement and immutable per-payable EOA transfer projections, governed
Admin operations, live WebSocket events and seckill winner-review, rollover and
payout projections.

The payment policy binds the dedicated service-fee EOA, exact Custody amounts
and fixed seckill-prize, node-reward and Locked reward-reserve allocations.
Core signs exact five-minute NPL quotes from matching fixed-pair reserves; the
Router has no external price-contract dependency.
Pickup verification requires the snapshotted store and invalidates a credential
after five failed attempts.

This package does not authorize deployment or a mainnet transaction. Current
status remains No-Go until the new release id, Abu V2 preflight-bound
W5/W1/W6 packet, real three-buyer evidence, cleanup gate and production
observation all pass. Missing production services remain fail closed.
Products must verify the coordinated manifest and keep unpublished capabilities
fail closed. They must not add parallel schemas or copy ABIs into product code.
