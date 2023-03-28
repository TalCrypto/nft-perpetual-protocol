// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAmm } from "./IAmm.sol";

interface IInsuranceFund {
    function withdraw(IERC20 _quoteToken, uint256 _amount) external;

    function increaseBudgetFor(IAmm _amm, uint256 _amount) external;

    function decreaseBudgetFor(IAmm _amm, uint256 _amount) external;

    function isExistedAmm(IAmm _amm) external view returns (bool);

    function getAllAmms() external view returns (IAmm[] memory);

    function getBudgetAllocatedFor(IAmm _amm) external view returns (uint256);
}
