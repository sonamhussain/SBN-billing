import 'dotenv/config'
import { callApi, extractCookieHeader, isUuid } from '../a1-foundation/integration.http.ts'

const requiredEnv = [
  'A1_IT_BASE_URL',
  'A1_IT_ADMIN_EMAIL',
  'A1_IT_ADMIN_PASSWORD',
  'A1_IT_VIEWER_EMAIL',
  'A1_IT_VIEWER_PASSWORD',
  'A1_IT_ORGANIZATION_ID',
  'A1_IT_OTHER_ORGANIZATION_ID',
  'A2_IT_OTHER_ORG_PAYER_ID',
] as const

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[A2.10] missing required env var: ${key}`)
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
const otherOrgPayerId = process.env.A2_IT_OTHER_ORG_PAYER_ID!

const runId = Date.now().toString()

let passCount = 0
let failCount = 0

function record(name: string, pass: boolean, detail?: string) {
  if (pass) passCount += 1
  else failCount += 1
  const dots = '.'.repeat(Math.max(2, 34 - name.length))
  console.log(`[A2.10] ${name} ${dots} ${pass ? 'PASS' : 'FAIL'}${detail ? ' - ' + detail : ''}`)
}

function assertStatus(name: string, status: number, expected: number, extraOk = true, detail?: string) {
  record(name, status === expected && extraOk, detail ?? `expected ${expected} got ${status}`)
}

function requestIdSafe(requestId: string | null, headerRequestId: string | null): boolean {
  return isUuid(requestId) && requestId === headerRequestId
}

type SimpleMasterConfig = {
  testNumber: string
  label: string
  collectionPath: string
  createdAction: string
  updatedAction: string
  entityType: string
}

const simpleMasters: SimpleMasterConfig[] = [
  { testNumber: 'T10', label: 'clinician', collectionPath: 'clinicians', createdAction: 'clinician.created', updatedAction: 'clinician.updated', entityType: 'CLINICIAN' },
  { testNumber: 'T11', label: 'specialty', collectionPath: 'specialties', createdAction: 'specialty.created', updatedAction: 'specialty.updated', entityType: 'SPECIALTY' },
  { testNumber: 'T12', label: 'payer', collectionPath: 'payers', createdAction: 'payer.created', updatedAction: 'payer.updated', entityType: 'PAYER' },
  { testNumber: 'T13', label: 'tpa', collectionPath: 'tpas', createdAction: 'tpa.created', updatedAction: 'tpa.updated', entityType: 'TPA' },
  { testNumber: 'T14', label: 'network', collectionPath: 'networks', createdAction: 'network.created', updatedAction: 'network.updated', entityType: 'NETWORK' },
]

type CodeMasterConfig = {
  flowTestNumber: string
  duplicateTestNumber: string
  label: string
  collectionPath: string
  byIdPath: string
  codeField: string
  createdAction: string
  updatedAction: string
  entityType: string
}

const codeMasters: CodeMasterConfig[] = [
  { flowTestNumber: 'T15', duplicateTestNumber: 'T16', label: 'service', collectionPath: 'services', byIdPath: 'services', codeField: 'internalCode', createdAction: 'service.created', updatedAction: 'service.updated', entityType: 'SERVICE' },
  { flowTestNumber: 'T17', duplicateTestNumber: 'T18', label: 'procedureCode', collectionPath: 'procedure-codes', byIdPath: 'procedure-codes', codeField: 'internalCode', createdAction: 'procedure_code.created', updatedAction: 'procedure_code.updated', entityType: 'PROCEDURE_CODE' },
  { flowTestNumber: 'T19', duplicateTestNumber: 'T20', label: 'diagnosisCode', collectionPath: 'diagnosis-codes', byIdPath: 'diagnosis-codes', codeField: 'code', createdAction: 'diagnosisCode.created', updatedAction: 'diagnosisCode.updated', entityType: 'DIAGNOSIS_CODE' },
]

const a2EntityTypes = [
  'CLINICIAN', 'SPECIALTY', 'PAYER', 'TPA', 'NETWORK', 'SERVICE', 'PROCEDURE_CODE', 'DIAGNOSIS_CODE', 'EXTERNAL_IDENTIFIER',
]

function countA2Events(items: any[]): number {
  if (!Array.isArray(items)) return -1
  return items.filter((e) => a2EntityTypes.includes(e?.entityType)).length
}

async function main() {
  console.log(`[A2.10] running against ${baseUrl} (runId=${runId})`)

  // T08 — admin sign-in
  const adminSignIn = await callApi(baseUrl, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  })
  const adminCookie = extractCookieHeader(adminSignIn.setCookies)
  assertStatus('T08 admin sign-in', adminSignIn.status, 200, adminCookie.length > 0)

  // T09 — admin /api/me
  const adminMe = await callApi(baseUrl, '/api/me', { headers: { Cookie: adminCookie } })
  assertStatus('T09 admin /api/me', adminMe.status, 200, adminMe.body?.user?.email === adminEmail)

  // ---- Positive happy-path flows for all nine A2 objects (audit snapshot taken only after these finish) ----

  const createdIds: Record<string, string> = {}
  const createdAuditIds: Record<string, string> = {}

  async function runSimpleMasterFlow(cfg: SimpleMasterConfig) {
    const displayName = `A210_${cfg.label.toUpperCase()}_${runId}`
    const create = await callApi(baseUrl, `/api/organizations/${organizationId}/${cfg.collectionPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ displayName }),
    })
    const id = create.body?.id
    if (typeof id === 'string') createdIds[cfg.label] = id

    const list = await callApi(baseUrl, `/api/organizations/${organizationId}/${cfg.collectionPath}`, { headers: { Cookie: adminCookie } })
    const get = id ? await callApi(baseUrl, `/api/${cfg.collectionPath}/${id}`, { headers: { Cookie: adminCookie } }) : { status: 0 }
    const updatedName = `${displayName}_UPD`
    const update = id
      ? await callApi(baseUrl, `/api/${cfg.collectionPath}/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ displayName: updatedName }),
        })
      : { status: 0, body: null }

    const pass =
      create.status === 201 &&
      list.status === 200 &&
      get.status === 200 &&
      update.status === 200 &&
      (update as any).body?.displayName === updatedName

    record(
      `${cfg.testNumber} ${cfg.label} flow`,
      pass,
      `create=${create.status} list=${list.status} get=${get.status} update=${update.status}`,
    )
  }

  for (const cfg of simpleMasters) {
    await runSimpleMasterFlow(cfg)
  }

  async function runCodeMasterFlow(cfg: CodeMasterConfig) {
    const codeValue = `A210_${cfg.label.toUpperCase()}_${runId}`
    const displayName = `A210_${cfg.label.toUpperCase()}_NAME_${runId}`
    const create = await callApi(baseUrl, `/api/organizations/${organizationId}/${cfg.collectionPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ [cfg.codeField]: codeValue, displayName }),
    })
    const id = create.body?.id
    if (typeof id === 'string') createdIds[cfg.label] = id

    const list = await callApi(baseUrl, `/api/organizations/${organizationId}/${cfg.collectionPath}`, { headers: { Cookie: adminCookie } })
    const get = id ? await callApi(baseUrl, `/api/${cfg.byIdPath}/${id}`, { headers: { Cookie: adminCookie } }) : { status: 0 }
    const updatedName = `${displayName}_UPD`
    const update = id
      ? await callApi(baseUrl, `/api/${cfg.byIdPath}/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({ displayName: updatedName }),
        })
      : { status: 0, body: null }

    const pass =
      create.status === 201 &&
      list.status === 200 &&
      get.status === 200 &&
      update.status === 200 &&
      (update as any).body?.displayName === updatedName &&
      (update as any).body?.[cfg.codeField] === codeValue

    record(
      `${cfg.flowTestNumber} ${cfg.label} flow`,
      pass,
      `create=${create.status} list=${list.status} get=${get.status} update=${update.status}`,
    )

    return { codeValue, displayName }
  }

  const codeMasterValues: Record<string, { codeValue: string; displayName: string }> = {}
  for (const cfg of codeMasters) {
    codeMasterValues[cfg.label] = await runCodeMasterFlow(cfg)
  }

  // T21 — ExternalIdentifier payer target create/list/get/update
  const extSourcePayer = `A210_EXT_PAYER_${runId}`
  const extValuePayer = `A210_EXT_VAL_PAYER_${runId}`
  const extPayerCreate = await callApi(baseUrl, `/api/organizations/${organizationId}/external-identifiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      sourceSystem: extSourcePayer,
      externalValue: extValuePayer,
      target: { type: 'PAYER', id: createdIds.payer },
    }),
  })
  const extPayerId = extPayerCreate.body?.id
  if (typeof extPayerId === 'string') createdIds.externalIdentifierPayer = extPayerId

  const extPayerList = await callApi(baseUrl, `/api/organizations/${organizationId}/external-identifiers`, { headers: { Cookie: adminCookie } })
  const extPayerGet = extPayerId ? await callApi(baseUrl, `/api/external-identifiers/${extPayerId}`, { headers: { Cookie: adminCookie } }) : { status: 0 }
  const extValuePayerUpdated = `${extValuePayer}_UPD`
  const extPayerUpdate = extPayerId
    ? await callApi(baseUrl, `/api/external-identifiers/${extPayerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ externalValue: extValuePayerUpdated }),
      })
    : { status: 0, body: null }

  record(
    'T21 externalIdentifier payer target flow',
    extPayerCreate.status === 201 &&
      extPayerCreate.body?.target?.type === 'PAYER' &&
      extPayerList.status === 200 &&
      extPayerGet.status === 200 &&
      extPayerUpdate.status === 200 &&
      (extPayerUpdate as any).body?.externalValue === extValuePayerUpdated &&
      (extPayerUpdate as any).body?.target?.type === 'PAYER' &&
      (extPayerUpdate as any).body?.target?.id === createdIds.payer,
    `create=${extPayerCreate.status} list=${extPayerList.status} get=${extPayerGet.status} update=${extPayerUpdate.status}`,
  )

  // T22 — ExternalIdentifier clinician target create/list/get
  const extSourceClin = `A210_EXT_CLIN_${runId}`
  const extValueClin = `A210_EXT_VAL_CLIN_${runId}`
  const extClinCreate = await callApi(baseUrl, `/api/organizations/${organizationId}/external-identifiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      sourceSystem: extSourceClin,
      externalValue: extValueClin,
      target: { type: 'CLINICIAN', id: createdIds.clinician },
    }),
  })
  const extClinId = extClinCreate.body?.id
  if (typeof extClinId === 'string') createdIds.externalIdentifierClinician = extClinId

  const extClinList = await callApi(baseUrl, `/api/organizations/${organizationId}/external-identifiers`, { headers: { Cookie: adminCookie } })
  const extClinGet = extClinId ? await callApi(baseUrl, `/api/external-identifiers/${extClinId}`, { headers: { Cookie: adminCookie } }) : { status: 0 }

  record(
    'T22 externalIdentifier clinician target flow',
    extClinCreate.status === 201 &&
      extClinCreate.body?.target?.type === 'CLINICIAN' &&
      extClinList.status === 200 &&
      extClinGet.status === 200,
    `create=${extClinCreate.status} list=${extClinList.status} get=${extClinGet.status}`,
  )

  // ---- Audit truth checks (read specific rows; safe to run any time after their create/update) ----

  async function fetchOrgAuditEvents(cookie: string) {
    const res = await callApi(baseUrl, `/api/organizations/${organizationId}/audit-events`, { headers: { Cookie: cookie } })
    return Array.isArray(res.body?.items) ? (res.body.items as any[]) : []
  }

  const auditAfterPositives = await fetchOrgAuditEvents(adminCookie)

  // T37 — create audit truth (clinician + external identifier representative)
  const clinicianCreatedEvent = auditAfterPositives.find(
    (e) => e.entityType === 'CLINICIAN' && e.entityId === createdIds.clinician && e.actionCode === 'clinician.created',
  )
  const extCreatedEvent = auditAfterPositives.find(
    (e) => e.entityType === 'EXTERNAL_IDENTIFIER' && e.entityId === createdIds.externalIdentifierPayer && e.actionCode === 'external_identifier.created',
  )
  record(
    'T37 create audit truth',
    !!clinicianCreatedEvent &&
      clinicianCreatedEvent.beforeState === null &&
      clinicianCreatedEvent.afterState?.displayName === `A210_CLINICIAN_${runId}` &&
      !!extCreatedEvent &&
      extCreatedEvent.beforeState === null &&
      extCreatedEvent.afterState?.sourceSystem === extSourcePayer,
  )

  // T38 — update audit truth (clinician representative)
  const clinicianUpdatedEvent = auditAfterPositives.find(
    (e) => e.entityType === 'CLINICIAN' && e.entityId === createdIds.clinician && e.actionCode === 'clinician.updated',
  )
  record(
    'T38 update audit truth',
    !!clinicianUpdatedEvent &&
      clinicianUpdatedEvent.beforeState?.displayName === `A210_CLINICIAN_${runId}` &&
      clinicianUpdatedEvent.afterState?.displayName === `A210_CLINICIAN_${runId}_UPD`,
  )

  // T39 — external identifier audit target preserved
  const extUpdatedEvent = auditAfterPositives.find(
    (e) => e.entityType === 'EXTERNAL_IDENTIFIER' && e.entityId === createdIds.externalIdentifierPayer && e.actionCode === 'external_identifier.updated',
  )
  record(
    'T39 externalIdentifier audit target',
    !!extUpdatedEvent &&
      extUpdatedEvent.beforeState?.targetType === 'PAYER' &&
      extUpdatedEvent.afterState?.targetType === 'PAYER' &&
      extUpdatedEvent.beforeState?.targetId === createdIds.payer &&
      extUpdatedEvent.afterState?.targetId === createdIds.payer,
  )

  // T41 — historical truth: the original create snapshot must not have been mutated by the later update
  record(
    'T41 historical truth',
    !!clinicianCreatedEvent && clinicianCreatedEvent.afterState?.displayName === `A210_CLINICIAN_${runId}`,
    clinicianCreatedEvent?.afterState?.displayName === `A210_CLINICIAN_${runId}`
      ? undefined
      : 'create snapshot was mutated by a later update',
  )

  // ---- Audit BEFORE snapshot for the focused no-false-audit gate ----
  const auditBeforeDenied = countA2Events(auditAfterPositives)

  // ---- Negative / security matrix (must create NO audit rows) ----

  // T16/T18/T20 — duplicate code masters
  for (const cfg of codeMasters) {
    const dup = await callApi(baseUrl, `/api/organizations/${organizationId}/${cfg.collectionPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        [cfg.codeField]: codeMasterValues[cfg.label].codeValue,
        displayName: `A210_${cfg.label.toUpperCase()}_DUP_${runId}`,
      }),
    })
    record(
      `${cfg.duplicateTestNumber} ${cfg.label} duplicate rejected`,
      dup.status === 400 && dup.body?.error?.code === 'VALIDATION_ERROR' && requestIdSafe(dup.body?.error?.requestId, dup.requestId),
      `expected 400 got ${dup.status}`,
    )
  }

  // T23 — external identifier duplicate same org+sourceSystem+externalValue
  const extDup = await callApi(baseUrl, `/api/organizations/${organizationId}/external-identifiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ sourceSystem: extSourcePayer, externalValue: extValuePayerUpdated, target: { type: 'PAYER', id: createdIds.payer } }),
  })
  record(
    'T23 externalIdentifier duplicate rejected',
    extDup.status === 400 && extDup.body?.error?.code === 'VALIDATION_ERROR',
    `expected 400 got ${extDup.status}`,
  )

  // T24 — external identifier missing target (valid-shaped UUID, no such record)
  const extMissingTarget = await callApi(baseUrl, `/api/organizations/${organizationId}/external-identifiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      sourceSystem: `A210_EXT_MISSING_${runId}`,
      externalValue: `A210_EXT_MISSING_VAL_${runId}`,
      target: { type: 'PAYER', id: '99999999-9999-4999-8999-999999999999' },
    }),
  })
  record(
    'T24 externalIdentifier missing target',
    (extMissingTarget.status === 404 || extMissingTarget.status === 400) &&
      (extMissingTarget.body?.error?.code === 'NOT_FOUND' || extMissingTarget.body?.error?.code === 'VALIDATION_ERROR'),
    `status=${extMissingTarget.status}`,
  )

  // T25 — external identifier foreign target (other organization's payer)
  const extForeignTarget = await callApi(baseUrl, `/api/organizations/${organizationId}/external-identifiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      sourceSystem: `A210_EXT_FOREIGN_${runId}`,
      externalValue: `A210_EXT_FOREIGN_VAL_${runId}`,
      target: { type: 'PAYER', id: otherOrgPayerId },
    }),
  })
  record(
    'T25 externalIdentifier foreign target',
    extForeignTarget.status === 403 && extForeignTarget.body?.error?.code === 'FORBIDDEN',
    `expected 403 got ${extForeignTarget.status}`,
  )

  // T26 — external identifier target immutable (target / targetType / targetId all rejected)
  const targetPatchAttempts = [
    { target: { type: 'CLINICIAN', id: createdIds.clinician } },
    { targetType: 'CLINICIAN' },
    { targetId: createdIds.clinician },
  ]
  let targetImmutablePass = true
  for (const body of targetPatchAttempts) {
    const res = await callApi(baseUrl, `/api/external-identifiers/${createdIds.externalIdentifierPayer}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify(body),
    })
    if (!(res.status === 400 && res.body?.error?.code === 'VALIDATION_ERROR')) targetImmutablePass = false
  }
  record('T26 externalIdentifier target immutable', targetImmutablePass)

  // T27 — viewer sign-in
  const viewerSignIn = await callApi(baseUrl, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: viewerEmail, password: viewerPassword }),
  })
  const viewerCookie = extractCookieHeader(viewerSignIn.setCookies)
  assertStatus('T27 viewer sign-in', viewerSignIn.status, 200, viewerCookie.length > 0)

  // T28 — viewer reads all nine A2 object types
  const allCollections = [
    ...simpleMasters.map((c) => c.collectionPath),
    ...codeMasters.map((c) => c.collectionPath),
    'external-identifiers',
  ]
  let viewerReadsPass = true
  const viewerReadDetails: string[] = []
  for (const path of allCollections) {
    const res = await callApi(baseUrl, `/api/organizations/${organizationId}/${path}`, { headers: { Cookie: viewerCookie } })
    viewerReadDetails.push(`${path}=${res.status}`)
    if (res.status !== 200) viewerReadsPass = false
  }
  record('T28 viewer reads all nine object types', viewerReadsPass, viewerReadDetails.join(' '))

  // T29 — viewer write denial: simple masters
  let simpleWriteDenialPass = true
  for (const cfg of simpleMasters) {
    const create = await callApi(baseUrl, `/api/organizations/${organizationId}/${cfg.collectionPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ displayName: `A210_VIEWER_${cfg.label}_${runId}` }),
    })
    const update = createdIds[cfg.label]
      ? await callApi(baseUrl, `/api/${cfg.collectionPath}/${createdIds[cfg.label]}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
          body: JSON.stringify({ displayName: 'Viewer Should Not Update' }),
        })
      : { status: 0 }
    if (create.status !== 403 || update.status !== 403) simpleWriteDenialPass = false
  }
  record('T29 viewer write denial simple masters', simpleWriteDenialPass)

  // T30 — viewer write denial: code masters
  let codeWriteDenialPass = true
  for (const cfg of codeMasters) {
    const create = await callApi(baseUrl, `/api/organizations/${organizationId}/${cfg.collectionPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ [cfg.codeField]: `A210_VIEWER_${cfg.label}_${runId}`, displayName: 'Viewer Try' }),
    })
    const update = createdIds[cfg.label]
      ? await callApi(baseUrl, `/api/${cfg.byIdPath}/${createdIds[cfg.label]}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
          body: JSON.stringify({ displayName: 'Viewer Should Not Update' }),
        })
      : { status: 0 }
    if (create.status !== 403 || update.status !== 403) codeWriteDenialPass = false
  }
  record('T30 viewer write denial code masters', codeWriteDenialPass)

  // T31 — viewer write denial: external identifier
  const extViewerCreate = await callApi(baseUrl, `/api/organizations/${organizationId}/external-identifiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ sourceSystem: 'X', externalValue: 'Y', target: { type: 'PAYER', id: createdIds.payer } }),
  })
  const extViewerUpdate = await callApi(baseUrl, `/api/external-identifiers/${createdIds.externalIdentifierPayer}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ externalValue: 'Hack' }),
  })
  record('T31 viewer write denial externalIdentifier', extViewerCreate.status === 403 && extViewerUpdate.status === 403)

  // T32 — cross-tenant collection denial for all A2 org-scoped list routes
  let crossTenantCollectionPass = true
  const crossTenantDetails: string[] = []
  for (const path of allCollections) {
    const res = await callApi(baseUrl, `/api/organizations/${otherOrganizationId}/${path}`, { headers: { Cookie: adminCookie } })
    crossTenantDetails.push(`${path}=${res.status}`)
    if (res.status !== 403) crossTenantCollectionPass = false
  }
  record('T32 cross-tenant collection denial', crossTenantCollectionPass, crossTenantDetails.join(' '))

  // T33 — cross-tenant by-ID denial (foreign representative resource)
  const foreignById = await callApi(baseUrl, `/api/payers/${otherOrgPayerId}`, { headers: { Cookie: adminCookie } })
  record('T33 cross-tenant by-ID denial', foreignById.status === 403 || foreignById.status === 404, `status=${foreignById.status}`)

  // T34 — blank/invalid inputs
  const blankClinician = await callApi(baseUrl, `/api/organizations/${organizationId}/clinicians`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ displayName: '   ' }),
  })
  record(
    'T34 blank/invalid inputs',
    blankClinician.status === 400 && blankClinician.body?.error?.code === 'VALIDATION_ERROR' && requestIdSafe(blankClinician.body?.error?.requestId, blankClinician.requestId),
  )

  // T35 — missing resources
  const missingClinician = await callApi(baseUrl, '/api/clinicians/99999999-9999-4999-8999-999999999999', { headers: { Cookie: adminCookie } })
  record(
    'T35 missing resources',
    missingClinician.status === 404 && missingClinician.body?.error?.code === 'NOT_FOUND' && requestIdSafe(missingClinician.body?.error?.requestId, missingClinician.requestId),
  )

  // T36 — malformed by-ID routes (never 500)
  const malformedClinician = await callApi(baseUrl, '/api/clinicians/not-a-valid-uuid', { headers: { Cookie: adminCookie } })
  record(
    'T36 malformed by-ID routes',
    malformedClinician.status === 404 && malformedClinician.body?.error?.code === 'NOT_FOUND',
    `expected 404 got ${malformedClinician.status}`,
  )

  // ---- T40 — focused no-false-audit gate ----
  const auditAfterDenied = await fetchOrgAuditEvents(adminCookie)
  const auditAfterDeniedCount = countA2Events(auditAfterDenied)
  record('T40 no false audit', auditBeforeDenied === auditAfterDeniedCount, `before=${auditBeforeDenied} after=${auditAfterDeniedCount}`)

  // ---- T46/T47 — health/readiness remain healthy throughout ----
  const health = await callApi(baseUrl, '/api/health')
  assertStatus('T46 API health', health.status, 200, health.body?.status === 'ok')

  const ready = await callApi(baseUrl, '/api/ready')
  assertStatus('T47 API readiness', ready.status, 200, ready.body?.database === 'connected')

  console.log(`[A2.10] automated summary: ${passCount}/${passCount + failCount} PASS`)
  process.exitCode = failCount > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('[A2.10] integration runner crashed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
