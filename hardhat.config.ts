import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { HardhatUserConfig } from "hardhat/types";

import "@typechain/hardhat";
// import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-waffle";
import "@openzeppelin/hardhat-upgrades";
import "@nomiclabs/hardhat-etherscan";
import { task } from "hardhat/config";
import "@graphprotocol/hardhat-graph";
import "hardhat-contract-sizer";

// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

task("deploy", "Deploys the passed contract")
  .addParam("contractName", "The name of the contract")
  .setAction(async (taskArgs, hre) => {
    const { contractName } = taskArgs;

    await hre.run("compile");

    const address = await deploy(hre, contractName);

    await hre.run("graph", { contractName, address });
  });

const deploy = async (hre: any, contractName: string): Promise<string> => {
  const contractArtifacts = await hre.ethers.getContractFactory(contractName);
  const contract = await contractArtifacts.deploy();

  await contract.deployed();

  return contract.address;
};

const INFURA_API_KEY = process.env.INFURA_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY! || "0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

const config = {
  solidity: {
    compilers: [
      {
        version: "0.8.9",
        settings: {
          optimizer: { enabled: true, runs: 100 },
        },
      },
    ],
  },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    arbitrum_rinkeby: {
      url: "https://rinkeby.arbitrum.io/rpc",
    },
    arbitrum: {
      url: "https://arb-mainnet.g.alchemy.com/v2/XY2OuQR0tqpTi-WY_yljupj20HFlfVok",
      accounts: [PRIVATE_KEY],
    },
    goerli: {
      url: `https://goerli.infura.io/v3/${INFURA_API_KEY}`,
      accounts: [PRIVATE_KEY],
    },
    sepolia: {
      url: `https://sepolia.infura.io/v3/${INFURA_API_KEY}`,
      accounts: [PRIVATE_KEY],
    },
  },
  subgraph: {
    name: "tribe3-perp",
  },
  paths: {
    subgraph: "tribe3-perp-subgraph",
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  mocha: {
    timeout: 80000,
  },
  contractSizer: {
    alphaSort: true,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
    only: [],
  },
};

export default config;
