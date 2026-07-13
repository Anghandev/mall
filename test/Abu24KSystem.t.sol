// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Abu24KPaymentEscrow} from "../contracts/Abu24KPaymentEscrow.sol";
import {Abu24KRewardLedger} from "../contracts/Abu24KRewardLedger.sol";
import {Abu24KSeckill} from "../contracts/Abu24KSeckill.sol";
import {BNMToken} from "../contracts/BNMToken.sol";
import {MockNPL} from "../contracts/MockNPL.sol";

contract ContractBuyer {
    function buy(Abu24KSeckill seckill, bytes32 sessionId, bytes32 orderId) external {
        seckill.recordPurchase(sessionId, orderId);
    }
}

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address) external;
    function prank(address, address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function txGasPrice(uint256 newGasPrice) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
    function chainId(uint256) external;
}

contract MiniTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(address actual, address expected) internal pure { require(actual == expected, "assert address eq failed"); }
    function assertEq(uint256 actual, uint256 expected) internal pure { require(actual == expected, "assert uint eq failed"); }
    function assertEq(bytes32 actual, bytes32 expected) internal pure { require(actual == expected, "assert bytes32 eq failed"); }
    function assertTrue(bool value) internal pure { require(value, "assert true failed"); }
}

contract Abu24KSystemTest is MiniTest {
    MockNPL npl;
    BNMToken bnm;
    Abu24KPaymentEscrow escrow;
    Abu24KRewardLedger ledger;
    Abu24KSeckill seckill;

    uint256 constant OWNER_KEY = 0xA11CE;
    address owner;
    address buyer = address(0xB0B);
    address seller = address(0x5E11E2);
    address attacker = address(0xBAD);
    address retainedNplReceiver = address(0xCAFE);
    address platformReceiver = address(0x1001);
    address regionReceiver = address(0x1002);
    address referralReceiver = address(0x1003);
    address prizePoolReceiver = address(0x1004);
    address burnReceiver = address(0x000000000000000000000000000000000000dEaD);
    address circulationReceiver = address(0x1006);
    bytes32 orderId = keccak256("24k-order-1");
    bytes32 productId = keccak256("p-24k-runner");
    bytes32 digest = keccak256("sku-address-region-digest");

    function setUp() public {
        owner = vm.addr(OWNER_KEY);
        npl = new MockNPL();
        bnm = new BNMToken(owner);
        ledger = new Abu24KRewardLedger(address(bnm), address(npl), owner);
        escrow = new Abu24KPaymentEscrow(address(npl), address(ledger), owner, retainedNplReceiver, owner);
        seckill = new Abu24KSeckill(address(npl), address(escrow), address(ledger), owner);

        vm.startPrank(owner);
        bnm.setMinter(address(ledger), true);
        ledger.setOperator(address(escrow), true);
        ledger.setOperator(address(seckill), true);
        escrow.setSeller(seller, true);
        escrow.setSplitConfig(_splitConfig());
        escrow.unpause();
        npl.approve(address(seckill), type(uint256).max);
        vm.stopPrank();

        npl.mint(owner, 10_000 ether);
        npl.mint(buyer, 1_000 ether);
        vm.prank(buyer);
        npl.approve(address(escrow), type(uint256).max);
    }

    function testSignedNplPaymentCompletesWithAtomicSplitAndRewardRelease() public {
        _pay(orderId, productId, 100 ether, 100 ether);
        assertEq(npl.balanceOf(address(escrow)), 100 ether);
        (,,,,, Abu24KRewardLedger.State lockedState) = ledger.entries(0);
        assertEq(uint256(lockedState), uint256(Abu24KRewardLedger.State.Locked));

        vm.prank(buyer);
        escrow.completeOrder(orderId);

        assertEq(npl.balanceOf(seller), 70 ether);
        assertEq(npl.balanceOf(platformReceiver), 10 ether);
        assertEq(npl.balanceOf(regionReceiver), 5 ether);
        assertEq(npl.balanceOf(referralReceiver), 5 ether);
        assertEq(npl.balanceOf(prizePoolReceiver), 5 ether);
        assertEq(npl.balanceOf(burnReceiver), 3 ether);
        assertEq(npl.balanceOf(circulationReceiver), 2 ether);
        assertEq(npl.balanceOf(address(escrow)), 0);
        (,,,,, Abu24KRewardLedger.State availableState) = ledger.entries(0);
        assertEq(uint256(availableState), uint256(Abu24KRewardLedger.State.Available));
    }

    function testOrderAuthorizationSellerWhitelistAndSplitVersionAreEnforced() public {
        uint64 deadline = uint64(block.timestamp + 30 minutes);
        bytes memory signature = _authorization(orderId, buyer, seller, productId, 100 ether, 100 ether, deadline, digest, 1);

        vm.prank(buyer);
        vm.expectRevert(Abu24KPaymentEscrow.InvalidOrderAuthorization.selector);
        escrow.payOrder(orderId, seller, productId, 101 ether, 100 ether, deadline, digest, 1, signature);

        address unapproved = address(0x5151);
        bytes memory unapprovedSignature = _authorization(orderId, buyer, unapproved, productId, 100 ether, 100 ether, deadline, digest, 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Abu24KPaymentEscrow.SellerNotApproved.selector, unapproved));
        escrow.payOrder(orderId, unapproved, productId, 100 ether, 100 ether, deadline, digest, 1, unapprovedSignature);

        vm.prank(owner);
        escrow.setSplitConfig(_splitConfig());
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Abu24KPaymentEscrow.InvalidSplitVersion.selector, 2, 1));
        escrow.payOrder(orderId, seller, productId, 100 ether, 100 ether, deadline, digest, 1, signature);
    }

    function testPauseBlocksPaymentAndEmergencyRefundBurnsRewardAtomically() public {
        _pay(orderId, productId, 100 ether, 100 ether);
        vm.prank(owner);
        escrow.pause();

        bytes32 order2 = keccak256("24k-order-2");
        uint64 deadline = uint64(block.timestamp + 30 minutes);
        uint32 splitVersion = escrow.currentSplitVersion();
        bytes memory signature = _authorization(order2, buyer, seller, productId, 10 ether, 10 ether, deadline, digest, splitVersion);
        vm.expectRevert();
        vm.prank(buyer);
        escrow.payOrder(order2, seller, productId, 10 ether, 10 ether, deadline, digest, splitVersion, signature);

        uint256 buyerBefore = npl.balanceOf(buyer);
        vm.prank(owner);
        escrow.emergencyRefund(orderId);
        assertEq(npl.balanceOf(buyer), buyerBefore + 100 ether);
        (,,,,, Abu24KRewardLedger.State state) = ledger.entries(0);
        assertEq(uint256(state), uint256(Abu24KRewardLedger.State.Burned));

        vm.prank(owner);
        escrow.unpause();
        _pay(order2, productId, 10 ether, 10 ether);
    }

    function testForceRefundRoutesRetentionAndBurnsUnclaimedReward() public {
        _pay(orderId, productId, 100 ether, 100 ether);
        uint256 buyerBefore = npl.balanceOf(buyer);
        vm.prank(owner);
        escrow.forceRefund(orderId, 70 ether);
        assertEq(npl.balanceOf(buyer), buyerBefore + 70 ether);
        assertEq(npl.balanceOf(retainedNplReceiver), 30 ether);
        (,,,,, Abu24KRewardLedger.State state) = ledger.entries(0);
        assertEq(uint256(state), uint256(Abu24KRewardLedger.State.Burned));
        (,,,,,,,, Abu24KPaymentEscrow.Status status) = escrow.orders(orderId);
        assertEq(uint256(status), uint256(Abu24KPaymentEscrow.Status.ForcedRefunded));
    }

    function testEscrowPermissionFailuresAndArbitrationOwnerRelease() public {
        _pay(orderId, productId, 100 ether, 100 ether);
        vm.prank(attacker);
        vm.expectRevert();
        escrow.completeOrder(orderId);
        vm.prank(attacker);
        vm.expectRevert();
        escrow.disputeOrder(orderId);
        vm.prank(attacker);
        vm.expectRevert();
        escrow.forceRefund(orderId, 100 ether);

        vm.prank(seller);
        escrow.disputeOrder(orderId);
        vm.prank(buyer);
        vm.expectRevert(Abu24KPaymentEscrow.NotParticipantOrOwner.selector);
        escrow.completeOrder(orderId);
        vm.prank(owner);
        escrow.completeOrder(orderId);
        assertEq(npl.balanceOf(seller), 70 ether);
    }

    function testEscrowAdminPermissionsAndRefundLimit() public {
        _pay(orderId, productId, 100 ether, 100 ether);
        vm.prank(attacker);
        vm.expectRevert();
        escrow.pause();
        vm.prank(owner);
        vm.expectRevert(Abu24KPaymentEscrow.RefundTooLarge.selector);
        escrow.forceRefund(orderId, 100 ether + 1);
        vm.prank(attacker);
        vm.expectRevert();
        escrow.setSeller(attacker, true);
        vm.prank(owner);
        vm.expectRevert(Abu24KPaymentEscrow.OwnershipRenounceDisabled.selector);
        escrow.renounceOwnership();
    }

    function testBscDeploymentsRejectWrongNplAddress() public {
        uint256 originalChainId = block.chainid;
        vm.chainId(56);
        vm.expectRevert(abi.encodeWithSelector(Abu24KPaymentEscrow.InvalidNplAddress.selector, address(npl)));
        new Abu24KPaymentEscrow(address(npl), address(ledger), owner, retainedNplReceiver, owner);
        vm.expectRevert(abi.encodeWithSelector(Abu24KRewardLedger.InvalidNplAddress.selector, address(npl)));
        new Abu24KRewardLedger(address(bnm), address(npl), owner);
        vm.expectRevert(abi.encodeWithSelector(Abu24KSeckill.InvalidNplAddress.selector, address(npl)));
        new Abu24KSeckill(address(npl), address(escrow), address(ledger), owner);
        vm.chainId(originalChainId);
    }

    function testRewardLedgerOperatorReleaseClaimAndRecoveryBurn() public {
        vm.prank(owner);
        ledger.setOperator(attacker, true);
        vm.prank(attacker);
        uint256 entryId = ledger.lockReward(buyer, orderId, address(bnm), 25 ether, 0);
        vm.prank(attacker);
        ledger.releaseOrderRewards(orderId);
        vm.prank(buyer);
        ledger.claim(entryId);
        assertEq(bnm.balanceOf(buyer), 25 ether);

        bytes32 refundOrder = keccak256("reward-refund");
        vm.prank(attacker);
        uint256 burnedId = ledger.lockReward(buyer, refundOrder, address(bnm), 10 ether, 0);
        vm.prank(attacker);
        ledger.burnOrderRewards(refundOrder);
        (,,,,, Abu24KRewardLedger.State state) = ledger.entries(burnedId);
        assertEq(uint256(state), uint256(Abu24KRewardLedger.State.Burned));
    }

    function testRewardLedgerOnlyAcceptsFundedNplAndBnm() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Abu24KRewardLedger.UnsupportedAsset.selector, attacker));
        ledger.lockReward(buyer, orderId, attacker, 1 ether, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Abu24KRewardLedger.InsufficientNplFunding.selector, 0, 1 ether));
        ledger.lockReward(buyer, orderId, address(npl), 1 ether, 0);

        npl.mint(address(ledger), 30 ether);
        vm.prank(owner);
        uint256 entryId = ledger.lockReward(buyer, orderId, address(npl), 30 ether, 1);
        assertEq(ledger.nplReserved(), 30 ether);
        vm.prank(owner);
        ledger.releaseOrderRewards(orderId);
        uint256 beforeBuyer = npl.balanceOf(buyer);
        vm.prank(buyer);
        ledger.claim(entryId);
        assertEq(npl.balanceOf(buyer), beforeBuyer + 30 ether);
        assertEq(ledger.nplReserved(), 0);
    }

    function testBnmPauseBlocksClaimAndUnpauseRestoresIt() public {
        vm.prank(owner);
        uint256 entryId = ledger.lockReward(buyer, orderId, address(bnm), 25 ether, 0);
        vm.prank(owner);
        ledger.releaseOrderRewards(orderId);
        vm.prank(owner);
        bnm.pause();
        vm.prank(buyer);
        vm.expectRevert();
        ledger.claim(entryId);
        vm.prank(owner);
        bnm.unpause();
        vm.prank(buyer);
        ledger.claim(entryId);
        assertEq(bnm.balanceOf(buyer), 25 ether);
    }

    function testLedgerPauseBlocksClaimButDoesNotTrapEscrowSettlement() public {
        _pay(orderId, productId, 100 ether, 100 ether);
        vm.prank(owner);
        ledger.pause();

        vm.prank(buyer);
        escrow.completeOrder(orderId);
        (,,,,, Abu24KRewardLedger.State availableState) = ledger.entries(0);
        assertEq(uint256(availableState), uint256(Abu24KRewardLedger.State.Available));
        assertEq(npl.balanceOf(address(escrow)), 0);

        vm.prank(buyer);
        vm.expectRevert();
        ledger.claim(0);
        vm.prank(owner);
        ledger.unpause();
        vm.prank(buyer);
        ledger.claim(0);
        assertEq(bnm.balanceOf(buyer), 100 ether);
    }

    function testSeckillOnlyRecordsUniquePaidMatchingOrdersAndReleasesFundedPrize() public {
        vm.prank(owner);
        bytes32 sessionId = seckill.startSession(productId, 2 hours, 1 hours, 30, 100 ether, 10 ether);
        _pay(orderId, productId, 100 ether, 100 ether);
        vm.warp(block.timestamp + 40);
        vm.prank(buyer, buyer);
        seckill.recordPurchase(sessionId, orderId);

        vm.prank(buyer, buyer);
        vm.expectRevert(abi.encodeWithSelector(Abu24KSeckill.OrderAlreadyRecorded.selector, orderId, sessionId));
        seckill.recordPurchase(sessionId, orderId);
        vm.prank(buyer, buyer);
        vm.expectRevert(Abu24KSeckill.InvalidPaidOrder.selector);
        seckill.recordPurchase(sessionId, keccak256("fake-order"));

        bytes32 cheapOrder = keccak256("cheap-order");
        _pay(cheapOrder, productId, 50 ether, 50 ether);
        vm.prank(buyer, buyer);
        vm.expectRevert(Abu24KSeckill.InvalidPaidOrder.selector);
        seckill.recordPurchase(sessionId, cheapOrder);

        ContractBuyer bot = new ContractBuyer();
        vm.expectRevert(Abu24KSeckill.ContractCallerBlocked.selector);
        bot.buy(seckill, sessionId, keccak256("bot-order"));

        vm.prank(owner);
        seckill.pause();
        vm.prank(owner);
        seckill.forceClose(sessionId);
        vm.prank(owner);
        seckill.settle(sessionId);

        uint256 prizeEntryId = ledger.entryCount() - 1;
        (address prizeUser, bytes32 rewardOrderId, address prizeAsset, uint256 prizeAmount, uint8 bucket, Abu24KRewardLedger.State prizeState) = ledger.entries(prizeEntryId);
        assertEq(prizeUser, buyer);
        assertEq(prizeAsset, address(npl));
        assertEq(prizeAmount, 10 ether);
        assertEq(uint256(bucket), uint256(seckill.SECKILL_PRIZE_BUCKET()));
        assertEq(uint256(prizeState), uint256(Abu24KRewardLedger.State.Available));
        assertTrue(rewardOrderId != orderId);
        (,,,,, Abu24KRewardLedger.State purchaseRewardState) = ledger.entries(0);
        assertEq(uint256(purchaseRewardState), uint256(Abu24KRewardLedger.State.Locked));
    }

    function testSeckillPrizeReleasedPrecedesRewardLedgerLogs() public {
        vm.prank(owner);
        bytes32 sessionId = seckill.startSession(productId, 2 hours, 1 hours, 30, 100 ether, 10 ether);
        _pay(orderId, productId, 100 ether, 100 ether);
        vm.prank(buyer, buyer);
        seckill.recordPurchase(sessionId, orderId);
        vm.prank(owner);
        seckill.forceClose(sessionId);

        vm.recordLogs();
        vm.prank(owner);
        seckill.settle(sessionId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 prizeReleasedTopic = keccak256("SeckillPrizeReleased(bytes32,bytes32,address,uint256)");
        bytes32 rewardLockedTopic = keccak256("RewardLocked(uint256,bytes32,address,address,uint256,uint8)");
        bytes32 rewardReleasedTopic = keccak256("RewardReleased(uint256,bytes32)");
        uint256 prizeReleasedIndex = type(uint256).max;
        uint256 rewardLockedIndex = type(uint256).max;
        uint256 rewardReleasedIndex = type(uint256).max;

        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].emitter == address(seckill) && logs[i].topics[0] == prizeReleasedTopic) prizeReleasedIndex = i;
            if (logs[i].emitter == address(ledger) && logs[i].topics[0] == rewardLockedTopic) rewardLockedIndex = i;
            if (logs[i].emitter == address(ledger) && logs[i].topics[0] == rewardReleasedTopic) rewardReleasedIndex = i;
        }

        assertTrue(prizeReleasedIndex != type(uint256).max);
        assertTrue(rewardLockedIndex != type(uint256).max);
        assertTrue(rewardReleasedIndex != type(uint256).max);
        bytes32 rewardOrderId = keccak256(abi.encodePacked("24K_SECKILL_PRIZE", sessionId));
        assertEq(logs[prizeReleasedIndex].topics[1], sessionId);
        assertEq(logs[prizeReleasedIndex].topics[2], rewardOrderId);
        assertEq(logs[rewardLockedIndex].topics[2], rewardOrderId);
        assertEq(logs[rewardReleasedIndex].topics[2], rewardOrderId);
        assertEq(logs[rewardLockedIndex].topics[1], logs[rewardReleasedIndex].topics[1]);
        assertTrue(prizeReleasedIndex < rewardLockedIndex);
        assertTrue(rewardLockedIndex < rewardReleasedIndex);
    }

    function testSeckillSettlementFailureRollsBackStateAfterEarlyPrizeEvent() public {
        vm.prank(owner);
        bytes32 sessionId = seckill.startSession(productId, 2 hours, 1 hours, 30, 100 ether, 10 ether);
        _pay(orderId, productId, 100 ether, 100 ether);
        vm.prank(buyer, buyer);
        seckill.recordPurchase(sessionId, orderId);
        vm.prank(owner);
        seckill.forceClose(sessionId);

        uint256 seckillBalanceBefore = npl.balanceOf(address(seckill));
        uint256 ledgerBalanceBefore = npl.balanceOf(address(ledger));
        uint256 entryCountBefore = ledger.entryCount();
        vm.prank(owner);
        ledger.pause();

        vm.expectRevert();
        vm.prank(owner);
        seckill.settle(sessionId);

        (,,,,,,,,,,, Abu24KSeckill.Status status) = seckill.sessions(sessionId);
        assertEq(uint256(status), uint256(Abu24KSeckill.Status.ForceClosed));
        assertEq(npl.balanceOf(address(seckill)), seckillBalanceBefore);
        assertEq(npl.balanceOf(address(ledger)), ledgerBalanceBefore);
        assertEq(ledger.entryCount(), entryCountBefore);
    }

    function testSeckillMaxGasPriceConfigIsOwnerOnlyAndEmits() public {
        uint256 limit = 5 gwei;
        assertEq(seckill.maxGasPriceWei(), 0);

        vm.prank(attacker);
        vm.expectRevert();
        seckill.setMaxGasPriceWei(limit);
        assertEq(seckill.maxGasPriceWei(), 0);

        vm.recordLogs();
        vm.prank(owner);
        seckill.setMaxGasPriceWei(limit);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(seckill.maxGasPriceWei(), limit);
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(seckill));
        assertEq(logs[0].topics[0], keccak256("MaxGasPriceUpdated(uint256,uint256)"));
        assertEq(keccak256(logs[0].data), keccak256(abi.encode(uint256(0), limit)));
    }

    function testSeckillGasPriceLimitRejectsAboveLimitAndAllowsAtLimit() public {
        uint256 limit = 5 gwei;
        vm.prank(owner);
        seckill.setMaxGasPriceWei(limit);
        vm.prank(owner);
        bytes32 sessionId = seckill.startSession(productId, 2 hours, 1 hours, 30, 100 ether, 10 ether);
        _pay(orderId, productId, 100 ether, 100 ether);

        vm.txGasPrice(limit + 1);
        vm.expectRevert(abi.encodeWithSelector(Abu24KSeckill.GasPriceTooHigh.selector, limit + 1, limit));
        vm.prank(buyer, buyer);
        seckill.recordPurchase(sessionId, orderId);
        assertEq(seckill.orderSession(orderId), bytes32(0));

        vm.txGasPrice(limit);
        vm.prank(buyer, buyer);
        seckill.recordPurchase(sessionId, orderId);
        assertEq(seckill.orderSession(orderId), sessionId);
    }

    function testSeckillZeroMaxGasPriceDisablesCheck() public {
        vm.prank(owner);
        bytes32 sessionId = seckill.startSession(productId, 2 hours, 1 hours, 30, 100 ether, 10 ether);
        _pay(orderId, productId, 100 ether, 100 ether);

        vm.txGasPrice(1_000 gwei);
        vm.prank(buyer, buyer);
        seckill.recordPurchase(sessionId, orderId);
        assertEq(seckill.orderSession(orderId), sessionId);
    }

    function testSeckillNoBuyerSettlementRefundsPrizePool() public {
        uint256 ownerBefore = npl.balanceOf(owner);
        vm.prank(owner);
        bytes32 sessionId = seckill.startSession(productId, 2 hours, 1 minutes, 30, 100 ether, 7 ether);
        vm.warp(block.timestamp + 2 minutes);
        vm.prank(owner);
        seckill.settle(sessionId);
        assertEq(npl.balanceOf(owner), ownerBefore);
    }

    function _splitConfig() internal view returns (Abu24KPaymentEscrow.SplitConfig memory) {
        return Abu24KPaymentEscrow.SplitConfig({
            platformReceiver: platformReceiver,
            regionReceiver: regionReceiver,
            referralReceiver: referralReceiver,
            prizePoolReceiver: prizePoolReceiver,
            burnReceiver: burnReceiver,
            circulationReceiver: circulationReceiver,
            merchantBps: 7000,
            platformBps: 1000,
            regionBps: 500,
            referralBps: 500,
            prizePoolBps: 500,
            burnBps: 300,
            circulationBps: 200
        });
    }

    function _pay(bytes32 id, bytes32 product, uint256 amount, uint256 bnmAmount) internal {
        uint64 deadline = uint64(block.timestamp + 30 minutes);
        uint32 splitVersion = escrow.currentSplitVersion();
        bytes memory signature = _authorization(id, buyer, seller, product, amount, bnmAmount, deadline, digest, splitVersion);
        vm.prank(buyer);
        escrow.payOrder(id, seller, product, amount, bnmAmount, deadline, digest, splitVersion, signature);
    }

    function _authorization(
        bytes32 id,
        address authorizedBuyer,
        address authorizedSeller,
        bytes32 product,
        uint256 amount,
        uint256 bnmAmount,
        uint64 deadline,
        bytes32 orderDigest,
        uint32 splitVersion
    ) internal returns (bytes memory) {
        bytes32 authDigest = escrow.orderAuthorizationDigest(id, authorizedBuyer, authorizedSeller, product, amount, bnmAmount, deadline, orderDigest, splitVersion);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, authDigest);
        return abi.encodePacked(r, s, v);
    }
}
