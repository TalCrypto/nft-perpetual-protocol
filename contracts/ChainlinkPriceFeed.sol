// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import { OwnableUpgradeableSafe } from "./OwnableUpgradeableSafe.sol";
import { IPriceFeed } from "./interfaces/IPriceFeed.sol";
import { BlockContext } from "./utils/BlockContext.sol";

contract ChainlinkPriceFeed is IPriceFeed, OwnableUpgradeableSafe, BlockContext {
    //**********************************************************//
    //    The below state variables can not change the order    //
    //**********************************************************//

    // key by bytes of amm symbol, eg BAYC/ETH
    mapping(bytes32 => AggregatorV3Interface) public aggregators;

    //**********************************************************//
    //    The above state variables can not change the order    //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    //
    // FUNCTIONS
    //
    function initialize() public initializer {
        __Ownable_init();
    }

    function addAggregator(bytes32 _priceFeedKey, address _aggregator) external onlyOwner {
        _requireNonEmptyAddress(_aggregator);
        aggregators[_priceFeedKey] = AggregatorV3Interface(_aggregator);
    }

    function removeAggregator(bytes32 _priceFeedKey) external onlyOwner {
        _requireNonEmptyAddress(address(aggregators[_priceFeedKey]));
        delete aggregators[_priceFeedKey];
    }

    //
    // INTERFACE IMPLEMENTATION
    //

    function setLatestData(
        bytes32,
        uint256,
        uint256,
        uint256
    ) external pure override {
        revert("CL_NS"); //not supported
    }

    function getPrice(bytes32 _priceFeedKey) public view override returns (uint256) {
        AggregatorV3Interface aggregator = aggregators[_priceFeedKey];
        _requireNonEmptyAddress(address(aggregator));

        (, uint256 latestPrice, ) = _getLatestRoundData(aggregator);
        return latestPrice;
    }

    function getLatestTimestamp(bytes32 _priceFeedKey) external view override returns (uint256) {
        AggregatorV3Interface aggregator = aggregators[_priceFeedKey];
        _requireNonEmptyAddress(address(aggregator));

        (, , uint256 latestTimestamp) = _getLatestRoundData(aggregator);
        return latestTimestamp;
    }

    // oracle price itself is twap so returns it as twap
    function getTwapPrice(bytes32 _priceFeedKey, uint256) external view override returns (uint256) {
        return getPrice(_priceFeedKey);
    }

    function getPreviousPrice(bytes32 _priceFeedKey, uint256 _numOfRoundBack) external view override returns (uint256) {
        AggregatorV3Interface aggregator = aggregators[_priceFeedKey];
        _requireNonEmptyAddress(address(aggregator));

        (uint80 round, , , , ) = aggregator.latestRoundData();
        uint64 aggregatorRoundId = uint64(round); // starts at 1
        require(aggregatorRoundId > _numOfRoundBack, "CL_NEH"); //Not enough history
        (, int256 previousPrice, , , ) = aggregator.getRoundData(round - uint80(_numOfRoundBack));
        _requirePositivePrice(previousPrice);
        return uint256(previousPrice);
    }

    function getPreviousTimestamp(bytes32 _priceFeedKey, uint256 _numOfRoundBack) external view override returns (uint256) {
        AggregatorV3Interface aggregator = aggregators[_priceFeedKey];
        _requireNonEmptyAddress(address(aggregator));

        (uint80 round, , , , ) = aggregator.latestRoundData();
        uint64 aggregatorRoundId = uint64(round); // starts at 1
        require(aggregatorRoundId > _numOfRoundBack, "CL_NEH"); //Not enough history
        (, int256 previousPrice, , uint256 previousTimestamp, ) = aggregator.getRoundData(round - uint80(_numOfRoundBack));
        _requirePositivePrice(previousPrice);
        return previousTimestamp;
    }

    function decimals(bytes32 _priceFeedKey) external view override returns (uint8) {
        AggregatorV3Interface aggregator = aggregators[_priceFeedKey];
        _requireNonEmptyAddress(address(aggregator));
        return aggregator.decimals();
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //

    function _getLatestRoundData(AggregatorV3Interface _aggregator)
        internal
        view
        returns (
            uint80,
            uint256 finalPrice,
            uint256
        )
    {
        (uint80 round, int256 latestPrice, , uint256 latestTimestamp, ) = _aggregator.latestRoundData();
        finalPrice = uint256(latestPrice);
        if (latestPrice <= 0) {
            _requireEnoughHistory(round);
            (round, finalPrice, latestTimestamp) = _getRoundData(_aggregator, round - 1);
        }
        return (round, finalPrice, latestTimestamp);
    }

    function _getRoundData(AggregatorV3Interface _aggregator, uint80 _round)
        internal
        view
        returns (
            uint80,
            uint256,
            uint256
        )
    {
        (uint80 round, int256 latestPrice, , uint256 latestTimestamp, ) = _aggregator.getRoundData(_round);
        while (latestPrice <= 0) {
            _requireEnoughHistory(round);
            round = round - 1;
            (, latestPrice, , latestTimestamp, ) = _aggregator.getRoundData(round);
        }
        return (round, uint256(latestPrice), latestTimestamp);
    }

    //
    // REQUIRE FUNCTIONS
    //

    function _requireNonEmptyAddress(address _addr) internal pure {
        require(_addr != address(0), "CL_ZA"); //zero address
    }

    function _requireEnoughHistory(uint80 _round) internal pure {
        uint64 aggregatorRoundId = uint64(_round); // starts at 1
        require(aggregatorRoundId > 1, "CL_NEH"); //not enough history
    }

    function _requirePositivePrice(int256 _price) internal pure {
        // a negative price should be reverted to prevent an extremely large/small premiumFraction
        require(_price > 0, "CL_NPP"); //not positive price
    }
}
