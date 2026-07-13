# 24K Contract Freeze

Status: frozen; downstream ABI consumers will be updated in the API/indexer stages

Compiler: Solidity `0.8.26`, optimizer enabled with 200 runs, `via_ir=true`, EVM Cancun.

## Fixed Funds Policy

- BSC payment token is NPL only: `0x4e8277ab31e4956b2cd48449793a57656dfc03d2`.
- `payOrder` transfers the exact authorized NPL amount into Escrow and locks the exact BNM reward amount.
- `completeOrder` releases rewards and distributes the entire escrowed NPL amount using the order's immutable split version.
- `forceRefund` is a platform-only full refund. It returns 100% of escrowed NPL to the buyer and burns all unclaimed order rewards atomically.
- Partial NPL retention is not part of the final contract. Merchant penalties are separate ledger/margin operations and cannot reduce the buyer's refund.
- `emergencyRefund` remains available only while Escrow is paused and returns 100% of escrowed NPL.
- Seckill prize NPL is transferred to RewardLedger, reserved, released and claimed through pull-based Claim.

## Roles

- Escrow owner: production multisig. Controls sellers, split versions, signer, pause, full force refund and emergency refund.
- Order signer: external EOA or ERC-1271 signer service. It signs EIP-712 order authorizations; the production API holds no private key.
- RewardLedger owner: production multisig. Controls operators and pause.
- RewardLedger operators: Escrow and Seckill only.
- BNM owner: production multisig. RewardLedger is the only minter.
- Seckill owner: production multisig. Controls sessions, Gas ceiling, force-close, settle and pause.

Ownership renunciation is disabled in every administrative contract.

## State Machines

Escrow:

`None -> PaidLocked -> Completed`

`None -> PaidLocked -> Arbitration -> Completed`

`PaidLocked|Arbitration -> ForcedRefunded`

`PaidLocked|Arbitration -> EmergencyRefunded` only while paused.

`None -> Cancelled` by the owner before payment.

Reward entry:

`Locked -> Available -> Claimed`

`Locked|Available -> Burned` for refund/recovery before claim.

Seckill:

`None -> Live -> Settled`

`Live -> ForceClosed -> Settled`

## Circuit Breakers

- Escrow pause blocks new payment, ordinary completion, dispute and force refund. While paused, owner-only `emergencyRefund` remains available.
- RewardLedger pause blocks new reward locks and user claims. Existing order rewards may still be released or burned so Escrow funds are not trapped.
- A paused RewardLedger blocks every new Seckill session. It also blocks settlement when a winner's NPL prize would create a new reward entry. Existing session/prize state remains unchanged until the ledger is unpaused.
- Seckill pause blocks new sessions and purchases. Owner may force-close and settle an existing session for recovery.
- BNM pause blocks transfer, mint and burn. It therefore blocks BNM claims but does not block Escrow NPL recovery.

## Final ABI Changes In This Stage

- Escrow constructor becomes `constructor(address npl,address rewardLedger,address orderSigner,address initialOwner)`.
- `forceRefund(bytes32 orderId)` always refunds the complete NPL amount.
- `OrderForcedRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 burnedRewards)`.
- Removed `retainedNplReceiver`, its setter and its update event.
- Seckill reads `RewardLedger.paused()` and reverts with `RewardLedgerPaused` before a session start or settlement that would require a new prize entry.

## Frozen ABI Fingerprints

The full ABI hash is `keccak256(UTF8(JSON.stringify(artifact.abi)))` over the listed Solc artifact. These hashes include inherited public methods and events. The method/event lists below are the business write surface; inherited ERC20 and Ownable methods remain covered by the full hash.

