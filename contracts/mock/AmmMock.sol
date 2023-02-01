// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import "../Amm.sol";
import { UIntMath } from "../utils/UIntMath.sol";

contract AmmMock {
    using UIntMath for uint256;

    event Dir(Amm.Dir dir);

    IERC20 public quoteAsset;
    int256 public quoteAssetReserve;
    int256 public baseAssetReserve;

    /*
     * For removeMargin mocks
     */
    int256 private outputTwap;
    int256 private outputPrice;
    int256 private inputPrice;

    /*
     * For payFundingRate mocks
     */
    uint256 private _fundingRate;

    function mockSetFundingRate(uint256 _fr) public {
        _fundingRate = _fr;
    }

    function mockSetQuoteAsset(IERC20 _quoteAsset) public {
        quoteAsset = _quoteAsset;
    }

    function fundingRate() public view returns (uint256) {
        return _fundingRate;
    }

    function settleFunding() public {}

    function mockSetOutputTwap(int256 _outputTwap) public {
        outputTwap = _outputTwap;
    }

    function mockSetOutputPrice(int256 _outputPrice) public {
        outputPrice = _outputPrice;
    }

    function mockSetInputPrice(int256 _inputPrice) public {
        inputPrice = _inputPrice;
    }

    function getBaseTwap(Amm.Dir, int256) external view returns (int256) {
        return outputTwap;
    }

    function getBasePrice(Amm.Dir, int256) external view returns (int256) {
        return outputPrice;
    }

    function getQuotePrice(Amm.Dir, int256) external view returns (int256) {
        return inputPrice;
    }

    function getReserve() external view returns (int256, int256) {
        return (quoteAssetReserve, baseAssetReserve);
    }

    function swapInput(
        Amm.Dir,
        int256,
        int256
    ) external returns (int256) {
        return inputPrice;
    }

    function swapOutput(Amm.Dir, int256) external returns (int256) {
        return outputPrice;
    }

    function mockSetBaseAssetReserve(int256 _baseAssetReserve) public {
        baseAssetReserve = _baseAssetReserve;
    }

    function mockSetQuoteAssetReserve(int256 _quoteAssetReserve) public {
        quoteAssetReserve = _quoteAssetReserve;
    }
}
