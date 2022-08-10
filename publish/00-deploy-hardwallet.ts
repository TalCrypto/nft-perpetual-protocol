import { ethers, run, network } from "hardhat";
import { ContractAddresses, saveAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
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
import { AmmInstanceName, PriceFeedKey } from "./Constants";

async function main() {
  const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  console.log("deployer: ", await ledger.getAddress());

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

  console.log("deploying ClearingHouseViewer");
  const clearingHouseViewer = await deployClearingHouseViewer(ledger, clearingHouse.address);
  console.log("deployed ClearingHouseViewer address: ", clearingHouseViewer.address);

  console.log("deploying TollPool");
  const tollPool = await deployProxyTollPool(ledger, clearingHouse.address);
  console.log("deployed TollPool address: ", tollPool.address);

  await clearingHouse.setTollPool(tollPool.address);

  console.log("deploying BAYC_AMM");
  const baycAmm = await deployProxyAmm({
    signer: ledger,
    quoteAssetReserve: deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].deployArgs.quoteAssetReserve,
    baseAssetReserve: deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].deployArgs.baseAssetReserve,
    tradeLimitRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].deployArgs.tradeLimitRatio,
    fundingPeriod: deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].deployArgs.fundingPeriod,
    fluctuation: deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].deployArgs.fluctuation,
    priceFeedKey: PriceFeedKey.BAYC,
    priceFeedAddress: deployConfig.chainlinkMap[PriceFeedKey.BAYC],
    tollRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].deployArgs.tollRatio,
    spreadRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].deployArgs.spreadRatio,
    quoteTokenAddress: deployConfig.weth,
  });
  console.log("deployed BAYC_AMM address: ", baycAmm.address);

  console.log("deploying DOODLE_AMM");
  const doodleAmm = await deployProxyAmm({
    signer: ledger,
    quoteAssetReserve: deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].deployArgs.quoteAssetReserve,
    baseAssetReserve: deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].deployArgs.baseAssetReserve,
    tradeLimitRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].deployArgs.tradeLimitRatio,
    fundingPeriod: deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].deployArgs.fundingPeriod,
    fluctuation: deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].deployArgs.fluctuation,
    priceFeedKey: PriceFeedKey.DOODLE,
    priceFeedAddress: deployConfig.chainlinkMap[PriceFeedKey.DOODLE],
    tollRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].deployArgs.tollRatio,
    spreadRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].deployArgs.spreadRatio,
    quoteTokenAddress: deployConfig.weth,
  });
  console.log("deployed DOODLE_AMM address: ", doodleAmm.address);

  console.log("deploying AmmReader");
  const ammReader = await deployAmmReader(ledger);
  console.log("deployed AmmReader address: ", ammReader.address);

  await baycAmm.setGlobalShutdown(insuranceFund.address);
  await baycAmm.setCounterParty(clearingHouse.address);
  await insuranceFund.addAmm(baycAmm.address);
  await doodleAmm.setGlobalShutdown(insuranceFund.address);
  await doodleAmm.setCounterParty(clearingHouse.address);
  await insuranceFund.addAmm(doodleAmm.address);
  await insuranceFund.setBeneficiary(clearingHouse.address);
  await tollPool.addFeeToken(deployConfig.weth);

  await baycAmm.setCap(
    deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].properties.maxHoldingBaseAsset,
    deployConfig.legacyAmmConfigMap[AmmInstanceName.BAYCETH].properties.openInterestNotionalCap
  );

  await doodleAmm.setCap(
    deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].properties.maxHoldingBaseAsset,
    deployConfig.legacyAmmConfigMap[AmmInstanceName.DOODLEETH].properties.openInterestNotionalCap
  );

  await baycAmm.setOpen(true);
  await doodleAmm.setOpen(true);

  const liquidator = await deployLiquidator(ledger, clearingHouse.address);

  await clearingHouse.setBackstopLiquidityProvider(liquidator.address, true);

  const contracts: ContractAddresses = {
    insuranceFund: insuranceFund.address,
    clearingHouse: clearingHouse.address,
    clearingHouseViewer: clearingHouseViewer.address,
    amm: {
      [AmmInstanceName.BAYCETH]: baycAmm.address,
      [AmmInstanceName.DOODLEETH]: doodleAmm.address,
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
