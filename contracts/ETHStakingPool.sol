// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BlockContext } from "./utils/BlockContext.sol";
import { IETHStakingPool } from "./interfaces/IETHStakingPool.sol";
import { IAmm } from "./interfaces/IAmm.sol";
import { IInsuranceFund } from "./interfaces/IInsuranceFund.sol";
import { OwnableUpgradeableSafe } from "./OwnableUpgradeableSafe.sol";
import { UIntMath } from "./utils/UIntMath.sol";
import { IntMath } from "./utils/IntMath.sol";

contract ETHStakingPool is IETHStakingPool, OwnableUpgradeableSafe, BlockContext {
    using UIntMath for uint256;
    using IntMath for int256;

    IERC20 public override quoteToken;
    IInsuranceFund public insuranceFund;

    uint256 public override totalSupply;

    address public tribe3Treasury;

    uint256 public guardEndTimestamp;

    uint256 public nextClaimTimestamp;

    uint256 public claimPeriodInSec;

    mapping(address => uint256) public balanceOf; // supposed to be used in case of making this public

    event Withdrawn(address amm, uint256 amount);

    modifier onlyTribe3Treasury() {
        require(_msgSender() == tribe3Treasury, "ES_NTT"); // not tribe3 treasury
        _;
    }

    modifier notGuardedPeriod() {
        require(_blockTimestamp() >= guardEndTimestamp, "ES_GP"); // guarded period
        _;
    }

    modifier claimable() {
        require(isClaimable(), "ES_NAC"); // not able to claim
        _;
        nextClaimTimestamp = _blockTimestamp() + claimPeriodInSec;
    }

    function initialize(address _quoteToken, address _insuranceFund) public initializer {
        __Ownable_init();
        _requireNonZeroAddress(_quoteToken);
        _requireNonZeroAddress(_insuranceFund);
        quoteToken = IERC20(_quoteToken);
        insuranceFund = IInsuranceFund(_insuranceFund);
        claimPeriodInSec = 30 * 24 * 3600;
        nextClaimTimestamp = _blockTimestamp() + claimPeriodInSec;
        guardEndTimestamp = _blockTimestamp() + 6 * 30 * 24 * 3600;
    }

    function setTribe3Treasury(address treasury) external onlyOwner {
        require(treasury != address(0), "ES_ZA");
        tribe3Treasury = treasury;
    }

    function setClaimPeriod(uint256 periodInSec) external onlyOwner {
        nextClaimTimestamp = _blockTimestamp() + periodInSec;
        claimPeriodInSec = periodInSec;
    }

    function stake(uint256 amount) external onlyTribe3Treasury {
        balanceOf[_msgSender()] += amount;
        totalSupply += amount;
        quoteToken.transferFrom(_msgSender(), address(this), amount);
    }

    function unstake(uint256 amount) external onlyTribe3Treasury notGuardedPeriod {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        quoteToken.transfer(msg.sender, amount);
    }

    function claim() external onlyTribe3Treasury claimable {
        int256 reward = calculateTotalReward();
        require(reward > 0, "ES_IR"); // insufficient reward
        quoteToken.transfer(_msgSender(), reward.abs());
    }

    function restakeReward(uint256 amount) external onlyTribe3Treasury claimable {
        int256 reward = calculateTotalReward();
        require(reward > 0 && amount <= reward.abs(), "ES_IR"); // insufficient reward
        balanceOf[_msgSender()] += amount;
        totalSupply += amount;
    }

    /**
     * @notice used for backing the insurance fund, only callable by the insurance fund
     */
    function withdraw(IAmm _amm, uint256 _amount) external {
        require(_msgSender() == address(insuranceFund), "ES_NI"); // not insurancefund
        IERC20 _quoteToken = _amm.quoteAsset();
        _quoteToken.transfer(_msgSender(), _amount);
        emit Withdrawn(address(_amm), _amount);
    }

    function withdrawAll() external {
        require(_msgSender() == address(insuranceFund), "ES_NI"); // not insurancefund
        quoteToken.transfer(_msgSender(), quoteToken.balanceOf(address(this)));
    }

    /**
     * @notice calculate total reward
     * @return reward positive is profit, negative is loss
     */
    function calculateTotalReward() public view override returns (int256 reward) {
        reward = (quoteToken.balanceOf(address(this))).toInt() - totalSupply.toInt();
    }

    function isClaimable() public view returns (bool) {
        return _blockTimestamp() >= nextClaimTimestamp;
    }

    function _requireNonZeroAddress(address _input) private pure {
        require(_input != address(0), "ES_ZA");
    }
}
