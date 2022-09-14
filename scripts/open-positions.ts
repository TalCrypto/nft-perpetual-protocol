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

  const Amm = await ethers.getContractFactory("Amm");
  const amm = await Amm.attach(contracts.amm.address);

  const QuoteToken = await ethers.getContractFactory("ERC20Fake");
  const quoteToken = await QuoteToken.attach(contracts.quoteToken.address);

  await quoteToken.transfer(contracts.insuranceFund.address, toFullDigitBN(50000, +(await quoteToken.decimals())));

  for (let i = 1; i < 6; i++) {
    await quoteToken.transfer(accounts[i].address, toFullDigitBN(15, +(await quoteToken.decimals())));
    await quoteToken.connect(accounts[i]).approve(clearingHouse.address, toFullDigitBN(15, +(await quoteToken.decimals())));
  }
  for (let i = 1; i < 6; i++) {
    await clearingHouse
      .connect(accounts[i])
      .openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0), true);
    await forward(1);
  }
  await clearingHouse.connect(accounts[1]).closePosition(amm.address, toFullDigitBN(0));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
