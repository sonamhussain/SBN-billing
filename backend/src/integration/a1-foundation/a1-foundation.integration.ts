import 'dotenv/config'
import { callApi, extractCookieHeader, isUuid } from './integration.http.ts'
import { runWorkerAcceptance } from './integration.worker.ts'

const requiredEnv = [
  'A1_IT_BASE_URL',
  'A1_IT_ADMIN_EMAIL',
  'A1_IT_ADMIN_PASSWORD',
  'A1_IT_VIEWER_EMAIL',
  'A1_IT_VIEWER_PASSWORD',
  'A1_IT_ORGANIZATION_ID',
  'A1_IT_OTHER_ORGANIZATION_ID',
  'A1_IT_FACILITY_ID',
] as const

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[A1.10] missing required env var: ${key}`)
    process.exit(1)
  }
}

const baseUrl = process.env.A1_IT_BASE_URL!
const adminEmail = process.env.A1_IT_ADMIN_EMAIL!
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD!
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL!
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD!
const organizationId = process.env.A1_IT_ORGANIZATION_ID!
const otherOrganizationId = process.env.A1_IT_OTHER_ORGANIZATION_ID!
const facilityId = process.env.A1_IT_FACILITY_ID!

let passCount = 0
let failCount = 0

function record(name: string, pass: boolean, detail?: string) {
  if (pass) passCount += 1
  else failCount += 1
  const dots = '.'.repeat(Math.max(2, 34 - name.length))
  console.log(`[A1.10] ${name} ${dots} ${pass ? 'PASS' : 'FAIL'}${detail ? ' - ' + detail : ''}`)
}

function assertStatus(name: string, status: number, expected: number, extraOk = true) {
  record(name, status === expected && extraOk, `expected ${expected} got ${status}`)
}

function requestIdSafe(requestId: string | null, headerRequestId: string | null): boolean {
  return isUuid(requestId) && requestId === headerRequestId
}

async function main() {
  console.log(`[A1.10] running against ${baseUrl}`)

  // T06 — health + ready
  const health = await callApi(baseUrl, '/api/health')
  assertStatus('T06 health', health.status, 200, health.body?.status === 'ok')

  const ready = await callApi(baseUrl, '/api/ready')
  assertStatus('T06 ready', ready.status, 200, ready.body?.database === 'connected')

  // T07 — admin sign-in
  const adminSignIn = await callApi(baseUrl, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  })
  const adminCookie = extractCookieHeader(adminSignIn.setCookies)
  assertStatus('T07 admin sign-in', adminSignIn.status, 200, adminCookie.length > 0)

  // T08 — admin /api/me
  const adminMe = await callApi(baseUrl, '/api/me', { headers: { Cookie: adminCookie } })
  assertStatus('T08 admin /api/me', adminMe.status, 200, adminMe.body?.user?.email === adminEmail)

  // T09 — access proof
  const access = await callApi(baseUrl, `/api/access/organizations/${organizationId}`, {
    headers: { Cookie: adminCookie },
  })
  const hasAuditRead = Array.isArray(access.body?.permissions) && access.body.permissions.includes('audit.read')
  assertStatus('T09 access proof', access.status, 200, hasAuditRead)

  // T10 — organization read
  const orgRead = await callApi(baseUrl, `/api/organizations/${organizationId}`, {
    headers: { Cookie: adminCookie },
  })
  assertStatus('T10 organization read', orgRead.status, 200, orgRead.body?.id === organizationId)

  // T11 — organization update + audit
  const orgAuditBefore = await callApi(baseUrl, `/api/organizations/${organizationId}/audit-events`, {
    headers: { Cookie: adminCookie },
  })
  const auditCountBefore = Array.isArray(orgAuditBefore.body?.items) ? orgAuditBefore.body.items.length : 0

  const uniqueOrgName = `A1.10 IT Org ${Date.now()}`
  const orgUpdate = await callApi(baseUrl, `/api/organizations/${organizationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ name: uniqueOrgName }),
  })
  assertStatus('T11 organization update', orgUpdate.status, 200, orgUpdate.body?.name === uniqueOrgName)

  const orgAuditAfterUpdate = await callApi(baseUrl, `/api/organizations/${organizationId}/audit-events`, {
    headers: { Cookie: adminCookie },
  })
  const newestOrgEvent = orgAuditAfterUpdate.body?.items?.[0]
  const orgAuditCorrect =
    newestOrgEvent?.actionCode === 'organization.updated' &&
    newestOrgEvent?.afterState?.name === uniqueOrgName
  record('T11 organization audit', orgAuditCorrect, orgAuditCorrect ? undefined : 'audit row mismatch')

  // T12 — facility read
  const facilityRead = await callApi(baseUrl, `/api/facilities/${facilityId}`, {
    headers: { Cookie: adminCookie },
  })
  assertStatus('T12 facility read', facilityRead.status, 200, facilityRead.body?.organizationId === organizationId)

  // T13 — facility update + audit
  const uniqueFacilityName = `A1.10 IT Facility ${Date.now()}`
  const facilityUpdate = await callApi(baseUrl, `/api/facilities/${facilityId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ name: uniqueFacilityName }),
  })
  assertStatus('T13 facility update', facilityUpdate.status, 200, facilityUpdate.body?.name === uniqueFacilityName)

  const orgAuditAfterFacility = await callApi(baseUrl, `/api/organizations/${organizationId}/audit-events`, {
    headers: { Cookie: adminCookie },
  })
  const newestFacilityEvent = orgAuditAfterFacility.body?.items?.[0]
  const facilityAuditCorrect =
    newestFacilityEvent?.actionCode === 'facility.updated' &&
    newestFacilityEvent?.afterState?.name === uniqueFacilityName
  record('T13 facility audit', facilityAuditCorrect, facilityAuditCorrect ? undefined : 'audit row mismatch')

  // T07 (viewer) — viewer sign-in
  const viewerSignIn = await callApi(baseUrl, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: viewerEmail, password: viewerPassword }),
  })
  const viewerCookie = extractCookieHeader(viewerSignIn.setCookies)
  record('T14 viewer sign-in', viewerSignIn.status === 200 && viewerCookie.length > 0)

  // T14 — viewer read
  const viewerRead = await callApi(baseUrl, `/api/organizations/${organizationId}`, {
    headers: { Cookie: viewerCookie },
  })
  assertStatus('T14 viewer read', viewerRead.status, 200)

  // Admin audit read newest-first (re-check)
  const adminAuditList = await callApi(baseUrl, `/api/organizations/${organizationId}/audit-events`, {
    headers: { Cookie: adminCookie },
  })
  const newestFirst =
    Array.isArray(adminAuditList.body?.items) &&
    adminAuditList.body.items.length >= 2 &&
    new Date(adminAuditList.body.items[0].occurredAt).getTime() >=
      new Date(adminAuditList.body.items[1].occurredAt).getTime()
  record('T14 admin audit newest-first', adminAuditList.status === 200 && newestFirst)

  // capture audit count for false-audit check
  const auditCountBeforeFailures = Array.isArray(adminAuditList.body?.items) ? adminAuditList.body.items.length : 0

  // ---- Mandatory authorization + error integration flow ----

  // T15 — unauthenticated
  const noCookie = await callApi(baseUrl, `/api/organizations/${organizationId}`)
  record(
    'T15 unauthenticated',
    noCookie.status === 401 &&
      noCookie.body?.error?.code === 'UNAUTHENTICATED' &&
      requestIdSafe(noCookie.body?.error?.requestId, noCookie.requestId),
  )

  // T16 — viewer write denial
  const viewerWrite = await callApi(baseUrl, `/api/organizations/${organizationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ name: 'Viewer Should Not Update' }),
  })
  record(
    'T16 viewer write denial',
    viewerWrite.status === 403 &&
      viewerWrite.body?.error?.code === 'FORBIDDEN' &&
      requestIdSafe(viewerWrite.body?.error?.requestId, viewerWrite.requestId),
  )

  // T17 — viewer audit denial
  const viewerAudit = await callApi(baseUrl, `/api/organizations/${organizationId}/audit-events`, {
    headers: { Cookie: viewerCookie },
  })
  record(
    'T17 viewer audit denial',
    viewerAudit.status === 403 &&
      viewerAudit.body?.error?.code === 'FORBIDDEN' &&
      requestIdSafe(viewerAudit.body?.error?.requestId, viewerAudit.requestId),
  )

  // T18 — cross-tenant denial
  const crossTenant = await callApi(baseUrl, `/api/organizations/${otherOrganizationId}`, {
    headers: { Cookie: adminCookie },
  })
  record(
    'T18 cross-tenant denial',
    crossTenant.status === 403 &&
      crossTenant.body?.error?.code === 'FORBIDDEN' &&
      requestIdSafe(crossTenant.body?.error?.requestId, crossTenant.requestId),
  )

  // T19 — validation error
  const validationError = await callApi(baseUrl, `/api/organizations/${organizationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ name: '   ' }),
  })
  record(
    'T19 validation error',
    validationError.status === 400 &&
      validationError.body?.error?.code === 'VALIDATION_ERROR' &&
      requestIdSafe(validationError.body?.error?.requestId, validationError.requestId),
  )

  // T20 — missing resource
  const missingResource = await callApi(baseUrl, '/api/facilities/550e8400-e29b-41d4-a716-446655440000', {
    headers: { Cookie: adminCookie },
  })
  record(
    'T20 missing resource',
    missingResource.status === 404 &&
      missingResource.body?.error?.code === 'NOT_FOUND' &&
      requestIdSafe(missingResource.body?.error?.requestId, missingResource.requestId),
  )

  // T21 — unknown API route
  const unknownRoute = await callApi(baseUrl, '/api/this-route-does-not-exist')
  record(
    'T21 unknown API route',
    unknownRoute.status === 404 &&
      unknownRoute.body?.error?.code === 'NOT_FOUND' &&
      requestIdSafe(unknownRoute.body?.error?.requestId, unknownRoute.requestId),
  )

  // T22 — malformed JSON
  const malformedJson = await callApi(baseUrl, '/api/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name": "broken json"',
  })
  record(
    'T22 malformed JSON',
    malformedJson.status === 400 &&
      malformedJson.body?.error?.code === 'INVALID_JSON' &&
      requestIdSafe(malformedJson.body?.error?.requestId, malformedJson.requestId),
  )

  // T23 — false-audit check
  const auditAfterFailures = await callApi(baseUrl, `/api/organizations/${organizationId}/audit-events`, {
    headers: { Cookie: adminCookie },
  })
  const auditCountAfterFailures = Array.isArray(auditAfterFailures.body?.items)
    ? auditAfterFailures.body.items.length
    : -1
  record(
    'T23 no false audit',
    auditCountAfterFailures === auditCountBeforeFailures,
    `before=${auditCountBeforeFailures} after=${auditCountAfterFailures}`,
  )

  // T24 — sign-out closure
  const signOut = await callApi(baseUrl, '/api/auth/sign-out', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie, Origin: baseUrl },
    body: '{}',
  })
  const meAfterSignOut = await callApi(baseUrl, '/api/me', { headers: { Cookie: adminCookie } })
  record(
    'T24 sign-out closure',
    signOut.status === 200 &&
      meAfterSignOut.status === 401 &&
      requestIdSafe(meAfterSignOut.body?.error?.requestId, meAfterSignOut.requestId),
  )

  // T25 — worker coexistence
  const workerDemo = await runWorkerAcceptance(true)
  const healthDuringWorker = await callApi(baseUrl, '/api/health')
  record(
    'T25 worker demo success',
    workerDemo.sawReady && workerDemo.sawDemoSuccess,
  )
  record('T25 API stays healthy', healthDuringWorker.status === 200)
  record(
    'T25 worker graceful stop',
    workerDemo.gracefulStop,
    workerDemo.gracefulStop
      ? undefined
      : 'graceful SIGTERM could not be delivered in this environment (Windows sandbox limitation) — verify manually with npm run worker:dev + Ctrl+C',
  )

  console.log(`[A1.10] automated summary: ${passCount}/${passCount + failCount} PASS`)
  process.exitCode = failCount > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('[A1.10] integration runner crashed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
