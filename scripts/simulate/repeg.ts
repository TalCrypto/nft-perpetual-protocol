import { ethers, network, upgrades } from "hardhat";
import { getAddresses } from "../../publish/addresses";
import { formatEther, parseEther } from "ethers/lib/utils";
import { BigNumber, constants } from "ethers";
import { Amm } from "../../typechain-types";
const B_ONE = ethers.utils.parseEther("1");
const maycTraders = [
  "0x1b0f13884ac076ac6013ec5ef947222b933fd410",
  "0x5c470ce5ba7ef24cf48c08876fb75bb34fae75db",
  "0xfb71b820f5c040f5b2dab2564ebd3feae2124928",
  "0xba227bdeef088685941408142abfcb922a27ea6a",
  "0x4b0d4e2369f578878ef0aa122e30f108a24100ab",
  "0xe32afd57f507836c0a5423851f67bc9ac1139b62",
  "0xd5102725cc00421854dd616a2d8769ce36017315",
  "0x7a6883f1438f4d74d756f2be3f63b514d64bf361",
  "0x9482c72cb018ee03d8c23395038b510ed4e6040c",
  "0x80445399b0b66c95a8f1baecaebe3e49a0df649e",
  "0x94824e3889f36dcf3b077be81c06b3553abf9c15",
  "0xc2349b492b6a9d47f471a55e803e83695b4c593b",
  "0x93616fa273266373ca0a8d2e66ddc6037516a2c8",
  "0x6d48e27b29312041cace223d9a02fa1c4f2c376e",
  "0x77863da34ca9d4872b86fb9a4973792ca6a11e16",
  "0x7f9b8c7bd797503af08e48ac52e19b0cd5ae9ac4",
  "0x57dbccbb81b9cecc80a47c5cb6158c3717e2c831",
  "0x05c03cac4aec329ac3f9593291c680f853afb666",
  "0xdc126049e2046afb9de50cd5dc498d7bcdc93e0a",
  "0x08627cddb9710dce14c3949ce41278514a82253d",
  "0x0341e5d01989cb91942997beaad3c8e904ea101e",
  "0x88812b4f3a593bcb6faee35fea189af677d6d00d",
  "0xda23ab0b2636c3f9806a868278d73aef2439ab60",
  "0x6f65c146839f5f4c21bf87a374e1e925e183bb60",
  "0x8bfe553ab794615b6009fba5f077509a453dcbfd",
  "0x931385cb7beeef891184215b7a92763181178617",
  "0x629898596dc5f16c31af69382ab7985654332e78",
  "0x571b8db726c2a29d237f88c9efeb896290bf395b",
  "0x2bc0dc8d0d2af7488e695e69213830a149bbb443",
  "0x96fd61202a698ee3eac21e247a6b209ea5ffeb91",
  "0xc64abf95930767b42f10848f4708bd68daed59ee",
  "0x8ace9857b8e4af3c477ada96b3844aa4acf94d22",
  "0xcc9118a2356aac1dff87cdb4514a9fef9bbe1236",
  "0xc89f42adad463cad50507a484e9c581cd7708916",
  "0x1d394761dea3fa4311d47549dbbe8f09f95b7625",
  "0x0adf61f8aed5e794018e3de8adc6ae57398f3343",
  "0xc983336e1cc2f2a82adae156b645f1a053d40b7b",
  "0x3f4c49b26c157188e60806d017686e401969fed2",
];

const quoteReserveSlot = "0xA0";
const baseReserveSlot = "0xA1";

async function main() {
  const addresses = getAddresses("arbitrum");
  const ammAddress = addresses.amm.MAYCETH ?? "";
  await simulateRepegForAMM(ammAddress);
}

