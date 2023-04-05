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
  ETHStakingPool,
} from "../../../typechain-types";
import { deployL2PriceFeed, PnlCalcOption, Side } from "../../../utils/contract";
import { fullDeploy } from "../../../utils/deploy";
import { toFullDigitBN } from "../../../utils/number";
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
    await quoteToken.transfer(alice.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(bob.address, toFullDigitBN(5000, +(await quoteToken.decimals())));

    await ethStakingPool.setTribe3Treasury(admin.address);
    await quoteToken.approve(ethStakingPool.address, toFullDigitBN(5000));
    await ethStakingPool.stake(toFullDigitBN(5000));

    // await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));

    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setTwapPrice(marketPrice);

    return { amm, insuranceFund, quoteToken, mockPriceFeed, clearingHouse, clearingHouseViewer };
  }

  beforeEach(async () => {
    const account = await ethers.getSigners();
    admin = account[0];
    alice = account[1];
    bob = account[2];
    carol = account[3];
    relayer = account[4];
    const fixture = await loadFixture(deployEnvFixture);
    amm = fixture.amm;
    insuranceFund = fixture.insuranceFund;
    quoteToken = fixture.quoteToken;
    mockPriceFeed = fixture.mockPriceFeed;
    clearingHouse = fixture.clearingHouse;
    clearingHouseViewer = fixture.clearingHouseViewer;
  });

  describe("getPersonalPositionWithFundingPayment", () => {
    it("return negative margin when alice's position is underwater", async () => {
      // given alice takes 10x short position (size: -150) with 60 margin
      await approve(alice, clearingHouse.address, 60);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(150), true);

      // given the underlying twap price is $2.1, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(2.1));

      // when the new fundingRate is -50% which means underlyingPrice < snapshotPrice
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).to.eq(toFullDigitBN(-0.5));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).to.eq(toFullDigitBN(-0.5));

      // then alice need to pay 150 * 0.5 = 75
      // {size: -150, margin: 60} => {size: -150, margin: -15}
      const alicePosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address);
      expect(alicePosition.size).to.eq(toFullDigitBN(-150));
      expect(alicePosition.margin).to.eq(toFullDigitBN(-15));
      const positionInfo = await clearingHouseViewer.getTraderPositionInfo(amm.address, alice.address);
    });
  });

  describe("getTraderPositionInfo", () => {
    it("returns exact infos", async () => {
      await approve(alice, clearingHouse.address, 600);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(37.5), true);

      // given bob takes 1x short position (-187.5B) with 1200 margin
      await approve(bob, clearingHouse.address, 1800);
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(1200), toFullDigitBN(1), toFullDigitBN(187.5), true);

      // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.59));

      // when the new fundingRate is 1% which means underlyingPrice < snapshotPrice
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.01));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.01));

      // then alice need to pay 1% of her position size as fundingPayment
      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
      const alicePosition = await clearingHouseViewer.getTraderPositionInfo(amm.address, alice.address);
      expect(alicePosition.positionSize).to.eq(toFullDigitBN(37.5));
      expect(alicePosition.openMargin.add(alicePosition.fundingPayment)).to.eq(toFullDigitBN(299.625));
      // then bob will get 1% of her position size as fundingPayment
      // {balance: -187.5, margin: 1200} => {balance: -187.5, margin: 1201.875}
      const bobPosition = await clearingHouseViewer.getTraderPositionInfo(amm.address, bob.address);
      expect(bobPosition.positionSize).to.eq(toFullDigitBN(-187.5));
      expect(bobPosition.openMargin.add(bobPosition.fundingPayment)).to.eq(toFullDigitBN(1201.875));
    });
    it("empty position returns 0 in all fields", async () => {
      const carolPositioin = await clearingHouseViewer.getTraderPositionInfo(amm.address, carol.address);
      expect(carolPositioin.positionSize).eq(BigNumber.from(0));
      expect(carolPositioin.openMargin).eq(BigNumber.from(0));
      expect(carolPositioin.margin).eq(BigNumber.from(0));
      expect(carolPositioin.unrealizedPnl).eq(BigNumber.from(0));
      expect(carolPositioin.fundingPayment).eq(BigNumber.from(0));
      expect(carolPositioin.marginRatio).eq(BigNumber.from(0));
      expect(carolPositioin.liquidationPrice).eq(BigNumber.from(0));
      expect(carolPositioin.openLeverage).eq(BigNumber.from(0));
      expect(carolPositioin.leverage).eq(BigNumber.from(0));
      expect(carolPositioin.openNotional).eq(BigNumber.from(0));
      expect(carolPositioin.positionNotional).eq(BigNumber.from(0));
      expect(carolPositioin.entryPrice).eq(BigNumber.from(0));
    });
  });

  describe("getMarginAdjustmentEstimation", () => {
    beforeEach(async () => {
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);
    });

    it("add margin estimation", async () => {
      const estimation = await clearingHouseViewer.getMarginAdjustmentEstimation(amm.address, alice.address, toFullDigitBN(80));
      await clearingHouse.connect(alice).addMargin(amm.address, toFullDigitBN(80));
      const positionInfo = await clearingHouseViewer.getTraderPositionInfo(amm.address, alice.address);
      expect(estimation.entryPrice).eq(positionInfo.entryPrice);
      expect(estimation.fundingPayment).eq(positionInfo.fundingPayment);
      expect(estimation.leverage).eq(positionInfo.leverage);
      expect(estimation.liquidationPrice).eq(positionInfo.liquidationPrice);
      expect(estimation.margin).eq(positionInfo.margin);
      expect(estimation.marginRatio).eq(positionInfo.marginRatio);
      expect(estimation.openLeverage).eq(positionInfo.openLeverage);
      expect(estimation.openMargin).eq(positionInfo.openMargin);
      expect(estimation.openNotional).eq(positionInfo.openNotional);
      expect(estimation.positionNotional).eq(positionInfo.positionNotional);
      expect(estimation.positionSize).eq(positionInfo.positionSize);
      expect(estimation.spotPrice).eq(positionInfo.spotPrice);
      expect(estimation.unrealizedPnl).eq(positionInfo.unrealizedPnl);
    });

    it("remove margin estimation", async () => {
      const estimation = await clearingHouseViewer.getMarginAdjustmentEstimation(amm.address, alice.address, toFullDigitBN(-10));
      await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(10));
      const positionInfo = await clearingHouseViewer.getTraderPositionInfo(amm.address, alice.address);
      expect(estimation.entryPrice).eq(positionInfo.entryPrice);
      expect(estimation.fundingPayment).eq(positionInfo.fundingPayment);
      expect(estimation.leverage).eq(positionInfo.leverage);
      expect(estimation.liquidationPrice).eq(positionInfo.liquidationPrice);
      expect(estimation.margin).eq(positionInfo.margin);
      expect(estimation.marginRatio).eq(positionInfo.marginRatio);
      expect(estimation.openLeverage).eq(positionInfo.openLeverage);
      expect(estimation.openMargin).eq(positionInfo.openMargin);
      expect(estimation.openNotional).eq(positionInfo.openNotional);
      expect(estimation.positionNotional).eq(positionInfo.positionNotional);
      expect(estimation.positionSize).eq(positionInfo.positionSize);
      expect(estimation.spotPrice).eq(positionInfo.spotPrice);
      expect(estimation.unrealizedPnl).eq(positionInfo.unrealizedPnl);
    });
  });

  describe("getOpenPositionEstimation", () => {
    beforeEach(async () => {
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);
    });
    it("open position estimation", async () => {
      const estimation = await clearingHouseViewer.getOpenPositionEstimation(
        amm.address,
        bob.address,
        Side.BUY,
        toFullDigitBN(100),
        toFullDigitBN(10)
      );
      const positionEst = estimation.positionInfo;
      const tx = await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);
      const positionInfo = await clearingHouseViewer.getTraderPositionInfo(amm.address, bob.address);
      expect(positionEst.positionSize).eq(positionInfo.positionSize);
      expect(positionEst.positionNotional).eq("100000000000000000000");
      expect(positionEst.entryPrice).eq(positionInfo.entryPrice);
      expect(positionEst.fundingPayment).eq(positionInfo.fundingPayment);
      expect(positionEst.leverage).eq("10000000000000000000");
      expect(positionEst.liquidationPrice).eq(positionInfo.liquidationPrice);
      expect(positionEst.margin).eq("10000000000000000000");
      expect(positionEst.marginRatio).eq("100000000000000000");
      expect(positionEst.openLeverage).eq(positionInfo.openLeverage);
      expect(positionEst.openMargin).eq(positionInfo.openMargin);
      expect(positionEst.openNotional).eq(positionInfo.openNotional);
      expect(positionEst.spotPrice).eq(positionInfo.spotPrice);
      expect(positionEst.unrealizedPnl).eq(0);
      expect(tx)
        .emit(clearingHouse, "PositionChanged")
        .withArgs(
          bob.address,
          amm.address,
          positionEst.openMargin,
          estimation.exchangedQuoteAssetAmount,
          estimation.exchangedPositionSize,
          estimation.tollFee.sub(estimation.spreadFee),
          positionEst.positionSize,
          estimation.realizedPnl,
          positionEst.unrealizedPnl,
          estimation.badDebt,
          0,
          positionEst.spotPrice,
          positionEst.fundingPayment
        );
      expect(estimation.marginToVault).eq(toFullDigitBN(10));
    });

    it("increase position estimation", async () => {
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);
      const estimation = await clearingHouseViewer.getOpenPositionEstimation(
        amm.address,
        alice.address,
        Side.BUY,
        toFullDigitBN(100),
        toFullDigitBN(10)
      );
      const positionEst = estimation.positionInfo;
      const tx = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);
      const positionInfo = await clearingHouseViewer.getTraderPositionInfo(amm.address, alice.address);
      expect(positionEst.positionSize).eq(positionInfo.positionSize);
      expect(positionEst.positionNotional).eq("218032786885245901637");
      expect(positionEst.entryPrice).eq(positionInfo.entryPrice);
      expect(positionEst.fundingPayment).eq(positionInfo.fundingPayment);
      expect(positionEst.leverage).eq("5732758620689655197");
      expect(positionEst.liquidationPrice).eq(positionInfo.liquidationPrice);
      expect(positionEst.margin).eq("38032786885245901637");
      expect(positionEst.marginRatio).eq(positionInfo.marginRatio);
      expect(positionEst.openLeverage).eq(positionInfo.openLeverage);
      expect(positionEst.openMargin).eq(positionInfo.openMargin);
      expect(positionEst.openNotional).eq(positionInfo.openNotional);
      expect(positionEst.spotPrice).eq(positionInfo.spotPrice);
      expect(positionEst.unrealizedPnl).eq("18032786885245901637");
      expect(tx)
        .emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address,
          amm.address,
          positionEst.openMargin,
          estimation.exchangedQuoteAssetAmount,
          estimation.exchangedPositionSize,
          estimation.tollFee.sub(estimation.spreadFee),
          positionEst.positionSize,
          estimation.realizedPnl,
          positionEst.unrealizedPnl,
          estimation.badDebt,
          0,
          positionEst.spotPrice,
          positionEst.fundingPayment
        );
      expect(estimation.marginToVault).eq(toFullDigitBN(10));
    });

    it("reduce position estimation", async () => {
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);
      const estimation = await clearingHouseViewer.getOpenPositionEstimation(
        amm.address,
        alice.address,
        Side.SELL,
        toFullDigitBN(50),
        toFullDigitBN(10)
      );
      const positionEst = estimation.positionInfo;
      const tx = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(50), toFullDigitBN(10), toFullDigitBN(0), true);
      const positionInfo = await clearingHouseViewer.getTraderPositionInfo(amm.address, alice.address);
      expect(positionEst.positionSize).eq(positionInfo.positionSize);
      expect(positionEst.positionNotional).eq("68032786885245901637");
      expect(positionEst.openNotional).eq(positionInfo.openNotional);
      expect(positionEst.entryPrice).eq(positionInfo.entryPrice);
      expect(positionEst.fundingPayment).eq(positionInfo.fundingPayment);
      expect(positionEst.leverage).eq("2426900584795321639");
      expect(positionEst.liquidationPrice).eq(positionInfo.liquidationPrice);
      expect(positionEst.margin).eq("28032786885245901637");
      expect(positionEst.marginRatio).eq(positionInfo.marginRatio);
      expect(positionEst.openLeverage).eq(positionInfo.openLeverage);
      expect(positionEst.openMargin).eq(positionInfo.openMargin);
      expect(positionEst.spotPrice).eq(positionInfo.spotPrice);
      expect(positionEst.unrealizedPnl).eq("10845806604894274172");
      expect(tx)
        .emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address,
          amm.address,
          positionEst.openMargin,
          estimation.exchangedQuoteAssetAmount,
          estimation.exchangedPositionSize,
          estimation.tollFee.sub(estimation.spreadFee),
          positionEst.positionSize,
          estimation.realizedPnl,
          positionEst.unrealizedPnl,
          estimation.badDebt,
          0,
          positionEst.spotPrice,
          positionEst.fundingPayment
        );
    });

    it("reverse position estimation", async () => {
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);
      const estimation = await clearingHouseViewer.getOpenPositionEstimation(
        amm.address,
        alice.address,
        Side.SELL,
        toFullDigitBN(150),
        toFullDigitBN(10)
      );
      const positionEst = estimation.positionInfo;
      const tx = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(150), toFullDigitBN(10), toFullDigitBN(0), true);
      const positionInfo = await clearingHouseViewer.getTraderPositionInfo(amm.address, alice.address);
      expect(positionEst.positionSize).eq("-2813852813852813853");
      expect(positionEst.positionNotional).eq("31967213114754098363");
      expect(positionEst.openNotional).eq(positionInfo.openNotional);
      expect(positionEst.entryPrice).eq("11360655737704918032");
      expect(positionEst.fundingPayment).eq(positionInfo.fundingPayment);
      expect(positionEst.leverage).eq("10000000000000000100");
      expect(positionEst.liquidationPrice).eq("11901639344262295080");
      expect(positionEst.margin).eq("3196721311475409836");
      expect(positionEst.marginRatio).eq(positionInfo.marginRatio);
      expect(positionEst.openLeverage).eq(positionInfo.openLeverage);
      expect(positionEst.openMargin).eq(positionInfo.openMargin);
      expect(positionEst.spotPrice).eq(positionInfo.spotPrice);
      expect(positionEst.unrealizedPnl).eq(0);
      expect(tx)
        .emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address,
          amm.address,
          positionEst.openMargin,
          estimation.exchangedQuoteAssetAmount,
          "-11904761904761904763",
          estimation.tollFee.sub(estimation.spreadFee),
          "-2813852813852813854",
          estimation.realizedPnl,
          positionEst.unrealizedPnl,
          estimation.badDebt,
          0,
          positionEst.spotPrice,
          positionEst.fundingPayment
        );
      expect(estimation.marginToVault).eq("-24836065573770491801");
    });
  });
  // describe("openInterestNotional", () => {
  //   beforeEach(async () => {
  //     await amm.setCap(toFullDigitBN(0), toFullDigitBN(600));
  //     await approve(alice, clearingHouse.address, 1600);
  //     await approve(bob, clearingHouse.address, 1600);
  //   });

  //   it("increase when increase position", async () => {
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(1), toFullDigitBN(0), true);
  //     expect(await clearingHouse.openInterestNotionalMap(amm.address)).eq(toFullDigitBN(600));
  //   });

  //   it("reduce when reduce position", async () => {
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(1), toFullDigitBN(0), true);
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(300), toFullDigitBN(1), toFullDigitBN(0), true);
  //     expect(await clearingHouse.openInterestNotionalMap(amm.address)).eq(toFullDigitBN(300));
  //   });

  //   it("reduce when close position", async () => {
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(400), toFullDigitBN(1), toFullDigitBN(0), true);

  //     await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));

  //     // expect the result will be almost 0 (with a few rounding error)
  //     const openInterestNotional = await clearingHouse.openInterestNotionalMap(amm.address);
  //     expect(openInterestNotional.toNumber()).lte(10);
  //   });

  //   it("increase when traders open positions in different direction", async () => {
  //     await approve(alice, clearingHouse.address, 300);
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(300), toFullDigitBN(1), toFullDigitBN(0), true);
  //     await approve(bob, clearingHouse.address, 300);
  //     await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(300), toFullDigitBN(1), toFullDigitBN(0), true);
  //     expect(await clearingHouse.openInterestNotionalMap(amm.address)).eq(toFullDigitBN(600));
  //   });

  //   it("increase when traders open larger position in reverse direction", async () => {
  //     await approve(alice, clearingHouse.address, 600);
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(1), toFullDigitBN(0), true);
  //     expect(await clearingHouse.openInterestNotionalMap(amm.address)).eq(toFullDigitBN(200));
  //   });

  //   it("is 0 when everyone close position", async () => {
  //     // avoid two closing positions from exceeding the fluctuation limit
  //     await amm.setFluctuationLimitRatio(toFullDigitBN(0.8));

  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);
  //     await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);

  //     await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));
  //     await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(0));

  //     // expect the result will be almost 0 (with a few rounding error)
  //     const openInterestNotional = await clearingHouse.openInterestNotionalMap(amm.address);
  //     expect(openInterestNotional.toNumber()).lte(10);
  //   });

  //   it("is 0 when everyone close position, one of them is bankrupt position", async () => {
  //     await amm.setSpreadRatio(toFullDigitBN(0.1));
  //     await clearingHouse.setBackstopLiquidityProvider(bob.address, true);
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);
  //     await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);

  //     // when alice close, it create bad debt (bob's position is bankrupt), so we can only liquidate her position
  //     // await clearingHouse.closePosition(amm.address, toFullDigitBN(0), { from: alice })
  //     await clearingHouse.connect(bob).liquidate(amm.address, alice.address);

  //     // bypass the restrict mode
  //     await forwardBlockTimestamp(15);
  //     await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(0));

  //     // expect the result will be almost 0 (with a few rounding error)
  //     const openInterestNotional = await clearingHouse.openInterestNotionalMap(amm.address);
  //     expect(openInterestNotional.toNumber()).lte(10);
  //   });

  //   it("stop trading if it's over openInterestCap", async () => {
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(1), toFullDigitBN(0), true);
  //     await expect(
  //       clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0), true)
  //     ).to.be.revertedWith("CH_ONOL");
  //   });

  //   it("won't be limited by the open interest cap if the trader is the whitelist", async () => {
  //     await approve(alice, clearingHouse.address, 700);
  //     await clearingHouse.setWhitelist(alice.address);
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(700), toFullDigitBN(1), toFullDigitBN(0), true);
  //     expect(await clearingHouse.openInterestNotionalMap(amm.address)).eq(toFullDigitBN(700));
  //   });

  //   it("won't stop trading if it's reducing position, even it's more than cap", async () => {
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(1), toFullDigitBN(0), true);
  //     await amm.setCap(toFullDigitBN(0), toFullDigitBN(300));
  //     await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(300), toFullDigitBN(1), toFullDigitBN(0), true);
  //     expect(await clearingHouse.openInterestNotionalMap(amm.address)).eq(toFullDigitBN(300));
  //   });
  // });

  describe("payFunding: when alice.size = 37.5 & bob.size = -187.5", () => {
    beforeEach(async () => {
      await amm.setSpreadRatio(toFullDigitBN(0.5));
      // given alice takes 2x long position (37.5B) with 300 margin
      await approve(alice, clearingHouse.address, 600);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(37.5), true);

      // given bob takes 1x short position (-187.5B) with 1200 margin
      await approve(bob, clearingHouse.address, 1800);
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(1200), toFullDigitBN(1), toFullDigitBN(187.5), true);

      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 300 (alice's margin) + 1200 (bob' margin) = 1500
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(1500, +(await quoteToken.decimals())));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(5900));
      expect(await clearingHouse.vaults(amm.address)).eq(toFullDigitBN(1500));
    });

    it("will generate loss for amm when funding rate is positive and amm hold more long position", async () => {
      // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.59));

      // when the new fundingRate is 1% which means underlyingPrice < snapshotPrice
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.01));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.01));

      // then alice need to pay 1% of her position size as fundingPayment
      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
      const alicePosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address);
      expect(alicePosition.size).to.eq(toFullDigitBN(37.5));
      expect(alicePosition.margin).to.eq(toFullDigitBN(299.625));

      // then bob will get 1% of her position size as fundingPayment
      // {balance: -187.5, margin: 1200} => {balance: -187.5, margin: 1201.875}
      const bobPosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address);
      expect(bobPosition.size).to.eq(toFullDigitBN(-187.5));
      expect(bobPosition.margin).to.eq(toFullDigitBN(1201.875));

      // then fundingPayment will generate 1.5 loss and clearingHouse will withdraw in advanced from insuranceFund
      // clearingHouse: 1500 + 1.5
      // insuranceFund: 5900 - 1.5
      const clearingHouseQuoteTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      expect(clearingHouseQuoteTokenBalance).to.eq(toFullDigitBN(1501.5, +(await quoteToken.decimals())));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).to.eq(toFullDigitBN(5898.5, +(await quoteToken.decimals())));
    });

    it("will keep generating the same loss for amm when funding rate is positive and amm hold more long position", async () => {
      // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.59));

      // when the new fundingRate is 1% which means underlyingPrice < snapshotPrice, long pays short
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // same as above test case:
      // there are only 2 traders: bob and alice
      // alice need to pay 1% of her position size as fundingPayment (37.5 * 1% = 0.375)
      // bob will get 1% of her position size as fundingPayment (187.5 * 1% = 1.875)
      // ammPnl = 0.375 - 1.875 = -1.5
      // clearingHouse payFunding twice in the same condition
      // then fundingPayment will generate 1.5 * 2 loss and clearingHouse will withdraw in advanced from insuranceFund
      // clearingHouse: 1500 + 3
      // insuranceFund: 6900 - 3
      const clearingHouseQuoteTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      expect(clearingHouseQuoteTokenBalance).to.eq(toFullDigitBN(1503, +(await quoteToken.decimals())));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).to.eq(toFullDigitBN(5897, +(await quoteToken.decimals())));
    });

    it("funding rate is 1%, 1% then -1%", async () => {
      // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.59));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.01));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.01));

      // then alice need to pay 1% of her position size as fundingPayment
      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        toFullDigitBN(299.625)
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq(toFullDigitBN(299.625));

      // pay 1% funding again
      // {balance: 37.5, margin: 299.625} => {balance: 37.5, margin: 299.25}
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.02));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.02));
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        toFullDigitBN(299.25)
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq(toFullDigitBN(299.25));

      // pay -1% funding
      // {balance: 37.5, margin: 299.25} => {balance: 37.5, margin: 299.625}
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.61));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.01));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.01));
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        toFullDigitBN(299.625)
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq(toFullDigitBN(299.625));
    });

    it("funding rate is 1%, -1% then -1%", async () => {
      // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.59));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // then alice need to pay 1% of her position size as fundingPayment
      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.01));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.01));
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        toFullDigitBN(299.625)
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq(toFullDigitBN(299.625));

      // pay -1% funding
      // {balance: 37.5, margin: 299.625} => {balance: 37.5, margin: 300}
      await gotoNextFundingTime();
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.61));
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0));
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(toFullDigitBN(300));
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq(toFullDigitBN(300));

      // pay -1% funding
      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 300.375}
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(-0.01));
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(-0.01));
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        toFullDigitBN(300.375)
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq(toFullDigitBN(300.375));
    });

    it("has huge funding payment profit that doesn't need margin anymore", async () => {
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // then alice will get 2000% of her position size as fundingPayment
      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 1050}
      // then alice can withdraw more than her initial margin while remain the enough margin ratio
      await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(400));

      // margin = 1050 - 400 = 650
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(toFullDigitBN(650));
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq(toFullDigitBN(650));
    });

    it("has huge funding payment loss that the margin become negative with bad debt of long position", async () => {
      await clearingHouse.setBackstopLiquidityProvider(alice.address, true);
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // then bob will get 2000% of her position size as fundingPayment
      // funding payment: -187.5 x 2000% = -3750, margin is 1200 so bad debt = -3750 + 1200 = 2550
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address)).margin).eq(toFullDigitBN(-2550));

      // liquidate the bad debt position
      const tx = await clearingHouse.connect(alice).liquidate(amm.address, bob.address);
      const receipt = await tx.wait();
      const event = receipt.events?.find((x) => {
        return x.event == "PositionChanged";
      });

      expect(event?.args).to.not.be.null;
      expect(event?.args?.[9]).to.eq(toFullDigitBN(2550)); // bad debt
      expect(event?.args?.[12]).to.eq(toFullDigitBN(3750)); // funding payment
    });

    it("has huge funding payment loss that the margin become negative, can add margin", async () => {
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // then bob will get 2000% of her position size as fundingPayment
      // funding payment: -187.5 x 2000% = -3750, margin is 1200 so bad debt = -3750 + 1200 = 2550
      // margin can be added but will still shows 0 until it's larger than bad debt
      await approve(bob, clearingHouse.address, 1);
      await clearingHouse.connect(bob).addMargin(amm.address, toFullDigitBN(1));
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address)).margin).eq(toFullDigitBN(-2549));
    });

    it("has huge funding payment loss that the margin become 0, can not remove margin", async () => {
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // then bob will get 2000% of her position size as fundingPayment
      // funding payment: -187.5 x 2000% = -3750, margin is 1200 so bad debt = -3750 + 1200 = 2550
      // margin can't removed
      await expect(clearingHouse.connect(bob).removeMargin(amm.address, toFullDigitBN(1))).to.be.revertedWith("CH_MNE");
    });

    it("reduce bad debt after adding margin to a underwater position", async () => {
      await clearingHouse.setBackstopLiquidityProvider(alice.address, true);
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // then bob will get 2000% of her position size as fundingPayment
      // funding payment: -187.5 x 2000% = -3750, margin is 1200 so bad debt = -3750 + 1200 = 2550
      // margin can be added but will still shows 0 until it's larger than bad debt
      // margin can't removed
      await approve(bob, clearingHouse.address, 10);
      await clearingHouse.connect(bob).addMargin(amm.address, toFullDigitBN(10));

      // close bad debt position
      // badDebt 2550 - 10 margin = 2540

      const tx = await clearingHouse.connect(alice).liquidate(amm.address, bob.address);
      const receipt = await tx.wait();
      const event = receipt.events?.find((x) => {
        return x.event == "PositionChanged";
      });

      expect(event?.args).to.not.be.null;
      expect(event?.args?.[9]).to.eq(toFullDigitBN(2540)); // bad debt
      expect(event?.args?.[12]).to.eq(toFullDigitBN(3750)); // funding payment
    });

    it("will change nothing if the funding rate is 0", async () => {
      // when the underlying twap price is $1.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.6));

      // when the new fundingRate is 0% which means underlyingPrice = snapshotPrice
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(0);
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(0);

      // then alice's position won't change
      // {balance: 37.5, margin: 300}
      const alicePosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address);
      expect(alicePosition.size).to.eq(toFullDigitBN(37.5));
      expect(alicePosition.margin).to.eq(toFullDigitBN(300));

      // then bob's position won't change
      // {balance: -187.5, margin: 1200}
      const bobPosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address);
      expect(bobPosition.size).to.eq(toFullDigitBN(-187.5));
      expect(bobPosition.margin).to.eq(toFullDigitBN(1200));

      // clearingHouse: 1500
      // insuranceFund: 5900
      const clearingHouseBaseToken = await quoteToken.balanceOf(clearingHouse.address);
      expect(clearingHouseBaseToken).to.eq(toFullDigitBN(1500, +(await quoteToken.decimals())));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).to.eq(toFullDigitBN(5900, +(await quoteToken.decimals())));
    });
  });

  describe("payFunding-dynamic: when alice.size = 37.5 (long) & bob.size  = -187.5 (short)", () => {
    beforeEach(async () => {
      await amm.setFundingCostCoverRate(toFullDigitBN(0.5));
      await amm.setFundingRevenueTakeRate(toFullDigitBN(0.5));
      // given alice takes 2x long position (37.5B) with 300 margin
      await approve(alice, clearingHouse.address, 600);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(37.5), true);

      // given bob takes 1x short position (-187.5B) with 1200 margin
      await approve(bob, clearingHouse.address, 1800);
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(1200), toFullDigitBN(1), toFullDigitBN(187.5), true);

      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 300 (alice's margin) + 1200 (bob' margin) = 1500
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(1500, +(await quoteToken.decimals())));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).eq(toFullDigitBN(5000));
      expect(await clearingHouse.vaults(amm.address)).eq(toFullDigitBN(1500));
    });

    it("will generate loss for amm when dynamic funding rate is positive and amm hold more long position", async () => {
      // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.59));

      // normalFraction = 0.01
      // fractionLong = 0.01 * (2*187.5 + 0.5*(-150))/225 = 0.0133333333333333333
      // fractionShort = 0.01 * (2*37.5 - 0.5*(-150))/225 = 0.0066666666666666666
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq("13333333333333333");
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq("6666666666666666");

      // then alice need to pay 1.333% of her position size as fundingPayment
      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.5}
      const alicePosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address);
      expect(alicePosition.size).to.eq(toFullDigitBN(37.5));
      expect(alicePosition.margin).to.eq("299500000000000000013");

      // then bob will get 0.66% of her position size as fundingPayment
      // {balance: -187.5, margin: 1200} => {balance: -187.5, margin: 1201.25}
      const bobPosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address);
      expect(bobPosition.size).to.eq(toFullDigitBN(-187.5));
      expect(bobPosition.margin).to.eq("1201249999999999999875");

      // then fundingPayment will generate 0.75 loss and clearingHouse will withdraw in advanced from insuranceFund
      // clearingHouse: 1500 + 0.75
      // insuranceFund: 5000 - 0.75
      const clearingHouseQuoteTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      expect(clearingHouseQuoteTokenBalance).to.eq(toFullDigitBN(1500.75, +(await quoteToken.decimals())));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).to.eq(toFullDigitBN(4999.25, +(await quoteToken.decimals())));
    });

    it("will keep generating the same loss for amm when dynamic funding rate is positive and amm hold more long position", async () => {
      // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.59));

      // normalFraction = 0.01
      // fractionLong = 0.01 * (2*187.5 + 0.5*(-150))/225 = 0.0133333333333333333
      // fractionShort = 0.01 * (2*37.5 - 0.5*(-150))/225 = 0.0066666666666666666
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // same as above test case:
      // there are only 2 traders: bob and alice
      // alice need to pay as fundingPayment (37.5 * 0.0133333333333333333 = 0.375)
      // bob will get as fundingPayment (187.5 * 0.0066666666666666666 = 1.875)
      // ammPnl = -0.75
      // clearingHouse payFunding twice in the same condition
      // then fundingPayment will generate 0.75 * 2 loss and clearingHouse will withdraw in advanced from insuranceFund
      // clearingHouse: 1500 + 1.5
      // insuranceFund: 5000 - 1.5
      const clearingHouseQuoteTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      expect(clearingHouseQuoteTokenBalance).to.eq(toFullDigitBN(1501.5, +(await quoteToken.decimals())));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).to.eq(toFullDigitBN(4998.5, +(await quoteToken.decimals())));
    });

    it("normal funding rate is 1%, 1% then -1%", async () => {
      // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.59));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq("13333333333333333");
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq("6666666666666666");

      // then alice need to pay 1% of her position size as fundingPayment
      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.5}
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        "299500000000000000013"
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq("299500000000000000013");

      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address)).margin).eq(
        "1201249999999999999875"
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, bob.address)).eq("1201249999999999999875");

      // pay 1% funding again
      // {balance: 37.5, margin: 299.5} => {balance: 37.5, margin: 299}
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq("26666666666666666");
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq("13333333333333332");
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        "299000000000000000025"
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq("299000000000000000025");

      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address)).margin).eq(
        "1202499999999999999750"
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, bob.address)).eq("1202499999999999999750");

      // pay -1% funding
      // {balance: 37.5, margin: 299} => {balance: 37.5, margin: 299.5}
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.61));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq("13333333333333333");
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq("6666666666666666");
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        "299500000000000000013"
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq("299500000000000000013");
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address)).margin).eq(
        "1201249999999999999875"
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, bob.address)).eq("1201249999999999999875");
    });

    it("has huge dynamic funding payment profit that doesn't need margin anymore", async () => {
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      // fractionLong = -20 * (2*187.5 + 0.5*(-150))/225 = -26.666666666666
      // fractionShort = -20 * (2*37.5 - 0.5*(-150))/225 = -13.333333333333
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 1299.9999999999}
      // then alice can withdraw more than her initial margin while remain the enough margin ratio
      await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(400));

      // margin = 1299.9999999999 - 400 = 899.9999999999
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address)).margin).eq(
        "899999999999999999975"
      );
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).eq("899999999999999999975");
    });

    it("has huge dynamic funding payment loss that the margin become negative with bad debt of long position", async () => {
      await clearingHouse.setBackstopLiquidityProvider(alice.address, true);
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      // fractionLong = -20 * (2*187.5 + 0.5*(-150))/225 = -26.666666666666
      // fractionShort = -20 * (2*37.5 - 0.5*(-150))/225 = -13.333333333333
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // then bob will get 2000% of her position size as fundingPayment
      // funding payment: -187.5 x 13.333333333333 = -2500, margin is 1200 so bad debt = -2500 + 1200 = 1300
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address)).margin).eq(
        "-1299999999999999999937"
      );

      // liquidate the bad debt position
      const tx = await clearingHouse.connect(alice).liquidate(amm.address, bob.address);
      const receipt = await tx.wait();
      const event = receipt.events?.find((x) => {
        return x.event == "PositionChanged";
      });

      expect(event?.args).to.not.be.null;
      expect(event?.args?.[9]).to.eq("1299999999999999999937"); // bad debt
      expect(event?.args?.[12]).to.eq("2499999999999999999937"); // funding payment
    });

    it("has huge dynamic funding payment loss that the margin become negative, can add margin", async () => {
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // funding payment: -187.5 x 13.333333333333 = -2500, margin is 1200 so bad debt = -2500 + 1200 = 1300
      // margin can be added but will still shows 0 until it's larger than bad debt
      await approve(bob, clearingHouse.address, 1);
      await clearingHouse.connect(bob).addMargin(amm.address, toFullDigitBN(1));
      expect((await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address)).margin).eq(
        "-1298999999999999999937"
      );
    });

    it("has huge dynamic funding payment loss that the margin become 0, can not remove margin", async () => {
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // funding payment: -187.5 x 13.333333333333 = -2500, margin is 1200 so bad debt = -2500 + 1200 = 1300
      // margin can't removed
      await expect(clearingHouse.connect(bob).removeMargin(amm.address, toFullDigitBN(1))).to.be.revertedWith("CH_MNE");
    });

    it("reduce bad debt after adding margin to a underwater position", async () => {
      await clearingHouse.setBackstopLiquidityProvider(alice.address, true);
      // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(21.6));
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);

      // funding payment: -187.5 x 13.333333333333 = -2500, margin is 1200 so bad debt = -2500 + 1200 = 1300
      // margin can be added but will still shows 0 until it's larger than bad debt
      // margin can't removed
      await approve(bob, clearingHouse.address, 10);
      await clearingHouse.connect(bob).addMargin(amm.address, toFullDigitBN(10));

      // close bad debt position
      // badDebt 1299.999999999999999937 - 10 margin = 1289.999999999999999937

      const tx = await clearingHouse.connect(alice).liquidate(amm.address, bob.address);
      const receipt = await tx.wait();
      const event = receipt.events?.find((x) => {
        return x.event == "PositionChanged";
      });

      expect(event?.args).to.not.be.null;
      expect(event?.args?.[9]).to.eq("1289999999999999999937"); // bad debt
      expect(event?.args?.[12]).to.eq("2499999999999999999937"); // funding payment
    });

    it("will change nothing if the dynamic funding rate is 0", async () => {
      // when the underlying twap price is $1.6, and current snapShot price is 400B/250Q = $1.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(1.6));

      // when the new fundingRate is 0% which means underlyingPrice = snapshotPrice
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(0);
      expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(0);

      // then alice's position won't change
      // {balance: 37.5, margin: 300}
      const alicePosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, alice.address);
      expect(alicePosition.size).to.eq(toFullDigitBN(37.5));
      expect(alicePosition.margin).to.eq(toFullDigitBN(300));

      // then bob's position won't change
      // {balance: -187.5, margin: 1200}
      const bobPosition = await clearingHouseViewer.getPersonalPositionWithFundingPayment(amm.address, bob.address);
      expect(bobPosition.size).to.eq(toFullDigitBN(-187.5));
      expect(bobPosition.margin).to.eq(toFullDigitBN(1200));

      // clearingHouse: 1500
      // insuranceFund: 5000
      const clearingHouseBaseToken = await quoteToken.balanceOf(clearingHouse.address);
      expect(clearingHouseBaseToken).to.eq(toFullDigitBN(1500, +(await quoteToken.decimals())));
      expect(await insuranceFund.getAvailableBudgetFor(amm.address)).to.eq(toFullDigitBN(5000, +(await quoteToken.decimals())));
    });
  });

  describe("getMarginRatio", () => {
    it("get margin ratio", async () => {
      await approve(alice, clearingHouse.address, 2000);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);

      const marginRatio = await clearingHouse.getMarginRatio(amm.address, alice.address);
      expect(marginRatio).to.eq(toFullDigitBN(0.1));
    });

    it("get margin ratio - long", async () => {
      await approve(alice, clearingHouse.address, 2000);

      // (1000 + x) * (100 + y) = 1000 * 100
      //
      // Alice goes long with 25 quote and 10x leverage
      // open notional: 25 * 10 = 250
      // (1000 + 250) * (100 - y) = 1000 * 100
      // y = 20
      // AMM: 1250, 80
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);

      // Bob goes short with 15 quote and 10x leverage
      // (1250 - 150) * (80 + y) = 1000 * 100
      // y = 10.9090909091
      // AMM: 1100, 90.9090909091
      await approve(bob, clearingHouse.address, 2000);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(150), toFullDigitBN(10), toFullDigitBN(0), true);

      // (1100 - x) * (90.9090909091 + 20) = 1000 * 100
      // position notional / x : 1100 - 901.6393442622 = 198.3606
      // unrealizedPnl: 198.3606 - 250 (open notional) = -51.6394
      // margin ratio:  (25 (margin) - 51.6394) / 198.3606 ~= -0.1342978394
      const marginRatio = await clearingHouse.getMarginRatio(amm.address, alice.address);
      expect(marginRatio).to.eq("-134297520661157024");
    });

    it("get margin ratio - short", async () => {
      await approve(alice, clearingHouse.address, 2000);

      // Alice goes short with 25 quote and 10x leverage
      // open notional: 25 * 10 = 250
      // (1000 - 250) * (100 + y) = 1000 * 100
      // y = 33.3333333333
      // AMM: 750, 133.3333333333
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(33.4), true);

      // Bob goes long with 15 quote and 10x leverage
      // (750 + 150) * (133.3333333333 - y) = 1000 * 100
      // y = 22.222222222
      // AMM: 900, 111.1111111111
      await approve(bob, clearingHouse.address, 2000);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(150), toFullDigitBN(10), toFullDigitBN(0), true);

      // (900 + x) * (111.1111111111 - 33.3333333333) = 1000 * 100
      // position notional / x : 1285.7142857139 - 900 = 385.7142857139
      // the formula of unrealizedPnl when short is the opposite of that when long
      // unrealizedPnl: 250 (open notional) - 385.7142857139 = -135.7142857139
      // margin ratio:  (25 (margin) - 135.7142857139) / 385.7142857139 ~= -0.287037037
      const marginRatio = await clearingHouse.getMarginRatio(amm.address, alice.address);
      expect(marginRatio).to.eq("-287037037037037037");
    });

    // it("get margin ratio - higher twap", async () => {
    //   await approve(alice, clearingHouse.address, 2000);
    //   await approve(bob, clearingHouse.address, 2000);

    //   const timestamp = await amm.mock_getCurrentTimestamp();

    //   // Alice goes long with 25 quote and 10x leverage
    //   // open notional: 25 * 10 = 250
    //   // (1000 + 250) * (100 - y) = 1000 * 100
    //   // y = 20
    //   // AMM: 1250, 80
    //   let newTimestamp = timestamp.add(15);
    //   await amm.mock_setBlockTimestamp(newTimestamp);
    //   await amm.mock_setBlockNumber(10002);
    //   await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(25), toFullDigitBN(10), toFullDigitBN(20));

    //   // Bob goes short with 15 quote and 10x leverage
    //   // (1250 - 150) * (80 + y) = 1000 * 100
    //   // y = 10.9090909091
    //   // AMM: 1100, 90.9090909091
    //   newTimestamp = newTimestamp.add(15 * 62);
    //   await amm.mock_setBlockTimestamp(newTimestamp);
    //   await amm.mock_setBlockNumber(10064);
    //   await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(15), toFullDigitBN(10), toFullDigitBN(0));

    //   // unrealized TWAP Pnl: -0.860655737704918033
    //   // margin ratio: (25 - 0.860655737704918033) / (250 - 0.860655737704918033) = 0.09689093601
    //   newTimestamp = newTimestamp.add(15);
    //   await amm.mock_setBlockTimestamp(newTimestamp);
    //   await amm.mock_setBlockNumber(10065);
    //   const marginRatio = await clearingHouse.getMarginRatio(amm.address, alice.address);
    //   expect(marginRatio).to.eq("96890936009212041");
    // });

    describe("verify margin ratio when there is funding payment", () => {
      it("when funding rate is positive", async () => {
        await approve(alice, clearingHouse.address, 2000);

        // price: 1250 / 80 = 15.625
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);

        // given the underlying twap price: 15.5
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.5));

        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.125));
        expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.125));

        // marginRatio = (margin + funding payment + unrealized Pnl) / positionNotional
        // funding payment: 20 * -12.5% = -2.5
        // position notional: 250
        // margin ratio: (25 - 2.5) / 250 = 0.09
        const aliceMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, alice.address);
        expect(aliceMarginRatio).to.eq(toFullDigitBN(0.09));
      });

      it("when funding rate is negative", async () => {
        await amm.setSpreadRatio(toFullDigitBN(0.5));
        await approve(alice, clearingHouse.address, 2000);

        // price: 1250 / 80 = 15.625
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);

        // given the underlying twap price is 15.7
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.7));

        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(-0.075));
        expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(-0.075));

        // marginRatio = (margin + funding payment + unrealized Pnl) / openNotional
        // funding payment: 20 * 7.5% = 1.5
        // position notional: 250
        // margin ratio: (25 + 1.5) / 250 =  0.106
        const aliceMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, alice.address);
        expect(aliceMarginRatio).to.eq(toFullDigitBN(0.106));
      });

      it("with pnl and funding rate is positive", async () => {
        await amm.setSpreadRatio(toFullDigitBN(0.5));
        await approve(alice, clearingHouse.address, 2000);
        await approve(bob, clearingHouse.address, 2000);

        // price: 1250 / 80 = 15.625
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
        // price: 800 / 125 = 6.4
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(10), toFullDigitBN(45), true);

        // given the underlying twap price: 6.3
        await mockPriceFeed.setTwapPrice(toFullDigitBN(6.3));

        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.1));
        expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.1));

        // marginRatio = (margin + funding payment + unrealized Pnl) / positionNotional
        // funding payment: 20 (position size) * -10% = -2
        // (800 - x) * (125 + 20) = 1000 * 100
        // position notional / x : 800 - 689.6551724138 = 110.3448275862
        // unrealized Pnl: 250 - 110.3448275862 = 139.6551724138
        // margin ratio: (25 - 2 - 139.6551724138) / 110.3448275862 = -1.0571875
        const aliceMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, alice.address);
        expect(aliceMarginRatio).to.eq("-1057187500000000000");

        // funding payment (bob receives): 45 * 10% = 4.5
        // margin ratio: (45 + 4.5) / 450 = 0.11
        const bobMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, bob.address);
        expect(bobMarginRatio).to.eq(toFullDigitBN(0.11));
      });

      it("with pnl and funding rate is negative", async () => {
        await approve(alice, clearingHouse.address, 2000);
        await approve(bob, clearingHouse.address, 2000);

        // price: 1250 / 80 = 15.625
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
        // price: 800 / 125 = 6.4
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(10), toFullDigitBN(45), true);

        // given the underlying twap price: 6.5
        await mockPriceFeed.setTwapPrice(toFullDigitBN(6.5));

        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(-0.1));
        expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(-0.1));

        // funding payment (alice receives): 20 (position size) * 10% = 2
        // (800 - x) * (125 + 20) = 1000 * 100
        // position notional / x : 800 - 689.6551724138 = 110.3448275862
        // unrealized Pnl: 250 - 110.3448275862 = 139.6551724138
        // margin ratio: (25 + 2 - 139.6551724138) / 110.3448275862 = -1.0209375
        const aliceMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, alice.address);
        expect(aliceMarginRatio).to.eq("-1020937500000000000");

        // funding payment: 45 (position size) * -10% = -4.5
        // margin ratio: (45 - 4.5) / 450 = 0.09
        const bobMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, bob.address);
        expect(bobMarginRatio).to.eq(toFullDigitBN(0.09));
      });
    });
    describe("verify margin ratio when there is dynamic funding payment", () => {
      beforeEach(async () => {
        await amm.setFundingCostCoverRate(toFullDigitBN(0.5));
        await amm.setFundingRevenueTakeRate(toFullDigitBN(0.5));
      });
      it("when dynamic funding rate is positive", async () => {
        await approve(alice, clearingHouse.address, 2000);

        // price: 1250 / 80 = 15.625, long = 20, short = 0
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);

        // given the underlying twap price: 15.5
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.5));

        // longFraction: 0.125 * 0.5
        // shortFraction: 0.125 * 1.5
        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(0.125 * 0.5));
        expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq(toFullDigitBN(0.125 * 1.5));

        // marginRatio = (margin + funding payment + unrealized Pnl) / positionNotional
        // funding payment: 20 * -12.5% * 0.5 = -2.5 * 0.5
        // position notional: 250
        // margin ratio: (25 - 2.5*0.5) / 250 = 0.095
        const aliceMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, alice.address);
        expect(aliceMarginRatio).to.eq(toFullDigitBN(0.095));
      });

      it("when dynamic funding rate is negative", async () => {
        await amm.setSpreadRatio(toFullDigitBN(0.5));
        await approve(alice, clearingHouse.address, 2000);

        // price: 1250 / 80 = 15.625, long = 20, short = 0
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);

        // given the underlying twap price is 15.7
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.7));

        // longFraction: -0.075 * 0.5
        // shortFraction: -0.075 * 1.5
        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq(toFullDigitBN(-0.075 * 0.5));
        expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq("-112500000000000000");

        // marginRatio = (margin + funding payment + unrealized Pnl) / openNotional
        // funding payment: 20 * 7.5% *0.5 = 1.5 * 0.5
        // position notional: 250
        // margin ratio: (25 + 1.5 * 0.5) / 250 =  0.103
        const aliceMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, alice.address);
        expect(aliceMarginRatio).to.eq(toFullDigitBN(0.103));
      });

      it("with pnl and dynamic funding rate is positive", async () => {
        await amm.setSpreadRatio(toFullDigitBN(0.5));
        await approve(alice, clearingHouse.address, 2000);
        await approve(bob, clearingHouse.address, 2000);

        // price: 1250 / 80 = 15.625, long - 20
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
        // price: 800 / 125 = 6.4, short - 45
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(10), toFullDigitBN(45), true);

        // given the underlying twap price: 6.3
        await mockPriceFeed.setTwapPrice(toFullDigitBN(6.3));

        // longFraction: 0.1 * (2 * 45 + 0.5*(-25)) / 65 = 0.1192307692
        // shortFraction: 0.1 * (2 * 20 - 0.5*(-25)) / 65 = 0.080769230
        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);

        expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq("119230769230769230");
        expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq("80769230769230769");

        // marginRatio = (margin + funding payment + unrealized Pnl) / positionNotional
        // funding payment: 20 (position size) * -0.1192307692 = -2.3846153846153846
        // (800 - x) * (125 + 20) = 1000 * 100
        // position notional / x : 800 - 689.6551724138 = 110.3448275862
        // unrealized Pnl: 250 - 110.3448275862 = 139.6551724138
        // margin ratio: (25 - 2.3846153846153846 - 139.6551724138) / 110.3448275862 = -1.06067
        const aliceMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, alice.address);
        expect(aliceMarginRatio).to.eq("-1060673076923076922");

        // funding payment (bob receives): 45 * 0.080769230 = 4.5
        // margin ratio: (45 + 4.5) / 450 = 0.108076923
        const bobMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, bob.address);
        expect(bobMarginRatio).to.eq("108076923076923076");

        // 5350 - 0.1 * 25 * 0.5
        expect(await insuranceFund.getAvailableBudgetFor(amm.address)).to.eq(toFullDigitBN(5348.75, +(await quoteToken.decimals())));
      });

      it("with pnl and dynamic funding rate is negative", async () => {
        await approve(alice, clearingHouse.address, 2000);
        await approve(bob, clearingHouse.address, 2000);

        // price: 1250 / 80 = 15.625
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
        // price: 800 / 125 = 6.4
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(10), toFullDigitBN(45), true);

        // given the underlying twap price: 6.5
        await mockPriceFeed.setTwapPrice(toFullDigitBN(6.5));

        // longFraction: -0.1 * (2 * 45 + 0.5*(-25)) / 65 = -0.1192307692
        // shortFraction: -0.1 * (2 * 20 - 0.5*(-25)) / 65 = -0.080769230
        await gotoNextFundingTime();
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFractionLong(amm.address)).eq("-119230769230769230");
        expect(await clearingHouse.getLatestCumulativePremiumFractionShort(amm.address)).eq("-80769230769230769");

        // funding payment (alice receives): 20 (position size) * 0.1192307692  = 2.384615384
        // (800 - x) * (125 + 20) = 1000 * 100
        // position notional / x : 800 - 689.6551724138 = 110.3448275862
        // unrealized Pnl: 250 - 110.3448275862 = 139.6551724138
        // margin ratio: (25 + 2.384615384 - 139.6551724138) / 110.3448275862 = -1.0174519
        const aliceMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, alice.address);
        expect(aliceMarginRatio).to.eq("-1017451923076923077");

        // funding payment: 45 (position size) * -0.080769230 = -3.63461535
        // margin ratio: (45 - 3.63461535) / 450 = 0.091923
        const bobMarginRatio = await clearingHouseViewer.getMarginRatio(amm.address, bob.address);
        expect(bobMarginRatio).to.eq("91923076923076923");

        // 5000 + 0.1 * 25 * 0.5
        expect(await insuranceFund.getAvailableBudgetFor(amm.address)).to.eq(toFullDigitBN(5001.25, +(await quoteToken.decimals())));
      });
    });
  });

  describe("clearingHouse", () => {
    beforeEach(async () => {
      await amm.setSpreadRatio(toFullDigitBN(0.5));
      await approve(alice, clearingHouse.address, 100);
      const clearingHouseBaseTokenBalance = await quoteToken.allowance(alice.address, clearingHouse.address);
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(100, +(await quoteToken.decimals())));
    });

    it("clearingHouse should have enough balance after close position", async () => {
      await approve(bob, clearingHouse.address, 200);

      // AMM after: 900 : 111.1111111111
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(11.12), true);

      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(4), toFullDigitBN(13.89), true);
      // 20(bob's margin) + 25(alice's margin) = 45
      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigitBN(45, +(await quoteToken.decimals())));

      // when bob close his position (11.11)
      // AMM after: 878.0487804877 : 113.8888888889
      // Bob's PnL = 21.951219512195121950
      // need to return Bob's margin 20 and PnL 21.951 = 41.951
      // clearingHouse balance: 45 - 41.951 = 3.048...
      await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(0));
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("45000000000000000000");
      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq("3048780487804878055");
    });

    it("clearingHouse doesn't have enough balance after close position and ask for InsuranceFund", async () => {
      await approve(bob, clearingHouse.address, 200);

      // AMM after: 900 : 111.1111111111
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(11.12), true);

      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(13.89), true);
      // 20(bob's margin) + 20(alice's margin) = 40
      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigitBN(40, +(await quoteToken.decimals())));

      // when bob close his position (11.11)
      // AMM after: 878.0487804877 : 113.8888888889
      // Bob's PnL = 21.951219512195121950
      // need to return Bob's margin 20 and PnL 21.951 = 41.951
      // clearingHouse balance: 40 - 41.951 = -1.95...
      await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(0));
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("40000000000000000000");
      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigitBN(0));
    });
  });

  describe("fluctuation limit, except liquidation", () => {
    it("force error, open position/internalIncrease exceeds the fluctuation limit", async () => {
      await approve(alice, clearingHouse.address, 100);
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.2));

      // alice pays 20 margin * 5x long quote when 9.0909091 base
      // AMM after: 1100 : 90.9090909, price: 12.1000000012
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(9), true)
      ).to.be.revertedWith("AMM_POFL");
    });

    it("force error, reduce position exceeds the fluctuation limit", async () => {
      await approve(alice, clearingHouse.address, 500);
      await amm.setFluctuationLimitRatio(toFullDigitBN(1));

      // alice pays 250 margin * 1x long to get 20 base
      // AMM after: 1250 : 80, price: 15.625
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);

      await amm.setFluctuationLimitRatio(toFullDigitBN(0.078));
      // AMM after: 1200 : 83.3333333333, price: 14.4
      // price fluctuation: (15.625 - 14.4) / 15.625 = 0.0784
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(50), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("AMM_POFL");
    });
  });

  describe("close position limit", () => {
    it("force error, exceeding fluctuation limit twice in the same block", async () => {
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(1));

      // when bob create a 20 margin * 5x long position when 9.0909091 quoteAsset = 100 DAI
      // AMM after: 1100 : 90.9090909, price: 12.1000000012
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(9), true);

      // when alice create a 20 margin * 5x long position when 7.5757609 quoteAsset = 100 DAI
      // AMM after: 1200 : 83.3333333, price: 14.4000000058
      await forwardBlockTimestamp(15);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.5), true);

      await forwardBlockTimestamp(15);
      // set 0.5 here to avoid the above opening positions from failing
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.043));

      // after alice closes her position partially, price: 13.767109
      // price fluctuation: (14.4000000058 - 13.767109) / 14.4000000058 = 0.0524
      // so it must be reverted
      await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("AMM_POFL");
      // await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));

      // // after bob closes his position partially, price: 13.0612
      // // price fluctuation: (13.767109 - 13.0612) / 13.767109 = 0.04278
      // await amm.setFluctuationLimitRatio(toFullDigitBN(0.042));
      // await expect(clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith(
      //   "price is already over fluctuation limit"
      // );
    });

    describe("slippage limit", () => {
      beforeEach(async () => {
        await amm.setSpreadRatio(toFullDigitBN(0.5));
        await forwardBlockTimestamp(900);
      });

      // Case 1
      it("closePosition, originally long, (amount should pay = 118.03279) at the limit of min quote amount = 118", async () => {
        await approve(alice, clearingHouse.address, 200);
        await approve(bob, clearingHouse.address, 200);

        // when bob create a 20 margin * 5x short position when 9.0909091 quoteAsset = 100 DAI
        // AMM after: 1100 : 90.9090909
        await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(9), true);

        // when alice create a 20 margin * 5x short position when 7.5757609 quoteAsset = 100 DAI
        // AMM after: 1200 : 83.3333333
        await forwardBlockTimestamp(15);
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.5), true);

        // when bob close his position
        // AMM after: 1081.96721 : 92.4242424
        await forwardBlockTimestamp(15);
        await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(118));

        const quoteAssetReserve = await amm.quoteAssetReserve();
        const baseAssetReserve = await amm.baseAssetReserve();
        expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1081.96);
        expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(92.4242);
      });

      // Case 2
      it("closePosition, originally short, (amount should pay = 78.048) at the limit of max quote amount = 79", async () => {
        await approve(alice, clearingHouse.address, 200);
        await approve(bob, clearingHouse.address, 200);

        // when bob create a 20 margin * 5x short position when 11.1111111111 quoteAsset = 100 DAI
        // AMM after: 900 : 111.1111111111
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(11.12), true);

        // when alice create a 20 margin * 5x short position when 13.8888888889 quoteAsset = 100 DAI
        // AMM after: 800 : 125
        await forwardBlockTimestamp(15);
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(13.89), true);

        // when bob close his position
        // AMM after: 878.0487804877 : 113.8888888889
        await forwardBlockTimestamp(15);
        await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(79));

        const quoteAssetReserve = await amm.quoteAssetReserve();
        const baseAssetReserve = await amm.baseAssetReserve();
        expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 1000).to.eq(878.048);
        expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 1000).to.eq(113.888);
      });

      // expectRevert section
      // Case 1
      it("force error, closePosition, originally long, less than min quote amount = 119", async () => {
        await approve(alice, clearingHouse.address, 100);
        await approve(bob, clearingHouse.address, 100);

        await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(9), true);

        await forwardBlockTimestamp(15);
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.5), true);

        await forwardBlockTimestamp(15);
        await expect(clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(119))).to.be.revertedWith("CH_TLRS");
      });

      // Case 2
      it("force error, closePosition, originally short, more than max quote amount = 78", async () => {
        await approve(alice, clearingHouse.address, 100);
        await approve(bob, clearingHouse.address, 100);

        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(11.12), true);

        await forwardBlockTimestamp(15);
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(13.89), true);

        await forwardBlockTimestamp(15);
        await expect(clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(78))).to.be.revertedWith("CH_TMRL");
      });
    });
  });

  describe("pausable functions", () => {
    it("pause by admin", async () => {
      const error = "Pausable: paused";
      await clearingHouse.pause();
      await expect(
        clearingHouse.openPosition(amm.address, Side.BUY, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith(error);

      await expect(clearingHouse.addMargin(amm.address, toFullDigitBN(1))).to.be.revertedWith(error);
      await expect(clearingHouse.removeMargin(amm.address, toFullDigitBN(1))).to.be.revertedWith(error);
      await expect(clearingHouse.closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith(error);
    });

    it("can't pause by non-admin", async () => {
      await expect(clearingHouse.connect(alice).pause()).to.be.revertedWith("'Ownable: caller is not the owner");
    });

    it("pause then unpause by admin", async () => {
      await quoteToken.connect(alice).approve(clearingHouse.address, toFullDigitBN(2));
      await clearingHouse.pause();
      await clearingHouse.unpause();
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0), true);
      await clearingHouse.connect(alice).addMargin(amm.address, toFullDigitBN(1));
      await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(1));
      await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));
    });

    it("pause by admin and can not being paused by non-admin", async () => {
      await clearingHouse.pause();
      await expect(clearingHouse.connect(alice).pause()).to.be.revertedWith("'Ownable: caller is not the owner");
    });
  });

  describe("backstop LP setter", async () => {
    it("set backstop LP by owner", async () => {
      expect(await clearingHouse.connect(admin).backstopLiquidityProviderMap(alice.address)).to.be.false;
      await clearingHouse.connect(admin).setBackstopLiquidityProvider(alice.address, true);
      expect(await clearingHouse.connect(admin).backstopLiquidityProviderMap(alice.address)).to.be.true;
      await clearingHouse.connect(admin).setBackstopLiquidityProvider(alice.address, false);
      expect(await clearingHouse.connect(admin).backstopLiquidityProviderMap(alice.address)).to.be.false;
    });

    it("not allowed to set backstop LP by non-owner", async () => {
      await expect(clearingHouse.connect(alice).setBackstopLiquidityProvider(bob.address, true)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("ownership renounce", async () => {
    it("not allowed to renounce ownership by admin", async () => {
      await expect(clearingHouse.connect(admin).renounceOwnership()).to.be.revertedWith("OS_NR");
    });
  });
});
