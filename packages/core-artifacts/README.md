# Core Artifacts

This package has no runtime exports while the coordinated Core artifact set is
unpublished. `contracts/` contains the deterministic contract-only freeze at
`2.0.0-contracts.1`: ABI bundle, event and role catalogs, deployment manifest
template and SHA-256 checksums.

The contract snapshot is not permission to deploy and is not yet consumable by
products. Core will publish OpenAPI, generated types, enums, WebSocket protocol
and consumer tests at the same coordinated checkpoint. Products must not add
parallel schemas or copy these ABIs into their own source trees.
