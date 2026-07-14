// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ITwapSourceV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract TwapOracleAdapterV2 {
    ITwapSourceV2 public immutable source;
    address public immutable usdt;
    address public immutable npl;
    bytes32 public immutable oracleVersion;

    error InvalidAddress();
    error InvalidQuote();
    error StaleOracle();
    error InsufficientLiquidity();
    error ExcessiveDeviation(uint256 actualDeviationBps);

    constructor(ITwapSourceV2 source_, address usdt_, address npl_, bytes32 oracleVersion_) {
        if (address(source_) == address(0) || usdt_ == address(0) || npl_ == address(0) || usdt_ == npl_) {
            revert InvalidAddress();
        }
        if (
            block.chainid != V2Types.BSC_CHAIN_ID || usdt_ != V2Types.USDT || npl_ != V2Types.NPL
                || oracleVersion_ == bytes32(0)
        ) revert InvalidAddress();
        source = source_;
        usdt = usdt_;
        npl = npl_;
        oracleVersion = oracleVersion_;
    }

    function validateQuote(
        bytes32 requestedOracleVersion,
        uint256 usdtAmount,
        uint256 signedNplAmount,
        uint64 maxAge,
        uint128 minimumLiquidity
    ) external view returns (uint256 twapNplAmount) {
        if (
            requestedOracleVersion != oracleVersion || usdtAmount == 0 || signedNplAmount == 0 || maxAge == 0
                || minimumLiquidity == 0
        ) revert InvalidQuote();
        uint128 liquidity;
        uint64 updatedAt;
        (twapNplAmount, liquidity, updatedAt) = source.consult(usdt, npl, usdtAmount, V2Types.ORACLE_WINDOW);
        if (twapNplAmount == 0 || updatedAt > block.timestamp) revert InvalidQuote();
        if (block.timestamp - updatedAt > maxAge) revert StaleOracle();
        if (liquidity < minimumLiquidity) revert InsufficientLiquidity();

        uint256 difference =
            signedNplAmount > twapNplAmount ? signedNplAmount - twapNplAmount : twapNplAmount - signedNplAmount;
        uint256 deviationBps = Math.mulDiv(difference, V2Types.BPS, twapNplAmount, Math.Rounding.Ceil);
        if (deviationBps > V2Types.ORACLE_MAX_DEVIATION_BPS) revert ExcessiveDeviation(deviationBps);
    }
}
