// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IRewardLedgerV2} from "./interfaces/IRewardLedgerV2.sol";

interface IPaymentEscrowV2Orders {
    function isPaidOrder(bytes32 orderId, address buyer, bytes32 skuId) external view returns (bool);
}

/// @notice EOA-only relay seckill backed by paid V2 escrow orders and a USDT prize pool.
contract SeckillV2 is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant PURCHASE_AUTHORIZATION_TYPEHASH = keccak256(
        "PurchaseAuthorization(bytes32 sessionId,bytes32 orderId,address buyer,uint256 nonce,uint64 deadline)"
    );
    uint8 public constant PRIZE_ROLE = 5;

    enum Status {
        None,
        Live,
        ForceClosed,
        Settled
    }

    struct Session {
        bytes32 skuId;
        uint64 startsAt;
        uint64 mainEndsAt;
        uint64 relayEndsAt;
        uint32 relayExtendSeconds;
        uint32 inventoryLimit;
        uint32 totalBuys;
        uint256 prizePoolUsdt;
        address lastBuyer;
        bytes32 winningOrderId;
        Status status;
    }

    struct PurchaseAuthorization {
        bytes32 sessionId;
        bytes32 orderId;
        address buyer;
        uint256 nonce;
        uint64 deadline;
    }

    IERC20 public immutable usdt;
    IPaymentEscrowV2Orders public immutable escrow;
    IRewardLedgerV2 public immutable rewardLedger;
    address public immutable recoveryReceiver;
    address public purchaseSigner;
    uint256 public maxGasPriceWei;
    bool public purchasesPaused = true;

    mapping(address buyer => uint256 nonce) public purchaseNonces;
    mapping(bytes32 sessionId => Session session) public sessions;
    mapping(bytes32 orderId => bytes32 sessionId) public orderSession;

    event SessionCreated(bytes32 indexed sessionId, bytes32 indexed skuId, uint64 startsAt, uint64 mainEndsAt, uint64 relayEndsAt, uint32 inventoryLimit);
    event PrizeFunded(bytes32 indexed sessionId, uint256 amount, uint256 totalPrizePoolUsdt);
    event PurchaseRecorded(bytes32 indexed sessionId, bytes32 indexed orderId, address indexed buyer, uint64 relayEndsAt, uint32 totalBuys);
    event SessionForceClosed(bytes32 indexed sessionId);
    event SessionSettled(bytes32 indexed sessionId, address indexed winner, bytes32 indexed winningOrderId, uint256 prizePoolUsdt, bool orderStillEligible);
    event PurchaseSignerUpdated(address indexed signer);
    event MaxGasPriceUpdated(uint256 previousValue, uint256 newValue);
    event PurchasesPaused(address indexed account);
    event PurchasesResumed(address indexed account);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidTime();
    error InvalidStatus(Status status);
    error InvalidAuthorization();
    error InvalidNonce(uint256 expected, uint256 supplied);
    error InvalidPaidOrder();
    error InvalidReceivedAmount(uint256 expected, uint256 received);
    error OrderAlreadyRecorded(bytes32 orderId, bytes32 sessionId);
    error ContractCallerBlocked();
    error GasPriceTooHigh(uint256 gasPriceWei, uint256 maxGasPriceWei);
    error PurchasesArePaused();
    error OwnershipRenounceDisabled();

    constructor(
        address usdt_,
        address escrow_,
        address rewardLedger_,
        address recoveryReceiver_,
        address purchaseSigner_,
        address initialOwner
    ) Ownable(initialOwner) EIP712("Abu 24K Seckill", "2") {
        if (
            usdt_ == address(0) || escrow_ == address(0) || rewardLedger_ == address(0)
                || recoveryReceiver_ == address(0) || purchaseSigner_ == address(0) || initialOwner == address(0)
        ) revert InvalidAddress();
        usdt = IERC20(usdt_);
        escrow = IPaymentEscrowV2Orders(escrow_);
        rewardLedger = IRewardLedgerV2(rewardLedger_);
        recoveryReceiver = recoveryReceiver_;
        purchaseSigner = purchaseSigner_;
    }

    function setPurchaseSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidAddress();
        purchaseSigner = signer;
        emit PurchaseSignerUpdated(signer);
    }

    function setMaxGasPriceWei(uint256 value) external onlyOwner {
        uint256 previous = maxGasPriceWei;
        maxGasPriceWei = value;
        emit MaxGasPriceUpdated(previous, value);
    }

    function setPurchasesPaused(bool paused) external onlyOwner {
        if (!paused && maxGasPriceWei == 0) revert InvalidAmount();
        if (purchasesPaused == paused) return;
        purchasesPaused = paused;
        if (paused) emit PurchasesPaused(msg.sender);
        else emit PurchasesResumed(msg.sender);
    }

    function createSession(
        bytes32 sessionId,
        bytes32 skuId,
        uint64 startsAt,
        uint64 mainDurationSeconds,
        uint64 relayInitialSeconds,
        uint32 relayExtendSeconds,
        uint32 inventoryLimit
    ) external onlyOwner {
        if (sessionId == bytes32(0) || skuId == bytes32(0)) revert InvalidAddress();
        if (
            startsAt < block.timestamp || mainDurationSeconds == 0 || relayInitialSeconds == 0 || relayExtendSeconds == 0
                || inventoryLimit == 0
        ) revert InvalidTime();
        if (sessions[sessionId].status != Status.None) revert InvalidStatus(sessions[sessionId].status);
        uint64 mainEndsAt = startsAt + mainDurationSeconds;
        uint64 relayEndsAt = startsAt + relayInitialSeconds;
        if (relayEndsAt > mainEndsAt) relayEndsAt = mainEndsAt;
        sessions[sessionId] = Session({
            skuId: skuId,
            startsAt: startsAt,
            mainEndsAt: mainEndsAt,
            relayEndsAt: relayEndsAt,
            relayExtendSeconds: relayExtendSeconds,
            inventoryLimit: inventoryLimit,
            totalBuys: 0,
            prizePoolUsdt: 0,
            lastBuyer: address(0),
            winningOrderId: bytes32(0),
            status: Status.Live
        });
        emit SessionCreated(sessionId, skuId, startsAt, mainEndsAt, relayEndsAt, inventoryLimit);
    }

    function fundPrize(bytes32 sessionId, uint256 amount) external onlyOwner nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.status != Status.Live) revert InvalidStatus(session.status);
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = usdt.balanceOf(address(this));
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdt.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InvalidReceivedAmount(amount, received);
        session.prizePoolUsdt += amount;
        emit PrizeFunded(sessionId, amount, session.prizePoolUsdt);
    }

    function purchaseAuthorizationDigest(PurchaseAuthorization calldata auth) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            PURCHASE_AUTHORIZATION_TYPEHASH,
            auth.sessionId,
            auth.orderId,
            auth.buyer,
            auth.nonce,
            auth.deadline
        )));
    }

    function recordPurchase(PurchaseAuthorization calldata auth, bytes calldata signature) external nonReentrant {
        if (purchasesPaused) revert PurchasesArePaused();
        if (tx.origin != msg.sender) revert ContractCallerBlocked();
        if (tx.gasprice > maxGasPriceWei) revert GasPriceTooHigh(tx.gasprice, maxGasPriceWei);
        if (auth.buyer != msg.sender || auth.deadline <= block.timestamp) revert InvalidAuthorization();
        uint256 expectedNonce = purchaseNonces[msg.sender];
        if (auth.nonce != expectedNonce) revert InvalidNonce(expectedNonce, auth.nonce);
        if (!SignatureChecker.isValidSignatureNow(purchaseSigner, purchaseAuthorizationDigest(auth), signature)) {
            revert InvalidAuthorization();
        }
        Session storage session = sessions[auth.sessionId];
        if (session.status != Status.Live) revert InvalidStatus(session.status);
        if (block.timestamp < session.startsAt || block.timestamp > session.mainEndsAt || block.timestamp > session.relayEndsAt) {
            revert InvalidTime();
        }
        if (session.totalBuys >= session.inventoryLimit) revert InvalidAmount();
        bytes32 recordedSession = orderSession[auth.orderId];
        if (recordedSession != bytes32(0)) revert OrderAlreadyRecorded(auth.orderId, recordedSession);
        if (!escrow.isPaidOrder(auth.orderId, msg.sender, session.skuId)) revert InvalidPaidOrder();

        purchaseNonces[msg.sender] = expectedNonce + 1;
        orderSession[auth.orderId] = auth.sessionId;
        session.totalBuys += 1;
        session.lastBuyer = msg.sender;
        session.winningOrderId = auth.orderId;
        uint64 base = session.relayEndsAt > block.timestamp ? session.relayEndsAt : uint64(block.timestamp);
        uint64 nextRelayEndsAt = base + session.relayExtendSeconds;
        if (nextRelayEndsAt > session.mainEndsAt) nextRelayEndsAt = session.mainEndsAt;
        session.relayEndsAt = nextRelayEndsAt;
        emit PurchaseRecorded(auth.sessionId, auth.orderId, msg.sender, nextRelayEndsAt, session.totalBuys);
    }

    function forceClose(bytes32 sessionId) external onlyOwner {
        Session storage session = sessions[sessionId];
        if (session.status != Status.Live) revert InvalidStatus(session.status);
        session.status = Status.ForceClosed;
        emit SessionForceClosed(sessionId);
    }

    /// @notice Settlement remains available while purchases are paused.
    function settle(bytes32 sessionId) external onlyOwner nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.status != Status.Live && session.status != Status.ForceClosed) revert InvalidStatus(session.status);
        if (
            session.status == Status.Live && block.timestamp <= session.mainEndsAt && block.timestamp <= session.relayEndsAt
        ) revert InvalidTime();
        session.status = Status.Settled;
        bool eligible = session.lastBuyer != address(0)
            && escrow.isPaidOrder(session.winningOrderId, session.lastBuyer, session.skuId);
        uint256 prize = session.prizePoolUsdt;
        if (prize > 0) {
            if (!eligible) {
                usdt.safeTransfer(recoveryReceiver, prize);
            } else {
                usdt.safeTransfer(address(rewardLedger), prize);
                IRewardLedgerV2.Credit[] memory credits = new IRewardLedgerV2.Credit[](1);
                credits[0] = IRewardLedgerV2.Credit(session.lastBuyer, address(usdt), prize, PRIZE_ROLE);
                rewardLedger.creditAvailableBatch(keccak256(abi.encode("SECKILL_PRIZE_V2", sessionId)), credits);
            }
        }
        emit SessionSettled(sessionId, eligible ? session.lastBuyer : address(0), session.winningOrderId, prize, eligible);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }
}
