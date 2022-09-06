// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { BlockContext } from "./utils/BlockContext.sol";
import { IPriceFeed } from "./interfaces/IPriceFeed.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { IAmm } from "./interfaces/IAmm.sol";
import { IntMath } from "./utils/IntMath.sol";
import { UIntMath } from "./utils/UIntMath.sol";
import { FullMath } from "./utils/FullMath.sol";
import { AmmMath } from "./utils/AmmMath.sol";

contract Amm is IAmm, OwnableUpgradeable, BlockContext {
    using UIntMath for uint256;
    using IntMath for int256;

    //
    // CONSTANT
    //
    // because position decimal rounding error,
    // if the position size is less than IGNORABLE_DIGIT_FOR_SHUTDOWN, it's equal size is 0
    uint256 private constant IGNORABLE_DIGIT_FOR_SHUTDOWN = 100;

    // a margin to prevent from rounding when calc liquidity multiplier limit
    uint256 private constant MARGIN_FOR_LIQUIDITY_MIGRATION_ROUNDING = 1e9;

    //
    // EVENTS
    //
    event SwapInput(Dir dir, uint256 quoteAssetAmount, uint256 baseAssetAmount);
    event SwapOutput(Dir dir, uint256 quoteAssetAmount, uint256 baseAssetAmount);
    event FundingRateUpdated(int256 rate, uint256 underlyingPrice);
    event ReserveSnapshotted(uint256 quoteAssetReserve, uint256 baseAssetReserve, uint256 timestamp);
    event LiquidityChanged(uint256 quoteReserve, uint256 baseReserve, int256 cumulativeNotional);
    event CapChanged(uint256 maxHoldingBaseAsset, uint256 openInterestNotionalCap);
    event Shutdown(uint256 settlementPrice);
    event PriceFeedUpdated(address priceFeed);
    event ReservesAdjusted(uint256 quoteAssetReserve, uint256 baseAssetReserve);

    //
    // MODIFIERS
    //
    modifier onlyOpen() {
        require(open, "amm was closed");
        _;
    }

    modifier onlyCounterParty() {
        require(counterParty == _msgSender(), "caller is not counterParty");
        _;
    }

    //
    // enum and struct
    //
    struct ReserveSnapshot {
        uint256 quoteAssetReserve;
        uint256 baseAssetReserve;
        uint256 timestamp;
        uint256 blockNumber;
    }

    // internal usage
    enum QuoteAssetDir {
        QUOTE_IN,
        QUOTE_OUT
    }
    // internal usage
    enum TwapCalcOption {
        RESERVE_ASSET,
        INPUT_ASSET
    }

    // To record current base/quote asset to calculate TWAP

    struct TwapInputAsset {
        Dir dir;
        uint256 assetAmount;
        QuoteAssetDir inOrOut;
    }

    struct TwapPriceCalcParams {
        TwapCalcOption opt;
        uint256 snapshotIndex;
        TwapInputAsset asset;
    }

    //
    // Constant
    //
    // 10%
    uint256 public constant MAX_ORACLE_SPREAD_RATIO = 1e17;

    //**********************************************************//
    //    The below state variables can not change the order    //
    //**********************************************************//

    // // DEPRECATED
    // // update during every swap and calculate total amm pnl per funding period
    // int256 private baseAssetDeltaThisFundingPeriod;

    // update during every swap and used when shutting amm down. it's trader's total base asset size
    int256 public totalPositionSize;

    // latest funding rate = ((twap market price - twap oracle price) / twap oracle price) / 24
    int256 public fundingRate;

    int256 private cumulativeNotional;

    uint256 private settlementPrice;
    uint256 public tradeLimitRatio;
    uint256 public quoteAssetReserve;
    uint256 public baseAssetReserve;
    uint256 public fluctuationLimitRatio;

    // owner can update
    uint256 public tollRatio;
    uint256 public spreadRatio;
    uint256 private maxHoldingBaseAsset;
    uint256 private openInterestNotionalCap;

    // snapshot of amm reserve when change liquidity's invariant
    LiquidityChangedSnapshot[] private liquidityChangedSnapshots;

    uint256 public spotPriceTwapInterval;
    uint256 public fundingPeriod;
    uint256 public fundingBufferPeriod;
    uint256 public nextFundingTime;
    bytes32 public priceFeedKey;
    ReserveSnapshot[] public reserveSnapshots;

    address private counterParty;
    address public globalShutdown;
    IERC20 public override quoteAsset;
    IPriceFeed public priceFeed;
    bool public override open;
    bool public override adjustable;
    bool public canLowerK;
    uint256[50] private __gap;

    //**********************************************************//
    //    The above state variables can not change the order    //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//

    //
    // FUNCTIONS
    //
    function initialize(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        uint256 _tradeLimitRatio,
        uint256 _fundingPeriod,
        IPriceFeed _priceFeed,
        bytes32 _priceFeedKey,
        address _quoteAsset,
        uint256 _fluctuationLimitRatio,
        uint256 _tollRatio,
        uint256 _spreadRatio
    ) public initializer {
        require(
            _quoteAssetReserve != 0 &&
                _tradeLimitRatio != 0 &&
                _baseAssetReserve != 0 &&
                _fundingPeriod != 0 &&
                address(_priceFeed) != address(0) &&
                _quoteAsset != address(0),
            "invalid input"
        );
        __Ownable_init();

        quoteAssetReserve = _quoteAssetReserve;
        baseAssetReserve = _baseAssetReserve;
        tradeLimitRatio = _tradeLimitRatio;
        tollRatio = _tollRatio;
        spreadRatio = _spreadRatio;
        fluctuationLimitRatio = _fluctuationLimitRatio;
        fundingPeriod = _fundingPeriod;
        fundingBufferPeriod = _fundingPeriod / 2;
        spotPriceTwapInterval = 1 hours;
        priceFeedKey = _priceFeedKey;
        quoteAsset = IERC20(_quoteAsset);
        priceFeed = _priceFeed;
        liquidityChangedSnapshots.push(
            LiquidityChangedSnapshot({
                cumulativeNotional: 0,
                baseAssetReserve: baseAssetReserve,
                quoteAssetReserve: quoteAssetReserve,
                totalPositionSize: 0
            })
        );
        reserveSnapshots.push(ReserveSnapshot(quoteAssetReserve, baseAssetReserve, _blockTimestamp(), _blockNumber()));
        emit ReserveSnapshotted(quoteAssetReserve, baseAssetReserve, _blockTimestamp());
    }

    /**
     * @notice Swap your quote asset to base asset,
     * @dev Only clearingHouse can call this function
     * @param _dirOfQuote ADD_TO_AMM for long, REMOVE_FROM_AMM for short
     * @param _quoteAssetAmount quote asset amount
     * @param _canOverFluctuationLimit if true, the impact of the price MUST be less than `fluctuationLimitRatio`
     * @return base asset amount
     */
    function swapInput(
        Dir _dirOfQuote,
        uint256 _quoteAssetAmount,
        bool _canOverFluctuationLimit
    ) external override onlyOpen onlyCounterParty returns (uint256) {
        if (_quoteAssetAmount == 0) {
            return 0;
        }
        if (_dirOfQuote == Dir.REMOVE_FROM_AMM) {
            require(quoteAssetReserve.mulD(tradeLimitRatio) >= _quoteAssetAmount, "over trading limit");
        }

        uint256 baseAssetAmount = getInputPrice(_dirOfQuote, _quoteAssetAmount);
        // // If LONG, exchanged base amount should be more than _baseAssetAmountLimit,
        // // otherwise(SHORT), exchanged base amount should be less than _baseAssetAmountLimit.
        // // In SHORT case, more position means more debt so should not be larger than _baseAssetAmountLimit
        // if (_baseAssetAmountLimit != 0) {
        //     if (_dirOfQuote == Dir.ADD_TO_AMM) {
        //         require(baseAssetAmount >= _baseAssetAmountLimit, "Less than minimal base token");
        //     } else {
        //         require(baseAssetAmount <= _baseAssetAmountLimit, "More than maximal base token");
        //     }
        // }

        _updateReserve(_dirOfQuote, _quoteAssetAmount, baseAssetAmount, _canOverFluctuationLimit);
        emit SwapInput(_dirOfQuote, _quoteAssetAmount, baseAssetAmount);
        return baseAssetAmount;
    }

    /**
     * @notice swap your base asset to quote asset
     * @dev only clearingHouse can call this function
     * @param _dirOfBase ADD_TO_AMM for short, REMOVE_FROM_AMM for long, opposite direction from swapInput
     * @param _baseAssetAmount base asset amount
     * @param _canOverFluctuationLimit if true, the impact of the price MUST be less than `fluctuationLimitRatio`
     * @return quote asset amount
     */
    function swapOutput(
        Dir _dirOfBase,
        uint256 _baseAssetAmount,
        bool _canOverFluctuationLimit
    ) external override onlyOpen onlyCounterParty returns (uint256) {
        if (_baseAssetAmount == 0) {
            return 0;
        }
        if (_dirOfBase == Dir.REMOVE_FROM_AMM) {
            require(baseAssetReserve.mulD(tradeLimitRatio) >= _baseAssetAmount, "over trading limit");
        }

        uint256 quoteAssetAmount = getOutputPrice(_dirOfBase, _baseAssetAmount);
        Dir dirOfQuote = _dirOfBase == Dir.ADD_TO_AMM ? Dir.REMOVE_FROM_AMM : Dir.ADD_TO_AMM;
        // // If SHORT, exchanged quote amount should be less than _quoteAssetAmountLimit,
        // // otherwise(LONG), exchanged base amount should be more than _quoteAssetAmountLimit.
        // // In the SHORT case, more quote assets means more payment so should not be more than _quoteAssetAmountLimit
        // if (_quoteAssetAmountLimit != 0) {
        //     if (dirOfQuote == Dir.REMOVE_FROM_AMM) {
        //         // SHORT
        //         require(quoteAssetAmount >= _quoteAssetAmountLimit, "Less than minimal quote token");
        //     } else {
        //         // LONG
        //         require(quoteAssetAmount <= _quoteAssetAmountLimit, "More than maximal quote token");
        //     }
        // }

        // as mentioned in swapOutput(), it always allows going over fluctuation limit because
        // it is only used by close/liquidate positions
        _updateReserve(dirOfQuote, quoteAssetAmount, _baseAssetAmount, _canOverFluctuationLimit);
        emit SwapOutput(_dirOfBase, quoteAssetAmount, _baseAssetAmount);
        return quoteAssetAmount;
    }

    /**
     * @notice update funding rate
     * @dev only allow to update while reaching `nextFundingTime`
     * @param _cap the limit of expense of funding payment
     * @return premiumFraction premium fraction of this period in 18 digits
     * @return fundingPayment profit of insurance fund in funding payment
     * @return uncappedFundingPayment imbalance cost of funding payment without cap
     */
    function settleFunding(uint256 _cap)
        external
        override
        onlyOpen
        onlyCounterParty
        returns (
            int256 premiumFraction,
            int256 fundingPayment,
            int256 uncappedFundingPayment
        )
    {
        require(_blockTimestamp() >= nextFundingTime, "settle funding too early");
        uint256 latestPricetimestamp = priceFeed.getLatestTimestamp(priceFeedKey);
        require(_blockTimestamp() < latestPricetimestamp + 30 * 60, "oracle price is expired");

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        uint256 underlyingPrice = getUnderlyingTwapPrice(spotPriceTwapInterval);
        int256 premium = getTwapPrice(spotPriceTwapInterval).toInt() - underlyingPrice.toInt();
        premiumFraction = (premium * fundingPeriod.toInt()) / int256(1 days);
        int256 positionSize = totalPositionSize; // to optimize gas
        // funding payment = premium fraction * position
        // eg. if alice takes 10 long position, totalPositionSize = 10
        // if premiumFraction is positive: long pay short, amm get positive funding payment
        // if premiumFraction is negative: short pay long, amm get negative funding payment
        // if totalPositionSize.side * premiumFraction > 0, funding payment is positive which means profit
        uncappedFundingPayment = premiumFraction.mulD(positionSize);
        // if expense of funding payment is greater than cap amount, then cap it
        if (uncappedFundingPayment < 0 && uint256(-uncappedFundingPayment) > _cap) {
            premiumFraction = int256(_cap).divD(positionSize) * (-1);
            fundingPayment = int256(_cap) * (-1);
        } else {
            fundingPayment = uncappedFundingPayment;
        }

        // update funding rate = premiumFraction / twapIndexPrice
        updateFundingRate(premiumFraction, underlyingPrice);

        // in order to prevent multiple funding settlement during very short time after network congestion
        uint256 minNextValidFundingTime = _blockTimestamp() + fundingBufferPeriod;

        // floor((nextFundingTime + fundingPeriod) / 3600) * 3600
        uint256 nextFundingTimeOnHourStart = ((nextFundingTime + fundingPeriod) / (1 hours)) * (1 hours);

        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        nextFundingTime = nextFundingTimeOnHourStart > minNextValidFundingTime ? nextFundingTimeOnHourStart : minNextValidFundingTime;

        // // DEPRECATED only for backward compatibility before we upgrade ClearingHouse
        // // reset funding related states
        // baseAssetDeltaThisFundingPeriod = 0;

        // return premiumFraction;
    }

    /**
     * Repeg both reserves in case of repegging and k-adjustment
     */
    function adjust(uint256 _quoteAssetReserve, uint256 _baseAssetReserve) external onlyCounterParty {
        require(_quoteAssetReserve != 0, "quote asset reserve cannot be 0");
        require(_baseAssetReserve != 0, "base asset reserve cannot be 0");
        quoteAssetReserve = _quoteAssetReserve;
        baseAssetReserve = _baseAssetReserve;
        _addReserveSnapshot();
        liquidityChangedSnapshots.push(
            LiquidityChangedSnapshot({
                cumulativeNotional: cumulativeNotional,
                baseAssetReserve: _baseAssetReserve,
                quoteAssetReserve: _quoteAssetReserve,
                totalPositionSize: totalPositionSize
            })
        );
        emit ReservesAdjusted(quoteAssetReserve, baseAssetReserve);
    }

    function calcBaseAssetAfterLiquidityMigration(
        int256 _baseAssetAmount,
        uint256 _fromQuoteReserve,
        uint256 _fromBaseReserve
    ) public view override returns (int256) {
        if (_baseAssetAmount == 0) {
            return _baseAssetAmount;
        }

        bool isPositiveValue = _baseAssetAmount > 0 ? true : false;

        // measure the trader position's notional value on the old curve
        // (by simulating closing the position)
        uint256 posNotional = getOutputPriceWithReserves(
            isPositiveValue ? Dir.ADD_TO_AMM : Dir.REMOVE_FROM_AMM,
            _baseAssetAmount.abs(),
            _fromQuoteReserve,
            _fromBaseReserve
        );

        // calculate and apply the required size on the new curve
        int256 newBaseAsset = getInputPrice(isPositiveValue ? Dir.REMOVE_FROM_AMM : Dir.ADD_TO_AMM, posNotional).toInt();
        return newBaseAsset * (isPositiveValue ? int256(1) : int256(-1));
    }

    /**
     * @notice shutdown amm,
     * @dev only `globalShutdown` or owner can call this function
     * The price calculation is in `globalShutdown`.
     */
    function shutdown() external override {
        require(_msgSender() == owner() || _msgSender() == globalShutdown, "not owner nor globalShutdown");
        _implShutdown();
    }

    /**
     * @notice set counter party
     * @dev only owner can call this function
     * @param _counterParty address of counter party
     */
    function setCounterParty(address _counterParty) external onlyOwner {
        counterParty = _counterParty;
    }

    /**
     * @notice set `globalShutdown`
     * @dev only owner can call this function
     * @param _globalShutdown address of `globalShutdown`
     */
    function setGlobalShutdown(address _globalShutdown) external onlyOwner {
        globalShutdown = _globalShutdown;
    }

    /**
     * @notice set fluctuation limit rate. Default value is `1 / max leverage`
     * @dev only owner can call this function
     * @param _fluctuationLimitRatio fluctuation limit rate in 18 digits, 0 means skip the checking
     */
    function setFluctuationLimitRatio(uint256 _fluctuationLimitRatio) public onlyOwner {
        fluctuationLimitRatio = _fluctuationLimitRatio;
    }

    /**
     * @notice set time interval for twap calculation, default is 1 hour
     * @dev only owner can call this function
     * @param _interval time interval in seconds
     */
    function setSpotPriceTwapInterval(uint256 _interval) external onlyOwner {
        require(_interval != 0, "can not set interval to 0");
        spotPriceTwapInterval = _interval;
    }

    /**
     * @notice set `open` flag. Amm is open to trade if `open` is true. Default is false.
     * @dev only owner can call this function
     * @param _open open to trade is true, otherwise is false.
     */
    function setOpen(bool _open) external onlyOwner {
        if (open == _open) return;

        open = _open;
        if (_open) {
            nextFundingTime = ((_blockTimestamp() + fundingPeriod) / (1 hours)) * (1 hours);
        }
    }

    /**
     * @notice set `adjustable` flag. Amm is open to formulaic repeg and K adjustment if `adjustable` is true. Default is false.
     * @dev only owner can call this function
     * @param _adjustable open to formulaic repeg and K adjustment is true, otherwise is false.
     */
    function setAdjustable(bool _adjustable) external onlyOwner {
        if (adjustable == _adjustable) return;
        adjustable = _adjustable;
    }

    /**
     * @notice set `canLowerK` flag. Amm is open to decrease K adjustment if `canLowerK` is true. Default is false.
     * @dev only owner can call this function
     * @param _canLowerK open to decrease K adjustment is true, otherwise is false.
     */
    function setCanLowerK(bool _canLowerK) external onlyOwner {
        if (canLowerK == _canLowerK) return;
        canLowerK = _canLowerK;
    }

    /**
     * @notice set new toll ratio
     * @dev only owner can call
     * @param _tollRatio new toll ratio in 18 digits
     */
    function setTollRatio(uint256 _tollRatio) public onlyOwner {
        tollRatio = _tollRatio;
    }

    /**
     * @notice set new spread ratio
     * @dev only owner can call
     * @param _spreadRatio new toll spread in 18 digits
     */
    function setSpreadRatio(uint256 _spreadRatio) public onlyOwner {
        spreadRatio = _spreadRatio;
    }

    /**
     * @notice set new cap during guarded period, which is max position size that traders can hold
     * @dev only owner can call. assume this will be removes soon once the guarded period has ended. must be set before opening amm
     * @param _maxHoldingBaseAsset max position size that traders can hold in 18 digits
     * @param _openInterestNotionalCap open interest cap, denominated in quoteToken
     */
    function setCap(uint256 _maxHoldingBaseAsset, uint256 _openInterestNotionalCap) public onlyOwner {
        maxHoldingBaseAsset = _maxHoldingBaseAsset;
        openInterestNotionalCap = _openInterestNotionalCap;
        emit CapChanged(maxHoldingBaseAsset, openInterestNotionalCap);
    }

    /**
     * @notice set priceFee address
     * @dev only owner can call
     * @param _priceFeed new price feed for this AMM
     */
    function setPriceFeed(IPriceFeed _priceFeed) public onlyOwner {
        require(address(_priceFeed) != address(0), "invalid PriceFeed address");
        priceFeed = _priceFeed;
        emit PriceFeedUpdated(address(priceFeed));
    }

    //
    // VIEW FUNCTIONS
    //
    function getFormulaicRepegResult(uint256 _budget, bool _adjustK)
        external
        view
        override
        returns (
            bool isAdjustable,
            int256 cost,
            uint256 newQuoteAssetReserve,
            uint256 newBaseAssetReserve
        )
    {
        if (open && adjustable && isOverSpreadLimit()) {
            uint256 targetPrice = getUnderlyingPrice();
            uint256 _quoteAssetReserve = quoteAssetReserve; //to optimize gas cost
            uint256 _baseAssetReserve = baseAssetReserve; //to optimize gas cost
            int256 _positionSize = totalPositionSize; //to optimize gas cost
            newBaseAssetReserve = _baseAssetReserve;
            newQuoteAssetReserve = targetPrice.mulD(newBaseAssetReserve);
            cost = AmmMath.adjustPegCost(_quoteAssetReserve, newBaseAssetReserve, _positionSize, newQuoteAssetReserve);
            if (cost > 0 && uint256(cost) > _budget) {
                if (_adjustK && canLowerK) {
                    // scale down K by 0.1% that returns a profit of clearing house
                    (cost, newQuoteAssetReserve, newBaseAssetReserve) = AmmMath.adjustKCost(
                        _quoteAssetReserve,
                        _baseAssetReserve,
                        _positionSize,
                        999,
                        1000
                    );
                    isAdjustable = true;
                } else {
                    isAdjustable = false;
                    // newQuoteAssetReserve = AmmMath.calcBudgetedQuoteReserve(_quoteAssetReserve, _baseAssetReserve, _positionSize, _budget);
                    // cost = _budget.toInt();
                }
            } else {
                isAdjustable = newQuoteAssetReserve != _quoteAssetReserve;
            }
        }
    }

    function getFormulaicUpdateKResult(int256 _budget)
        external
        view
        returns (
            bool isAdjustable,
            int256 cost,
            uint256 newQuoteAssetReserve,
            uint256 newBaseAssetReserve
        )
    {
        if (open && adjustable && (_budget > 0 || (_budget < 0 && canLowerK))) {
            uint256 _quoteAssetReserve = quoteAssetReserve; //to optimize gas cost
            uint256 _baseAssetReserve = baseAssetReserve; //to optimize gas cost
            int256 _positionSize = totalPositionSize; //to optimize gas cost
            (uint256 scaleNum, uint256 scaleDenom) = AmmMath.calculateBudgetedKScale(
                _quoteAssetReserve,
                _baseAssetReserve,
                _budget,
                _positionSize
            );
            if (scaleNum == scaleDenom) {
                isAdjustable = false;
            } else {
                isAdjustable = true;
                (cost, newQuoteAssetReserve, newBaseAssetReserve) = AmmMath.adjustKCost(
                    _quoteAssetReserve,
                    _baseAssetReserve,
                    _positionSize,
                    scaleNum,
                    scaleDenom
                );
            }
        }
    }

    function isOverFluctuationLimit(Dir _dirOfBase, uint256 _baseAssetAmount) external view override returns (bool) {
        // Skip the check if the limit is 0
        if (fluctuationLimitRatio == 0) {
            return false;
        }

        (uint256 upperLimit, uint256 lowerLimit) = _getPriceBoundariesOfLastBlock();

        uint256 quoteAssetExchanged = getOutputPrice(_dirOfBase, _baseAssetAmount);
        uint256 price = (_dirOfBase == Dir.REMOVE_FROM_AMM)
            ? (quoteAssetReserve + quoteAssetExchanged).divD(baseAssetReserve - _baseAssetAmount)
            : (quoteAssetReserve - quoteAssetExchanged).divD(baseAssetReserve + _baseAssetAmount);

        if (price <= upperLimit && price >= lowerLimit) {
            return false;
        }
        return true;
    }

    /**
     * @notice get input twap amount.
     * returns how many base asset you will get with the input quote amount based on twap price.
     * @param _dirOfQuote ADD_TO_AMM for long, REMOVE_FROM_AMM for short.
     * @param _quoteAssetAmount quote asset amount
     * @return base asset amount
     */
    function getInputTwap(Dir _dirOfQuote, uint256 _quoteAssetAmount) public view override returns (uint256) {
        return _implGetInputAssetTwapPrice(_dirOfQuote, _quoteAssetAmount, QuoteAssetDir.QUOTE_IN, 15 minutes);
    }

    /**
     * @notice get output twap amount.
     * return how many quote asset you will get with the input base amount on twap price.
     * @param _dirOfBase ADD_TO_AMM for short, REMOVE_FROM_AMM for long, opposite direction from `getInputTwap`.
     * @param _baseAssetAmount base asset amount
     * @return quote asset amount
     */
    function getOutputTwap(Dir _dirOfBase, uint256 _baseAssetAmount) public view override returns (uint256) {
        return _implGetInputAssetTwapPrice(_dirOfBase, _baseAssetAmount, QuoteAssetDir.QUOTE_OUT, 15 minutes);
    }

    /**
     * @notice get input amount. returns how many base asset you will get with the input quote amount.
     * @param _dirOfQuote ADD_TO_AMM for long, REMOVE_FROM_AMM for short.
     * @param _quoteAssetAmount quote asset amount
     * @return base asset amount
     */
    function getInputPrice(Dir _dirOfQuote, uint256 _quoteAssetAmount) public view override returns (uint256) {
        return getInputPriceWithReserves(_dirOfQuote, _quoteAssetAmount, quoteAssetReserve, baseAssetReserve);
    }

    /**
     * @notice get output price. return how many quote asset you will get with the input base amount
     * @param _dirOfBase ADD_TO_AMM for short, REMOVE_FROM_AMM for long, opposite direction from `getInput`.
     * @param _baseAssetAmount base asset amount
     * @return quote asset amount
     */
    function getOutputPrice(Dir _dirOfBase, uint256 _baseAssetAmount) public view override returns (uint256) {
        return getOutputPriceWithReserves(_dirOfBase, _baseAssetAmount, quoteAssetReserve, baseAssetReserve);
    }

    /**
     * @notice get underlying price provided by oracle
     * @return underlying price
     */
    function getUnderlyingPrice() public view override returns (uint256) {
        return uint256(priceFeed.getPrice(priceFeedKey));
    }

    /**
     * @notice get underlying twap price provided by oracle
     * @return underlying price
     */
    function getUnderlyingTwapPrice(uint256 _intervalInSeconds) public view returns (uint256) {
        return uint256(priceFeed.getTwapPrice(priceFeedKey, _intervalInSeconds));
    }

    /**
     * @notice get spot price based on current quote/base asset reserve.
     * @return spot price
     */
    function getSpotPrice() public view override returns (uint256) {
        return quoteAssetReserve.divD(baseAssetReserve);
    }

    /**
     * @notice get twap price
     */
    function getTwapPrice(uint256 _intervalInSeconds) public view returns (uint256) {
        return _implGetReserveTwapPrice(_intervalInSeconds);
    }

    /**
     * @notice get current quote/base asset reserve.
     * @return (quote asset reserve, base asset reserve)
     */
    function getReserve() external view returns (uint256, uint256) {
        return (quoteAssetReserve, baseAssetReserve);
    }

    function getSnapshotLen() external view returns (uint256) {
        return reserveSnapshots.length;
    }

    function getLiquidityHistoryLength() external view override returns (uint256) {
        return liquidityChangedSnapshots.length;
    }

    function getCumulativeNotional() external view override returns (int256) {
        return cumulativeNotional;
    }

    function getLatestLiquidityChangedSnapshots() public view returns (LiquidityChangedSnapshot memory) {
        return liquidityChangedSnapshots[liquidityChangedSnapshots.length - 1];
    }

    function getLiquidityChangedSnapshots(uint256 i) external view override returns (LiquidityChangedSnapshot memory) {
        require(i < liquidityChangedSnapshots.length, "incorrect index");
        return liquidityChangedSnapshots[i];
    }

    function getSettlementPrice() external view override returns (uint256) {
        return settlementPrice;
    }

    // // DEPRECATED only for backward compatibility before we upgrade ClearingHouse
    // function getBaseAssetDeltaThisFundingPeriod() external view override returns (int256) {
    //     return baseAssetDeltaThisFundingPeriod;
    // }

    function getMaxHoldingBaseAsset() external view override returns (uint256) {
        return maxHoldingBaseAsset;
    }

    function getOpenInterestNotionalCap() external view override returns (uint256) {
        return openInterestNotionalCap;
    }

    function getBaseAssetDelta() external view override returns (int256) {
        return totalPositionSize;
    }

    function isOverSpreadLimit() public view override returns (bool) {
        uint256 oraclePrice = getUnderlyingPrice();
        require(oraclePrice > 0, "underlying price is 0");
        uint256 marketPrice = getSpotPrice();
        uint256 oracleSpreadRatioAbs = (marketPrice.toInt() - oraclePrice.toInt()).divD(oraclePrice.toInt()).abs();

        return oracleSpreadRatioAbs >= MAX_ORACLE_SPREAD_RATIO ? true : false;
    }

    /**
     * @notice calculate total fee (including toll and spread) by input quoteAssetAmount
     * @param _quoteAssetAmount quoteAssetAmount
     * @return total tx fee
     */
    function calcFee(uint256 _quoteAssetAmount) external view override returns (uint256, uint256) {
        if (_quoteAssetAmount == 0) {
            return (0, 0);
        }
        return (_quoteAssetAmount.mulD(tollRatio), _quoteAssetAmount.mulD(spreadRatio));
    }

    /*       plus/minus 1 while the amount is not dividable
     *
     *        getInputPrice                         getOutputPrice
     *
     *     ＡＤＤ      (amount - 1)              (amount + 1)   ＲＥＭＯＶＥ
     *      ◥◤            ▲                         |             ◢◣
     *      ◥◤  ------->  |                         ▼  <--------  ◢◣
     *    -------      -------                   -------        -------
     *    |  Q  |      |  B  |                   |  Q  |        |  B  |
     *    -------      -------                   -------        -------
     *      ◥◤  ------->  ▲                         |  <--------  ◢◣
     *      ◥◤            |                         ▼             ◢◣
     *   ＲＥＭＯＶＥ  (amount + 1)              (amount + 1)      ＡＤＤ
     **/

    function getInputPriceWithReserves(
        Dir _dirOfQuote,
        uint256 _quoteAssetAmount,
        uint256 _quoteAssetPoolAmount,
        uint256 _baseAssetPoolAmount
    ) public pure override returns (uint256) {
        if (_quoteAssetAmount == 0) {
            return 0;
        }

        bool isAddToAmm = _dirOfQuote == Dir.ADD_TO_AMM;
        uint256 baseAssetAfter;
        uint256 quoteAssetAfter;
        uint256 baseAssetBought;
        if (isAddToAmm) {
            quoteAssetAfter = _quoteAssetPoolAmount + _quoteAssetAmount;
        } else {
            quoteAssetAfter = _quoteAssetPoolAmount - _quoteAssetAmount;
        }
        require(quoteAssetAfter != 0, "quote asset after is 0");

        baseAssetAfter = FullMath.mulDiv(_quoteAssetPoolAmount, _baseAssetPoolAmount, quoteAssetAfter);
        baseAssetBought = (baseAssetAfter.toInt() - _baseAssetPoolAmount.toInt()).abs();

        // if the amount is not dividable, return 1 wei less for trader
        if (
            FullMath.mulDiv(_quoteAssetPoolAmount, _baseAssetPoolAmount, quoteAssetAfter) !=
            FullMath.mulDivRoundingUp(_quoteAssetPoolAmount, _baseAssetPoolAmount, quoteAssetAfter)
        ) {
            if (isAddToAmm) {
                baseAssetBought = baseAssetBought - 1;
            } else {
                baseAssetBought = baseAssetBought + 1;
            }
        }

        return baseAssetBought;
    }

    function getOutputPriceWithReserves(
        Dir _dirOfBase,
        uint256 _baseAssetAmount,
        uint256 _quoteAssetPoolAmount,
        uint256 _baseAssetPoolAmount
    ) public pure override returns (uint256) {
        if (_baseAssetAmount == 0) {
            return 0;
        }

        bool isAddToAmm = _dirOfBase == Dir.ADD_TO_AMM;
        uint256 quoteAssetAfter;
        uint256 baseAssetAfter;
        uint256 quoteAssetSold;

        if (isAddToAmm) {
            baseAssetAfter = _baseAssetPoolAmount + _baseAssetAmount;
        } else {
            baseAssetAfter = _baseAssetPoolAmount - _baseAssetAmount;
        }
        require(baseAssetAfter != 0, "base asset after is 0");

        quoteAssetAfter = FullMath.mulDiv(_quoteAssetPoolAmount, _baseAssetPoolAmount, baseAssetAfter);
        quoteAssetSold = (quoteAssetAfter.toInt() - _quoteAssetPoolAmount.toInt()).abs();

        // if the amount is not dividable, return 1 wei less for trader
        if (
            FullMath.mulDiv(_quoteAssetPoolAmount, _baseAssetPoolAmount, baseAssetAfter) !=
            FullMath.mulDivRoundingUp(_quoteAssetPoolAmount, _baseAssetPoolAmount, baseAssetAfter)
        ) {
            if (isAddToAmm) {
                quoteAssetSold = quoteAssetSold - 1;
            } else {
                quoteAssetSold = quoteAssetSold + 1;
            }
        }

        return quoteAssetSold;
    }

    //
    // INTERNAL FUNCTIONS
    //
    // update funding rate = premiumFraction / twapIndexPrice
    function updateFundingRate(int256 _premiumFraction, uint256 _underlyingPrice) private {
        fundingRate = _premiumFraction.divD(_underlyingPrice.toInt());
        emit FundingRateUpdated(fundingRate, _underlyingPrice);
    }

    function _addReserveSnapshot() internal {
        uint256 currentBlock = _blockNumber();
        ReserveSnapshot storage latestSnapshot = reserveSnapshots[reserveSnapshots.length - 1];
        // update values in snapshot if in the same block
        if (currentBlock == latestSnapshot.blockNumber) {
            latestSnapshot.quoteAssetReserve = quoteAssetReserve;
            latestSnapshot.baseAssetReserve = baseAssetReserve;
        } else {
            reserveSnapshots.push(ReserveSnapshot(quoteAssetReserve, baseAssetReserve, _blockTimestamp(), currentBlock));
        }
        emit ReserveSnapshotted(quoteAssetReserve, baseAssetReserve, _blockTimestamp());
    }

    // the direction is in quote asset
    function _updateReserve(
        Dir _dirOfQuote,
        uint256 _quoteAssetAmount,
        uint256 _baseAssetAmount,
        bool _canOverFluctuationLimit
    ) internal {
        // check if it's over fluctuationLimitRatio
        // this check should be before reserves being updated
        _checkIsOverBlockFluctuationLimit(_dirOfQuote, _quoteAssetAmount, _baseAssetAmount, _canOverFluctuationLimit);

        if (_dirOfQuote == Dir.ADD_TO_AMM) {
            quoteAssetReserve = quoteAssetReserve + _quoteAssetAmount;
            baseAssetReserve = baseAssetReserve - _baseAssetAmount;
            // DEPRECATED only for backward compatibility before we upgrade ClearingHouse
            // baseAssetDeltaThisFundingPeriod = baseAssetDeltaThisFundingPeriod - _baseAssetAmount.toInt();
            totalPositionSize = totalPositionSize + _baseAssetAmount.toInt();
            cumulativeNotional = cumulativeNotional + _quoteAssetAmount.toInt();
        } else {
            quoteAssetReserve = quoteAssetReserve - _quoteAssetAmount;
            baseAssetReserve = baseAssetReserve + _baseAssetAmount;
            // // DEPRECATED only for backward compatibility before we upgrade ClearingHouse
            // baseAssetDeltaThisFundingPeriod = baseAssetDeltaThisFundingPeriod + _baseAssetAmount.toInt();
            totalPositionSize = totalPositionSize - _baseAssetAmount.toInt();
            cumulativeNotional = cumulativeNotional - _quoteAssetAmount.toInt();
        }

        // _addReserveSnapshot must be after checking price fluctuation
        _addReserveSnapshot();
    }

    function _implGetInputAssetTwapPrice(
        Dir _dirOfQuote,
        uint256 _assetAmount,
        QuoteAssetDir _inOut,
        uint256 _interval
    ) internal view returns (uint256) {
        TwapPriceCalcParams memory params;
        params.opt = TwapCalcOption.INPUT_ASSET;
        params.snapshotIndex = reserveSnapshots.length - 1;
        params.asset.dir = _dirOfQuote;
        params.asset.assetAmount = _assetAmount;
        params.asset.inOrOut = _inOut;
        return _calcTwap(params, _interval);
    }

    function _implGetReserveTwapPrice(uint256 _interval) internal view returns (uint256) {
        TwapPriceCalcParams memory params;
        params.opt = TwapCalcOption.RESERVE_ASSET;
        params.snapshotIndex = reserveSnapshots.length - 1;
        return _calcTwap(params, _interval);
    }

    function _calcTwap(TwapPriceCalcParams memory _params, uint256 _interval) internal view returns (uint256) {
        uint256 currentPrice = _getPriceWithSpecificSnapshot(_params);
        if (_interval == 0) {
            return currentPrice;
        }

        uint256 baseTimestamp = _blockTimestamp() - _interval;
        ReserveSnapshot memory currentSnapshot = reserveSnapshots[_params.snapshotIndex];
        // return the latest snapshot price directly
        // if only one snapshot or the timestamp of latest snapshot is earlier than asking for
        if (reserveSnapshots.length == 1 || currentSnapshot.timestamp <= baseTimestamp) {
            return currentPrice;
        }

        uint256 previousTimestamp = currentSnapshot.timestamp;
        uint256 period = _blockTimestamp() - previousTimestamp;
        uint256 weightedPrice = currentPrice * period;
        while (true) {
            // if snapshot history is too short
            if (_params.snapshotIndex == 0) {
                return weightedPrice / period;
            }

            _params.snapshotIndex = _params.snapshotIndex - 1;
            currentSnapshot = reserveSnapshots[_params.snapshotIndex];
            currentPrice = _getPriceWithSpecificSnapshot(_params);

            // check if current round timestamp is earlier than target timestamp
            if (currentSnapshot.timestamp <= baseTimestamp) {
                // weighted time period will be (target timestamp - previous timestamp). For example,
                // now is 1000, _interval is 100, then target timestamp is 900. If timestamp of current round is 970,
                // and timestamp of NEXT round is 880, then the weighted time period will be (970 - 900) = 70,
                // instead of (970 - 880)
                weightedPrice = weightedPrice + (currentPrice * (previousTimestamp - baseTimestamp));
                break;
            }

            uint256 timeFraction = previousTimestamp - currentSnapshot.timestamp;
            weightedPrice = weightedPrice + (currentPrice * timeFraction);
            period = period + timeFraction;
            previousTimestamp = currentSnapshot.timestamp;
        }
        return weightedPrice / _interval;
    }

    function _getPriceWithSpecificSnapshot(TwapPriceCalcParams memory params) internal view virtual returns (uint256) {
        ReserveSnapshot memory snapshot = reserveSnapshots[params.snapshotIndex];

        // RESERVE_ASSET means price comes from quoteAssetReserve/baseAssetReserve
        // INPUT_ASSET means getInput/Output price with snapshot's reserve
        if (params.opt == TwapCalcOption.RESERVE_ASSET) {
            return snapshot.quoteAssetReserve.divD(snapshot.baseAssetReserve);
        } else if (params.opt == TwapCalcOption.INPUT_ASSET) {
            if (params.asset.assetAmount == 0) {
                return 0;
            }
            if (params.asset.inOrOut == QuoteAssetDir.QUOTE_IN) {
                return
                    getInputPriceWithReserves(
                        params.asset.dir,
                        params.asset.assetAmount,
                        snapshot.quoteAssetReserve,
                        snapshot.baseAssetReserve
                    );
            } else if (params.asset.inOrOut == QuoteAssetDir.QUOTE_OUT) {
                return
                    getOutputPriceWithReserves(
                        params.asset.dir,
                        params.asset.assetAmount,
                        snapshot.quoteAssetReserve,
                        snapshot.baseAssetReserve
                    );
            }
        }
        revert("not supported option");
    }

    function _getPriceBoundariesOfLastBlock() internal view returns (uint256, uint256) {
        uint256 len = reserveSnapshots.length;
        ReserveSnapshot memory latestSnapshot = reserveSnapshots[len - 1];
        // if the latest snapshot is the same as current block, get the previous one
        if (latestSnapshot.blockNumber == _blockNumber() && len > 1) {
            latestSnapshot = reserveSnapshots[len - 2];
        }

        uint256 lastPrice = latestSnapshot.quoteAssetReserve.divD(latestSnapshot.baseAssetReserve);
        uint256 upperLimit = lastPrice.mulD(1 ether + fluctuationLimitRatio);
        uint256 lowerLimit = lastPrice.mulD(1 ether - fluctuationLimitRatio);
        return (upperLimit, lowerLimit);
    }

    /**
     * @notice there can only be one tx in a block can skip the fluctuation check
     *         otherwise, some positions can never be closed or liquidated
     * @param _canOverFluctuationLimit if true, can skip fluctuation check for once; else, can never skip
     */
    function _checkIsOverBlockFluctuationLimit(
        Dir _dirOfQuote,
        uint256 _quoteAssetAmount,
        uint256 _baseAssetAmount,
        bool _canOverFluctuationLimit
    ) internal view {
        // Skip the check if the limit is 0
        if (fluctuationLimitRatio == 0) {
            return;
        }

        //
        // assume the price of the last block is 10, fluctuation limit ratio is 5%, then
        //
        //          current price
        //  --+---------+-----------+---
        //   9.5        10         10.5
        // lower limit           upper limit
        //
        // when `openPosition`, the price can only be between 9.5 - 10.5
        // when `liquidate` and `closePosition`, the price can exceed the boundary once
        // (either lower than 9.5 or higher than 10.5)
        // once it exceeds the boundary, all the rest txs in this block fail
        //

        (uint256 upperLimit, uint256 lowerLimit) = _getPriceBoundariesOfLastBlock();

        uint256 price = quoteAssetReserve.divD(baseAssetReserve);
        require(price <= upperLimit && price >= lowerLimit, "price is already over fluctuation limit");

        if (!_canOverFluctuationLimit) {
            price = (_dirOfQuote == Dir.ADD_TO_AMM)
                ? (quoteAssetReserve + _quoteAssetAmount).divD(baseAssetReserve - _baseAssetAmount)
                : (quoteAssetReserve - _quoteAssetAmount).divD(baseAssetReserve + _baseAssetAmount);
            require(price <= upperLimit && price >= lowerLimit, "price is over fluctuation limit");
        }
    }

    function _checkLiquidityMultiplierLimit(int256 _positionSize, uint256 _liquidityMultiplier) internal view {
        // have lower bound when position size is long
        if (_positionSize > 0) {
            uint256 liquidityMultiplierLowerBound = (_positionSize + MARGIN_FOR_LIQUIDITY_MIGRATION_ROUNDING.toInt())
                .divD(baseAssetReserve.toInt())
                .abs();
            require(_liquidityMultiplier >= liquidityMultiplierLowerBound, "illegal liquidity multiplier");
        }
    }

    function _implShutdown() internal {
        LiquidityChangedSnapshot memory latestLiquiditySnapshot = getLatestLiquidityChangedSnapshots();

        // get last liquidity changed history to calc new quote/base reserve
        uint256 previousK = latestLiquiditySnapshot.baseAssetReserve.mulD(latestLiquiditySnapshot.quoteAssetReserve);
        int256 lastInitBaseReserveInNewCurve = latestLiquiditySnapshot.totalPositionSize + latestLiquiditySnapshot.baseAssetReserve.toInt();
        int256 lastInitQuoteReserveInNewCurve = previousK.toInt().divD(lastInitBaseReserveInNewCurve);

        // settlementPrice = SUM(Open Position Notional Value) / SUM(Position Size)
        // `Open Position Notional Value` = init quote reserve - current quote reserve
        // `Position Size` = init base reserve - current base reserve
        int256 positionNotionalValue = lastInitQuoteReserveInNewCurve - quoteAssetReserve.toInt();

        // if total position size less than IGNORABLE_DIGIT_FOR_SHUTDOWN, treat it as 0 positions due to rounding error
        if (totalPositionSize.toUint() > IGNORABLE_DIGIT_FOR_SHUTDOWN) {
            settlementPrice = positionNotionalValue.abs().divD(totalPositionSize.abs());
        }

        open = false;
        emit Shutdown(settlementPrice);
    }
}
