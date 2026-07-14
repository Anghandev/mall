# BSC Mainnet Micro-Test Approval Plan

Status: `NOT AUTHORIZED` and `NON-EXECUTABLE`.

This plan is bound to Core artifact `2.0.0-rc.2` and Core checkpoint
`20a28f9`. It does not authorize a deployment, approval, token transfer or
transaction. `pnpm micro:preflight` has not been run and no ignored `.env` or
private key has been read.

## Current Gate

Execution is blocked while `packages/core-artifacts/coordinated-manifest.json`
has `deploymentAuthorized: false`, any `DecisionBlocked` item remains, or any
required external input is absent.

Before an approval packet can be generated, Core must receive and verify:

- the published launch `ProductPolicy`, including all 13 manifest-listed
  decisions and the required BSC confirmation count;
- Safe, secondary signer, quote signer, finality signer, TWAP source and all
  role addresses;
- BSC RPC and fallback RPC, deployed contract addresses, production HTTPS,
  remote signer/executor mTLS and health evidence;
- actual deployed runtime-code hashes, role grants, Safe admin and signer
  getter attestations for the same artifact version;
- dedicated test wallets and explicit maximum BNB, USDT and NPL budgets;
- encrypted backup storage, provider accounts, approved merchant/admin
  wallets and required device evidence.

The known provider key in five immutable V1 Phase 1 blobs must be rotated
outside this repository. V1 history remains read-only until a separate
cutover task is approved.

## Deployment Targets

The only permitted deployment order is the order in the coordinated contract
manifest:

1. `PolicyRegistryV2`
2. `BeneficiaryRegistryV2`
3. `TwapOracleAdapterV2`
4. `BNMTokenV2`
5. `ClaimVaultV2`
6. `RewardLedgerV2`
7. `MerchantGuaranteeVaultV2`
8. `PaymentEscrowV2`
9. `SeckillV2`
10. Every manifest-listed post-deployment role grant
11. Launch policy publication through RBAC, secondary signature and Safe

No deployment script or production address manifest is currently published.
Those are `ExternalBlocked`; they must be implemented, audited and dry-run
against a BSC fork before byte-level deployment calldata is proposed.

## Calldata Approval Record

Every proposed transaction must be recorded before approval with:

```text
chainId = 56
from role and expected signer
to contract name and deployed address
function signature and 4-byte selector
SHA-256/keccak256 of exact calldata
resourceId and policyVersion
every USDT/NPL/BNM amount in integer token units
native value
idempotency key
replacementForTxHash, if any
eth_estimateGas result, gas limit and max fee
expected events, state changes and balance deltas
```

The Executor must independently decode the same ABI and match target,
selector, resource, policy and every amount. Unknown targets, selectors,
trailing calldata, replacement mismatches or missing bindings stop the run.

Exact calldata hashes are intentionally absent from this document: contract
addresses and policy values are not available, so producing them now would be
guessing.

## Micro-Test Sequence

After deployment and role verification, the separately approved run is:

1. Publish the approved launch policy and verify its immutable snapshot.
2. Configure the dedicated merchant, beneficiary and regional test snapshot.
3. Fund only the approved micro guarantee, risk reserve, buyer USDT and buyer
   NPL amounts.
4. Execute one ordinary dual-leg purchase and prove exact USDT/NPL debits,
   20% NPL Burn, 80% Locked routing and Locked BNM.
5. Record shipment/delivery and submit one finality attestation at the approved
   confirmation threshold; prove merchant USDT and rewards release only then.
6. Execute one micro merchant Claim, one NPL reward Claim and one BNM Claim.
7. Create one 60-minute seckill session, execute one final purchase that adds
   30 seconds without exceeding the 60-second relay cap, settle it and execute
   one micro prize Claim.
8. Exercise pause, blocked write, allowed reconciliation/recovery read and
   resume with Safe-held RBAC evidence.
9. Revoke temporary token allowances and reconcile every wallet, contract,
   Burn address, liability and audit-chain balance.

Micro token amounts remain `DecisionBlocked` until the approved policy makes
all integer conservation and Burn constraints satisfiable. No test fixture or
locally invented amount may be substituted.

## Gas And Budget

The hard default ceilings are:

- native value per transaction: `0.0001 BNB`;
- maximum gas cost per transaction: `0.0002 BNB`;
- cumulative native spend: `0.001 BNB`.

Before broadcast, each transaction must pass `eth_estimateGas` and the locked
spend ledger in `scripts/microtest/tx-guard.mjs`. The exclusive lock must cover
budget check, broadcast, receipt wait and atomic receipt logging. Successful
transactions count gas plus native value; failed mined transactions still
count gas. Transaction hashes are unique.

If the full deployment and test sequence cannot fit these ceilings, execution
stops. The limits are not raised without a new bounded user approval.

## Stop Conditions

Stop before the next broadcast when any of these occurs:

- missing or mismatched artifact, manifest, address, bytecode or role evidence;
- RPC chain mismatch, provider outage, reorg, replacement mismatch or receipt
  status other than `1`;
- quote expiry, Oracle age/liquidity/deviation failure or finality shortfall;
- unexpected event, balance delta, liability, Burn, reward or BNM result;
- failed assertion, failed audit append, lock conflict or damaged spend log;
- per-transaction or cumulative gas/budget excess.

## Recovery

There is no business-refund fallback. If a technical incident occurs:

- Safe pauses only the affected new-order, seckill or Claim scope;
- fulfillment, takeover, reconciliation, audit reads and finality sync remain
  available;
- an unverified deployment is not added to the production manifest, signers
  and executors stay disabled, and erroneous roles are revoked;
- only provable surplus may be recovered through the Safe-only recovery
  functions; recorded liabilities remain untouched;
- every action, transaction hash, receipt, event, balance proof and decision is
  appended to the audit package before any resume decision.

User approval must name the exact transaction count, calldata hashes, token
amounts and BNB ceiling. Approval of this document alone is not approval to
transact.
