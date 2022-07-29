import { ethers, run } from "hardhat";
import { fullDeploy } from "../utils/deploy";

async function main() {
  const accounts = await ethers.getSigners();
  const admin = accounts[0];
  const { amm, insuranceFund, quoteToken, priceFeed, clearingHouse, liquidator } = await fullDeploy({ sender: admin });
  await run("graph", { contractName: "ClearingHouse", address: clearingHouse.address });
  await run("graph", { contractName: "Amm", address: amm.address });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