async function simulateRepegForAMM(ammAddress: string) {
  const amm = await ethers.getContractAt("Amm", ammAddress);

  const spotPrice = await amm.getSpotPrice();
  const baseReserve = await amm.baseAssetReserve();
  const quoteReserve = await amm.quoteAssetReserve();
  const targetPrice = await amm.getUnderlyingPrice();
  const positionSize = await amm.getBaseAssetDelta();

  console.log("reserves before", formatEther(quoteReserve), formatEther(baseReserve));

  const { newQuoteAssetReserve, newBaseAssetReserve } = calcReservesAfterRepeg(spotPrice, baseReserve, targetPrice, positionSize);

  const repegCost = calcRevenueForAdjustReserves(quoteReserve, baseReserve, positionSize, newQuoteAssetReserve, newBaseAssetReserve).mul(
    BigNumber.from(-1)
  );

  console.log("repeg cost", formatEther(repegCost));

  const badDebtBefore = await calcBadDebt(amm);
  console.log("bad debt before", formatEther(badDebtBefore));

  await ethers.provider.send("hardhat_setStorageAt", [
    ammAddress,
    quoteReserveSlot,
    ethers.utils.hexlify(ethers.utils.zeroPad(newQuoteAssetReserve.toHexString(), 32)),
  ]);
  await ethers.provider.send("hardhat_setStorageAt", [
    ammAddress,
    baseReserveSlot,
    ethers.utils.hexlify(ethers.utils.zeroPad(newBaseAssetReserve.toHexString(), 32)),
  ]);
  const q = await amm.quoteAssetReserve();
  const b = await amm.baseAssetReserve();
  console.log("reserves after", formatEther(q), formatEther(b));

  // bad debt = collateral - vault = collateral - (vault before + repegCost) = collateral - vault before - repegCost = bade debt after - repegCost
  const badDebtAfter = (await calcBadDebt(amm)).sub(repegCost);
  console.log("bad debt after", formatEther(badDebtAfter));
  console.log("decrease in bad debt", formatEther(badDebtBefore.sub(badDebtAfter)));
}

async function calcBadDebt(amm: Amm) {
  const addresses = getAddresses("arbitrum");
  const chViewer = await ethers.getContractAt("ClearingHouseViewer", addresses.clearingHouseViewer);
  const ch = await ethers.getContractAt("ClearingHouse", addresses.clearingHouse);
  const vault = await ch.vaults(amm.address);
  const positionSize = await amm.getBaseAssetDelta();
  const absNetNotional = await amm.getBasePrice(positionSize.isNegative() ? 1 : 0, positionSize.abs());
  const settlementPrice = absNetNotional.mul(B_ONE).div(positionSize.abs());
  console.log("settlementPrice", formatEther(settlementPrice));
  const positionInfoPromise = maycTraders.map((trader) => chViewer.getTraderPositionInfo(amm.address, trader));
  const positionInfos = await Promise.all(positionInfoPromise);
  const unrealizedPnlSettleArray = positionInfos.map((info) => {
    const signedOpenNotional = info.openNotional.mul(BigNumber.from((-1) ** (info.positionSize.isNegative() ? 1 : 0)));
    const signedNotionalSettle = settlementPrice.mul(info.positionSize).div(B_ONE);
    return signedNotionalSettle.sub(signedOpenNotional);
  });
  const collateralSettle = positionInfos.map((info, index) => {
    return info.openMargin.add(info.fundingPayment).add(unrealizedPnlSettleArray[index]);
  });
  const totalCollateralSettle = collateralSettle.reduce((val, collateral) => {
    if (collateral.isNegative()) {
      return val;
    } else {
      return val.add(collateral);
    }
  }, constants.Zero);
  const badDebt = totalCollateralSettle.sub(vault);
  return badDebt;
}

function calcReservesAfterRepeg(spotPrice: BigNumber, baseAssetReserve: BigNumber, targetPrice: BigNumber, positionSize: BigNumber) {
  let newQuoteAssetReserve = baseAssetReserve
    .mul(ethers.utils.parseEther(Math.sqrt(Number(ethers.utils.formatEther(spotPrice.mul(targetPrice).div(B_ONE)))).toString()))
    .div(B_ONE);
  let newBaseAssetReserve = baseAssetReserve
    .mul(ethers.utils.parseEther(Math.sqrt(Number(ethers.utils.formatEther(spotPrice.mul(B_ONE).div(targetPrice)))).toString()))
    .div(B_ONE);
  if (positionSize.isNegative() && newBaseAssetReserve.sub(positionSize.abs()).isNegative()) {
    newQuoteAssetReserve = baseAssetReserve.mul(targetPrice).div(B_ONE);
    newBaseAssetReserve = baseAssetReserve;
  }
  return { newQuoteAssetReserve, newBaseAssetReserve };
}

function calcRevenueForAdjustReserves(
  quoteAssetReserve: BigNumber,
  baseAssetReserve: BigNumber,
  positionSize: BigNumber,
  newQuoteAssetReserve: BigNumber,
  newBaseAssetReserve: BigNumber
) {
  return quoteAssetReserve
    .mul(positionSize)
    .div(baseAssetReserve.add(positionSize))
    .sub(newQuoteAssetReserve.mul(positionSize).div(newBaseAssetReserve.add(positionSize)));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
