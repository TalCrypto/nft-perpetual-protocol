import { readFileSync, writeFileSync } from "fs";

const filePath = "./utils/network/addresses.json";

export async function getNetwork(networkName: string): Promise<Object> {
  try {
    const data = readFileSync(filePath);
    const networks = JSON.parse(data.toString());
    return networks[networkName];
  } catch {
    return {};
  }
}

export async function setNetwork(networkName: string, network: Object): Promise<Boolean> {
  try {
    const data = await readFileSync(filePath);
    let networks = JSON.parse(data.toString());
    networks[networkName] = network;
    writeFileSync(filePath, JSON.stringify(networks));
    return true;
  } catch (e) {
    return false;
  }
}
