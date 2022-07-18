import { expect, use } from "chai";
import { BigNumber } from "ethers";
import { ethers } from "hardhat";
import { Amm, AmmFake, ERC20Fake, L2PriceFeedMock } from "../../typechain-types";
import { solidity } from "ethereum-waffle";
import { deployAmm, deployErc20Fake, deployL2MockPriceFeed, deployProxyAmm, Dir } from "../helper/contract";
import { toFullDigitBN } from "../helper/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Amm Unit Test", () => {
  const ETH_PRICE = 100;

  let amm: Amm;
  let priceFeed: L2PriceFeedMock;
  let quoteToken: ERC20Fake;
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let fundingPeriod: BigNumber;
  let fundingBufferPeriod: BigNumber;

  async function moveToNextBlocks(number: number): Promise<void> {
    await ethers.provider.send("hardhat_mine", [`0x${number.toString(16)}`]);
  }

  async function forward(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    const movedBlocks = seconds / 15 < 1 ? 1 : seconds / 15;
    await moveToNextBlocks(movedBlocks);
  }

  async function deployEnvFixture() {
    const account = await ethers.getSigners();
    admin = account[0];
    alice = account[1];

    priceFeed = (await deployL2MockPriceFeed(admin, toFullDigitBN(ETH_PRICE))) as L2PriceFeedMock;
    quoteToken = (await deployErc20Fake(admin, toFullDigitBN(20000000))) as ERC20Fake;
    amm = await deployProxyAmm({
      deployer: admin,
      quoteAssetTokenAddr: quoteToken.address,
      priceFeedAddr: priceFeed.address,
      fluctuation: toFullDigitBN(0),
      fundingPeriod: BigNumber.from(3600), // 1 hour
    });
    await amm.setCounterParty(admin.address);
    await amm.setOpen(true);
    await amm.setAdjustable(true);
    await amm.setCanLowerK(true);
  }

  beforeEach(async () => {
    await loadFixture(deployEnvFixture);
  });

  describe("adjust function test", () => {
    it("should fail with 0 reserves", async () => {
      await expect(amm.adjust(toFullDigitBN(0), toFullDigitBN(10))).to.be.revertedWith("quote asset reserve cannot be 0");
      await expect(amm.adjust(toFullDigitBN(10), toFullDigitBN(0))).to.be.revertedWith("base asset reserve cannot be 0");
    });
    it("should success with valid reserve", async () => {
      await amm.adjust(toFullDigitBN(10), toFullDigitBN(20));
      expect(await amm.quoteAssetReserve()).to.be.equal(toFullDigitBN(10));
      expect(await amm.baseAssetReserve()).to.be.equal(toFullDigitBN(20));
      expect(await amm.getLiquidityHistoryLength()).equal(2);
      const liquidity = await amm.getLatestLiquidityChangedSnapshots();
      expect(liquidity.quoteAssetReserve).eql(toFullDigitBN(10));
      expect(liquidity.baseAssetReserve).eql(toFullDigitBN(20));
    });
  });

  describe("when disable formulaic adjustable for amm", () => {
    beforeEach(async () => {
      await amm.setAdjustable(false);
    });
    it("getFormulaicRepegResult returns not adjustable", async () => {
      const res = await amm.getFormulaicRepegResult(toFullDigitBN(10));
      expect(res.isAdjustable).to.be.false;
    });
    it("getFormulaicUpdateKResult returns not adjustable", async () => {
      const res = await amm.getFormulaicUpdateKResult(toFullDigitBN(10));
      expect(res.isAdjustable).to.be.false;
    });
  });

  describe("getFormulaicRepegResult function test", () => {
    describe("when there are more long open interests", () => {
      // B = 90, Q = 1111.11...11, position_size = 10, mark_price = 12.344
      const positionSize = toFullDigitBN(10);
      beforeEach(async () => {
        await amm.swapOutput(Dir.REMOVE_FROM_AMM, positionSize, 0);
      });

      describe("when oracle > mark and oracle-mark divergence exceeds limit 10%", () => {
        const oraclePrice = toFullDigitBN(50);
        beforeEach(async () => {
          //oracle_price = 12.3
          await priceFeed.setPrice(oraclePrice);
        });
        describe("when budget is enough", () => {
          const budget = toFullDigitBN(1000);
          it("should be updatable with positive cost smaller than budget", async () => {
            const res = await amm.getFormulaicRepegResult(budget);
            expect(res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(res.newBaseAssetReserve)).to.be.equal(oraclePrice);
            expect(res.isAdjustable).to.be.true;
            expect(res.cost).to.be.below(budget);
            expect(res.cost).to.be.above(toFullDigitBN(0));
          });
          it("cost should be the same as the difference of position notional values between after and before", async () => {
            const valueBefore = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
            const res = await amm.getFormulaicRepegResult(budget);
            await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
            const valueAfter = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
            expect(res.cost).to.be.equal(valueAfter.sub(valueBefore));
          });
        });
        describe("when budget is not enough", () => {
          const budget = toFullDigitBN(10);
          it("should be updatable with cost same as budget", async () => {
            const res = await amm.getFormulaicRepegResult(budget);
            expect(res.isAdjustable).to.be.true;
            expect(res.cost).to.be.equal(budget);
          });
          it("cost should be the same as the difference of position notional values between after and before", async () => {
            const valueBefore = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
            const res = await amm.getFormulaicRepegResult(budget);
            await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
            const valueAfter = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
            expect(res.cost).to.be.equal(valueAfter.sub(valueBefore));
          });
        });
      });
      describe("when oracle > mark and oracle-mark divergence doesn't exceed limit 10%", () => {
        const budget = toFullDigitBN(0);
        const oraclePrice = toFullDigitBN(12.4);
        beforeEach(async () => {
          //oracle_price = 12.3
          await priceFeed.setPrice(oraclePrice);
        });
        it("should not be updatable with cost 0", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.isAdjustable).to.be.false;
          expect(res.cost).to.be.equal(toFullDigitBN(0));
        });
      });
      describe("when oracle < mark and oracle-mark divergence exceeds limit 10%", () => {
        const oraclePrice = toFullDigitBN(5);
        const budget = toFullDigitBN(0);
        beforeEach(async () => {
          //oracle_price = 12.3
          await priceFeed.setPrice(oraclePrice);
        });
        it("should be updatable with negative cost", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(res.newBaseAssetReserve)).to.be.equal(oraclePrice);
          expect(res.isAdjustable).to.be.true;
          expect(res.cost).to.be.below(toFullDigitBN(0));
        });
        it("cost should be the same as the difference of position notional values between after and before", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          const res = await amm.getFormulaicRepegResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          expect(res.cost).to.be.equal(valueAfter.sub(valueBefore));
        });
      });
      describe("when oracle < mark and oracle-mark divergence doesn't exceed limit 10%", () => {
        const budget = toFullDigitBN(0);
        const oraclePrice = toFullDigitBN(12.3);
        beforeEach(async () => {
          //oracle_price = 12.3
          await priceFeed.setPrice(oraclePrice);
        });
        it("should not be updatable with cost 0", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.isAdjustable).to.be.false;
          expect(res.cost).to.be.equal(toFullDigitBN(0));
        });
      });
    });

    describe("when there are more short open interests", () => {
      // B = 110, Q = 909.0909, position_size = -10, mark_price = 8.264
      const positionSize = toFullDigitBN(10);
      beforeEach(async () => {
        await amm.swapOutput(Dir.ADD_TO_AMM, positionSize, 0);
      });

      describe("when oracle < mark and oracle-mark divergence exceeds limit 10%", () => {
        const oraclePrice = toFullDigitBN(4);
        beforeEach(async () => {
          //oracle_price = 12.3
          await priceFeed.setPrice(oraclePrice);
        });
        describe("when budget is enough", () => {
          const budget = toFullDigitBN(1000);
          it("should be updatable with positive cost smaller than budget", async () => {
            const res = await amm.getFormulaicRepegResult(budget);
            expect(res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(res.newBaseAssetReserve)).to.be.equal(oraclePrice);
            expect(res.isAdjustable).to.be.true;
            expect(res.cost).to.be.below(budget);
            expect(res.cost).to.be.above(toFullDigitBN(0));
          });
          it("cost should be the same as the difference of position notional values between after and before", async () => {
            const valueBefore = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
            const res = await amm.getFormulaicRepegResult(budget);
            await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
            const valueAfter = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
            expect(res.cost).to.be.equal(valueBefore.sub(valueAfter));
          });
        });
        describe("when budget is not enough", () => {
          const budget = toFullDigitBN(10);
          it("should be updatable with cost same as budget", async () => {
            const res = await amm.getFormulaicRepegResult(budget);
            expect(res.isAdjustable).to.be.true;
            expect(res.cost).to.be.equal(budget);
          });
          it("cost should be the same as the difference of position notional values between after and before", async () => {
            const valueBefore = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
            const res = await amm.getFormulaicRepegResult(budget);
            await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
            const valueAfter = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
            expect(res.cost).to.be.equal(valueBefore.sub(valueAfter));
          });
        });
      });
      describe("when oracle < mark and oracle-mark divergence doesn't exceed limit 10%", () => {
        const budget = toFullDigitBN(0);
        const oraclePrice = toFullDigitBN(8.2);
        beforeEach(async () => {
          //oracle_price = 12.3
          await priceFeed.setPrice(oraclePrice);
        });
        it("should not be updatable with cost 0", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.isAdjustable).to.be.false;
          expect(res.cost).to.be.equal(toFullDigitBN(0));
        });
      });
      describe("when oracle > mark and oracle-mark divergence exceeds limit 10%", () => {
        const oraclePrice = toFullDigitBN(20);
        const budget = toFullDigitBN(0);
        beforeEach(async () => {
          //oracle_price = 12.3
          await priceFeed.setPrice(oraclePrice);
        });
        it("should be updatable with negative cost", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(res.newBaseAssetReserve)).to.be.equal(oraclePrice);
          expect(res.isAdjustable).to.be.true;
          expect(res.cost).to.be.below(toFullDigitBN(0));
        });
        it("cost should be the same as the difference of position notional values between after and before", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          const res = await amm.getFormulaicRepegResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          expect(res.cost).to.be.equal(valueBefore.sub(valueAfter));
        });
      });
      describe("when oracle > mark and oracle-mark divergence doesn't exceed limit 10%", () => {
        const budget = toFullDigitBN(0);
        const oraclePrice = toFullDigitBN(8.3);
        beforeEach(async () => {
          //oracle_price = 12.3
          await priceFeed.setPrice(oraclePrice);
        });
        it("should not be updatable with cost 0", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.isAdjustable).to.be.false;
          expect(res.cost).to.be.equal(toFullDigitBN(0));
        });
      });
    });

    describe("when long open interests = short open interests", () => {
      // B = 100, Q = 1000, position_size = 0, mark_price = 10
      it("position size = 0", async () => {
        expect(await amm.getBaseAssetDelta()).to.be.equal(toFullDigitBN(0));
      });

      describe("when oracle < mark and oracle-mark divergence exceeds limit 10%", () => {
        const oraclePrice = toFullDigitBN(5);
        const budget = toFullDigitBN(0);
        beforeEach(async () => {
          await priceFeed.setPrice(oraclePrice);
        });
        it("should be updatable to oracle price with cost 0", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(res.newBaseAssetReserve)).to.be.equal(oraclePrice);
          expect(res.isAdjustable).to.be.true;
          expect(res.cost).to.be.equal(budget);
        });
      });
      describe("when oracle < mark and oracle-mark divergence doesn't exceed limit 10%", () => {
        const budget = toFullDigitBN(0);
        const oraclePrice = toFullDigitBN(9.99);
        beforeEach(async () => {
          await priceFeed.setPrice(oraclePrice);
        });
        it("should not be updatable with cost 0", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.isAdjustable).to.be.false;
          expect(res.cost).to.be.equal(toFullDigitBN(0));
        });
      });
      describe("when oracle > mark and oracle-mark divergence exceeds limit 10%", () => {
        const oraclePrice = toFullDigitBN(20);
        const budget = toFullDigitBN(0);
        beforeEach(async () => {
          await priceFeed.setPrice(oraclePrice);
        });
        it("should be updatable with cost 0", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(res.newBaseAssetReserve)).to.be.equal(oraclePrice);
          expect(res.isAdjustable).to.be.true;
          expect(res.cost).to.be.equal(toFullDigitBN(0));
        });
      });
      describe("when oracle > mark and oracle-mark divergence doesn't exceed limit 10%", () => {
        const budget = toFullDigitBN(0);
        const oraclePrice = toFullDigitBN(10.01);
        beforeEach(async () => {
          await priceFeed.setPrice(oraclePrice);
        });
        it("should not be updatable with cost 0", async () => {
          const res = await amm.getFormulaicRepegResult(budget);
          expect(res.isAdjustable).to.be.false;
          expect(res.cost).to.be.equal(toFullDigitBN(0));
        });
      });
    });
  });

  describe("getFormulaicUpdateKResult function test", () => {
    const maxIncreaseRatio = toFullDigitBN(1.001);
    const minDecreaseRatio = toFullDigitBN(0.978);
    describe("when there are more long open interests", () => {
      const positionSize = toFullDigitBN(10);
      // B = 90, Q = 1111.11...11, position_size = 10
      beforeEach(async () => {
        await amm.swapOutput(Dir.REMOVE_FROM_AMM, positionSize, 0);
      });
      describe("when budget is positive and a bit small", async () => {
        const budget = toFullDigitBN(0.01);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("ratio of reserves should be the same", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve())).eql(
            res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(await amm.quoteAssetReserve())
          );
        });
        it("should increase K because oracle < mark", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).above(toFullDigitBN(1));
        });
        it("ratio should be smaller than maxIncreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(maxIncreaseRatio);
        });
        it("cost should be same as budget", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).eql(budget);
        });
        it("cost should be the same as the difference of position notional values", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          const res = await amm.getFormulaicUpdateKResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          expect(res.cost).to.be.equal(valueAfter.sub(valueBefore));
        });
      });
      describe("when budget is positive and enough big", async () => {
        const budget = toFullDigitBN(0.5);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("should increase K because oracle < mark", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).above(toFullDigitBN(1));
        });
        it("ratio should be same as maxIncreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).eql(maxIncreaseRatio);
        });
        it("cost should be smaller than budget", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).below(budget);
        });
        it("cost should be the same as the difference of position notional values", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          const res = await amm.getFormulaicUpdateKResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          expect(res.cost).to.be.equal(valueAfter.sub(valueBefore));
        });
      });
      describe("when budget is negative and it's absolute amount is a bit small", async () => {
        const budget = toFullDigitBN(-0.01);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("ratio of reserves should be the same", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve())).eql(
            res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(await amm.quoteAssetReserve())
          );
        });
        it("should decrease K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(toFullDigitBN(1));
        });
        it("ratio should be bigger than minDecreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).above(minDecreaseRatio);
        });
        it("cost should be same as budget", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).eql(budget);
        });
        it("cost should be the same as the difference of position notional values", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          const res = await amm.getFormulaicUpdateKResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          expect(res.cost).to.be.equal(valueAfter.sub(valueBefore));
        });
      });
      describe("when budget is negative and it's absolute amount is enough big", async () => {
        const budget = toFullDigitBN(-0.5);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("should decrease K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(toFullDigitBN(1));
        });
        it("ratio should be same as minDecreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).eql(minDecreaseRatio);
        });
        it("cost should be above than budget", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).above(budget);
        });
        it("cost should be the same as the difference of position notional values", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          const res = await amm.getFormulaicUpdateKResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.ADD_TO_AMM, positionSize);
          expect(res.cost).to.be.equal(valueAfter.sub(valueBefore));
        });
      });
      describe("when budget is negative and canLowerK is false", async () => {
        const budget = toFullDigitBN(-0.5);
        it("should not be updatable", async () => {
          amm.setCanLowerK(false);
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.false;
        });
      });
    });

    describe("when there are more short open interests", () => {
      const positionSize = toFullDigitBN(10);
      // B = 110, Q = 909.0909, position_size = -10
      beforeEach(async () => {
        await amm.swapOutput(Dir.ADD_TO_AMM, positionSize, 0);
      });
      describe("when budget is positive and a bit small", async () => {
        const budget = toFullDigitBN(0.005);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("should increase K because mark < oracle", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).above(toFullDigitBN(1));
        });
        it("ratio should be smaller than maxIncreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(maxIncreaseRatio);
        });
        it("cost should be same as budget", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).eql(budget);
        });
        it("cost should be one bigger than the difference of position notional values", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          const res = await amm.getFormulaicUpdateKResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          expect(res.cost).to.be.equal(valueBefore.sub(valueAfter).add(1));
        });
      });
      describe("when budget is positive and enough big", async () => {
        const budget = toFullDigitBN(0.5);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("should increase K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).above(toFullDigitBN(1));
        });
        it("ratio should be same as maxIncreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).eql(maxIncreaseRatio);
        });
        it("cost should be smaller than budget", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).below(budget);
        });
        it("cost should be one bigger than the difference of position notional values", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          const res = await amm.getFormulaicUpdateKResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          expect(res.cost).to.be.equal(valueBefore.sub(valueAfter).add(1));
        });
      });
      describe("when budget is negative and it's absolute amount is a bit small", async () => {
        const budget = toFullDigitBN(-0.01);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("ratio of reserves should be the same", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve())).eql(
            res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(await amm.quoteAssetReserve())
          );
        });
        it("should decrease K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(toFullDigitBN(1));
        });
        it("ratio should be bigger than minDecreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).above(minDecreaseRatio);
        });
        it("cost should be same as budget", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).eql(budget);
        });
        it("cost should be one bigger than the difference of position notional values", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          const res = await amm.getFormulaicUpdateKResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          expect(res.cost).to.be.equal(valueBefore.sub(valueAfter).add(1));
        });
      });
      describe("when budget is negative and it's absolute amount is enough big", async () => {
        const budget = toFullDigitBN(-0.5);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("should decrease K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(toFullDigitBN(1));
        });
        it("ratio should be same as minDecreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).eql(minDecreaseRatio);
        });
        it("cost should be above than budget", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).above(budget);
        });
        it("cost should be one bigger than the difference of position notional values", async () => {
          const valueBefore = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          const res = await amm.getFormulaicUpdateKResult(budget);
          await amm.adjust(res.newQuoteAssetReserve, res.newBaseAssetReserve);
          const valueAfter = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, positionSize);
          expect(res.cost).to.be.equal(valueBefore.sub(valueAfter).add(1));
        });
      });
      describe("when budget is negative and canLowerK is false", async () => {
        const budget = toFullDigitBN(-0.5);
        it("should not be updatable", async () => {
          amm.setCanLowerK(false);
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.false;
        });
      });
    });

    describe("when long open interests = short open interests", () => {
      // const positionSize = toFullDigitBN(0);
      // B = 100, Q = 1000, position_size = 0
      // beforeEach(async () => {
      //   await amm.swapOutput(Dir.REMOVE_FROM_AMM, positionSize, 0);
      // });
      describe("when budget is positive and a bit small", async () => {
        const budget = toFullDigitBN(0.01);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("ratio of reserves should be the same", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve())).eql(
            res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(await amm.quoteAssetReserve())
          );
        });
        it("should decrease K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(toFullDigitBN(1));
        });
        it("ratio should be same as minDecreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).eql(minDecreaseRatio);
        });
        it("cost should be 0", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).eql(toFullDigitBN(0));
        });
      });
      describe("when budget is positive and enough big", async () => {
        const budget = toFullDigitBN(0.5);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("should decrease K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(toFullDigitBN(1));
        });
        it("ratio should be same as minDecreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).eql(minDecreaseRatio);
        });
        it("cost should be 0", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).eql(toFullDigitBN(0));
        });
      });
      describe("when budget is negative and it's absolute amount is a bit small", async () => {
        const budget = toFullDigitBN(-0.01);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("ratio of reserves should be the same", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve())).eql(
            res.newQuoteAssetReserve.mul(toFullDigitBN(1)).div(await amm.quoteAssetReserve())
          );
        });
        it("should decrease K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(toFullDigitBN(1));
        });
        it("ratio should be same as minDecreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).eql(minDecreaseRatio);
        });
        it("cost should be 0", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).eql(toFullDigitBN(0));
        });
      });
      describe("when budget is negative and it's absolute amount is enough big", async () => {
        const budget = toFullDigitBN(-0.5);
        it("should be updatable", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.isAdjustable).to.be.true;
        });
        it("should decrease K", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).below(toFullDigitBN(1));
        });
        it("ratio should be same as minDecreaseRatio", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          const ratio = res.newBaseAssetReserve.mul(toFullDigitBN(1)).div(await amm.baseAssetReserve());
          expect(ratio).eql(minDecreaseRatio);
        });
        it("cost should be 0", async () => {
          const res = await amm.getFormulaicUpdateKResult(budget);
          expect(res.cost).eql(toFullDigitBN(0));
        });
      });
    });
  });
});
