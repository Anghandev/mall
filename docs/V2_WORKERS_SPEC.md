# Abu 24K V2 Payment And Fulfillment Workers

Status: local settlement/admin checkpoint `2.0.0-settlement-admin.9`. Production RPCs, deployed
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

When a payment first appears with 15 or more confirmations in one historical
batch, `finalized_at` is the timestamp of its fifteenth canonical block. For an
incrementally observed payment, Core uses that same canonical timestamp when
available and the real confirmation observation time as fallback; it never
reuses the payment block timestamp as finality time.

The same transaction may be re-included in a different block. Reorg handling
posts a linked reversal and retains both branches as evidence. Before finality,
the selected reservation returns to its reserved state. A reorg after 15
confirmations never puts sold inventory back on sale: the selected reservation
remains consumed and the order enters reconciliation. Re-inclusion of the same
signed leg can rebuild the projection; a different seckill/fallback leg is
quarantined. Only at 15 confirmations is the unused reservation released.

## RPC Sources

The resilient contract reader requires independent primary and fallback BSC
RPC URLs and verifies chain 56. Core reads fixed-pair reserves at one common
block, verifies the NPL/USDT token identity and minimum USDT liquidity, and
computes the exact integer NPL amount before signing. The beneficiary adapter
reads referral, four region beneficiaries and genesis eligibility from the
deployed registry. Both RPC providers failing returns `ExternalBlocked`.

## Payment Write Readiness

New ordinary and seckill quotes require a fresh runtime readiness snapshot.
Core verifies artifact checksums, chain 56, deployed code hashes for all three
contracts, immutable bindings, Safe-held roles, quote and secondary signers,
the fixed-pair reserve source, PostgreSQL, Redis, remote signer identity
and a caught-up Indexer. The manifest must include each deployed address,
runtime code hash and the Router deployment block.

Missing fulfillment providers, audit storage or settlement Executor do not
disable payment quoting. Payment readiness never stops submission tracking,
payment reads, Indexer polling, finality or reorg recovery. The Indexer continues
running while `writesEnabled` is false.

Trusted risk observations use a separate internal token and immutable evidence
hash. The local rule engine applies the published Gas threshold and the frozen
wallet-switch/cancellation windows before either quote path. Production
mempool/RPC high-Gas collection, device fingerprint collection and their
provider credentials remain external inputs; Core does not fabricate those
observations when a source is absent.

## Signer

Core stores no quote or catalog-preview private key. `RemoteSignerClient` sends only purpose,
bytes32 digest, resource, policy version, deadline and idempotency key to an
isolated signer. It recovers the returned signature and rejects any signer other
than the configured public address.

The same authenticated endpoint must answer the Core health request with
`status: READY` and its public signer address. Health identity is checked before
new quotes are enabled; each quote signature is still recovered independently.

`PRODUCT_CONCESSION_PREVIEW` signs the EIP-712 digest for the latest product/SKU
fingerprint, canonical policy, exact destination allocation and five-minute
expiry. Catalog review never accepts an unsigned or stale financial preview.

Signer URL/token and public signer address are independent configuration. A
public address without a reachable isolated signer is not ready.

## Executor And Settlement Workers

The bounded executor validates chain, target, exact calldata, resource, policy,
integer amounts, zero native value, gas cap and replacement evidence. An
executor response is only `Submitted`; indexed receipt and canonical finality
remain separate evidence.

The settlement worker reserves the governed Safe nonce, builds an immutable
MultiSend batch from exact request items, attests the Safe runtime and submits
only matching calldata. Request, batch and finality transitions are append-only
and idempotent. A status-1 receipt becomes `Settled` only after 15 canonical
confirmations; replacements and reorgs preserve the old evidence and reopen the
affected liabilities without duplicating a payout.

Guarantee polling verifies exact ERC-20 Transfer evidence and rotates fairly
across pending and finalized deposits. Coverage polling reconciles each Safe
asset against unsettled liabilities and controls only the documented breaker.
Policy publication, notification, audit-outbox and monitoring workers use the
same bounded command and evidence rules; missing providers remain typed
`ConfigurationRequired` or `ExternalBlocked` rather than simulated success.

## Fulfillment Scheduling And Providers

The scheduler uses the indexed 15-confirmation payment-finality timestamp. It
may open delivery takeover after seven days without shipment evidence and
records pickup timeout as `DecisionBlocked`; it never guesses a pickup policy.
One order failure does not stop later eligible orders. Unexpected failures are
persisted as retry/dead-letter `OPEN_TAKEOVER` jobs and exposed by worker status;
`available_at` and terminal job state control whether another attempt may run,
and the timer does not silently discard a rejected polling cycle.
Payment and settlement breakers do not stop this scheduler or any fulfillment,
takeover, arbitration, reconciliation or audit action.

Kuaidi100 and Cainiao callbacks authenticate an HMAC over exact raw body bytes.
Each provider/event identity is immutable and idempotent. Unsupported status,
future timestamp, bad signature or missing secret fails closed. A `DELIVERED`
event moves only the fulfillment state; it does not itself release balances.

AMap reverse geocoding validates the national six-digit region code and records
the response evidence hash. Missing key, malformed provider response or region
drift returns `ConfigurationRequired`, `ExternalBlocked` or an idempotency
conflict without storing plaintext delivery data.

## BNM Availability

Fulfillment completion writes one `BnmAvailabilityRequested` outbox event in
the same PostgreSQL transaction as the order and ledger transition. The BNM
worker calls only a configured HTTPS backend endpoint with order, buyer, exact
integer point amount, state, monotonic order-scoped `stateVersion`, reason and
evidence hash. The backend must atomically apply only a version newer than its
stored version, treat an equal version with changed content as a conflict, and
ignore lower versions. Acknowledgements must match the idempotency identity and
prove the requested effective version/state; missing or mismatched proof is
`ExternalBlocked`. `BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH` is set only from a
verified delayed-write conformance run; without it provider readiness remains
`CONFIGURATION_REQUIRED`, bootstrap does not start the worker and the adapter
does not issue an HTTP request. Ordinary failures remain retryable and never fabricate
success. Events for one order are leased strictly FIFO, including expired-lease
recovery. A deep payment reorg cancels an unsent `AVAILABLE` event and always
appends a higher-version `LOCKED` synchronization. An external call already in
flight is fenced locally by its unique worker identity and attempt token and
externally by the monotonic version. After that call resolves or fails
ambiguously, the canceled `AVAILABLE` is never sent again; even a server-side
late arrival cannot overwrite the newer `LOCKED` state.
Outer lease or retry-write failures remain visible in worker status and do not
make `stop()` reject.
BNM has no token, mint, Claim, Safe transfer or settlement executor path.

Safe MultiSend settlement and administrative workers are published in this
checkpoint. Their production execution remains disabled until same-version
deployment evidence and external Safe/RPC/signer inputs are present. Payment
breakers never stop Indexer, finality, reorg recovery, fulfillment,
reconciliation or audit processing.
