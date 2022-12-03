// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "forge-std/Test.sol";
import "../../contracts/mock/AmmFake.sol";
import "../../contracts/mock/L2PriceFeedFake.sol";
import "../../contracts/mock/ERC20Fake.sol";
import "../../contracts/interfaces/IPriceFeed.sol";
import "../../contracts/interfaces/IAmm.sol";
import "../../contracts/utils/AmmMath.sol";

contract AmmTest is Test {
    IPriceFeed public priceFeed;
    ERC20Fake public token;
    AmmFake public amm;
    int256 PRECISION = 1e9;

    function setUp() public {
        priceFeed = new L2PriceFeedFake();

        token = new ERC20Fake();
        token.initializeERC20Fake(20000000 ether, "Test ETH", "TETH", 18);

        amm = new AmmFake(10000 ether, 100 ether, 0.9 ether, 3600, priceFeed, stringToBytes32("ETH"), address(token), 0, 0, 0);
        amm.setCounterParty(address(this));
        amm.setOpen(true);
        amm.setAdjustable(true);
        amm.setCanLowerK(true);
    }

    function testReservers() public {
        assertEq(amm.quoteAssetReserve(), 10000 ether);
        assertEq(amm.baseAssetReserve(), 100 ether);
    }

    function testKAdjutment(int56 _totalPositionSize, int48 _budget) public {
        vm.assume(_budget != 0);
        int256 totalPositionSize = _totalPositionSize * PRECISION;
        vm.assume(totalPositionSize < 90 ether);
        int256 budget = _budget * PRECISION;
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
            assertLe((newQReserve * 1 ether) / oldQReserve, 1.001 ether, "exceeds quote increase limit");
            assertLe((newBReserve * 1 ether) / oldBReserve, 1.001 ether, "exceeds base increase limit");
            assertLt(cost / PRECISION, budget, "bigger than positive budget");
        } else {
            // #long < #short
            assertTrue(isAdjustable);
            // decrease K
            assertLe(newQReserve, oldQReserve, "not quote decrease");
            assertLe(newBReserve, oldBReserve, "not base decrease");
            // max decrease 99.9%
            assertGe((newQReserve + 1) * 1 ether, oldQReserve * 0.999 ether, "exceeds quote decrease limit");
            assertGe((newBReserve + 1) * 1 ether, oldBReserve * 0.999 ether, "exceeds base decrease limit");
            assertGt(cost / PRECISION, budget, "smaller than negative budget");
        }
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
