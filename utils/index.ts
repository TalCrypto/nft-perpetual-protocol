import { ethers } from "hardhat";

export async function moveToNextBlocks(number: number): Promise<void> {
  await ethers.provider.send("hardhat_mine", [`0x${number.toString(16)}`]);
}

export async function forward(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  const movedBlocks = seconds / 15 < 1 ? 1 : seconds / 15;
  await moveToNextBlocks(movedBlocks);
}
