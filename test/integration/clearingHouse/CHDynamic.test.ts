import { expect, use } from "chai";
import { Signer, BigNumber, utils } from "ethers";
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
  ETHStakingPool,
} from "../../../typechain-types";
import { PnlCalcOption, Side } from "../../../utils/contract";
import { fullDeploy } from "../../../utils/deploy";
import { toFullDigitBN } from "../../../utils/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ClearingHouse Dynamic Adjustment Test", () => {
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
  let ethStakingPool: ETHStakingPool;

  let traderWallet1: TraderWallet;
  let traderWallet2: TraderWallet;

  async function gotoNextFundingTime(): Promise<void> {
    const nextFundingTime = await amm.nextFundingTime();
    await amm.mock_setBlockTimestamp(nextFundingTime);
    await mockPriceFeed.setLatestTimestamp(nextFundingTime);
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
    const [admin, alice, bob] = await ethers.getSigners();
    const contracts = await fullDeploy({ sender: admin });
    const amm = contracts.amm;
    const insuranceFund = contracts.insuranceFund;
    const quoteToken = contracts.quoteToken;
    const mockPriceFeed = contracts.priceFeed;
    const clearingHouse = contracts.clearingHouse;
    const clearingHouseViewer = contracts.clearingHouseViewer;
    const ethStakingPool = contracts.ethStakingPool;

    // Each of Alice & Bob have 5000 DAI
    await quoteToken.transfer(alice.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(bob.address, toFullDigitBN(5000, +(await quoteToken.decimals())));

    // await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));
    await amm.setAdjustable(true);
    await amm.setCanLowerK(true);
    await amm.setSpreadRatio(toFullDigitBN(0.01));
    await amm.setKIncreaseMax(toFullDigitBN(1.5));
    await amm.setKDecreaseMax(toFullDigitBN(0.5));
    await amm.setKCostCoverRate(toFullDigitBN(1));
    await amm.setKRevenueTakeRate(toFullDigitBN(1));

    // given alice takes 2x short position (-25B) with 100 margin
    await quoteToken.connect(alice).approve(clearingHouse.address, toFullDigitBN(5000));
    await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(2), toFullDigitBN(0), true);
    // B = 125, Q = 800

    // given bob takes 1x long position (45B) with 450 margin
    await quoteToken.connect(bob).approve(clearingHouse.address, toFullDigitBN(5000));
    await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(450), toFullDigitBN(1), toFullDigitBN(0), true);
    // B = 80, Q = 1250
    // mark_price = 15.625
    // net position size = 20B
    const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
    // 100 (alice's margin) + 450 (bob' margin)  = 550
    expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(550));
    expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address)).eq(toFullDigitBN(6.5));

    await ethStakingPool.setTribe3Treasury(admin.address);
    await quoteToken.approve(ethStakingPool.address, toFullDigitBN(5000));
    await amm.mockSetSpreadCheck(true);
    await amm.setQuoteReserveUpperLimit(ethers.constants.MaxUint256);
    await amm.setPtcBaseDecrease(toFullDigitBN(0.001));

    return { admin, alice, bob, amm, insuranceFund, quoteToken, mockPriceFeed, clearingHouse, clearingHouseViewer, ethStakingPool };
  }

  beforeEach(async () => {
    const fixture = await loadFixture(deployEnvFixture);
    admin = fixture.admin;
    alice = fixture.alice;
    bob = fixture.bob;
    amm = fixture.amm;
    insuranceFund = fixture.insuranceFund;
    quoteToken = fixture.quoteToken;
    mockPriceFeed = fixture.mockPriceFeed;
    clearingHouse = fixture.clearingHouse;
    clearingHouseViewer = fixture.clearingHouseViewer;
    ethStakingPool = fixture.ethStakingPool;
  });

  describe("when repeg is not needed", () => {
    beforeEach(async () => {
      await syncAmmPriceToOracle();
      await gotoNextFundingTime();
    });
    describe("when total is revenue", () => {
      beforeEach(async () => {
        expect(await amm.getTwapPrice(24 * 3600)).eq(toFullDigitBN(15.625));
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.525));
        // funding payment = (15.625-15.525)*20 = 2
        // net revenue = 6.5
        // total revenue = 8.5
      });
      it("should increase k", async () => {
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        await clearingHouse.payFunding(amm.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveBefore.div(baseAssetReserveBefore)).eq(quoteAssetReserveAfter.div(baseAssetReserveAfter));
        expect(quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).gt(toFullDigitBN(1));
      });
      it("should decrease k by 0.1% if the target is bigger than upper limit", async () => {
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        await amm.setQuoteReserveUpperLimit(toFullDigitBN(1000));
        await clearingHouse.payFunding(amm.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).eq(toFullDigitBN(0.999));
        expect(baseAssetReserveAfter.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).eq(toFullDigitBN(0.999));
      });
      it("should increase k even when target is smaller than the lower limit", async () => {
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        const limit = quoteAssetReserveBefore.mul(2);
        await amm.setQuoteReserveLowerLimit(limit);
        await clearingHouse.payFunding(amm.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveBefore.div(baseAssetReserveBefore)).eq(quoteAssetReserveAfter.div(baseAssetReserveAfter));
        expect(quoteAssetReserveAfter).gt(quoteAssetReserveBefore);
        expect(quoteAssetReserveAfter).lt(limit);
      });
      it("should increase k when target is bigger than the lower limit", async () => {
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        const limit = quoteAssetReserveBefore;
        await amm.setQuoteReserveLowerLimit(limit);
        await clearingHouse.payFunding(amm.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveBefore.div(baseAssetReserveBefore)).eq(quoteAssetReserveAfter.div(baseAssetReserveAfter));
        expect(quoteAssetReserveAfter).gt(quoteAssetReserveBefore);
        expect(quoteAssetReserveAfter).gt(limit);
      });
      it("total/4 is used for increasing K", async () => {
        // (2 + 6.5)/4 = 2.125
        const ifBalBefore = await quoteToken.balanceOf(insuranceFund.address);
        const tx = await clearingHouse.payFunding(amm.address);
        const ifBalAfter = await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        await expect(tx)
          .to.emit(clearingHouse, "UpdateK")
          .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "2125000000000000001");
        expect(ifBalAfter.sub(ifBalBefore)).eq("-125000000000000001");
      });
      it("total/4 * 0.25 is used for increasing K when coverRate is 0.25", async () => {
        // (2 + 6.5)/4 = 0.53125
        await amm.setKCostCoverRate(toFullDigitBN(0.25));
        const ifBalBefore = await quoteToken.balanceOf(insuranceFund.address);
        const tx = await clearingHouse.payFunding(amm.address);
        const ifBalAfter = await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        await expect(tx)
          .to.emit(clearingHouse, "UpdateK")
          .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "531250000000000000");
        // 2 - 0.53125 = 1.46875
        expect(ifBalAfter.sub(ifBalBefore)).eq("1468750000000000000");
      });
    });
    describe("when total is cost", () => {
      beforeEach(async () => {
        expect(await amm.getTwapPrice(24 * 3600)).eq(toFullDigitBN(15.625));
        await mockPriceFeed.setTwapPrice(toFullDigitBN(16.125));
        // funding payment = (15.625-16.125)*20 = -10
        // net revenue = 6.5
        // total cost = 3.5
      });
      it("65% is recovered through K decreasing when insurance fund is enough to pay 35% of total cost", async () => {
        await ethStakingPool.stake(toFullDigitBN(1.76));
        expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(8.26));
        // budget = 8.26
        // k revenue  3.5*065 = 2.275
        // total cost 10 - 2.275 = 7.725
        const ifBalBefore = await insuranceFund.getAvailableBudgetFor(amm.address);
        // await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        const tx = await clearingHouse.payFunding(amm.address);
        const ifBalAfter = await insuranceFund.getAvailableBudgetFor(amm.address);
        //await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveBefore.div(baseAssetReserveBefore)).eq(quoteAssetReserveAfter.div(baseAssetReserveAfter));
        expect(quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).lt(toFullDigitBN(1));
        await expect(tx)
          .to.emit(clearingHouse, "UpdateK")
          .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "-2275682704811443433");
        expect(ifBalAfter.sub(ifBalBefore)).eq("-7724317295188556567");
      });
      it("65% * 0.25 is recovered through K decreasing when insurance fund is enough to pay 35% of total cost when k revenue take rate is 0.25", async () => {
        await amm.setKRevenueTakeRate(toFullDigitBN(0.25));
        await ethStakingPool.stake(toFullDigitBN(3));
        expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(9.5));
        // budget = 9.5
        // k revenue 3.5*065*0.25 = 0.56875
        // total cost 10 - 0.56875 = 9.43125
        const ifBalBefore = await insuranceFund.getAvailableBudgetFor(amm.address);
        // await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        const tx = await clearingHouse.payFunding(amm.address);
        const ifBalAfter = await insuranceFund.getAvailableBudgetFor(amm.address);
        //await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveBefore.div(baseAssetReserveBefore)).eq(quoteAssetReserveAfter.div(baseAssetReserveAfter));
        expect(quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).lt(toFullDigitBN(1));
        await expect(tx)
          .to.emit(clearingHouse, "UpdateK")
          .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "-568920676202860858");
        expect(ifBalAfter.sub(ifBalBefore)).eq("-9431079323797139142");
      });
      it("65% is recovered with additional 0.1% decreasing through K decreasing when insurance fund is enough to pay 35% of total cost when target is above the upper limit", async () => {
        await ethStakingPool.stake(toFullDigitBN(1.76));
        expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(8.26));
        // budget = 8.26
        // -3.5/2 = -1.75
        const ifBalBefore = await insuranceFund.getAvailableBudgetFor(amm.address);
        // await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        await amm.setQuoteReserveUpperLimit(toFullDigitBN(1000));
        const tx = await clearingHouse.payFunding(amm.address);
        const ifBalAfter = await insuranceFund.getAvailableBudgetFor(amm.address);
        //await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveBefore.div(baseAssetReserveBefore)).eq(quoteAssetReserveAfter.div(baseAssetReserveAfter));
        expect(quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).lt(toFullDigitBN(1));
        await expect(tx)
          .to.emit(clearingHouse, "UpdateK")
          .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "-2329434652190164433");
        expect(ifBalAfter.sub(ifBalBefore)).eq("-7670565347809835567");
      });
      it("K is not decreased when the target is smaller than the lower limit", async () => {
        await ethStakingPool.stake(toFullDigitBN(3.5));
        // await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        await amm.setQuoteReserveLowerLimit(quoteAssetReserveBefore);
        await clearingHouse.payFunding(amm.address);
        //await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveAfter).eq(quoteAssetReserveBefore);
        expect(baseAssetReserveAfter).eq(baseAssetReserveBefore);
        expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(0));
      });
      it("K is decreased when target is bigger than the upper limit", async () => {
        await ethStakingPool.stake(toFullDigitBN(3.5));
        await amm.setQuoteReserveUpperLimit(toFullDigitBN(1000));
        // await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        await clearingHouse.payFunding(amm.address);
        //await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveAfter).lt(quoteAssetReserveBefore);
        expect(quoteAssetReserveAfter).gt(toFullDigitBN(1000));
        expect(baseAssetReserveAfter).lt(baseAssetReserveBefore);
      });
      it("max k decreasing is done when insurance fund is not enough to pay 35% of total cost", async () => {
        await ethStakingPool.stake(toFullDigitBN(1));
        expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(7.5));
        // budget = 8.25
        // max k decrease revenue = 41.66
        const ifBalBefore = await insuranceFund.getAvailableBudgetFor(amm.address);
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        const tx = await clearingHouse.payFunding(amm.address);
        const ifBalAfter = await insuranceFund.getAvailableBudgetFor(amm.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveBefore.div(baseAssetReserveBefore)).eq(quoteAssetReserveAfter.div(baseAssetReserveAfter));
        expect(quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).eq(toFullDigitBN(0.5));
        await expect(tx)
          .to.emit(clearingHouse, "UpdateK")
          .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "-41666666666666666667");
        expect(ifBalAfter.sub(ifBalBefore)).eq("31666666666666666667"); // = 41.66-10=31.66
      });
      it("amm is shut down when total is not enough to pay funding", async () => {
        // max k decrease revenue = 41.66
        // insurance fund = 6.5
        // total reserve = 48.66
        expect(await amm.getTwapPrice(24 * 3600)).eq(toFullDigitBN(15.625));
        await mockPriceFeed.setTwapPrice(toFullDigitBN(18.075));
        // funding payment = (15.625-18.075)*20 = -49
        const tx = await clearingHouse.payFunding(amm.address);
        await expect(tx).to.emit(amm, "FundingRateUpdated").withArgs(0, 0, toFullDigitBN(18.075), 0);
        expect(await amm.open()).eq(false);
      });
    });
  });

  describe("when repeg is needed", () => {
    describe("when total is revenue", () => {
      beforeEach(async () => {
        // mark_price = 15.625
        // oracle_price = 14
        // target_price = 14.7
        // repeg cost = -13.502219259243703526
        await mockPriceFeed.setPrice(toFullDigitBN(14));
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.625)); // to make funding payment 0
        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        await gotoNextFundingTime();
        expect(await amm.getTwapPrice(24 * 3600)).eq(toFullDigitBN(15.625));
        await mockPriceFeed.setTwapPrice(toFullDigitBN(16.125));
        // funding payment = (15.625-16.125)*20 = -10
        // net revenue = 0
        // total revenue = 3.502219259243703526
      });
      it("repeg is done", async () => {
        await clearingHouse.payFunding(amm.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(baseAssetReserveAfter)).eq("14000000004732863828");
      });
      it("k is increased", async () => {
        const [quoteAssetReserveBefore, baseAssetReserveBefore] = await amm.getReserve();
        await clearingHouse.payFunding(amm.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        expect(quoteAssetReserveAfter.mul(baseAssetReserveAfter)).gt(quoteAssetReserveBefore.mul(baseAssetReserveBefore));
      });
      it("total/4 is used for increasing K when it is smaller than max k decrease revenue", async () => {
        // 3.502219259243703526/4 = 0.875554814810925883
        const ifBalBefore = await quoteToken.balanceOf(insuranceFund.address);
        const tx = await clearingHouse.payFunding(amm.address);
        const ifBalAfter = await quoteToken.balanceOf(insuranceFund.address);
        const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
        await expect(tx)
          .to.emit(clearingHouse, "UpdateK")
          .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "3449465108424479284");
        expect(ifBalAfter.sub(ifBalBefore)).eq("10348395325273437850");
      });
    });
    describe("when total is cost", () => {
      beforeEach(async () => {
        // mark_price = 15.625
        // oracle_price = 18
        // target_price = 17.1
        // repeg cost = 21.300551659460829192
        // max K decrease revenue with repeg = 45.860748587566391346
        // max k decrease revenue without repeg = 41.024899564780716437
        await mockPriceFeed.setPrice(toFullDigitBN(18));
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.625)); // to make funding payment 0
        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        await gotoNextFundingTime();
        // net revenue = 0
      });
      it("amm is shut down when total reserve is not sufficient to pay funding", async () => {
        expect(await amm.getTwapPrice(24 * 3600)).eq(toFullDigitBN(15.625));
        await mockPriceFeed.setTwapPrice(toFullDigitBN(18.125));
        // funding payment = (15.625-18.125)*20 = -50
        // total reserve = max(45.860748587566391346-21.300551659460829192, 41.024899564780716437)
        await clearingHouse.payFunding(amm.address);
        expect(await amm.open()).eq(false);
      });
      describe("when total reserve is sufficient to pay funding, but not to pay repeg cost - budget: 6.5", () => {
        beforeEach(async () => {
          expect(await amm.getTwapPrice(24 * 3600)).eq(toFullDigitBN(15.625));
          await mockPriceFeed.setTwapPrice(toFullDigitBN(17.625));
          // funding payment = (15.625-17.625)*20 = -40
          // total reserve = 6.5 + max(45.860748587566391346-21.300551659460829192, 41.024899564780716437)
        });
        it("funding payment is done, but repeg is not", async () => {
          const est = await clearingHouseViewer.getFundingRates(amm.address);
          expect(est.fundingRateLong).eq("-113475177304964539");
          expect(est.fundingRateShort).eq("-113475177304964539");
          expect(est.fundingPayment).eq(toFullDigitBN(-40));
          const tx = await clearingHouse.payFunding(amm.address);
          await expect(tx)
            .to.emit(amm, "FundingRateUpdated")
            .withArgs("-113475177304964539", "-113475177304964539", toFullDigitBN(17.625), toFullDigitBN(-40));
          await expect(tx).to.not.emit(clearingHouse, "Repeg");
        });
        it("max k decreasing is done", async () => {
          const [quoteAssetReservebefore, baseAssetReservebefore] = await amm.getReserve();
          const tx = await clearingHouse.payFunding(amm.address);
          const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
          await quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(quoteAssetReservebefore).eq(toFullDigitBN(0.5));
          await expect(tx)
            .to.emit(clearingHouse, "UpdateK")
            .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "-41024899564780716437");
        });
      });
      describe("when total reserve is sufficient to pay funding and repeg cost", () => {
        beforeEach(async () => {
          expect(await amm.getTwapPrice(24 * 3600)).eq(toFullDigitBN(15.625));
          await mockPriceFeed.setTwapPrice(toFullDigitBN(17.625));
          // funding payment = (15.625-17.625)*20 = -40
          // budget = 18.375
          await ethStakingPool.stake(toFullDigitBN(50));
          // total reserve = 18.375 + max(45.860748587566391346-21.300551659460829192, 41.024899564780716437)
        });
        it("funding and repeg is done", async () => {
          const est = await clearingHouseViewer.getFundingRates(amm.address);
          expect(est.fundingRateLong).eq("-113475177304964539");
          expect(est.fundingRateShort).eq("-113475177304964539");
          expect(est.fundingPayment).eq(toFullDigitBN(-40));
          const tx = await clearingHouse.payFunding(amm.address);
          await expect(tx)
            .to.emit(amm, "FundingRateUpdated")
            .withArgs("-113475177304964539", "-113475177304964539", toFullDigitBN(17.625), toFullDigitBN(-40));
          await expect(tx)
            .to.emit(clearingHouse, "Repeg")
            .withArgs(amm.address, "1386408061182874743310", "77022670015195071867", "34165539667841413525");
        });
        it("max k decreasing after repeg is done when budget is not sufficient", async () => {
          const [quoteAssetReservebefore, baseAssetReservebefore] = await amm.getReserve();
          const tx = await clearingHouse.payFunding(amm.address);
          const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
          await quoteAssetReserveAfter.mul(toFullDigitBN(1)).div(quoteAssetReservebefore).eq(toFullDigitBN(0.5));
          await expect(tx)
            .to.emit(clearingHouse, "UpdateK")
            .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "-48222067404318214252");
        });
        it("65% of total cost (30.6) is recovered through k decreasing when budget is sufficient", async () => {
          // budget = 38.374999999999999998
          await ethStakingPool.stake(toFullDigitBN(20));
          const tx = await clearingHouse.payFunding(amm.address);
          const [quoteAssetReserveAfter, baseAssetReserveAfter] = await amm.getReserve();
          await expect(tx)
            .to.emit(clearingHouse, "UpdateK")
            .withArgs(amm.address, quoteAssetReserveAfter, baseAssetReserveAfter, "-48222067404318214252");
          expect(await quoteToken.balanceOf(insuranceFund.address)).eq("0");
          expect(await quoteToken.balanceOf(ethStakingPool.address)).eq("48931527736476800725");
        });
      });
    });
  });
});
