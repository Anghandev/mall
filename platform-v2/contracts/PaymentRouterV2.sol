// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBeneficiaryRegistryV2, IPolicyRegistryV2, ITwapOracleV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract PaymentRouterV2 is AccessControl, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant SESSION_ADMIN_ROLE = keccak256("SESSION_ADMIN_ROLE");
    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "PaymentAuthorization(bytes32 paymentHash,bytes32 orderId,address buyer,address merchant,bytes32 productId,bytes32 skuId,uint32 quantity,uint8 fulfillmentMode,uint256 listPriceUsdt,uint256 usdtPaymentAmount,uint256 nplPaymentAmount,uint64 deadline)"
    );
    bytes32 public constant SECKILL_TYPEHASH = keccak256(
        "SeckillAuthorization(bytes32 seckillHash,bytes32 orderId,address buyer,address merchant,bytes32 productId,bytes32 skuId,uint32 quantity,uint8 fulfillmentMode,uint256 seckillListPriceUsdt,uint256 seckillUsdtPaymentAmount,uint256 seckillNplPaymentAmount,uint256 fallbackListPriceUsdt,uint256 fallbackUsdtPaymentAmount,uint256 fallbackNplPaymentAmount,uint64 deadline)"
    );

    struct SeckillSession {
        uint64 policyVersion;
        uint64 startsAt;
        uint64 mainDeadline;
        uint64 relayDeadline;
        uint32 relayIncrement;
        uint32 relayCap;
        bool opened;
    }

    IERC20 public immutable usdt;
    IERC20 public immutable npl;
    IPolicyRegistryV2 public immutable policyRegistry;
    IBeneficiaryRegistryV2 public immutable beneficiaryRegistry;
    ITwapOracleV2 public immutable oracle;
    address public immutable governanceSafe;
    address public immutable platformServiceFeeSafe;
    address public immutable usdtCustodySafe;
    address public immutable nplRewardSafe;
    address public immutable operationsTreasurySafe;
    address public immutable quoteSigner;

    mapping(bytes32 orderId => bool used) public usedOrderId;
    mapping(address buyer => mapping(uint256 nonce => bool used)) public usedPaymentNonce;
    mapping(bytes32 reservationId => bool used) public usedReservation;
    mapping(bytes32 sessionId => SeckillSession session) private _sessions;
    bool public newPaymentsPaused;
    bool public seckillPurchasesPaused;

    error InvalidAddress();
    error InvalidIntent();
    error InvalidAmounts();
    error InvalidSignature();
    error QuoteExpired();
    error ReservationExpired();
    error Replay();
    error InexactTransfer();
    error NewPaymentsPaused();
    error SeckillPurchasesPaused();
    error InvalidSession();
    error SessionNotLive();
    error SafeExecutionRequired();

    event PaymentCompleted(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed merchant,
        V2Types.PaymentClassification classification,
        uint64 policyVersion,
        uint256 listPriceUsdt,
        uint256 productUsdtPaid,
        uint256 platformServiceFeeUsdt,
        uint256 custodyProductUsdt,
        uint256 freightUsdt,
        uint256 usdtPaid,
        uint256 nplPaid,
        uint256 nplBurned,
        uint256 nplRewarded,
        uint256 bnmLocked,
        bytes32 reservationId,
        bytes32 snapshotHash
    );
    event MerchantReceivableSnapshotted(
        bytes32 indexed orderId,
        uint256 baseReceivableUsdt,
        uint16 concessionBps,
        uint256 concessionAmountUsdt,
        uint256 netReceivableUsdt,
        bytes32 indexed allocationHash
    );
    event SeckillSessionOpened(
        bytes32 indexed sessionId,
        uint64 indexed policyVersion,
        uint64 startsAt,
        uint64 mainDeadline,
        uint64 relayDeadline
    );
    event SeckillRelayExtended(bytes32 indexed sessionId, bytes32 indexed orderId, uint64 relayDeadline);
    event PaymentPauseChanged(bool paused, bytes32 indexed evidenceHash);
    event SeckillPurchasePauseChanged(bool paused, bytes32 indexed evidenceHash);

    constructor(
        IERC20 usdt_,
        IERC20 npl_,
        IPolicyRegistryV2 policyRegistry_,
        IBeneficiaryRegistryV2 beneficiaryRegistry_,
        ITwapOracleV2 oracle_,
        address platformServiceFeeSafe_,
        address usdtCustodySafe_,
        address nplRewardSafe_,
        address operationsTreasurySafe_,
        address quoteSigner_
    ) EIP712("Abu24KPaymentRouter", "2") {
        if (address(policyRegistry_) == address(0)) revert InvalidAddress();
        address governanceSafe_ = policyRegistry_.safe();
        if (
            block.chainid != V2Types.BSC_CHAIN_ID || address(usdt_) != V2Types.USDT || address(npl_) != V2Types.NPL
                || address(beneficiaryRegistry_) == address(0) || address(oracle_) == address(0)
                || governanceSafe_ == address(0) || platformServiceFeeSafe_ == address(0)
                || usdtCustodySafe_ == address(0) || nplRewardSafe_ == address(0)
                || operationsTreasurySafe_ == address(0) || quoteSigner_ == address(0)
                || platformServiceFeeSafe_ == governanceSafe_ || usdtCustodySafe_ == governanceSafe_
                || nplRewardSafe_ == governanceSafe_ || operationsTreasurySafe_ == governanceSafe_
                || platformServiceFeeSafe_ == usdtCustodySafe_ || platformServiceFeeSafe_ == nplRewardSafe_
                || platformServiceFeeSafe_ == operationsTreasurySafe_ || usdtCustodySafe_ == nplRewardSafe_
                || usdtCustodySafe_ == operationsTreasurySafe_ || nplRewardSafe_ == operationsTreasurySafe_
        ) revert InvalidAddress();
        usdt = usdt_;
        npl = npl_;
        policyRegistry = policyRegistry_;
        beneficiaryRegistry = beneficiaryRegistry_;
        oracle = oracle_;
        governanceSafe = governanceSafe_;
        platformServiceFeeSafe = platformServiceFeeSafe_;
        usdtCustodySafe = usdtCustodySafe_;
        nplRewardSafe = nplRewardSafe_;
        operationsTreasurySafe = operationsTreasurySafe_;
        quoteSigner = quoteSigner_;
        _grantRole(DEFAULT_ADMIN_ROLE, governanceSafe_);
        _grantRole(PAUSER_ROLE, governanceSafe_);
        _grantRole(SESSION_ADMIN_ROLE, governanceSafe_);
    }

    function pay(V2Types.PaymentIntent calldata intent, bytes calldata quoteSignature, bytes calldata buyerSignature)
        external
        nonReentrant
    {
        if (intent.seckill || intent.sessionId != bytes32(0)) revert InvalidIntent();
        bytes32 digest = hashPayment(intent);
        _validateSignatures(intent.buyer, digest, quoteSignature, buyerSignature);
        _executePayment(intent, V2Types.PaymentClassification.Ordinary);
    }

    function paySeckill(
        V2Types.SeckillIntent calldata intent,
        bytes calldata quoteSignature,
        bytes calldata buyerSignature
    ) external nonReentrant {
        if (seckillPurchasesPaused) revert SeckillPurchasesPaused();
        SeckillSession storage session = _sessions[intent.sessionId];
        if (!session.opened || block.timestamp < session.startsAt) revert SessionNotLive();
        _validateDualIntent(intent, session.policyVersion);
        bytes32 digest = hashSeckill(intent);
        _validateSignatures(intent.seckillPayment.buyer, digest, quoteSignature, buyerSignature);

        bool live = block.timestamp < session.mainDeadline && block.timestamp < session.relayDeadline;
        if (live) {
            _executePayment(intent.seckillPayment, V2Types.PaymentClassification.Seckill);
            uint64 remaining = session.relayDeadline - uint64(block.timestamp);
            uint64 extendedRemaining = remaining + session.relayIncrement;
            if (extendedRemaining > session.relayCap) extendedRemaining = session.relayCap;
            uint64 extendedDeadline = uint64(block.timestamp) + extendedRemaining;
            session.relayDeadline = extendedDeadline < session.mainDeadline ? extendedDeadline : session.mainDeadline;
            emit SeckillRelayExtended(intent.sessionId, intent.seckillPayment.orderId, session.relayDeadline);
        } else {
            _executePayment(intent.fallbackPayment, V2Types.PaymentClassification.FallbackRetail);
        }
    }

    function openSeckillSession(bytes32 sessionId, uint64 policyVersion, uint64 startsAt)
        external
        onlyRole(SESSION_ADMIN_ROLE)
    {
        if (msg.sender != governanceSafe) revert SafeExecutionRequired();
        if (sessionId == bytes32(0) || startsAt < block.timestamp || _sessions[sessionId].opened) {
            revert InvalidSession();
        }
        V2Types.Policy memory policy = policyRegistry.getPolicy(policyVersion);
        uint64 mainDeadline = startsAt + policy.seckillMainDuration;
        uint64 relayDeadline = startsAt + policy.relayInitial;
        _sessions[sessionId] = SeckillSession(
            policyVersion, startsAt, mainDeadline, relayDeadline, policy.relayIncrement, policy.relayCap, true
        );
        emit SeckillSessionOpened(sessionId, policyVersion, startsAt, mainDeadline, relayDeadline);
    }

    function setNewPaymentsPaused(bool paused, bytes32 evidenceHash) external onlyRole(PAUSER_ROLE) {
        if (msg.sender != governanceSafe) revert SafeExecutionRequired();
        if (evidenceHash == bytes32(0)) revert InvalidIntent();
        newPaymentsPaused = paused;
        emit PaymentPauseChanged(paused, evidenceHash);
    }

    function setSeckillPurchasesPaused(bool paused, bytes32 evidenceHash) external onlyRole(PAUSER_ROLE) {
        if (msg.sender != governanceSafe) revert SafeExecutionRequired();
        if (evidenceHash == bytes32(0)) revert InvalidIntent();
        seckillPurchasesPaused = paused;
        emit SeckillPurchasePauseChanged(paused, evidenceHash);
    }

    function hashPayment(V2Types.PaymentIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_TYPEHASH,
                    keccak256(abi.encode(intent)),
                    intent.orderId,
                    intent.buyer,
                    intent.merchant,
                    intent.productId,
                    intent.skuId,
                    intent.quantity,
                    intent.fulfillmentMode,
                    intent.listPriceUsdt,
                    intent.usdtPaymentAmount,
                    intent.nplPaymentAmount,
                    intent.deadline
                )
            )
        );
    }

    function hashSeckill(V2Types.SeckillIntent calldata intent) public view returns (bytes32) {
        V2Types.PaymentIntent calldata seckill = intent.seckillPayment;
        V2Types.PaymentIntent calldata fallbackPayment = intent.fallbackPayment;
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SECKILL_TYPEHASH,
                    keccak256(abi.encode(intent)),
                    seckill.orderId,
                    seckill.buyer,
                    seckill.merchant,
                    seckill.productId,
                    seckill.skuId,
                    seckill.quantity,
                    seckill.fulfillmentMode,
                    seckill.listPriceUsdt,
                    seckill.usdtPaymentAmount,
                    seckill.nplPaymentAmount,
                    fallbackPayment.listPriceUsdt,
                    fallbackPayment.usdtPaymentAmount,
                    fallbackPayment.nplPaymentAmount,
                    seckill.deadline
                )
            )
        );
    }

    function getSession(bytes32 sessionId) external view returns (SeckillSession memory) {
        return _sessions[sessionId];
    }

    function _executePayment(V2Types.PaymentIntent calldata intent, V2Types.PaymentClassification classification)
        private
    {
        if (newPaymentsPaused) revert NewPaymentsPaused();
        _validateIntent(intent, classification);
        if (
            usedOrderId[intent.orderId] || usedPaymentNonce[intent.buyer][intent.nonce]
                || usedReservation[intent.reservationId]
        ) {
            revert Replay();
        }
        usedOrderId[intent.orderId] = true;
        usedPaymentNonce[intent.buyer][intent.nonce] = true;
        usedReservation[intent.reservationId] = true;

        uint256 routerUsdtBefore = usdt.balanceOf(address(this));
        uint256 routerNplBefore = npl.balanceOf(address(this));
        uint256 buyerUsdtBefore = usdt.balanceOf(intent.buyer);
        uint256 buyerNplBefore = npl.balanceOf(intent.buyer);
        uint256 platformServiceFeeBefore = usdt.balanceOf(platformServiceFeeSafe);
        uint256 custodyBefore = usdt.balanceOf(usdtCustodySafe);
        uint256 burnBefore = npl.balanceOf(V2Types.NPL_BURN_ADDRESS);
        uint256 rewardBefore = npl.balanceOf(nplRewardSafe);

        if (intent.platformServiceFeeUsdt != 0) {
            usdt.safeTransferFrom(intent.buyer, platformServiceFeeSafe, intent.platformServiceFeeUsdt);
        }
        uint256 custodyUsdt = intent.custodyProductUsdt + intent.freightUsdt;
        if (custodyUsdt != 0) usdt.safeTransferFrom(intent.buyer, usdtCustodySafe, custodyUsdt);
        npl.safeTransferFrom(intent.buyer, V2Types.NPL_BURN_ADDRESS, intent.nplBurnAmount);
        npl.safeTransferFrom(intent.buyer, nplRewardSafe, intent.nplRewardAmount);

        if (
            usdt.balanceOf(address(this)) != routerUsdtBefore || npl.balanceOf(address(this)) != routerNplBefore
                || buyerUsdtBefore - usdt.balanceOf(intent.buyer) != intent.usdtPaymentAmount
                || buyerNplBefore - npl.balanceOf(intent.buyer) != intent.nplPaymentAmount
                || usdt.balanceOf(platformServiceFeeSafe) - platformServiceFeeBefore != intent.platformServiceFeeUsdt
                || usdt.balanceOf(usdtCustodySafe) - custodyBefore != custodyUsdt
                || npl.balanceOf(V2Types.NPL_BURN_ADDRESS) - burnBefore != intent.nplBurnAmount
                || npl.balanceOf(nplRewardSafe) - rewardBefore != intent.nplRewardAmount
        ) revert InexactTransfer();

        bytes32 snapshotHash = keccak256(abi.encode(intent));
        emit PaymentCompleted(
            intent.orderId,
            intent.buyer,
            intent.merchant,
            classification,
            intent.policyVersion,
            intent.listPriceUsdt,
            intent.productUsdtPaymentAmount,
            intent.platformServiceFeeUsdt,
            intent.custodyProductUsdt,
            intent.freightUsdt,
            intent.usdtPaymentAmount,
            intent.nplPaymentAmount,
            intent.nplBurnAmount,
            intent.nplRewardAmount,
            intent.bnmAmount,
            intent.reservationId,
            snapshotHash
        );
        emit MerchantReceivableSnapshotted(
            intent.orderId,
            intent.merchantBaseReceivableUsdt,
            intent.merchantConcessionBps,
            intent.merchantConcessionAmount,
            intent.merchantNetReceivableUsdt,
            intent.concessionAllocationHash
        );
    }

    function _validateIntent(V2Types.PaymentIntent calldata intent, V2Types.PaymentClassification classification)
        private
        view
    {
        if (
            intent.orderId == bytes32(0) || intent.buyer == address(0) || intent.merchant == address(0)
                || intent.buyer == intent.merchant || intent.productId == bytes32(0) || intent.skuId == bytes32(0)
                || intent.quantity == 0 || intent.fulfillmentTargetHash == bytes32(0)
                || intent.regionCodeHash == bytes32(0) || intent.productPolicyHash == bytes32(0)
                || intent.reservationId == bytes32(0) || intent.reservationHash == bytes32(0)
                || intent.concessionAllocationHash == bytes32(0)
        ) revert InvalidIntent();
        if (intent.issuedAt > block.timestamp || intent.deadline <= block.timestamp) revert QuoteExpired();
        if (intent.deadline - intent.issuedAt > V2Types.QUOTE_VALIDITY) revert QuoteExpired();
        if (intent.reservationDeadline < intent.deadline || intent.reservationDeadline <= block.timestamp) {
            revert ReservationExpired();
        }
        if (classification == V2Types.PaymentClassification.Seckill) {
            if (!intent.seckill || intent.sessionId == bytes32(0)) revert InvalidIntent();
        } else if (intent.seckill || intent.sessionId != bytes32(0)) {
            revert InvalidIntent();
        }

        V2Types.Policy memory policy = policyRegistry.getPolicy(intent.policyVersion);
        if (
            intent.oracleVersion != policy.oracleVersion || policy.usdtCustodySafe != usdtCustodySafe
                || policy.nplRewardSafe != nplRewardSafe || policy.operationsTreasurySafe != operationsTreasurySafe
                || intent.concessionAllocationHash != policy.concessionDestinationSetHash
        ) revert InvalidIntent();
        _validateAmounts(intent, policy);
        beneficiaryRegistry.validateSnapshot(
            intent.policyVersion, intent.buyer, intent.merchant, intent.regionCodeHash, intent.beneficiaries
        );
        oracle.validateQuote(intent.oracleVersion, intent.listPriceUsdt, intent.nplQuoteAmount);
    }

    function _validateAmounts(V2Types.PaymentIntent calldata intent, V2Types.Policy memory policy) private pure {
        if (intent.listPriceUsdt == 0 || intent.nplQuoteAmount == 0 || intent.merchantConcessionBps > V2Types.BPS) {
            revert InvalidAmounts();
        }
        uint256 expectedProductUsdt = Math.mulDiv(intent.listPriceUsdt, policy.usdtPaymentBps, V2Types.BPS);
        uint256 expectedServiceFee =
            Math.mulDiv(intent.listPriceUsdt, V2Types.PLATFORM_SERVICE_FEE_LIST_PRICE_BPS, V2Types.BPS);
        uint256 expectedCustodyProductUsdt = expectedProductUsdt - expectedServiceFee;
        uint256 expectedUsdt = expectedProductUsdt + intent.freightUsdt;
        uint256 expectedNplPayment = Math.mulDiv(intent.nplQuoteAmount, policy.nplPaymentBps, V2Types.BPS);
        uint256 expectedBurn = Math.mulDiv(intent.nplQuoteAmount, policy.nplBurnListPriceBps, V2Types.BPS);
        uint256 expectedReward = expectedNplPayment - expectedBurn;
        uint256 expectedConcession =
            Math.mulDiv(intent.merchantBaseReceivableUsdt, intent.merchantConcessionBps, V2Types.BPS);
        if (
            expectedProductUsdt == 0 || expectedNplPayment == 0
                || (policy.nplBurnListPriceBps != 0 && expectedBurn == 0)
                || (policy.nplRewardListPriceBps != 0 && expectedReward == 0)
                || policy.platformFeeBps != V2Types.PLATFORM_SERVICE_FEE_LIST_PRICE_BPS
                || intent.productUsdtPaymentAmount != expectedProductUsdt
                || intent.platformServiceFeeUsdt != expectedServiceFee
                || intent.custodyProductUsdt != expectedCustodyProductUsdt
                || intent.platformServiceFeeUsdt + intent.custodyProductUsdt != intent.productUsdtPaymentAmount
                || intent.usdtPaymentAmount != expectedUsdt
                || (intent.fulfillmentMode == V2Types.FulfillmentMode.Pickup && intent.freightUsdt != 0)
                || intent.nplPaymentAmount != expectedNplPayment || intent.nplBurnAmount != expectedBurn
                || intent.nplRewardAmount != expectedReward
                || intent.nplBurnAmount + intent.nplRewardAmount != intent.nplPaymentAmount
                || intent.merchantBaseReceivableUsdt != intent.custodyProductUsdt
                || intent.merchantConcessionAmount != expectedConcession
                || intent.merchantNetReceivableUsdt != intent.merchantBaseReceivableUsdt - expectedConcession
                || intent.bnmAmount != intent.listPriceUsdt
        ) revert InvalidAmounts();
    }

    function _validateDualIntent(V2Types.SeckillIntent calldata intent, uint64 sessionPolicyVersion) private pure {
        V2Types.PaymentIntent calldata seckill = intent.seckillPayment;
        V2Types.PaymentIntent calldata fallbackPayment = intent.fallbackPayment;
        if (
            intent.sessionId == bytes32(0) || !seckill.seckill || seckill.sessionId != intent.sessionId
                || fallbackPayment.seckill || fallbackPayment.sessionId != bytes32(0)
                || seckill.policyVersion != sessionPolicyVersion
                || fallbackPayment.policyVersion != sessionPolicyVersion || seckill.orderId != fallbackPayment.orderId
                || seckill.buyer != fallbackPayment.buyer || seckill.merchant != fallbackPayment.merchant
                || seckill.productId != fallbackPayment.productId || seckill.skuId != fallbackPayment.skuId
                || seckill.quantity != fallbackPayment.quantity
                || seckill.fulfillmentMode != fallbackPayment.fulfillmentMode
                || seckill.fulfillmentTargetHash != fallbackPayment.fulfillmentTargetHash
                || seckill.regionCodeHash != fallbackPayment.regionCodeHash
                || seckill.oracleVersion != fallbackPayment.oracleVersion
                || seckill.productPolicyHash != fallbackPayment.productPolicyHash
                || seckill.reservationDeadline != fallbackPayment.reservationDeadline
                || seckill.issuedAt != fallbackPayment.issuedAt || seckill.deadline != fallbackPayment.deadline
                || seckill.nonce != fallbackPayment.nonce || seckill.freightUsdt != fallbackPayment.freightUsdt
                || seckill.merchantConcessionBps != fallbackPayment.merchantConcessionBps
                || seckill.concessionAllocationHash != fallbackPayment.concessionAllocationHash
                || keccak256(abi.encode(seckill.beneficiaries)) != keccak256(abi.encode(fallbackPayment.beneficiaries))
                || seckill.reservationId == fallbackPayment.reservationId
        ) revert InvalidIntent();
    }

    function _validateSignatures(
        address buyer,
        bytes32 digest,
        bytes calldata quoteSignature,
        bytes calldata buyerSignature
    ) private view {
        if (
            !SignatureChecker.isValidSignatureNowCalldata(quoteSigner, digest, quoteSignature)
                || !SignatureChecker.isValidSignatureNowCalldata(buyer, digest, buyerSignature)
        ) revert InvalidSignature();
    }
}
