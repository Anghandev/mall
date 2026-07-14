# Mall Core Web3 Publication Boundary

Status: the previous handwritten `mall-web3-v1` proposal is retired. Mall uses
the coordinated payment ABI and ABI-shaped `routerCall`; it does not copy
PaymentRouter fragments or infer event signatures.

The `2.0.0-payment.1` publication provides BSC chain 56, fixed USDT/NPL
identity, exact versioned payment legs, MaxUint256 approval requirements with
revocation metadata, EIP-712 buyer authorization, PaymentRouter ABI-shaped
calls, submission binding and payment finality projections.

The manifest currently has no deployment authorization or executable
`PAY_ORDER`, so wallet writes remain disabled. Missing or mismatched artifacts,
wrong chain, invalid addresses, expired quote/reservation, unavailable RPC,
paused capability and unknown finality also fail closed.

Final success requires receipt status, expected chain/contract/event/resource,
block hash, confirmations and replacement/reorg reconciliation. TxHash alone is
never business finality.
