// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBNMTokenV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract ClaimVaultV2 is AccessControl, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MERCHANT_CREDITOR_ROLE = keccak256("MERCHANT_CREDITOR_ROLE");
    bytes32 public constant REWARD_CREDITOR_ROLE = keccak256("REWARD_CREDITOR_ROLE");
    bytes32 public constant PRIZE_CREDITOR_ROLE = keccak256("PRIZE_CREDITOR_ROLE");
    bytes32 public constant BNM_CREDITOR_ROLE = keccak256("BNM_CREDITOR_ROLE");
    bytes32 public constant MERCHANT_FREEZER_ROLE = keccak256("MERCHANT_FREEZER_ROLE");
    bytes32 public constant MERCHANT_ENCUMBER_ROLE = keccak256("MERCHANT_ENCUMBER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");
    bytes32 public constant CLAIM_TYPEHASH = keccak256("ClaimAuthorization(bytes32 claimHash)");

    IERC20 public immutable usdt;
    IERC20 public immutable npl;
    IBNMTokenV2 public immutable bnm;

    mapping(address merchant => uint256 amount) public merchantClaimable;
    mapping(address beneficiary => uint256 amount) public rewardClaimable;
    mapping(address winner => uint256 amount) public prizeClaimable;
    mapping(address beneficiary => uint256 amount) public bnmClaimable;
    mapping(address claimant => mapping(uint256 nonce => bool used)) public usedClaimNonce;
    mapping(address merchant => bool frozen) public merchantFrozen;

    uint256 public totalUsdtLiability;
    uint256 public totalNplLiability;
    uint256 public totalBnmLiability;
    bool public merchantClaimsPaused;
    bool public rewardClaimsPaused;
    bool public prizeClaimsPaused;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidAsset();
    error InvalidRail();
    error InvalidSignature();
    error ClaimExpired();
    error ClaimReplay();
    error ClaimPaused();
    error MerchantFrozen();
    error InsufficientClaimable();
    error InexactTransfer();
    error InvalidEvidence();
    error InsufficientSurplus();

    event ClaimCredited(
        bytes32 indexed resourceId, address indexed beneficiary, V2Types.ClaimRail indexed rail, uint256 amount
    );
    event Claimed(
        address indexed claimant, V2Types.ClaimRail indexed rail, address indexed asset, uint256 amount, uint256 nonce
    );
    event MerchantFreezeChanged(address indexed merchant, bool frozen, bytes32 indexed evidenceHash);
    event ClaimPauseChanged(V2Types.ClaimRail indexed rail, bool paused, bytes32 indexed evidenceHash);
    event MerchantEncumbered(address indexed merchant, address indexed recipient, uint256 amount);
    event SurplusRecovered(
        address indexed token, address indexed recipient, uint256 amount, bytes32 indexed incidentHash
    );

    constructor(address safe, IERC20 usdt_, IERC20 npl_, IBNMTokenV2 bnm_) EIP712("Abu24KClaimVault", "2") {
        if (
            safe == address(0) || address(usdt_) == address(0) || address(npl_) == address(0)
                || address(bnm_) == address(0) || address(usdt_) == address(npl_)
                || block.chainid != V2Types.BSC_CHAIN_ID || address(usdt_) != V2Types.USDT
                || address(npl_) != V2Types.NPL
        ) revert InvalidAddress();
        usdt = usdt_;
        npl = npl_;
        bnm = bnm_;
        _grantRole(DEFAULT_ADMIN_ROLE, safe);
        _grantRole(PAUSER_ROLE, safe);
        _grantRole(RECOVERY_ROLE, safe);
    }

    function depositMerchant(bytes32 orderId, address merchant, uint256 amount)
        external
        onlyRole(MERCHANT_CREDITOR_ROLE)
    {
        _pullExact(usdt, msg.sender, amount);
        merchantClaimable[merchant] += amount;
        totalUsdtLiability += amount;
        emit ClaimCredited(orderId, merchant, V2Types.ClaimRail.MerchantUsdt, amount);
    }

    function depositReward(bytes32 orderId, address beneficiary, uint256 amount)
        external
        onlyRole(REWARD_CREDITOR_ROLE)
    {
        _pullExact(npl, msg.sender, amount);
        rewardClaimable[beneficiary] += amount;
        totalNplLiability += amount;
        emit ClaimCredited(orderId, beneficiary, V2Types.ClaimRail.RewardNpl, amount);
    }

    function depositPrize(bytes32 sessionId, address winner, uint256 amount) external onlyRole(PRIZE_CREDITOR_ROLE) {
        _pullExact(usdt, msg.sender, amount);
        prizeClaimable[winner] += amount;
        totalUsdtLiability += amount;
        emit ClaimCredited(sessionId, winner, V2Types.ClaimRail.PrizeUsdt, amount);
    }

    function creditBnm(bytes32 orderId, address beneficiary, uint256 amount) external onlyRole(BNM_CREDITOR_ROLE) {
        if (beneficiary == address(0) || amount == 0) revert InvalidAmount();
        bnmClaimable[beneficiary] += amount;
        totalBnmLiability += amount;
        emit ClaimCredited(orderId, beneficiary, V2Types.ClaimRail.Bnm, amount);
    }

    function claim(V2Types.ClaimIntent calldata intent, bytes calldata claimantSignature) external nonReentrant {
        if (intent.claimant == address(0) || intent.amount == 0) revert InvalidAmount();
        if (block.timestamp > intent.deadline) revert ClaimExpired();
        if (usedClaimNonce[intent.claimant][intent.nonce]) revert ClaimReplay();
        if (merchantFrozen[intent.claimant] && intent.rail != V2Types.ClaimRail.PrizeUsdt) revert MerchantFrozen();

        bytes32 digest = hashClaim(intent);
        if (!SignatureChecker.isValidSignatureNowCalldata(intent.claimant, digest, claimantSignature)) {
            revert InvalidSignature();
        }
        usedClaimNonce[intent.claimant][intent.nonce] = true;
        _claim(intent);
        emit Claimed(intent.claimant, intent.rail, intent.asset, intent.amount, intent.nonce);
    }

    function hashClaim(V2Types.ClaimIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, keccak256(abi.encode(intent)))));
    }

    function encumberMerchant(address merchant, uint256 amount)
        external
        onlyRole(MERCHANT_ENCUMBER_ROLE)
        nonReentrant
        returns (uint256 encumbered)
    {
        uint256 available = merchantClaimable[merchant];
        encumbered = amount < available ? amount : available;
        if (encumbered == 0) return 0;
        merchantClaimable[merchant] = available - encumbered;
        totalUsdtLiability -= encumbered;
        usdt.safeTransfer(msg.sender, encumbered);
        emit MerchantEncumbered(merchant, msg.sender, encumbered);
    }

    function setMerchantFrozen(address merchant, bool frozen, bytes32 evidenceHash)
        external
        onlyRole(MERCHANT_FREEZER_ROLE)
    {
        if (merchant == address(0) || evidenceHash == bytes32(0)) revert InvalidEvidence();
        merchantFrozen[merchant] = frozen;
        emit MerchantFreezeChanged(merchant, frozen, evidenceHash);
    }

    function setClaimPause(V2Types.ClaimRail rail, bool paused, bytes32 evidenceHash) external onlyRole(PAUSER_ROLE) {
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        if (rail == V2Types.ClaimRail.MerchantUsdt) merchantClaimsPaused = paused;
        else if (rail == V2Types.ClaimRail.PrizeUsdt) prizeClaimsPaused = paused;
        else if (rail == V2Types.ClaimRail.RewardNpl || rail == V2Types.ClaimRail.Bnm) rewardClaimsPaused = paused;
        else revert InvalidRail();
        emit ClaimPauseChanged(rail, paused, evidenceHash);
    }

    function recoverSurplus(address token, address recipient, uint256 amount, bytes32 incidentHash)
        external
        onlyRole(RECOVERY_ROLE)
        nonReentrant
    {
        if (recipient == address(0) || incidentHash == bytes32(0)) revert InvalidEvidence();
        IERC20 asset = IERC20(token);
        uint256 protectedAmount;
        if (token == address(usdt)) protectedAmount = totalUsdtLiability;
        else if (token == address(npl)) protectedAmount = totalNplLiability;
        uint256 balance = asset.balanceOf(address(this));
        if (balance < protectedAmount || amount > balance - protectedAmount) revert InsufficientSurplus();
        asset.safeTransfer(recipient, amount);
        emit SurplusRecovered(token, recipient, amount, incidentHash);
    }

    function _claim(V2Types.ClaimIntent calldata intent) private {
        if (intent.rail == V2Types.ClaimRail.MerchantUsdt) {
            if (merchantClaimsPaused) revert ClaimPaused();
            if (intent.asset != address(usdt)) revert InvalidAsset();
            _debit(merchantClaimable, intent.claimant, intent.amount);
            totalUsdtLiability -= intent.amount;
            usdt.safeTransfer(intent.claimant, intent.amount);
        } else if (intent.rail == V2Types.ClaimRail.RewardNpl) {
            if (rewardClaimsPaused) revert ClaimPaused();
            if (intent.asset != address(npl)) revert InvalidAsset();
            _debit(rewardClaimable, intent.claimant, intent.amount);
            totalNplLiability -= intent.amount;
            npl.safeTransfer(intent.claimant, intent.amount);
        } else if (intent.rail == V2Types.ClaimRail.PrizeUsdt) {
            if (prizeClaimsPaused) revert ClaimPaused();
            if (intent.asset != address(usdt)) revert InvalidAsset();
            _debit(prizeClaimable, intent.claimant, intent.amount);
            totalUsdtLiability -= intent.amount;
            usdt.safeTransfer(intent.claimant, intent.amount);
        } else if (intent.rail == V2Types.ClaimRail.Bnm) {
            if (rewardClaimsPaused) revert ClaimPaused();
            if (intent.asset != address(bnm)) revert InvalidAsset();
            _debit(bnmClaimable, intent.claimant, intent.amount);
            totalBnmLiability -= intent.amount;
            bnm.mint(intent.claimant, intent.amount);
        } else {
            revert InvalidRail();
        }
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        if (from == address(0) || amount == 0) revert InvalidAmount();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert InexactTransfer();
    }

    function _debit(mapping(address => uint256) storage balances, address account, uint256 amount) private {
        uint256 available = balances[account];
        if (amount > available) revert InsufficientClaimable();
        balances[account] = available - amount;
    }
}
