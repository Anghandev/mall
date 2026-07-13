// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAbu24KEscrowOrders {
    function isPaidOrder(bytes32 orderId, address buyer, bytes32 productId, uint256 minimumNplAmount) external view returns (bool);
}

interface IAbu24KPrizeLedger {
    function lockReward(address user, bytes32 orderId, address asset, uint256 amount, uint8 bucket) external returns (uint256);
    function releaseOrderRewards(bytes32 orderId) external;
}

/// @title Abu24KSeckill
/// @notice Relay-timer seckill that only records unique, paid Escrow orders.
contract Abu24KSeckill is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BSC_NPL = 0x4E8277AB31e4956b2CD48449793a57656DfC03D2;
    uint8 public constant SECKILL_PRIZE_BUCKET = 5;

    enum Status {
        None,
        Upcoming,
        Live,
        Settling,
        Settled,
        ForceClosed
    }

    struct Session {
        bytes32 productId;
        uint64 startsAt;
        uint64 mainEndsAt;
        uint64 relayEndsAt;
        uint32 relayExtendSeconds;
        uint64 maxRelaySeconds;
        uint256 minimumNplAmount;
        uint256 prizePoolNpl;
        uint256 totalBuys;
        address lastBuyer;
        bytes32 winningOrderId;
        Status status;
    }

    IERC20 public immutable npl;
    IAbu24KEscrowOrders public immutable escrow;
    IAbu24KPrizeLedger public immutable rewardLedger;
    uint256 public nonce;
    mapping(bytes32 sessionId => Session session) public sessions;
    mapping(bytes32 orderId => bytes32 sessionId) public orderSession;
    uint256 public maxGasPriceWei;

    event SessionStarted(bytes32 indexed sessionId, bytes32 indexed productId, uint64 startsAt, uint64 mainEndsAt, uint64 relayEndsAt, uint256 minimumNplAmount, uint256 prizePoolNpl);
    event PurchaseRecorded(bytes32 indexed sessionId, address indexed buyer, bytes32 indexed orderId, uint64 relayEndsAt, uint256 totalBuys);
    event SessionForceClosed(bytes32 indexed sessionId);
    event SessionSettled(bytes32 indexed sessionId, address indexed winner, bytes32 indexed orderId, uint256 prizePoolNpl);
    event SeckillPrizeReleased(bytes32 indexed sessionId, bytes32 indexed rewardOrderId, address indexed winner, uint256 prizePoolNpl);
    event MaxGasPriceUpdated(uint256 previousMaxGasPriceWei, uint256 newMaxGasPriceWei);
    event SeckillPaused(address indexed account);
    event SeckillUnpaused(address indexed account);

    error InvalidAddress();
    error InvalidNplAddress(address token);
    error InvalidTime();
    error InvalidSession();
    error InvalidStatus(Status current);
    error InvalidPaidOrder();
    error OrderAlreadyRecorded(bytes32 orderId, bytes32 sessionId);
    error ContractCallerBlocked();
    error GasPriceTooHigh(uint256 gasPriceWei, uint256 maxGasPriceWei);
    error OwnershipRenounceDisabled();

    constructor(address npl_, address escrow_, address rewardLedger_, address initialOwner) Ownable(initialOwner) {
        if (npl_ == address(0) || escrow_ == address(0) || rewardLedger_ == address(0) || initialOwner == address(0)) revert InvalidAddress();
        if (block.chainid == 56 && npl_ != BSC_NPL) revert InvalidNplAddress(npl_);
        npl = IERC20(npl_);
        escrow = IAbu24KEscrowOrders(escrow_);
        rewardLedger = IAbu24KPrizeLedger(rewardLedger_);
    }

    function startSession(
        bytes32 productId,
        uint64 durationSeconds,
        uint64 relayInitialSeconds,
        uint32 relayExtendSeconds,
        uint256 minimumNplAmount,
        uint256 prizePoolNpl
    ) external onlyOwner nonReentrant whenNotPaused returns (bytes32 sessionId) {
        if (productId == bytes32(0) || durationSeconds == 0 || relayInitialSeconds == 0 || relayExtendSeconds == 0 || minimumNplAmount == 0) revert InvalidTime();
        uint64 start = uint64(block.timestamp);
        uint64 mainEnd = start + durationSeconds;
        uint64 relayEnd = start + relayInitialSeconds;
        if (relayEnd > mainEnd) relayEnd = mainEnd;
        sessionId = keccak256(abi.encode(productId, block.timestamp, nonce++));
        sessions[sessionId] = Session({
            productId: productId,
            startsAt: start,
            mainEndsAt: mainEnd,
            relayEndsAt: relayEnd,
            relayExtendSeconds: relayExtendSeconds,
            maxRelaySeconds: relayInitialSeconds,
            minimumNplAmount: minimumNplAmount,
            prizePoolNpl: prizePoolNpl,
            totalBuys: 0,
            lastBuyer: address(0),
            winningOrderId: bytes32(0),
            status: Status.Live
        });
        if (prizePoolNpl > 0) npl.safeTransferFrom(msg.sender, address(this), prizePoolNpl);
        emit SessionStarted(sessionId, productId, start, mainEnd, relayEnd, minimumNplAmount, prizePoolNpl);
    }

    function recordPurchase(bytes32 sessionId, bytes32 orderId) external nonReentrant whenNotPaused {
        uint256 gasPriceLimit = maxGasPriceWei;
        if (gasPriceLimit != 0 && tx.gasprice > gasPriceLimit) revert GasPriceTooHigh(tx.gasprice, gasPriceLimit);
        if (tx.origin != msg.sender) revert ContractCallerBlocked();
        Session storage session = sessions[sessionId];
        if (session.status == Status.None) revert InvalidSession();
        if (session.status != Status.Live) revert InvalidStatus(session.status);
        if (block.timestamp > session.mainEndsAt || block.timestamp > session.relayEndsAt) revert InvalidStatus(Status.Settling);
        bytes32 recordedSession = orderSession[orderId];
        if (recordedSession != bytes32(0)) revert OrderAlreadyRecorded(orderId, recordedSession);
        if (!escrow.isPaidOrder(orderId, msg.sender, session.productId, session.minimumNplAmount)) revert InvalidPaidOrder();

        uint64 base = uint64(block.timestamp) > session.relayEndsAt ? uint64(block.timestamp) : session.relayEndsAt;
        uint64 nextRelay = base + session.relayExtendSeconds;
        uint64 maxRelay = uint64(block.timestamp) + session.maxRelaySeconds;
        if (nextRelay > maxRelay) nextRelay = maxRelay;
        if (nextRelay > session.mainEndsAt) nextRelay = session.mainEndsAt;
        session.relayEndsAt = nextRelay;
        session.totalBuys += 1;
        session.lastBuyer = msg.sender;
        session.winningOrderId = orderId;
        orderSession[orderId] = sessionId;
        emit PurchaseRecorded(sessionId, msg.sender, orderId, nextRelay, session.totalBuys);
    }

    function setMaxGasPriceWei(uint256 newMaxGasPriceWei) external onlyOwner {
        uint256 previousMaxGasPriceWei = maxGasPriceWei;
        maxGasPriceWei = newMaxGasPriceWei;
        emit MaxGasPriceUpdated(previousMaxGasPriceWei, newMaxGasPriceWei);
    }

    function forceClose(bytes32 sessionId) external onlyOwner {
        Session storage session = sessions[sessionId];
        if (session.status != Status.Live) revert InvalidStatus(session.status);
        session.status = Status.ForceClosed;
        emit SessionForceClosed(sessionId);
    }

    function settle(bytes32 sessionId) external onlyOwner nonReentrant {
        Session storage session = sessions[sessionId];
        if (session.status != Status.Live && session.status != Status.ForceClosed) revert InvalidStatus(session.status);
        if (session.status == Status.Live && block.timestamp <= session.mainEndsAt && block.timestamp <= session.relayEndsAt) revert InvalidTime();
        session.status = Status.Settled;
        if (session.prizePoolNpl > 0) {
            if (session.lastBuyer == address(0)) {
                npl.safeTransfer(owner(), session.prizePoolNpl);
            } else {
                npl.safeTransfer(address(rewardLedger), session.prizePoolNpl);
                bytes32 rewardOrderId = keccak256(abi.encodePacked("24K_SECKILL_PRIZE", sessionId));
                emit SeckillPrizeReleased(sessionId, rewardOrderId, session.lastBuyer, session.prizePoolNpl);
                rewardLedger.lockReward(session.lastBuyer, rewardOrderId, address(npl), session.prizePoolNpl, SECKILL_PRIZE_BUCKET);
                rewardLedger.releaseOrderRewards(rewardOrderId);
            }
        }
        emit SessionSettled(sessionId, session.lastBuyer, session.winningOrderId, session.prizePoolNpl);
    }

    function pause() external onlyOwner {
        _pause();
        emit SeckillPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit SeckillUnpaused(msg.sender);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }
}
