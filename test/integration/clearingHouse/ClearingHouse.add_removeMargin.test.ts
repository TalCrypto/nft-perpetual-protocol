import { expect, use } from "chai";
import { Signer, BigNumber, ContractTransaction, BigNumberish } from "ethers";
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

use(solidity);

type MarginChangedStruct = {
  sender?: string;
  amm?: string;
  amount?: BigNumberish;
  fundingPayment?: BigNumberish;
};

describe("ClearingHouse add/remove margin Test", () => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let mockPriceFeed!: L2PriceFeedMock;
  let clearingHouse: ClearingHouseFake;
  let clearingHouseViewer: ClearingHouseViewer;

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

  async function approve(account: SignerWithAddress, spender: string, amount: number): Promise<void> {
    await quoteToken.connect(account).approve(spender, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function transfer(from: SignerWithAddress, to: string, amount: number): Promise<void> {
    await quoteToken.connect(from).transfer(to, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function syncAmmPriceToOracle() {
    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setPrice(marketPrice);
  }

  async function expectMarginChanged(tx: ContractTransaction, val: MarginChangedStruct) {
    const receipt = await tx.wait();
    const event = receipt.events?.find((x) => {
      return x.event == "MarginChanged";
    });
    expect(event?.args).to.not.be.null;
    if (val.sender != null) {
      expect(event?.args?.[0]).to.eq(val.sender);
    }
    if (val.amm != null) {
      expect(event?.args?.[1]).to.eq(val.amm);
    }
    if (val.amount != null) {
      expect(event?.args?.[2]).to.eq(val.amount);
    }
    if (val.fundingPayment != null) {
      expect(event?.args?.[3]).to.eq(val.fundingPayment);
    }
  }

  beforeEach(async () => {
    const account = await ethers.getSigners();
    admin = account[0];
    alice = account[1];
    bob = account[2];

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

    await syncAmmPriceToOracle();
  });

  describe("add/remove margin", () => {
    beforeEach(async () => {
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(10), toFullDigitBN(37.5));
    });

    it("add margin", async () => {
      const receipt = await clearingHouse.connect(alice).addMargin(amm.address, toFullDigitBN(80));

      await expectMarginChanged(receipt, {
        sender: alice.address,
        amm: amm.address,
        amount: toFullDigitBN(80),
        fundingPayment: "0",
      });

      await expect(receipt)
        .to.emit(quoteToken, "Transfer")
        .withArgs(alice.address, clearingHouse.address, toFullDigitBN(80, +(await quoteToken.decimals())));

      expect((await clearingHouse.getPosition(amm.address, alice.address)).margin).to.eq(toFullDigitBN(140));
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(140));
    });

    it("add margin even if there is no position opened yet", async () => {
      await expect(clearingHouse.connect(bob).addMargin(amm.address, toFullDigitBN(1))).to.emit(clearingHouse, "MarginChanged");
    });

    it("remove margin", async () => {
      // remove margin 20
      const receipt = await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(20));
      await expectMarginChanged(receipt, {
        sender: alice.address,
        amm: amm.address,
        amount: toFullDigitBN(-20),
        fundingPayment: "0",
      });

      await expect(receipt)
        .to.emit(quoteToken, "Transfer")
        .withArgs(clearingHouse.address, alice.address, toFullDigitBN(20, +(await quoteToken.decimals())));

      // 60 - 20
      expect((await clearingHouse.getPosition(amm.address, alice.address)).margin).to.eq(toFullDigitBN(40));
      // 60 - 20
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(40));
    });

    it("remove margin after pay funding", async () => {
      // given the underlying twap price is 25.5, and current snapShot price is 1600 / 62.5 = 25.6
      await mockPriceFeed.setTwapPrice(toFullDigitBN(25.5));

      // when the new fundingRate is 10% which means underlyingPrice < snapshotPrice
      await gotoNextFundingTime();
      await clearingHouse.payFunding(amm.address);
      expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(0.1));

      // remove margin 20
      const receipt = await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(20));

      await expectMarginChanged(receipt, {
        sender: alice.address,
        amm: amm.address,
        amount: toFullDigitBN(-20),
        fundingPayment: toFullDigitBN(3.75),
      });
    });

    it("remove margin - no position opened yet but there is margin (edge case)", async () => {
      await clearingHouse.connect(bob).addMargin(amm.address, toFullDigitBN(1));

      const receipt = await clearingHouse.connect(bob).removeMargin(amm.address, toFullDigitBN(1));

      await expectMarginChanged(receipt, {
        sender: bob.address,
        amm: amm.address,
        amount: toFullDigitBN(-1),
        fundingPayment: "0",
      });
    });

    it("force error, remove margin - no enough margin", async () => {
      // margin is 60, try to remove more than 60
      const removedMargin = 61;
      await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(removedMargin))).to.be.revertedWith(
        "margin is not enough"
      );
    });

    it("force error, remove margin - no enough margin ratio (4%)", async () => {
      const removedMargin = 36;

      // min(margin + funding, margin + funding + unrealized PnL) - position value * 10%
      // min(60 - 36, 60 - 36) - 600 * 0.1 = -24
      // remove margin 36
      // remain margin -> 60 - 36 = 24
      // margin ratio -> 24 / 600 = 4%
      await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(removedMargin))).to.be.revertedWith(
        "free collateral is not enough"
      );
    });

    it("force error, remove margin - no position opened yet and neither is there any margin", async () => {
      await expect(clearingHouse.connect(bob).removeMargin(amm.address, toFullDigitBN(1))).to.be.revertedWith("margin is not enough");
    });
  });

  describe("remove margin with unrealized PnL", () => {
    beforeEach(async () => {
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);
    });

    describe("using spot price", () => {
      it("remove margin when a long position with profit", async () => {
        // reserve 1000 : 100
        await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(5), toFullDigitBN(0));
        // reserve 1300 : 76.92, price = 16.9

        await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(5), toFullDigitBN(0));
        // reserve 1600 : 62.5, price = 25.6

        // margin: 60
        // positionSize: 23.08
        // positionNotional: 431.5026875438
        // unrealizedPnl: 431.5026875438 - 300 = 131.5026875438
        // min(margin + funding, margin + funding + unrealized PnL) - position value * 5%
        // min(60, 60 + 131.5026875438) - 300 * 0.05 = 42
        // can not remove margin > 45
        await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(45.01))).to.be.revertedWith(
          "free collateral is not enough"
        );
        const freeCollateral = await clearingHouseViewer.getFreeCollateral(amm.address, alice.address);
        expect(freeCollateral).to.eq(toFullDigitBN(45));
        await clearingHouse.connect(alice).removeMargin(amm.address, freeCollateral);
      });

      it("remove margin when a long position with loss", async () => {
        await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(5), toFullDigitBN(0));
        // reserve 1300 : 76.92, price = 16.9

        await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(10), toFullDigitBN(5), toFullDigitBN(0));
        // reserve 1250 : 80 price = 15.625

        // margin: 60
        // positionSize: 23.08
        // positionNotional: 279.88
        // unrealizedPnl: 279.88 - 300 =  -20.12
        // min(margin + funding, margin + funding + unrealized PnL) - position value * 5%
        // min(60, 60 + (-20.12)) - 300 * 0.05 = 24.88
        // can not remove margin > 24.88
        await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(24.9))).to.be.revertedWith(
          "free collateral is not enough"
        );
        const freeCollateral = await clearingHouseViewer.getFreeCollateral(amm.address, alice.address);
        expect(freeCollateral).to.eq("24850746268656716414");
        await clearingHouse.connect(alice).removeMargin(amm.address, freeCollateral);
      });

      it("remove margin when a short position with profit", async () => {
        await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(5), toFullDigitBN(0));
        // reserve 900 : 111.11, price = 8.1
        await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(5), toFullDigitBN(0));
        // reserve 800 : 125, price = 6.4

        // margin: 20
        // positionSize: -11.11
        // positionNotional: 78.04
        // unrealizedPnl: 100 - 78.04 = 21.96
        // min(margin + funding, margin + funding + unrealized PnL) - position value * 5%
        // min(20, 20 + 21.96) - 78.04 * 0.05 = 16.098
        // can not remove margin > 16.098
        await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(16.5))).to.be.revertedWith(
          "free collateral is not enough"
        );
        const freeCollateral = await clearingHouseViewer.getFreeCollateral(amm.address, alice.address);
        expect(freeCollateral).to.eq("16097560975609756098");
        await clearingHouse.connect(alice).removeMargin(amm.address, freeCollateral);
      });

      it("remove margin when a short position with loss", async () => {
        await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(5), toFullDigitBN(0));
        await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(5), toFullDigitBN(0));
        // reserve 800 : 125, price = 6.4

        // margin: 20
        // positionSize: -11.11
        // positionNotional: 112.1
        // unrealizedPnl: 100 - 112.1 = -12.1
        // min(margin + funding, margin + funding + unrealized PnL) - position value * 5%
        // min(20, 20 + (-12.1)) - 112.1 * 0.05 = 2.295
        // can not remove margin > 2.295
        await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(2.5))).to.be.revertedWith(
          "free collateral is not enough"
        );
        const freeCollateral = await clearingHouseViewer.getFreeCollateral(amm.address, alice.address);
        expect(freeCollateral).to.eq("2282608695652173905");
        await clearingHouse.connect(alice).removeMargin(amm.address, freeCollateral);
      });
    });

    describe("using twap", () => {
      it("remove margin when a long position with profit", async () => {
        // reserve 1000 : 100
        await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(5), toFullDigitBN(0));
        await forwardBlockTimestamp(450);
        // reserve 1300 : 76.92, price = 16.9

        await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(5), toFullDigitBN(0));
        await forwardBlockTimestamp(450);
        // reserve 1600 : 62.5, price = 25.6

        // margin: 60
        // positionSize: 23.08
        // positionNotional: (300 + 431.5) / 2 = 365.75
        // unrealizedPnl: 365.75 - 300 = 65.75
        // min(margin + funding, margin + funding + unrealized PnL) - position value * 5%
        // min(60, 60 + 65.75) - 300 * 0.05 = 45
        // can not remove margin > 45
        await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(45.01))).to.be.revertedWith(
          "free collateral is not enough"
        );
        await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(45));
      });

      it("remove margin when a long position with loss", async () => {
        await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(5), toFullDigitBN(0));
        await forwardBlockTimestamp(450);
        // reserve 1300 : 76.92, price = 16.9

        await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(10), toFullDigitBN(5), toFullDigitBN(0));
        await forwardBlockTimestamp(450);
        // reserve 1250 : 80 price = 15.625
        // push the price up, so that CH uses twap to calculate the loss
        await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(0));

        // margin: 60
        // positionSize: 23.08
        // positionNotional: (300 + 279.85) / 2 = 289.925
        // unrealizedPnl: 289.925 - 300 =  -10.075
        // min(margin + funding, margin + funding + unrealized PnL) - position value * 5%
        // min(60, 60 + (-10.075)) - 300 * 0.05 = 34.925
        // can not remove margin > 34.925
        await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(34.93))).to.be.revertedWith(
          "free collateral is not enough"
        );
        const freeCollateral = await clearingHouseViewer.getFreeCollateral(amm.address, alice.address);
        await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(34.92));
      });

      it("remove margin when a short position with profit", async () => {
        await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(5), toFullDigitBN(0));
        await forwardBlockTimestamp(450);
        // reserve 900 : 111.11, price = 8.1
        await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(5), toFullDigitBN(0));
        await forwardBlockTimestamp(450);
        // reserve 800 : 125, price = 6.4

        // margin: 20
        // positionSize: -11.11
        // positionNotional: (78.04 + 100) / 2 = 89.02
        // unrealizedPnl: 100 - 89.02 = 10.98
        // min(margin + funding, margin + funding + unrealized PnL) - position value * 5%
        // min(20, 20 + 10.98) - 89.02 * 0.05 = 15.549
        // can not remove margin > 15.549
        await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(15.6))).to.be.revertedWith(
          "free collateral is not enough"
        );
        await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(15.5));
      });

      it("remove margin when a short position with loss", async () => {
        await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(5), toFullDigitBN(0));
        await forwardBlockTimestamp(450);
        await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(5), toFullDigitBN(0));
        await forwardBlockTimestamp(450);
        // reserve 800 : 125, price = 6.4

        // pull the price down, so that CH uses twap to calculate the loss
        await clearingHouse.connect(bob).closePosition(amm.address, toFullDigitBN(0));

        // margin: 20
        // positionSize: -11.11
        // positionNotional: (112.1 + 100) / 2 = 106.05
        // unrealizedPnl: 100 - 106.05 = -6.05
        // min(margin + funding, margin + funding + unrealized PnL) - position value * 5%
        // min(20, 20 + (-6.05)) - 106.05 * 0.05 = 8.6475
        // can not remove margin > 8.6475
        await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(8.7))).to.be.revertedWith(
          "free collateral is not enough"
        );
        await clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(8.6));
      });
    });
  });
});
