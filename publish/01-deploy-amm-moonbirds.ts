import { ethers, network } from "hardhat";
import { getAddresses, saveAddresses } from "./addresses";
import { LedgerSigner } from "@ethersproject/hardware-wallets";
import { deployProxyAmm } from "../utils/contract";
import { DeployConfig } from "./DeployConfig";
import { AmmInstanceName, PriceFeedKey } from "./Constants";

async function main() {
  // const ledger = await new LedgerSigner(ethers.provider, "hid", "m/44'/60'/0'/0");
  // console.log("deployer: ", await ledger.getAddress());

  const accounts = await ethers.getSigners();
  const ledger = accounts[0];
  console.log("deployer: ", await ledger.getAddress());

  const deployConfig = new DeployConfig(network.name);
  const addresses = getAddresses(network.name);

  console.log("deploying MOONBIRDS_AMM");
  const moonBirdsAmm = await deployProxyAmm({
    signer: ledger,
    quoteAssetReserve: deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].deployArgs.quoteAssetReserve,
    baseAssetReserve: deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].deployArgs.baseAssetReserve,
    tradeLimitRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].deployArgs.tradeLimitRatio,
    fundingPeriod: deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].deployArgs.fundingPeriod,
    fluctuation: deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].deployArgs.fluctuation,
    priceFeedKey: deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].deployArgs.priceFeedKey,
    priceFeedAddress: deployConfig.priceFeed,
    tollRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].deployArgs.tollRatio,
    spreadRatio: deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].deployArgs.spreadRatio,
    quoteTokenAddress: deployConfig.weth,
  });
  console.log("deployed MOONBIRDS_AMM address: ", moonBirdsAmm.address);

  await moonBirdsAmm.setGlobalShutdown(addresses.insuranceFund);
  await moonBirdsAmm.setCounterParty(addresses.clearingHouse);

  const InsuranceFund = await ethers.getContractFactory("InsuranceFund");
  const insuranceFund = await InsuranceFund.attach(addresses.insuranceFund);
  await insuranceFund.addAmm(moonBirdsAmm.address);

  await moonBirdsAmm.setCap(
    deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].properties.maxHoldingBaseAsset,
    deployConfig.legacyAmmConfigMap[AmmInstanceName.MOONBIRDSETH].properties.openInterestNotionalCap
  );

  await moonBirdsAmm.setOpen(true);

  addresses.amm[AmmInstanceName.MOONBIRDSETH] = moonBirdsAmm.address;

  saveAddresses(network.name, addresses);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
