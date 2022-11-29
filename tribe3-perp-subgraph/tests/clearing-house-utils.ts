import { newMockEvent } from "matchstick-as"
import { ethereum, Address, BigInt } from "@graphprotocol/graph-ts"
import {
  BackstopLiquidityProviderChanged,
  Initialized,
  MarginChanged,
  OwnershipTransferred,
  Paused,
  PositionAdjusted,
  PositionChanged,
  PositionLiquidated,
  PositionSettled,
  Repeg,
  RestrictionModeEntered,
  Unpaused,
  UpdateK
} from "../generated/ClearingHouse/ClearingHouse"

export function createBackstopLiquidityProviderChangedEvent(
  account: Address,
  isProvider: boolean
): BackstopLiquidityProviderChanged {
  let backstopLiquidityProviderChangedEvent = changetype<
    BackstopLiquidityProviderChanged
  >(newMockEvent())

  backstopLiquidityProviderChangedEvent.parameters = new Array()

  backstopLiquidityProviderChangedEvent.parameters.push(
    new ethereum.EventParam("account", ethereum.Value.fromAddress(account))
  )
  backstopLiquidityProviderChangedEvent.parameters.push(
    new ethereum.EventParam(
      "isProvider",
      ethereum.Value.fromBoolean(isProvider)
    )
  )

  return backstopLiquidityProviderChangedEvent
}

export function createInitializedEvent(version: i32): Initialized {
  let initializedEvent = changetype<Initialized>(newMockEvent())

  initializedEvent.parameters = new Array()

  initializedEvent.parameters.push(
    new ethereum.EventParam(
      "version",
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(version))
    )
  )

  return initializedEvent
}

export function createMarginChangedEvent(
  sender: Address,
  amm: Address,
  amount: BigInt,
  fundingPayment: BigInt
): MarginChanged {
  let marginChangedEvent = changetype<MarginChanged>(newMockEvent())

  marginChangedEvent.parameters = new Array()

  marginChangedEvent.parameters.push(
    new ethereum.EventParam("sender", ethereum.Value.fromAddress(sender))
  )
  marginChangedEvent.parameters.push(
    new ethereum.EventParam("amm", ethereum.Value.fromAddress(amm))
  )
  marginChangedEvent.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromSignedBigInt(amount))
  )
  marginChangedEvent.parameters.push(
    new ethereum.EventParam(
      "fundingPayment",
      ethereum.Value.fromSignedBigInt(fundingPayment)
    )
  )

  return marginChangedEvent
}

export function createOwnershipTransferredEvent(
  previousOwner: Address,
  newOwner: Address
): OwnershipTransferred {
  let ownershipTransferredEvent = changetype<OwnershipTransferred>(
    newMockEvent()
  )

  ownershipTransferredEvent.parameters = new Array()

  ownershipTransferredEvent.parameters.push(
    new ethereum.EventParam(
      "previousOwner",
      ethereum.Value.fromAddress(previousOwner)
    )
  )
  ownershipTransferredEvent.parameters.push(
    new ethereum.EventParam("newOwner", ethereum.Value.fromAddress(newOwner))
  )

  return ownershipTransferredEvent
}

export function createPausedEvent(account: Address): Paused {
  let pausedEvent = changetype<Paused>(newMockEvent())

  pausedEvent.parameters = new Array()

  pausedEvent.parameters.push(
    new ethereum.EventParam("account", ethereum.Value.fromAddress(account))
  )

  return pausedEvent
}

