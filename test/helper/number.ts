import { BigNumber, utils } from "ethers";

export const DEFAULT_TOKEN_DECIMALS = 18;
export const ONE_DAY = 60 * 60 * 24;

// noinspection JSMethodCanBeStatic
export function toFullDigitBN(val: number | string, decimals = DEFAULT_TOKEN_DECIMALS): BigNumber {
  return utils.parseUnits(val.toString(), decimals);
}
