// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IClaimVaultV2, IPolicyRegistryV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract MerchantGuaranteeVaultV2 is AccessControl, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant TAKEOVER_ROLE = keccak256("TAKEOVER_ROLE");
    bytes32 public constant TAKEOVER_DISBURSER_ROLE = keccak256("TAKEOVER_DISBURSER_ROLE");
    bytes32 public constant ORDER_RESERVER_ROLE = keccak256("ORDER_RESERVER_ROLE");
    bytes32 public constant TAKEOVER_CLOSER_ROLE = keccak256("TAKEOVER_CLOSER_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");
    bytes32 public constant TAKEOVER_DISBURSEMENT_TYPEHASH = keccak256(
        "TakeoverDisbursement(bytes32 orderId,uint64 policyVersion,address merchant,address recipient,uint256 amount,uint256 previousDisbursed,uint256 nextDisbursed,bytes32 evidenceHash,uint256 nonce,uint64 deadline)"
    );

    struct OrderCoverage {
        address merchant;
        uint64 policyVersion;
        uint256 requiredAmount;
        uint256 guaranteeReserved;
        uint256 riskReserveReserved;
        bool releasedOrConsumed;
    }

    struct TakeoverFunding {
        address merchant;
        uint64 policyVersion;
        uint256 requiredAmount;
        uint256 guaranteeUsed;
        uint256 merchantAvailableUsed;
        uint256 riskReserveUsed;
        uint256 disbursed;
        uint256 guaranteeDisbursed;
        uint256 merchantAvailableDisbursed;
        uint256 riskReserveDisbursed;
        bool closed;
    }

    IERC20 public immutable usdt;
    IPolicyRegistryV2 public immutable policyRegistry;
    IClaimVaultV2 public immutable claimVault;

    mapping(address merchant => uint256 amount) public guaranteeBalance;
    mapping(address merchant => uint256 amount) public merchantDebt;
    mapping(address merchant => uint256 amount) public reservedGuarantee;
    mapping(bytes32 orderId => OrderCoverage coverage) public orderCoverage;
    mapping(bytes32 orderId => TakeoverFunding funding) public takeoverFunding;
    mapping(uint256 nonce => bool used) public usedDisbursementNonce;
    uint256 public totalGuarantees;
    uint256 public riskReserveBalance;
    uint256 public reservedRiskReserve;
    uint256 public totalTakeoverLocked;

    error InvalidAddress();
    error InvalidAmount();
    error InexactTransfer();
    error TakeoverExists();
    error CoverageExists();
    error UnknownCoverage();
    error InsufficientTakeoverFunding();
    error UnknownTakeover();
    error DisbursementExceeded();
    error DisbursementReplay();
    error DisbursementExpired();
    error InvalidSignature();
    error SafeExecutionRequired();
    error InvalidEvidence();
    error InsufficientSurplus();

    event GuaranteeDeposited(address indexed merchant, address indexed payer, uint256 amount);
    event RiskReserveDeposited(address indexed payer, uint256 amount);
    event OrderCoverageReserved(
        bytes32 indexed orderId, address indexed merchant, uint256 guaranteeReserved, uint256 riskReserveReserved
    );
    event OrderCoverageReleased(bytes32 indexed orderId, address indexed merchant);
    event TakeoverFunded(
        bytes32 indexed orderId,
        address indexed merchant,
        uint256 guaranteeUsed,
        uint256 merchantAvailableUsed,
        uint256 riskReserveUsed
    );
    event TakeoverDisbursed(
        bytes32 indexed orderId,
        uint64 indexed policyVersion,
        address indexed recipient,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 nonce
    );
    event TakeoverClosed(
        bytes32 indexed orderId,
        uint256 guaranteeRestored,
        uint256 merchantAvailableRestored,
        uint256 riskReserveRestored,
        bytes32 indexed evidenceHash
    );
    event MerchantDebtRepaid(address indexed merchant, address indexed payer, uint256 amount);
    event SurplusRecovered(address indexed recipient, uint256 amount, bytes32 indexed incidentHash);

    constructor(address safe, IERC20 usdt_, IPolicyRegistryV2 policyRegistry_, IClaimVaultV2 claimVault_)
        EIP712("Abu24KMerchantGuaranteeVault", "2")
    {
        if (
            safe == address(0) || address(usdt_) == address(0) || address(policyRegistry_) == address(0)
                || address(claimVault_) == address(0) || block.chainid != V2Types.BSC_CHAIN_ID
                || address(usdt_) != V2Types.USDT
        ) revert InvalidAddress();
        usdt = usdt_;
        policyRegistry = policyRegistry_;
        claimVault = claimVault_;
        usdt_.forceApprove(address(claimVault_), type(uint256).max);
        _grantRole(DEFAULT_ADMIN_ROLE, safe);
        _grantRole(TAKEOVER_DISBURSER_ROLE, safe);
        _grantRole(RECOVERY_ROLE, safe);
    }

    function depositGuarantee(address merchant, uint256 amount) external nonReentrant {
        if (merchant == address(0) || amount == 0) revert InvalidAmount();
        _pullExact(msg.sender, amount);
        guaranteeBalance[merchant] += amount;
        totalGuarantees += amount;
        emit GuaranteeDeposited(merchant, msg.sender, amount);
    }

    function depositRiskReserve(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        _pullExact(msg.sender, amount);
        riskReserveBalance += amount;
        emit RiskReserveDeposited(msg.sender, amount);
    }

    function canAcceptOrder(address merchant, uint64 policyVersion) external view returns (bool) {
        V2Types.Policy memory policy = policyRegistry.getPolicy(policyVersion);
        return guaranteeBalance[merchant] >= policy.merchantGuaranteeMinimum
            && riskReserveBalance >= policy.platformRiskReserveMinimum;
    }

    function reserveOrderCoverage(bytes32 orderId, uint64 policyVersion, address merchant, uint256 requiredAmount)
        external
        onlyRole(ORDER_RESERVER_ROLE)
    {
        if (orderId == bytes32(0) || merchant == address(0) || requiredAmount == 0) revert InvalidAmount();
        if (orderCoverage[orderId].merchant != address(0)) revert CoverageExists();
        policyRegistry.getPolicy(policyVersion);
        uint256 freeGuarantee = guaranteeBalance[merchant] - reservedGuarantee[merchant];
        uint256 guaranteeAmount = requiredAmount < freeGuarantee ? requiredAmount : freeGuarantee;
        uint256 reserveAmount = requiredAmount - guaranteeAmount;
        uint256 freeRiskReserve = riskReserveBalance - reservedRiskReserve;
        if (reserveAmount > freeRiskReserve) revert InsufficientTakeoverFunding();
        reservedGuarantee[merchant] += guaranteeAmount;
        reservedRiskReserve += reserveAmount;
        orderCoverage[orderId] = OrderCoverage({
            merchant: merchant,
            policyVersion: policyVersion,
            requiredAmount: requiredAmount,
            guaranteeReserved: guaranteeAmount,
            riskReserveReserved: reserveAmount,
            releasedOrConsumed: false
        });
        emit OrderCoverageReserved(orderId, merchant, guaranteeAmount, reserveAmount);
    }

    function releaseOrderCoverage(bytes32 orderId) external onlyRole(TAKEOVER_CLOSER_ROLE) {
        OrderCoverage storage coverage = orderCoverage[orderId];
        if (coverage.merchant == address(0) || coverage.releasedOrConsumed) revert UnknownCoverage();
        coverage.releasedOrConsumed = true;
        reservedGuarantee[coverage.merchant] -= coverage.guaranteeReserved;
        reservedRiskReserve -= coverage.riskReserveReserved;
        emit OrderCoverageReleased(orderId, coverage.merchant);
    }

    function beginTakeover(bytes32 orderId, address merchant, uint256 requiredAmount)
        external
        onlyRole(TAKEOVER_ROLE)
        nonReentrant
        returns (uint256 guaranteeUsed, uint256 merchantAvailableUsed, uint256 reserveUsed)
    {
        if (orderId == bytes32(0) || merchant == address(0) || requiredAmount == 0) revert InvalidAmount();
        if (takeoverFunding[orderId].merchant != address(0)) revert TakeoverExists();
        OrderCoverage storage coverage = orderCoverage[orderId];
        if (coverage.merchant != merchant || coverage.requiredAmount != requiredAmount || coverage.releasedOrConsumed) {
            revert UnknownCoverage();
        }
        coverage.releasedOrConsumed = true;
        reservedGuarantee[merchant] -= coverage.guaranteeReserved;
        reservedRiskReserve -= coverage.riskReserveReserved;

        uint256 freeGuarantee = guaranteeBalance[merchant] - reservedGuarantee[merchant];
        guaranteeUsed = requiredAmount < freeGuarantee ? requiredAmount : freeGuarantee;
        uint256 remaining = requiredAmount - guaranteeUsed;
        if (remaining != 0) merchantAvailableUsed = claimVault.encumberMerchant(merchant, remaining);
        remaining -= merchantAvailableUsed;
        if (remaining > riskReserveBalance - reservedRiskReserve) revert InsufficientTakeoverFunding();
        reserveUsed = remaining;

        guaranteeBalance[merchant] -= guaranteeUsed;
        totalGuarantees -= guaranteeUsed;
        riskReserveBalance -= reserveUsed;
        totalTakeoverLocked += requiredAmount;
        takeoverFunding[orderId] = TakeoverFunding({
            merchant: merchant,
            policyVersion: coverage.policyVersion,
            requiredAmount: requiredAmount,
            guaranteeUsed: guaranteeUsed,
            merchantAvailableUsed: merchantAvailableUsed,
            riskReserveUsed: reserveUsed,
            disbursed: 0,
            guaranteeDisbursed: 0,
            merchantAvailableDisbursed: 0,
            riskReserveDisbursed: 0,
            closed: false
        });

        emit TakeoverFunded(orderId, merchant, guaranteeUsed, merchantAvailableUsed, reserveUsed);
    }

    function disburseTakeover(
        bytes32 orderId,
        address recipient,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 nonce,
        uint64 deadline,
        bytes calldata secondarySignature
    ) external onlyRole(TAKEOVER_DISBURSER_ROLE) nonReentrant {
        TakeoverFunding storage funding = takeoverFunding[orderId];
        if (funding.merchant == address(0)) revert UnknownTakeover();
        if (funding.closed) revert UnknownTakeover();
        if (msg.sender != policyRegistry.safe()) revert SafeExecutionRequired();
        if (block.timestamp > deadline) revert DisbursementExpired();
        if (usedDisbursementNonce[nonce]) revert DisbursementReplay();
        if (recipient == address(0) || amount == 0 || evidenceHash == bytes32(0)) revert InvalidEvidence();
        if (amount > funding.requiredAmount - funding.disbursed) revert DisbursementExceeded();
        bytes32 digest = hashTakeoverDisbursement(orderId, recipient, amount, evidenceHash, nonce, deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(policyRegistry.secondarySigner(), digest, secondarySignature))
        {
            revert InvalidSignature();
        }
        usedDisbursementNonce[nonce] = true;
        uint256 previousDisbursed = funding.disbursed;
        uint256 nextDisbursed = previousDisbursed + amount;
        funding.guaranteeDisbursed += _spentThrough(nextDisbursed, funding.guaranteeUsed)
        - _spentThrough(previousDisbursed, funding.guaranteeUsed);
        uint256 merchantAvailableEnd = funding.guaranteeUsed + funding.merchantAvailableUsed;
        funding.merchantAvailableDisbursed += _spentBetween(nextDisbursed, funding.guaranteeUsed, merchantAvailableEnd)
        - _spentBetween(previousDisbursed, funding.guaranteeUsed, merchantAvailableEnd);
        uint256 reserveDelta = _spentBetween(nextDisbursed, merchantAvailableEnd, funding.requiredAmount)
            - _spentBetween(previousDisbursed, merchantAvailableEnd, funding.requiredAmount);
        funding.riskReserveDisbursed += reserveDelta;
        merchantDebt[funding.merchant] += reserveDelta;
        funding.disbursed = nextDisbursed;
        totalTakeoverLocked -= amount;
        usdt.safeTransfer(recipient, amount);
        emit TakeoverDisbursed(orderId, funding.policyVersion, recipient, amount, evidenceHash, nonce);
    }

    function hashTakeoverDisbursement(
        bytes32 orderId,
        address recipient,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 nonce,
        uint64 deadline
    ) public view returns (bytes32) {
        TakeoverFunding storage funding = takeoverFunding[orderId];
        if (funding.merchant == address(0) || funding.closed) revert UnknownTakeover();
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TAKEOVER_DISBURSEMENT_TYPEHASH,
                    orderId,
                    funding.policyVersion,
                    funding.merchant,
                    recipient,
                    amount,
                    funding.disbursed,
                    funding.disbursed + amount,
                    evidenceHash,
                    nonce,
                    deadline
                )
            )
        );
    }

    function closeTakeover(bytes32 orderId, bytes32 evidenceHash) external onlyRole(TAKEOVER_CLOSER_ROLE) nonReentrant {
        TakeoverFunding storage funding = takeoverFunding[orderId];
        if (funding.merchant == address(0) || funding.closed) revert UnknownTakeover();
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        funding.closed = true;
        uint256 guaranteeRestored = funding.guaranteeUsed - funding.guaranteeDisbursed;
        uint256 availableRestored = funding.merchantAvailableUsed - funding.merchantAvailableDisbursed;
        uint256 reserveRestored = funding.riskReserveUsed - funding.riskReserveDisbursed;
        uint256 remaining = funding.requiredAmount - funding.disbursed;
        totalTakeoverLocked -= remaining;
        guaranteeBalance[funding.merchant] += guaranteeRestored;
        totalGuarantees += guaranteeRestored;
        riskReserveBalance += reserveRestored;
        if (availableRestored != 0) {
            claimVault.depositMerchant(orderId, funding.merchant, availableRestored);
        }
        emit TakeoverClosed(orderId, guaranteeRestored, availableRestored, reserveRestored, evidenceHash);
    }

    function repayDebt(address merchant, uint256 amount) external nonReentrant {
        if (merchant == address(0) || amount == 0 || amount > merchantDebt[merchant]) revert InvalidAmount();
        _pullExact(msg.sender, amount);
        merchantDebt[merchant] -= amount;
        riskReserveBalance += amount;
        emit MerchantDebtRepaid(merchant, msg.sender, amount);
    }

    function recoverSurplus(address recipient, uint256 amount, bytes32 incidentHash)
        external
        onlyRole(RECOVERY_ROLE)
        nonReentrant
    {
        if (recipient == address(0) || incidentHash == bytes32(0)) revert InvalidEvidence();
        uint256 protectedAmount = totalGuarantees + riskReserveBalance + totalTakeoverLocked;
        uint256 balance = usdt.balanceOf(address(this));
        if (balance < protectedAmount || amount > balance - protectedAmount) revert InsufficientSurplus();
        usdt.safeTransfer(recipient, amount);
        emit SurplusRecovered(recipient, amount, incidentHash);
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBalance = usdt.balanceOf(address(this));
        usdt.safeTransferFrom(from, address(this), amount);
        if (usdt.balanceOf(address(this)) - beforeBalance != amount) revert InexactTransfer();
    }

    function _spentThrough(uint256 value, uint256 end) private pure returns (uint256) {
        return value < end ? value : end;
    }

    function _spentBetween(uint256 value, uint256 start, uint256 end) private pure returns (uint256) {
        if (value <= start) return 0;
        uint256 capped = value < end ? value : end;
        return capped - start;
    }
}
