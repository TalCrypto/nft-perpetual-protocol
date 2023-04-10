import { ethers, network } from "hardhat";
import { ContractAddresses, saveAddresses } from "./addresses";
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
} from "../utils/contract";
import { DeployConfig } from "./DeployConfig";
import { AmmInstanceName } from "./Constants";
import { Amm, InsuranceFund, ClearingHouse, ChainlinkPriceFeed } from "../typechain-types";
import { Signer } from "ethers";

async function deployAndConfigAmm(
  insuranceFund: InsuranceFund,
  clearingHouse: ClearingHouse,
  chainlinkPriceFeed: ChainlinkPriceFeed,
  deployConfig: DeployConfig,
  ammInstanceName: AmmInstanceName,
  ledger: Signer
) {
  await chainlinkPriceFeed.addAggregator(
    deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.priceFeedKey,
    deployConfig.aggregators[ammInstanceName]
  );
  const amm = await deployProxyAmm({
    signer: ledger,
    quoteAssetReserve: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.quoteAssetReserve,
    baseAssetReserve: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.baseAssetReserve,
    tradeLimitRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.tradeLimitRatio,
    fundingPeriod: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.fundingPeriod,
    fluctuation: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.fluctuation,
    priceFeedKey: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.priceFeedKey,
    priceFeedAddress: chainlinkPriceFeed.address,
    tollRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.tollRatio,
    spreadRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.spreadRatio,
    quoteTokenAddress: deployConfig.weth,
  });
  console.log(`deployed ${ammInstanceName} address: `, amm.address);
  console.log(`configuring for ${ammInstanceName}`);
  await amm.setGlobalShutdown(insuranceFund.address);
  await amm.setCounterParty(clearingHouse.address);
  await insuranceFund.addAmm(amm.address);
  await amm.setOpen(true);
  await amm.setAdjustable(true);
  await amm.setCanLowerK(true);
  return amm;
}

async function main() {
  const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  console.log("deployer: ", await ledger.getAddress());

  // const [ledger] = await ethers.getSigners();

  const deployConfig = new DeployConfig(network.name);
  console.log("deploying InsuranceFund");
  const insuranceFund = await deployProxyIF(ledger);
  console.log("deployed InsuranceFund address: ", insuranceFund.address);

  console.log("deploying ClearingHouse");
  const clearingHouse = await deployProxyClearingHouse(ledger, insuranceFund.address);
  console.log("deployed ClearingHouse address: ", clearingHouse.address);

  console.log("deploying ClearingHouseViewer");
  const clearingHouseViewer = await deployClearingHouseViewer(ledger, clearingHouse.address);
  console.log("deployed ClearingHouseViewer address: ", clearingHouseViewer.address);

  console.log("deploying TollPool");
  const tollPool = await deployProxyTollPool(ledger, clearingHouse.address);
  console.log("deployed TollPool address: ", tollPool.address);

  await clearingHouse.setTollPool(tollPool.address);

  console.log("deploying chainlinkPriceFeed");
  const chainlinkPriceFeed = await deployChainlinkPriceFeed(ledger);
  console.log("deployed chainlinkPriceFeed address: ", tollPool.address);

  const baycAmm = await deployAndConfigAmm(insuranceFund, clearingHouse, chainlinkPriceFeed, deployConfig, AmmInstanceName.BAYCETH, ledger);
  const azukiAmm = await deployAndConfigAmm(
    insuranceFund,
    clearingHouse,
    chainlinkPriceFeed,
    deployConfig,
    AmmInstanceName.AZUKIETH,
    ledger
  );

  const maycAmm = await deployAndConfigAmm(insuranceFund, clearingHouse, chainlinkPriceFeed, deployConfig, AmmInstanceName.MAYCETH, ledger);
  const punksAmm = await deployAndConfigAmm(
    insuranceFund,
    clearingHouse,
    chainlinkPriceFeed,
    deployConfig,
    AmmInstanceName.WRAPPEDCRYPTOPUNKSETH,
    ledger
  );

  console.log("deploying AmmReader");
  const ammReader = await deployAmmReader(ledger);
  console.log("deployed AmmReader address: ", ammReader.address);

  console.log("deploying ETHStakingPool");
  const ethStakingPool = await deployETHStakingPool(ledger, deployConfig.weth, insuranceFund.address);
  console.log("deployed ETHStakingPool address: ", ethStakingPool.address);

  await insuranceFund.setBeneficiary(clearingHouse.address);
  await insuranceFund.activateETHStakingPool(ethStakingPool.address);
  await ethStakingPool.setTribe3Treasury(deployConfig.tribe3Treasury);
  await tollPool.addFeeToken(deployConfig.weth);

  const liquidator = await deployLiquidator(ledger, clearingHouse.address);

  await clearingHouse.setBackstopLiquidityProvider(liquidator.address, true);

  const contracts: ContractAddresses = {
    insuranceFund: insuranceFund.address,
    clearingHouse: clearingHouse.address,
    clearingHouseViewer: clearingHouseViewer.address,
    amm: {
      [AmmInstanceName.BAYCETH]: baycAmm.address,
      [AmmInstanceName.DOODLESETH]: "",
      [AmmInstanceName.AZUKIETH]: azukiAmm.address,
      [AmmInstanceName.MOONBIRDSETH]: "",
      [AmmInstanceName.MAYCETH]: maycAmm.address,
      [AmmInstanceName.PUDGYPENGUINSETH]: "",
      [AmmInstanceName.WRAPPEDCRYPTOPUNKSETH]: punksAmm.address,
    },
    ammReader: ammReader.address,
    tollPool: tollPool.address,
    liquidator: liquidator.address,
    chainlinkPriceFeed: chainlinkPriceFeed.address,
    ethStakingPool: ethStakingPool.address,
    whitelistMaster: "",
  };
  saveAddresses(network.name, contracts);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
