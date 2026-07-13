# V2 Integration Protocol

One coordinating Goal owns Core and integration. The three product worktrees
are controlled consumers under that Goal, not independent Goals.

## Checkpoints And Worktrees

1. Phase 1 is completed and committed in the main `v2/core` workspace.
2. One clean V2 workspace baseline is committed by Core.
3. From the same Core checkpoint, Core creates:
   - `codex/v2-mall-rewrite`, writable only under `mall-v2/`;
   - `codex/v2-merchant-rewrite`, writable only under `merchant-v2/`;
   - `codex/v2-platform-admin-rewrite`, writable only under
     `platform-v2/admin/`.
4. No two writers use the same worktree. Product worktrees do not rebase,
   rewrite shared history or cherry-pick individual shared commits.

## Shared Authority

Core owns funds, contracts, Schema/migrations, database, API, indexer, signer,
executor, adapters, OpenAPI, ABI, manifests, generated types, enums, WebSocket
protocol and consumer tests. Products never duplicate or infer them.

Before Core publishes a coordinated artifact version, products may implement
only deterministic UI and fail-closed states. Fixtures are test-only and must
not enter a production bundle.

## Publication And Consumption

Core publishes one checkpoint containing the same-version OpenAPI, generated
types, ABI bundle, deployment manifest, state/error enums, WebSocket protocol
and payment/reservation/settlement/takeover/fulfillment/Claim/seckill/finality
consumer tests.

The coordinating thread synchronizes the complete Core checkpoint to all three
product branches. Each product then replaces only its affected fail-closed
placeholder, consumes the published artifact and runs its consumer, type and UI
tests. A local schema look-alike or handwritten calldata is forbidden.

## Product Delivery Report

Every product delivery reports:

- completed Requirement IDs;
- commit hash and modified files;
- test commands and results;
- required Core capability;
- `ExternalBlocked` items;
- whether any production fixture exists.

When Core capability is missing, the only accepted record is:

```text
Requirement ID + required capability + fail-closed behavior
```

Core integrates one product commit at a time and immediately runs that
product's consumer test. Combined E2E starts only after every product consumes
the same Core artifact version.

## Runtime Boundary

```text
signed policy and reservation
  -> ordered wallet transaction intents
  -> receipt plus expected event identity
  -> confirmations and reorg/replacement handling
  -> indexed domain state
  -> API projection plus allowedActions
  -> Mall / Merchant / Platform UI
```

No UI may set a final business state directly. Resource ID, wallet identity,
signature, expected event, block hash and confirmations remain bound end to
end.

## Combined Gate

The combined gate covers checkout, boundary classification, takeover
fulfillment, receipt/pickup/arbitration, settlement, all Claims, seckill,
audit/finality, provider failures, permissions and every Circuit Breaker.

A failed consumer or combined test reopens the originating Requirement ID.
Screenshots, fixtures, static strings and isolated green unit tests cannot
override failed integration evidence.

After the full local gate, one read-only full-repository security review is
allowed. Core fixes its bounded list; the same review task then checks only the
fix diff.
