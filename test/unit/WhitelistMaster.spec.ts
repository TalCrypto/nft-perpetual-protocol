import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { ethers } from "hardhat";
import {
  AmmFake,
  ClearingHouseFake,
  ERC20Fake,
  ETHStakingPool,
  InsuranceFundFake,
  L2PriceFeedMock,
  WhitelistMaster,
} from "../../typechain-types";
import { forward } from "../../utils";
import {
  deployAmm,
  deployErc20Fake,
  deployETHStakingPool,
  deployInsuranceFund,
  deployL2MockPriceFeed,
  deployWhitelistMaster,
  Side,
} from "../../utils/contract";
import { fullDeploy } from "../../utils/deploy";
import { toFullDigitBN } from "../../utils/number";

describe("WhitelistMaster unit test", async () => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let whitelistMaster: WhitelistMaster;

  beforeEach(async () => {
    [admin, alice, bob, carol] = await ethers.getSigners();
    whitelistMaster = await deployWhitelistMaster(admin);
  });
  it("whitelist one address", async () => {
    expect(await whitelistMaster.isWhitelisted(alice.address)).false;
    await whitelistMaster.addToWhitelist([alice.address]);
    expect(await whitelistMaster.isWhitelisted(alice.address)).true;
  });
  it("whitelist several addresses", async () => {
    expect(await whitelistMaster.isWhitelisted(alice.address)).false;
    expect(await whitelistMaster.isWhitelisted(bob.address)).false;
    expect(await whitelistMaster.isWhitelisted(carol.address)).false;
    await whitelistMaster.addToWhitelist([alice.address, bob.address, carol.address]);
    expect(await whitelistMaster.isWhitelisted(alice.address)).true;
    expect(await whitelistMaster.isWhitelisted(bob.address)).true;
    expect(await whitelistMaster.isWhitelisted(carol.address)).true;
  });
  it("remove one address from whitelist", async () => {
    expect(await whitelistMaster.isWhitelisted(alice.address)).false;
    await whitelistMaster.addToWhitelist([alice.address]);
    expect(await whitelistMaster.isWhitelisted(alice.address)).true;
    await whitelistMaster.removeFromWhitelist([alice.address]);
    expect(await whitelistMaster.isWhitelisted(alice.address)).false;
  });
  it("remove several addresses from whitelist", async () => {
    expect(await whitelistMaster.isWhitelisted(alice.address)).false;
    expect(await whitelistMaster.isWhitelisted(bob.address)).false;
    expect(await whitelistMaster.isWhitelisted(carol.address)).false;
    await whitelistMaster.addToWhitelist([alice.address, bob.address, carol.address]);
    expect(await whitelistMaster.isWhitelisted(alice.address)).true;
    expect(await whitelistMaster.isWhitelisted(bob.address)).true;
    expect(await whitelistMaster.isWhitelisted(carol.address)).true;
    await whitelistMaster.removeFromWhitelist([alice.address, carol.address]);
    expect(await whitelistMaster.isWhitelisted(alice.address)).false;
    expect(await whitelistMaster.isWhitelisted(bob.address)).true;
    expect(await whitelistMaster.isWhitelisted(carol.address)).false;
  });
  it("only owner can call add function", async () => {
    await expect(whitelistMaster.connect(alice).addToWhitelist([alice.address])).revertedWith("Ownable: caller is not the owner");
  });
  it("only owner can call remove function", async () => {
    await expect(whitelistMaster.connect(alice).removeFromWhitelist([alice.address])).revertedWith("Ownable: caller is not the owner");
  });
});
