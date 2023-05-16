// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { Amm } from "./Amm.sol";
import { UIntMath } from "./utils/UIntMath.sol";

contract AmmReader {
    using UIntMath for uint256;
    struct AmmStates {
        bool canLowerK;
        uint8 repegFlag;
        uint256 initMarginRatio;
        uint256 maintenanceMarginRatio;
        uint256 liquidationFeeRatio;
        uint256 partialLiquidationRatio;
        uint256 tradeLimitRatio;
        uint256 fluctuationLimitRatio;
        uint256 txFeeRatio;
        uint256 quoteAssetReserve;
        uint256 baseAssetReserve;
        uint256 longPositionSize;
        uint256 shortPositionSize;
        uint256 twapInterval;
        uint256 fundingPeriod;
        address priceFeed;
        bytes32 priceFeedKey;
        string quoteAssetSymbol;
        string baseAssetSymbol;
    }

    function getAmmStates(address _amm) external view returns (AmmStates memory) {
        Amm amm = Amm(_amm);
        (bool getSymbolSuccess, bytes memory quoteAssetSymbolData) = address(amm.quoteAsset()).staticcall(
            abi.encodeWithSignature("symbol()")
        );
        (uint256 quoteAssetReserve, uint256 baseAssetReserve) = amm.getReserve();

        bytes32 priceFeedKey = amm.priceFeedKey();
        return
            AmmStates({
                canLowerK: amm.canLowerK(),
                repegFlag: amm.repegFlag(),
                initMarginRatio: amm.initMarginRatio(),
                maintenanceMarginRatio: amm.maintenanceMarginRatio(),
                liquidationFeeRatio: amm.liquidationFeeRatio(),
                partialLiquidationRatio: amm.partialLiquidationRatio(),
                tradeLimitRatio: amm.tradeLimitRatio(),
                fluctuationLimitRatio: amm.fluctuationLimitRatio(),
                txFeeRatio: amm.spreadRatio() + amm.tollRatio(),
                quoteAssetReserve: quoteAssetReserve,
                baseAssetReserve: baseAssetReserve,
                longPositionSize: amm.longPositionSize(),
                shortPositionSize: amm.shortPositionSize(),
                twapInterval: amm.spotPriceTwapInterval(),
                fundingPeriod: amm.fundingPeriod(),
                priceFeed: address(amm.priceFeed()),
                priceFeedKey: priceFeedKey,
                quoteAssetSymbol: getSymbolSuccess ? abi.decode(quoteAssetSymbolData, (string)) : "",
                baseAssetSymbol: bytes32ToString(priceFeedKey)
            });
    }

    // TODO: move to library
    function bytes32ToString(bytes32 _key) private pure returns (string memory) {
        uint8 length;
        while (length < 32 && _key[length] != 0) {
            length++;
        }
        bytes memory bytesArray = new bytes(length);
        for (uint256 i = 0; i < 32 && _key[i] != 0; i++) {
            bytesArray[i] = _key[i];
        }
        return string(bytesArray);
    }
}
