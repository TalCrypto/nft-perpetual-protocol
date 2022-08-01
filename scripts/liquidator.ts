import { queryTraders } from "../utils/graphql";
import { ethers, network } from "hardhat";
import { getNetwork } from "../utils/network";
import { toFullDigitBN } from "../utils/number";

async function main() {
  const maintenanceMarginRatio = toFullDigitBN(0.05);
  const contracts = getNetwork(network.name);
  const ClearingHouse = await ethers.getContractFactory("ClearingHouse");
  const clearingHouse = await ClearingHouse.attach(contracts.clearingHouse.address);
  const Liquidator = await ethers.getContractFactory("Liquidator");
  const liquidator = await Liquidator.attach(contracts.liquidator.address);
  const Amm = await ethers.getContractFactory("Amm");
  const amm = await Amm.attach(contracts.amm.address);
  const L2PriceFeedMock = await ethers.getContractFactory("L2PriceFeedMock");
  const mockPriceFeed = await L2PriceFeedMock.attach(contracts.priceFeed.address);

  const traders = await queryTraders(contracts.amm.address);

  const marketPrice = await amm.getSpotPrice();
  await mockPriceFeed.setPrice(marketPrice);

  let addressesOfLiquidatableTraders: Array<string> = [];

  for (let i = 0; i < traders.length; i++) {
    const marginRatio = await clearingHouse.getMarginRatio(contracts.amm.address, traders[i].trader);
    if (marginRatio.lt(maintenanceMarginRatio)) {
      addressesOfLiquidatableTraders.push(traders[i].trader);
    }
  }
  console.log("liquidatableTraders", addressesOfLiquidatableTraders);
  //TODO split traders when there are so many
  await liquidator.liquidate(contracts.amm.address, addressesOfLiquidatableTraders);
  console.log("Successfully liquidated");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
