export interface IFootPrintCandle {
  uuid: string
  openTime: string
  openTimeMs: number
  closeTime: string
  closeTimeMs: number
  interval: string
  symbol: string
  exchange: string
  aggressiveBid: number
  aggressiveAsk: number
  volumeDelta: number
  volume: number
  high: number
  low: number
  // bid: IOrderRow
  // ask: IOrderRow
  /** bid/ask volume grouped by levels (to pricePrecisionDp) */
  priceLevels: { [price: number]: IPriceLevel }
  isClosed: boolean
}

export type IFootPrintClosedCandle = IFootPrintCandle & {
  priceLevels: { [price: number]: IPriceLevelClosed }
  isClosed: true
  didPersistToStore: boolean
}

// interface IOrderRow {
//   [price: string]: number
// }

export interface IPriceLevel {
  volSumBid: number
  volSumAsk: number
}

export type IPriceLevelClosed = IPriceLevel & { imbalancePercent: number }