| Contract | Artifact | Full ABI hash |
|---|---|---|
| `BNMToken` | `out/BNMToken.sol/BNMToken.json` | `0xe1a444f79bc6d1eb30bde895d10deeeabfbd5ef643f67ce474ff020a47bbcf12` |
| `Abu24KRewardLedger` | `out/Abu24KRewardLedger.sol/Abu24KRewardLedger.json` | `0xcc15ac5fbe44a9f889e623ba422814a92c248bf1afc021de985df32946474b63` |
| `Abu24KPaymentEscrow` | `out/Abu24KPaymentEscrow.sol/Abu24KPaymentEscrow.json` | `0x026e51a4a9a8f89e5ab6e1e041dce037281011c5f7ab646c51be7c61f64d5ea6` |
| `Abu24KSeckill` | `out/Abu24KSeckill.sol/Abu24KSeckill.json` | `0xbcdce3e119e6201890be85dbde2ec1f4976b9061caf16fe2689d024ec61c36bf` |

### Constructors And Write Methods

| Contract | Constructor | Business write methods (`selector signature`) |
|---|---|---|
| `BNMToken` | `constructor(address initialOwner)` | `0xcf456ae7 setMinter(address,bool)`; `0x40c10f19 mint(address,uint256)`; `0xc4a858f7 burnFromLedger(address,uint256)`; `0x8456cb59 pause()`; `0x3f4ba83a unpause()`; `0xf2fde38b transferOwnership(address)` |
| `Abu24KRewardLedger` | `constructor(address bnm,address npl,address initialOwner)` | `0x558a7297 setOperator(address,bool)`; `0x951a3318 lockReward(address,bytes32,address,uint256,uint8)`; `0x8198f961 releaseOrderRewards(bytes32)`; `0xadb65aed burnOrderRewards(bytes32)`; `0x379607f5 claim(uint256)`; `0x14acc2c5 emergencyBurnLocked(bytes32)`; `0x5a5a21f8 emergencyBurnUnclaimed(bytes32)`; `0x8456cb59 pause()`; `0x3f4ba83a unpause()`; `0xf2fde38b transferOwnership(address)` |
| `Abu24KPaymentEscrow` | `constructor(address npl,address rewardLedger,address orderSigner,address initialOwner)` | `0x854266a2 payOrder(bytes32,address,bytes32,uint256,uint256,uint64,bytes32,uint32,bytes)`; `0xddf5df45 completeOrder(bytes32)`; `0x3e4e3792 disputeOrder(bytes32)`; `0x3b6db66f forceRefund(bytes32)`; `0xd92e0af2 emergencyRefund(bytes32)`; `0xe54af4fd cancelBeforePayment(bytes32)`; `0xe29983c5 setSeller(address,bool)`; `0x62fe035f setSellers(address[],bool)`; `0xb9e5ae20 setSplitConfig((address,address,address,address,address,address,uint16,uint16,uint16,uint16,uint16,uint16,uint16))`; `0x937832f9 setOrderSigner(address)`; `0x8456cb59 pause()`; `0x3f4ba83a unpause()`; `0xf2fde38b transferOwnership(address)` |
| `Abu24KSeckill` | `constructor(address npl,address escrow,address rewardLedger,address initialOwner)` | `0x8882ec0e startSession(bytes32,uint64,uint64,uint32,uint256,uint256)`; `0x60cccd1b recordPurchase(bytes32,bytes32)`; `0x267656cc forceClose(bytes32)`; `0x987757dd settle(bytes32)`; `0x4d86fc56 setMaxGasPriceWei(uint256)`; `0x8456cb59 pause()`; `0x3f4ba83a unpause()`; `0xf2fde38b transferOwnership(address)` |

### Business Events

