// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { OwnableUpgradeableSafe } from "./OwnableUpgradeableSafe.sol";
import { IInsuranceFund } from "./interfaces/IInsuranceFund.sol";
import { BlockContext } from "./utils/BlockContext.sol";
import { IAmm } from "./interfaces/IAmm.sol";
import { UIntMath } from "./utils/UIntMath.sol";
import { TransferHelper } from "./utils/TransferHelper.sol";

contract InsuranceFund is IInsuranceFund, OwnableUpgradeableSafe, BlockContext, ReentrancyGuardUpgradeable {
    using UIntMath for uint256;
    using TransferHelper for IERC20;

    //**********************************************************//
    //    The below state variables can not change the order    //
    //**********************************************************//

    mapping(address => bool) private ammMap;
    mapping(address => bool) private quoteTokenMap;
    IAmm[] private amms;
    IERC20[] public quoteTokens;

    // contract dependencies;
    address private beneficiary;

    //**********************************************************//
    //    The above state variables can not change the order    //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    //
    // EVENTS
    //

    event Withdrawn(address withdrawer, uint256 amount);
    event TokenAdded(address tokenAddress);
    event TokenRemoved(address tokenAddress);
    event ShutdownAllAmms(uint256 blockNumber);
    event AmmAdded(address amm);
    event AmmRemoved(address amm);

    //
    // FUNCTIONS
    //

    function initialize() public initializer {
        __Ownable_init();
        __ReentrancyGuard_init();
    }

    /**
     * @dev only owner can call
     * @param _amm IAmm address
     */
    function addAmm(IAmm _amm) public onlyOwner {
        require(!isExistedAmm(_amm), "IF_AAA"); //amm already added
        ammMap[address(_amm)] = true;
        amms.push(_amm);
        emit AmmAdded(address(_amm));

        // add token if it's new one
        IERC20 token = _amm.quoteAsset();
        if (!isQuoteTokenExisted(token)) {
            quoteTokens.push(token);
            quoteTokenMap[address(token)] = true;
            emit TokenAdded(address(token));
        }
    }

    // /**
    //  * @dev only owner can call. no need to call
    //  * @param _amm IAmm address
    //  */
    // function removeAmm(IAmm _amm) external onlyOwner {
    //     require(isExistedAmm(_amm), "IF_ANE"); //amm not existed
    //     ammMap[address(_amm)] = false;
    //     uint256 ammLength = amms.length;
    //     for (uint256 i = 0; i < ammLength; i++) {
    //         if (amms[i] == _amm) {
    //             amms[i] = amms[ammLength - 1];
    //             amms.pop();
    //             emit AmmRemoved(address(_amm));
    //             break;
    //         }
    //     }
    // }

    /**
     * @notice shutdown all Amms when fatal error happens
     * @dev only owner can call. Emit `ShutdownAllAmms` event
     */
    function shutdownAllAmm() external onlyOwner {
        for (uint256 i; i < amms.length; i++) {
            amms[i].shutdown();
        }
        emit ShutdownAllAmms(block.number);
    }

    // function removeToken(IERC20 _token) external onlyOwner {
    //     require(isQuoteTokenExisted(_token), "IF_TNE"); //token not existed

    //     quoteTokenMap[address(_token)] = false;
    //     uint256 quoteTokensLength = getQuoteTokenLength();
    //     for (uint256 i = 0; i < quoteTokensLength; i++) {
    //         if (quoteTokens[i] == _token) {
    //             if (i < quoteTokensLength - 1) {
    //                 quoteTokens[i] = quoteTokens[quoteTokensLength - 1];
    //             }
    //             quoteTokens.pop();
    //             break;
    //         }
    //     }

    //     // transfer the quoteToken to owner.
    //     if (balanceOf(_token) > 0) {
    //         _token.safeTransfer(owner(), balanceOf(_token));
    //     }

    //     emit TokenRemoved(address(_token));
    // }

    /**
     * @notice withdraw token to caller
     * @param _amount the amount of quoteToken caller want to withdraw
     */
    function withdraw(IERC20 _quoteToken, uint256 _amount) external override {
        require(beneficiary == _msgSender(), "IF_NB"); //not beneficiary
        require(isQuoteTokenExisted(_quoteToken), "IF_ANS"); //asset not supported

        uint256 quoteBalance = balanceOf(_quoteToken);

        require(quoteBalance >= _amount, "IF_FNE"); //Fund not enough

        _quoteToken.safeTransfer(_msgSender(), _amount);
        emit Withdrawn(_msgSender(), _amount);
    }

    //
    // SETTER
    //

    function setBeneficiary(address _beneficiary) external onlyOwner {
        beneficiary = _beneficiary;
    }

    function getQuoteTokenLength() public view returns (uint256) {
        return quoteTokens.length;
    }

    //
    // VIEW
    //
    function isExistedAmm(IAmm _amm) public view override returns (bool) {
        return ammMap[address(_amm)];
    }

    function getAllAmms() external view override returns (IAmm[] memory) {
        return amms;
    }

    function isQuoteTokenExisted(IERC20 _token) internal view returns (bool) {
        return quoteTokenMap[address(_token)];
    }

    function balanceOf(IERC20 _quoteToken) internal view returns (uint256) {
        return _quoteToken.balanceOf(address(this));
    }
}
