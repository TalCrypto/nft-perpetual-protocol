// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPriceFeed } from "./IPriceFeed.sol";

interface IAmm {
    /**
     * @notice asset direction, used in getInputPrice, getOutputPrice, swapInput and swapOutput
     * @param ADD_TO_AMM add asset to Amm
     * @param REMOVE_FROM_AMM remove asset from Amm
     */
    enum Dir {
        ADD_TO_AMM,
        REMOVE_FROM_AMM
    }

    struct LiquidityChangedSnapshot {
        int256 cumulativeNotional;
        // the base/quote reserve of amm right before liquidity changed
        uint256 quoteAssetReserve;
        uint256 baseAssetReserve;
        // total position size owned by amm after last snapshot taken
        // `totalPositionSize` = currentBaseAssetReserve - lastLiquidityChangedHistoryItem.baseAssetReserve + prevTotalPositionSize
        int256 totalPositionSize;
    }

    function swapInput(
        Dir _dir,
        uint256 _quoteAssetAmount,
        uint256 _baseAssetAmountLimit,
        bool _canOverFluctuationLimit
    ) external returns (uint256);

    function swapOutput(
        Dir _dir,
        uint256 _baseAssetAmount,
        uint256 _quoteAssetAmountLimit
    ) external returns (uint256);

    function adjust(uint256 _quoteAssetReserve, uint256 _baseAssetReserve) external;

    function shutdown() external;

    function settleFunding() external returns (int256);

    function calcFee(uint256 _quoteAssetAmount) external view returns (uint256, uint256);

    //
    // VIEW
    //

    function getFormulaicRepegResult(uint256 budget)
        external
        view
        returns (
            bool,
            int256,
            uint256,
            uint256
        );

    function getFormulaicUpdateKResult(int256 budget)
        external
        view
        returns (
            int256 cost,
            uint256 newQuoteAssetReserve,
            uint256 newBaseAssetReserve
        );

    function isOverFluctuationLimit(Dir _dirOfBase, uint256 _baseAssetAmount) external view returns (bool);

    function calcBaseAssetAfterLiquidityMigration(
        int256 _baseAssetAmount,
        uint256 _fromQuoteReserve,
        uint256 _fromBaseReserve
    ) external view returns (int256);

    function getInputTwap(Dir _dir, uint256 _quoteAssetAmount) external view returns (uint256);

    function getOutputTwap(Dir _dir, uint256 _baseAssetAmount) external view returns (uint256);

    function getInputPrice(Dir _dir, uint256 _quoteAssetAmount) external view returns (uint256);

    function getOutputPrice(Dir _dir, uint256 _baseAssetAmount) external view returns (uint256);

    function getInputPriceWithReserves(
        Dir _dir,
        uint256 _quoteAssetAmount,
        uint256 _quoteAssetPoolAmount,
        uint256 _baseAssetPoolAmount
    ) external pure returns (uint256);

    function getOutputPriceWithReserves(
        Dir _dir,
        uint256 _baseAssetAmount,
        uint256 _quoteAssetPoolAmount,
        uint256 _baseAssetPoolAmount
    ) external pure returns (uint256);

    function getSpotPrice() external view returns (uint256);

    function getLiquidityHistoryLength() external view returns (uint256);

    // overridden by state variable
    function quoteAsset() external view returns (IERC20);

    function priceFeedKey() external view returns (bytes32);

    function tradeLimitRatio() external view returns (uint256);

    function fundingPeriod() external view returns (uint256);

    function priceFeed() external view returns (IPriceFeed);

    function getReserve() external view returns (uint256, uint256);

    function open() external view returns (bool);

    // can not be overridden by state variable due to type `Deciaml.decimal`
    function getSettlementPrice() external view returns (uint256);

    // function getBaseAssetDeltaThisFundingPeriod() external view returns (int256);

    function getCumulativeNotional() external view returns (int256);

    function getMaxHoldingBaseAsset() external view returns (uint256);

    function getOpenInterestNotionalCap() external view returns (uint256);

    function getLiquidityChangedSnapshots(uint256 i) external view returns (LiquidityChangedSnapshot memory);

    function getBaseAssetDelta() external view returns (int256);

    function getUnderlyingPrice() external view returns (uint256);

    function isOverSpreadLimit() external view returns (bool);
}
