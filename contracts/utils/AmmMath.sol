// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import "./FullMath.sol";
import "./IntMath.sol";
import "./UIntMath.sol";

library AmmMath {
    using UIntMath for uint256;
    using IntMath for int256;
    uint256 constant K_DECREASE_MAX = 0.999 ether; //99.9% decrease
    uint256 constant K_INCREASE_MAX = 1.001 ether; //100.1% increase

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
        newQuoteAssetReserve = FullMath.mulDiv(_quoteAssetReserve, _numerator, _denominator);
        newBaseAssetReserve = FullMath.mulDiv(_baseAssetReserve, _numerator, _denominator);
        if (_positionSize > 0) {
            uint256 newPositionNotionalSize = FullMath.mulDiv(
                newQuoteAssetReserve,
                uint256(_positionSize),
                newBaseAssetReserve + uint256(_positionSize)
            );
            uint256 positionNotionalSize = FullMath.mulDiv(
                _quoteAssetReserve,
                uint256(_positionSize),
                _baseAssetReserve + uint256(_positionSize)
            );
            cost = newPositionNotionalSize.toInt() - positionNotionalSize.toInt();
        } else {
            uint256 newPositionNotionalSize = FullMath.mulDiv(
                newQuoteAssetReserve,
                uint256(-_positionSize),
                newBaseAssetReserve - uint256(-_positionSize)
            );
            uint256 positionNotionalSize = FullMath.mulDiv(
                _quoteAssetReserve,
                uint256(-_positionSize),
                _baseAssetReserve - uint256(-_positionSize)
            );
            cost = positionNotionalSize.toInt() - newPositionNotionalSize.toInt();
        }
    }

    function calculateBudgetedKScale(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        int256 _budget,
        int256 _positionSize
    ) internal pure returns (uint256, uint256) {
        if (_positionSize == 0 && _budget > 0) {
            return (K_INCREASE_MAX, 1 ether);
        } else if (_positionSize == 0 && _budget < 0) {
            return (K_DECREASE_MAX, 1 ether);
        }
        int256 x = _baseAssetReserve.toInt();
        int256 y = _quoteAssetReserve.toInt();
        int256 x_d = x + _positionSize;
        int256 num1 = y.mulD(_positionSize).mulD(_positionSize);
        int256 num2 = _positionSize.mulD(x_d).mulD(_budget);
        int256 denom2 = x.mulD(x_d).mulD(_budget);
        int256 denom1 = num1;
        int256 numerator = num1 + num2;
        int256 denominator = denom1 - denom2;
        if (_budget > 0 && denominator < 0) {
            return (K_INCREASE_MAX, 1 ether);
        } else if (_budget < 0 && numerator < 0) {
            return (K_DECREASE_MAX, 1 ether);
        }
        // if (numerator > 0 != denominator > 0 || denominator == 0 || numerator == 0) {
        //     return (_budget > 0 ? K_INCREASE_MAX : K_DECREASE_MAX, 1 ether);
        // }
        uint256 absNum = numerator.abs();
        uint256 absDen = denominator.abs();
        if (absNum > absDen) {
            uint256 curChange = absNum.divD(absDen);
            uint256 maxChange = K_INCREASE_MAX.divD(1 ether);
            if (curChange > maxChange) {
                return (K_INCREASE_MAX, 1 ether);
            } else {
                return (absNum, absDen);
            }
        } else {
            uint256 curChange = absNum.divD(absDen);
            uint256 maxChange = K_DECREASE_MAX.divD(1 ether);
            if (curChange < maxChange) {
                return (K_DECREASE_MAX, 1 ether);
            } else {
                return (absNum, absDen);
            }
        }
    }
}
