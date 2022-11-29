import { readFileSync, writeFileSync } from "fs";

const filePath = "./publish/addresses/addresses.json";

export interface ContractAddresses {
  clearingHouse: string;
  clearingHouseViewer: string;
  amm: Record<string, string>;
  ammReader: string;
  insuranceFund: string;
  tollPool: string;
  liquidator: string;
}

export function getAddresses(networkName: string): ContractAddresses {
  const data = readFileSync(filePath);
  const networks = JSON.parse(data.toString());
  return networks[networkName];
}

export function saveAddresses(networkName: string, network: ContractAddresses): Boolean {
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
