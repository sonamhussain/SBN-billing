import { Router } from 'express'
import { isDatabaseReady } from '../shared/database/readiness.ts'

const readyRouter = Router()

readyRouter.get('/', async (_req, res) => {
  const databaseReady = await isDatabaseReady()

  if (!databaseReady) {
    res.status(503).json({
      status: 'not_ready',
      service: 'sbn-billing-api',
      database: 'unavailable',
      timestamp: new Date().toISOString(),
    })
    return
  }

  res.status(200).json({
    status: 'ready',
    service: 'sbn-billing-api',
    database: 'connected',
    timestamp: new Date().toISOString(),
  })
})

export default readyRouter
