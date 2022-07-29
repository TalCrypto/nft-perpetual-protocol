import { ethers, run, network } from "hardhat";
import { fullProxyDeploy } from "../utils/deploy";
import { setNetwork } from "../utils/network";

async function main() {
  const accounts = await ethers.getSigners();
  const admin = accounts[0];
  const { amm, insuranceFund, quoteToken, priceFeed, clearingHouse, liquidator } = await fullProxyDeploy({ sender: admin });
  await run("graph", { contractName: "ClearingHouse", address: clearingHouse.address });
  await run("graph", { contractName: "Amm", address: amm.address });
  const contracts = {
    Amm: { address: amm.address },
    InsuranceFund: { address: insuranceFund.address },
    QuoteToken: { address: quoteToken.address },
    PriceFeed: { address: priceFeed.address },
    ClearingHouse: { address: clearingHouse.address },
    Liquidator: { address: liquidator.address },
  };
  await setNetwork(network.name, contracts);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
