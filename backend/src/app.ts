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
import { organizationSpecialtyRouter, specialtyRouter } from './modules/specialty/specialty.route.ts'
import { organizationPayerRouter, payerRouter } from './modules/payer/payer.route.ts'
import { organizationTpaRouter, tpaRouter } from './modules/tpa/tpa.route.ts'
import { organizationNetworkRouter, networkRouter } from './modules/network/network.route.ts'
import { organizationServiceRouter, serviceRouter } from './modules/service/service.route.ts'
import { organizationProcedureCodeRouter, procedureCodeRouter } from './modules/procedure-code/procedure-code.route.ts'
import { organizationDiagnosisCodeRouter, diagnosisCodeRouter } from './modules/diagnosis-code/diagnosis-code.route.ts'
import { organizationExternalIdentifierRouter, externalIdentifierRouter } from './modules/external-identifier/external-identifier.route.ts'
import { organizationRuleSourceRouter, ruleSourceRouter } from './modules/rule-source/rule-source.route.ts'
import { sourceVersionsRouter, ruleSourceVersionRouter } from './modules/rule-source-version/rule-source-version.route.ts'
import { versionInterpretationsRouter, sourceInterpretationRouter } from './modules/source-interpretation/source-interpretation.route.ts'

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

// A2.2
app.use('/api/organizations', organizationSpecialtyRouter)
app.use('/api/specialties', specialtyRouter)

// A2.3
app.use('/api/organizations', organizationPayerRouter)
app.use('/api/payers', payerRouter)

// A2.4
app.use('/api/organizations', organizationTpaRouter)
app.use('/api/tpas', tpaRouter)

// A2.5
app.use('/api/organizations', organizationNetworkRouter)
app.use('/api/networks', networkRouter)

// A2.6
app.use('/api/organizations', organizationServiceRouter)
app.use('/api/services', serviceRouter)

// A2.7
app.use('/api/organizations', organizationProcedureCodeRouter)
app.use('/api/procedure-codes', procedureCodeRouter)

// A2.8
app.use('/api/organizations', organizationDiagnosisCodeRouter)
app.use('/api/diagnosis-codes', diagnosisCodeRouter)

// A2.9
app.use('/api/organizations', organizationExternalIdentifierRouter)
app.use('/api/external-identifiers', externalIdentifierRouter)

// A3.1
app.use('/api/organizations', organizationRuleSourceRouter)
app.use('/api/rule-sources', ruleSourceRouter)

// A3.2
app.use('/api/rule-sources', sourceVersionsRouter)
app.use('/api/rule-source-versions', ruleSourceVersionRouter)
app.use('/api/rule-source-versions', versionInterpretationsRouter)
app.use('/api/source-interpretations', sourceInterpretationRouter)

// A1.8 — LAST
app.use('/api', apiNotFoundHandler)
app.use(apiErrorHandler)
