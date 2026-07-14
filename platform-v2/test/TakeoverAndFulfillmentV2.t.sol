// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {ClaimVaultV2} from "../contracts/ClaimVaultV2.sol";
import {MerchantGuaranteeVaultV2} from "../contracts/MerchantGuaranteeVaultV2.sol";
import {PaymentEscrowV2} from "../contracts/PaymentEscrowV2.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract TakeoverAndFulfillmentV2Test is CoreFixture {
    function testSevenDayNoShipmentOpensTakeoverAndFreezesMerchant() public {
        bytes32 orderId = keccak256("takeover-order");
        _payOrder(_makeOrder(orderId, buyer, 20, false), BUYER_KEY);

        vm.expectRevert(PaymentEscrowV2.TakeoverNotReady.selector);
        paymentEscrow.openTakeover(orderId, keccak256("too-early"));

        vm.warp(block.timestamp + 7 days + 1);
        bytes32 takeoverEvidence = keccak256("scheduler-evidence");
        paymentEscrow.openTakeover(orderId, takeoverEvidence);
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.Takeover));
        assertTrue(claimVault.merchantFrozen(merchant));
        assertEq(guaranteeVault.guaranteeBalance(merchant), 470 ether);

        V2Types.OrderIntent memory blocked = _makeOrder(keccak256("merchant-frozen-order"), buyer, 21, false);
        blocked.deadline = type(uint64).max;
        blocked.reservationDeadline = type(uint64).max;
        twapSource.setResult(1_000 ether, 1_000_000 ether, uint64(block.timestamp));
        bytes32 digest = paymentEscrow.hashOrder(blocked);
        bytes memory quoteSignature = _sign(QUOTE_KEY, digest);
        bytes memory buyerSignature = _sign(BUYER_KEY, digest);
        vm.expectRevert(PaymentEscrowV2.MerchantUnavailable.selector);
        paymentEscrow.payOrder(blocked, quoteSignature, buyerSignature);
    }

    function testValidShipmentPreventsTakeover() public {
        bytes32 orderId = keccak256("shipped-order");
        _payOrder(_makeOrder(orderId, buyer, 22, false), BUYER_KEY);
        vm.prank(safe);
        paymentEscrow.recordShipmentEvidence(orderId, keccak256("valid-shipment"));
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(PaymentEscrowV2.TakeoverNotReady.selector);
        paymentEscrow.openTakeover(orderId, keccak256("invalid-takeover"));
    }

    function testMerchantFreezeResolvesOnlyAfterTakeoverFulfillmentAndDebtClearance() public {
        bytes32 orderId = keccak256("takeover-resolution-order");
        _payOrder(_makeOrder(orderId, buyer, 28, false), BUYER_KEY);
        vm.warp(block.timestamp + 7 days + 1);
        paymentEscrow.openTakeover(orderId, keccak256("takeover-open"));
        assertEq(paymentEscrow.activeTakeoverCases(merchant), 1);

        vm.prank(safe);
        vm.expectRevert(PaymentEscrowV2.MerchantUnavailable.selector);
        paymentEscrow.resolveMerchantFreeze(merchant, keccak256("premature-unfreeze"));

        vm.startPrank(safe);
        paymentEscrow.recordShipmentEvidence(orderId, keccak256("replacement-shipment"));
        paymentEscrow.recordDeliveryEvidence(orderId, keccak256("replacement-delivery"));
        vm.stopPrank();
        bytes32 receiptEvidence = keccak256("takeover-customer-receipt");
        vm.prank(buyer);
        paymentEscrow.requestCustomerReceipt(orderId, receiptEvidence);
        _finalize(orderId, V2Types.FulfillmentMethod.CustomerReceipt, receiptEvidence, 34);
        assertEq(paymentEscrow.activeTakeoverCases(merchant), 0);

        vm.prank(safe);
        paymentEscrow.resolveMerchantFreeze(merchant, keccak256("merchant-restored"));
        assertFalse(claimVault.merchantFrozen(merchant));
    }

    function testTakeoverFundingConsumesGuaranteeThenAvailableThenReserve() public {
        vm.startPrank(safe);
        guaranteeVault.grantRole(guaranteeVault.TAKEOVER_ROLE(), address(this));
        guaranteeVault.grantRole(guaranteeVault.ORDER_RESERVER_ROLE(), address(this));
        claimVault.grantRole(claimVault.MERCHANT_CREDITOR_ROLE(), address(this));
        vm.stopPrank();
        usdt.mint(address(this), 100 ether);
        usdt.approve(address(claimVault), type(uint256).max);
        claimVault.depositMerchant(keccak256("prior-proceeds"), merchant, 100 ether);

        bytes32 takeoverId = keccak256("large-takeover");
        guaranteeVault.reserveOrderCoverage(takeoverId, 1, merchant, 650 ether);
        (uint256 guaranteeUsed, uint256 availableUsed, uint256 reserveUsed) =
            guaranteeVault.beginTakeover(takeoverId, merchant, 650 ether);
        assertEq(guaranteeUsed, 500 ether);
        assertEq(availableUsed, 100 ether);
        assertEq(reserveUsed, 50 ether);
        assertEq(guaranteeVault.guaranteeBalance(merchant), 0);
        assertEq(claimVault.merchantClaimable(merchant), 0);
        assertEq(guaranteeVault.riskReserveBalance(), 450 ether);
        assertEq(guaranteeVault.merchantDebt(merchant), 0);
        assertEq(guaranteeVault.totalTakeoverLocked(), 650 ether);

        _disburseTakeover(takeoverId, safe, 650 ether, keccak256("replacement-purchase"), 720);
        assertEq(guaranteeVault.merchantDebt(merchant), 50 ether);
        assertEq(guaranteeVault.totalTakeoverLocked(), 0);
    }

    function testConcurrentOrdersCannotOverReserveTakeoverCoverage() public {
        vm.startPrank(safe);
        guaranteeVault.grantRole(guaranteeVault.ORDER_RESERVER_ROLE(), address(this));
        vm.stopPrank();

        guaranteeVault.reserveOrderCoverage(keccak256("coverage-a"), 1, merchant, 400 ether);
        guaranteeVault.reserveOrderCoverage(keccak256("coverage-b"), 1, merchant, 400 ether);
        vm.expectRevert(MerchantGuaranteeVaultV2.InsufficientTakeoverFunding.selector);
        guaranteeVault.reserveOrderCoverage(keccak256("coverage-c"), 1, merchant, 300 ether);

        assertEq(guaranteeVault.reservedGuarantee(merchant), 500 ether);
        assertEq(guaranteeVault.reservedRiskReserve(), 300 ether);
    }

    function testClosingPartialTakeoverRestoresEveryUnusedFundingSource() public {
        vm.startPrank(safe);
        guaranteeVault.grantRole(guaranteeVault.TAKEOVER_ROLE(), address(this));
        guaranteeVault.grantRole(guaranteeVault.ORDER_RESERVER_ROLE(), address(this));
        guaranteeVault.grantRole(guaranteeVault.TAKEOVER_CLOSER_ROLE(), address(this));
        claimVault.grantRole(claimVault.MERCHANT_CREDITOR_ROLE(), address(this));
        vm.stopPrank();
        usdt.mint(address(this), 100 ether);
        usdt.approve(address(claimVault), type(uint256).max);
        claimVault.depositMerchant(keccak256("available-before-partial"), merchant, 100 ether);

        bytes32 takeoverId = keccak256("partial-takeover");
        guaranteeVault.reserveOrderCoverage(takeoverId, 1, merchant, 650 ether);
        guaranteeVault.beginTakeover(takeoverId, merchant, 650 ether);
        _disburseTakeover(takeoverId, safe, 100 ether, keccak256("partial-spend"), 721);
        guaranteeVault.closeTakeover(takeoverId, keccak256("partial-close"));

        assertEq(guaranteeVault.guaranteeBalance(merchant), 400 ether);
        assertEq(claimVault.merchantClaimable(merchant), 100 ether);
        assertEq(guaranteeVault.riskReserveBalance(), 500 ether);
        assertEq(guaranteeVault.merchantDebt(merchant), 0);
        assertEq(guaranteeVault.totalTakeoverLocked(), 0);
    }

    function testTakeoverFundingRevertsAtomicallyWhenAllSourcesAreInsufficient() public {
        vm.startPrank(safe);
        guaranteeVault.grantRole(guaranteeVault.ORDER_RESERVER_ROLE(), address(this));
        vm.stopPrank();
        vm.expectRevert(MerchantGuaranteeVaultV2.InsufficientTakeoverFunding.selector);
        guaranteeVault.reserveOrderCoverage(keccak256("unfunded-takeover"), 1, merchant, 1_001 ether);
        assertEq(guaranteeVault.guaranteeBalance(merchant), 500 ether);
        assertEq(guaranteeVault.riskReserveBalance(), 500 ether);
    }

    function testMerchantForcedReceiptIsRequestOnlyUntilPlatformReviewAndFinality() public {
        bytes32 orderId = keccak256("forced-receipt-order");
        _payOrder(_makeOrder(orderId, buyer, 23, false), BUYER_KEY);
        vm.startPrank(safe);
        paymentEscrow.recordShipmentEvidence(orderId, keccak256("shipment"));
        paymentEscrow.recordDeliveryEvidence(orderId, keccak256("delivery"));
        vm.stopPrank();

        vm.prank(merchant);
        vm.expectRevert(PaymentEscrowV2.ForcedReceiptNotReady.selector);
        paymentEscrow.requestForcedReceipt(orderId, keccak256("logistics-proof"));

        vm.warp(block.timestamp + 7 days);
        vm.prank(merchant);
        paymentEscrow.requestForcedReceipt(orderId, keccak256("logistics-proof"));
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.Delivered));
        assertEq(claimVault.bnmClaimable(buyer), 0);

        bytes32 reviewedEvidence = keccak256("reviewed-logistics-proof");
        vm.prank(safe);
        paymentEscrow.approveForcedReceipt(orderId, reviewedEvidence);
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.FulfillmentPending));
        _finalize(orderId, V2Types.FulfillmentMethod.ForcedReceipt, reviewedEvidence, 30);
        assertEq(claimVault.bnmClaimable(buyer), 100 ether);
    }

    function testTakeoverDisbursementRequiresSafeAndExactSecondaryAuthorization() public {
        vm.startPrank(safe);
        guaranteeVault.grantRole(guaranteeVault.TAKEOVER_ROLE(), address(this));
        guaranteeVault.grantRole(guaranteeVault.ORDER_RESERVER_ROLE(), address(this));
        guaranteeVault.grantRole(guaranteeVault.TAKEOVER_DISBURSER_ROLE(), address(this));
        vm.stopPrank();
        bytes32 takeoverId = keccak256("authorized-disbursement");
        guaranteeVault.reserveOrderCoverage(takeoverId, 1, merchant, 30 ether);
        guaranteeVault.beginTakeover(takeoverId, merchant, 30 ether);

        bytes32 evidence = keccak256("authorized-replacement-purchase");
        uint64 deadline = type(uint64).max;
        bytes32 digest = guaranteeVault.hashTakeoverDisbursement(takeoverId, safe, 10 ether, evidence, 722, deadline);
        bytes memory signature = _sign(SECONDARY_KEY, digest);
        vm.expectRevert(MerchantGuaranteeVaultV2.SafeExecutionRequired.selector);
        guaranteeVault.disburseTakeover(takeoverId, safe, 10 ether, evidence, 722, deadline, signature);

        vm.prank(safe);
        vm.expectRevert(MerchantGuaranteeVaultV2.InvalidSignature.selector);
        guaranteeVault.disburseTakeover(takeoverId, address(0x9999), 10 ether, evidence, 722, deadline, signature);

        vm.prank(safe);
        guaranteeVault.disburseTakeover(takeoverId, safe, 10 ether, evidence, 722, deadline, signature);
        vm.prank(safe);
        vm.expectRevert(MerchantGuaranteeVaultV2.DisbursementReplay.selector);
        guaranteeVault.disburseTakeover(takeoverId, safe, 10 ether, evidence, 722, deadline, signature);
    }

    function testArbitrationKeepsFundsLockedUntilFinalDecisionFinality() public {
        bytes32 orderId = keccak256("arbitration-order");
        _payOrder(_makeOrder(orderId, buyer, 24, false), BUYER_KEY);
        vm.prank(safe);
        paymentEscrow.recordShipmentEvidence(orderId, keccak256("arbitration-shipment"));
        vm.prank(buyer);
        paymentEscrow.openArbitration(orderId, keccak256("exchange-request"));
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.Arbitration));
        assertEq(paymentEscrow.totalLockedUsdt(), 50 ether);
        assertEq(rewardLedger.totalLockedNpl(), 400 ether);

        bytes32 decisionEvidence = keccak256("final-arbitration-decision");
        vm.prank(safe);
        paymentEscrow.approveArbitrationFulfillment(orderId, decisionEvidence);
        vm.prank(buyer);
        vm.expectRevert(PaymentEscrowV2.InvalidOrderState.selector);
        paymentEscrow.openArbitration(orderId, keccak256("reopen-after-final-decision"));
        _finalize(orderId, V2Types.FulfillmentMethod.Arbitration, decisionEvidence, 31);
        assertEq(paymentEscrow.totalLockedUsdt(), 0);
        assertEq(rewardLedger.totalLockedNpl(), 0);
    }

    function testPaidOrderCannotArbitrateOrRegisterShipmentAfterTakeoverDeadline() public {
        bytes32 orderId = keccak256("paid-state-guards");
        _payOrder(_makeOrder(orderId, buyer, 241, false), BUYER_KEY);

        vm.prank(buyer);
        vm.expectRevert(PaymentEscrowV2.InvalidOrderState.selector);
        paymentEscrow.openArbitration(orderId, keccak256("premature-arbitration"));

        vm.warp(block.timestamp + 7 days);
        vm.prank(safe);
        vm.expectRevert(PaymentEscrowV2.TakeoverNotReady.selector);
        paymentEscrow.recordShipmentEvidence(orderId, keccak256("late-shipment"));
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.Paid));
    }

    function testDeliveryEvidenceCannotOverwriteArbitrationState() public {
        bytes32 orderId = keccak256("arbitration-state-guard");
        _payOrder(_makeOrder(orderId, buyer, 242, false), BUYER_KEY);
        vm.prank(safe);
        paymentEscrow.recordShipmentEvidence(orderId, keccak256("arbitration-state-shipment"));
        vm.prank(buyer);
        paymentEscrow.openArbitration(orderId, keccak256("arbitration-state-open"));

        vm.prank(safe);
        paymentEscrow.recordDeliveryEvidence(orderId, keccak256("delivery-during-arbitration"));
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.Arbitration));
        vm.prank(buyer);
        vm.expectRevert(PaymentEscrowV2.InvalidOrderState.selector);
        paymentEscrow.requestCustomerReceipt(orderId, keccak256("receipt-during-arbitration"));
    }

    function testPickupVerificationUsesNormalFinalityFlow() public {
        bytes32 orderId = keccak256("pickup-order");
        V2Types.OrderIntent memory intent = _makeOrder(orderId, buyer, 25, false);
        intent.fulfillmentMode = V2Types.FulfillmentMode.Pickup;
        intent.fulfillmentTargetHash = keccak256("signed-pickup-store");
        _payOrder(intent, BUYER_KEY);
        bytes32 verificationEvidence = keccak256("signed-pickup-scan");
        vm.prank(safe);
        paymentEscrow.requestPickupVerification(orderId, verificationEvidence);
        _finalize(orderId, V2Types.FulfillmentMethod.PickupVerification, verificationEvidence, 32);
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.Fulfilled));
    }

    function testPickupTimeoutTakeoverFailsClosedPendingEvidenceDecision() public {
        bytes32 orderId = keccak256("pickup-timeout-decision-blocked");
        V2Types.OrderIntent memory intent = _makeOrder(orderId, buyer, 251, false);
        intent.fulfillmentMode = V2Types.FulfillmentMode.Pickup;
        intent.fulfillmentTargetHash = keccak256("pickup-location-snapshot");
        _payOrder(intent, BUYER_KEY);

        vm.warp(block.timestamp + 7 days + 1);
        vm.expectRevert(PaymentEscrowV2.PickupTakeoverDecisionBlocked.selector);
        paymentEscrow.openTakeover(orderId, keccak256("pickup-timeout"));
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.Paid));
    }

    function testFinalityRequiresConfirmationsAndCorrectSigner() public {
        bytes32 orderId = keccak256("invalid-finality-order");
        _payOrder(_makeOrder(orderId, buyer, 26, false), BUYER_KEY);
        vm.startPrank(safe);
        paymentEscrow.recordShipmentEvidence(orderId, keccak256("shipment"));
        paymentEscrow.recordDeliveryEvidence(orderId, keccak256("delivery"));
        vm.stopPrank();
        bytes32 evidence = keccak256("receipt");
        vm.prank(buyer);
        paymentEscrow.requestCustomerReceipt(orderId, evidence);

        V2Types.FulfillmentAttestation memory attestation =
            _attestation(orderId, V2Types.FulfillmentMethod.CustomerReceipt, evidence, 33);
        attestation.confirmations = 11;
        bytes memory insufficientConfirmationSignature = _sign(FINALITY_KEY, paymentEscrow.hashFinality(attestation));
        vm.expectRevert(PaymentEscrowV2.InvalidFinality.selector);
        paymentEscrow.finalizeFulfillment(attestation, insufficientConfirmationSignature);

        attestation.confirmations = 12;
        attestation.sourceContract = safe;
        bytes memory wrongSourceSignature = _sign(FINALITY_KEY, paymentEscrow.hashFinality(attestation));
        vm.expectRevert(PaymentEscrowV2.InvalidFinality.selector);
        paymentEscrow.finalizeFulfillment(attestation, wrongSourceSignature);

        attestation.sourceContract = address(paymentEscrow);
        attestation.sourceEventHash = keccak256("WrongFulfillmentEvent(bytes32)");
        bytes memory wrongEventSignature = _sign(FINALITY_KEY, paymentEscrow.hashFinality(attestation));
        vm.expectRevert(PaymentEscrowV2.InvalidFinality.selector);
        paymentEscrow.finalizeFulfillment(attestation, wrongEventSignature);

        attestation.sourceEventHash = paymentEscrow.FULFILLMENT_REQUEST_EVENT_SIGNATURE();
        bytes memory wrongSignature = _sign(QUOTE_KEY, paymentEscrow.hashFinality(attestation));
        vm.expectRevert(PaymentEscrowV2.InvalidSignature.selector);
        paymentEscrow.finalizeFulfillment(attestation, wrongSignature);
        assertEq(paymentEscrow.totalLockedUsdt(), 50 ether);
    }

    function testTechnicalRecoveryCannotTouchLockedOrderFunds() public {
        bytes32 orderId = keccak256("recovery-order");
        _payOrder(_makeOrder(orderId, buyer, 27, false), BUYER_KEY);
        usdt.mint(address(paymentEscrow), 7 ether);
        vm.startPrank(safe);
        paymentEscrow.recoverSurplus(address(usdt), safe, 7 ether, keccak256("incident"));
        vm.expectRevert(PaymentEscrowV2.InsufficientSurplus.selector);
        paymentEscrow.recoverSurplus(address(usdt), safe, 1, keccak256("incident-2"));
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(paymentEscrow)), 50 ether);
    }

    function _finalize(bytes32 orderId, V2Types.FulfillmentMethod method, bytes32 evidence, uint256 nonce) private {
        V2Types.FulfillmentAttestation memory attestation = _attestation(orderId, method, evidence, nonce);
        paymentEscrow.finalizeFulfillment(attestation, _sign(FINALITY_KEY, paymentEscrow.hashFinality(attestation)));
    }

    function _attestation(bytes32 orderId, V2Types.FulfillmentMethod method, bytes32 evidence, uint256 nonce)
        private
        view
        returns (V2Types.FulfillmentAttestation memory)
    {
        return V2Types.FulfillmentAttestation({
            orderId: orderId,
            method: method,
            sourceChainId: 56,
            sourceContract: address(paymentEscrow),
            sourceEventHash: paymentEscrow.FULFILLMENT_REQUEST_EVENT_SIGNATURE(),
            sourceTxHash: keccak256(abi.encode("tx", orderId, method)),
            blockHash: keccak256(abi.encode("block", orderId, method)),
            confirmations: 12,
            status: 1,
            nonce: nonce,
            deadline: uint64(block.timestamp + 1 hours),
            evidenceHash: evidence
        });
    }

    function _disburseTakeover(bytes32 orderId, address recipient, uint256 amount, bytes32 evidence, uint256 nonce)
        private
    {
        uint64 deadline = type(uint64).max;
        bytes32 digest = guaranteeVault.hashTakeoverDisbursement(orderId, recipient, amount, evidence, nonce, deadline);
        bytes memory signature = _sign(SECONDARY_KEY, digest);
        vm.prank(safe);
        guaranteeVault.disburseTakeover(orderId, recipient, amount, evidence, nonce, deadline, signature);
    }
}
