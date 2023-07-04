import { ethers, network } from "hardhat";
import { getAddresses, saveAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { deployLiquidator, deployProxyAmm } from "../utils/contract";
import { DeployConfig } from "./DeployConfig";
import { AmmInstanceName, PriceFeedKey } from "./Constants";

async function main() {
  // const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  const accounts = await ethers.getSigners();
  const ledger = accounts[0];
  console.log("deployer: ", await ledger.getAddress());

  const deployConfig = new DeployConfig(network.name);
  const addresses = getAddresses(network.name);

  console.log("deploying liquidator");
  const liquidator = await deployLiquidator(ledger, addresses.clearingHouse);
  console.log("deployed liquidator address: ", liquidator.address);

  const ClearingHouse = await ethers.getContractFactory("ClearingHouse");
  const clearing = await ClearingHouse.attach(addresses.clearingHouse);
  await clearing.setBackstopLiquidityProvider(liquidator.address, true);

  addresses.liquidator = liquidator.address;

  saveAddresses(network.name, addresses);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
