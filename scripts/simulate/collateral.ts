import { ethers, network, upgrades } from "hardhat";
import { getAddresses } from "../../publish/addresses";
import { formatEther, parseEther } from "ethers/lib/utils";
import { BigNumber, constants } from "ethers";
import { Amm } from "../../typechain-types";
const B_ONE = ethers.utils.parseEther("1");
const baycTraders = [
  "0x00e065f1a996da341e8a3afddd481cdd40d2fd11",
  "0x05c03cac4aec329ac3f9593291c680f853afb666",
  "0x05fe5507da021d3df44d7d28519e69c77c5cf879",
  "0x07188478c7b3e7ce94a45eb6dcfdc366d0700aa8",
  "0x08627cddb9710dce14c3949ce41278514a82253d",
  "0x11d67fa925877813b744abc0917900c2b1d6eb81",
  "0x14af1e6e4dc1ef495af34fa9ba79529ff811d1e4",
  "0x166c87dbd9481c0d34d49fb0e4c546d94d7adef1",
  "0x171c3e910aa78aa1be20b78e01bb2eeb454a0fed",
  "0x18216fb0b1f8fa9073e3a50234d23db2b7c994db",
  "0x18f1300cad4e3fd3f37a8e2c2aefe318b5a02b11",
  "0x196f239229aae65883802b5bb512e17084147ff6",
  "0x1b0f13884ac076ac6013ec5ef947222b933fd410",
  "0x1b5d86fdd629498f5ef872229e88d730c7ba5027",
  "0x1f26bc4210f00b3109f5de60ac8d3ad8e6f55eb1",
  "0x23c14e77e980e8d90851c72678ec5f4255af7874",
  "0x2583336e58ceb06eb4864e9021f091057eeae3ab",
  "0x26c9fc612b005781127246bbc5dc39f823e3106e",
  "0x2afd616faa15aeb869a569c5640641f2859e53b3",
  "0x2bc0dc8d0d2af7488e695e69213830a149bbb443",
  "0x2eff9bc25386263c9184fd9db2464cd522c0adb3",
  "0x35e4f4126a29fa93fc7037b0ff8057282c374303",
  "0x3f4c49b26c157188e60806d017686e401969fed2",
  "0x4b0d4e2369f578878ef0aa122e30f108a24100ab",
  "0x51aceb6e60635c770b97025596080f588b9bb7ba",
  "0x5c470ce5ba7ef24cf48c08876fb75bb34fae75db",
  "0x5d680598432c27dbac852abe94395823a83a7592",
  "0x5e37b7e461beace6f0049ee50f86aac66ec78344",
  "0x617cf05445f9750264498ed4ea4faeda19654e66",
  "0x6b73375cd1129a5e6f945fd522549a3869b44f5b",
  "0x6f65c146839f5f4c21bf87a374e1e925e183bb60",
  "0x74795c9cd03e8c92efa746028b1fd7088cfc443e",
  "0x7a6883f1438f4d74d756f2be3f63b514d64bf361",
  "0x8874174a2366668d54fea6343f71709389563c8a",
  "0x88812b4f3a593bcb6faee35fea189af677d6d00d",
  "0x8bfe553ab794615b6009fba5f077509a453dcbfd",
  "0x9171e359f585ba1097a40eadfbf35e23bdacf53e",
  "0x94824e3889f36dcf3b077be81c06b3553abf9c15",
  "0x9482c72cb018ee03d8c23395038b510ed4e6040c",
  "0x98e1c4e34ccded4760ef8da63bcccdf4a75b3c4b",
  "0x9da98cc8e38cef116e3db6c62e495a524400ba3e",
  "0xad468e8336182e2cec7022f3434f91227c33a723",
  "0xb8c99cf73b3fb4fa362f44ee10fd8dafae45d7f0",
  "0xba227bdeef088685941408142abfcb922a27ea6a",
  "0xc2349b492b6a9d47f471a55e803e83695b4c593b",
  "0xc32c97d0dc2f7deafe9973327a77c6df1470466c",
  "0xcae4ccfe670f8c2a4999f9dfaf44625110fce9e5",
  "0xcf8f67a8784dbd02f55ce036014f49ecb0e8a36b",
  "0xd31d839a569caa378b94e78fb2ea050ca2c2239b",
  "0xd5102725cc00421854dd616a2d8769ce36017315",
  "0xda23ab0b2636c3f9806a868278d73aef2439ab60",
  "0xdc126049e2046afb9de50cd5dc498d7bcdc93e0a",
  "0xf0b131a9eaa9e2c8f1d26d200d47bc1eda50fb66",
  "0xf5c9483756409107d7f118ee585c7f2aab02aa53",
  "0xfb71b820f5c040f5b2dab2564ebd3feae2124928",
  "0xfd6710604e00a6620cf3fd224c524db56ec0afe5",
];

const quoteReserveSlot = "0xA0";
const baseReserveSlot = "0xA1";

async function main() {
  const addresses = getAddresses("arbitrum");
  const ammAddress = addresses.amm.BAYCETH ?? "";
  await simulateRepegForAMM(ammAddress, baycTraders);
}

async function simulateRepegForAMM(ammAddress: string, traders: string[]) {
  const amm = await ethers.getContractAt("Amm", ammAddress);

  const spotPrice = await amm.getSpotPrice();
  const baseReserve = await amm.baseAssetReserve();
  const quoteReserve = await amm.quoteAssetReserve();
  const targetPrice = await amm.getUnderlyingPrice();
  const positionSize = await amm.getBaseAssetDelta();

  console.log("reserves before", formatEther(quoteReserve), formatEther(baseReserve));

  const [newQuoteAssetReserve, newBaseAssetReserve] = [
    quoteReserve.mul(parseEther("0.996")).div(B_ONE),
    baseReserve.mul(parseEther("0.996")).div(B_ONE),
  ];

  const kCost = calcRevenueForAdjustReserves(quoteReserve, baseReserve, positionSize, newQuoteAssetReserve, newBaseAssetReserve).mul(
    BigNumber.from(-1)
  );

  console.log("kCost", formatEther(kCost));

  const collateralBefore = await calcCollateral(amm, traders);
  console.log("collateral before", formatEther(collateralBefore));

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
  const collateralAfter = await calcCollateral(amm, traders);
  console.log("collateral after", formatEther(collateralAfter));
}

async function calcCollateral(amm: Amm, traders: string[]) {
  const addresses = getAddresses("arbitrum");
  const chViewer = await ethers.getContractAt("ClearingHouseViewer", addresses.clearingHouseViewer);

  const positionInfoPromise = traders.map((trader) => chViewer.getTraderPositionInfo(amm.address, trader));
  const positionInfos = await Promise.all(positionInfoPromise);
  return positionInfos.reduce((val, info) => {
    return val.add(info.margin);
  }, constants.Zero);
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
