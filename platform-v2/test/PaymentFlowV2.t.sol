// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {Mock1271Wallet} from "./helpers/Mocks.sol";
import {ClaimVaultV2} from "../contracts/ClaimVaultV2.sol";
import {PaymentEscrowV2} from "../contracts/PaymentEscrowV2.sol";
import {TwapOracleAdapterV2} from "../contracts/TwapOracleAdapterV2.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract PaymentFlowV2Test is CoreFixture {
    function testDualAssetPaymentBurnsAndLocksBeforeFulfillment() public {
        bytes32 orderId = keccak256("ordinary-order-1");
        V2Types.OrderIntent memory intent = _makeOrder(orderId, buyer, 1, false);
        uint256 buyerUsdtBefore = usdt.balanceOf(buyer);
        uint256 buyerNplBefore = npl.balanceOf(buyer);

        _payOrder(intent, BUYER_KEY);

        assertEq(buyerUsdtBefore - usdt.balanceOf(buyer), 50 ether);
        assertEq(buyerNplBefore - npl.balanceOf(buyer), 500 ether);
        assertEq(npl.balanceOf(paymentEscrow.NPL_BURN_ADDRESS()), 100 ether);
        assertEq(npl.balanceOf(address(rewardLedger)), 400 ether);
        assertEq(rewardLedger.totalLockedNpl(), 400 ether);
        assertEq(usdt.balanceOf(address(paymentEscrow)), 50 ether);
        assertEq(paymentEscrow.totalLockedUsdt(), 50 ether);
        assertEq(claimVault.merchantClaimable(merchant), 0);
        assertEq(claimVault.bnmClaimable(buyer), 0);
        assertEq(bnm.balanceOf(buyer), 0);
    }

    function testFulfillmentFinalityReleasesEveryRailAndConservesFunds() public {
        bytes32 orderId = keccak256("ordinary-order-2");
        _payOrder(_makeOrder(orderId, buyer, 2, false), BUYER_KEY);
        _fulfillByCustomer(orderId, 1);

        assertEq(paymentEscrow.totalLockedUsdt(), 0);
        assertEq(rewardLedger.totalLockedNpl(), 0);
        assertEq(usdt.balanceOf(address(paymentEscrow)), 0);
        assertEq(claimVault.merchantClaimable(merchant), 30 ether);
        assertEq(usdt.balanceOf(platformTreasury), 5 ether);
        assertEq(usdt.balanceOf(usdtRemainderAccount), 15 ether);
        assertEq(claimVault.bnmClaimable(buyer), 100 ether);
        assertEq(claimVault.rewardClaimable(genesis), 20 ether);
        assertEq(claimVault.rewardClaimable(directReferral), 10 ether);
        assertEq(claimVault.rewardClaimable(district), 12 ether);
        assertEq(claimVault.rewardClaimable(city), 8 ether);
        assertEq(claimVault.rewardClaimable(province), 6 ether);
        assertEq(claimVault.rewardClaimable(region), 4 ether);
        assertEq(claimVault.rewardClaimable(merchant), 10 ether);
        assertEq(claimVault.rewardClaimable(operationsOne), 24 ether);
        assertEq(claimVault.rewardClaimable(operationsTwo), 16 ether);
        assertEq(npl.balanceOf(circulationPool), 290 ether);
        assertEq(npl.balanceOf(address(claimVault)), 110 ether);
        assertEq(npl.balanceOf(address(claimVault)) + npl.balanceOf(circulationPool), 400 ether);
    }

    function testBnmAndMerchantClaimUseSignedNonceAndMintOnlyOnClaim() public {
        bytes32 orderId = keccak256("ordinary-order-3");
        _payOrder(_makeOrder(orderId, buyer, 3, false), BUYER_KEY);
        _fulfillByCustomer(orderId, 2);

        V2Types.ClaimIntent memory bnmIntent = V2Types.ClaimIntent({
            claimant: buyer,
            rail: V2Types.ClaimRail.Bnm,
            asset: address(bnm),
            amount: 100 ether,
            nonce: 1,
            deadline: uint64(block.timestamp + 1 hours)
        });
        bytes32 bnmDigest = claimVault.hashClaim(bnmIntent);
        bytes memory bnmSignature = _sign(BUYER_KEY, bnmDigest);
        claimVault.claim(bnmIntent, bnmSignature);
        assertEq(bnm.balanceOf(buyer), 100 ether);
        assertEq(claimVault.bnmClaimable(buyer), 0);

        vm.expectRevert(ClaimVaultV2.ClaimReplay.selector);
        claimVault.claim(bnmIntent, bnmSignature);

        V2Types.ClaimIntent memory merchantIntent = V2Types.ClaimIntent({
            claimant: merchant,
            rail: V2Types.ClaimRail.MerchantUsdt,
            asset: address(usdt),
            amount: 30 ether,
            nonce: 1,
            deadline: uint64(block.timestamp + 1 hours)
        });
        uint256 merchantBefore = usdt.balanceOf(merchant);
        claimVault.claim(merchantIntent, _sign(MERCHANT_KEY, claimVault.hashClaim(merchantIntent)));
        assertEq(usdt.balanceOf(merchant) - merchantBefore, 30 ether);
        assertEq(claimVault.merchantClaimable(merchant), 0);
    }

    function testOrderAndReservationCannotReplay() public {
        V2Types.OrderIntent memory intent = _makeOrder(keccak256("replay-order"), buyer, 4, false);
        bytes32 digest = paymentEscrow.hashOrder(intent);
        bytes memory quoteSignature = _sign(QUOTE_KEY, digest);
        bytes memory buyerSignature = _sign(BUYER_KEY, digest);
        paymentEscrow.payOrder(intent, quoteSignature, buyerSignature);

        vm.expectRevert(PaymentEscrowV2.OrderExists.selector);
        paymentEscrow.payOrder(intent, quoteSignature, buyerSignature);
    }

    function testOracleDeviationFailsClosedWithoutBlockingFulfillment() public {
        V2Types.OrderIntent memory invalidIntent = _makeOrder(keccak256("bad-oracle"), buyer, 5, false);
        twapSource.setResult(500 ether, 1_000_000 ether, uint64(block.timestamp));
        bytes32 digest = paymentEscrow.hashOrder(invalidIntent);
        vm.expectRevert(abi.encodeWithSelector(TwapOracleAdapterV2.ExcessiveDeviation.selector, 10_000));
        paymentEscrow.payOrder(invalidIntent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));

        twapSource.setResult(1_000 ether, 1_000_000 ether, uint64(block.timestamp));
        bytes32 validOrderId = keccak256("valid-before-oracle-outage");
        _payOrder(_makeOrder(validOrderId, buyer, 6, false), BUYER_KEY);
        twapSource.setResult(0, 0, 0);
        _fulfillByCustomer(validOrderId, 3);
        assertEq(claimVault.bnmClaimable(buyer), 100 ether);
    }

    function testWrongOracleVersionFailsBeforePayment() public {
        V2Types.OrderIntent memory intent = _makeOrder(keccak256("wrong-oracle-version"), buyer, 61, false);
        intent.oracleVersion = keccak256("unpublished-oracle-version");
        bytes32 digest = paymentEscrow.hashOrder(intent);
        vm.expectRevert(PaymentEscrowV2.InvalidAmounts.selector);
        paymentEscrow.payOrder(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
        assertEq(paymentEscrow.totalLockedUsdt(), 0);
    }

    function testFeeOnTransferTokenIsRejected() public {
        V2Types.OrderIntent memory intent = _makeOrder(keccak256("fee-token"), buyer, 7, false);
        usdt.setFeeBps(100);
        bytes32 digest = paymentEscrow.hashOrder(intent);
        vm.expectRevert(PaymentEscrowV2.InexactTransfer.selector);
        paymentEscrow.payOrder(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
        assertEq(paymentEscrow.totalLockedUsdt(), 0);
    }

    function testTokenCallbackCannotReenterPayment() public {
        V2Types.OrderIntent memory outer = _makeOrder(keccak256("outer-order"), buyer, 8, false);
        V2Types.OrderIntent memory inner = _makeOrder(keccak256("inner-order"), buyer, 9, false);
        bytes32 innerDigest = paymentEscrow.hashOrder(inner);
        bytes memory callbackData = abi.encodeCall(
            paymentEscrow.payOrder, (inner, _sign(QUOTE_KEY, innerDigest), _sign(BUYER_KEY, innerDigest))
        );
        usdt.configureCallback(address(paymentEscrow), callbackData);
        _payOrder(outer, BUYER_KEY);
        assertFalse(usdt.callbackSucceeded());
        assertEq(paymentEscrow.getOrder(inner.orderId).state == V2Types.OrderState.None, true);
    }

    function testErc1271BuyerAuthorization() public {
        uint256 walletOwnerKey = 0x1271;
        address walletOwner = vm.addr(walletOwnerKey);
        Mock1271Wallet wallet = new Mock1271Wallet(walletOwner);
        usdt.mint(address(wallet), 1_000 ether);
        npl.mint(address(wallet), 10_000 ether);
        vm.startPrank(walletOwner);
        wallet.approveToken(address(usdt), address(paymentEscrow), type(uint256).max);
        wallet.approveToken(address(npl), address(paymentEscrow), type(uint256).max);
        vm.stopPrank();
        vm.prank(safe);
        beneficiaryRegistry.setReferrer(address(wallet), directReferral);

        V2Types.OrderIntent memory intent = _makeOrder(keccak256("erc1271-order"), address(wallet), 10, false);
        bytes32 digest = paymentEscrow.hashOrder(intent);
        paymentEscrow.payOrder(intent, _sign(QUOTE_KEY, digest), _sign(walletOwnerKey, digest));
        assertEq(paymentEscrow.getOrder(intent.orderId).buyer, address(wallet));
    }

    function testNoBusinessRefundMethodExists() public {
        (bool success,) = address(paymentEscrow).call(abi.encodeWithSignature("refund(bytes32)", keccak256("order")));
        assertFalse(success);
    }
}
