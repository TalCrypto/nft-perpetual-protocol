// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AmmFake } from "../../contracts/mock/AmmFake.sol";
import { ClearingHouseFake } from "../../contracts/mock/ClearingHouseFake.sol";
import { ClearingHouseViewer } from "../../contracts/ClearingHouseViewer.sol";
import { InsuranceFundFake } from "../../contracts/mock/InsuranceFundFake.sol";
import { L2PriceFeedMock } from "../../contracts/mock/L2PriceFeedMock.sol";
import { ERC20Fake } from "../../contracts/mock/ERC20Fake.sol";
import { IPriceFeed } from "../../contracts/interfaces/IPriceFeed.sol";
import { IAmm } from "../../contracts/interfaces/IAmm.sol";
import { IClearingHouse } from "../../contracts/interfaces/IClearingHouse.sol";
import { AmmMath } from "../../contracts/utils/AmmMath.sol";
import { UIntMath } from "../../contracts/utils/UIntMath.sol";
import { IntMath } from "../../contracts/utils/IntMath.sol";

contract CHFundingTest is Test {
    using UIntMath for uint256;
    using IntMath for int256;

    L2PriceFeedMock public priceFeed;
    ERC20Fake public token;
    AmmFake public amm;
    ClearingHouseFake public clearingHouse;
    ClearingHouseViewer clearingHouseViewer;
    InsuranceFundFake public insuranceFund;
    uint256 PRECISION = 1e9;
    address alice;
    address bob;

    function setUp() public {
        priceFeed = new L2PriceFeedMock(100 ether);

        token = new ERC20Fake();
        token.initializeERC20Fake(20000000 ether, "Test ETH", "TETH", 18);

        amm = new AmmFake(10000 ether, 100 ether, 0.9 ether, 3600, priceFeed, stringToBytes32("ETH"), address(token), 0, 0, 0);

        insuranceFund = new InsuranceFundFake();

        clearingHouse = new ClearingHouseFake(0.2 ether, 0.1 ether, 0.05 ether, insuranceFund, address(0));

        clearingHouseViewer = new ClearingHouseViewer(clearingHouse);

        insuranceFund.addAmm(amm);
        insuranceFund.setBeneficiary(address(clearingHouse));
        amm.setGlobalShutdown(address(insuranceFund));
        amm.setCounterParty(address(clearingHouse));
        amm.setOpen(true);

        alice = address(1);
        bob = address(2);

        token.transfer(alice, 5000000 ether);
        token.transfer(bob, 5000000 ether);
    }

    function testReserves() public {
        assertEq(amm.quoteAssetReserve(), 10000 ether);
        assertEq(amm.baseAssetReserve(), 100 ether);
    }

    function testNormalFundingWhenRevenue(
        uint256 _longPositionSize,
        uint256 _shortPositionSize,
        uint80 _budget
    ) public {
        vm.assume(_longPositionSize <= 90 ether);
        vm.assume(_shortPositionSize <= 90 ether);
        vm.assume(_longPositionSize > 0);
        vm.assume(_shortPositionSize > 0);
        amm.setFundingCostCoverRate(1 ether);
        amm.setFundingRevenueTakeRate(1 ether);
        token.approve(address(clearingHouse), _budget);
        clearingHouse.inject2InsuranceFund(amm, _budget);
        // alice opens a long position
        vm.prank(alice);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(alice);
        clearingHouse.openPosition(amm, IClearingHouse.Side.BUY, _longPositionSize, 5 ether, 0, false);
        // bob opens a short position
        vm.prank(bob);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(bob);
        clearingHouse.openPosition(amm, IClearingHouse.Side.SELL, _shortPositionSize, 5 ether, 0, false);

        IClearingHouse.Position memory alicePositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 vaultBefore = clearingHouse.vaults(address(amm));
        uint256 insuranceBudgetBefore = clearingHouse.insuranceBudgets(address(amm));

        moveToNextFundingTimestamp();
        clearingHouse.payFunding(amm);

        int256 fractionLong = clearingHouse.getLatestCumulativePremiumFractionLong(amm);
        int256 fractionShort = clearingHouse.getLatestCumulativePremiumFractionShort(amm);

        IClearingHouse.Position memory alicePositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 vaultAfter = clearingHouse.vaults(address(amm));
        uint256 insuranceBudgetAfter = clearingHouse.insuranceBudgets(address(amm));

        assertEq(int256(insuranceBudgetAfter) - int256(insuranceBudgetBefore), int256(vaultBefore) - int256(vaultAfter));
        // positive means revenue
        int256 systemFundingPayment = (alicePositionBefore.margin + bobPositionBefore.margin) -
            (alicePositionAfter.margin + bobPositionAfter.margin);

        assertEq(fractionLong, fractionShort, "funding premium fractions should be same between long and short");
        assertTrue(systemFundingPayment >= 0, "system funding payment should be revenue");
        assertTrue(
            (systemFundingPayment - int256(insuranceBudgetAfter) - int256(insuranceBudgetBefore)) < 1e2,
            "difference between actual and theoretical should be 0"
        );
    }

    function testNormalFundingWhenCost(
        uint256 _longPositionSize,
        uint256 _shortPositionSize,
        uint80 _budget
    ) public {
        vm.assume(_longPositionSize <= 90 ether);
        vm.assume(_shortPositionSize <= 90 ether);
        vm.assume(_longPositionSize > 0);
        vm.assume(_shortPositionSize > 0);
        amm.setFundingCostCoverRate(1 ether);
        amm.setFundingRevenueTakeRate(1 ether);
        token.approve(address(clearingHouse), _budget);
        clearingHouse.inject2InsuranceFund(amm, _budget);
        // alice opens a long position
        vm.prank(alice);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(alice);
        clearingHouse.openPosition(amm, IClearingHouse.Side.BUY, _longPositionSize, 5 ether, 0, false);
        // bob opens a short position
        vm.prank(bob);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(bob);
        clearingHouse.openPosition(amm, IClearingHouse.Side.SELL, _shortPositionSize, 5 ether, 0, false);

        uint256 marketTWAP = amm.getTwapPrice(3 * 3600);
        if (_longPositionSize > _shortPositionSize) {
            priceFeed.setTwapPrice((marketTWAP * 11) / 10);
        } else {
            priceFeed.setTwapPrice((marketTWAP * 9) / 10);
        }

        IClearingHouse.Position memory alicePositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 vaultBefore = clearingHouse.vaults(address(amm));
        uint256 insuranceBudgetBefore = clearingHouse.insuranceBudgets(address(amm));

        moveToNextFundingTimestamp();
        clearingHouse.payFunding(amm);

        int256 fractionLong = clearingHouse.getLatestCumulativePremiumFractionLong(amm);
        int256 fractionShort = clearingHouse.getLatestCumulativePremiumFractionShort(amm);

        assertEq(fractionLong, fractionShort);

        IClearingHouse.Position memory alicePositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 vaultAfter = clearingHouse.vaults(address(amm));
        uint256 insuranceBudgetAfter = clearingHouse.insuranceBudgets(address(amm));

        assertEq(int256(insuranceBudgetAfter) - int256(insuranceBudgetBefore), int256(vaultBefore) - int256(vaultAfter));

        int256 systemFundingPayment = (alicePositionBefore.margin + bobPositionBefore.margin) -
            (alicePositionAfter.margin + bobPositionAfter.margin);

        assertEq(fractionLong, fractionShort, "funding premium fractions should be same between long and short");
        assertTrue(systemFundingPayment <= 0, "system funding payment should be cost");
        assertTrue(
            (systemFundingPayment - int256(insuranceBudgetAfter) - int256(insuranceBudgetBefore)) < 1e2,
            "difference between actual and theoretical should be 0"
        );

        if (fractionLong == 0 && fractionShort == 0) {
            assertFalse(amm.open());
        }
    }

    function testDynamicFundingAsNotCoverTakeWhenCost(
        uint64 _longPositionSize,
        uint64 _shortPositionSize,
        uint80 _budget
    ) public {
        vm.assume(_longPositionSize > 1e9);
        vm.assume(_shortPositionSize > 1e9);
        amm.setFundingCostCoverRate(0 ether);
        amm.setFundingRevenueTakeRate(0 ether);
        token.approve(address(clearingHouse), _budget);
        clearingHouse.inject2InsuranceFund(amm, _budget);
        // alice opens a long position
        vm.prank(alice);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(alice);
        clearingHouse.openPosition(amm, IClearingHouse.Side.BUY, _longPositionSize, 5 ether, 0, false);
        // bob opens a short position
        vm.prank(bob);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(bob);
        clearingHouse.openPosition(amm, IClearingHouse.Side.SELL, _shortPositionSize, 5 ether, 0, false);

        assertEq(amm.longPositionSize(), _longPositionSize);
        assertEq(amm.shortPositionSize(), _shortPositionSize);

        uint256 marketTWAP = amm.getTwapPrice(3 * 3600);
        if (_longPositionSize > _shortPositionSize) {
            priceFeed.setTwapPrice((marketTWAP * 11) / 10);
        } else {
            priceFeed.setTwapPrice((marketTWAP * 9) / 10);
        }

        IClearingHouse.Position memory alicePositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 vaultBefore = clearingHouse.vaults(address(amm));
        uint256 insuranceBudgetBefore = clearingHouse.insuranceBudgets(address(amm));

        moveToNextFundingTimestamp();
        clearingHouse.payFunding(amm);

        IClearingHouse.Position memory alicePositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 vaultAfter = clearingHouse.vaults(address(amm));
        uint256 insuranceBudgetAfter = clearingHouse.insuranceBudgets(address(amm));

        int256 systemFundingPayment = (alicePositionBefore.margin + bobPositionBefore.margin) -
            (alicePositionAfter.margin + bobPositionAfter.margin);

        assertTrue(systemFundingPayment.abs() < 1e2, "system funding payment should be 0");
        assertEq(vaultAfter, vaultBefore);
        assertEq(insuranceBudgetAfter, insuranceBudgetBefore);
    }

    function testDynamicFundingAsNotCoverTakeWhenRevenue(
        uint64 _longPositionSize,
        uint64 _shortPositionSize,
        uint80 _budget
    ) public {
        vm.assume(_longPositionSize > 1e9);
        vm.assume(_shortPositionSize > 1e9);
        amm.setFundingCostCoverRate(0 ether);
        amm.setFundingRevenueTakeRate(0 ether);
        token.approve(address(clearingHouse), _budget);
        clearingHouse.inject2InsuranceFund(amm, _budget);
        // alice opens a long position
        vm.prank(alice);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(alice);
        clearingHouse.openPosition(amm, IClearingHouse.Side.BUY, _longPositionSize, 5 ether, 0, false);
        // bob opens a short position
        vm.prank(bob);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(bob);
        clearingHouse.openPosition(amm, IClearingHouse.Side.SELL, _shortPositionSize, 5 ether, 0, false);

        assertEq(amm.longPositionSize(), _longPositionSize);
        assertEq(amm.shortPositionSize(), _shortPositionSize);

        IClearingHouse.Position memory alicePositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 vaultBefore = clearingHouse.vaults(address(amm));
        uint256 insuranceBudgetBefore = clearingHouse.insuranceBudgets(address(amm));

        moveToNextFundingTimestamp();
        clearingHouse.payFunding(amm);

        IClearingHouse.Position memory alicePositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 vaultAfter = clearingHouse.vaults(address(amm));
        uint256 insuranceBudgetAfter = clearingHouse.insuranceBudgets(address(amm));

        int256 systemFundingPayment = (alicePositionBefore.margin + bobPositionBefore.margin) -
            (alicePositionAfter.margin + bobPositionAfter.margin);

        assertTrue(systemFundingPayment.abs() < 1e2, "system funding payment should be 0");
        assertEq(vaultAfter, vaultBefore);
        assertEq(insuranceBudgetAfter, insuranceBudgetBefore);
    }

    function testDynamicFundingAsTakeWhenRevenue(
        uint256 _longPositionSize,
        uint256 _shortPositionSize,
        uint80 _budget
    ) public {
        vm.assume(_longPositionSize <= 90 ether);
        vm.assume(_shortPositionSize <= 90 ether);
        vm.assume(_longPositionSize > 0);
        vm.assume(_shortPositionSize > 0);
        amm.setFundingCostCoverRate(1 ether);
        amm.setFundingRevenueTakeRate(0.75 ether);
        token.approve(address(clearingHouse), _budget);
        clearingHouse.inject2InsuranceFund(amm, _budget);
        // alice opens a long position
        vm.prank(alice);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(alice);
        clearingHouse.openPosition(amm, IClearingHouse.Side.BUY, _longPositionSize, 5 ether, 0, false);
        // bob opens a short position
        vm.prank(bob);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(bob);
        clearingHouse.openPosition(amm, IClearingHouse.Side.SELL, _shortPositionSize, 5 ether, 0, false);

        IClearingHouse.Position memory alicePositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 insuranceBudgetBefore = clearingHouse.insuranceBudgets(address(amm));

        moveToNextFundingTimestamp();
        clearingHouse.payFunding(amm);

        IClearingHouse.Position memory alicePositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 insuranceBudgetAfter = clearingHouse.insuranceBudgets(address(amm));

        // positive means revenue
        int256 systemFundingPayment = (alicePositionBefore.margin + bobPositionBefore.margin) -
            (alicePositionAfter.margin + bobPositionAfter.margin);

        assertTrue(systemFundingPayment >= 0, "system funding payment should be revenue");
        assertTrue(
            (systemFundingPayment - int256(insuranceBudgetAfter) - int256(insuranceBudgetBefore)) < 1e2,
            "difference between actual and theoretical should be 0"
        );
    }

    function testDynamicFundingAsTakeWhenRevenueWithDoublePay(
        uint256 _longPositionSize,
        uint256 _shortPositionSize,
        uint80 _budget
    ) public {
        vm.assume(_longPositionSize <= 90 ether);
        vm.assume(_shortPositionSize <= 90 ether);
        vm.assume(_longPositionSize > 0);
        vm.assume(_shortPositionSize > 0);
        amm.setFundingCostCoverRate(1 ether);
        amm.setFundingRevenueTakeRate(0.75 ether);
        token.approve(address(clearingHouse), _budget);
        clearingHouse.inject2InsuranceFund(amm, _budget);
        // alice opens a long position
        vm.prank(alice);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(alice);
        clearingHouse.openPosition(amm, IClearingHouse.Side.BUY, _longPositionSize, 5 ether, 0, false);
        // bob opens a short position
        vm.prank(bob);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(bob);
        clearingHouse.openPosition(amm, IClearingHouse.Side.SELL, _shortPositionSize, 5 ether, 0, false);

        moveToNextFundingTimestamp();
        clearingHouse.payFunding(amm);

        vm.prank(bob);
        clearingHouse.openPosition(amm, IClearingHouse.Side.SELL, _shortPositionSize, 5 ether, 0, false);

        IClearingHouse.Position memory alicePositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 insuranceBudgetBefore = clearingHouse.insuranceBudgets(address(amm));

        moveToNextFundingTimestamp();
        clearingHouse.payFunding(amm);

        IClearingHouse.Position memory alicePositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 insuranceBudgetAfter = clearingHouse.insuranceBudgets(address(amm));

        // positive means revenue
        int256 systemFundingPayment = (alicePositionBefore.margin + bobPositionBefore.margin) -
            (alicePositionAfter.margin + bobPositionAfter.margin);

        emit log_int(systemFundingPayment);

        assertTrue(systemFundingPayment >= 0, "system funding payment should be revenue");
        assertTrue(
            (systemFundingPayment - int256(insuranceBudgetAfter) - int256(insuranceBudgetBefore)) < 1e2,
            "difference between actual and theoretical should be 0"
        );
    }

    function testDynamicFundingAsCoverWhenCost(
        uint256 _longPositionSize,
        uint256 _shortPositionSize,
        uint80 _budget
    ) public {
        vm.assume(_longPositionSize <= 90 ether);
        vm.assume(_shortPositionSize <= 90 ether);
        vm.assume(_longPositionSize > 0);
        vm.assume(_shortPositionSize > 0);
        amm.setFundingCostCoverRate(1 ether);
        amm.setFundingRevenueTakeRate(0.75 ether);
        token.approve(address(clearingHouse), _budget);
        clearingHouse.inject2InsuranceFund(amm, _budget);
        // alice opens a long position
        vm.prank(alice);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(alice);
        clearingHouse.openPosition(amm, IClearingHouse.Side.BUY, _longPositionSize, 5 ether, 0, false);
        // bob opens a short position
        vm.prank(bob);
        token.approve(address(clearingHouse), type(uint256).max);
        vm.prank(bob);
        clearingHouse.openPosition(amm, IClearingHouse.Side.SELL, _shortPositionSize, 5 ether, 0, false);

        uint256 marketTWAP = amm.getTwapPrice(3 * 3600);
        if (_longPositionSize > _shortPositionSize) {
            priceFeed.setTwapPrice((marketTWAP * 11) / 10);
        } else {
            priceFeed.setTwapPrice((marketTWAP * 9) / 10);
        }

        IClearingHouse.Position memory alicePositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionBefore = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 insuranceBudgetBefore = clearingHouse.insuranceBudgets(address(amm));

        moveToNextFundingTimestamp();
        clearingHouse.payFunding(amm);

        IClearingHouse.Position memory alicePositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, alice);
        IClearingHouse.Position memory bobPositionAfter = clearingHouseViewer.getPersonalPositionWithFundingPayment(amm, bob);
        uint256 insuranceBudgetAfter = clearingHouse.insuranceBudgets(address(amm));

        // positive means revenue
        int256 systemFundingPayment = (alicePositionBefore.margin + bobPositionBefore.margin) -
            (alicePositionAfter.margin + bobPositionAfter.margin);

        assertTrue(systemFundingPayment <= 0, "system funding payment should be cost");
        assertTrue(
            (systemFundingPayment - int256(insuranceBudgetAfter) - int256(insuranceBudgetBefore)) < 1e2,
            "difference between actual and theoretical should be 0"
        );
    }

    function moveToNextFundingTimestamp() private {
        amm.mock_setBlockTimestamp(amm.mock_getCurrentTimestamp() + 3600);
        clearingHouse.mock_setBlockNumber(clearingHouse.mock_getCurrentBlockNumber() + 1);
        priceFeed.setLatestTimestamp(amm.mock_getCurrentTimestamp() + 3600);
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
