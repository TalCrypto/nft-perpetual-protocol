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
import { formatEther } from "ethers/lib/utils";

use(solidity);

describe("ClearingHouse Liquidation Test", () => {
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
    await mockPriceFeed.setTwapPrice(marketPrice);
  }

  async function deployEnvFixture() {
    const accounts = await ethers.getSigners();
    const admin = accounts[0];
    const alice = accounts[1];
    const bob = accounts[2];
    const carol = accounts[3];
    const relayer = accounts[4];
    const contracts = await fullDeploy({ sender: admin });
    const amm = contracts.amm;
    const insuranceFund = contracts.insuranceFund;
    const quoteToken = contracts.quoteToken;
    const mockPriceFeed = contracts.priceFeed;
    const clearingHouse = contracts.clearingHouse;
    const clearingHouseViewer = contracts.clearingHouseViewer;
    // clearingHouse = contracts.clearingHouse;

    // Each of Alice & Bob have 5000 DAI
    await quoteToken.transfer(alice.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(bob.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(insuranceFund.address, toFullDigitBN(5000, +(await quoteToken.decimals())));

    await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));

    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setTwapPrice(marketPrice);

    return { admin, alice, bob, carol, relayer, amm, insuranceFund, quoteToken, mockPriceFeed, clearingHouse, clearingHouseViewer };
  }

  beforeEach(async () => {
    const fixture = await loadFixture(deployEnvFixture);
    admin = fixture.admin;
    alice = fixture.alice;
    bob = fixture.bob;
    carol = fixture.carol;
    relayer = fixture.relayer;
    amm = fixture.amm;
    insuranceFund = fixture.insuranceFund;
    quoteToken = fixture.quoteToken;
    mockPriceFeed = fixture.mockPriceFeed;
    clearingHouse = fixture.clearingHouse;
    clearingHouseViewer = fixture.clearingHouseViewer;
  });

  describe("liquidate", () => {
    beforeEach(async () => {
      await forwardBlockTimestamp(900);
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(0.25));
      await clearingHouse.setLiquidationFeeRatio(toFullDigitBN(0.025));
    });

    it("partially liquidate a long position", async () => {
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when alice create a 25 margin * 10x position to get 20 long position
      // AMM after: 1250 : 80
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 45.18072289 margin * 1x position to get 3 short position
      // AMM after: 1204.819277 : 83
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(45.18072289), toFullDigitBN(1), toFullDigitBN(0), true);

      // partially liquidate 25%
      // liquidated positionNotional: getOutputPrice(20 (original position) * 0.25) = 68.455
      // remain positionNotional: 233.945 - 68.455 = 165.49
      // total pnl = openNotional - getOutputPrice(20) == 250 - 233.945 = 16.054(loss)
      // realizedPnl = 16.054 * 0.25 = 4.01, unrealizedPnl = 16.054 - 4.01 = 12.04
      // liquidationPenalty = liquidation fee + fee to InsuranceFund
      //                    = 68.455 * 0.0125 + 68.455 * 0.0125 = 1.711
      // remain margin = margin - realizedPnl - liquidationPenalty = 25 - 4.01 - 1.711 = 19.27
      // margin ratio = (remain margin - unrealizedPnl) / remain positionNotional
      //              = (19.27 - 12.04) / 165.49 = 0.0437

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0)))
        .to.emit(clearingHouse, "PositionLiquidated")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "68455640744970299585", // positionNotional
          toFullDigitBN(5), // positionSize
          "855695509312128744", // feeToLiquidator
          "855695509312128745", //feeToIF
          carol.address, // liquidator
          "0" // badDebt
        )
        .to.emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "19274981656679729691", // margin
          "68455640744970299585", // positionNotional
          toFullDigitBN(-5), // exchangedPositionSize
          toFullDigitBN(0), // fee
          toFullDigitBN(15), // positionSizeAfter
          "-4013627324696012820", // realizedPnl
          "-12040881974088038460", // unrealizedPnlAfter
          toFullDigitBN(0), // badDebt
          "1711391018624257489", // liquidationPenalty
          "12913223140527534513", // spotPrice
          "0" // fundingPayment
        );

      expect((await clearingHouse.getPosition(amm.address, alice.address)).margin).to.eq("19274981656679729691");
      expect(await clearingHouse.getMarginRatio(amm.address, alice.address)).to.eq("43713253015241334");
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(toFullDigitBN(15));
      // Change from 855695 to 5000855695509312128745 because perp v1 use 6 decimals quote token but we are using 18 decimals
      expect(await quoteToken.balanceOf(carol.address)).to.eq("855695509312128744");
      // Change from 5000855695 to 5000855695509312128745
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("5000855695509312128745");
    });

    it("partially liquidate a long position with quoteAssetAmountLimit", async () => {
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when alice create a 25 margin * 10x position to get 20 long position
      // AMM after: 1250 : 80
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 45.18072289 margin * 1x position to get 3 short position
      // AMM after: 1204.819277 : 83
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(45.18072289), toFullDigitBN(1), toFullDigitBN(0), true);

      // partially liquidate 25%
      // liquidated positionNotional: getOutputPrice(20 (original position) * 0.25) = 68.455
      // if quoteAssetAmountLimit == 273.85 > 68.455 * 4 = 273.82, quote asset gets is less than expected, thus tx reverts
      await expect(
        clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(273.85))
      ).to.be.revertedWith("CH_TLRS");

      // if quoteAssetAmountLimit == 273.8 < 68.455 * 4 = 273.82, quote asset gets is more than expected
      await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(273.8));
    });

    it("partially liquidate a short position", async () => {
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when alice create a 20 margin * 10x position to get 25 short position
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 19.67213115 margin * 1x position to get 3 long position
      // AMM after: 819.6721311 : 122
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(19.67213115), toFullDigitBN(1), toFullDigitBN(0), true);

      // remainMargin = (margin + unrealizedPnL) = 20 - 15.38 = 4.62
      // marginRatio = remainMargin / openNotional = 4.62 / 100 = 0.0462 < minMarginRatio(0.05)
      // then anyone (eg. carol) can liquidate alice's position
      await syncAmmPriceToOracle();

      // partially liquidate 25%
      // liquidated positionNotional: getOutputPrice(25 (original position) * 0.25) = 44.258
      // remain positionNotional: 211.255 - 44.258 = 166.997
      // total pnl = openNotional - getOutputPrice(25) == 200 - 211.255 = 11.255(loss)
      // realizedPnl = 11.255 * 0.25 = 2.81, unrealizedPnl = 11.255 - 2.81 = 8.44
      // liquidationPenalty = liquidation fee + fee to InsuranceFund
      //                    = 44.258 * 0.0125 + 44.258 * 0.0125 = 1.106
      // remain margin = margin - realizedPnl - liquidationPenalty = 20 - 2.81 - 1.106 = 16.079
      // margin ratio = (remain margin - unrealizedPnl) / remain positionNotional
      //              = (16.079 - 8.44) / 166.997 = 0.0457

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0)))
        .to.emit(clearingHouse, "PositionLiquidated")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "44258754381889405651", // positionNotional
          toFullDigitBN(6.25), // positionSize
          "553234429773617570", // liquidationFee
          "553234429773617571", // feeToIF
          carol.address, // liquidator
          "0" // badDebt
        )
        .to.emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "16079605164093693758", // margin
          "44258754381889405651", // positionNotional
          toFullDigitBN(6.25), // exchangedPositionSize
          toFullDigitBN(0), // fee
          toFullDigitBN(-18.75), // positionSizeAfter
          "-2813925976359071101", // realizedPnl
          "-8441777929077213306", // unrealizedPnlAfter
          toFullDigitBN(0), // badDebt
          "1106468859547235141", // liquidationPenalty
          "7463765749759145951", // spotPrice
          "0" // fundingPayment
        );

      expect((await clearingHouse.getPosition(amm.address, alice.address)).margin).to.eq("16079605164093693758");
      expect(await clearingHouse.getMarginRatio(amm.address, alice.address)).to.eq("45736327859926164");
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(toFullDigitBN(-18.75));
      expect(await quoteToken.balanceOf(carol.address)).to.eq("553234429773617570");
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("5000553234429773617571");
    });

    it("partially liquidate a short position with quoteAssetAmountLimit", async () => {
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when alice create a 20 margin * 10x position to get 25 short position
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 19.67213115 margin * 1x position to get 3 long position
      // AMM after: 819.6721311 : 122
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(19.67213115), toFullDigitBN(1), toFullDigitBN(0), true);

      // remainMargin = (margin + unrealizedPnL) = 20 - 15.38 = 4.62
      // marginRatio = remainMargin / openNotional = 4.62 / 100 = 0.0462 < minMarginRatio(0.05)
      // then anyone (eg. carol) can liquidate alice's position
      await syncAmmPriceToOracle();

      // partially liquidate 25%
      // liquidated positionNotional: getOutputPrice(25 (original position) * 0.25) = 44.258
      // if quoteAssetAmountLimit == 177 > 44.258 * 4 = 177.032, quote asset pays is more than expected, thus tx reverts

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(177))).to.be.revertedWith(
        "CH_TMRL"
      );

      // if quoteAssetAmountLimit == 177.1 < 44.258 * 4 = 177.032, quote asset pays is less than expected
      await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(177.1));
    });

    it("a long position is under water, thus liquidating the complete position", async () => {
      await clearingHouse.setBackstopLiquidityProvider(carol.address, true);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when alice create a 25 margin * 10x position to get 20 long position
      // AMM after: 1250 : 80
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 73.52941176 margin * 1x position to get 3 short position
      // AMM after: 1176.470588 : 85
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(73.52941176), toFullDigitBN(1), toFullDigitBN(0), true);
      // alice's margin = -0.910364380952380952
      // the badDebt params of the two events are different
      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0)))
        .to.emit(clearingHouse, "PositionLiquidated")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "224089635855963718818", // positionNotional 224.08
          "20000000000000000000", // positionSize
          "2801120448199546485", // feeToLiquidator
          "0", //feeToIF
          carol.address, // liquidator
          "3711484592235827667" // badDebt
        )
        .to.emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "0", // margin
          "224089635855963718818", // positionNotional
          "-20000000000000000000", // exchangedPositionSize
          toFullDigitBN(0), // fee
          "0", // positionSizeAfter
          "-25910364144036281182", // realizedPnl
          "0", // unrealizedPnlAfter
          "910364144036281182", // badDebt
          "2801120448199546485", // liquidationPenalty margin<0 => liquidationPenalty=feeToLiquidator
          "9070294784639239822", // spotPrice
          "0" // fundingPayment
        );

      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(0);
      expect(await quoteToken.balanceOf(carol.address)).to.eq("2801120448199546485");
      // 5000 - 0.91 - 2.8
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("4996288515407764172333");
    });

    it("a long position is under water, thus liquidating the complete position with quoteAssetAmountLimit", async () => {
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when alice create a 25 margin * 10x position to get 20 long position
      // AMM after: 1250 : 80
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 73.52941176 margin * 1x position to get 3 short position
      // AMM after: 1176.470588 : 85
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(73.52941176), toFullDigitBN(1), toFullDigitBN(0), true);

      // set carol to backstop LP
      await clearingHouse.connect(admin).setBackstopLiquidityProvider(carol.address, true);

      // liquidatedPositionNotional = 224.089635855963718818

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(224.1))).to.be.revertedWith(
        "CH_TLRS"
      );

      await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(224));
    });

    it("a long position is under water with positive remain margin, thus liquidating the whole position", async () => {
      await clearingHouse.setBackstopLiquidityProvider(carol.address, true);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));
      await clearingHouse.setLiquidationFeeRatio(toFullDigitBN(0.05));

      // when alice create a 25 margin * 10x position to get 20 long position
      // AMM after: 1250 : 80
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 73.52941176 margin * 1x position to get 4 short position
      // AMM after: 1190.476190 : 84
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(59.52381), toFullDigitBN(1), toFullDigitBN(0), true);
      expect(await clearingHouse.vaults(amm.address)).equal(toFullDigitBN(84.52381));

      // the badDebt params of the two events are different
      // alice - margin: 3.93773, feeToLiquidator = 5.72325
      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0)))
        .to.emit(clearingHouse, "PositionLiquidated")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "228937728772189349135", // positionNotional
          "20000000000000000000", // positionSize
          "5723443219304733728", // feeToLiquidator
          "0", //feeToIF
          carol.address, // liquidator
          "1785714447115384593" // badDebt
        )
        .to.emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "0", // margin
          "228937728772189349135", // positionNotional
          "-20000000000000000000", // exchangedPositionSize
          toFullDigitBN(0), // fee
          "0", // positionSizeAfter
          "-21062271227810650865", // realizedPnl
          "0", // unrealizedPnlAfter
          "0", // badDebt
          "5723443219304733728", // margin(25) + realizedPnL(-21.06) < feeToLiquidator => liquidationPenalty = liquidationFee
          "9245562124203459263", // spotPrice
          "0" // fundingPayment
        );

      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(0);
      expect(await quoteToken.balanceOf(carol.address)).to.eq("5723443219304733728");
      // 5000 - (liquidationFee-(initial margin + realizedPnl))
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("4998214285552884615407");
    });

    it("a short position is under water, thus liquidating the complete position", async () => {
      await clearingHouse.setBackstopLiquidityProvider(carol.address, true);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when alice create a 20 margin * 10x position to get 25 short position
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 40.33613445 margin * 1x position to get 3 long position
      // AMM after: 840.3361345 : 119
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(40.33613445), toFullDigitBN(1), toFullDigitBN(0), true);

      await syncAmmPriceToOracle();

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0)))
        .to.emit(clearingHouse, "PositionLiquidated")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "223493652777982118604", // positionNotional
          toFullDigitBN(25), // positionSize
          "2793670659724776482", // liquidationFee
          "0", //
          carol.address, // liquidator
          "6287323437706895086" // badDebt
        )
        .to.emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "0", // margin
          "223493652777982118604", // positionNotional
          "25000000000000000000", // exchangedPositionSize
          toFullDigitBN(0), // fee
          "0", // positionSizeAfter
          "-23493652777982118604", // realizedPnl
          "0", // unrealizedPnlAfter
          "3493652777982118604", // badDebt
          "2793670659724776482", // liquidationPenalty
          "11317338161935337063", // spotPrice
          "0" // fundingPayment
        );

      // expectEvent(receipt, "PositionLiquidated", {
      //     amm: amm.address,
      //     trader: alice,
      //     positionNotional: "223493652777982118604",
      //     positionSize: toFullDigitBN(25),
      //     liquidationFee: "2793670659724776482",
      //     liquidator: carol,
      //     badDebt: "2793670659724776482",
      // })

      // expectEvent(receipt, "PositionChanged", {
      //     margin: "0",
      //     positionNotional: "223493652777982118604",
      //     exchangedPositionSize: "25000000000000000000",
      //     positionSizeAfter: "0",
      //     realizedPnl: "-23493652777982118604",
      //     unrealizedPnlAfter: "0",
      //     liquidationPenalty: "20000000000000000000",
      //     badDebt: "3493652777982118604",
      // })

      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(0);
      expect(await quoteToken.balanceOf(carol.address)).to.eq("2793670659724776482");
      // 5000 - 3.49 - 2.79
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("4993712676562293104914");
    });

    it("a short position is under water with positive remain margin, thus liquidating the whole position", async () => {
      await clearingHouse.setBackstopLiquidityProvider(carol.address, true);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));
      await clearingHouse.setLiquidationFeeRatio(toFullDigitBN(0.05));

      // when alice create a 20 margin * 10x position to get 25 short position
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // when bob create a 33.333333 margin * 1x position to get 5 long position
      // AMM after: 833.333333 : 120
      await forwardBlockTimestamp(15); // 15 secs. later
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(33.333333), toFullDigitBN(1), toFullDigitBN(0), true);

      await syncAmmPriceToOracle();

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0)))
        .to.emit(clearingHouse, "PositionLiquidated")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "219298245415512465429", // positionNotional
          toFullDigitBN(25), // positionSize
          "5482456135387811635", // feeToLiquidator,
          "0", // feeToIF
          carol.address, // liquidator
          "4780701550900277064" // badDebt
        )
        .to.emit(clearingHouse, "PositionChanged")
        .withArgs(
          alice.address, // trader
          amm.address, // amm
          "0", // margin
          "219298245415512465429", // positionNotional
          "25000000000000000000", // exchangedPositionSize
          toFullDigitBN(0), // fee
          "0", // positionSizeAfter
          "-19298245415512465429", // realizedPnl
          "0", // unrealizedPnlAfter
          "0", // badDebt
          "5482456135387811635", // liquidationPenalty
          "11080332398775331684", // spotPrice
          "0" // fundingPayment
        );

      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(0);
      expect(await quoteToken.balanceOf(carol.address)).to.eq("5482456135387811635");
      // 5000 - (liquidationFee-(initial margin + realizedPnl))
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq("4995219298449099722936");
    });

    it("force error, position not liquidatable due to TWAP over maintenance margin", async () => {
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);

      // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
      // AMM after: 1100 : 90.9090909091
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(9.09), true);

      // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
      // AMM after: 1200 : 83.3333333333
      await forwardBlockTimestamp(15);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.57), true);

      // when bob sell his position when 7.5757575758 quoteAsset = 100 DAI
      // AMM after: 1100 : 90.9090909091
      await forwardBlockTimestamp(600);
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.58), true);

      // verify alice's openNotional = 100 DAI
      // spot price PnL = positionValue - openNotional = 84.62 - 100 = -15.38
      // TWAP PnL = (70.42 * 270 + 84.62 * 15 + 99.96 * 600 + 84.62 * 15) / 900 - 100 ~= -9.39
      // Use TWAP price PnL since -9.39 > -15.38
      await forwardBlockTimestamp(15);
      const positionBefore = await clearingHouse.getPosition(amm.address, alice.address);
      expect(positionBefore.openNotional).to.eq(toFullDigitBN(100));
      expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).to.eq(
        "-15384615384615384623"
      );
      expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.TWAP)).to.eq("-9386059949440231138");

      // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + (-9.39)) / 100 = 0.1061 > 0.05 = minMarginRatio
      // then anyone (eg. carol) calling liquidate() would get an exception
      await syncAmmPriceToOracle();

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0))).to.be.revertedWith(
        "CH_MRNC"
      );
    });

    it("force error, position not liquidatable due to SPOT price over maintenance margin", async () => {
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);

      // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
      // AMM after: 1100 : 90.9090909091
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(9.09), true);

      // verify alice's openNotional = 100 DAI
      // spot price PnL = positionValue - openNotional = 100 - 100 = 0
      // TWAP PnL = (83.3333333333 * 885 + 100 * 15) / 900 - 100 = -16.39
      // Use spot price PnL since 0 > -16.39
      await forwardBlockTimestamp(15);
      const positionBefore = await clearingHouse.getPosition(amm.address, alice.address);
      expect(positionBefore.openNotional).to.eq(toFullDigitBN(100));

      // workaround: rounding error, should be 0 but it's actually 10 wei
      const spotPnl = await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE);
      expect(spotPnl.div(10)).to.eq("0");
      expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.TWAP)).to.eq("-16388888888888888891");

      // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + 0) / 100 = 0.2 > 0.05 = minMarginRatio
      // then anyone (eg. carol) calling liquidate() would get an exception
      await syncAmmPriceToOracle();
      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0))).to.be.revertedWith(
        "CH_MRNC"
      );
    });

    it("force error, can't liquidate an empty position", async () => {
      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0))).to.be.revertedWith(
        "CH_ZP"
      );
    });
  });

  describe("fluctuation check when liquidating", () => {
    beforeEach(async () => {
      await forwardBlockTimestamp(900);
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(0.25));
      await clearingHouse.setLiquidationFeeRatio(toFullDigitBN(0.025));
    });

    async function openSmallPositions(
      account: SignerWithAddress,
      side: Side,
      margin: BigNumber,
      leverage: BigNumber,
      count: number
    ): Promise<void> {
      for (let i = 0; i < count; i++) {
        await clearingHouse
          .connect(account)
          .openPosition(amm.address, side, margin.mul(leverage).div(toFullDigitBN("1")), leverage, toFullDigitBN(0), true);
        await forwardBlockTimestamp(15);
      }
    }

    it("partially liquidate one position within the fluctuation limit", async () => {
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.041));

      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100
      // AMM after: 1100 : 90.9090909091
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100
      // AMM after: 1200 : 83.3333333333
      // alice get: 90.9090909091 - 83.3333333333 = 7.5757575758
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(4), toFullDigitBN(5), 5);

      // liquidate -> return 25% base asset to AMM
      // 90.9090909091 + 1.89 = 92.8
      // AMM after: 1077.55102 : 92.8, price: 11.61
      // fluctuation: (12.1 - 11.61116202) / 12.1 = 0.04039983306
      // values can be retrieved with amm.quoteAssetReserve() & amm.baseAssetReserve()
      await syncAmmPriceToOracle();
      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0))).to.emit(
        clearingHouse,
        "PositionLiquidated"
      );

      const baseAssetReserve = await amm.baseAssetReserve();
      const quoteAssetReserve = await amm.quoteAssetReserve();
      //expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(92.803)
      expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1077.55);
    });

    it("partially liquidate two positions within the fluctuation limit", async () => {
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.041));
      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);

      await transfer(admin, traderWallet1.address, 1000);
      await transfer(admin, bob.address, 1000);
      await transfer(admin, carol.address, 1000);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await approve(carol, clearingHouse.address, 100);
      // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.199));

      // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100
      // AMM after: 1100 : 90.9090909091
      // actual margin ratio is 19.99...9%
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100
      // AMM after: quote = 1150
      await openSmallPositions(carol, Side.BUY, toFullDigitBN(2), toFullDigitBN(5), 5);

      // when alice create a 10 margin * 5x long position
      // AMM after: quote = 1200
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(2), toFullDigitBN(5), 5);

      // bob short 100
      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(4), toFullDigitBN(5), 5);

      // AMM after: 1077.55102 : 92.8, price: 11.61
      // fluctuation: (12.1 - 11.61116202) / 12.1 = 0.04039983306
      await syncAmmPriceToOracle();
      await traderWallet1.connect(admin).twoLiquidations(amm.address, alice.address, carol.address);

      const baseAssetReserve = await amm.baseAssetReserve();
      const quoteAssetReserve = await amm.quoteAssetReserve();
      expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(92.803);
      expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1077.55);
    });

    it("partially liquidate three positions within the fluctuation limit", async () => {
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.06));
      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);
      await clearingHouse.setBackstopLiquidityProvider(traderWallet1.address, true);

      await transfer(admin, traderWallet1.address, 1000);
      await transfer(admin, bob.address, 1000);
      await transfer(admin, carol.address, 1000);
      await transfer(admin, relayer.address, 1000);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await approve(carol, clearingHouse.address, 100);
      await approve(relayer, clearingHouse.address, 100);
      // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.199));

      // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100
      // AMM after: 1100 : 90.9090909091
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100
      // AMM after: quote = 1150 : 86.9565217391
      await openSmallPositions(carol, Side.BUY, toFullDigitBN(2), toFullDigitBN(5), 5);

      // when alice create a 10 margin * 5x long position
      // AMM after: quote = 1200 : 83.3333333333
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(2), toFullDigitBN(5), 5);

      // when relayer create a 2 margin * 5x long position
      // AMM after: quote = 1210 : 82.6446281
      // alice + carol + relayer get: 90.9090909091 - 82.6446281 = 8.2644628091
      await openSmallPositions(relayer, Side.BUY, toFullDigitBN(0.4), toFullDigitBN(5), 5);

      // AMM after: 1110 : 90.09009009, price: 12.321
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(4), toFullDigitBN(5), 5);

      // AMM after: close to 1079.066031 : 92.67273, price: 11.64383498
      // fluctuation: (12.321 - 11.64383498) / 12.321 = 0.05496023212
      await traderWallet1.connect(admin).threeLiquidations(amm.address, alice.address, carol.address, relayer.address);

      const baseAssetReserve = await amm.baseAssetReserve();
      const quoteAssetReserve = await amm.quoteAssetReserve();
      expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(92.6727);
      expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1079.06);
    });

    it("partially liquidate two positions and completely liquidate one within the fluctuation limit", async () => {
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.12));
      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);

      await transfer(admin, traderWallet1.address, 1000);
      await transfer(admin, bob.address, 1000);
      await transfer(admin, carol.address, 1000);
      await transfer(admin, relayer.address, 1000);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await approve(carol, clearingHouse.address, 100);
      await approve(relayer, clearingHouse.address, 100);
      // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.199));

      // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100
      // AMM after: 1100 : 90.9090909091
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100
      // AMM after: quote = 1150 : 86.9565217391
      await openSmallPositions(carol, Side.BUY, toFullDigitBN(2), toFullDigitBN(5), 5);

      // when alice create a 10 margin * 5x long position
      // AMM after: quote = 1200 : 83.3333333333
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(2), toFullDigitBN(5), 5);

      // when relayer create a 10 margin * 5x long position
      // AMM after: quote = 1250 : 80
      // alice + carol + relayer get: 90.9090909091 - 80 = 10.9090909091
      await openSmallPositions(relayer, Side.BUY, toFullDigitBN(2), toFullDigitBN(5), 5);

      // AMM after: 1150 : 86.9565217391, price: 13.225
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(4), toFullDigitBN(5), 5);

      // alice's & carol's positions are partially closed, while relayer's position is closed completely
      // AMM after: close to 1084.789366 : 92.1837, price: 11.7676797
      // fluctuation: (13.225 - 11.7676797) / 13.225 = 0.1101943516
      await traderWallet1.connect(admin).threeLiquidations(amm.address, alice.address, carol.address, relayer.address);

      const baseAssetReserve = await amm.baseAssetReserve();
      const quoteAssetReserve = await amm.quoteAssetReserve();
      expect(parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).to.eq(92.1837);
      expect(parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).to.eq(1084.78);
    });

    it("liquidate one complete position with the price impact exceeding the fluctuation limit ", async () => {
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.147));
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(1));

      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
      // AMM after: 1100 : 90.9090909091
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
      // AMM after: 1200 : 83.3333333333
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(4), toFullDigitBN(5), 5);

      // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
      // fluctuation: (12.1 - 10.31) / 12.1 = 0.1479
      await syncAmmPriceToOracle();

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0))).to.emit(
        clearingHouse,
        "PositionLiquidated"
      );
    });

    it("partially liquidate one position with the price impact exceeding the fluctuation limit ", async () => {
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(0.5));

      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      // bob pays 20 margin * 5x quote to get 9.0909090909 base
      // AMM after: 1100 : 90.9090909091
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // alice pays 20 margin * 5x quote to get 7.5757575758 base
      // AMM after: 1200 : 83.3333333333
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(4), toFullDigitBN(5), 5);

      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(4), toFullDigitBN(5), 5);

      // AMM after: 1056 : 94.697, price: 11.15136
      // fluctuation: (12.1 - 11.15136) / 12.1 = 0.0784
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.07));

      // temporarily exclude the maintenance margin ratio to openReverse
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0));

      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(44), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("AMM_POFL");

      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));
      await syncAmmPriceToOracle();
      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0))).to.emit(
        clearingHouse,
        "PositionLiquidated"
      );
    });

    it("force error, partially liquidate two positions while exceeding the fluctuation limit", async () => {
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.147));
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(0.5));
      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);

      await transfer(admin, traderWallet1.address, 1000);
      await transfer(admin, bob.address, 1000);
      await transfer(admin, carol.address, 1000);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await approve(carol, clearingHouse.address, 100);
      // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.199));

      // bob pays 20 margin * 5x quote to get 9.0909090909 base
      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(10), toFullDigitBN(5), 2);

      // carol pays 10 margin * 5x quote to get 3.95256917 base
      // AMM after: 1150 : 86.9565217391
      await openSmallPositions(carol, Side.BUY, toFullDigitBN(5), toFullDigitBN(5), 2);

      // alice pays 10 margin * 5x quote to get 3.6231884391 base
      // alice + carol base: 7.5757576091
      // AMM after: 1200 : 83.3333333, price: 14.4
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(5), toFullDigitBN(5), 2);

      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(10), toFullDigitBN(5), 2);

      // for verifying that even though the first tx can exceed the fluctuation limit,
      // there cannot be a second tx after it
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.038));

      // half of alice's base asset: 3.6231884391 / 2 = 1.8115942196
      // AMM after: 1078.5079927008 : 92.7206851287, price: 11.6317949032
      // fluctuation: (12.1 - 11.63) / 12.1 = 0.03884297521
      // half of carol's base asset: 3.95256917 / 2 = 1.976284585
      // AMM after: 1055.9999998134 : 94.6969697137, price: 11.1513599961
      // fluctuation: (11.63 - 11.15) / 11.63 = 0.04127257094
      await expect(traderWallet1.connect(admin).twoLiquidations(amm.address, alice.address, carol.address)).to.be.revertedWith("AMM_POFL");
    });

    it("force error, liquidate two complete positions while exceeding the fluctuation limit", async () => {
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.147));
      // full liquidation
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(1));
      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);

      await transfer(admin, traderWallet1.address, 1000);
      await transfer(admin, bob.address, 1000);
      await transfer(admin, carol.address, 1000);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await approve(carol, clearingHouse.address, 100);
      // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.199));

      // bob pays 20 margin * 5x quote to get 9.0909090909 base
      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(10), toFullDigitBN(5), 2);

      // carol pays 10 margin * 5x quote to get 3.95256917 base
      // AMM after: 1150 : 86.9565217391
      await openSmallPositions(carol, Side.BUY, toFullDigitBN(5), toFullDigitBN(5), 2);

      // alice pays 10 margin * 5x quote to get 3.6231884391 base
      // alice + carol base: 7.5757576091
      // AMM after: 1200 : 83.3333333, price: 14.4
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(5), toFullDigitBN(5), 2);

      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(10), toFullDigitBN(5), 2);

      await amm.setFluctuationLimitRatio(toFullDigitBN(0.075));

      // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
      // fluctuation: (12.1 - 11.19) / 12.1 = 0.07520661157
      // fluctuation: (11.19 - 10.31005917) / 11.19 = 0.07863635657
      // fluctuation: (12.1 - 10.31005917) / 12.1 = 0.1479
      await syncAmmPriceToOracle();

      await expect(traderWallet1.connect(admin).twoLiquidations(amm.address, alice.address, carol.address)).to.be.revertedWith("AMM_POFL");
    });

    it("force error, liquidate three positions while exceeding the fluctuation limit", async () => {
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.21));
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(1));
      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);

      await transfer(admin, traderWallet1.address, 1000);
      await transfer(admin, bob.address, 1000);
      await transfer(admin, carol.address, 1000);
      await transfer(admin, relayer.address, 1000);
      await approve(alice, clearingHouse.address, 100);
      await approve(bob, clearingHouse.address, 100);
      await approve(carol, clearingHouse.address, 100);
      await approve(relayer, clearingHouse.address, 100);
      // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.199));

      // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
      // AMM after: 1100 : 90.9090909091, price: 12.1
      await openSmallPositions(bob, Side.BUY, toFullDigitBN(10), toFullDigitBN(5), 2);

      // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
      // AMM after: 1150 : 86.9565
      await openSmallPositions(carol, Side.BUY, toFullDigitBN(5), toFullDigitBN(5), 2);

      // when alice create a 10 margin * 5x long position
      // AMM after: 1200 : 83.3333333, price: 14.4
      await openSmallPositions(alice, Side.BUY, toFullDigitBN(5), toFullDigitBN(5), 2);

      // when relayer create a 10 margin * 5x long position
      // AMM after: quote = 1250
      await openSmallPositions(relayer, Side.BUY, toFullDigitBN(2), toFullDigitBN(5), 5);

      // AMM after: 1150 : 86.9565, price: 13.225
      await openSmallPositions(bob, Side.SELL, toFullDigitBN(4), toFullDigitBN(5), 5);

      await amm.setFluctuationLimitRatio(toFullDigitBN(0.1));

      // AMM after: close to 1021.8093699518 : 97.8656126482, price: 10.4409438852
      // fluctuation: (13.225 - 10.4409438852) / 13.225 = 0.2105146401
      await syncAmmPriceToOracle();

      await expect(
        traderWallet1.connect(admin).threeLiquidations(amm.address, alice.address, carol.address, relayer.address)
      ).to.be.revertedWith("AMM_POFL");
    });
  });

  describe("liquidator front run hack", () => {
    beforeEach(async () => {
      await transfer(admin, carol.address, 1000);
      await approve(alice, clearingHouse.address, 1000);
      await approve(bob, clearingHouse.address, 1000);
      await approve(carol, clearingHouse.address, 1000);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));
    });

    async function makeAliceLiquidatableByShort() {
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(9.09), true);
      await forwardBlockTimestamp(15);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.57), true);
      await forwardBlockTimestamp(15);
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.58), true);
      await forwardBlockTimestamp(15);
      // remainMargin = (margin + unrealizedPnL) = 20 - 15.38 = 4.62
      // marginRatio of alice = remainMargin / openNotional = 4.62 / 100 = 0.0462 < minMarginRatio(0.05)
    }

    async function makeAliceLiquidatableByLong() {
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await forwardBlockTimestamp(15);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await forwardBlockTimestamp(15);
      await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(0));
      await forwardBlockTimestamp(15);
      // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + (-21.95)) / 100 = -0.0195 < 0.05 = minMarginRatio
    }

    it("liquidator can open position and liquidate in the next block", async () => {
      await clearingHouse.connect(admin).setBackstopLiquidityProvider(carol.address, true);
      await makeAliceLiquidatableByShort();

      await clearingHouse.connect(carol).openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await forwardBlockTimestamp(15);
      await syncAmmPriceToOracle();

      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0))).to.emit(
        clearingHouse,
        "PositionLiquidated"
      );
    });

    it("can open position (short) and liquidate, but can't do anything more action in the same block", async () => {
      await clearingHouse.connect(admin).setBackstopLiquidityProvider(carol.address, true);
      await makeAliceLiquidatableByShort();
      await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0));

      // short to make alice loss more and make insuranceFund loss more
      await clearingHouse.connect(carol).openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await syncAmmPriceToOracle();

      await expect(clearingHouse.connect(carol).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("CH_RM");
    });

    it("can open position (long) and liquidate, but can't do anything more action in the same block", async () => {
      await clearingHouse.setBackstopLiquidityProvider(carol.address, true);
      await makeAliceLiquidatableByLong();

      // short to make alice loss more and make insuranceFund loss more
      await clearingHouse.connect(carol).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await syncAmmPriceToOracle();
      await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0));
      await expect(clearingHouse.connect(carol).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("CH_RM");
    });

    it("can open position and liquidate, but can't do anything more action in the same block", async () => {
      await makeAliceLiquidatableByShort();

      // open a long position, make alice loss less
      await clearingHouse.connect(carol).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(1), toFullDigitBN(0), true);
      await syncAmmPriceToOracle();
      await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0));
      await expect(clearingHouse.connect(carol).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("CH_RM");
    });

    it("can open position (even the same side, short), but can't do anything more action in the same block", async () => {
      await clearingHouse.setBackstopLiquidityProvider(carol.address, true);
      await makeAliceLiquidatableByLong();

      // open a short position, make alice loss less
      await clearingHouse.connect(carol).openPosition(amm.address, Side.SELL, toFullDigitBN(10), toFullDigitBN(1), toFullDigitBN(0), true);
      await syncAmmPriceToOracle();
      await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0));
      await expect(clearingHouse.connect(carol).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("CH_RM");
    });

    it("liquidator can't open and liquidate position in the same block, even from different msg.sender", async () => {
      await transfer(admin, carol.address, 1000);
      await approve(alice, clearingHouse.address, 1000);
      await approve(bob, clearingHouse.address, 1000);
      await approve(carol, clearingHouse.address, 1000);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);
      traderWallet2 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);
      await clearingHouse.setBackstopLiquidityProvider(traderWallet2.address, true);

      await approve(alice, traderWallet1.address, 500);
      await approve(alice, traderWallet2.address, 500);
      await transfer(alice, traderWallet1.address, 500);
      await transfer(alice, traderWallet2.address, 500);

      await makeAliceLiquidatableByShort();
      await traderWallet1.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(5), toFullDigitBN(0));
      await syncAmmPriceToOracle();
      await traderWallet2.connect(bob).liquidate(amm.address, alice.address, toFullDigitBN(0));
      await expect(traderWallet1.connect(bob).closePosition(amm.address)).to.be.revertedWith("CH_RM");
    });

    it("liquidator can't open and liquidate position in the same block, even from different tx.origin", async () => {
      await transfer(admin, carol.address, 1000);
      await approve(alice, clearingHouse.address, 1000);
      await approve(bob, clearingHouse.address, 1000);
      await approve(carol, clearingHouse.address, 1000);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));

      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);
      traderWallet2 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);
      await clearingHouse.setBackstopLiquidityProvider(traderWallet2.address, true);

      await approve(alice, traderWallet1.address, 500);
      await approve(alice, traderWallet2.address, 500);
      await transfer(alice, traderWallet1.address, 500);
      await transfer(alice, traderWallet2.address, 500);

      await makeAliceLiquidatableByShort();
      await traderWallet1.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(5), toFullDigitBN(0));
      await syncAmmPriceToOracle();
      await traderWallet2.connect(carol).liquidate(amm.address, alice.address, toFullDigitBN(0));
      await expect(traderWallet1.connect(admin).closePosition(amm.address)).to.be.revertedWith("CH_RM");
    });
  });

  describe("restriction mode", () => {
    enum Action {
      OPEN = 0,
      CLOSE = 1,
      LIQUIDATE = 2,
    }

    // copy from above so skip the comment for calculation
    async function makeLiquidatableByShort(addr: SignerWithAddress): Promise<void> {
      await clearingHouse.connect(admin).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await forwardBlockTimestamp(15);
      await clearingHouse.connect(addr).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await forwardBlockTimestamp(15);
      await clearingHouse.connect(admin).openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await forwardBlockTimestamp(15);
    }

    beforeEach(async () => {
      traderWallet1 = await new TraderWallet__factory(admin).deploy(clearingHouse.address, quoteToken.address);
      await transfer(admin, traderWallet1.address, 1000);

      await approve(admin, clearingHouse.address, 1000);
      await approve(alice, clearingHouse.address, 1000);
      await approve(bob, clearingHouse.address, 1000);
      await clearingHouse.setMaintenanceMarginRatio(toFullDigitBN(0.2));
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(1));
    });

    it("trigger restriction mode", async () => {
      await clearingHouse.connect(admin).setBackstopLiquidityProvider(alice.address, true);
      // just make some trades to make bob's bad debt larger than 0 by checking args[8] of event
      // price become 11.03 after openPosition
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(50), toFullDigitBN(5), toFullDigitBN(0), true);
      await forwardBlockTimestamp(15);
      // price become 7.23 after openPosition
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      await forwardBlockTimestamp(15);
      // liquidate bad debt position
      await clearingHouse.connect(alice).liquidate(amm.address, bob.address);

      const blockNumber = await clearingHouse.mock_getCurrentBlockNumber();
      expect(await clearingHouse.isInRestrictMode(amm.address, blockNumber)).eq(true);
      expect(await clearingHouse.isInRestrictMode(amm.address, blockNumber.sub(1))).eq(false);
    });

    // there are 3 types of actions, open, close and liquidate
    // So test cases will be combination of any two of them,
    // except close-close because it doesn't make sense.
    it("open then close", async () => {
      await expect(
        traderWallet1.multiActions(
          Action.OPEN,
          true,
          Action.CLOSE,
          amm.address,
          Side.BUY,
          toFullDigitBN(60),
          toFullDigitBN(10),
          toFullDigitBN(0),
          alice.address
        )
      ).to.be.revertedWith("CH_RM");
    });

    it("open then open", async () => {
      await expect(
        traderWallet1.multiActions(
          Action.OPEN,
          true,
          Action.OPEN,
          amm.address,
          Side.BUY,
          toFullDigitBN(60),
          toFullDigitBN(10),
          toFullDigitBN(0),
          alice.address
        )
      ).to.be.revertedWith("CH_RM");
    });

    it("open then liquidate", async () => {
      await makeLiquidatableByShort(alice);
      await syncAmmPriceToOracle();
      await clearingHouse.liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0));
    });

    it("liquidate then open", async () => {
      await makeLiquidatableByShort(alice);
      await forwardBlockTimestamp(15);
      await syncAmmPriceToOracle();
      await traderWallet1.multiActions(
        Action.LIQUIDATE,
        true,
        Action.OPEN,
        amm.address,
        Side.BUY,
        toFullDigitBN(60),
        toFullDigitBN(10),
        toFullDigitBN(0),
        alice.address
      );
    });

    it("failed if open, liquidate then close", async () => {
      await clearingHouse.setBackstopLiquidityProvider(traderWallet1.address, true);
      await makeLiquidatableByShort(alice);
      await forwardBlockTimestamp(15);
      await traderWallet1.openPosition(amm.address, Side.SELL, toFullDigitBN(10), toFullDigitBN(5), toFullDigitBN(0));
      await syncAmmPriceToOracle();
      await expect(
        traderWallet1.multiActions(
          Action.LIQUIDATE,
          true,
          Action.CLOSE,
          amm.address,
          Side.BUY,
          toFullDigitBN(60),
          toFullDigitBN(10),
          toFullDigitBN(0),
          alice.address
        )
      ).to.be.revertedWith("CH_RM");
    });

    it("liquidate then liquidate", async () => {
      await makeLiquidatableByShort(alice);
      await makeLiquidatableByShort(bob);
      await forwardBlockTimestamp(15);
      await syncAmmPriceToOracle();
      await expect(
        traderWallet1.multiActions(
          Action.LIQUIDATE,
          true,
          Action.LIQUIDATE,
          amm.address,
          Side.BUY,
          toFullDigitBN(60),
          toFullDigitBN(10),
          toFullDigitBN(0),
          alice.address
        )
      ).to.be.revertedWith("CH_ZP");
    });

    it("close then liquidate", async () => {
      await clearingHouse.connect(admin).setBackstopLiquidityProvider(admin.address, true);
      // avoid two actions from exceeding the fluctuation limit
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.5));

      await makeLiquidatableByShort(alice);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(10), toFullDigitBN(1), toFullDigitBN(0), true);
      await forwardBlockTimestamp(15);
      await clearingHouse.closePosition(amm.address, toFullDigitBN(0));
      await syncAmmPriceToOracle();
      await clearingHouse.liquidateWithSlippage(amm.address, alice.address, toFullDigitBN(0));
    });

    it("force error, close then liquidate then open", async () => {
      // avoid actions from exceeding the fluctuation limit
      await amm.setFluctuationLimitRatio(toFullDigitBN(1));

      await makeLiquidatableByShort(alice);
      await traderWallet1.openPosition(amm.address, Side.SELL, toFullDigitBN(5), toFullDigitBN(1), toFullDigitBN(0));
      await forwardBlockTimestamp(15);

      await traderWallet1.closePosition(amm.address);
      await syncAmmPriceToOracle();
      await expect(
        traderWallet1.multiActions(
          Action.LIQUIDATE,
          true,
          Action.OPEN,
          amm.address,
          Side.BUY,
          toFullDigitBN(60),
          toFullDigitBN(10),
          toFullDigitBN(0),
          alice.address
        )
      ).to.be.revertedWith("CH_RM");
    });
  });

  describe("cascading liquidation", () => {
    beforeEach(async () => {
      await transfer(admin, carol.address, 1000);
      await approve(alice, clearingHouse.address, 1000);
      await approve(bob, clearingHouse.address, 1000);
      await approve(carol, clearingHouse.address, 1000);
      await clearingHouse.connect(admin).setMaintenanceMarginRatio(toFullDigitBN(0.1));
    });
    it("make alice liquidatable by another liquidation", async () => {
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(9.09), true);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.57), true);
      await clearingHouse.connect(carol).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(0), true);
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(7.58), true);
      // alice is not able to be liquidated after closing bob's position
      await expect(clearingHouse.liquidate(amm.address, alice.address)).revertedWith("CH_MRNC");
      // carol is able to be liquidated after closing bob's position
      await clearingHouse.liquidate(amm.address, carol.address);
      // alice is able to be liquidated after liquidating carol's position
      await clearingHouse.liquidate(amm.address, alice.address);
    });
  });

  describe("partial liquidation with bad debt", () => {
    beforeEach(async () => {
      await transfer(admin, carol.address, 1000);
      await approve(alice, clearingHouse.address, 1000);
      await approve(bob, clearingHouse.address, 1000);
      await approve(carol, clearingHouse.address, 1000);
      await clearingHouse.setMaintenanceMarginRatio(toFullDigitBN(0.1));
      await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(0.25));
      await clearingHouse.setLiquidationFeeRatio(toFullDigitBN(0.025));
      // B: 100, Q: 1000
    });
    it("make alice liquidatable by funding payment", async () => {
      // B: 80, Q: 1250, SpotPrice = 15.625
      // Alice - OpenNotional: 250, PositionSize: 20, Margin: 25
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);
      // B: 76.923, Q: 1300, SpotPrice = 16.9
      // Bob - OpenNotional: 50, PositionSize: 3.076, Margin: 5
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(50), toFullDigitBN(10), toFullDigitBN(0), true);
      // Alice - PositionNotional: 268.2539, UnrealizedPnl: 18.2539, Margin: 25
      const { positionNotional, unrealizedPnl } = await clearingHouse.getPositionNotionalAndUnrealizedPnl(
        amm.address,
        alice.address,
        PnlCalcOption.SPOT_PRICE
      );
      expect(positionNotional).equal(BigNumber.from("268253968253968253968"));
      expect(unrealizedPnl).equal(BigNumber.from("18253968253968253968"));

      await mockPriceFeed.setTwapPrice(toFullDigitBN(15.2));

      // funding payment
      await gotoNextFundingTime();

      await clearingHouse.payFunding(amm.address);

      expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).equal(BigNumber.from("1699999999999999999")); //1.699999999999999999

      // Alice - marginRatio = (25 + 18.2539 - 1.699999999999999999 * 20)/268.2539 = 9.2539 / 268.2539 = 0.03449
      expect(await clearingHouse.getMarginRatio(amm.address, alice.address)).equal(BigNumber.from("34497041420118343"));

      // // hence partial liquidate Alice, but failed because of bad debt
      // await expect(clearingHouse.liquidate(amm.address, alice.address)).revertedWith(
      //   "Arithmetic operation underflowed or overflowed outside of an unchecked block"
      // );
      await clearingHouse.liquidate(amm.address, alice.address);
      expect((await clearingHouse.getPosition(amm.address, alice.address)).margin).equal("-6420076011625307380");
    });
  });
});
