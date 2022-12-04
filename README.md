<!-- If you want badge for Github Actions & NPM version, uncomment these! -->
[![Hardhat Tests](https://github.com/Tribe3-xyz/tribe3-smart-contract/actions/workflows/hardhat-test.yml/badge.svg)](https://github.com/Tribe3-xyz/tribe3-smart-contract/actions/workflows/hardhat-test.yml)
[![Foundry Tests](https://github.com/Tribe3-xyz/tribe3-smart-contract/actions/workflows/foundry-test.yml/badge.svg)](https://github.com/Tribe3-xyz/tribe3-smart-contract/actions/workflows/foundry-test.yml)
<!-- [![Integration Tests](https://github.com/mattstam/solidity-template/actions/workflows/integration-test.yaml/badge.svg)](https://github.com/mattstam/solidity-template/actions/workflows/integration-test.yaml)
[![Slither Static Analysis](https://github.com/mattstam/solidity-template/actions/workflows/slither.yaml/badge.svg)](https://github.com/mattstam/solidity-template/actions/workflows/slither.yaml)
[![Lint](https://github.com/mattstam/solidity-template/actions/workflows/lint.yaml/badge.svg)](https://github.com/mattstam/solidity-template/actions/workflows/lint.yaml)
[![NPM Version](https://img.shields.io/npm/v/@mattstam/solidity-template/latest.svg)](https://www.npmjs.com/package/@mattstam/solidity-template/v/latest) -->
# Tribe3 Smart Contract

This project demonstrates a basic Hardhat use case. It comes with a sample contract, a test for that contract, a sample script that deploys that contract, and an example of a task implementation, which simply lists the available accounts.

Try running some of the following tasks:

```shell
npx hardhat accounts
npx hardhat compile
npx hardhat clean
npx hardhat test
npx hardhat node
node scripts/sample-script.js
npx hardhat help
```

# Prequisites:
1. Run `yarn` or `npm install` to install the dependencies
2. Run `yarn graph-codegen` or `npm run graph-codegen`

# Run matchstick test:
1. Just run `yarn graph-test` or `npm run graph-test`

# Run hardhat tests:
1. Just run `npx hardhat test`

# How to index the contract on localhost network:
1. You will need 3 terminal windows/tabs open
2. In one of the windows/tabs run `yarn hardhat-local` or `npm run hardhat-local`
3. In another window/tab run `yarn graph-local` or `npm run graph-local`
4. Deploy the contracts:
  - `npx hardhat run ./scripts/full-deploy-hardhat.ts`
 
5. Build the subgraph by executing `yarn graph-build --network localhost` or `npm run graph-build --network localhost`. 

*NOTE: The `--network` option will tell the `build` command to get the latest configurations (address and startBlock) for the `localhost` network from the `networks.json` config file and update the `subgraph.yaml` file. (Soon this step will be redundant, because the network option will be directly added to the deploy command)*

6. Create a subgraph on the local hardhat node by running `yarn create-local` or `npm run create-local`
7. Deploy the subgraph on the local hardhat node by running `yarn deploy-local` or `npm run deploy-local`

*NOTE: Since graph-cli `0.32.0`, the `--network` option is available for the `deloy` command, so now you can run the `deploy-local` script with `--network localhost` options and skip step 5*

8. Now you can interact with the contract by running the scripts in the `scripts` directory with `npx hardhat run <script>`:
  - `scripts/open-positions.ts` - will open/close some positions to generate some liquidatable positions
  - `scripts/liquidator.ts` - will get open positions from graph and check their margin ratio then liquidate them
 
9. You can query the subgraph by opening the following url in your browser `http://127.0.0.1:8000/subgraphs/name/tribe3-perp/graphql`