| Contract | Events (`topic0 signature`) |
|---|---|
| `BNMToken` | `0x583b0aa0e528532caf4b907c11d7a8158a122fe2a6fb80cd9b09776ebea8d92d MinterSet(address,bool)`; `0x0e4af30da5046c48f7194bf34dd05e7fb7112ce0cc48afeb92ddec3bdd68c0b8 BnmPaused(address)`; `0xc6e86dad5cad6c872af439e0d6516e15144e902755b154519fdba0019c5da83f BnmUnpaused(address)` |
| `Abu24KRewardLedger` | `0x6cab42dea197fef4f60db14bc2c782cc524f57479dfdf7fded021de456e20b4e RewardLocked(uint256,bytes32,address,address,uint256,uint8)`; `0x4ee8d541911c8bbb95bc869e625731708f3c74835fd0d491fdc6816096675b21 RewardReleased(uint256,bytes32)`; `0xd7566a1f449b7ee89a6af29f319e117c231ea862057eb65395ca2bf70283b1c8 RewardClaimed(uint256,address,address,uint256)`; `0x145732a2564404b1c6949dc6768e93145d4587940e647860a745ccaff790763b LockedRewardBurned(uint256,bytes32)`; `0x6ccaedb3e59c1a927dbf535917c0a73c3842df8c3749935059823eb413f3c5bc UnclaimedRewardBurned(uint256,bytes32,uint8)`; `0x966c160e1c4dbc7df8d69af4ace01e9297c3cf016397b7914971f2fbfa32672d OperatorUpdated(address,bool)`; `0xe5526d35f0db491e3e7690717b21c8148a1b5eef07240279db75404df228a593 LedgerPaused(address)`; `0x5c60c80f65b9801a26d96f798c9e64b18f337054d8d11bfd257c8d0ac0f0fc11 LedgerUnpaused(address)` |
| `Abu24KPaymentEscrow` | `0xcd8aa2b7c79b4a257820045c692fcbca0e726967f067439420eca15cf08718af OrderPaid(bytes32,address,address,bytes32,uint256,uint256,uint64,bytes32,uint32)`; `0x7c3a204b66a57c793a5cd809ac5ec057ead8b730630042b184f5098a8133ea25 OrderCompleted(bytes32,address,uint256,uint32)`; `0xdf36ebde25d680a233c15b6cc04f12b9ddc88a19264375e2ad0b3f98cbb3d33a OrderAllocation(bytes32,bytes32,address,uint256)`; `0x9edf1107bac873533366b40e9cfa2aed57afb61d525da4ff6d14cb1b39077b26 OrderArbitration(bytes32,address)`; `0x06a876ef616dd0711f3bed87b62637b6c830c63d9facbcb08dcb15c2ab14bbe6 OrderForcedRefunded(bytes32,address,uint256,uint256)`; `0x2ac29f5b5e9d4a7dfb2401ce973ac3bb2cc8904bb18958762f8169c592549ee5 OrderEmergencyRefunded(bytes32,address,uint256,uint256)`; `0xd15346b8dc54bc09692c08039e0445581c833b5907e82d5dd84e2e419e962cbc SellerApprovalUpdated(address,bool)`; `0xa521e66555bd7ea3c3e57f48fb3aab666767be4f15ebc8e2f51c92e69cc0acf4 SplitConfigUpdated(uint32,bytes32)`; `0x2f9064f0a97e9070c757bd29b5b587dcd40381490dc7f8c8fc365e066db06506 OrderSignerUpdated(address)`; `0xe09da54871a93dfd23785e1544a66bfd63e8d69684f1e1215bf64fc99914ef6f EscrowPaused(address)`; `0x42bf020f5c69b1d2c29241cf608c056a0dc48f3a92dab932af57af62d62979ae EscrowUnpaused(address)` |
| `Abu24KSeckill` | `0xd4321eb29d62302976f5addab6417b816c30843c05321cd7b920e33294082a73 SessionStarted(bytes32,bytes32,uint64,uint64,uint64,uint256,uint256)`; `0x91ec88ec159c0d7cfff6e614a6e530945d79b0f7241ffc8099285b6b4aef3c58 PurchaseRecorded(bytes32,address,bytes32,uint64,uint256)`; `0x9afee503e9f373d2edb98357aefa752799d2c846880dba1ce55435d14a09c5e8 SessionForceClosed(bytes32)`; `0xf55bfce5199819cbde0e5537a9f34a4d24b7d8dcababc159d4bd3679208c8534 SessionSettled(bytes32,address,bytes32,uint256)`; `0xc725645a7d23f13518e737a7438bb94c6496cd0e116991b4968fe42f136657a6 SeckillPrizeReleased(bytes32,bytes32,address,uint256)`; `0xb1daf6a9ad2299bf65e68bf739b901d006349eb874677e4b9ce28e208bd41c27 MaxGasPriceUpdated(uint256,uint256)`; `0x6c16806ef2715764e9b524d0397cbe26af44df88e91ed69cc72fc2e044400123 SeckillPaused(address)`; `0x5b8a9222c76933c1319d051f51f2abff28e3236387b7e46dbb3f2864a0d4291e SeckillUnpaused(address)` |

