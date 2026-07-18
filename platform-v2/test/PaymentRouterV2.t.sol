// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "./helpers/CoreFixture.sol";
import {Mock1271Wallet} from "./helpers/Mocks.sol";
import {BeneficiaryRegistryV2} from "../contracts/BeneficiaryRegistryV2.sol";
import {PaymentRouterV2} from "../contracts/PaymentRouterV2.sol";
import {IBeneficiaryRegistryV2, IPolicyRegistryV2} from "../contracts/interfaces/IV2Core.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract PaymentRouterV2Test is CoreFixture {
    function testPaymentEncodingMatchesCoreSigningVector() public pure {
        V2Types.PaymentIntent memory intent = _signingVectorIntent();
        bytes32 paymentHash = keccak256(abi.encode(intent));
        assertEq(paymentHash, 0x5e4de10e2ad0e6a4523921877b4dd61cfc3b8eb3788ccb6d682170caa36c81e7);
        assertEq(
            _paymentAuthorizationDigest(intent, paymentHash),
            0xa2f194fafcb357f74f04b79697a228e5bb86a5933b42c03b56082131a548406b
        );
    }

    function testSeckillEncodingMatchesCoreSigningVector() public pure {
        V2Types.PaymentIntent memory seckillPayment = _signingVectorIntent();
        seckillPayment.seckill = true;
        seckillPayment.sessionId = bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555));
        V2Types.PaymentIntent memory fallbackPayment = _signingVectorIntent();
        fallbackPayment.reservationId =
            bytes32(uint256(0x6666666666666666666666666666666666666666666666666666666666666666));
        fallbackPayment.reservationHash =
            bytes32(uint256(0x7777777777777777777777777777777777777777777777777777777777777777));
        V2Types.SeckillIntent memory intent = V2Types.SeckillIntent({
            sessionId: seckillPayment.sessionId, seckillPayment: seckillPayment, fallbackPayment: fallbackPayment
        });
        bytes32 seckillHash = keccak256(abi.encode(intent));
        assertEq(seckillHash, 0x9c0b86b12a6cb8613c46b162f487fc798d4ff4205cd77213b151306cbc40c2b1);
        assertEq(
            _seckillAuthorizationDigest(intent, seckillHash),
            0x30365fa7329679f0bb416e5a5b512a0d8c68c26d6352fe7ce7055647b3618cfc
        );
    }

    function _signingVectorIntent() private pure returns (V2Types.PaymentIntent memory) {
        return V2Types.PaymentIntent({
            orderId: bytes32(uint256(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)),
            policyVersion: 1,
            buyer: 0x1111111111111111111111111111111111111111,
            merchant: 0x2222222222222222222222222222222222222222,
            productId: bytes32(uint256(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)),
            skuId: bytes32(uint256(0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc)),
            quantity: 2,
            fulfillmentMode: V2Types.FulfillmentMode.Delivery,
            fulfillmentTargetHash: bytes32(uint256(0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd)),
            regionCodeHash: bytes32(uint256(0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)),
            productPolicyHash: bytes32(uint256(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)),
            reservationId: bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222)),
            reservationHash: bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333)),
            reservationDeadline: 1_800_000_600,
            issuedAt: 1_800_000_000,
            deadline: 1_800_000_300,
            nonce: 7,
            listPriceUsdt: 100 ether,
            productUsdtPaymentAmount: 70 ether,
            platformServiceFeeUsdt: 1 ether,
            custodyProductUsdt: 69 ether,
            freightUsdt: 0,
            usdtPaymentAmount: 70 ether,
            nplQuoteAmount: 1_000 ether,
            nplPaymentAmount: 300 ether,
            nplBurnAmount: 200 ether,
            nplRewardAmount: 100 ether,
            merchantBaseReceivableUsdt: 69 ether,
            merchantConcessionBps: 2_500,
            merchantConcessionAmount: 17.25 ether,
            merchantNetReceivableUsdt: 51.75 ether,
            concessionAllocationHash: bytes32(
                uint256(0x4444444444444444444444444444444444444444444444444444444444444444)
            ),
            bnmAmount: 100 ether,
            seckill: false,
            sessionId: bytes32(0),
            beneficiaries: V2Types.BeneficiarySnapshot({
                genesis: 0x3333333333333333333333333333333333333333,
                directReferral: 0x4444444444444444444444444444444444444444,
                district: 0x5555555555555555555555555555555555555555,
                city: 0x6666666666666666666666666666666666666666,
                province: 0x7777777777777777777777777777777777777777,
                region: 0x8888888888888888888888888888888888888888
            })
        });
    }

    function _paymentAuthorizationDigest(V2Types.PaymentIntent memory intent, bytes32 paymentHash)
        private
        pure
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PaymentAuthorization(bytes32 paymentHash,bytes32 orderId,address buyer,address merchant,bytes32 productId,bytes32 skuId,uint32 quantity,uint8 fulfillmentMode,uint256 listPriceUsdt,uint256 usdtPaymentAmount,uint256 nplPaymentAmount,uint64 deadline)"
                ),
                paymentHash,
                intent.orderId,
                intent.buyer,
                intent.merchant,
                intent.productId,
                intent.skuId,
                intent.quantity,
                intent.fulfillmentMode,
                intent.listPriceUsdt,
                intent.usdtPaymentAmount,
                intent.nplPaymentAmount,
                intent.deadline
            )
        );
        return _authorizationDigest(structHash);
    }

    function _seckillAuthorizationDigest(V2Types.SeckillIntent memory intent, bytes32 seckillHash)
        private
        pure
        returns (bytes32)
    {
        V2Types.PaymentIntent memory seckill = intent.seckillPayment;
        V2Types.PaymentIntent memory fallbackPayment = intent.fallbackPayment;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "SeckillAuthorization(bytes32 seckillHash,bytes32 orderId,address buyer,address merchant,bytes32 productId,bytes32 skuId,uint32 quantity,uint8 fulfillmentMode,uint256 seckillListPriceUsdt,uint256 seckillUsdtPaymentAmount,uint256 seckillNplPaymentAmount,uint256 fallbackListPriceUsdt,uint256 fallbackUsdtPaymentAmount,uint256 fallbackNplPaymentAmount,uint64 deadline)"
                ),
                seckillHash,
                seckill.orderId,
                seckill.buyer,
                seckill.merchant,
                seckill.productId,
                seckill.skuId,
                seckill.quantity,
                seckill.fulfillmentMode,
                seckill.listPriceUsdt,
                seckill.usdtPaymentAmount,
                seckill.nplPaymentAmount,
                fallbackPayment.listPriceUsdt,
                fallbackPayment.usdtPaymentAmount,
                fallbackPayment.nplPaymentAmount,
                seckill.deadline
            )
        );
        return _authorizationDigest(structHash);
    }

    function _authorizationDigest(bytes32 structHash) private pure returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Abu24KPaymentRouter"),
                keccak256("2"),
                uint256(56),
                0x9999999999999999999999999999999999999999
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    function testConstructorRejectsZeroPolicyRegistryBeforeCallingIt() public {
        vm.expectRevert(PaymentRouterV2.InvalidAddress.selector);
        new PaymentRouterV2(
            usdt,
            npl,
            IPolicyRegistryV2(address(0)),
            IBeneficiaryRegistryV2(address(beneficiaryRegistry)),
            platformServiceFeeSafe,
            usdtCustodySafe,
            nplRewardSafe,
            operationsTreasurySafe,
            quoteSigner
        );
    }

    function testPaymentAtomicallySplitsServiceFeeCustodyBurnRewardAndRouterRetainsZero() public {
        V2Types.PaymentIntent memory intent =
            _makePayment(keccak256("order-1"), buyer, 1, false, keccak256("reservation-1"));
        uint256 buyerUsdtBefore = usdt.balanceOf(buyer);
        uint256 buyerNplBefore = npl.balanceOf(buyer);

        _pay(intent, BUYER_KEY);

        assertEq(buyerUsdtBefore - usdt.balanceOf(buyer), 70 ether);
        assertEq(buyerNplBefore - npl.balanceOf(buyer), 300 ether);
        assertEq(usdt.balanceOf(platformServiceFeeSafe), 1 ether);
        assertEq(usdt.balanceOf(usdtCustodySafe), 69 ether);
        assertEq(npl.balanceOf(V2Types.NPL_BURN_ADDRESS), 200 ether);
        assertEq(npl.balanceOf(nplRewardSafe), 100 ether);
        assertEq(usdt.balanceOf(address(router)), 0);
        assertEq(npl.balanceOf(address(router)), 0);
    }

    function testDeliveryFreightIsPureUsdtAndPickupCannotChargeFreight() public {
        V2Types.PaymentIntent memory delivery =
            _makePayment(keccak256("delivery-freight"), buyer, 19, false, keccak256("reservation-19"));
        delivery.freightUsdt = 5 ether;
        delivery.usdtPaymentAmount = delivery.productUsdtPaymentAmount + delivery.freightUsdt;
        uint256 custodyBefore = usdt.balanceOf(usdtCustodySafe);
        uint256 burnBefore = npl.balanceOf(V2Types.NPL_BURN_ADDRESS);
        uint256 rewardBefore = npl.balanceOf(nplRewardSafe);

        _pay(delivery, BUYER_KEY);

        assertEq(usdt.balanceOf(usdtCustodySafe) - custodyBefore, 74 ether);
        assertEq(npl.balanceOf(V2Types.NPL_BURN_ADDRESS) - burnBefore, 200 ether);
        assertEq(npl.balanceOf(nplRewardSafe) - rewardBefore, 100 ether);
        assertEq(delivery.bnmAmount, delivery.listPriceUsdt);

        V2Types.PaymentIntent memory pickup =
            _makePayment(keccak256("pickup-freight"), buyer, 20, false, keccak256("reservation-20"));
        pickup.fulfillmentMode = V2Types.FulfillmentMode.Pickup;
        pickup.freightUsdt = 1;
        pickup.usdtPaymentAmount = pickup.productUsdtPaymentAmount + pickup.freightUsdt;
        bytes32 digest = router.hashPayment(pickup);
        vm.expectRevert(PaymentRouterV2.InvalidAmounts.selector);
        router.pay(pickup, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }

    function testConcessionNeverChangesBuyerPaymentAndAllowsZeroOrFull() public {
        V2Types.PaymentIntent memory zero =
            _makePayment(keccak256("zero-concession"), buyer, 2, false, keccak256("reservation-2"));
        zero = _setAmounts(zero, 100 ether, 1_000 ether, 0);
        _pay(zero, BUYER_KEY);
        assertEq(zero.usdtPaymentAmount, 70 ether);
        assertEq(zero.merchantNetReceivableUsdt, zero.merchantBaseReceivableUsdt);

        V2Types.PaymentIntent memory full =
            _makePayment(keccak256("full-concession"), buyer, 3, false, keccak256("reservation-3"));
        full = _setAmounts(full, 100 ether, 1_000 ether, 10_000);
        _pay(full, BUYER_KEY);
        assertEq(full.usdtPaymentAmount, 70 ether);
        assertEq(full.merchantNetReceivableUsdt, 0);
    }

    function testReplayWrongAmountAndLongQuoteFailClosed() public {
        V2Types.PaymentIntent memory intent =
            _makePayment(keccak256("replay"), buyer, 4, false, keccak256("reservation-4"));
        _pay(intent, BUYER_KEY);
        bytes32 digest = router.hashPayment(intent);
        vm.expectRevert(PaymentRouterV2.Replay.selector);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));

        intent = _makePayment(keccak256("bad-amount"), buyer, 5, false, keccak256("reservation-5"));
        intent.nplRewardAmount += 1;
        digest = router.hashPayment(intent);
        vm.expectRevert(PaymentRouterV2.InvalidAmounts.selector);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));

        intent = _makePayment(keccak256("long-quote"), buyer, 6, false, keccak256("reservation-6"));
        intent.deadline = intent.issuedAt + 5 minutes + 1;
        intent.reservationDeadline = intent.deadline + 1;
        digest = router.hashPayment(intent);
        vm.expectRevert(PaymentRouterV2.QuoteExpired.selector);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));

        intent = _makePayment(keccak256("wrong-concession-set"), buyer, 14, false, keccak256("reservation-14"));
        intent.concessionAllocationHash = keccak256("unpublished-concession-set");
        digest = router.hashPayment(intent);
        vm.expectRevert(PaymentRouterV2.InvalidIntent.selector);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }

    function testQuoteSignatureBindsAmountsIdentityReservationPolicyDeadlineAndNonce() public {
        V2Types.PaymentIntent memory original =
            _makePayment(keccak256("bound-fields"), buyer, 19, false, keccak256("reservation-19"));
        bytes32 digest = router.hashPayment(original);
        bytes memory quoteSignature = _sign(QUOTE_KEY, digest);
        bytes memory buyerSignature = _sign(BUYER_KEY, digest);
        V2Types.PaymentIntent memory changed = original;

        changed.nplQuoteAmount += 1;
        _expectInvalidOldSignatures(changed, quoteSignature, buyerSignature);
        changed = original;
        changed.orderId = keccak256("other-order");
        _expectInvalidOldSignatures(changed, quoteSignature, buyerSignature);
        changed = original;
        changed.productId = keccak256("other-product");
        _expectInvalidOldSignatures(changed, quoteSignature, buyerSignature);
        changed = original;
        changed.reservationHash = keccak256("other-reservation");
        _expectInvalidOldSignatures(changed, quoteSignature, buyerSignature);
        changed = original;
        changed.merchant = address(0xBEEF);
        _expectInvalidOldSignatures(changed, quoteSignature, buyerSignature);
        changed = original;
        changed.policyVersion += 1;
        _expectInvalidOldSignatures(changed, quoteSignature, buyerSignature);
        changed = original;
        changed.deadline -= 1;
        _expectInvalidOldSignatures(changed, quoteSignature, buyerSignature);
        changed = original;
        changed.nonce += 1;
        _expectInvalidOldSignatures(changed, quoteSignature, buyerSignature);
    }

    function testSubBpsPaymentCannotCreateZeroCostBnmLiability() public {
        V2Types.PaymentIntent memory intent =
            _makePayment(keccak256("sub-bps"), buyer, 16, false, keccak256("reservation-16"));
        intent = _setAmounts(intent, 1, 1, 0);
        bytes32 digest = router.hashPayment(intent);
        vm.expectRevert(PaymentRouterV2.InvalidAmounts.selector);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }

    function testFeeOnTransferAndReentrancyCannotBreakConservation() public {
        V2Types.PaymentIntent memory intent =
            _makePayment(keccak256("fee-token"), buyer, 7, false, keccak256("reservation-7"));
        npl.setFeeBps(100);
        bytes32 digest = router.hashPayment(intent);
        vm.expectRevert(PaymentRouterV2.InexactTransfer.selector);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
        npl.setFeeBps(0);

        intent = _makePayment(keccak256("reentrant"), buyer, 8, false, keccak256("reservation-8"));
        digest = router.hashPayment(intent);
        bytes memory callData = abi.encodeCall(router.pay, (intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest)));
        usdt.configureCallback(address(router), callData);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
        assertFalse(usdt.callbackSucceeded());
        assertEq(usdt.balanceOf(address(router)), 0);
        assertEq(npl.balanceOf(address(router)), 0);
    }

    function testErc1271BuyerAuthorization() public {
        uint256 ownerKey = 0x1271;
        address owner = vm.addr(ownerKey);
        Mock1271Wallet wallet = new Mock1271Wallet(owner);
        usdt.mint(address(wallet), 100 ether);
        npl.mint(address(wallet), 1_000 ether);
        vm.startPrank(owner);
        wallet.approveToken(address(usdt), address(router), type(uint256).max);
        wallet.approveToken(address(npl), address(router), type(uint256).max);
        vm.stopPrank();
        V2Types.PaymentIntent memory intent =
            _makePayment(keccak256("erc1271"), address(wallet), 9, false, keccak256("reservation-9"));
        bytes32 digest = router.hashPayment(intent);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(ownerKey, digest));
        assertEq(usdt.balanceOf(platformServiceFeeSafe), 1 ether);
        assertEq(usdt.balanceOf(usdtCustodySafe), 69 ether);
    }

    function testQuoteSignerCannotInjectLegacyGenesisBeneficiary() public {
        V2Types.PaymentIntent memory intent =
            _makePayment(keccak256("genesis-diversion"), buyer, 18, false, keccak256("reservation-18"));
        intent.beneficiaries.genesis = genesis;
        bytes32 digest = router.hashPayment(intent);
        vm.expectRevert(BeneficiaryRegistryV2.BeneficiaryMismatch.selector);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }

    function testPaymentPauseRequiresActualSafeAndCanResume() public {
        bytes32 evidence = keccak256("incident");
        vm.expectRevert();
        router.setNewPaymentsPaused(true, evidence);
        vm.prank(safe);
        router.setNewPaymentsPaused(true, evidence);
        V2Types.PaymentIntent memory intent =
            _makePayment(keccak256("paused"), buyer, 10, false, keccak256("reservation-10"));
        bytes32 digest = router.hashPayment(intent);
        vm.expectRevert(PaymentRouterV2.NewPaymentsPaused.selector);
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
        vm.prank(safe);
        router.setNewPaymentsPaused(false, keccak256("resume"));
        router.pay(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }

    function testSeckillLiveExtendsRelayAndExactDeadlineUsesFallback() public {
        bytes32 sessionId = keccak256("session-1");
        vm.prank(safe);
        router.openSeckillSession(sessionId, 1, uint64(block.timestamp));
        vm.warp(block.timestamp + 30 seconds);
        V2Types.SeckillIntent memory liveIntent = _dualIntent(11);
        bytes32 digest = router.hashSeckill(liveIntent);
        router.paySeckill(liveIntent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
        PaymentRouterV2.SeckillSession memory session = router.getSession(sessionId);
        assertEq(session.relayDeadline, block.timestamp + 60 seconds);

        vm.warp(session.relayDeadline);
        V2Types.SeckillIntent memory fallbackIntent = _dualIntent(12);
        digest = router.hashSeckill(fallbackIntent);
        router.paySeckill(fallbackIntent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
        assertTrue(router.usedReservation(fallbackIntent.fallbackPayment.reservationId));
        assertFalse(router.usedReservation(fallbackIntent.seckillPayment.reservationId));
    }

    function testSeckillRejectsMismatchedDualQuoteIdentity() public {
        bytes32 sessionId = keccak256("session-1");
        vm.prank(safe);
        router.openSeckillSession(sessionId, 1, uint64(block.timestamp));
        V2Types.SeckillIntent memory intent = _dualIntent(15);
        intent.fallbackPayment.nonce += 1;
        bytes32 digest = router.hashSeckill(intent);
        vm.expectRevert(PaymentRouterV2.InvalidIntent.selector);
        router.paySeckill(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));
    }

    function testFutureSessionUsesVersionedRelayIncrementAndCap() public {
        V2Types.PaymentIntent memory versionOneQuote =
            _makePayment(keccak256("version-one-after-region-change"), buyer, 18, false, keccak256("reservation-18"));
        bytes32 versionOneDigest = router.hashPayment(versionOneQuote);
        bytes memory versionOneQuoteSignature = _sign(QUOTE_KEY, versionOneDigest);
        bytes memory versionOneBuyerSignature = _sign(BUYER_KEY, versionOneDigest);
        V2Types.Policy memory policy = policyRegistry.getPolicy(1);
        policy.version = 2;
        policy.relayInitial = 20 seconds;
        policy.relayIncrement = 10 seconds;
        policy.relayCap = 20 seconds;
        policy.decisionEvidenceHash = keccak256("policy-2-timers");
        address[] memory accounts = new address[](4);
        accounts[0] = operationsOne;
        accounts[1] = operationsTwo;
        accounts[2] = operationsThree;
        accounts[3] = operationsFour;
        uint16[] memory weights = new uint16[](4);
        weights[0] = 2_500;
        weights[1] = 2_500;
        weights[2] = 2_500;
        weights[3] = 2_500;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        BeneficiaryRegistryV2.RegionBeneficiaries memory nextRegion =
            BeneficiaryRegistryV2.RegionBeneficiaries(district, city, province, region);
        bytes32 regionDigest = beneficiaryRegistry.hashRegionPublication(2, regionCodeHash, nextRegion, 8, deadline);
        vm.prank(safe);
        beneficiaryRegistry.publishRegionBeneficiaries(
            2, regionCodeHash, nextRegion, 8, deadline, _sign(SECONDARY_KEY, regionDigest)
        );
        bytes32 publicationDigest = policyRegistry.hashPublication(policy, accounts, weights, 8, deadline);
        vm.prank(safe);
        policyRegistry.publishPolicy(policy, accounts, weights, 8, deadline, _sign(SECONDARY_KEY, publicationDigest));
        router.pay(versionOneQuote, versionOneQuoteSignature, versionOneBuyerSignature);

        bytes32 sessionId = keccak256("session-v2");
        vm.prank(safe);
        router.openSeckillSession(sessionId, 2, uint64(block.timestamp));
        vm.warp(block.timestamp + 5 seconds);
        V2Types.SeckillIntent memory intent = _dualIntent(17);
        intent.sessionId = sessionId;
        intent.seckillPayment.sessionId = sessionId;
        intent.seckillPayment.policyVersion = 2;
        intent.fallbackPayment.policyVersion = 2;
        bytes32 digest = router.hashSeckill(intent);
        router.paySeckill(intent, _sign(QUOTE_KEY, digest), _sign(BUYER_KEY, digest));

        PaymentRouterV2.SeckillSession memory session = router.getSession(sessionId);
        assertEq(session.relayIncrement, 10 seconds);
        assertEq(session.relayCap, 20 seconds);
        assertEq(session.relayDeadline, block.timestamp + 20 seconds);
    }

    function _expectInvalidOldSignatures(
        V2Types.PaymentIntent memory intent,
        bytes memory quoteSignature,
        bytes memory buyerSignature
    ) private {
        vm.expectRevert(PaymentRouterV2.InvalidSignature.selector);
        router.pay(intent, quoteSignature, buyerSignature);
    }

    function _dualIntent(uint256 nonce) private view returns (V2Types.SeckillIntent memory dual) {
        bytes32 orderId = keccak256(abi.encode("dual-order", nonce));
        V2Types.PaymentIntent memory seckill =
            _makePayment(orderId, buyer, nonce, true, keccak256(abi.encode("seckill-reservation", nonce)));
        V2Types.PaymentIntent memory fallbackPayment =
            _makePayment(orderId, buyer, nonce, false, keccak256(abi.encode("fallback-reservation", nonce)));
        dual = V2Types.SeckillIntent(keccak256("session-1"), seckill, fallbackPayment);
    }
}
