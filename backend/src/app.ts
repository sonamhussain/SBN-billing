import express from 'express'
import healthRouter from './routes/health.route.ts'

export const app = express()

app.use(express.json())
app.use('/api', healthRouter)
