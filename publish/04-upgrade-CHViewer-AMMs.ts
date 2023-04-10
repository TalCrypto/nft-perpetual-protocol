import { ethers, network, upgrades } from "hardhat";
import { getAddresses, saveAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { AmmInstanceName } from "./Constants";
import { ClearingHouse__factory, Amm__factory, ClearingHouseViewer__factory } from "../typechain-types";
import { deployClearingHouseViewer } from "../utils/contract";

async function main() {
  // const accounts = await ethers.getSigners();
  // const ledger = accounts[0];

  const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  console.log("deployer: ", await ledger.getAddress());

  const addresses = getAddresses(network.name);

  console.log("deploying ClearingHouseViewer");
  const clearingHouseViewer = await deployClearingHouseViewer(ledger, addresses.clearingHouse);
  console.log("deployed ClearingHouseViewer address: ", clearingHouseViewer.address);
  addresses.clearingHouseViewer = clearingHouseViewer.address;

  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.AZUKIETH], new Amm__factory(ledger));
  console.log("upgraded AZUKIETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.BAYCETH], new Amm__factory(ledger));
  console.log("upgraded BAYCETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.MAYCETH], new Amm__factory(ledger));
  console.log("upgraded MAYCETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.WRAPPEDCRYPTOPUNKSETH], new Amm__factory(ledger));
  console.log("upgraded WRAPPEDCRYPTOPUNKSETH amm");

  saveAddresses(network.name, addresses);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
