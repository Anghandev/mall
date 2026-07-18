// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CoreFixture} from "./helpers/CoreFixture.sol";
import {V2Types} from "../contracts/types/V2Types.sol";

contract PaymentRouterFuzzV2Test is CoreFixture {
    function testFuzz_MulBpsMatchesFullPrecision(uint256 amount, uint16 rawBps) public pure {
        uint16 bps = uint16(uint256(rawBps) % 10_001);
        assertEq(V2Types.mulBps(amount, bps), Math.mulDiv(amount, bps, V2Types.BPS));
    }

    function testFuzz_PaymentConservesEveryAtomicUnit(
        uint96 rawListPrice,
        uint96 rawNplQuote,
        uint16 rawConcession,
        uint96 rawFreight
    ) public {
        uint256 listPrice = bound(uint256(rawListPrice), 10, 1_000_000 ether);
        uint256 nplQuote = bound(uint256(rawNplQuote), 10, 10_000_000 ether);
        uint16 concessionBps = uint16(bound(rawConcession, 0, 10_000));
        V2Types.PaymentIntent memory intent = _makePayment(
            keccak256(abi.encode("fuzz-order", rawListPrice, rawNplQuote, rawConcession)),
            buyer,
            uint256(keccak256(abi.encode(rawListPrice, rawNplQuote, rawConcession))),
            false,
            keccak256(abi.encode("fuzz-reservation", rawListPrice, rawNplQuote, rawConcession))
        );
        intent.freightUsdt = bound(uint256(rawFreight), 0, 100_000 ether);
        intent = _setAmounts(intent, listPrice, nplQuote, concessionBps);
        uint256 feeBefore = usdt.balanceOf(platformServiceFeeSafe);
        uint256 custodyBefore = usdt.balanceOf(usdtCustodySafe);
        uint256 burnBefore = npl.balanceOf(V2Types.NPL_BURN_ADDRESS);
        uint256 rewardBefore = npl.balanceOf(nplRewardSafe);

        _pay(intent, BUYER_KEY);

        assertEq(usdt.balanceOf(platformServiceFeeSafe) - feeBefore, intent.platformServiceFeeUsdt);
        assertEq(usdt.balanceOf(usdtCustodySafe) - custodyBefore, intent.custodyProductUsdt + intent.freightUsdt);
        assertEq(intent.platformServiceFeeUsdt + intent.custodyProductUsdt, intent.productUsdtPaymentAmount);
        assertEq(intent.productUsdtPaymentAmount + intent.freightUsdt, intent.usdtPaymentAmount);
        assertEq(npl.balanceOf(V2Types.NPL_BURN_ADDRESS) - burnBefore, intent.nplBurnAmount);
        assertEq(npl.balanceOf(nplRewardSafe) - rewardBefore, intent.nplRewardAmount);
        assertEq(intent.nplBurnAmount + intent.nplRewardAmount, intent.nplPaymentAmount);
        assertEq(intent.merchantConcessionAmount + intent.merchantNetReceivableUsdt, intent.merchantBaseReceivableUsdt);
        assertEq(usdt.balanceOf(address(router)), 0);
        assertEq(npl.balanceOf(address(router)), 0);
    }
}
