// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.9;
pragma experimental ABIEncoderV2;

import { Decimal } from "../utils/Decimal.sol";

interface IClearingHouseConfig {
    using Decimal for Decimal.decimal;

    function getInitMarginRatio() external view returns (Decimal.decimal memory);

    function getMaintenanceMargin() external view returns (Decimal.decimal memory);

    function getLiquidationFeeRatio() external view returns (Decimal.decimal memory);
}