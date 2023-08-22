import { ethers, network, upgrades, defender } from "hardhat";
import { ContractAddresses, getAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { AmmInstanceName } from "./Constants";
import { ClearingHouse__factory, Amm__factory, InsuranceFund__factory, ETHStakingPool__factory } from "../typechain-types";
import { Signer } from "ethers";

async function main() {
  const accounts = await ethers.getSigners();
  const ledger = accounts[0];

  // const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  // console.log("deployer: ", await ledger.getAddress());

  const addresses = getAddresses(network.name);
  console.log("Preparing proposal to upgrade StakingPool...");
  const proposalSP = await defender.proposeUpgrade(addresses.ethStakingPool, new ETHStakingPool__factory(ledger));
  console.log("StakingPool upgrade proposal created at:", proposalSP.url);

  console.log("Preparing proposal to upgrade IF...");
  const proposalCH = await defender.proposeUpgrade(addresses.insuranceFund, new InsuranceFund__factory(ledger));
  console.log("IF upgrade proposal created at:", proposalCH.url);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
