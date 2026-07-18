// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V2Types} from "../types/V2Types.sol";

interface IPolicyRegistryV2 {
    function governanceWallet() external view returns (address);
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
