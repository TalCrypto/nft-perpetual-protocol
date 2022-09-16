import { ethers, network, upgrades } from "hardhat";
import { getAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { AmmInstanceName } from "./Constants";
import { ClearingHouse__factory, Amm__factory } from "../typechain-types";

async function main() {
  const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  console.log("deployer: ", await ledger.getAddress());

  const addresses = getAddresses(network.name);
  await upgrades.upgradeProxy(addresses.clearingHouse, new ClearingHouse__factory(ledger));
  console.log("upgraded ClearingHouse");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.AZUKIETH], new Amm__factory(ledger));
  console.log("upgraded AZUKIETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.BAYCETH], new Amm__factory(ledger));
  console.log("upgraded BAYCETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.CLONEXETH], new Amm__factory(ledger));
  console.log("upgraded CLONEXETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.CRYPTOPUNKSETH], new Amm__factory(ledger));
  console.log("upgraded CRYPTOPUNKSETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.DOODLESETH], new Amm__factory(ledger));
  console.log("upgraded DOODLESETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.MEEBITSETH], new Amm__factory(ledger));
  console.log("upgraded MEEBITSETH amm");
  await upgrades.upgradeProxy(addresses.amm[AmmInstanceName.MOONBIRDSETH], new Amm__factory(ledger));
  console.log("upgraded MOONBIRDSETH amm");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
