// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AmmFake } from "../../contracts/mock/AmmFake.sol";
import { L2PriceFeedMock } from "../../contracts/mock/L2PriceFeedMock.sol";
import { ERC20Fake } from "../../contracts/mock/ERC20Fake.sol";
import { IPriceFeed } from "../../contracts/interfaces/IPriceFeed.sol";
import { IAmm } from "../../contracts/interfaces/IAmm.sol";
import { AmmMath } from "../../contracts/utils/AmmMath.sol";
import { UIntMath } from "../../contracts/utils/UIntMath.sol";
import { IntMath } from "../../contracts/utils/IntMath.sol";

contract AmmTest is Test {
    using UIntMath for uint256;
    using IntMath for int256;

    L2PriceFeedMock public priceFeed;
    ERC20Fake public token;
    AmmFake public amm;
    uint256 PRECISION = 1e9;

    function setUp() public {
        priceFeed = new L2PriceFeedMock(100 ether);

        token = new ERC20Fake();
        token.initializeERC20Fake(20000000 ether, "Test ETH", "TETH", 18);

        amm = new AmmFake(10000 ether, 100 ether, 0.9 ether, 3600, priceFeed, stringToBytes32("ETH"), address(token), 0, 0, 0);
        amm.setCounterParty(address(this));
        amm.setOpen(true);
        amm.setAdjustable(true);
        amm.setCanLowerK(true);
        amm.mockSetSpreadCheck(true);
    }

    function testReserves() public {
        assertEq(amm.quoteAssetReserve(), 10000 ether);
        assertEq(amm.baseAssetReserve(), 100 ether);
    }

    function testKAdjutment(int96 _totalPositionSize, int56 _budget) public {
        int256 totalPositionSize = int256(_totalPositionSize);
        vm.assume(totalPositionSize <= 90 ether);
        vm.assume(totalPositionSize >= -900 ether);
        int256 budget = _budget * int256(PRECISION);
        vm.assume(budget.abs() < 10000 ether);
        if (totalPositionSize > 0) {
            amm.swapInput(IAmm.Dir.REMOVE_FROM_AMM, uint256(totalPositionSize), false, true);
        } else {
            amm.swapInput(IAmm.Dir.ADD_TO_AMM, uint256(-totalPositionSize), false, true);
        }
        (uint256 oldQReserve, uint256 oldBReserve) = amm.getReserve();
        (bool isAdjustable, int256 cost, uint256 newQReserve, uint256 newBReserve) = amm.getFormulaicUpdateKResult(int256(budget));
        if (budget > 0) {
            assertTrue(isAdjustable);
            // increase K
            assertGe(newQReserve, oldQReserve, "not quote increase");
            assertGe(newBReserve, oldBReserve, "not base increase");
            // max increase 100.5%
            assertLe(newQReserve.divD(oldQReserve), 1.005 ether, "exceeds quote increase limit");
            assertLe(newBReserve.divD(oldBReserve), 1.005 ether, "exceeds base increase limit");
            assertGe(cost, 0, "cost is not positive");
            assertLe(cost / int256(PRECISION), budget / int256(PRECISION), "bigger than positive budget");
        } else if (budget < 0) {
            assertTrue(isAdjustable);
            // decrease K
            assertLe(newQReserve, oldQReserve, "not quote decrease");
            assertLe(newBReserve, oldBReserve, "not base decrease");
            // max decrease 99%
            assertGe((newQReserve + 1).divD(oldQReserve), 0.99 ether, "exceeds quote decrease limit");
            assertGe((newBReserve + 1).divD(oldBReserve), 0.99 ether, "exceeds base decrease limit");
            assertLe(cost, 0, "cost is not negative");
            assertGe(cost / int256(PRECISION), budget / int256(PRECISION), "smaller than negative budget");
        } else {
            assertFalse(isAdjustable);
        }

        // cost correctness
        if (totalPositionSize > 0 && isAdjustable) {
            uint256 notionalBefore = amm.getBasePrice(IAmm.Dir.ADD_TO_AMM, totalPositionSize.abs());
            amm.adjust(newQReserve, newBReserve);
            uint256 notionalAfter = amm.getBasePrice(IAmm.Dir.ADD_TO_AMM, totalPositionSize.abs());
            assertEq(cost, notionalAfter.toInt() - notionalBefore.toInt(), "cost calculation incorrect when #long>#short");
        } else if (totalPositionSize < 0 && isAdjustable) {
            uint256 notionalBefore = amm.getBasePrice(IAmm.Dir.REMOVE_FROM_AMM, totalPositionSize.abs());
            amm.adjust(newQReserve, newBReserve);
            uint256 notionalAfter = amm.getBasePrice(IAmm.Dir.REMOVE_FROM_AMM, totalPositionSize.abs());
            assertEq(cost, notionalBefore.toInt() - notionalAfter.toInt(), "cost calculation incorrect when #long<#short");
        }
    }

    function testRepeg(
        int96 _totalPositionSize,
        uint40 _oraclePrice,
        bool budgetIsEnough
    ) public {
        uint256 oraclePrice = uint256(_oraclePrice) * PRECISION;
        priceFeed.setPrice(oraclePrice);
        int256 totalPositionSize = int256(_totalPositionSize);
        vm.assume(totalPositionSize <= 90 ether);
        vm.assume(totalPositionSize >= -900 ether);
        vm.assume(oraclePrice > 1e15);
        uint256 budget = budgetIsEnough ? type(uint256).max : 0;
        if (totalPositionSize > 0) {
            amm.swapInput(IAmm.Dir.REMOVE_FROM_AMM, uint256(totalPositionSize), false, true);
        } else {
            amm.swapInput(IAmm.Dir.ADD_TO_AMM, uint256(-totalPositionSize), false, true);
        }
        (uint256 oldQReserve, uint256 oldBReserve) = amm.getReserve();
        uint256 spotPrice = amm.getSpotPrice();
        (bool isAdjustable, int256 cost, uint256 newQReserve, uint256 newBReserve) = amm.repegCheck(budget);
        totalPositionSize == 0 ? assertTrue(isAdjustable) : assertFalse(isAdjustable);
        (isAdjustable, cost, newQReserve, newBReserve) = amm.repegCheck(budget);
        totalPositionSize == 0 ? assertTrue(isAdjustable) : assertFalse(isAdjustable);
        (isAdjustable, cost, newQReserve, newBReserve) = amm.repegCheck(budget);
        if (totalPositionSize > 0) {
            // #long > #short
            if (oraclePrice * 95 > spotPrice * 100) {
                // oracle price is bigger than spot price and exceeds spread limit 10%
                assertGt(cost, 0, "cost is not positive"); // there is a cost to system
                if (budget == 0) {
                    assertFalse(isAdjustable);
                    assertApproxEqRel(newQReserve, newBReserve.mulD(oraclePrice), 1e10, "wrong repeg");
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                } else {
                    assertTrue(isAdjustable);
                    assertApproxEqRel(newQReserve, newBReserve.mulD(oraclePrice), 1e10, "wrong repeg");
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                }
            } else if (oraclePrice * 105 < spotPrice * 100) {
                // oracle price is smaller than spot price and exceeds spread limit 10%
                assertLt(cost, 0); // there is a revenue to system
                assertTrue(isAdjustable);
                assertApproxEqRel(newQReserve, newBReserve.mulD(oraclePrice), 1e10, "wrong repeg");
                assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
            } else {
                assertFalse(isAdjustable);
            }
        } else if (totalPositionSize < 0) {
            // #long < #short
            if (oraclePrice * 95 > spotPrice * 100) {
                // oracle price is more than spot price and exceeds spread limit 10%
                assertLt(cost, 0, "cost is not negative"); // there is a revenue to system
                assertTrue(isAdjustable);
                assertApproxEqRel(newQReserve, newBReserve.mulD(oraclePrice), 1e10, "wrong repeg");
                if (newBReserve != oldBReserve) {
                    // in case new base asset reserve is bigger than totalPositionSize.abs()
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                } else {
                    assertGt(newQReserve * newBReserve, oldQReserve * oldBReserve, "decrease K");
                }
            } else if (oraclePrice * 105 < spotPrice * 100) {
                // oracle price is smaller than spot price and exceeds spread limit 10%
                assertGt(cost, 0); // there is a cost to system
                if (budget == 0) {
                    assertFalse(isAdjustable);
                    assertApproxEqRel(newQReserve, newBReserve.mulD(oraclePrice), 1e10, "wrong repeg");
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                } else {
                    assertTrue(isAdjustable);
                    assertApproxEqRel(newQReserve, newBReserve.mulD(oraclePrice), 1e10, "wrong repeg");
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                }
            } else {
                assertFalse(isAdjustable);
            }
        } else {
            // #long == #short
            assertEq(cost, 0, "cost is not zero"); // there is no cost
            assertTrue(isAdjustable, "not adjustable");
            assertApproxEqRel(newQReserve, newBReserve.mulD(oraclePrice), 1e10, "wrong repeg");
            assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
        }
        // cost correctness
        if (totalPositionSize > 0 && isAdjustable) {
            uint256 notionalBefore = amm.getBasePrice(IAmm.Dir.ADD_TO_AMM, totalPositionSize.abs());
            amm.adjust(newQReserve, newBReserve);
            uint256 notionalAfter = amm.getBasePrice(IAmm.Dir.ADD_TO_AMM, totalPositionSize.abs());
            assertEq(cost, notionalAfter.toInt() - notionalBefore.toInt(), "cost calculation incorrect when #long>#short");
        } else if (isAdjustable) {
            uint256 notionalBefore = amm.getBasePrice(IAmm.Dir.REMOVE_FROM_AMM, totalPositionSize.abs());
            amm.adjust(newQReserve, newBReserve);
            uint256 notionalAfter = amm.getBasePrice(IAmm.Dir.REMOVE_FROM_AMM, totalPositionSize.abs());
            assertEq(cost, notionalBefore.toInt() - notionalAfter.toInt(), "cost calculation incorrect when #long<#short");
        }
    }

    function testRepegFlag() public {
        uint256 spotPrice = amm.getSpotPrice();
        priceFeed.setPrice(spotPrice * 2);

        (bool isAdjustable, , , ) = amm.repegCheck(type(uint256).max);
        assertTrue(isAdjustable);

        amm.swapInput(IAmm.Dir.REMOVE_FROM_AMM, 1 ether, false, true);
        (isAdjustable, , , ) = amm.repegCheck(type(uint256).max);
        assertFalse(isAdjustable);
        (isAdjustable, , , ) = amm.repegCheck(type(uint256).max);
        assertTrue(isAdjustable);
        (isAdjustable, , , ) = amm.repegCheck(type(uint256).max);
        assertTrue(isAdjustable);

        priceFeed.setPrice(spotPrice);
        (isAdjustable, , , ) = amm.repegCheck(type(uint256).max);
        assertFalse(isAdjustable);
        (isAdjustable, , , ) = amm.repegCheck(type(uint256).max);
        assertFalse(isAdjustable);
    }

    function stringToBytes32(string memory source) public pure returns (bytes32 result) {
        bytes memory tempEmptyStringTest = bytes(source);
        if (tempEmptyStringTest.length == 0) {
            return 0x0;
        }

        assembly {
            result := mload(add(source, 32))
        }
    }
}
