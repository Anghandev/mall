// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {PolicyRegistryV2} from "../contracts/PolicyRegistryV2.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract PolicyRegistryV2Test is CoreFixture {
    function testLaunchPolicyIsFrozenAndOperationsAreVersioned() public view {
        V2Types.Policy memory policy = policyRegistry.getPolicy(1);
        assertEq(policy.version, 1);
        assertEq(policy.burnBps, 2_000);
        assertEq(policy.routeBps, 8_000);
        assertEq(policy.seckillMainDuration, 60 minutes);
        assertEq(policy.relayInitial, 60 seconds);
        assertEq(policy.relayIncrement, 30 seconds);
        assertEq(policy.relayCap, 60 seconds);

        (address[] memory accounts, uint16[] memory weights) = policyRegistry.getOperations(1);
        assertEq(accounts.length, 2);
        assertEq(accounts[0], operationsOne);
        assertEq(accounts[1], operationsTwo);
        assertEq(weights[0], 6_000);
        assertEq(weights[1], 4_000);
    }

    function testPolicyPublicationRequiresSafeAndSecondarySignature() public {
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
        assertEq(policyRegistry.getPolicy(1).burnBps, 2_000);
        assertEq(policyRegistry.getPolicy(2).burnBps, 2_500);
    }

    function testPolicyPublicationRequiresRulesContentHash() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        policy.rulesContentHash = bytes32(0);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 3, deadline);
        vm.prank(safe);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 3, deadline, _sign(SECONDARY_KEY, digest));
    }

    function testOperationsAccountLimitKeepsWorstCaseFulfillmentBounded() public {
        V2Types.Policy memory policy = policyRegistry.getPolicy(1);
        policy.version = 2;
        policy.decisionEvidenceHash = keccak256("max-operations-policy");
        (address[] memory accounts, uint16[] memory weights) = _operations(32);
        policy.beneficiarySetHash = keccak256(abi.encode(accounts, weights));
        uint64 deadline = type(uint64).max;
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 4, deadline);
        vm.prank(safe);
        policyRegistry.publishPolicy(policy, accounts, weights, 4, deadline, _sign(SECONDARY_KEY, digest));

        V2Types.OrderIntent memory intent = _makeOrder(keccak256("max-operations-order"), buyer, 401, false);
        intent.policyVersion = 2;
        _payOrder(intent, BUYER_KEY);
        uint256 gasBefore = gasleft();
        _fulfillByCustomer(intent.orderId, 401);
        uint256 fulfillmentGas = gasBefore - gasleft();
        assertTrue(fulfillmentGas < 10_000_000);
        assertEq(rewardLedger.totalLockedNpl(), 0);
    }

    function testPolicyRejectsOperationsAccountListAboveLimit() public {
        V2Types.Policy memory policy = policyRegistry.getPolicy(1);
        policy.version = 2;
        policy.decisionEvidenceHash = keccak256("too-many-operations-policy");
        (address[] memory accounts, uint16[] memory weights) = _operations(33);
        policy.beneficiarySetHash = keccak256(abi.encode(accounts, weights));
        uint64 deadline = type(uint64).max;
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 5, deadline);
        vm.prank(safe);
        vm.expectRevert(PolicyRegistryV2.InvalidOperations.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 5, deadline, _sign(SECONDARY_KEY, digest));
    }

    function _secondPolicy()
        private
        view
        returns (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights)
    {
        policy = policyRegistry.getPolicy(1);
        policy.version = 2;
        policy.burnBps = 2_500;
        policy.routeBps = 7_500;
        policy.decisionEvidenceHash = keccak256("policy-2-evidence");
        accounts = new address[](2);
        accounts[0] = operationsOne;
        accounts[1] = operationsTwo;
        weights = new uint16[](2);
        weights[0] = 6_000;
        weights[1] = 4_000;
    }

    function _operations(uint256 length) private pure returns (address[] memory accounts, uint16[] memory weights) {
        accounts = new address[](length);
        weights = new uint16[](length);
        uint16 share = uint16(10_000 / length);
        uint256 allocated;
        for (uint256 i; i < length; ++i) {
            accounts[i] = address(uint160(0x8001 + i));
            weights[i] = i + 1 == length ? uint16(10_000 - allocated) : share;
            allocated += weights[i];
        }
    }
}
