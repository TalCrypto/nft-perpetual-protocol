// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { BlockContext } from "./utils/BlockContext.sol";
import { IPriceFeed } from "./interfaces/IPriceFeed.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { IAmm } from "./interfaces/IAmm.sol";
import { IntMath } from "./utils/IntMath.sol";
import { UIntMath } from "./utils/UIntMath.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AmmMath } from "./utils/AmmMath.sol";

contract Amm is IAmm, OwnableUpgradeable, BlockContext {
    using UIntMath for uint256;
    using IntMath for int256;

    //
    // enum and struct
    //

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

    struct ReserveSnapshot {
        uint256 quoteAssetReserve;
        uint256 baseAssetReserve;
        uint256 timestamp;
        uint256 blockNumber;
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
    // CONSTANT
    //
    // because position decimal rounding error,
    // if the position size is less than IGNORABLE_DIGIT_FOR_SHUTDOWN, it's equal size is 0
    uint256 private constant IGNORABLE_DIGIT_FOR_SHUTDOWN = 1e9;

    uint256 public constant MAX_ORACLE_SPREAD_RATIO = 0.1 ether; // 10%

    uint8 public constant MIN_NUM_REPEG_FLAG = 3;

    //**********************************************************//
    //    The below state variables can not change the order    //
    //**********************************************************//

    // // DEPRECATED
    // // update during every swap and calculate total amm pnl per funding period
    // int256 private baseAssetDeltaThisFundingPeriod;

    // update during every swap and used when shutting amm down. it's trader's total base asset size
    // int256 public totalPositionSize;
    uint256 public longPositionSize;
    uint256 public shortPositionSize;

    // latest funding rate
    int256 public fundingRateLong;
    int256 public fundingRateShort;

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
    uint8 public repegFlag;
    uint256 public repegPriceGapRatio;

    uint256 public fundingCostCoverRate; // system covers pct of normal funding payment when cost, 1 means normal funding rate
    uint256 public fundingRevenueTakeRate; // system takes ptc of normal funding payment when revenue, 1 means normal funding rate

    uint256[50] private __gap;

    //**********************************************************//
    //    The above state variables can not change the order    //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//

    //
    // EVENTS
    //
    event SwapInput(Dir dirOfQuote, uint256 quoteAssetAmount, uint256 baseAssetAmount);
    event SwapOutput(Dir dirOfQuote, uint256 quoteAssetAmount, uint256 baseAssetAmount);
    event FundingRateUpdated(int256 rateLong, int256 rateShort, uint256 underlyingPrice, int256 fundingPayment);
    event ReserveSnapshotted(uint256 quoteAssetReserve, uint256 baseAssetReserve, uint256 timestamp);
    // event LiquidityChanged(uint256 quoteReserve, uint256 baseReserve, int256 cumulativeNotional);
    event CapChanged(uint256 maxHoldingBaseAsset, uint256 openInterestNotionalCap);
    event Shutdown(uint256 settlementPrice);
    event PriceFeedUpdated(address priceFeed);
    event ReservesAdjusted(uint256 quoteAssetReserve, uint256 baseAssetReserve, int256 totalPositionSize, int256 cumulativeNotional);

    //
    // MODIFIERS
    //
    modifier onlyOpen() {
        require(open, "AMM_C"); //amm was closed
        _;
    }

    modifier onlyCounterParty() {
        require(counterParty == _msgSender(), "AMM_NCP"); //not counterParty
        _;
    }

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
            "AMM_III"
        ); //initial with invalid input
        __Ownable_init();

        repegPriceGapRatio = 0.05 ether; // 5%
        fundingCostCoverRate = 0.5 ether; // system covers 50% of normal funding payment when cost
        fundingRevenueTakeRate = 1 ether; // system take 100% of normal funding payment when revenue

        quoteAssetReserve = _quoteAssetReserve;
        baseAssetReserve = _baseAssetReserve;
        tradeLimitRatio = _tradeLimitRatio;
        tollRatio = _tollRatio;
        spreadRatio = _spreadRatio;
        fluctuationLimitRatio = _fluctuationLimitRatio;
        fundingPeriod = _fundingPeriod;
        fundingBufferPeriod = _fundingPeriod / 2;
        spotPriceTwapInterval = 3 hours;
        priceFeedKey = _priceFeedKey;
        quoteAsset = IERC20(_quoteAsset);
        priceFeed = _priceFeed;
        reserveSnapshots.push(ReserveSnapshot(quoteAssetReserve, baseAssetReserve, _blockTimestamp(), _blockNumber()));
        emit ReserveSnapshotted(quoteAssetReserve, baseAssetReserve, _blockTimestamp());
    }

    /**
     * @notice this function is called only when opening position
     * @dev Only clearingHouse can call this function
     * @param _dir ADD_TO_AMM, REMOVE_FROM_AMM
     * @param _amount quote asset amount
     * @param _isQuote whether or not amount is quote
     * @param _canOverFluctuationLimit if true, the impact of the price MUST be less than `fluctuationLimitRatio`
     */
    function swapInput(
        Dir _dir,
        uint256 _amount,
        bool _isQuote,
        bool _canOverFluctuationLimit
    )
        external
        override
        onlyOpen
        onlyCounterParty
        returns (
            uint256 quoteAssetAmount,
            int256 baseAssetAmount,
            uint256 spreadFee,
            uint256 tollFee
        )
    {
        uint256 uBaseAssetAmount;
        if (_isQuote) {
            quoteAssetAmount = _amount;
            uBaseAssetAmount = getQuotePrice(_dir, _amount);
        } else {
            quoteAssetAmount = getBasePrice(_dir, _amount);
            uBaseAssetAmount = _amount;
        }

        Dir dirOfQuote;
        if (_isQuote == (_dir == Dir.ADD_TO_AMM)) {
            // open long
            longPositionSize += uBaseAssetAmount;
            dirOfQuote = Dir.ADD_TO_AMM;
            baseAssetAmount = int256(uBaseAssetAmount);
        } else {
            // open short
            shortPositionSize += uBaseAssetAmount;
            dirOfQuote = Dir.REMOVE_FROM_AMM;
            baseAssetAmount = -1 * int256(uBaseAssetAmount);
        }
        spreadFee = quoteAssetAmount.mulD(spreadRatio);
        tollFee = quoteAssetAmount.mulD(tollRatio);

        _updateReserve(dirOfQuote, quoteAssetAmount, uBaseAssetAmount, _canOverFluctuationLimit);
        emit SwapInput(dirOfQuote, quoteAssetAmount, uBaseAssetAmount);
    }

    /**
     * @notice this function is called only when closing/reversing position
     * @dev only clearingHouse can call this function
     * @param _dir ADD_TO_AMM, REMOVE_FROM_AMM
     * @param _amount base asset amount
     * @param _isQuote whether or not amount is quote
     * @param _canOverFluctuationLimit if true, the impact of the price MUST be less than `fluctuationLimitRatio`
     */
    function swapOutput(
        Dir _dir,
        uint256 _amount,
        bool _isQuote,
        bool _canOverFluctuationLimit
    )
        external
        override
        onlyOpen
        onlyCounterParty
        returns (
            uint256 quoteAssetAmount,
            int256 baseAssetAmount,
            uint256 spreadFee,
            uint256 tollFee
        )
    {
        uint256 uBaseAssetAmount;
        if (_isQuote) {
            quoteAssetAmount = _amount;
            uBaseAssetAmount = getQuotePrice(_dir, _amount);
        } else {
            quoteAssetAmount = getBasePrice(_dir, _amount);
            uBaseAssetAmount = _amount;
        }

        Dir dirOfQuote;
        if (_isQuote == (_dir == Dir.ADD_TO_AMM)) {
            // close/reverse short
            uint256 _shortPositionSize = shortPositionSize;
            _shortPositionSize >= uBaseAssetAmount ? shortPositionSize = _shortPositionSize - uBaseAssetAmount : shortPositionSize = 0;
            dirOfQuote = Dir.ADD_TO_AMM;
            baseAssetAmount = int256(uBaseAssetAmount);
        } else {
            // close/reverse long
            uint256 _longPositionSize = longPositionSize;
            _longPositionSize >= uBaseAssetAmount ? longPositionSize = _longPositionSize - uBaseAssetAmount : longPositionSize = 0;
            dirOfQuote = Dir.REMOVE_FROM_AMM;
            baseAssetAmount = -1 * int256(uBaseAssetAmount);
        }
        spreadFee = quoteAssetAmount.mulD(spreadRatio);
        tollFee = quoteAssetAmount.mulD(tollRatio);

        _updateReserve(dirOfQuote, quoteAssetAmount, uBaseAssetAmount, _canOverFluctuationLimit);
        emit SwapOutput(dirOfQuote, quoteAssetAmount, uBaseAssetAmount);
    }

    /**
     * @notice update funding rate
     * @dev only allow to update while reaching `nextFundingTime`
     * @param _cap the limit of expense of funding payment
     * @return premiumFractionLong premium fraction for long of this period in 18 digits
     * @return premiumFractionShort premium fraction for short of this period in 18 digits
     * @return fundingPayment profit of insurance fund in funding payment
     */
    function settleFunding(uint256 _cap)
        external
        override
        onlyOpen
        onlyCounterParty
        returns (
            int256 premiumFractionLong,
            int256 premiumFractionShort,
            int256 fundingPayment
        )
    {
        require(_blockTimestamp() >= nextFundingTime, "AMM_SFTE"); //settle funding too early
        uint256 latestPricetimestamp = priceFeed.getLatestTimestamp(priceFeedKey);
        require(_blockTimestamp() < latestPricetimestamp + 30 * 60, "AMM_OPE"); //oracle price is expired

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(3 hour) / 1 day
        // premiumFraction = premium * timeFraction
        uint256 underlyingPrice = getUnderlyingTwapPrice(spotPriceTwapInterval);
        int256 premium = getTwapPrice(spotPriceTwapInterval).toInt() - underlyingPrice.toInt();
        int256 premiumFraction = (premium * fundingPeriod.toInt()) / int256(1 days);
        int256 positionSize = getBaseAssetDelta();
        // funding payment = premium fraction * position
        // eg. if alice takes 10 long position, totalPositionSize = 10
        // if premiumFraction is positive: long pay short, amm get positive funding payment
        // if premiumFraction is negative: short pay long, amm get negative funding payment
        // if totalPositionSize.side * premiumFraction > 0, funding payment is positive which means profit
        int256 normalFundingPayment = premiumFraction.mulD(positionSize);

        // dynamic funding rate formula
        // premiumFractionLong  = premiumFraction * (2*shortSize + a*positionSize) / (longSize + shortSize)
        // premiumFractionShort = premiumFraction * (2*longSize  - a*positionSize) / (longSize + shortSize)
        int256 _longPositionSize = int256(longPositionSize);
        int256 _shortPositionSize = int256(shortPositionSize);
        int256 _fundingRevenueTakeRate = int256(fundingRevenueTakeRate);
        int256 _fundingCostCoverRate = int256(fundingCostCoverRate);

        if (normalFundingPayment > 0 && _fundingRevenueTakeRate < 1 ether && _longPositionSize + _shortPositionSize != 0) {
            // when the normal funding payment is revenue and daynamic rate is available, system takes profit partially
            fundingPayment = normalFundingPayment.mulD(_fundingRevenueTakeRate);
            int256 sign = premiumFraction >= 0 ? int256(1) : int256(-1);
            premiumFractionLong =
                int256(
                    Math.mulDiv(
                        premiumFraction.abs(),
                        uint256(_shortPositionSize * 2 + positionSize.mulD(_fundingRevenueTakeRate)),
                        uint256(_longPositionSize + _shortPositionSize)
                    )
                ) *
                sign;
            premiumFractionShort =
                int256(
                    Math.mulDiv(
                        premiumFraction.abs(),
                        uint256(_longPositionSize * 2 - positionSize.mulD(_fundingRevenueTakeRate)),
                        uint256(_longPositionSize + _shortPositionSize)
                    )
                ) *
                sign;
        } else if (normalFundingPayment < 0 && _fundingCostCoverRate < 1 ether && _longPositionSize + _shortPositionSize != 0) {
            // when the normal funding payment is cost and daynamic rate is available, system covers partially
            fundingPayment = normalFundingPayment.mulD(_fundingCostCoverRate);
            int256 sign = premiumFraction >= 0 ? int256(1) : int256(-1);
            if (uint256(-fundingPayment) > _cap) {
                // when the funding payment that system covers is greater than the cap, then not pay funding and shutdown amm
                fundingPayment = 0;
                _implShutdown();
            } else {
                premiumFractionLong =
                    int256(
                        Math.mulDiv(
                            premiumFraction.abs(),
                            uint256(_shortPositionSize * 2 + positionSize.mulD(_fundingCostCoverRate)),
                            uint256(_longPositionSize + _shortPositionSize)
                        )
                    ) *
                    sign;
                premiumFractionShort =
                    int256(
                        Math.mulDiv(
                            premiumFraction.abs(),
                            uint256(_longPositionSize * 2 - positionSize.mulD(_fundingCostCoverRate)),
                            uint256(_longPositionSize + _shortPositionSize)
                        )
                    ) *
                    sign;
            }
        } else {
            fundingPayment = normalFundingPayment;
            // if expense of funding payment is greater than cap amount, then not pay funding and shutdown amm
            if (fundingPayment < 0 && uint256(-fundingPayment) > _cap) {
                fundingPayment = 0;
                _implShutdown();
            } else {
                premiumFractionLong = premiumFraction;
                premiumFractionShort = premiumFraction;
            }
        }

        // update funding rate = premiumFraction / twapIndexPrice
        fundingRateLong = premiumFractionLong.divD(underlyingPrice.toInt());
        fundingRateShort = premiumFractionShort.divD(underlyingPrice.toInt());
        // positive fundingPayment is revenue to system, otherwise cost to system
        emit FundingRateUpdated(fundingRateLong, fundingRateShort, underlyingPrice, fundingPayment);

        // in order to prevent multiple funding settlement during very short time after network congestion
        uint256 minNextValidFundingTime = _blockTimestamp() + fundingBufferPeriod;

        // floor((nextFundingTime + fundingPeriod) / 3600) * 3600
        uint256 nextFundingTimeOnHourStart = ((nextFundingTime + fundingPeriod) / (1 hours)) * (1 hours);

        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        nextFundingTime = nextFundingTimeOnHourStart > minNextValidFundingTime ? nextFundingTimeOnHourStart : minNextValidFundingTime;
    }

    /**
     * @notice check if repeg can be done and get the cost and reserves of formulaic repeg
     * @param _budget the budget available for repeg
     * @return isAdjustable if true, curve can be adjustable by repeg
     * @return cost the amount of cost of repeg, negative means profit of system
     * @return newQuoteAssetReserve the new quote asset reserve by repeg
     * @return newBaseAssetReserve the new base asset reserve by repeg
     */
    function repegCheck(uint256 _budget)
        external
        override
        onlyCounterParty
        returns (
            bool isAdjustable,
            int256 cost,
            uint256 newQuoteAssetReserve,
            uint256 newBaseAssetReserve
        )
    {
        if (open && adjustable) {
            uint256 _repegFlag = repegFlag;
            (bool result, uint256 marketPrice, uint256 oraclePrice) = isOverSpreadLimit();
            if (result) {
                _repegFlag += 1;
            } else {
                _repegFlag = 0;
            }
            int256 _positionSize = getBaseAssetDelta();
            uint256 targetPrice;
            if (_positionSize == 0) {
                targetPrice = oraclePrice;
            } else if (_repegFlag >= MIN_NUM_REPEG_FLAG) {
                targetPrice = oraclePrice > marketPrice
                    ? oraclePrice.mulD(1 ether - repegPriceGapRatio)
                    : oraclePrice.mulD(1 ether + repegPriceGapRatio);
            }
            if (targetPrice != 0) {
                uint256 _quoteAssetReserve = quoteAssetReserve; //to optimize gas cost
                uint256 _baseAssetReserve = baseAssetReserve; //to optimize gas cost
                (newQuoteAssetReserve, newBaseAssetReserve) = AmmMath.calcReservesAfterRepeg(
                    _quoteAssetReserve,
                    _baseAssetReserve,
                    targetPrice,
                    _positionSize
                );
                cost = AmmMath.calcCostForAdjustReserves(
                    _quoteAssetReserve,
                    _baseAssetReserve,
                    _positionSize,
                    newQuoteAssetReserve,
                    newBaseAssetReserve
                );
                if (cost > 0 && uint256(cost) > _budget) {
                    isAdjustable = false;
                } else {
                    isAdjustable = true;
                }
            }
            repegFlag = uint8(_repegFlag);
        }
    }

    /**
     * Repeg both reserves in case of repegging and k-adjustment
     */
    function adjust(uint256 _quoteAssetReserve, uint256 _baseAssetReserve) external onlyCounterParty {
        require(_quoteAssetReserve != 0, "AMM_ZQ"); //quote asset reserve cannot be 0
        require(_baseAssetReserve != 0, "AMM_ZB"); //base asset reserve cannot be 0
        quoteAssetReserve = _quoteAssetReserve;
        baseAssetReserve = _baseAssetReserve;
        _addReserveSnapshot();
        emit ReservesAdjusted(quoteAssetReserve, baseAssetReserve, getBaseAssetDelta(), cumulativeNotional);
    }

    /**
     * @notice shutdown amm,
     * @dev only `globalShutdown` or owner can call this function
     * The price calculation is in `globalShutdown`.
     */
    function shutdown() external override {
        require(_msgSender() == owner() || _msgSender() == globalShutdown, "AMM_NONG"); //not owner nor globalShutdown
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
    function setFluctuationLimitRatio(uint256 _fluctuationLimitRatio) external onlyOwner {
        fluctuationLimitRatio = _fluctuationLimitRatio;
    }

    /**
     * @notice set time interval for twap calculation, default is 1 hour
     * @dev only owner can call this function
     * @param _interval time interval in seconds
     */
    function setSpotPriceTwapInterval(uint256 _interval) external onlyOwner {
        require(_interval != 0, "AMM_ZI"); //zero interval
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
    function setTollRatio(uint256 _tollRatio) external onlyOwner {
        tollRatio = _tollRatio;
    }

    /**
     * @notice set new spread ratio
     * @dev only owner can call
     * @param _spreadRatio new toll spread in 18 digits
     */
    function setSpreadRatio(uint256 _spreadRatio) external onlyOwner {
        spreadRatio = _spreadRatio;
    }

    /**
     * @notice set new cap during guarded period, which is max position size that traders can hold
     * @dev only owner can call. assume this will be removes soon once the guarded period has ended. must be set before opening amm
     * @param _maxHoldingBaseAsset max position size that traders can hold in 18 digits
     * @param _openInterestNotionalCap open interest cap, denominated in quoteToken
     */
    function setCap(uint256 _maxHoldingBaseAsset, uint256 _openInterestNotionalCap) external onlyOwner {
        maxHoldingBaseAsset = _maxHoldingBaseAsset;
        openInterestNotionalCap = _openInterestNotionalCap;
        emit CapChanged(maxHoldingBaseAsset, openInterestNotionalCap);
    }

    /**
     * @notice set priceFee address
     * @dev only owner can call
     * @param _priceFeed new price feed for this AMM
     */
    function setPriceFeed(IPriceFeed _priceFeed) external onlyOwner {
        require(address(_priceFeed) != address(0), "AMM_ZAPF"); //zero address of price feed
        priceFeed = _priceFeed;
        emit PriceFeedUpdated(address(priceFeed));
    }

    function setRepegPriceGapRatio(uint256 _ratio) external onlyOwner {
        repegPriceGapRatio = _ratio;
    }

    function setFundingCostCoverRate(uint256 _rate) external onlyOwner {
        fundingCostCoverRate = _rate;
    }

    function setFundingRevenueTakeRate(uint256 _rate) external onlyOwner {
        fundingRevenueTakeRate = _rate;
    }

    //
    // VIEW FUNCTIONS
    //

    /**
     * @notice get the cost and reserves when adjust k
     * @param _budget the budget available for adjust
     * @return isAdjustable if true, curve can be adjustable by adjust k
     * @return cost the amount of cost of adjust k
     * @return newQuoteAssetReserve the new quote asset reserve by adjust k
     * @return newBaseAssetReserve the new base asset reserve by adjust k
     */

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
            int256 _positionSize = getBaseAssetDelta(); //to optimize gas cost
            (uint256 scaleNum, uint256 scaleDenom) = AmmMath.calculateBudgetedKScale(
                _quoteAssetReserve,
                _baseAssetReserve,
                _budget,
                _positionSize
            );
            if (scaleNum == scaleDenom || scaleDenom == 0 || scaleNum == 0) {
                isAdjustable = false;
            } else {
                isAdjustable = true;
                newQuoteAssetReserve = Math.mulDiv(_quoteAssetReserve, scaleNum, scaleDenom);
                newBaseAssetReserve = Math.mulDiv(_baseAssetReserve, scaleNum, scaleDenom);
                cost = AmmMath.calcCostForAdjustReserves(
                    _quoteAssetReserve,
                    _baseAssetReserve,
                    _positionSize,
                    newQuoteAssetReserve,
                    newBaseAssetReserve
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

        uint256 quoteAssetExchanged = getBasePrice(_dirOfBase, _baseAssetAmount);
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
    function getQuoteTwap(Dir _dirOfQuote, uint256 _quoteAssetAmount) public view override returns (uint256) {
        return _implGetInputAssetTwapPrice(_dirOfQuote, _quoteAssetAmount, QuoteAssetDir.QUOTE_IN, 15 minutes);
    }

    /**
     * @notice get output twap amount.
     * return how many quote asset you will get with the input base amount on twap price.
     * @param _dirOfBase ADD_TO_AMM for short, REMOVE_FROM_AMM for long, opposite direction from `getQuoteTwap`.
     * @param _baseAssetAmount base asset amount
     * @return quote asset amount
     */
    function getBaseTwap(Dir _dirOfBase, uint256 _baseAssetAmount) public view override returns (uint256) {
        return _implGetInputAssetTwapPrice(_dirOfBase, _baseAssetAmount, QuoteAssetDir.QUOTE_OUT, 15 minutes);
    }

    /**
     * @notice get input amount. returns how many base asset you will get with the input quote amount.
     * @param _dirOfQuote ADD_TO_AMM for long, REMOVE_FROM_AMM for short.
     * @param _quoteAssetAmount quote asset amount
     * @return base asset amount
     */
    function getQuotePrice(Dir _dirOfQuote, uint256 _quoteAssetAmount) public view override returns (uint256) {
        return getQuotePriceWithReserves(_dirOfQuote, _quoteAssetAmount, quoteAssetReserve, baseAssetReserve);
    }

    /**
     * @notice get output price. return how many quote asset you will get with the input base amount
     * @param _dirOfBase ADD_TO_AMM for short, REMOVE_FROM_AMM for long, opposite direction from `getInput`.
     * @param _baseAssetAmount base asset amount
     * @return quote asset amount
     */
    function getBasePrice(Dir _dirOfBase, uint256 _baseAssetAmount) public view override returns (uint256) {
        return getBasePriceWithReserves(_dirOfBase, _baseAssetAmount, quoteAssetReserve, baseAssetReserve);
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
    function getReserve() public view returns (uint256, uint256) {
        return (quoteAssetReserve, baseAssetReserve);
    }

    function getSnapshotLen() public view returns (uint256) {
        return reserveSnapshots.length;
    }

    function getCumulativeNotional() public view override returns (int256) {
        return cumulativeNotional;
    }

    function getSettlementPrice() public view override returns (uint256) {
        return settlementPrice;
    }

    // // DEPRECATED only for backward compatibility before we upgrade ClearingHouse
    // function getBaseAssetDeltaThisFundingPeriod() external view override returns (int256) {
    //     return baseAssetDeltaThisFundingPeriod;
    // }

    function getMaxHoldingBaseAsset() public view override returns (uint256) {
        return maxHoldingBaseAsset;
    }

    function getOpenInterestNotionalCap() public view override returns (uint256) {
        return openInterestNotionalCap;
    }

    function getBaseAssetDelta() public view override returns (int256) {
        return longPositionSize.toInt() - shortPositionSize.toInt();
    }

    function isOverSpreadLimit()
        public
        view
        override
        returns (
            bool result,
            uint256 marketPrice,
            uint256 oraclePrice
        )
    {
        oraclePrice = getUnderlyingPrice();
        require(oraclePrice > 0, "AMM_ZOP"); //zero oracle price
        marketPrice = getSpotPrice();
        uint256 oracleSpreadRatioAbs = (marketPrice.toInt() - oraclePrice.toInt()).divD(oraclePrice.toInt()).abs();

        result = oracleSpreadRatioAbs >= MAX_ORACLE_SPREAD_RATIO ? true : false;
    }

    // /**
    //  * @notice calculate total fee (including toll and spread) by input quoteAssetAmount
    //  * @param _quoteAssetAmount quoteAssetAmount
    //  * @return total tx fee
    //  */
    // function calcFee(uint256 _quoteAssetAmount) external view override returns (uint256, uint256) {
    //     if (_quoteAssetAmount == 0) {
    //         return (0, 0);
    //     }
    //     return (_quoteAssetAmount.mulD(tollRatio), _quoteAssetAmount.mulD(spreadRatio));
    // }

    /*       plus/minus 1 while the amount is not dividable
     *
     *        getQuotePrice                         getBasePrice
     *
     *     ＡＤＤ      (amount - 1)              (amount + 1)   ＲＥＭＯＶＥ
     *      ◥◤            ▲                         |             ◢◣
     *      ◥◤  ------->  |                         ▼  <--------  ◢◣
     *    -------      -------                   -------        -------
     *    |  Q  |      |  B  |                   |  Q  |        |  B  |
     *    -------      -------                   -------        -------
     *      ◥◤  ------->  ▲                         |  <--------  ◢◣
     *      ◥◤            |                         ▼             ◢◣
     *   ＲＥＭＯＶＥ  (amount + 1)              (amount - 1)      ＡＤＤ
     **/

    function getQuotePriceWithReserves(
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
        require(quoteAssetAfter != 0, "AMM_ZQAA"); //zero quote asset after

        baseAssetAfter = Math.mulDiv(_quoteAssetPoolAmount, _baseAssetPoolAmount, quoteAssetAfter, Math.Rounding.Up);
        baseAssetBought = (baseAssetAfter.toInt() - _baseAssetPoolAmount.toInt()).abs();

        // // if the amount is not dividable, return 1 wei less for trader
        // if (mulmod(_quoteAssetPoolAmount, _baseAssetPoolAmount, quoteAssetAfter) != 0) {
        //     if (isAddToAmm) {
        //         baseAssetBought = baseAssetBought - 1;
        //     } else {
        //         baseAssetBought = baseAssetBought + 1;
        //     }
        // }

        return baseAssetBought;
    }

    function getBasePriceWithReserves(
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
        require(baseAssetAfter != 0, "AMM_ZBAA"); //zero base asset after

        quoteAssetAfter = Math.mulDiv(_quoteAssetPoolAmount, _baseAssetPoolAmount, baseAssetAfter, Math.Rounding.Up);
        quoteAssetSold = (quoteAssetAfter.toInt() - _quoteAssetPoolAmount.toInt()).abs();

        // // if the amount is not dividable, return 1 wei less for trader
        // if (mulmod(_quoteAssetPoolAmount, _baseAssetPoolAmount, baseAssetAfter) != 0) {
        //     if (isAddToAmm) {
        //         quoteAssetSold = quoteAssetSold - 1;
        //     } else {
        //         quoteAssetSold = quoteAssetSold + 1;
        //     }
        // }

        return quoteAssetSold;
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
        uint256 _quoteAssetReserve = quoteAssetReserve;
        uint256 _baseAssetReserve = baseAssetReserve;
        // check if it's over fluctuationLimitRatio
        // this check should be before reserves being updated
        _checkIsOverBlockFluctuationLimit(
            _dirOfQuote,
            _quoteAssetAmount,
            _baseAssetAmount,
            _quoteAssetReserve,
            _baseAssetReserve,
            _canOverFluctuationLimit
        );

        if (_dirOfQuote == Dir.ADD_TO_AMM) {
            require(_baseAssetReserve.mulD(tradeLimitRatio) >= _baseAssetAmount, "AMM_OTL"); //over trading limit
            quoteAssetReserve = _quoteAssetReserve + _quoteAssetAmount;
            baseAssetReserve = _baseAssetReserve - _baseAssetAmount;
            cumulativeNotional = cumulativeNotional + _quoteAssetAmount.toInt();
        } else {
            require(_quoteAssetReserve.mulD(tradeLimitRatio) >= _quoteAssetAmount, "AMM_OTL"); //over trading limit
            quoteAssetReserve = _quoteAssetReserve - _quoteAssetAmount;
            baseAssetReserve = _baseAssetReserve + _baseAssetAmount;
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
                    getQuotePriceWithReserves(
                        params.asset.dir,
                        params.asset.assetAmount,
                        snapshot.quoteAssetReserve,
                        snapshot.baseAssetReserve
                    );
            } else if (params.asset.inOrOut == QuoteAssetDir.QUOTE_OUT) {
                return
                    getBasePriceWithReserves(
                        params.asset.dir,
                        params.asset.assetAmount,
                        snapshot.quoteAssetReserve,
                        snapshot.baseAssetReserve
                    );
            }
        }
        revert("AMM_NOMP"); //not supported option for market price for a specific snapshot
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
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
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

        uint256 price = _quoteAssetReserve.divD(_baseAssetReserve);
        require(price <= upperLimit && price >= lowerLimit, "AMM_POFL"); //price is already over fluctuation limit

        if (!_canOverFluctuationLimit) {
            price = (_dirOfQuote == Dir.ADD_TO_AMM)
                ? (_quoteAssetReserve + _quoteAssetAmount).divD(_baseAssetReserve - _baseAssetAmount)
                : (_quoteAssetReserve - _quoteAssetAmount).divD(_baseAssetReserve + _baseAssetAmount);
            require(price <= upperLimit && price >= lowerLimit, "AMM_POFL"); //price is over fluctuation limit
        }
    }

    function _implShutdown() internal {
        uint256 _quoteAssetReserve = quoteAssetReserve;
        uint256 _baseAssetReserve = baseAssetReserve;
        int256 _totalPositionSize = getBaseAssetDelta();
        uint256 initBaseReserve = (_totalPositionSize + _baseAssetReserve.toInt()).abs();
        if (initBaseReserve > IGNORABLE_DIGIT_FOR_SHUTDOWN) {
            uint256 initQuoteReserve = Math.mulDiv(_quoteAssetReserve, _baseAssetReserve, initBaseReserve);
            int256 positionNotionalValue = initQuoteReserve.toInt() - _quoteAssetReserve.toInt();
            // if total position size less than IGNORABLE_DIGIT_FOR_SHUTDOWN, treat it as 0 positions due to rounding error
            if (_totalPositionSize.toUint() > IGNORABLE_DIGIT_FOR_SHUTDOWN) {
                settlementPrice = positionNotionalValue.abs().divD(_totalPositionSize.abs());
            }
        }
        open = false;
        emit Shutdown(settlementPrice);
    }
}
