import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { AmmFake, ClearingHouseFake, ERC20Fake, ETHStakingPool, InsuranceFundFake, L2PriceFeedMock } from "../../typechain-types";
import { Side } from "../../utils/contract";
import { fullDeploy } from "../../utils/deploy";
import { toFullDigitBN } from "../../utils/number";

describe("fund flow test", async () => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let clearingHouse: ClearingHouseFake;
  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let ethStakingPool: ETHStakingPool;
  let mockPriceFeed: L2PriceFeedMock;
  let quoteToken: ERC20Fake;

  async function gotoNextFundingTime(): Promise<void> {
    const nextFundingTime = await amm.nextFundingTime();
    await clearingHouse.mock_setBlockTimestamp(nextFundingTime);
    await amm.mock_setBlockTimestamp(nextFundingTime);
    await mockPriceFeed.setLatestTimestamp(nextFundingTime);
    const blockNumber = await amm.mock_getCurrentBlockNumber();
    await clearingHouse.mock_setBlockNumber(blockNumber.add(1));
    await amm.mock_setBlockNumber(blockNumber.add(1));
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

    // clearingHouse = contracts.clearingHouse;

    // Each of Alice & Bob have 5000 DAI
    await quoteToken.transfer(alice.address, toFullDigitBN(5000));
    await quoteToken.transfer(bob.address, toFullDigitBN(5000));

    await quoteToken.connect(alice).approve(clearingHouse.address, ethers.constants.MaxUint256);
    await quoteToken.connect(bob).approve(clearingHouse.address, ethers.constants.MaxUint256);
    await quoteToken.connect(admin).approve(ethStakingPool.address, ethers.constants.MaxUint256);

    await ethStakingPool.setTribe3Treasury(admin.address);

    // await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));

    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setTwapPrice(marketPrice);

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
    ethStakingPool = fixture.ethStakingPool;
  });

  describe("contribution waterfall/sequence", () => {
    it("staking balance is not included in available budget when no open interest", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(0));
    });
    it("available budget calculation", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.001));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(5), toFullDigitBN(0), true);
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(10.6));
    });
    it("only insurance fund is used to cover cost when insurance fund is enough", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.01));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(5), toFullDigitBN(0), true);
      // x: 62.5, y: 1600, price: 25.6
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.7));
      // funding payment = -0.1 * 37.5 = -3.75
      await clearingHouse.payFunding(amm.address);
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(6 - 3.75));
    });
    it("insurance is used when the staking pool is no activated", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await insuranceFund.deactivateETHStakingPool();
      await amm.setSpreadRatio(toFullDigitBN(0.01));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(5), toFullDigitBN(0), true);
      // x: 62.5, y: 1600, price: 25.6
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.7));
      // funding payment = -0.1 * 37.5 = -3.75
      await clearingHouse.payFunding(amm.address);
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(6 - 3.75));
    });
    it("staking pool is used to cover cost when insurance fund is not enough", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.001));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(5), toFullDigitBN(0), true);
      // x: 62.5, y: 1600, price: 25.6
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.7));
      // funding payment = -0.1 * 37.5 = -3.75
      await clearingHouse.payFunding(amm.address);
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10 - (3.75 - 0.6)));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(0));
    });
    it("reward is used first if there is", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.1));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      // x: 62.5, y: 1600, price: 25.6
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.5));
      // funding payment = 0.1 * 37.5 = 3.75
      await clearingHouse.payFunding(amm.address);
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.7));
      // funding payment = -0.1 * 37.5 = -3.75
      await clearingHouse.payFunding(amm.address);
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(60));
    });
    it("insurance is used after reward", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.1));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      // x: 62.5, y: 1600, price: 25.6
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.5));
      // funding payment = 0.1 * 37.5 = 7.5
      await clearingHouse.payFunding(amm.address);
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.8));
      // funding payment = -0.1 * 37.5 = -7.5
      await clearingHouse.payFunding(amm.address);
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(60 - 3.75));
    });
    it("staking principal is used after insurance fund", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.1));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(60));
      // x: 62.5, y: 1600, price: 25.6
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.5));
      // funding payment = 0.1 * 37.5 = 3.75
      await clearingHouse.payFunding(amm.address);
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(60));
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(13.75));
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(27.4));
      // funding payment = -1.8 * 37.5 = -67.5
      await clearingHouse.payFunding(amm.address);
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10 - 3.75));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(0));
    });
  });
  describe("distribution waterfall/sequence", async () => {
    it("fee is transferred to insurance fund when staking pool is not activated", async () => {
      await insuranceFund.deactivateETHStakingPool();
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.01));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      expect(await quoteToken.balanceOf(alice.address)).eq(toFullDigitBN(5000 - 66));
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(6));
    });
    it("fee is transferred to insurance fund if it is below vault and staking pool is full", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.01));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      expect(await quoteToken.balanceOf(alice.address)).eq(toFullDigitBN(5000 - 66));
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(6));
    });
    it("fee is transferred to staking pool if it is below vault and staking pool is not full", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.001));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      // x: 62.5, y: 1600, price: 25.6
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.7));
      // funding payment = -0.1 * 37.5 = -3.75
      await clearingHouse.payFunding(amm.address);
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(10 - (3.75 - 0.6)));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(0));

      await gotoNextFundingTime();
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      expect(await quoteToken.balanceOf(alice.address)).eq(toFullDigitBN(5000 - 60.6 * 2));
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(7.45));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(0));
    });
    it("fee is transferred to staking pool as reward if it is above vault and staking pool is full", async () => {
      await ethStakingPool.stake(toFullDigitBN(10));
      await amm.setSpreadRatio(toFullDigitBN(0.2));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      expect(await quoteToken.balanceOf(alice.address)).eq(toFullDigitBN(5000 - 180));
      expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(70));
      expect(await quoteToken.balanceOf(insuranceFund.address)).eq(toFullDigitBN(60));
      expect(await ethStakingPool.calculateTotalReward()).eq(toFullDigitBN(60));
    });
  });
});
