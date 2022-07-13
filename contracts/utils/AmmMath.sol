// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import "./FullMath.sol";
import "./IntMath.sol";
import "./UIntMath.sol";

library AmmMath {
    using UIntMath for uint256;
    using IntMath for int256;
    uint128 constant K_DECREASE_MAX = 22 * 1e15; //2.2% decrease
    uint128 constant K_INCREASE_MAX = 1 * 1e15; //0.1% increase

    /**
     * calculate cost of repegging
     * @return cost if > 0, insurance fund should charge it
     */
    function adjustPegCost(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        int256 _positionSize,
        uint256 _newQuoteAssetReserve
    ) internal pure returns (int256 cost) {
        if (_quoteAssetReserve == _newQuoteAssetReserve || _positionSize == 0) {
            cost = 0;
        } else {
            uint256 positionSizeAbs = _positionSize.abs();
            if (_positionSize > 0) {
                cost =
                    FullMath.mulDiv(_newQuoteAssetReserve, positionSizeAbs, _baseAssetReserve + positionSizeAbs).toInt() -
                    FullMath.mulDiv(_quoteAssetReserve, positionSizeAbs, _baseAssetReserve + positionSizeAbs).toInt();
            } else {
                cost =
                    FullMath.mulDiv(_quoteAssetReserve, positionSizeAbs, _baseAssetReserve - positionSizeAbs).toInt() -
                    FullMath.mulDiv(_newQuoteAssetReserve, positionSizeAbs, _baseAssetReserve - positionSizeAbs).toInt();
            }
        }
    }

    function calcBudgetedQuoteReserve(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        int256 _positionSize,
        uint256 _budget
    ) internal pure returns (uint256 newQuoteAssetReserve) {
        newQuoteAssetReserve = _positionSize > 0
            ? _budget + _quoteAssetReserve + FullMath.mulDiv(_budget, _baseAssetReserve, _positionSize.abs())
            : _budget + _quoteAssetReserve - FullMath.mulDiv(_budget, _baseAssetReserve, _positionSize.abs());
    }

    function adjustKCost(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        int256 _positionSize,
        uint256 _numerator,
        uint256 _denominator
    )
        internal
        pure
        returns (
            int256 cost,
            uint256 newQuoteAssetReserve,
            uint256 newBaseAssetReserve
        )
    {
        newQuoteAssetReserve = _quoteAssetReserve.mulD(_numerator).divD(_denominator);
        newBaseAssetReserve = _baseAssetReserve.mulD(_numerator).divD(_denominator);
        if (_numerator == _denominator || _positionSize == 0) {
            cost = 0;
        } else {
            uint256 baseAsset = _positionSize > 0
                ? _baseAssetReserve + uint256(_positionSize)
                : _baseAssetReserve - uint256(0 - _positionSize);
            uint256 newBaseAsset = _positionSize > 0
                ? newBaseAssetReserve + uint256(_positionSize)
                : newBaseAssetReserve - uint256(0 - _positionSize);
            uint256 newTerminalQuoteAssetReserve = FullMath.mulDiv(newQuoteAssetReserve, newBaseAssetReserve, newBaseAsset);
            uint256 terminalQuoteAssetReserve = FullMath.mulDiv(_quoteAssetReserve, _baseAssetReserve, baseAsset);
            uint256 newPositionNotionalSize = _positionSize > 0
                ? newQuoteAssetReserve - newTerminalQuoteAssetReserve
                : newTerminalQuoteAssetReserve - newQuoteAssetReserve;
            uint256 positionNotionalSize = _positionSize > 0
                ? _quoteAssetReserve - terminalQuoteAssetReserve
                : terminalQuoteAssetReserve - _quoteAssetReserve;
            if (_positionSize < 0) {
                cost = positionNotionalSize.toInt() - newPositionNotionalSize.toInt();
            } else {
                cost = newPositionNotionalSize.toInt() - positionNotionalSize.toInt();
            }
        }
    }

    function calculateBudgetedKScale(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        int256 _budget,
        int256 _positionSize
    ) internal pure returns (uint256, uint256) {
        int256 x = _baseAssetReserve.toInt();
        int256 y = _quoteAssetReserve.toInt();
        int256 c = -_budget;
        int256 d = _positionSize;
        int256 x_d = x + d;
        int256 num1 = y.mulD(d).mulD(d);
        int256 num2 = c.mulD(x_d).mulD(d);
        int256 denom1 = c.mulD(x).mulD(x_d);
        int256 denom2 = num1;
        uint256 numerator = (num1 - num2).abs();
        uint256 denominator = (denom1 + denom2).abs();
        if (numerator > denominator) {
            uint256 kUpperBound = 1 ether + K_INCREASE_MAX;
            uint256 curChange = numerator.divD(denominator);
            uint256 maxChange = kUpperBound.divD(1 ether);
            if (curChange > maxChange) {
                return (kUpperBound, 1 ether);
            } else {
                return (numerator, denominator);
            }
        } else {
            uint256 kLowerBound = 1 ether - K_DECREASE_MAX;
            uint256 curChange = numerator.divD(denominator);
            uint256 maxChange = kLowerBound.divD(1 ether);
            if (curChange < maxChange) {
                return (kLowerBound, 1 ether);
            } else {
                return (numerator, denominator);
            }
        }
    }
}
