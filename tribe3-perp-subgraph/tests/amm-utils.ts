import { newMockEvent } from "matchstick-as"
import { ethereum, BigInt, Address } from "@graphprotocol/graph-ts"
import {
  CapChanged,
  FundingRateUpdated,
  AmmInitialized,
  LiquidityChanged,
  AmmOwnershipTransferred,
  PriceFeedUpdated,
  AmmRepeg,
  ReserveSnapshotted,
  Shutdown,
  SwapInput,
  SwapOutput
} from "../generated/Amm/Amm"

export function createCapChangedEvent(
  maxHoldingBaseAsset: BigInt,
  openInterestNotionalCap: BigInt
): CapChanged {
  let capChangedEvent = changetype<CapChanged>(newMockEvent())

  capChangedEvent.parameters = new Array()

  capChangedEvent.parameters.push(
    new ethereum.EventParam(
      "maxHoldingBaseAsset",
      ethereum.Value.fromUnsignedBigInt(maxHoldingBaseAsset)
    )
  )
  capChangedEvent.parameters.push(
    new ethereum.EventParam(
      "openInterestNotionalCap",
      ethereum.Value.fromUnsignedBigInt(openInterestNotionalCap)
    )
  )

  return capChangedEvent
}

export function createFundingRateUpdatedEvent(
  rate: BigInt,
  underlyingPrice: BigInt
): FundingRateUpdated {
  let fundingRateUpdatedEvent = changetype<FundingRateUpdated>(newMockEvent())

  fundingRateUpdatedEvent.parameters = new Array()

  fundingRateUpdatedEvent.parameters.push(
    new ethereum.EventParam("rate", ethereum.Value.fromSignedBigInt(rate))
  )
  fundingRateUpdatedEvent.parameters.push(
    new ethereum.EventParam(
      "underlyingPrice",
      ethereum.Value.fromUnsignedBigInt(underlyingPrice)
    )
  )

  return fundingRateUpdatedEvent
}

export function createAmmInitializedEvent(version: i32): AmmInitialized {
  let ammInitializedEvent = changetype<AmmInitialized>(newMockEvent())

  ammInitializedEvent.parameters = new Array()

  ammInitializedEvent.parameters.push(
    new ethereum.EventParam(
      "version",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(version))
    )
  )

  return ammInitializedEvent
}

export function createLiquidityChangedEvent(
  quoteReserve: BigInt,
  baseReserve: BigInt,
  cumulativeNotional: BigInt
): LiquidityChanged {
  let liquidityChangedEvent = changetype<LiquidityChanged>(newMockEvent())

  liquidityChangedEvent.parameters = new Array()

  liquidityChangedEvent.parameters.push(
    new ethereum.EventParam(
      "quoteReserve",
      ethereum.Value.fromUnsignedBigInt(quoteReserve)
    )
  )
  liquidityChangedEvent.parameters.push(
    new ethereum.EventParam(
      "baseReserve",
      ethereum.Value.fromUnsignedBigInt(baseReserve)
    )
  )
  liquidityChangedEvent.parameters.push(
    new ethereum.EventParam(
      "cumulativeNotional",
      ethereum.Value.fromSignedBigInt(cumulativeNotional)
    )
  )

  return liquidityChangedEvent
}

export function createAmmOwnershipTransferredEvent(
  previousOwner: Address,
  newOwner: Address
): AmmOwnershipTransferred {
  let ammOwnershipTransferredEvent = changetype<AmmOwnershipTransferred>(
    newMockEvent()
  )

  ammOwnershipTransferredEvent.parameters = new Array()

  ammOwnershipTransferredEvent.parameters.push(
    new ethereum.EventParam(
      "previousOwner",
      ethereum.Value.fromAddress(previousOwner)
    )
  )
  ammOwnershipTransferredEvent.parameters.push(
    new ethereum.EventParam("newOwner", ethereum.Value.fromAddress(newOwner))
  )

  return ammOwnershipTransferredEvent
}

