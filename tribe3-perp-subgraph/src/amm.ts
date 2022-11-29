import { FundingRateUpdated, ReserveSnapshotted } from "../generated/Amm/Amm";
import { FundingRateUpdatedEvent, ReserveSnapshottedEvent } from "../generated/schema";
import { BI_ZERO, getAmm, getDayTradeData } from "./helper";

/* Funding rate/payment event
 */
export function handleFundingRateUpdated(event: FundingRateUpdated): void {
  let entity = new FundingRateUpdatedEvent(event.transaction.hash.toHexString() + "-" + event.logIndex.toString());
  entity.amm = event.address;
  entity.rate = event.params.rate;
  entity.underlyingPrice = event.params.underlyingPrice;
  entity.blockNumber = event.block.number;
  entity.timestamp = event.block.timestamp;
  entity.save();
}

export function handleReserveSnapshotted(event: ReserveSnapshotted): void {
  let amm = getAmm(event.address);
  let baseAssetReserve = event.params.baseAssetReserve;
  let quoteAssetReserve = event.params.quoteAssetReserve;
  amm.baseAssetReserve = baseAssetReserve;
  amm.quoteAssetReserve = quoteAssetReserve;
  amm.openInterestNotional = amm.openInterestSize.times(quoteAssetReserve.div(baseAssetReserve));
  amm.blockNumber = event.block.number;
  amm.timestamp = event.block.timestamp;

  let reserveSnapshottedEvent = new ReserveSnapshottedEvent(event.transaction.hash.toHexString() + "-" + event.logIndex.toString());
  reserveSnapshottedEvent.amm = event.address;
  reserveSnapshottedEvent.baseAssetReserve = baseAssetReserve;
  reserveSnapshottedEvent.quoteAssetReserve = quoteAssetReserve;
  reserveSnapshottedEvent.blockNumber = event.block.number;
  reserveSnapshottedEvent.timestamp = event.block.timestamp;

  //
  // update day trade data
  //
  const spotPrice = quoteAssetReserve.div(baseAssetReserve);
  let dayTradeData = getDayTradeData(event, event.address);
  if (dayTradeData.open == BI_ZERO) {
    dayTradeData.open = spotPrice;
  }
  if (spotPrice.gt(dayTradeData.high)) {
    dayTradeData.high = spotPrice;
  }
  if (dayTradeData.low == BI_ZERO || spotPrice.lt(dayTradeData.low)) {
    dayTradeData.low = spotPrice;
  }
  dayTradeData.close = spotPrice;

  amm.save();
  reserveSnapshottedEvent.save();
  dayTradeData.save();
}
