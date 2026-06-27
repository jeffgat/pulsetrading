import { useQuery } from '@tanstack/react-query'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchNqCandles } from '@/api/candles'
import { QueryKeys } from '@/api/_query_keys'

type Timeframe = '1' | '3' | '5'

const timeframes: Timeframe[] = ['1', '3', '5']

function aggregateCandles(
  candles: CandlestickData<Time>[],
  timeframe: Timeframe,
) {
  const multiplier = Number(timeframe)

  if (multiplier === 1) {
    return candles
  }

  const buckets = new Map<number, CandlestickData<Time>>()

  for (const candle of candles) {
    const timestamp = Number(candle.time)
    const bucketTime = timestamp - (timestamp % (multiplier * 60))
    const existing = buckets.get(bucketTime)

    if (!existing) {
      buckets.set(bucketTime, {
        time: bucketTime as Time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })
      continue
    }

    existing.high = Math.max(existing.high, candle.high)
    existing.low = Math.min(existing.low, candle.low)
    existing.close = candle.close
  }

  return Array.from(buckets.values()).sort(
    (left, right) => Number(left.time) - Number(right.time),
  )
}

export function LightweightChartView() {
  const chartContainerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const [timeframe, setTimeframe] = useState<Timeframe>('1')

  const { data, error, isPending } = useQuery({
    queryKey: [QueryKeys.CANDLES, 'nq'],
    queryFn: fetchNqCandles,
  })

  const candles = useMemo<CandlestickData<Time>[]>(() => {
    return (
      data?.candles.map((candle) => ({
        time: candle.time as Time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })) ?? []
    )
  }, [data])

  const visibleCandles = useMemo(() => {
    return aggregateCandles(candles, timeframe)
  }, [candles, timeframe])

  useEffect(() => {
    const container = chartContainerRef.current

    if (!container) {
      return
    }

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#111111' },
        textColor: '#d4d4d4',
      },
      grid: {
        horzLines: { color: '#242424' },
        vertLines: { color: '#242424' },
      },
      crosshair: {
        mode: 0,
      },
      rightPriceScale: {
        borderColor: '#333333',
      },
      timeScale: {
        borderColor: '#333333',
        rightOffset: 12,
        barSpacing: 8,
        timeVisible: true,
        secondsVisible: false,
      },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.25,
      },
    })

    chartRef.current = chart
    candleSeriesRef.current = candleSeries

    return () => {
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!candleSeriesRef.current) {
      return
    }

    candleSeriesRef.current.setData(visibleCandles)
    chartRef.current?.timeScale().fitContent()
  }, [visibleCandles])

  return (
    <section className="flex h-full min-h-[520px] w-[800px] flex-col overflow-hidden bg-[#111111]">
      <div className="flex min-h-14 items-center justify-between border-b border-white/10 px-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">NQ</p>
          <p className="text-xs text-neutral-400">Nasdaq 100 futures</p>
        </div>

        <div className="flex rounded-md border border-white/10 bg-white/10 p-1">
          {timeframes.map((value) => (
            <button
              className={`h-8 min-w-10 rounded-sm px-3 text-sm font-medium transition ${
                timeframe === value
                  ? 'bg-white text-neutral-950'
                  : 'text-neutral-300 hover:bg-white/10 hover:text-white'
              }`}
              key={value}
              onClick={() => setTimeframe(value)}
              type="button"
            >
              {value}m
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0" ref={chartContainerRef} />

        {isPending ? (
          <div className="absolute inset-0 grid place-items-center bg-[#111111] text-sm text-neutral-400">
            Loading NQ candles...
          </div>
        ) : null}

        {error ? (
          <div className="absolute inset-0 grid place-items-center bg-[#111111] px-6 text-center text-sm text-red-300">
            {error.message}
          </div>
        ) : null}
      </div>
    </section>
  )
}
