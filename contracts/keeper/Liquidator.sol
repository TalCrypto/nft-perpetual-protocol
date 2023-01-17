// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IClearingHouse.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract Liquidator is Ownable {
    using SafeERC20 for IERC20;

    IClearingHouse clearingHouse;

    uint256 public mmRatio;

    event PositionLiquidated(address amm, address[] traders, bool[] results, string[] reasons);

    constructor(IClearingHouse _clearingHouse, uint256 _mmRatio) {
        clearingHouse = _clearingHouse;
        mmRatio = _mmRatio;
    }

    receive() external payable {}

    function setMMRatio(uint256 _mmRatio) external onlyOwner {
        mmRatio = _mmRatio;
    }

    function setClearingHouse(address _addrCH) external onlyOwner {
        clearingHouse = IClearingHouse(_addrCH);
    }

    function withdrawERC20(IERC20 _token) external onlyOwner {
        _token.safeTransfer(msg.sender, _token.balanceOf(address(this)));
    }

    function withdrawETH() external onlyOwner {
        (bool success, ) = msg.sender.call{ value: address(this).balance }(new bytes(0));
        require(success, "L_ETF"); //eth transfer failed
    }

    function singleLiquidate(IAmm _amm, address _trader) external {
        clearingHouse.liquidate(_amm, _trader);
    }

    function liquidate(IAmm _amm, address[] memory _traders) external {
        bool[] memory results = new bool[](_traders.length);
        string[] memory reasons = new string[](_traders.length);
        for (uint256 i = 0; i < _traders.length; i++) {
            // (success, ret) = clearingHouse.call(abi.encodeWithSelector(IClearingHouse.liquidate.selector, _amm, _traders[i]));
            try clearingHouse.liquidate(_amm, _traders[i]) {
                results[i] = true;
            } catch Error(string memory reason) {
                reasons[i] = reason;
            } catch {
                reasons[i] = "";
            }
        }
        emit PositionLiquidated(address(_amm), _traders, results, reasons);
    }

    function isLiquidatable(IAmm _amm, address[] memory _traders) external view returns (bool[] memory) {
        bool[] memory results = new bool[](_traders.length);
        for (uint256 i = 0; i < _traders.length; i++) {
            try clearingHouse.getMarginRatio(_amm, _traders[i]) returns (int256 ratio) {
                if (ratio < int256(mmRatio)) {
                    results[i] = true;
                } else {
                    results[i] = false;
                }
            } catch Error(string memory) {
                results[i] = false;
            } catch {
                results[i] = false;
            }
        }
        return results;
    }
}
