import { utils, BigNumber, ethers } from "ethers";
import { AmmInstanceName, PriceFeedKey } from "./Constants";

const DEFAULT_AMM_TRADE_LIMIT_RATIO = utils.parseEther("0.9"); // 90% trading limit ratio
const DEFAULT_AMM_FUNDING_PERIOD = BigNumber.from(10800); // 3 hour
const DEFAULT_AMM_FLUCTUATION = utils.parseEther("0.02"); // 2%
const DEFAULT_AMM_TOLL_RATIO = utils.parseEther("0"); // 0%
const DEFAULT_AMM_SPREAD_RATIO = utils.parseEther("0.003"); // 0.3%

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

export type AmmConfig = { name: AmmInstanceName; deployArgs: AmmDeployArgs };

const BAYC_AMM: AmmConfig = {
  name: AmmInstanceName.BAYCETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("4000"),
    baseAssetReserve: utils.parseEther("69.05"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: ethers.utils.formatBytes32String(PriceFeedKey.BAYC),
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
};

const DOODLES_AMM: AmmConfig = {
  name: AmmInstanceName.DOODLESETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("1093.8"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: ethers.utils.formatBytes32String(PriceFeedKey.DOODLES),
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
};

const AZUKI_AMM: AmmConfig = {
  name: AmmInstanceName.AZUKIETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("4000"),
    baseAssetReserve: utils.parseEther("301.89"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: ethers.utils.formatBytes32String(PriceFeedKey.AZUKI),
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
};

const MOONBIRDS_AMM: AmmConfig = {
  name: AmmInstanceName.MOONBIRDSETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("964.94"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: ethers.utils.formatBytes32String(PriceFeedKey.MOONBIRDS),
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
};

const MAYC_AMM: AmmConfig = {
  name: AmmInstanceName.MAYCETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3500"),
    baseAssetReserve: utils.parseEther("272.37"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: ethers.utils.formatBytes32String(PriceFeedKey.MAYC),
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
};

const PUDGYPENGUINS_AMM: AmmConfig = {
  name: AmmInstanceName.PUDGYPENGUINSETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("3000"),
    baseAssetReserve: utils.parseEther("736.21"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: ethers.utils.formatBytes32String(PriceFeedKey.PUDGYPENGUINS),
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
};

const WRAPPEDCRYPTOPUNKS_AMM: AmmConfig = {
  name: AmmInstanceName.WRAPPEDCRYPTOPUNKSETH,
  deployArgs: {
    // base * price
    quoteAssetReserve: utils.parseEther("4500"),
    baseAssetReserve: utils.parseEther("79.53"),
    tradeLimitRatio: DEFAULT_AMM_TRADE_LIMIT_RATIO, // 90% trading limit ratio
    fundingPeriod: DEFAULT_AMM_FUNDING_PERIOD, // 6 hour
    fluctuation: DEFAULT_AMM_FLUCTUATION, // 1.2%
    priceFeedKey: ethers.utils.formatBytes32String(PriceFeedKey.WRAPPEDCRYPTOPUNKS),
    tollRatio: DEFAULT_AMM_TOLL_RATIO, // 0.0%
    spreadRatio: DEFAULT_AMM_SPREAD_RATIO, // 0.5%
  },
};

export class DeployConfig {
  // stage
  readonly network: string;
  // deploy
  readonly confirmations: number;

  // weth address
  readonly weth: string;

  // tribe3 treasury address
  readonly tribe3Treasury;

  readonly aggregators: Record<AmmInstanceName, string>;

  // amm
  readonly legacyAmmConfigMap: Record<AmmInstanceName, AmmConfig> = {
    [AmmInstanceName.BAYCETH]: BAYC_AMM,
    [AmmInstanceName.AZUKIETH]: AZUKI_AMM,
    [AmmInstanceName.DOODLESETH]: DOODLES_AMM,
    [AmmInstanceName.MOONBIRDSETH]: MOONBIRDS_AMM,
    [AmmInstanceName.MAYCETH]: MAYC_AMM,
    [AmmInstanceName.PUDGYPENGUINSETH]: PUDGYPENGUINS_AMM,
    [AmmInstanceName.WRAPPEDCRYPTOPUNKSETH]: WRAPPEDCRYPTOPUNKS_AMM,
  };

  constructor(network: string) {
    this.network = network;
    switch (network) {
      case "arbitrum":
        this.confirmations = 5;
        this.weth = "0x7F4C5d495Fd0FFBD76992505200d9dF604Fa0715";
        this.tribe3Treasury = "0x3D97f8E56717bacabdf627c8F7c5444c392eA91d";
        this.aggregators = {
          [AmmInstanceName.BAYCETH]: "0x11De87FC66a66dC001e83f2bF48E90353168d02D",
          [AmmInstanceName.AZUKIETH]: "0xFA56Ea945b94F2Ef0489178343eCC3CACfbB3836",
          [AmmInstanceName.DOODLESETH]: "",
          [AmmInstanceName.MOONBIRDSETH]: "",
          [AmmInstanceName.MAYCETH]: "0x574087CB2CC9D7c5170422b83b9FD1677430bd55",
          [AmmInstanceName.PUDGYPENGUINSETH]: "",
          [AmmInstanceName.WRAPPEDCRYPTOPUNKSETH]: "0x533a05621EebFac12a0d12599EA2B6665e9b171D",
        };
        break;
      case "arbitrum_goerli":
        this.confirmations = 5;
        this.weth = "0xEe01c0CD76354C383B8c7B4e65EA88D00B06f36f";
        this.tribe3Treasury = "0x3bDA1E0f89D925e6931B7B64B1bDaaC210C9a519";
        this.aggregators = {
          [AmmInstanceName.BAYCETH]: "0xDeE1bfdFB24547Fa54130649ca8Cd83827b4d5E2",
          [AmmInstanceName.AZUKIETH]: "0x6c72f0c19864A6CbE860c525c747ec5318b05baA",
          [AmmInstanceName.DOODLESETH]: "0xD5cEc194526b633F14A2f007Fdf4b440aE4Dc65B",
          [AmmInstanceName.MOONBIRDSETH]: "0x97D4e4fa0BB86e096dE6041d373c32FA55062458",
          [AmmInstanceName.MAYCETH]: "0x5A00Dca3e384686922adb59303A6735c3F46c189",
          [AmmInstanceName.PUDGYPENGUINSETH]: "0x27D5738e9264B295BD714f337c77bc0447461b03",
          [AmmInstanceName.WRAPPEDCRYPTOPUNKSETH]: "",
        };
        break;
      case "goerli":
        this.confirmations = 5;
        this.weth = "0x1DcD297530778f987e8DEEB07667E29Cd052bC50"; // Test WETH for campaign only
        this.tribe3Treasury = "";
        this.aggregators = {
          [AmmInstanceName.BAYCETH]: "0x862f31222C62240344c930426788129Fe488a09C",
          [AmmInstanceName.AZUKIETH]: "0x10a9B70Ff86BbE92A3E86Be2CEa3754AFCC7C4FC",
          [AmmInstanceName.DOODLESETH]: "0x59846B946A0ca6Fd25feFd25578455D0B4b7bDe9",
          [AmmInstanceName.MOONBIRDSETH]: "0x9F9bd05aB4F631e926F6e48D52254FDA3719e53b",
          [AmmInstanceName.MAYCETH]: "0x7a3A09090Ed5b0559c158D91747EF3b1659A4De3",
          [AmmInstanceName.PUDGYPENGUINSETH]: "0x824fe7D8070dE426358019F57bEAbBd7fa179Fa1",
          [AmmInstanceName.WRAPPEDCRYPTOPUNKSETH]: "",
        };
        break;
      default:
        throw new Error(`not supported network=${network}`);
    }
  }
}
