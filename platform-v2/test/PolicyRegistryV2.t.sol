// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {BeneficiaryRegistryV2} from "../contracts/BeneficiaryRegistryV2.sol";
import {PolicyRegistryV2} from "../contracts/PolicyRegistryV2.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract PolicyRegistryV2Test is CoreFixture {
    function testLaunchPolicyFreezesPaymentWalletsAndRewards() public view {
        V2Types.Policy memory policy = policyRegistry.getPolicy(1);
        assertEq(policyRegistry.governanceWallet(), governanceWallet);
        assertEq(policyRegistry.secondarySigner(), governanceWallet);
        assertEq(policy.usdtPaymentBps, 7_000);
        assertEq(policy.nplPaymentBps, 3_000);
        assertEq(policy.nplBurnListPriceBps, 2_000);
        assertEq(policy.nplRewardListPriceBps, 1_000);
        assertEq(policy.merchantGuaranteeMinimum, 1_000 ether);
        assertEq(policy.usdtCustodyWallet, usdtCustodyWallet);
        assertEq(policy.nplRewardWallet, nplRewardWallet);
        assertEq(policy.operationsWallet, operationsWallet);
        assertEq(
            uint256(policy.genesisBps) + policy.directReferralBps + policy.districtBps + policy.cityBps
                + policy.provinceBps + policy.regionBps + policy.operationsBps,
            1_000
        );
    }

    function testPolicyRegistryRejectsContractGovernanceWallet() public {
        vm.expectRevert(PolicyRegistryV2.InvalidAddress.selector);
        new PolicyRegistryV2(address(this));
    }

    function testPolicyPublicationRequiresActualGovernanceWalletAndSecondarySignature() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 2, deadline);

        vm.expectRevert();
        policyRegistry.publishPolicy(policy, accounts, weights, 2, deadline, _sign(GOVERNANCE_KEY, digest));

        vm.prank(governanceWallet);
        vm.expectRevert(PolicyRegistryV2.InvalidSecondarySignature.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 2, deadline, _sign(QUOTE_KEY, digest));

        vm.prank(governanceWallet);
        policyRegistry.publishPolicy(policy, accounts, weights, 2, deadline, _sign(GOVERNANCE_KEY, digest));
        assertEq(policyRegistry.latestVersion(), 2);
    }

    function testFuturePolicyCanAdjustBurnRouteAndRewardSharesForFutureQuotes() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        policy.nplBurnListPriceBps = 1_800;
        policy.nplRewardListPriceBps = 1_200;
        policy.operationsBps = 600;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 7, deadline);

        vm.prank(governanceWallet);
        policyRegistry.publishPolicy(policy, accounts, weights, 7, deadline, _sign(GOVERNANCE_KEY, digest));

        V2Types.Policy memory published = policyRegistry.getPolicy(2);
        assertEq(published.nplBurnListPriceBps, 1_800);
        assertEq(published.nplRewardListPriceBps, 1_200);
        assertEq(published.operationsBps, 600);
    }

    function testPolicyRejectsBuyerLegDrift() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        policy.usdtPaymentBps = 6_999;
        policy.nplPaymentBps = 3_001;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 3, deadline);
        vm.prank(governanceWallet);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 3, deadline, _sign(GOVERNANCE_KEY, digest));
    }

    function testPolicyRejectsIncompleteRewardAllocationAndDuplicateWallets() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        policy.operationsBps = 399;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 5, deadline);
        vm.prank(governanceWallet);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 5, deadline, _sign(GOVERNANCE_KEY, digest));

        (policy, accounts, weights) = _secondPolicy();
        policy.nplRewardWallet = policy.usdtCustodyWallet;
        digest = policyRegistry.hashPublication(policy, accounts, weights, 6, deadline);
        vm.prank(governanceWallet);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 6, deadline, _sign(GOVERNANCE_KEY, digest));

        (policy, accounts, weights) = _secondPolicy();
        policy.usdtCustodyWallet = address(this);
        digest = policyRegistry.hashPublication(policy, accounts, weights, 9, deadline);
        vm.prank(governanceWallet);
        vm.expectRevert(PolicyRegistryV2.InvalidPolicy.selector);
        policyRegistry.publishPolicy(policy, accounts, weights, 9, deadline, _sign(GOVERNANCE_KEY, digest));
    }

    function testRegionRoutingRequiresVersionedGovernanceWalletAndSecondaryApproval() public {
        (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights) = _secondPolicy();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        BeneficiaryRegistryV2.RegionBeneficiaries memory next = BeneficiaryRegistryV2.RegionBeneficiaries(
            address(0x8001), address(0x8002), address(0x8003), address(0x8004)
        );
        bytes32 digest = beneficiaryRegistry.hashRegionPublication(2, regionCodeHash, next, 2, deadline);

        vm.expectRevert();
        beneficiaryRegistry.publishRegionBeneficiaries(
            2, regionCodeHash, next, 2, deadline, _sign(GOVERNANCE_KEY, digest)
        );
        vm.prank(governanceWallet);
        vm.expectRevert(BeneficiaryRegistryV2.InvalidSecondarySignature.selector);
        beneficiaryRegistry.publishRegionBeneficiaries(2, regionCodeHash, next, 2, deadline, _sign(QUOTE_KEY, digest));
        vm.prank(governanceWallet);
        beneficiaryRegistry.publishRegionBeneficiaries(
            2, regionCodeHash, next, 2, deadline, _sign(GOVERNANCE_KEY, digest)
        );

        bytes32 policyDigest = policyRegistry.hashPublication(policy, accounts, weights, 20, deadline);
        vm.prank(governanceWallet);
        policyRegistry.publishPolicy(policy, accounts, weights, 20, deadline, _sign(GOVERNANCE_KEY, policyDigest));

        V2Types.BeneficiarySnapshot memory oldSnapshot =
            V2Types.BeneficiarySnapshot(address(0), directReferral, district, city, province, region);
        beneficiaryRegistry.validateSnapshot(1, buyer, merchant, regionCodeHash, oldSnapshot);
        V2Types.BeneficiarySnapshot memory nextSnapshot = V2Types.BeneficiarySnapshot(
            address(0), directReferral, next.district, next.city, next.province, next.region
        );
        beneficiaryRegistry.validateSnapshot(2, buyer, merchant, regionCodeHash, nextSnapshot);
        vm.expectRevert(BeneficiaryRegistryV2.BeneficiaryMismatch.selector);
        beneficiaryRegistry.validateSnapshot(2, buyer, merchant, regionCodeHash, oldSnapshot);

        vm.prank(governanceWallet);
        vm.expectRevert(BeneficiaryRegistryV2.PolicyVersionRequired.selector);
        beneficiaryRegistry.publishRegionBeneficiaries(
            2, regionCodeHash, next, 3, deadline, _sign(GOVERNANCE_KEY, digest)
        );
    }

    function _secondPolicy()
        private
        view
        returns (V2Types.Policy memory policy, address[] memory accounts, uint16[] memory weights)
    {
        policy = policyRegistry.getPolicy(1);
        policy.version = 2;
        policy.decisionEvidenceHash = keccak256("policy-2-evidence");
        accounts = new address[](4);
        accounts[0] = operationsOne;
        accounts[1] = operationsTwo;
        accounts[2] = operationsThree;
        accounts[3] = operationsFour;
        weights = new uint16[](4);
        weights[0] = 2_500;
        weights[1] = 2_500;
        weights[2] = 2_500;
        weights[3] = 2_500;
    }
}
