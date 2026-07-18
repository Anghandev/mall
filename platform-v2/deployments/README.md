# BSC Payment Deployment Evidence

`bsc-payment-v2.json` is the canonical, reviewable input for publishing a
deployed payment artifact. It must not exist until deployment, source
verification, Safe/role verification and the release approval gate are complete.

The file contains no secrets. It is committed with the release so both
`contracts:artifacts` and `artifacts:check` reproduce the same deployed manifest:

```json
{
  "artifactVersion": "2.0.0-settlement-admin.16",
  "chainId": 56,
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
