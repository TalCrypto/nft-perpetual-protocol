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
  Liquidator,
} from "../../typechain-types";
import { PnlCalcOption, Side } from "../../utils/contract";
import { fullDeploy } from "../../utils/deploy";
import { toFullDigitBN } from "../../utils/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Liquidator Test", () => {
  let admin: SignerWithAddress;
  let accounts: SignerWithAddress[];

  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let mockPriceFeed!: L2PriceFeedMock;
  let clearingHouse: ClearingHouseFake;
  let liquidator: Liquidator;

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
    await mockPriceFeed.setTwapPrice(marketPrice);
  }

  async function deployEnvFixture() {
    accounts = await ethers.getSigners();
    admin = accounts[0];

    const contracts = await fullDeploy({ sender: admin });
    amm = contracts.amm;
    insuranceFund = contracts.insuranceFund;
    quoteToken = contracts.quoteToken;
    mockPriceFeed = contracts.priceFeed;
    clearingHouse = contracts.clearingHouse;
    liquidator = contracts.liquidator;
    const ethStakingPool = contracts.ethStakingPool;
    await ethStakingPool.setTribe3Treasury(admin.address);
    // Each of Alice & Bob have 5000 DAI
    for (let i = 1; i < 6; i++) {
      await quoteToken.transfer(accounts[i].address, toFullDigitBN(15, +(await quoteToken.decimals())));
      await approve(accounts[i], clearingHouse.address, 15);
    }
    await quoteToken.approve(ethStakingPool.address, toFullDigitBN(5000));
    await ethStakingPool.stake(toFullDigitBN(5000));

    await syncAmmPriceToOracle();

    for (let i = 1; i < 6; i++) {
      await clearingHouse
        .connect(accounts[i])
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);
      await forwardBlockTimestamp(1);
    }
  }

  beforeEach(async () => {
    await loadFixture(deployEnvFixture);
  });

  describe("Liquidation", () => {
    beforeEach(async () => {
      await clearingHouse.connect(accounts[1]).closePosition(amm.address, toFullDigitBN(0));
      //margin ratio of account 2: 0.249999999999999999
      //margin ratio of account 3: 0.126033057851239669
      //margin ratio of account 4: -0.008264462809917355
      //margin ratio of account 5: -0.152892561983471074
      const liquidatable = await liquidator.isLiquidatable(amm.address, [
        accounts[1].address,
        accounts[2].address,
        accounts[3].address,
        accounts[4].address,
        accounts[5].address,
        accounts[6].address,
        accounts[7].address,
      ]);
      expect(liquidatable[0]).eq(false);
      expect(liquidatable[1]).eq(false);
      expect(liquidatable[2]).eq(false);
      expect(liquidatable[3]).eq(true);
      expect(liquidatable[4]).eq(true);
      expect(liquidatable[5]).eq(false);
      expect(liquidatable[6]).eq(false);
    });
    it("single liquidation of underwater position", async () => {
      // expect(await liquidator.estimateGas.liquidate(amm.address, [accounts[4].address])).eq(ethers.BigNumber.from("303421"));
      await liquidator.singleLiquidate(amm.address, accounts[4].address);
      await expect(clearingHouse.getMarginRatio(amm.address, accounts[4].address)).revertedWith("CH_ZP");
      // await expect(tx).to.emit(liquidator, "PositionLiquidated").withArgs(amm.address, [accounts[4].address], [true], [""]);
    });
    it("multi liquidations of underwater positions", async () => {
      // expect(await liquidator.estimateGas.liquidate(amm.address, [accounts[4].address, accounts[5].address])).eq(
      //   ethers.BigNumber.from("438206")
      // );
      const tx = await liquidator.liquidate(amm.address, [accounts[4].address, accounts[5].address]);
      await expect(clearingHouse.getMarginRatio(amm.address, accounts[4].address)).revertedWith("CH_ZP");
      await expect(tx)
        .to.emit(liquidator, "PositionLiquidated")
        .withArgs(amm.address, [accounts[4].address, accounts[5].address], [true, true], ["", ""]);
    });
    it("single liquidation of position that is under maintenance margin ratio", async () => {
      // expect(await liquidator.estimateGas.liquidate(amm.address, [accounts[2].address])).eq(ethers.BigNumber.from("83665"));
      const tx = await liquidator.liquidate(amm.address, [accounts[2].address]);
      await expect(tx).to.emit(liquidator, "PositionLiquidated").withArgs(amm.address, [accounts[2].address], [false], ["CH_MRNC"]);
    });
    it("multi liquidations of underwater position and not", async () => {
      // expect(await liquidator.estimateGas.liquidate(amm.address, [accounts[2].address, accounts[5].address])).eq(
      //   ethers.BigNumber.from("355147")
      // );
      const tx = await liquidator.liquidate(amm.address, [accounts[2].address, accounts[5].address]);
      await expect(tx)
        .to.emit(liquidator, "PositionLiquidated")
        .withArgs(amm.address, [accounts[2].address, accounts[5].address], [false, true], ["CH_MRNC", ""]);
    });
    it("multi liquidations that are under maintenance margin ratio", async () => {
      // expect(await liquidator.estimateGas.liquidate(amm.address, [accounts[2].address, accounts[3].address])).eq(
      //   ethers.BigNumber.from("137016")
      // );
      const tx = await liquidator.liquidate(amm.address, [accounts[2].address, accounts[3].address]);
      await expect(tx)
        .to.emit(liquidator, "PositionLiquidated")
        .withArgs(amm.address, [accounts[2].address, accounts[3].address], [false, false], ["CH_MRNC", "CH_MRNC"]);
    });
  });
  describe("Withdrawal Test", () => {
    it("erc20 withdrawal", async () => {
      await quoteToken.transfer(liquidator.address, toFullDigitBN("100"));
      expect(await quoteToken.balanceOf(liquidator.address)).eql(toFullDigitBN(100));
      await liquidator.withdrawERC20(quoteToken.address);
      expect(await quoteToken.balanceOf(liquidator.address)).eql(toFullDigitBN(0));
    });
    it("eth withdrawal", async () => {
      await admin.sendTransaction({
        to: liquidator.address,
        value: toFullDigitBN("1.0"), // Sends exactly 1.0 ether
      });
      expect(await ethers.provider.getBalance(liquidator.address)).eql(toFullDigitBN(1));
      await liquidator.withdrawETH();
      expect(await ethers.provider.getBalance(liquidator.address)).eql(toFullDigitBN(0));
    });
  });
});
