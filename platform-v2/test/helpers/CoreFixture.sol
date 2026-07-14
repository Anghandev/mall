// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase} from "./TestBase.sol";
import {CallbackERC20, Mock1271Wallet, MockCredential, MockTwapSource} from "./Mocks.sol";
import {BNMTokenV2} from "../../contracts/BNMTokenV2.sol";
import {BeneficiaryRegistryV2} from "../../contracts/BeneficiaryRegistryV2.sol";
import {ClaimVaultV2} from "../../contracts/ClaimVaultV2.sol";
import {MerchantGuaranteeVaultV2} from "../../contracts/MerchantGuaranteeVaultV2.sol";
import {PaymentEscrowV2} from "../../contracts/PaymentEscrowV2.sol";
import {PolicyRegistryV2} from "../../contracts/PolicyRegistryV2.sol";
import {RewardLedgerV2} from "../../contracts/RewardLedgerV2.sol";
import {SeckillV2} from "../../contracts/SeckillV2.sol";
import {TwapOracleAdapterV2} from "../../contracts/TwapOracleAdapterV2.sol";
import {
    IBeneficiaryRegistryV2,
    IBNMTokenV2,
    IClaimVaultV2,
    IMerchantGuaranteeVaultV2,
    IPaymentEscrowV2,
    IPolicyRegistryV2,
    IRewardLedgerV2,
    ITwapOracleV2
} from "../../contracts/interfaces/IV2Core.sol";
import {V2Types} from "../../contracts/types/V2Types.sol";

