// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAmm } from "./interfaces/IAmm.sol";
import { IInsuranceFund } from "./interfaces/IInsuranceFund.sol";
import { ClearingHouse } from "./ClearingHouse.sol";

import { IntMath } from "./utils/IntMath.sol";
import { UIntMath } from "./utils/UIntMath.sol";

contract ClearingHouseViewer {
    using UIntMath for uint256;
    using IntMath for int256;

    ClearingHouse public clearingHouse;

    //
    // FUNCTIONS
    //

    constructor(ClearingHouse _clearingHouse) {
        clearingHouse = _clearingHouse;
    }

    //
    // Public
    //

    /**
     * @notice get unrealized PnL
     * @param _amm IAmm address
     * @param _trader trader address
     * @param _pnlCalcOption ClearingHouse.PnlCalcOption, can be SPOT_PRICE or TWAP.
     * @return unrealized PnL in 18 digits
     */
    function getUnrealizedPnl(
        IAmm _amm,
        address _trader,
        ClearingHouse.PnlCalcOption _pnlCalcOption
    ) external view returns (int256) {
        (, int256 unrealizedPnl) = (clearingHouse.getPositionNotionalAndUnrealizedPnl(_amm, _trader, _pnlCalcOption));
        return unrealizedPnl;
    }

    /**
     * @notice get personal balance with funding payment
     * @param _quoteToken ERC20 token address
     * @param _trader trader address
     * @return margin personal balance with funding payment in 18 digits
     */
    function getPersonalBalanceWithFundingPayment(IERC20 _quoteToken, address _trader) external view returns (int256 margin) {
        IInsuranceFund insuranceFund = clearingHouse.insuranceFund();
        IAmm[] memory amms = insuranceFund.getAllAmms();
        for (uint256 i = 0; i < amms.length; i++) {
            if (IAmm(amms[i]).quoteAsset() != _quoteToken) {
                continue;
            }
            int256 posMargin = getPersonalPositionWithFundingPayment(amms[i], _trader).margin;
            margin = margin + posMargin;
        }
    }

    /**
     * @notice get personal position with funding payment
     * @param _amm IAmm address
     * @param _trader trader address
     * @return position ClearingHouse.Position struct
     */
    function getPersonalPositionWithFundingPayment(IAmm _amm, address _trader)
        public
        view
        returns (ClearingHouse.Position memory position)
    {
        position = clearingHouse.getPosition(_amm, _trader);
        position.margin = position.margin + getFundingPayment(position, clearingHouse.getLatestCumulativePremiumFraction(_amm));
        // position.margin = marginWithFundingPayment >= 0 ? marginWithFundingPayment.abs() : 0;
    }

    /**
     * @notice get personal margin ratio
     * @param _amm IAmm address
     * @param _trader trader address
     * @return personal margin ratio in 18 digits
     */
    function getMarginRatio(IAmm _amm, address _trader) external view returns (int256) {
        return clearingHouse.getMarginRatio(_amm, _trader);
    }

    /**
     * @notice get withdrawable margin
     * @param _amm IAmm address
     * @param _trader trader address
     * @return withdrawable margin in 18 digits
     */
    function getFreeCollateral(IAmm _amm, address _trader) external view returns (int256) {
        // get trader's margin
        ClearingHouse.Position memory position = getPersonalPositionWithFundingPayment(_amm, _trader);

        // get trader's unrealized PnL and choose the least beneficial one for the trader
        (uint256 spotPositionNotional, int256 spotPricePnl) = (
            clearingHouse.getPositionNotionalAndUnrealizedPnl(_amm, _trader, ClearingHouse.PnlCalcOption.SPOT_PRICE)
        );
        (uint256 twapPositionNotional, int256 twapPricePnl) = (
            clearingHouse.getPositionNotionalAndUnrealizedPnl(_amm, _trader, ClearingHouse.PnlCalcOption.TWAP)
        );

        int256 unrealizedPnl;
        uint256 positionNotional;
        (unrealizedPnl, positionNotional) = (spotPricePnl > twapPricePnl)
            ? (twapPricePnl, twapPositionNotional)
            : (spotPricePnl, spotPositionNotional);

        // min(margin + funding, margin + funding + unrealized PnL) - position value * initMarginRatio
        int256 accountValue = unrealizedPnl + position.margin;
        int256 minCollateral = accountValue - position.margin > 0 ? position.margin : accountValue;

        uint256 initMarginRatio = clearingHouse.initMarginRatio();
        int256 marginRequirement = position.size > 0
            ? position.openNotional.toInt().mulD(initMarginRatio.toInt())
            : positionNotional.toInt().mulD(initMarginRatio.toInt());

        return minCollateral - marginRequirement;
    }

    //
    // PRIVATE
    //

    // negative means trader paid and vice versa
    function getFundingPayment(ClearingHouse.Position memory _position, int256 _latestCumulativePremiumFraction)
        private
        pure
        returns (int256)
    {
        return
            _position.size == 0
                ? int256(0)
                : (_latestCumulativePremiumFraction - _position.lastUpdatedCumulativePremiumFraction).mulD(_position.size) * -1;
    }
}
