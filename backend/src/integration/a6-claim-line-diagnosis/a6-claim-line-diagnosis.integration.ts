import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordReadinessAssessment } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'
import { createClaim } from '../../modules/claim/claim.service.ts'
import { createEncounterActivity } from '../../modules/encounter-activity/encounter-activity.service.ts'
import { createClaimLine, removeClaimLine, setClaimLineDiagnosisPointers } from '../../modules/claim-line/claim-line.service.ts'
import { createClaimDiagnosis } from '../../modules/claim-diagnosis/claim-diagnosis.service.ts'

// A6.2 — focused acceptance for Claim Line, Diagnosis & Source Traceability (T001–T130).
//
// Every Claim here is created through the A6.1 owner route from a READY_FOR_REVIEW A5.9 assessment of a
// synthetic A5.7 run whose findings name exact EncounterActivity and EncounterDiagnosis rows, so the
// bound handoff reference set is known exactly. Lines, diagnoses and pointers are built through the A6.2
// routes. ADVERSARIAL writes go in only to create a state no owner path can create (an incompatible
// assessment, two runs at one instant) or to prove that the database refuses them. Every value is
// synthetic and keyed by this run's id.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.2] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.2] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.2] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.2] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const gitArgs = (args: string[]) => (spawnSync('git', args, { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const git = (args: string) => gitArgs(args.split(' '))
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0
const gitGrep = (pattern: string, paths: string[]) => {
  const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
  return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
}

// Scope guards judge behaviour on committed production code, never vocabulary in comments or tests.
const committedFiles = (dir: string) => git(`ls-tree -r --name-only --full-tree HEAD ${dir}`).split(/\r?\n/).filter(Boolean)
const committedCode = (path: string) =>
  git(`show HEAD:${path}`)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
const committedProductionCodeOf = (dirs: string[]) => {
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A62-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// The corrected foundation A6.1 was built on: the A5.10 closure (158c9b7) and the A1 provisioning
// corrective (PR #68, 7632ef8). The A6.1 merge itself is found on main by its branch name, never assumed.
const a510Merge = '158c9b7c32b212e61ebcfe8e73ab93ff6f7f85d3'
const a1CorrectiveMerge = '7632ef86c6050c501ac6d5692206839d608daec3'
const a61Branch = 'feature/a6-1-claim-foundation-a5-handoff-binding'
const a62Branch = 'feature/a6-2-claim-line-diagnosis-source-traceability'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const LINE_DIR = 'backend/src/modules/claim-line'
const DX_DIR = 'backend/src/modules/claim-diagnosis'
const FE_LINE_DIR = 'frontend/src/modules/claim-line'
const FE_DX_DIR = 'frontend/src/modules/claim-diagnosis'
const HARNESS_DIR = 'backend/src/integration/a6-claim-line-diagnosis'
const A62_TABLES = ['claim_diagnoses', 'claim_line_diagnosis_pointers', 'claim_line_source_activities', 'claim_lines']
const A62_ACTIONS = [
  'claim_line.added',
  'claim_line.reordered',
  'claim_line.removed',
  'claim_diagnosis.added',
  'claim_diagnosis.reordered',
  'claim_diagnosis.removed',
  'claim_line_diagnoses.changed',
]

const deepKeys = (value: unknown, found: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) for (const item of value) deepKeys(item, found)
  else if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.add(key)
      deepKeys(child, found)
    }
  return found
}

async function attemptAdversarial(write: () => Promise<unknown>): Promise<string> {
  try {
    await write()
    return ''
  } catch (error) {
    return `${(error as { code?: string }).code ?? ''} ${String((error as Error).message ?? error)}`
  }
}

function failAt(probe: string, message: string) {
  clearConcurrencyProbes()
  setConcurrencyProbe(probe, async () => {
    throw new Error(message)
  })
}

