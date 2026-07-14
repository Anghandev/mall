// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ITwapSourceV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract TwapOracleAdapterV2 {
    ITwapSourceV2 public immutable source;
    bytes32 public immutable oracleVersion;

    error InvalidAddress();
    error InvalidQuote();
    error StaleOracle();
    error InsufficientLiquidity();
    error ExcessiveDeviation(uint256 actualDeviationBps);

    constructor(ITwapSourceV2 source_, bytes32 oracleVersion_) {
        if (
            block.chainid != V2Types.BSC_CHAIN_ID || address(source_) == address(0)
                || source_.pair() != V2Types.NPL_USDT_PAIR || oracleVersion_ == bytes32(0)
        ) revert InvalidAddress();
        source = source_;
        oracleVersion = oracleVersion_;
    }

    function validateQuote(bytes32 requestedOracleVersion, uint256 usdtListPrice, uint256 signedNplQuoteAmount)
        external
        view
        returns (uint256 twapNplAmount)
    {
        if (requestedOracleVersion != oracleVersion || usdtListPrice == 0 || signedNplQuoteAmount == 0) {
            revert InvalidQuote();
        }
        uint128 usdtLiquidity;
        uint64 updatedAt;
        (twapNplAmount, usdtLiquidity, updatedAt) =
            source.consult(V2Types.NPL_USDT_PAIR, V2Types.USDT, V2Types.NPL, usdtListPrice, V2Types.ORACLE_WINDOW);
        if (twapNplAmount == 0 || updatedAt > block.timestamp) revert InvalidQuote();
        if (block.timestamp - updatedAt > V2Types.ORACLE_MAX_AGE) revert StaleOracle();
        if (usdtLiquidity < V2Types.ORACLE_MIN_USDT_LIQUIDITY) revert InsufficientLiquidity();

        uint256 difference = signedNplQuoteAmount > twapNplAmount
            ? signedNplQuoteAmount - twapNplAmount
            : twapNplAmount - signedNplQuoteAmount;
        uint256 deviationBps = Math.mulDiv(difference, V2Types.BPS, twapNplAmount, Math.Rounding.Ceil);
        if (deviationBps > V2Types.ORACLE_MAX_DEVIATION_BPS) revert ExcessiveDeviation(deviationBps);
    }
}
