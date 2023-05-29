import { ethers, network, upgrades } from "hardhat";
import { ContractAddresses, getAddresses, saveAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import {
  deployAmmReader,
  deployChainlinkPriceFeed,
  deployClearingHouseViewer,
  deployETHStakingPool,
  deployLiquidator,
  deployProxyAmm,
  deployProxyClearingHouse,
  deployProxyIF,
  deployProxyTollPool,
  deployWhitelistMaster,
} from "../utils/contract";
import { DeployConfig } from "./DeployConfig";
import { AmmInstanceName } from "./Constants";
import { Amm, InsuranceFund, ClearingHouse, ChainlinkPriceFeed } from "../typechain-types";
import { Signer } from "ethers";
import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

const MULTISIG_ADDRESS = `${process.env.MULTISIG_ADDRESS}`;

async function deployAndConfigAmm(
  insuranceFundAddr: string,
  clearingHouseAddr: string,
  chainlinkPriceFeedAddr: string,
  deployConfig: DeployConfig,
  ammInstanceName: AmmInstanceName,
  ledger: Signer
) {
  if (!ethers.utils.isAddress(MULTISIG_ADDRESS) || MULTISIG_ADDRESS == ethers.constants.AddressZero) {
    throw "invalid multisig address";
  }
  const amm = await deployProxyAmm({
    signer: ledger,
    quoteAssetReserve: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.quoteAssetReserve,
    baseAssetReserve: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.baseAssetReserve,
    tradeLimitRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.tradeLimitRatio,
    fundingPeriod: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.fundingPeriod,
    fluctuation: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.fluctuation,
    priceFeedKey: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.priceFeedKey,
    priceFeedAddress: chainlinkPriceFeedAddr,
    tollRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.tollRatio,
    spreadRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.spreadRatio,
    quoteTokenAddress: deployConfig.weth,
  });
  console.log(`deployed ${ammInstanceName} address: `, amm.address);
  console.log(`configuring for ${ammInstanceName}`);
  await amm.setGlobalShutdown(insuranceFundAddr);
  await amm.setCounterParty(clearingHouseAddr);
  // await insuranceFund.addAmm(amm.address);
  await amm.setOpen(true);
  await amm.setAdjustable(true);
  await amm.setCanLowerK(true);
  await amm.transferOwnership(MULTISIG_ADDRESS);
  return amm;
}

async function main() {
  const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  console.log("deployer: ", await ledger.getAddress());

  // const [ledger] = await ethers.getSigners();

  const addresses = getAddresses(network.name);

  const deployConfig = new DeployConfig(network.name);

  const degodsAmm = await deployAndConfigAmm(
    addresses.insuranceFund,
    addresses.clearingHouse,
    addresses.chainlinkPriceFeed,
    deployConfig,
    AmmInstanceName.DEGODSETH,
    ledger
  );
  const captainzAmm = await deployAndConfigAmm(
    addresses.insuranceFund,
    addresses.clearingHouse,
    addresses.chainlinkPriceFeed,
    deployConfig,
    AmmInstanceName.THECAPTAINZETH,
    ledger
  );

  addresses.amm[AmmInstanceName.DEGODSETH] = degodsAmm.address;
  addresses.amm[AmmInstanceName.THECAPTAINZETH] = captainzAmm.address;

  saveAddresses(network.name, addresses);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
