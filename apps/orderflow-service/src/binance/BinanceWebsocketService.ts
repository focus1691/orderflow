import { Injectable } from '@nestjs/common'
import { Observable, Subject } from 'rxjs'
import { WebsocketClient, WsMessageAggTradeRaw } from 'binance'

@Injectable()
export class BinanceWebSocketService {
  private ws: WebsocketClient
  private tradeUpdates$: Subject<WsMessageAggTradeRaw> = new Subject()
  TradeData
  constructor() {
    this.initWebSocket()
  }

  get tradeUpdates(): Observable<WsMessageAggTradeRaw> {
    return this.tradeUpdates$.asObservable()
  }

  private initWebSocket(): void {
    this.ws = new WebsocketClient({})

    this.ws.on('message', (message: WsMessageAggTradeRaw) => {
      this.tradeUpdates$.next(message)
    })

    this.ws.on('open', (data) => {
      console.log('connection opened:', data.wsKey, data.ws.target.url)
    })

    this.ws.on('reconnecting', (data) => {
      console.log('ws automatically reconnecting.... ', data?.wsKey)
    })

    this.ws.on('reconnected', (data) => {
      console.log('ws has reconnected ', data?.wsKey)
    })

    this.ws.on('error', (data) => {
      console.log('ws saw error ', data?.wsKey)
    })
  }

  public subscribeToTrades(symbol: string, market: 'spot' | 'usdm' | 'coinm'): void {
    this.ws.subscribeAggregateTrades(symbol, market)
  }
}