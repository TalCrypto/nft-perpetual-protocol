import { run, network, upgrades } from "hardhat";
import { ContractAddresses, getAddresses, saveAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { AmmInstanceName, ContractFullyQualifiedName } from "./Constants";
import { DeployConfig } from "./DeployConfig";

export async function getImplementation(proxyAddr: string) {
  const proxyAdmin = await upgrades.admin.getInstance();
  return proxyAdmin.getProxyImplementation(proxyAddr);
}

async function main() {
  const addresses = getAddresses(network.name);

  // upgradable contracts verification

  console.log("verifying ClearingHouse impl contract");
  const clearingHouseImplAddr = await getImplementation(addresses.clearingHouse);
  await run("verify:verify", {
    address: clearingHouseImplAddr,
    constructorArguments: [],
    contract: ContractFullyQualifiedName.ClearingHouse,
  });

  console.log("verifying BAYC_Amm/Doodl_Amm impl contract");
  const baycAmmImplAddr = await getImplementation(addresses.amm[AmmInstanceName.BAYCETH]);
  await run("verify:verify", {
    address: baycAmmImplAddr,
    constructorArguments: [],
    contract: ContractFullyQualifiedName.Amm,
  });

  console.log("verifying InsuranceFund impl contract");
  const iFImplAddr = await getImplementation(addresses.insuranceFund);
  await run("verify:verify", {
    address: iFImplAddr,
    constructorArguments: [],
    contract: ContractFullyQualifiedName.InsuranceFund,
  });

  console.log("verifying TollPool impl contract");
  const tollPoolImplAddr = await getImplementation(addresses.tollPool);
  await run("verify:verify", {
    address: tollPoolImplAddr,
    constructorArguments: [],
    contract: ContractFullyQualifiedName.TollPool,
  });

  // non-upgradable contracts verification

  console.log("verifying ClearingHouseViewer contract");
  await run("verify:verify", {
    address: addresses.clearingHouseViewer,
    constructorArguments: [addresses.clearingHouse],
    contract: ContractFullyQualifiedName.ClearingHouseViewer,
  });

  console.log("verifying AmmReader contract");
  await run("verify:verify", {
    address: addresses.ammReader,
    constructorArguments: [],
    contract: ContractFullyQualifiedName.AmmReader,
  });

  const deployConfig = new DeployConfig(network.name);
  console.log("verifying Liquidator contract");
  await run("verify:verify", {
    address: addresses.liquidator,
    constructorArguments: [addresses.clearingHouse],
    contract: ContractFullyQualifiedName.Liquidator,
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