export function createPriceFeedUpdatedEvent(
  priceFeed: Address
): PriceFeedUpdated {
  let priceFeedUpdatedEvent = changetype<PriceFeedUpdated>(newMockEvent())

  priceFeedUpdatedEvent.parameters = new Array()

  priceFeedUpdatedEvent.parameters.push(
    new ethereum.EventParam("priceFeed", ethereum.Value.fromAddress(priceFeed))
  )

  return priceFeedUpdatedEvent
}

export function createAmmRepegEvent(
  quoteAssetReserve: BigInt,
  baseAssetReserve: BigInt
): AmmRepeg {
  let ammRepegEvent = changetype<AmmRepeg>(newMockEvent())

  ammRepegEvent.parameters = new Array()

  ammRepegEvent.parameters.push(
    new ethereum.EventParam(
      "quoteAssetReserve",
      ethereum.Value.fromUnsignedBigInt(quoteAssetReserve)
    )
  )
  ammRepegEvent.parameters.push(
    new ethereum.EventParam(
      "baseAssetReserve",
      ethereum.Value.fromUnsignedBigInt(baseAssetReserve)
    )
  )

  return ammRepegEvent
}

export function createReserveSnapshottedEvent(
  quoteAssetReserve: BigInt,
  baseAssetReserve: BigInt,
  timestamp: BigInt
): ReserveSnapshotted {
  let reserveSnapshottedEvent = changetype<ReserveSnapshotted>(newMockEvent())

  reserveSnapshottedEvent.parameters = new Array()

  reserveSnapshottedEvent.parameters.push(
    new ethereum.EventParam(
      "quoteAssetReserve",
      ethereum.Value.fromUnsignedBigInt(quoteAssetReserve)
    )
  )
  reserveSnapshottedEvent.parameters.push(
    new ethereum.EventParam(
      "baseAssetReserve",
      ethereum.Value.fromUnsignedBigInt(baseAssetReserve)
    )
  )
  reserveSnapshottedEvent.parameters.push(
    new ethereum.EventParam(
      "timestamp",
      ethereum.Value.fromUnsignedBigInt(timestamp)
    )
  )

  return reserveSnapshottedEvent
}

export function createShutdownEvent(settlementPrice: BigInt): Shutdown {
  let shutdownEvent = changetype<Shutdown>(newMockEvent())

  shutdownEvent.parameters = new Array()

  shutdownEvent.parameters.push(
    new ethereum.EventParam(
      "settlementPrice",
      ethereum.Value.fromUnsignedBigInt(settlementPrice)
    )
  )

  return shutdownEvent
}

export function createSwapInputEvent(
  dir: i32,
  quoteAssetAmount: BigInt,
  baseAssetAmount: BigInt
): SwapInput {
  let swapInputEvent = changetype<SwapInput>(newMockEvent())

  swapInputEvent.parameters = new Array()

  swapInputEvent.parameters.push(
    new ethereum.EventParam(
      "dir",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(dir))
    )
  )
  swapInputEvent.parameters.push(
    new ethereum.EventParam(
      "quoteAssetAmount",
      ethereum.Value.fromUnsignedBigInt(quoteAssetAmount)
    )
  )
  swapInputEvent.parameters.push(
    new ethereum.EventParam(
      "baseAssetAmount",
      ethereum.Value.fromUnsignedBigInt(baseAssetAmount)
    )
  )

  return swapInputEvent
}

export function createSwapOutputEvent(
  dir: i32,
  quoteAssetAmount: BigInt,
  baseAssetAmount: BigInt
): SwapOutput {
  let swapOutputEvent = changetype<SwapOutput>(newMockEvent())

  swapOutputEvent.parameters = new Array()

  swapOutputEvent.parameters.push(
    new ethereum.EventParam(
      "dir",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(dir))
    )
  )
  swapOutputEvent.parameters.push(
    new ethereum.EventParam(
      "quoteAssetAmount",
      ethereum.Value.fromUnsignedBigInt(quoteAssetAmount)
    )
  )
  swapOutputEvent.parameters.push(
    new ethereum.EventParam(
      "baseAssetAmount",
      ethereum.Value.fromUnsignedBigInt(baseAssetAmount)
    )
  )

  return swapOutputEvent
}