export function createPositionAdjustedEvent(
  amm: Address,
  trader: Address,
  newPositionSize: BigInt,
  oldLiquidityIndex: BigInt,
  newLiquidityIndex: BigInt
): PositionAdjusted {
  let positionAdjustedEvent = changetype<PositionAdjusted>(newMockEvent())

  positionAdjustedEvent.parameters = new Array()

  positionAdjustedEvent.parameters.push(
    new ethereum.EventParam("amm", ethereum.Value.fromAddress(amm))
  )
  positionAdjustedEvent.parameters.push(
    new ethereum.EventParam("trader", ethereum.Value.fromAddress(trader))
  )
  positionAdjustedEvent.parameters.push(
    new ethereum.EventParam(
      "newPositionSize",
      ethereum.Value.fromSignedBigInt(newPositionSize)
    )
  )
  positionAdjustedEvent.parameters.push(
    new ethereum.EventParam(
      "oldLiquidityIndex",
      ethereum.Value.fromUnsignedBigInt(oldLiquidityIndex)
    )
  )
  positionAdjustedEvent.parameters.push(
    new ethereum.EventParam(
      "newLiquidityIndex",
      ethereum.Value.fromUnsignedBigInt(newLiquidityIndex)
    )
  )

  return positionAdjustedEvent
}

export function createPositionChangedEvent(
  trader: Address,
  amm: Address,
  margin: BigInt,
  positionNotional: BigInt,
  exchangedPositionSize: BigInt,
  fee: BigInt,
  positionSizeAfter: BigInt,
  realizedPnl: BigInt,
  unrealizedPnlAfter: BigInt,
  badDebt: BigInt,
  liquidationPenalty: BigInt,
  spotPrice: BigInt,
  fundingPayment: BigInt
): PositionChanged {
  let positionChangedEvent = changetype<PositionChanged>(newMockEvent())

  positionChangedEvent.parameters = new Array()

  positionChangedEvent.parameters.push(
    new ethereum.EventParam("trader", ethereum.Value.fromAddress(trader))
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam("amm", ethereum.Value.fromAddress(amm))
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam("margin", ethereum.Value.fromUnsignedBigInt(margin))
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "positionNotional",
      ethereum.Value.fromUnsignedBigInt(positionNotional)
    )
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "exchangedPositionSize",
      ethereum.Value.fromSignedBigInt(exchangedPositionSize)
    )
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam("fee", ethereum.Value.fromUnsignedBigInt(fee))
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "positionSizeAfter",
      ethereum.Value.fromSignedBigInt(positionSizeAfter)
    )
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "realizedPnl",
      ethereum.Value.fromSignedBigInt(realizedPnl)
    )
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "unrealizedPnlAfter",
      ethereum.Value.fromSignedBigInt(unrealizedPnlAfter)
    )
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "badDebt",
      ethereum.Value.fromUnsignedBigInt(badDebt)
    )
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "liquidationPenalty",
      ethereum.Value.fromUnsignedBigInt(liquidationPenalty)
    )
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "spotPrice",
      ethereum.Value.fromUnsignedBigInt(spotPrice)
    )
  )
  positionChangedEvent.parameters.push(
    new ethereum.EventParam(
      "fundingPayment",
      ethereum.Value.fromSignedBigInt(fundingPayment)
    )
  )

  return positionChangedEvent
}

export function createPositionLiquidatedEvent(
  trader: Address,
  amm: Address,
  positionNotional: BigInt,
  positionSize: BigInt,
  liquidationFee: BigInt,
  liquidator: Address,
  badDebt: BigInt
): PositionLiquidated {
  let positionLiquidatedEvent = changetype<PositionLiquidated>(newMockEvent())

  positionLiquidatedEvent.parameters = new Array()

  positionLiquidatedEvent.parameters.push(
    new ethereum.EventParam("trader", ethereum.Value.fromAddress(trader))
  )
  positionLiquidatedEvent.parameters.push(
    new ethereum.EventParam("amm", ethereum.Value.fromAddress(amm))
  )
  positionLiquidatedEvent.parameters.push(
    new ethereum.EventParam(
      "positionNotional",
      ethereum.Value.fromUnsignedBigInt(positionNotional)
    )
  )
  positionLiquidatedEvent.parameters.push(
    new ethereum.EventParam(
      "positionSize",
      ethereum.Value.fromUnsignedBigInt(positionSize)
    )
  )
  positionLiquidatedEvent.parameters.push(
    new ethereum.EventParam(
      "liquidationFee",
      ethereum.Value.fromUnsignedBigInt(liquidationFee)
    )
  )
  positionLiquidatedEvent.parameters.push(
    new ethereum.EventParam(
      "liquidator",
      ethereum.Value.fromAddress(liquidator)
    )
  )
  positionLiquidatedEvent.parameters.push(
    new ethereum.EventParam(
      "badDebt",
      ethereum.Value.fromUnsignedBigInt(badDebt)
    )
  )

  return positionLiquidatedEvent
}

