import express from 'express'
import { toNodeHandler } from 'better-auth/node'
import { auth } from './shared/auth/auth.ts'
import healthRouter from './routes/health.route.ts'
import readyRouter from './routes/ready.route.ts'
import organizationRouter from './modules/organization/organization.route.ts'
import { organizationFacilityRouter, facilityRouter } from './modules/facility/facility.route.ts'
import meRouter from './routes/me.route.ts'
import accessRouter from './modules/access/access.route.ts'
import { auditRouter } from './modules/audit/audit.route.ts'

export const app = express()

// Better Auth must read the raw request before express.json()
app.all('/api/auth/*splat', toNodeHandler(auth))

app.use(express.json())
app.use('/api', healthRouter)
app.use('/api/ready', readyRouter)
app.use('/api/organizations', organizationRouter)

// A1.4
app.use('/api/organizations', organizationFacilityRouter)
app.use('/api/facilities', facilityRouter)

// A1.5
app.use('/api', meRouter)

// A1.6
app.use('/api/access', accessRouter)

// A1.7
app.use('/api/organizations', auditRouter)
