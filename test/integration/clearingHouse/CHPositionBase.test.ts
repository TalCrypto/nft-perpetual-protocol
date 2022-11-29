import { expect, use } from "chai";
import { Signer, BigNumber, ContractTransaction, BigNumberish } from "ethers";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";

import {
  ClearingHouse,
  AmmFake,
  ClearingHouseFake,
  ClearingHouseViewer,
  ERC20Fake,
  InsuranceFundFake,
  TraderWallet__factory,
  TraderWallet,
  L2PriceFeedMock,
  TollPool,
} from "../../../typechain-types";

import { PnlCalcOption, Side } from "../../../utils/contract";
import { fullDeploy } from "../../../utils/deploy";
import { toFullDigitBN } from "../../../utils/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

use(solidity);

type PositionChangedStruct = {
  trader?: string;
  amm?: string;
  margin?: BigNumberish;
  positionNotional?: BigNumberish;
  exchangedPositionSize?: BigNumberish;
  fee?: BigNumberish;
  positionSizeAfter?: BigNumberish;
  realizedPnl?: BigNumberish;
  unrealizedPnlAfter?: BigNumberish;
  badDebt?: BigNumberish;
  liquidationPenalty?: BigNumberish;
  spotPrice?: BigNumberish;
  fundingPayment?: BigNumberish;
};

