import { ethers, network } from "hardhat";
import { getAddresses } from "../../publish/addresses";
import { formatEther, parseEther } from "ethers/lib/utils";

async function main() {
  const addresses = getAddresses("arbitrum");
  const maycAmmAddress = addresses.amm.MAYCETH ?? "";
  const ch = await ethers.getContractAt("ClearingHouse", addresses.clearingHouse);
  const chViewer = await ethers.getContractAt("ClearingHouseViewer", addresses.clearingHouseViewer);
  const IF = await ethers.getContractAt("InsuranceFund", addresses.insuranceFund);
  const stakingPool = await ethers.getContractAt("ETHStakingPool", addresses.ethStakingPool);
  const user1 = await ethers.getImpersonatedSigner("0x1b0f13884ac076ac6013ec5ef947222b933fd410");
  const user2 = await ethers.getImpersonatedSigner("0x5c470ce5ba7ef24cf48c08876fb75bb34fae75db");
  const user3 = await ethers.getImpersonatedSigner("0xfb71b820f5c040f5b2dab2564ebd3feae2124928");
  const user4 = await ethers.getImpersonatedSigner("0x4b0d4e2369f578878ef0aa122e30f108a24100ab");
  const freeCollateral1 = await chViewer.getFreeCollateral(maycAmmAddress, user1.address);
  const freeCollateral2 = await chViewer.getFreeCollateral(maycAmmAddress, user2.address);
  const freeCollateral3 = await chViewer.getFreeCollateral(maycAmmAddress, user3.address);
  const freeCollateral4 = await chViewer.getFreeCollateral(maycAmmAddress, user4.address);
  const total = freeCollateral1.add(freeCollateral2).add(freeCollateral3).add(freeCollateral4);

  console.log(`${user1.address}'s withdrawal`, formatEther(freeCollateral1));
  console.log(`${user2.address}'s withdrawal`, formatEther(freeCollateral2));
  console.log(`${user3.address}'s withdrawal`, formatEther(freeCollateral3));
  console.log(`${user4.address}'s withdrawal`, formatEther(freeCollateral4));
  console.log("total amount to be withdrawn", formatEther(total));
  const maycVault = await ch.vaults(maycAmmAddress);
  const IFBudget = await IF.budgetsAllocated(maycAmmAddress);
  const stakingReward = await stakingPool.calculateTotalReward();
  console.log("vault before ", formatEther(maycVault));
  console.log("IF budget before", formatEther(IFBudget));
  console.log("staking reward before", formatEther(stakingReward));
  console.log("shortage of vault", formatEther(maycVault.sub(total)));
  // staking reward is used to fill the shortage first
  // and then IF is used
  // and then staking pool principal is used
  console.log("user1, 2,3, 4 withdraw their free collateral");
  await ch.connect(user1).removeMargin(maycAmmAddress, freeCollateral1);
  await ch.connect(user2).removeMargin(maycAmmAddress, freeCollateral2);
  await ch.connect(user3).removeMargin(maycAmmAddress, freeCollateral3);
  await ch.connect(user4).removeMargin(maycAmmAddress, freeCollateral4);
  const maycVault2 = await ch.vaults(maycAmmAddress);
  const IFBudget2 = await IF.budgetsAllocated(maycAmmAddress);
  const stakingReward2 = await stakingPool.calculateTotalReward();
  console.log("vault after ", formatEther(maycVault2));
  console.log("IF budget after", formatEther(IFBudget2));
  console.log("staking reward after", formatEther(stakingReward2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
