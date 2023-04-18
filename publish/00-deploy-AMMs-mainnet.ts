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
  insuranceFund: string,
  clearingHouse: string,
  chainlinkPriceFeed: string,
  deployConfig: DeployConfig,
  ammInstanceName: AmmInstanceName,
  ledger: Signer
) {
  // await chainlinkPriceFeed.addAggregator(
  //   deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.priceFeedKey,
  //   deployConfig.aggregators[ammInstanceName]
  // );
  const amm = await deployProxyAmm({
    signer: ledger,
    quoteAssetReserve: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.quoteAssetReserve,
    baseAssetReserve: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.baseAssetReserve,
    tradeLimitRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.tradeLimitRatio,
    fundingPeriod: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.fundingPeriod,
    fluctuation: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.fluctuation,
    priceFeedKey: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.priceFeedKey,
    priceFeedAddress: chainlinkPriceFeed,
    tollRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.tollRatio,
    spreadRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.spreadRatio,
    quoteTokenAddress: deployConfig.weth,
  });
  console.log(`deployed ${ammInstanceName} address: `, amm.address);
  console.log(`configuring for ${ammInstanceName}`);
  await amm.setGlobalShutdown(insuranceFund);
  await amm.setCounterParty(clearingHouse);
  // await insuranceFund.addAmm(amm.address);
  await amm.setOpen(true);
  await amm.setAdjustable(true);
  await amm.setCanLowerK(true);
  return amm;
}

async function main() {
  if (!ethers.utils.isAddress(MULTISIG_ADDRESS) || MULTISIG_ADDRESS == ethers.constants.AddressZero) {
    throw "invalid multisig address";
  }
  const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  console.log("deployer: ", await ledger.getAddress());

  // const [ledger] = await ethers.getSigners();

  const addresses = getAddresses(network.name);

  const deployConfig = new DeployConfig(network.name);

  const baycAmm = await deployAndConfigAmm(
    addresses.insuranceFund,
    addresses.clearingHouse,
    addresses.chainlinkPriceFeed,
    deployConfig,
    AmmInstanceName.BAYCETH,
    ledger
  );
  const azukiAmm = await deployAndConfigAmm(
    addresses.insuranceFund,
    addresses.clearingHouse,
    addresses.chainlinkPriceFeed,
    deployConfig,
    AmmInstanceName.AZUKIETH,
    ledger
  );

  const maycAmm = await deployAndConfigAmm(
    addresses.insuranceFund,
    addresses.clearingHouse,
    addresses.chainlinkPriceFeed,
    deployConfig,
    AmmInstanceName.MAYCETH,
    ledger
  );
  const punksAmm = await deployAndConfigAmm(
    addresses.insuranceFund,
    addresses.clearingHouse,
    addresses.chainlinkPriceFeed,
    deployConfig,
    AmmInstanceName.WRAPPEDCRYPTOPUNKSETH,
    ledger
  );

  await upgrades.admin.transferProxyAdminOwnership(MULTISIG_ADDRESS);
  console.log("successfully transferred proxy admins");

  addresses.amm[AmmInstanceName.BAYCETH] = baycAmm.address;
  addresses.amm[AmmInstanceName.AZUKIETH] = azukiAmm.address;
  addresses.amm[AmmInstanceName.MAYCETH] = maycAmm.address;
  addresses.amm[AmmInstanceName.WRAPPEDCRYPTOPUNKSETH] = punksAmm.address;

  saveAddresses(network.name, addresses);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
