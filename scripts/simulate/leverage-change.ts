import { ethers } from "hardhat";
import { ContractAddresses, getAddresses } from "../../publish/addresses";
import { getAmmTraders } from "../../utils/subgraph";
import { toFullDigitBN } from "../../utils/number";
import { formatEther, parseEther } from "ethers/lib/utils";

async function simulateLeverageChangeFor(ammName: string, addresses: ContractAddresses, ammAddr?: string) {
  if (!ammAddr) {
    throw new Error("amm address is not defined");
  }
  console.log(`=========================${ammName}=========================`);
  const traders = await getAmmTraders(ammAddr);
  console.log("number of traders: ", traders.length);
  const ch = await ethers.getContractAt("ClearingHouse", addresses.clearingHouse);
  const liquidator = await ethers.getContractAt("Liquidator", addresses.liquidator);
  const amm = await ethers.getContractAt("Amm", ammAddr);
  const ownerAddress = await amm.owner();
  const owner = await ethers.getImpersonatedSigner(ownerAddress);
  await ethers.provider.send("hardhat_setBalance", [ownerAddress, parseEther("0.1").toHexString().replace("0x0", "0x")]);
  await amm.connect(owner).setInitMarginRatio(toFullDigitBN(0.2));
  await amm.connect(owner).setMaintenanceMarginRatio(toFullDigitBN(0.1));
  const mmRatio = await amm.maintenanceMarginRatio();
  const imRatio = await amm.initMarginRatio();
  console.log("maintenance margin ratio: ", formatEther(mmRatio));
  console.log("init margin ratio: ", formatEther(imRatio));
  const liquidatables = await liquidator.isLiquidatable(ammAddr, traders);
  const underwaterTraders = traders.filter((trader, index) => liquidatables[index]);
  console.log("number of underwater traders due to change of ratios: ", underwaterTraders.length);
  if (underwaterTraders.length > 0) {
    console.log(underwaterTraders);
    let candidates = underwaterTraders;
    while (true) {
      const target = candidates[0];
      console.log("liquidating: ", target);
      await ch.liquidate(ammAddr, target);
      const possibilities = await liquidator.isLiquidatable(ammAddr, traders);
      candidates = traders.filter((trader, index) => possibilities[index]);
      console.log("number of underwater traders after above liquidation: ", candidates.length);
      if (candidates.length === 0) {
        break;
      }
    }
  }
}

async function main() {
  const addresses = getAddresses("arbitrum");
  await simulateLeverageChangeFor("bayc", addresses, addresses.amm.BAYCETH);
  await simulateLeverageChangeFor("mayc", addresses, addresses.amm.MAYCETH);
  await simulateLeverageChangeFor("azuki", addresses, addresses.amm.AZUKIETH);
  await simulateLeverageChangeFor("wpunks", addresses, addresses.amm.WRAPPEDCRYPTOPUNKSETH);
  await simulateLeverageChangeFor("degods", addresses, addresses.amm.DEGODSETH);
  await simulateLeverageChangeFor("captainz", addresses, addresses.amm.THECAPTAINZETH);
  await simulateLeverageChangeFor("milady", addresses, addresses.amm.MILADYETH);
  await simulateLeverageChangeFor("ppg", addresses, addresses.amm.PUDGYPENGUINSETH);
}

main();
