import { expect, use } from "chai";
import { Signer, BigNumber } from "ethers";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
import {
  AmmFake,
  ClearingHouseFake,
  ClearingHouseViewer,
  ERC20Fake,
  InsuranceFundFake,
  TraderWallet__factory,
  TraderWallet,
  L2PriceFeedMock,
} from "../../../typechain-types";
import { PnlCalcOption, Side } from "../../../utils/contract";
import { fullDeploy } from "../../../utils/deploy";
import { toFullDigitBN } from "../../../utils/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ClearingHouse Test", () => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let relayer: SignerWithAddress;

  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let mockPriceFeed!: L2PriceFeedMock;
  let clearingHouse: ClearingHouseFake;
  let clearingHouseViewer: ClearingHouseViewer;

  let traderWallet1: TraderWallet;
  let traderWallet2: TraderWallet;

  async function gotoNextFundingTime(): Promise<void> {
    const nextFundingTime = await amm.nextFundingTime();
    await amm.mock_setBlockTimestamp(nextFundingTime);
  }

  async function forwardBlockTimestamp(time: number): Promise<void> {
    const now = await amm.mock_getCurrentTimestamp();
    const newTime = now.add(time);
    await amm.mock_setBlockTimestamp(newTime);
    await clearingHouse.mock_setBlockTimestamp(newTime);
    const movedBlocks = time / 15 < 1 ? 1 : time / 15;

    const blockNumber = await amm.mock_getCurrentBlockNumber();
    const newBlockNumber = blockNumber.add(movedBlocks);
    await amm.mock_setBlockNumber(newBlockNumber);
    await clearingHouse.mock_setBlockNumber(newBlockNumber);
  }

  async function endEpoch(): Promise<void> {
    //await forwardBlockTimestamp((await supplySchedule.mintDuration()).toNumber())
    //await minter.mintReward()
  }

  async function approve(account: Signer, spender: string, amount: number): Promise<void> {
    await quoteToken.connect(account).approve(spender, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function transfer(from: Signer, to: string, amount: number): Promise<void> {
    await quoteToken.connect(from).transfer(to, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  function toBytes32(str: string): string {
    const paddingLen = 32 - str.length;
    const hex = ethers.utils.formatBytes32String(str);
    return hex + "00".repeat(paddingLen);
  }

  async function syncAmmPriceToOracle() {
    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setPrice(marketPrice);
  }

  async function deployEnvFixture() {
    const account = await ethers.getSigners();
    admin = account[0];
    alice = account[1];
    bob = account[2];
    carol = account[3];
    relayer = account[4];

    const contracts = await fullDeploy({ sender: admin });
    amm = contracts.amm;
    insuranceFund = contracts.insuranceFund;
    quoteToken = contracts.quoteToken;
    mockPriceFeed = contracts.priceFeed;
    clearingHouse = contracts.clearingHouse;
    clearingHouseViewer = contracts.clearingHouseViewer;

    // Each of Alice & Bob have 5000 DAI
    await quoteToken.transfer(alice.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(bob.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(insuranceFund.address, toFullDigitBN(5000, +(await quoteToken.decimals())));

    await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));
    await amm.setAdjustable(true);
    await amm.setCanLowerK(true);

    await syncAmmPriceToOracle();
  }

  beforeEach(async () => {
    await loadFixture(deployEnvFixture);
  });

  describe("repeg test", () => {
    describe("when open position not to make mark-oracle divergence exceeds", () => {
      // B = 100, Q = 1000
      it("repeg doesn't occur", async () => {
        await approve(alice, clearingHouse.address, 1);
        const tx = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(1), toFullDigitBN(10), toFullDigitBN(150));
        // B = 101.0101, Q = 990
        expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(990));
        expect(await amm.baseAssetReserve()).eql(toFullDigitBN(100000).mul(toFullDigitBN(1)).div(toFullDigitBN(990)).add(1));
        await expect(tx).to.not.emit(clearingHouse, "Repeg");
      });
    });
    describe("when open short position to make mark-oracle divergence exceeds down", () => {
      describe("when clearing house has sufficient token", () => {
        beforeEach(async () => {
          await quoteToken.transfer(clearingHouse.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
        });
        it("repeg occurs with profit of insurance funding", async () => {
          // given alice takes 10x short position (size: -150) with 60 margin
          await approve(alice, clearingHouse.address, 60);
          const tx = await clearingHouse
            .connect(alice)
            .openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
          // B = 250, Q = 2500
          expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(2500));
          expect(await amm.baseAssetReserve()).eql(toFullDigitBN(250));
          await expect(tx)
            .to.emit(clearingHouse, "Repeg")
            .withArgs(amm.address, toFullDigitBN(2500), toFullDigitBN(250), toFullDigitBN(-3150));
          expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
        });
        it("should not be able to close position because of bad debt", async () => {
          await approve(alice, clearingHouse.address, 60);
          await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
          await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("bad debt");
        });
        it("should not be able to liquidate by trader", async () => {
          await approve(alice, clearingHouse.address, 60);
          await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
          await expect(clearingHouse.connect(bob).liquidate(amm.address, alice.address)).to.be.revertedWith("not backstop LP");
        });
        it("should be able to liquidate by backstop and repeg occurs with cost 0", async () => {
          await approve(alice, clearingHouse.address, 60);
          await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
          expect(await quoteToken.balanceOf(clearingHouse.address)).eql(toFullDigitBN(5060));
          expect(await quoteToken.balanceOf(insuranceFund.address)).eql(toFullDigitBN(5000));
          expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          await clearingHouse.setBackstopLiquidityProvider(bob.address, true);
          await clearingHouse.connect(bob).liquidate(amm.address, alice.address);
          expect(await quoteToken.balanceOf(clearingHouse.address)).eql(toFullDigitBN(8150.0));
          expect(await quoteToken.balanceOf(insuranceFund.address)).eql(toFullDigitBN(1816.25));
          expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          expect(await quoteToken.balanceOf(bob.address)).eql(toFullDigitBN(5093.75));
        });
      });
      describe("when clearing house has insufficient token", () => {
        it("repeg occurs with profit of insurance funding, same as the balance of clearing house", async () => {
          await approve(alice, clearingHouse.address, 60);
          const tx = await clearingHouse
            .connect(alice)
            .openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
          // B = 250, Q = 2500
          expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(2500));
          expect(await amm.baseAssetReserve()).eql(toFullDigitBN(250));
          await expect(tx)
            .to.emit(clearingHouse, "Repeg")
            .withArgs(amm.address, toFullDigitBN(2500), toFullDigitBN(250), toFullDigitBN(-3150));
          expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
        });
        it("should not be able to close position because of bad debt", async () => {
          await approve(alice, clearingHouse.address, 60);
          await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
          await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("bad debt");
        });
        it("should not be able to liquidate by trader", async () => {
          await approve(alice, clearingHouse.address, 60);
          await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
          await expect(clearingHouse.connect(bob).liquidate(amm.address, alice.address)).to.be.revertedWith("not backstop LP");
        });
        it("should be able to liquidate by backstop and repeg occurs with cost 0", async () => {
          await approve(alice, clearingHouse.address, 60);
          await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
          expect(await quoteToken.balanceOf(clearingHouse.address)).eql(toFullDigitBN(60));
          expect(await quoteToken.balanceOf(insuranceFund.address)).eql(toFullDigitBN(5000));
          expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          await clearingHouse.setBackstopLiquidityProvider(bob.address, true);
          await clearingHouse.connect(bob).liquidate(amm.address, alice.address);
          expect(await quoteToken.balanceOf(clearingHouse.address)).eql(toFullDigitBN(3150.0));
          expect(await quoteToken.balanceOf(insuranceFund.address)).eql(toFullDigitBN(1816.25));
          expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          expect(await quoteToken.balanceOf(bob.address)).eql(toFullDigitBN(5093.75));
        });
      });
    });
    describe("when open long position to make mark-oracle divergence exceeds up", () => {
      it("repeg occurs with profit of insurance funding", async () => {
        await approve(alice, clearingHouse.address, 200);
        const tx = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0));
        expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(500));
        expect(await amm.baseAssetReserve()).eql(toFullDigitBN(50));
        await expect(tx).to.emit(clearingHouse, "Repeg").withArgs(amm.address, toFullDigitBN(500), toFullDigitBN(50), toFullDigitBN(-750));
        expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(750));
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(750));
      });
      it("should not be able to close position because of bad debt", async () => {
        await approve(alice, clearingHouse.address, 200);
        await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0));
        await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("bad debt");
      });
      it("should not be able to liquidate by trader", async () => {
        await approve(alice, clearingHouse.address, 200);
        await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0));
        await expect(clearingHouse.connect(bob).liquidate(amm.address, alice.address)).to.be.revertedWith("not backstop LP");
      });
      it("should be able to liquidate by backstop and repeg occurs with cost 0", async () => {
        await clearingHouse.setLiquidationFeeRatio(toFullDigitBN(0.01));
        await approve(alice, clearingHouse.address, 200);
        await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0));
        // B = 50, Q = 500
        expect(await quoteToken.balanceOf(clearingHouse.address)).eql(toFullDigitBN(100));
        expect(await quoteToken.balanceOf(insuranceFund.address)).eql(toFullDigitBN(5000));
        expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(750));
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(750));
        await clearingHouse.setBackstopLiquidityProvider(bob.address, true);
        await clearingHouse.connect(bob).liquidate(amm.address, alice.address);
        expect(await quoteToken.balanceOf(clearingHouse.address)).eql(toFullDigitBN(750.0));
        expect(await quoteToken.balanceOf(insuranceFund.address)).eql(toFullDigitBN(4348.75));
        expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(750));
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(750));
        expect(await quoteToken.balanceOf(bob.address)).eql(toFullDigitBN(5001.25));
        expect(await amm.baseAssetReserve()).eql(toFullDigitBN(100));
        expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(1000));
      });
    });
    describe("when open short position to make mark-oracle divergence exceeds up", () => {
      describe("when total fee is not enough for charging repegging cost", () => {
        it("scale down reserves by 0.1%", async () => {
          amm.setSpreadRatio(toFullDigitBN(0.5));
          mockPriceFeed.setPrice(toFullDigitBN(1));
          await approve(alice, clearingHouse.address, 360);
          const tx = await clearingHouse
            .connect(alice)
            .openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(0));
          expect(await quoteToken.balanceOf(alice.address)).eq(toFullDigitBN(4640));
          await expect(tx)
            .emit(clearingHouse, "Repeg")
            .withArgs(amm.address, toFullDigitBN(400 * 0.999), toFullDigitBN(250 * 0.999), "-902255639097744360");
        });
      });
    });
  });

  describe("k-adjustment test when payFunding: when alice.size = 37.5 & bob.size = -137.5", () => {
    beforeEach(async () => {
      // given alice takes 2x long position (37.5B) with 300 margin
      await approve(alice, clearingHouse.address, 600);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(300), toFullDigitBN(2), toFullDigitBN(37.5));
      // repeg occurs so that B = 62.5, Q = 625

      // given bob takes 1x short position (-137.5B) with 429.6875 margin
      await approve(bob, clearingHouse.address, 500);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(429.6875), toFullDigitBN(1), toFullDigitBN(500));
      // repeg occurs so that B = 200, Q = 2000

      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 300 (alice's margin) + 429.6875 (bob' margin)  = 729.6875
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(729.6875));
    });

    describe("when oracle twap is higher than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(10.1));
      });
      it("should increase k because funding payment is positive", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eq(toFullDigitBN(2170.3125));
        // funding imbalance cost = 10
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(-0.1));
        const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
        const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
        expect(Number(baseAssetReserve) / 200).above(1);
        expect(Number(quoteAssetReserve) / 200).above(1);
        expect(Number(quoteAssetReserve) / Number(baseAssetReserve)).eq(10);
      });
    });

    describe("when oracle twap is lower than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(9.9));
      });
      it("k-adjustment doesn't occur because funding cost is negative and it's absolute value is smaller than net revenue", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eq(toFullDigitBN(2170.3125));
        // funding imbalance cost = -10
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(0.1));
        const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
        const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
        expect(Number(baseAssetReserve)).eq(200);
        expect(Number(quoteAssetReserve)).eq(2000);
      });
    });
  });

  describe("k-adjustment test when payFunding: when alice.size = 37.5 & bob.size = -17.5", () => {
    beforeEach(async () => {
      // given alice takes 2x long position (37.5B) with 300 margin
      await approve(alice, clearingHouse.address, 600);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(300), toFullDigitBN(2), toFullDigitBN(37.5));
      // repeg occurs so that B = 62.5, Q = 625

      // given bob takes 1x short position (-17.5B) with 136.71875 margin
      await approve(bob, clearingHouse.address, 500);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(136.71875), toFullDigitBN(1), toFullDigitBN(500));
      // repeg occurs so that B = 80, Q = 800

      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 300 (alice's margin) + 136.71875 (bob' margin) = 436.71875
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(436.71875));
    });

    describe("when oracle twap is higher than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(10.1));
      });
      it("k-adjustment doesn't occur because funding cost is negative and it's absolute value is smaller than revenue since last funding", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eq(toFullDigitBN(303.28125));
        // funding imbalance cost = -2
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(-0.1));
        const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
        const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
        expect(Number(baseAssetReserve)).eq(80);
        expect(Number(quoteAssetReserve)).eq(800);
      });
    });

    describe("when oracle twap is lower than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(9.9));
      });
      it("should increase k because funding payment is positive", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eq(toFullDigitBN(303.28125));
        // funding imbalance cost = 2
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(0.1));
        const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
        const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
        expect(Number(baseAssetReserve) / 80).above(1);
        expect(Number(quoteAssetReserve) / 800).above(1);
        expect(Number(quoteAssetReserve) / Number(baseAssetReserve)).eq(10);
      });
    });
  });

  describe("k-adjustment test when payFunding: when alice.size = 0.019996 & bob.size = -0.009997", () => {
    let quoteAssetReserveBefore: BigNumber;
    let baseAssetReserveBefore: BigNumber;
    beforeEach(async () => {
      // given alice takes 2x long position (0.019996B) with 0.1 margin
      await approve(alice, clearingHouse.address, 1);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(0.1), toFullDigitBN(2), toFullDigitBN(0));
      // B = 99.98000399920016, Q = 1000.2.

      // given bob takes 1x short position (-0.009997B) with 0.1 margin
      await approve(bob, clearingHouse.address, 500);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(0.1), toFullDigitBN(1), toFullDigitBN(0));
      // B = 99.99000099990001, Q = 1000.1
      baseAssetReserveBefore = await amm.baseAssetReserve();
      quoteAssetReserveBefore = await amm.quoteAssetReserve();
      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 0.1 (alice's margin) + 0.1 (bob' margin) = 0.2
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(0.2));
    });

    describe("when oracle twap is higher than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(10.1));
      });
      it("decrease K because funding cost is negative and it's absolute value is greater than revenue since last funding", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eq(toFullDigitBN(0));
        await clearingHouse.payFunding(amm.address);
        const fraction = await clearingHouse.getLatestCumulativePremiumFraction(amm.address);
        const positionSize = await amm.getBaseAssetDelta();
        expect(fraction.mul(positionSize)).below(toFullDigitBN(0));
        const baseAssetReserve = await amm.baseAssetReserve();
        const quoteAssetReserve = await amm.quoteAssetReserve();
        expect(baseAssetReserve.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).below(toFullDigitBN(1));
        expect(quoteAssetReserve.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).below(toFullDigitBN(1));
        expect(baseAssetReserve.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).eq(
          quoteAssetReserve.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)
        );
      });
    });

    describe("when oracle twap is lower than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(9.9));
      });
      it("decrease K because total position size is positive and oracle > mark", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eq(toFullDigitBN(0));
        await clearingHouse.payFunding(amm.address);
        const baseAssetReserve = await amm.baseAssetReserve();
        const quoteAssetReserve = await amm.quoteAssetReserve();
        expect(baseAssetReserve.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).below(toFullDigitBN(1));
        expect(quoteAssetReserve.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).below(toFullDigitBN(1));
        expect(baseAssetReserve.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).eq(
          quoteAssetReserve.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)
        );
      });
    });
  });
});