export function createPositionSettledEvent(
  amm: Address,
  trader: Address,
  valueTransferred: BigInt
): PositionSettled {
  let positionSettledEvent = changetype<PositionSettled>(newMockEvent())

  positionSettledEvent.parameters = new Array()

  positionSettledEvent.parameters.push(
    new ethereum.EventParam("amm", ethereum.Value.fromAddress(amm))
  )
  positionSettledEvent.parameters.push(
    new ethereum.EventParam("trader", ethereum.Value.fromAddress(trader))
  )
  positionSettledEvent.parameters.push(
    new ethereum.EventParam(
      "valueTransferred",
      ethereum.Value.fromUnsignedBigInt(valueTransferred)
    )
  )

  return positionSettledEvent
}

export function createRepegEvent(
  amm: Address,
  quoteAssetReserve: BigInt,
  baseAssetReserve: BigInt,
  cost: BigInt
): Repeg {
  let repegEvent = changetype<Repeg>(newMockEvent())

  repegEvent.parameters = new Array()

  repegEvent.parameters.push(
    new ethereum.EventParam("amm", ethereum.Value.fromAddress(amm))
  )
  repegEvent.parameters.push(
    new ethereum.EventParam(
      "quoteAssetReserve",
      ethereum.Value.fromUnsignedBigInt(quoteAssetReserve)
    )
  )
  repegEvent.parameters.push(
    new ethereum.EventParam(
      "baseAssetReserve",
      ethereum.Value.fromUnsignedBigInt(baseAssetReserve)
    )
  )
  repegEvent.parameters.push(
    new ethereum.EventParam("cost", ethereum.Value.fromSignedBigInt(cost))
  )

  return repegEvent
}

export function createRestrictionModeEnteredEvent(
  amm: Address,
  blockNumber: BigInt
): RestrictionModeEntered {
  let restrictionModeEnteredEvent = changetype<RestrictionModeEntered>(
    newMockEvent()
  )

  restrictionModeEnteredEvent.parameters = new Array()

  restrictionModeEnteredEvent.parameters.push(
    new ethereum.EventParam("amm", ethereum.Value.fromAddress(amm))
  )
  restrictionModeEnteredEvent.parameters.push(
    new ethereum.EventParam(
      "blockNumber",
      ethereum.Value.fromUnsignedBigInt(blockNumber)
    )
  )

  return restrictionModeEnteredEvent
}

export function createUnpausedEvent(account: Address): Unpaused {
  let unpausedEvent = changetype<Unpaused>(newMockEvent())

  unpausedEvent.parameters = new Array()

  unpausedEvent.parameters.push(
    new ethereum.EventParam("account", ethereum.Value.fromAddress(account))
  )

  return unpausedEvent
}

export function createUpdateKEvent(
  amm: Address,
  quoteAssetReserve: BigInt,
  baseAssetReserve: BigInt,
  cost: BigInt
): UpdateK {
  let updateKEvent = changetype<UpdateK>(newMockEvent())

  updateKEvent.parameters = new Array()

  updateKEvent.parameters.push(
    new ethereum.EventParam("amm", ethereum.Value.fromAddress(amm))
  )
  updateKEvent.parameters.push(
    new ethereum.EventParam(
      "quoteAssetReserve",
      ethereum.Value.fromUnsignedBigInt(quoteAssetReserve)
    )
  )
  updateKEvent.parameters.push(
    new ethereum.EventParam(
      "baseAssetReserve",
      ethereum.Value.fromUnsignedBigInt(baseAssetReserve)
    )
  )
  updateKEvent.parameters.push(
    new ethereum.EventParam("cost", ethereum.Value.fromSignedBigInt(cost))
  )

  return updateKEvent
}
