# V2 Integration Protocol

The three product Goals are consumers of one shared platform. A product Goal is
not complete when its local UI or fixtures pass; completion requires integration
against the same published core artifacts and the combined end-to-end gate.

## Shared Authority

The core Goal owns contracts, funds, database state, API, indexer, signer,
external adapters, deployment, and cross-product tests. It publishes versioned:

- OpenAPI and generated TypeScript types;
- ABI bundles and deployment manifests;
- state and error enums;
- payment, reservation, settlement, refund, claim, and finality consumer tests.

Customer Mall, Merchant Workbench, and Platform Operations must consume those
artifacts. They may not duplicate schemas, infer money, invent endpoints, or
turn missing `allowedActions` into permission.

## Delivery Loop

1. A product Goal records a missing capability in its owned upstream-gap file
   and reports the affected requirement IDs to the core Goal.
2. The core Goal resolves product decisions, implements the shared capability,
   runs provider and contract tests, and publishes one versioned checkpoint.
3. The coordinating thread synchronizes that checkpoint into all three product
   branches. Product Goals do not cherry-pick or rewrite shared history.
4. Each affected product replaces its fail-closed placeholder with a consumer
   of the published artifact and runs its consumer, type, and UI tests.
5. The core Goal integrates product commits containing only owned paths and runs
   combined checkout, fulfillment, refund, settlement, Claim, seckill, audit,
   finality, and permission E2E.
6. A failed consumer or combined test reopens the originating requirement. A
   local fixture, screenshot, static string check, or green unit test cannot
   override failed integration evidence.

## Runtime Flow

```text
signed policy and reservation
  -> ordered wallet transaction intents
  -> contract receipt and expected event
  -> confirmation and reorg handling
  -> indexed domain state
  -> API projection plus allowedActions
  -> Mall / Merchant / Operations UI
```

No UI may skip a step by directly setting a final business state. Resource IDs,
wallet identity, signatures, expected event identity, block hash, and required
confirmations remain bound through the entire flow.

## Completion Gate

The combined project is complete only when:

- all three product matrices are integrated against the same core version;
- no local-fixable requirement remains Partial or Missing;
- all consumer-contract and cross-product E2E tests pass;
- Circuit Breaker activation, blocked actions, recovery actions, resume, and
  permission failures are proven;
- fixtures and mocks are excluded from production evidence;
- external services, production HTTPS, devices, and bounded BSC micro-tests are
  verified when the user supplies and approves those release inputs.

Until then, each Goal remains active or accurately reports an external/core
blocker. It must not mark the product or combined project complete.
