// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAmm } from "./interfaces/IAmm.sol";
import { IInsuranceFund } from "./interfaces/IInsuranceFund.sol";
import { IClearingHouse } from "./interfaces/IClearingHouse.sol";
import { ClearingHouse } from "./ClearingHouse.sol";

import { IntMath } from "./utils/IntMath.sol";
import { UIntMath } from "./utils/UIntMath.sol";

contract ClearingHouseViewer {
    using UIntMath for uint256;
    using IntMath for int256;

    struct PositionInfo {
        address trader;
        IAmm amm;
        int256 positionSize; // the contract size of a position
        int256 openMargin; // the margin that is collateralized when opening
        int256 margin; // openMargin + fundingPayment + unrealizedPnl
        int256 unrealizedPnl; // the unrealized profit and loss of a position
        int256 fundingPayment; // the funding payment that a position has received since opening the position
        int256 marginRatio; // (openMargin + fundingPayment + unrealizedPnl) / positionNotional
        int256 liquidationPrice; // the excution price where a position is liquidated
        uint256 openLeverage; // the leverage that was used when opening a position
        uint256 leverage; // the current leverage, positionNotional / (openMargin + fundingPayment + unrealizedPnl)
        uint256 openNotional; // the notional value of a position when it is opened
        uint256 positionNotional; // the current notional value of a position
        uint256 entryPrice; // the excuted price when opening a price
        uint256 spotPrice; // the current vAmm price
        bool isLiquidatable;
        int256 unrealizedPnlWithoutPriceImpact;
    }

    struct OpenPositionEstResp {
        PositionInfo positionInfo;
        // the quote asset amount trader will send if open position, will receive if close
        uint256 exchangedQuoteAssetAmount;
        // if realizedPnl + realizedFundingPayment + margin is negative, it's the abs value of it
        uint256 badDebt;
        // the base asset amount trader will receive if open position, will send if close
        int256 exchangedPositionSize;
        // funding payment incurred during this position response
        // realizedPnl = unrealizedPnl * closedRatio
        int256 realizedPnl;
        // positive = trader transfer margin to vault, negative = trader receive margin from vault
        // it's 0 when reducePosition, its addedMargin when _increasePosition
        // it's min(0, openMargin + realizedFundingPayment + realizedPnl) when _closePosition
        int256 marginToVault;
        // fee to the insurance fund
        uint256 spreadFee;
        // fee to the toll pool which provides rewards to the token stakers
        uint256 tollFee;
    }

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
        position.margin =
            position.margin +
            _getFundingPayment(
                position,
                position.size > 0
                    ? clearingHouse.getLatestCumulativePremiumFractionLong(_amm)
                    : clearingHouse.getLatestCumulativePremiumFractionShort(_amm)
            );
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

        uint256 initMarginRatio = _amm.initMarginRatio();
        int256 marginRequirement = position.size > 0
            ? position.openNotional.toInt().mulD(initMarginRatio.toInt())
            : positionNotional.toInt().mulD(initMarginRatio.toInt());

        return minCollateral - marginRequirement;
    }

    function getTraderPositionInfo(IAmm amm, address trader) public view returns (PositionInfo memory positionInfo) {
        positionInfo.trader = trader;
        positionInfo.amm = amm;
        ClearingHouse.Position memory position = clearingHouse.getPosition(amm, trader);
        positionInfo.positionSize = position.size;
        positionInfo.openMargin = position.margin;
        positionInfo.openNotional = position.openNotional;
        (positionInfo.positionNotional, positionInfo.unrealizedPnl) = (
            clearingHouse.getPositionNotionalAndUnrealizedPnl(amm, trader, ClearingHouse.PnlCalcOption.SPOT_PRICE)
        );
        positionInfo.fundingPayment = _getFundingPayment(
            position,
            position.size > 0
                ? clearingHouse.getLatestCumulativePremiumFractionLong(amm)
                : clearingHouse.getLatestCumulativePremiumFractionShort(amm)
        );
        positionInfo.spotPrice = amm.getSpotPrice();
        positionInfo = _fillAdditionalPositionInfo(amm, positionInfo);
    }

    function getMarginAdjustmentEstimation(
        IAmm amm,
        address trader,
        int256 deltaMargin
    ) public view returns (PositionInfo memory positionInfo) {
        positionInfo = getTraderPositionInfo(amm, trader);
        if (deltaMargin >= 0) {
            positionInfo.openMargin = positionInfo.openMargin + deltaMargin;
        } else {
            positionInfo.openMargin = positionInfo.openMargin + deltaMargin + positionInfo.fundingPayment;
            positionInfo.fundingPayment = 0;
        }
        positionInfo = _fillAdditionalPositionInfo(amm, positionInfo);
    }

    function getOpenPositionEstimation(
        IAmm amm,
        address trader,
        IClearingHouse.Side side,
        uint256 quoteAmount,
        uint256 leverage
    ) public view returns (OpenPositionEstResp memory positionEst) {
        PositionInfo memory oldPositionInfo = getTraderPositionInfo(amm, trader);
        (uint256 quoteAssetReserve, uint256 baseAssetReserve) = amm.getReserve();
        int256 exchangedPositionSize;
        if (side == IClearingHouse.Side.BUY) {
            exchangedPositionSize = amm.getQuotePrice(IAmm.Dir.ADD_TO_AMM, quoteAmount).toInt();
            positionEst.positionInfo.spotPrice = (quoteAssetReserve + quoteAmount).divD(baseAssetReserve - exchangedPositionSize.abs());
        } else {
            exchangedPositionSize = (-1) * (amm.getQuotePrice(IAmm.Dir.REMOVE_FROM_AMM, quoteAmount).toInt());
            positionEst.positionInfo.spotPrice = (quoteAssetReserve - quoteAmount).divD(baseAssetReserve + exchangedPositionSize.abs());
        }
        positionEst.exchangedPositionSize = exchangedPositionSize;
        positionEst.exchangedQuoteAssetAmount = quoteAmount;
        (positionEst.tollFee, positionEst.spreadFee) = amm.calcFee(quoteAmount);

        // increase or decrease position depends on old position's side and size
        if (
            oldPositionInfo.positionSize == 0 ||
            (oldPositionInfo.positionSize > 0 ? IClearingHouse.Side.BUY : IClearingHouse.Side.SELL) == side
        ) {
            // increase position
            int256 increaseMarginRequirement = quoteAmount.divD(leverage).toInt();
            positionEst.positionInfo.openMargin = oldPositionInfo.openMargin + increaseMarginRequirement + oldPositionInfo.fundingPayment;
            positionEst.positionInfo.fundingPayment = 0;
            positionEst.positionInfo.openNotional = oldPositionInfo.openNotional + quoteAmount;
            positionEst.positionInfo.positionNotional = oldPositionInfo.positionNotional + quoteAmount;
            positionEst.positionInfo.unrealizedPnl = oldPositionInfo.unrealizedPnl;
            positionEst.marginToVault = increaseMarginRequirement;
        } else {
            // reverse position
            if (oldPositionInfo.positionNotional > quoteAmount) {
                positionEst.realizedPnl = oldPositionInfo.unrealizedPnl.mulD(exchangedPositionSize.abs().toInt()).divD(
                    oldPositionInfo.positionSize.abs().toInt()
                );
                positionEst.positionInfo.openMargin = oldPositionInfo.openMargin + positionEst.realizedPnl + oldPositionInfo.fundingPayment;
            } else {
                positionEst.realizedPnl = oldPositionInfo.unrealizedPnl;
                int256 remainMargin = oldPositionInfo.openMargin + positionEst.realizedPnl + oldPositionInfo.fundingPayment;
                int256 increaseMarginRquirement = (quoteAmount - oldPositionInfo.positionNotional).divD(leverage).toInt();
                positionEst.positionInfo.openMargin = increaseMarginRquirement;
                positionEst.marginToVault = increaseMarginRquirement - remainMargin;
            }
            positionEst.positionInfo.positionNotional = (oldPositionInfo.positionNotional.toInt() - quoteAmount.toInt()).abs();
            positionEst.positionInfo.fundingPayment = 0;
            positionEst.positionInfo.unrealizedPnl = oldPositionInfo.unrealizedPnl - positionEst.realizedPnl;
            int256 remainOpenNotional = oldPositionInfo.positionSize > 0
                ? oldPositionInfo.positionNotional.toInt() - quoteAmount.toInt() - positionEst.positionInfo.unrealizedPnl
                : positionEst.positionInfo.unrealizedPnl + oldPositionInfo.positionNotional.toInt() - quoteAmount.toInt();
            positionEst.positionInfo.openNotional = remainOpenNotional.abs();
        }
        positionEst.badDebt = positionEst.positionInfo.openMargin < 0 ? positionEst.positionInfo.openMargin.abs() : 0;
        positionEst.positionInfo.positionSize = oldPositionInfo.positionSize + exchangedPositionSize;
        positionEst.positionInfo = _fillAdditionalPositionInfo(amm, positionEst.positionInfo);
    }

    function getFundingRates(IAmm _amm)
        public
        view
        returns (
            int256 fundingRateLong,
            int256 fundingRateShort,
            int256 fundingPayment
        )
    {
        int256 premiumFractionLong;
        int256 premiumFractionShort;
        uint256 underlyingPrice;
        (, premiumFractionLong, premiumFractionShort, fundingPayment, underlyingPrice) = _amm.getFundingPaymentEstimation(
            type(uint256).max
        );
        fundingRateLong = premiumFractionLong.divD(underlyingPrice.toInt());
        fundingRateShort = premiumFractionShort.divD(underlyingPrice.toInt());
    }

    //
    // PRIVATE
    //

    // negative means trader paid and vice versa
    function _getFundingPayment(ClearingHouse.Position memory _position, int256 _latestCumulativePremiumFraction)
        private
        pure
        returns (int256)
    {
        return
            _position.size == 0
                ? int256(0)
                : (_latestCumulativePremiumFraction - _position.lastUpdatedCumulativePremiumFraction).mulD(_position.size) * -1;
    }

    function _fillAdditionalPositionInfo(IAmm amm, PositionInfo memory positionInfo) private view returns (PositionInfo memory) {
        positionInfo.margin = positionInfo.openMargin + positionInfo.fundingPayment + positionInfo.unrealizedPnl;
        if (positionInfo.positionNotional == uint256(0)) {
            positionInfo.marginRatio = 0;
        } else {
            positionInfo.marginRatio = positionInfo.margin.divD(int256(positionInfo.positionNotional));
        }
        positionInfo.isLiquidatable = positionInfo.marginRatio < int256(amm.maintenanceMarginRatio());
        uint256 oraclePrice = amm.getUnderlyingPrice();
        if (_isOverSpreadLimit(positionInfo.spotPrice, oraclePrice)) {
            uint256 positionNotionalBasedOnOracle = positionInfo.positionSize.abs().mulD(oraclePrice);
            int256 unrealizedPnlBasedOnOracle = positionInfo.positionSize < 0
                ? positionInfo.openNotional.toInt() - positionNotionalBasedOnOracle.toInt()
                : positionNotionalBasedOnOracle.toInt() - positionInfo.openNotional.toInt();
            if (positionNotionalBasedOnOracle != 0) {
                int256 marginRatioBasedOnOracle = (positionInfo.openMargin + positionInfo.fundingPayment + unrealizedPnlBasedOnOracle).divD(
                    positionNotionalBasedOnOracle.toInt()
                );
                positionInfo.isLiquidatable = marginRatioBasedOnOracle < int256(amm.maintenanceMarginRatio());
            }
        }

        positionInfo.entryPrice = positionInfo.positionSize == 0 ? 0 : positionInfo.openNotional.divD(positionInfo.positionSize.abs());
        positionInfo.openLeverage = positionInfo.openMargin <= 0 ? 0 : positionInfo.openNotional.divD(positionInfo.openMargin.abs());
        if (positionInfo.marginRatio <= 0) {
            positionInfo.leverage = 0;
        } else {
            positionInfo.leverage = int256(1 ether).divD(positionInfo.marginRatio).abs();
        }
        positionInfo.liquidationPrice = _getLiquidationPrice(
            amm,
            positionInfo.entryPrice,
            positionInfo.positionSize,
            positionInfo.openMargin,
            positionInfo.fundingPayment
        );
        positionInfo.unrealizedPnlWithoutPriceImpact = positionInfo.positionSize < 0
            ? positionInfo.openNotional.toInt() - positionInfo.positionSize.abs().mulD(positionInfo.spotPrice).toInt()
            : positionInfo.positionSize.abs().mulD(positionInfo.spotPrice).toInt() - positionInfo.openNotional.toInt();
        return positionInfo;
    }

    function _getLiquidationPrice(
        IAmm amm,
        uint256 entryPrice,
        int256 positionSize,
        int256 margin,
        int256 fundingPayment
    ) private view returns (int256) {
        uint256 maintenanceMarginRatio = amm.maintenanceMarginRatio();
        if (positionSize == 0) {
            return 0;
        } else if (positionSize > 0) {
            return (entryPrice.toInt() - (margin + fundingPayment).divD(positionSize)).divD(1 ether - maintenanceMarginRatio.toInt());
        } else {
            return (entryPrice.toInt() - (margin + fundingPayment).divD(positionSize)).divD(1 ether + maintenanceMarginRatio.toInt());
        }
    }

    function _isOverSpreadLimit(uint256 marketPrice, uint256 oraclePrice) internal view virtual returns (bool result) {
        uint256 oracleSpreadRatioAbs = (marketPrice.toInt() - oraclePrice.toInt()).divD(oraclePrice.toInt()).abs();
        result = oracleSpreadRatioAbs >= clearingHouse.LIQ_SWITCH_RATIO() ? true : false;
    }
}
