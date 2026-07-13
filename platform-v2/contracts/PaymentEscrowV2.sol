// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IRewardLedgerV2} from "./interfaces/IRewardLedgerV2.sol";

/// @notice Signed mixed USDT/NPL order escrow with immutable per-order financial snapshots.
contract PaymentEscrowV2 is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_BENEFICIARIES = 16;

    bytes32 public constant ORDER_AUTHORIZATION_TYPEHASH = keccak256(
        "OrderAuthorization(bytes32 orderId,address buyer,bytes32 skuId,uint32 quantity,uint32 policyVersion,uint32 oracleVersion,uint80 oracleRoundId,uint256 oraclePriceE18,uint64 oracleUpdatedAt,uint64 deadline,uint256 nonce,bytes32 orderDigest)"
    );
    bytes32 public constant COMPLETION_AUTHORIZATION_TYPEHASH = keccak256(
        "CompletionAuthorization(bytes32 orderId,bytes32 outcomeDigest,uint64 deadline,uint256 nonce)"
    );

    enum Status {
        None,
        PaidLocked,
        Arbitration,
        Completed,
        ForcedRefunded
    }

    enum BeneficiaryRole {
        Merchant,
        Platform,
        PrizePool,
        Region,
        Referral
    }

    struct Beneficiary {
        address account;
        uint16 weightBps;
        BeneficiaryRole role;
    }

    struct ProductPolicy {
        address merchant;
        address nplBurnReceiver;
        address nplPoolReceiver;
        uint256 unitSaleValueE18;
        uint256 unitMerchantCostE18;
        uint16 usdtBps;
        uint16 nplBps;
        uint16 nplBurnBps;
        uint16 nplPoolBps;
        uint16 platformBps;
        uint16 prizePoolBps;
        uint16 regionBps;
        uint16 referralBps;
        bool enabled;
    }

    struct OracleConfig {
        address feed;
        uint32 maxAgeSeconds;
        uint16 maxDeviationBps;
        uint8 feedDecimals;
    }

    struct OrderAuthorization {
        bytes32 orderId;
        address buyer;
        bytes32 skuId;
        uint32 quantity;
        uint32 policyVersion;
        uint32 oracleVersion;
        uint80 oracleRoundId;
        uint256 oraclePriceE18;
        uint64 oracleUpdatedAt;
        uint64 deadline;
        uint256 nonce;
        bytes32 orderDigest;
    }

    struct CompletionAuthorization {
        bytes32 orderId;
        bytes32 outcomeDigest;
        uint64 deadline;
        uint256 nonce;
    }

    struct Order {
        address buyer;
        address merchant;
        bytes32 skuId;
        uint32 quantity;
        uint32 policyVersion;
        uint32 oracleVersion;
        uint80 oracleRoundId;
        uint256 oraclePriceE18;
        uint256 usdtAmount;
        uint256 nplAmount;
        uint256 bnmAmount;
        uint256 merchantCostUsdt;
        bytes32 orderDigest;
        Status status;
    }

    IERC20 public immutable usdt;
    IERC20 public immutable npl;
    IRewardLedgerV2 public immutable rewardLedger;
    uint8 public immutable usdtDecimals;
    uint8 public immutable nplDecimals;
    address public orderSigner;
    address public fulfillmentSigner;
    bool public ordersPaused = true;
    uint256 public lockedUsdt;
    uint256 public lockedNpl;
    uint32 public currentOracleVersion;

    mapping(address merchant => bool approved) public approvedMerchants;
    mapping(address buyer => uint256 nonce) public orderNonces;
    mapping(bytes32 orderId => uint256 nonce) public completionNonces;
    mapping(bytes32 orderId => Order order) public orders;
    mapping(bytes32 skuId => uint32 version) public currentPolicyVersion;
    mapping(bytes32 skuId => mapping(uint32 version => ProductPolicy policy)) public productPolicies;
    mapping(bytes32 skuId => mapping(uint32 version => Beneficiary[] beneficiaries)) private _policyBeneficiaries;
    mapping(uint32 version => OracleConfig config) public oracleConfigs;

    event MerchantApprovalUpdated(address indexed merchant, bool approved);
    event ProductPolicyPublished(bytes32 indexed skuId, uint32 indexed version, bytes32 policyHash);
    event ProductPolicyDisabled(bytes32 indexed skuId, uint32 indexed version);
    event OracleConfigPublished(uint32 indexed version, address indexed feed, uint32 maxAgeSeconds, uint16 maxDeviationBps);
    event OrderSignerUpdated(address indexed signer);
    event FulfillmentSignerUpdated(address indexed signer);
    event OrdersPaused(address indexed account);
    event OrdersResumed(address indexed account);
    event OrderPaid(bytes32 indexed orderId, address indexed buyer, address indexed merchant, bytes32 skuId, uint256 usdtAmount, uint256 nplAmount, uint256 bnmAmount, uint32 policyVersion, uint32 oracleVersion, uint80 oracleRoundId);
    event OrderDisputed(bytes32 indexed orderId, address indexed caller, bytes32 reasonHash);
    event OrderCompleted(bytes32 indexed orderId, bytes32 indexed outcomeDigest, uint256 usdtAmount, uint256 nplAmount);
    event OrderRefunded(bytes32 indexed orderId, address indexed buyer, uint256 usdtAmount, uint256 nplAmount, bytes32 reasonHash);
    event NplRouted(bytes32 indexed orderId, address indexed receiver, uint256 amount, bool burned);
    event ExcessTokenRecovered(address indexed asset, address indexed receiver, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidDecimals(uint8 decimals);
    error InvalidBps();
    error InvalidPolicy();
    error InvalidPolicyVersion(uint32 expected, uint32 supplied);
    error InvalidOracleVersion(uint32 expected, uint32 supplied);
    error InvalidStatus(Status status);
    error InvalidAuthorization();
    error InvalidDeadline();
    error InvalidNonce(uint256 expected, uint256 supplied);
    error InvalidReceivedAmount(address asset, uint256 expected, uint256 received);
    error InvalidOracleRound();
    error StaleOraclePrice(uint256 updatedAt, uint256 maxAgeSeconds);
    error OracleDeviationTooHigh(uint256 snapshotPrice, uint256 latestPrice, uint256 maxDeviationBps);
    error MerchantNotApproved(address merchant);
    error OrdersArePaused();
    error NotOrderParticipant();
    error ReservedFunds(uint256 available, uint256 requested);
    error OwnershipRenounceDisabled();

    constructor(
        address usdt_,
        address npl_,
        address rewardLedger_,
        address orderSigner_,
        address fulfillmentSigner_,
        address initialOwner
    ) Ownable(initialOwner) EIP712("Abu 24K Payment Escrow", "2") {
        if (
            usdt_ == address(0) || npl_ == address(0) || rewardLedger_ == address(0) || orderSigner_ == address(0)
                || fulfillmentSigner_ == address(0) || initialOwner == address(0)
        ) revert InvalidAddress();
        uint8 usdtDecimals_ = IERC20Metadata(usdt_).decimals();
        uint8 nplDecimals_ = IERC20Metadata(npl_).decimals();
        if (usdtDecimals_ > 18) revert InvalidDecimals(usdtDecimals_);
        if (nplDecimals_ > 18) revert InvalidDecimals(nplDecimals_);
        usdt = IERC20(usdt_);
        npl = IERC20(npl_);
        rewardLedger = IRewardLedgerV2(rewardLedger_);
        usdtDecimals = usdtDecimals_;
        nplDecimals = nplDecimals_;
        orderSigner = orderSigner_;
        fulfillmentSigner = fulfillmentSigner_;
    }

    function setMerchant(address merchant, bool approved) external onlyOwner {
        if (merchant == address(0)) revert InvalidAddress();
        approvedMerchants[merchant] = approved;
        emit MerchantApprovalUpdated(merchant, approved);
    }

    function setOrderSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidAddress();
        orderSigner = signer;
        emit OrderSignerUpdated(signer);
    }

    function setFulfillmentSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidAddress();
        fulfillmentSigner = signer;
        emit FulfillmentSignerUpdated(signer);
    }

    function setOrdersPaused(bool paused) external onlyOwner {
        if (ordersPaused == paused) return;
        ordersPaused = paused;
        if (paused) emit OrdersPaused(msg.sender);
        else emit OrdersResumed(msg.sender);
    }

    function publishOracleConfig(address feed, uint32 maxAgeSeconds, uint16 maxDeviationBps)
        external
        onlyOwner
        returns (uint32 version)
    {
        if (feed == address(0)) revert InvalidAddress();
        if (maxAgeSeconds == 0 || maxDeviationBps == 0 || maxDeviationBps > BPS) revert InvalidBps();
        uint8 feedDecimals = IAggregatorV3(feed).decimals();
        if (feedDecimals > 18) revert InvalidDecimals(feedDecimals);
        version = ++currentOracleVersion;
        oracleConfigs[version] = OracleConfig(feed, maxAgeSeconds, maxDeviationBps, feedDecimals);
        emit OracleConfigPublished(version, feed, maxAgeSeconds, maxDeviationBps);
    }

    function publishProductPolicy(bytes32 skuId, ProductPolicy calldata policy, Beneficiary[] calldata beneficiaries)
        external
        onlyOwner
        returns (uint32 version)
    {
        _validatePolicy(policy, beneficiaries);
        version = currentPolicyVersion[skuId] + 1;
        currentPolicyVersion[skuId] = version;
        productPolicies[skuId][version] = policy;
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            _policyBeneficiaries[skuId][version].push(beneficiaries[i]);
        }
        emit ProductPolicyPublished(skuId, version, keccak256(abi.encode(policy, beneficiaries)));
    }

    function disableProductPolicy(bytes32 skuId, uint32 version) external onlyOwner {
        if (version == 0 || version != currentPolicyVersion[skuId]) revert InvalidPolicyVersion(currentPolicyVersion[skuId], version);
        productPolicies[skuId][version].enabled = false;
        emit ProductPolicyDisabled(skuId, version);
    }

    function policyBeneficiaries(bytes32 skuId, uint32 version) external view returns (Beneficiary[] memory) {
        return _policyBeneficiaries[skuId][version];
    }

    function orderAuthorizationDigest(OrderAuthorization calldata auth) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            ORDER_AUTHORIZATION_TYPEHASH,
            auth.orderId,
            auth.buyer,
            auth.skuId,
            auth.quantity,
            auth.policyVersion,
            auth.oracleVersion,
            auth.oracleRoundId,
            auth.oraclePriceE18,
            auth.oracleUpdatedAt,
            auth.deadline,
            auth.nonce,
            auth.orderDigest
        )));
    }

    function completionAuthorizationDigest(CompletionAuthorization calldata auth) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            COMPLETION_AUTHORIZATION_TYPEHASH,
            auth.orderId,
            auth.outcomeDigest,
            auth.deadline,
            auth.nonce
        )));
    }

    function quote(OrderAuthorization calldata auth)
        public
        view
        returns (uint256 usdtAmount, uint256 nplAmount, uint256 bnmAmount, uint256 merchantCostUsdt)
    {
        ProductPolicy storage policy = productPolicies[auth.skuId][auth.policyVersion];
        if (!policy.enabled) revert InvalidPolicy();
        uint256 grossValueE18 = policy.unitSaleValueE18 * auth.quantity;
        uint256 usdtValueE18 = Math.mulDiv(grossValueE18, policy.usdtBps, BPS);
        uint256 nplValueE18 = grossValueE18 - usdtValueE18;
        usdtAmount = _fromE18Exact(usdtValueE18, usdtDecimals);
        merchantCostUsdt = _fromE18Exact(policy.unitMerchantCostE18 * auth.quantity, usdtDecimals);
        nplAmount = Math.mulDiv(nplValueE18, 10 ** nplDecimals, auth.oraclePriceE18, Math.Rounding.Ceil);
        bnmAmount = grossValueE18;
        if (merchantCostUsdt > usdtAmount || usdtAmount == 0 || nplAmount == 0 || bnmAmount == 0) revert InvalidPolicy();
    }

    function payOrder(OrderAuthorization calldata auth, bytes calldata signature) external nonReentrant {
        if (ordersPaused) revert OrdersArePaused();
        if (auth.orderId == bytes32(0) || auth.buyer != msg.sender || auth.quantity == 0) revert InvalidAuthorization();
        if (auth.deadline <= block.timestamp) revert InvalidDeadline();
        if (orders[auth.orderId].status != Status.None) revert InvalidStatus(orders[auth.orderId].status);
        uint256 expectedNonce = orderNonces[msg.sender];
        if (auth.nonce != expectedNonce) revert InvalidNonce(expectedNonce, auth.nonce);
        uint32 policyVersion = currentPolicyVersion[auth.skuId];
        if (auth.policyVersion != policyVersion) revert InvalidPolicyVersion(policyVersion, auth.policyVersion);
        if (auth.oracleVersion != currentOracleVersion) revert InvalidOracleVersion(currentOracleVersion, auth.oracleVersion);
        ProductPolicy storage policy = productPolicies[auth.skuId][policyVersion];
        if (!policy.enabled) revert InvalidPolicy();
        if (!approvedMerchants[policy.merchant]) revert MerchantNotApproved(policy.merchant);
        _validateOracle(auth);
        if (!SignatureChecker.isValidSignatureNow(orderSigner, orderAuthorizationDigest(auth), signature)) revert InvalidAuthorization();

        (uint256 usdtAmount, uint256 nplAmount, uint256 bnmAmount, uint256 merchantCostUsdt) = quote(auth);
        orderNonces[msg.sender] = expectedNonce + 1;
        orders[auth.orderId] = Order({
            buyer: msg.sender,
            merchant: policy.merchant,
            skuId: auth.skuId,
            quantity: auth.quantity,
            policyVersion: policyVersion,
            oracleVersion: auth.oracleVersion,
            oracleRoundId: auth.oracleRoundId,
            oraclePriceE18: auth.oraclePriceE18,
            usdtAmount: usdtAmount,
            nplAmount: nplAmount,
            bnmAmount: bnmAmount,
            merchantCostUsdt: merchantCostUsdt,
            orderDigest: auth.orderDigest,
            status: Status.PaidLocked
        });
        lockedUsdt += usdtAmount;
        lockedNpl += nplAmount;
        _pullExact(usdt, msg.sender, usdtAmount);
        _pullExact(npl, msg.sender, nplAmount);
        rewardLedger.lockBnm(auth.orderId, msg.sender, bnmAmount);
        emit OrderPaid(auth.orderId, msg.sender, policy.merchant, auth.skuId, usdtAmount, nplAmount, bnmAmount, policyVersion, auth.oracleVersion, auth.oracleRoundId);
    }

    function completeOrder(CompletionAuthorization calldata auth, bytes calldata signature) external nonReentrant {
        Order storage order = orders[auth.orderId];
        if (order.status != Status.PaidLocked && order.status != Status.Arbitration) revert InvalidStatus(order.status);
        if (auth.deadline <= block.timestamp) revert InvalidDeadline();
        uint256 expectedNonce = completionNonces[auth.orderId];
        if (auth.nonce != expectedNonce) revert InvalidNonce(expectedNonce, auth.nonce);
        if (!SignatureChecker.isValidSignatureNow(fulfillmentSigner, completionAuthorizationDigest(auth), signature)) {
            revert InvalidAuthorization();
        }
        completionNonces[auth.orderId] = expectedNonce + 1;
        order.status = Status.Completed;
        lockedUsdt -= order.usdtAmount;
        lockedNpl -= order.nplAmount;
        rewardLedger.releaseBnm(auth.orderId);
        _settleUsdt(auth.orderId, order);
        _routeNpl(auth.orderId, order);
        emit OrderCompleted(auth.orderId, auth.outcomeDigest, order.usdtAmount, order.nplAmount);
    }

    function disputeOrder(bytes32 orderId, bytes32 reasonHash) external {
        Order storage order = orders[orderId];
        if (order.status != Status.PaidLocked) revert InvalidStatus(order.status);
        if (msg.sender != order.buyer && msg.sender != order.merchant && msg.sender != owner()) revert NotOrderParticipant();
        order.status = Status.Arbitration;
        emit OrderDisputed(orderId, msg.sender, reasonHash);
    }

    /// @notice Refund remains available while new orders are paused.
    function forceRefund(bytes32 orderId, bytes32 reasonHash) external onlyOwner nonReentrant {
        Order storage order = orders[orderId];
        if (order.status != Status.PaidLocked && order.status != Status.Arbitration) revert InvalidStatus(order.status);
        order.status = Status.ForcedRefunded;
        lockedUsdt -= order.usdtAmount;
        lockedNpl -= order.nplAmount;
        rewardLedger.burnBnm(orderId);
        usdt.safeTransfer(order.buyer, order.usdtAmount);
        npl.safeTransfer(order.buyer, order.nplAmount);
        emit OrderRefunded(orderId, order.buyer, order.usdtAmount, order.nplAmount, reasonHash);
    }

    function isPaidOrder(bytes32 orderId, address buyer, bytes32 skuId) external view returns (bool) {
        Order storage order = orders[orderId];
        return order.status == Status.PaidLocked && order.buyer == buyer && order.skuId == skuId;
    }

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function recoverExcessToken(address asset, address receiver, uint256 amount) external onlyOwner nonReentrant {
        if (asset == address(0) || receiver == address(0)) revert InvalidAddress();
        uint256 reserved = asset == address(usdt) ? lockedUsdt : asset == address(npl) ? lockedNpl : 0;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 available = balance > reserved ? balance - reserved : 0;
        if (amount > available) revert ReservedFunds(available, amount);
        IERC20(asset).safeTransfer(receiver, amount);
        emit ExcessTokenRecovered(asset, receiver, amount);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }

    function _validateOracle(OrderAuthorization calldata auth) private view {
        OracleConfig storage config = oracleConfigs[auth.oracleVersion];
        if (config.feed == address(0) || auth.oraclePriceE18 == 0) revert InvalidOracleRound();
        (uint80 id, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = IAggregatorV3(config.feed).getRoundData(auth.oracleRoundId);
        if (id != auth.oracleRoundId || answer <= 0 || answeredInRound < id || updatedAt != auth.oracleUpdatedAt) revert InvalidOracleRound();
        uint256 snapshotPrice = uint256(answer) * 10 ** (18 - config.feedDecimals);
        if (snapshotPrice != auth.oraclePriceE18) revert InvalidOracleRound();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > config.maxAgeSeconds) {
            revert StaleOraclePrice(updatedAt, config.maxAgeSeconds);
        }
        (, int256 latestAnswer,, uint256 latestUpdatedAt,) = IAggregatorV3(config.feed).latestRoundData();
        if (latestAnswer <= 0 || latestUpdatedAt == 0) revert InvalidOracleRound();
        uint256 latestPrice = uint256(latestAnswer) * 10 ** (18 - config.feedDecimals);
        uint256 difference = latestPrice > snapshotPrice ? latestPrice - snapshotPrice : snapshotPrice - latestPrice;
        uint256 deviationBps = Math.mulDiv(difference, BPS, snapshotPrice);
        if (deviationBps > config.maxDeviationBps) {
            revert OracleDeviationTooHigh(snapshotPrice, latestPrice, config.maxDeviationBps);
        }
    }

    function _validatePolicy(ProductPolicy calldata policy, Beneficiary[] calldata beneficiaries) private view {
        if (
            policy.merchant == address(0) || policy.nplBurnReceiver == address(0) || policy.nplPoolReceiver == address(0)
                || policy.unitSaleValueE18 == 0 || policy.unitMerchantCostE18 == 0 || !policy.enabled
        ) revert InvalidPolicy();
        if (policy.usdtBps == 0 || policy.nplBps == 0 || uint256(policy.usdtBps) + policy.nplBps != BPS) revert InvalidBps();
        if (uint256(policy.nplBurnBps) + policy.nplPoolBps != BPS) revert InvalidBps();
        if (uint256(policy.platformBps) + policy.prizePoolBps + policy.regionBps + policy.referralBps != BPS) revert InvalidBps();
        if (beneficiaries.length == 0 || beneficiaries.length > MAX_BENEFICIARIES) revert InvalidPolicy();
        uint256[5] memory roleWeights;
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            Beneficiary calldata beneficiary = beneficiaries[i];
            uint256 role = uint256(beneficiary.role);
            if (beneficiary.account == address(0) || beneficiary.weightBps == 0 || role == 0 || role > 4) revert InvalidPolicy();
            roleWeights[role] += beneficiary.weightBps;
        }
        if (
            roleWeights[1] != policy.platformBps || roleWeights[2] != policy.prizePoolBps
                || roleWeights[3] != policy.regionBps || roleWeights[4] != policy.referralBps
        ) revert InvalidBps();
        uint256 usdtValueE18 = Math.mulDiv(policy.unitSaleValueE18, policy.usdtBps, BPS);
        if (policy.unitMerchantCostE18 > usdtValueE18) revert InvalidPolicy();
        uint256 residual = _fromE18Exact(usdtValueE18 - policy.unitMerchantCostE18, usdtDecimals);
        if (residual == 0) revert InvalidPolicy();
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            if (Math.mulDiv(residual, beneficiaries[i].weightBps, BPS) == 0) revert InvalidPolicy();
        }
        _fromE18Exact(usdtValueE18, usdtDecimals);
        _fromE18Exact(policy.unitMerchantCostE18, usdtDecimals);
    }

    function _settleUsdt(bytes32 orderId, Order storage order) private {
        Beneficiary[] storage beneficiaries = _policyBeneficiaries[order.skuId][order.policyVersion];
        uint256 residual = order.usdtAmount - order.merchantCostUsdt;
        uint256[] memory amounts = new uint256[](beneficiaries.length);
        uint256 allocated;
        uint256 platformIndex = type(uint256).max;
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            amounts[i] = Math.mulDiv(residual, beneficiaries[i].weightBps, BPS);
            allocated += amounts[i];
            if (platformIndex == type(uint256).max && beneficiaries[i].role == BeneficiaryRole.Platform) platformIndex = i;
        }
        amounts[platformIndex] += residual - allocated;
        IRewardLedgerV2.Credit[] memory credits = new IRewardLedgerV2.Credit[](beneficiaries.length + 1);
        credits[0] = IRewardLedgerV2.Credit(order.merchant, address(usdt), order.merchantCostUsdt, uint8(BeneficiaryRole.Merchant));
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            credits[i + 1] = IRewardLedgerV2.Credit(
                beneficiaries[i].account,
                address(usdt),
                amounts[i],
                uint8(beneficiaries[i].role)
            );
        }
        usdt.safeTransfer(address(rewardLedger), order.usdtAmount);
        rewardLedger.creditAvailableBatch(keccak256(abi.encode("ORDER_USDT_V2", orderId)), credits);
    }

    function _routeNpl(bytes32 orderId, Order storage order) private {
        ProductPolicy storage policy = productPolicies[order.skuId][order.policyVersion];
        uint256 burnAmount = Math.mulDiv(order.nplAmount, policy.nplBurnBps, BPS);
        uint256 poolAmount = order.nplAmount - burnAmount;
        if (burnAmount > 0) {
            npl.safeTransfer(policy.nplBurnReceiver, burnAmount);
            emit NplRouted(orderId, policy.nplBurnReceiver, burnAmount, true);
        }
        if (poolAmount > 0) {
            npl.safeTransfer(policy.nplPoolReceiver, poolAmount);
            emit NplRouted(orderId, policy.nplPoolReceiver, poolAmount, false);
        }
    }

    function _pullExact(IERC20 asset, address from, uint256 amount) private {
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        uint256 received = asset.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InvalidReceivedAmount(address(asset), amount, received);
    }

    function _fromE18Exact(uint256 valueE18, uint8 tokenDecimals) private pure returns (uint256 amount) {
        uint256 divisor = 10 ** (18 - tokenDecimals);
        if (valueE18 % divisor != 0) revert InvalidAmount();
        amount = valueE18 / divisor;
    }
}
