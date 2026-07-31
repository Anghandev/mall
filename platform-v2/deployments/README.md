# BSC Payment Deployment Evidence

`bsc-payment-v2.json` is the canonical, reviewable input for the five-role EOA
payment deployment lineage. Before deployment it has `deploymentStatus:
"PENDING"`, so generated artifacts contain current ABI but no active address. A
`DEPLOYED` file proves the historical address/code lineage only. It does not
authorize the current `.30` production release, buyer acceptance or Mainnet Go.

`bsc-payment-v2-safe-superseded.json` preserves the previous Safe-bound
deployment evidence. Those contracts received no policy publication or user
funds and are permanently `SUPERSEDED`; the file must never become the active
manifest or be deleted as migration cleanup.

`bsc-payment-v2-eoa-router-superseded-pre-launch.json` preserves the first
EOA-bound Router after its pre-launch service-fee-recipient replacement. The
production database had no orders, quotes, reservations or seckill sessions at
cutover. The Policy and Beneficiary registries remain active; only that Router
is historical and it must never be restored as the active manifest entry.

The file contains no secrets. It is committed with the release so both
`contracts:artifacts` and `artifacts:check` reproduce the same deployed manifest:

```json
{
  "artifactVersion": "2.0.0-settlement-admin.16",
  "chainId": 56,
  "architecture": "FIVE_ROLE_EOA_V2",
  "deploymentStatus": "DEPLOYED",
  "deploymentAuthorized": false,
  "historicalLineageOnly": true,
  "authorizationEvidenceHash": "0x...32-byte-release-evidence-hash...",
  "historicalAuthorization": {
    "deploymentAuthorized": true,
    "authorizationEvidenceHash": "0x...32-byte-release-evidence-hash..."
  },
  "contracts": {
    "PolicyRegistryV2": {
      "address": "0x...",
      "deploymentBlock": 0,
      "deployedCodeHash": "0x..."
    },
    "BeneficiaryRegistryV2": {
      "address": "0x...",
      "deploymentBlock": 0,
      "deployedCodeHash": "0x..."
    },
    "PaymentRouterV2": {
      "address": "0x...",
      "deploymentBlock": 0,
      "deployedCodeHash": "0x..."
    }
  }
}
```

The generator rejects missing/extra contracts, duplicate addresses, invalid
blocks, invalid code hashes, a different artifact version or chain, a missing
historical authorization evidence hash, or any attempt to mark this lineage file
as current release authorization. Hand-editing generated manifests is never a
publication path.

## Historical fulfillment-launch authorization

`historical/bsc-fulfillment-launch-authorization.29-historical-revoked.json`
archives the previous `.29` launch authorization and is **not** a current
release gate, rollback target or deploy input. Current `.30` release authority is
external: each `SUSPENDED`, `MICROTEST_AUTHORIZED`, `GO` or `NO_GO` decision is a
separate signed JSON file whose path and SHA-256 are supplied to deploy/runtime
preflight commands.
