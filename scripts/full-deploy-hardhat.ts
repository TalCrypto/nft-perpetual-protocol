import { ethers, run, network } from "hardhat";
import { fullProxyDeploy } from "../utils/deploy";
import { ContractNetwork, setNetwork } from "../utils/network";

async function main() {
  const accounts = await ethers.getSigners();
  const admin = accounts[0];
  const { amm, insuranceFund, quoteToken, priceFeed, clearingHouse, liquidator } = await fullProxyDeploy({ sender: admin });
  await run("graph", { contractName: "ClearingHouse", address: clearingHouse.address });
  await run("graph", { contractName: "Amm", address: amm.address });
  const contracts: ContractNetwork = {
    amm: { address: amm.address },
    insuranceFund: { address: insuranceFund.address },
    quoteToken: { address: quoteToken.address },
    priceFeed: { address: priceFeed.address },
    clearingHouse: { address: clearingHouse.address },
    liquidator: { address: liquidator.address },
  };
  setNetwork(network.name, contracts);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
