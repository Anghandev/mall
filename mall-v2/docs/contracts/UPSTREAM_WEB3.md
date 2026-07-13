# Mall Core Web3 Publication Boundary

Status: the previous handwritten `mall-web3-v1` proposal is retired. Mall does
not copy ABI fragments, construct calldata or infer event signatures.

The frozen system contract provides only stable product facts before Core
publication: BSC chain 56, the fixed USDT/NPL addresses, exact versioned payment
legs, zero-leg omission, default MaxUint256 first approval with disclosure, and
ordered signed transaction intents.

Core must publish the coordinated ABI bundle, deployment manifest, expected
events, generated types and consumer tests. Missing or mismatched artifacts,
wrong chain, invalid addresses, expired quote/reservation, unavailable RPC,
paused capability and unknown finality all disable wallet writes.

Final success requires receipt status, expected chain/contract/event/resource,
block hash, confirmations and replacement/reorg reconciliation. TxHash alone is
never business finality.
