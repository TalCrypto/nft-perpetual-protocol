import { ethers } from "hardhat";
import { expect, use } from "chai";
import { ChainlinkPriceFeedFake, ChainlinkAggregatorMock } from "../../typechain-types";
import { deployChainlinkAggregatorMock, deployChainlinkPriceFeedFake } from "../../utils/contract";
import { toFullDigitBN } from "../../utils/number";

// use(assertionHelper);

describe("ChainlinkPriceFeed Spec", () => {
  const CHAINLINK_DECIMAL = 8;

  let priceFeed!: ChainlinkPriceFeedFake;
  let chainlinkMock1!: ChainlinkAggregatorMock;
  let chainlinkMock2!: ChainlinkAggregatorMock;
  let chainlinkMock3!: ChainlinkAggregatorMock;
  const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000";

  async function deployFixture() {
    const [owner] = await ethers.getSigners();
    const priceFeed = await deployChainlinkPriceFeedFake(owner);
    const chainlinkMock1 = await deployChainlinkAggregatorMock(owner);
    const chainlinkMock2 = await deployChainlinkAggregatorMock(owner);
    const chainlinkMock3 = await deployChainlinkAggregatorMock(owner);

    return { priceFeed, chainlinkMock1, chainlinkMock2, chainlinkMock3 };
  }

  beforeEach(async () => {
    const fixture = await deployFixture();
    priceFeed = fixture.priceFeed;
    chainlinkMock1 = fixture.chainlinkMock1;
    chainlinkMock2 = fixture.chainlinkMock2;
    chainlinkMock3 = fixture.chainlinkMock3;
  });

  describe("addAggregator", () => {
    it("get aggregator with existed aggregator key", async () => {
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), chainlinkMock1.address);
      expect(await priceFeed.aggregators(ethers.utils.formatBytes32String("ETH"))).eq(chainlinkMock1.address);
    });

    it("get aggregator with non-existed aggregator key", async () => {
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), chainlinkMock1.address);
      expect(await priceFeed.aggregators(ethers.utils.formatBytes32String("BTC"))).eq(EMPTY_ADDRESS);
    });

    it("add multi aggregators", async () => {
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), chainlinkMock1.address);
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("BTC"), chainlinkMock2.address);
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("LINK"), chainlinkMock3.address);
      expect(await priceFeed.aggregators(ethers.utils.formatBytes32String("ETH"))).eq(chainlinkMock1.address);
      expect(await priceFeed.aggregators(ethers.utils.formatBytes32String("LINK"))).eq(chainlinkMock3.address);
    });

    it("force error, addAggregator with zero address", async () => {
      await expect(priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), EMPTY_ADDRESS)).revertedWith("empty address");
    });
  });

  describe("removeAggregator", () => {
    it("remove 1 aggregator when there's only 1", async () => {
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), chainlinkMock1.address);
      await priceFeed.removeAggregator(ethers.utils.formatBytes32String("ETH"));

      // cant use expect because the error message is different between CI and local env

      expect(await priceFeed.aggregators(ethers.utils.formatBytes32String("ETH"))).eq(EMPTY_ADDRESS);
    });

    it("remove 1 aggregator when there're 2", async () => {
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), chainlinkMock1.address);
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("BTC"), chainlinkMock1.address);
      await priceFeed.removeAggregator(ethers.utils.formatBytes32String("ETH"));
      expect(await priceFeed.aggregators(ethers.utils.formatBytes32String("ETH"))).eq(EMPTY_ADDRESS);
      expect(await priceFeed.aggregators(ethers.utils.formatBytes32String("BTC"))).eq(chainlinkMock1.address);
    });
  });

  describe("twap", () => {
    beforeEach(async () => {
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), chainlinkMock1.address);
      const currentTime = await priceFeed.mock_getCurrentTimestamp();
      await chainlinkMock1.mockAddAnswer(0, toFullDigitBN(400), currentTime, currentTime, 0);
      const firstTimestamp = currentTime.add(15);
      await chainlinkMock1.mockAddAnswer(1, toFullDigitBN(405), firstTimestamp, firstTimestamp, 1);
      const secondTimestamp = firstTimestamp.add(15);
      await chainlinkMock1.mockAddAnswer(2, toFullDigitBN(410), secondTimestamp, secondTimestamp, 2);
      const thirdTimestamp = secondTimestamp.add(15);
      await priceFeed.mock_setBlockTimestamp(thirdTimestamp);
    });

    // aggregator's answer
    // timestamp(base + 0)  : 400
    // timestamp(base + 15) : 405
    // timestamp(base + 30) : 410
    // now = base + 45
    //
    //  --+------+-----+-----+-----+-----+-----+
    //          base                          now

    it("twap price", async () => {
      const price = await priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 45);
      expect(price).to.eq(toFullDigitBN(405));
    });

    it("asking interval more than aggregator has", async () => {
      const price = await priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 46);
      expect(price).to.eq(toFullDigitBN(405));
    });

    it("asking interval less than aggregator has", async () => {
      const price = await priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 44);
      expect(price).to.eq("405113636363636363636");
    });

    it("given variant price period", async () => {
      const currentTime = await priceFeed.mock_getCurrentTimestamp();
      await chainlinkMock1.mockAddAnswer(4, toFullDigitBN(420), currentTime.add(30), currentTime.add(30), 4);
      await priceFeed.mock_setBlockTimestamp(currentTime.add(50));

      // twap price should be (400 * 15) + (405 * 15) + (410 * 45) + (420 * 20) / 95 = 409.74
      const price = await priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 95);
      expect(price).to.eq("409736842105263157894");
    });

    it("latest price update time is earlier than the request, return the latest price", async () => {
      const currentTime = await priceFeed.mock_getCurrentTimestamp();
      await priceFeed.mock_setBlockTimestamp(currentTime.add(100));

      // latest update time is base + 30, but now is base + 145 and asking for (now - 45)
      // should return the latest price directly
      const price = await priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 45);
      expect(price).to.eq(toFullDigitBN(410));
    });

    it("if current price < 0, ignore the current price", async () => {
      await chainlinkMock1.mockAddAnswer(3, toFullDigitBN(-10), 250, 250, 3);
      const price = await priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 45);
      expect(price).to.eq(toFullDigitBN(405));
    });

    it("if there is a negative price in the middle, ignore that price", async () => {
      const currentTime = await priceFeed.mock_getCurrentTimestamp();
      await chainlinkMock1.mockAddAnswer(3, toFullDigitBN(-100), currentTime.add(20), currentTime.add(20), 3);
      await chainlinkMock1.mockAddAnswer(4, toFullDigitBN(420), currentTime.add(30), currentTime.add(30), 4);
      await priceFeed.mock_setBlockTimestamp(currentTime.add(50));

      // twap price should be (400 * 15) + (405 * 15) + (410 * 45) + (420 * 20) / 95 = 409.74
      const price = await priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 95);
      expect(price).to.eq("409736842105263157894");
    });

    it("force error, interval is zero", async () => {
      await expect(priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 0)).revertedWith("interval can't be 0");
    });
  });

  describe("getprice/getLatestTimestamp/getPreviousPrice/getPreviousTimestamp", () => {
    beforeEach(async () => {
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), chainlinkMock1.address);
      await chainlinkMock1.mockAddAnswer(0, toFullDigitBN(400), 100, 100, 0);
      await chainlinkMock1.mockAddAnswer(1, toFullDigitBN(405), 150, 150, 1);
      await chainlinkMock1.mockAddAnswer(2, toFullDigitBN(410), 200, 200, 2);
    });

    it("getPrice/getTimestamp", async () => {
      const price = await priceFeed.getPrice(ethers.utils.formatBytes32String("ETH"));
      expect(price).to.eq(toFullDigitBN(410));
      const timestamp = await priceFeed.getLatestTimestamp(ethers.utils.formatBytes32String("ETH"));
      expect(timestamp).to.eq(200);
    });

    it("latest getPreviousPrice/getPreviousTimestamp", async () => {
      const price = await priceFeed.getPreviousPrice(ethers.utils.formatBytes32String("ETH"), 0);
      expect(price).to.eq(toFullDigitBN(410));
      const timestamp = await priceFeed.getPreviousTimestamp(ethers.utils.formatBytes32String("ETH"), 0);
      expect(timestamp).to.eq(200);
    });

    it("non-latest getPreviousPrice/getPreviousTimestamp", async () => {
      const price = await priceFeed.getPreviousPrice(ethers.utils.formatBytes32String("ETH"), 2);
      expect(price).to.eq(toFullDigitBN(400));
      const timestamp = await priceFeed.getPreviousTimestamp(ethers.utils.formatBytes32String("ETH"), 2);
      expect(timestamp).to.eq(100);
    });

    it("if current price < 0, return the latest positive price and the according timestamp", async () => {
      await chainlinkMock1.mockAddAnswer(3, toFullDigitBN(-10), 250, 250, 3);

      let price = await priceFeed.getPrice(ethers.utils.formatBytes32String("ETH"));
      expect(price).to.eq(toFullDigitBN(410));
      let timestamp = await priceFeed.getLatestTimestamp(ethers.utils.formatBytes32String("ETH"));
      expect(timestamp).to.eq(200);

      await chainlinkMock1.mockAddAnswer(4, toFullDigitBN(-120), 300, 300, 4);

      price = await priceFeed.getPrice(ethers.utils.formatBytes32String("ETH"));
      expect(price).to.eq(toFullDigitBN(410));
      timestamp = await priceFeed.getLatestTimestamp(ethers.utils.formatBytes32String("ETH"));
      expect(timestamp).to.eq(200);
    });

    it("force error, getPreviousPrice/getPreviousTimestamp fail if the price at that time < 0", async () => {
      await chainlinkMock1.mockAddAnswer(3, toFullDigitBN(-10), 250, 250, 3);

      await expect(priceFeed.getPreviousPrice(ethers.utils.formatBytes32String("ETH"), 0)).revertedWith("Negative price");
      await expect(priceFeed.getPreviousTimestamp(ethers.utils.formatBytes32String("ETH"), 0)).revertedWith("Negative price");

      const price = await priceFeed.getPreviousPrice(ethers.utils.formatBytes32String("ETH"), 2);
      expect(price).to.eq(toFullDigitBN(405));
      const timestamp = await priceFeed.getPreviousTimestamp(ethers.utils.formatBytes32String("ETH"), 2);
      expect(timestamp).to.eq(150);
    });

    it("force error, getPreviousPrice/getPreviousTimestamp more than current history", async () => {
      await expect(priceFeed.getPreviousPrice(ethers.utils.formatBytes32String("ETH"), 10)).revertedWith("Not enough history");
      await expect(priceFeed.getPreviousTimestamp(ethers.utils.formatBytes32String("ETH"), 10)).revertedWith("Not enough history");
    });
  });

  describe("when all price history are negative, there is no enough (valid) history", () => {
    beforeEach(async () => {
      await priceFeed.addAggregator(ethers.utils.formatBytes32String("ETH"), chainlinkMock1.address);
      await chainlinkMock1.mockAddAnswer(0, toFullDigitBN(-400), 100, 100, 0);
      await chainlinkMock1.mockAddAnswer(1, toFullDigitBN(-405), 150, 150, 1);
      await chainlinkMock1.mockAddAnswer(2, toFullDigitBN(-410), 200, 200, 2);
    });

    it("force error, getTwapPrice", async () => {
      await expect(priceFeed.getTwapPrice(ethers.utils.formatBytes32String("ETH"), 40)).revertedWith("Not enough history");
    });

    it("force error, getprice/getLatestTimestamp", async () => {
      await expect(priceFeed.getPrice(ethers.utils.formatBytes32String("ETH"))).revertedWith("Not enough history");
      await expect(priceFeed.getLatestTimestamp(ethers.utils.formatBytes32String("ETH"))).revertedWith("Not enough history");
    });

    it("force error, getPreviousPrice/getPreviousTimestamp still get the 'Negative price' error, as these two functions do not traverse back to a valid one", async () => {
      await expect(priceFeed.getPreviousPrice(ethers.utils.formatBytes32String("ETH"), 0)).revertedWith("Negative price");
      await expect(priceFeed.getPreviousTimestamp(ethers.utils.formatBytes32String("ETH"), 0)).revertedWith("Negative price");

      await expect(priceFeed.getPreviousPrice(ethers.utils.formatBytes32String("ETH"), 1)).revertedWith("Negative price");
      await expect(priceFeed.getPreviousTimestamp(ethers.utils.formatBytes32String("ETH"), 1)).revertedWith("Negative price");
    });
  });
});
