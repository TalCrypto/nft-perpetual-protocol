import { queryTraders } from "../utils/graphql";
import { ethers, network } from "hardhat";
import { getNetwork } from "../utils/network";

async function main() {
  const accounts = await ethers.getSigners();
  const admin = accounts[0];
  const contracts = getNetwork(network.name);
  const data = await queryTraders(contracts.amm.address);
  console.log("query-result", data);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
