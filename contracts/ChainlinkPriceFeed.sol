// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { IPriceFeed } from "./interfaces/IPriceFeed.sol";
import { BlockContext } from "./utils/BlockContext.sol";

contract ChainlinkPriceFeed is IPriceFeed, OwnableUpgradeable, BlockContext {
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
    ) external override {
        revert("not support");
    }

    function getPrice(bytes32 _priceFeedKey) external view override returns (uint256) {
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

    function getTwapPrice(bytes32 _priceFeedKey, uint256 _interval) external view override returns (uint256) {
        AggregatorV3Interface aggregator = aggregators[_priceFeedKey];
        _requireNonEmptyAddress(address(aggregator));
        require(_interval != 0, "interval can't be 0");

        // 3 different timestamps, `previous`, `current`, `target`
        // `base` = now - _interval
        // `current` = current round timestamp from aggregator
        // `previous` = previous round timestamp form aggregator
        // now >= previous > current > = < base
        //
        //  while loop i = 0
        //  --+------+-----+-----+-----+-----+-----+
        //         base                 current  now(previous)
        //
        //  while loop i = 1
        //  --+------+-----+-----+-----+-----+-----+
        //         base           current previous now

        (uint80 round, uint256 latestPrice, uint256 latestTimestamp) = _getLatestRoundData(aggregator);
        uint256 baseTimestamp = _blockTimestamp() - _interval;
        // if latest updated timestamp is earlier than target timestamp, return the latest price.
        if (latestTimestamp < baseTimestamp || round == 0) {
            return latestPrice;
        }

        // rounds are like snapshots, latestRound means the latest price snapshot. follow chainlink naming
        uint256 previousTimestamp = latestTimestamp;
        uint256 cumulativeTime = _blockTimestamp() - previousTimestamp;
        uint256 weightedPrice = latestPrice * cumulativeTime;
        while (true) {
            if (round == 0) {
                // if cumulative time is less than requested interval, return current twap price
                return weightedPrice / cumulativeTime;
            }

            round = round - 1;
            (, uint256 currentPrice, uint256 currentTimestamp) = _getRoundData(aggregator, round);

            // check if current round timestamp is earlier than target timestamp
            if (currentTimestamp <= baseTimestamp) {
                // weighted time period will be (target timestamp - previous timestamp). For example,
                // now is 1000, _interval is 100, then target timestamp is 900. If timestamp of current round is 970,
                // and timestamp of NEXT round is 880, then the weighted time period will be (970 - 900) = 70,
                // instead of (970 - 880)
                weightedPrice = weightedPrice + currentPrice * (previousTimestamp - baseTimestamp);
                break;
            }

            uint256 timeFraction = previousTimestamp - currentTimestamp;
            weightedPrice = weightedPrice + currentPrice * timeFraction;
            cumulativeTime = cumulativeTime + timeFraction;
            previousTimestamp = currentTimestamp;
        }
        return weightedPrice / _interval;
    }

    function getPreviousPrice(bytes32 _priceFeedKey, uint256 _numOfRoundBack) external view override returns (uint256) {
        AggregatorV3Interface aggregator = aggregators[_priceFeedKey];
        _requireNonEmptyAddress(address(aggregator));

        (uint80 round, , , , ) = aggregator.latestRoundData();
        require(round > 0 && round >= _numOfRoundBack, "Not enough history");
        (, int256 previousPrice, , , ) = aggregator.getRoundData(round - uint80(_numOfRoundBack));
        _requirePositivePrice(previousPrice);
        return uint256(previousPrice);
    }

    function getPreviousTimestamp(bytes32 _priceFeedKey, uint256 _numOfRoundBack) external view override returns (uint256) {
        AggregatorV3Interface aggregator = aggregators[_priceFeedKey];
        _requireNonEmptyAddress(address(aggregator));

        (uint80 round, , , , ) = aggregator.latestRoundData();
        require(round > 0 && round >= _numOfRoundBack, "Not enough history");
        (, int256 previousPrice, , uint256 previousTimestamp, ) = aggregator.getRoundData(round - uint80(_numOfRoundBack));
        _requirePositivePrice(previousPrice);
        return previousTimestamp;
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
        if (latestPrice < 0) {
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
        while (latestPrice < 0) {
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
        require(_addr != address(0), "empty address");
    }

    function _requireEnoughHistory(uint80 _round) internal pure {
        require(_round > 0, "Not enough history");
    }

    function _requirePositivePrice(int256 _price) internal pure {
        // a negative price should be reverted to prevent an extremely large/small premiumFraction
        require(_price > 0, "Negative price");
    }
}
