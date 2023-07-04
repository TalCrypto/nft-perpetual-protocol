import { ethers, network, upgrades, defender } from "hardhat";
import { ContractAddresses, getAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { AmmInstanceName } from "./Constants";
import { ClearingHouse__factory, Amm__factory } from "../typechain-types";
import { Signer } from "ethers";

async function proposeUpgradeAMM(deployer: Signer, addresses: ContractAddresses, ammNam: AmmInstanceName) {
  const proxyAddress = addresses.amm[ammNam];
  if (!proxyAddress) {
    console.log(`${ammNam} AMM doesn't exist`);
  } else {
    console.log(`Preparing proposal to upgrade ${ammNam}...`);
    const proposal = await defender.proposeUpgrade(proxyAddress, new Amm__factory(deployer));
    console.log(`${ammNam} upgrade proposal created at:`, proposal.url);
  }
}

async function main() {
  // const accounts = await ethers.getSigners();
  // const ledger = accounts[0];

  const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  console.log("deployer: ", await ledger.getAddress());

  const addresses = getAddresses(network.name);

  await proposeUpgradeAMM(ledger, addresses, AmmInstanceName.BAYCETH);
  await proposeUpgradeAMM(ledger, addresses, AmmInstanceName.MAYCETH);
  await proposeUpgradeAMM(ledger, addresses, AmmInstanceName.AZUKIETH);
  await proposeUpgradeAMM(ledger, addresses, AmmInstanceName.WRAPPEDCRYPTOPUNKSETH);
  await proposeUpgradeAMM(ledger, addresses, AmmInstanceName.DEGODSETH);
  await proposeUpgradeAMM(ledger, addresses, AmmInstanceName.THECAPTAINZETH);
  await proposeUpgradeAMM(ledger, addresses, AmmInstanceName.MILADYETH);
  await proposeUpgradeAMM(ledger, addresses, AmmInstanceName.PUDGYPENGUINSETH);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