function holdAt(probe: string) {
  clearConcurrencyProbes()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let reached: () => void = () => {}
  const arrived = new Promise<void>((resolve) => (reached = resolve))
  setConcurrencyProbe(probe, async () => {
    reached()
    await held
  })
  return { arrived, release }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SuiteLine = { id: string; verdict: 'PASS' | 'FAIL' | 'N/A'; line: string }
function suiteLines(output: string, tag: string): SuiteLine[] {
  const prefix = `[${tag}] `
  const rows: SuiteLine[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue
    const rest = line.slice(prefix.length)
    const id = rest.split(' ')[0]
    if (!/^T\d+(\/T\d+)?$/.test(id)) continue
    const verdict = / \.{3,} PASS/.test(rest) ? 'PASS' : / \.{3,} FAIL/.test(rest) ? 'FAIL' : / \.{3,} N\/A /.test(rest) ? 'N/A' : null
    if (verdict) rows.push({ id, verdict, line })
  }
  return rows
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sorted = (values: string[]) => [...values].sort()

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A6.2] A6.2 claim line, diagnosis & source traceability — run ${runId}`)
  console.log(`[A6.2] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

  const databaseUp = async () => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return true
    } catch {
      return false
    }
  }
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return true
      await pause(400)
    }
    return false
  }
  if (!(await waitFor(databaseUp, 60_000)))
    throw new RunAborted(`the database is not reachable, so no check can be judged. Start it with \`docker start ${dbContainer}\`, wait for it to report healthy, then run this suite again.`)

  const ready = async () => (await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0
  const health = async () => (await fetch(`${baseUrl}/api/health`).catch(() => null))?.status ?? 0
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000)))
      throw new RunAborted(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }
  const priorLinesAtStart = await prisma.claimLine.count({ where: { createdAt: { lt: runStartedAt } } })
  const priorDiagnosesAtStart = await prisma.claimDiagnosis.count({ where: { createdAt: { lt: runStartedAt } } })

  // ---------------------------------------------------------------- gates (T001–T006)
  section('Start gate, migration and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const a61Merge = gitArgs(['log', 'origin/main', '--merges', `--grep=${a61Branch}`, '-n', '1', '--format=%H'])
  const laterA6Code = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter((file) => /claim-pric|claim-integrity|claim-approval|claim-payload|claim-submission|tariff-rate/.test(file))
  check(
    'T001',
    'Start gate',
    branch === a62Branch &&
      a61Merge.length === 40 &&
      gitOk(`merge-base --is-ancestor ${a510Merge} origin/main`) &&
      gitOk(`merge-base --is-ancestor ${a1CorrectiveMerge} origin/main`) &&
      gitOk('merge-base --is-ancestor origin/main HEAD') &&
      laterA6Code.length === 0,
    `branch ${branch}; A6.1 merged on main as ${a61Merge.slice(0, 7) || 'NOT FOUND'}; the A5.10 closure and the A1 provisioning corrective are ancestors; this branch contains the latest main ${git('rev-parse --short origin/main')}; no A6.3+ code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check('T003', 'A6.1 ancestry', a61Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a61Merge} HEAD`), `the A6.1 merge ${a61Merge.slice(0, 7) || 'NOT FOUND'} is an ancestor of HEAD`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, ''))
  const schemaDiff = git('diff origin/main...HEAD -- :/backend/prisma/schema.prisma').split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const schemaAddedModels = schemaDiff.filter((l) => /^\+\s*model /.test(l)).map((l) => l.replace(/^\+\s*model\s+(\w+).*$/, '$1'))
  const relationLines = schemaDiff.filter((l) => /^\+\s+\w+\s+(ClaimLine|ClaimDiagnosis|ClaimLineSourceActivity|ClaimLineDiagnosisPointer)\[\]/.test(l))
  const scopeProblems = [
    [same(sorted(createdTables), A62_TABLES), `tables created: ${createdTables.join(', ')}`],
    [!/DROP (INDEX|TABLE|COLUMN)/.test(statements), 'something is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => A62_TABLES.some((table) => m.includes(`"${table}"`))), 'a table outside A6.2 is altered'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 10 && !/ON DELETE CASCADE|ON DELETE SET NULL/.test(statements), 'the ten foreign keys are not all ON DELETE RESTRICT'],
    [(statements.match(/CREATE (CONSTRAINT )?TRIGGER [a-z_]+_trg/g) ?? []).length === 9, 'the nine integrity/history triggers are not all created'],
    [(statements.match(/CREATE UNIQUE INDEX "[a-z_]+_uidx"/g) ?? []).length === 4, 'the four partial unique indexes are not all created'],
    [!/\b(price|amount|currency|rate|fee|status|state|approved\w*|payload|hash|xml|x12|npi|nabidh|malaffi|riayati|submission\w*|service_id|procedure_code_id|quantity|unit_code|modifier\w*|diagnosis_code_id|display_name)\b/i.test(statements), 'a copied source fact, price, lifecycle, payload or HIE column appears'],
    [schemaRemoved.length === 0 && same(sorted(schemaAddedModels), ['ClaimDiagnosis', 'ClaimLine', 'ClaimLineDiagnosisPointer', 'ClaimLineSourceActivity']) && relationLines.length === 10, 'the schema diff is not exactly the four models and their relations'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T004',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1
      ? `expected exactly one migration, found ${migrationPaths.length}`
      : scopeProblems.length === 0
        ? 'one migration; exactly the four A6.2 tables with ten RESTRICT foreign keys, four partial unique indexes and nine guards; the schema adds only the four models and their relations; no drift'
        : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const familyExpected = ['claimDiagnosis.create', 'claimDiagnosis.read', 'claimDiagnosis.update', 'claimLine.create', 'claimLine.read', 'claimLine.update']
  const family = allCodes.filter((code) => /^claim(Line|Diagnosis)\./.test(code)).sort()
  const familyGrants: string[] = []
  for (const code of familyExpected) familyGrants.push(`${code}=${await grantsOf(code)}`)
  const expectedGrants = familyExpected.map((code) => `${code}=${code.endsWith('.read') ? 'ORG_ADMIN,ORG_VIEWER' : 'ORG_ADMIN'}`)
  const invented = allCodes.filter((code) => /(approve|submit|transmit|pric|tariffRate|claimPayload|claimSubmission)/i.test(code))
  check(
    'T006',
    'Permissions',
    same(family, familyExpected) && same(familyGrants, expectedGrants) && invented.length === 0,
    invented.length === 0 ? 'claimLine.* and claimDiagnosis.* create/update for Admin, read for Admin and Viewer; no pricing, approval or transport permission' : `unexpected: ${invented.join(', ')}`,
  )

  // ---------------------------------------------------------------- fixtures
  await apiReady('signing in')
  let connectionResets = 0
  const httpCall = async (path: string, init?: RequestInit) => {
    try {
      return await callApi(baseUrl, path, init)
    } catch {
      connectionResets += 1
      throw new RunAborted(`the API connection was reset while calling ${path}. Start the API with \`npm start\` (never \`npm run dev\`) in a tab of its own, and run this suite again.`)
    }
  }
  const signIn = async (email: string, password: string) => {
    const res = await httpCall('/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email, password }) })
    return { status: res.status, cookie: extractCookieHeader(res.setCookies) }
  }
  const admin = await signIn(adminEmail, adminPassword)
  const viewer = await signIn(viewerEmail, viewerPassword)
  if (admin.status !== 200 || viewer.status !== 200) throw new Error(`sign-in failed (admin ${admin.status}, viewer ${viewer.status})`)
  const as = (cookie: string) => (init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, 'Content-Type': 'application/json', Cookie: cookie } })
  const asAdmin = as(admin.cookie)
  const asViewer = as(viewer.cookie)
  const anonymous = (init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, 'Content-Type': 'application/json' } })
  const api = async (method: string, path: string, body?: unknown, who = asAdmin) => {
    const res = await httpCall(path, who(body === undefined ? { method } : { method, body: JSON.stringify(body) }))
    return { status: res.status, body: res.body as any }
  }
  const post = (path: string, body: unknown) => api('POST', path, body)
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const viewerUserId = (await prisma.user.findFirstOrThrow({ where: { email: viewerEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const svcA = must('service A', (await post(`/api/organizations/${org}/services`, { internalCode: key('SA'), displayName: 'Synthetic service A' })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: 'Synthetic service B' })).body)
  const dx: { id: string; code: string; displayName: string }[] = []
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F'])
    dx.push(must(`diagnosis ${letter}`, (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key(`DX${letter}`), displayName: `Synthetic diagnosis ${letter}` })).body))
  const plainEncounter = async (label: string) =>
    must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body) as { id: string }
  const addActivity = async (encounterId: string, body: Record<string, unknown>) => must('activity', (await post(`/api/encounters/${encounterId}/activities`, body)).body)
  const addEncounterDiagnosis = async (encounterId: string, diagnosisCodeId: string) => must('encounter diagnosis', (await post(`/api/encounters/${encounterId}/diagnoses`, { diagnosisCodeId })).body)

  // Synthetic runs through A5.7's own recorder; assessments through the A5.9 owner route; Claims through
  // the A6.1 owner route.
  const plainContext = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  const sourceFindings = (activityIds: string[], diagnosisIds: string[]) => [
    finding('WARNING', { layer: 'CODING' }),
    ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId })),
    ...diagnosisIds.map((encounterDiagnosisId) => finding('PASS', { layer: 'CODING', encounterDiagnosisId })),
  ]
  const recordRun = async (encounterId: string, findings: Record<string, unknown>[], validatorVersion = 'A5-VAL-1') => {
    const contextSnapshot = await plainContext(encounterId)
    const result = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId, contextSnapshot, validatorVersion, findings }, actorUserId, tx))
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    return result.value.id
  }
  // Two runs at one exact instant cannot come from any owner path: the second is copied from the first
  // with the same evaluation and creation time, plus one finding, in one transaction.
  const copyRunAtSameInstant = async (sourceRunId: string) => {
    const newRunId = (await prisma.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid()::text AS id`)[0].id
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO validation_runs (id, encounter_id, service_date, facility_id, facility_regulatory_profile_id, insurance_membership_id, payer_id, tpa_id, network_id, insurance_product_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at)
         SELECT $1::uuid, encounter_id, service_date, facility_id, facility_regulatory_profile_id, insurance_membership_id, payer_id, tpa_id, network_id, insurance_product_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at
         FROM validation_runs WHERE id = $2::uuid`,
        newRunId,
        sourceRunId,
      )
      await tx.$executeRawUnsafe(
        `INSERT INTO validation_findings (id, validation_run_id, sequence, layer, outcome, finding_code, message) VALUES (gen_random_uuid(), $1::uuid, 1, 'TECHNICAL', 'PASS', 'SYNTHETIC_COPY', 'Synthetic copy.')`,
        newRunId,
      )
    })
    return newRunId
  }
  const assess = async (validationRunId: string) => {
    const res = await post(`/api/validation-runs/${validationRunId}/readiness-assessments`, {})
    if (res.status !== 201 || res.body?.state !== 'READY_FOR_REVIEW') throw new Error(`a valid READY assessment was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as { id: string }
  }
  const claimFor = async (assessmentId: string) => {
    const res = await post(`/api/pre-claim-readiness-assessments/${assessmentId}/claims`, {})
    if (res.status !== 201) throw new Error(`a valid claim was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as { id: string; encounterId: string }
  }
  // A fresh Encounter with activities and diagnoses, all named by one READY run, and its Claim.
  const sourcedClaim = async (label: string, activityCount: number, diagnosisCount: number) => {
    const encounter = await plainEncounter(label)
    const activityIds: string[] = []
    for (let i = 0; i < activityCount; i += 1) activityIds.push((await addActivity(encounter.id, { serviceId: i % 2 === 0 ? svcA.id : svcB.id, quantity: String(i + 1) })).id)
    const diagnosisIds: string[] = []
    for (let i = 0; i < diagnosisCount; i += 1) diagnosisIds.push((await addEncounterDiagnosis(encounter.id, dx[i].id)).id)
    const runIdOf = await recordRun(encounter.id, sourceFindings(activityIds, diagnosisIds))
    const assessment = await assess(runIdOf)
    const claim = await claimFor(assessment.id)
    return { encounterId: encounter.id, activityIds, diagnosisIds, runId: runIdOf, assessmentId: assessment.id, claimId: claim.id }
  }

  // A6.2 routes.
  const addLine = (claimId: string, encounterActivityId: unknown, who = asAdmin, extra: Record<string, unknown> = {}) => api('POST', `/api/claims/${claimId}/lines`, { encounterActivityId, ...extra }, who)
  const listLines = (claimId: string, who = asAdmin) => api('GET', `/api/claims/${claimId}/lines`, undefined, who)
  const orderLines = (claimId: string, claimLineIds: string[], who = asAdmin) => api('PUT', `/api/claims/${claimId}/lines/order`, { claimLineIds }, who)
  const removeLineHttp = (lineId: string, who = asAdmin) => api('POST', `/api/claim-lines/${lineId}/remove`, {}, who)
  const setPointers = (lineId: string, claimDiagnosisIds: string[], who = asAdmin) => api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds }, who)
  const addDx = (claimId: string, encounterDiagnosisId: unknown, roleCode: unknown, who = asAdmin, extra: Record<string, unknown> = {}) =>
    api('POST', `/api/claims/${claimId}/diagnoses`, { encounterDiagnosisId, roleCode, ...extra }, who)
  const listDx = (claimId: string, who = asAdmin) => api('GET', `/api/claims/${claimId}/diagnoses`, undefined, who)
  const orderDx = (claimId: string, claimDiagnosisIds: string[], who = asAdmin) => api('PUT', `/api/claims/${claimId}/diagnoses/order`, { claimDiagnosisIds }, who)
  const removeDxHttp = (id: string, who = asAdmin) => api('POST', `/api/claim-diagnoses/${id}/remove`, {}, who)

  const createdLineIds: string[] = []
  const createdDiagnosisIds: string[] = []
  const lineOk = (res: { status: number; body: any }) => {
    if (res.status === 201 && res.body?.id) createdLineIds.push(res.body.id)
    return res
  }
  const dxOk = (res: { status: number; body: any }) => {
    if (res.status === 201 && res.body?.id) createdDiagnosisIds.push(res.body.id)
    return res
  }
  const a62Audits = () => prisma.auditEvent.count({ where: { actionCode: { in: A62_ACTIONS } } })
  const auditsOf = (actionCode: string, entityId: string) => prisma.auditEvent.findMany({ where: { actionCode, entityId } })
  const linesOf = (claimId: string) => prisma.claimLine.findMany({ where: { claimId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const activeLineOrder = async (claimId: string) => (await prisma.claimLine.findMany({ where: { claimId, removedAt: null }, orderBy: { sequence: 'asc' } })).map((row) => `${row.sequence}:${row.id}`)
  const activeDxOrder = async (claimId: string) => (await prisma.claimDiagnosis.findMany({ where: { claimId, removedAt: null }, orderBy: { sequence: 'asc' } })).map((row) => `${row.sequence}:${row.id}`)
  const dbNow = async () => (await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now

  // The main Encounter: a1..a3 and d1, d2, d4, d5 are named by the run; a4 and d3 are recorded on the
  // Encounter but never validated. a1 and a3 carry the same service. A second Encounter of the same
  // tenant supplies wrong-Encounter sources.
  const mainEncounter = await plainEncounter('main encounter')
  const a1 = await addActivity(mainEncounter.id, { serviceId: svcA.id, quantity: '2.5', unitCode: 'SYN-UNIT', modifierCodes: ['SYN-M1', 'SYN-M2'] })
  const a2 = await addActivity(mainEncounter.id, { serviceId: svcB.id, quantity: '1' })
  const a3 = await addActivity(mainEncounter.id, { serviceId: svcA.id, quantity: '1' })
  const a4 = await addActivity(mainEncounter.id, { serviceId: svcB.id, quantity: '3' })
  const d1 = await addEncounterDiagnosis(mainEncounter.id, dx[0].id)
  const d2 = await addEncounterDiagnosis(mainEncounter.id, dx[1].id)
  const d3 = await addEncounterDiagnosis(mainEncounter.id, dx[2].id)
  const d4 = await addEncounterDiagnosis(mainEncounter.id, dx[3].id)
  const d5 = await addEncounterDiagnosis(mainEncounter.id, dx[4].id)
  const mainRun = await recordRun(mainEncounter.id, sourceFindings([a1.id, a2.id, a3.id], [d1.id, d2.id, d4.id, d5.id]))
  const mainAssessment = await assess(mainRun)
  const mainClaim = await claimFor(mainAssessment.id)
  const C = mainClaim.id
  const otherEncounter = await plainEncounter('other encounter')
  const x1 = await addActivity(otherEncounter.id, { serviceId: svcA.id, quantity: '1' })
  const y1 = await addEncounterDiagnosis(otherEncounter.id, dx[0].id)
  const handoff = (await api('GET', `/api/pre-claim-readiness-assessments/${mainAssessment.id}/a6-handoff`)).body as any
  const handoffActivities: string[] = handoff?.exactReferences?.encounterActivityIds ?? []
  const handoffDiagnoses: string[] = handoff?.exactReferences?.encounterDiagnosisIds ?? []
  if (!same(sorted(handoffActivities), sorted([a1.id, a2.id, a3.id])) || !same(sorted(handoffDiagnoses), sorted([d1.id, d2.id, d4.id, d5.id])))
    throw new Error('fixture: the main handoff does not name exactly the validated sources')
  const d1EncounterSequence = (await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: d1.id } })).sequence

  // Another tenant: a synthetic run on its Encounter through the recorder, an assessment and a Claim
  // through the owner services (the owner routes only ever act for this tenant).
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  let foreignActivity = await prisma.encounterActivity.findFirst({ where: { encounter: { patient: { organizationId: otherOrg } } }, select: { id: true } })
  if (!foreignActivity && foreignEncounter) {
    const foreignService = await prisma.service.findFirst({ where: { organizationId: otherOrg }, select: { id: true } })
    const created = foreignService ? await createEncounterActivity(foreignEncounter.id, { serviceId: foreignService.id, quantity: '1' }, actorUserId) : null
    foreignActivity = created?.ok ? { id: created.value.id } : null
  }
  const foreignRunId = foreignEncounter ? await recordRun(foreignEncounter.id, [finding('PASS', { findingCode: 'SYNTHETIC_FOREIGN_CODE' })]) : null
  const foreignAssessment = foreignRunId ? await recordReadinessAssessment(foreignRunId, {}, actorUserId) : null
  const foreignClaim = foreignAssessment?.ok ? await createClaim(foreignAssessment.value.id, {}, actorUserId) : null
  const foreignClaimId = foreignClaim?.ok ? foreignClaim.value.id : null
  const leaks = (body: unknown) => /SYNTHETIC_|encounterActivityId|encounterDiagnosisId|roleCode|claimLineContractVersion|quantity|sequence/.test(JSON.stringify(body ?? {}))

  // A5 truth of the main Claim, captured before any A6.2 write.
  const runBefore = JSON.stringify(await prisma.validationRun.findUniqueOrThrow({ where: { id: mainRun } }))
  const findingsBefore = JSON.stringify(await prisma.validationFinding.findMany({ where: { validationRunId: mainRun }, orderBy: { sequence: 'asc' } }))
  const assessmentBefore = JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: mainAssessment.id } }))
  const claimBefore = JSON.stringify(await prisma.claim.findUniqueOrThrow({ where: { id: C } }))
  console.log('[A6.2]      fixtures ready: patient, AE-DU/DHA facility profile, clinician, services, diagnosis codes, a validated Encounter with unvalidated extras, its Claim, and a foreign-tenant Claim')

  // ---------------------------------------------------------------- ClaimLine create (T007–T021)
  section('ClaimLine creation and source traceability')
  const l1 = lineOk(await addLine(C, a1.id))
  const L1 = l1.body as any
  check('T007', 'Admin line create', l1.status === 201 && L1?.claimLineContractVersion === 'A6-LINE-1' && L1?.sequence === 1 && L1?.source?.encounterActivityId === a1.id, `201 ${L1?.claimLineContractVersion} at position ${L1?.sequence}`)
  const auditsBefore08 = await a62Audits()
  const viewerLine = await addLine(C, a2.id, asViewer)
  check('T008', 'Viewer line create', viewerLine.status === 403 && (await prisma.claimLine.count({ where: { claimId: C } })) === 1 && (await a62Audits()) === auditsBefore08, '403; no line and no audit')
  const malformedSource = await addLine(C, 'not-a-uuid')
  const malformedClaim = await api('POST', '/api/claims/not-a-uuid/lines', { encounterActivityId: a2.id })
  const rawError = (body: unknown) => /\bat \w|prisma|SELECT|INSERT|constraint|trigger/i.test(JSON.stringify(body ?? {}))
  check(
    'T009',
    'Malformed line source',
    malformedSource.status === 400 && errorCode(malformedSource.body) === 'VALIDATION_ERROR' && malformedClaim.status === 400 && !rawError(malformedSource.body) && !rawError(malformedClaim.body),
    `malformed source ${malformedSource.status}, malformed claim id ${malformedClaim.status}; safe envelope`,
  )
  const linesBefore10 = await prisma.claimLine.count()
  const missingClaim = await addLine(MISSING, a2.id)
  check('T010', 'Missing Claim', missingClaim.status === 404 && (await prisma.claimLine.count()) === linesBefore10, '404; nothing written')
  const foreignClaimLine = foreignClaimId ? await addLine(foreignClaimId, a2.id) : null
  check(
    'T011',
    'Foreign Claim',
    foreignClaimLine !== null && foreignClaimLine.status === 403 && !leaks(foreignClaimLine.body) && (await prisma.claimLine.count({ where: { claimId: foreignClaimId ?? MISSING } })) === 0,
    foreignClaimLine === null ? 'no foreign-tenant Claim could be created to prove this' : '403; nothing about the foreign Claim disclosed',
  )
  const foreignSource = foreignActivity ? await addLine(C, foreignActivity.id) : null
  check(
    'T012',
    'Foreign source activity',
    foreignSource !== null && foreignSource.status === 404 && !leaks(foreignSource.body) && (await prisma.claimLine.count({ where: { claimId: C } })) === 1,
    foreignSource === null ? 'no foreign-tenant activity exists to prove this' : `${foreignSource.status}; refused as "not found", with no Encounter or source detail`,
  )
  const wrongEncounter = await addLine(C, x1.id)
  check('T013', 'Wrong Encounter activity', wrongEncounter.status === 409 && errorCode(wrongEncounter.body) === 'CLAIM_SOURCE_ENCOUNTER_MISMATCH', '409 CLAIM_SOURCE_ENCOUNTER_MISMATCH')
  const notInHandoff = await addLine(C, a4.id)
  check('T014', 'Activity not in handoff', notInHandoff.status === 409 && errorCode(notInHandoff.body) === 'CLAIM_SOURCE_NOT_IN_HANDOFF' && (await prisma.claimLine.count({ where: { claimId: C } })) === 1, 'refused: a same-Encounter activity the bound run never validated')
  const contractAttempt = await addLine(C, a2.id, asAdmin, { claimLineContractVersion: 'A6-LINE-2' })
  const storedL1 = L1?.id ? await prisma.claimLine.findUnique({ where: { id: L1.id } }) : null
  check('T015', 'Line contract exact', contractAttempt.status === 400 && storedL1?.claimLineContractVersion === 'A6-LINE-1', `the server stores A6-LINE-1; a client contract is refused (${contractAttempt.status})`)
  const sequenceAttempt = await addLine(C, a2.id, asAdmin, { sequence: 7 })
  const l2 = lineOk(await addLine(C, a2.id))
  const L2 = l2.body as any

  // Concurrency (§17): two creates on one Claim, the first held after its insert while the second waits
  // on the Claim lock; then a removal held after its compaction while a create waits. Every write ends
  // on one contiguous 1..N order; a writer that started on an overtaken snapshot is retried.
  const race = await sourcedClaim('race', 4, 0)
  const raceHold = holdAt('claimLine.inserted')
  const raceFirst = createClaimLine(race.claimId, { encounterActivityId: race.activityIds[0] }, actorUserId)
  await Promise.race([raceHold.arrived, raceFirst])
  const raceSecond = createClaimLine(race.claimId, { encounterActivityId: race.activityIds[1] }, actorUserId)
  await pause(400)
  raceHold.release()
  const [raceA, raceB] = await Promise.all([raceFirst, raceSecond])
  clearConcurrencyProbes()
  for (const result of [raceA, raceB]) if (result.ok) createdLineIds.push(result.value.id)
  const raceThird = await createClaimLine(race.claimId, { encounterActivityId: race.activityIds[2] }, actorUserId)
  if (raceThird.ok) createdLineIds.push(raceThird.value.id)
  const removeHold = holdAt('claimLine.removed')
  const raceRemove = raceA.ok ? removeClaimLine(raceA.value.id, {}, actorUserId) : Promise.resolve(null)
  await Promise.race([removeHold.arrived, raceRemove])
  const raceAdd = createClaimLine(race.claimId, { encounterActivityId: race.activityIds[3] }, actorUserId)
  await pause(400)
  removeHold.release()
  const [removeResult, addResult] = await Promise.all([raceRemove, raceAdd])
  clearConcurrencyProbes()
  if (addResult.ok) createdLineIds.push(addResult.value.id)
  const raceOrder = await activeLineOrder(race.claimId)
  const contiguous = (order: string[]) => order.every((entry, index) => entry.startsWith(`${index + 1}:`))
  check(
    'T016',
    'Line sequence server-owned',
    sequenceAttempt.status === 400 && l2.status === 201 && L2?.sequence === 2 && same(await activeLineOrder(C), [`1:${L1?.id}`, `2:${L2?.id}`]) &&
      raceA.ok && raceB.ok && raceThird.ok && removeResult?.ok === true && addResult.ok && raceOrder.length === 3 && contiguous(raceOrder),
    `a client sequence is refused (${sequenceAttempt.status}); creates append 1..N; held concurrent create/create and remove/create both end contiguous (${raceOrder.length} active)`,
  )
  const sourceRows = L1?.id && L2?.id ? await prisma.claimLineSourceActivity.findMany({ where: { claimLineId: { in: [L1.id, L2.id] } } }) : []
  check(
    'T017',
    'Line source row',
    sourceRows.length === 2 && sourceRows.some((row) => row.claimLineId === L1.id && row.encounterActivityId === a1.id) && sourceRows.some((row) => row.claimLineId === L2.id && row.encounterActivityId === a2.id),
    'exactly one ClaimLineSourceActivity per line, naming its exact activity',
  )
  const columnsOf = async (table: string) =>
    (await prisma.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, table)).map((row) => row.column_name)
  const lineColumns = await columnsOf('claim_lines')
  const sourceColumns = await columnsOf('claim_line_source_activities')
  const dxColumns = await columnsOf('claim_diagnoses')
  const pointerColumns = await columnsOf('claim_line_diagnosis_pointers')
  const a62Columns = [...lineColumns, ...sourceColumns, ...dxColumns, ...pointerColumns]
  const reachedColumns = lineColumns.includes('claim_line_contract_version') && dxColumns.includes('role_code') && pointerColumns.includes('claim_diagnosis_id')
  const copiedFacts = [...lineColumns, ...sourceColumns].filter((name) => /service|procedure|quantity|unit|modifier|code/.test(name))
  check('T018', 'No source fact copy', reachedColumns && copiedFacts.length === 0, copiedFacts.length === 0 ? 'claim_lines and its source table carry no service, procedure, quantity, unit or modifier column' : copiedFacts.join(', '))
  const a1Row = await prisma.encounterActivity.findUniqueOrThrow({ where: { id: a1.id }, include: { modifiers: { orderBy: { sequence: 'asc' } } } })
  check(
    'T019',
    'Derived line DTO',
    same(L1?.source, {
      encounterActivityId: a1.id,
      serviceId: a1Row.serviceId,
      procedureCodeId: a1Row.procedureCodeId,
      quantity: a1Row.quantity.toFixed(),
      unitCode: a1Row.unitCode,
      modifierCodes: a1Row.modifiers.map((m) => m.code),
    }),
    `the DTO reads service, quantity ${a1Row.quantity.toFixed()}, unit and ${a1Row.modifiers.length} ordered modifiers from the exact A4.6 activity`,
  )
  const l3 = lineOk(await addLine(C, a3.id))
  const L3 = l3.body as any
  check('T020', 'Repeated activity facts', l3.status === 201 && a1Row.serviceId === svcA.id && L3?.source?.serviceId === svcA.id && L3?.id !== L1?.id, 'a distinct activity with the same service creates its own line')
  const auditsBefore21 = await a62Audits()
  const duplicateSource = await addLine(C, a1.id)
  check(
    'T021',
    'Duplicate active source',
    duplicateSource.status === 409 && errorCode(duplicateSource.body) === 'CLAIM_LINE_SOURCE_ALREADY_ACTIVE' && (await prisma.claimLine.count({ where: { claimId: C } })) === 3 && (await a62Audits()) === auditsBefore21,
    '409 CLAIM_LINE_SOURCE_ALREADY_ACTIVE; no line, no audit',
  )

  // ---------------------------------------------------------------- order and removal (T022–T028)
  section('ClaimLine order, removal and re-add')
  const listed22 = await listLines(C)
  check('T022', 'Line list order', listed22.status === 200 && same((listed22.body?.items ?? []).map((item: any) => `${item.sequence}:${item.id}`), [`1:${L1?.id}`, `2:${L2?.id}`, `3:${L3?.id}`]), 'active lines in Claim position order')
  const reorder23 = await orderLines(C, [L3?.id, L1?.id, L2?.id])
  const reorderAudits23 = await auditsOf('claim_line.reordered', C)
  check(
    'T023',
    'Line reorder exact set',
    reorder23.status === 200 && same(await activeLineOrder(C), [`1:${L3?.id}`, `2:${L1?.id}`, `3:${L2?.id}`]) && reorderAudits23.length === 1,
    'all active ids exactly once reorder atomically, with one audit',
  )
  const order24 = await activeLineOrder(C)
  const missingId = await orderLines(C, [L3?.id, L1?.id])
  check('T024', 'Line reorder missing ID', missingId.status === 400 && same(await activeLineOrder(C), order24), 'refused; order unchanged')
  const foreignLineId = race.claimId ? (await prisma.claimLine.findFirst({ where: { claimId: race.claimId }, select: { id: true } }))?.id : undefined
  const foreignIdReorder = await orderLines(C, [L3?.id, L1?.id, foreignLineId ?? MISSING])
  check('T025', 'Line reorder foreign ID', foreignIdReorder.status === 400 && same(await activeLineOrder(C), order24) && !leaks(foreignIdReorder.body), 'a line of another Claim is refused like any unknown id; order unchanged; nothing disclosed')
  const before26 = await dbNow()
  const remove26 = await removeLineHttp(L1?.id)
  const after26 = await dbNow()
  const removedL1 = L1?.id ? await prisma.claimLine.findUnique({ where: { id: L1.id } }) : null
  const l1Source = L1?.id ? await prisma.claimLineSourceActivity.count({ where: { claimLineId: L1.id } }) : 0
  check(
    'T026',
    'Line remove',
    remove26.status === 200 &&
      removedL1?.removedAt !== null &&
      removedL1 !== null &&
      removedL1.removedAt! >= new Date(before26.getTime() - 1000) &&
      removedL1.removedAt! <= new Date(after26.getTime() + 1000) &&
      l1Source === 1 &&
      same(await activeLineOrder(C), [`1:${L3?.id}`, `2:${L2?.id}`]),
    'removedAt is stamped by the database; the row and its source survive; the remaining lines are 1..N',
  )
  const auditsBefore27 = await a62Audits()
  const removeAgain = await removeLineHttp(L1?.id)
  check('T027', 'Line remove again', removeAgain.status === 409 && errorCode(removeAgain.body) === 'CLAIM_STRUCTURE_INACTIVE' && (await a62Audits()) === auditsBefore27, '409 CLAIM_STRUCTURE_INACTIVE; no audit')
  const l4 = lineOk(await addLine(C, a1.id))
  const L4 = l4.body as any
  check(
    'T028',
    'Line re-add after remove',
    l4.status === 201 && L4?.id !== L1?.id && L4?.sequence === 3 && (await prisma.claimLine.count({ where: { id: L1?.id, removedAt: { not: null } } })) === 1,
    'the same source creates a new line; the removed line stays as history',
  )

  // ---------------------------------------------------------------- line database guards (T029–T035)
  section('ClaimLine database guards')
  const insertLineSql = `INSERT INTO claim_lines (id, claim_id, sequence, claim_line_contract_version, created_by_user_id, updated_at) VALUES ($1::uuid, $2::uuid, $3, 'A6-LINE-1', $4::uuid, now())`
  const insertSourceSql = `INSERT INTO claim_line_source_activities (id, claim_line_id, encounter_activity_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`
  const newId = async () => (await prisma.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid()::text AS id`)[0].id
  const directLine = async (claimId: string, sequence: number, activityId: string | null) => {
    const id = await newId()
    return attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(insertLineSql, id, claimId, sequence, actorUserId)
        if (activityId) await tx.$executeRawUnsafe(insertSourceSql, id, activityId)
      }),
    )
  }
  const linesBeforeGuards = await prisma.claimLine.count({ where: { claimId: C } })
  const zero = await directLine(C, 0, a2.id)
  const negative = await directLine(C, -1, a2.id)
  check('T029', 'Line DB sequence CHECK', /claim_lines_sequence_chk/.test(zero) && /claim_lines_sequence_chk/.test(negative), 'a direct zero or negative position is rejected')
  const order30 = await activeLineOrder(C)
  const collide = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_lines SET sequence = 1 WHERE id = $1::uuid`, L2?.id))
  check('T030', 'Line active sequence unique', /claim_lines_active_sequence_uidx|unique|23505|P2002|P2010/i.test(collide) && same(await activeLineOrder(C), order30), 'a direct duplicate active position is rejected')
  const crossEncounter = await directLine(C, 50, x1.id)
  check('T031', 'Source Encounter DB guard', /claim_source_encounter_mismatch/.test(crossEncounter), 'a direct cross-Encounter source binding is rejected')
  const unreferenced = await directLine(C, 51, a4.id)
  const noSource = await directLine(C, 52, null)
  const duplicateActive = await directLine(C, 53, a2.id)
  check(
    'T032',
    'Source handoff DB guard',
    /claim_source_not_in_handoff/.test(unreferenced) && /claim_lines_source_required/.test(noSource) && /claim_line_source_already_active/.test(duplicateActive) && (await prisma.claimLine.count({ where: { claimId: C } })) === linesBeforeGuards,
    'a same-Encounter but unvalidated source, a line without a source and a second active line for one source are each rejected; nothing remains',
  )
  const sourceUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_line_source_activities SET encounter_activity_id = $2::uuid WHERE claim_line_id = $1::uuid`, L2?.id, a3.id))
  const sourceDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_line_source_activities WHERE claim_line_id = $1::uuid`, L1?.id))
  check('T033', 'Source immutable', /append-only/.test(sourceUpdate) && /append-only/.test(sourceDelete), 'a direct source update or delete is rejected')
  const l2Stored = JSON.stringify(await prisma.claimLine.findUnique({ where: { id: L2?.id } }))
  const lineAttacks: [string, string][] = [
    ['claim_id', `'${race.claimId}'::uuid`],
    ['claim_line_contract_version', `'A6-LINE-2'`],
    ['created_by_user_id', `'${viewerUserId}'::uuid`],
    ['created_at', `created_at + interval '1 second'`],
  ]
  const lineRefusals: string[] = []
  for (const [column, value] of lineAttacks) lineRefusals.push(await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_lines SET ${column} = ${value} WHERE id = $1::uuid`, L2?.id)))
  const restore = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_lines SET removed_at = NULL WHERE id = $1::uuid`, L1?.id))
  check(
    'T034',
    'Line source identity immutable',
    lineRefusals.every((message) => /claim_lines identity is immutable/.test(message)) && /cannot be changed or restored/.test(restore) && JSON.stringify(await prisma.claimLine.findUnique({ where: { id: L2?.id } })) === l2Stored,
    `changing the Claim, contract, creator or createdAt is refused (${lineRefusals.length}/4) and a removed line cannot be restored`,
  )
  const lineDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_lines WHERE id = $1::uuid`, L2?.id))
  check('T035', 'No hard delete', /cannot be deleted/.test(lineDelete) && (await prisma.claimLine.count({ where: { id: L2?.id } })) === 1, 'a direct ClaimLine DELETE is rejected')

  // ---------------------------------------------------------------- ClaimDiagnosis (T036–T058)
  section('ClaimDiagnosis creation, explicit role and history')
  const dxP = dxOk(await addDx(C, d2.id, 'PRIMARY'))
  const DP = dxP.body as any
  check('T036', 'Admin diagnosis create', dxP.status === 201 && DP?.claimDiagnosisContractVersion === 'A6-DX-1' && DP?.sequence === 1, `201 ${DP?.claimDiagnosisContractVersion}`)
  const auditsBefore37 = await a62Audits()
  const viewerDx = await addDx(C, d1.id, 'SECONDARY', asViewer)
  check('T037', 'Viewer diagnosis create', viewerDx.status === 403 && (await prisma.claimDiagnosis.count({ where: { claimId: C } })) === 1 && (await a62Audits()) === auditsBefore37, '403; no diagnosis and no audit')
  const malformedDx = await addDx(C, 'not-a-uuid', 'PRIMARY')
  check('T038', 'Malformed diagnosis source', malformedDx.status === 400 && errorCode(malformedDx.body) === 'VALIDATION_ERROR' && !rawError(malformedDx.body), '400 safe envelope')
  const wrongDx = await addDx(C, y1.id, 'SECONDARY')
  check('T039', 'Wrong Encounter diagnosis', wrongDx.status === 409 && errorCode(wrongDx.body) === 'CLAIM_SOURCE_ENCOUNTER_MISMATCH', '409 CLAIM_SOURCE_ENCOUNTER_MISMATCH')
  const notInHandoffDx = await addDx(C, d3.id, 'SECONDARY')
  check('T040', 'Diagnosis not in handoff', notInHandoffDx.status === 409 && errorCode(notInHandoffDx.body) === 'CLAIM_SOURCE_NOT_IN_HANDOFF', '409 CLAIM_SOURCE_NOT_IN_HANDOFF')
  const dxContractAttempt = await addDx(C, d1.id, 'SECONDARY', asAdmin, { claimDiagnosisContractVersion: 'A6-DX-2' })
  const storedDP = DP?.id ? await prisma.claimDiagnosis.findUnique({ where: { id: DP.id } }) : null
  check('T041', 'Diagnosis contract exact', dxContractAttempt.status === 400 && storedDP?.claimDiagnosisContractVersion === 'A6-DX-1', `the server stores A6-DX-1; a client contract is refused (${dxContractAttempt.status})`)
  check('T042', 'Role PRIMARY', storedDP?.roleCode === 'PRIMARY' && DP?.roleCode === 'PRIMARY', 'PRIMARY accepted and stored exactly')
  const dxS = dxOk(await addDx(C, d1.id, 'SECONDARY'))
  const DS = dxS.body as any
  check('T043', 'Role SECONDARY', dxS.status === 201 && (await prisma.claimDiagnosis.findUnique({ where: { id: DS?.id } }))?.roleCode === 'SECONDARY', 'SECONDARY accepted and stored exactly')
  const dxA = dxOk(await addDx(C, d4.id, 'ADMITTING'))
  const DA = dxA.body as any
  const claimEncounter = await prisma.encounter.findUniqueOrThrow({ where: { id: mainEncounter.id } })
  check('T044', 'Role ADMITTING', dxA.status === 201 && DA?.roleCode === 'ADMITTING' && claimEncounter.updatedAt.getTime() === (await prisma.encounter.findUniqueOrThrow({ where: { id: mainEncounter.id } })).updatedAt.getTime(), 'ADMITTING stored exactly; nothing about the Encounter is inferred or changed')
  const badRoles: number[] = []
  for (const roleCode of ['', ' ', 'primary', ' PRIMARY', 'PRINCIPAL', 'DISCHARGE', null]) badRoles.push((await addDx(C, d5.id, roleCode)).status)
  const insertDxSql = `INSERT INTO claim_diagnoses (id, claim_id, encounter_diagnosis_id, sequence, role_code, claim_diagnosis_contract_version, created_by_user_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, 'A6-DX-1', $5::uuid, now())`
  const dbRole = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertDxSql, C, d5.id, 900, 'primary', actorUserId))
  const dbPaddedRole = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertDxSql, C, d5.id, 901, 'PRIMARY ', actorUserId))
  check(
    'T045',
    'Bad role',
    badRoles.every((code) => code === 400) && /claim_diagnoses_role_code_chk/.test(dbRole) && /claim_diagnoses_role_code_chk/.test(dbPaddedRole) && (await prisma.claimDiagnosis.count({ where: { claimId: C, encounterDiagnosisId: d5.id } })) === 0,
    `blank, lowercase, padded, invented and missing roles are refused by the service (${badRoles.join('/')}) and by the database CHECK`,
  )
  const noRole = await api('POST', `/api/claims/${C}/diagnoses`, { encounterDiagnosisId: d5.id })
  check(
    'T046',
    'No role inference',
    d1EncounterSequence === 1 && DS?.roleCode === 'SECONDARY' && noRole.status === 400 && (await prisma.claimDiagnosis.count({ where: { claimId: C, roleCode: 'PRIMARY' } })) === 1,
    'the Encounter’s first diagnosis was carried as SECONDARY exactly as chosen; a request without a role is refused (no PRIMARY is inferred)',
  )
  const dxSequenceAttempt = await addDx(C, d5.id, 'SECONDARY', asAdmin, { sequence: 1 })
  check('T047', 'Diagnosis sequence server-owned', dxSequenceAttempt.status === 400 && same(await activeDxOrder(C), [`1:${DP?.id}`, `2:${DS?.id}`, `3:${DA?.id}`]), 'creates append 1..N; a client sequence is refused')
  const copiedDx = dxColumns.filter((name) => /code_id|display|icd|^code$|description/.test(name) && name !== 'role_code')
  check('T048', 'No diagnosis code copy', reachedColumns && copiedDx.length === 0, copiedDx.length === 0 ? 'no ICD code, display text or DiagnosisCode id on claim_diagnoses' : copiedDx.join(', '))
  check('T049', 'Derived diagnosis DTO', same(DP?.source, { diagnosisCodeId: dx[1].id, code: dx[1].code, displayName: dx[1].displayName }), 'the DTO shows the exact source DiagnosisCode through the owner join')
  const auditsBefore50 = await a62Audits()
  const duplicateDx = await addDx(C, d2.id, 'SECONDARY')
  check(
    'T050',
    'Duplicate active diagnosis source',
    duplicateDx.status === 409 && errorCode(duplicateDx.body) === 'CLAIM_DIAGNOSIS_ALREADY_ACTIVE' && (await a62Audits()) === auditsBefore50,
    '409 CLAIM_DIAGNOSIS_ALREADY_ACTIVE; no audit',
  )
  const reorder51 = await orderDx(C, [DS?.id, DP?.id, DA?.id])
  check('T051', 'Diagnosis reorder exact set', reorder51.status === 200 && same(await activeDxOrder(C), [`1:${DS?.id}`, `2:${DP?.id}`, `3:${DA?.id}`]) && (await auditsOf('claim_diagnosis.reordered', C)).length === 1, 'atomic reorder with one audit')
  const remove52 = await removeDxHttp(DA?.id)
  const removedDA = DA?.id ? await prisma.claimDiagnosis.findUnique({ where: { id: DA.id } }) : null
  check('T052', 'Diagnosis remove', remove52.status === 200 && removedDA?.removedAt !== null && removedDA?.roleCode === 'ADMITTING', 'one-way removedAt; the row and its source remain')
  const corrected = dxOk(await addDx(C, d4.id, 'SECONDARY'))
  const DA2 = corrected.body as any
  check(
    'T053',
    'Diagnosis role correction',
    corrected.status === 201 && DA2?.id !== DA?.id && DA2?.roleCode === 'SECONDARY' && (await prisma.claimDiagnosis.findUnique({ where: { id: DA?.id } }))?.roleCode === 'ADMITTING',
    'remove + re-add of the same source with a new role; the old ADMITTING row survives as history',
  )
  const dxZero = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertDxSql, C, d5.id, 0, 'SECONDARY', actorUserId))
  check('T054', 'Diagnosis DB sequence CHECK', /claim_diagnoses_sequence_chk/.test(dxZero), 'a direct zero position is rejected')
  const dxOrder55 = await activeDxOrder(C)
  const dxCollide = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_diagnoses SET sequence = 1 WHERE id = $1::uuid`, DP?.id))
  const dxDuplicateSource = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertDxSql, C, d2.id, 902, 'SECONDARY', actorUserId))
  check(
    'T055',
    'Diagnosis active sequence unique',
    /claim_diagnoses_active_sequence_uidx|unique|23505|P2002|P2010/i.test(dxCollide) && /claim_diagnoses_active_source_uidx|unique|23505|P2002|P2010/i.test(dxDuplicateSource) && same(await activeDxOrder(C), dxOrder55),
    'a direct duplicate active position, and a second active row for one source, are rejected',
  )
  const dxCross = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertDxSql, C, y1.id, 903, 'SECONDARY', actorUserId))
  const dxUnreferenced = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertDxSql, C, d3.id, 904, 'SECONDARY', actorUserId))
  check('T056', 'Diagnosis source DB guard', /claim_source_encounter_mismatch/.test(dxCross) && /claim_source_not_in_handoff/.test(dxUnreferenced), 'a direct cross-Encounter or unreferenced diagnosis is rejected')
  const dpStored = JSON.stringify(await prisma.claimDiagnosis.findUnique({ where: { id: DP?.id } }))
  const dxAttacks: [string, string][] = [
    ['claim_id', `'${race.claimId}'::uuid`],
    ['encounter_diagnosis_id', `'${d5.id}'::uuid`],
    ['role_code', `'SECONDARY'`],
    ['claim_diagnosis_contract_version', `'A6-DX-2'`],
    ['created_by_user_id', `'${viewerUserId}'::uuid`],
    ['created_at', `created_at + interval '1 second'`],
  ]
  const dxRefusals: string[] = []
  for (const [column, value] of dxAttacks) dxRefusals.push(await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_diagnoses SET ${column} = ${value} WHERE id = $1::uuid`, DP?.id)))
  check(
    'T057',
    'Diagnosis immutable identity',
    dxRefusals.every((message) => /identity, source and role are immutable/.test(message)) && JSON.stringify(await prisma.claimDiagnosis.findUnique({ where: { id: DP?.id } })) === dpStored,
    `source, role, contract, creator and createdAt cannot be rewritten (${dxRefusals.length}/6)`,
  )
  const dxDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_diagnoses WHERE id = $1::uuid`, DP?.id))
  check('T058', 'No hard diagnosis delete', /cannot be deleted/.test(dxDelete), 'a direct DELETE is rejected')

  // ---------------------------------------------------------------- pointers (T059–T070)
  section('ClaimLine diagnosis pointers')
  // Current active diagnoses: DS(1), DP(2), DA2(3). Active lines: L3(1), L2(2), L4(3).
  const pointerAuditsOf = async (lineId: string) => (await auditsOf('claim_line_diagnoses.changed', lineId)).length
  const set59 = await setPointers(L3?.id, [DP?.id, DS?.id])
  check(
    'T059',
    'Pointer set add',
    set59.status === 200 && same(set59.body?.claimDiagnosisIds, [DS?.id, DP?.id]) && (await prisma.claimLineDiagnosisPointer.count({ where: { claimLineId: L3?.id, removedAt: null } })) === 2 && (await pointerAuditsOf(L3?.id)) === 1,
    'an exact-set PUT creates two active pointers, shown in ClaimDiagnosis order, with one audit',
  )
  const reorder66 = await orderDx(C, [DP?.id, DS?.id, DA2?.id])
  const after66 = await listLines(C)
  const l3After66 = (after66.body?.items ?? []).find((item: any) => item.id === L3?.id)
  check(
    'T066',
    'Pointer no second order',
    reorder66.status === 200 && same(l3After66?.claimDiagnosisIds, [DP?.id, DS?.id]) && !pointerColumns.some((name) => /sequence|position|order|rank/.test(name)),
    'no pointer position column; reordering the diagnoses reorders every line’s pointers',
  )
  const auditsBefore69 = await pointerAuditsOf(L3?.id)
  const pointerRowsBefore69 = await prisma.claimLineDiagnosisPointer.count({ where: { claimLineId: L3?.id } })
  const repeat69 = await setPointers(L3?.id, [DS?.id, DP?.id])
  check(
    'T069',
    'Pointer exact set repeat',
    repeat69.status === 200 && (await pointerAuditsOf(L3?.id)) === auditsBefore69 && (await prisma.claimLineDiagnosisPointer.count({ where: { claimLineId: L3?.id } })) === pointerRowsBefore69,
    'the identical set is a no-op: 200, no new row, no audit',
  )
  const duplicateInput = await setPointers(L3?.id, [DP?.id, DP?.id])
  const activeP = await prisma.claimLineDiagnosisPointer.findFirst({ where: { claimLineId: L3?.id, claimDiagnosisId: DP?.id, removedAt: null } })
  const insertPointerSql = `INSERT INTO claim_line_diagnosis_pointers (id, claim_line_id, claim_diagnosis_id, created_by_user_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, now())`
  const dbDuplicatePointer = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertPointerSql, L3?.id, DP?.id, actorUserId))
  check(
    'T061',
    'Pointer duplicate input',
    duplicateInput.status === 400 && activeP !== null && /claim_line_diagnosis_pointers_active_uidx|unique|23505|P2002|P2010/i.test(dbDuplicatePointer) && (await prisma.claimLineDiagnosisPointer.count({ where: { claimLineId: L3?.id, claimDiagnosisId: DP?.id, removedAt: null } })) === 1,
    'a duplicate id is refused (400); the database refuses a second active pointer',
  )
  const otherClaim = await sourcedClaim('cross claim', 1, 1)
  const otherDx = dxOk(await addDx(otherClaim.claimId, otherClaim.diagnosisIds[0], 'PRIMARY'))
  const crossPointer = await setPointers(L3?.id, [DP?.id, otherDx.body?.id])
  const dbCrossPointer = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertPointerSql, L2?.id, otherDx.body?.id, actorUserId))
  const missingPointer = await setPointers(L3?.id, [MISSING])
  check(
    'T062',
    'Cross-Claim pointer',
    crossPointer.status === 409 && errorCode(crossPointer.body) === 'CLAIM_DIAGNOSIS_POINTER_MISMATCH' && /claim_diagnosis_pointer_mismatch/.test(dbCrossPointer) && missingPointer.status === 404 && !leaks(missingPointer.body),
    'a diagnosis of another Claim is refused by the service (409) and the database; an unknown id is "not found"',
  )
  const removedTarget = await setPointers(L3?.id, [DA?.id])
  const dbRemovedTarget = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertPointerSql, L2?.id, DA?.id, actorUserId))
  check('T063', 'Removed diagnosis pointer', removedTarget.status === 409 && errorCode(removedTarget.body) === 'CLAIM_STRUCTURE_INACTIVE' && /claim_structure_inactive/.test(dbRemovedTarget), 'a removed ClaimDiagnosis cannot be pointed to (service and database)')
  const empty60 = await setPointers(L3?.id, [])
  check(
    'T060',
    'Pointer empty set',
    empty60.status === 200 && same(empty60.body?.claimDiagnosisIds, []) && (await prisma.claimLineDiagnosisPointer.count({ where: { claimLineId: L3?.id, removedAt: null } })) === 0 && (await prisma.claimLineDiagnosisPointer.count({ where: { claimLineId: L3?.id, removedAt: { not: null } } })) === 2,
    'an empty list is allowed; the two pointers become removed history',
  )
  // Derived cleanup: removing a ClaimDiagnosis or a ClaimLine ends its active pointers in the same
  // transaction, under the one removal event.
  await setPointers(L2?.id, [DA2?.id])
  const dxRemovedAuditsBefore = (await prisma.auditEvent.findMany({ where: { actionCode: 'claim_line_diagnoses.changed', entityId: L2?.id } })).length
  const remove67 = await removeDxHttp(DA2?.id)
  check(
    'T067',
    'Diagnosis removal cleanup',
    remove67.status === 200 && (await prisma.claimLineDiagnosisPointer.count({ where: { claimDiagnosisId: DA2?.id, removedAt: null } })) === 0 && (await prisma.claimLineDiagnosisPointer.count({ where: { claimDiagnosisId: DA2?.id } })) === 1 && (await pointerAuditsOf(L2?.id)) === dxRemovedAuditsBefore,
    'removing the diagnosis removed its active pointer atomically, under the one removal event',
  )
  await setPointers(L4?.id, [DP?.id])
  const remove68 = await removeLineHttp(L4?.id)
  check(
    'T068',
    'Line removal cleanup',
    remove68.status === 200 && (await prisma.claimLineDiagnosisPointer.count({ where: { claimLineId: L4?.id, removedAt: null } })) === 0 && same(remove68.body?.claimDiagnosisIds, []),
    'removing the line removed its active pointer atomically',
  )
  const removedLinePointers = await setPointers(L4?.id, [DP?.id])
  check('T064', 'Removed line pointer', removedLinePointers.status === 409 && errorCode(removedLinePointers.body) === 'CLAIM_STRUCTURE_INACTIVE', 'the pointers of a removed ClaimLine cannot change')
  const historyRows = await prisma.claimLineDiagnosisPointer.findMany({ where: { claimLineId: { in: [L3?.id, L4?.id, L2?.id] }, removedAt: { not: null } } })
  const pointerRestore = historyRows[0] ? await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_line_diagnosis_pointers SET removed_at = NULL WHERE id = $1::uuid`, historyRows[0].id)) : ''
  const pointerDelete = historyRows[0] ? await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_line_diagnosis_pointers WHERE id = $1::uuid`, historyRows[0].id)) : ''
  check(
    'T065',
    'Pointer history',
    historyRows.length >= 4 && /cannot be changed or restored/.test(pointerRestore) && /cannot be deleted/.test(pointerDelete),
    `${historyRows.length} removed pointer(s) stay queryable; none can be restored or deleted`,
  )
  const externalPointer = pointerColumns.filter((name) => !['id', 'claim_line_id', 'claim_diagnosis_id', 'removed_at', 'created_by_user_id', 'created_at', 'updated_at'].includes(name))
  check('T070', 'No pointer external semantics', reachedColumns && externalPointer.length === 0, externalPointer.length === 0 ? 'the pointer table holds only its internal identity and history columns; no eClaimLink, XML or X12 field' : externalPointer.join(', '))

  // ---------------------------------------------------------------- bound handoff gate (T071–T080)
  section('Bound A5 handoff gate and owner reuse')
  const moduleCode = committedProductionCodeOf([LINE_DIR, DX_DIR])
  const feCode = committedProductionCodeOf([FE_LINE_DIR, FE_DX_DIR])
  const reached = moduleCode.files.length === 10 && moduleCode.code.includes('openClaimStructureGate') && moduleCode.code.includes('createClaimDiagnosisRecord')
  const lineServiceCode = committedCode(`${LINE_DIR}/claim-line.service.ts`)
  const dxServiceCode = committedCode(`${DX_DIR}/claim-diagnosis.service.ts`)
  const gateCalls = (code: string) => (code.match(/await openClaimStructureGate\(/g) ?? []).length
  const writeCalls = (code: string) => (code.match(/runClaimStructureWrite\(async/g) ?? []).length
  const gateSuperseded = await sourcedClaim('superseded gate', 2, 1)
  const supersededLine = lineOk(await addLine(gateSuperseded.claimId, gateSuperseded.activityIds[0]))
  await recordRun(gateSuperseded.encounterId, sourceFindings(gateSuperseded.activityIds, gateSuperseded.diagnosisIds))
  const supersededWrites = [
    await addLine(gateSuperseded.claimId, gateSuperseded.activityIds[1]),
    await addDx(gateSuperseded.claimId, gateSuperseded.diagnosisIds[0], 'PRIMARY'),
    await removeLineHttp(supersededLine.body?.id),
    await setPointers(supersededLine.body?.id, []),
    await orderLines(gateSuperseded.claimId, [supersededLine.body?.id]),
  ]
  const supersededRead = await listLines(gateSuperseded.claimId)
  check(
    'T071',
    'Bound handoff composer',
    reached &&
      /composeA6Handoff\(claim\.preClaimReadinessAssessmentId, tx\)/.test(lineServiceCode) &&
      /Prisma\.TransactionIsolationLevel\.Serializable/.test(lineServiceCode) &&
      gateCalls(lineServiceCode) === 4 &&
      gateCalls(dxServiceCode) === 3 &&
      writeCalls(lineServiceCode) === 4 &&
      writeCalls(dxServiceCode) === 3 &&
      !/a6-handoff|fetch\(/.test(moduleCode.code),
    'every one of the seven A6.2 writes opens the Claim gate, which runs the A5.9 composer on the write transaction itself; no HTTP handoff call',
  )
  check(
    'T072',
    'Superseded Claim basis',
    supersededLine.status === 201 &&
      supersededWrites.every((res) => res.status === 409 && errorCode(res.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION') &&
      supersededRead.status === 200 &&
      (supersededRead.body?.items ?? []).length === 1,
    'after a newer run, create, diagnosis, remove, pointer and reorder writes are each 409 READINESS_SUPERSEDED_BY_NEWER_VALIDATION; the history stays readable',
  )
  const tie = await sourcedClaim('tie gate', 1, 0)
  await copyRunAtSameInstant(tie.runId)
  const tieWrite = await addLine(tie.claimId, tie.activityIds[0])
  check('T073', 'Recency tie', tieWrite.status === 409 && errorCode(tieWrite.body) === 'VALIDATION_RUN_RECENCY_AMBIGUOUS' && (await prisma.claimLine.count({ where: { claimId: tie.claimId } })) === 0, '409 VALIDATION_RUN_RECENCY_AMBIGUOUS; no identifier wins')
  // An incompatible basis cannot come from the A6.1 owner route (it refuses), so the assessment and the
  // Claim bound to it are inserted directly to prove A6.2 refuses it on its own.
  const incompatibleEncounter = await plainEncounter('incompatible')
  const incompatibleActivity = await addActivity(incompatibleEncounter.id, { serviceId: svcA.id, quantity: '1' })
  const incompatibleRun = await recordRun(incompatibleEncounter.id, sourceFindings([incompatibleActivity.id], []))
  const incompatibleAssessment = (
    await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO pre_claim_readiness_assessments (id, validation_run_id, readiness_policy_version, state, assessed_at, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, 'A5-READY-2', 'READY_FOR_REVIEW', now(), $2::uuid) RETURNING id::text AS id`,
      incompatibleRun,
      actorUserId,
    )
  )[0].id
  const incompatibleClaim = (
    await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO claims (id, encounter_id, pre_claim_readiness_assessment_id, claim_contract_version, handoff_schema_version, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'A6-CLAIM-1', 'PreClaimA6HandoffV1', $3::uuid) RETURNING id::text AS id`,
      incompatibleEncounter.id,
      incompatibleAssessment,
      actorUserId,
    )
  )[0].id
  const incompatibleWrite = await addLine(incompatibleClaim, incompatibleActivity.id)
  check('T074', 'Incompatible handoff', incompatibleWrite.status === 409 && errorCode(incompatibleWrite.body) === 'CLAIM_HANDOFF_INCOMPATIBLE' && (await prisma.claimLine.count({ where: { claimId: incompatibleClaim } })) === 0, 'a Claim bound to an A5-READY-2 assessment refuses mutation with 409 CLAIM_HANDOFF_INCOMPATIBLE')
  const imports = [...moduleCode.code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  check(
    'T075',
    'No readiness recompute',
    reached &&
      !imports.some((p) => /pre-claim-validation|validation-run\.recorder|pre-claim-readiness\.policy|evidence-completeness|authorization-line\.matcher/.test(p)) &&
      !/reduceReadiness|recordValidationRunInTransaction|executePreClaimValidation|'RESTRICT'|'FAIL'|'WARNING'|'READY_FOR_REVIEW'|'BLOCKED'/.test(moduleCode.code),
    'A6.2 imports and runs no readiness reducer, validation engine or recorder',
  )
  check(
    'T076',
    'No A3 execution',
    reached && !imports.some((p) => /rule-(resolution|provenance|applicability|pack|version|source)/.test(p)) && !/\b(compose|resolve|infer)\w*(Provenance|Rule|Applicability)\b/.test(moduleCode.code),
    'no applicability, precedence or provenance composition in A6.2',
  )
  const lateActivity = await addActivity(mainEncounter.id, { serviceId: svcA.id, quantity: '4' })
  const lateWrite = await addLine(C, lateActivity.id)
  check(
    'T077',
    'No A4 current-source substitution',
    reached && lateWrite.status === 409 && errorCode(lateWrite.body) === 'CLAIM_SOURCE_NOT_IN_HANDOFF' && !/findActiveEncounter(Activities|Diagnoses)|encounterActivity\.findMany|encounterDiagnosis\.findMany/.test(moduleCode.code),
    'an activity recorded after the validation is refused; sources are only the exact handoff ids, never the current Encounter list',
  )
  check(
    'T078',
    'A5 history unchanged',
    JSON.stringify(await prisma.validationRun.findUniqueOrThrow({ where: { id: mainRun } })) === runBefore &&
      JSON.stringify(await prisma.validationFinding.findMany({ where: { validationRunId: mainRun }, orderBy: { sequence: 'asc' } })) === findingsBefore &&
      JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: mainAssessment.id } })) === assessmentBefore,
    'the bound run, its findings and the assessment are byte-identical after every line, diagnosis and pointer mutation',
  )
  check('T079', 'Claim identity unchanged', JSON.stringify(await prisma.claim.findUniqueOrThrow({ where: { id: C } })) === claimBefore, 'the Claim row is byte-identical; A6.2 never rebinds it')
  const multi = await sourcedClaim('multi claim', 1, 0)
  const multiFirstLine = lineOk(await addLine(multi.claimId, multi.activityIds[0]))
  const multiFirstBefore = JSON.stringify(await linesOf(multi.claimId))
  const multiSecondAssessment = await assess(await recordRun(multi.encounterId, sourceFindings(multi.activityIds, [])))
  const multiSecondClaim = await claimFor(multiSecondAssessment.id)
  const multiSecondLine = lineOk(await addLine(multiSecondClaim.id, multi.activityIds[0]))
  check(
    'T080',
    'Multiple Claim histories',
    multiFirstLine.status === 201 && multiSecondLine.status === 201 && JSON.stringify(await linesOf(multi.claimId)) === multiFirstBefore && (await prisma.claimLine.count({ where: { claimId: multiSecondClaim.id } })) === 1,
    'a second Claim of the same Encounter gets its own line for the same activity; the first Claim’s structure is untouched',
  )

  // ---------------------------------------------------------------- reads (T081–T085)
  section('Reads and tenancy')
  const adminLines = await listLines(C)
  const adminDx = await listDx(C)
  check('T081', 'Admin own-org reads', adminLines.status === 200 && adminDx.status === 200 && (adminLines.body?.items ?? []).length === 2 && (adminDx.body?.items ?? []).length === 2, `lines ${adminLines.status}, diagnoses ${adminDx.status}`)
  const viewerLines = await listLines(C, asViewer)
  const viewerDxList = await listDx(C, asViewer)
  check('T082', 'Viewer own-org reads', viewerLines.status === 200 && viewerDxList.status === 200 && same(viewerLines.body, adminLines.body), `lines ${viewerLines.status}, diagnoses ${viewerDxList.status}`)
  const foreignLines = foreignClaimId ? await listLines(foreignClaimId) : null
  const foreignDx = foreignClaimId ? await listDx(foreignClaimId) : null
  check(
    'T083',
    'Cross-tenant reads',
    foreignLines !== null && foreignDx !== null && foreignLines.status === 403 && foreignDx.status === 403 && !leaks(foreignLines.body) && !leaks(foreignDx.body),
    foreignLines === null ? 'no foreign-tenant Claim could be created to prove this' : '403/403; no source fact disclosed',
  )
  const malformedReads = [await api('GET', '/api/claims/not-a-uuid/lines'), await api('GET', '/api/claims/not-a-uuid/diagnoses'), await api('GET', `/api/claims/${MISSING}/lines`), await api('POST', '/api/claim-lines/not-a-uuid/remove', {})]
  check(
    'T084',
    'Malformed read IDs',
    same(malformedReads.map((res) => res.status), [400, 400, 404, 400]) && malformedReads.every((res) => !rawError(res.body)),
    `${malformedReads.map((res) => res.status).join('/')}; no raw database error`,
  )
  const listedIds = (adminLines.body?.items ?? []).map((item: any) => item.id)
  check(
    'T085',
    'Removed rows normal read',
    !listedIds.includes(L1?.id) && !listedIds.includes(L4?.id) && (await prisma.claimLine.count({ where: { claimId: C, removedAt: { not: null } } })) === 2 && !(adminDx.body?.items ?? []).some((item: any) => item.id === DA?.id),
    'normal lists show active rows only; removed lines and diagnoses remain in the database',
  )

  // ---------------------------------------------------------------- audit (T086–T094)
  section('Business audit')
  const lineAdded = await prisma.auditEvent.findMany({ where: { actionCode: 'claim_line.added', entityId: { in: createdLineIds } } })
  check('T086', 'Line audit count', createdLineIds.length >= 10 && createdLineIds.every((id) => lineAdded.filter((row) => row.entityId === id).length === 1), `exactly one claim_line.added for each of the ${createdLineIds.length} lines created by this run`)
  const reorderRows = await auditsOf('claim_line.reordered', C)
  check(
    'T087',
    'Line reorder audit',
    reorderRows.length === 1 && reorderRows[0].entityType === 'CLAIM' && same(Object.keys(reorderRows[0].beforeState as object), ['claimLineIds']) && same(Object.keys(reorderRows[0].afterState as object), ['claimLineIds']),
    'one minimal event with the before/after active line id order only',
  )
  const removalRows = [...(await auditsOf('claim_line.removed', L1?.id)), ...(await auditsOf('claim_line.removed', L4?.id))]
  check('T088', 'Line remove audit', removalRows.length === 2 && removalRows.every((row) => same(Object.keys(row.afterState as object).sort(), ['id', 'removedAt'])), 'one removal event per removed line')
  const dxAdded = await prisma.auditEvent.findMany({ where: { actionCode: 'claim_diagnosis.added', entityId: { in: createdDiagnosisIds } } })
  check('T089', 'Diagnosis audit count', createdDiagnosisIds.length >= 5 && createdDiagnosisIds.every((id) => dxAdded.filter((row) => row.entityId === id).length === 1), `exactly one claim_diagnosis.added for each of the ${createdDiagnosisIds.length} diagnoses created by this run`)
  const pointerRows = await auditsOf('claim_line_diagnoses.changed', L3?.id)
  check(
    'T090',
    'Pointer audit',
    pointerRows.length === 2 && pointerRows.every((row) => same(Object.keys(row.beforeState as object), ['claimDiagnosisIds']) && same(Object.keys(row.afterState as object), ['claimDiagnosisIds'])),
    'one minimal claim_line_diagnoses.changed per real change (set, then clear); the no-op repeat wrote none',
  )
  const allA62Audits = await prisma.auditEvent.findMany({ where: { actionCode: { in: A62_ACTIONS }, occurredAt: { gte: runStartedAt } } })
  const allowedSnapshotKeys = new Set(['id', 'sequence', 'claimLineContractVersion', 'claimDiagnosisContractVersion', 'roleCode', 'createdAt', 'removedAt', 'claimLineIds', 'claimDiagnosisIds'])
  const auditText = JSON.stringify(allA62Audits.map((row) => [row.beforeState, row.afterState]))
  check(
    'T091',
    'Audit minimization',
    allA62Audits.length > 0 &&
      allA62Audits.every((row) => [...deepKeys(row.beforeState), ...deepKeys(row.afterState)].every((k) => allowedSnapshotKeys.has(k))) &&
      !auditText.includes(a1.id) &&
      !auditText.includes(d2.id) &&
      !auditText.includes(dx[1].code) &&
      !/SYN-UNIT|SYN-M1|SYNTHETIC_|quantity|modifier|displayName/.test(auditText),
    'ids, positions, contracts, roles and timestamps only; no source id, code text, quantity, modifier, patient, member, payer, finding or evidence value',
  )
  const rollbackClaim = await sourcedClaim('rollback', 3, 2)
  const rollbackSnapshot = async () => JSON.stringify([await linesOf(rollbackClaim.claimId), await prisma.claimDiagnosis.findMany({ where: { claimId: rollbackClaim.claimId }, orderBy: { id: 'asc' } }), await prisma.claimLineDiagnosisPointer.findMany({ where: { claimLine: { claimId: rollbackClaim.claimId } }, orderBy: { id: 'asc' } }), await a62Audits()])
  const forced = async (probe: string, action: () => Promise<unknown>) => {
    const before = await rollbackSnapshot()
    failAt(probe, 'forced failure (acceptance)')
    let threw = false
    try {
      await action()
    } catch {
      threw = true
    }
    clearConcurrencyProbes()
    return threw && (await rollbackSnapshot()) === before
  }
  const rbLine = await createClaimLine(rollbackClaim.claimId, { encounterActivityId: rollbackClaim.activityIds[0] }, actorUserId)
  const rbDx = await createClaimDiagnosis(rollbackClaim.claimId, { encounterDiagnosisId: rollbackClaim.diagnosisIds[0], roleCode: 'PRIMARY' }, actorUserId)
  if (rbLine.ok) createdLineIds.push(rbLine.value.id)
  if (rbDx.ok) createdDiagnosisIds.push(rbDx.value.id)
  if (rbLine.ok && rbDx.ok) await setClaimLineDiagnosisPointers(rbLine.value.id, { claimDiagnosisIds: [rbDx.value.id] }, actorUserId)
  const rollbacks = [
    await forced('claimLine.inserted', () => createClaimLine(rollbackClaim.claimId, { encounterActivityId: rollbackClaim.activityIds[1] }, actorUserId)),
    await forced('claimLine.audited', () => createClaimLine(rollbackClaim.claimId, { encounterActivityId: rollbackClaim.activityIds[2] }, actorUserId)),
    await forced('claimDiagnosis.audited', () => createClaimDiagnosis(rollbackClaim.claimId, { encounterDiagnosisId: rollbackClaim.diagnosisIds[1], roleCode: 'SECONDARY' }, actorUserId)),
    rbLine.ok && (await forced('claimLine.removed', () => removeClaimLine(rbLine.value.id, {}, actorUserId))),
    rbLine.ok && (await forced('claimLine.pointersChanged', () => setClaimLineDiagnosisPointers(rbLine.value.id, { claimDiagnosisIds: [] }, actorUserId))),
  ]
  check('T092', 'Atomic rollback', rbLine.ok && rbDx.ok && rollbacks.every(Boolean), `a forced failure after an insert, an audit, a removal with pointer cleanup, or a pointer change leaves nothing partial (${rollbacks.filter(Boolean).length}/5)`)
  const auditsBeforeReads = await prisma.auditEvent.count()
  await listLines(C)
  await listDx(C)
  await listLines(C, asViewer)
  await listDx(C, asViewer)
  check('T093', 'No audit on reads', (await prisma.auditEvent.count()) === auditsBeforeReads, 'four line and diagnosis list reads wrote no AuditEvent')
  const auditsBefore94 = await a62Audits()
  const currentOrder = (await listLines(C)).body?.items?.map((item: any) => item.id) ?? []
  const currentDxOrder = (await listDx(C)).body?.items?.map((item: any) => item.id) ?? []
  const noops = [
    await addLine(C, a2.id, asViewer),
    await addLine(C, 'nope'),
    await addLine(C, a4.id),
    await addLine(C, x1.id),
    await addLine(C, a2.id),
    await addDx(C, d2.id, 'PRIMARY'),
    await addDx(C, d5.id, 'primary'),
    await addLine(incompatibleClaim, incompatibleActivity.id),
    await addLine(gateSuperseded.claimId, gateSuperseded.activityIds[1]),
    await removeLineHttp(L1?.id),
    await orderLines(C, currentOrder),
    await orderDx(C, currentDxOrder),
    await setPointers(L3?.id, []),
  ]
  check(
    'T094',
    'No false audit',
    (await a62Audits()) === auditsBefore94 && noops.slice(0, 10).every((res) => res.status >= 400) && noops.slice(10).every((res) => res.status === 200),
    'denied, malformed, unvalidated, wrong-Encounter, duplicate, bad-role, incompatible, superseded and already-removed attempts, and identical reorders and pointer sets, wrote no AuditEvent',
  )

  // ---------------------------------------------------------------- privacy scans (T095–T098)
  section('Logging, storage, URL and synthetic-data scans')
  const scanPaths = [`:/${LINE_DIR}`, `:/${DX_DIR}`, `:/${FE_LINE_DIR}`, `:/${FE_DX_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const logReach = gitGrep('openClaimStructureGate|ClaimLineCheck', scanPaths)
  check('T095', 'Logging scan', logReach.status === 0 && logScan.status === 1, 'no source, claim structure or clinical value is logged (search verified to reach the source)')
  check(
    'T096',
    'Browser storage scan',
    feCode.files.length === 2 && feCode.code.includes('ClaimLineCheck') && !/\b(localStorage|sessionStorage|indexedDB)\b/.test(feCode.code) && !/\.quantity|modifierCodes|displayName|\.source\.code/.test(feCode.code),
    'nothing in browser storage; the checks show ids, positions, roles and pointer ids only',
  )
  const routeCode = committedCode(`${LINE_DIR}/claim-line.route.ts`) + committedCode(`${DX_DIR}/claim-diagnosis.route.ts`)
  check(
    'T097',
    'URL discipline',
    reached && !/req\.query/.test(moduleCode.code) && !/fetch\(`[^`]*\?/.test(feCode.code) && !/URLSearchParams/.test(feCode.code) && !/'\/[^']*\?/.test(routeCode),
    'path UUIDs and JSON bodies only; no source fact or id in a query string',
  )
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git(`show HEAD:${HARNESS_DIR}/a6-claim-line-diagnosis.integration.ts`)
  check('T098', 'Synthetic-data proof', harnessSource.length > 0 && harnessSource.match(realDataMarkers) === null && runId.startsWith('A62-'), 'fixtures are runId-keyed synthetic values; no real patient, member or claim marker')

  // ---------------------------------------------------------------- market and HIE boundaries (T099–T108)
  section('UAE-preserving multi-market and clinical/HIE boundaries')
  const lineage = (
    await prisma.$queryRaw<{ jurisdiction: string; authority: string }[]>`
      SELECT profile.jurisdiction_code AS jurisdiction, profile.regulatory_authority_code AS authority
      FROM claims claim
      JOIN pre_claim_readiness_assessments assessment ON assessment.id = claim.pre_claim_readiness_assessment_id
      JOIN validation_runs run ON run.id = assessment.validation_run_id
      JOIN facility_regulatory_profiles profile ON profile.id = run.facility_regulatory_profile_id
      WHERE claim.id = ${C}::uuid`
  )[0]
  const dubaiColumns = a62Columns.filter((name) => /dhpo|eclaim|xml|soap|file_id|activity_type|wire|transaction|jurisdiction|country|market|emirate/i.test(name))
  check('T099', 'UAE jurisdiction path', lineage?.jurisdiction === 'AE-DU' && lineage?.authority === 'DHA' && (await prisma.claimLine.count({ where: { claimId: C, removedAt: null } })) === 2 && dubaiColumns.length === 0, 'an AE-DU/DHA Claim built its structure with no Dubai-specific table field')
  const rolesCode = committedCode(`${DX_DIR}/claim-diagnosis.types.ts`)
  check(
    'T100',
    'Current UAE role capture',
    /'PRIMARY', 'SECONDARY', 'ADMITTING'/.test(rolesCode) && storedDP?.roleCode === 'PRIMARY' && DS?.roleCode === 'SECONDARY' && !/\b(xml\w*|toXml|buildPayload|canonicalPayload|serializeClaim\w*)\b|JSON\.stringify/i.test(moduleCode.code),
    'PRIMARY and SECONDARY (and ADMITTING) are captured as canonical roles; nothing is serialized',
  )
  check('T101', 'No UAE payload hard-code', reached && dubaiColumns.length === 0 && !/\b(dhpo|eclaimlink|soap|xml)\b|['"`](AE-DU|AE-AZ|DHA|DOH|AED)['"`]/i.test(moduleCode.code + feCode.code), 'no DHPO, eClaimLink, XML, SOAP, file or activity-wire field or literal')
  check('T102', 'No global market switch', reached && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION)\w*/i.test(moduleCode.code) && !/\b(MARKET_MODE|marketMode|countryMode)\b/.test(moduleCode.code), 'no process-global UAE/US mode')
  const usColumns = a62Columns.filter((name) => /npi|medicare|medicaid|x12|clearinghouse|cpt|hcpcs|icd/i.test(name))
  check('T103', 'No US core fields', reachedColumns && usColumns.length === 0 && !/\b(npi|medicare|medicaid|x12|clearinghouse)\b/i.test(moduleCode.code), 'no NPI, Medicare, Medicaid, X12 or clearinghouse column or behaviour')
  check(
    'T104',
    'Future US pointer compatibility',
    same(sorted(pointerColumns), sorted(['id', 'claim_line_id', 'claim_diagnosis_id', 'removed_at', 'created_by_user_id', 'created_at', 'updated_at'])) && same(l3After66?.claimDiagnosisIds, [DP?.id, DS?.id]),
    'the diagnosis order and the optional pointers are internal canonical structure that any adapter can map',
  )
  const hieScan = (name: RegExp) => reached && !a62Columns.some((column) => name.test(column)) && !name.test(moduleCode.code + feCode.code)
  check('T105', 'NABIDH boundary', hieScan(/nabidh/i), 'no NABIDH message, status or identifier')
  check('T106', 'Malaffi boundary', hieScan(/malaffi/i), 'no Malaffi message, status or identifier')
  check('T107', 'Riayati boundary', hieScan(/riayati/i), 'no Riayati message, status or identifier')
  check('T108', 'Connected Care separation', hieScan(/\b(hl7|fhir|hie|his_\w+|clinical_\w+)\b/i) && same(sorted(createdTables), A62_TABLES), 'no clinical or HIS table or field joins the claim structure')

  // ---------------------------------------------------------------- A1 provisioning (T109)
  section('A1 provisioning')
  const organizationsBefore = await prisma.organization.count()
  const anonymousCreate = await httpCall('/api/organizations', anonymous({ method: 'POST', body: JSON.stringify({ name: `${runId} org` }) }))
  const adminCreate = await post('/api/organizations', { name: `${runId} org` })
  check('T109', 'A1 provisioning security', anonymousCreate.status === 404 && adminCreate.status === 404 && (await prisma.organization.count()) === organizationsBefore, `anonymous ${anonymousCreate.status}, admin ${adminCreate.status}; no Organization written`)

  // ---------------------------------------------------------------- source trace and structure (T128–T129)
  section('Source trace reconstruction and absence of later-phase fields')
  const dtoKeys = [...deepKeys(adminLines.body), ...deepKeys(adminDx.body), ...deepKeys(L1), ...deepKeys(DP)]
  const laterFields = [...a62Columns, ...dtoKeys].filter((name) => /price|^rate|Rate|fee|amount|currency|state|status|approv|payload|hash|submi|transport|tariff/i.test(name))
  check('T128', 'No price/lifecycle/payload', reachedColumns && laterFields.length === 0, laterFields.length === 0 ? 'no money, claim state, approval, payload, ClaimSubmission or transport field in the schema or DTOs' : laterFields.join(', '))
  const traced = await prisma.$queryRaw<{ kind: string; ok: boolean }[]>`
    SELECT 'line' AS kind, bool_and(activity.encounter_id = claim.encounter_id AND EXISTS (
      SELECT 1 FROM validation_findings finding WHERE finding.validation_run_id = assessment.validation_run_id AND finding.encounter_activity_id = activity.id)) AS ok
    FROM claim_lines line
    JOIN claim_line_source_activities source ON source.claim_line_id = line.id
    JOIN encounter_activities activity ON activity.id = source.encounter_activity_id
    JOIN claims claim ON claim.id = line.claim_id
    JOIN pre_claim_readiness_assessments assessment ON assessment.id = claim.pre_claim_readiness_assessment_id
    WHERE line.claim_id = ${C}::uuid
    UNION ALL
    SELECT 'diagnosis' AS kind, bool_and(diagnosis.encounter_id = claim.encounter_id AND EXISTS (
      SELECT 1 FROM validation_findings finding WHERE finding.validation_run_id = assessment.validation_run_id AND finding.encounter_diagnosis_id = diagnosis.id)) AS ok
    FROM claim_diagnoses claim_diagnosis
    JOIN encounter_diagnoses diagnosis ON diagnosis.id = claim_diagnosis.encounter_diagnosis_id
    JOIN claims claim ON claim.id = claim_diagnosis.claim_id
    JOIN pre_claim_readiness_assessments assessment ON assessment.id = claim.pre_claim_readiness_assessment_id
    WHERE claim_diagnosis.claim_id = ${C}::uuid`
  check(
    'T129',
    'Source trace reconstruction',
    traced.length === 2 && traced.every((row) => row.ok === true),
    'every line and diagnosis, active or removed, reconstructs Claim -> exact Encounter source -> bound run finding without any copied master truth',
  )

  // ---------------------------------------------------------------- regressions (T110–T119)
  section('Regressions — A6.1 invoked, nesting A5.10 -> A1')
  await apiReady('the A6.1 and backward regression chain')
  const chain = run('npm run test:a6:claim-foundation')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A6.1')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.1] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.1 asserts facts about its own branch, its own diff and that no A6.2 structure exists yet. On A6.2
  // those statements are obsolete by design; every other A6.1 check is substantive and must PASS.
  const a61NonApplicable: Record<string, string> = {
    T001: "A6.1 'Start gate' requires the current branch to be the A6.1 feature branch; A6.2 is branched from the main that contains A6.1",
    T003: "A6.1 'Migration scope' judges the single migration this branch adds against main; on A6.2 that is the A6.2 migration",
    T006: "A6.1 'Permissions' treats any claimLine.* permission as invented; A6.2 adds exactly the claimLine/claimDiagnosis family (proven by T006 here)",
    T030: "A6.1 'No ClaimLine' asserts no claim_lines/claim_diagnoses table; A6.2 creates exactly those tables",
    T102: "A6.1 'Diff scope' lists the paths A6.1 was allowed to change and treats claim-line paths as later domain; A6.2 is that domain",
    T110: "A6.1 'Exact head evidence' requires the upstream to be the A6.1 feature branch, deleted when it merged",
  }
  const undocumented = failing.filter((id) => !(id in a61NonApplicable))
  const counts = chain.output.match(/\[A6\.1\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T096') && rows.some((row) => row.id === 'T057') && !/\[A6\.1\] RUN ABORTED|\[A6\.1\] uncaught error/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check('T110', 'A1 health truth', verdictOf('T083') === 'PASS', `A6.1 T083 (A1 health truth through the owner chain) ${verdictOf('T083')}`)
  check('T111', 'A2 regression', verdictOf('T084') === 'PASS', `A6.1 T084 (A2 through A5.10 -> A4) ${verdictOf('T084')}`)
  check('T112', 'A3 regression', verdictOf('T085') === 'PASS', `A6.1 T085 (A3, with the A3.9 scope suite run directly) ${verdictOf('T085')}`)
  check('T113', 'A4.5 regression', verdictOf('T086') === 'PASS', `A6.1 T086 (A4.10 and A4.9 to A1, including A4.5 diagnosis order/remove/history) ${verdictOf('T086')}`)
  check('T114', 'A4.6 regression', verdictOf('T086') === 'PASS', `A6.1 T086 (including A4.6 activity Decimal/modifier/remove/history) ${verdictOf('T086')}`)
  check('T115', 'A4.9 regression', verdictOf('T086') === 'PASS', `A6.1 T086 (including A4.9 canonical billing context) ${verdictOf('T086')}`)
  check('T116', 'A5.8 regression', verdictOf('T094') === 'PASS', `A6.1 T094 (A5.8) ${verdictOf('T094')}`)
  check('T117', 'A5.9 regression', verdictOf('T095') === 'PASS', `A6.1 T095 (A5.9) ${verdictOf('T095')}`)
  check('T118', 'A5.10 regression', verdictOf('T096') === 'PASS', `A6.1 T096 (A5.10) ${verdictOf('T096')}`)
  check(
    'T119',
    'A6.1 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A6.1 suite did not complete'
      : !reconciled
        ? `A6.1 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.1 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.1\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.1] automated summary: ', 'A6.1 ')}; all ${failedCount} failure(s) are exact obsolete branch/phase guards`,
  )
  for (const id of Object.keys(a61NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T119/${id}`, `A6.1 ${titleOf(row.line)}`, a61NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0) {
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[A6.2]      ${text.slice(0, 400)}`)
  }

  // ---------------------------------------------------------------- build gates (T120–T123)
  section('Build gates and replay')
  const unitTests = run('npm run test:unit')
  check('T120', 'Unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), (unitTests.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0])
  const typecheck = run('npm run typecheck')
  check('T121', 'Typecheck', typecheck.ok, 'backend typecheck clean')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T122', 'Frontend build/lint', build.ok && lint.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)
  const replay = run('npm run db:verify:replay')
  const replayA62 = [
    /PASS {2}the A6\.2 CHECKs pin A6-LINE-1, A6-DX-1 and exactly PRIMARY, SECONDARY and ADMITTING/,
    /PASS {2}claim_lines_active_sequence_uidx is a partial unique index/,
    /PASS {2}claim_diagnoses_active_source_uidx is a partial unique index/,
    /PASS {2}claim_line_diagnosis_pointers_active_uidx is a partial unique index/,
    /PASS {2}claim_line_source_activities_insert_guard_trg is present/,
    /PASS {2}claim_lines_source_required_trg is present/,
    /PASS {2}claim_lines carries exactly its 8 A6\.2 columns/,
    /PASS {2}the claim tables are exactly claims plus the four A6\.2 tables/,
  ]
  check(
    'T123',
    'DB replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayA62.every((pattern) => pattern.test(replay.output)),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the A6.2 constraints, partial indexes and guards survive`,
  )

  // ---------------------------------------------------------------- DB truth (T124)
  await apiReady('the DB truth check')
  const upHealth = await health()
  const upReady = await ready()
  const stopped = spawnSync('docker', ['stop', dbContainer], { encoding: 'utf8' }).status === 0
  const downReady = await waitFor(async () => (await ready()) === 503, 30_000)
  const downSamples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    downSamples.push(await health())
    await pause(400)
  }
  const restarted = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  check('T124', 'DB health truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- closure (T125–T127, T130)
  section('Repeatability, diff scope, secrets and exact head')
  await waitFor(databaseUp, 60_000)
  const priorLinesNow = await prisma.claimLine.count({ where: { createdAt: { lt: runStartedAt } } })
  const priorDiagnosesNow = await prisma.claimDiagnosis.count({ where: { createdAt: { lt: runStartedAt } } })
  check(
    'T125',
    'Repeatability',
    createdLineIds.length >= 10 && priorLinesNow === priorLinesAtStart && priorDiagnosesNow === priorDiagnosesAtStart,
    `this run used a fresh synthetic runId (${runId}) and fresh Claims; all ${priorLinesNow} line(s) and ${priorDiagnosesNow} diagnosis(es) from earlier runs are retained as history`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/database/row-lock.ts',
    'backend/src/shared/errors/error.types.ts',
    'frontend/src/developer/checkRegistry.tsx',
  ]
  const ownDirs = [LINE_DIR, DX_DIR, FE_LINE_DIR, FE_DX_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !file.includes('a6_2_claim_line_diagnosis_source_traceability') && !allowed.includes(file))
  const laterDomain = changedPaths.filter((file) => /submission|pricing|tariff-rate|claim-price|transmission|remittance|integration\/a9|nabidh|malaffi|riayati/i.test(file))
  check(
    'T126',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && laterDomain.length === 0,
    outOfScope.length === 0 && laterDomain.length === 0
      ? `${changedPaths.length} path(s): the two A6.2 modules, migration, harness and check pages, the shared lock list, vocabularies, the replay verifier and wiring; no A6.3+, A9 or HIE domain`
      : `unexpected: ${[...outOfScope, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [`:/${HARNESS_DIR}`, ...scanPaths],
  )
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [`:/${HARNESS_DIR}`])
  check('T127', 'Secret scan', secretReach.status === 0 && secretScan.status === 1, 'no credential, private key, payer or HIE secret is committed (search verified to reach the harness)')
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T130',
    'Exact head evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a62Branch}`) && !/ahead|behind/.test(tracking),
    `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A6.2] run ${runId} — HEAD ${headSha}`)
  console.log(`[A6.2] main Claim ${C}: ${(await prisma.claimLine.count({ where: { claimId: C } }))} line row(s), ${(await prisma.claimDiagnosis.count({ where: { claimId: C } }))} diagnosis row(s), active and removed history`)
  if (failures.length > 0) {
    console.log(`[A6.2] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.2] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.2] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.2] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.2] CLAIM LINE / DIAGNOSIS / SOURCE TRACEABILITY ACCEPTANCE COMPLETE' : '[A6.2] A6.2 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.2] RUN ABORTED: ${error.message}`)
      console.log('[A6.2] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.2] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.2] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
