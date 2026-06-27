import { config } from 'dotenv'
import express from 'express'
import { routes } from './routes.js'

config({ path: '../.env', override: false })
config({ path: '.env', override: true })
config({ path: 'server/.env', override: true })

async function main() {
  const app = express()
  const port = Number(process.env.PORT ?? 3000)

  app.use(express.json())
  app.use(routes)

  app.get('/health', (_, res) => {
    res.json({ status: 'ok' })
  })

  app.listen(port, () => {
    console.log(`api running on :${port}`)
  })
}

main().catch((err) => {
  console.log('failed to execute main')
  console.error(err)
  process.exit(1)
})
