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
import { FullMath } from "./utils/FullMath.sol";
import "hardhat/console.sol";

// note BaseRelayRecipient must come after OwnerPausableUpgradeSafe so its _msgSender() takes precedence
// (yes, the ordering is reversed comparing to Python)
contract ClearingHouse is OwnerPausableUpgradeSafe, ReentrancyGuardUpgradeable, BlockContext {
    using UIntMath for uint256;
    using IntMath for int256;

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
        // it's 0 when internalReducePosition, its addedMargin when internalIncreasePosition
        // it's min(0, oldPosition + realizedFundingPayment + realizedPnl) when internalClosePosition
        int256 marginToVault;
        // unrealized pnl after open position
        int256 unrealizedPnlAfter;
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

    mapping(address => uint256) private decimalMap;

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

    // prepaid bad debt balance, key by ERC20 token address
    mapping(address => uint256) internal prepaidBadDebt;

    // contract dependencies
    IInsuranceFund public insuranceFund;
    IMultiTokenRewardRecipient public feePool;

    // designed for arbitragers who can hold unlimited positions. will be removed after guarded period
    address internal whitelist;

    mapping(address => bool) public backstopLiquidityProviderMap;

    mapping(address => mapping(address => uint256)) public totalFees;

    // amm => token => revenue since last funding
    mapping(address => mapping(address => int256)) public netRevenuesSinceLastFunding;

    uint256[50] private __gap;

    //**********************************************************//
    //    Can not change the order of above state variables     //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    //

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
    function setTollPool(address _feePool) external onlyOwner {
        feePool = IMultiTokenRewardRecipient(_feePool);
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

    /**
     * @notice add margin to increase margin ratio
     * @param _amm IAmm address
     * @param _addedMargin added margin in 18 digits
     */
    function addMargin(IAmm _amm, uint256 _addedMargin) external whenNotPaused nonReentrant {
        // check condition
        requireAmm(_amm, true);
        IERC20 quoteToken = _amm.quoteAsset();
        requireValidTokenAmount(_addedMargin);

        address trader = _msgSender();
        Position memory position = getPosition(_amm, trader);
        // update margin
        position.margin = position.margin + _addedMargin;

        setPosition(_amm, trader, position);
        // transfer token from trader
        quoteToken.transferFrom(trader, address(this), _addedMargin);
        //_transferFrom(quoteToken, trader, address(this), _addedMargin);
        emit MarginChanged(trader, address(_amm), int256(_addedMargin), 0);
        formulaicRepegAmm(_amm);
    }

    /**
     * @notice remove margin to decrease margin ratio
     * @param _amm IAmm address
     * @param _removedMargin removed margin in 18 digits
     */
    function removeMargin(IAmm _amm, uint256 _removedMargin) external whenNotPaused nonReentrant {
        // check condition
        requireAmm(_amm, true);
        IERC20 quoteToken = _amm.quoteAsset();
        requireValidTokenAmount(_removedMargin);

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
        ) = calcRemainMarginWithFundingPayment(_amm, position, marginDelta);
        require(badDebt == 0, "margin is not enough");
        position.margin = remainMargin;
        position.lastUpdatedCumulativePremiumFraction = latestCumulativePremiumFraction;

        // check enough margin (same as the way Curie calculates the free collateral)
        // Use a more conservative way to restrict traders to remove their margin
        // We don't allow unrealized PnL to support their margin removal
        require(calcFreeCollateral(_amm, trader, remainMargin - badDebt) >= 0, "free collateral is not enough");

        setPosition(_amm, trader, position);

        // transfer token back to trader
        withdraw(quoteToken, trader, _removedMargin);
        emit MarginChanged(trader, address(_amm), marginDelta, fundingPayment);
        formulaicRepegAmm(_amm);
    }

    /**
     * @notice settle all the positions when amm is shutdown. The settlement price is according to IAmm.settlementPrice
     * @param _amm IAmm address
     */
    function settlePosition(IAmm _amm) external nonReentrant {
        // check condition
        requireAmm(_amm, false);
        address trader = _msgSender();
        Position memory pos = getPosition(_amm, trader);
        requirePositionSize(pos.size);
        // update position
        clearPosition(_amm, trader);
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
            _amm.quoteAsset().transfer(trader, settledValue);
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
    //   internalIncreasePosition(newMargin, leverage)
    // else if liquidate
    //   close()
    //   pay liquidation fee to liquidator
    //   move the remain margin to insuranceFund

    /**
     * @notice open a position
     * @param _amm amm address
     * @param _side enum Side; BUY for long and SELL for short
     * @param _quoteAssetAmount quote asset amount in 18 digits. Can Not be 0
     * @param _leverage leverage  in 18 digits. Can Not be 0
     * @param _baseAssetAmountLimit minimum base asset amount expected to get to prevent from slippage.
     */
    function openPosition(
        IAmm _amm,
        Side _side,
        uint256 _quoteAssetAmount,
        uint256 _leverage,
        uint256 _baseAssetAmountLimit
    ) public whenNotPaused nonReentrant {
        requireAmm(_amm, true);
        IERC20 quoteToken = _amm.quoteAsset();
        requireValidTokenAmount(_quoteAssetAmount);
        requireNonZeroInput(_leverage);
        requireMoreMarginRatio(int256(1 ether).divD(_leverage.toInt()), initMarginRatio, true);
        requireNotRestrictionMode(_amm);

        address trader = _msgSender();
        PositionResp memory positionResp;
        {
            // add scope for stack too deep error
            int256 oldPositionSize = getPosition(_amm, trader).size;
            bool isNewPosition = oldPositionSize == 0 ? true : false;

            // increase or decrease position depends on old position's side and size
            if (isNewPosition || (oldPositionSize > 0 ? Side.BUY : Side.SELL) == _side) {
                positionResp = internalIncreasePosition(_amm, _side, _quoteAssetAmount.mulD(_leverage), _baseAssetAmountLimit, _leverage);
            } else {
                positionResp = openReversePosition(_amm, _side, trader, _quoteAssetAmount, _leverage, _baseAssetAmountLimit, false);
            }

            // update the position state
            setPosition(_amm, trader, positionResp.position);
            // if opening the exact position size as the existing one == closePosition, can skip the margin ratio check
            if (!isNewPosition && positionResp.position.size != 0) {
                requireMoreMarginRatio(getMarginRatio(_amm, trader), maintenanceMarginRatio, true);
            }

            // to prevent attacker to leverage the bad debt to withdraw extra token from insurance fund
            require(positionResp.badDebt == 0, "bad debt");

            // transfer the actual token between trader and vault
            if (positionResp.marginToVault > 0) {
                quoteToken.transferFrom(trader, address(this), positionResp.marginToVault.abs());
                //_transferFrom(quoteToken, trader, address(this), positionResp.marginToVault.abs());
            } else if (positionResp.marginToVault < 0) {
                withdraw(quoteToken, trader, positionResp.marginToVault.abs());
            }
        }

        // calculate fee and transfer token for fees
        //@audit - can optimize by changing amm.swapInput/swapOutput's return type to (exchangedAmount, quoteToll, quoteSpread, quoteReserve, baseReserve) (@wraecca)
        uint256 transferredFee = transferFee(trader, _amm, positionResp.exchangedQuoteAssetAmount);

        // emit event
        uint256 spotPrice = _amm.getSpotPrice();
        int256 fundingPayment = positionResp.fundingPayment; // pre-fetch for stack too deep error
        emit PositionChanged(
            trader,
            address(_amm),
            positionResp.position.margin,
            positionResp.exchangedQuoteAssetAmount,
            positionResp.exchangedPositionSize,
            transferredFee,
            positionResp.position.size,
            positionResp.realizedPnl,
            positionResp.unrealizedPnlAfter,
            positionResp.badDebt,
            0,
            spotPrice,
            fundingPayment
        );
        formulaicRepegAmm(_amm);
    }

    /**
     * @notice close all the positions
     * @param _amm IAmm address
     */
    function closePosition(IAmm _amm, uint256 _quoteAssetAmountLimit) public whenNotPaused nonReentrant {
        // check conditions
        requireAmm(_amm, true);
        requireNotRestrictionMode(_amm);

        // update position
        address trader = _msgSender();

        PositionResp memory positionResp;
        {
            Position memory position = getPosition(_amm, trader);
            // if it is long position, close a position means short it(which means base dir is ADD_TO_AMM) and vice versa
            IAmm.Dir dirOfBase = position.size > 0 ? IAmm.Dir.ADD_TO_AMM : IAmm.Dir.REMOVE_FROM_AMM;

            // check if this position exceed fluctuation limit
            // if over fluctuation limit, then close partial position. Otherwise close all.
            // if partialLiquidationRatio is 1, then close whole position
            if (_amm.isOverFluctuationLimit(dirOfBase, position.size.abs()) && partialLiquidationRatio < 1 ether) {
                uint256 partiallyClosedPositionNotional = _amm.getOutputPrice(
                    dirOfBase,
                    position.size.mulD(partialLiquidationRatio.toInt()).abs()
                );

                positionResp = openReversePosition(
                    _amm,
                    position.size > 0 ? Side.SELL : Side.BUY,
                    trader,
                    partiallyClosedPositionNotional,
                    1 ether,
                    0,
                    true
                );
                setPosition(_amm, trader, positionResp.position);
            } else {
                positionResp = internalClosePosition(_amm, trader, _quoteAssetAmountLimit);
            }

            // to prevent attacker to leverage the bad debt to withdraw extra token from insurance fund
            require(positionResp.badDebt == 0, "bad debt");

            // add scope for stack too deep error
            // transfer the actual token from trader and vault
            IERC20 quoteToken = _amm.quoteAsset();
            withdraw(quoteToken, trader, positionResp.marginToVault.abs());
        }

        // calculate fee and transfer token for fees
        uint256 transferredFee = transferFee(trader, _amm, positionResp.exchangedQuoteAssetAmount);

        // prepare event
        uint256 spotPrice = _amm.getSpotPrice();
        int256 fundingPayment = positionResp.fundingPayment;
        emit PositionChanged(
            trader,
            address(_amm),
            positionResp.position.margin,
            positionResp.exchangedQuoteAssetAmount,
            positionResp.exchangedPositionSize,
            transferredFee,
            positionResp.position.size,
            positionResp.realizedPnl,
            positionResp.unrealizedPnlAfter,
            positionResp.badDebt,
            0,
            spotPrice,
            fundingPayment
        );
        formulaicRepegAmm(_amm);
    }

    function liquidateWithSlippage(
        IAmm _amm,
        address _trader,
        uint256 _quoteAssetAmountLimit
    ) external nonReentrant returns (uint256 quoteAssetAmount, bool isPartialClose) {
        Position memory position = getPosition(_amm, _trader);
        (quoteAssetAmount, isPartialClose) = internalLiquidate(_amm, _trader);

        uint256 quoteAssetAmountLimit = isPartialClose ? _quoteAssetAmountLimit.mulD(partialLiquidationRatio) : _quoteAssetAmountLimit;

        if (position.size > 0) {
            require(quoteAssetAmount >= quoteAssetAmountLimit, "Less than minimal quote token");
        } else if (position.size < 0 && quoteAssetAmountLimit != 0) {
            require(quoteAssetAmount <= quoteAssetAmountLimit, "More than maximal quote token");
        }
        formulaicRepegAmm(_amm);

        return (quoteAssetAmount, isPartialClose);
    }

    /**
     * @notice liquidate trader's underwater position. Require trader's margin ratio less than maintenance margin ratio
     * @dev liquidator can NOT open any positions in the same block to prevent from price manipulation.
     * @param _amm IAmm address
     * @param _trader trader address
     */
    function liquidate(IAmm _amm, address _trader) public nonReentrant {
        internalLiquidate(_amm, _trader);
        formulaicRepegAmm(_amm);
    }

    /**
     * @notice if funding rate is positive, traders with long position pay traders with short position and vice versa.
     * @param _amm IAmm address
     */
    function payFunding(IAmm _amm) external {
        requireAmm(_amm, true);

        int256 premiumFraction = _amm.settleFunding();
        ammMap[address(_amm)].cumulativePremiumFractions.push(premiumFraction + getLatestCumulativePremiumFraction(_amm));

        // funding payment = premium fraction * position
        // eg. if alice takes 10 long position, totalPositionSize = 10
        // if premiumFraction is positive: long pay short, amm get positive funding payment
        // if premiumFraction is negative: short pay long, amm get negative funding payment
        // if totalPositionSize.side * premiumFraction > 0, funding payment is positive which means profit
        int256 totalTraderPositionSize = _amm.getBaseAssetDelta();
        int256 ammFundingPaymentProfit = premiumFraction.mulD(totalTraderPositionSize);
        IERC20 quoteAsset = _amm.quoteAsset();
        if (ammFundingPaymentProfit < 0) {
            //TODO capped funding
            insuranceFund.withdraw(quoteAsset, ammFundingPaymentProfit.abs());
        } else {
            transferToInsuranceFund(quoteAsset, ammFundingPaymentProfit.abs());
        }
        formulaicUpdateK(_amm, ammFundingPaymentProfit);
        netRevenuesSinceLastFunding[address(_amm)][address(quoteAsset)] = 0;
    }

    //
    // VIEW FUNCTIONS
    //

    /**
     * @notice get margin ratio, marginRatio = (margin + funding payment + unrealized Pnl) / positionNotional
     * use spot and twap price to calculate unrealized Pnl, final unrealized Pnl depends on which one is higher
     * @param _amm IAmm address
     * @param _trader trader address
     * @return margin ratio in 18 digits
     */
    function getMarginRatio(IAmm _amm, address _trader) public view returns (int256) {
        Position memory position = getPosition(_amm, _trader);
        requirePositionSize(position.size);
        (int256 unrealizedPnl, uint256 positionNotional) = getPreferencePositionNotionalAndUnrealizedPnl(
            _amm,
            _trader,
            PnlPreferenceOption.MAX_PNL
        );
        return _getMarginRatio(_amm, position, unrealizedPnl, positionNotional);
    }

    function _getMarginRatioByCalcOption(
        IAmm _amm,
        address _trader,
        PnlCalcOption _pnlCalcOption
    ) internal view returns (int256) {
        Position memory position = getPosition(_amm, _trader);
        requirePositionSize(position.size);
        (uint256 positionNotional, int256 pnl) = getPositionNotionalAndUnrealizedPnl(_amm, _trader, _pnlCalcOption);
        return _getMarginRatio(_amm, position, pnl, positionNotional);
    }

    function _getMarginRatio(
        IAmm _amm,
        Position memory _position,
        int256 _unrealizedPnl,
        uint256 _positionNotional
    ) internal view returns (int256) {
        (uint256 remainMargin, uint256 badDebt, , ) = calcRemainMarginWithFundingPayment(_amm, _position, _unrealizedPnl);
        return (remainMargin.toInt() - badDebt.toInt()).divD(_positionNotional.toInt());
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

    //
    // INTERNAL FUNCTIONS
    //

    function enterRestrictionMode(IAmm _amm) internal {
        uint256 blockNumber = _blockNumber();
        ammMap[address(_amm)].lastRestrictionBlock = blockNumber;
        emit RestrictionModeEntered(address(_amm), blockNumber);
    }

    function setPosition(
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

    function clearPosition(IAmm _amm, address _trader) internal {
        // keep the record in order to retain the last updated block number
        ammMap[address(_amm)].positionMap[_trader] = Position({
            size: 0,
            margin: 0,
            openNotional: 0,
            lastUpdatedCumulativePremiumFraction: 0,
            blockNumber: _blockNumber(),
            liquidityHistoryIndex: 0
        });
    }

    function internalLiquidate(IAmm _amm, address _trader) internal returns (uint256 quoteAssetAmount, bool isPartialClose) {
        requireAmm(_amm, true);
        int256 marginRatio = getMarginRatio(_amm, _trader);

        // including oracle-based margin ratio as reference price when amm is over spread limit
        if (_amm.isOverSpreadLimit()) {
            int256 marginRatioBasedOnOracle = _getMarginRatioByCalcOption(_amm, _trader, PnlCalcOption.ORACLE);
            if (marginRatioBasedOnOracle - marginRatio > 0) {
                marginRatio = marginRatioBasedOnOracle;
            }
        }
        requireMoreMarginRatio(marginRatio, maintenanceMarginRatio, false);

        PositionResp memory positionResp;
        uint256 liquidationPenalty;
        {
            uint256 liquidationBadDebt;
            uint256 feeToLiquidator;
            uint256 feeToInsuranceFund;
            IERC20 quoteAsset = _amm.quoteAsset();

            int256 marginRatioBasedOnSpot = _getMarginRatioByCalcOption(_amm, _trader, PnlCalcOption.SPOT_PRICE);
            if (
                // check margin(based on spot price) is enough to pay the liquidation fee
                // after partially close, otherwise we fully close the position.
                // that also means we can ensure no bad debt happen when partially liquidate
                marginRatioBasedOnSpot > int256(liquidationFeeRatio) && partialLiquidationRatio < 1 ether && partialLiquidationRatio != 0
            ) {
                Position memory position = getPosition(_amm, _trader);
                uint256 partiallyLiquidatedPositionNotional = _amm.getOutputPrice(
                    position.size > 0 ? IAmm.Dir.ADD_TO_AMM : IAmm.Dir.REMOVE_FROM_AMM,
                    position.size.mulD(partialLiquidationRatio.toInt()).abs()
                );

                positionResp = openReversePosition(
                    _amm,
                    position.size > 0 ? Side.SELL : Side.BUY,
                    _trader,
                    partiallyLiquidatedPositionNotional,
                    1 ether,
                    0,
                    true
                );

                // half of the liquidationFee goes to liquidator & another half goes to insurance fund
                liquidationPenalty = positionResp.exchangedQuoteAssetAmount.mulD(liquidationFeeRatio);
                feeToLiquidator = liquidationPenalty / 2;
                feeToInsuranceFund = liquidationPenalty - feeToLiquidator;

                positionResp.position.margin = positionResp.position.margin - liquidationPenalty;
                setPosition(_amm, _trader, positionResp.position);

                isPartialClose = true;
            } else {
                liquidationPenalty = getPosition(_amm, _trader).margin;
                positionResp = internalClosePosition(_amm, _trader, 0);
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
                    realizeBadDebt(quoteAsset, totalBadDebt);
                }
                if (remainMargin > 0) {
                    feeToInsuranceFund = remainMargin;
                }
            }

            if (feeToInsuranceFund > 0) {
                transferToInsuranceFund(quoteAsset, feeToInsuranceFund);
            }
            withdraw(quoteAsset, _msgSender(), feeToLiquidator);
            enterRestrictionMode(_amm);

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
        int256 fundingPayment = positionResp.fundingPayment;
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
            fundingPayment
        );

        return (positionResp.exchangedQuoteAssetAmount, isPartialClose);
    }

    // only called from openPosition and closeAndOpenReversePosition. caller need to ensure there's enough marginRatio
    function internalIncreasePosition(
        IAmm _amm,
        Side _side,
        uint256 _openNotional,
        uint256 _minPositionSize,
        uint256 _leverage
    ) internal returns (PositionResp memory positionResp) {
        address trader = _msgSender();
        Position memory oldPosition = getPosition(_amm, trader);
        positionResp.exchangedPositionSize = swapInput(_amm, _side, _openNotional, _minPositionSize, false);
        int256 newSize = oldPosition.size + positionResp.exchangedPositionSize;

        updateOpenInterestNotional(_amm, _openNotional.toInt());
        // if the trader is not in the whitelist, check max position size
        if (trader != whitelist) {
            uint256 maxHoldingBaseAsset = _amm.getMaxHoldingBaseAsset();
            if (maxHoldingBaseAsset > 0) {
                // total position size should be less than `positionUpperBound`
                require(newSize.abs() <= maxHoldingBaseAsset, "hit position size upper bound"); //hit position size upper bound
            }
        }

        int256 increaseMarginRequirement = _openNotional.divD(_leverage).toInt();
        (
            uint256 remainMargin, // the 2nd return (bad debt) must be 0 - already checked from caller
            ,
            int256 fundingPayment,
            int256 latestCumulativePremiumFraction
        ) = calcRemainMarginWithFundingPayment(_amm, oldPosition, increaseMarginRequirement);

        (, int256 unrealizedPnl) = getPositionNotionalAndUnrealizedPnl(_amm, trader, PnlCalcOption.SPOT_PRICE);

        // update positionResp
        positionResp.exchangedQuoteAssetAmount = _openNotional;
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

    function openReversePosition(
        IAmm _amm,
        Side _side,
        address _trader,
        uint256 _quoteAssetAmount,
        uint256 _leverage,
        uint256 _baseAssetAmountLimit,
        bool _canOverFluctuationLimit
    ) internal returns (PositionResp memory) {
        uint256 openNotional = _quoteAssetAmount.mulD(_leverage);
        (uint256 oldPositionNotional, int256 unrealizedPnl) = getPositionNotionalAndUnrealizedPnl(_amm, _trader, PnlCalcOption.SPOT_PRICE);
        PositionResp memory positionResp;

        // reduce position if old position is larger
        if (oldPositionNotional > openNotional) {
            updateOpenInterestNotional(_amm, openNotional.toInt() * -1);
            Position memory oldPosition = getPosition(_amm, _trader);
            positionResp.exchangedPositionSize = swapInput(_amm, _side, openNotional, _baseAssetAmountLimit, _canOverFluctuationLimit);

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
            ) = calcRemainMarginWithFundingPayment(_amm, oldPosition, positionResp.realizedPnl);

            // positionResp.unrealizedPnlAfter = unrealizedPnl - realizedPnl
            positionResp.unrealizedPnlAfter = unrealizedPnl - positionResp.realizedPnl;
            positionResp.exchangedQuoteAssetAmount = openNotional;

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

        return closeAndOpenReversePosition(_amm, _side, _trader, _quoteAssetAmount, _leverage, _baseAssetAmountLimit);
    }

    function closeAndOpenReversePosition(
        IAmm _amm,
        Side _side,
        address _trader,
        uint256 _quoteAssetAmount,
        uint256 _leverage,
        uint256 _baseAssetAmountLimit
    ) internal returns (PositionResp memory positionResp) {
        // new position size is larger than or equal to the old position size
        // so either close or close then open a larger position
        PositionResp memory closePositionResp = internalClosePosition(_amm, _trader, 0);

        // the old position is underwater. trader should close a position first
        require(closePositionResp.badDebt == 0, "reduce an underwater position");

        // update open notional after closing position
        uint256 openNotional = _quoteAssetAmount.mulD(_leverage) - closePositionResp.exchangedQuoteAssetAmount;

        // if remain exchangedQuoteAssetAmount is too small (eg. 1wei) then the required margin might be 0
        // then the clearingHouse will stop opening position
        if (openNotional.divD(_leverage) == 0) {
            positionResp = closePositionResp;
        } else {
            uint256 updatedBaseAssetAmountLimit;
            if (_baseAssetAmountLimit > closePositionResp.exchangedPositionSize.toUint()) {
                updatedBaseAssetAmountLimit = _baseAssetAmountLimit - closePositionResp.exchangedPositionSize.abs();
            }

            PositionResp memory increasePositionResp = internalIncreasePosition(
                _amm,
                _side,
                openNotional,
                updatedBaseAssetAmountLimit,
                _leverage
            );
            positionResp = PositionResp({
                position: increasePositionResp.position,
                exchangedQuoteAssetAmount: closePositionResp.exchangedQuoteAssetAmount + increasePositionResp.exchangedQuoteAssetAmount,
                badDebt: closePositionResp.badDebt + increasePositionResp.badDebt,
                fundingPayment: closePositionResp.fundingPayment + increasePositionResp.fundingPayment,
                exchangedPositionSize: closePositionResp.exchangedPositionSize + increasePositionResp.exchangedPositionSize,
                realizedPnl: closePositionResp.realizedPnl + increasePositionResp.realizedPnl,
                unrealizedPnlAfter: 0,
                marginToVault: closePositionResp.marginToVault + increasePositionResp.marginToVault
            });
        }
        return positionResp;
    }

    function internalClosePosition(
        IAmm _amm,
        address _trader,
        uint256 _quoteAssetAmountLimit
    ) private returns (PositionResp memory positionResp) {
        // check conditions
        Position memory oldPosition = getPosition(_amm, _trader);
        requirePositionSize(oldPosition.size);

        (, int256 unrealizedPnl) = getPositionNotionalAndUnrealizedPnl(_amm, _trader, PnlCalcOption.SPOT_PRICE);
        (uint256 remainMargin, uint256 badDebt, int256 fundingPayment, ) = calcRemainMarginWithFundingPayment(
            _amm,
            oldPosition,
            unrealizedPnl
        );

        positionResp.exchangedPositionSize = oldPosition.size * -1;
        positionResp.realizedPnl = unrealizedPnl;
        positionResp.badDebt = badDebt;
        positionResp.fundingPayment = fundingPayment;
        positionResp.marginToVault = remainMargin.toInt() * -1;
        // for amm.swapOutput, the direction is in base asset, from the perspective of Amm
        positionResp.exchangedQuoteAssetAmount = _amm.swapOutput(
            oldPosition.size > 0 ? IAmm.Dir.ADD_TO_AMM : IAmm.Dir.REMOVE_FROM_AMM,
            oldPosition.size.abs(),
            _quoteAssetAmountLimit
        );

        // bankrupt position's bad debt will be also consider as a part of the open interest
        updateOpenInterestNotional(_amm, (unrealizedPnl + badDebt.toInt() + oldPosition.openNotional.toInt()) * -1);
        clearPosition(_amm, _trader);
    }

    function swapInput(
        IAmm _amm,
        Side _side,
        uint256 _inputAmount,
        uint256 _minOutputAmount,
        bool _canOverFluctuationLimit
    ) internal returns (int256) {
        // for amm.swapInput, the direction is in quote asset, from the perspective of Amm
        IAmm.Dir dir = (_side == Side.BUY) ? IAmm.Dir.ADD_TO_AMM : IAmm.Dir.REMOVE_FROM_AMM;
        int256 outputAmount = _amm.swapInput(dir, _inputAmount, _minOutputAmount, _canOverFluctuationLimit).toInt();
        if (IAmm.Dir.REMOVE_FROM_AMM == dir) {
            return outputAmount * -1;
        }
        return outputAmount;
    }

    function transferFee(
        address _from,
        IAmm _amm,
        uint256 _positionNotional
    ) internal returns (uint256 fee) {
        // the logic of toll fee can be removed if the bytecode size is too large
        (uint256 toll, uint256 spread) = _amm.calcFee(_positionNotional);
        bool hasToll = toll > 0;
        bool hasSpread = spread > 0;
        if (hasToll || hasSpread) {
            IERC20 quoteAsset = _amm.quoteAsset();

            // transfer spread to market in order to use it to make market better
            if (hasSpread) {
                quoteAsset.transferFrom(_from, address(insuranceFund), spread);
                totalFees[address(_amm)][address(quoteAsset)] += spread;
                netRevenuesSinceLastFunding[address(_amm)][address(quoteAsset)] += spread.toInt();
                //_transferFrom(quoteAsset, _from, address(insuranceFund), spread);
            }

            // transfer toll to feePool
            if (hasToll) {
                require(address(feePool) != address(0), "Invalid"); //Invalid feePool
                quoteAsset.transferFrom(_from, address(feePool), toll);
                //_transferFrom(quoteAsset, _from, address(feePool), toll);
            }

            fee = toll + spread;
        }
    }

    function withdraw(
        IERC20 _token,
        address _receiver,
        uint256 _amount
    ) internal {
        // if withdraw amount is larger than entire balance of vault
        // means this trader's profit comes from other under collateral position's future loss
        // and the balance of entire vault is not enough
        // need money from IInsuranceFund to pay first, and record this prepaidBadDebt
        // in this case, insurance fund loss must be zero
        uint256 totalTokenBalance = _token.balanceOf(address(this)); // _balanceOf(_token, address(this));
        if (totalTokenBalance < _amount) {
            uint256 balanceShortage = _amount - totalTokenBalance;
            prepaidBadDebt[address(_token)] = prepaidBadDebt[address(_token)] + balanceShortage;
            insuranceFund.withdraw(_token, balanceShortage);
        }
        _token.transfer(_receiver, _amount);
        //_transfer(_token, _receiver, _amount);
    }

    function realizeBadDebt(IERC20 _token, uint256 _badDebt) internal {
        uint256 badDebtBalance = prepaidBadDebt[address(_token)];
        if (badDebtBalance > _badDebt) {
            // no need to move extra tokens because vault already prepay bad debt, only need to update the numbers
            prepaidBadDebt[address(_token)] = badDebtBalance - _badDebt;
        } else {
            // in order to realize all the bad debt vault need extra tokens from insuranceFund
            insuranceFund.withdraw(_token, _badDebt - badDebtBalance);
            prepaidBadDebt[address(_token)] = 0;
        }
    }

    function transferToInsuranceFund(IERC20 _token, uint256 _amount) internal {
        uint256 totalTokenBalance = _token.balanceOf(address(this)); // _balanceOf(_token, address(this));
        _token.transfer(address(insuranceFund), totalTokenBalance < _amount ? totalTokenBalance : _amount);
        //_transfer(_token, address(insuranceFund), totalTokenBalance < _amount ? totalTokenBalance : _amount);
    }

    /**
     * @dev assume this will be removes soon once the guarded period has ended. caller need to ensure amm exist
     */
    function updateOpenInterestNotional(IAmm _amm, int256 _amount) internal {
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

    function calcRemainMarginWithFundingPayment(
        IAmm _amm,
        Position memory _oldPosition,
        int256 _marginDelta
    )
        private
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
    function calcFreeCollateral(
        IAmm _amm,
        address _trader,
        uint256 _marginWithFundingPayment
    ) internal view returns (int256) {
        Position memory pos = getPosition(_amm, _trader);
        (int256 unrealizedPnl, uint256 positionNotional) = getPreferencePositionNotionalAndUnrealizedPnl(
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

    function getPreferencePositionNotionalAndUnrealizedPnl(
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

    function getUnadjustedPosition(IAmm _amm, address _trader) public view returns (Position memory position) {
        position = ammMap[address(_amm)].positionMap[_trader];
    }

    // function _msgSender() internal view override(BaseRelayRecipient, ContextUpgradeSafe) returns (address payable) {
    //     return super._msgSender();
    // }

    // function _msgData() internal view override(BaseRelayRecipient, ContextUpgradeSafe) returns (bytes memory ret) {
    //     return super._msgData();
    // }

    //
    // REQUIRE FUNCTIONS
    //
    function requireAmm(IAmm _amm, bool _open) private view {
        require(insuranceFund.isExistedAmm(_amm), "amm not found");
        require(_open == _amm.open(), _open ? "amm was closed" : "amm is open");
    }

    function requireNonZeroInput(uint256 _decimal) private pure {
        require(_decimal != 0, "input is 0");
    }

    function requirePositionSize(int256 _size) private pure {
        require(_size != 0, "positionSize is 0");
    }

    function requireValidTokenAmount(uint256 _decimal) private pure {
        require(_decimal != 0, "invalid token amount");
    }

    function requireNotRestrictionMode(IAmm _amm) private view {
        uint256 currentBlock = _blockNumber();
        if (currentBlock == ammMap[address(_amm)].lastRestrictionBlock) {
            require(getPosition(_amm, _msgSender()).blockNumber != currentBlock, "only one action allowed");
        }
    }

    function requireMoreMarginRatio(
        int256 _marginRatio,
        uint256 _baseMarginRatio,
        bool _largerThanOrEqualTo
    ) private pure {
        int256 remainingMarginRatio = _marginRatio - _baseMarginRatio.toInt();
        require(_largerThanOrEqualTo ? remainingMarginRatio >= 0 : remainingMarginRatio < 0, "Margin ratio not meet criteria");
    }

    function formulaicRepegAmm(IAmm _amm) private {
        address quote = address(_amm.quoteAsset());
        // Only a portion of the protocol fees are allocated to repegging
        uint256 budget = totalFees[address(_amm)][quote] / 2;
        (bool isAdjustable, int256 cost, uint256 newQuoteAssetReserve, uint256 newBaseAssetReserve) = _amm.getFormulaicRepegResult(
            budget,
            true
        );
        if (isAdjustable && applyCost(address(_amm), quote, cost)) {
            _amm.adjust(newQuoteAssetReserve, newBaseAssetReserve);
            emit Repeg(address(_amm), newQuoteAssetReserve, newBaseAssetReserve, cost);
        }
    }

    // fundingImbalance is positive, clearing house receives funds
    function formulaicUpdateK(IAmm _amm, int256 fundingImbalance) private {
        address quote = address(_amm.quoteAsset());
        int256 netRevenue = netRevenuesSinceLastFunding[address(_amm)][quote];
        int256 budget;
        if (fundingImbalance > 0) {
            // positive cost is period revenue, give back half in k increase
            budget = fundingImbalance / 2;
        } else if (netRevenue < -fundingImbalance) {
            // cost exceeded period revenue, take back half in k decrease
            if (netRevenue < 0) {
                budget = fundingImbalance / 2;
            } else {
                budget = (netRevenue + fundingImbalance) / 2;
            }
        }
        (bool isAdjustable, int256 cost, uint256 newQuoteAssetReserve, uint256 newBaseAssetReserve) = _amm.getFormulaicUpdateKResult(
            budget
        );
        if (isAdjustable && applyCost(address(_amm), quote, cost)) {
            _amm.adjust(newQuoteAssetReserve, newBaseAssetReserve);
            emit UpdateK(address(_amm), newQuoteAssetReserve, newBaseAssetReserve, cost);
        }
    }

    function applyCost(
        address _amm,
        address _quote,
        int256 _cost
    ) private returns (bool) {
        uint256 totalFee = totalFees[_amm][_quote];
        uint256 cost = _cost.abs();
        // positive cost is expense, negative cost is revenue
        if (_cost > 0) {
            if (cost <= totalFee) {
                totalFees[_amm][_quote] = totalFee - cost;
            } else {
                totalFees[_amm][_quote] = 0;
                insuranceFund.withdraw(IERC20(_quote), cost - totalFee);
            }
            netRevenuesSinceLastFunding[_amm][_quote] = netRevenuesSinceLastFunding[_amm][_quote] - _cost;
        } else {
            // increase the totalFees
            totalFees[_amm][_quote] = totalFee + cost;
            netRevenuesSinceLastFunding[_amm][_quote] = netRevenuesSinceLastFunding[_amm][_quote] + cost.toInt();
        }
        return true;
    }
}
