// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {PolicyRegistryV2} from "../contracts/PolicyRegistryV2.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract PolicyRegistryV2Test is CoreFixture {
    function testLaunchPolicyFreezesPaymentOracleSafesAndRewards() public view {
        V2Types.Policy memory policy = policyRegistry.getPolicy(1);
        assertEq(policy.usdtPaymentBps, 7_000);
        assertEq(policy.nplPaymentBps, 3_000);
        assertEq(policy.nplBurnListPriceBps, 2_000);
        assertEq(policy.nplRewardListPriceBps, 1_000);
        assertEq(policy.oracleMaxAge, 10 minutes);
        assertEq(policy.oracleMinLiquidity, 50_000 ether);
        assertEq(policy.merchantGuaranteeMinimum, 1_000 ether);
        assertEq(policy.usdtCustodySafe, usdtCustodySafe);
        assertEq(policy.nplRewardSafe, nplRewardSafe);
        assertEq(policy.operationsTreasurySafe, operationsTreasurySafe);
        assertEq(
            uint256(policy.genesisBps) + policy.directReferralBps + policy.districtBps + policy.cityBps
                + policy.provinceBps + policy.regionBps + policy.operationsBps,
            1_000
        );
    }

    function testPolicyPublicationRequiresActualSafeAndSecondarySignature() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 2, deadline);

        vm.expectRevert();
        policyRegistry.publishPolicy(policy, accounts, weights, 2, deadline, _sign(SECONDARY_KEY, digest));

        vm.prank(safe);
        vm.expectRevert(PolicyRegistryV2.InvalidSecondarySignature.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 2, deadline, _sign(QUOTE_KEY, digest));

        vm.prank(safe);
        policyRegistry.publishPolicy(policy, accounts, weights, 2, deadline, _sign(SECONDARY_KEY, digest));
        assertEq(policyRegistry.latestVersion(), 2);
    }

    function testFuturePolicyCanAdjustBurnRouteAndRewardSharesForFutureQuotes() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        policy.nplBurnListPriceBps = 1_800;
        policy.nplRewardListPriceBps = 1_200;
        policy.operationsBps = 600;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 7, deadline);

        vm.prank(safe);
        policyRegistry.publishPolicy(policy, accounts, weights, 7, deadline, _sign(SECONDARY_KEY, digest));

        V2Types.Policy memory published = policyRegistry.getPolicy(2);
        assertEq(published.nplBurnListPriceBps, 1_800);
        assertEq(published.nplRewardListPriceBps, 1_200);
        assertEq(published.operationsBps, 600);
    }

    function testPolicyRejectsBuyerLegOrOracleSafetyDrift() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        policy.usdtPaymentBps = 6_999;
        policy.nplPaymentBps = 3_001;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 3, deadline);
        vm.prank(safe);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 3, deadline, _sign(SECONDARY_KEY, digest));

        (policy, accounts, weights) = _secondPolicy();
        policy.oracleMaxAge = 11 minutes;
        digest = policyRegistry.hashPublication(policy, accounts, weights, 4, deadline);
        vm.prank(safe);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 4, deadline, _sign(SECONDARY_KEY, digest));
    }

    function testPolicyRejectsIncompleteRewardAllocationAndDuplicateSafes() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        policy.operationsBps = 399;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 5, deadline);
        vm.prank(safe);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 5, deadline, _sign(SECONDARY_KEY, digest));

        (policy, accounts, weights) = _secondPolicy();
        policy.nplRewardSafe = policy.usdtCustodySafe;
        digest = policyRegistry.hashPublication(policy, accounts, weights, 6, deadline);
        vm.prank(safe);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 6, deadline, _sign(SECONDARY_KEY, digest));
    }

    function _secondPolicy()
        private
        view
        returns (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights)
    {
        policy = policyRegistry.getPolicy(1);
        policy.version = 2;
        policy.decisionEvidenceHash = keccak256("policy-2-evidence");
        accounts = new address[](2);
        accounts[0] = operationsOne;
        accounts[1] = operationsTwo;
        weights = new uint16[](2);
        weights[0] = 6_000;
        weights[1] = 4_000;
    }
}
