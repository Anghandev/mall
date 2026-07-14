// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "../helpers/CoreFixture.sol";
import {CallbackERC20, MockTwapSource} from "../helpers/Mocks.sol";
import {Vm} from "../helpers/TestBase.sol";
import {PaymentRouterV2} from "../../contracts/PaymentRouterV2.sol";
import {V2Types} from "../../contracts/types/V2Types.sol";

contract PaymentHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    PaymentRouterV2 public immutable router;
    CallbackERC20 public immutable usdt;
    CallbackERC20 public immutable npl;
    MockTwapSource public immutable twapSource;
    address public immutable buyer;
    address public immutable merchant;
    address public immutable quoteSigner;
    uint256 public immutable buyerKey;
    uint256 public immutable quoteKey;
    bytes32 public immutable oracleVersion;
    bytes32 public immutable concessionAllocationHash;
    uint256 public totalUsdtPaid;
    uint256 public totalNplPaid;
    uint256 private _nonce;

    constructor(
        PaymentRouterV2 router_,
        CallbackERC20 usdt_,
        CallbackERC20 npl_,
        MockTwapSource twapSource_,
        address merchant_,
        uint256 buyerKey_,
        uint256 quoteKey_,
        bytes32 oracleVersion_,
        bytes32 concessionAllocationHash_
    ) {
        router = router_;
        usdt = usdt_;
        npl = npl_;
        twapSource = twapSource_;
        merchant = merchant_;
        buyerKey = buyerKey_;
        quoteKey = quoteKey_;
        buyer = vm.addr(buyerKey_);
        quoteSigner = vm.addr(quoteKey_);
        oracleVersion = oracleVersion_;
        concessionAllocationHash = concessionAllocationHash_;
        vm.startPrank(buyer);
        usdt_.approve(address(router_), type(uint256).max);
        npl_.approve(address(router_), type(uint256).max);
        vm.stopPrank();
    }

    function pay(uint96 rawSalt) external {
        uint256 nonce = ++_nonce;
        bytes32 orderId = keccak256(abi.encode("invariant-order", nonce, rawSalt));
        bytes32 reservationId = keccak256(abi.encode("invariant-reservation", nonce, rawSalt));
        usdt.mint(buyer, 70 ether);
        npl.mint(buyer, 300 ether);
        twapSource.setResult(1_000 ether, 50_000 ether, uint64(block.timestamp));
        V2Types.PaymentIntent memory intent = V2Types.PaymentIntent({
            orderId: orderId,
            policyVersion: 1,
            oracleVersion: oracleVersion,
            buyer: buyer,
            merchant: merchant,
            productId: keccak256("invariant-product"),
            skuId: keccak256("invariant-sku"),
            quantity: 1,
            fulfillmentMode: V2Types.FulfillmentMode.Delivery,
            fulfillmentTargetHash: keccak256("invariant-address"),
            regionCodeHash: keccak256(abi.encode(buyer)),
            productPolicyHash: keccak256("invariant-policy"),
            reservationId: reservationId,
            reservationHash: keccak256(abi.encode(reservationId)),
            reservationDeadline: uint64(block.timestamp + 10 minutes),
            issuedAt: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 5 minutes),
            nonce: nonce,
            listPriceUsdt: 100 ether,
            usdtPaymentAmount: 70 ether,
            nplQuoteAmount: 1_000 ether,
            nplPaymentAmount: 300 ether,
            nplBurnAmount: 200 ether,
            nplRewardAmount: 100 ether,
            merchantBaseReceivableUsdt: 60 ether,
            merchantConcessionBps: 2_500,
            merchantConcessionAmount: 15 ether,
            merchantNetReceivableUsdt: 45 ether,
            concessionAllocationHash: concessionAllocationHash,
            bnmAmount: 100 ether,
            seckill: false,
            sessionId: bytes32(0),
            beneficiaries: V2Types.BeneficiarySnapshot(
                address(0), address(0), address(0), address(0), address(0), address(0)
            )
        });
        bytes32 digest = router.hashPayment(intent);
        router.pay(intent, _sign(quoteKey, digest), _sign(buyerKey, digest));
        totalUsdtPaid += 70 ether;
        totalNplPaid += 300 ether;
    }

    function _sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract PaymentRouterInvariantTest is CoreFixture {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    PaymentHandler private handler;
    address[] private _targetContracts;

    function setUp() public override {
        super.setUp();
        handler = new PaymentHandler(
            router, usdt, npl, twapSource, merchant, 0x123456, QUOTE_KEY, ORACLE_VERSION, concessionAllocationHash
        );
        _targetContracts.push(address(handler));
    }

    function targetContracts() public view returns (address[] memory) {
        return _targetContracts;
    }

    function excludeContracts() public pure returns (address[] memory values) {}
    function targetSenders() public pure returns (address[] memory values) {}
    function excludeSenders() public pure returns (address[] memory values) {}
    function targetArtifacts() public pure returns (string[] memory values) {}
    function excludeArtifacts() public pure returns (string[] memory values) {}
    function targetSelectors() public pure returns (FuzzSelector[] memory values) {}
    function excludeSelectors() public pure returns (FuzzSelector[] memory values) {}
    function targetArtifactSelectors() public pure returns (FuzzArtifactSelector[] memory values) {}
    function targetInterfaces() public pure returns (FuzzInterface[] memory values) {}

    function invariant_RouterNeverCustodiesAndSafeTransfersConserve() public view {
        assertEq(usdt.balanceOf(address(router)), 0);
        assertEq(npl.balanceOf(address(router)), 0);
        assertEq(usdt.balanceOf(usdtCustodySafe), handler.totalUsdtPaid());
        assertEq(npl.balanceOf(V2Types.NPL_BURN_ADDRESS) + npl.balanceOf(nplRewardSafe), handler.totalNplPaid());
    }
}
