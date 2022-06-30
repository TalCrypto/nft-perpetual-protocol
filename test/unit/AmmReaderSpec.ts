import { expect, use } from "chai";
import { BigNumber } from "ethers";
import { ethers } from "hardhat";
import { AmmFake, ERC20Fake, L2PriceFeedMock, AmmReader } from "../../typechain-types";
import { solidity } from "ethereum-waffle";
import { deployAmm, deployAmmReader, deployErc20Fake, deployL2MockPriceFeed } from "../helper/contract";
import { toFullDigitBN } from "../helper/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

use(solidity);

describe("AmmReader Unit Test", () => {
  const ETH_PRICE = 100;
  const ETH_BYTES32 = "0x4554480000000000000000000000000000000000000000000000000000000000";

  let amm: AmmFake;
  let ammReader: AmmReader;
  let l2PriceFeed: L2PriceFeedMock;
  let quoteToken: ERC20Fake;
  let admin: SignerWithAddress;

  beforeEach(async () => {
    const account = await ethers.getSigners();
    admin = account[0];

    l2PriceFeed = await deployL2MockPriceFeed(admin, toFullDigitBN(ETH_PRICE));
    quoteToken = await deployErc20Fake(admin, toFullDigitBN(20000000));
    amm = await deployAmm({
      deployer: admin,
      quoteAssetTokenAddr: quoteToken.address,
      priceFeedAddr: l2PriceFeed.address,
      fluctuation: toFullDigitBN(0),
      fundingPeriod: BigNumber.from(3600), // 1 hour
    });
    await amm.setCounterParty(admin.address);

    ammReader = await deployAmmReader(admin);
  });

  it("verify inputs & outputs", async () => {
    const {
      quoteAssetReserve,
      baseAssetReserve,
      tradeLimitRatio,
      fundingPeriod,
      quoteAssetSymbol,
      baseAssetSymbol,
      priceFeedKey,
      priceFeed,
    } = await ammReader.getAmmStates(amm.address);
    expect(quoteAssetReserve).to.eq(toFullDigitBN(1000));
    expect(baseAssetReserve).to.eq(toFullDigitBN(100));
    expect(tradeLimitRatio).to.eq(toFullDigitBN(0.9));
    expect(fundingPeriod).to.eq("3600");
    expect(quoteAssetSymbol).to.eq("symbol");
    expect(baseAssetSymbol).to.eq("ETH");
    expect(priceFeedKey).to.eq(ETH_BYTES32);
    expect(priceFeed).to.eq(l2PriceFeed.address);
  });
});
