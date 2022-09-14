import { ethers } from "hardhat";

function toBytes32(str: string): string {
  const paddingLen = 32 - str.length;
  const hex = ethers.utils.formatBytes32String(str);
  return hex + "00".repeat(paddingLen);
}

async function main() {
  // const ClearingHouse = await ethers.getContractFactory("ClearingHouse");
  // const clearingHouse = await ClearingHouse.attach("0x3355C1a190Dec974a6Effd55a150449b7b9887b3");

  // const Amm = await ethers.getContractFactory("Amm");
  // const amm = await Amm.attach("0x04557bdBBa19ECD484c9B8219ba1dFC81be6c51f");

  // console.log("clearingHouse fee", ethers.utils.formatEther(await clearingHouse.totalFees("0x76c4BFd2E8Bf127f77adb986A17c7BE1f63eE103")));
  // console.log("amm adjustable", await amm.adjustable());
  // console.log("underlying price", ethers.utils.formatEther(await amm.getUnderlyingPrice()));
  // console.log("spot price", ethers.utils.formatEther(await amm.getSpotPrice()));
  // console.log("isOverSpreadLimit", await amm.isOverSpreadLimit());
  // console.log("isOpen", await amm.open());
  // const res = await amm.getFormulaicRepegResult(ethers.utils.parseEther("101"), false);
  // console.log(res);
  const ClearingHouse = await ethers.getContractFactory("ClearingHouse");
  const clearing = await ClearingHouse.attach("0x4b9EA0D9bC9997eb2CD0c1C1C83F0AFdAF99641C");
  const res = await clearing.getLatestCumulativePremiumFraction("0x420D88132aCdf362608f5E877bDe42a8A1587289");
  const info = await clearing.getPosition("0x420D88132aCdf362608f5E877bDe42a8A1587289", "0xDce3D0dD6D7556597dAa334da7942f5268628DCb");
  const marginRatio = await clearing.getMarginRatio(
    "0x420D88132aCdf362608f5E877bDe42a8A1587289",
    "0xED673572e139C190f31A60D9eF0dFAF500CcF165"
  );
  console.log(ethers.utils.formatEther(marginRatio));
  // console.log(info);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
