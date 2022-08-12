import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { ethers, network } from "hardhat";
import { Side } from "../utils/contract";
import { getNetwork } from "../utils/network";
import { toFullDigitBN } from "../utils/number";

async function moveToNextBlocks(number: number): Promise<void> {
  await ethers.provider.send("hardhat_mine", [`0x${number.toString(16)}`]);
}

async function forward(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  const movedBlocks = seconds / 15 < 1 ? 1 : seconds / 15;
  await moveToNextBlocks(movedBlocks);
}

async function main() {
  const accounts = await ethers.getSigners();

  const contracts = getNetwork(network.name);

  const ClearingHouse = await ethers.getContractFactory("ClearingHouse");
  const clearingHouse = await ClearingHouse.attach(contracts.clearingHouse.address);

  await clearingHouse.setOperator(accounts[0].address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
