// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    IBeneficiaryRegistryV2,
    IClaimVaultV2,
    IMerchantGuaranteeVaultV2,
    IPolicyRegistryV2,
    IRewardLedgerV2,
    ITwapOracleV2
} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract PaymentEscrowV2 is AccessControl, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BSC_CHAIN_ID = 56;
    uint256 public constant TAKEOVER_DELAY = 7 days;
    address public constant NPL_BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    bytes32 public constant SECKILL_ROLE = keccak256("SECKILL_ROLE");
    bytes32 public constant FULFILLMENT_OPERATOR_ROLE = keccak256("FULFILLMENT_OPERATOR_ROLE");
    bytes32 public constant FORCED_RECEIPT_REVIEWER_ROLE = keccak256("FORCED_RECEIPT_REVIEWER_ROLE");
    bytes32 public constant ARBITRATOR_ROLE = keccak256("ARBITRATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");

    bytes32 public constant ORDER_TYPEHASH = keccak256("OrderAuthorization(bytes32 orderHash)");
    bytes32 public constant FINALITY_TYPEHASH = keccak256("FulfillmentFinality(bytes32 finalityHash)");
    bytes32 public constant FULFILLMENT_REQUEST_EVENT_SIGNATURE =
        keccak256("FulfillmentRequested(bytes32,uint8,bytes32)");

    struct Order {
        uint64 policyVersion;
        uint64 paidAt;
        uint64 shippedAt;
        uint64 deliveredAt;
        address buyer;
        address merchant;
        V2Types.FulfillmentMode fulfillmentMode;
        V2Types.FulfillmentMethod pendingMethod;
        V2Types.OrderState state;
        uint256 usdtLocked;
        uint256 merchantUsdtAmount;
        uint256 platformUsdtAmount;
        uint256 usdtRemainderAmount;
        uint256 bnmAmount;
        bool takeoverOpened;
        bytes32 snapshotHash;
        bytes32 shipmentEvidenceHash;
        bytes32 deliveryEvidenceHash;
        bytes32 fulfillmentRequestHash;
        bytes32 finalityEvidenceHash;
    }

    IERC20 public immutable usdt;
    IERC20 public immutable npl;
    IPolicyRegistryV2 public immutable policyRegistry;
    IBeneficiaryRegistryV2 public immutable beneficiaryRegistry;
    ITwapOracleV2 public immutable oracle;
    IRewardLedgerV2 public immutable rewardLedger;
    IClaimVaultV2 public immutable claimVault;
    IMerchantGuaranteeVaultV2 public immutable guaranteeVault;
    address public immutable quoteSigner;
    address public immutable finalitySigner;
    uint32 public immutable requiredConfirmations;

    mapping(bytes32 orderId => Order order) private _orders;
    mapping(address buyer => mapping(uint256 nonce => bool used)) public usedOrderNonce;
    mapping(bytes32 reservationId => bool used) public usedReservation;
    mapping(uint256 nonce => bool used) public usedFinalityNonce;
    mapping(address merchant => uint256 count) public activeTakeoverCases;
    uint256 public totalLockedUsdt;
    bool public newOrdersPaused;

    error InvalidAddress();
    error InvalidIntent();
    error InvalidAmounts();
    error InvalidSignature();
    error InvalidFinality();
    error IntentExpired();
    error ReservationExpired();
    error Replay();
    error OrderExists();
    error UnknownOrder();
    error InvalidOrderState();
    error InexactTransfer();
    error NewOrdersPaused();
    error MerchantUnavailable();
    error TakeoverNotReady();
    error PickupTakeoverDecisionBlocked();
    error ShipmentAlreadyRecorded();
    error ForcedReceiptNotReady();
    error UnauthorizedBuyerOrMerchant();
    error InvalidEvidence();
    error InsufficientSurplus();

    event OrderPaid(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed merchant,
        uint64 policyVersion,
        uint256 usdtAmount,
        uint256 nplAmount,
        uint256 burnedNpl,
        uint256 routedNpl,
        uint256 bnmLocked,
        bool seckill,
        bytes32 sessionId,
        bytes32 snapshotHash
    );
    event NewOrdersPauseChanged(bool paused, bytes32 indexed evidenceHash);
    event ShipmentEvidenceRecorded(bytes32 indexed orderId, bytes32 indexed evidenceHash);
    event DeliveryEvidenceRecorded(bytes32 indexed orderId, bytes32 indexed evidenceHash);
    event ForcedReceiptRequested(bytes32 indexed orderId, address indexed merchant, bytes32 indexed evidenceHash);
    event FulfillmentRequested(
        bytes32 indexed orderId, V2Types.FulfillmentMethod indexed method, bytes32 indexed evidenceHash
    );
    event ArbitrationOpened(bytes32 indexed orderId, bytes32 indexed evidenceHash);
    event TakeoverOpened(
        bytes32 indexed orderId,
        address indexed merchant,
        uint256 guaranteeUsed,
        uint256 merchantAvailableUsed,
        uint256 reserveUsed,
        bytes32 evidenceHash
    );
    event MerchantFreezeResolved(address indexed merchant, uint64 indexed policyVersion, bytes32 indexed evidenceHash);
    event OrderFulfilled(
        bytes32 indexed orderId, V2Types.FulfillmentMethod indexed method, bytes32 indexed finalityEvidenceHash
    );
    event ReconciliationEvidence(bytes32 indexed orderId, bytes32 indexed evidenceHash, address indexed recorder);
    event SurplusRecovered(
        address indexed token, address indexed recipient, uint256 amount, bytes32 indexed incidentHash
    );

    constructor(
        address safe,
        IERC20 usdt_,
        IERC20 npl_,
        IPolicyRegistryV2 policyRegistry_,
        IBeneficiaryRegistryV2 beneficiaryRegistry_,
        ITwapOracleV2 oracle_,
        IRewardLedgerV2 rewardLedger_,
        IClaimVaultV2 claimVault_,
        IMerchantGuaranteeVaultV2 guaranteeVault_,
        address quoteSigner_,
        address finalitySigner_,
        uint32 requiredConfirmations_
    ) EIP712("Abu24KPaymentEscrow", "2") {
        if (
            safe == address(0) || address(usdt_) == address(0) || address(npl_) == address(0)
                || address(policyRegistry_) == address(0) || address(beneficiaryRegistry_) == address(0)
                || address(oracle_) == address(0) || address(rewardLedger_) == address(0)
                || address(claimVault_) == address(0) || address(guaranteeVault_) == address(0)
                || quoteSigner_ == address(0) || finalitySigner_ == address(0) || requiredConfirmations_ == 0
                || block.chainid != V2Types.BSC_CHAIN_ID || address(usdt_) != V2Types.USDT
                || address(npl_) != V2Types.NPL
        ) revert InvalidAddress();
        usdt = usdt_;
        npl = npl_;
        policyRegistry = policyRegistry_;
        beneficiaryRegistry = beneficiaryRegistry_;
        oracle = oracle_;
        rewardLedger = rewardLedger_;
        claimVault = claimVault_;
        guaranteeVault = guaranteeVault_;
        quoteSigner = quoteSigner_;
        finalitySigner = finalitySigner_;
        requiredConfirmations = requiredConfirmations_;
        usdt_.forceApprove(address(claimVault_), type(uint256).max);
        npl_.forceApprove(address(rewardLedger_), type(uint256).max);

        _grantRole(DEFAULT_ADMIN_ROLE, safe);
        _grantRole(FULFILLMENT_OPERATOR_ROLE, safe);
        _grantRole(FORCED_RECEIPT_REVIEWER_ROLE, safe);
        _grantRole(ARBITRATOR_ROLE, safe);
        _grantRole(PAUSER_ROLE, safe);
        _grantRole(RECOVERY_ROLE, safe);
    }

    function payOrder(V2Types.OrderIntent calldata intent, bytes calldata quoteSignature, bytes calldata buyerSignature)
        external
        nonReentrant
    {
        bytes32 digest = hashOrder(intent);
        if (!SignatureChecker.isValidSignatureNowCalldata(quoteSigner, digest, quoteSignature)) {
            revert InvalidSignature();
        }
        if (!SignatureChecker.isValidSignatureNowCalldata(intent.buyer, digest, buyerSignature)) {
            revert InvalidSignature();
        }
        _executeOrder(intent, address(0), true);
    }

    function executeSeckillOrder(V2Types.OrderIntent calldata intent)
        external
        onlyRole(SECKILL_ROLE)
        nonReentrant
        returns (uint256 prizeContribution)
    {
        prizeContribution = intent.prizeUsdtAmount;
        _executeOrder(intent, intent.seckill ? msg.sender : address(0), false);
    }

    function hashOrder(V2Types.OrderIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, keccak256(abi.encode(intent)))));
    }

    function hashFinality(V2Types.FulfillmentAttestation calldata attestation) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(FINALITY_TYPEHASH, keccak256(abi.encode(attestation)))));
    }

    function recordShipmentEvidence(bytes32 orderId, bytes32 evidenceHash)
        external
        onlyRole(FULFILLMENT_OPERATOR_ROLE)
    {
        Order storage order = _getOrder(orderId);
        if (evidenceHash == bytes32(0) || order.fulfillmentMode != V2Types.FulfillmentMode.Delivery) {
            revert InvalidEvidence();
        }
        if (order.state == V2Types.OrderState.Paid && block.timestamp >= order.paidAt + TAKEOVER_DELAY) {
            revert TakeoverNotReady();
        }
        if (
            order.state != V2Types.OrderState.Paid
                && !(order.takeoverOpened
                    && (order.state == V2Types.OrderState.Takeover || order.state == V2Types.OrderState.Arbitration))
        ) revert InvalidOrderState();
        if (order.shipmentEvidenceHash != bytes32(0) || order.state == V2Types.OrderState.Fulfilled) {
            revert ShipmentAlreadyRecorded();
        }
        bool arbitrationOpen = order.state == V2Types.OrderState.Arbitration;
        order.shipmentEvidenceHash = evidenceHash;
        order.shippedAt = uint64(block.timestamp);
        if (!arbitrationOpen) order.state = V2Types.OrderState.Shipped;
        emit ShipmentEvidenceRecorded(orderId, evidenceHash);
    }

    function recordDeliveryEvidence(bytes32 orderId, bytes32 evidenceHash)
        external
        onlyRole(FULFILLMENT_OPERATOR_ROLE)
    {
        Order storage order = _getOrder(orderId);
        if (
            evidenceHash == bytes32(0) || order.shipmentEvidenceHash == bytes32(0)
                || order.fulfillmentMode != V2Types.FulfillmentMode.Delivery
        ) revert InvalidEvidence();
        if (
            (order.state != V2Types.OrderState.Shipped && order.state != V2Types.OrderState.Arbitration)
                || order.deliveryEvidenceHash != bytes32(0)
        ) {
            revert InvalidOrderState();
        }
        bool arbitrationOpen = order.state == V2Types.OrderState.Arbitration;
        order.deliveryEvidenceHash = evidenceHash;
        order.deliveredAt = uint64(block.timestamp);
        if (!arbitrationOpen) order.state = V2Types.OrderState.Delivered;
        emit DeliveryEvidenceRecorded(orderId, evidenceHash);
    }

    function requestCustomerReceipt(bytes32 orderId, bytes32 evidenceHash) external {
        Order storage order = _getOrder(orderId);
        if (msg.sender != order.buyer) revert UnauthorizedBuyerOrMerchant();
        if (
            order.state != V2Types.OrderState.Delivered || evidenceHash == bytes32(0)
                || order.fulfillmentMode != V2Types.FulfillmentMode.Delivery
        ) revert InvalidOrderState();
        _setFulfillmentRequest(orderId, order, V2Types.FulfillmentMethod.CustomerReceipt, evidenceHash);
    }

    function requestForcedReceipt(bytes32 orderId, bytes32 logisticsEvidenceHash) external {
        Order storage order = _getOrder(orderId);
        if (msg.sender != order.merchant) revert UnauthorizedBuyerOrMerchant();
        if (
            order.state != V2Types.OrderState.Delivered || order.deliveredAt == 0
                || block.timestamp < order.deliveredAt + TAKEOVER_DELAY
        ) revert ForcedReceiptNotReady();
        if (logisticsEvidenceHash == bytes32(0)) revert InvalidEvidence();
        order.fulfillmentRequestHash = logisticsEvidenceHash;
        emit ForcedReceiptRequested(orderId, msg.sender, logisticsEvidenceHash);
    }

    function approveForcedReceipt(bytes32 orderId, bytes32 reviewedEvidenceHash)
        external
        onlyRole(FORCED_RECEIPT_REVIEWER_ROLE)
    {
        Order storage order = _getOrder(orderId);
        if (
            order.state != V2Types.OrderState.Delivered || order.fulfillmentRequestHash == bytes32(0)
                || reviewedEvidenceHash == bytes32(0)
        ) revert ForcedReceiptNotReady();
        _setFulfillmentRequest(orderId, order, V2Types.FulfillmentMethod.ForcedReceipt, reviewedEvidenceHash);
    }

    function requestPickupVerification(bytes32 orderId, bytes32 verificationEvidenceHash)
        external
        onlyRole(FULFILLMENT_OPERATOR_ROLE)
    {
        Order storage order = _getOrder(orderId);
        if (
            order.fulfillmentMode != V2Types.FulfillmentMode.Pickup
                || (order.state != V2Types.OrderState.Paid && order.state != V2Types.OrderState.Takeover)
                || verificationEvidenceHash == bytes32(0)
        ) revert InvalidOrderState();
        _setFulfillmentRequest(orderId, order, V2Types.FulfillmentMethod.PickupVerification, verificationEvidenceHash);
    }

    function openArbitration(bytes32 orderId, bytes32 evidenceHash) external {
        Order storage order = _getOrder(orderId);
        if (msg.sender != order.buyer && !hasRole(ARBITRATOR_ROLE, msg.sender)) revert UnauthorizedBuyerOrMerchant();
        if (
            order.state == V2Types.OrderState.Paid || order.state == V2Types.OrderState.Arbitration
                || order.state == V2Types.OrderState.Fulfilled
                || (order.state == V2Types.OrderState.FulfillmentPending
                    && order.pendingMethod == V2Types.FulfillmentMethod.Arbitration)
                || (order.shipmentEvidenceHash == bytes32(0) && !order.takeoverOpened) || evidenceHash == bytes32(0)
        ) revert InvalidOrderState();
        order.state = V2Types.OrderState.Arbitration;
        order.fulfillmentRequestHash = bytes32(0);
        emit ArbitrationOpened(orderId, evidenceHash);
    }

    function approveArbitrationFulfillment(bytes32 orderId, bytes32 finalDecisionEvidenceHash)
        external
        onlyRole(ARBITRATOR_ROLE)
    {
        Order storage order = _getOrder(orderId);
        if (order.state != V2Types.OrderState.Arbitration || finalDecisionEvidenceHash == bytes32(0)) {
            revert InvalidOrderState();
        }
        _setFulfillmentRequest(orderId, order, V2Types.FulfillmentMethod.Arbitration, finalDecisionEvidenceHash);
    }

    function openTakeover(bytes32 orderId, bytes32 evidenceHash) external nonReentrant {
        Order storage order = _getOrder(orderId);
        if (order.fulfillmentMode == V2Types.FulfillmentMode.Pickup) revert PickupTakeoverDecisionBlocked();
        if (
            evidenceHash == bytes32(0) || order.shipmentEvidenceHash != bytes32(0)
                || order.state != V2Types.OrderState.Paid || block.timestamp < order.paidAt + TAKEOVER_DELAY
        ) revert TakeoverNotReady();
        (uint256 guaranteeUsed, uint256 merchantAvailableUsed, uint256 reserveUsed) =
            guaranteeVault.beginTakeover(orderId, order.merchant, order.merchantUsdtAmount);
        order.state = V2Types.OrderState.Takeover;
        order.takeoverOpened = true;
        activeTakeoverCases[order.merchant] += 1;
        claimVault.setMerchantFrozen(order.merchant, true, evidenceHash);
        emit TakeoverOpened(orderId, order.merchant, guaranteeUsed, merchantAvailableUsed, reserveUsed, evidenceHash);
    }

    function resolveMerchantFreeze(address merchant, bytes32 evidenceHash)
        external
        onlyRole(FULFILLMENT_OPERATOR_ROLE)
    {
        uint64 policyVersion = policyRegistry.latestVersion();
        if (
            merchant == address(0) || evidenceHash == bytes32(0) || activeTakeoverCases[merchant] != 0
                || guaranteeVault.merchantDebt(merchant) != 0 || !guaranteeVault.canAcceptOrder(merchant, policyVersion)
        ) revert MerchantUnavailable();
        claimVault.setMerchantFrozen(merchant, false, evidenceHash);
        emit MerchantFreezeResolved(merchant, policyVersion, evidenceHash);
    }

    function finalizeFulfillment(V2Types.FulfillmentAttestation calldata attestation, bytes calldata finalitySignature)
        external
        nonReentrant
    {
        Order storage order = _getOrder(attestation.orderId);
        _validateFinality(order, attestation, finalitySignature);
        usedFinalityNonce[attestation.nonce] = true;
        order.state = V2Types.OrderState.Fulfilled;
        order.finalityEvidenceHash = keccak256(abi.encode(attestation));
        totalLockedUsdt -= order.usdtLocked;
        if (order.takeoverOpened) {
            guaranteeVault.closeTakeover(attestation.orderId, order.finalityEvidenceHash);
            activeTakeoverCases[order.merchant] -= 1;
        } else {
            guaranteeVault.releaseOrderCoverage(attestation.orderId);
        }

        if (order.merchantUsdtAmount != 0) {
            claimVault.depositMerchant(attestation.orderId, order.merchant, order.merchantUsdtAmount);
        }
        V2Types.Policy memory policy = policyRegistry.getPolicy(order.policyVersion);
        if (order.platformUsdtAmount != 0) usdt.safeTransfer(policy.platformTreasury, order.platformUsdtAmount);
        if (order.usdtRemainderAmount != 0) {
            usdt.safeTransfer(policy.usdtRemainderAccount, order.usdtRemainderAmount);
        }
        rewardLedger.releaseOrder(attestation.orderId);
        if (order.bnmAmount != 0) claimVault.creditBnm(attestation.orderId, order.buyer, order.bnmAmount);

        emit OrderFulfilled(attestation.orderId, attestation.method, order.finalityEvidenceHash);
    }

    function setNewOrdersPause(bool paused, bytes32 evidenceHash) external onlyRole(PAUSER_ROLE) {
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        newOrdersPaused = paused;
        emit NewOrdersPauseChanged(paused, evidenceHash);
    }

    function recordReconciliationEvidence(bytes32 orderId, bytes32 evidenceHash)
        external
        onlyRole(FULFILLMENT_OPERATOR_ROLE)
    {
        _getOrder(orderId);
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        emit ReconciliationEvidence(orderId, evidenceHash, msg.sender);
    }

    function recoverSurplus(address token, address recipient, uint256 amount, bytes32 incidentHash)
        external
        onlyRole(RECOVERY_ROLE)
        nonReentrant
    {
        if (recipient == address(0) || incidentHash == bytes32(0)) revert InvalidEvidence();
        IERC20 asset = IERC20(token);
        uint256 protectedAmount = token == address(usdt) ? totalLockedUsdt : 0;
        uint256 balance = asset.balanceOf(address(this));
        if (balance < protectedAmount || amount > balance - protectedAmount) revert InsufficientSurplus();
        asset.safeTransfer(recipient, amount);
        emit SurplusRecovered(token, recipient, amount, incidentHash);
    }

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function _executeOrder(V2Types.OrderIntent calldata intent, address prizeRecipient, bool requireLatestPolicy)
        private
    {
        if (newOrdersPaused) revert NewOrdersPaused();
        if (_orders[intent.orderId].state != V2Types.OrderState.None) revert OrderExists();
        if (usedOrderNonce[intent.buyer][intent.nonce] || usedReservation[intent.reservationId]) revert Replay();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (block.timestamp > intent.reservationDeadline) revert ReservationExpired();

        V2Types.Policy memory policy = policyRegistry.getPolicy(intent.policyVersion);
        if (requireLatestPolicy && intent.policyVersion != policyRegistry.latestVersion()) revert InvalidIntent();
        _validateIntent(intent, policy, prizeRecipient);
        if (claimVault.merchantFrozen(intent.merchant)) revert MerchantUnavailable();
        if (!guaranteeVault.canAcceptOrder(intent.merchant, intent.policyVersion)) revert MerchantUnavailable();
        beneficiaryRegistry.validateSnapshot(
            intent.policyVersion, intent.buyer, intent.merchant, intent.regionCodeHash, intent.beneficiaries
        );
        guaranteeVault.reserveOrderCoverage(
            intent.orderId, intent.policyVersion, intent.merchant, intent.merchantUsdtAmount
        );

        usedOrderNonce[intent.buyer][intent.nonce] = true;
        usedReservation[intent.reservationId] = true;
        (uint256 burnedNpl, uint256 routedNpl) = _collectPayment(intent, policy, prizeRecipient);
        _storeOrder(intent);

        emit OrderPaid(
            intent.orderId,
            intent.buyer,
            intent.merchant,
            intent.policyVersion,
            intent.usdtPaymentAmount,
            intent.nplPaymentAmount,
            burnedNpl,
            routedNpl,
            intent.bnmAmount,
            intent.seckill,
            intent.sessionId,
            keccak256(abi.encode(intent))
        );
    }

    function _validateIntent(V2Types.OrderIntent calldata intent, V2Types.Policy memory policy, address prizeRecipient)
        private
        view
    {
        if (
            intent.orderId == bytes32(0) || intent.buyer == address(0) || intent.merchant == address(0)
                || intent.productId == bytes32(0) || intent.skuId == bytes32(0) || intent.quantity == 0
                || intent.fulfillmentTargetHash == bytes32(0) || intent.regionCodeHash == bytes32(0)
                || intent.productPolicyHash == bytes32(0) || intent.reservationId == bytes32(0)
                || intent.reservationHash == bytes32(0) || intent.listPriceUsdt == 0 || intent.merchantUsdtAmount == 0
        ) revert InvalidIntent();
        if (intent.bnmAmount != intent.listPriceUsdt) revert InvalidAmounts();

        uint256 expectedUsdt = Math.mulDiv(intent.listPriceUsdt, policy.usdtPaymentBps, V2Types.BPS);
        uint256 expectedNpl = Math.mulDiv(intent.rewardBaseNpl, policy.nplPaymentBps, V2Types.BPS);
        uint256 expectedPlatform = Math.mulDiv(intent.listPriceUsdt, policy.platformFeeBps, V2Types.BPS);
        uint256 expectedPrize =
            intent.seckill ? Math.mulDiv(intent.listPriceUsdt, policy.seckillPrizeBps, V2Types.BPS) : 0;
        if (
            intent.usdtPaymentAmount != expectedUsdt || intent.nplPaymentAmount != expectedNpl
                || intent.platformUsdtAmount != expectedPlatform || intent.prizeUsdtAmount != expectedPrize
                || intent.merchantUsdtAmount + intent.platformUsdtAmount + intent.prizeUsdtAmount
                        + intent.usdtRemainderAmount != intent.usdtPaymentAmount
        ) revert InvalidAmounts();
        if ((intent.nplPaymentAmount == 0) != (intent.rewardBaseNpl == 0)) revert InvalidAmounts();
        if (intent.oracleVersion != policy.oracleVersion) revert InvalidAmounts();
        if (intent.nplPaymentAmount != 0) {
            oracle.validateQuote(
                intent.oracleVersion,
                intent.listPriceUsdt,
                intent.rewardBaseNpl,
                policy.oracleMaxAge,
                policy.oracleMinLiquidity
            );
            if (mulmod(intent.nplPaymentAmount, policy.burnBps, V2Types.BPS) != 0) revert InvalidAmounts();
            uint256 totalRewardBps = uint256(policy.genesisBps) + policy.directReferralBps + policy.districtBps
                + policy.cityBps + policy.provinceBps + policy.regionBps + policy.operationsBps
                + policy.merchantStoreBps;
            uint256 routedNpl =
                intent.nplPaymentAmount - Math.mulDiv(intent.nplPaymentAmount, policy.burnBps, V2Types.BPS);
            if (Math.mulDiv(intent.rewardBaseNpl, totalRewardBps, V2Types.BPS) > routedNpl) {
                revert InvalidAmounts();
            }
        }
        if (intent.seckill) {
            if (intent.sessionId == bytes32(0) || prizeRecipient == address(0)) revert InvalidIntent();
        } else if (intent.sessionId != bytes32(0) || prizeRecipient != address(0) || intent.prizeUsdtAmount != 0) {
            revert InvalidIntent();
        }
    }

    function _collectPayment(V2Types.OrderIntent calldata intent, V2Types.Policy memory policy, address prizeRecipient)
        private
        returns (uint256 burnedNpl, uint256 routedNpl)
    {
        if (intent.usdtPaymentAmount != 0) _pullExact(usdt, intent.buyer, intent.usdtPaymentAmount);
        if (intent.nplPaymentAmount != 0) _pullExact(npl, intent.buyer, intent.nplPaymentAmount);

        if (intent.nplPaymentAmount != 0) {
            burnedNpl = Math.mulDiv(intent.nplPaymentAmount, policy.burnBps, V2Types.BPS);
            routedNpl = intent.nplPaymentAmount - burnedNpl;
            if (burnedNpl != 0) npl.safeTransfer(NPL_BURN_ADDRESS, burnedNpl);
        }
        rewardLedger.lockOrder(
            intent.orderId, intent.policyVersion, routedNpl, intent.rewardBaseNpl, intent.beneficiaries
        );
        if (intent.prizeUsdtAmount != 0) usdt.safeTransfer(prizeRecipient, intent.prizeUsdtAmount);
        totalLockedUsdt += intent.usdtPaymentAmount - intent.prizeUsdtAmount;
    }

    function _storeOrder(V2Types.OrderIntent calldata intent) private {
        _orders[intent.orderId] = Order({
            policyVersion: intent.policyVersion,
            paidAt: uint64(block.timestamp),
            shippedAt: 0,
            deliveredAt: 0,
            buyer: intent.buyer,
            merchant: intent.merchant,
            fulfillmentMode: intent.fulfillmentMode,
            pendingMethod: V2Types.FulfillmentMethod.CustomerReceipt,
            state: V2Types.OrderState.Paid,
            usdtLocked: intent.usdtPaymentAmount - intent.prizeUsdtAmount,
            merchantUsdtAmount: intent.merchantUsdtAmount,
            platformUsdtAmount: intent.platformUsdtAmount,
            usdtRemainderAmount: intent.usdtRemainderAmount,
            bnmAmount: intent.bnmAmount,
            takeoverOpened: false,
            snapshotHash: keccak256(abi.encode(intent)),
            shipmentEvidenceHash: bytes32(0),
            deliveryEvidenceHash: bytes32(0),
            fulfillmentRequestHash: bytes32(0),
            finalityEvidenceHash: bytes32(0)
        });
    }

    function _validateFinality(
        Order storage order,
        V2Types.FulfillmentAttestation calldata attestation,
        bytes calldata finalitySignature
    ) private view {
        if (
            order.state != V2Types.OrderState.FulfillmentPending || attestation.method != order.pendingMethod
                || attestation.evidenceHash != order.fulfillmentRequestHash || attestation.sourceChainId != BSC_CHAIN_ID
                || attestation.sourceContract != address(this)
                || attestation.sourceEventHash != FULFILLMENT_REQUEST_EVENT_SIGNATURE
                || attestation.sourceTxHash == bytes32(0) || attestation.blockHash == bytes32(0)
                || attestation.confirmations < requiredConfirmations || attestation.status != 1
                || attestation.evidenceHash == bytes32(0) || block.timestamp > attestation.deadline
                || usedFinalityNonce[attestation.nonce]
        ) revert InvalidFinality();
        if (!SignatureChecker.isValidSignatureNowCalldata(finalitySigner, hashFinality(attestation), finalitySignature))
        {
            revert InvalidSignature();
        }
    }

    function _setFulfillmentRequest(
        bytes32 orderId,
        Order storage order,
        V2Types.FulfillmentMethod method,
        bytes32 evidenceHash
    ) private {
        order.pendingMethod = method;
        order.fulfillmentRequestHash = evidenceHash;
        order.state = V2Types.OrderState.FulfillmentPending;
        emit FulfillmentRequested(orderId, method, evidenceHash);
    }

    function _getOrder(bytes32 orderId) private view returns (Order storage order) {
        order = _orders[orderId];
        if (order.state == V2Types.OrderState.None) revert UnknownOrder();
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert InexactTransfer();
    }
}
