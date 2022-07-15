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
import { PnlCalcOption, Side } from "../../helper/contract";
import { fullDeploy } from "../../helper/deploy";
import { toFullDigitBN } from "../../helper/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

use(solidity);

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
    clearingHouse = contracts.clearingHouse;

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
    describe("open position", () => {
      describe("when open position not to make mark-oracle divergence exceeds", () => {
        // B = 100, Q = 1000
        it("repeg doesn't occur", async () => {
          await approve(alice, clearingHouse.address, 1);
          const tx = await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(1), toFullDigitBN(10), toFullDigitBN(150));
          // B = 101.0101, Q = 990
          expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(990));
          expect(await amm.baseAssetReserve()).eql(toFullDigitBN(100000).mul(toFullDigitBN(1)).div(toFullDigitBN(990)).add(1));
          await expect(tx).to.not.emit(clearingHouse, "Repeg");
        })

      })
      describe("when open short position to make mark-oracle divergence exceeds down", () => {
        describe("when clearing house has sufficient token", ()=>{
          beforeEach(async ()=>{
            await quoteToken.transfer(clearingHouse.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
          })
          it("repeg occurs with profit of insurance funding", async () => {
            // given alice takes 10x short position (size: -150) with 60 margin
            await approve(alice, clearingHouse.address, 60);
            const tx = await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
            // B = 250, Q = 2500
            expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(2500));
            expect(await amm.baseAssetReserve()).eql(toFullDigitBN(250));
            await expect(tx).to.emit(clearingHouse, "Repeg").withArgs(amm.address, toFullDigitBN(2500), toFullDigitBN(250), toFullDigitBN(-3150));
            expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
            expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(3150));
          })
        })
        describe("when clearing house has insufficient token", ()=>{
          it("repeg occurs with profit of insurance funding, same as the balance of clearing house", async () => {
            await approve(alice, clearingHouse.address, 60);
            const tx = await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(150));
            // B = 250, Q = 2500
            expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(2500));
            expect(await amm.baseAssetReserve()).eql(toFullDigitBN(250));
            await expect(tx).to.emit(clearingHouse, "Repeg").withArgs(amm.address, toFullDigitBN(2500), toFullDigitBN(250), toFullDigitBN(-3150));
            expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(60));
            expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(60));
          })
        })
      })
      describe("when open long position to make mark-oracle divergence exceeds up", ()=>{
        it("repeg occurs with profit of insurance funding", async () => {
          await approve(alice, clearingHouse.address, 200);
          const tx = await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0));
          // B = 250, Q = 2500
          expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(500));
          expect(await amm.baseAssetReserve()).eql(toFullDigitBN(50));
          await expect(tx).to.emit(clearingHouse, "Repeg").withArgs(amm.address, toFullDigitBN(500), toFullDigitBN(50), toFullDigitBN(-750));
          expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(100));
          expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(100));
        })
      })
      describe("when open short position to make mark-oracle divergence exceeds up", ()=>{
        describe("when total fee is not enough for charging repegging cost", ()=>{
          it("repeg doesn't occur", async () => {
            mockPriceFeed.setPrice(toFullDigitBN(1));
            await approve(alice, clearingHouse.address, 60);
            const tx = await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(0));
            await expect(tx).to.not.emit(clearingHouse, "Repeg")
            expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(400));
            expect(await amm.baseAssetReserve()).eql(toFullDigitBN(250));
          })
        })
        describe("when total fee is enough for charging repegging cost", ()=>{
          it("repeg occurs", async () => {
            amm.setSpreadRatio(toFullDigitBN(0.5));
            mockPriceFeed.setPrice(toFullDigitBN(1));
            expect(await quoteToken.balanceOf(clearingHouse.address)).eql(toFullDigitBN(0));
            expect(await quoteToken.balanceOf(insuranceFund.address)).eql(toFullDigitBN(5000));
            await approve(alice, clearingHouse.address, 60);
            const tx = await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(0));
            await expect(tx).to.emit(clearingHouse, "Repeg").withArgs(amm.address, toFullDigitBN(380), toFullDigitBN(250), toFullDigitBN(30));
            expect(await clearingHouse.totalFees(amm.address, quoteToken.address)).eql(toFullDigitBN(30));
            expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address, quoteToken.address)).eql(toFullDigitBN(30));
            expect(await quoteToken.balanceOf(clearingHouse.address)).eql(toFullDigitBN(30));
            expect(await quoteToken.balanceOf(insuranceFund.address)).eql(toFullDigitBN(5030));
            expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(380));
            expect(await amm.baseAssetReserve()).eql(toFullDigitBN(250));
          })
        })
      })
    })
  });

});
