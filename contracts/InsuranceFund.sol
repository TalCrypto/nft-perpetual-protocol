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
import { IInsuranceFundCallee } from "./interfaces/IInsuranceFundCallee.sol";

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

    // amm => budget of the insurance fund, allocated to each market
    mapping(IAmm => uint256) public budgetsAllocated;

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
        if (!_isQuoteTokenExisted(token)) {
            quoteTokens.push(token);
            quoteTokenMap[address(token)] = true;
            emit TokenAdded(address(token));
        }
    }

    /**
     * @dev only owner can call. no need to call
     * @param _amm IAmm address
     */
    function removeAmm(IAmm _amm) external onlyOwner {
        require(isExistedAmm(_amm), "IF_ANE"); //amm not existed
        ammMap[address(_amm)] = false;
        uint256 ammLength = amms.length;
        for (uint256 i = 0; i < ammLength; i++) {
            if (amms[i] == _amm) {
                amms[i] = amms[ammLength - 1];
                amms.pop();
                emit AmmRemoved(address(_amm));
                break;
            }
        }
    }

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

    function removeToken(IERC20 _token) external onlyOwner {
        require(_isQuoteTokenExisted(_token), "IF_TNE"); //token not existed

        quoteTokenMap[address(_token)] = false;
        uint256 quoteTokensLength = getQuoteTokenLength();
        for (uint256 i = 0; i < quoteTokensLength; i++) {
            if (quoteTokens[i] == _token) {
                if (i < quoteTokensLength - 1) {
                    quoteTokens[i] = quoteTokens[quoteTokensLength - 1];
                }
                quoteTokens.pop();
                break;
            }
        }

        // transfer the quoteToken to owner.
        if (_balanceOf(_token) > 0) {
            _token.safeTransfer(owner(), _balanceOf(_token));
        }

        emit TokenRemoved(address(_token));
    }

    function setBeneficiary(address _beneficiary) external onlyOwner {
        require(_beneficiary != address(0), "IF_ZA");
        beneficiary = _beneficiary;
    }
    /**
     * @notice withdraw token to caller, only can be called by the beneficiaries
     */
    function withdraw(IAmm _amm, uint256 _amount) external override {
        uint256 budget = budgetsAllocated[_amm];
        IERC20 quoteToken = _amm.quoteAsset();
        require(beneficiary == _msgSender(), "IF_NB"); //not beneficiary
        require(_isQuoteTokenExisted(quoteToken), "IF_ANS"); //asset not supported
        require(budget >= _amount, "IF_FNE"); //Fund not enough
        budgetsAllocated[_amm] -= _amount;
        quoteToken.safeTransfer(_msgSender(), _amount);
        emit Withdrawn(_msgSender(), _amount);
    }

    /**
     * @notice deposit token to this insurance fund
     * @dev should make sure that enough token is approved before calling
     */

    function deposit(IAmm _amm, uint256 _amount) external override {
        IERC20 quoteToken = _amm.quoteAsset();
        require(_isQuoteTokenExisted(quoteToken), "IF_ANS"); //asset not supported
        uint256 balanceBefore = quoteToken.balanceOf(address(this));
        IInsuranceFundCallee(_msgSender()).depositCallback(quoteToken, _amount);
        budgetsAllocated[_amm] += quoteToken.balanceOf(address(this)) - balanceBefore;
    }

    //
    // VIEW
    //

    function getQuoteTokenLength() public view returns (uint256) {
        return quoteTokens.length;
    }

    function isExistedAmm(IAmm _amm) public view override returns (bool) {
        return ammMap[address(_amm)];
    }

    function getAllAmms() external view override returns (IAmm[] memory) {
        return amms;
    }

    function getAvailableBudgetFor(IAmm _amm) external view override returns (uint256 budget) {
        budget = budgetsAllocated[_amm];
    }

    //
    // private
    //

    function _isQuoteTokenExisted(IERC20 _token) internal view returns (bool) {
        return quoteTokenMap[address(_token)];
    }

    function _balanceOf(IERC20 _quoteToken) internal view returns (uint256) {
        return _quoteToken.balanceOf(address(this));
    }
}
