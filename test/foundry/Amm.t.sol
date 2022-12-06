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
    }

    function testReserves() public {
        assertEq(amm.quoteAssetReserve(), 10000 ether);
        assertEq(amm.baseAssetReserve(), 100 ether);
    }

    function testKAdjutment(int96 _totalPositionSize, int56 _budget) public {
        vm.assume(_budget != 0);
        int256 totalPositionSize = int256(_totalPositionSize);
        vm.assume(totalPositionSize < 90 ether);
        int256 budget = _budget * int256(PRECISION);
        vm.assume(budget.abs() < 10000 ether);
        if (totalPositionSize > 0) {
            amm.swapOutput(IAmm.Dir.REMOVE_FROM_AMM, uint256(totalPositionSize), true);
        } else {
            amm.swapOutput(IAmm.Dir.ADD_TO_AMM, uint256(-totalPositionSize), true);
        }
        (uint256 oldQReserve, uint256 oldBReserve) = amm.getReserve();
        (bool isAdjustable, int256 cost, uint256 newQReserve, uint256 newBReserve) = amm.getFormulaicUpdateKResult(int256(budget));
        if (budget >= 0) {
            // #long > #short
            assertTrue(isAdjustable);
            // increase K
            assertGe(newQReserve, oldQReserve, "not quote increase");
            assertGe(newBReserve, oldBReserve, "not base increase");
            // max increase 100.1%
            assertLe(newQReserve * 1 ether, oldQReserve * 1.001 ether, "exceeds quote increase limit");
            assertLe(newBReserve * 1 ether, oldBReserve * 1.001 ether, "exceeds base increase limit");
            assertLe(cost / int256(PRECISION), budget / int256(PRECISION), "bigger than positive budget");
        } else {
            // #long < #short
            assertTrue(isAdjustable);
            // decrease K
            assertLe(newQReserve, oldQReserve, "not quote decrease");
            assertLe(newBReserve, oldBReserve, "not base decrease");
            // max decrease 99.9%
            assertGe((newQReserve + 1) * 1 ether, oldQReserve * 0.999 ether, "exceeds quote decrease limit");
            assertGe((newBReserve + 1) * 1 ether, oldBReserve * 0.999 ether, "exceeds base decrease limit");
            assertGe(cost / int256(PRECISION), budget / int256(PRECISION), "smaller than negative budget");
        }

        // cost correctness
        if (totalPositionSize > 0) {
            uint256 notionalBefore = amm.getOutputPrice(IAmm.Dir.ADD_TO_AMM, totalPositionSize.abs());
            amm.adjust(newQReserve, newBReserve);
            uint256 notionalAfter = amm.getOutputPrice(IAmm.Dir.ADD_TO_AMM, totalPositionSize.abs());
            assertEq(cost, notionalAfter.toInt() - notionalBefore.toInt(), "cost calculation incorrect when #long>#short");
        } else {
            uint256 notionalBefore = amm.getOutputPrice(IAmm.Dir.REMOVE_FROM_AMM, totalPositionSize.abs());
            amm.adjust(newQReserve, newBReserve);
            uint256 notionalAfter = amm.getOutputPrice(IAmm.Dir.REMOVE_FROM_AMM, totalPositionSize.abs());
            assertEq(cost, notionalBefore.toInt() - notionalAfter.toInt(), "cost calculation incorrect when #long<#short");
        }
    }

    function testRepeg(
        int96 _totalPositionSize,
        uint40 _targetPrice,
        bool budgetIsEnough
    ) public {
        uint256 targetPrice = uint256(_targetPrice) * PRECISION;
        priceFeed.setTwapPrice(targetPrice);
        int256 totalPositionSize = int256(_totalPositionSize);
        vm.assume(totalPositionSize.abs() < 90 ether);
        vm.assume(targetPrice > 1e15);
        uint256 budget = budgetIsEnough ? type(uint256).max : 0;
        if (totalPositionSize > 0) {
            amm.swapOutput(IAmm.Dir.REMOVE_FROM_AMM, uint256(totalPositionSize), true);
        } else {
            amm.swapOutput(IAmm.Dir.ADD_TO_AMM, uint256(-totalPositionSize), true);
        }
        (uint256 oldQReserve, uint256 oldBReserve) = amm.getReserve();
        uint256 spotPrice = amm.getSpotPrice();
        (bool isAdjustable, int256 cost, uint256 newQReserve, uint256 newBReserve) = amm.getFormulaicRepegResult(budget, false);
        if (totalPositionSize > 0) {
            // #long > #short
            if (targetPrice * 900 > spotPrice * 1000) {
                // target price is bigger than spot price and exceeds spread limit 10%
                assertGt(cost, 0, "cost is not positive"); // there is a cost to system
                if (budget == 0) {
                    assertFalse(isAdjustable);
                    assertApproxEqRel(newQReserve, newBReserve.mulD(targetPrice), 1e10, "wrong repeg");
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                } else {
                    assertTrue(isAdjustable);
                    assertApproxEqRel(newQReserve, newBReserve.mulD(targetPrice), 1e10, "wrong repeg");
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                }
            } else if (targetPrice * 11 < spotPrice * 10) {
                // target price is smaller than spot price and exceeds spread limit 10%
                assertLt(cost, 0); // there is a revenue to system
                assertTrue(isAdjustable);
                assertApproxEqRel(newQReserve, newBReserve.mulD(targetPrice), 1e10, "wrong repeg");
                assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
            } else {
                assertFalse(isAdjustable);
            }
        } else if (totalPositionSize < 0) {
            // #long < #short
            if (targetPrice * 900 > spotPrice * 1000) {
                // target price is more than spot price and exceeds spread limit 10%
                assertLt(cost, 0, "cost is not negative"); // there is a revenue to system
                assertTrue(isAdjustable);
                assertApproxEqRel(newQReserve, newBReserve.mulD(targetPrice), 1e10, "wrong repeg");
                if (newBReserve != oldBReserve) {
                    // in case new base asset reserve is bigger than totalPositionSize.abs()
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                } else {
                    assertGt(newQReserve * newBReserve, oldQReserve * oldBReserve, "decrease K");
                }
            } else if (targetPrice * 11 < spotPrice * 10) {
                // target price is smaller than spot price and exceeds spread limit 10%
                assertGt(cost, 0); // there is a cost to system
                if (budget == 0) {
                    assertFalse(isAdjustable);
                    assertApproxEqRel(newQReserve, newBReserve.mulD(targetPrice), 1e10, "wrong repeg");
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                } else {
                    assertTrue(isAdjustable);
                    assertApproxEqRel(newQReserve, newBReserve.mulD(targetPrice), 1e10, "wrong repeg");
                    assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
                }
            } else {
                assertFalse(isAdjustable);
            }
        } else {
            // #long == #short
            if (targetPrice * 900 > spotPrice * 1000) {
                // target price is bigger than spot price and exceeds spread limit 10%
                assertEq(cost, 0, "cost is not zero"); // there is no cost
                assertTrue(isAdjustable, "not adjustable");
                assertApproxEqRel(newQReserve, newBReserve.mulD(targetPrice), 1e10, "wrong repeg");
                assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
            } else if (targetPrice * 11 < spotPrice * 10) {
                // target price is smaller than spot price and exceeds spread limit 10%
                assertEq(cost, 0, "cost is not zero"); // there is no cost
                assertTrue(isAdjustable, "not adjustable");
                assertApproxEqRel(newQReserve, newBReserve.mulD(targetPrice), 1e10, "wrong repeg");
                assertApproxEqRel(oldQReserve * oldBReserve, newQReserve * newBReserve, 1e10, "changed K");
            } else {
                assertFalse(isAdjustable);
            }
        }
    }

    function testSpecific() public {
        testRepeg(-30157829746910143156, 1099511627775, false);
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
