// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import "../Amm.sol";

contract AmmFake is Amm {
    constructor(
        uint256 _dcQuoteAssetReserve,
        uint256 _dcBaseAssetReserve,
        uint256 _dcTradeLimitRatio,
        uint256 _fundingPeriod,
        IPriceFeed _priceFeed,
        bytes32 _priceFeedKey,
        address _quoteAsset,
        uint256 _fluctuation,
        uint256 _tollRatio,
        uint256 _spreadRatio
    ) {
        Amm.initialize(
            _dcQuoteAssetReserve,
            _dcBaseAssetReserve,
            _dcTradeLimitRatio,
            _fundingPeriod,
            _priceFeed,
            _priceFeedKey,
            _quoteAsset,
            _fluctuation,
            _tollRatio,
            _spreadRatio
        );
    }

    uint256 private timestamp = 1444004400;
    uint256 private number = 10001;

    function mock_setBlockTimestamp(uint256 _timestamp) public {
        timestamp = _timestamp;
    }

    function mock_setBlockNumber(uint256 _number) public {
        number = _number;
    }

    function mock_getCurrentTimestamp() public view returns (uint256) {
        return _blockTimestamp();
    }

    function mock_getCurrentBlockNumber() public view returns (uint256) {
        return _blockNumber();
    }

    // Override BlockContext here
    function _blockTimestamp() internal view override returns (uint256) {
        return timestamp;
    }

    function _blockNumber() internal view override returns (uint256) {
        return number;
    }

    function getInputPriceWithReservesPublic(
        Dir _dir,
        uint256  _quoteAssetAmount,
        uint256  _quoteAssetPoolAmount,
        uint256  _baseAssetPoolAmount
    ) public view returns (uint256 ) {
        return getInputPriceWithReserves(_dir, _quoteAssetAmount, _quoteAssetPoolAmount, _baseAssetPoolAmount);
    }

    function getOutputPriceWithReservesPublic(
        Dir _dir,
        uint256  _baseAssetAmount,
        uint256  _quoteAssetPoolAmount,
        uint256  _baseAssetPoolAmount
    ) public view returns (uint256 ) {
        return getOutputPriceWithReserves(_dir, _baseAssetAmount, _quoteAssetPoolAmount, _baseAssetPoolAmount);
    }

    function mockSetReserve(uint256  _quoteReserve, uint256  _baseReserve) public {
        quoteAssetReserve = _quoteReserve;
        baseAssetReserve = _baseReserve;
    }
}
