# Abu 24K V2 Chain Workers

Status: local Core worker checkpoint. Production RPC, deployed contract
addresses, signer/executor services and credentials remain `ExternalBlocked`.

## Indexer

The indexer loads the frozen ABI bundle and an address manifest. It does not
copy event signatures into a parallel decoder. Every accepted log binds
artifact version, contract, event signature, resource ID, transaction, block
hash/number and log index.

Blocks must be contiguous and parent-linked to the stored canonical
checkpoint. Replaying the same block/hash is idempotent. A conflicting block or
parent records a reorg boundary and returns `ReorgPending`; no derived state is
presented as final until replay and confirmation complete.

## Signer

Core contains no signing key. `RemoteSignerClient` sends a purpose, bytes32
digest, exact resource, policy version, deadline and idempotency key to an
isolated signer service. It recovers the returned signature and rejects any
signer other than the configured quote/finality/secondary wallet.

Signer URL/token and public signer addresses are separate configuration. A
public address without a reachable isolated signer remains `ExternalBlocked`.

## Executor

Core contains no deployer/owner key. The remote executor accepts only chain 56,
an exact target/calldata, zero native value, resource/policy/idempotency fields
and a configured gas cap. Replacement requests bind the prior transaction hash
and the response must echo that relationship.

Execution returns `Submitted`, never final success. The indexer/finality worker
must still verify receipt status, expected event/resource, canonical block and
confirmations.

## Scheduler And Queue

The scheduler emits idempotent durable jobs for eligible seven-day delivery
takeover and forced-receipt review. Pickup timeout produces
`PickupTakeoverDecisionBlocked` and no guessed job. PostgreSQL durable jobs and
outbox rows survive process/Redis failure and use bounded leases/retries.

Customer-facing breakers never stop indexer, finality, takeover, recovery,
reconciliation or audit processing.
