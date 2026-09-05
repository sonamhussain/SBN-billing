import express from 'express'
import { toNodeHandler } from 'better-auth/node'
import { auth } from './shared/auth/auth.ts'
import { requestIdMiddleware } from './shared/http/request-id.middleware.ts'
import { apiNotFoundHandler, apiErrorHandler } from './shared/errors/error.middleware.ts'
import healthRouter from './routes/health.route.ts'
import readyRouter from './routes/ready.route.ts'
import organizationRouter from './modules/organization/organization.route.ts'
import { organizationFacilityRouter, facilityRouter } from './modules/facility/facility.route.ts'
import meRouter from './routes/me.route.ts'
import accessRouter from './modules/access/access.route.ts'
import { auditRouter } from './modules/audit/audit.route.ts'
import { organizationClinicianRouter, clinicianRouter } from './modules/clinician/clinician.route.ts'

export const app = express()

// A1.8 request correlation — response header only
app.use(requestIdMiddleware)

// A1.5 Better Auth must remain before express.json()
app.all('/api/auth/*splat', toNodeHandler(auth))

app.use(express.json())

// existing routes — keep order/contracts
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

// A2.1
app.use('/api/organizations', organizationClinicianRouter)
app.use('/api/clinicians', clinicianRouter)

// A1.8 — LAST
app.use('/api', apiNotFoundHandler)
app.use(apiErrorHandler)
