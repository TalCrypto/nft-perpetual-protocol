import { AmmPosition, Position, Amm, TraderDayData, Trader, DayTradeData } from "../generated/schema";
import { BigInt, Address, ethereum, Bytes } from "@graphprotocol/graph-ts";
import { PositionChanged } from "../generated/ClearingHouse/ClearingHouse";

export let BI_ZERO = BigInt.fromI32(0);

export function getPosition(trader: Address): Position {
  let position = Position.load(parsePositionId(trader));
  if (!position) {
    position = createPosition(trader);
  }
  return position!;
}

export function createPosition(trader: Address): Position {
  let position = new Position(parsePositionId(trader));
  position.trader = trader;
  position.margin = BI_ZERO;
  position.openNotional = BI_ZERO;
  position.tradingVolume = BI_ZERO;
  position.leverage = BI_ZERO;
  position.realizedPnl = BI_ZERO;
  position.unrealizedPnl = BI_ZERO;
  position.fundingPayment = BI_ZERO;
  position.fee = BI_ZERO;
  position.badDebt = BI_ZERO;
  position.liquidationPenalty = BI_ZERO;
  position.totalPnlAmount = BI_ZERO;
  position.blockNumber = BI_ZERO;
  position.timestamp = BI_ZERO;
  position.save();
  return position;
}

export function parsePositionId(trader: Address): string {
  return trader.toHexString();
}

export function getAmmPosition(amm: Address, trader: Address): AmmPosition {
  let ammPosition = AmmPosition.load(parseAmmPositionId(amm, trader));
  if (!ammPosition) {
    ammPosition = createAmmPosition(amm, trader);
  }
  return ammPosition!;
}

export function createAmmPosition(amm: Address, trader: Address): AmmPosition {
  let ammPositionId = parseAmmPositionId(amm, trader);
  let ammPosition = new AmmPosition(ammPositionId);
  ammPosition.amm = amm;
  ammPosition.trader = trader;
  ammPosition.margin = BI_ZERO;
  ammPosition.positionSize = BI_ZERO;
  ammPosition.openNotional = BI_ZERO;
  ammPosition.tradingVolume = BI_ZERO;
  ammPosition.leverage = BI_ZERO;
  ammPosition.entryPrice = BI_ZERO;
  ammPosition.realizedPnl = BI_ZERO;
  ammPosition.unrealizedPnl = BI_ZERO;
  ammPosition.fundingPayment = BI_ZERO;
  ammPosition.fee = BI_ZERO;
  ammPosition.badDebt = BI_ZERO;
  ammPosition.liquidationPenalty = BI_ZERO;
  ammPosition.totalPnlAmount = BI_ZERO;
  ammPosition.position = parsePositionId(trader);
  ammPosition.blockNumber = BI_ZERO;
  ammPosition.timestamp = BI_ZERO;
  ammPosition.save();
  return ammPosition;
}

export function parseAmmPositionId(amm: Address, trader: Address): string {
  return amm.toHexString() + "-" + trader.toHexString();
}

export function calcNewAmmOpenNotional(ammPosition: AmmPosition, event: PositionChanged): BigInt {
  let signedOpenNotional = ammPosition.positionSize.ge(BI_ZERO) ? ammPosition.openNotional : ammPosition.openNotional.neg();

  return signedOpenNotional
    .plus(event.params.realizedPnl)
    .plus(event.params.exchangedPositionSize.ge(BI_ZERO) ? event.params.positionNotional : event.params.positionNotional.neg())
    .abs();
}

export namespace decimal {
  export function div(a: BigInt, b: BigInt): BigInt {
    return a.times(BigInt.fromI32(10).pow(18)).div(b);
  }
}

export function getAmm(ammAddress: Address): Amm {
  let amm = Amm.load(parseAmmId(ammAddress));
  if (!amm) {
    amm = createAmm(ammAddress);
  }
  return amm!;
}

export function createAmm(ammAddress: Address): Amm {
  let amm = new Amm(parseAmmId(ammAddress));
  amm.address = ammAddress;
  amm.positionBalance = BI_ZERO;
  amm.openInterestSize = BI_ZERO;
  amm.openInterestNotional = BI_ZERO;
  amm.tradingVolume = BI_ZERO;
  amm.quoteAssetReserve = BI_ZERO;
  amm.baseAssetReserve = BI_ZERO;
  amm.blockNumber = BI_ZERO;
  amm.timestamp = BI_ZERO;
  amm.save();
  return amm;
}

