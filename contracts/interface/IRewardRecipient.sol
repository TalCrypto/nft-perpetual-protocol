// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRewardRecipient {
    function notifyRewardAmount(uint256 _amount) external;

    function token() external returns (IERC20);
}
