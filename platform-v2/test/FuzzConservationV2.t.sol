// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {PaymentEscrowV2} from "../contracts/PaymentEscrowV2.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract FuzzConservationV2Test is CoreFixture {
    function testZeroNplLegSkipsApprovalTransferBurnAndOracle() public {
        _publishZeroNplPolicy();
        V2Types.OrderIntent memory intent = _makeOrder(keccak256("zero-npl-order"), buyer, 300, false);
        intent.policyVersion = 2;
        intent.usdtPaymentAmount = 100 ether;
        intent.nplPaymentAmount = 0;
        intent.rewardBaseNpl = 0;
        intent.merchantUsdtAmount = 80 ether;
        intent.platformUsdtAmount = 5 ether;
        intent.usdtRemainderAmount = 15 ether;
        uint256 nplBefore = npl.balanceOf(buyer);
        twapSource.setResult(0, 0, 0);

        intent.oracleVersion = keccak256("wrong-zero-leg-oracle-version");
        bytes32 wrongVersionDigest = paymentEscrow.hashOrder(intent);
        vm.expectRevert(PaymentEscrowV2.InvalidAmounts.selector);
        paymentEscrow.payOrder(intent, _sign(QUOTE_KEY, wrongVersionDigest), _sign(BUYER_KEY, wrongVersionDigest));
        intent.oracleVersion = ORACLE_VERSION;
        _payOrder(intent, BUYER_KEY);
        assertEq(npl.balanceOf(buyer), nplBefore);
        assertEq(npl.balanceOf(paymentEscrow.NPL_BURN_ADDRESS()), 0);
        assertEq(rewardLedger.totalLockedNpl(), 0);
        _fulfillByCustomer(intent.orderId, 300);
        assertEq(claimVault.merchantClaimable(merchant), 80 ether);
        assertEq(claimVault.totalNplLiability(), 0);
    }

    function testMissingBeneficiariesAndAllIntegerRemainderRouteToCirculationPool() public {
        uint256 unboundBuyerKey = 0xABCD;
        address unboundBuyer = vm.addr(unboundBuyerKey);
        usdt.mint(unboundBuyer, 1_000 ether);
        npl.mint(unboundBuyer, 10_000 ether);
        vm.startPrank(unboundBuyer);
        usdt.approve(address(paymentEscrow), type(uint256).max);
        npl.approve(address(paymentEscrow), type(uint256).max);
        vm.stopPrank();

        V2Types.OrderIntent memory intent = _makeOrder(keccak256("missing-beneficiaries"), unboundBuyer, 301, false);
        intent.fulfillmentMode = V2Types.FulfillmentMode.Pickup;
        intent.regionCodeHash = keccak256("unassigned-region");
        intent.beneficiaries = V2Types.BeneficiarySnapshot({
            genesis: address(0),
            directReferral: address(0),
            district: address(0),
            city: address(0),
            province: address(0),
            region: address(0),
            merchantStore: address(0)
        });
        bytes32 digest = paymentEscrow.hashOrder(intent);
        paymentEscrow.payOrder(intent, _sign(QUOTE_KEY, digest), _sign(unboundBuyerKey, digest));

        bytes32 pickupEvidence = keccak256("pickup-missing-beneficiary-order");
        vm.prank(safe);
        paymentEscrow.requestPickupVerification(intent.orderId, pickupEvidence);
        _finalizePickup(intent.orderId, pickupEvidence, 301);
        assertEq(claimVault.rewardClaimable(operationsOne), 24 ether);
        assertEq(claimVault.rewardClaimable(operationsTwo), 16 ether);
        assertEq(claimVault.totalNplLiability(), 40 ether);
        assertEq(npl.balanceOf(circulationPool), 360 ether);
    }

    function testFuzz_OrderFundsConserveAcrossPaymentAndFulfillment(uint96 rawUnits) public {
        uint256 units = bound(rawUnits, 1e12, 1e17);
        uint256 listPrice = units * 10_000;
        bytes32 orderId = keccak256(abi.encode("fuzz-order", rawUnits));
        V2Types.OrderIntent memory intent = _makeOrder(orderId, buyer, uint256(rawUnits) + 1_000, false);
        intent.listPriceUsdt = listPrice;
        intent.usdtPaymentAmount = listPrice / 2;
        intent.rewardBaseNpl = listPrice * 10;
        intent.nplPaymentAmount = listPrice * 5;
        intent.merchantUsdtAmount = listPrice * 3 / 10;
        intent.platformUsdtAmount = listPrice / 20;
        intent.usdtRemainderAmount = listPrice * 3 / 20;
        intent.bnmAmount = listPrice;
        twapSource.setResult(intent.rewardBaseNpl, 1_000_000 ether, uint64(block.timestamp));

        uint256 buyerUsdtBefore = usdt.balanceOf(buyer);
        uint256 buyerNplBefore = npl.balanceOf(buyer);
        _payOrder(intent, BUYER_KEY);
        assertEq(buyerUsdtBefore - usdt.balanceOf(buyer), intent.usdtPaymentAmount);
        assertEq(buyerNplBefore - npl.balanceOf(buyer), intent.nplPaymentAmount);
        assertEq(
            npl.balanceOf(paymentEscrow.NPL_BURN_ADDRESS()) + rewardLedger.totalLockedNpl(), intent.nplPaymentAmount
        );

        _fulfillByCustomer(orderId, uint256(rawUnits) + 1_000);
        assertEq(
            claimVault.merchantClaimable(merchant) + usdt.balanceOf(platformTreasury)
                + usdt.balanceOf(usdtRemainderAccount),
            intent.usdtPaymentAmount
        );
        assertEq(
            npl.balanceOf(paymentEscrow.NPL_BURN_ADDRESS()) + claimVault.totalNplLiability()
                + npl.balanceOf(circulationPool),
            intent.nplPaymentAmount
        );
        assertEq(claimVault.bnmClaimable(buyer), listPrice);
    }

    function _publishZeroNplPolicy() private {
        V2Types.Policy memory policy = policyRegistry.getPolicy(1);
        policy.version = 2;
        policy.usdtPaymentBps = 10_000;
        policy.nplPaymentBps = 0;
        policy.genesisBps = 0;
        policy.directReferralBps = 0;
        policy.districtBps = 0;
        policy.cityBps = 0;
        policy.provinceBps = 0;
        policy.regionBps = 0;
        policy.operationsBps = 0;
        policy.merchantStoreBps = 0;
        policy.decisionEvidenceHash = keccak256("zero-npl-policy-decision");
        address[] memory accounts = new address[](2);
        accounts[0] = operationsOne;
        accounts[1] = operationsTwo;
        uint16[] memory weights = new uint16[](2);
        weights[0] = 6_000;
        weights[1] = 4_000;
        uint64 deadline = type(uint64).max;
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, 302, deadline);
        vm.prank(safe);
        policyRegistry.publishPolicy(policy, accounts, weights, 302, deadline, _sign(SECONDARY_KEY, digest));
    }

    function _finalizePickup(bytes32 orderId, bytes32 evidence, uint256 nonce) private {
        V2Types.FulfillmentAttestation memory attestation = V2Types.FulfillmentAttestation({
            orderId: orderId,
            method: V2Types.FulfillmentMethod.PickupVerification,
            sourceChainId: 56,
            sourceContract: address(paymentEscrow),
            sourceEventHash: paymentEscrow.FULFILLMENT_REQUEST_EVENT_SIGNATURE(),
            sourceTxHash: keccak256(abi.encode("tx", orderId)),
            blockHash: keccak256(abi.encode("block", orderId)),
            confirmations: 12,
            status: 1,
            nonce: nonce,
            deadline: type(uint64).max,
            evidenceHash: evidence
        });
        paymentEscrow.finalizeFulfillment(attestation, _sign(FINALITY_KEY, paymentEscrow.hashFinality(attestation)));
    }
}
