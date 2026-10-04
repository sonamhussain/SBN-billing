import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { apiFixtures } from '../a3-governance/a3-governance.fixtures.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { insertGovernedProvenance } from '../../modules/pre-claim-validation/pre-claim-validation.provenance.ts'
import { recordReadinessAssessment } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'

// A5.9 — focused acceptance for Pre-Claim Readiness & the A6 Handoff Contract (T01–T110).
//
// One exact immutable A5-VAL-1 ValidationRun is reduced under readiness policy A5-READY-1 to one
// immutable READY_FOR_REVIEW, RESTRICTED or BLOCKED assessment, and a READY_FOR_REVIEW assessment of the
// Encounter's latest run exposes the read-only PreClaimA6HandoffV1 reference contract.
//
// Valid fixtures are created through their owning routes. One real A5.8 execution proves the end-to-end
// path; every outcome mix is otherwise a synthetic run recorded through A5.7's own internal recorder, so
// the outcomes under test are exact. Every recency scenario gets an Encounter of its own. ADVERSARIAL
// writes go in only to create a state no owner path can create (two runs at one instant) or to prove
// something refuses them. Every value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.9] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.9] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.9] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.9] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
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
const committedCodeOf = (dir: string) => {
  const files = committedFiles(dir)
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}
const committedProductionCodeOf = (dirs: string[]) => {
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A59-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.8 FINAL PASS was merged into main as PR #61; PR #62 then scoped the A5.4, A5.7 and A5.8 readiness
// scans to behaviour and was merged before A5.9. A5.9 is branched from that main.
const a58Merge = 'b8c7c5e'
const scanCorrection = '97a08d5'
const a59Branch = 'feature/a5-9-pre-claim-readiness-a6-handoff'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const FRESH_UNTIL = '2030-12-31T00:00:00.000Z'
const DOC = 'DOCUMENTATION_REQUIREMENT_EFFECT'
const MODULE_DIR = 'backend/src/modules/pre-claim-readiness'
const FRONTEND_DIR = 'frontend/src/modules/pre-claim-readiness'
const HARNESS_DIR = 'backend/src/integration/a5-readiness'
const TABLE = 'pre_claim_readiness_assessments'
const ENTITY = 'PRE_CLAIM_READINESS_ASSESSMENT'
const ACTION = 'pre_claim_readiness.recorded'

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

// The harness's own statement of A5-READY-1, kept apart from the module so the module is judged
// against the document rather than against itself.
const expectedState = (outcomes: string[]) => (outcomes.includes('FAIL') ? 'BLOCKED' : outcomes.includes('RESTRICT') ? 'RESTRICTED' : 'READY_FOR_REVIEW')
const sortedSet = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => typeof id === 'string'))].sort()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.9] Pre-claim readiness & A6 handoff contract — run ${runId}`)
  console.log(`[A5.9] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  const priorAssessmentsAtStart = await prisma.preClaimReadinessAssessment.count({ where: { createdAt: { lt: runStartedAt } } })

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, migration and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'Start gate',
    branch === a59Branch && gitOk(`merge-base --is-ancestor ${a58Merge} origin/main`) && gitOk(`merge-base --is-ancestor ${scanCorrection} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.8 merge ${a58Merge} (PR #61) and the scan correction ${scanCorrection} (PR #62) are on main, and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, ''))
  const schemaDiff = git('diff origin/main...HEAD -- :/backend/prisma/schema.prisma').split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const schemaAddedModels = schemaDiff.filter((l) => /^\+\s*model /.test(l)).map((l) => l.replace(/^\+\s*model\s+(\w+).*$/, '$1'))
  const backRelations = schemaDiff.filter((l) => /^\+\s+\w+\s+PreClaimReadinessAssessment\[\]/.test(l))
  const scopeProblems = [
    [same(createdTables, [TABLE]), `tables created: ${createdTables.join(', ')}`],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => m.includes(`"${TABLE}"`)), 'a table outside A5.9 is altered'],
    [(statements.match(/ADD CONSTRAINT "[a-z_]*_chk"/g) ?? []).length === 2, 'the state and policy CHECKs are not both added'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 2, 'the two foreign keys are not both ON DELETE RESTRICT'],
    [(statements.match(/CREATE TRIGGER [a-z_]+_trg/g) ?? []).length === 1 && /BEFORE UPDATE OR DELETE/.test(statements), 'the one UPDATE/DELETE trigger is not created'],
    [!/\b(jsonb?|claim_line|claim_submission|price|amount|is_current|is_latest|approved)\b/i.test(statements), 'a JSON, claim, pricing, pointer or approval column appears'],
    [schemaRemoved.length === 0 && same(schemaAddedModels, ['PreClaimReadinessAssessment']) && backRelations.length === 2, 'the schema diff is not exactly the model and its two back-relations'],
  ].filter(([ok]) => !ok).map(([, reason]) => reason as string)
  check(
    'T03',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1
      ? `expected exactly one migration, found ${migrationPaths.length}`
      : scopeProblems.length === 0
        ? 'one migration; exactly pre_claim_readiness_assessments with two CHECKs, two RESTRICT foreign keys, the unique key and one UPDATE/DELETE trigger; the schema adds only the model and its ValidationRun/User back-relations; no drift'
        : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'Migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /pre_claim_readiness_assessments_append_only_trg is present/.test(replay.output) &&
      /pre_claim_readiness_assessments_state_chk is present/.test(replay.output) &&
      /pre_claim_readiness_assessments_policy_version_chk is present/.test(replay.output) &&
      /pre_claim_readiness_assessments_validation_run_id_fkey is present/.test(replay.output) &&
      /pre_claim_readiness_assessments_created_by_user_id_fkey is present/.test(replay.output) &&
      /PASS {2}the one-assessment-per-run-and-policy unique index is present/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the A5.9 foreign keys, unique key, CHECKs and trigger survive`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const readinessCodes = allCodes.filter((code) => /^preClaim(Readiness|A6Handoff)/.test(code)).sort()
  const invented = allCodes.filter((code) => /^(claim|claimLine|claimSubmission)\./i.test(code) || /(approve|submit|override)/i.test(code))
  check(
    'T06',
    'Permissions',
    same(readinessCodes, ['preClaimA6Handoff.read', 'preClaimReadiness.evaluate', 'preClaimReadiness.read']) &&
      (await grantsOf('preClaimReadiness.evaluate')) === 'ORG_ADMIN' &&
      (await grantsOf('preClaimReadiness.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('preClaimA6Handoff.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      invented.length === 0,
    invented.length === 0 ? 'evaluate for Admin only; read and handoff-read for Admin and Viewer; no approve, submit, override or claim permission' : `unexpected: ${invented.join(', ')}`,
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
  const post = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'POST', body: JSON.stringify(body) }))
  const send = (method: string, path: string, who = asAdmin) => httpCall(path, who({ method, body: '{}' }))
  const get = (path: string, who = asAdmin) => httpCall(path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const fx = apiFixtures(baseUrl, admin.cookie, org, runId)
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  let serial = 0
  const key = (prefix: string) => `${runId}-${prefix}-${++serial}`

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const svcA = must('service A', (await post(`/api/organizations/${org}/services`, { internalCode: key('SA'), displayName: 'Synthetic service A' })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: 'Synthetic service B' })).body)
  const dxA = must('diagnosis A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXA'), displayName: 'Synthetic diagnosis A' })).body)
  const dxB = must('diagnosis B', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXB'), displayName: 'Synthetic diagnosis B' })).body)
  const evidenceArtifact = async (label: string) => {
    const artifact = must(label, (await post(`/api/organizations/${org}/evidence-artifacts`, { storageRef: `synthetic://evidence/${key('E')}`, contentHash: 'e'.repeat(64), documentType: 'SYNTHETIC_RESPONSE', sourceDate: '2026-06-10', receivedAt: '2026-06-15T09:30:00.000Z' })).body) as any
    return { versionId: artifact.latestVersion.id as string, storageRef: artifact.latestVersion.storageRef as string | undefined }
  }
  const evidence1 = await evidenceArtifact('evidence 1')
  const evidence2 = await evidenceArtifact('evidence 2')

  // A commercial world of its own: a payer, a membership and a resolvable contract with a verified tariff.
  const commercialWorld = async (label: string) => {
    const payer = must(`${label} payer`, (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} ${label} payer` })).body)
    const memberIdentifier = `MEM-${key('M')}`
    const membership = must(`${label} membership`, (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier, coverageFrom: '2025-01-01', coverageTo: null })).body)
    const contract = must(`${label} contract`, (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    must(`${label} contract facility`, (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
    const schedule = must(`${label} schedule`, (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
    const tariffVersion = must(`${label} tariff version`, (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
    if ((await post(`/api/tariff-schedule-versions/${tariffVersion.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error(`fixture ${label} tariff verification failed`)
    return { payer, membership, memberIdentifier, contract, schedule, tariffVersion }
  }
  const encounterFor = async (label: string, membershipId: string | null) =>
    must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membershipId })).body) as { id: string }
  const plainEncounter = (label: string) => encounterFor(label, null)

  // ---- one real A5.8 execution
  const realWorld = await commercialWorld('real')
  const realEncounter = await encounterFor('real encounter', realWorld.membership.id)
  must('real activity', (await post(`/api/encounters/${realEncounter.id}/activities`, { serviceId: svcA.id, quantity: '1' })).body)
  must('real diagnosis', (await post(`/api/encounters/${realEncounter.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body)
  must('real eligibility', (await post(`/api/encounters/${realEncounter.id}/eligibility-verifications`, {
    verificationMethod: 'PORTAL', status: 'ELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: FRESH_UNTIL, authorizationRequired: false, referralRequired: null, requestEvidenceVersionId: null, responseEvidenceVersionId: evidence1.versionId,
  })).body)
  const realExecution = await post(`/api/encounters/${realEncounter.id}/pre-claim-validation/execute`, {})
  if (realExecution.status !== 201) throw new Error(`the real A5.8 execution was refused with ${realExecution.status}: ${JSON.stringify(realExecution.body).slice(0, 200)}`)
  const realRunId = (realExecution.body as any).validationRunId as string

  // ---- synthetic runs through A5.7's own recorder
  const storedEncounter = async (encounterId: string) => prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
  const plainContext = async (encounterId: string) => {
    const row = await storedEncounter(encounterId)
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  const recordedRunIds: string[] = []
  const recordRun = async (encounterId: string, findings: Record<string, unknown>[], validatorVersion = 'A5-VAL-1', context?: Record<string, unknown>) => {
    const contextSnapshot = context ?? (await plainContext(encounterId))
    const result = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId, contextSnapshot, validatorVersion, findings }, actorUserId, tx))
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    recordedRunIds.push(result.value.id)
    return result.value.id
  }
  // Two runs at one exact instant cannot come from any owner path: the second is copied from the first
  // with the same evaluation time and a creation time offset by `createdOffset`, plus one finding, in
  // one transaction (so the same-transaction and non-empty-run triggers are satisfied).
  const copyRunAt = async (sourceRunId: string, createdOffset: string, outcome: string) => {
    const newRunId = (await prisma.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid()::text AS id`)[0].id
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO validation_runs (id, encounter_id, service_date, facility_id, facility_regulatory_profile_id, insurance_membership_id, payer_id, tpa_id, network_id, insurance_product_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at)
         SELECT $1::uuid, encounter_id, service_date, facility_id, facility_regulatory_profile_id, insurance_membership_id, payer_id, tpa_id, network_id, insurance_product_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at + $3::interval
         FROM validation_runs WHERE id = $2::uuid`,
        newRunId,
        sourceRunId,
        createdOffset,
      )
      await tx.$executeRawUnsafe(
        `INSERT INTO validation_findings (id, validation_run_id, sequence, layer, outcome, finding_code, message) VALUES (gen_random_uuid(), $1::uuid, 1, 'TECHNICAL', $2, 'SYNTHETIC_COPY', 'Synthetic copy.')`,
        newRunId,
        outcome,
      )
    })
    recordedRunIds.push(newRunId)
    return newRunId
  }

  const assessHttp = async (validationRunId: string, body?: unknown, who = asAdmin) => {
    const res = await httpCall(`/api/validation-runs/${validationRunId}/readiness-assessments`, who(body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) }))
    return { status: res.status, body: res.body as any }
  }
  const createdAssessmentIds: string[] = []
  const assess = async (validationRunId: string) => {
    const res = await assessHttp(validationRunId, {})
    if (res.status !== 201) throw new Error(`a valid assessment was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    createdAssessmentIds.push(res.body.id)
    return res.body as { id: string; validationRunId: string; readinessPolicyVersion: string; state: string; assessedAt: string; createdByUserId: string; createdAt: string }
  }
  const handoff = async (assessmentId: string, who = asAdmin) => {
    const res = await get(`/api/pre-claim-readiness-assessments/${assessmentId}/a6-handoff`, who)
    return { status: res.status, body: res.body as any }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const assessmentsFor = (validationRunId: string) => prisma.preClaimReadinessAssessment.count({ where: { validationRunId } })
  const totalAssessments = () => prisma.preClaimReadinessAssessment.count()
  const readinessAudits = () => prisma.auditEvent.count({ where: { entityType: ENTITY } })
  const totalAudits = () => prisma.auditEvent.count()
  const findingsOf = (validationRunId: string) => prisma.validationFinding.findMany({ where: { validationRunId }, orderBy: { sequence: 'asc' }, include: { consumedDatasetVersions: true } })
  console.log('[A5.9]      fixtures ready: patient, facility, clinician, services, diagnosis codes, evidence, one real A5.8 run, and the synthetic recorder')

  // ---------------------------------------------------------------- creation (T07–T14)
  section('Assessment creation contract')
  const realRunBefore = JSON.stringify(await prisma.validationRun.findUniqueOrThrow({ where: { id: realRunId } }))
  const realFindingsBefore = JSON.stringify(await findingsOf(realRunId))
  const realAssessment = await assess(realRunId)
  const realOutcomes = (await findingsOf(realRunId)).map((f) => f.outcome)
  const realAudit = await prisma.auditEvent.findMany({ where: { entityId: realAssessment.id }, select: { actionCode: true, entityType: true, organizationId: true } })
  check(
    'T07',
    'Admin assess',
    (await assessmentsFor(realRunId)) === 1 && realAssessment.state === expectedState(realOutcomes) && realAudit.length === 1 && realAudit[0].actionCode === ACTION && realAudit[0].entityType === ENTITY && realAudit[0].organizationId === org,
    `the exact A5.8 run (${realOutcomes.length} findings) produced one ${realAssessment.state} assessment and one ${ACTION} event in one transaction`,
  )
  const viewerRun = await recordRun(await plainEncounter('viewer encounter').then((e) => e.id), [finding('PASS')])
  const auditsBefore08 = await readinessAudits()
  const viewerAssess = await assessHttp(viewerRun, {}, asViewer)
  check('T08', 'Viewer assess', viewerAssess.status === 403 && (await assessmentsFor(viewerRun)) === 0 && (await readinessAudits()) === auditsBefore08, '403; no assessment and no audit')
  const viewerList = await get(`/api/encounters/${realEncounter.id}/pre-claim-readiness-assessments`, asViewer)
  const viewerGet = await get(`/api/pre-claim-readiness-assessments/${realAssessment.id}`, asViewer)
  check('T09', 'Viewer read', viewerList.status === 200 && viewerGet.status === 200 && (viewerGet.body as any)?.id === realAssessment.id, `list ${viewerList.status}, get ${viewerGet.status}`)
  const before10 = await totalAssessments()
  const missingRun = await assessHttp(MISSING, {})
  check('T10', 'Run missing', missingRun.status === 404 && (await totalAssessments()) === before10, `${missingRun.status}; nothing written`)

  // Another tenant's Encounter gets a synthetic run of its own through the recorder (the owner routes
  // only act for this tenant), and an assessment through the service the route calls.
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  const foreignRunId = foreignEncounter ? await recordRun(foreignEncounter.id, [finding('PASS', { findingCode: 'SYNTHETIC_FOREIGN_CODE' })]) : null
  const foreignAssessmentResult = foreignRunId ? await recordReadinessAssessment(foreignRunId, {}, actorUserId) : null
  const foreignAssessmentId = foreignAssessmentResult?.ok ? foreignAssessmentResult.value.id : null
  if (foreignAssessmentId) createdAssessmentIds.push(foreignAssessmentId)
  const leaks = (body: unknown) => /READY_FOR_REVIEW|RESTRICTED|BLOCKED|SYNTHETIC_FOREIGN_CODE|findingCode|facilityId|validationRunId/.test(JSON.stringify(body ?? {}))
  const foreignRunBefore = foreignRunId ? await assessmentsFor(foreignRunId) : 0
  const foreignPost = foreignRunId ? await assessHttp(foreignRunId, {}) : null
  check(
    'T11',
    'Run foreign tenant',
    foreignPost !== null && foreignPost.status === 403 && !leaks(foreignPost.body) && (await assessmentsFor(foreignRunId!)) === foreignRunBefore,
    foreignPost === null ? 'no foreign-tenant Encounter exists to prove this' : `${foreignPost.status}; no state, finding code or context disclosed; nothing written`,
  )
  const bodyEncounter = await plainEncounter('body encounter')
  const bodyRun = await recordRun(bodyEncounter.id, [finding('PASS')])
  const injections = []
  for (const body of [{ state: 'READY_FOR_REVIEW' }, { readinessPolicyVersion: 'A5-READY-2' }, { assessedAt: '2020-01-01T00:00:00.000Z' }, { findingIds: [] }, { counts: { fail: 0 } }, { context: {} }, { validationRunId: bodyRun }, []])
    injections.push((await assessHttp(bodyRun, body)).status)
  const absentBody = await assessHttp(bodyRun)
  if (absentBody.status === 201) createdAssessmentIds.push(absentBody.body.id)
  check(
    'T12',
    'Body empty only',
    injections.every((code) => code === 400) && absentBody.status === 201 && (await assessmentsFor(bodyRun)) === 1,
    `state, policy, assessedAt, finding ids, counts, context and run id are each refused (${injections.join('/')}); an absent body records exactly one assessment`,
  )
  check('T13', 'Compatible validator', realAssessment.readinessPolicyVersion === 'A5-READY-1' && absentBody.body?.readinessPolicyVersion === 'A5-READY-1', 'A5-VAL-1 runs are accepted by A5-READY-1')
  const incompatibleEncounter = await plainEncounter('incompatible encounter')
  const incompatible = []
  for (const version of ['A5-VAL-2', `${runId}-VAL`]) {
    const id = await recordRun(incompatibleEncounter.id, [finding('PASS')], version)
    const audits = await readinessAudits()
    const res = await assessHttp(id, {})
    incompatible.push(res.status === 409 && errorCode(res.body) === 'READINESS_POLICY_INCOMPATIBLE' && (await assessmentsFor(id)) === 0 && (await readinessAudits()) === audits)
  }
  check('T14', 'Incompatible validator', incompatible.length === 2 && incompatible.every(Boolean), 'A5-VAL-2 and an unknown validator are refused with 409 READINESS_POLICY_INCOMPATIBLE; no assessment, no audit')

  // ---------------------------------------------------------------- composition (T15–T27)
  section('A5-READY-1 composition')
  const compose = async (label: string, findings: Record<string, unknown>[]) => {
    const encounter = await plainEncounter(label)
    const runIdOf = await recordRun(encounter.id, findings)
    const assessment = await assess(runIdOf)
    return { encounterId: encounter.id, runId: runIdOf, assessment }
  }
  const passOnly = await compose('pass only', [finding('PASS'), finding('PASS', { layer: 'CODING' })])
  check('T15', 'PASS-only run', passOnly.assessment.state === 'READY_FOR_REVIEW', passOnly.assessment.state)
  const warningOnly = await compose('warning only', [finding('WARNING'), finding('WARNING', { layer: 'EVIDENCE' })])
  check('T16', 'WARNING-only run', warningOnly.assessment.state === 'READY_FOR_REVIEW', warningOnly.assessment.state)
  const passWarning = await compose('pass warning', [finding('PASS'), finding('WARNING', { layer: 'COVERAGE' }), finding('PASS', { layer: 'CONTRACT' })])
  check('T17', 'PASS + WARNING', passWarning.assessment.state === 'READY_FOR_REVIEW', passWarning.assessment.state)
  const oneRestrict = await compose('one restrict', [finding('PASS'), finding('RESTRICT', { layer: 'COVERAGE' }), finding('PASS', { layer: 'CONTRACT' })])
  check('T18', 'One RESTRICT', oneRestrict.assessment.state === 'RESTRICTED', oneRestrict.assessment.state)
  const warnRestrict = await compose('warning restrict', [finding('WARNING'), finding('RESTRICT', { layer: 'EVIDENCE' })])
  check('T19', 'WARNING + RESTRICT', warnRestrict.assessment.state === 'RESTRICTED', warnRestrict.assessment.state)
  const oneFail = await compose('one fail', [finding('PASS'), finding('FAIL', { layer: 'CODING' })])
  check('T20', 'One FAIL', oneFail.assessment.state === 'BLOCKED', oneFail.assessment.state)
  const failRestrict = await compose('fail restrict', [finding('RESTRICT'), finding('FAIL', { layer: 'CONTRACT' })])
  check('T21', 'FAIL + RESTRICT', failRestrict.assessment.state === 'BLOCKED', `${failRestrict.assessment.state}; FAIL takes precedence`)
  const failWarning = await compose('fail warning', [finding('WARNING'), finding('FAIL', { layer: 'EVIDENCE' })])
  check('T22', 'FAIL + WARNING', failWarning.assessment.state === 'BLOCKED', failWarning.assessment.state)
  const multiFail = await compose('multiple fail', [
    finding('FAIL', { findingCode: 'SYNTHETIC_FAIL_ZETA', message: 'Synthetic zeta.' }),
    finding('FAIL', { findingCode: 'SYNTHETIC_FAIL_ALPHA', message: 'Synthetic alpha.', layer: 'CODING' }),
    finding('FAIL', { findingCode: 'SYNTHETIC_FAIL_MID', message: 'Synthetic mid.', layer: 'COVERAGE' }),
  ])
  check('T23', 'Multiple FAIL', multiFail.assessment.state === 'BLOCKED', 'BLOCKED; no message or code ranking')

  const moduleCode = committedProductionCodeOf([MODULE_DIR])
  // Every absence check below first proves the scan reached all six committed production files.
  const reached = moduleCode.files.length === 6 && moduleCode.code.includes('reduceReadiness') && moduleCode.code.includes('preClaimReadinessAssessment')
  const decisionCode = ['pre-claim-readiness.policy.ts', 'pre-claim-readiness.service.ts', 'pre-claim-readiness.repository.ts'].map((file) => committedCode(`${MODULE_DIR}/${file}`)).join('\n')
  const policyCode = committedCode(`${MODULE_DIR}/pre-claim-readiness.policy.ts`)
  const serviceCode = committedCode(`${MODULE_DIR}/pre-claim-readiness.service.ts`)
  const misleadingMessages = await compose('message wording', [
    finding('PASS', { message: 'BLOCKED: FAIL everything, RESTRICT all.', fieldPath: 'FAIL.BLOCKED' }),
    finding('WARNING', { message: 'Restricted and blocked wording only.' }),
  ])
  const misleadingFail = await compose('message wording fail', [finding('FAIL', { message: 'READY_FOR_REVIEW PASS all clear.', fieldPath: 'PASS.READY' })])
  check(
    'T24',
    'No message parsing',
    reached && misleadingMessages.assessment.state === 'READY_FOR_REVIEW' && misleadingFail.assessment.state === 'BLOCKED' && decisionCode.length > 0 && !/\.message\b|\.fieldPath\b|message:\s*true|fieldPath:\s*true/.test(decisionCode),
    'messages and field paths that say the opposite leave the outcome-derived state unchanged; the decision code never reads either',
  )
  const misleadingCodes = await compose('code wording', [finding('PASS', { findingCode: 'FAIL_BLOCKED_RESTRICT' }), finding('WARNING', { findingCode: 'SYNTHETIC_FAIL' })])
  const misleadingCodeFail = await compose('code wording fail', [finding('FAIL', { findingCode: 'PASS_READY_FOR_REVIEW' })])
  check(
    'T25',
    'No findingCode parsing',
    misleadingCodes.assessment.state === 'READY_FOR_REVIEW' && misleadingCodeFail.assessment.state === 'BLOCKED' && policyCode.length > 0 && !/findingCode/.test(policyCode) && /reduceReadiness\(findings\.map\(\(finding\) => finding\.outcome\)\)/.test(serviceCode),
    'codes that name another outcome change nothing; the policy receives outcomes only',
  )
  const policies = await prisma.preClaimReadinessAssessment.findMany({ where: { id: { in: createdAssessmentIds } }, select: { readinessPolicyVersion: true } })
  check('T26', 'Policy exact', policies.length === createdAssessmentIds.length && policies.every((row) => row.readinessPolicyVersion === 'A5-READY-1'), `all ${policies.length} assessments store A5-READY-1, set by the server`)
  const clockEncounter = await plainEncounter('clock encounter')
  const clockRun = await recordRun(clockEncounter.id, [finding('PASS')])
  const clockHold = holdAt('pre_claim_readiness.run_locked')
  const clockCall = recordReadinessAssessment(clockRun, {}, actorUserId)
  await clockHold.arrived
  await pause(500)
  clockHold.release()
  const clockResult = await clockCall
  clearConcurrencyProbes()
  if (clockResult.ok) createdAssessmentIds.push(clockResult.value.id)
  const clockRow = clockResult.ok ? await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: clockResult.value.id } }) : null
  const clockGap = clockRow ? clockRow.createdAt.getTime() - clockRow.assessedAt.getTime() : -1
  check(
    'T27',
    'assessedAt DB truth',
    clockGap >= 400 && /readTransactionTimestamp\(tx\)/.test(serviceCode) && !/new Date\(/.test(serviceCode),
    clockRow ? `assessedAt is the transaction start; the row was written ${clockGap} ms later, by the application clock` : 'the held assessment did not record',
  )

  // ---------------------------------------------------------------- duplicates and history (T28–T35)
  section('Duplicates, history and immutability')
  const passOnlyRowBefore = JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: passOnly.assessment.id } }))
  const auditsBefore28 = await readinessAudits()
  const duplicate = await assessHttp(passOnly.runId, {})
  const raceEncounter = await plainEncounter('race encounter')
  const raceRun = await recordRun(raceEncounter.id, [finding('PASS')])
  const raceHold = holdAt('pre_claim_readiness.run_locked')
  const raceFirst = recordReadinessAssessment(raceRun, {}, actorUserId)
  await raceHold.arrived
  let raceSecondSettled = false
  const raceSecond = recordReadinessAssessment(raceRun, {}, actorUserId).finally(() => (raceSecondSettled = true))
  await pause(400)
  const secondWaited = !raceSecondSettled
  raceHold.release()
  const [raceA, raceB] = await Promise.all([raceFirst, raceSecond])
  clearConcurrencyProbes()
  if (raceA.ok) createdAssessmentIds.push(raceA.value.id)
  check(
    'T28',
    'Duplicate assessment',
    duplicate.status === 400 &&
      errorCode(duplicate.body) === 'VALIDATION_ERROR' &&
      (await assessmentsFor(passOnly.runId)) === 1 &&
      JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: passOnly.assessment.id } })) === passOnlyRowBefore &&
      secondWaited &&
      raceA.ok &&
      !raceB.ok &&
      raceB.code === 'VALIDATION_ERROR' &&
      (await assessmentsFor(raceRun)) === 1 &&
      (await readinessAudits()) === auditsBefore28 + 1,
    'a second create is refused (400) and the original is unchanged; a concurrent second request waited on the run lock and was refused, leaving one row and one audit',
  )
  const historyRun2 = await recordRun(passOnly.encounterId, [finding('FAIL')])
  const history2 = await assess(historyRun2)
  check('T29', 'New run new assessment', history2.validationRunId === historyRun2 && history2.state === 'BLOCKED', 'a later run of the same Encounter gets its own assessment')
  const encounterAssessments = await prisma.preClaimReadinessAssessment.count({ where: { validationRun: { encounterId: passOnly.encounterId } } })
  const uniqueIndexes = (await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${TABLE} AND indexdef ILIKE '%UNIQUE%'`).map((row) => row.indexdef)
  check(
    'T30',
    'No Encounter uniqueness',
    encounterAssessments === 2 && uniqueIndexes.length === 2 && uniqueIndexes.some((def) => /\(validation_run_id, readiness_policy_version\)/.test(def)) && uniqueIndexes.some((def) => /_pkey/.test(def)),
    'the Encounter keeps both historical assessments; the only unique keys are the id and (run, policy)',
  )
  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY column_name`).map((row) => row.column_name)
  const assessmentColumns = await columnsOf(TABLE)
  const pointerColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* '(is_current|is_latest|current_readiness|latest_readiness|readiness_state|approved_for_submission|payer_accepted)'`).map((row) => row.c)
  check(
    'T31',
    'No current pointer',
    same(assessmentColumns, ['assessed_at', 'created_at', 'created_by_user_id', 'id', 'readiness_policy_version', 'state', 'validation_run_id']) && pointerColumns.length === 0,
    pointerColumns.length === 0 ? 'exactly the seven doc columns; no current, latest or approval column anywhere' : `unexpected: ${pointerColumns.join(', ')}`,
  )
  const runColumns = await columnsOf('validation_runs')
  const expectedRunColumns = ['created_at', 'created_by_user_id', 'encounter_id', 'evaluated_at', 'facility_id', 'facility_regulatory_profile_id', 'id', 'insurance_membership_id', 'insurance_product_id', 'network_id', 'payer_id', 'provider_contract_id', 'service_date', 'tariff_schedule_id', 'tariff_schedule_version_id', 'tpa_id', 'validator_version']
  check(
    'T32',
    'No ValidationRun mutation',
    reached &&
      JSON.stringify(await prisma.validationRun.findUniqueOrThrow({ where: { id: realRunId } })) === realRunBefore &&
      JSON.stringify(await findingsOf(realRunId)) === realFindingsBefore &&
      same(runColumns, expectedRunColumns) &&
      !/(validationRun|validationFinding)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(moduleCode.code),
    'the assessed run and its findings are byte-identical afterwards; validation_runs keeps its A5.7 columns; the module writes no run or finding',
  )
  const routeCode = committedCode(`${MODULE_DIR}/pre-claim-readiness.route.ts`)
  const routeVerbs = [...routeCode.matchAll(/\b\w+Router\.(get|post|put|patch|delete|all)\(/g)].map((m) => m[1]).sort()
  const mutations = [await send('PATCH', `/api/pre-claim-readiness-assessments/${passOnly.assessment.id}`), await send('PUT', `/api/pre-claim-readiness-assessments/${passOnly.assessment.id}`), await send('DELETE', `/api/pre-claim-readiness-assessments/${passOnly.assessment.id}`)].map((r) => r.status)
  check('T33', 'Assessment API immutable', same(routeVerbs, ['get', 'get', 'get', 'post']) && mutations.every((code) => code === 404), `PATCH, PUT and DELETE are 404 (${mutations.join('/')}); the module has one POST and three GETs`)
  const tamper = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET state = 'READY_FOR_REVIEW' WHERE id = $1::uuid`, oneFail.assessment.id))
  check('T34', 'DB UPDATE immutability', /append-only/.test(tamper) && (await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: oneFail.assessment.id } })).state === 'BLOCKED', 'the trigger refused a direct UPDATE; the row is unchanged')
  const remove = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, oneFail.assessment.id))
  check('T35', 'DB DELETE immutability', /append-only/.test(remove) && (await prisma.preClaimReadinessAssessment.count({ where: { id: oneFail.assessment.id } })) === 1, 'the trigger refused a direct DELETE; the row survived')

  // ---------------------------------------------------------------- reads (T36–T44)
  section('Assessment reads and derived reasons')
  const ownList = await get(`/api/encounters/${passOnly.encounterId}/pre-claim-readiness-assessments`)
  const ownRunIds = (await prisma.validationRun.findMany({ where: { encounterId: passOnly.encounterId }, select: { id: true } })).map((row) => row.id)
  const foreignList = foreignEncounter ? await get(`/api/encounters/${foreignEncounter.id}/pre-claim-readiness-assessments`) : null
  check(
    'T36',
    'List ownership',
    ownList.status === 200 && ((ownList.body as any).items as any[]).length === 2 && ((ownList.body as any).items as any[]).every((item) => ownRunIds.includes(item.validationRunId)) && foreignList !== null && foreignList.status === 403 && !leaks(foreignList.body),
    foreignList === null ? 'no foreign-tenant Encounter exists to prove this' : `own Encounter lists only its own assessments; another tenant's Encounter is ${foreignList.status} with nothing disclosed`,
  )
  const orderEncounter = await plainEncounter('order encounter')
  for (const outcome of ['PASS', 'RESTRICT', 'FAIL', 'WARNING']) await assess(await recordRun(orderEncounter.id, [finding(outcome)]))
  const listed = ((await get(`/api/encounters/${orderEncounter.id}/pre-claim-readiness-assessments`)).body as any).items.map((item: any) => item.id)
  const listedAgain = ((await get(`/api/encounters/${orderEncounter.id}/pre-claim-readiness-assessments`)).body as any).items.map((item: any) => item.id)
  const dbOrder = (await prisma.$queryRaw<{ id: string }[]>`
    SELECT a.id::text AS id FROM pre_claim_readiness_assessments a JOIN validation_runs r ON r.id = a.validation_run_id
    WHERE r.encounter_id = ${orderEncounter.id}::uuid ORDER BY a.assessed_at DESC, a.created_at DESC, a.id ASC`).map((row) => row.id)
  check('T37', 'List order', listed.length === 4 && same(listed, dbOrder) && same(listed, listedAgain), 'assessedAt DESC, createdAt DESC, id ASC, exactly as the database orders them, on every read')
  const detail = await get(`/api/pre-claim-readiness-assessments/${passOnly.assessment.id}`)
  const storedDetail = await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: passOnly.assessment.id } })
  const detailBody = detail.body as any
  check(
    'T38',
    'Assessment GET',
    detail.status === 200 &&
      same(Object.keys(detailBody).sort(), ['assessedAt', 'createdAt', 'createdByUserId', 'id', 'readinessPolicyVersion', 'reasons', 'state', 'validationRunId']) &&
      detailBody.validationRunId === storedDetail.validationRunId &&
      detailBody.state === storedDetail.state &&
      detailBody.assessedAt === storedDetail.assessedAt.toISOString() &&
      detailBody.createdAt === storedDetail.createdAt.toISOString() &&
      detailBody.createdByUserId === actorUserId,
    'the exact immutable assessment with its derived reasons',
  )
  const mixed = await compose('mixed reasons', [
    finding('PASS', { findingCode: 'SYNTHETIC_P1' }),
    finding('FAIL', { findingCode: 'SYNTHETIC_F1', layer: 'CODING' }),
    finding('WARNING', { findingCode: 'SYNTHETIC_W1', layer: 'COVERAGE' }),
    finding('RESTRICT', { findingCode: 'SYNTHETIC_R1', layer: 'COVERAGE' }),
    finding('FAIL', { findingCode: 'SYNTHETIC_F2', layer: 'CONTRACT' }),
    finding('PASS', { findingCode: 'SYNTHETIC_P2', layer: 'EVIDENCE' }),
    finding('WARNING', { findingCode: 'SYNTHETIC_W2', layer: 'EVIDENCE' }),
    finding('RESTRICT', { findingCode: 'SYNTHETIC_R2', layer: 'EVIDENCE' }),
  ])
  const mixedFindings = await findingsOf(mixed.runId)
  const mixedDetail = (await get(`/api/pre-claim-readiness-assessments/${mixed.assessment.id}`)).body as any
  const mixedDetailAgain = (await get(`/api/pre-claim-readiness-assessments/${mixed.assessment.id}`)).body as any
  const expectedReasons = (outcome: string) => mixedFindings.filter((f) => f.outcome === outcome).map((f) => ({ findingId: f.id, sequence: f.sequence, findingCode: f.findingCode }))
  check('T39', 'Reason blocked IDs', mixed.assessment.state === 'BLOCKED' && same(mixedDetail?.reasons?.blockedFindings, expectedReasons('FAIL')), `${expectedReasons('FAIL').length} FAIL finding(s) with their codes`)
  check('T40', 'Reason restricted IDs', same(mixedDetail?.reasons?.restrictedFindings, expectedReasons('RESTRICT')), `${expectedReasons('RESTRICT').length} RESTRICT finding(s) with their codes`)
  check('T41', 'Reason warning IDs', same(mixedDetail?.reasons?.warningFindings, expectedReasons('WARNING')), `${expectedReasons('WARNING').length} WARNING finding(s) with their codes`)
  check('T42', 'Reason pass IDs', same(mixedDetail?.reasons?.passFindings, expectedReasons('PASS')), `${expectedReasons('PASS').length} PASS finding(s) with their codes`)
  const reasonLists = ['blockedFindings', 'restrictedFindings', 'warningFindings', 'passFindings'].map((name) => (mixedDetail?.reasons?.[name] ?? []) as { sequence: number }[])
  check(
    'T43',
    'Reason order',
    reasonLists.every((list) => list.every((item, index) => index === 0 || item.sequence > list[index - 1].sequence)) && same(mixedDetail, mixedDetailAgain) && ![...deepKeys(mixedDetail)].some((k) => /^(message|fieldPath)$/.test(k)),
    'each reason set follows the run sequence on every read, never id order; no message or field path is a reason',
  )
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  const extraTables = tables.filter((t) => /(readiness|handoff)/i.test(t) && t !== TABLE)
  check('T44', 'No reason table', extraTables.length === 0 && createdTables.length === 1, extraTables.length === 0 ? 'reasons are derived at read time; no readiness-reason or handoff table exists' : `unexpected: ${extraTables.join(', ')}`)

  // ---------------------------------------------------------------- handoff gate (T45–T58)
  section('A6 handoff gate and the newer-validation rule')
  // The rich run: every reference kind, with deliberate duplicates, on an Encounter of its own.
  const richWorld = await commercialWorld('rich')
  const richEncounter = await encounterFor('rich encounter', richWorld.membership.id)
  const a1 = must('activity 1', (await post(`/api/encounters/${richEncounter.id}/activities`, { serviceId: svcA.id, quantity: '1' })).body)
  const a2 = must('activity 2', (await post(`/api/encounters/${richEncounter.id}/activities`, { serviceId: svcB.id, quantity: '2' })).body)
  const d1 = must('diagnosis 1', (await post(`/api/encounters/${richEncounter.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body)
  const d2 = must('diagnosis 2', (await post(`/api/encounters/${richEncounter.id}/diagnoses`, { diagnosisCodeId: dxB.id })).body)
  const eligibilityBody = { verificationMethod: 'PORTAL', status: 'ELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: FRESH_UNTIL, authorizationRequired: false, referralRequired: null, requestEvidenceVersionId: null, responseEvidenceVersionId: evidence1.versionId }
  const e1 = must('eligibility 1', (await post(`/api/encounters/${richEncounter.id}/eligibility-verifications`, eligibilityBody)).body)
  const e2 = must('eligibility 2', (await post(`/api/encounters/${richEncounter.id}/eligibility-verifications`, eligibilityBody)).body)
  const authorization = must('prior authorization', (await post(`/api/encounters/${richEncounter.id}/prior-authorizations`, {
    versionKind: 'INITIAL', status: 'REQUESTED', authorizationReference: null, eligibilityVerificationId: null, requestedAt: null, respondedAt: null, validFrom: null, validThrough: null,
    evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: evidence1.versionId }],
  })).body) as any
  const pv1 = authorization.latestRecordedVersion.id as string
  const authorizationReference = `AUTH-${key('R')}`
  const pv2 = must('approved version', (await post(`/api/prior-authorizations/${authorization.id}/versions`, {
    versionKind: 'RESPONSE', status: 'APPROVED', authorizationReference, eligibilityVerificationId: null, requestedAt: null, respondedAt: '2026-06-10T09:00:00.000Z', validFrom: null, validThrough: null,
    evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: evidence2.versionId }],
  })).body).id
  const lineOf = (serviceId: string) => ({ serviceId, procedureCodeId: null, diagnosisCodeId: null, requestedQty: '1', approvedQty: '1', unitCode: null, approvedFrom: null, approvedThrough: null, status: 'APPROVED' })
  const lines = ((await post(`/api/prior-authorization-versions/${pv2}/authorization-lines`, { lines: [lineOf(svcA.id), lineOf(svcB.id)] })).body as any)?.items as { id: string }[] | undefined
  if (!lines || lines.length !== 2) throw new Error('fixture authorization lines could not be captured')
  const [l1, l2] = lines.map((row) => row.id)
  const source1 = await fx.verifiedSource('readiness source 1', { activateOn: '2025-01-01' })
  const source2 = await fx.verifiedSource('readiness source 2', { activateOn: '2025-01-01' })
  const rule = await fx.ruleDefinition('readiness rule')
  // Left DRAFT on purpose: the recorder needs only visible governance, and an unverified rule can never
  // be discovered by an A5.6 or A5.8 evaluation of another suite.
  const v1 = await fx.draftRuleVersion(rule.id, '1', { effectType: DOC })
  const v2 = await fx.draftRuleVersion(rule.id, '2', { effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT' })
  const applicability = await fx.applicability(v1.id, { payerId: richWorld.payer.id })
  const binding = await fx.bind(v1.id, source1.interpretation.id)
  const requirement = must('evidence requirement', (await post(`/api/rule-versions/${v1.id}/evidence-requirement`, { documentTypes: ['SYNTHETIC_RESPONSE'], minimumCount: 1, sourceDateRequired: false, maxSourceAgeDays: null })).body)
  const datasets = (await prisma.referenceDatasetVersion.findMany({ take: 2, orderBy: { id: 'asc' }, select: { id: true } })).map((row) => row.id)
  if (datasets.length < 2) throw new Error('two reference dataset versions are needed for the dataset reference proofs')
  const [ds1, ds2] = datasets
  const s1v = source1.sourceVersion.id as string
  const s2v = source2.sourceVersion.id as string
  const richContext = {
    serviceDate: SERVICE_DATE, facilityId: facility.id, facilityRegulatoryProfileId: (await storedEncounter(richEncounter.id)).facilityRegulatoryProfileId,
    insuranceMembershipId: richWorld.membership.id, payerId: richWorld.payer.id, tpaId: null, networkId: null, insuranceProductId: null,
    providerContractId: richWorld.contract.id, tariffScheduleId: richWorld.schedule.id, tariffScheduleVersionId: richWorld.tariffVersion.id,
  }
  const richFindings = (wording: string) => [
    finding('PASS', { message: `${wording} technical.`, encounterActivityId: a1.id, encounterDiagnosisId: d1.id }),
    finding('WARNING', { layer: 'CODING', findingCode: 'SYNTHETIC_CODING', message: `${wording} coding.`, encounterActivityId: a2.id, encounterDiagnosisId: d1.id }),
    finding('PASS', { layer: 'COVERAGE', findingCode: 'SYNTHETIC_ELIGIBILITY', message: `${wording} eligibility.`, eligibilityVerificationId: e1.id }),
    finding('PASS', { layer: 'COVERAGE', findingCode: 'SYNTHETIC_ELIGIBILITY', message: `${wording} eligibility.`, eligibilityVerificationId: e2.id, priorAuthorizationVersionId: pv1 }),
    finding('WARNING', { layer: 'COVERAGE', findingCode: 'SYNTHETIC_AUTHORIZATION', message: `${wording} authorization.`, priorAuthorizationVersionId: pv2, authorizationLineId: l2 }),
    finding('PASS', { layer: 'CONTRACT', findingCode: 'SYNTHETIC_CONTRACT', message: `${wording} contract.`, encounterActivityId: a1.id, encounterDiagnosisId: d2.id, priorAuthorizationVersionId: pv2, authorizationLineId: l1 }),
    finding('PASS', { layer: 'EVIDENCE', findingCode: 'SYNTHETIC_EVIDENCE', message: `${wording} evidence.`, evidenceRequirementId: requirement.id, evidenceArtifactVersionId: evidence1.versionId, ruleVersionId: v1.id, governingSourceVersionId: s1v, referenceDatasetVersionId: ds1 }),
    finding('PASS', { layer: 'EVIDENCE', findingCode: 'SYNTHETIC_GOVERNED', message: `${wording} governed.`, evidenceRequirementId: requirement.id, evidenceArtifactVersionId: evidence2.versionId, ruleVersionId: v1.id, governingSourceVersionId: s1v }),
    finding('WARNING', { layer: 'EVIDENCE', findingCode: 'SYNTHETIC_EVIDENCE', message: `${wording} evidence.`, evidenceArtifactVersionId: evidence1.versionId, ruleVersionId: v2.id, governingSourceVersionId: s2v }),
  ]
  // The governed finding carries normalized A5.8 provenance consuming two dataset versions, written in
  // the run's own transaction exactly as A5.8 writes it.
  const recordRich = async (wording: string) => {
    const id = await prisma.$transaction(async (tx) => {
      const recorded = await recordValidationRunInTransaction({ encounterId: richEncounter.id, contextSnapshot: richContext, validatorVersion: 'A5-VAL-1', findings: richFindings(wording) }, actorUserId, tx)
      if (!recorded.ok) throw new Error(`the rich synthetic run was refused by the A5.7 recorder: ${recorded.message}`)
      const governed = await tx.validationFinding.findFirstOrThrow({ where: { validationRunId: recorded.value.id, findingCode: 'SYNTHETIC_GOVERNED' } })
      await insertGovernedProvenance(
        governed.id,
        {
          provenanceContractVersion: 'A3-PROV-1', precedencePolicyVersion: 'A3-PREC-1', rulePackVersionId: null, governingBindingId: binding.id, governingSourceInterpretationId: source1.interpretation.id,
          businessDate: SERVICE_DATE, evaluationTimestamp: new Date().toISOString(), historicalOnly: false, supportingBindingIds: [], matchedApplicabilityIds: [applicability.id], referenceDatasetVersionIds: [ds1, ds2],
        } as never,
        tx,
      )
      return recorded.value.id
    })
    recordedRunIds.push(id)
    return id
  }
  const richRun = await recordRich('Synthetic')
  const richAssessment = await assess(richRun)
  const readyHandoff = await handoff(richAssessment.id)
  const richBody = readyHandoff.body
  // The real A5.8 run is its Encounter's latest run too: its handoff follows its own state end to end.
  const realHandoff = await handoff(realAssessment.id)
  const realHandoffOk = realAssessment.state === 'READY_FOR_REVIEW' ? realHandoff.status === 200 && realHandoff.body?.validationRun?.id === realRunId : realHandoff.status === 409
  check(
    'T45',
    'Handoff ready',
    richAssessment.state === 'READY_FOR_REVIEW' && readyHandoff.status === 200 && richBody?.schemaVersion === 'PreClaimA6HandoffV1' && realHandoffOk,
    `the READY_FOR_REVIEW assessment of the Encounter's latest run returns the contract (${readyHandoff.status}); the real A5.8 run's ${realAssessment.state} assessment answers ${realHandoff.status}`,
  )
  const restricted = await handoff(oneRestrict.assessment.id)
  check('T46', 'Handoff restricted', restricted.status === 409 && errorCode(restricted.body) === 'PRECLAIM_NOT_READY_FOR_HANDOFF' && !('exactReferences' in (restricted.body ?? {})), `RESTRICTED -> ${restricted.status} ${errorCode(restricted.body)}`)
  const blocked = await handoff(oneFail.assessment.id)
  check('T47', 'Handoff blocked', blocked.status === 409 && errorCode(blocked.body) === 'PRECLAIM_NOT_READY_FOR_HANDOFF' && !('exactReferences' in (blocked.body ?? {})), `BLOCKED -> ${blocked.status} ${errorCode(blocked.body)}`)
  const foreignHandoff = foreignAssessmentId ? await handoff(foreignAssessmentId) : null
  const foreignDetail = foreignAssessmentId ? await get(`/api/pre-claim-readiness-assessments/${foreignAssessmentId}`) : null
  check(
    'T48',
    'Handoff foreign',
    foreignHandoff !== null && foreignHandoff.status === 403 && !leaks(foreignHandoff.body) && foreignDetail !== null && foreignDetail.status === 403 && !leaks(foreignDetail.body),
    foreignHandoff === null ? 'no foreign-tenant assessment could be created to prove this' : `another tenant's handoff and assessment are ${foreignHandoff.status}/${foreignDetail?.status} with no state, code or context disclosed`,
  )
  const malformed = await handoff('not-a-uuid')
  const malformedGet = await get('/api/pre-claim-readiness-assessments/not-a-uuid')
  const malformedPost = await assessHttp('not-a-uuid', {})
  const missingHandoff = await handoff(MISSING)
  const raw = (body: unknown) => /prisma|postgres|syntax|invalid input|uuid_in|stack/i.test(JSON.stringify(body ?? {}))
  check(
    'T49',
    'Handoff malformed',
    malformed.status === 400 && malformedGet.status === 400 && malformedPost.status === 400 && missingHandoff.status === 404 && ![malformed.body, malformedGet.body, malformedPost.body, missingHandoff.body].some(raw),
    `malformed ids are ${malformed.status}/${malformedGet.status}/${malformedPost.status}, an unknown assessment is ${missingHandoff.status}; no raw database error`,
  )

  // Each recency scenario has an Encounter of its own.
  const supersedeEncounter = await plainEncounter('supersede encounter')
  const olderReady = await assess(await recordRun(supersedeEncounter.id, [finding('PASS')]))
  const beforeNewer = await handoff(olderReady.id)
  const olderRow = JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: olderReady.id } }))
  const newerReadyRun = await recordRun(supersedeEncounter.id, [finding('WARNING')])
  const afterNewer = await handoff(olderReady.id)
  const newerReady = await assess(newerReadyRun)
  const newerReadyHandoff = await handoff(newerReady.id)
  check(
    'T50',
    'Newer validation supersedes',
    beforeNewer.status === 200 && afterNewer.status === 409 && errorCode(afterNewer.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' && newerReadyHandoff.status === 200,
    `the older READY assessment handed off (${beforeNewer.status}) until a newer run existed, then ${afterNewer.status} ${errorCode(afterNewer.body)}; the newer READY run hands off`,
  )
  const blockedEncounter = await plainEncounter('newer blocked encounter')
  const cleanOld = await assess(await recordRun(blockedEncounter.id, [finding('PASS')]))
  const newerBlocked = await assess(await recordRun(blockedEncounter.id, [finding('FAIL')]))
  const cleanOldHandoff = await handoff(cleanOld.id)
  const newerBlockedHandoff = await handoff(newerBlocked.id)
  check(
    'T51',
    'Newer blocked supersedes old ready',
    newerBlocked.state === 'BLOCKED' && cleanOldHandoff.status === 409 && errorCode(cleanOldHandoff.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' && newerBlockedHandoff.status === 409 && errorCode(newerBlockedHandoff.body) === 'PRECLAIM_NOT_READY_FOR_HANDOFF',
    'the old clean run cannot bypass the later BLOCKED run, which itself cannot be handed off',
  )
  const unassessedEncounter = await plainEncounter('newer unassessed encounter')
  const assessedOld = await assess(await recordRun(unassessedEncounter.id, [finding('PASS')]))
  const unassessedRun = await recordRun(unassessedEncounter.id, [finding('PASS')])
  const unassessedHandoff = await handoff(assessedOld.id)
  check(
    'T52',
    'Newer unassessed run',
    (await assessmentsFor(unassessedRun)) === 0 && unassessedHandoff.status === 409 && errorCode(unassessedHandoff.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION',
    'a newer run with no assessment of its own still blocks the older handoff',
  )
  check(
    'T53',
    'No latest-state persistence',
    JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: olderReady.id } })) === olderRow && pointerColumns.length === 0 && extraTables.length === 0,
    'supersession is computed at read time; the older assessment row is unchanged and no pointer row or column exists',
  )
  const supersedeRuns = await prisma.validationRun.findMany({ where: { encounterId: supersedeEncounter.id }, orderBy: { createdAt: 'asc' }, select: { id: true, evaluatedAt: true } })
  check('T54', 'Recency evaluatedAt', supersedeRuns.length === 2 && supersedeRuns[1].evaluatedAt > supersedeRuns[0].evaluatedAt && afterNewer.status === 409, 'a later evaluatedAt supersedes the earlier run')
  const createdEncounter = await plainEncounter('created-at encounter')
  const sameInstantRun = await recordRun(createdEncounter.id, [finding('PASS')])
  const sameInstant = await assess(sameInstantRun)
  const laterCreatedRun = await copyRunAt(sameInstantRun, '1 millisecond', 'PASS')
  const createdRows = await prisma.$queryRaw<{ same_evaluated: boolean; later_created: boolean }[]>`
    SELECT (a.evaluated_at = b.evaluated_at) AS same_evaluated, (b.created_at > a.created_at) AS later_created
    FROM validation_runs a, validation_runs b WHERE a.id = ${sameInstantRun}::uuid AND b.id = ${laterCreatedRun}::uuid`
  const createdHandoff = await handoff(sameInstant.id)
  check(
    'T55',
    'Recency createdAt',
    createdRows[0]?.same_evaluated === true && createdRows[0]?.later_created === true && createdHandoff.status === 409 && errorCode(createdHandoff.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION',
    'at the same evaluatedAt, the run created later supersedes',
  )
  const tieEncounter = await plainEncounter('tie encounter')
  const tieRunA = await recordRun(tieEncounter.id, [finding('PASS')])
  const tieA = await assess(tieRunA)
  const tieRunB = await copyRunAt(tieRunA, '0 seconds', 'PASS')
  const tieB = await assess(tieRunB)
  const tieHandoffA = await handoff(tieA.id)
  const tieHandoffB = await handoff(tieB.id)
  check(
    'T56',
    'Recency tie ambiguity',
    tieA.state === 'READY_FOR_REVIEW' && tieB.state === 'READY_FOR_REVIEW' && [tieHandoffA, tieHandoffB].every((h) => h.status === 409 && errorCode(h.body) === 'VALIDATION_RUN_RECENCY_AMBIGUOUS'),
    'two READY runs at the identical evaluatedAt and createdAt are both refused; neither UUID wins',
  )
  const outcomeEncounter = await plainEncounter('outcome tie encounter')
  const outcomeReadyRun = await recordRun(outcomeEncounter.id, [finding('PASS')])
  const outcomeReady = await assess(outcomeReadyRun)
  await assess(await copyRunAt(outcomeReadyRun, '0 seconds', 'FAIL'))
  const outcomeHandoff = await handoff(outcomeReady.id)
  check(
    'T57',
    'No outcome winner',
    outcomeHandoff.status === 409 && errorCode(outcomeHandoff.body) === 'VALIDATION_RUN_RECENCY_AMBIGUOUS' && newerReadyHandoff.status === 200 && cleanOldHandoff.status === 409 && /decideRecency\(await findRecencyRelations\(/.test(serviceCode),
    'tied with a BLOCKED run, the READY run is still ambiguous; a newer READY or a newer BLOCKED run supersedes alike',
  )
  check(
    'T58',
    'Handoff schema version',
    same(Object.keys(richBody ?? {}).sort(), ['assessedAt', 'exactReferences', 'findingRefs', 'findingSummary', 'readinessAssessmentId', 'readinessPolicyVersion', 'readinessState', 'schemaVersion', 'validationRun']) && richBody.schemaVersion === 'PreClaimA6HandoffV1',
    'exactly PreClaimA6HandoffV1 and its nine top-level fields',
  )

  // ---------------------------------------------------------------- handoff content (T59–T75)
  section('PreClaimA6HandoffV1 exact references')
  const richRow = await prisma.validationRun.findUniqueOrThrow({ where: { id: richRun } })
  const richAssessmentRow = await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: richAssessment.id } })
  const richStored = await findingsOf(richRun)
  check(
    'T59',
    'Handoff assessment refs',
    richBody.readinessAssessmentId === richAssessment.id && richBody.readinessPolicyVersion === 'A5-READY-1' && richBody.readinessState === 'READY_FOR_REVIEW' && richBody.assessedAt === richAssessmentRow.assessedAt.toISOString(),
    'exact assessment id, policy, state and assessedAt',
  )
  check(
    'T60',
    'Handoff run refs',
    same(Object.keys(richBody.validationRun).sort(), ['context', 'encounterId', 'evaluatedAt', 'id', 'validatorVersion']) &&
      richBody.validationRun.id === richRun &&
      richBody.validationRun.validatorVersion === 'A5-VAL-1' &&
      richBody.validationRun.evaluatedAt === richRow.evaluatedAt.toISOString() &&
      richBody.validationRun.encounterId === richEncounter.id,
    'exact run id, validator, evaluatedAt and Encounter',
  )
  const sortKeys = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  check('T61', 'Handoff context refs', same(sortKeys(richBody.validationRun.context), sortKeys(richContext)), 'the exact A5.7 context ids, with tpaId, networkId and insuranceProductId preserved as null')
  const countOf = (outcome: string) => richStored.filter((f) => f.outcome === outcome).length
  check(
    'T62',
    'Handoff counts',
    same(richBody.findingSummary, { total: richStored.length, pass: countOf('PASS'), warning: countOf('WARNING'), restrict: countOf('RESTRICT'), fail: countOf('FAIL') }),
    `total ${richStored.length}: ${countOf('PASS')} pass, ${countOf('WARNING')} warning, ${countOf('RESTRICT')} restrict, ${countOf('FAIL')} fail`,
  )
  check(
    'T63',
    'Handoff finding refs',
    same(richBody.findingRefs, richStored.map((f) => ({ id: f.id, sequence: f.sequence, layer: f.layer, outcome: f.outcome, findingCode: f.findingCode }))),
    'every finding id, sequence, layer, outcome and code in sequence order; no message or field path',
  )
  const refs = richBody.exactReferences ?? {}
  const refCheck = (id: string, title: string, field: string, expected: string[], what: string) =>
    check(id, title, same(refs[field], [...expected].sort()) && expected.length >= 2, `${expected.length} distinct ${what}, deduplicated across findings and sorted ascending`)
  refCheck('T64', 'Activity refs', 'encounterActivityIds', [a1.id, a2.id], 'activities')
  refCheck('T65', 'Diagnosis refs', 'encounterDiagnosisIds', [d1.id, d2.id], 'diagnoses')
  refCheck('T66', 'Eligibility refs', 'eligibilityVerificationIds', [e1.id, e2.id], 'eligibility verifications')
  refCheck('T67', 'Authorization version refs', 'priorAuthorizationVersionIds', [pv1, pv2], 'prior authorization versions')
  refCheck('T68', 'Authorization line refs', 'authorizationLineIds', [l1, l2], 'authorization lines')
  check('T69', 'Evidence requirement refs', same(refs.evidenceRequirementIds, [requirement.id]), 'the one requirement named by two findings appears once')
  refCheck('T70', 'Evidence version refs', 'evidenceArtifactVersionIds', [evidence1.versionId, evidence2.versionId], 'evidence artifact versions')
  refCheck('T71', 'Rule refs', 'ruleVersionIds', [v1.id, v2.id], 'rule versions')
  refCheck('T72', 'Governing source refs', 'governingSourceVersionIds', [s1v, s2v], 'governing source versions')
  const governedRow = richStored.find((f) => f.findingCode === 'SYNTHETIC_GOVERNED')
  check(
    'T73',
    'Reference dataset refs',
    same(refs.referenceDatasetVersionIds, sortedSet([ds1, ds2])) && governedRow?.referenceDatasetVersionId === null && governedRow.consumedDatasetVersions.length === 2,
    "one finding's base dataset reference plus the governed finding's two A5.8 dataset rows, deduplicated to two",
  )
  const richAgain = (await handoff(richAssessment.id)).body
  const sortedAndUnique = Object.values(refs as Record<string, string[]>).every((list) => Array.isArray(list) && same(list, sortedSet(list)))
  check('T74', 'Handoff deterministic order', same(richAgain, richBody) && Object.keys(refs).length === 10 && sortedAndUnique, 'identical on a repeated read; all ten reference arrays are unique and ascending')
  // A twin run with different wording on the same Encounter: references and state must be identical.
  const twinRun = await recordRich('Reworded synthetic wording')
  const twinAssessment = await assess(twinRun)
  const twin = (await handoff(twinAssessment.id)).body
  const refsWithoutIds = (body: any) => (body?.findingRefs ?? []).map(({ id: _id, ...rest }: any) => rest)
  check(
    'T75',
    'No message handoff dependency',
    twinAssessment.state === richAssessment.state && same(twin?.exactReferences, richBody.exactReferences) && same(twin?.findingSummary, richBody.findingSummary) && same(refsWithoutIds(twin), refsWithoutIds(richBody)),
    'a run differing only in message wording yields the same state, references, counts and finding codes',
  )
  const handoffText = JSON.stringify(richBody)
  const handoffKeys = [...deepKeys(richBody)]
  check(
    'T76',
    'No patient/member values',
    !handoffKeys.some((k) => /^(givenName|familyName|dateOfBirth|memberIdentifier|policyIdentifier|authorizationReference|patientId)$/.test(k)) && !handoffText.includes(`${runId}-P`) && !handoffText.includes(richWorld.memberIdentifier) && !handoffText.includes(authorizationReference),
    'no name, birth date, member, policy or authorization value at any depth',
  )
  check('T77', 'No evidence metadata', !handoffKeys.some((k) => /storageRef|contentHash|documentType|sourceDate|bytes/i.test(k)) && !handoffText.includes('synthetic://evidence') && !handoffText.includes('e'.repeat(64)), 'no storage reference, content hash, document type or bytes')
  check('T78', 'No pricing', !handoffKeys.some((k) => /(rate|fee|amount|allowed|reimburs|price|responsib|copay|deductible|total(?!$))/i.test(k)), 'no rate, fee, amount, allowed, reimbursement or patient-responsibility field')
  check(
    'T79',
    'No Claim IDs',
    reached && !handoffKeys.some((k) => /claim/i.test(k)) && !tables.some((t) => /(^claims?$|claim_lines?|claim_submissions?)/.test(t)) && !/(prisma|tx|db)\s*\.\s*(claim|claimLine|claimSubmission)\b/.test(moduleCode.code),
    'no Claim, ClaimLine or ClaimSubmission is created or returned',
  )
  check('T80', 'No approval', !handoffKeys.some((k) => /(approv|payerAccept|submit|humanApprover|reviewer)/i.test(k)) && !/APPROVED_FOR_SUBMISSION/.test(handoffText), 'no approval, submission or payer-acceptance flag')
  check('T81', 'No payload hash', reached && !handoffKeys.some((k) => /(hash|payload|canonical|signature)/i.test(k)) && !/createHash|node:crypto|from 'crypto'/.test(moduleCode.code), 'A5.9 builds no canonical claim payload or hash')
  const appCode = committedCode('backend/src/app.ts')
  const readinessMounts = [...appCode.matchAll(/app\.use\('([^']+)',\s*(validationRunReadinessRouter|encounterReadinessRouter|readinessAssessmentRouter)\)/g)].map((m) => m[1]).sort()
  check(
    'T82',
    'No external route',
    reached && same(readinessMounts, ['/api/encounters', '/api/pre-claim-readiness-assessments', '/api/validation-runs']) && !/\b(fetch|axios|https?\.request|dhpo|eclaimlink|apiKey|clientSecret|transactionId)\b/i.test(moduleCode.code) && !/\/(submit|approve|transmit|claims?)\b/.test(routeCode),
    'three internal mounts only; no integration route, transport, credential or transaction identity',
  )

  // ---------------------------------------------------------------- scope (T83–T88)
  section('No re-execution of any upstream owner')
  const imports = [...moduleCode.code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  const runsBefore83 = await prisma.validationRun.count()
  const scopeEncounter = await plainEncounter('scope encounter')
  const scopeRun = await recordRun(scopeEncounter.id, [finding('PASS')])
  const runsAfterRecord = await prisma.validationRun.count()
  await assess(scopeRun)
  check(
    'T83',
    'No validation execution',
    reached && !imports.some((p) => /pre-claim-validation/.test(p)) && !/executePreClaimValidation|recordValidationRunInTransaction|validation-run\.recorder/.test(moduleCode.code) && (await prisma.validationRun.count()) === runsAfterRecord && runsAfterRecord === runsBefore83 + 1,
    'an assessment creates no ValidationRun; A5.9 imports and calls no A5.8 execution or A5.7 recorder path',
  )
  check(
    'T84',
    'No A3 execution',
    reached && !imports.some((p) => /rule-(resolution|applicability|source-binding|pack|provenance|executability)/.test(p)) && !/specificity|SUPERSEDES|CONFLICTS_WITH|sourceRank|composeRuleDecisionProvenance|evaluateRuleResolution/.test(moduleCode.code),
    'no applicability, precedence or provenance composition',
  )
  check('T85', 'No eligibility selection', reached && !imports.some((p) => /eligibility/.test(p)) && !/validThrough|freshness|selectEligibility|eligibilityVerification\./.test(moduleCode.code), 'no A5.2 candidate or freshness logic')
  check('T86', 'No authorization matching', reached && !imports.some((p) => /authorization-line|prior-authorization/.test(p)) && !/evaluateAuthorization|scopeOutcome|authorizationLine\./.test(moduleCode.code), 'no A5.4 scope evaluation')
  check('T87', 'No evidence completeness', reached && !imports.some((p) => /evidence-requirement|encounter-evidence|evidence-artifact/.test(p)) && !/evaluateEvidenceCompleteness|completeness/i.test(moduleCode.code), 'no A5.6 evaluation')
  check(
    'T88',
    'No rule DSL',
    reached && !/new Function\(|\beval\(|vm\.run/.test(moduleCode.code) && !tables.some((t) => /(check_registry|rule_dsl|readiness_rule|readiness_polic)/.test(t)) && createdTables.length === 1,
    'the A5-READY-1 reduction is fixed code; no interpreter and no check registry table',
  )

  // ---------------------------------------------------------------- audit (T89–T92)
  section('Business Audit')
  const auditRows = await prisma.auditEvent.findMany({ where: { entityId: { in: createdAssessmentIds } }, select: { entityId: true, actionCode: true, entityType: true, beforeState: true, afterState: true } })
  check(
    'T89',
    'Audit count',
    createdAssessmentIds.length > 20 && createdAssessmentIds.every((id) => auditRows.filter((row) => row.entityId === id).length === 1) && auditRows.every((row) => row.actionCode === ACTION && row.entityType === ENTITY),
    `exactly one ${ACTION} per assessment across ${createdAssessmentIds.length} assessments`,
  )
  const auditText = JSON.stringify(auditRows.map((row) => row.afterState))
  check(
    'T90',
    'Audit minimization',
    auditRows.every((row) => row.beforeState === null && same(Object.keys((row.afterState ?? {}) as object).sort(), ['assessedAt', 'createdAt', 'id', 'readinessPolicyVersion', 'state'])) && !auditText.includes(richRun) && !auditText.includes(richEncounter.id) && !/findingCode|SYNTHETIC_|facilityId|payerId/.test(auditText),
    'id, policy, state, assessedAt and createdAt only; no run, Encounter, finding, context or reference',
  )
  const rollback = async (probe: string) => {
    const encounter = await plainEncounter(`rollback ${probe}`)
    const id = await recordRun(encounter.id, [finding('PASS')])
    const audits = await readinessAudits()
    failAt(probe, 'forced failure (acceptance)')
    let threw = false
    try {
      await recordReadinessAssessment(id, {}, actorUserId)
    } catch {
      threw = true
    }
    clearConcurrencyProbes()
    return threw && (await assessmentsFor(id)) === 0 && (await readinessAudits()) === audits
  }
  check('T91', 'Atomic rollback', (await rollback('pre_claim_readiness.recorded')) && (await rollback('pre_claim_readiness.assessment_inserted')), 'a forced failure after the audit, or after the insert, leaves no assessment and no audit')
  const auditsBeforeReads = await totalAudits()
  await get(`/api/encounters/${richEncounter.id}/pre-claim-readiness-assessments`)
  await get(`/api/pre-claim-readiness-assessments/${richAssessment.id}`)
  await handoff(twinAssessment.id)
  await handoff(oneFail.assessment.id)
  await get(`/api/encounters/${richEncounter.id}/pre-claim-readiness-assessments`, asViewer)
  await handoff(twinAssessment.id, asViewer)
  check('T92', 'No audit on reads', (await totalAudits()) === auditsBeforeReads, 'six assessment, list and handoff reads wrote no AuditEvent')

  // ---------------------------------------------------------------- privacy and build (T93–T95)
  section('Privacy, logging and build gates')
  const feCode = committedCodeOf(FRONTEND_DIR)
  check(
    'T93',
    'Frontend privacy',
    feCode.files.length === 2 && feCode.code.includes('recordAssessment') && !/\b(localStorage|sessionStorage|indexedDB)\b/.test(feCode.code) && !/findingCode|exactReferences|findingRefs|fieldPath|memberIdentifier|facilityId|payerId|[/]provenance/.test(feCode.code),
    'nothing in browser storage; only the assessment id, state, policy, run id and counts are shown',
  )
  const scanPaths = [`:/${MODULE_DIR}`, `:/${FRONTEND_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const reach = gitGrep('reduceReadiness|recordAssessment', scanPaths)
  check(
    'T94',
    'Logging scan',
    reach.status === 0 && logScan.status === 1 && !/req\.query/.test(moduleCode.code) && !/fetch\(`[^`]*\?/.test(feCode.code),
    'no finding, context, member or evidence data is logged; no query string is read or sent (search verified to reach the source)',
  )
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T95', 'Unit/typecheck/build', unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok, `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)

  // ---------------------------------------------------------------- regressions (T96–T106)
  section('Regressions and database truth')
  // §22: the owner suites are INVOKED, never reimplemented. A5.8's suite nests A5.7 -> A5.6 -> ... -> A1.
  await apiReady('the A5.8 and backward regression chain')
  const chain = run('npm run test:a5:pre-claim-validation')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A5.8')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A5.8] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A5.8 asserts facts about its own branch, its own migration and the paths it was allowed to change.
  const a58NonApplicable: Record<string, string> = {
    T01: "A5.8 'Start gate' requires the current branch to be the A5.8 feature branch; A5.9 is a different branch, branched from the merged A5.8 main",
    T03: "A5.8 'Migration scope' judges the single migration this branch adds against main; on A5.9 that migration is A5.9's own readiness migration",
    T134: "A5.8 'Diff scope' lists the paths A5.8 was allowed to change; A5.9 legitimately changes different ones",
    T135: "A5.8 'Exact head evidence' requires the upstream to be the A5.8 feature branch, which was deleted when PR #61 merged",
  }
  const undocumented = failing.filter((id) => !(id in a58NonApplicable))
  const counts = chain.output.match(/\[A5\.8\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T124') && rows.some((row) => row.id === 'T131')
  check(
    'T96',
    'A5.8 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A5.8 suite did not reach its regression checks'
      : !reconciled
        ? `A5.8 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A5.8 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A5\.8\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.8] automated summary: ', 'A5.8 ')}; all ${failedCount} failure(s) named and accounted for, and every execution and provenance invariant still holds`,
  )
  for (const id of undocumented) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) console.log(`[A5.9]      ${row.line.slice(0, 400)}`)
  }
  for (const id of Object.keys(a58NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T96/${id}`, `A5.8 ${titleOf(row.line)}`, a58NonApplicable[id])
  }
  const lineOfId = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check('T97', 'A5.7 regression', verdictOf('T124') === 'PASS', `A5.8 T124 (A5.7) ${verdictOf('T124')}`)
  check('T98', 'A5.6 regression', verdictOf('T125') === 'PASS', `A5.8 T125 (A5.6) ${verdictOf('T125')}`)
  check('T99', 'A5.5 regression', verdictOf('T126') === 'PASS', `A5.8 T126 (A5.5) ${verdictOf('T126')}`)
  check('T100', 'A5.4 regression', verdictOf('T127') === 'PASS', `A5.8 T127 (A5.4) ${verdictOf('T127')}`)
  check('T101', 'A5.3 regression', verdictOf('T128') === 'PASS' && /T97 \(A5\.3\) PASS/.test(lineOfId('T128')), `A5.8 T128 reports A5.3 ${/T97 \(A5\.3\) PASS/.test(lineOfId('T128')) ? 'PASS' : 'not PASS'}`)
  check('T102', 'A5.2/A5.1 regressions', verdictOf('T128') === 'PASS' && /T98 \(A5\.2 and A5\.1\) PASS/.test(lineOfId('T128')), `A5.8 T128 reports A5.2 and A5.1 ${/T98 \(A5\.2 and A5\.1\) PASS/.test(lineOfId('T128')) ? 'PASS' : 'not PASS'}`)
  check('T103', 'A4 regressions', verdictOf('T129') === 'PASS', `A5.8 T129 (A4.10 and A4.9 to A1) ${verdictOf('T129')}`)
  check('T104', 'A3 regressions', verdictOf('T130') === 'PASS', `A5.8 T130 (A3, with the A3.9 scope suite run directly) ${verdictOf('T130')}`)
  check('T105', 'A2/A1 regressions', verdictOf('T131') === 'PASS', `A5.8 T131 (A2 and A1) ${verdictOf('T131')}`)
  for (const text of chain.output.split(/\r?\n/).filter((l) => l.startsWith('[A5.8]      ') && / substantive checks /.test(l))) console.log(`[A5.9]      ${text.replace('[A5.8]', '').trim().slice(0, 190)}`)

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
  check('T106', 'DB truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- closure (T107–T110)
  section('Repeatability, diff scope and exact head')
  await waitFor(databaseUp, 60_000)
  const priorAssessmentsNow = await prisma.preClaimReadinessAssessment.count({ where: { createdAt: { lt: runStartedAt } } })
  check(
    'T107',
    'Repeatability',
    createdAssessmentIds.length > 20 && recordedRunIds.length > 20 && priorAssessmentsNow === priorAssessmentsAtStart,
    `this run used a fresh synthetic runId (${runId}), recorded ${recordedRunIds.length} run(s) and ${createdAssessmentIds.length} assessment(s); all ${priorAssessmentsNow} assessment(s) from earlier runs are retained as history`,
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
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !file.startsWith(`${FRONTEND_DIR}/`) && !file.includes('a5_9_pre_claim_readiness_a6_handoff') && !allowed.includes(file),
  )
  const futureImport = moduleCode.code.match(/from '[^']*modules\/(claim|claim-line|submission|remittance|pricing|integration|transmission)/)
  check(
    'T108',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && futureImport === null,
    outOfScope.length === 0 && futureImport === null
      ? `${changedPaths.length} path(s): the A5.9 module, its migration, harness and check page, the replay verifier, and wiring; no A5.10, A6 or A9 domain`
      : `unexpected: ${[...outOfScope, futureImport?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )
  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [`:/${HARNESS_DIR}`, `:/${MODULE_DIR}`, `:/${FRONTEND_DIR}`],
  )
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git(`show HEAD:${HARNESS_DIR}/a5-readiness.integration.ts`)
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [`:/${HARNESS_DIR}`])
  check(
    'T109',
    'Secret/PHI scan',
    secretReach.status === 0 && secretScan.status === 1 && harnessSource.length > 0 && harnessSource.match(realDataMarkers) === null,
    'no credential, real patient, member or claim content is committed (search verified to reach the harness)',
  )
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T110',
    'Exact head evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a59Branch}`) && !/ahead|behind/.test(tracking),
    `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A5.9] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.9] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.9] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.9] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.9] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.9] A5.9 PRE-CLAIM READINESS / A6 HANDOFF ACCEPTANCE COMPLETE' : '[A5.9] A5.9 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.9] RUN ABORTED: ${error.message}`)
      console.log('[A5.9] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.9] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.9] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
