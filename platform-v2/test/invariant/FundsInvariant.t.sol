// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreFixture} from "../helpers/CoreFixture.sol";
import {CallbackERC20} from "../helpers/Mocks.sol";
import {Vm} from "../helpers/TestBase.sol";
import {ClaimVaultV2} from "../../contracts/ClaimVaultV2.sol";
import {MerchantGuaranteeVaultV2} from "../../contracts/MerchantGuaranteeVaultV2.sol";
import {PaymentEscrowV2} from "../../contracts/PaymentEscrowV2.sol";
import {RewardLedgerV2} from "../../contracts/RewardLedgerV2.sol";

contract GuaranteeHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    CallbackERC20 public immutable usdt;
    MerchantGuaranteeVaultV2 public immutable vault;
    address public immutable merchant;
    address public immutable safe;
    uint256 public immutable secondaryKey;
    bytes32[] public cases;
    uint256 private _caseNonce;
    uint256 private _disbursementNonce;

    constructor(
        CallbackERC20 usdt_,
        MerchantGuaranteeVaultV2 vault_,
        address merchant_,
        address safe_,
        uint256 secondaryKey_
    ) {
        usdt = usdt_;
        vault = vault_;
        merchant = merchant_;
        safe = safe_;
        secondaryKey = secondaryKey_;
        usdt_.approve(address(vault_), type(uint256).max);
    }

    function depositGuarantee(uint96 rawAmount) external {
        uint256 amount = uint256(rawAmount) % 100 ether + 1;
        usdt.mint(address(this), amount);
        vault.depositGuarantee(merchant, amount);
    }

    function depositReserve(uint96 rawAmount) external {
        uint256 amount = uint256(rawAmount) % 100 ether + 1;
        usdt.mint(address(this), amount);
        vault.depositRiskReserve(amount);
    }

    function beginTakeover(uint96 rawAmount) external {
        uint256 amount = uint256(rawAmount) % 100 ether + 1;
        bytes32 orderId = keccak256(abi.encode("invariant-takeover", ++_caseNonce));
        try vault.reserveOrderCoverage(orderId, 1, merchant, amount) {
            try vault.beginTakeover(orderId, merchant, amount) {
                cases.push(orderId);
            } catch {}
        } catch {}
    }

    function disburse(uint256 rawIndex, uint96 rawAmount) external {
        if (cases.length == 0) return;
        bytes32 orderId = cases[rawIndex % cases.length];
        (,, uint256 requiredAmount,,,, uint256 disbursed,,,,) = vault.takeoverFunding(orderId);
        uint256 remaining = requiredAmount - disbursed;
        if (remaining == 0) return;
        uint256 amount = uint256(rawAmount) % remaining + 1;
        bytes32 evidenceHash = keccak256(abi.encode(orderId, amount));
        uint256 nonce = ++_disbursementNonce;
        uint64 deadline = type(uint64).max;
        bytes32 digest = vault.hashTakeoverDisbursement(orderId, address(0x9999), amount, evidenceHash, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(secondaryKey, digest);
        vm.prank(safe);
        vault.disburseTakeover(
            orderId, address(0x9999), amount, evidenceHash, nonce, deadline, abi.encodePacked(r, s, v)
        );
    }
}

contract FundsInvariantTest is CoreFixture {
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

    GuaranteeHandler private handler;
    uint256 private totalPaidNpl;
    uint256 private totalPaidUsdt;
    address[] private _targetContracts;

    function setUp() public override {
        super.setUp();
        bytes32 lockedOrder = keccak256("invariant-locked-order");
        bytes32 fulfilledOrder = keccak256("invariant-fulfilled-order");
        _payOrder(_makeOrder(lockedOrder, buyer, 400, false), BUYER_KEY);
        _payOrder(_makeOrder(fulfilledOrder, buyer, 401, false), BUYER_KEY);
        _fulfillByCustomer(fulfilledOrder, 400);
        totalPaidNpl = 1_000 ether;
        totalPaidUsdt = 100 ether;

        handler = new GuaranteeHandler(usdt, guaranteeVault, address(0x8888), safe, SECONDARY_KEY);
        vm.startPrank(safe);
        guaranteeVault.grantRole(guaranteeVault.TAKEOVER_ROLE(), address(handler));
        guaranteeVault.grantRole(guaranteeVault.ORDER_RESERVER_ROLE(), address(handler));
        vm.stopPrank();
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

    function invariant_EveryRecordedLiabilityIsFullyBacked() public view {
        assertTrue(usdt.balanceOf(address(paymentEscrow)) >= paymentEscrow.totalLockedUsdt());
        assertTrue(npl.balanceOf(address(rewardLedger)) >= rewardLedger.totalLockedNpl());
        assertTrue(usdt.balanceOf(address(claimVault)) >= claimVault.totalUsdtLiability());
        assertTrue(npl.balanceOf(address(claimVault)) >= claimVault.totalNplLiability());
        assertTrue(
            usdt.balanceOf(address(guaranteeVault))
                >= guaranteeVault.totalGuarantees() + guaranteeVault.riskReserveBalance()
                    + guaranteeVault.totalTakeoverLocked()
        );
        assertTrue(usdt.balanceOf(address(seckill)) >= seckill.totalUnsettledPrize());
    }

    function invariant_OrderNplAndUsdtStayConservedAcrossLockedAndReleasedStates() public view {
        assertEq(
            npl.balanceOf(paymentEscrow.NPL_BURN_ADDRESS()) + npl.balanceOf(address(rewardLedger))
                + npl.balanceOf(address(claimVault)) + npl.balanceOf(circulationPool),
            totalPaidNpl
        );
        assertEq(
            usdt.balanceOf(address(paymentEscrow)) + claimVault.totalUsdtLiability() + usdt.balanceOf(platformTreasury)
                + usdt.balanceOf(usdtRemainderAccount),
            totalPaidUsdt
        );
        assertEq(bnm.totalSupply() + claimVault.bnmClaimable(buyer), 100 ether);
    }
}