describe("ClearingHouse - open/close position Test", () => {
  const MAX_INT = BigNumber.from(2).pow(BigNumber.from(255)).sub(BigNumber.from(1));
  let addresses: string[];
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let relayer: SignerWithAddress;

  let clearingHouse: ClearingHouseFake;
  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let clearingHouseViewer: ClearingHouseViewer;
  let tollPool: TollPool;
  let mockPriceFeed: L2PriceFeedMock;

  async function approve(account: SignerWithAddress, spender: string, amount: number | string): Promise<void> {
    await quoteToken.connect(account).approve(spender, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function transfer(from: SignerWithAddress, to: string, amount: number | string): Promise<void> {
    await quoteToken.connect(from).transfer(to, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function syncAmmPriceToOracle() {
    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setTwapPrice(marketPrice);
  }

  async function expectPositionChanged(tx: ContractTransaction, val: PositionChangedStruct) {
    const receipt = await tx.wait();
    const event = receipt.events?.find((x) => {
      return x.event == "PositionChanged";
    });
    expect(event?.args).to.not.be.null;
    if (val.trader != null) {
      expect(event?.args?.[0]).to.eq(val.trader);
    }
    if (val.amm != null) {
      expect(event?.args?.[1]).to.eq(val.amm);
    }
    if (val.margin != null) {
      expect(event?.args?.[2]).to.eq(val.margin);
    }
    if (val.positionNotional != null) {
      expect(event?.args?.[3]).to.eq(val.positionNotional);
    }
    if (val.exchangedPositionSize != null) {
      expect(event?.args?.[4]).to.eq(val.exchangedPositionSize);
    }
    if (val.fee != null) {
      expect(event?.args?.[5]).to.eq(val.fee);
    }
    if (val.positionSizeAfter != null) {
      expect(event?.args?.[6]).to.eq(val.positionSizeAfter);
    }
    if (val.realizedPnl != null) {
      expect(event?.args?.[7]).to.eq(val.realizedPnl);
    }
    if (val.unrealizedPnlAfter != null) {
      expect(event?.args?.[8]).to.eq(val.unrealizedPnlAfter);
    }
    if (val.badDebt != null) {
      expect(event?.args?.[9]).to.eq(val.badDebt);
    }
    if (val.liquidationPenalty != null) {
      expect(event?.args?.[10]).to.eq(val.liquidationPenalty);
    }
    if (val.spotPrice != null) {
      expect(event?.args?.[11]).to.eq(val.spotPrice);
    }
    if (val.fundingPayment != null) {
      expect(event?.args?.[12]).to.eq(val.fundingPayment);
    }
  }

  async function deployEnvFixture() {
    return fullDeploy({ sender: admin });
  }

  beforeEach(async () => {
    [admin, alice, bob, carol, relayer] = await ethers.getSigners();
    const contracts = await loadFixture(deployEnvFixture);
    amm = contracts.amm;
    insuranceFund = contracts.insuranceFund;
    quoteToken = contracts.quoteToken;
    clearingHouse = contracts.clearingHouse;
    clearingHouseViewer = contracts.clearingHouseViewer;
    clearingHouse = contracts.clearingHouse;
    tollPool = contracts.tollPool;
    mockPriceFeed = contracts.priceFeed;

    // Each of Alice & Bob have 5000 USDC
    await transfer(admin, alice.address, 5000);
    await transfer(admin, bob.address, 5000);
    await transfer(admin, insuranceFund.address, 5000);

    await syncAmmPriceToOracle();
  });

  describe("position", () => {
    beforeEach(async () => {
      await approve(alice, clearingHouse.address, 200);
      const clearingHouseBaseTokenBalance = await quoteToken.allowance(alice.address, clearingHouse.address);
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(200, +(await quoteToken.decimals())));
    });

    it("open position - increase with long", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(37.5), toFullDigitBN(10), toFullDigitBN(600), false);

      // expect to equal 60
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(60));
      // personal position should be 37.5
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(toFullDigitBN(37.5), "position not matched");
    });

    it("open position - increase position with two longs", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);
      // position 1
      // AMM after: 1600:62.5
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(37.5), toFullDigitBN(10), toFullDigitBN(600), false);

      // position 2
      // AMM after: 2000:50
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(12.5), toFullDigitBN(10), toFullDigitBN(400), false);

      // total size = 37.5 + 12.5 = 50
      const pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(toFullDigitBN(50));
      expect(pos.margin).to.eq(toFullDigitBN(100));

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(toFullDigitBN(100));
    });

    it("open position - increase position with two shorts", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(25), toFullDigitBN(5), toFullDigitBN(200), false);

      // create position 2
      // AMM after: 625 : 160
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(35), toFullDigitBN(5), toFullDigitBN(174), false);

      // total size = 25 + 35 and the size of short position is negative
      const pos2 = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos2.size).to.eq(toFullDigitBN(-60));
      expect(pos2.margin).to.eq(toFullDigitBN(75));

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(toFullDigitBN(75));
    });

    it("open position - reduce position with long, short", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1
      // AMM after: 1600 : 62.5
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(37.5), toFullDigitBN(10), toFullDigitBN(600), false);
      // alice has 5000 - 60 = 4940
      expect(await quoteToken.balanceOf(alice.address)).to.eq(toFullDigitBN(4940, +(await quoteToken.decimals())));

      // create position 2
      // AMM after: 1000 : 100
      const ret = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(37.5), toFullDigitBN(2), toFullDigitBN(600), false);

      const pos = await clearingHouse.connect(alice).getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(toFullDigitBN(0));

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(toFullDigitBN(0));
    });

    it("open position - reduce with one long and two shorts", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1 - long 60 * 10
      // AMM after: 1600 : 62.5
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(37.5), toFullDigitBN(10), toFullDigitBN(600), false);

      // create position 2 - short 20 * 5 (reduce position 100)
      // AMM after: 1250 : 80
      const tx = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(17.5), toFullDigitBN(5), toFullDigitBN(349), false);

      let pos = await clearingHouse.connect(alice).getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(toFullDigitBN(20));
      expect(pos.margin).to.eq(toFullDigitBN(60));

      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(60));

      // create position 3 - short
      // AMM after: 1000 : 100
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(10), toFullDigitBN(249), false);
      pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(0);
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(0);
    });

    it("open position - reduce with short and two longs", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // ## Current Amm Reserves:
      // BaseAsset=1000
      // QuoteAsset=100

      // create position 1 - short 40 * 5
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(25), toFullDigitBN(5), toFullDigitBN(200), false);

      // ## POSITION
      // size=-25
      // margin=40
      // openNotional=200
      // #### COSTS
      // - side=1
      // - size=25
      // - quoteAssetReserve=800
      // - baseAssetReserve=125

      //  ## Current Amm Reserves:
      //  BaseAsset=800
      //  QuoteAsset=125

      // create position 2 - long 20 * 5 (reduce position 100)
      // AMM after: 909.0909090909091 : 110
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(15), toFullDigitBN(5), toFullDigitBN(110), false);

      // ## POSITION
      // size=-10
      // margin=20.000000000000000001
      // openNotional=100
      // #### COSTS
      // - side=1
      // - size=10
      let pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(toFullDigitBN(-10));
      expect(pos.margin).to.eq(toFullDigitBN(40));
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(40));

      // ## Current Amm Reserves:
      // BaseAsset=909.0909090909091
      // QuoteAsset=110

      // create position 3 - long
      // AMM after: 1000 : 100
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0), false);

      pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(0);
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(0);
    });

    it("open position - reduce with short, long and short", async () => {
      // avoid actions from exceeding the fluctuation limit
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.8));

      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1 - short
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(25), toFullDigitBN(10), toFullDigitBN(200), false);

      // create position 2 - long
      // AMM after: 1250: 80
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(45), toFullDigitBN(3), toFullDigitBN(450), false);
      let pos = await clearingHouse.getPosition(amm.address, alice.address);

      // sumSize = -25 + 45 = 20
      // expect(pos.size).to.eq(toFullDigitBN(20))

      // sumMargin = sumNotionalSize((20 * 10) - 150 * 3) / leverage(3) = 83.33
      expect(pos.margin).to.eq("83333333333333333333");
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(
        "83333333333333333333"
      );

      // create position 3 - short
      // AMM after: 1000 : 100
      // return size might loss 1 wei
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(10), toFullDigitBN(250), false);
      pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(0);

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(0);

      // 1916.666...7 = 2000 - 83.3333...
      expect(await quoteToken.allowance(alice.address, clearingHouse.address)).to.eq("1916666666666666666667");
      expect(await quoteToken.balanceOf(alice.address)).to.eq(toFullDigitBN(5000, +(await quoteToken.decimals())));
    });

    it("open position - reduce with long, short and long", async () => {
      // avoid actions from exceeding the fluctuation limit
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.8));

      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1 - long
      // AMM after: 1250 : 80
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(20), toFullDigitBN(10), toFullDigitBN(250), false);

      // create position 2 - short
      // AMM after: 800 : 125
      await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(45), toFullDigitBN(3), toFullDigitBN(0), false);

      // sumSize = 20 - 45 = -25
      let pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(toFullDigitBN(-25));

      // sumMargin = sumNotionalSize(250 - 450) / leverage(3) = 66.66
      expect(pos.margin).to.eq("66666666666666666666");
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(
        "66666666666666666666"
      );

      // create position 3 - long
      // AMM after: 1000 : 100
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(25), toFullDigitBN(10), toFullDigitBN(0), false);

      pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(0);
      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(0);
    });

    it("open position - reduce when there is unrealized pnl", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);

      // create position 1
      // AMM after: 1250 : 80
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(20), toFullDigitBN(10), toFullDigitBN(250), false);
      // alice has 5000 - 25 = 4975
      expect(await quoteToken.balanceOf(alice.address)).to.eq(toFullDigitBN(4975, +(await quoteToken.decimals())));

      // create position 2
      // AMM after: 1600 : 62.5
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(17.5), toFullDigitBN(10), toFullDigitBN(350), false);
      // bob has 5000 - 30 = 4965
      expect(await quoteToken.balanceOf(bob.address)).to.eq(toFullDigitBN(4965, +(await quoteToken.decimals())));

      const res = await clearingHouse.getPositionNotionalAndUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE);

      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0), false);
      const res1 = await clearingHouse.getPositionNotionalAndUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE);

      const pos = await clearingHouse.connect(alice).getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(toFullDigitBN(10));
      expect(pos.margin).to.eq(toFullDigitBN(25).add(res[1].sub(res1[1])));

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(toFullDigitBN(25).add(res[1].sub(res1[1])));

      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0), false);

      const pos1 = await clearingHouse.connect(alice).getPosition(amm.address, alice.address);
      expect(pos1.size).to.eq(toFullDigitBN(0));
      expect(pos1.margin).to.eq(toFullDigitBN(0));
      expect(await quoteToken.balanceOf(alice.address)).to.eq(toFullDigitBN(5000).add(res[1]));
    });

    it("open position - reverse when there is unrealized pnl", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);

      // create position 1
      // AMM after: 1250 : 80
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(20), toFullDigitBN(10), toFullDigitBN(250), false);
      // alice has 5000 - 25 = 4975
      expect(await quoteToken.balanceOf(alice.address)).to.eq(toFullDigitBN(4975, +(await quoteToken.decimals())));

      // create position 2
      // AMM after: 1600 : 62.5
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(17.5), toFullDigitBN(10), toFullDigitBN(350), false);
      // bob has 5000 - 30 = 4965
      expect(await quoteToken.balanceOf(bob.address)).to.eq(toFullDigitBN(4965, +(await quoteToken.decimals())));

      const res = await clearingHouse.getPositionNotionalAndUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE);

      // after close: 1212.121212121212 : 82.5
      // after open:  1000 : 100
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(37.5), toFullDigitBN(10), toFullDigitBN(599), false);

      const pos = await clearingHouse.connect(alice).getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(toFullDigitBN(-17.5));
      expect(pos.margin).to.eq("21212121212121212121");
      expect(await quoteToken.balanceOf(alice.address)).to.eq(toFullDigitBN(5000).add(res[1]).sub("21212121212121212121"));
    });
  });
});
