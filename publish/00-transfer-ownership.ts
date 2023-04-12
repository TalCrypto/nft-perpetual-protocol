import { ethers, network, upgrades } from "hardhat";
import { getAddresses, saveAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { deployLiquidator, deployProxyAmm } from "../utils/contract";
import { DeployConfig } from "./DeployConfig";
import { AmmInstanceName, PriceFeedKey } from "./Constants";

import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

const MULTISIG_ADDRESS = `${process.env.MULTISIG_ADDRESS}`;

async function main() {
  if (!ethers.utils.isAddress(MULTISIG_ADDRESS) || MULTISIG_ADDRESS == ethers.constants.AddressZero) {
    throw "invalid multisig address";
  }
  // const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  const [ledger] = await ethers.getSigners();

  await upgrades.admin.transferProxyAdminOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred proxy admins");

  const addresses = getAddresses(network.name);

  const insuranceFund = await ethers.getContractAt("InsuranceFund", addresses.insuranceFund, ledger);
  const clearingHouse = await ethers.getContractAt("ClearingHouse", addresses.clearingHouse, ledger);
  const tollPool = await ethers.getContractAt("TollPool", addresses.tollPool, ledger);
  const ethStakingPool = await ethers.getContractAt("ETHStakingPool", addresses.ethStakingPool, ledger);
  const whitelistMaster = await ethers.getContractAt("WhitelistMaster", addresses.whitelistMaster, ledger);
  const chainlinkPriceFeed = await ethers.getContractAt("ChainlinkPriceFeed", addresses.chainlinkPriceFeed, ledger);
  const liquidator = await ethers.getContractAt("Liquidator", addresses.liquidator, ledger);
  const baycAmm = await ethers.getContractAt("Amm", addresses.amm[AmmInstanceName.BAYCETH], ledger);
  const maycAmm = await ethers.getContractAt("Amm", addresses.amm[AmmInstanceName.MAYCETH], ledger);
  const azukiAmm = await ethers.getContractAt("Amm", addresses.amm[AmmInstanceName.AZUKIETH], ledger);
  const wpunksAmm = await ethers.getContractAt("Amm", addresses.amm[AmmInstanceName.WRAPPEDCRYPTOPUNKSETH], ledger);

  await insuranceFund.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of InsuranceFund");
  await clearingHouse.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of ClearingHouse");
  await tollPool.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of TollPool");
  await ethStakingPool.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of ETHStakingPool");
  await whitelistMaster.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of WhitelistMaster");
  await chainlinkPriceFeed.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of ChainlinkPriceFeed");
  await liquidator.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of Liquidator");
  await baycAmm.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of BAYC_AMM");
  await maycAmm.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of MAYC_AMM");
  await azukiAmm.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of AZUKI_AMM");
  await wpunksAmm.transferOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred ownership of WPUNKS_AMM");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