export function parseAmmId(ammAddress: Address): string {
  return ammAddress.toHexString();
}

export function createTrader(traderAddress: Address): Trader {
  let trader = new Trader(traderAddress.toHexString());
  let position = getPosition(traderAddress);
  trader.position = position.id;
  trader.save();
  return trader;
}

export function getTrader(traderAddress: Address): Trader {
  let trader = Trader.load(traderAddress.toHexString());
  if (!trader) {
    trader = createTrader(traderAddress);
  }
  return trader!;
}

export function getTraderDayData(event: ethereum.Event, trader: Address): TraderDayData {
  let _trader = getTrader(trader);
  let timestamp = event.block.timestamp.toI32();
  let dayID = timestamp / 86400;
  let id = _trader.id + "-" + dayID.toString();

  let dayData = TraderDayData.load(id);
  let dayStartTimestamp = dayID * 86400;

  if (!dayData) {
    dayData = new TraderDayData(id);
    dayData.date = BigInt.fromI32(dayStartTimestamp);
    dayData.fee = BI_ZERO;
    dayData.tradingVolume = BI_ZERO;
    dayData.fundingPayment = BI_ZERO;
    dayData.realizedPnl = BI_ZERO;
    dayData.trader = _trader.id;
    dayData.save();
  }
  return dayData!;
}

export function getDayTradeData(event: ethereum.Event, amm: Address): DayTradeData {
  const oneDay = 86400;
  let timestamp = event.block.timestamp.toI32();
  let timeID = timestamp / oneDay;

  let id = amm.toHexString() + "-" + timeID.toString();

  let dayTradeData = DayTradeData.load(id);

  if (!dayTradeData) {
    let dayStartTimestamp = timeID * oneDay;
    dayTradeData = new DayTradeData(id);
    dayTradeData.timestamp = BigInt.fromI32(dayStartTimestamp);
    dayTradeData.amm = amm;
    dayTradeData.open = BI_ZERO;
    dayTradeData.high = BI_ZERO;
    dayTradeData.low = BI_ZERO;
    dayTradeData.close = BI_ZERO;
    dayTradeData.volume = BI_ZERO;
    dayTradeData.txCount = BI_ZERO;
    dayTradeData.save();
  }
  return dayTradeData!;
}

// export function createReferralCode(
//   referralCode: string,
//   referrer: Address,
//   createdAt: BigInt
// ): ReferralCode {
//   let _referralCode = new ReferralCode(referralCode);
//   let _referrer = getTrader(referrer);
//   _referralCode.referrer = _referrer.id;
//   _referralCode.referees = [];
//   _referralCode.createdAt = createdAt;
//   _referralCode.save();
//   return _referralCode!;
// }

// export function getReferralCode(referralCode: string): ReferralCode {
//   let _referralCode = ReferralCode.load(referralCode);
//   return _referralCode!;
// }

// export function getReferralCodeDayData(
//   event: ethereum.Event,
//   referralCode: string
// ): ReferralCodeDayData {
//   let timestamp = event.block.timestamp.toI32();
//   let dayID = timestamp / 86400;
//   let id = referralCode + "-" + dayID.toString();
//   let dayData = ReferralCodeDayData.load(id);
//   let dayStartTimestamp = dayID * 86400;

//   if (!dayData) {
//     dayData = new ReferralCodeDayData(id);
//     dayData.referralCode = referralCode;
//     dayData.tradingVolume = BI_ZERO;
//     dayData.fees = BI_ZERO;
//     dayData.date = BigInt.fromI32(dayStartTimestamp);
//     dayData.newReferees = [];
//     dayData.activeReferees = [];
//     dayData.save();
//   }
//   return dayData!;
// }

export function removeAddressFromList(addresses: string[], addressToRemove: string): string[] {
  let spliceIndex = -1;
  for (let i = 0; i < addresses.length; ++i) {
    if (addressToRemove == addresses[i]) {
      spliceIndex = i;
    }
  }
  if (spliceIndex > -1) {
    addresses.splice(spliceIndex, 1);
  }
  return addresses;
}
