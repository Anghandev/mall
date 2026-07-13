# Mall V2 Upstream Web3 Contract

Status: consumer proposal `mall-web3-v1`.

## Runtime Discovery

The app reads chain and addresses from `/api/dapp/bootstrap`. It does not import platform source files or deployment manifests.

Required fields:

- `chainId`: `56`
- `explorerUrl`
- `confirmationsRequired`
- `tokens.USDT` and `tokens.NPL`: address, symbol, decimals
- `contracts.paymentEscrow`, `contracts.seckill`, `contracts.rewardLedger`
- feature availability and pause reasons

All addresses are validated as nonzero checksummed EVM addresses before wallet writes are enabled.

## Allowance And Approval

The customer app may call only these ERC-20 reads directly:

```solidity
function allowance(address owner, address spender) external view returns (uint256);
function balanceOf(address owner) external view returns (uint256);
```

Approval transaction calldata is supplied by the upstream intent. The UI discloses token, spender, requested amount, and a block-explorer token-approval route. USDT and NPL are checked independently. A revoked or insufficient allowance requests approval again.

## Transaction Sequence

The app executes the ordered `WalletTransaction[]` from the intent. Expected logical keys are:

- `approve-usdt` when required
- `approve-npl` when required
- `pay-order`
- `record-seckill-purchase` when required
- `complete-order`
- `claim-reward`

The app must not construct settlement calldata, substitute receivers, change token amounts, or reorder dependency-linked transactions.

## Transaction State Machine

```text
idle
  -> awaiting-wallet
  -> submitted(txHash)
  -> confirming(receipt status=1, confirmations < required)
  -> finalized

awaiting-wallet -> rejected
submitted|confirming -> replaced(newTxHash)
submitted|confirming -> reverted
submitted|confirming -> rpc-unavailable (resume polling)
```

Only `finalized` can trigger an authoritative aggregate refresh. Local transaction state is presentation state, not an order or reward ledger.

## Required Event Evidence

The platform transaction-status endpoint maps receipts to an expected domain event and resource identifier. The app requires all of the following before final success:

- receipt `status=1`
- expected chain and contract address
- expected event signature
- expected order/session/reward identifier
- `confirmations >= confirmationsRequired`
- no replacement or reorg incident

## Security Boundary

- The app supports EOA and compatible smart-account providers; it does not use `tx.origin` assumptions.
- PII is never put into calldata. Orders bind an opaque address/store identifier, region code, and signed digest.
- Missing contracts, invalid addresses, stale quote/reservation, wrong chain, unavailable RPC, paused features, and unknown finality all fail closed.
- Emergency pause and recovery are upstream responsibilities. The app displays pause reason and available recovery actions returned by the API.

