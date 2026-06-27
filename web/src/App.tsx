import { useQuery } from '@tanstack/react-query'
import { QueryKeys } from './api/_query_keys'
import { fetchNqCandles } from './api/candles'
import { ChartView } from './components/chart-view'

function App() {
  const { data, error, isPending } = useQuery({
    queryKey: [QueryKeys.CANDLES, 'nq'],
    queryFn: fetchNqCandles,
  })
  console.log('data', data)

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-800">
      <section className="">
        <ChartView />
        <div className="m-2">
          {isPending ? (
            <p className="text-neutral-300">Loading NQ candles...</p>
          ) : error ? (
            <p className="text-red-300">{error.message}</p>
          ) : (
            <p className="text-neutral-300">
              Loaded {data.candles.length} NQ candles
            </p>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
