// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {PaymentEscrowV2} from "../contracts/PaymentEscrowV2.sol";
import {SeckillV2} from "../contracts/SeckillV2.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract SeckillV2Test is CoreFixture {
    bytes32 private constant SESSION_ID = keccak256("session-1");

    function testLivePurchaseUsesSeckillInventoryPrizeAndRelayCap() public {
        _createSession(10, 1);
        V2Types.SeckillIntent memory intent = _makeSeckillIntent(keccak256("seckill-live-1"), 100);
        _buy(intent);

        SeckillV2.Session memory session = seckill.getSession(SESSION_ID);
        assertEq(session.sold, 1);
        assertEq(session.lastBuyer, buyer);
        assertEq(session.prizePool, 10 ether);
        assertEq(session.relayDeadline, session.startsAt + 60 seconds);
        assertEq(usdt.balanceOf(address(seckill)), 10 ether);
        assertEq(paymentEscrow.totalLockedUsdt(), 40 ether);
        assertEq(uint256(paymentEscrow.getOrder(intent.seckillOrder.orderId).state), uint256(V2Types.OrderState.Paid));
    }

    function testFinalPurchaseAddsThirtySecondsButRemainingNeverExceedsSixty() public {
        _createSession(11, 3);
        uint64 startsAt = seckill.getSession(SESSION_ID).startsAt;
        vm.warp(startsAt + 40 seconds);
        twapSource.setResult(1_000 ether, 1_000_000 ether, uint64(block.timestamp));
        V2Types.SeckillIntent memory first = _makeSeckillIntent(keccak256("relay-1"), 101);
        _setMaxDeadlines(first);
        _buy(first);
        assertEq(seckill.getSession(SESSION_ID).relayDeadline, startsAt + 90 seconds);

        V2Types.SeckillIntent memory second = _makeSeckillIntent(keccak256("relay-2"), 102);
        _setMaxDeadlines(second);
        _buy(second);
        assertEq(seckill.getSession(SESSION_ID).relayDeadline, uint64(block.timestamp + 60 seconds));
    }

    function testExactRelayDeadlineAtomicallyUsesFallbackRetailQuote() public {
        _createSession(12, 1);
        uint64 relayDeadline = seckill.getSession(SESSION_ID).relayDeadline;
        vm.warp(relayDeadline);
        twapSource.setResult(1_000 ether, 1_000_000 ether, uint64(block.timestamp));
        V2Types.SeckillIntent memory intent = _makeSeckillIntent(keccak256("boundary-order"), 103);
        _setMaxDeadlines(intent);
        _buy(intent);

        SeckillV2.Session memory session = seckill.getSession(SESSION_ID);
        assertEq(session.sold, 0);
        assertEq(session.prizePool, 0);
        assertEq(uint256(paymentEscrow.getOrder(intent.fallbackOrder.orderId).state), uint256(V2Types.OrderState.Paid));
        assertEq(paymentEscrow.getOrder(intent.fallbackOrder.orderId).usdtLocked, 50 ether);
        assertTrue(paymentEscrow.usedReservation(intent.fallbackOrder.reservationId));
        assertFalse(paymentEscrow.usedReservation(intent.seckillOrder.reservationId));
    }

    function testFallbackInsufficientAllowanceRevertsEntirePurchase() public {
        _createSession(13, 1);
        vm.warp(seckill.getSession(SESSION_ID).relayDeadline);
        twapSource.setResult(1_000 ether, 1_000_000 ether, uint64(block.timestamp));
        V2Types.SeckillIntent memory intent = _makeSeckillIntent(keccak256("boundary-no-allowance"), 104);
        _setMaxDeadlines(intent);
        vm.prank(buyer);
        usdt.approve(address(paymentEscrow), 0);
        bytes32 digest = seckill.hashPurchase(intent);
        bytes memory quoteSignature = _sign(QUOTE_KEY, digest);
        bytes memory buyerSignature = _sign(BUYER_KEY, digest);
        vm.expectRevert();
        seckill.buy(intent, quoteSignature, buyerSignature);
        assertEq(seckill.getSession(SESSION_ID).sold, 0);
        assertFalse(paymentEscrow.usedReservation(intent.fallbackOrder.reservationId));
        assertEq(uint256(paymentEscrow.getOrder(intent.fallbackOrder.orderId).state), uint256(V2Types.OrderState.None));
    }

    function testSeckillInventoryCannotOversell() public {
        _createSession(14, 1);
        _buy(_makeSeckillIntent(keccak256("inventory-first"), 105));
        V2Types.SeckillIntent memory second = _makeSeckillIntent(keccak256("inventory-second"), 106);
        bytes32 digest = seckill.hashPurchase(second);
        bytes memory quoteSignature = _sign(QUOTE_KEY, digest);
        bytes memory buyerSignature = _sign(BUYER_KEY, digest);
        vm.expectRevert(SeckillV2.InventoryExceeded.selector);
        seckill.buy(second, quoteSignature, buyerSignature);
        assertEq(seckill.getSession(SESSION_ID).sold, 1);
    }

    function testPrizeBecomesClaimableOnlyAfterFinalSessionSettlement() public {
        _createSession(15, 1);
        V2Types.SeckillIntent memory intent = _makeSeckillIntent(keccak256("settlement-order"), 107);
        _buy(intent);
        assertEq(claimVault.prizeClaimable(buyer), 0);
        assertEq(claimVault.bnmClaimable(buyer), 0);

        vm.prank(safe);
        vm.expectRevert(SeckillV2.SessionNotReadyToSettle.selector);
        seckill.settle(SESSION_ID);

        vm.warp(seckill.getSession(SESSION_ID).relayDeadline + 5 minutes);
        vm.prank(safe);
        seckill.settle(SESSION_ID);
        assertEq(claimVault.prizeClaimable(buyer), 10 ether);
        assertEq(claimVault.bnmClaimable(buyer), 0);
        assertEq(usdt.balanceOf(address(seckill)), 0);
    }

    function testSafeInjectionAndForceCloseRequireSecondarySignature() public {
        _createSession(16, 1);
        bytes32 injectionEvidence = keccak256("prize-injection-evidence");
        uint64 deadline = type(uint64).max;
        bytes32 injectionAction =
            keccak256(abi.encode("INJECT_PRIZE", SESSION_ID, uint64(1), address(usdt), 25 ether, 0, injectionEvidence));
        bytes memory injectionSignature = _sign(SECONDARY_KEY, seckill.hashAdminAction(injectionAction, 17, deadline));
        vm.prank(safe);
        seckill.injectPrize(SESSION_ID, 25 ether, injectionEvidence, 17, deadline, injectionSignature);
        assertEq(seckill.getSession(SESSION_ID).prizePool, 25 ether);

        bytes32 closeEvidence = keccak256("manual-close-evidence");
        SeckillV2.Session memory session = seckill.getSession(SESSION_ID);
        bytes32 closeAction = keccak256(
            abi.encode("FORCE_CLOSE", SESSION_ID, uint64(1), session.mainDeadline, session.relayDeadline, closeEvidence)
        );
        bytes memory wrongSignature = _sign(QUOTE_KEY, seckill.hashAdminAction(closeAction, 18, deadline));
        vm.prank(safe);
        vm.expectRevert(SeckillV2.InvalidSignature.selector);
        seckill.forceClose(SESSION_ID, closeEvidence, 18, deadline, wrongSignature);

        bytes memory closeSignature = _sign(SECONDARY_KEY, seckill.hashAdminAction(closeAction, 18, deadline));
        vm.prank(safe);
        seckill.forceClose(SESSION_ID, closeEvidence, 18, deadline, closeSignature);
        assertEq(seckill.getSession(SESSION_ID).forceClosedAt, uint64(block.timestamp));
    }

    function testBothQuotesAreBoundByOneBuyerAcknowledgement() public {
        _createSession(19, 1);
        V2Types.SeckillIntent memory intent = _makeSeckillIntent(keccak256("dual-quote"), 108);
        bytes32 digest = seckill.hashPurchase(intent);
        intent.fallbackOrder.listPriceUsdt = 101 ether;
        vm.expectRevert(SeckillV2.InvalidSignature.selector);
        seckill.buy(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }

    function testNewPolicyRejectsOldOrdinaryOrdersAndSessionsButKeepsActiveSessionSnapshot() public {
        _createSession(20, 2);
        _publishSecondPolicy(21);

        V2Types.OrderIntent memory staleOrder = _makeOrder(keccak256("stale-ordinary"), buyer, 109, false);
        bytes32 orderDigest = paymentEscrow.hashOrder(staleOrder);
        vm.expectRevert(PaymentEscrowV2.InvalidIntent.selector);
        paymentEscrow.payOrder(staleOrder, _sign(QUOTE_KEY, orderDigest), _sign(BUYER_KEY, orderDigest));

        V2Types.SeckillIntent memory activeSessionOrder = _makeSeckillIntent(keccak256("active-old-session"), 110);
        _buy(activeSessionOrder);
        assertEq(seckill.getSession(SESSION_ID).sold, 1);

        bytes32 newSessionId = keccak256("stale-policy-new-session");
        uint64 startsAt = uint64(block.timestamp);
        bytes32 actionHash = keccak256(
            abi.encode(
                "CREATE_SESSION",
                newSessionId,
                uint64(1),
                merchant,
                keccak256("product-1"),
                keccak256("sku-1"),
                keccak256("product-policy-1"),
                startsAt,
                uint256(1)
            )
        );
        uint64 deadline = type(uint64).max;
        bytes memory signature = _sign(SECONDARY_KEY, seckill.hashAdminAction(actionHash, 22, deadline));
        vm.prank(safe);
        vm.expectRevert(SeckillV2.InvalidSession.selector);
        seckill.createSession(
            newSessionId,
            1,
            merchant,
            keccak256("product-1"),
            keccak256("sku-1"),
            keccak256("product-policy-1"),
            startsAt,
            1,
            22,
            deadline,
            signature
        );
    }

    function testInjectedPrizeInEmptySessionStaysLockedAndHasNoRolloverPath() public {
        _createSession(23, 1);
        bytes32 evidence = keccak256("empty-session-injection");
        uint64 deadline = type(uint64).max;
        bytes32 actionHash =
            keccak256(abi.encode("INJECT_PRIZE", SESSION_ID, uint64(1), address(usdt), 25 ether, 0, evidence));
        bytes memory signature = _sign(SECONDARY_KEY, seckill.hashAdminAction(actionHash, 24, deadline));
        vm.prank(safe);
        seckill.injectPrize(SESSION_ID, 25 ether, evidence, 24, deadline, signature);

        vm.warp(seckill.getSession(SESSION_ID).relayDeadline + 5 minutes);
        vm.prank(safe);
        vm.expectRevert(SeckillV2.NoWinner.selector);
        seckill.settle(SESSION_ID);
        assertEq(seckill.totalUnsettledPrize(), 25 ether);

        vm.prank(safe);
        vm.expectRevert(SeckillV2.InsufficientSurplus.selector);
        seckill.recoverSurplus(safe, 1, keccak256("cannot-recover-locked-prize"));
    }

    function _createSession(uint256 adminNonce, uint256 inventory) private {
        uint64 startsAt = uint64(block.timestamp);
        bytes32 productId = keccak256("product-1");
        bytes32 skuId = keccak256("sku-1");
        bytes32 productPolicyHash = keccak256("product-policy-1");
        bytes32 actionHash = keccak256(
            abi.encode(
                "CREATE_SESSION",
                SESSION_ID,
                uint64(1),
                merchant,
                productId,
                skuId,
                productPolicyHash,
                startsAt,
                inventory
            )
        );
        uint64 deadline = type(uint64).max;
        bytes memory signature = _sign(SECONDARY_KEY, seckill.hashAdminAction(actionHash, adminNonce, deadline));
        vm.prank(safe);
        seckill.createSession(
            SESSION_ID,
            1,
            merchant,
            productId,
            skuId,
            productPolicyHash,
            startsAt,
            inventory,
            adminNonce,
            deadline,
            signature
        );
    }

    function _makeSeckillIntent(bytes32 orderId, uint256 nonce)
        private
        view
        returns (V2Types.SeckillIntent memory intent)
    {
        V2Types.OrderIntent memory seckillOrder = _makeOrder(orderId, buyer, nonce, true);
        V2Types.OrderIntent memory fallbackOrder = _makeOrder(orderId, buyer, nonce, false);
        intent = V2Types.SeckillIntent({
            sessionId: SESSION_ID, seckillOrder: seckillOrder, fallbackOrder: fallbackOrder, deadline: type(uint64).max
        });
    }

    function _setMaxDeadlines(V2Types.SeckillIntent memory intent) private pure {
        intent.deadline = type(uint64).max;
        intent.seckillOrder.deadline = type(uint64).max;
        intent.seckillOrder.reservationDeadline = type(uint64).max;
        intent.fallbackOrder.deadline = type(uint64).max;
        intent.fallbackOrder.reservationDeadline = type(uint64).max;
    }

    function _buy(V2Types.SeckillIntent memory intent) private {
        bytes32 digest = seckill.hashPurchase(intent);
        seckill.buy(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }

    function _publishSecondPolicy(uint256 nonce) private {
        V2Types.Policy memory policy = policyRegistry.getPolicy(1);
        policy.version = 2;
        policy.decisionEvidenceHash = keccak256("policy-v2-snapshot-test");
        policy.rulesContentHash = keccak256("policy-v2-rules");
        address[] memory accounts = new address[](2);
        accounts[0] = operationsOne;
        accounts[1] = operationsTwo;
        uint16[] memory weights = new uint16[](2);
        weights[0] = 6_000;
        weights[1] = 4_000;
        uint64 deadline = type(uint64).max;
        bytes32 digest = policyRegistry.hashPublication(policy, accounts, weights, nonce, deadline);
        vm.prank(safe);
        policyRegistry.publishPolicy(policy, accounts, weights, nonce, deadline, _sign(SECONDARY_KEY, digest));
    }
}
