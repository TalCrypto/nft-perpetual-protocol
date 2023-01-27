// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IntMath } from "./IntMath.sol";
import { UIntMath } from "./UIntMath.sol";

library AmmMath {
    using UIntMath for uint256;
    using IntMath for int256;
    uint256 constant K_DECREASE_MAX = 0.998 ether; // 99.8% decrease
    uint256 constant K_INCREASE_MAX = 1.001 ether; // 100.1% increase

    /**
     * @notice calculate reserves after repegging with preserving K
     * @dev https://docs.google.com/document/d/1JcKFCFY7vDxys0eWl0K1B3kQEEz-mrr7VU3-JPLPkkE/edit?usp=sharing
     */
    function calcReservesAfterRepeg(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        uint256 _targetPrice,
        int256 _positionSize
    ) internal pure returns (uint256 newQuoteAssetReserve, uint256 newBaseAssetReserve) {
        uint256 spotPrice = _quoteAssetReserve.divD(_baseAssetReserve);
        newQuoteAssetReserve = Math.mulDiv(_baseAssetReserve, Math.sqrt(spotPrice.mulD(_targetPrice)), 1e9);
        newBaseAssetReserve = Math.mulDiv(_baseAssetReserve, Math.sqrt(spotPrice.divD(_targetPrice)), 1e9);
        // in case net user position size is short and its absolute value is bigger than the expected base asset reserve
        if (_positionSize < 0 && newBaseAssetReserve <= _positionSize.abs()) {
            newQuoteAssetReserve = _baseAssetReserve.mulD(_targetPrice);
            newBaseAssetReserve = _baseAssetReserve;
        }
    }

    // function calcBudgetedQuoteReserve(
    //     uint256 _quoteAssetReserve,
    //     uint256 _baseAssetReserve,
    //     int256 _positionSize,
    //     uint256 _budget
    // ) internal pure returns (uint256 newQuoteAssetReserve) {
    //     newQuoteAssetReserve = _positionSize > 0
    //         ? _budget + _quoteAssetReserve + Math.mulDiv(_budget, _baseAssetReserve, _positionSize.abs())
    //         : _budget + _quoteAssetReserve - Math.mulDiv(_budget, _baseAssetReserve, _positionSize.abs());
    // }

    /**
     *@notice calculate the cost for adjusting the reserves
     *@dev
     *For #long>#short (d>0): cost = (y'-x'y'/(x'+d)) - (y-xy/(x+d)) = y'd/(x'+d) - yd/(x+d)
     *For #long<#short (d<0): cost = (xy/(x-|d|)-y) - (x'y'/(x'-|d|)-y') = y|d|/(x-|d|) - y'|d|/(x'-|d|)
     *@param _quoteAssetReserve y
     *@param _baseAssetReserve x
     *@param _positionSize d
     *@param _newQuoteAssetReserve y'
     *@param _newBaseAssetReserve x'
     */

    function calcCostForAdjustReserves(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        int256 _positionSize,
        uint256 _newQuoteAssetReserve,
        uint256 _newBaseAssetReserve
    ) internal pure returns (int256 cost) {
        if (_positionSize > 0) {
            cost =
                (Math.mulDiv(_newQuoteAssetReserve, uint256(_positionSize), (_newBaseAssetReserve + uint256(_positionSize)))).toInt() -
                (Math.mulDiv(_quoteAssetReserve, uint256(_positionSize), (_baseAssetReserve + uint256(_positionSize)))).toInt();
        } else {
            cost =
                (Math.mulDiv(_quoteAssetReserve, uint256(-_positionSize), (_baseAssetReserve - uint256(-_positionSize)))).toInt() -
                (Math.mulDiv(_newQuoteAssetReserve, uint256(-_positionSize), (_newBaseAssetReserve - uint256(-_positionSize)))).toInt();
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
