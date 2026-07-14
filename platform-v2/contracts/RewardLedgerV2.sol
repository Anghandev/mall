// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IClaimVaultV2, IPolicyRegistryV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract RewardLedgerV2 is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAYMENT_LOCKER_ROLE = keccak256("PAYMENT_LOCKER_ROLE");
    bytes32 public constant FULFILLMENT_RELEASER_ROLE = keccak256("FULFILLMENT_RELEASER_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");

    struct OrderReward {
        uint64 policyVersion;
        uint256 routeAmount;
        uint256 rewardBaseNpl;
        V2Types.BeneficiarySnapshot beneficiaries;
        bool released;
    }

    IERC20 public immutable npl;
    IPolicyRegistryV2 public immutable policyRegistry;
    IClaimVaultV2 public immutable claimVault;
    uint256 public totalLockedNpl;
    mapping(bytes32 orderId => OrderReward reward) private _orderRewards;

    error InvalidAddress();
    error InvalidAmount();
    error OrderExists();
    error UnknownOrder();
    error AlreadyReleased();
    error AllocationExceedsRoute();
    error InexactTransfer();
    error InvalidEvidence();
    error InsufficientSurplus();

    event OrderRewardsLocked(
        bytes32 indexed orderId,
        uint64 indexed policyVersion,
        uint256 routeAmount,
        uint256 rewardBaseNpl,
        bytes32 snapshotHash
    );
    event RewardAvailable(
        bytes32 indexed orderId, address indexed beneficiary, bytes32 indexed rewardKind, uint256 amount
    );
    event OrderRewardsReleased(bytes32 indexed orderId, uint256 claimsAmount, uint256 circulationAmount);
    event SurplusRecovered(address indexed recipient, uint256 amount, bytes32 indexed incidentHash);

    constructor(address safe, IERC20 npl_, IPolicyRegistryV2 policyRegistry_, IClaimVaultV2 claimVault_) {
        if (
            safe == address(0) || address(npl_) == address(0) || address(policyRegistry_) == address(0)
                || address(claimVault_) == address(0) || block.chainid != V2Types.BSC_CHAIN_ID
                || address(npl_) != V2Types.NPL
        ) revert InvalidAddress();
        npl = npl_;
        policyRegistry = policyRegistry_;
        claimVault = claimVault_;
        npl_.forceApprove(address(claimVault_), type(uint256).max);
        _grantRole(DEFAULT_ADMIN_ROLE, safe);
        _grantRole(RECOVERY_ROLE, safe);
    }

    function lockOrder(
        bytes32 orderId,
        uint64 policyVersion,
        uint256 routeAmount,
        uint256 rewardBaseNpl,
        V2Types.BeneficiarySnapshot calldata beneficiaries
    ) external onlyRole(PAYMENT_LOCKER_ROLE) nonReentrant {
        if (orderId == bytes32(0) || _orderRewards[orderId].policyVersion != 0) revert OrderExists();
        if ((routeAmount == 0) != (rewardBaseNpl == 0)) revert InvalidAmount();
        policyRegistry.getPolicy(policyVersion);
        if (routeAmount != 0) _pullExact(msg.sender, routeAmount);
        _orderRewards[orderId] = OrderReward(policyVersion, routeAmount, rewardBaseNpl, beneficiaries, false);
        totalLockedNpl += routeAmount;
        emit OrderRewardsLocked(
            orderId, policyVersion, routeAmount, rewardBaseNpl, keccak256(abi.encode(beneficiaries))
        );
    }

    function releaseOrder(bytes32 orderId) external onlyRole(FULFILLMENT_RELEASER_ROLE) nonReentrant {
        OrderReward storage reward = _orderRewards[orderId];
        if (reward.policyVersion == 0) revert UnknownOrder();
        if (reward.released) revert AlreadyReleased();
        reward.released = true;
        totalLockedNpl -= reward.routeAmount;

        V2Types.Policy memory policy = policyRegistry.getPolicy(reward.policyVersion);
        uint256 claimsAmount;
        claimsAmount += _credit(
            orderId, reward.beneficiaries.genesis, "GENESIS", reward.rewardBaseNpl, policy.genesisBps
        );
        claimsAmount += _credit(
            orderId,
            reward.beneficiaries.directReferral,
            "DIRECT_REFERRAL",
            reward.rewardBaseNpl,
            policy.directReferralBps
        );
        claimsAmount += _credit(
            orderId, reward.beneficiaries.district, "DISTRICT", reward.rewardBaseNpl, policy.districtBps
        );
        claimsAmount += _credit(orderId, reward.beneficiaries.city, "CITY", reward.rewardBaseNpl, policy.cityBps);
        claimsAmount += _credit(
            orderId, reward.beneficiaries.province, "PROVINCE", reward.rewardBaseNpl, policy.provinceBps
        );
        claimsAmount += _credit(orderId, reward.beneficiaries.region, "REGION", reward.rewardBaseNpl, policy.regionBps);
        claimsAmount += _credit(
            orderId, reward.beneficiaries.merchantStore, "MERCHANT_STORE", reward.rewardBaseNpl, policy.merchantStoreBps
        );
        claimsAmount += _creditOperations(orderId, reward.policyVersion, reward.rewardBaseNpl, policy.operationsBps);
        if (claimsAmount > reward.routeAmount) revert AllocationExceedsRoute();

        uint256 circulationAmount = reward.routeAmount - claimsAmount;
        if (circulationAmount != 0) npl.safeTransfer(policy.circulationPool, circulationAmount);
        emit OrderRewardsReleased(orderId, claimsAmount, circulationAmount);
    }

    function getOrderReward(bytes32 orderId) external view returns (OrderReward memory) {
        return _orderRewards[orderId];
    }

    function recoverSurplus(address recipient, uint256 amount, bytes32 incidentHash)
        external
        onlyRole(RECOVERY_ROLE)
        nonReentrant
    {
        if (recipient == address(0) || incidentHash == bytes32(0)) revert InvalidEvidence();
        uint256 balance = npl.balanceOf(address(this));
        if (balance < totalLockedNpl || amount > balance - totalLockedNpl) revert InsufficientSurplus();
        npl.safeTransfer(recipient, amount);
        emit SurplusRecovered(recipient, amount, incidentHash);
    }

    function _credit(bytes32 orderId, address beneficiary, bytes32 kind, uint256 base, uint16 bps)
        private
        returns (uint256 amount)
    {
        if (beneficiary == address(0) || bps == 0) return 0;
        amount = Math.mulDiv(base, bps, V2Types.BPS);
        if (amount == 0) return 0;
        claimVault.depositReward(orderId, beneficiary, amount);
        emit RewardAvailable(orderId, beneficiary, kind, amount);
    }

    function _creditOperations(bytes32 orderId, uint64 policyVersion, uint256 base, uint16 bps)
        private
        returns (uint256 credited)
    {
        if (bps == 0) return 0;
        uint256 operationsAmount = Math.mulDiv(base, bps, V2Types.BPS);
        (address[] memory accounts, uint16[] memory weights) = policyRegistry.getOperations(policyVersion);
        for (uint256 i; i < accounts.length; ++i) {
            uint256 amount = Math.mulDiv(operationsAmount, weights[i], V2Types.BPS);
            if (amount == 0) continue;
            claimVault.depositReward(orderId, accounts[i], amount);
            credited += amount;
            emit RewardAvailable(orderId, accounts[i], "OPERATIONS", amount);
        }
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBalance = npl.balanceOf(address(this));
        npl.safeTransferFrom(from, address(this), amount);
        if (npl.balanceOf(address(this)) - beforeBalance != amount) revert InexactTransfer();
    }
}