## Frozen Deployment Order

1. Verify BSC chain `56`, fixed NPL code/address, all three deployed multisigs, split receivers, approved seller, order signer and the bounded Gas budget.
2. Deploy `BNMToken` and `Abu24KRewardLedger` with the deployer as temporary setup owner. Authorize RewardLedger as the only BNM minter, transfer BNM ownership to the rewards multisig, and leave RewardLedger ownership temporarily with the deployer.
3. Deploy Escrow paused. Configure split version 1 and the initial seller, authorize Escrow as a RewardLedger operator, unpause Escrow, then transfer Escrow ownership to its multisig.
4. Deploy Seckill, authorize it as the second RewardLedger operator, set a reviewed nonzero Gas ceiling, transfer Seckill ownership to its multisig, then transfer RewardLedger ownership last to the rewards multisig.
5. Run all three read-only deployment checks. Final checks require every owner to be the configured deployed multisig, BNM/RewardLedger/Escrow/Seckill to be unpaused, exact NPL bindings, configured Escrow/Seckill operators, seller/split configuration and the Gas ceiling.

`deploy:check-rewards` may report an explicit pre-Seckill PASS only when its local deployment manifest proves that the current temporary RewardLedger owner is the original deployer and no Seckill address is configured. This is not a launch PASS. Once Seckill is configured, the same check requires final multisig ownership.

If any transaction or assertion fails, stop. Do not blindly rerun a deployment script: inspect recorded receipts and continue only the missing ownership/configuration transaction or deploy a reviewed replacement set. Orphan addresses must never be exported as production configuration.

## Stage Verification

- Foundry: 19/19 tests pass, including NPL payment/distribution, full force refund, emergency refund, pause/recovery, permissions, BNM/RewardLedger Claim and Seckill settlement.
- ABI freeze gate: four full ABI hashes, exact `forceRefund(bytes32)` selector and exact `OrderForcedRefunded` types/indexed layout pass.
- Deployment scripts: Node syntax checks pass and no removed retained-NPL constructor/configuration remains.
- Local chain-id 56 rehearsal: Rewards -> deferred owner check -> Escrow -> Seckill -> final owner checks passes. The rehearsal uses dummy local contracts and sends no BSC transaction.
- Independent targeted review: no blocking funds, state-machine, permission or deployment-order finding; its ABI-signature hardening recommendation is incorporated into the freeze gate.

## Downstream Impact List

The ABI change must be synchronized exactly once after contract tests pass:

- `test/Abu24KSystem.t.sol`
- `scripts/deploy/escrow.mjs`
- `scripts/deploy/check-escrow.mjs`
- `scripts/microtest/escrow-smoke.mjs`
- `scripts/microtest/fund-tx-e2e.mjs`
- `scripts/indexer/sync-events.mjs`
- `scripts/export-dapp-contracts.mjs`
- `scripts/audit-mvp.mjs`
- `server/index.mjs` event interfaces, calldata, validation, OpenAPI, SDK and generated handoff
- backend E2E event fixtures and admin refund payloads
- production env templates and readiness checks that still mention retained NPL

No frontend or API may keep the removed partial-refund parameter after the ABI freeze commit.
