// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

interface IAbu24KRewardLedger {
    function bnm() external view returns (address);
    function lockReward(address user, bytes32 orderId, address asset, uint256 amount, uint8 bucket)
        external
        returns (uint256);
    function releaseOrderRewards(bytes32 orderId) external;
    function burnOrderRewards(bytes32 orderId) external returns (uint256);
}

/// @notice USDT order escrow. NPL and BNM are never accepted as payment assets.
contract Abu24KPaymentEscrow is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    address public constant BSC_USDT = 0x55d398326f99059fF775485246999027B3197955;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint8 public constant BNM_ORDER_BUCKET = 0;

    bytes32 public constant ORDER_AUTHORIZATION_TYPEHASH = keccak256(
        "OrderAuthorization(bytes32 orderId,address buyer,address seller,bytes32 productId,uint256 paymentAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion)"
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
        uint256 paymentAmount;
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
        uint16 merchantBps;
        uint16 platformBps;
        uint16 regionBps;
        uint16 referralBps;
        uint16 prizePoolBps;
    }

    IERC20 public immutable usdt;
    IAbu24KRewardLedger public immutable rewardLedger;
    address public orderSigner;
    uint32 public currentSplitVersion;
    bool public ordersPaused = true;
    bool public merchantClaimsPaused = true;
    uint256 public totalProceedsAccrued;
    uint256 public totalProceedsClaimed;
    uint256 public totalOutstandingProceeds;

    mapping(bytes32 orderId => Order order) public orders;
    mapping(address seller => bool approved) public approvedSellers;
    mapping(address operator => bool enabled) public settlementOperators;
    mapping(address seller => uint256 amount) public claimableProceeds;
    mapping(uint32 version => SplitConfig config) public splitConfigs;

    event OrderPaid(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed seller,
        bytes32 productId,
        uint256 paymentAmount,
        uint256 bnmLocked,
        uint64 deadline,
        bytes32 orderDigest,
        uint32 splitVersion
    );
    event OrderCompleted(bytes32 indexed orderId, address indexed seller, uint256 paymentAmount, uint32 splitVersion);
    event OrderAllocation(bytes32 indexed orderId, bytes32 indexed role, address indexed receiver, uint256 amount);
    event MerchantProceedsAccrued(bytes32 indexed orderId, address indexed merchant, uint256 amount);
    event MerchantProceedsClaimed(address indexed merchant, uint256 amount);
    event OrderArbitration(bytes32 indexed orderId, address indexed caller);
    event OrderForcedRefunded(bytes32 indexed orderId, address indexed buyer, uint256 refundedPayment, uint256 burnedRewards);
    event OrderEmergencyRefunded(bytes32 indexed orderId, address indexed buyer, uint256 refundedPayment, uint256 burnedRewards);
    event SellerApprovalUpdated(address indexed seller, bool approved);
    event SettlementOperatorUpdated(address indexed operator, bool enabled);
    event SplitConfigUpdated(uint32 indexed version, bytes32 indexed configHash);
    event OrderSignerUpdated(address indexed signer);
    event OrdersPauseUpdated(bool paused, address indexed account);
    event MerchantClaimsPauseUpdated(bool paused, address indexed account);

    error InvalidAddress();
    error InvalidUsdtAddress(address token);
    error InvalidAmount();
    error InvalidOrderId();
    error InvalidDeadline();
    error InvalidStatus(Status current);
    error InvalidReceivedAmount(uint256 expected, uint256 received);
    error InvalidSplitConfig();
    error InvalidSplitVersion(uint32 expected, uint32 supplied);
    error InvalidOrderAuthorization();
    error SellerNotApproved(address seller);
    error NotParticipantOperatorOrOwner();
    error OrdersArePaused();
    error OrdersNotPaused();
    error MerchantClaimsArePaused();
    error NoClaimableProceeds();
    error OwnershipRenounceDisabled();

    constructor(address usdt_, address rewardLedger_, address orderSigner_, address initialOwner)
        Ownable(initialOwner)
        EIP712("24K Mall Escrow", "2")
    {
        if (usdt_ == address(0) || rewardLedger_ == address(0) || orderSigner_ == address(0) || initialOwner == address(0)) {
            revert InvalidAddress();
        }
        if (block.chainid == 56 && usdt_ != BSC_USDT) revert InvalidUsdtAddress(usdt_);
        usdt = IERC20(usdt_);
        rewardLedger = IAbu24KRewardLedger(rewardLedger_);
        orderSigner = orderSigner_;
    }

    modifier whenOrdersOpen() {
        if (ordersPaused) revert OrdersArePaused();
        _;
    }

    modifier whenMerchantClaimsOpen() {
        if (merchantClaimsPaused) revert MerchantClaimsArePaused();
        _;
    }

    function setSeller(address seller, bool approved) external onlyOwner {
        if (seller == address(0)) revert InvalidAddress();
        approvedSellers[seller] = approved;
        emit SellerApprovalUpdated(seller, approved);
    }

    function setSettlementOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert InvalidAddress();
        settlementOperators[operator] = enabled;
        emit SettlementOperatorUpdated(operator, enabled);
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

    function setOrdersPaused(bool paused) external onlyOwner {
        ordersPaused = paused;
        emit OrdersPauseUpdated(paused, msg.sender);
    }

    function setMerchantClaimsPaused(bool paused) external onlyOwner {
        merchantClaimsPaused = paused;
        emit MerchantClaimsPauseUpdated(paused, msg.sender);
    }

    function orderAuthorizationDigest(
        bytes32 orderId,
        address buyer,
        address seller,
        bytes32 productId,
        uint256 paymentAmount,
        uint256 bnmLocked,
        uint64 deadline,
        bytes32 orderDigest,
        uint32 splitVersion
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_AUTHORIZATION_TYPEHASH,
                    orderId,
                    buyer,
                    seller,
                    productId,
                    paymentAmount,
                    bnmLocked,
                    deadline,
                    orderDigest,
                    splitVersion
                )
            )
        );
    }

    function payOrder(
        bytes32 orderId,
        address seller,
        bytes32 productId,
        uint256 paymentAmount,
        uint256 bnmLocked,
        uint64 deadline,
        bytes32 orderDigest,
        uint32 splitVersion,
        bytes calldata authorization
    ) external nonReentrant whenOrdersOpen {
        if (orderId == bytes32(0)) revert InvalidOrderId();
        if (!approvedSellers[seller]) revert SellerNotApproved(seller);
        if (paymentAmount == 0 || bnmLocked == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (splitVersion == 0 || splitVersion != currentSplitVersion) {
            revert InvalidSplitVersion(currentSplitVersion, splitVersion);
        }
        Order storage order = orders[orderId];
        if (order.status != Status.None) revert InvalidStatus(order.status);

        bytes32 authorizationDigest = orderAuthorizationDigest(
            orderId,
            msg.sender,
            seller,
            productId,
            paymentAmount,
            bnmLocked,
            deadline,
            orderDigest,
            splitVersion
        );
        if (!SignatureChecker.isValidSignatureNow(orderSigner, authorizationDigest, authorization)) {
            revert InvalidOrderAuthorization();
        }

        uint256 beforeBalance = usdt.balanceOf(address(this));
        usdt.safeTransferFrom(msg.sender, address(this), paymentAmount);
        uint256 received = usdt.balanceOf(address(this)) - beforeBalance;
        if (received != paymentAmount) revert InvalidReceivedAmount(paymentAmount, received);

        orders[orderId] = Order(
            msg.sender,
            seller,
            productId,
            paymentAmount,
            bnmLocked,
            deadline,
            orderDigest,
            splitVersion,
            Status.PaidLocked
        );
        rewardLedger.lockReward(msg.sender, orderId, rewardLedger.bnm(), bnmLocked, BNM_ORDER_BUCKET);
        emit OrderPaid(orderId, msg.sender, seller, productId, paymentAmount, bnmLocked, deadline, orderDigest, splitVersion);
    }

    function completeOrder(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status != Status.PaidLocked && order.status != Status.Arbitration) revert InvalidStatus(order.status);
        if (order.status == Status.Arbitration) {
            if (msg.sender != owner()) revert NotParticipantOperatorOrOwner();
        } else if (msg.sender != order.buyer && msg.sender != owner() && !settlementOperators[msg.sender]) {
            revert NotParticipantOperatorOrOwner();
        }
        order.status = Status.Completed;
        rewardLedger.releaseOrderRewards(orderId);
        _distributeOrder(orderId, order);
        emit OrderCompleted(orderId, order.seller, order.paymentAmount, order.splitVersion);
    }

    function disputeOrder(bytes32 orderId) external {
        Order storage order = _requireStatus(orderId, Status.PaidLocked);
        if (msg.sender != order.buyer && msg.sender != order.seller && msg.sender != owner()) {
            revert NotParticipantOperatorOrOwner();
        }
        order.status = Status.Arbitration;
        emit OrderArbitration(orderId, msg.sender);
    }

    function forceRefund(bytes32 orderId) external onlyOwner nonReentrant {
        Order storage order = orders[orderId];
        if (order.status != Status.PaidLocked && order.status != Status.Arbitration) revert InvalidStatus(order.status);
        order.status = Status.ForcedRefunded;
        uint256 burnedRewards = rewardLedger.burnOrderRewards(orderId);
        usdt.safeTransfer(order.buyer, order.paymentAmount);
        emit OrderForcedRefunded(orderId, order.buyer, order.paymentAmount, burnedRewards);
    }

    function emergencyRefund(bytes32 orderId) external onlyOwner nonReentrant {
        if (!ordersPaused) revert OrdersNotPaused();
        Order storage order = orders[orderId];
        if (order.status != Status.PaidLocked && order.status != Status.Arbitration) revert InvalidStatus(order.status);
        order.status = Status.EmergencyRefunded;
        uint256 burnedRewards = rewardLedger.burnOrderRewards(orderId);
        usdt.safeTransfer(order.buyer, order.paymentAmount);
        emit OrderEmergencyRefunded(orderId, order.buyer, order.paymentAmount, burnedRewards);
    }

    function cancelBeforePayment(bytes32 orderId) external onlyOwner {
        if (orderId == bytes32(0)) revert InvalidOrderId();
        Order storage order = orders[orderId];
        if (order.status != Status.None) revert InvalidStatus(order.status);
        order.status = Status.Cancelled;
    }

    function claimMerchantProceeds() external nonReentrant whenMerchantClaimsOpen {
        uint256 amount = claimableProceeds[msg.sender];
        if (amount == 0) revert NoClaimableProceeds();
        claimableProceeds[msg.sender] = 0;
        totalOutstandingProceeds -= amount;
        totalProceedsClaimed += amount;
        usdt.safeTransfer(msg.sender, amount);
        emit MerchantProceedsClaimed(msg.sender, amount);
    }

    function isPaidOrder(bytes32 orderId, address buyer, bytes32 productId, uint256 minimumPaymentAmount)
        external
        view
        returns (bool)
    {
        Order storage order = orders[orderId];
        return order.status == Status.PaidLocked && order.buyer == buyer && order.productId == productId
            && order.paymentAmount >= minimumPaymentAmount;
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }

    function _distributeOrder(bytes32 orderId, Order storage order) private {
        SplitConfig storage config = splitConfigs[order.splitVersion];
        uint256 amount = order.paymentAmount;
        uint256 platformAmount = amount * config.platformBps / BPS_DENOMINATOR;
        uint256 regionAmount = amount * config.regionBps / BPS_DENOMINATOR;
        uint256 referralAmount = amount * config.referralBps / BPS_DENOMINATOR;
        uint256 prizePoolAmount = amount * config.prizePoolBps / BPS_DENOMINATOR;
        uint256 merchantAmount = amount - platformAmount - regionAmount - referralAmount - prizePoolAmount;

        claimableProceeds[order.seller] += merchantAmount;
        totalProceedsAccrued += merchantAmount;
        totalOutstandingProceeds += merchantAmount;
        emit MerchantProceedsAccrued(orderId, order.seller, merchantAmount);
        emit OrderAllocation(orderId, keccak256("merchant"), order.seller, merchantAmount);
        _transferAllocation(orderId, keccak256("platform"), config.platformReceiver, platformAmount);
        _transferAllocation(orderId, keccak256("region"), config.regionReceiver, regionAmount);
        _transferAllocation(orderId, keccak256("referral"), config.referralReceiver, referralAmount);
        _transferAllocation(orderId, keccak256("prize-pool"), config.prizePoolReceiver, prizePoolAmount);
    }

    function _transferAllocation(bytes32 orderId, bytes32 role, address receiver, uint256 amount) private {
        if (amount == 0) return;
        usdt.safeTransfer(receiver, amount);
        emit OrderAllocation(orderId, role, receiver, amount);
    }

    function _validateSplitConfig(SplitConfig calldata config) private pure {
        uint256 total = uint256(config.merchantBps) + config.platformBps + config.regionBps + config.referralBps
            + config.prizePoolBps;
        if (total != BPS_DENOMINATOR || config.merchantBps == 0) revert InvalidSplitConfig();
        if (
            (config.platformBps > 0 && config.platformReceiver == address(0))
                || (config.regionBps > 0 && config.regionReceiver == address(0))
                || (config.referralBps > 0 && config.referralReceiver == address(0))
                || (config.prizePoolBps > 0 && config.prizePoolReceiver == address(0))
        ) revert InvalidSplitConfig();
    }

    function _requireStatus(bytes32 orderId, Status expected) private view returns (Order storage order) {
        order = orders[orderId];
        if (order.status != expected) revert InvalidStatus(order.status);
    }
}
