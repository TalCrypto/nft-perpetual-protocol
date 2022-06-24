// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

interface IInflationMonitor {
    function isOverMintThreshold() external view returns (bool);

    function appendMintedTokenHistory(uint256 _amount) external;
}
