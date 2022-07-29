import { expect, use } from "chai";
import { Signer, BigNumber, ContractTransaction, BigNumberish } from "ethers";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
import { AmmFake, ClearingHouseFake, ERC20Fake, InsuranceFundFake, L2PriceFeedMock } from "../../../typechain-types";
import { Side } from "../../../utils/contract";
import { fullDeploy } from "../../../utils/deploy";
import { toFullDigitBN } from "../../../utils/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

use(solidity);

describe("Bad Debt Test", () => {
  let admin: SignerWithAddress;
  let whale: SignerWithAddress;
  let shrimp: SignerWithAddress;

  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let mockPriceFeed!: L2PriceFeedMock;
  let clearingHouse: ClearingHouseFake;

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

  async function syncAmmPriceToOracle() {
    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setPrice(marketPrice);
  }

  async function deployEnvFixture() {
    const account = await ethers.getSigners();
    admin = account[0];
    whale = account[1];
    shrimp = account[2];

    const contracts = await fullDeploy({ sender: admin });
    amm = contracts.amm;
    insuranceFund = contracts.insuranceFund;
    quoteToken = contracts.quoteToken;
    mockPriceFeed = contracts.priceFeed;
    clearingHouse = contracts.clearingHouse;
    clearingHouse = contracts.clearingHouse;

    // for manipulating the price
    await quoteToken.transfer(whale.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await approve(whale, clearingHouse.address, 5000);

    // account that will incur bad debt
    await quoteToken.transfer(shrimp.address, toFullDigitBN(15, +(await quoteToken.decimals())));
    await approve(shrimp, clearingHouse.address, 15);

    await quoteToken.transfer(insuranceFund.address, toFullDigitBN(50000, +(await quoteToken.decimals())));

    await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));

    await syncAmmPriceToOracle();

    // shrimp open small long
    // position size: 7.40740741
    await clearingHouse.connect(shrimp).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(8), toFullDigitBN(0));

    // whale drop spot price
    for (let i = 0; i < 5; i++) {
      await clearingHouse.connect(whale).openPosition(amm.address, Side.SELL, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0));
    }

    // spot price: 3.364
    await forwardBlockTimestamp(1);
  }

  beforeEach(async () => {
    await loadFixture(deployEnvFixture);
  });

  it("cannot increase position when bad debt", async () => {
    // increase position should fail since margin is not enough
    await expect(
      clearingHouse.connect(shrimp).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0))
    ).to.be.revertedWith("Margin ratio not meet criteria");

    // pump spot price
    await clearingHouse.connect(whale).closePosition(amm.address, toFullDigitBN(0));

    // increase position should succeed since the position no longer has bad debt
    await clearingHouse.connect(shrimp).openPosition(amm.address, Side.BUY, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0));
  });

  it("cannot reduce position when bad debt", async () => {
    // reduce position should fail since margin is not enough
    await expect(
      clearingHouse.connect(shrimp).openPosition(amm.address, Side.SELL, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0))
    ).to.be.revertedWith("Margin ratio not meet criteria");

    // pump spot price
    await clearingHouse.connect(whale).closePosition(amm.address, toFullDigitBN(0));

    // reduce position should succeed since the position no longer has bad debt
    await clearingHouse.connect(shrimp).openPosition(amm.address, Side.SELL, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0));
  });

  it("cannot close position when bad debt", async () => {
    // close position should fail since bad debt
    // open notional = 80
    // estimated realized PnL (partial close) = 7.4 * 3.36 - 80 = -55.136
    // estimated remaining margin = 10 + (-55.136) = -45.136
    // real bad debt: 46.10795455
    await expect(clearingHouse.connect(shrimp).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("bad debt");

    // pump spot price
    await clearingHouse.connect(whale).closePosition(amm.address, toFullDigitBN(0));

    // increase position should succeed since the position no longer has bad debt
    await clearingHouse.connect(shrimp).closePosition(amm.address, toFullDigitBN(0));
  });

  it("can not partial close position when bad debt", async () => {
    // set fluctuation limit ratio to trigger partial close
    await amm.setFluctuationLimitRatio(toFullDigitBN("0.000001"));
    await clearingHouse.setPartialLiquidationRatio(toFullDigitBN("0.25"));

    // position size: 7.4074074074
    // open notional = 80
    // estimated realized PnL (partial close) = 7.4 * 0.25 * 3.36 - 80 * 0.25 = -13.784
    // estimated remaining margin = 10 + (-13.784) = -3.784
    // real bad debt = 4.027
    await expect(clearingHouse.connect(shrimp).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("bad debt");
  });

  it("can partial close position as long as it does not incur bad debt", async () => {
    // set fluctuation limit ratio to trigger partial close
    await amm.setFluctuationLimitRatio(toFullDigitBN("0.000001"));
    await clearingHouse.setPartialLiquidationRatio(toFullDigitBN("0.1"));

    // position size: 7.4074074074
    // open notional = 80
    // estimated realized PnL (partial close) = 7.4 * 0.1 * 3.36 - 80 * 0.1 = -5.5136
    // estimated remaining margin = 10 + (-5.5136) = 4.4864
    // real bad debt = 0
    await clearingHouse.connect(shrimp).closePosition(amm.address, toFullDigitBN(0));

    // remaining position size = 7.4074074074 * 0.9 = 6.66666667
    expect((await clearingHouse.getPosition(amm.address, shrimp.address)).size).to.be.eq("6666666666666666667");
  });

  it("can liquidate position by backstop LP when bad debt", async () => {
    // set whale to backstop LP
    await clearingHouse.setBackstopLiquidityProvider(whale.address, true);

    // close position should fail since bad debt
    // open notional = 80
    // estimated realized PnL (partial close) = 7.4 * 3.36 - 80 = -55.136
    // estimated remaining margin = 10 + (-55.136) = -45.136
    // real bad debt: 46.10795455
    await expect(clearingHouse.connect(shrimp).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("bad debt");

    // no need to manipulate TWAP because the spot price movement is large enough
    // that getMarginRatio() returns negative value already
    await syncAmmPriceToOracle();

    // can liquidate bad debt position
    await clearingHouse.connect(whale).liquidate(amm.address, shrimp.address);
  });

  it("cannot liquidate position by non backstop LP when bad debt", async () => {
    // close position should fail since bad debt
    // open notional = 80
    // estimated realized PnL (partial close) = 7.4 * 3.36 - 80 = -55.136
    // estimated remaining margin = 10 + (-55.136) = -45.136
    // real bad debt: 46.10795455
    await expect(clearingHouse.connect(shrimp).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("bad debt");

    // no need to manipulate TWAP because the spot price movement is large enough
    // that getMarginRatio() returns negative value already
    await syncAmmPriceToOracle();

    // can liquidate bad debt position
    await expect(clearingHouse.connect(whale).liquidate(amm.address, shrimp.address)).to.be.revertedWith("not backstop LP");
  });
});

describe("Withdrawal Constraint Test, pause withdrawals whenever their bad debts are more than balance of IF", () => {
  let admin: SignerWithAddress;
  let accounts: SignerWithAddress[];

  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let mockPriceFeed!: L2PriceFeedMock;
  let clearingHouse: ClearingHouseFake;

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

    for (let i = 1; i < 6; i++) {
      await quoteToken.transfer(accounts[i].address, toFullDigitBN(15, +(await quoteToken.decimals())));
      await approve(accounts[i], clearingHouse.address, 15);
    }

    await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));
    await syncAmmPriceToOracle();

    for (let i = 1; i < 6; i++) {
      await clearingHouse.connect(accounts[i]).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0));
      await forwardBlockTimestamp(1);
    }
  }
  beforeEach(async () => {
    await loadFixture(deployEnvFixture);
  });
  describe("when the balance of clearing house is sufficient", () => {
    beforeEach(async () => {
      await quoteToken.transfer(insuranceFund.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
      await clearingHouse.connect(accounts[1]).closePosition(amm.address, toFullDigitBN(0));
      //balance of account1 94.999999999999999992
      //prepaid bad debt 39.999999999999999992
      //balance of insurance fund 4960.000000000000000008
    });
    it("account2 can be closed", async () => {
      await clearingHouse.connect(accounts[2]).closePosition(amm.address, toFullDigitBN(0));
    });
    it("account3 can be closed", async () => {
      await clearingHouse.connect(accounts[3]).closePosition(amm.address, toFullDigitBN(0));
    });
    it("account4 can't be closed because of bad debt", async () => {
      await expect(clearingHouse.connect(accounts[4]).closePosition(amm.address, toFullDigitBN(0))).revertedWith("bad debt");
    });
    it("account5 can't be closed because of bad debt", async () => {
      await expect(clearingHouse.connect(accounts[5]).closePosition(amm.address, toFullDigitBN(0))).revertedWith("bad debt");
    });
  });
  describe("when up to half of insurance fund is paid as bad debt", () => {
    beforeEach(async () => {
      await quoteToken.transfer(insuranceFund.address, toFullDigitBN(80, +(await quoteToken.decimals())));
      await clearingHouse.connect(accounts[1]).closePosition(amm.address, toFullDigitBN(0));
      //balance of account1 94.999999999999999992
      //prepaid bad debt 39.999999999999999992
      //balance of insurance fund 40.000000000000000008
    });
    it("account2 can't be closed because of realizing bad debt", async () => {
      await expect(clearingHouse.connect(accounts[2]).closePosition(amm.address, toFullDigitBN(0))).revertedWith(
        "wait until realize bad debt"
      );
    });
    it("account3 can't be closed because of realizing bad debt", async () => {
      await expect(clearingHouse.connect(accounts[3]).closePosition(amm.address, toFullDigitBN(0))).revertedWith(
        "wait until realize bad debt"
      );
    });
    it("account4 can't be closed because of bad debt", async () => {
      await expect(clearingHouse.connect(accounts[4]).closePosition(amm.address, toFullDigitBN(0))).revertedWith("bad debt");
    });
    it("account5 can't be closed because of bad debt", async () => {
      await expect(clearingHouse.connect(accounts[5]).closePosition(amm.address, toFullDigitBN(0))).revertedWith("bad debt");
    });
    it("account3 can be closed after realizing bad debt of account5", async () => {
      await clearingHouse.setBackstopLiquidityProvider(admin.address, true);
      await clearingHouse.liquidate(amm.address, accounts[5].address);
      await clearingHouse.connect(accounts[3]).closePosition(amm.address, toFullDigitBN(0));
    });
    it("account2 can be closed after realizing bad debt of account5 and account4", async () => {
      await clearingHouse.setBackstopLiquidityProvider(admin.address, true);
      await clearingHouse.liquidate(amm.address, accounts[5].address);
      await clearingHouse.liquidate(amm.address, accounts[4].address);
      await clearingHouse.connect(accounts[2]).closePosition(amm.address, toFullDigitBN(0));
    });
  });
});
