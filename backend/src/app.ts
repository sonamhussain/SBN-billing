import express from 'express'
import healthRouter from './routes/health.route.ts'
import readyRouter from './routes/ready.route.ts'
import organizationRouter from './modules/organization/organization.route.ts'

export const app = express()

app.use(express.json())
app.use('/api', healthRouter)
app.use('/api/ready', readyRouter)
app.use('/api/organizations', organizationRouter)
