/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { FindManyOptions, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm'
import { CandleUniqueColumns, FootPrintCandle } from '@database/entity/footprint_candle.entity'
import { IFootPrintClosedCandle } from '@orderflow/dto/orderflow.dto'
import { CACHE_LIMIT } from '@tsquant/exchangeapi/dist/lib/constants/exchange'
import { SymbolIntervalTimestampRangeDictionary } from '@tsquant/exchangeapi/dist/lib/types'

@Injectable()
export class DatabaseService {
  private logger: Logger = new Logger(DatabaseService.name)

  constructor(
    @InjectRepository(FootPrintCandle)
    private footprintCandleRepository: Repository<FootPrintCandle>
  ) {}

  async batchSaveFootPrintCandles(candles: IFootPrintClosedCandle[]): Promise<string[]> {
    const saved: string[] = []
    const totalCandles = candles.length
    try {
      for (let index = 0; index < totalCandles; index++) {
        const candle = candles[index]
        this.logger.log(`Processing candle ${index + 1}/${totalCandles}, ${candle.interval} ${candle.openTime}`)
        const cleanedCandle = { ...candle }
        delete cleanedCandle.uuid

        await this.footprintCandleRepository.upsert(cleanedCandle, {
          conflictPaths: CandleUniqueColumns,
          upsertType: 'on-conflict-do-update',
          skipUpdateIfNoValuesChanged: true
        })

        if (candle?.uuid) saved.push(candle.uuid)
      }
    } catch (error) {
      console.error('Error bulk inserting FootPrintCandles:', error)
    }
    return saved
  }

  async getTestCandles(): Promise<FootPrintCandle[]> {
    const query = this.footprintCandleRepository.createQueryBuilder('candle').select('*').where('candle.id IN (1,2,3,4)')

    try {
      return await query.getRawMany()
    } catch (error) {
      console.error('Error getTestCandles', error)
      throw error
    }
  }

  async getCandles(exchange: string, symbol: string, interval: string, openTime?: Date, closeTime?: Date): Promise<IFootPrintClosedCandle[]> {
    try {
      const whereConditions = {
        exchange,
        symbol,
        interval
      }

      if (openTime) {
        whereConditions['openTime'] = MoreThanOrEqual(openTime)
      }

      if (closeTime) {
        whereConditions['closeTime'] = LessThanOrEqual(closeTime)
      }

      const queryOptions: FindManyOptions<FootPrintCandle> = {
        where: whereConditions,
        order: { openTime: 'ASC' as const }
      }

      const rows = await this.footprintCandleRepository.find(queryOptions)

      const candles: IFootPrintClosedCandle[] = rows.map(
        (row) =>
          ({
            ...row,
            didPersistToStore: true,
            isClosed: true,
            openTime: new Date(row.openTime).toISOString(),
            closeTime: new Date(row.closeTime).toISOString()
          } as IFootPrintClosedCandle)
      )

      return candles
    } catch (error) {
      console.error('Error fetching aggregated candles:', error)
      throw error
    }
  }

  async pruneOldData(): Promise<void> {
    try {
      await this.footprintCandleRepository.query(`
        WITH ranked_rows AS (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY exchange, symbol, interval ORDER BY "openTime" DESC
          ) row_number
          FROM footprint_candle
        )
        DELETE FROM footprint_candle
        WHERE id IN (
          SELECT id FROM ranked_rows WHERE row_number > ${CACHE_LIMIT}
        )
      `)
    } catch (err) {
      this.logger.error('Failed to prune old data:', err)
    }
  }

  /** Fetch the last and first stored timestamp data to understand the range of stored data. Timestamp is the openTime for kLines */
  async getTimestampRange(exchange: string, symbol?: string): Promise<SymbolIntervalTimestampRangeDictionary> {
    try {
      const params = symbol ? [exchange, symbol] : [exchange]
      const query = `
      SELECT symbol, interval, MAX("openTime") as max_timestamp, MIN("openTime") as min_timestamp
      FROM footprint_candle
      WHERE exchange = $1${symbol ? ' AND symbol = $2' : ''}
      GROUP BY symbol, interval
    `

      const result = await this.footprintCandleRepository.query(query, params)
      const resultMap: SymbolIntervalTimestampRangeDictionary = {}

      result.forEach((row) => {
        if (!resultMap[row.symbol]) {
          resultMap[row.symbol] = {}
        }
        resultMap[row.symbol][row.interval] = {
          last: row.max_timestamp ? new Date(row.max_timestamp).getTime() : 0,
          first: row.min_timestamp ? new Date(row.min_timestamp).getTime() : 0
        }
      })

      return resultMap
    } catch (err) {
      this.logger.error('Failed to retrieve timestamp ranges:', err)
      return {}
    }
  }
}
