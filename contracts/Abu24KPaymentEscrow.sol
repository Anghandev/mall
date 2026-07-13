// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

interface IAbu24KRewardLedger {
    function bnm() external view returns (address);
    function lockReward(address user, bytes32 orderId, address asset, uint256 amount, uint8 bucket) external returns (uint256);
    function releaseOrderRewards(bytes32 orderId) external;
    function burnOrderRewards(bytes32 orderId) external returns (uint256);
}

/// @title Abu24KPaymentEscrow
/// @notice Signed, NPL-only order escrow with atomic reward and settlement transitions.
contract Abu24KPaymentEscrow is Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    address public constant BSC_NPL = 0x4E8277AB31e4956b2CD48449793a57656DfC03D2;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint8 public constant BNM_ORDER_BUCKET = 0;

    bytes32 public constant ORDER_AUTHORIZATION_TYPEHASH = keccak256(
        "OrderAuthorization(bytes32 orderId,address buyer,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion)"
    );

    enum Status {
        None,
        PaidLocked,
        Completed,
        Arbitration,
        ForcedRefunded,
        EmergencyRefunded,
        Cancelled
    }

    struct Order {
        address buyer;
        address seller;
        bytes32 productId;
        uint256 nplAmount;
        uint256 bnmLocked;
        uint64 deadline;
        bytes32 orderDigest;
        uint32 splitVersion;
        Status status;
    }

    struct SplitConfig {
        address platformReceiver;
        address regionReceiver;
        address referralReceiver;
        address prizePoolReceiver;
        address burnReceiver;
        address circulationReceiver;
        uint16 merchantBps;
        uint16 platformBps;
        uint16 regionBps;
        uint16 referralBps;
        uint16 prizePoolBps;
        uint16 burnBps;
        uint16 circulationBps;
    }

    IERC20 public immutable npl;
    IAbu24KRewardLedger public immutable rewardLedger;
    address public orderSigner;
    uint32 public currentSplitVersion;
    mapping(bytes32 orderId => Order order) public orders;
    mapping(address seller => bool approved) public approvedSellers;
    mapping(uint32 version => SplitConfig config) public splitConfigs;

    event OrderPaid(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed seller,
        bytes32 productId,
        uint256 nplAmount,
        uint256 bnmLocked,
        uint64 deadline,
        bytes32 orderDigest,
        uint32 splitVersion
    );
    event OrderCompleted(bytes32 indexed orderId, address indexed seller, uint256 nplAmount, uint32 splitVersion);
    event OrderAllocation(bytes32 indexed orderId, bytes32 indexed role, address indexed receiver, uint256 amount);
    event OrderArbitration(bytes32 indexed orderId, address indexed caller);
    event OrderForcedRefunded(bytes32 indexed orderId, address indexed buyer, uint256 refundedNpl, uint256 burnedRewards);
    event OrderEmergencyRefunded(bytes32 indexed orderId, address indexed buyer, uint256 refundedNpl, uint256 burnedRewards);
    event SellerApprovalUpdated(address indexed seller, bool approved);
    event SplitConfigUpdated(uint32 indexed version, bytes32 indexed configHash);
    event OrderSignerUpdated(address indexed signer);
    event EscrowPaused(address indexed account);
    event EscrowUnpaused(address indexed account);

    error InvalidAddress();
    error InvalidNplAddress(address token);
    error InvalidAmount();
    error InvalidOrderId();
    error InvalidDeadline();
    error InvalidStatus(Status current);
    error InvalidReceivedAmount(uint256 expected, uint256 received);
    error InvalidSplitConfig();
    error InvalidSplitVersion(uint32 expected, uint32 supplied);
    error InvalidOrderAuthorization();
    error SellerNotApproved(address seller);
    error NotParticipantOrOwner();
    error OwnershipRenounceDisabled();

    constructor(
        address npl_,
        address rewardLedger_,
        address orderSigner_,
        address initialOwner
    ) Ownable(initialOwner) EIP712("24K Mall Escrow", "1") {
        if (npl_ == address(0) || rewardLedger_ == address(0) || orderSigner_ == address(0) || initialOwner == address(0)) {
            revert InvalidAddress();
        }
        if (block.chainid == 56 && npl_ != BSC_NPL) revert InvalidNplAddress(npl_);
        npl = IERC20(npl_);
        rewardLedger = IAbu24KRewardLedger(rewardLedger_);
        orderSigner = orderSigner_;
        _pause();
    }

    function setSeller(address seller, bool approved) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        approvedSellers[seller] = approved;
        emit SellerApprovalUpdated(seller, approved);
    }

    function setSellers(address[] calldata sellers, bool approved) external onlyOwner {
        for (uint256 i = 0; i < sellers.length; i++) {
            address seller = sellers[i];
            if (seller == address(0)) revert InvalidAddress();
            approvedSellers[seller] = approved;
            emit SellerApprovalUpdated(seller, approved);
        }
    }

    function setSplitConfig(SplitConfig calldata config) external onlyOwner returns (uint32 version) {
        _validateSplitConfig(config);
        version = currentSplitVersion + 1;
        currentSplitVersion = version;
        splitConfigs[version] = config;
        emit SplitConfigUpdated(version, keccak256(abi.encode(config)));
    }

    function setOrderSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidAddress();
        orderSigner = signer;
        emit OrderSignerUpdated(signer);
    }

    function orderAuthorizationDigest(
        bytes32 orderId,
        address buyer,
        address seller,
        bytes32 productId,
        uint256 nplAmount,
        uint256 bnmLocked,
        uint64 deadline,
        bytes32 orderDigest,
        uint32 splitVersion
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            ORDER_AUTHORIZATION_TYPEHASH,
            orderId,
            buyer,
            seller,
            productId,
            nplAmount,
            bnmLocked,
            deadline,
            orderDigest,
            splitVersion
        )));
    }

    function payOrder(
        bytes32 orderId,
        address seller,
        bytes32 productId,
        uint256 nplAmount,
        uint256 bnmLocked,
        uint64 deadline,
        bytes32 orderDigest,
        uint32 splitVersion,
        bytes calldata authorization
    ) external nonReentrant whenNotPaused {
        if (orderId == bytes32(0)) revert InvalidOrderId();
        if (!approvedSellers[seller]) revert SellerNotApproved(seller);
        if (nplAmount == 0 || bnmLocked == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (splitVersion == 0 || splitVersion != currentSplitVersion) revert InvalidSplitVersion(currentSplitVersion, splitVersion);
        Order storage order = orders[orderId];
        if (order.status != Status.None) revert InvalidStatus(order.status);

        bytes32 authorizationDigest = orderAuthorizationDigest(
            orderId,
            msg.sender,
            seller,
            productId,
            nplAmount,
            bnmLocked,
            deadline,
            orderDigest,
            splitVersion
        );
        if (!SignatureChecker.isValidSignatureNow(orderSigner, authorizationDigest, authorization)) {
            revert InvalidOrderAuthorization();
        }

        uint256 beforeBalance = npl.balanceOf(address(this));
        npl.safeTransferFrom(msg.sender, address(this), nplAmount);
        uint256 received = npl.balanceOf(address(this)) - beforeBalance;
        if (received != nplAmount) revert InvalidReceivedAmount(nplAmount, received);

        orders[orderId] = Order({
            buyer: msg.sender,
            seller: seller,
            productId: productId,
            nplAmount: nplAmount,
            bnmLocked: bnmLocked,
            deadline: deadline,
            orderDigest: orderDigest,
            splitVersion: splitVersion,
            status: Status.PaidLocked
        });
        rewardLedger.lockReward(msg.sender, orderId, rewardLedger.bnm(), bnmLocked, BNM_ORDER_BUCKET);
        emit OrderPaid(orderId, msg.sender, seller, productId, nplAmount, bnmLocked, deadline, orderDigest, splitVersion);
    }

    function completeOrder(bytes32 orderId) external nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        if (order.status != Status.PaidLocked && order.status != Status.Arbitration) revert InvalidStatus(order.status);
        if (order.status == Status.Arbitration) {
            if (msg.sender != owner()) revert NotParticipantOrOwner();
        } else if (msg.sender != order.buyer && msg.sender != owner()) {
            revert NotParticipantOrOwner();
        }
        order.status = Status.Completed;
        rewardLedger.releaseOrderRewards(orderId);
        _distributeOrder(orderId, order);
        emit OrderCompleted(orderId, order.seller, order.nplAmount, order.splitVersion);
    }

    function disputeOrder(bytes32 orderId) external whenNotPaused {
        Order storage order = _requireStatus(orderId, Status.PaidLocked);
        if (msg.sender != order.buyer && msg.sender != order.seller && msg.sender != owner()) revert NotParticipantOrOwner();
        order.status = Status.Arbitration;
        emit OrderArbitration(orderId, msg.sender);
    }

    /// @notice Platform refund for merchant timeout or fraud. Unclaimed order rewards are burned atomically.
    function forceRefund(bytes32 orderId) external onlyOwner nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        if (order.status != Status.PaidLocked && order.status != Status.Arbitration) revert InvalidStatus(order.status);
        order.status = Status.ForcedRefunded;
        uint256 burnedRewards = rewardLedger.burnOrderRewards(orderId);
        npl.safeTransfer(order.buyer, order.nplAmount);
        emit OrderForcedRefunded(orderId, order.buyer, order.nplAmount, burnedRewards);
    }

    function cancelBeforePayment(bytes32 orderId) external onlyOwner whenNotPaused {
        if (orderId == bytes32(0)) revert InvalidOrderId();
        Order storage order = orders[orderId];
        if (order.status != Status.None) revert InvalidStatus(order.status);
        order.status = Status.Cancelled;
    }

    function pause() external onlyOwner {
        _pause();
        emit EscrowPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (currentSplitVersion == 0) revert InvalidSplitConfig();
        _unpause();
        emit EscrowUnpaused(msg.sender);
    }

    function emergencyRefund(bytes32 orderId) external onlyOwner nonReentrant whenPaused {
        Order storage order = orders[orderId];
        if (order.status != Status.PaidLocked && order.status != Status.Arbitration) revert InvalidStatus(order.status);
        order.status = Status.EmergencyRefunded;
        uint256 burnedRewards = rewardLedger.burnOrderRewards(orderId);
        npl.safeTransfer(order.buyer, order.nplAmount);
        emit OrderEmergencyRefunded(orderId, order.buyer, order.nplAmount, burnedRewards);
    }

    function isPaidOrder(bytes32 orderId, address buyer, bytes32 productId, uint256 minimumNplAmount) external view returns (bool) {
        Order storage order = orders[orderId];
        return order.status == Status.PaidLocked && order.buyer == buyer && order.productId == productId && order.nplAmount >= minimumNplAmount;
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }

    function _distributeOrder(bytes32 orderId, Order storage order) private {
        SplitConfig storage config = splitConfigs[order.splitVersion];
        uint256 amount = order.nplAmount;
        uint256 platformAmount = amount * config.platformBps / BPS_DENOMINATOR;
        uint256 regionAmount = amount * config.regionBps / BPS_DENOMINATOR;
        uint256 referralAmount = amount * config.referralBps / BPS_DENOMINATOR;
        uint256 prizePoolAmount = amount * config.prizePoolBps / BPS_DENOMINATOR;
        uint256 burnAmount = amount * config.burnBps / BPS_DENOMINATOR;
        uint256 circulationAmount = amount * config.circulationBps / BPS_DENOMINATOR;
        uint256 sellerAmount = amount - platformAmount - regionAmount - referralAmount - prizePoolAmount - burnAmount - circulationAmount;

        _transferAllocation(orderId, keccak256("merchant"), order.seller, sellerAmount);
        _transferAllocation(orderId, keccak256("platform"), config.platformReceiver, platformAmount);
        _transferAllocation(orderId, keccak256("region"), config.regionReceiver, regionAmount);
        _transferAllocation(orderId, keccak256("referral"), config.referralReceiver, referralAmount);
        _transferAllocation(orderId, keccak256("prize-pool"), config.prizePoolReceiver, prizePoolAmount);
        _transferAllocation(orderId, keccak256("burn"), config.burnReceiver, burnAmount);
        _transferAllocation(orderId, keccak256("circulation"), config.circulationReceiver, circulationAmount);
    }

    function _transferAllocation(bytes32 orderId, bytes32 role, address receiver, uint256 amount) private {
        if (amount == 0) return;
        npl.safeTransfer(receiver, amount);
        emit OrderAllocation(orderId, role, receiver, amount);
    }

    function _validateSplitConfig(SplitConfig calldata config) private pure {
        uint256 total = uint256(config.merchantBps) + config.platformBps + config.regionBps + config.referralBps
            + config.prizePoolBps + config.burnBps + config.circulationBps;
        if (total != BPS_DENOMINATOR || config.merchantBps == 0) revert InvalidSplitConfig();
        if (
            (config.platformBps > 0 && config.platformReceiver == address(0))
                || (config.regionBps > 0 && config.regionReceiver == address(0))
                || (config.referralBps > 0 && config.referralReceiver == address(0))
                || (config.prizePoolBps > 0 && config.prizePoolReceiver == address(0))
                || (config.burnBps > 0 && config.burnReceiver == address(0))
                || (config.circulationBps > 0 && config.circulationReceiver == address(0))
        ) revert InvalidSplitConfig();
    }

    function _requireStatus(bytes32 orderId, Status expected) private view returns (Order storage order) {
        order = orders[orderId];
        if (order.status != expected) revert InvalidStatus(order.status);
    }

}
