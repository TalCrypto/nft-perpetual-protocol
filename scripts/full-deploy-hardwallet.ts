import { ethers, run, network } from "hardhat";
import { fullProxyDeploy } from "../utils/deploy";
import { ContractNetwork, setNetwork } from "../utils/network";
import { LedgerSigner } from "@ethersproject/hardware-wallets";

async function main() {
  const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  const { amm, insuranceFund, quoteToken, priceFeed, clearingHouse, liquidator } = await fullProxyDeploy({ sender: ledger });
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
