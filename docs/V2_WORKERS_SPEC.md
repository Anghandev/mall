# 24K商城 V2 Payment And Fulfillment Workers

Status: receipt-worker architecture revision. The EOA-bound contracts and
historical bounded BSC execution evidence remain published; current production
database, signer and provider operations remain launch-time configuration.

## Payment Receipt Worker

The worker loads `PaymentRouterV2` from the coordinated ABI bundle and its
address from the same-version manifest. It resumes every known unresolved
replacement-lineage hash from
`payment_quotes` and `transaction_finality`; restart never requires a deployment
height or historical block catch-up. A replacement cannot evict a hash with a
mined status-1 receipt, and older declared replacements remain observable until
one exact Router payment wins finality.

For each `SUBMITTED` or `REORGED` hash, the primary RPC verifies Chain 56,
status 1, the active Router target, canonical receipt block and the exact
`PaymentCompleted` identity and signed snapshot. At 15 confirmations the
fallback RPC independently verifies the same receipt evidence. Normal polling
does not query both RPCs block by block. If a stored receipt reappears under the
same txHash in another block, both RPCs must prove replacement of the old block
before the worker records a reorg; it never rewrites FINAL block identity.

A seckill-classified receipt must contain one matching
`SeckillRelayExtended` after `PaymentCompleted`. Receipt events are sorted by
block and log index. Payment, relay, inventory consumption, order creation,
balanced Locked journals, finality and outbox writes occur in one PostgreSQL
transaction. Three receipts are finalized in chain order even if RPC responses
arrive out of order. A same-session quote or active replacement lineage whose
receipt is temporarily unavailable keeps a later relay retryable; once that
lineage is proven failed it no longer masks a poisoned later deadline.

`finalized_at` is the fifteenth canonical block timestamp. Before 15
confirmations a missing or replaced receipt returns to `REORGED`/pending and no
new receipt-driven business projection is admitted. A discovered post-finality
deep reorg pauses the relevant breaker and creates `RECONCILE`/manual evidence.
Ordinary FINAL hashes are audited for 24 hours; seckill FINAL hashes remain
audited until that session is settled or force-closed;
the worker does not automatically maintain or replay full historical branches.

After deadline, any unresolved quote is excluded only after both RPCs report
`PaymentRouter.usedOrderId(orderId) == false` at one matching canonical block
whose timestamp has reached the signed deadline. Core persists that proof before
release. `true` creates durable manual-recovery evidence, leaves the quote and
inventory unresolved and prevents session close until the wallet record, buyer,
Admin or Operator restores the exact txHash. The worker never scans Router
history to guess a missing hash.

Production does not continuously store canonical or empty blocks and has no
global caught-up/lag gate. Historical `chain_*` tables, checkpoints and the old
continuous Indexer implementation remain isolated rollback evidence only; no
shadow dual-write, old-session migration or automatic A-to-B-to-A recovery is
required.

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
contracts, the Router's immutable Platform Governance EOA binding, Registry EOA-held
roles, quote and secondary signers, the fixed-pair reserve source, PostgreSQL,
Redis, remote signer identity and a healthy `PaymentReceiptWorker`. The manifest
must include each deployed address, runtime code hash and Router deployment block.

Missing fulfillment providers, audit storage or settlement Executor do not
disable payment quoting. Receipt-worker or RPC failure pauses only new ordinary
and seckill quotes and new seckill sessions. TxHash submission/recovery, payment
reads, finality/reorg reconciliation, fulfillment, settlement and audit remain
available.

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

The settlement worker creates one immutable ERC-20 transfer intent per payable,
reserves the configured executor EOA nonce and submits only the bound token,
recipient, amount, calldata and gas cap. Request, transfer and finality
transitions are append-only and idempotent. A status-1 receipt becomes `Settled`
only after 15 canonical confirmations; replacements and reorgs preserve the old
evidence and reopen affected liabilities without duplicating a payout.

Guarantee polling verifies exact ERC-20 Transfer evidence and rotates fairly
across pending and finalized deposits. Coverage polling reconciles each funding EOA
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

Kuaidi100 and Cainiao callbacks are Phase 2 compatibility surfaces and are not
started or required for launch. When configured, they authenticate an HMAC over exact raw body bytes.
Each provider/event identity is immutable and idempotent. Unsupported status,
future timestamp, bad signature or missing secret fails closed. A `DELIVERED`
event moves only the fulfillment state; it does not itself release balances.

AMap reverse geocoding is Phase 2. Launch accepts complete audited manual
province/city/district/six-digit-code input and does not call a map provider.
When configured, reverse geocoding validates the national six-digit region code and records
the response evidence hash. Missing key, malformed provider response or region
drift returns `ConfigurationRequired`, `ExternalBlocked` or an idempotency
conflict without storing plaintext delivery data.

## BNM Availability

Ordinary and seckill quote creation first calls the same authenticated backend
for a read-only wallet-registration check. A missing registration returns
`Forbidden` before inventory reservation, quote signing or payment broadcast;
transport, authentication or malformed-response failures remain
`ExternalBlocked`. The check never creates a user or changes BNM state.
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
The existing backend has passed the delayed-write conformance suite and a live
Core HTTP-adapter `LOCKED` version-advance smoke test with zero atomic and legacy
projection balance deltas. Its endpoint, token and evidence hash remain ignored
runtime configuration; production Core deployment and worker monitoring are
still operational rollout work.
BNM has no token, mint, Claim, EOA transfer or settlement executor path.

Per-payable EOA settlement and EOA-governed administrative workers are published
in this checkpoint. Settlement and breaker finality use canonical receipts,
events and confirmations; coverage uses stable dual-RPC `latest` observations.
Production requires two distinct Chain-56 RPC endpoints, not Archive state.
Payment breakers never stop receipt tracking, finality, reorg recovery,
fulfillment, reconciliation or audit processing.
