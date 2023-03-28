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

use(solidity);

describe("ClearingHouse Fee Pool Test", () => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let mockPriceFeed!: L2PriceFeedMock;
  let clearingHouse: ClearingHouseFake;
  let clearingHouseViewer: ClearingHouseViewer;

  async function approve(account: Signer, spender: string, amount: number): Promise<void> {
    await quoteToken.connect(account).approve(spender, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function transfer(from: Signer, to: string, amount: number): Promise<void> {
    await quoteToken.connect(from).transfer(to, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function deployEnvFixture() {
    const contracts = await fullDeploy({ sender: admin });
    const amm = contracts.amm;
    const insuranceFund = contracts.insuranceFund;
    const quoteToken = contracts.quoteToken;
    const mockPriceFeed = contracts.priceFeed;
    const clearingHouse = contracts.clearingHouse;
    const clearingHouseViewer = contracts.clearingHouseViewer;

    await quoteToken.transfer(alice.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(bob.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(insuranceFund.address, toFullDigitBN(5000, +(await quoteToken.decimals())));

    // await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));

    return { clearingHouse, amm, insuranceFund, quoteToken, mockPriceFeed };
  }

  beforeEach(async () => {
    [admin, alice, bob] = await ethers.getSigners();
    const fixture = await loadFixture(deployEnvFixture);
    clearingHouse = fixture.clearingHouse;
    quoteToken = fixture.quoteToken;
    amm = fixture.amm;
    insuranceFund = fixture.insuranceFund;
  });

  it("inject into fee pool", async () => {
    await approve(alice, clearingHouse.address, 100);
    expect(await insuranceFund.getBudgetAllocatedFor(amm.address)).eql(toFullDigitBN(0));
    await clearingHouse.connect(alice).inject2InsuranceFund(amm.address, toFullDigitBN(100));
    expect(await insuranceFund.getBudgetAllocatedFor(amm.address)).eql(toFullDigitBN(100));
  });

  // describe("withdraw from fee pool", () => {
  //   beforeEach(async () => {
  //     await approve(alice, clearingHouse.address, 100);
  //     await clearingHouse.connect(alice).deposit2FeePool(amm.address, toFullDigitBN(100));
  //   });
  //   it("should be failed of withdrawal from not owner", async () => {
  //     await expect(clearingHouse.connect(alice).withdrawFromFeePool(amm.address, toFullDigitBN(10))).revertedWith(
  //       "Ownable: caller is not the owner"
  //     );
  //   });
  //   it("should be success of withdrawal from owner", async () => {
  //     await clearingHouse.withdrawFromFeePool(amm.address, toFullDigitBN(10));
  //     expect(await clearingHouse.totalFees(amm.address)).eql(toFullDigitBN(90));
  //     expect(await clearingHouse.totalMinusFees(amm.address)).eql(toFullDigitBN(90));
  //   });
  //   it("should be failed of withdrawal exceeding the balance of fee pool", async () => {
  //     await expect(clearingHouse.withdrawFromFeePool(amm.address, toFullDigitBN(101))).reverted;
  //   });
  // });
});
