type CandleResponse = {
  start: string
  end: string
  candles: Array<{
    time: number
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>
}

export async function fetchNqCandles() {
  const response = await fetch('/api/candles/nq')

  if (!response.ok) {
    throw new Error('Failed to fetch NQ candles')
  }

  return (await response.json()) as CandleResponse
}
