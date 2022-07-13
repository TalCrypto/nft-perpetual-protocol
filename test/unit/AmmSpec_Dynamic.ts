import { expect, use } from "chai";
import { BigNumber } from "ethers";
import { ethers } from "hardhat";
import { Amm, AmmFake, ERC20Fake, L2PriceFeedMock } from "../../typechain-types";
import { solidity } from "ethereum-waffle";
import { deployAmm, deployErc20Fake, deployL2MockPriceFeed, deployProxyAmm, Dir } from "../helper/contract";
import { toFullDigitBN } from "../helper/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

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
            expect(res.isUpdatable).to.be.true;
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
            expect(res.isUpdatable).to.be.true;
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
          expect(res.isUpdatable).to.be.false;
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
          expect(res.isUpdatable).to.be.true;
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
          expect(res.isUpdatable).to.be.false;
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
            expect(res.isUpdatable).to.be.true;
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
            expect(res.isUpdatable).to.be.true;
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
          expect(res.isUpdatable).to.be.false;
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
          expect(res.isUpdatable).to.be.true;
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
          expect(res.isUpdatable).to.be.false;
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
          expect(res.isUpdatable).to.be.true;
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
          expect(res.isUpdatable).to.be.false;
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
          expect(res.isUpdatable).to.be.true;
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
          expect(res.isUpdatable).to.be.false;
          expect(res.cost).to.be.equal(toFullDigitBN(0));
        });
      });
    });
  });
});
