import { readFileSync, writeFileSync } from "fs";

const filePath = "./utils/network/addresses.json";

export interface ContractNetwork {
  amm: { address: string };
  insuranceFund: { address: string };
  quoteToken: { address: string };
  priceFeed: { address: string };
  clearingHouse: { address: string };
  liquidator: { address: string };
}

export function getNetwork(networkName: string): ContractNetwork {
  const data = readFileSync(filePath);
  const networks = JSON.parse(data.toString());
  return networks[networkName];
}

export function setNetwork(networkName: string, network: ContractNetwork): Boolean {
  try {
    const data = readFileSync(filePath);
    let networks = JSON.parse(data.toString());
    networks[networkName] = network;
    writeFileSync(filePath, JSON.stringify(networks));
    return true;
  } catch (e) {
    return false;
  }
}
