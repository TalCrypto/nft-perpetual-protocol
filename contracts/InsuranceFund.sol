// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IExchangeWrapper } from "./interfaces/IExchangeWrapper.sol";
import { IInsuranceFund } from "./interfaces/IInsuranceFund.sol";
import { BlockContext } from "./utils/BlockContext.sol";
import { IMinter } from "./interfaces/IMinter.sol";
import { IAmm } from "./interfaces/IAmm.sol";
import { IInflationMonitor } from "./interfaces/IInflationMonitor.sol";
import { UIntMath } from "./utils/UIntMath.sol";

contract InsuranceFund is IInsuranceFund, OwnableUpgradeable, BlockContext, ReentrancyGuardUpgradeable {
    using UIntMath for uint256;

    //
    // EVENTS
    //

    event Withdrawn(address withdrawer, uint256 amount);
    event TokenAdded(address tokenAddress);
    event TokenRemoved(address tokenAddress);
    event ShutdownAllAmms(uint256 blockNumber);
    event AmmAdded(address amm);
    event AmmRemoved(address amm);

    //**********************************************************//
    //    The below state variables can not change the order    //
    //**********************************************************//

    mapping(address => bool) private ammMap;
    mapping(address => bool) private quoteTokenMap;
    IAmm[] private amms;
    IERC20[] public quoteTokens;

    // contract dependencies
    IExchangeWrapper public exchange;
    IERC20 public perpToken;
    IMinter public minter;
    IInflationMonitor public inflationMonitor;
    address private beneficiary;

    //**********************************************************//
    //    The above state variables can not change the order    //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    //
    // FUNCTIONS
    //

    function initialize() external initializer {
        __Ownable_init();
        __ReentrancyGuard_init();
    }

    /**
     * @dev only owner can call
     * @param _amm IAmm address
     */
    function addAmm(IAmm _amm) public onlyOwner {
        require(!isExistedAmm(_amm), "amm already added");
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

    /**
     * @dev only owner can call. no need to call
     * @param _amm IAmm address
     */
    function removeAmm(IAmm _amm) external onlyOwner {
        require(isExistedAmm(_amm), "amm not existed");
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
        if (!inflationMonitor.isOverMintThreshold()) {
            return;
        }
        for (uint256 i; i < amms.length; i++) {
            amms[i].shutdown();
        }
        emit ShutdownAllAmms(block.number);
    }

    function removeToken(IERC20 _token) external onlyOwner {
        require(isQuoteTokenExisted(_token), "token not existed");

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

        // exchange and transfer to the quoteToken with the most value. if no more quoteToken, buy protocol tokens
        // TODO use curve or balancer fund token for pooling the fees will be less painful
        if (balanceOf(_token) > 0) {
            address outputToken = getTokenWithMaxValue();
            if (outputToken == address(0)) {
                outputToken = address(perpToken);
            }
            swapInput(_token, IERC20(outputToken), balanceOf(_token), 0);
        }

        emit TokenRemoved(address(_token));
    }

    /**
     * @notice withdraw token to caller
     * @param _amount the amount of quoteToken caller want to withdraw
     */
    function withdraw(IERC20 _quoteToken, uint256 _amount) external override {
        require(beneficiary == _msgSender(), "caller is not beneficiary");
        require(isQuoteTokenExisted(_quoteToken), "Asset is not supported");

        uint256 quoteBalance = balanceOf(_quoteToken);
        if (_amount > quoteBalance) {
            uint256 insufficientAmount = _amount - quoteBalance;
            swapEnoughQuoteAmount(_quoteToken, insufficientAmount);
            quoteBalance = balanceOf(_quoteToken);
        }
        require(quoteBalance >= _amount, "Fund not enough");

        _quoteToken.transfer(_msgSender(), _amount);
        emit Withdrawn(_msgSender(), _amount);
    }

    //
    // SETTER
    //

    function setExchange(IExchangeWrapper _exchange) external onlyOwner {
        exchange = _exchange;
    }

    function setBeneficiary(address _beneficiary) external onlyOwner {
        beneficiary = _beneficiary;
    }

    function setMinter(IMinter _minter) public onlyOwner {
        minter = _minter;
        perpToken = minter.getPerpToken();
    }

    function setInflationMonitor(IInflationMonitor _inflationMonitor) external onlyOwner {
        inflationMonitor = _inflationMonitor;
    }

    function getQuoteTokenLength() public view returns (uint256) {
        return quoteTokens.length;
    }

    //
    // INTERNAL FUNCTIONS
    //

    function getTokenWithMaxValue() internal view returns (address) {
        uint256 numOfQuoteTokens = quoteTokens.length;
        if (numOfQuoteTokens == 0) {
            return address(0);
        }
        if (numOfQuoteTokens == 1) {
            return address(quoteTokens[0]);
        }

        IERC20 denominatedToken = quoteTokens[0];
        IERC20 maxValueToken = denominatedToken;
        uint256 valueOfMaxValueToken = balanceOf(denominatedToken);
        for (uint256 i = 1; i < numOfQuoteTokens; i++) {
            IERC20 quoteToken = quoteTokens[i];
            uint256 quoteTokenValue = exchange.getInputPrice(quoteToken, denominatedToken, balanceOf(quoteToken));
            if (quoteTokenValue > valueOfMaxValueToken) {
                // if (quoteTokenValue.cmp(valueOfMaxValueToken) > 0) {
                maxValueToken = quoteToken;
                valueOfMaxValueToken = quoteTokenValue;
            }
        }
        return address(maxValueToken);
    }

    function swapInput(
        IERC20 inputToken,
        IERC20 outputToken,
        uint256 inputTokenSold,
        uint256 minOutputTokenBought
    ) internal returns (uint256 received) {
        if (inputTokenSold == 0) {
            return 0;
        }
        inputToken.approve(address(exchange), inputTokenSold);
        received = exchange.swapInput(inputToken, outputToken, inputTokenSold, minOutputTokenBought, 0);
        require(received > 0, "Exchange swap error");
    }

    function swapOutput(
        IERC20 inputToken,
        IERC20 outputToken,
        uint256 outputTokenBought,
        uint256 maxInputTokenSold
    ) internal returns (uint256 received) {
        if (outputTokenBought == 0) {
            return 0;
        }
        inputToken.approve(address(exchange), maxInputTokenSold);
        received = exchange.swapOutput(inputToken, outputToken, outputTokenBought, maxInputTokenSold, 0);
        require(received > 0, "Exchange swap error");
    }

    function swapEnoughQuoteAmount(IERC20 _quoteToken, uint256 _requiredQuoteAmount) internal {
        IERC20[] memory orderedTokens = getOrderedQuoteTokens(_quoteToken);
        for (uint256 i = 0; i < orderedTokens.length; i++) {
            // get how many amount of quote token i is still required
            uint256 swappedQuoteToken;
            uint256 otherQuoteRequiredAmount = exchange.getOutputPrice(orderedTokens[i], _quoteToken, _requiredQuoteAmount);

            // if balance of token i can afford the left debt, swap and return
            if (otherQuoteRequiredAmount <= balanceOf(orderedTokens[i])) {
                swappedQuoteToken = swapInput(orderedTokens[i], _quoteToken, otherQuoteRequiredAmount, 0);
                return;
            }

            // if balance of token i can't afford the left debt, show hand and move to the next one
            swappedQuoteToken = swapInput(orderedTokens[i], _quoteToken, balanceOf(orderedTokens[i]), 0);
            _requiredQuoteAmount = _requiredQuoteAmount - swappedQuoteToken;
        }

        // if all the quote tokens can't afford the debt, ask staking token to mint
        if (_requiredQuoteAmount > 0) {
            uint256 requiredPerpAmount = exchange.getOutputPrice(perpToken, _quoteToken, _requiredQuoteAmount);
            minter.mintForLoss(requiredPerpAmount);
            swapInput(perpToken, _quoteToken, requiredPerpAmount, 0);
        }
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

    function getOrderedQuoteTokens(IERC20 _exceptionQuoteToken) internal view returns (IERC20[] memory orderedTokens) {
        IERC20[] memory tokens = quoteTokens;
        // insertion sort
        for (uint256 i = 0; i < getQuoteTokenLength(); i++) {
            IERC20 currentToken = quoteTokens[i];
            uint256 currentPerpValue = exchange.getInputPrice(currentToken, perpToken, balanceOf(currentToken));

            for (uint256 j = i; j > 0; j--) {
                uint256 subsetPerpValue = exchange.getInputPrice(tokens[j - 1], perpToken, balanceOf(tokens[j - 1]));
                if (currentPerpValue > subsetPerpValue) {
                    tokens[j] = tokens[j - 1];
                    tokens[j - 1] = currentToken;
                }
            }
        }

        orderedTokens = new IERC20[](tokens.length - 1);
        uint256 j;
        for (uint256 i = 0; i < tokens.length; i++) {
            // jump to the next token
            if (tokens[i] == _exceptionQuoteToken) {
                continue;
            }
            orderedTokens[j] = tokens[i];
            j++;
        }
    }

    function balanceOf(IERC20 _quoteToken) internal view returns (uint256) {
        return _quoteToken.balanceOf(address(this));
    }
}
