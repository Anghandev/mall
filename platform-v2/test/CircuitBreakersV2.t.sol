// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {ClaimVaultV2} from "../contracts/ClaimVaultV2.sol";
import {PaymentEscrowV2} from "../contracts/PaymentEscrowV2.sol";
import {RewardLedgerV2} from "../contracts/RewardLedgerV2.sol";
import {MerchantGuaranteeVaultV2} from "../contracts/MerchantGuaranteeVaultV2.sol";
import {SeckillV2} from "../contracts/SeckillV2.sol";
import {
    IBeneficiaryRegistryV2,
    IClaimVaultV2,
    IMerchantGuaranteeVaultV2,
    IPolicyRegistryV2,
    IRewardLedgerV2,
    ITwapOracleV2
} from "../contracts/interfaces/IV2Core.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract CircuitBreakersV2Test is CoreFixture {
    bytes32 private constant SESSION_ID = keccak256("session-1");

    function testNewOrderPauseBlocksOnlyNewOrdersAndAllowsFulfillmentAndReconciliation() public {
        bytes32 existingOrderId = keccak256("existing-before-pause");
        _payOrder(_makeOrder(existingOrderId, buyer, 200, false), BUYER_KEY);
        vm.prank(safe);
        paymentEscrow.setNewOrdersPause(true, keccak256("order-pause"));

        V2Types.OrderIntent memory blocked = _makeOrder(keccak256("blocked-by-pause"), buyer, 201, false);
        bytes32 digest = paymentEscrow.hashOrder(blocked);
        bytes memory quoteSignature = _sign(QUOTE_KEY, digest);
        bytes memory buyerSignature = _sign(BUYER_KEY, digest);
        vm.expectRevert(PaymentEscrowV2.NewOrdersPaused.selector);
        paymentEscrow.payOrder(blocked, quoteSignature, buyerSignature);

        vm.prank(safe);
        paymentEscrow.recordReconciliationEvidence(existingOrderId, keccak256("reconciliation"));
        _fulfillByCustomer(existingOrderId, 200);
        assertEq(claimVault.bnmClaimable(buyer), 100 ether);

        vm.prank(safe);
        paymentEscrow.setNewOrdersPause(false, keccak256("order-resume"));
        _payOrder(blocked, BUYER_KEY);
        assertEq(uint256(paymentEscrow.getOrder(blocked.orderId).state), uint256(V2Types.OrderState.Paid));
    }

    function testNewOrderPauseDoesNotBlockTakeoverRecovery() public {
        bytes32 orderId = keccak256("takeover-during-pause");
        _payOrder(_makeOrder(orderId, buyer, 202, false), BUYER_KEY);
        vm.prank(safe);
        paymentEscrow.setNewOrdersPause(true, keccak256("order-pause"));
        vm.warp(block.timestamp + 7 days + 1);
        paymentEscrow.openTakeover(orderId, keccak256("takeover-evidence"));
        assertEq(uint256(paymentEscrow.getOrder(orderId).state), uint256(V2Types.OrderState.Takeover));
    }

    function testMerchantClaimPauseIsIndependentFromRewardClaim() public {
        bytes32 orderId = keccak256("merchant-claim-pause");
        _payOrder(_makeOrder(orderId, buyer, 203, false), BUYER_KEY);
        _fulfillByCustomer(orderId, 203);

        V2Types.ClaimIntent memory merchantIntent =
            _claimIntent(merchant, V2Types.ClaimRail.MerchantUsdt, address(usdt), 30 ether, 203);
        bytes memory merchantSignature = _sign(MERCHANT_KEY, claimVault.hashClaim(merchantIntent));
        vm.prank(safe);
        claimVault.setClaimPause(V2Types.ClaimRail.MerchantUsdt, true, keccak256("merchant-claim-pause"));
        vm.expectRevert(ClaimVaultV2.ClaimPaused.selector);
        claimVault.claim(merchantIntent, merchantSignature);

        V2Types.ClaimIntent memory bnmIntent = _claimIntent(buyer, V2Types.ClaimRail.Bnm, address(bnm), 100 ether, 204);
        claimVault.claim(bnmIntent, _sign(BUYER_KEY, claimVault.hashClaim(bnmIntent)));
        assertEq(bnm.balanceOf(buyer), 100 ether);

        vm.prank(safe);
        claimVault.setClaimPause(V2Types.ClaimRail.MerchantUsdt, false, keccak256("merchant-claim-resume"));
        claimVault.claim(merchantIntent, merchantSignature);
        assertEq(claimVault.merchantClaimable(merchant), 0);
    }

    function testRewardClaimPauseBlocksNplAndBnmButNotMerchant() public {
        bytes32 orderId = keccak256("reward-claim-pause");
        _payOrder(_makeOrder(orderId, buyer, 205, false), BUYER_KEY);
        _fulfillByCustomer(orderId, 205);
        vm.prank(safe);
        claimVault.setClaimPause(V2Types.ClaimRail.RewardNpl, true, keccak256("reward-pause"));

        V2Types.ClaimIntent memory rewardIntent =
            _claimIntent(directReferral, V2Types.ClaimRail.RewardNpl, address(npl), 10 ether, 205);
        bytes memory rewardSignature = _sign(DIRECT_REFERRAL_KEY, claimVault.hashClaim(rewardIntent));
        vm.expectRevert(ClaimVaultV2.ClaimPaused.selector);
        claimVault.claim(rewardIntent, rewardSignature);

        V2Types.ClaimIntent memory bnmIntent = _claimIntent(buyer, V2Types.ClaimRail.Bnm, address(bnm), 100 ether, 206);
        bytes memory bnmSignature = _sign(BUYER_KEY, claimVault.hashClaim(bnmIntent));
        vm.expectRevert(ClaimVaultV2.ClaimPaused.selector);
        claimVault.claim(bnmIntent, bnmSignature);

        V2Types.ClaimIntent memory merchantIntent =
            _claimIntent(merchant, V2Types.ClaimRail.MerchantUsdt, address(usdt), 30 ether, 207);
        claimVault.claim(merchantIntent, _sign(MERCHANT_KEY, claimVault.hashClaim(merchantIntent)));
        assertEq(claimVault.merchantClaimable(merchant), 0);
    }

    function testSeckillPurchaseAndSettlementBreakersAreIndependent() public {
        _createSession(208);
        V2Types.SeckillIntent memory intent = _makeSeckillIntent(keccak256("breaker-seckill"), 208);
        bytes32 purchaseDigest = seckill.hashPurchase(intent);
        bytes memory quoteSignature = _sign(QUOTE_KEY, purchaseDigest);
        bytes memory buyerSignature = _sign(BUYER_KEY, purchaseDigest);

        vm.prank(safe);
        seckill.setPurchasePause(true, keccak256("purchase-pause"));
        vm.expectRevert(SeckillV2.PurchasesPaused.selector);
        seckill.buy(intent, quoteSignature, buyerSignature);
        vm.prank(safe);
        seckill.setPurchasePause(false, keccak256("purchase-resume"));
        seckill.buy(intent, quoteSignature, buyerSignature);

        vm.warp(seckill.getSession(SESSION_ID).relayDeadline + 5 minutes);
        vm.prank(safe);
        seckill.setSettlementPause(true, keccak256("settlement-pause"));
        vm.prank(safe);
        vm.expectRevert(SeckillV2.SettlementPaused.selector);
        seckill.settle(SESSION_ID);
        assertEq(claimVault.prizeClaimable(buyer), 0);

        vm.prank(safe);
        seckill.setSettlementPause(false, keccak256("settlement-resume"));
        vm.prank(safe);
        seckill.settle(SESSION_ID);
        assertEq(claimVault.prizeClaimable(buyer), 10 ether);
    }

    function testPrizeClaimPauseDoesNotBlockBnmClaim() public {
        _createSession(209);
        V2Types.SeckillIntent memory purchase = _makeSeckillIntent(keccak256("prize-pause"), 209);
        bytes32 orderId = purchase.seckillOrder.orderId;
        _buy(purchase);
        vm.warp(seckill.getSession(SESSION_ID).relayDeadline + 5 minutes);
        vm.prank(safe);
        seckill.settle(SESSION_ID);
        _fulfillByCustomer(orderId, 209);

        vm.prank(safe);
        claimVault.setClaimPause(V2Types.ClaimRail.PrizeUsdt, true, keccak256("prize-claim-pause"));
        V2Types.ClaimIntent memory prizeIntent =
            _claimIntent(buyer, V2Types.ClaimRail.PrizeUsdt, address(usdt), 10 ether, 209);
        bytes memory prizeSignature = _sign(BUYER_KEY, claimVault.hashClaim(prizeIntent));
        vm.expectRevert(ClaimVaultV2.ClaimPaused.selector);
        claimVault.claim(prizeIntent, prizeSignature);

        V2Types.ClaimIntent memory bnmIntent = _claimIntent(buyer, V2Types.ClaimRail.Bnm, address(bnm), 100 ether, 210);
        claimVault.claim(bnmIntent, _sign(BUYER_KEY, claimVault.hashClaim(bnmIntent)));
        assertEq(bnm.balanceOf(buyer), 100 ether);
    }

    function testFrozenMerchantCanStillClaimPrizeWonAsBuyer() public {
        bytes32 orderId = keccak256("freeze-merchant-for-prize");
        _payOrder(_makeOrder(orderId, buyer, 211, false), BUYER_KEY);
        vm.warp(block.timestamp + 7 days + 1);
        paymentEscrow.openTakeover(orderId, keccak256("freeze-before-prize"));

        vm.startPrank(safe);
        claimVault.grantRole(claimVault.PRIZE_CREDITOR_ROLE(), address(this));
        vm.stopPrank();
        usdt.mint(address(this), 10 ether);
        usdt.approve(address(claimVault), 10 ether);
        claimVault.depositPrize(keccak256("merchant-won-session"), merchant, 10 ether);

        V2Types.ClaimIntent memory prizeIntent =
            _claimIntent(merchant, V2Types.ClaimRail.PrizeUsdt, address(usdt), 10 ether, 211);
        uint256 balanceBefore = usdt.balanceOf(merchant);
        claimVault.claim(prizeIntent, _sign(MERCHANT_KEY, claimVault.hashClaim(prizeIntent)));
        assertEq(usdt.balanceOf(merchant) - balanceBefore, 10 ether);
        assertTrue(claimVault.merchantFrozen(merchant));
    }

    function testPauseAndResumeRequireSafeRole() public {
        vm.expectRevert();
        paymentEscrow.setNewOrdersPause(true, keccak256("unauthorized"));
        vm.expectRevert();
        claimVault.setClaimPause(V2Types.ClaimRail.MerchantUsdt, true, keccak256("unauthorized"));
        vm.expectRevert();
        seckill.setPurchasePause(true, keccak256("unauthorized"));
    }

    function testGrantedPauseRoleStillRequiresActualSafe() public {
        vm.startPrank(safe);
        paymentEscrow.grantRole(paymentEscrow.PAUSER_ROLE(), address(this));
        claimVault.grantRole(claimVault.PAUSER_ROLE(), address(this));
        seckill.grantRole(seckill.PAUSER_ROLE(), address(this));
        vm.stopPrank();

        vm.expectRevert(PaymentEscrowV2.SafeExecutionRequired.selector);
        paymentEscrow.setNewOrdersPause(true, keccak256("wrong-caller"));
        vm.expectRevert(ClaimVaultV2.SafeExecutionRequired.selector);
        claimVault.setClaimPause(V2Types.ClaimRail.MerchantUsdt, true, keccak256("wrong-caller"));
        vm.expectRevert(SeckillV2.SafeExecutionRequired.selector);
        seckill.setPurchasePause(true, keccak256("wrong-caller"));
        assertFalse(paymentEscrow.newOrdersPaused());
        assertFalse(claimVault.merchantClaimsPaused());
        assertFalse(seckill.purchasesPaused());
    }

    function testGrantedRecoveryRoleStillRequiresActualSafeAndSafeCanRecoverOnlySurplus() public {
        vm.startPrank(safe);
        paymentEscrow.grantRole(paymentEscrow.RECOVERY_ROLE(), address(this));
        claimVault.grantRole(claimVault.RECOVERY_ROLE(), address(this));
        rewardLedger.grantRole(rewardLedger.RECOVERY_ROLE(), address(this));
        guaranteeVault.grantRole(guaranteeVault.RECOVERY_ROLE(), address(this));
        seckill.grantRole(seckill.RECOVERY_ROLE(), address(this));
        vm.stopPrank();

        usdt.mint(address(paymentEscrow), 2 ether);
        usdt.mint(address(claimVault), 2 ether);
        npl.mint(address(rewardLedger), 2 ether);
        usdt.mint(address(guaranteeVault), 2 ether);
        usdt.mint(address(seckill), 2 ether);

        vm.expectRevert(PaymentEscrowV2.SafeExecutionRequired.selector);
        paymentEscrow.recoverSurplus(address(usdt), buyer, 1 ether, keccak256("wrong-caller"));
        vm.expectRevert(ClaimVaultV2.SafeExecutionRequired.selector);
        claimVault.recoverSurplus(address(usdt), buyer, 1 ether, keccak256("wrong-caller"));
        vm.expectRevert(RewardLedgerV2.SafeExecutionRequired.selector);
        rewardLedger.recoverSurplus(buyer, 1 ether, keccak256("wrong-caller"));
        vm.expectRevert(MerchantGuaranteeVaultV2.SafeExecutionRequired.selector);
        guaranteeVault.recoverSurplus(buyer, 1 ether, keccak256("wrong-caller"));
        vm.expectRevert(SeckillV2.SafeExecutionRequired.selector);
        seckill.recoverSurplus(buyer, 1 ether, keccak256("wrong-caller"));

        uint256 buyerUsdtBefore = usdt.balanceOf(buyer);
        uint256 buyerNplBefore = npl.balanceOf(buyer);
        uint256 protectedGuaranteeBefore = guaranteeVault.totalGuarantees() + guaranteeVault.riskReserveBalance();
        vm.startPrank(safe);
        paymentEscrow.recoverSurplus(address(usdt), buyer, 1 ether, keccak256("payment-incident"));
        claimVault.recoverSurplus(address(usdt), buyer, 1 ether, keccak256("claim-incident"));
        rewardLedger.recoverSurplus(buyer, 1 ether, keccak256("reward-incident"));
        guaranteeVault.recoverSurplus(buyer, 1 ether, keccak256("guarantee-incident"));
        seckill.recoverSurplus(buyer, 1 ether, keccak256("seckill-incident"));
        vm.stopPrank();
        assertEq(usdt.balanceOf(buyer) - buyerUsdtBefore, 4 ether);
        assertEq(npl.balanceOf(buyer) - buyerNplBefore, 1 ether);
        assertEq(paymentEscrow.totalLockedUsdt(), 0);
        assertEq(claimVault.totalUsdtLiability(), 0);
        assertEq(rewardLedger.totalLockedNpl(), 0);
        assertEq(guaranteeVault.totalGuarantees() + guaranteeVault.riskReserveBalance(), protectedGuaranteeBefore);
        assertEq(seckill.totalUnsettledPrize(), 0);
    }

    function testRegistryBoundContractsRejectMismatchedSafeAtConstruction() public {
        address wrongSafe = address(0xBAD);
        vm.expectRevert(RewardLedgerV2.InvalidAddress.selector);
        new RewardLedgerV2(
            wrongSafe, npl, IPolicyRegistryV2(address(policyRegistry)), IClaimVaultV2(address(claimVault))
        );
        vm.expectRevert(MerchantGuaranteeVaultV2.InvalidAddress.selector);
        new MerchantGuaranteeVaultV2(
            wrongSafe, usdt, IPolicyRegistryV2(address(policyRegistry)), IClaimVaultV2(address(claimVault))
        );
        vm.expectRevert(PaymentEscrowV2.InvalidAddress.selector);
        new PaymentEscrowV2(
            wrongSafe,
            usdt,
            npl,
            IPolicyRegistryV2(address(policyRegistry)),
            IBeneficiaryRegistryV2(address(beneficiaryRegistry)),
            ITwapOracleV2(address(oracle)),
            IRewardLedgerV2(address(rewardLedger)),
            IClaimVaultV2(address(claimVault)),
            IMerchantGuaranteeVaultV2(address(guaranteeVault)),
            quoteSigner,
            finalitySigner,
            12
        );
        assertEq(claimVault.safe(), safe);
    }

    function _claimIntent(address claimant, V2Types.ClaimRail rail, address asset, uint256 amount, uint256 nonce)
        private
        pure
        returns (V2Types.ClaimIntent memory)
    {
        return V2Types.ClaimIntent({
            claimant: claimant, rail: rail, asset: asset, amount: amount, nonce: nonce, deadline: type(uint64).max
        });
    }

    function _createSession(uint256 nonce) private {
        uint64 startsAt = uint64(block.timestamp);
        bytes32 actionHash = keccak256(
            abi.encode(
                "CREATE_SESSION",
                SESSION_ID,
                uint64(1),
                merchant,
                keccak256("product-1"),
                keccak256("sku-1"),
                keccak256("product-policy-1"),
                startsAt,
                uint256(2)
            )
        );
        bytes memory signature = _sign(SECONDARY_KEY, seckill.hashAdminAction(actionHash, nonce, type(uint64).max));
        vm.prank(safe);
        seckill.createSession(
            SESSION_ID,
            1,
            merchant,
            keccak256("product-1"),
            keccak256("sku-1"),
            keccak256("product-policy-1"),
            startsAt,
            2,
            nonce,
            type(uint64).max,
            signature
        );
    }

    function _makeSeckillIntent(bytes32 orderId, uint256 nonce) private view returns (V2Types.SeckillIntent memory) {
        return V2Types.SeckillIntent({
            sessionId: SESSION_ID,
            seckillOrder: _makeOrder(orderId, buyer, nonce, true),
            fallbackOrder: _makeOrder(orderId, buyer, nonce, false),
            deadline: type(uint64).max
        });
    }

    function _buy(V2Types.SeckillIntent memory intent) private {
        bytes32 digest = seckill.hashPurchase(intent);
        seckill.buy(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }
}
