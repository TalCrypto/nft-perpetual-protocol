// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { BlockContext } from "./utils/BlockContext.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { OwnerPausableUpgradeSafe } from "./OwnerPausable.sol";
import { IAmm } from "./interfaces/IAmm.sol";
import { IInsuranceFund } from "./interfaces/IInsuranceFund.sol";
import { IMultiTokenRewardRecipient } from "./interfaces/IMultiTokenRewardRecipient.sol";
import { IntMath } from "./utils/IntMath.sol";
import { UIntMath } from "./utils/UIntMath.sol";
import { TransferHelper } from "./utils/TransferHelper.sol";
import { AmmMath } from "./utils/AmmMath.sol";

// note BaseRelayRecipient must come after OwnerPausableUpgradeSafe so its _msgSender() takes precedence
// (yes, the ordering is reversed comparing to Python)
contract ClearingHouse is OwnerPausableUpgradeSafe, ReentrancyGuardUpgradeable, BlockContext {
    using UIntMath for uint256;
    using IntMath for int256;
    using TransferHelper for IERC20;

    //
    // Struct and Enum
    //

    enum Side {
        BUY,
        SELL
    }
    enum PnlCalcOption {
        SPOT_PRICE,
        TWAP,
        ORACLE
    }

    /// @param MAX_PNL most beneficial way for traders to calculate position notional
    /// @param MIN_PNL least beneficial way for traders to calculate position notional
    enum PnlPreferenceOption {
        MAX_PNL,
        MIN_PNL
    }

    /// @notice This struct records personal position information
    /// @param size denominated in amm.baseAsset
    /// @param margin isolated margin
    /// @param openNotional the quoteAsset value of position when opening position. the cost of the position
    /// @param lastUpdatedCumulativePremiumFraction for calculating funding payment, record at the moment every time when trader open/reduce/close position
    /// @param liquidityHistoryIndex
    /// @param blockNumber the block number of the last position
    struct Position {
        int256 size;
        uint256 margin;
        uint256 openNotional;
        int256 lastUpdatedCumulativePremiumFraction;
        uint256 liquidityHistoryIndex;
        uint256 blockNumber;
    }

    /// @notice This struct is used for avoiding stack too deep error when passing too many var between functions
    struct PositionResp {
        Position position;
        // the quote asset amount trader will send if open position, will receive if close
        uint256 exchangedQuoteAssetAmount;
        // if realizedPnl + realizedFundingPayment + margin is negative, it's the abs value of it
        uint256 badDebt;
        // the base asset amount trader will receive if open position, will send if close
        int256 exchangedPositionSize;
        // funding payment incurred during this position response
        int256 fundingPayment;
        // realizedPnl = unrealizedPnl * closedRatio
        int256 realizedPnl;
        // positive = trader transfer margin to vault, negative = trader receive margin from vault
        // it's 0 when internalReducePosition, its addedMargin when _increasePosition
        // it's min(0, oldPosition + realizedFundingPayment + realizedPnl) when _closePosition
        int256 marginToVault;
        // unrealized pnl after open position
        int256 unrealizedPnlAfter;
        uint256 spreadFee;
        uint256 tollFee;
    }

    struct AmmMap {
        // issue #1471
        // last block when it turn restriction mode on.
        // In restriction mode, no one can do multi open/close/liquidate position in the same block.
        // If any underwater position being closed (having a bad debt and make insuranceFund loss),
        // or any liquidation happened,
        // restriction mode is ON in that block and OFF(default) in the next block.
        // This design is to prevent the attacker being benefited from the multiple action in one block
        // in extreme cases
        uint256 lastRestrictionBlock;
        int256[] cumulativePremiumFractions;
        mapping(address => Position) positionMap;
    }

    //**********************************************************//
    //    Can not change the order of below state variables     //
    //**********************************************************//
    //string public override versionRecipient;

    // only admin
    uint256 public initMarginRatio;

    // only admin
    uint256 public maintenanceMarginRatio;

    // only admin
    uint256 public liquidationFeeRatio;

    // only admin
    uint256 public partialLiquidationRatio;

    // key by amm address. will be deprecated or replaced after guarded period.
    // it's not an accurate open interest, just a rough way to control the unexpected loss at the beginning
    mapping(address => uint256) public openInterestNotionalMap;

    // key by amm address
    mapping(address => AmmMap) internal ammMap;

    // prepaid bad debt balance, key by Amm address
    mapping(address => uint256) public prepaidBadDebts;

    // contract dependencies
    IInsuranceFund public insuranceFund;
    IMultiTokenRewardRecipient public tollPool;

    // designed for arbitragers who can hold unlimited positions. will be removed after guarded period
    address internal whitelist;

    mapping(address => bool) public backstopLiquidityProviderMap;

    // amm => balance of vault
    mapping(address => uint256) public vaults;

    // amm => total fees allocated to market
    // the cumulative fees collected from traders, not decrease
    mapping(address => uint256) public totalFees;

    // totalMinusFees = totalFees - system funding payment - adjust costs
    mapping(address => uint256) public totalMinusFees;

    // amm => revenue since last funding
    mapping(address => int256) public netRevenuesSinceLastFunding;

    // the address of bot that controls market
    address public operator;

    uint256[50] private __gap;

    //**********************************************************//
    //    Can not change the order of above state variables     //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    //

    //
    // EVENTS
    //
    //event MarginRatioChanged(uint256 marginRatio);
    //event LiquidationFeeRatioChanged(uint256 liquidationFeeRatio);
    event BackstopLiquidityProviderChanged(address indexed account, bool indexed isProvider);
    event MarginChanged(address indexed sender, address indexed amm, int256 amount, int256 fundingPayment);
    event PositionAdjusted(
        address indexed amm,
        address indexed trader,
        int256 newPositionSize,
        uint256 oldLiquidityIndex,
        uint256 newLiquidityIndex
    );
    event PositionSettled(address indexed amm, address indexed trader, uint256 valueTransferred);
    event RestrictionModeEntered(address amm, uint256 blockNumber);
    event Repeg(address amm, uint256 quoteAssetReserve, uint256 baseAssetReserve, int256 cost);
    event UpdateK(address amm, uint256 quoteAssetReserve, uint256 baseAssetReserve, int256 cost);

    /// @notice This event is emitted when position change
    /// @param trader the address which execute this transaction
    /// @param amm IAmm address
    /// @param margin margin
    /// @param positionNotional margin * leverage
    /// @param exchangedPositionSize position size, e.g. ETHUSDC or LINKUSDC
    /// @param fee transaction fee
    /// @param positionSizeAfter position size after this transaction, might be increased or decreased
    /// @param realizedPnl realized pnl after this position changed
    /// @param unrealizedPnlAfter unrealized pnl after this position changed
    /// @param badDebt position change amount cleared by insurance funds
    /// @param liquidationPenalty amount of remaining margin lost due to liquidation
    /// @param spotPrice quote asset reserve / base asset reserve
    /// @param fundingPayment funding payment (+: trader paid, -: trader received)
    event PositionChanged(
        address indexed trader,
        address indexed amm,
        uint256 margin,
        uint256 positionNotional,
        int256 exchangedPositionSize,
        uint256 fee,
        int256 positionSizeAfter,
        int256 realizedPnl,
        int256 unrealizedPnlAfter,
        uint256 badDebt,
        uint256 liquidationPenalty,
        uint256 spotPrice,
        int256 fundingPayment
    );

    /// @notice This event is emitted when position liquidated
    /// @param trader the account address being liquidated
    /// @param amm IAmm address
    /// @param positionNotional liquidated position value minus liquidationFee
    /// @param positionSize liquidated position size
    /// @param liquidationFee liquidation fee to the liquidator
    /// @param liquidator the address which execute this transaction
    /// @param badDebt liquidation fee amount cleared by insurance funds
    event PositionLiquidated(
        address indexed trader,
        address indexed amm,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator,
        uint256 badDebt
    );

    modifier onlyOperator() {
        require(operator == _msgSender(), "caller is not operator");
        _;
    }

    // FUNCTIONS
    //
    // openzeppelin doesn't support struct input
    // https://github.com/OpenZeppelin/openzeppelin-sdk/issues/1523
    function initialize(
        uint256 _initMarginRatio,
        uint256 _maintenanceMarginRatio,
        uint256 _liquidationFeeRatio,
        IInsuranceFund _insuranceFund
    ) public initializer {
        //require(address(_insuranceFund) != address(0), "Invalid IInsuranceFund");

        __OwnerPausable_init();

        //comment these out for reducing bytecode size
        __ReentrancyGuard_init();

        initMarginRatio = _initMarginRatio;
        maintenanceMarginRatio = _maintenanceMarginRatio;
        liquidationFeeRatio = _liquidationFeeRatio;
        insuranceFund = _insuranceFund;
    }

    //
    // External
    //

    /**
     * @notice set liquidation fee ratio
     * @dev only owner can call
     * @param _liquidationFeeRatio new liquidation fee ratio in 18 digits
     */
    function setLiquidationFeeRatio(uint256 _liquidationFeeRatio) external onlyOwner {
        liquidationFeeRatio = _liquidationFeeRatio;
        //emit LiquidationFeeRatioChanged(liquidationFeeRatio.toUint());
    }

    /**
     * @notice set maintenance margin ratio
     * @dev only owner can call
     * @param _maintenanceMarginRatio new maintenance margin ratio in 18 digits
     */
    function setMaintenanceMarginRatio(uint256 _maintenanceMarginRatio) external onlyOwner {
        maintenanceMarginRatio = _maintenanceMarginRatio;
        //emit MarginRatioChanged(maintenanceMarginRatio.toUint());
    }

    /**
     * @notice set the toll pool address
     * @dev only owner can call
     */
    function setTollPool(address _tollPool) external onlyOwner {
        tollPool = IMultiTokenRewardRecipient(_tollPool);
    }

    /**
     * @notice add an address in the whitelist. People in the whitelist can hold unlimited positions.
     * @dev only owner can call
     * @param _whitelist an address
     */
    function setWhitelist(address _whitelist) external onlyOwner {
        whitelist = _whitelist;
    }

    /**
     * @notice set backstop liquidity provider
     * @dev only owner can call
     * @param account provider address
     * @param isProvider wether the account is a backstop liquidity provider
     */
    function setBackstopLiquidityProvider(address account, bool isProvider) external onlyOwner {
        backstopLiquidityProviderMap[account] = isProvider;
        emit BackstopLiquidityProviderChanged(account, isProvider);
    }

    /**
     * @notice set the margin ratio after deleveraging
     * @dev only owner can call
     */
    function setPartialLiquidationRatio(uint256 _ratio) external onlyOwner {
        //require(_ratio.cmp(Decimal.one()) <= 0, "invalid partial liquidation ratio");
        require(_ratio <= 1 ether, "invalid partial liquidation ratio");
        partialLiquidationRatio = _ratio;
    }

    function setOperator(address _operator) external onlyOwner {
        operator = _operator;
    }

    /**
     * @notice add margin to increase margin ratio
     * @param _amm IAmm address
     * @param _addedMargin added margin in 18 digits
     */
    function addMargin(IAmm _amm, uint256 _addedMargin) external whenNotPaused nonReentrant {
        // check condition
        _requireAmm(_amm, true);
        _requireNonZeroInput(_addedMargin);

        address trader = _msgSender();
        Position memory position = getPosition(_amm, trader);
        // update margin
        position.margin = position.margin + _addedMargin;

        _setPosition(_amm, trader, position);
        // transfer token from trader
        _deposit(_amm, trader, _addedMargin);
        emit MarginChanged(trader, address(_amm), int256(_addedMargin), 0);
    }

    /**
     * @notice remove margin to decrease margin ratio
     * @param _amm IAmm address
     * @param _removedMargin removed margin in 18 digits
     */
    function removeMargin(IAmm _amm, uint256 _removedMargin) external whenNotPaused nonReentrant {
        // check condition
        _requireAmm(_amm, true);
        _requireNonZeroInput(_removedMargin);

        address trader = _msgSender();
        // realize funding payment if there's no bad debt
        Position memory position = getPosition(_amm, trader);

        // update margin and cumulativePremiumFraction
        int256 marginDelta = _removedMargin.toInt() * -1;
        (
            uint256 remainMargin,
            uint256 badDebt,
            int256 fundingPayment,
            int256 latestCumulativePremiumFraction
        ) = _calcRemainMarginWithFundingPayment(_amm, position, marginDelta);
        require(badDebt == 0, "margin is not enough");
        position.margin = remainMargin;
        position.lastUpdatedCumulativePremiumFraction = latestCumulativePremiumFraction;

        // check enough margin (same as the way Curie calculates the free collateral)
        // Use a more conservative way to restrict traders to remove their margin
        // We don't allow unrealized PnL to support their margin removal
        require(_calcFreeCollateral(_amm, trader, remainMargin - badDebt) >= 0, "free collateral is not enough");

        _setPosition(_amm, trader, position);

        // transfer token back to trader
        _withdraw(_amm, trader, _removedMargin);
        emit MarginChanged(trader, address(_amm), marginDelta, fundingPayment);
    }

    /**
     * @notice settle all the positions when amm is shutdown. The settlement price is according to IAmm.settlementPrice
     * @param _amm IAmm address
     */
    function settlePosition(IAmm _amm) external nonReentrant {
        // check condition
        _requireAmm(_amm, false);
        address trader = _msgSender();
        Position memory pos = getPosition(_amm, trader);
        _requirePositionSize(pos.size);
        // update position
        _setPosition(
            _amm,
            trader,
            Position({
                size: 0,
                margin: 0,
                openNotional: 0,
                lastUpdatedCumulativePremiumFraction: 0,
                blockNumber: _blockNumber(),
                liquidityHistoryIndex: 0
            })
        );
        // calculate settledValue
        // If Settlement Price = 0, everyone takes back her collateral.
        // else Returned Fund = Position Size * (Settlement Price - Open Price) + Collateral
        uint256 settlementPrice = _amm.getSettlementPrice();
        uint256 settledValue;
        if (settlementPrice == 0) {
            settledValue = pos.margin;
        } else {
            // returnedFund = positionSize * (settlementPrice - openPrice) + positionMargin
            // openPrice = positionOpenNotional / positionSize.abs()
            int256 returnedFund = pos.size.mulD(settlementPrice.toInt() - (pos.openNotional.divD(pos.size.abs())).toInt()) +
                pos.margin.toInt();
            // if `returnedFund` is negative, trader can't get anything back
            if (returnedFund > 0) {
                settledValue = returnedFund.abs();
            }
        }
        // transfer token based on settledValue. no insurance fund support
        if (settledValue > 0) {
            _withdraw(_amm, trader, settledValue);
            // _amm.quoteAsset().safeTransfer(trader, settledValue);
            //_transfer(_amm.quoteAsset(), trader, settledValue);
        }
        // emit event
        emit PositionSettled(address(_amm), trader, settledValue);
    }

    // if increase position
    //   marginToVault = addMargin
    //   marginDiff = realizedFundingPayment + realizedPnl(0)
    //   pos.margin += marginToVault + marginDiff
    //   vault.margin += marginToVault + marginDiff
    //   required(enoughMarginRatio)
    // else if reduce position()
    //   marginToVault = 0
    //   marginDiff = realizedFundingPayment + realizedPnl
    //   pos.margin += marginToVault + marginDiff
    //   if pos.margin < 0, badDebt = abs(pos.margin), set pos.margin = 0
    //   vault.margin += marginToVault + marginDiff
    //   required(enoughMarginRatio)
    // else if close
    //   marginDiff = realizedFundingPayment + realizedPnl
    //   pos.margin += marginDiff
    //   if pos.margin < 0, badDebt = abs(pos.margin)
    //   marginToVault = -pos.margin
    //   set pos.margin = 0
    //   vault.margin += marginToVault + marginDiff
    // else if close and open a larger position in reverse side
    //   close()
    //   positionNotional -= exchangedQuoteAssetAmount
    //   newMargin = positionNotional / leverage
    //   _increasePosition(newMargin, leverage)
    // else if liquidate
    //   close()
    //   pay liquidation fee to liquidator
    //   move the remain margin to insuranceFund

    /**
     * @notice open a position
     * @param _amm amm address
     * @param _side enum Side; BUY for long and SELL for short
     * @param _amount leveraged asset amount to be exact amount in 18 digits. Can Not be 0
     * @param _leverage leverage  in 18 digits. Can Not be 0
     * @param _oppositeAmountBound minimum or maxmum asset amount expected to get to prevent from slippage.
     * @param _isQuote if _assetAmount is quote asset, then true, otherwise false.
     */
    function openPosition(
        IAmm _amm,
        Side _side,
        uint256 _amount,
        uint256 _leverage,
        uint256 _oppositeAmountBound,
        bool _isQuote
    ) external whenNotPaused nonReentrant {
        _requireAmm(_amm, true);
        _requireNonZeroInput(_amount);
        _requireNonZeroInput(_leverage);
        _requireMoreMarginRatio(int256(1 ether).divD(_leverage.toInt()), initMarginRatio, true);
        _requireNotRestrictionMode(_amm);

        address trader = _msgSender();
        PositionResp memory positionResp;
        {
            // add scope for stack too deep error
            int256 oldPositionSize = getPosition(_amm, trader).size;
            bool isNewPosition = oldPositionSize == 0 ? true : false;

            // increase or decrease position depends on old position's side and size
            if (isNewPosition || (oldPositionSize > 0 ? Side.BUY : Side.SELL) == _side) {
                positionResp = _increasePosition(_amm, _side, trader, _amount, _leverage, _isQuote);
            } else {
                positionResp = _openReversePosition(_amm, _side, trader, _amount, _leverage, _isQuote, false);
            }

            _checkSlippage(
                _side,
                positionResp.exchangedQuoteAssetAmount,
                positionResp.exchangedPositionSize.abs(),
                _oppositeAmountBound,
                _isQuote
            );

            // update the position state
            _setPosition(_amm, trader, positionResp.position);
            // if opening the exact position size as the existing one == closePosition, can skip the margin ratio check
            if (!isNewPosition && positionResp.position.size != 0) {
                _requireMoreMarginRatio(getMarginRatio(_amm, trader), maintenanceMarginRatio, true);
            }

            // to prevent attacker to leverage the bad debt to withdraw extra token from insurance fund
            require(positionResp.badDebt == 0, "bad debt");

            // transfer the actual token between trader and vault
            if (positionResp.marginToVault > 0) {
                _deposit(_amm, trader, positionResp.marginToVault.abs());
            } else if (positionResp.marginToVault < 0) {
                _withdraw(_amm, trader, positionResp.marginToVault.abs());
            }
        }

        // transfer token for fees
        _transferFee(trader, _amm, positionResp.spreadFee, positionResp.tollFee);

        // emit event
        uint256 spotPrice = _amm.getSpotPrice();
        int256 fundingPayment = positionResp.fundingPayment; // pre-fetch for stack too deep error
        emit PositionChanged(
            trader,
            address(_amm),
            positionResp.position.margin,
            positionResp.exchangedQuoteAssetAmount,
            positionResp.exchangedPositionSize,
            positionResp.spreadFee + positionResp.tollFee,
            positionResp.position.size,
            positionResp.realizedPnl,
            positionResp.unrealizedPnlAfter,
            positionResp.badDebt,
            0,
            spotPrice,
            fundingPayment
        );
    }

    /**
     * @notice close all the positions
     * @param _amm IAmm address
     */
    function closePosition(IAmm _amm, uint256 _quoteAssetAmountLimit) external whenNotPaused nonReentrant {
        // check conditions
        _requireAmm(_amm, true);
        _requireNotRestrictionMode(_amm);

        // update position
        address trader = _msgSender();

        PositionResp memory positionResp;
        {
            Position memory position = getPosition(_amm, trader);
            // // if it is long position, close a position means short it(which means base dir is ADD_TO_AMM) and vice versa
            // IAmm.Dir dirOfBase = position.size > 0 ? IAmm.Dir.ADD_TO_AMM : IAmm.Dir.REMOVE_FROM_AMM;

            positionResp = _closePosition(_amm, trader, false);
            _checkSlippage(
                position.size > 0 ? Side.SELL : Side.BUY,
                positionResp.exchangedQuoteAssetAmount,
                positionResp.exchangedPositionSize.abs(),
                _quoteAssetAmountLimit,
                false
            );

            // to prevent attacker to leverage the bad debt to withdraw extra token from insurance fund
            require(positionResp.badDebt == 0, "bad debt");

            // add scope for stack too deep error
            // transfer the actual token from trader and vault
            _withdraw(_amm, trader, positionResp.marginToVault.abs());
        }

        // transfer token for fees
        _transferFee(trader, _amm, positionResp.spreadFee, positionResp.tollFee);

        // prepare event
        uint256 spotPrice = _amm.getSpotPrice();
        int256 fundingPayment = positionResp.fundingPayment;
        emit PositionChanged(
            trader,
            address(_amm),
            positionResp.position.margin,
            positionResp.exchangedQuoteAssetAmount,
            positionResp.exchangedPositionSize,
            positionResp.spreadFee + positionResp.tollFee,
            positionResp.position.size,
            positionResp.realizedPnl,
            positionResp.unrealizedPnlAfter,
            positionResp.badDebt,
            0,
            spotPrice,
            fundingPayment
        );
    }

    function liquidateWithSlippage(
        IAmm _amm,
        address _trader,
        uint256 _quoteAssetAmountLimit
    ) external nonReentrant returns (uint256 quoteAssetAmount, bool isPartialClose) {
        Position memory position = getPosition(_amm, _trader);
        (quoteAssetAmount, isPartialClose) = _liquidate(_amm, _trader);

        uint256 quoteAssetAmountLimit = isPartialClose ? _quoteAssetAmountLimit.mulD(partialLiquidationRatio) : _quoteAssetAmountLimit;

        if (position.size > 0) {
            require(quoteAssetAmount >= quoteAssetAmountLimit, "Less than minimal quote token");
        } else if (position.size < 0 && quoteAssetAmountLimit != 0) {
            require(quoteAssetAmount <= quoteAssetAmountLimit, "More than maximal quote token");
        }

        return (quoteAssetAmount, isPartialClose);
    }

    /**
     * @notice liquidate trader's underwater position. Require trader's margin ratio less than maintenance margin ratio
     * @dev liquidator can NOT open any positions in the same block to prevent from price manipulation.
     * @param _amm IAmm address
     * @param _trader trader address
     */
    function liquidate(IAmm _amm, address _trader) external nonReentrant {
        _liquidate(_amm, _trader);
    }

    /**
     * @notice if funding rate is positive, traders with long position pay traders with short position and vice versa.
     * @param _amm IAmm address
     */
    function payFunding(IAmm _amm) external {
        _requireAmm(_amm, true);
        _formulaicRepegAmm(_amm);
        uint256 cap = getAdjustmentPoolAmount(address(_amm));
        (int256 premiumFraction, int256 fundingPayment, int256 fundingImbalanceCost) = _amm.settleFunding(cap);
        ammMap[address(_amm)].cumulativePremiumFractions.push(premiumFraction + getLatestCumulativePremiumFraction(_amm));
        // funding payment is positive means profit
        if (fundingPayment < 0) {
            totalMinusFees[address(_amm)] = totalMinusFees[address(_amm)] - fundingPayment.abs();
            _withdrawFromInsuranceFund(_amm, fundingPayment.abs());
        } else {
            totalMinusFees[address(_amm)] = totalMinusFees[address(_amm)] + fundingPayment.abs();
            _transferToInsuranceFund(_amm, fundingPayment.abs());
        }
        _formulaicUpdateK(_amm, fundingImbalanceCost);
        netRevenuesSinceLastFunding[address(_amm)] = 0;
    }

    /**
     * @notice repeg amm according to off-chain calculation for the healthy of market
     * @dev only the operator can call this function
     * @param _amm IAmm address
     * @param _newQuoteAssetReserve the quote asset amount to be repegged
     */
    function repegAmm(IAmm _amm, uint256 _newQuoteAssetReserve) external onlyOperator {
        (uint256 quoteAssetReserve, uint256 baseAssetReserve) = _amm.getReserve();
        int256 positionSize = _amm.getBaseAssetDelta();
        int256 cost = AmmMath.adjustPegCost(quoteAssetReserve, baseAssetReserve, positionSize, _newQuoteAssetReserve);

        uint256 totalFee = totalFees[address(_amm)];
        uint256 totalMinusFee = totalMinusFees[address(_amm)];
        uint256 budget = totalMinusFee > totalFee / 2 ? totalMinusFee - totalFee / 2 : 0;
        require(cost <= 0 || cost.abs() <= budget, "insufficient fee pool");
        require(_applyCost(_amm, cost), "failed to apply cost");
        _amm.adjust(_newQuoteAssetReserve, baseAssetReserve);
        emit Repeg(address(_amm), _newQuoteAssetReserve, baseAssetReserve, cost);
    }

    /**
     * @notice adjust K of amm according to off-chain calculation for the healthy of market
     * @dev only the operator can call this function
     * @param _amm IAmm address
     * @param _scaleNum the numerator of K scale to be adjusted
     * @param _scaleDenom the denominator of K scale to be adjusted
     */
    function adjustK(
        IAmm _amm,
        uint256 _scaleNum,
        uint256 _scaleDenom
    ) external onlyOperator {
        (uint256 quoteAssetReserve, uint256 baseAssetReserve) = _amm.getReserve();
        int256 positionSize = _amm.getBaseAssetDelta();
        (int256 cost, uint256 newQuoteAssetReserve, uint256 newBaseAssetReserve) = AmmMath.adjustKCost(
            quoteAssetReserve,
            baseAssetReserve,
            positionSize,
            _scaleNum,
            _scaleDenom
        );

        uint256 totalFee = totalFees[address(_amm)];
        uint256 totalMinusFee = totalMinusFees[address(_amm)];
        uint256 budget = totalMinusFee > totalFee / 2 ? totalMinusFee - totalFee / 2 : 0;
        require(cost <= 0 || cost.abs() <= budget, "insufficient fee pool");
        require(_applyCost(_amm, cost), "failed to apply cost");
        _amm.adjust(newQuoteAssetReserve, newBaseAssetReserve);
        emit UpdateK(address(_amm), newQuoteAssetReserve, newBaseAssetReserve, cost);
    }

    function deposit2FeePool(IAmm _amm, uint256 _amount) external {
        IERC20 quoteAsset = _amm.quoteAsset();
        quoteAsset.safeTransferFrom(_msgSender(), address(insuranceFund), _amount);
        totalFees[address(_amm)] += _amount;
        totalMinusFees[address(_amm)] += _amount;
    }

    function withdrawFromFeePool(IAmm _amm, uint256 _amount) external onlyOwner {
        totalFees[address(_amm)] -= _amount;
        totalMinusFees[address(_amm)] -= _amount;
        IERC20 quoteAsset = _amm.quoteAsset();
        insuranceFund.withdraw(quoteAsset, _amount);
        quoteAsset.safeTransfer(_msgSender(), _amount);
    }

    //
    // VIEW FUNCTIONS
    //

    /**
     * @notice get margin ratio, marginRatio = (margin + funding payment + unrealized Pnl) / positionNotional
     * use spot price to calculate unrealized Pnl
     * @param _amm IAmm address
     * @param _trader trader address
     * @return margin ratio in 18 digits
     */
    function getMarginRatio(IAmm _amm, address _trader) public view returns (int256) {
        Position memory position = getPosition(_amm, _trader);
        _requirePositionSize(position.size);
        (uint256 positionNotional, int256 unrealizedPnl) = getPositionNotionalAndUnrealizedPnl(_amm, _trader, PnlCalcOption.SPOT_PRICE);
        return _getMarginRatio(_amm, position, unrealizedPnl, positionNotional);
    }

    /**
     * @notice get personal position information
     * @param _amm IAmm address
     * @param _trader trader address
     * @return struct Position
     */
    function getPosition(IAmm _amm, address _trader) public view returns (Position memory) {
        return ammMap[address(_amm)].positionMap[_trader];
    }

    /**
     * @notice get position notional and unrealized Pnl without fee expense and funding payment
     * @param _amm IAmm address
     * @param _trader trader address
     * @param _pnlCalcOption enum PnlCalcOption, SPOT_PRICE for spot price and TWAP for twap price
     * @return positionNotional position notional
     * @return unrealizedPnl unrealized Pnl
     */
    function getPositionNotionalAndUnrealizedPnl(
        IAmm _amm,
        address _trader,
        PnlCalcOption _pnlCalcOption
    ) public view returns (uint256 positionNotional, int256 unrealizedPnl) {
        Position memory position = getPosition(_amm, _trader);
        uint256 positionSizeAbs = position.size.abs();
        if (positionSizeAbs != 0) {
            bool isShortPosition = position.size < 0;
            IAmm.Dir dir = isShortPosition ? IAmm.Dir.REMOVE_FROM_AMM : IAmm.Dir.ADD_TO_AMM;
            if (_pnlCalcOption == PnlCalcOption.TWAP) {
                positionNotional = _amm.getOutputTwap(dir, positionSizeAbs);
            } else if (_pnlCalcOption == PnlCalcOption.SPOT_PRICE) {
                positionNotional = _amm.getOutputPrice(dir, positionSizeAbs);
            } else {
                uint256 oraclePrice = _amm.getUnderlyingPrice();
                positionNotional = positionSizeAbs.mulD(oraclePrice);
            }
            // unrealizedPnlForLongPosition = positionNotional - openNotional
            // unrealizedPnlForShortPosition = positionNotionalWhenBorrowed - positionNotionalWhenReturned =
            // openNotional - positionNotional = unrealizedPnlForLongPosition * -1
            unrealizedPnl = isShortPosition
                ? position.openNotional.toInt() - positionNotional.toInt()
                : positionNotional.toInt() - position.openNotional.toInt();
        }
    }

    /**
     * @notice get latest cumulative premium fraction.
     * @param _amm IAmm address
     * @return latest cumulative premium fraction in 18 digits
     */
    function getLatestCumulativePremiumFraction(IAmm _amm) public view returns (int256 latest) {
        uint256 len = ammMap[address(_amm)].cumulativePremiumFractions.length;
        if (len > 0) {
            latest = ammMap[address(_amm)].cumulativePremiumFractions[len - 1];
        }
    }

    // function _getMarginRatioByCalcOption(
    //     IAmm _amm,
    //     address _trader,
    //     PnlCalcOption _pnlCalcOption
    // ) internal view returns (int256) {
    //     Position memory position = getPosition(_amm, _trader);
    //     _requirePositionSize(position.size);
    //     (uint256 positionNotional, int256 pnl) = getPositionNotionalAndUnrealizedPnl(_amm, _trader, _pnlCalcOption);
    //     return _getMarginRatio(_amm, position, pnl, positionNotional);
    // }

    /**
     * @notice Only a portion of the protocol fees are allocated to adjustment and funding payment
     * @dev half of total fee is allocated to market loss, the remain to adjustment
     * @param _amm the address of vamm
     * @return amount the fee amount allocated to adjustmnet and funding payment
     */
    function getAdjustmentPoolAmount(address _amm) public view returns (uint256 amount) {
        uint256 totalFee = totalFees[_amm];
        uint256 totalMinusFee = totalMinusFees[_amm];
        amount = totalMinusFee > totalFee / 2 ? totalMinusFee - totalFee / 2 : 0;
    }

    //
    // INTERNAL FUNCTIONS
    //

    function _getMarginRatio(
        IAmm _amm,
        Position memory _position,
        int256 _unrealizedPnl,
        uint256 _positionNotional
    ) internal view returns (int256) {
        (uint256 remainMargin, uint256 badDebt, , ) = _calcRemainMarginWithFundingPayment(_amm, _position, _unrealizedPnl);
        return (remainMargin.toInt() - badDebt.toInt()).divD(_positionNotional.toInt());
    }

    function _enterRestrictionMode(IAmm _amm) internal {
        uint256 blockNumber = _blockNumber();
        ammMap[address(_amm)].lastRestrictionBlock = blockNumber;
        emit RestrictionModeEntered(address(_amm), blockNumber);
    }

    function _setPosition(
        IAmm _amm,
        address _trader,
        Position memory _position
    ) internal {
        Position storage positionStorage = ammMap[address(_amm)].positionMap[_trader];
        positionStorage.size = _position.size;
        positionStorage.margin = _position.margin;
        positionStorage.openNotional = _position.openNotional;
        positionStorage.lastUpdatedCumulativePremiumFraction = _position.lastUpdatedCumulativePremiumFraction;
        positionStorage.blockNumber = _position.blockNumber;
        positionStorage.liquidityHistoryIndex = _position.liquidityHistoryIndex;
    }

    function _liquidate(IAmm _amm, address _trader) internal returns (uint256 quoteAssetAmount, bool isPartialClose) {
        _requireAmm(_amm, true);
        int256 marginRatio = getMarginRatio(_amm, _trader);
        // // once oracle price is updated ervery funding payment, this part has no longer effect
        // // including oracle-based margin ratio as reference price when amm is over spread limit
        // if (_amm.isOverSpreadLimit()) {
        //     int256 marginRatioBasedOnOracle = _getMarginRatioByCalcOption(_amm, _trader, PnlCalcOption.ORACLE);
        //     if (marginRatioBasedOnOracle - marginRatio > 0) {
        //         marginRatio = marginRatioBasedOnOracle;
        //     }
        // }
        _requireMoreMarginRatio(marginRatio, maintenanceMarginRatio, false);

        PositionResp memory positionResp;
        uint256 liquidationPenalty;
        {
            uint256 liquidationBadDebt;
            uint256 feeToLiquidator;
            uint256 feeToInsuranceFund;

            // int256 marginRatioBasedOnSpot = _getMarginRatioByCalcOption(_amm, _trader, PnlCalcOption.SPOT_PRICE);
            if (
                // check margin(based on spot price) is enough to pay the liquidation fee
                // after partially close, otherwise we fully close the position.
                // that also means we can ensure no bad debt happen when partially liquidate
                marginRatio > int256(liquidationFeeRatio) && partialLiquidationRatio < 1 ether && partialLiquidationRatio != 0
            ) {
                Position memory position = getPosition(_amm, _trader);
                positionResp = _openReversePosition(
                    _amm,
                    position.size > 0 ? Side.SELL : Side.BUY,
                    _trader,
                    position.size.mulD(partialLiquidationRatio.toInt()).abs(),
                    1 ether,
                    false,
                    true
                );

                // half of the liquidationFee goes to liquidator & another half goes to insurance fund
                liquidationPenalty = positionResp.exchangedQuoteAssetAmount.mulD(liquidationFeeRatio);
                feeToLiquidator = liquidationPenalty / 2;
                feeToInsuranceFund = liquidationPenalty - feeToLiquidator;

                positionResp.position.margin = positionResp.position.margin - liquidationPenalty;
                _setPosition(_amm, _trader, positionResp.position);

                isPartialClose = true;
            } else {
                liquidationPenalty = getPosition(_amm, _trader).margin;
                positionResp = _closePosition(_amm, _trader, true);
                uint256 remainMargin = positionResp.marginToVault.abs();
                feeToLiquidator = positionResp.exchangedQuoteAssetAmount.mulD(liquidationFeeRatio) / 2;

                // if the remainMargin is not enough for liquidationFee, count it as bad debt
                // else, then the rest will be transferred to insuranceFund
                uint256 totalBadDebt = positionResp.badDebt;
                if (feeToLiquidator > remainMargin) {
                    liquidationBadDebt = feeToLiquidator - remainMargin;
                    totalBadDebt = totalBadDebt + liquidationBadDebt;
                    remainMargin = 0;
                } else {
                    remainMargin = remainMargin - feeToLiquidator;
                }

                // transfer the actual token between trader and vault
                if (totalBadDebt > 0) {
                    require(backstopLiquidityProviderMap[_msgSender()], "not backstop LP");
                    _realizeBadDebt(_amm, totalBadDebt);
                }
                if (remainMargin > 0) {
                    feeToInsuranceFund = remainMargin;
                }
            }

            if (feeToInsuranceFund > 0) {
                _transferToInsuranceFund(_amm, feeToInsuranceFund);
            }
            _withdraw(_amm, _msgSender(), feeToLiquidator);
            _enterRestrictionMode(_amm);

            emit PositionLiquidated(
                _trader,
                address(_amm),
                positionResp.exchangedQuoteAssetAmount,
                positionResp.exchangedPositionSize.toUint(),
                feeToLiquidator,
                _msgSender(),
                liquidationBadDebt
            );
        }

        // emit event
        uint256 spotPrice = _amm.getSpotPrice();
        emit PositionChanged(
            _trader,
            address(_amm),
            positionResp.position.margin,
            positionResp.exchangedQuoteAssetAmount,
            positionResp.exchangedPositionSize,
            0,
            positionResp.position.size,
            positionResp.realizedPnl,
            positionResp.unrealizedPnlAfter,
            positionResp.badDebt,
            liquidationPenalty,
            spotPrice,
            positionResp.fundingPayment
        );

        return (positionResp.exchangedQuoteAssetAmount, isPartialClose);
    }

    // only called from openPosition and _closeAndOpenReversePosition. caller need to ensure there's enough marginRatio
    function _increasePosition(
        IAmm _amm,
        Side _side,
        address _trader,
        uint256 _amount,
        uint256 _leverage,
        bool _isQuote
    ) internal returns (PositionResp memory positionResp) {
        Position memory oldPosition = getPosition(_amm, _trader);
        (positionResp.exchangedQuoteAssetAmount, positionResp.exchangedPositionSize, positionResp.spreadFee, positionResp.tollFee) = _swap(
            _amm,
            _side,
            _amount,
            _isQuote,
            false
        );

        int256 newSize = oldPosition.size + positionResp.exchangedPositionSize;

        _updateOpenInterestNotional(_amm, positionResp.exchangedQuoteAssetAmount.toInt());
        // if the trader is not in the whitelist, check max position size
        if (_trader != whitelist) {
            uint256 maxHoldingBaseAsset = _amm.getMaxHoldingBaseAsset();
            if (maxHoldingBaseAsset > 0) {
                // total position size should be less than `positionUpperBound`
                require(newSize.abs() <= maxHoldingBaseAsset, "hit position size upper bound"); //hit position size upper bound
            }
        }

        int256 increaseMarginRequirement = positionResp.exchangedQuoteAssetAmount.divD(_leverage).toInt();
        (
            uint256 remainMargin, // the 2nd return (bad debt) must be 0 - already checked from caller
            ,
            int256 fundingPayment,
            int256 latestCumulativePremiumFraction
        ) = _calcRemainMarginWithFundingPayment(_amm, oldPosition, increaseMarginRequirement);

        (, int256 unrealizedPnl) = getPositionNotionalAndUnrealizedPnl(_amm, _trader, PnlCalcOption.SPOT_PRICE);

        // update positionResp
        positionResp.unrealizedPnlAfter = unrealizedPnl;
        positionResp.marginToVault = increaseMarginRequirement;
        positionResp.fundingPayment = fundingPayment;
        positionResp.position = Position(
            newSize, //Number of base asset (e.g. BAYC)
            remainMargin,
            oldPosition.openNotional + positionResp.exchangedQuoteAssetAmount, //In Quote Asset (e.g. USDC)
            latestCumulativePremiumFraction,
            oldPosition.liquidityHistoryIndex,
            _blockNumber()
        );
    }

    function _openReversePosition(
        IAmm _amm,
        Side _side,
        address _trader,
        uint256 _amount,
        uint256 _leverage,
        bool _isQuote,
        bool _canOverFluctuationLimit
    ) internal returns (PositionResp memory) {
        (uint256 oldPositionNotional, int256 unrealizedPnl) = getPositionNotionalAndUnrealizedPnl(_amm, _trader, PnlCalcOption.SPOT_PRICE);
        Position memory oldPosition = getPosition(_amm, _trader);
        PositionResp memory positionResp;

        // reduce position if old position is larger
        if (_isQuote ? oldPositionNotional > _amount : oldPosition.size.abs() > _amount) {
            (
                positionResp.exchangedQuoteAssetAmount,
                positionResp.exchangedPositionSize,
                positionResp.spreadFee,
                positionResp.tollFee
            ) = _swap(_amm, _side, _amount, _isQuote, _canOverFluctuationLimit);

            _updateOpenInterestNotional(_amm, positionResp.exchangedQuoteAssetAmount.toInt() * -1);
            // realizedPnl = unrealizedPnl * closedRatio
            // closedRatio = positionResp.exchangedPositionSiz / oldPosition.size
            if (oldPosition.size != 0) {
                positionResp.realizedPnl = unrealizedPnl.mulD(positionResp.exchangedPositionSize.abs().toInt()).divD(
                    oldPosition.size.abs().toInt()
                );
            }
            uint256 remainMargin;
            int256 latestCumulativePremiumFraction;
            (
                remainMargin,
                positionResp.badDebt,
                positionResp.fundingPayment,
                latestCumulativePremiumFraction
            ) = _calcRemainMarginWithFundingPayment(_amm, oldPosition, positionResp.realizedPnl);

            // positionResp.unrealizedPnlAfter = unrealizedPnl - realizedPnl
            positionResp.unrealizedPnlAfter = unrealizedPnl - positionResp.realizedPnl;

            // calculate openNotional (it's different depends on long or short side)
            // long: unrealizedPnl = positionNotional - openNotional => openNotional = positionNotional - unrealizedPnl
            // short: unrealizedPnl = openNotional - positionNotional => openNotional = positionNotional + unrealizedPnl
            // positionNotional = oldPositionNotional - exchangedQuoteAssetAmount
            int256 remainOpenNotional = oldPosition.size > 0
                ? oldPositionNotional.toInt() - positionResp.exchangedQuoteAssetAmount.toInt() - positionResp.unrealizedPnlAfter
                : positionResp.unrealizedPnlAfter + oldPositionNotional.toInt() - positionResp.exchangedQuoteAssetAmount.toInt();
            require(remainOpenNotional > 0, "value of openNotional <= 0");

            positionResp.position = Position(
                oldPosition.size + positionResp.exchangedPositionSize,
                remainMargin,
                remainOpenNotional.abs(),
                latestCumulativePremiumFraction,
                oldPosition.liquidityHistoryIndex,
                _blockNumber()
            );
            return positionResp;
        }

        return _closeAndOpenReversePosition(_amm, _side, _trader, _amount, _leverage, _isQuote);
    }

    function _closeAndOpenReversePosition(
        IAmm _amm,
        Side _side,
        address _trader,
        uint256 _amount,
        uint256 _leverage,
        bool _isQuote
    ) internal returns (PositionResp memory positionResp) {
        // new position size is larger than or equal to the old position size
        // so either close or close then open a larger position
        PositionResp memory closePositionResp = _closePosition(_amm, _trader, false);

        // the old position is underwater. trader should close a position first
        require(closePositionResp.badDebt == 0, "reduce an underwater position");

        // update open notional after closing position
        uint256 amount = _isQuote
            ? _amount - closePositionResp.exchangedQuoteAssetAmount
            : _amount - closePositionResp.exchangedPositionSize.abs();

        // if remain asset amount is too small (eg. 10 wei) then the required margin might be 0
        // then the clearingHouse will stop opening position
        if (amount <= 10 wei) {
            positionResp = closePositionResp;
        } else {
            PositionResp memory increasePositionResp = _increasePosition(_amm, _side, _trader, amount, _leverage, _isQuote);
            positionResp = PositionResp({
                position: increasePositionResp.position,
                exchangedQuoteAssetAmount: closePositionResp.exchangedQuoteAssetAmount + increasePositionResp.exchangedQuoteAssetAmount,
                badDebt: closePositionResp.badDebt + increasePositionResp.badDebt,
                fundingPayment: closePositionResp.fundingPayment + increasePositionResp.fundingPayment,
                exchangedPositionSize: closePositionResp.exchangedPositionSize + increasePositionResp.exchangedPositionSize,
                realizedPnl: closePositionResp.realizedPnl + increasePositionResp.realizedPnl,
                unrealizedPnlAfter: 0,
                marginToVault: closePositionResp.marginToVault + increasePositionResp.marginToVault,
                spreadFee: closePositionResp.spreadFee + increasePositionResp.spreadFee,
                tollFee: closePositionResp.tollFee + increasePositionResp.tollFee
            });
        }
        return positionResp;
    }

    function _closePosition(
        IAmm _amm,
        address _trader,
        bool _canOverFluctuationLimit
    ) internal returns (PositionResp memory positionResp) {
        // check conditions
        Position memory oldPosition = getPosition(_amm, _trader);
        _requirePositionSize(oldPosition.size);

        (, int256 unrealizedPnl) = getPositionNotionalAndUnrealizedPnl(_amm, _trader, PnlCalcOption.SPOT_PRICE);
        (uint256 remainMargin, uint256 badDebt, int256 fundingPayment, ) = _calcRemainMarginWithFundingPayment(
            _amm,
            oldPosition,
            unrealizedPnl
        );

        positionResp.realizedPnl = unrealizedPnl;
        positionResp.badDebt = badDebt;
        positionResp.fundingPayment = fundingPayment;
        positionResp.marginToVault = remainMargin.toInt() * -1;

        (positionResp.exchangedQuoteAssetAmount, positionResp.exchangedPositionSize, positionResp.spreadFee, positionResp.tollFee) = _swap(
            _amm,
            oldPosition.size > 0 ? Side.SELL : Side.BUY,
            oldPosition.size.abs(),
            false,
            _canOverFluctuationLimit
        );

        // bankrupt position's bad debt will be also consider as a part of the open interest
        _updateOpenInterestNotional(_amm, (unrealizedPnl + badDebt.toInt() + oldPosition.openNotional.toInt()) * -1);
        _setPosition(
            _amm,
            _trader,
            Position({
                size: 0,
                margin: 0,
                openNotional: 0,
                lastUpdatedCumulativePremiumFraction: 0,
                blockNumber: _blockNumber(),
                liquidityHistoryIndex: 0
            })
        );
    }

    function _swap(
        IAmm _amm,
        Side _side,
        uint256 _amount,
        bool _isQuote,
        bool _canOverFluctuationLimit
    )
        internal
        returns (
            uint256 quoteAmount,
            int256 baseAmount,
            uint256 spreadFee,
            uint256 tollFee
        )
    {
        if (_isQuote) {
            // swap quote
            // long => add, short => remove
            quoteAmount = _amount;
            uint256 ubaseAmount;
            if (_side == Side.BUY) {
                (ubaseAmount, spreadFee, tollFee) = _amm.swapInput(IAmm.Dir.ADD_TO_AMM, _amount, _canOverFluctuationLimit);
                baseAmount = ubaseAmount.toInt();
            } else {
                (ubaseAmount, spreadFee, tollFee) = _amm.swapInput(IAmm.Dir.REMOVE_FROM_AMM, _amount, _canOverFluctuationLimit);
                baseAmount = ubaseAmount.toInt() * -1;
            }
        } else {
            // swap base
            // long => remove, short => add
            if (_side == Side.BUY) {
                (quoteAmount, spreadFee, tollFee) = _amm.swapOutput(IAmm.Dir.REMOVE_FROM_AMM, _amount, _canOverFluctuationLimit);
                baseAmount = _amount.toInt();
            } else {
                (quoteAmount, spreadFee, tollFee) = _amm.swapOutput(IAmm.Dir.ADD_TO_AMM, _amount, _canOverFluctuationLimit);
                baseAmount = _amount.toInt() * -1;
            }
        }
    }

    function _checkSlippage(
        Side _side,
        uint256 _quote,
        uint256 _base,
        uint256 _oppositeAmountBound,
        bool _isQuote
    ) internal pure {
        // skip when _oppositeAmountBound is zero
        if (_oppositeAmountBound == 0) {
            return;
        }
        // long + isQuote, want more output base as possible, so we set a lower bound of output base
        // short + isQuote, want less input base as possible, so we set a upper bound of input base
        // long + !isQuote, want less input quote as possible, so we set a upper bound of input quote
        // short + !isQuote, want more output quote as possible, so we set a lower bound of output quote
        if (_isQuote) {
            if (_side == Side.BUY) {
                // too little received when long
                require(_base >= _oppositeAmountBound, "CH_TLRL");
            } else {
                // too much requested when short
                require(_base <= _oppositeAmountBound, "CH_TMRS");
            }
        } else {
            if (_side == Side.BUY) {
                // too much requested when long
                require(_quote <= _oppositeAmountBound, "CH_TMRL");
            } else {
                // too little received when short
                require(_quote >= _oppositeAmountBound, "CH_TLRS");
            }
        }
    }

    function _transferFee(
        address _from,
        IAmm _amm,
        uint256 _spreadFee,
        uint256 _tollFee
    ) internal {
        IERC20 quoteAsset = _amm.quoteAsset();

        // transfer spread to market in order to use it to make market better
        if (_spreadFee > 0) {
            quoteAsset.safeTransferFrom(_from, address(insuranceFund), _spreadFee);
            totalFees[address(_amm)] += _spreadFee;
            totalMinusFees[address(_amm)] += _spreadFee;
            netRevenuesSinceLastFunding[address(_amm)] += _spreadFee.toInt();
        }

        // transfer toll to tollPool
        if (_tollFee > 0) {
            require(address(tollPool) != address(0), "Invalid"); //Invalid tollPool
            quoteAsset.safeTransferFrom(_from, address(tollPool), _tollFee);
        }
    }

    function _deposit(
        IAmm _amm,
        address _sender,
        uint256 _amount
    ) internal {
        vaults[address(_amm)] += _amount;
        IERC20 quoteToken = _amm.quoteAsset();
        quoteToken.safeTransferFrom(_sender, address(this), _amount);
    }

    function _withdraw(
        IAmm _amm,
        address _receiver,
        uint256 _amount
    ) internal {
        // if withdraw amount is larger than the balance of given Amm's vault
        // means this trader's profit comes from other under collateral position's future loss
        // and the balance of given Amm's vault is not enough
        // need money from IInsuranceFund to pay first, and record this prepaidBadDebt
        // in this case, insurance fund loss must be zero
        uint256 vault = vaults[address(_amm)];
        IERC20 quoteToken = _amm.quoteAsset();
        if (vault < _amount) {
            uint256 balanceShortage = _amount - vault;
            prepaidBadDebts[address(_amm)] += balanceShortage;
            _withdrawFromInsuranceFund(_amm, balanceShortage);
        }
        vaults[address(_amm)] -= _amount;
        quoteToken.safeTransfer(_receiver, _amount);
    }

    function _realizeBadDebt(IAmm _amm, uint256 _badDebt) internal {
        uint256 badDebtBalance = prepaidBadDebts[address(_amm)];
        if (badDebtBalance >= _badDebt) {
            // no need to move extra tokens because vault already prepay bad debt, only need to update the numbers
            prepaidBadDebts[address(_amm)] = badDebtBalance - _badDebt;
        } else {
            // in order to realize all the bad debt vault need extra tokens from insuranceFund
            _withdrawFromInsuranceFund(_amm, _badDebt - badDebtBalance);
            prepaidBadDebts[address(_amm)] = 0;
        }
    }

    function _withdrawFromInsuranceFund(IAmm _amm, uint256 _amount) internal {
        IERC20 quoteToken = _amm.quoteAsset();
        vaults[address(_amm)] += _amount;
        insuranceFund.withdraw(quoteToken, _amount);
    }

    function _transferToInsuranceFund(IAmm _amm, uint256 _amount) internal {
        IERC20 quoteToken = _amm.quoteAsset();
        uint256 vault = vaults[address(_amm)];
        if (vault > _amount) {
            vaults[address(_amm)] = vault - _amount;
            quoteToken.safeTransfer(address(insuranceFund), _amount);
        } else {
            vaults[address(_amm)] = 0;
            quoteToken.safeTransfer(address(insuranceFund), vault);
        }
    }

    /**
     * @dev assume this will be removes soon once the guarded period has ended. caller need to ensure amm exist
     */
    function _updateOpenInterestNotional(IAmm _amm, int256 _amount) internal {
        // when cap = 0 means no cap
        uint256 cap = _amm.getOpenInterestNotionalCap();
        address ammAddr = address(_amm);
        if (cap > 0) {
            int256 updatedOpenInterestNotional = _amount + openInterestNotionalMap[ammAddr].toInt();
            // the reduced open interest can be larger than total when profit is too high and other position are bankrupt
            if (updatedOpenInterestNotional < 0) {
                updatedOpenInterestNotional = 0;
            }
            if (_amount > 0) {
                // whitelist won't be restrict by open interest cap
                require(updatedOpenInterestNotional.toUint() <= cap || _msgSender() == whitelist, "over limit");
            }
            openInterestNotionalMap[ammAddr] = updatedOpenInterestNotional.abs();
        }
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //

    function _calcRemainMarginWithFundingPayment(
        IAmm _amm,
        Position memory _oldPosition,
        int256 _marginDelta
    )
        internal
        view
        returns (
            uint256 remainMargin,
            uint256 badDebt,
            int256 fundingPayment,
            int256 latestCumulativePremiumFraction
        )
    {
        // calculate funding payment
        latestCumulativePremiumFraction = getLatestCumulativePremiumFraction(_amm);
        if (_oldPosition.size != 0) {
            fundingPayment = (latestCumulativePremiumFraction - _oldPosition.lastUpdatedCumulativePremiumFraction).mulD(_oldPosition.size);
        }

        // calculate remain margin
        int256 signedRemainMargin = _marginDelta - fundingPayment + _oldPosition.margin.toInt();

        // if remain margin is negative, set to zero and leave the rest to bad debt
        if (signedRemainMargin < 0) {
            badDebt = signedRemainMargin.abs();
        } else {
            remainMargin = signedRemainMargin.abs();
        }
    }

    /// @param _marginWithFundingPayment margin + funding payment - bad debt
    function _calcFreeCollateral(
        IAmm _amm,
        address _trader,
        uint256 _marginWithFundingPayment
    ) internal view returns (int256) {
        Position memory pos = getPosition(_amm, _trader);
        (int256 unrealizedPnl, uint256 positionNotional) = _getPreferencePositionNotionalAndUnrealizedPnl(
            _amm,
            _trader,
            PnlPreferenceOption.MIN_PNL
        );

        // min(margin + funding, margin + funding + unrealized PnL) - position value * initMarginRatio
        int256 accountValue = unrealizedPnl + _marginWithFundingPayment.toInt();
        int256 minCollateral = unrealizedPnl > 0 ? _marginWithFundingPayment.toInt() : accountValue;

        // margin requirement
        // if holding a long position, using open notional (mapping to quote debt in Curie)
        // if holding a short position, using position notional (mapping to base debt in Curie)
        int256 marginRequirement = pos.size > 0
            ? pos.openNotional.toInt().mulD(initMarginRatio.toInt())
            : positionNotional.toInt().mulD(initMarginRatio.toInt());

        return minCollateral - marginRequirement;
    }

    function _getPreferencePositionNotionalAndUnrealizedPnl(
        IAmm _amm,
        address _trader,
        PnlPreferenceOption _pnlPreference
    ) internal view returns (int256 unrealizedPnl, uint256 positionNotional) {
        (uint256 spotPositionNotional, int256 spotPricePnl) = (
            getPositionNotionalAndUnrealizedPnl(_amm, _trader, PnlCalcOption.SPOT_PRICE)
        );
        (uint256 twapPositionNotional, int256 twapPricePnl) = (getPositionNotionalAndUnrealizedPnl(_amm, _trader, PnlCalcOption.TWAP));

        // if MAX_PNL
        //    spotPnL >  twapPnL return (spotPnL, spotPositionNotional)
        //    spotPnL <= twapPnL return (twapPnL, twapPositionNotional)
        // if MIN_PNL
        //    spotPnL >  twapPnL return (twapPnL, twapPositionNotional)
        //    spotPnL <= twapPnL return (spotPnL, spotPositionNotional)
        (unrealizedPnl, positionNotional) = (_pnlPreference == PnlPreferenceOption.MAX_PNL) == (spotPricePnl > twapPricePnl)
            ? (spotPricePnl, spotPositionNotional)
            : (twapPricePnl, twapPositionNotional);
    }

    //
    // REQUIRE FUNCTIONS
    //
    function _requireAmm(IAmm _amm, bool _open) private view {
        require(insuranceFund.isExistedAmm(_amm), "amm not found");
        require(_open == _amm.open(), _open ? "amm was closed" : "amm is open");
    }

    function _requireNonZeroInput(uint256 _input) private pure {
        require(_input != 0, "input is 0");
    }

    function _requirePositionSize(int256 _size) private pure {
        require(_size != 0, "positionSize is 0");
    }

    function _requireNotRestrictionMode(IAmm _amm) private view {
        uint256 currentBlock = _blockNumber();
        if (currentBlock == ammMap[address(_amm)].lastRestrictionBlock) {
            require(getPosition(_amm, _msgSender()).blockNumber != currentBlock, "only one action allowed");
        }
    }

    function _requireMoreMarginRatio(
        int256 _marginRatio,
        uint256 _baseMarginRatio,
        bool _largerThanOrEqualTo
    ) private pure {
        int256 remainingMarginRatio = _marginRatio - _baseMarginRatio.toInt();
        require(_largerThanOrEqualTo ? remainingMarginRatio >= 0 : remainingMarginRatio < 0, "Margin ratio not meet criteria");
    }

    function _formulaicRepegAmm(IAmm _amm) private {
        uint256 budget = getAdjustmentPoolAmount(address(_amm));
        (bool isAdjustable, int256 cost, uint256 newQuoteAssetReserve, uint256 newBaseAssetReserve) = _amm.getFormulaicRepegResult(
            budget,
            true
        );
        if (isAdjustable && _applyCost(_amm, cost)) {
            _amm.adjust(newQuoteAssetReserve, newBaseAssetReserve);
            emit Repeg(address(_amm), newQuoteAssetReserve, newBaseAssetReserve, cost);
        }
    }

    // if fundingImbalance is positive, clearing house receives funds
    function _formulaicUpdateK(IAmm _amm, int256 _fundingImbalance) private {
        int256 netRevenue = netRevenuesSinceLastFunding[address(_amm)];
        int256 budget;
        if (_fundingImbalance > 0) {
            // positive cost is period revenue, give back half in k increase
            budget = _fundingImbalance / 2;
        } else if (netRevenue < -_fundingImbalance) {
            // cost exceeded period revenue, take back half in k decrease
            if (netRevenue < 0) {
                budget = _fundingImbalance / 2;
            } else {
                budget = (netRevenue + _fundingImbalance) / 2;
            }
        }
        (bool isAdjustable, int256 cost, uint256 newQuoteAssetReserve, uint256 newBaseAssetReserve) = _amm.getFormulaicUpdateKResult(
            budget
        );
        if (isAdjustable && _applyCost(_amm, cost)) {
            _amm.adjust(newQuoteAssetReserve, newBaseAssetReserve);
            emit UpdateK(address(_amm), newQuoteAssetReserve, newBaseAssetReserve, cost);
        }
    }

    /**
     * @notice apply cost for repeg and adjustment
     * @dev negative cost is revenue, otherwise is expense of insurance fund
     */
    function _applyCost(IAmm _amm, int256 _cost) private returns (bool) {
        uint256 totalMinusFee = totalMinusFees[address(_amm)];
        uint256 costAbs = _cost.abs();
        if (_cost > 0) {
            if (costAbs <= totalMinusFee) {
                totalMinusFees[address(_amm)] = totalMinusFee - costAbs;
                _withdrawFromInsuranceFund(_amm, costAbs);
            } else {
                return false;
            }
        } else {
            totalMinusFees[address(_amm)] = totalMinusFee + costAbs;
            _transferToInsuranceFund(_amm, costAbs);
        }
        netRevenuesSinceLastFunding[address(_amm)] = netRevenuesSinceLastFunding[address(_amm)] - _cost;
        return true;
    }
}
