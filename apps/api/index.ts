import express from 'express'

const app = express()

app.use(express.json())

app.get('/health', (_, res) => {
  res.json({ status: 'ok' })
})

app.listen(3000, () => {
  console.log('api running on :3000')
})
