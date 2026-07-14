# Abu 24K V2 Payment Workers

Status: local payment checkpoint `2.0.0-payment.1`. Production RPCs, deployed
addresses, signer service and credentials remain `ExternalBlocked`.

## Indexer

The indexer loads `PaymentRouterV2` from the coordinated ABI bundle and an
address from the same-version manifest. It does not maintain a copied event
signature. Every decoded `PaymentCompleted` binds artifact version, Router,
event signature/hash, order, transaction, block hash/number and log index.

Canonical blocks must be contiguous and parent-linked. Replaying the same
block/hash is idempotent. A replacement segment proves a common ancestor before
the old branch is marked non-canonical. Payment projection, inventory
consumption, order creation, balanced Locked journals, finality and outbox writes
occur in one PostgreSQL transaction.

The runtime polling worker starts from the manifest's authoritative Router
`deploymentBlock`. It first persists the preceding block as a reorg baseline,
then ingests every canonical block, including blocks with no Router logs. Empty
blocks advance confirmations. Each poll compares RPC with the persisted
checkpoint, walks back to a proven common ancestor on mismatch and atomically
replaces the branch. Shutdown waits for the active poll before PostgreSQL closes.

The same transaction may be re-included in a different block. Reorg handling
posts a linked reversal and retains both branches as evidence. Before finality,
the selected reservation returns to its reserved state. A reorg after 15
confirmations never puts sold inventory back on sale: the selected reservation
remains consumed and the order enters reconciliation. Re-inclusion of the same
signed leg can rebuild the projection; a different seckill/fallback leg is
quarantined. Only at 15 confirmations is the unused reservation released.

## RPC Sources

The resilient contract reader requires independent primary and fallback BSC
RPC URLs and verifies chain 56. The Oracle adapter verifies the fixed
NPL/USDT pair, 30-minute window, age and liquidity. The beneficiary adapter
reads referral, four region beneficiaries and genesis eligibility from the
deployed registry. Both RPC providers failing returns `ExternalBlocked`.

## Payment Write Readiness

New ordinary and seckill quotes require a fresh runtime readiness snapshot.
Core verifies artifact checksums, chain 56, deployed code hashes for all four
contracts, immutable bindings, Safe-held roles, quote and secondary signers,
the TWAP source address/codehash/pair, PostgreSQL, Redis, remote signer identity
and a caught-up Indexer. The manifest must include each deployed address,
runtime code hash and the Router deployment block.

Missing fulfillment providers, audit storage or settlement Executor do not
disable payment quoting. Payment readiness never stops submission tracking,
payment reads, Indexer polling, finality or reorg recovery. The Indexer continues
running while `writesEnabled` is false.

## Signer

Core stores no quote private key. `RemoteSignerClient` sends only purpose,
bytes32 digest, resource, policy version, deadline and idempotency key to an
isolated signer. It recovers the returned signature and rejects any signer other
than the configured public address.

The same authenticated endpoint must answer the Core health request with
`status: READY` and its public signer address. Health identity is checked before
new quotes are enabled; each quote signature is still recovered independently.

Signer URL/token and public signer address are independent configuration. A
public address without a reachable isolated signer is not ready.

## Executor And Later Workers

The bounded executor validates chain, target, exact calldata, resource, policy,
integer amounts, zero native value, gas cap and replacement evidence. An
executor response is only `Submitted`; indexed receipt and canonical finality
remain separate evidence.

Fulfillment scheduling, takeover execution, Safe MultiSend settlement and
provider webhook workers belong to later checkpoints. Their existing internal
helpers and tests do not publish those HTTP/product capabilities in the payment
manifest. Payment breakers never stop indexer, finality, reorg recovery,
reconciliation or audit processing.
