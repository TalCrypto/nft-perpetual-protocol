import { Signer, BigNumber } from "ethers";
import {
  AmmFake,
  AmmReader,
  ClearingHouseFake,
  ClearingHouseViewer,
  ERC20Fake,
  InsuranceFundFake,
  L2PriceFeedMock,
  TollPool,
  ClearingHouse,
  Liquidator,
} from "../../typechain-types";
import {
  deployAmm,
  deployAmmReader,
  deployClearingHouse,
  deployClearingHouseViewer,
  deployErc20Fake,
  deployInsuranceFund,
  deployTollPool,
  deployL2MockPriceFeed,
  deployLiquidator,
} from "./contract";
import { toFullDigitBN } from "./number";

export interface PerpContracts {
  quoteToken: ERC20Fake;
  priceFeed: L2PriceFeedMock;
  insuranceFund: InsuranceFundFake;
  clearingHouse: ClearingHouseFake;
  amm: AmmFake;
  ammReader: AmmReader;
  clearingHouseViewer: ClearingHouseViewer;
  tollPool: TollPool;
  liquidator: Liquidator;
}

export interface ContractDeployArgs {
  sender?: Signer;
  quoteTokenAmount?: BigNumber;
  perpInitSupply?: BigNumber;
  perpRewardVestingPeriod?: BigNumber;
  perpInflationRate?: BigNumber;
  perpMintDuration?: BigNumber;
  perpDecayRate?: BigNumber;
  tollRatio?: BigNumber;
  spreadRatio?: BigNumber;
  quoteAssetReserve?: BigNumber;
  baseAssetReserve?: BigNumber;
  startSchedule?: boolean;
}

const quoteTokenDecimals = 18;

const DEFAULT_CONTRACT_DEPLOY_ARGS: ContractDeployArgs = {
  quoteTokenAmount: toFullDigitBN(20000000, quoteTokenDecimals),
  perpInitSupply: toFullDigitBN(1000000),
  perpRewardVestingPeriod: BigNumber.from(0),
  perpInflationRate: toFullDigitBN(0.01), // 1%
  perpMintDuration: BigNumber.from(7 * 24 * 60 * 60), // 1 week
  perpDecayRate: BigNumber.from(0),
  tollRatio: BigNumber.from(0),
  spreadRatio: BigNumber.from(0),
  quoteAssetReserve: toFullDigitBN(1000),
  baseAssetReserve: toFullDigitBN(100),
  startSchedule: true,
};

export async function fullDeploy(args: ContractDeployArgs): Promise<PerpContracts> {
  const {
    sender,
    quoteTokenAmount = DEFAULT_CONTRACT_DEPLOY_ARGS.quoteTokenAmount,
    tollRatio = DEFAULT_CONTRACT_DEPLOY_ARGS.tollRatio,
    spreadRatio = DEFAULT_CONTRACT_DEPLOY_ARGS.spreadRatio,
    quoteAssetReserve = DEFAULT_CONTRACT_DEPLOY_ARGS.quoteAssetReserve,
    baseAssetReserve = DEFAULT_CONTRACT_DEPLOY_ARGS.baseAssetReserve,
  } = args;

  const quoteToken = await deployErc20Fake(sender!, quoteTokenAmount, "Tether", "USDT", BigNumber.from(quoteTokenDecimals));
  const priceFeed = await deployL2MockPriceFeed(sender!, toFullDigitBN(100));

  const insuranceFund = await deployInsuranceFund(sender!, priceFeed.address, priceFeed.address);

  const clearingHouse = await deployClearingHouse(
    sender!,
    toFullDigitBN(0.05),
    toFullDigitBN(0.05),
    toFullDigitBN(0.05),
    insuranceFund.address,
    insuranceFund.address
  );

  const clearingHouseViewer = await deployClearingHouseViewer(sender!, clearingHouse.address);
  const tollPool = await deployTollPool(sender!, clearingHouse.address);

  await clearingHouse.setTollPool(tollPool.address);

  // deploy an amm with Q100/B1000 liquidity
  const amm = await deployAmm({
    deployer: sender!,
    quoteAssetTokenAddr: quoteToken.address,
    priceFeedAddr: priceFeed.address,
    fundingPeriod: BigNumber.from(86400), // to make calculation easier we set fundingPeriod = 1 day
    fluctuation: toFullDigitBN(0),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    quoteAssetReserve: quoteAssetReserve!,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    baseAssetReserve: baseAssetReserve!,
    tollRatio,
    spreadRatio,
  });

  const ammReader = await deployAmmReader(sender!);

  await amm.setGlobalShutdown(insuranceFund.address);
  await amm.setCounterParty(clearingHouse.address);
  await insuranceFund.addAmm(amm.address);
  await insuranceFund.setBeneficiary(clearingHouse.address);
  await tollPool.addFeeToken(quoteToken.address);

  await amm.setOpen(true);

  const liquidator = await deployLiquidator(sender!, clearingHouse.address, toFullDigitBN(0.05));

  return {
    quoteToken,
    priceFeed,
    insuranceFund,
    clearingHouse,
    amm,
    ammReader,
    clearingHouseViewer,
    tollPool,
    liquidator,
  };
}
