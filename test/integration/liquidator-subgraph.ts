import { expect, use } from "chai";
import { Signer, BigNumber } from "ethers";
import { ethers, run } from "hardhat";
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
import { queryTraders } from "../../utils/graphql";

describe("Liquidator Test with Subgraph", () => {
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
    await mockPriceFeed.setPrice(marketPrice);
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

    await run("graph", { contractName: "ClearingHouse", address: clearingHouse.address });
    await run("graph", { contractName: "Amm", address: amm.address });

    // Each of Alice & Bob have 5000 DAI
    for (let i = 1; i < 6; i++) {
      await quoteToken.transfer(accounts[i].address, toFullDigitBN(15, +(await quoteToken.decimals())));
      await approve(accounts[i], clearingHouse.address, 15);
    }
    await quoteToken.transfer(insuranceFund.address, toFullDigitBN(5000, +(await quoteToken.decimals())));

    await syncAmmPriceToOracle();

    for (let i = 1; i < 6; i++) {
      await clearingHouse.connect(accounts[i]).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0));
      await forwardBlockTimestamp(1);
    }
  }

  before(async () => {
    await loadFixture(deployEnvFixture);
  });

  describe("Liquidation", () => {
    before(async () => {
      await clearingHouse.connect(accounts[1]).closePosition(amm.address, toFullDigitBN(0));
      //margin ratio of account 2: 0.249999999999999999
      //margin ratio of account 3: 0.126033057851239669
      //margin ratio of account 4: -0.008264462809917355
      //margin ratio of account 5: -0.152892561983471074
    });
    it("single liquidation of underwater position", async () => {
      console.log(await queryTraders(amm.address));
    });
  });
});
