import { ethers, network } from "hardhat";
import { ContractAddresses, saveAddresses } from "./addresses";
// import { LedgerSigner } from "@ethersproject/hardware-wallets";
import {
  deployAmmReader,
  deployClearingHouseViewer,
  deployLiquidator,
  deployProxyAmm,
  deployProxyClearingHouse,
  deployProxyIF,
  deployProxyTollPool,
} from "../utils/contract";
import { DeployConfig } from "./DeployConfig";
import { AmmInstanceName } from "./Constants";
import { Amm, InsuranceFund, ClearingHouse } from "../typechain-types";
import { Signer } from "ethers";

async function deployAmm(deployConfig: DeployConfig, ammInstanceName: AmmInstanceName, ledger: Signer) {
  console.log(`deploying ${ammInstanceName}`);
  const amm = await deployProxyAmm({
    signer: ledger,
    quoteAssetReserve: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.quoteAssetReserve,
    baseAssetReserve: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.baseAssetReserve,
    tradeLimitRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.tradeLimitRatio,
    fundingPeriod: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.fundingPeriod,
    fluctuation: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.fluctuation,
    priceFeedKey: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.priceFeedKey,
    priceFeedAddress: deployConfig.priceFeed,
    tollRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.tollRatio,
    spreadRatio: deployConfig.legacyAmmConfigMap[ammInstanceName].deployArgs.spreadRatio,
    quoteTokenAddress: deployConfig.weth,
  });
  console.log(`deployed ${ammInstanceName} address: `, amm.address);
  return amm;
}

async function configAmm(
  deployConfig: DeployConfig,
  amm: Amm,
  ammInstanceName: AmmInstanceName,
  insuranceFund: InsuranceFund,
  clearingHouse: ClearingHouse
) {
  await amm.setGlobalShutdown(insuranceFund.address);
  await amm.setCounterParty(clearingHouse.address);
  await insuranceFund.addAmm(amm.address);
  // if (
  //   deployConfig.legacyAmmConfigMap[ammInstanceName].properties.maxHoldingBaseAsset.gt(ethers.utils.parseEther("0")) ||
  //   deployConfig.legacyAmmConfigMap[ammInstanceName].properties.openInterestNotionalCap.gt(ethers.utils.parseEther("0"))
  // ) {
  //   await amm.setCap(
  //     deployConfig.legacyAmmConfigMap[ammInstanceName].properties.maxHoldingBaseAsset,
  //     deployConfig.legacyAmmConfigMap[ammInstanceName].properties.openInterestNotionalCap
  //   );
  // }
  await amm.setOpen(true);
  await amm.setAdjustable(true);
  await amm.setCanLowerK(true);
}

async function main() {
  // const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  // console.log("deployer: ", await ledger.getAddress());

  const ledger = (await ethers.getSigners())[0];

  const deployConfig = new DeployConfig(network.name);

  console.log("deploying InsuranceFund");
  const insuranceFund = await deployProxyIF(ledger);
  console.log("deployed InsuranceFund address: ", insuranceFund.address);

  console.log("deploying ClearingHouse");
  const clearingHouse = await deployProxyClearingHouse(
    ledger,
    deployConfig.initMarginRequirement,
    deployConfig.maintenanceMarginRequirement,
    deployConfig.liquidationFeeRatio,
    insuranceFund.address
  );
  console.log("deployed ClearingHouse address: ", clearingHouse.address);

  if (deployConfig.partialLiquidationRatio.gt(ethers.utils.parseEther("0"))) {
    await clearingHouse.setPartialLiquidationRatio(deployConfig.partialLiquidationRatio);
  }

  console.log("deploying ClearingHouseViewer");
  const clearingHouseViewer = await deployClearingHouseViewer(ledger, clearingHouse.address);
  console.log("deployed ClearingHouseViewer address: ", clearingHouseViewer.address);

  console.log("deploying TollPool");
  const tollPool = await deployProxyTollPool(ledger, clearingHouse.address);
  console.log("deployed TollPool address: ", tollPool.address);

  await clearingHouse.setTollPool(tollPool.address);

  const baycAmm = await deployAmm(deployConfig, AmmInstanceName.BAYCETH, ledger);
  const doodleAmm = await deployAmm(deployConfig, AmmInstanceName.DOODLESETH, ledger);
  const azukiAmm = await deployAmm(deployConfig, AmmInstanceName.AZUKIETH, ledger);
  const moonbirdsAmm = await deployAmm(deployConfig, AmmInstanceName.MOONBIRDSETH, ledger);
  const cloneXAmm = await deployAmm(deployConfig, AmmInstanceName.CLONEXETH, ledger);
  const cryptoPunksAmm = await deployAmm(deployConfig, AmmInstanceName.CRYPTOPUNKSETH, ledger);
  const meebitsAmm = await deployAmm(deployConfig, AmmInstanceName.MEEBITSETH, ledger);

  console.log("deploying AmmReader");
  const ammReader = await deployAmmReader(ledger);
  console.log("deployed AmmReader address: ", ammReader.address);

  await configAmm(deployConfig, baycAmm, AmmInstanceName.BAYCETH, insuranceFund, clearingHouse);
  await configAmm(deployConfig, doodleAmm, AmmInstanceName.DOODLESETH, insuranceFund, clearingHouse);
  await configAmm(deployConfig, azukiAmm, AmmInstanceName.AZUKIETH, insuranceFund, clearingHouse);
  await configAmm(deployConfig, moonbirdsAmm, AmmInstanceName.MOONBIRDSETH, insuranceFund, clearingHouse);
  await configAmm(deployConfig, cloneXAmm, AmmInstanceName.CLONEXETH, insuranceFund, clearingHouse);
  await configAmm(deployConfig, cryptoPunksAmm, AmmInstanceName.CRYPTOPUNKSETH, insuranceFund, clearingHouse);
  await configAmm(deployConfig, meebitsAmm, AmmInstanceName.MEEBITSETH, insuranceFund, clearingHouse);

  await insuranceFund.setBeneficiary(clearingHouse.address);
  await tollPool.addFeeToken(deployConfig.weth);

  const liquidator = await deployLiquidator(ledger, clearingHouse.address);

  await clearingHouse.setBackstopLiquidityProvider(liquidator.address, true);

  const contracts: ContractAddresses = {
    insuranceFund: insuranceFund.address,
    clearingHouse: clearingHouse.address,
    clearingHouseViewer: clearingHouseViewer.address,
    amm: {
      [AmmInstanceName.BAYCETH]: baycAmm.address,
      [AmmInstanceName.DOODLESETH]: doodleAmm.address,
      [AmmInstanceName.AZUKIETH]: azukiAmm.address,
      [AmmInstanceName.MOONBIRDSETH]: moonbirdsAmm.address,
      [AmmInstanceName.CLONEXETH]: cloneXAmm.address,
      [AmmInstanceName.CRYPTOPUNKSETH]: cryptoPunksAmm.address,
      [AmmInstanceName.MEEBITSETH]: meebitsAmm.address,
    },
    ammReader: ammReader.address,
    tollPool: tollPool.address,
    liquidator: liquidator.address,
  };
  saveAddresses(network.name, contracts);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
