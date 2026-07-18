# BSC Payment Deployment Evidence

`bsc-payment-v2.json` is the canonical, reviewable input for the five-role EOA
payment deployment. Before deployment it has `deploymentStatus: "PENDING"`, so
generated artifacts contain current ABI but no active address. It becomes
`DEPLOYED` only after deployment, source verification, EOA-role/immutable
verification and the release approval gate are complete.

`bsc-payment-v2-safe-superseded.json` preserves the previous Safe-bound
deployment evidence. Those contracts received no policy publication or user
funds and are permanently `SUPERSEDED`; the file must never become the active
manifest or be deleted as migration cleanup.

The file contains no secrets. It is committed with the release so both
`contracts:artifacts` and `artifacts:check` reproduce the same deployed manifest:

```json
{
  "artifactVersion": "2.0.0-settlement-admin.16",
  "chainId": 56,
  "architecture": "FIVE_ROLE_EOA_V2",
  "deploymentStatus": "DEPLOYED",
  "deploymentAuthorized": true,
  "authorizationEvidenceHash": "0x...32-byte-release-evidence-hash...",
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
blocks, invalid code hashes, a different artifact version or chain, and a
missing authorization evidence hash. Hand-editing generated manifests is never
a publication path.
