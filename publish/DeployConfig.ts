import { utils, BigNumber } from "ethers";
import { AmmInstanceName, PriceFeedKey } from "./Constants";

const DEFAULT_AMM_TRADE_LIMIT_RATIO = utils.parseEther("0.9"); // 90% trading limit ratio
const DEFAULT_AMM_FUNDING_PERIOD = BigNumber.from(10800); // 3 hour
const DEFAULT_AMM_FLUCTUATION = utils.parseEther("0.02"); // 2%
const DEFAULT_AMM_TOLL_RATIO = utils.parseEther("0.0006"); // 0.06%
const DEFAULT_AMM_SPREAD_RATIO = utils.parseEther("0.0024"); // 0.24%

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
    quoteAssetReserve: utils.parseEther("6000"),
    baseAssetReserve: utils.parseEther("82.22"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.BAYC,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("0"), // No cap
    openInterestNotionalCap: utils.parseEther("0"), // No cap
  },
};

const DOODLES_AMM: AmmConfig = {
  name: AmmInstanceName.DOODLESETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("428.57"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.DOODLES,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("0"), // No cap
    openInterestNotionalCap: utils.parseEther("0"), // No cap
  },
};

const AZUKI_AMM: AmmConfig = {
  name: AmmInstanceName.AZUKIETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("202.51"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.AZUKIETH,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("0"), // No cap
    openInterestNotionalCap: utils.parseEther("0"), // No cap
  },
};

const MOONBIRDS_AMM: AmmConfig = {
  name: AmmInstanceName.MOONBIRDSETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("387.00"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.MOONBIRDS,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("0"), // No cap
    openInterestNotionalCap: utils.parseEther("0"), // No cap
  },
};

const CLONEX_AMM: AmmConfig = {
  name: AmmInstanceName.CLONEXETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("560.51"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.CLONEX,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("0"), // No cap
    openInterestNotionalCap: utils.parseEther("0"), // No cap
  },
};

const CRYPTOPUNKS_AMM: AmmConfig = {
  name: AmmInstanceName.CRYPTOPUNKSETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("45.26"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.CRYPTOPUNKS,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("0"), // No cap
    openInterestNotionalCap: utils.parseEther("0"), // No cap
  },
};

const MEEBITS_AMM: AmmConfig = {
  name: AmmInstanceName.MEEBITSETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("912.78"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: PriceFeedKey.MEEBITS,
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
  properties: {
    maxHoldingBaseAsset: utils.parseEther("0"), // No cap
    openInterestNotionalCap: utils.parseEther("0"), // No cap
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
      spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
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
  readonly maintenanceMarginRequirement = utils.parseEther("0.1"); // 10% - 10x
  readonly partialLiquidationRatio = utils.parseEther("0.125");
  readonly liquidationFeeRatio = utils.parseEther("0.05"); // 5% - 1/2 of maintenance margin

  // amm
  readonly legacyAmmConfigMap: Record<string, AmmConfig> = {
    [AmmInstanceName.BAYCETH]: BAYC_AMM,
    [AmmInstanceName.AZUKIETH]: AZUKI_AMM,
    [AmmInstanceName.DOODLESETH]: DOODLES_AMM,
    [AmmInstanceName.MOONBIRDSETH]: MOONBIRDS_AMM,
    [AmmInstanceName.CLONEXETH]: CLONEX_AMM,
    [AmmInstanceName.CRYPTOPUNKSETH]: CRYPTOPUNKS_AMM,
    [AmmInstanceName.MEEBITSETH]: MEEBITS_AMM,
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
      case "goerli":
        this.confirmations = 5;
        // fake address
        this.priceFeed = "0xF8d5fd95EB2087E907bA6E78bf873F1A39c273Ed"; // For campaign only
        // fake address
        this.weth = "0x1DcD297530778f987e8DEEB07667E29Cd052bC50"; // Test WETH for campaign only
        break;
      case "rinkeby":
        this.confirmations = 5;
        // fake address
        this.priceFeed = "0x95eC14c7B17Ea5E533372e9d3aE547ecf9e5D0c8"; // For campaign only
        // fake address
        this.weth = "0x1746eb1b452f33Bc83f0230dC3ca1298037D3eeF"; // Test WETH for campaign only
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
