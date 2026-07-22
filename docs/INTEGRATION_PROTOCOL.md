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

Core owns funds, contracts, Schema/migrations, database, API, payment receipt worker, signer,
executor, adapters, OpenAPI, ABI, manifests, generated types, enums, WebSocket
protocol and consumer tests. Products never duplicate or infer them.

Before a relevant Core batch exists, products may implement deterministic UI
and an explicit fail-closed state. This is temporary development progress, not
Requirement completion. Fixtures are test-only and must not enter a production
bundle.

## Publication And Consumption

Core publishes three coordinated checkpoints rather than one checkpoint per
small change:

1. payment: catalog/SKU, reservation, quote, allowance, PaymentRouter,
   ordinary/seckill payment, receipt finality and order creation;
2. fulfillment: shipment, logistics, pickup, exchange, delay, arbitration,
   takeover, administrative region and BNM Locked/Available;
3. settlement/admin: double-entry ledger, guarantee/debt, reward and settlement
   request, per-transfer EOA execution, policy, CMS, notifications, audit and monitoring.

Each checkpoint contains the same-version OpenAPI, Schema, generated types,
required ABI/deployment manifest, state/error enums, WebSocket protocol and the
consumer tests for that batch. Core does not publish a new RC for each small
change inside a batch.

The coordinating thread synchronizes each complete Core batch to all three
product branches. Each product immediately replaces its affected fail-closed
placeholder, consumes the published artifact and runs the narrow consumer,
type and UI tests for that batch. A local schema look-alike or handwritten
calldata is forbidden.

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

Such a record is blocked progress, not a completed Requirement ID. Disabled
controls, empty APIs/actions, static fixtures or review-only bypasses may not be
reported as delivery.

Core integrates one product commit at a time and immediately runs that
product's consumer test. Combined E2E starts only after every product consumes
the same Core artifact version.

## Runtime Boundary

```text
signed policy and reservation
  -> PaymentRouter atomic transfers to the configured funding EOAs
  -> submitted txHash plus status-1 Router receipt and expected event identity
  -> 15 canonical confirmations and atomic balanced Locked journal entries
  -> fulfillment / arbitration and Available entries
  -> signed settlement request and immutable per-payable EOA transfer intent
  -> 15-confirmation receipt plus reorg/replacement handling
  -> API projection plus allowedActions
  -> Mall / Merchant / Platform UI
```

No UI may set a final business state directly. Resource ID, wallet identity,
signature, expected event, block hash and confirmations remain bound end to
end.

## Combined Gate

The combined gate covers checkout, boundary classification, takeover
fulfillment, receipt/pickup/arbitration, BNM points, signed settlement requests,
EOA transfer execution, seckill, audit/finality, provider failures, permissions and every
Circuit Breaker.

A failed consumer or combined test reopens the originating Requirement ID.
Disabled/empty/static surfaces, screenshots, fixtures and isolated green unit
tests cannot override missing integration evidence or count as completion.

After the full local gate, one read-only full-repository security review is
allowed. Core fixes its bounded list; the same review task then checks only the
fix diff.