abstract contract CoreFixture is TestBase {
    uint256 internal constant SAFE_KEY = 0xA11CE;
    uint256 internal constant SECONDARY_KEY = 0xB0B;
    uint256 internal constant QUOTE_KEY = 0xC0DE;
    uint256 internal constant FINALITY_KEY = 0xD00D;
    uint256 internal constant BUYER_KEY = 0xBEEF;
    uint256 internal constant MERCHANT_KEY = 0xCAFE;
    uint256 internal constant DIRECT_REFERRAL_KEY = 0xD1CE;
    bytes32 internal constant ORACLE_VERSION = keccak256("oracle-v1");

    address internal safe;
    address internal secondarySigner;
    address internal quoteSigner;
    address internal finalitySigner;
    address internal buyer;
    address internal merchant;
    address internal genesis = address(0x5002);
    address internal directReferral;
    address internal district = address(0x5004);
    address internal city = address(0x5005);
    address internal province = address(0x5006);
    address internal region = address(0x5007);
    address internal operationsOne = address(0x6001);
    address internal operationsTwo = address(0x6002);
    address internal circulationPool = address(0x7001);
    address internal platformTreasury = address(0x7002);
    address internal usdtRemainderAccount = address(0x7003);
    bytes32 internal regionCodeHash = keccak256("210211");

    CallbackERC20 internal usdt;
    CallbackERC20 internal npl;
    MockCredential internal credential;
    MockTwapSource internal twapSource;
    PolicyRegistryV2 internal policyRegistry;
    BeneficiaryRegistryV2 internal beneficiaryRegistry;
    TwapOracleAdapterV2 internal oracle;
    BNMTokenV2 internal bnm;
    ClaimVaultV2 internal claimVault;
    RewardLedgerV2 internal rewardLedger;
    MerchantGuaranteeVaultV2 internal guaranteeVault;
    PaymentEscrowV2 internal paymentEscrow;
    SeckillV2 internal seckill;

    function setUp() public virtual {
        vm.chainId(56);
        vm.warp(1_800_000_000);
        safe = vm.addr(SAFE_KEY);
        secondarySigner = vm.addr(SECONDARY_KEY);
        quoteSigner = vm.addr(QUOTE_KEY);
        finalitySigner = vm.addr(FINALITY_KEY);
        buyer = vm.addr(BUYER_KEY);
        merchant = vm.addr(MERCHANT_KEY);
        directReferral = vm.addr(DIRECT_REFERRAL_KEY);

        CallbackERC20 usdtImplementation = new CallbackERC20("Mock USDT", "USDT");
        CallbackERC20 nplImplementation = new CallbackERC20("Mock NPL", "NPL");
        vm.etch(V2Types.USDT, address(usdtImplementation).code);
        vm.etch(V2Types.NPL, address(nplImplementation).code);
        usdt = CallbackERC20(V2Types.USDT);
        npl = CallbackERC20(V2Types.NPL);
        credential = new MockCredential();
        twapSource = new MockTwapSource();
        twapSource.setResult(1_000 ether, 1_000_000 ether, uint64(block.timestamp));

        policyRegistry = new PolicyRegistryV2(safe, secondarySigner);
        _publishLaunchPolicy();
        beneficiaryRegistry = new BeneficiaryRegistryV2(IPolicyRegistryV2(address(policyRegistry)));
        oracle = new TwapOracleAdapterV2(twapSource, address(usdt), address(npl), ORACLE_VERSION);
        bnm = new BNMTokenV2(safe);
        claimVault = new ClaimVaultV2(safe, usdt, npl, IBNMTokenV2(address(bnm)));
        rewardLedger = new RewardLedgerV2(
            safe, npl, IPolicyRegistryV2(address(policyRegistry)), IClaimVaultV2(address(claimVault))
        );
        guaranteeVault = new MerchantGuaranteeVaultV2(
            safe, usdt, IPolicyRegistryV2(address(policyRegistry)), IClaimVaultV2(address(claimVault))
        );
        paymentEscrow = new PaymentEscrowV2(
            safe,
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
        seckill = new SeckillV2(
            usdt,
            IPolicyRegistryV2(address(policyRegistry)),
            IMerchantGuaranteeVaultV2(address(guaranteeVault)),
            IPaymentEscrowV2(address(paymentEscrow)),
            IClaimVaultV2(address(claimVault)),
            quoteSigner
        );
        _wireRoles();
        _configureBeneficiaries();
        _fundActors();
    }

    function _publishLaunchPolicy() internal {
        address[] memory operationsAccounts = new address[](2);
        operationsAccounts[0] = operationsOne;
        operationsAccounts[1] = operationsTwo;
        uint16[] memory operationsWeights = new uint16[](2);
        operationsWeights[0] = 6_000;
        operationsWeights[1] = 4_000;

        V2Types.Policy memory policy = V2Types.Policy({
            version: 1,
            usdtPaymentBps: 5_000,
            nplPaymentBps: 5_000,
            burnBps: 2_000,
            routeBps: 8_000,
            genesisBps: 200,
            directReferralBps: 100,
            districtBps: 120,
            cityBps: 80,
            provinceBps: 60,
            regionBps: 40,
            operationsBps: 400,
            merchantStoreBps: 100,
            platformFeeBps: 500,
            seckillPrizeBps: 1_000,
            seckillMainDuration: 60 minutes,
            relayInitial: 60 seconds,
            relayIncrement: 30 seconds,
            relayCap: 60 seconds,
            oracleVersion: ORACLE_VERSION,
            oracleMaxAge: 10 minutes,
            oracleMinLiquidity: 100 ether,
            merchantGuaranteeMinimum: 100 ether,
            platformRiskReserveMinimum: 100 ether,
            guaranteeTopupLine: 50 ether,
            platformTreasury: platformTreasury,
            circulationPool: circulationPool,
            usdtRemainderAccount: usdtRemainderAccount,
            genesisCredential: address(credential),
            genesisTokenId: 1,
            genesisCredentialStandard: V2Types.CredentialStandard.ERC721,
            beneficiarySetHash: keccak256(abi.encode(operationsAccounts, operationsWeights)),
            decisionEvidenceHash: keccak256("test-policy-decision-evidence"),
            rulesContentHash: keccak256("frozen-seckill-rules")
        });
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = policyRegistry.hashPublication(policy, operationsAccounts, operationsWeights, 1, deadline);
        bytes memory signature = _sign(SECONDARY_KEY, digest);
        vm.prank(safe);
        policyRegistry.publishPolicy(policy, operationsAccounts, operationsWeights, 1, deadline, signature);
    }

    function _wireRoles() internal {
        vm.startPrank(safe);
        bnm.grantRole(bnm.MINTER_ROLE(), address(claimVault));
        claimVault.grantRole(claimVault.MERCHANT_CREDITOR_ROLE(), address(paymentEscrow));
        claimVault.grantRole(claimVault.REWARD_CREDITOR_ROLE(), address(rewardLedger));
        claimVault.grantRole(claimVault.PRIZE_CREDITOR_ROLE(), address(seckill));
        claimVault.grantRole(claimVault.BNM_CREDITOR_ROLE(), address(paymentEscrow));
        claimVault.grantRole(claimVault.MERCHANT_FREEZER_ROLE(), address(paymentEscrow));
        claimVault.grantRole(claimVault.MERCHANT_ENCUMBER_ROLE(), address(guaranteeVault));
        rewardLedger.grantRole(rewardLedger.PAYMENT_LOCKER_ROLE(), address(paymentEscrow));
        rewardLedger.grantRole(rewardLedger.FULFILLMENT_RELEASER_ROLE(), address(paymentEscrow));
        guaranteeVault.grantRole(guaranteeVault.TAKEOVER_ROLE(), address(paymentEscrow));
        guaranteeVault.grantRole(guaranteeVault.ORDER_RESERVER_ROLE(), address(paymentEscrow));
        guaranteeVault.grantRole(guaranteeVault.TAKEOVER_CLOSER_ROLE(), address(paymentEscrow));
        claimVault.grantRole(claimVault.MERCHANT_CREDITOR_ROLE(), address(guaranteeVault));
        paymentEscrow.grantRole(paymentEscrow.SECKILL_ROLE(), address(seckill));
        vm.stopPrank();
    }

    function _configureBeneficiaries() internal {
        credential.mint(genesis);
        vm.startPrank(safe);
        beneficiaryRegistry.setReferrer(buyer, directReferral);
        beneficiaryRegistry.setRegionBeneficiaries(
            regionCodeHash, BeneficiaryRegistryV2.RegionBeneficiaries(district, city, province, region)
        );
        vm.stopPrank();
    }

    function _fundActors() internal {
        usdt.mint(buyer, 100_000 ether);
        npl.mint(buyer, 100_000 ether);
        usdt.mint(safe, 100_000 ether);
        vm.startPrank(buyer);
        usdt.approve(address(paymentEscrow), type(uint256).max);
        npl.approve(address(paymentEscrow), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(safe);
        usdt.approve(address(guaranteeVault), type(uint256).max);
        usdt.approve(address(seckill), type(uint256).max);
        guaranteeVault.depositGuarantee(merchant, 500 ether);
        guaranteeVault.depositRiskReserve(500 ether);
        vm.stopPrank();
    }

    function _makeOrder(bytes32 orderId, address orderBuyer, uint256 nonce, bool isSeckill)
        internal
        view
        returns (V2Types.OrderIntent memory intent)
    {
        uint256 prizeAmount = isSeckill ? 10 ether : 0;
        intent = V2Types.OrderIntent({
            orderId: orderId,
            policyVersion: 1,
            oracleVersion: ORACLE_VERSION,
            buyer: orderBuyer,
            merchant: merchant,
            productId: keccak256("product-1"),
            skuId: keccak256("sku-1"),
            quantity: 1,
            fulfillmentMode: V2Types.FulfillmentMode.Delivery,
            fulfillmentTargetHash: keccak256("address-snapshot"),
            regionCodeHash: regionCodeHash,
            productPolicyHash: keccak256("product-policy-1"),
            reservationId: keccak256(abi.encode("reservation", orderId, isSeckill)),
            reservationHash: keccak256(abi.encode("reservation-details", orderId, isSeckill)),
            reservationDeadline: uint64(block.timestamp + 30 minutes),
            nonce: nonce,
            deadline: uint64(block.timestamp + 1 hours),
            listPriceUsdt: 100 ether,
            usdtPaymentAmount: 50 ether,
            nplPaymentAmount: 500 ether,
            rewardBaseNpl: 1_000 ether,
            merchantUsdtAmount: 30 ether,
            platformUsdtAmount: 5 ether,
            prizeUsdtAmount: prizeAmount,
            usdtRemainderAmount: isSeckill ? 5 ether : 15 ether,
            bnmAmount: 100 ether,
            seckill: isSeckill,
            sessionId: isSeckill ? keccak256("session-1") : bytes32(0),
            beneficiaries: V2Types.BeneficiarySnapshot({
                genesis: genesis,
                directReferral: beneficiaryRegistry.referrerOf(orderBuyer),
                district: district,
                city: city,
                province: province,
                region: region,
                merchantStore: merchant
            })
        });
    }

    function _payOrder(V2Types.OrderIntent memory intent, uint256 buyerKey) internal {
        bytes32 digest = paymentEscrow.hashOrder(intent);
        paymentEscrow.payOrder(intent, _sign(QUOTE_KEY, digest), _sign(buyerKey, digest));
    }

    function _fulfillByCustomer(bytes32 orderId, uint256 attestationNonce) internal {
        bytes32 shipmentHash = keccak256(abi.encode("shipment", orderId));
        bytes32 deliveryHash = keccak256(abi.encode("delivery", orderId));
        bytes32 receiptHash = keccak256(abi.encode("receipt", orderId));
        vm.startPrank(safe);
        paymentEscrow.recordShipmentEvidence(orderId, shipmentHash);
        paymentEscrow.recordDeliveryEvidence(orderId, deliveryHash);
        vm.stopPrank();
        vm.prank(buyer);
        paymentEscrow.requestCustomerReceipt(orderId, receiptHash);

        V2Types.FulfillmentAttestation memory attestation = V2Types.FulfillmentAttestation({
            orderId: orderId,
            method: V2Types.FulfillmentMethod.CustomerReceipt,
            sourceChainId: 56,
            sourceContract: address(paymentEscrow),
            sourceEventHash: paymentEscrow.FULFILLMENT_REQUEST_EVENT_SIGNATURE(),
            sourceTxHash: keccak256(abi.encode("tx", orderId)),
            blockHash: keccak256(abi.encode("block", orderId)),
            confirmations: 12,
            status: 1,
            nonce: attestationNonce,
            deadline: uint64(block.timestamp + 1 hours),
            evidenceHash: receiptHash
        });
        bytes32 digest = paymentEscrow.hashFinality(attestation);
        paymentEscrow.finalizeFulfillment(attestation, _sign(FINALITY_KEY, digest));
    }

    function _sign(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
