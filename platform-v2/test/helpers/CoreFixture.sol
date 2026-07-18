// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase} from "./TestBase.sol";
import {CallbackERC20} from "./Mocks.sol";
import {BeneficiaryRegistryV2} from "../../contracts/BeneficiaryRegistryV2.sol";
import {PaymentRouterV2} from "../../contracts/PaymentRouterV2.sol";
import {PolicyRegistryV2} from "../../contracts/PolicyRegistryV2.sol";
import {IBeneficiaryRegistryV2, IPolicyRegistryV2} from "../../contracts/interfaces/IV2Core.sol";
import {V2Types} from "../../contracts/types/V2Types.sol";

abstract contract CoreFixture is TestBase {
    uint256 internal constant GOVERNANCE_KEY = 0xA11CE;
    uint256 internal constant QUOTE_KEY = 0xC0DE;
    uint256 internal constant BUYER_KEY = 0xBEEF;

    address internal governanceWallet;
    address internal buyer;
    address internal merchant = address(0x4001);
    address internal genesis = address(0x5002);
    address internal directReferral = address(0x5003);
    address internal district = address(0x5004);
    address internal city = address(0x5005);
    address internal province = address(0x5006);
    address internal region = address(0x5007);
    address internal operationsOne = address(0x6001);
    address internal operationsTwo = address(0x6002);
    address internal operationsThree = address(0x6003);
    address internal operationsFour = address(0x6004);
    address internal platformServiceFeeWallet = address(0x7000);
    address internal usdtSettlementWallet = address(0x7001);
    address internal nplRewardWallet = address(0x7002);
    address internal operationsWallet = address(0x7003);
    address internal circulationPool = address(0x7004);
    bytes32 internal regionCodeHash = keccak256("210211");
    bytes32 internal concessionAllocationHash;

    CallbackERC20 internal usdt;
    CallbackERC20 internal npl;
    PolicyRegistryV2 internal policyRegistry;
    BeneficiaryRegistryV2 internal beneficiaryRegistry;
    PaymentRouterV2 internal router;

    function setUp() public virtual {
        vm.chainId(V2Types.BSC_CHAIN_ID);
        vm.warp(1_800_000_000);
        governanceWallet = vm.addr(GOVERNANCE_KEY);
        buyer = vm.addr(BUYER_KEY);
        concessionAllocationHash = _paymentAllocationSetHash();

        CallbackERC20 usdtImplementation = new CallbackERC20("Mock USDT", "USDT");
        CallbackERC20 nplImplementation = new CallbackERC20("Mock NPL", "NPL");
        vm.etch(V2Types.USDT, address(usdtImplementation).code);
        vm.etch(V2Types.NPL, address(nplImplementation).code);
        usdt = CallbackERC20(V2Types.USDT);
        npl = CallbackERC20(V2Types.NPL);
        policyRegistry = new PolicyRegistryV2(governanceWallet);
        beneficiaryRegistry = new BeneficiaryRegistryV2(IPolicyRegistryV2(address(policyRegistry)));
        BeneficiaryRegistryV2.RegionBeneficiaries memory regionBeneficiarySet =
            BeneficiaryRegistryV2.RegionBeneficiaries(district, city, province, region);
        uint64 regionPublicationDeadline = uint64(block.timestamp + 1 hours);
        bytes32 regionPublicationDigest = beneficiaryRegistry.hashRegionPublication(
            1, regionCodeHash, regionBeneficiarySet, 1, regionPublicationDeadline
        );
        vm.prank(governanceWallet);
        beneficiaryRegistry.publishRegionBeneficiaries(
            1,
            regionCodeHash,
            regionBeneficiarySet,
            1,
            regionPublicationDeadline,
            _sign(GOVERNANCE_KEY, regionPublicationDigest)
        );
        _publishLaunchPolicy();
        router = new PaymentRouterV2(
            usdt,
            npl,
            IPolicyRegistryV2(address(policyRegistry)),
            IBeneficiaryRegistryV2(address(beneficiaryRegistry)),
            platformServiceFeeWallet,
            usdtSettlementWallet,
            nplRewardWallet,
            operationsWallet
        );
        vm.prank(governanceWallet);
        beneficiaryRegistry.setReferrer(buyer, directReferral);
        usdt.mint(buyer, 1_000_000 ether);
        npl.mint(buyer, 10_000_000 ether);
        vm.startPrank(buyer);
        usdt.approve(address(router), type(uint256).max);
        npl.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _publishLaunchPolicy() internal {
        address[] memory operationsAccounts = new address[](4);
        operationsAccounts[0] = operationsOne;
        operationsAccounts[1] = operationsTwo;
        operationsAccounts[2] = operationsThree;
        operationsAccounts[3] = operationsFour;
        uint16[] memory operationsWeights = new uint16[](4);
        operationsWeights[0] = 2_500;
        operationsWeights[1] = 2_500;
        operationsWeights[2] = 2_500;
        operationsWeights[3] = 2_500;
        V2Types.Policy memory policy = V2Types.Policy({
            version: 1,
            usdtPaymentBps: V2Types.LAUNCH_USDT_PAYMENT_BPS,
            nplPaymentBps: V2Types.LAUNCH_NPL_PAYMENT_BPS,
            nplBurnListPriceBps: V2Types.NPL_BURN_LIST_PRICE_BPS,
            nplRewardListPriceBps: V2Types.NPL_REWARD_LIST_PRICE_BPS,
            genesisBps: 200,
            directReferralBps: 100,
            districtBps: 120,
            cityBps: 80,
            provinceBps: 60,
            regionBps: 40,
            operationsBps: 400,
            platformFeeBps: V2Types.PLATFORM_SERVICE_FEE_LIST_PRICE_BPS,
            seckillPrizeBps: 0,
            seckillMainDuration: 60 minutes,
            relayInitial: 60 seconds,
            relayIncrement: 30 seconds,
            relayCap: 60 seconds,
            merchantGuaranteeMinimum: V2Types.MERCHANT_GUARANTEE_MINIMUM,
            usdtSettlementWallet: usdtSettlementWallet,
            nplRewardWallet: nplRewardWallet,
            operationsWallet: operationsWallet,
            circulationPool: circulationPool,
            beneficiarySetHash: keccak256(
                abi.encode(_singleAddress(genesis), _singleWeight(10_000), operationsAccounts, operationsWeights)
            ),
            concessionDestinationSetHash: concessionAllocationHash,
            decisionEvidenceHash: keccak256("test-policy-decision-evidence"),
            rulesContentHash: keccak256("frozen-seckill-rules")
        });
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, operationsAccounts, operationsWeights, 1, deadline);
        vm.prank(governanceWallet);
        policyRegistry.publishPolicy(
            policy, operationsAccounts, operationsWeights, 1, deadline, _sign(GOVERNANCE_KEY, digest)
        );
    }

    function _makePayment(bytes32 orderId, address paymentBuyer, uint256 nonce, bool seckill, bytes32 reservationId)
        internal
        view
        returns (V2Types.PaymentIntent memory intent)
    {
        V2Types.BeneficiarySnapshot memory beneficiaries = V2Types.BeneficiarySnapshot({
            genesis: address(0),
            directReferral: paymentBuyer == buyer ? directReferral : address(0),
            district: paymentBuyer == buyer ? district : address(0),
            city: paymentBuyer == buyer ? city : address(0),
            province: paymentBuyer == buyer ? province : address(0),
            region: paymentBuyer == buyer ? region : address(0)
        });
        intent = V2Types.PaymentIntent({
            orderId: orderId,
            policyVersion: 1,
            buyer: paymentBuyer,
            merchant: merchant,
            productId: keccak256("product-1"),
            skuId: keccak256("sku-1"),
            quantity: 1,
            fulfillmentMode: V2Types.FulfillmentMode.Delivery,
            fulfillmentTargetHash: keccak256("address-snapshot"),
            regionCodeHash: regionCodeHash,
            productPolicyHash: keccak256("product-policy-1"),
            reservationId: reservationId,
            reservationHash: keccak256(abi.encode("reservation", reservationId)),
            reservationDeadline: uint64(block.timestamp + 10 minutes),
            issuedAt: uint64(block.timestamp),
            deadline: uint64(block.timestamp + V2Types.QUOTE_VALIDITY),
            nonce: nonce,
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
            concessionAllocationHash: concessionAllocationHash,
            bnmAmount: 100 ether,
            seckill: seckill,
            sessionId: seckill ? keccak256("session-1") : bytes32(0),
            beneficiaries: beneficiaries
        });
        if (paymentBuyer != buyer) intent.regionCodeHash = keccak256(abi.encode(paymentBuyer));
    }

    function _setAmounts(
        V2Types.PaymentIntent memory intent,
        uint256 listPriceUsdt,
        uint256 nplQuoteAmount,
        uint16 concessionBps
    ) internal pure returns (V2Types.PaymentIntent memory) {
        intent.listPriceUsdt = listPriceUsdt;
        intent.productUsdtPaymentAmount = listPriceUsdt * 7_000 / 10_000;
        intent.platformServiceFeeUsdt = listPriceUsdt * 100 / 10_000;
        intent.custodyProductUsdt = intent.productUsdtPaymentAmount - intent.platformServiceFeeUsdt;
        intent.usdtPaymentAmount = intent.productUsdtPaymentAmount + intent.freightUsdt;
        intent.nplQuoteAmount = nplQuoteAmount;
        intent.nplPaymentAmount = nplQuoteAmount * 3_000 / 10_000;
        intent.nplBurnAmount = nplQuoteAmount * 2_000 / 10_000;
        intent.nplRewardAmount = intent.nplPaymentAmount - intent.nplBurnAmount;
        intent.merchantBaseReceivableUsdt = intent.custodyProductUsdt;
        intent.merchantConcessionBps = concessionBps;
        intent.merchantConcessionAmount = intent.merchantBaseReceivableUsdt * concessionBps / 10_000;
        intent.merchantNetReceivableUsdt = intent.merchantBaseReceivableUsdt - intent.merchantConcessionAmount;
        intent.bnmAmount = listPriceUsdt;
        return intent;
    }

    function _pay(V2Types.PaymentIntent memory intent, uint256 buyerKey) internal {
        bytes32 digest = router.hashPayment(intent);
        router.pay(intent, _sign(GOVERNANCE_KEY, digest), _sign(buyerKey, digest));
    }

    function _paymentAllocationSetHash() private pure returns (bytes32) {
        bytes32[] memory pools = new bytes32[](3);
        pools[0] = keccak256("SECKILL_PRIZE");
        pools[1] = keccak256("NODE_REWARD");
        pools[2] = keccak256("REWARD_RESERVE");
        uint16[] memory weights = new uint16[](3);
        weights[0] = 4_500;
        weights[1] = 4_500;
        weights[2] = 1_000;
        return keccak256(abi.encode(pools, weights));
    }

    function _singleAddress(address account) private pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = account;
    }

    function _singleWeight(uint16 weight) private pure returns (uint16[] memory weights) {
        weights = new uint16[](1);
        weights[0] = weight;
    }

    function _sign(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
