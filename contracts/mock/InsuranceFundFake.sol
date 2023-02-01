// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import "../InsuranceFund.sol";

contract InsuranceFundFake is InsuranceFund {
    uint256 private timestamp = 1444004400;
    uint256 private number = 10001;

    constructor() {
        InsuranceFund.initialize();
    }

    // make internal function testable

    function mock_setBlockTimestamp(uint256 _timestamp) public {
        timestamp = _timestamp;
    }

    function mock_setBlockNumber(uint256 _number) public {
        number = _number;
    }

    function mock_getCurrentTimestamp() public view returns (uint256) {
        return _blockTimestamp();
    }

    // Override BlockContext here
    function _blockTimestamp() internal view override returns (uint256) {
        return timestamp;
    }

    function _blockNumber() internal view override returns (uint256) {
        return number;
    }
}
