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
    function validateQuote(bytes32 oracleVersion, uint256 usdtListPrice, uint256 signedNplQuoteAmount)
        external
        view
        returns (uint256 twapNplAmount);
}

interface ITwapSourceV2 {
    function pair() external view returns (address);

    function consult(address pair_, address baseToken, address quoteToken, uint256 baseAmount, uint32 window)
        external
        view
        returns (uint256 quoteAmount, uint128 usdtLiquidity, uint64 updatedAt);
}
