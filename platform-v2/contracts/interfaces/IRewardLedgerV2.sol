// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IRewardLedgerV2 {
    struct Credit {
        address beneficiary;
        address asset;
        uint256 amount;
        uint8 role;
    }

    function bnm() external view returns (address);
    function lockBnm(bytes32 orderId, address beneficiary, uint256 amount) external returns (bytes32 rewardId);
    function releaseBnm(bytes32 orderId) external;
    function burnBnm(bytes32 orderId) external;
    function creditAvailableBatch(bytes32 sourceId, Credit[] calldata credits) external returns (bytes32[] memory rewardIds);
}
