// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;
import { IPriceFeed } from "../interfaces/IPriceFeed.sol";

contract L2PriceFeedMock is IPriceFeed {
    uint256 price;
    uint256 twapPrice;
    uint256 latestTimestamp;

    constructor(uint256 _price) {
        price = _price;
        twapPrice = _price;
    }

    function getTwapPrice(bytes32, uint256) public view returns (uint256) {
        return twapPrice;
    }

    function setTwapPrice(uint256 _price) public {
        twapPrice = _price;
    }

    function getLatestTimestamp(bytes32) public view returns (uint256) {
        return latestTimestamp;
    }

    function setLatestTimestamp(uint256 _timestamp) public {
        latestTimestamp = _timestamp;
    }

    function getPrice(bytes32) public view returns (uint256) {
        return price;
    }

    function setPrice(uint256 _price) public {
        price = _price;
    }

    function getPreviousPrice(bytes32, uint256) external view returns (uint256) {
        return price;
    }

    function getPreviousTimestamp(bytes32, uint256) external view returns (uint256) {
        return latestTimestamp;
    }

    event PriceFeedDataSet(bytes32 key, uint256 price, uint256 timestamp, uint256 roundId);

    function setLatestData(
        bytes32 _priceFeedKey,
        uint256 _price,
        uint256 _timestamp,
        uint256 _roundId
    ) external {
        emit PriceFeedDataSet(_priceFeedKey, _price, _timestamp, _roundId);
    }
}
