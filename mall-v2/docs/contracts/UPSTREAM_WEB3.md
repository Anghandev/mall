# Mall Core Web3 Publication Boundary

Status: the previous handwritten `mall-web3-v1` proposal is retired. Mall uses
the coordinated payment ABI and ABI-shaped `routerCall`; it does not copy
PaymentRouter fragments or infer event signatures.

The `2.0.0-fulfillment-launch.28` publication provides BSC chain 56, fixed USDT/NPL
identity, exact five-minute Core-signed payment legs, MaxUint256 approval
requirements with revocation metadata, EIP-712 buyer authorization,
PaymentRouter ABI-shaped calls, submission binding and payment finality
projections. Mall renders the exact 70% USDT + 30% equivalent NPL quote and
never calculates the NPL amount.

The same checkpoint provides wallet-bound EIP-712 settlement intents. Mall
validates the wallet, recipient, chain, asset, configured executor EOA, expiry,
message and digest before signing, then submits only the signature to Core. It
never constructs an ERC-20 transfer. Final settlement is rendered only from
Core's 15-confirmation EOA execution projection and final TxHash.

The manifest currently has no deployment authorization or executable
`PAY_ORDER`, so wallet writes remain disabled. Missing or mismatched artifacts,
wrong chain, invalid addresses, expired quote/reservation, unavailable RPC,
paused capability and unknown finality also fail closed.

Final success requires receipt status, expected chain/contract/event/resource,
block hash, confirmations and replacement/reorg reconciliation. TxHash alone is
never business finality.
