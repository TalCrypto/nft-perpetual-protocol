import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { ethers } from "hardhat";
import { AmmFake, ClearingHouseFake, ERC20Fake, ETHStakingPool, InsuranceFundFake, L2PriceFeedMock } from "../../typechain-types";
import { forward } from "../../utils";
import { deployAmm, deployErc20Fake, deployETHStakingPool, deployInsuranceFund, deployL2MockPriceFeed, Side } from "../../utils/contract";
import { fullDeploy } from "../../utils/deploy";
import { toFullDigitBN } from "../../utils/number";

describe("EthStakingPool unit test", async () => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let insuranceFund: InsuranceFundFake;
  let ethStakingPool: ETHStakingPool;
  let quoteToken: ERC20Fake;
  let amm: AmmFake;

  async function deployEnvFixture() {
    const [admin, alice, bob] = await ethers.getSigners();
    const quoteToken = await deployErc20Fake(admin, toFullDigitBN(20000000), "TETH", "TETH", BigNumber.from(18));
    const insuranceFund = await deployInsuranceFund(admin, "", "");
    const priceFeed = await deployL2MockPriceFeed(admin, toFullDigitBN(10));
    const ethStakingPool = await deployETHStakingPool(admin, quoteToken.address, insuranceFund.address);
    const amm = await deployAmm({
      deployer: admin,
      quoteAssetTokenAddr: quoteToken.address,
      priceFeedAddr: priceFeed.address,
      fluctuation: toFullDigitBN(0),
      fundingPeriod: BigNumber.from(3600), // 1 hour
    });

    // Each of Alice & Bob have 5000 DAI
    await quoteToken.transfer(alice.address, toFullDigitBN(5000));
    await quoteToken.transfer(bob.address, toFullDigitBN(5000));

    await quoteToken.connect(admin).approve(ethStakingPool.address, ethers.constants.MaxUint256);

    return { admin, alice, bob, insuranceFund, quoteToken, ethStakingPool, amm };
  }

  beforeEach(async () => {
    const fixture = await loadFixture(deployEnvFixture);
    admin = fixture.admin;
    alice = fixture.alice;
    bob = fixture.bob;
    insuranceFund = fixture.insuranceFund;
    quoteToken = fixture.quoteToken;
    ethStakingPool = fixture.ethStakingPool;
    amm = fixture.amm;
  });
  it("only tribe3 treasury can stake", async () => {
    await expect(ethStakingPool.stake(toFullDigitBN(10))).revertedWith("ES_NTT");
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    expect(await ethStakingPool.totalSupply()).eq(toFullDigitBN(10));
    expect(await ethStakingPool.balanceOf(admin.address)).eq(toFullDigitBN(10));
  });
  it("others can't unstake", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await expect(ethStakingPool.connect(alice).unstake(toFullDigitBN(5))).revertedWith("ES_NTT");
  });
  it("tribe3 treasury can't unstake during the guarded period", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await expect(ethStakingPool.unstake(toFullDigitBN(5))).revertedWith("ES_GP");
  });
  it("only tribe3 treasury can unstake after the guarded period", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await forward(6 * 30 * 24 * 3600);
    await expect(ethStakingPool.connect(alice).unstake(toFullDigitBN(5))).revertedWith("ES_NTT");
    await ethStakingPool.unstake(toFullDigitBN(5));
    expect(await ethStakingPool.totalSupply()).eq(toFullDigitBN(5));
    expect(await ethStakingPool.balanceOf(admin.address)).eq(toFullDigitBN(5));
  });
  it("reward calculation", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await quoteToken.connect(alice).transfer(ethStakingPool.address, toFullDigitBN(5));
    expect(await ethStakingPool.calculateTotalReward()).eq(toFullDigitBN(5));
  });
  it("reward is not claimable before the period", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await quoteToken.connect(alice).transfer(ethStakingPool.address, toFullDigitBN(5));
    expect(await ethStakingPool.isClaimable()).false;
    await expect(ethStakingPool.claim()).revertedWith("ES_NAC");
  });
  it("reward is not restakable before the period", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await quoteToken.connect(alice).transfer(ethStakingPool.address, toFullDigitBN(5));
    expect(await ethStakingPool.isClaimable()).false;
    await expect(ethStakingPool.restakeReward(toFullDigitBN(1))).revertedWith("ES_NAC");
  });
  it("reward is claimable after the period by treasury", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await quoteToken.connect(alice).transfer(ethStakingPool.address, toFullDigitBN(5));
    await forward(30 * 24 * 3600);
    expect(await ethStakingPool.isClaimable()).true;
    await ethStakingPool.claim();
    expect(await ethStakingPool.calculateTotalReward()).eq(toFullDigitBN(0));
  });
  it("reward is not claimable after the period by others", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await quoteToken.connect(alice).transfer(ethStakingPool.address, toFullDigitBN(5));
    await forward(30 * 24 * 3600);
    expect(await ethStakingPool.isClaimable()).true;
    await expect(ethStakingPool.connect(alice).claim()).revertedWith("ES_NTT");
  });
  it("reward is restakable after the period by treasury", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await quoteToken.connect(alice).transfer(ethStakingPool.address, toFullDigitBN(5));
    await forward(30 * 24 * 3600);
    expect(await ethStakingPool.isClaimable()).true;
    await ethStakingPool.restakeReward(toFullDigitBN(2));
    expect(await ethStakingPool.calculateTotalReward()).eq(toFullDigitBN(3));
    expect(await ethStakingPool.totalSupply()).eq(toFullDigitBN(12));
    expect(await ethStakingPool.balanceOf(admin.address)).eq(toFullDigitBN(12));
  });
  it("reward is not restakable after the period by others", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await quoteToken.connect(alice).transfer(ethStakingPool.address, toFullDigitBN(5));
    await forward(30 * 24 * 3600);
    expect(await ethStakingPool.isClaimable()).true;
    await expect(ethStakingPool.connect(alice).restakeReward(toFullDigitBN(5))).revertedWith("ES_NTT");
  });
  it("reward is not claimable when it is below than 0 after the period by treasury", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await forward(30 * 24 * 3600);
    expect(await ethStakingPool.isClaimable()).true;
    await expect(ethStakingPool.claim()).revertedWith("ES_IR");
  });
  it("reward is not restakable when the amount is bigger than it after the period by treasury", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await quoteToken.connect(alice).transfer(ethStakingPool.address, toFullDigitBN(5));
    await forward(30 * 24 * 3600);
    expect(await ethStakingPool.isClaimable()).true;
    await expect(ethStakingPool.restakeReward(toFullDigitBN(12))).revertedWith("ES_IR");
  });
  it("only insurance fund can be succeeded in calling withdraw", async () => {
    await ethStakingPool.setTribe3Treasury(admin.address);
    await ethStakingPool.stake(toFullDigitBN(10));
    await insuranceFund.setBeneficiary(admin.address);
    await insuranceFund.addAmm(amm.address);
    await insuranceFund.activateETHStakingPool(ethStakingPool.address);
    const tx = await insuranceFund.withdraw(amm.address, toFullDigitBN(5));
    expect(tx).emit(ethStakingPool, "Withdrawn").withArgs(amm.address, toFullDigitBN(5));
    expect(await ethStakingPool.totalSupply()).eq(toFullDigitBN(10));
    expect(await ethStakingPool.balanceOf(admin.address)).eq(toFullDigitBN(10));
    expect(await ethStakingPool.calculateTotalReward()).eq(toFullDigitBN(-5));
    expect(await quoteToken.balanceOf(ethStakingPool.address)).eq(toFullDigitBN(5));
  });
});
