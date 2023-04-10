export enum AmmInstanceName {
  BAYCETH = "BAYCETH",
  AZUKIETH = "AZUKIETH",
  DOODLESETH = "DOODLESETH",
  MOONBIRDSETH = "MOONBIRDSETH",
  MAYCETH = "MAYCETH",
  PUDGYPENGUINSETH = "PUDGYPENGUINSETH",
  WRAPPEDCRYPTOPUNKSETH = "WRAPPEDCRYPTOPUNKSETH",
}

// chainlink
export enum PriceFeedKey {
  BAYC = "BAYC/ETH",
  AZUKI = "AZUKI/ETH",
  DOODLES = "DOODLES/ETH",
  MOONBIRDS = "MOONBIRDS/ETH",
  MAYC = "MAYCETH/ETH",
  PUDGYPENGUINS = "PUDGYPENGUINS/ETH",
  WRAPPEDCRYPTOPUNKS = "WRAPPEDCRYPTOPUNKS/ETH",
}

export enum ContractFullyQualifiedName {
  InsuranceFund = "contracts/InsuranceFund.sol:InsuranceFund",
  L2PriceFeed = "contracts/L2PriceFeed.sol:L2PriceFeed",
  ClearingHouse = "contracts/ClearingHouse.sol:ClearingHouse",
  ClearingHouseViewer = "contracts/ClearingHouseViewer.sol:ClearingHouseViewer",
  Amm = "contracts/Amm.sol:Amm",
  AmmReader = "contracts/AmmReader.sol:AmmReader",
  TollPool = "contracts/TollPool.sol:TollPool",
  Liquidator = "contracts/keeper/Liquidator.sol:Liquidator",
  ETHStakingPool = "contracts/ETHStakingPool.sol:ETHStakingPool",
  ChainlinkPriceFeed = "contracts/ChainlinkPriceFeed.sol:ChainlinkPriceFeed",
}
