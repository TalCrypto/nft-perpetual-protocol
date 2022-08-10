import { utils, BigNumber } from "ethers";
import { AmmInstanceName, PriceFeedKey } from "./Constants";

const DEFAULT_AMM_TRADE_LIMIT_RATIO = utils.parseEther("0.9"); // 90% trading limit ratio
const DEFAULT_AMM_FUNDING_PERIOD = BigNumber.from(3600); // 1 hour
const DEFAULT_AMM_FLUCTUATION = utils.parseEther("0.012"); // 1.2%
const DEFAULT_AMM_TOLL_RATIO = utils.parseEther("0"); // 0.0%
const DEFAULT_AMM_SPREAD_RATIO = utils.parseEther("0.001"); // 0.1%

// amm
export interface AmmDeployArgs {
  quoteAssetReserve: BigNumber;
  baseAssetReserve: BigNumber;
  tradeLimitRatio: BigNumber;
  fundingPeriod: BigNumber;
  fluctuation: BigNumber;
  priceFeedKey: string;
  tollRatio: BigNumber;
  spreadRatio: BigNumber;
}

interface AmmProperties {
  maxHoldingBaseAsset: BigNumber;
  openInterestNotionalCap: BigNumber;
}

export type AmmConfig = { name: AmmInstanceName; deployArgs: AmmDeployArgs; properties: AmmProperties };
export type AmmConfigMap = Record<string, AmmConfig>;

const BAYC_AMM: AmmConfig = {
  name: AmmInstanceName.BAYCETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("1000"),
    baseAssetReserve: utils.parseEther("10"), // 500 BTC
    tradeLimitRatio: utils.parseEther("0.9"), // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 1 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.BAYC,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.1%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("0.2"), // 0.2 BAYC,
    openInterestNotionalCap: utils.parseEther("20"), // 20 ETH
  },
};

const DOODLES_AMM: AmmConfig = {
  name: AmmInstanceName.DOODLESETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("1000"),
    baseAssetReserve: utils.parseEther("100"),
    tradeLimitRatio: utils.parseEther("0.9"), // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 1 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.DOODLES,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.1%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("2"), // 2 DOODLES,
    openInterestNotionalCap: utils.parseEther("20"), // 20 ETH
  },
};

const MOONBIRDS_AMM: AmmConfig = {
  name: AmmInstanceName.MOONBIRDSETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("1000"),
    baseAssetReserve: utils.parseEther("100"),
    tradeLimitRatio: utils.parseEther("0.9"), // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 1 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.MOONBIRDS,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.1%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("2"),
    openInterestNotionalCap: utils.parseEther("20"),
  },
};

export function makeAmmConfig(
  name: AmmInstanceName,
  priceFeedKey: string,
  baseAssetReserve: BigNumber,
  maxHoldingBaseAsset: BigNumber,
  openInterestNotionalCap: BigNumber,
  restDeployArgs?: Partial<AmmDeployArgs>
): AmmConfig {
  const config: AmmConfig = {
    name,
    deployArgs: {
      // base * price
      // exact quote reserve amount will be overriden by the script based on the base reserve and the price upon deployment
      baseAssetReserve,
      quoteAssetReserve: BigNumber.from(0),
      tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO,
      fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD,
      fluctuation: DEFAULT_AMM_FLUCTUATION,
      priceFeedKey: priceFeedKey,
      tollRatio: DEFAULT_AMM_TOLL_RATIO,
      spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.1%
    },
    properties: {
      maxHoldingBaseAsset,
      openInterestNotionalCap,
    },
  };

  if (restDeployArgs) {
    config.deployArgs = {
      ...config.deployArgs,
      ...restDeployArgs,
    };
  }

  return config;
}

export class DeployConfig {
  // stage
  readonly network: string;
  // deploy
  readonly confirmations: number;

  // chainlink
  readonly priceFeed: string;

  // weth address
  readonly weth: string;

  // clearing house
  readonly initMarginRequirement = utils.parseEther("0.2"); // 20% - 5x
  readonly maintenanceMarginRequirement = utils.parseEther("0.125"); // 12.5% - 8x
  readonly partialLiquidationRatio = utils.parseEther("0.125");
  readonly liquidationFeeRatio = utils.parseEther("0.0125"); // 1.25%

  // amm
  readonly legacyAmmConfigMap: Record<string, AmmConfig> = {
    [AmmInstanceName.BAYCETH]: BAYC_AMM,
    [AmmInstanceName.DOODLESETH]: DOODLES_AMM,
    [AmmInstanceName.MOONBIRDSETH]: MOONBIRDS_AMM,
  };

  constructor(network: string) {
    this.network = network;
    switch (network) {
      case "arbitrum":
        this.confirmations = 5;
        // fake address
        this.priceFeed = "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c";
        // fake address
        this.weth = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
        break;
      case "rinkeby":
        this.confirmations = 5;
        // fake address
        this.priceFeed = "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c";
        // fake address
        this.weth = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
        break;
      case "test":
        this.confirmations = 1;
        // fake address
        this.priceFeed = "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c";
        // fake address
        this.weth = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
        break;
      default:
        throw new Error(`not supported network=${network}`);
    }
  }
}
