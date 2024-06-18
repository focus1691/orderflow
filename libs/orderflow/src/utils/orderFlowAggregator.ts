import { getStartOfMinute } from './date'
import { IFootPrintCandle, IFootPrintClosedCandle, IPriceLevelClosed } from '../dto/orderflow.dto'
import { CACHE_LIMIT } from '@tsquant/exchangeapi/dist/lib/constants'
import * as crypto from 'crypto'

export interface OrderFlowAggregatorConfig {
  // Define per-level price precision used to group trades by level
  // (ideally don't use this, instead round to tick size before it reaches the aggregator)
  pricePrecisionDp?: number | null
  // Defines how many rows to keep in memory before pruning old rows (default is 600)
  maxCacheInMemory: number
}

export class OrderFlowAggregator {
  exchange: string
  symbol: string
  interval: string
  intervalSizeMs: number

  config: OrderFlowAggregatorConfig

  /** Candle currently building (still open) */
  private activeCandle: IFootPrintCandle | null = null

  /** Queue of candles that may not yet have reached the DB yet (closed candles) */
  private candleQueue: IFootPrintClosedCandle[] = []

  /** Used for backtesting in replace of getStartOfMinute()  */
  private currMinute: number | null = null

  constructor(exchange: string, symbol: string, interval: string, intervalSizeMs: number, config?: Partial<OrderFlowAggregatorConfig>) {
    this.exchange = exchange
    this.symbol = symbol
    this.interval = interval
    this.intervalSizeMs = intervalSizeMs

    this.config = {
      maxCacheInMemory: CACHE_LIMIT,
      ...config
    }
  }

  public setCurrMinute(currMinute: number): void {
    this.currMinute = currMinute
  }

  /** Get only candles that haven't been saved to DB yet */
  public getQueuedCandles(): IFootPrintClosedCandle[] {
    return this.getAllCandles().filter((candle) => !candle.didPersistToStore)
  }

  public clearCandleQueue(): void {
    this.candleQueue = []
  }

  /** Get all candles, incl those already saved to DB */
  public getAllCandles(): IFootPrintClosedCandle[] {
    return this.candleQueue
  }

  /** Marks which candles have been saved to DB */
  public markSavedCandles(savedUUIDs: string[]) {
    // console.log(`markSavedCandles: ${savedUUIDs}`)
    for (const uuid of savedUUIDs) {
      const candle = this.getAllCandles().find((c) => c.uuid === uuid)
      if (candle) {
        candle.didPersistToStore = true
        // console.log(`successfully marked: ${uuid}`)
      } else {
        console.log(`no candle found for uuid (${uuid})`, this.getAllCandles())
      }
    }
  }

  /** Call to ensure candle queue is trimmed within max length (oldest are discarded first) */
  public pruneCandleQueue() {
    const MAX_QUEUE_LENGTH = this.config.maxCacheInMemory
    if (this.candleQueue.length <= MAX_QUEUE_LENGTH) {
      return
    }

    // Trim store to last x candles, based on config
    const rowsToTrim = this.candleQueue.length - MAX_QUEUE_LENGTH

    console.log(`removing ${rowsToTrim} candles from aggregator queue. Length before: ${this.candleQueue.length}`)
    this.candleQueue.splice(0, rowsToTrim)
    console.log(`len after: ${this.candleQueue.length}`)
  }

  public retireActiveCandle(): IFootPrintClosedCandle | undefined {
    const candle = this.activeCandle

    if (!candle) {
      return
    }

    const closedPriceLevels: { [price: number]: IPriceLevelClosed } = {}

    const sortedLevels: string[] = Object.keys(candle.priceLevels).sort(
      (a, b) => Number(b) - Number(a) // descending price
    )
    for (const levelPrice of sortedLevels) {
      const level = candle.priceLevels[levelPrice]
      const imbalancePercent = (level.volSumBid / (level.volSumBid + level.volSumAsk)) * 100

      const closedLevel: IPriceLevelClosed = {
        ...level,
        bidImbalancePercent: +imbalancePercent.toFixed(2)
      }

      closedPriceLevels[levelPrice] = closedLevel
    }

    const imbalancePercent = (candle.aggressiveBid / (candle.aggressiveBid + candle.aggressiveAsk)) * 100

    const closedCandle: IFootPrintClosedCandle = {
      ...candle,
      priceLevels: closedPriceLevels,
      bidImbalancePercent: +imbalancePercent.toFixed(2),
      isClosed: true,
      didPersistToStore: false
    }

    this.candleQueue.push(closedCandle)
    this.activeCandle = null

    return closedCandle
  }

  public createNewCandle() {
    const startDate: Date = this.currMinute ? new Date(this.currMinute) : getStartOfMinute()
    const openTimeMs = startDate.getTime()
    const closeTimeMs = startDate.getTime() + this.intervalSizeMs - 1
    const openTime = startDate.toISOString()
    const closeTime = new Date(closeTimeMs).toISOString()

    const candle: IFootPrintCandle = {
      uuid: crypto.randomUUID(),
      openTime,
      openTimeMs,
      closeTime,
      closeTimeMs,
      symbol: this.symbol,
      exchange: this.exchange,
      interval: this.interval,
      aggressiveBid: 0,
      aggressiveAsk: 0,
      volume: 0,
      volumeDelta: 0,
      high: 0,
      low: 0,
      close: 0,
      priceLevels: {},
      isClosed: false
    }

    this.activeCandle = candle
  }

  public processCandleClosed(): IFootPrintClosedCandle | undefined {
    const candle = this.retireActiveCandle()
    this.createNewCandle()

    return candle
  }

  public processNewTrades(isBuyerMaker: boolean, assetQty: number, price: number) {
    if (!this.activeCandle) {
      this.createNewCandle()
      return this.processNewTrades(isBuyerMaker, assetQty, price)
    }

    const tradeQty = assetQty

    // TODO: asset qty or notional value or both?
    // https://t.me/c/1819709460/8295/17236
    this.activeCandle.volume += tradeQty

    // Determine which side (bid/ask) and delta direction based on isBuyerMM
    const tradeQtyDelta = isBuyerMaker ? -tradeQty : tradeQty

    // Update delta
    this.activeCandle.volumeDelta += tradeQtyDelta

    const precisionTrimmedPrice = this.config.pricePrecisionDp ? +price.toFixed(this.config.pricePrecisionDp) : price

    // Initialise the price level, if it doesn't exist yet
    // TODO: do price step size rounding here
    if (!this.activeCandle.priceLevels[precisionTrimmedPrice]) {
      this.activeCandle.priceLevels[precisionTrimmedPrice] = {
        volSumAsk: 0,
        volSumBid: 0
      }
    }

    // If buyer is maker, buy is a limit order, seller is a market order (low ask), seller is aggressive ask
    if (isBuyerMaker) {
      this.activeCandle.aggressiveAsk += tradeQty
      this.activeCandle.priceLevels[precisionTrimmedPrice].volSumAsk += tradeQty
    } else {
      // Else, sell is a limit order, buyer is a market order (high bid), buyer is aggressive bid
      this.activeCandle.aggressiveBid += tradeQty
      this.activeCandle.priceLevels[precisionTrimmedPrice].volSumBid += tradeQty
    }

    // Update high and low
    const lastHigh = this.activeCandle.high ?? price
    const lastLow = this.activeCandle.low ?? price

    this.activeCandle.high = Math.max(lastHigh, price)
    this.activeCandle.low = Math.min(lastLow, price)
    this.activeCandle.close = price
  }
}
