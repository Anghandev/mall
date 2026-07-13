// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Abu24KPaymentEscrow} from "../contracts/Abu24KPaymentEscrow.sol";
import {Abu24KRewardLedger} from "../contracts/Abu24KRewardLedger.sol";
import {BNMToken} from "../contracts/BNMToken.sol";
import {MockERC20} from "../contracts/MockERC20.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address caller) external;
    function startPrank(address caller) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function chainId(uint256 chainId_) external;
}

contract MiniTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertTrue(bool value) internal pure {
        require(value, "expected true");
    }
}

contract Abu24KMerchantSettlementTest is MiniTest {
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant BUYER_KEY = 0xB0B;

    MockERC20 internal usdt;
    MockERC20 internal npl;
    BNMToken internal bnm;
    Abu24KRewardLedger internal rewards;
    Abu24KPaymentEscrow internal escrow;

    address internal owner;
    address internal buyer;
    address internal seller = address(0x5E11E2);
    address internal settlementOperator = address(0x5E771E);
    address internal attacker = address(0xBAD);
    address internal platformReceiver = address(0x1001);
    address internal regionReceiver = address(0x1002);
    address internal referralReceiver = address(0x1003);
    address internal prizePoolReceiver = address(0x1004);
    bytes32 internal productId = keccak256("merchant-only-product");
    bytes32 internal orderDigest = keccak256("sku-address-region-policy-v2");

    function setUp() public {
        owner = vm.addr(OWNER_KEY);
        buyer = vm.addr(BUYER_KEY);
        usdt = new MockERC20("Mock USDT", "USDT");
        npl = new MockERC20("Mock NPL", "NPL");
        bnm = new BNMToken(owner);
        rewards = new Abu24KRewardLedger(address(bnm), address(npl), owner);
        escrow = new Abu24KPaymentEscrow(address(usdt), address(rewards), owner, owner);

        vm.startPrank(owner);
        bnm.setMinter(address(rewards), true);
        rewards.setOperator(address(escrow), true);
        rewards.unpauseRewardClaims();
        escrow.setSeller(seller, true);
        escrow.setSettlementOperator(settlementOperator, true);
        escrow.setSplitConfig(_splitConfig());
        escrow.setOrdersPaused(false);
        escrow.setMerchantClaimsPaused(false);
        vm.stopPrank();

        usdt.mint(buyer, 1_000 ether);
        vm.prank(buyer);
        usdt.approve(address(escrow), type(uint256).max);
    }

    function testUsdtSettlementAccruesBeforeMerchantPullClaim() public {
        bytes32 orderId = keccak256("order-1");
        _pay(orderId, 100 ether, 100 ether);
        assertEq(usdt.balanceOf(address(escrow)), 100 ether);
        (,,,,, Abu24KRewardLedger.State lockedState) = rewards.entries(0);
        assertEq(uint256(lockedState), uint256(Abu24KRewardLedger.State.Locked));

        vm.prank(settlementOperator);
        escrow.completeOrder(orderId);

        assertEq(usdt.balanceOf(seller), 0);
        assertEq(escrow.claimableProceeds(seller), 70 ether);
        assertEq(escrow.totalOutstandingProceeds(), 70 ether);
        assertEq(usdt.balanceOf(address(escrow)), 70 ether);
        assertEq(usdt.balanceOf(platformReceiver), 10 ether);
        assertEq(usdt.balanceOf(regionReceiver), 7 ether);
        assertEq(usdt.balanceOf(referralReceiver), 5 ether);
        assertEq(usdt.balanceOf(prizePoolReceiver), 8 ether);
        (,,,,, Abu24KRewardLedger.State availableState) = rewards.entries(0);
        assertEq(uint256(availableState), uint256(Abu24KRewardLedger.State.Available));

        vm.prank(seller);
        escrow.claimMerchantProceeds();
        assertEq(usdt.balanceOf(seller), 70 ether);
        assertEq(escrow.claimableProceeds(seller), 0);
        assertEq(escrow.totalOutstandingProceeds(), 0);
        assertEq(escrow.totalProceedsClaimed(), 70 ether);

        vm.prank(seller);
        vm.expectRevert(Abu24KPaymentEscrow.NoClaimableProceeds.selector);
        escrow.claimMerchantProceeds();
    }

    function testMultipleOrdersAggregateIntoOneMerchantClaim() public {
        _pay(keccak256("aggregate-1"), 100 ether, 100 ether);
        _pay(keccak256("aggregate-2"), 50 ether, 50 ether);
        vm.prank(settlementOperator);
        escrow.completeOrder(keccak256("aggregate-1"));
        vm.prank(settlementOperator);
        escrow.completeOrder(keccak256("aggregate-2"));
        assertEq(escrow.claimableProceeds(seller), 105 ether);
        assertEq(escrow.totalProceedsAccrued(), 105 ether);

        vm.prank(seller);
        escrow.claimMerchantProceeds();
        assertEq(usdt.balanceOf(seller), 105 ether);
    }

    function testOrdersPauseBlocksNewPaymentButAllowsRecovery() public {
        bytes32 paidOrder = keccak256("paid-before-pause");
        _pay(paidOrder, 100 ether, 100 ether);
        vm.prank(owner);
        escrow.setOrdersPaused(true);

        bytes32 blockedOrder = keccak256("blocked-order");
        uint64 deadline = uint64(block.timestamp + 30 minutes);
        bytes memory signature = _authorization(blockedOrder, 10 ether, 10 ether, deadline);
        vm.prank(buyer);
        vm.expectRevert(Abu24KPaymentEscrow.OrdersArePaused.selector);
        escrow.payOrder(blockedOrder, seller, productId, 10 ether, 10 ether, deadline, orderDigest, 1, signature);

        vm.prank(settlementOperator);
        escrow.completeOrder(paidOrder);
        assertEq(escrow.claimableProceeds(seller), 70 ether);

        vm.prank(owner);
        escrow.setOrdersPaused(false);
        _pay(blockedOrder, 10 ether, 10 ether);
    }

    function testMerchantClaimPauseDoesNotBlockRewardClaim() public {
        bytes32 orderId = keccak256("merchant-claim-pause");
        _pay(orderId, 100 ether, 100 ether);
        vm.prank(settlementOperator);
        escrow.completeOrder(orderId);

        vm.prank(owner);
        escrow.setMerchantClaimsPaused(true);
        vm.prank(seller);
        vm.expectRevert(Abu24KPaymentEscrow.MerchantClaimsArePaused.selector);
        escrow.claimMerchantProceeds();

        vm.prank(buyer);
        rewards.claim(0);
        assertEq(bnm.balanceOf(buyer), 100 ether);

        vm.prank(owner);
        escrow.setMerchantClaimsPaused(false);
        vm.prank(seller);
        escrow.claimMerchantProceeds();
        assertEq(usdt.balanceOf(seller), 70 ether);
    }

    function testRewardClaimPauseDoesNotBlockSettlementOrMerchantClaim() public {
        bytes32 orderId = keccak256("reward-claim-pause");
        _pay(orderId, 100 ether, 100 ether);
        vm.prank(owner);
        rewards.pauseRewardClaims();

        vm.prank(settlementOperator);
        escrow.completeOrder(orderId);
        vm.prank(seller);
        escrow.claimMerchantProceeds();
        assertEq(usdt.balanceOf(seller), 70 ether);

        vm.prank(buyer);
        vm.expectRevert(Abu24KRewardLedger.RewardClaimsArePaused.selector);
        rewards.claim(0);
        vm.prank(owner);
        rewards.unpauseRewardClaims();
        vm.prank(buyer);
        rewards.claim(0);
        assertEq(bnm.balanceOf(buyer), 100 ether);
    }

    function testForceRefundReturnsUsdtAndBurnsLockedBnm() public {
        bytes32 orderId = keccak256("forced-refund");
        _pay(orderId, 100 ether, 100 ether);
        uint256 buyerBefore = usdt.balanceOf(buyer);
        vm.prank(owner);
        escrow.forceRefund(orderId);
        assertEq(usdt.balanceOf(buyer), buyerBefore + 100 ether);
        (,,,,, Abu24KRewardLedger.State state) = rewards.entries(0);
        assertEq(uint256(state), uint256(Abu24KRewardLedger.State.Burned));
        (,,,,,,,, Abu24KPaymentEscrow.Status status) = escrow.orders(orderId);
        assertEq(uint256(status), uint256(Abu24KPaymentEscrow.Status.ForcedRefunded));
    }

    function testEmergencyRefundRequiresOrdersPause() public {
        bytes32 orderId = keccak256("emergency-refund");
        _pay(orderId, 100 ether, 100 ether);
        vm.prank(owner);
        vm.expectRevert(Abu24KPaymentEscrow.OrdersNotPaused.selector);
        escrow.emergencyRefund(orderId);

        vm.prank(owner);
        escrow.setOrdersPaused(true);
        uint256 buyerBefore = usdt.balanceOf(buyer);
        vm.prank(owner);
        escrow.emergencyRefund(orderId);
        assertEq(usdt.balanceOf(buyer), buyerBefore + 100 ether);
    }

    function testAuthorizationWhitelistVersionAndReplayAreEnforced() public {
        bytes32 orderId = keccak256("auth-order");
        uint64 deadline = uint64(block.timestamp + 30 minutes);
        bytes memory signature = _authorization(orderId, 100 ether, 100 ether, deadline);

        vm.prank(buyer);
        vm.expectRevert(Abu24KPaymentEscrow.InvalidOrderAuthorization.selector);
        escrow.payOrder(orderId, seller, productId, 101 ether, 100 ether, deadline, orderDigest, 1, signature);

        address unapprovedSeller = address(0x5151);
        bytes32 unapprovedOrder = keccak256("unapproved-order");
        bytes memory unapprovedSignature = _authorizationFor(unapprovedOrder, unapprovedSeller, 10 ether, 10 ether, deadline, 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Abu24KPaymentEscrow.SellerNotApproved.selector, unapprovedSeller));
        escrow.payOrder(unapprovedOrder, unapprovedSeller, productId, 10 ether, 10 ether, deadline, orderDigest, 1, unapprovedSignature);

        vm.prank(buyer);
        escrow.payOrder(orderId, seller, productId, 100 ether, 100 ether, deadline, orderDigest, 1, signature);
        vm.prank(buyer);
        vm.expectRevert();
        escrow.payOrder(orderId, seller, productId, 100 ether, 100 ether, deadline, orderDigest, 1, signature);

        vm.prank(owner);
        escrow.setSplitConfig(_splitConfig());
        bytes32 staleOrder = keccak256("stale-version");
        bytes memory staleSignature = _authorizationFor(staleOrder, seller, 10 ether, 10 ether, deadline, 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Abu24KPaymentEscrow.InvalidSplitVersion.selector, 2, 1));
        escrow.payOrder(staleOrder, seller, productId, 10 ether, 10 ether, deadline, orderDigest, 1, staleSignature);
    }

    function testArbitrationRequiresOwnerEvenForSettlementOperator() public {
        bytes32 orderId = keccak256("arbitration-order");
        _pay(orderId, 100 ether, 100 ether);
        vm.prank(seller);
        escrow.disputeOrder(orderId);

        vm.prank(settlementOperator);
        vm.expectRevert(Abu24KPaymentEscrow.NotParticipantOperatorOrOwner.selector);
        escrow.completeOrder(orderId);
        vm.prank(owner);
        escrow.completeOrder(orderId);
        assertEq(escrow.claimableProceeds(seller), 70 ether);
    }

    function testNplRewardsRemainSeparateFromUsdtProceeds() public {
        bytes32 rewardOrder = keccak256("npl-store-reward");
        npl.mint(address(rewards), 25 ether);
        vm.prank(owner);
        uint256 entryId = rewards.lockReward(seller, rewardOrder, address(npl), 25 ether, 1);
        vm.prank(owner);
        rewards.releaseOrderRewards(rewardOrder);
        vm.prank(seller);
        rewards.claim(entryId);

        assertEq(npl.balanceOf(seller), 25 ether);
        assertEq(usdt.balanceOf(seller), 0);
        assertEq(escrow.claimableProceeds(seller), 0);
    }

    function testOnlyOwnerCanChangeCircuitBreakersAndRenounceIsDisabled() public {
        vm.prank(attacker);
        vm.expectRevert();
        escrow.setOrdersPaused(true);
        vm.prank(attacker);
        vm.expectRevert();
        escrow.setMerchantClaimsPaused(true);
        vm.prank(attacker);
        vm.expectRevert();
        rewards.pauseRewardClaims();
        vm.prank(owner);
        vm.expectRevert(Abu24KPaymentEscrow.OwnershipRenounceDisabled.selector);
        escrow.renounceOwnership();
    }

    function testBscRejectsWrongUsdtAndNplAddresses() public {
        uint256 originalChainId = block.chainid;
        vm.chainId(56);
        vm.expectRevert(abi.encodeWithSelector(Abu24KPaymentEscrow.InvalidUsdtAddress.selector, address(usdt)));
        new Abu24KPaymentEscrow(address(usdt), address(rewards), owner, owner);
        vm.expectRevert(abi.encodeWithSelector(Abu24KRewardLedger.InvalidNplAddress.selector, address(npl)));
        new Abu24KRewardLedger(address(bnm), address(npl), owner);
        vm.chainId(originalChainId);
    }

    function _splitConfig() internal view returns (Abu24KPaymentEscrow.SplitConfig memory) {
        return Abu24KPaymentEscrow.SplitConfig({
            platformReceiver: platformReceiver,
            regionReceiver: regionReceiver,
            referralReceiver: referralReceiver,
            prizePoolReceiver: prizePoolReceiver,
            merchantBps: 7000,
            platformBps: 1000,
            regionBps: 700,
            referralBps: 500,
            prizePoolBps: 800
        });
    }

    function _pay(bytes32 orderId, uint256 paymentAmount, uint256 bnmLocked) internal {
        uint64 deadline = uint64(block.timestamp + 30 minutes);
        uint32 splitVersion = escrow.currentSplitVersion();
        bytes memory signature = _authorizationFor(orderId, seller, paymentAmount, bnmLocked, deadline, splitVersion);
        vm.prank(buyer);
        escrow.payOrder(
            orderId,
            seller,
            productId,
            paymentAmount,
            bnmLocked,
            deadline,
            orderDigest,
            splitVersion,
            signature
        );
    }

    function _authorization(bytes32 orderId, uint256 paymentAmount, uint256 bnmLocked, uint64 deadline)
        internal
        returns (bytes memory)
    {
        return _authorizationFor(orderId, seller, paymentAmount, bnmLocked, deadline, escrow.currentSplitVersion());
    }

    function _authorizationFor(
        bytes32 orderId,
        address authorizedSeller,
        uint256 paymentAmount,
        uint256 bnmLocked,
        uint64 deadline,
        uint32 splitVersion
    ) internal returns (bytes memory) {
        bytes32 digest = escrow.orderAuthorizationDigest(
            orderId,
            buyer,
            authorizedSeller,
            productId,
            paymentAmount,
            bnmLocked,
            deadline,
            orderDigest,
            splitVersion
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}
