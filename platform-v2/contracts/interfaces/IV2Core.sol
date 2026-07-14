// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V2Types} from "../types/V2Types.sol";

interface IPolicyRegistryV2 {
    function safe() external view returns (address);
    function secondarySigner() external view returns (address);
    function latestVersion() external view returns (uint64);
    function getPolicy(uint64 version) external view returns (V2Types.Policy memory);
    function getOperations(uint64 version) external view returns (address[] memory accounts, uint16[] memory weights);
}

interface IBeneficiaryRegistryV2 {
    function validateSnapshot(
        uint64 policyVersion,
        address buyer,
        address merchant,
        bytes32 regionCodeHash,
        V2Types.BeneficiarySnapshot calldata snapshot
    ) external view;
}

interface ITwapOracleV2 {
    function validateQuote(
        bytes32 oracleVersion,
        uint256 usdtAmount,
        uint256 signedNplAmount,
        uint64 maxAge,
        uint128 minimumLiquidity
    ) external view returns (uint256 twapNplAmount);
}

interface IClaimVaultV2 {
    function depositMerchant(bytes32 orderId, address merchant, uint256 amount) external;
    function depositReward(bytes32 orderId, address beneficiary, uint256 amount) external;
    function depositPrize(bytes32 sessionId, address winner, uint256 amount) external;
    function creditBnm(bytes32 orderId, address beneficiary, uint256 amount) external;
    function encumberMerchant(address merchant, uint256 amount) external returns (uint256 encumbered);
    function setMerchantFrozen(address merchant, bool frozen, bytes32 evidenceHash) external;
    function merchantFrozen(address merchant) external view returns (bool);
}

interface IBNMTokenV2 {
    function mint(address account, uint256 amount) external;
}

interface IRewardLedgerV2 {
    function lockOrder(
        bytes32 orderId,
        uint64 policyVersion,
        uint256 routeAmount,
        uint256 rewardBaseNpl,
        V2Types.BeneficiarySnapshot calldata beneficiaries
    ) external;
    function releaseOrder(bytes32 orderId) external;
}

interface IMerchantGuaranteeVaultV2 {
    function canAcceptOrder(address merchant, uint64 policyVersion) external view returns (bool);
    function merchantDebt(address merchant) external view returns (uint256);
    function reserveOrderCoverage(bytes32 orderId, uint64 policyVersion, address merchant, uint256 requiredAmount)
        external;
    function releaseOrderCoverage(bytes32 orderId) external;
    function beginTakeover(bytes32 orderId, address merchant, uint256 requiredAmount)
        external
        returns (uint256 guaranteeUsed, uint256 availableUsed, uint256 reserveUsed);
    function closeTakeover(bytes32 orderId, bytes32 evidenceHash) external;
}

interface IPaymentEscrowV2 {
    function executeSeckillOrder(V2Types.OrderIntent calldata intent) external returns (uint256 prizeContribution);
}

interface ITwapSourceV2 {
    function consult(address baseToken, address quoteToken, uint256 baseAmount, uint32 window)
        external
        view
        returns (uint256 quoteAmount, uint128 liquidity, uint64 updatedAt);
}
