import { Router } from 'express'

const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'sbn-billing-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  })
})

export default healthRouter
