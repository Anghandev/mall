// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IClaimVaultV2, IMerchantGuaranteeVaultV2, IPaymentEscrowV2, IPolicyRegistryV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract SeckillV2 is AccessControl, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_SETTLEMENT_DELAY = 5 minutes;
    bytes32 public constant SESSION_ADMIN_ROLE = keccak256("SESSION_ADMIN_ROLE");
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");
    bytes32 public constant PURCHASE_TYPEHASH = keccak256("SeckillPurchase(bytes32 purchaseHash)");
    bytes32 public constant ADMIN_ACTION_TYPEHASH =
        keccak256("SeckillAdminAction(bytes32 actionHash,uint256 nonce,uint64 deadline)");

    struct Session {
        uint64 policyVersion;
        uint64 startsAt;
        uint64 mainDeadline;
        uint64 relayDeadline;
        uint64 forceClosedAt;
        address merchant;
        address lastBuyer;
        bytes32 productId;
        bytes32 skuId;
        bytes32 productPolicyHash;
        uint256 inventory;
        uint256 sold;
        uint256 prizePool;
        bool settled;
    }

    IERC20 public immutable usdt;
    IPolicyRegistryV2 public immutable policyRegistry;
    IMerchantGuaranteeVaultV2 public immutable guaranteeVault;
    IPaymentEscrowV2 public immutable paymentEscrow;
    IClaimVaultV2 public immutable claimVault;
    address public immutable quoteSigner;
    address public immutable safe;

    mapping(bytes32 sessionId => Session session) private _sessions;
    mapping(uint256 nonce => bool used) public usedAdminNonce;
    uint256 public totalUnsettledPrize;
    bool public purchasesPaused;
    bool public settlementPaused;

    error InvalidAddress();
    error InvalidSession();
    error SessionExists();
    error UnknownSession();
    error SessionNotStarted();
    error SessionClosed();
    error SessionNotReadyToSettle();
    error SessionAlreadySettled();
    error NoWinner();
    error InventoryExceeded();
    error InvalidIntentPair();
    error InvalidSignature();
    error IntentExpired();
    error AdminReplay();
    error SafeExecutionRequired();
    error PurchasesPaused();
    error SettlementPaused();
    error InvalidEvidence();
    error InexactTransfer();
    error InsufficientSurplus();

    event SessionCreated(
        bytes32 indexed sessionId,
        uint64 indexed policyVersion,
        bytes32 indexed productId,
        bytes32 skuId,
        uint64 startsAt,
        uint64 mainDeadline,
        uint64 relayDeadline,
        uint256 inventory,
        bytes32 productPolicyHash
    );
    event SeckillPurchaseFinal(
        bytes32 indexed sessionId,
        bytes32 indexed orderId,
        address indexed buyer,
        bool seckillClassified,
        uint256 quantity,
        uint64 relayDeadline,
        uint256 prizeContribution
    );
    event PrizeInjected(bytes32 indexed sessionId, uint256 amount, uint256 newPrizePool, bytes32 indexed evidenceHash);
    event SessionForceClosed(bytes32 indexed sessionId, uint64 closedAt, bytes32 indexed evidenceHash);
    event SessionSettled(bytes32 indexed sessionId, address indexed winner, uint256 prizeAmount);
    event SeckillPauseChanged(bytes32 indexed scope, bool paused, bytes32 indexed evidenceHash);
    event SurplusRecovered(address indexed recipient, uint256 amount, bytes32 indexed incidentHash);

    constructor(
        IERC20 usdt_,
        IPolicyRegistryV2 policyRegistry_,
        IMerchantGuaranteeVaultV2 guaranteeVault_,
        IPaymentEscrowV2 paymentEscrow_,
        IClaimVaultV2 claimVault_,
        address quoteSigner_
    ) EIP712("Abu24KSeckill", "2") {
        if (
            address(usdt_) == address(0) || address(policyRegistry_) == address(0)
                || address(guaranteeVault_) == address(0) || address(paymentEscrow_) == address(0)
                || address(claimVault_) == address(0) || quoteSigner_ == address(0)
                || block.chainid != V2Types.BSC_CHAIN_ID || address(usdt_) != V2Types.USDT
        ) revert InvalidAddress();
        usdt = usdt_;
        policyRegistry = policyRegistry_;
        guaranteeVault = guaranteeVault_;
        paymentEscrow = paymentEscrow_;
        claimVault = claimVault_;
        quoteSigner = quoteSigner_;
        safe = policyRegistry_.safe();
        usdt_.forceApprove(address(claimVault_), type(uint256).max);

        _grantRole(DEFAULT_ADMIN_ROLE, safe);
        _grantRole(SESSION_ADMIN_ROLE, safe);
        _grantRole(SETTLER_ROLE, safe);
        _grantRole(PAUSER_ROLE, safe);
        _grantRole(RECOVERY_ROLE, safe);
    }

    function createSession(
        bytes32 sessionId,
        uint64 policyVersion,
        address merchant,
        bytes32 productId,
        bytes32 skuId,
        bytes32 productPolicyHash,
        uint64 startsAt,
        uint256 inventory,
        uint256 nonce,
        uint64 deadline,
        bytes calldata secondarySignature
    ) external onlyRole(SESSION_ADMIN_ROLE) {
        if (msg.sender != safe) revert SafeExecutionRequired();
        if (_sessions[sessionId].policyVersion != 0) revert SessionExists();
        if (policyVersion != policyRegistry.latestVersion()) revert InvalidSession();
        if (
            sessionId == bytes32(0) || merchant == address(0) || productId == bytes32(0) || skuId == bytes32(0)
                || productPolicyHash == bytes32(0) || startsAt < block.timestamp || inventory == 0
        ) revert InvalidSession();
        if (!guaranteeVault.canAcceptOrder(merchant, policyVersion)) revert InvalidSession();

        bytes32 actionHash = keccak256(
            abi.encode(
                "CREATE_SESSION",
                sessionId,
                policyVersion,
                merchant,
                productId,
                skuId,
                productPolicyHash,
                startsAt,
                inventory
            )
        );
        _validateAdminAction(actionHash, nonce, deadline, secondarySignature);
        V2Types.Policy memory policy = policyRegistry.getPolicy(policyVersion);
        uint64 mainDeadline = startsAt + policy.seckillMainDuration;
        uint64 relayDeadline = startsAt + policy.relayInitial;
        _sessions[sessionId] = Session({
            policyVersion: policyVersion,
            startsAt: startsAt,
            mainDeadline: mainDeadline,
            relayDeadline: relayDeadline,
            forceClosedAt: 0,
            merchant: merchant,
            lastBuyer: address(0),
            productId: productId,
            skuId: skuId,
            productPolicyHash: productPolicyHash,
            inventory: inventory,
            sold: 0,
            prizePool: 0,
            settled: false
        });
        emit SessionCreated(
            sessionId,
            policyVersion,
            productId,
            skuId,
            startsAt,
            mainDeadline,
            relayDeadline,
            inventory,
            productPolicyHash
        );
    }

    function buy(V2Types.SeckillIntent calldata intent, bytes calldata quoteSignature, bytes calldata buyerSignature)
        external
        nonReentrant
    {
        if (purchasesPaused) revert PurchasesPaused();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        Session storage session = _getSession(intent.sessionId);
        if (block.timestamp < session.startsAt) revert SessionNotStarted();
        _validateIntentPair(session, intent);

        bytes32 digest = hashPurchase(intent);
        if (!SignatureChecker.isValidSignatureNowCalldata(quoteSigner, digest, quoteSignature)) {
            revert InvalidSignature();
        }
        if (!SignatureChecker.isValidSignatureNowCalldata(intent.seckillOrder.buyer, digest, buyerSignature)) {
            revert InvalidSignature();
        }

        bool seckillClassified = _isSeckillWindowOpen(session);
        V2Types.OrderIntent calldata selected = seckillClassified ? intent.seckillOrder : intent.fallbackOrder;
        if (seckillClassified && session.sold + selected.quantity > session.inventory) revert InventoryExceeded();
        uint256 prizeContribution = paymentEscrow.executeSeckillOrder(selected);

        if (seckillClassified) {
            session.sold += selected.quantity;
            session.lastBuyer = selected.buyer;
            session.prizePool += prizeContribution;
            totalUnsettledPrize += prizeContribution;
            _extendRelay(session);
        }
        emit SeckillPurchaseFinal(
            intent.sessionId,
            selected.orderId,
            selected.buyer,
            seckillClassified,
            selected.quantity,
            session.relayDeadline,
            prizeContribution
        );
    }

    function injectPrize(
        bytes32 sessionId,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 nonce,
        uint64 deadline,
        bytes calldata secondarySignature
    ) external onlyRole(SESSION_ADMIN_ROLE) nonReentrant {
        if (msg.sender != safe) revert SafeExecutionRequired();
        Session storage session = _getSession(sessionId);
        if (!_isSeckillWindowOpen(session) || amount == 0 || evidenceHash == bytes32(0)) revert SessionClosed();
        bytes32 actionHash = keccak256(
            abi.encode(
                "INJECT_PRIZE", sessionId, session.policyVersion, address(usdt), amount, session.prizePool, evidenceHash
            )
        );
        _validateAdminAction(actionHash, nonce, deadline, secondarySignature);
        _pullExact(msg.sender, amount);
        session.prizePool += amount;
        totalUnsettledPrize += amount;
        emit PrizeInjected(sessionId, amount, session.prizePool, evidenceHash);
    }

    function forceClose(
        bytes32 sessionId,
        bytes32 evidenceHash,
        uint256 nonce,
        uint64 deadline,
        bytes calldata secondarySignature
    ) external onlyRole(SESSION_ADMIN_ROLE) {
        if (msg.sender != safe) revert SafeExecutionRequired();
        Session storage session = _getSession(sessionId);
        if (
            session.settled || session.forceClosedAt != 0 || evidenceHash == bytes32(0)
                || block.timestamp < session.startsAt || !_isSeckillWindowOpen(session)
        ) revert SessionClosed();
        bytes32 actionHash = keccak256(
            abi.encode(
                "FORCE_CLOSE",
                sessionId,
                session.policyVersion,
                session.mainDeadline,
                session.relayDeadline,
                evidenceHash
            )
        );
        _validateAdminAction(actionHash, nonce, deadline, secondarySignature);
        session.forceClosedAt = uint64(block.timestamp);
        emit SessionForceClosed(sessionId, session.forceClosedAt, evidenceHash);
    }

    function settle(bytes32 sessionId) external onlyRole(SETTLER_ROLE) nonReentrant {
        if (settlementPaused) revert SettlementPaused();
        Session storage session = _getSession(sessionId);
        if (session.settled) revert SessionAlreadySettled();
        uint64 closeTime = _closeTime(session);
        if (block.timestamp < closeTime + MIN_SETTLEMENT_DELAY) revert SessionNotReadyToSettle();
        if (session.prizePool != 0 && session.lastBuyer == address(0)) revert NoWinner();

        session.settled = true;
        uint256 prizeAmount = session.prizePool;
        totalUnsettledPrize -= prizeAmount;
        if (prizeAmount != 0) claimVault.depositPrize(sessionId, session.lastBuyer, prizeAmount);
        emit SessionSettled(sessionId, session.lastBuyer, prizeAmount);
    }

    function setPurchasePause(bool paused, bytes32 evidenceHash) external onlyRole(PAUSER_ROLE) {
        if (msg.sender != safe) revert SafeExecutionRequired();
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        purchasesPaused = paused;
        emit SeckillPauseChanged("PURCHASE", paused, evidenceHash);
    }

    function setSettlementPause(bool paused, bytes32 evidenceHash) external onlyRole(PAUSER_ROLE) {
        if (msg.sender != safe) revert SafeExecutionRequired();
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        settlementPaused = paused;
        emit SeckillPauseChanged("SETTLEMENT", paused, evidenceHash);
    }

    function recoverSurplus(address recipient, uint256 amount, bytes32 incidentHash)
        external
        onlyRole(RECOVERY_ROLE)
        nonReentrant
    {
        if (msg.sender != safe) revert SafeExecutionRequired();
        if (recipient == address(0) || incidentHash == bytes32(0)) revert InvalidEvidence();
        uint256 balance = usdt.balanceOf(address(this));
        if (balance < totalUnsettledPrize || amount > balance - totalUnsettledPrize) revert InsufficientSurplus();
        usdt.safeTransfer(recipient, amount);
        emit SurplusRecovered(recipient, amount, incidentHash);
    }

    function hashPurchase(V2Types.SeckillIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PURCHASE_TYPEHASH, keccak256(abi.encode(intent)))));
    }

    function hashAdminAction(bytes32 actionHash, uint256 nonce, uint64 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ADMIN_ACTION_TYPEHASH, actionHash, nonce, deadline)));
    }

    function getSession(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    function isSeckillWindowOpen(bytes32 sessionId) external view returns (bool) {
        Session storage session = _getSession(sessionId);
        return block.timestamp >= session.startsAt && _isSeckillWindowOpen(session);
    }

    function _validateIntentPair(Session storage session, V2Types.SeckillIntent calldata intent) private view {
        V2Types.OrderIntent calldata seckillOrder = intent.seckillOrder;
        V2Types.OrderIntent calldata fallbackOrder = intent.fallbackOrder;
        if (
            seckillOrder.orderId != fallbackOrder.orderId || seckillOrder.buyer != fallbackOrder.buyer
                || seckillOrder.merchant != fallbackOrder.merchant || seckillOrder.merchant != session.merchant
                || seckillOrder.productId != fallbackOrder.productId || seckillOrder.productId != session.productId
                || seckillOrder.skuId != fallbackOrder.skuId || seckillOrder.skuId != session.skuId
                || seckillOrder.quantity != fallbackOrder.quantity
                || seckillOrder.policyVersion != session.policyVersion
                || fallbackOrder.policyVersion != session.policyVersion
                || seckillOrder.productPolicyHash != session.productPolicyHash
                || fallbackOrder.productPolicyHash != session.productPolicyHash || !seckillOrder.seckill
                || fallbackOrder.seckill || seckillOrder.sessionId != intent.sessionId
                || fallbackOrder.sessionId != bytes32(0) || seckillOrder.nonce != fallbackOrder.nonce
                || seckillOrder.reservationId == fallbackOrder.reservationId
        ) revert InvalidIntentPair();
    }

    function _validateAdminAction(bytes32 actionHash, uint256 nonce, uint64 deadline, bytes calldata secondarySignature)
        private
    {
        if (block.timestamp > deadline) revert IntentExpired();
        if (usedAdminNonce[nonce]) revert AdminReplay();
        bytes32 digest = hashAdminAction(actionHash, nonce, deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(policyRegistry.secondarySigner(), digest, secondarySignature))
        {
            revert InvalidSignature();
        }
        usedAdminNonce[nonce] = true;
    }

    function _isSeckillWindowOpen(Session storage session) private view returns (bool) {
        return !session.settled && session.forceClosedAt == 0 && block.timestamp < session.mainDeadline
            && block.timestamp < session.relayDeadline;
    }

    function _extendRelay(Session storage session) private {
        V2Types.Policy memory policy = policyRegistry.getPolicy(session.policyVersion);
        uint256 remaining = session.relayDeadline - block.timestamp;
        uint256 nextRemaining = remaining + policy.relayIncrement;
        if (nextRemaining > policy.relayCap) nextRemaining = policy.relayCap;
        uint256 nextDeadline = block.timestamp + nextRemaining;
        if (nextDeadline > session.mainDeadline) nextDeadline = session.mainDeadline;
        // nextDeadline is capped by the uint64 mainDeadline above.
        // forge-lint: disable-next-line(unsafe-typecast)
        session.relayDeadline = uint64(nextDeadline);
    }

    function _closeTime(Session storage session) private view returns (uint64) {
        if (session.forceClosedAt != 0) return session.forceClosedAt;
        return session.relayDeadline < session.mainDeadline ? session.relayDeadline : session.mainDeadline;
    }

    function _getSession(bytes32 sessionId) private view returns (Session storage session) {
        session = _sessions[sessionId];
        if (session.policyVersion == 0) revert UnknownSession();
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBalance = usdt.balanceOf(address(this));
        usdt.safeTransferFrom(from, address(this), amount);
        if (usdt.balanceOf(address(this)) - beforeBalance != amount) revert InexactTransfer();
    }
}
