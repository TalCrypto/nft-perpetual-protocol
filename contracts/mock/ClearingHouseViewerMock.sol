// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { ClearingHouseViewer } from "../ClearingHouseViewer.sol";
import { ClearingHouse } from "../ClearingHouse.sol";

contract ClearingHouseViewerMock is ClearingHouseViewer {
    bool useSpreadCheck;

    constructor(ClearingHouse _clearingHouse) ClearingHouseViewer(_clearingHouse) {}

    function _isOverSpreadLimit(uint256 marketPrice, uint256 oraclePrice) internal view override returns (bool result) {
        result = super._isOverSpreadLimit(marketPrice, oraclePrice);
        if (!useSpreadCheck) {
            result = false;
        }
    }

    function mockSetSpreadCheck(bool input) public {
        useSpreadCheck = input;
    }
}
