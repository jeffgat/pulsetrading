import { Router } from 'express'
import type { Router as ExpressRouter } from 'express'
import { fetchNqCandlesFromRithmic } from './rithmic.js'

export const routes: ExpressRouter = Router()

routes.get('/api/candles/nq', async (_, res) => {
  try {
    const result = await fetchNqCandlesFromRithmic()
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'failed to fetch candles',
    })
  }
})
