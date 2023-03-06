// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import "../ClearingHouse.sol";
import "../interfaces/IAmm.sol";

// temporary commented unused functions to bypass contract too large error
contract ClearingHouseFake is ClearingHouse {
    uint256 private timestamp = 1444004400;
    uint256 private number = 10001;

    constructor(
        uint256 _initMarginRatio,
        uint256 _maintenanceMarginRatio,
        uint256 _liquidationFeeRatio,
        IInsuranceFund _insuranceFund,
        address
    ) {
        ClearingHouse.initialize(_initMarginRatio, _maintenanceMarginRatio, _liquidationFeeRatio, _insuranceFund);
    }

    function mock_setBlockTimestamp(uint256 _timestamp) public {
        timestamp = _timestamp;
    }

    function mock_setBlockNumber(uint256 _number) public {
        number = _number;
    }

    // function mock_getCurrentTimestamp() public view returns (uint256) {
    //     return _blockTimestamp();
    // }

    function mock_getCurrentBlockNumber() public view returns (uint256) {
        return _blockNumber();
    }

    // // Override BlockContext here
    function _blockTimestamp() internal view override returns (uint256) {
        return timestamp;
    }

    function _blockNumber() internal view override returns (uint256) {
        return number;
    }

    function mockSetRestrictionMode(IAmm _amm) external {
        _enterRestrictionMode(_amm);
    }

    function isInRestrictMode(address _amm, uint256 _block) external view returns (bool) {
        return ammMap[_amm].lastRestrictionBlock == _block;
    }

    function getPrepaidBadDebt(address _amm) public view returns (uint256) {
        return prepaidBadDebts[_amm];
    }

    function mockSetMMRatio(uint256 _ratio) public {
        maintenanceMarginRatio = _ratio;
    }
}
