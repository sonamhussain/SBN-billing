import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordReadinessAssessment } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'
import { createClaim } from '../../modules/claim/claim.service.ts'

// A6.1 — focused acceptance for Claim Foundation & A5 Handoff Binding (T001–T110).
//
// One exact READY_FOR_REVIEW A5.9 readiness assessment establishes one stable A6-CLAIM-1 Claim inside
// one REPEATABLE READ transaction that consumes the A5.9 transaction-aware handoff composer. Every
// recency scenario gets an Encounter of its own. Runs are recorded through A5.7's own recorder and
// assessed through the A5.9 owner route, so the outcomes under test are exact. ADVERSARIAL writes go in
// only to create a state no owner path can create (an assessment under another policy, two runs at one
// instant) or to prove the database refuses them. Every value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.1] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.1] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.1] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.1] ${title}`)

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
const committedProductionCodeOf = (dirs: string[]) => {
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}
class RollbackSentinel extends Error {}

const runId = `A61-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.10 FINAL PASS was merged into main as 158c9b7; the A1 organization-provisioning corrective (PR #68)
// was merged as 7632ef8. A6.1 is branched from that corrected main.
const a510Merge = '158c9b7c32b212e61ebcfe8e73ab93ff6f7f85d3'
const a1CorrectiveMerge = '7632ef86c6050c501ac6d5692206839d608daec3'
const a61Branch = 'feature/a6-1-claim-foundation-a5-handoff-binding'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/claim'
const A59_DIR = 'backend/src/modules/pre-claim-readiness'
const FRONTEND_DIR = 'frontend/src/modules/claim'
const HARNESS_DIR = 'backend/src/integration/a6-claim-foundation'
const TABLE = 'claims'
const ENTITY = 'CLAIM'
const ACTION = 'claim.created'
const IDENTITY_KEYS = ['claimContractVersion', 'createdAt', 'createdByUserId', 'encounterId', 'handoffSchemaVersion', 'id', 'preClaimReadinessAssessmentId']

// A column or DTO key is judged by its whole words (snake_case and camelCase split), never by a
// substring: "preClaimReadinessAssessmentId" contains "eClaim" and "encounter_id" contains "count".
const nameWords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const namesWithWord = (names: string[], words: string[]) => names.filter((name) => nameWords(name).some((word) => words.includes(word)))

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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A6.1] A6.1 claim foundation & A5 handoff binding — run ${runId}`)
  console.log(`[A6.1] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  const priorClaimsAtStart = await prisma.claim.count({ where: { createdAt: { lt: runStartedAt } } })

  // ---------------------------------------------------------------- gates (T001–T006)
  section('Start gate, migration and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T001',
    'Start gate',
    branch === a61Branch && gitOk(`merge-base --is-ancestor ${a510Merge} origin/main`) && gitOk(`merge-base --is-ancestor ${a1CorrectiveMerge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.10 merge ${a510Merge.slice(0, 7)} and the A1 provisioning corrective ${a1CorrectiveMerge.slice(0, 7)} (PR #68) are on main, and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, ''))
  const schemaDiff = git('diff origin/main...HEAD -- :/backend/prisma/schema.prisma').split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const schemaAddedModels = schemaDiff.filter((l) => /^\+\s*model /.test(l)).map((l) => l.replace(/^\+\s*model\s+(\w+).*$/, '$1'))
  const backRelations = schemaDiff.filter((l) => /^\+\s+\w+\s+Claim(\[\]|\?)/.test(l))
  const scopeProblems = [
    [same(createdTables, [TABLE]), `tables created: ${createdTables.join(', ')}`],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => m.includes(`"${TABLE}"`)), 'a table outside A6.1 is altered'],
    [(statements.match(/ADD CONSTRAINT "[a-z_]*_chk"/g) ?? []).length === 2, 'the contract and handoff CHECKs are not both added'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 3, 'the three foreign keys are not all ON DELETE RESTRICT'],
    [
      (statements.match(/CREATE TRIGGER [a-z_]+_trg/g) ?? []).length === 2 && /BEFORE INSERT ON "claims"/.test(statements) && /BEFORE UPDATE OR DELETE ON "claims"/.test(statements),
      'the coherence and identity triggers are not both created',
    ],
    [!/\b(jsonb?|claim_lines?|claim_submissions?|price|amount|currency|is_current|is_latest|approved\w*|status|payload)\b/i.test(statements), 'a JSON, line, pricing, pointer, approval or payload column appears'],
    [schemaRemoved.length === 0 && same(schemaAddedModels, ['Claim']) && backRelations.length === 3, 'the schema diff is not exactly the model and its three back-relations'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T003',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1
      ? `expected exactly one migration, found ${migrationPaths.length}`
      : scopeProblems.length === 0
        ? 'one migration; exactly claims with two contract CHECKs, three RESTRICT foreign keys, the assessment unique key, the coherence and identity triggers; the schema adds only the model and its Encounter/assessment/User back-relations; no drift'
        : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T004', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T005',
    'Migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /claims_binding_coherence_trg is present/.test(replay.output) &&
      /claims_identity_guard_trg is present/.test(replay.output) &&
      /PASS {2}the two Claim CHECKs pin A6-CLAIM-1 and PreClaimA6HandoffV1/.test(replay.output) &&
      /PASS {2}the one-Claim-per-assessment unique index is present/.test(replay.output) &&
      /PASS {2}no unique index on claims\.encounter_id/.test(replay.output) &&
      /PASS {2}claims carries exactly its seven identity columns/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the A6.1 foreign keys, unique key, CHECKs and triggers survive`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const claimCodes = allCodes.filter((code) => /^claim\./.test(code)).sort()
  const invented = allCodes.filter((code) => /^(claimLine|claimSubmission)\./i.test(code) || /(approve|submit|transmit)/i.test(code))
  check(
    'T006',
    'Permissions',
    same(claimCodes, ['claim.create', 'claim.read']) && (await grantsOf('claim.create')) === 'ORG_ADMIN' && (await grantsOf('claim.read')) === 'ORG_ADMIN,ORG_VIEWER' && invented.length === 0,
    invented.length === 0 ? 'claim.create for Admin only; claim.read for Admin and Viewer; no approve, submit or transmit permission' : `unexpected: ${invented.join(', ')}`,
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
  const post = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'POST', body: JSON.stringify(body) }))
  const send = (method: string, path: string, who = asAdmin) => httpCall(path, who({ method, body: '{}' }))
  const get = (path: string, who = asAdmin) => httpCall(path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const viewerUserId = (await prisma.user.findFirstOrThrow({ where: { email: viewerEmail }, select: { id: true } })).id

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const plainEncounter = async (label: string) =>
    must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body) as { id: string }

  // Synthetic runs through A5.7's own recorder; assessments through the A5.9 owner route.
  const plainContext = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  const recordedRunIds: string[] = []
  const recordRun = async (encounterId: string, findings: Record<string, unknown>[], validatorVersion = 'A5-VAL-1') => {
    const contextSnapshot = await plainContext(encounterId)
    const result = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId, contextSnapshot, validatorVersion, findings }, actorUserId, tx))
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    recordedRunIds.push(result.value.id)
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
    recordedRunIds.push(newRunId)
    return newRunId
  }
  const assess = async (validationRunId: string) => {
    const res = await post(`/api/validation-runs/${validationRunId}/readiness-assessments`, {})
    if (res.status !== 201) throw new Error(`a valid assessment was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as { id: string; state: string; readinessPolicyVersion: string; validationRunId: string }
  }
  // An assessment under a policy no owner path will record: inserted directly (the append-only trigger
  // refuses only UPDATE and DELETE), so the Claim contract's own refusal can be proven.
  const insertAssessmentDirectly = async (validationRunId: string, policy: string) =>
    (
      await prisma.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO pre_claim_readiness_assessments (id, validation_run_id, readiness_policy_version, state, assessed_at, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2, 'READY_FOR_REVIEW', now(), $3::uuid) RETURNING id::text AS id`,
        validationRunId,
        policy,
        actorUserId,
      )
    )[0].id
  const readyAssessment = async (label: string, findings = [finding('PASS'), finding('WARNING', { layer: 'CODING' })]) => {
    const encounter = await plainEncounter(label)
    const runIdOf = await recordRun(encounter.id, findings)
    const assessment = await assess(runIdOf)
    if (assessment.state !== 'READY_FOR_REVIEW') throw new Error(`fixture ${label} did not assess READY_FOR_REVIEW (${assessment.state})`)
    return { encounterId: encounter.id, runId: runIdOf, assessmentId: assessment.id }
  }

  const claimHttp = async (assessmentId: string, body?: unknown, who = asAdmin) => {
    const res = await httpCall(`/api/pre-claim-readiness-assessments/${assessmentId}/claims`, who(body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) }))
    return { status: res.status, body: res.body as any }
  }
  const createdClaimIds: string[] = []
  const claimFor = async (assessmentId: string) => {
    const res = await claimHttp(assessmentId, {})
    if (res.status !== 201) throw new Error(`a valid claim was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    createdClaimIds.push(res.body.id)
    return res.body as Record<string, string>
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const claimsFor = (assessmentId: string) => prisma.claim.count({ where: { preClaimReadinessAssessmentId: assessmentId } })
  const totalClaims = () => prisma.claim.count()
  const claimAudits = () => prisma.auditEvent.count({ where: { entityType: ENTITY } })
  const totalAudits = () => prisma.auditEvent.count()
  const handoffGet = async (assessmentId: string, who = asAdmin) => {
    const res = await get(`/api/pre-claim-readiness-assessments/${assessmentId}/a6-handoff`, who)
    return { status: res.status, body: res.body as any }
  }
  const auditsBeforeRefusals = { count: 0 }
  console.log('[A6.1]      fixtures ready: patient, AE-DU/DHA facility profile, clinician and the synthetic A5.7 recorder')

  // ---------------------------------------------------------------- creation contract (T007–T021)
  section('Claim creation contract')
  const main = await readyAssessment('main encounter')
  const mainHandoff = await handoffGet(main.assessmentId)
  const runBefore = JSON.stringify(await prisma.validationRun.findUniqueOrThrow({ where: { id: main.runId } }))
  const findingsBefore = JSON.stringify(await prisma.validationFinding.findMany({ where: { validationRunId: main.runId }, orderBy: { sequence: 'asc' }, include: { consumedDatasetVersions: true, ruleProvenance: true } }))
  const assessmentBefore = JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: main.assessmentId } }))
  const runsBeforeCreate = await prisma.validationRun.count()

  const bodyInjections: number[] = []
  auditsBeforeRefusals.count = await claimAudits()
  for (const body of [{ encounterId: main.encounterId }, { preClaimReadinessAssessmentId: main.assessmentId }, { readinessState: 'READY_FOR_REVIEW' }, { validationRunId: main.runId }, { context: {} }, []])
    bodyInjections.push((await claimHttp(main.assessmentId, body)).status)
  const dbNowBefore = (await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now
  const mainClaimRes = await claimHttp(main.assessmentId)
  const dbNowAfter = (await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now
  if (mainClaimRes.status === 201) createdClaimIds.push(mainClaimRes.body.id)
  const mainClaim = (mainClaimRes.body ?? {}) as Record<string, string>
  check(
    'T007',
    'Body empty only',
    bodyInjections.every((code) => code === 400) && mainClaimRes.status === 201 && (await claimsFor(main.assessmentId)) === 1,
    `Encounter, assessment, state, run and context fields and a non-object body are each refused (${bodyInjections.join('/')}); an absent body creates exactly one Claim`,
  )
  const mainAudit = mainClaim.id ? await prisma.auditEvent.findMany({ where: { entityId: mainClaim.id }, select: { actionCode: true, entityType: true, organizationId: true } }) : []
  check(
    'T008',
    'Admin create',
    mainClaimRes.status === 201 && (await claimsFor(main.assessmentId)) === 1 && mainAudit.length === 1 && mainAudit[0].actionCode === ACTION && mainAudit[0].entityType === ENTITY && mainAudit[0].organizationId === org,
    `the exact READY assessment produced one ${mainClaim.claimContractVersion} Claim and one ${ACTION} event`,
  )
  const viewerReady = await readyAssessment('viewer create')
  const auditsBefore09 = await claimAudits()
  const viewerCreate = await claimHttp(viewerReady.assessmentId, {}, asViewer)
  check('T009', 'Viewer create', viewerCreate.status === 403 && (await claimsFor(viewerReady.assessmentId)) === 0 && (await claimAudits()) === auditsBefore09, '403; no Claim and no audit')
  const malformed = await claimHttp('not-a-uuid', {})
  check('T010', 'Malformed assessment', malformed.status === 400 && errorCode(malformed.body) === 'VALIDATION_ERROR' && !/at |\bprisma\b|SELECT/i.test(JSON.stringify(malformed.body)), '400 safe envelope; no lookup or write')
  const before11 = await totalClaims()
  const missing = await claimHttp(MISSING, {})
  check('T011', 'Missing assessment', missing.status === 404 && (await totalClaims()) === before11 && (await claimAudits()) === auditsBefore09, '404; no Claim and no audit')

  // Another tenant's Encounter gets a synthetic run through the recorder and an assessment through the
  // service the A5.9 route calls; the owner routes only ever act for this tenant.
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  const foreignRunId = foreignEncounter ? await recordRun(foreignEncounter.id, [finding('PASS', { findingCode: 'SYNTHETIC_FOREIGN_CODE' })]) : null
  const foreignAssessmentResult = foreignRunId ? await recordReadinessAssessment(foreignRunId, {}, actorUserId) : null
  const foreignAssessmentId = foreignAssessmentResult?.ok ? foreignAssessmentResult.value.id : null
  const leaks = (body: unknown) => /READY_FOR_REVIEW|RESTRICTED|BLOCKED|SYNTHETIC_FOREIGN_CODE|findingCode|facilityId|validationRunId|encounterId/.test(JSON.stringify(body ?? {}))
  const foreignPost = foreignAssessmentId ? await claimHttp(foreignAssessmentId, {}) : null
  check(
    'T012',
    'Foreign assessment',
    foreignPost !== null && foreignPost.status === 403 && !leaks(foreignPost.body) && (await claimsFor(foreignAssessmentId!)) === 0,
    foreignPost === null ? 'no foreign-tenant Encounter exists to prove this' : `${foreignPost.status}; no readiness state, finding or context disclosed; nothing written`,
  )
  const boundAssessment = await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: main.assessmentId }, include: { validationRun: { select: { validatorVersion: true } } } })
  check('T013', 'READY required', boundAssessment.state === 'READY_FOR_REVIEW' && mainClaimRes.status === 201, 'a READY_FOR_REVIEW assessment is accepted')

  const outcomeAssessment = async (label: string, findings: Record<string, unknown>[]) => {
    const encounter = await plainEncounter(label)
    const assessment = await assess(await recordRun(encounter.id, findings))
    return assessment
  }
  const restricted = await outcomeAssessment('restricted', [finding('PASS'), finding('RESTRICT', { layer: 'COVERAGE' })])
  const blocked = await outcomeAssessment('blocked', [finding('PASS'), finding('FAIL', { layer: 'CODING' })])
  const restrictedRes = await claimHttp(restricted.id, {})
  check('T014', 'Restricted refused', restricted.state === 'RESTRICTED' && restrictedRes.status === 409 && errorCode(restrictedRes.body) === 'PRECLAIM_NOT_READY_FOR_CLAIM' && (await claimsFor(restricted.id)) === 0, '409 PRECLAIM_NOT_READY_FOR_CLAIM; no Claim')
  const blockedRes = await claimHttp(blocked.id, {})
  check('T015', 'Blocked refused', blocked.state === 'BLOCKED' && blockedRes.status === 409 && errorCode(blockedRes.body) === 'PRECLAIM_NOT_READY_FOR_CLAIM' && (await claimsFor(blocked.id)) === 0, '409 PRECLAIM_NOT_READY_FOR_CLAIM; no Claim')
  check('T016', 'Policy compatibility', boundAssessment.readinessPolicyVersion === 'A5-READY-1' && boundAssessment.validationRun.validatorVersion === 'A5-VAL-1' && mainClaimRes.status === 201, 'A5-READY-1 over A5-VAL-1 is accepted')
  const otherPolicyEncounter = await plainEncounter('other policy')
  const otherPolicyAssessment = await insertAssessmentDirectly(await recordRun(otherPolicyEncounter.id, [finding('PASS')]), 'A5-READY-2')
  const otherValidatorEncounter = await plainEncounter('other validator')
  const otherValidatorAssessment = await insertAssessmentDirectly(await recordRun(otherValidatorEncounter.id, [finding('PASS')], 'A5-VAL-2'), 'A5-READY-1')
  const otherPolicyRes = await claimHttp(otherPolicyAssessment, {})
  const otherValidatorRes = await claimHttp(otherValidatorAssessment, {})
  check(
    'T017',
    'Incompatible policy/validator',
    [otherPolicyRes, otherValidatorRes].every((res) => res.status === 409 && errorCode(res.body) === 'CLAIM_HANDOFF_INCOMPATIBLE') && (await claimsFor(otherPolicyAssessment)) === 0 && (await claimsFor(otherValidatorAssessment)) === 0,
    'an A5-READY-2 assessment and an A5-VAL-2 run are each refused with 409 CLAIM_HANDOFF_INCOMPATIBLE; no Claim',
  )
  const storedMain = mainClaim.id ? await prisma.claim.findUniqueOrThrow({ where: { id: mainClaim.id } }) : null
  check('T018', 'Handoff schema', storedMain?.handoffSchemaVersion === 'PreClaimA6HandoffV1' && mainClaim.handoffSchemaVersion === 'PreClaimA6HandoffV1' && mainHandoff.body?.schemaVersion === 'PreClaimA6HandoffV1', 'PreClaimA6HandoffV1 consumed and stored as the version label')
  check('T019', 'Claim contract', storedMain?.claimContractVersion === 'A6-CLAIM-1' && mainClaim.claimContractVersion === 'A6-CLAIM-1', 'A6-CLAIM-1 is server-owned and stored exactly')
  check('T020', 'Exact assessment binding', storedMain?.preClaimReadinessAssessmentId === main.assessmentId, `the stored assessment is exactly the route assessment ${main.assessmentId}`)
  check(
    'T021',
    'Exact Encounter binding',
    storedMain?.encounterId === main.encounterId && mainHandoff.status === 200 && mainHandoff.body?.validationRun?.encounterId === storedMain?.encounterId,
    'the Claim Encounter is exactly the handoff Encounter',
  )

  // ---------------------------------------------------------------- database guards (T022–T027)
  section('Database coherence, uniqueness and multiplicity')
  const insertClaimSql = `INSERT INTO claims (id, encounter_id, pre_claim_readiness_assessment_id, claim_contract_version, handoff_schema_version, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'A6-CLAIM-1', 'PreClaimA6HandoffV1', $3::uuid)`
  const coherence = await readyAssessment('coherence')
  const inRolledBackTransaction = async (write: (tx: typeof prisma) => Promise<unknown>) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await write(tx as unknown as typeof prisma)
        throw new RollbackSentinel('rolled back by the acceptance harness')
      }),
    )
  const validPair = await inRolledBackTransaction((tx) => tx.$executeRawUnsafe(insertClaimSql, coherence.encounterId, coherence.assessmentId, actorUserId))
  check('T022', 'DB coherence guard valid', /rolled back by the acceptance harness/.test(validPair) && (await claimsFor(coherence.assessmentId)) === 0, 'a direct insert of the correct Encounter-assessment pair is accepted (then rolled back)')
  const mismatch = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertClaimSql, main.encounterId, coherence.assessmentId, actorUserId))
  check('T023', 'DB coherence guard attack', /claims_binding_coherence/.test(mismatch) && (await claimsFor(coherence.assessmentId)) === 0, 'a direct insert pairing another Encounter with the assessment is rejected')
  const secondForMain = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertClaimSql, main.encounterId, main.assessmentId, actorUserId))
  check('T024', 'Assessment unique', /claims_pre_claim_readiness_assessment_id_key|unique|23505|P2010/i.test(secondForMain) && (await claimsFor(main.assessmentId)) === 1, 'a second Claim for the same assessment is refused by the unique key')

  // Two creates for one assessment: the first is held after its insert, the second waits on the
  // assessment lock, then both finish. Exactly one Claim and one audit survive.
  const race = await readyAssessment('race')
  const raceAuditsBefore = await claimAudits()
  const raceHold = holdAt('claim.inserted')
  const firstCreate = createClaim(race.assessmentId, {}, actorUserId)
  await raceHold.arrived
  const secondCreate = createClaim(race.assessmentId, {}, actorUserId)
  await pause(400)
  raceHold.release()
  const [firstResult, secondResult] = await Promise.all([firstCreate, secondCreate])
  clearConcurrencyProbes()
  if (firstResult.ok) createdClaimIds.push(firstResult.value.id)
  const httpRace = await readyAssessment('http race')
  const httpRaceStatuses = (await Promise.all([claimHttp(httpRace.assessmentId, {}), claimHttp(httpRace.assessmentId, {})])).map((res) => {
    if (res.status === 201) createdClaimIds.push(res.body.id)
    return res.status
  })
  check(
    'T025',
    'Concurrent duplicate',
    firstResult.ok && !secondResult.ok && secondResult.code === 'CLAIM_ALREADY_EXISTS' && (await claimsFor(race.assessmentId)) === 1 && (await claimAudits()) === raceAuditsBefore + 2 && same(httpRaceStatuses.sort(), [201, 409]) && (await claimsFor(httpRace.assessmentId)) === 1,
    `held/overlapping creates: one Claim and one audit; simultaneous HTTP creates ${httpRaceStatuses.join('/')}`,
  )
  const mainStoredBefore26 = JSON.stringify(storedMain)
  const auditsBefore26 = await claimAudits()
  const duplicate = await claimHttp(main.assessmentId, {})
  check(
    'T026',
    'Duplicate response',
    duplicate.status === 409 && errorCode(duplicate.body) === 'CLAIM_ALREADY_EXISTS' && JSON.stringify(await prisma.claim.findUniqueOrThrow({ where: { id: mainClaim.id } })) === mainStoredBefore26 && (await claimAudits()) === auditsBefore26,
    '409 CLAIM_ALREADY_EXISTS; the original is unchanged and no second audit is written',
  )
  // One Encounter, two successive READY validations, two Claims.
  const multiEncounter = await plainEncounter('multi encounter')
  const multiFirstRun = await recordRun(multiEncounter.id, [finding('PASS')])
  const multiFirstAssessment = await assess(multiFirstRun)
  const multiFirstClaim = await claimFor(multiFirstAssessment.id)
  const multiFirstBefore = JSON.stringify(await prisma.claim.findUniqueOrThrow({ where: { id: multiFirstClaim.id } }))
  const multiSecondRun = await recordRun(multiEncounter.id, [finding('PASS', { layer: 'CODING' })])
  const multiSecondAssessment = await assess(multiSecondRun)
  const multiSecondClaim = await claimFor(multiSecondAssessment.id)
  const multiClaims = await prisma.claim.findMany({ where: { encounterId: multiEncounter.id } })
  check(
    'T027',
    'Multiple Claims per Encounter',
    multiClaims.length === 2 && multiClaims.every((row) => row.encounterId === multiEncounter.id) && multiFirstClaim.id !== multiSecondClaim.id,
    'two different valid assessments of one Encounter produce two Claims; there is no Encounter uniqueness',
  )

  // ---------------------------------------------------------------- structural absence (T028–T035)
  section('No pointer, lifecycle, line, pricing, approval, payload, submission or transport')
  const claimColumns = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims' ORDER BY ordinal_position`).map((row) => row.column_name)
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  const readBody = (await get(`/api/claims/${mainClaim.id}`)).body as Record<string, unknown>
  const listBody = (await get(`/api/encounters/${multiEncounter.id}/claims`)).body as Record<string, unknown>
  const dtoKeys = [...deepKeys(mainClaim), ...deepKeys(readBody), ...deepKeys(listBody)]
  const reachedColumns = claimColumns.length === 7 && claimColumns.includes('pre_claim_readiness_assessment_id')
  const columnOrKey = (pattern: RegExp) => [...claimColumns, ...dtoKeys].filter((name) => pattern.test(name))
  const pointer = columnOrKey(/current|latest|primary|winner|is_?active/i)
  check('T028', 'No current Claim pointer', reachedColumns && pointer.length === 0, pointer.length === 0 ? 'no current, latest, primary or winner column or DTO key' : pointer.join(', '))
  const lifecycle = claimColumns.filter((name) => /status|state|draft|ready|approved|submitted|lifecycle/i.test(name))
  check('T029', 'No lifecycle state', reachedColumns && lifecycle.length === 0, lifecycle.length === 0 ? 'the Claim row has no DRAFT/READY/APPROVED/SUBMITTED or status column' : lifecycle.join(', '))
  const lineTables = tables.filter((name) => /^claim_(lines?|diagnos\w*|modifiers?)$/.test(name))
  check('T030', 'No ClaimLine', lineTables.length === 0 && columnOrKey(/lines?$|diagnos/i).length === 0, 'no ClaimLine or ClaimDiagnosis table, column or DTO key')
  const pricing = columnOrKey(/price|rate|fee|amount|currency|allowed|reimburs|responsibility|tariff/i)
  check('T031', 'No pricing', reachedColumns && pricing.length === 0, pricing.length === 0 ? 'no price, rate, fee, amount, currency, allowed, reimbursement or patient-responsibility field' : pricing.join(', '))
  const approval = columnOrKey(/approv|reviewer/i)
  check('T032', 'No approval', reachedColumns && approval.length === 0, 'no approver, approvedAt or approvedForSubmission field')
  const payload = columnOrKey(/payload|hash|xml|x12|serializ|canonical|signature/i)
  check('T033', 'No payload', reachedColumns && payload.length === 0, 'no payload, hash, XML, X12 or serialized claim field')
  const submissionTables = tables.filter((name) => /submission|evidence_package|claim_snapshot/.test(name))
  check('T034', 'No ClaimSubmission', submissionTables.length === 0 && columnOrKey(/submi/i).length === 0, 'no ClaimSubmission or evidence-package table or field')
  const moduleCode = committedProductionCodeOf([MODULE_DIR])
  const feCode = committedProductionCodeOf([FRONTEND_DIR])
  const reached = moduleCode.files.length === 5 && moduleCode.code.includes('composeA6Handoff') && moduleCode.code.includes('createClaimRecord')
  const transportHits = /\b(fetch|axios|https?\.request|dhpo|eclaimlink|clearinghouse|soap|transactionId|apiKey|clientSecret)\b/i.test(moduleCode.code)
  const transportNames = namesWithWord([...claimColumns, ...dtoKeys], ['transaction', 'transport', 'dhpo', 'eclaim', 'eclaimlink', 'clearinghouse'])
  check(
    'T035',
    'No transport',
    reached && !transportHits && transportNames.length === 0,
    transportNames.length === 0 ? 'no DHPO, eClaimLink or clearinghouse call, credential or transaction id' : transportNames.join(', '),
  )

  // ---------------------------------------------------------------- A5 reuse and snapshot (T036–T047)
  section('A5.9 owner reuse, snapshot consistency and recency')
  const imports = [...moduleCode.code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  check(
    'T036',
    'No A5 revalidation',
    reached && (await prisma.validationRun.count()) >= runsBeforeCreate && !imports.some((p) => /pre-claim-validation|validation-run\.recorder/.test(p)) && !/executePreClaimValidation|recordValidationRunInTransaction/.test(moduleCode.code),
    'Claim creation imports and runs no A5.8 validation and records no run',
  )
  check(
    'T037',
    'No readiness reducer copy',
    reached && imports.includes('../pre-claim-readiness/pre-claim-readiness.service.ts') && !/reduceReadiness|outcomes?\.includes|'RESTRICT'|'FAIL'|'WARNING'/.test(moduleCode.code),
    'the module imports the A5.9 owner composer and holds no FAIL/RESTRICT reduction',
  )
  check(
    'T038',
    'No recency query copy',
    reached && !/findRecencyRelations|decideRecency|evaluated_?[aA]t|validation_runs|validationRun\s*\.\s*find/.test(moduleCode.code),
    'no A5.9 recency SQL or logic is duplicated in A6.1',
  )
  const claimServiceCode = committedCode(`${MODULE_DIR}/claim.service.ts`)
  const a59ServiceCode = committedCode(`${A59_DIR}/pre-claim-readiness.service.ts`)
  check(
    'T039',
    'Same transaction composer',
    /composeA6Handoff\(assessmentId, tx\)/.test(claimServiceCode) && /withReadSnapshot\(undefined, \(tx\) => composeA6Handoff\(assessmentId, tx\)\)/.test(a59ServiceCode) && /export async function composeA6Handoff\(assessmentId: string, tx: DbClient\)/.test(a59ServiceCode),
    'the public A5.9 GET and A6.1 creation run one composer; A6.1 passes its own write transaction client',
  )
  // The creation is held after its first statement (the assessment lock, which takes the REPEATABLE
  // READ snapshot). A newer run is then committed for the same Encounter. The held creation still sees
  // the earlier snapshot, so its decision and its insert agree; the public handoff afterwards refuses.
  const snapshot = await readyAssessment('snapshot')
  const snapshotHold = holdAt('claim.assessment_locked')
  const snapshotCreate = createClaim(snapshot.assessmentId, {}, actorUserId)
  await snapshotHold.arrived
  const lateRun = await recordRun(snapshot.encounterId, [finding('PASS', { layer: 'EVIDENCE' })])
  snapshotHold.release()
  const snapshotResult = await snapshotCreate
  clearConcurrencyProbes()
  if (snapshotResult.ok) createdClaimIds.push(snapshotResult.value.id)
  const snapshotHandoffAfter = await handoffGet(snapshot.assessmentId)
  check(
    'T040',
    'Snapshot consistency',
    /isolationLevel: Prisma\.TransactionIsolationLevel\.RepeatableRead/.test(claimServiceCode) && snapshotResult.ok && lateRun.length > 0 && snapshotHandoffAfter.status === 409 && errorCode(snapshotHandoffAfter.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION',
    'a run committed after the snapshot was taken is invisible to the decision and the insert alike; a later public handoff sees it and refuses',
  )
  const supersededEncounter = await plainEncounter('superseded')
  const supersededOld = await assess(await recordRun(supersededEncounter.id, [finding('PASS')]))
  await assess(await recordRun(supersededEncounter.id, [finding('PASS', { layer: 'CODING' })]))
  const supersededRes = await claimHttp(supersededOld.id, {})
  check('T041', 'Newer run supersedes', supersededRes.status === 409 && errorCode(supersededRes.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' && (await claimsFor(supersededOld.id)) === 0, '409 READINESS_SUPERSEDED_BY_NEWER_VALIDATION; no Claim')
  const unassessedEncounter = await plainEncounter('newer unassessed')
  const unassessedOld = await assess(await recordRun(unassessedEncounter.id, [finding('PASS')]))
  await recordRun(unassessedEncounter.id, [finding('PASS', { layer: 'CODING' })])
  const unassessedRes = await claimHttp(unassessedOld.id, {})
  check('T042', 'Newer unassessed supersedes', unassessedRes.status === 409 && errorCode(unassessedRes.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' && (await claimsFor(unassessedOld.id)) === 0, 'a newer run without any assessment still refuses the older one')
  const tieEncounter = await plainEncounter('tie')
  const tieRun = await recordRun(tieEncounter.id, [finding('PASS')])
  const tieAssessment = await assess(tieRun)
  await copyRunAtSameInstant(tieRun)
  const tieRes = await claimHttp(tieAssessment.id, {})
  check('T043', 'Recency tie', tieRes.status === 409 && errorCode(tieRes.body) === 'VALIDATION_RUN_RECENCY_AMBIGUOUS' && (await claimsFor(tieAssessment.id)) === 0, '409 VALIDATION_RUN_RECENCY_AMBIGUOUS; no identifier wins')
  const multiFirstAfter = JSON.stringify(await prisma.claim.findUnique({ where: { id: multiFirstClaim.id } }))
  check('T044', 'Post-create newer validation', multiFirstAfter === multiFirstBefore && snapshotResult.ok && (await prisma.claim.count({ where: { id: snapshotResult.ok ? snapshotResult.value.id : MISSING } })) === 1, 'a later ValidationRun neither rewrites nor deletes an existing Claim')
  check('T045', 'A5 run immutable', JSON.stringify(await prisma.validationRun.findUniqueOrThrow({ where: { id: main.runId } })) === runBefore, 'the bound ValidationRun is byte-identical after Claim creation')
  check(
    'T046',
    'A5 findings immutable',
    JSON.stringify(await prisma.validationFinding.findMany({ where: { validationRunId: main.runId }, orderBy: { sequence: 'asc' }, include: { consumedDatasetVersions: true, ruleProvenance: true } })) === findingsBefore,
    'the bound findings and their provenance are unchanged',
  )
  check('T047', 'A5 readiness immutable', JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: main.assessmentId } })) === assessmentBefore, 'the bound assessment is unchanged')

  // ---------------------------------------------------------------- reads and immutability (T048–T056)
  section('Claim reads, tenancy and identity immutability')
  const readKeys = Object.keys(readBody ?? {}).sort()
  check(
    'T048',
    'Claim GET',
    same(readKeys, [...IDENTITY_KEYS, 'source'].sort()) &&
      IDENTITY_KEYS.every((key) => readBody[key] === mainClaim[key]) &&
      same(readBody.source, { validationRunId: main.runId, readinessState: 'READY_FOR_REVIEW' }),
    'the exact identity and contract versions, plus the derived source run and readiness state',
  )
  const listed = ((listBody as { items?: { id: string; encounterId: string; createdAt: string }[] }).items ?? [])
  const expectedOrder = [...listed].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1)).map((item) => item.id)
  check(
    'T049',
    'Encounter Claim list',
    listed.length === 2 && listed.every((item) => item.encounterId === multiEncounter.id) && same(listed.map((item) => item.id), expectedOrder) && listed[0].id === multiSecondClaim.id,
    'only that Encounter’s Claims, createdAt DESC then id ASC',
  )
  const foreignClaimResult = foreignAssessmentId ? await createClaim(foreignAssessmentId, {}, actorUserId) : null
  const foreignClaimId = foreignClaimResult?.ok ? foreignClaimResult.value.id : null
  const foreignGet = foreignClaimId ? await get(`/api/claims/${foreignClaimId}`) : null
  check(
    'T050',
    'Cross-tenant Claim GET',
    foreignGet !== null && foreignGet.status === 403 && !leaks(foreignGet.body),
    foreignGet === null ? 'no foreign-tenant Claim could be created to prove this' : '403; nothing about the foreign Claim is disclosed',
  )
  const foreignList = foreignEncounter ? await get(`/api/encounters/${foreignEncounter.id}/claims`) : null
  check('T051', 'Cross-tenant Claim list', foreignList !== null && foreignList.status === 403 && !leaks(foreignList.body), foreignList === null ? 'no foreign-tenant Encounter exists' : '403; the foreign Encounter is refused')
  const viewerGet = await get(`/api/claims/${mainClaim.id}`, asViewer)
  const viewerList = await get(`/api/encounters/${multiEncounter.id}/claims`, asViewer)
  check('T052', 'Viewer reads', viewerGet.status === 200 && (viewerGet.body as any)?.id === mainClaim.id && viewerList.status === 200 && ((viewerList.body as any)?.items ?? []).length === 2, `get ${viewerGet.status}, list ${viewerList.status}`)
  const routeCode = committedCode(`${MODULE_DIR}/claim.route.ts`)
  const routeVerbs = [...routeCode.matchAll(/\b\w+Router\.(get|post|put|patch|delete|all)\(/g)].map((m) => m[1]).sort()
  const mutationStatuses = [await send('PATCH', `/api/claims/${mainClaim.id}`), await send('PUT', `/api/claims/${mainClaim.id}`), await send('DELETE', `/api/claims/${mainClaim.id}`)].map((res) => res.status)
  check('T053', 'Claim API immutable', same(routeVerbs, ['get', 'get', 'post']) && mutationStatuses.every((code) => code === 404), `routes: ${routeVerbs.join(', ')}; PATCH/PUT/DELETE ${mutationStatuses.join('/')}`)
  const identityAttacks: [string, string][] = [
    ['encounter_id', `'${multiEncounter.id}'::uuid`],
    ['pre_claim_readiness_assessment_id', `'${coherence.assessmentId}'::uuid`],
    ['claim_contract_version', `'A6-CLAIM-2'`],
    ['handoff_schema_version', `'PreClaimA6HandoffV2'`],
    ['created_by_user_id', `'${viewerUserId}'::uuid`],
    ['created_at', `created_at + interval '1 second'`],
    ['id', 'gen_random_uuid()'],
  ]
  const updateRefusals: string[] = []
  for (const [column, value] of identityAttacks) updateRefusals.push(await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claims SET ${column} = ${value} WHERE id = $1::uuid`, mainClaim.id)))
  check(
    'T054',
    'DB identity UPDATE attack',
    updateRefusals.every((message) => /identity and source binding are immutable/.test(message)) && JSON.stringify(await prisma.claim.findUniqueOrThrow({ where: { id: mainClaim.id } })) === mainStoredBefore26,
    `changing the Encounter, assessment, both versions, creator, createdAt or id is refused (${updateRefusals.length}/7)`,
  )
  const deleteRefusal = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claims WHERE id = $1::uuid`, mainClaim.id))
  check('T055', 'DB DELETE attack', /claims cannot be deleted/.test(deleteRefusal) && (await prisma.claim.count({ where: { id: mainClaim.id } })) === 1, 'a direct DELETE is refused')
  const neutralUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claims SET created_at = created_at WHERE id = $1::uuid`, mainClaim.id))
  const guardSource = (await prisma.$queryRaw<{ src: string }[]>`SELECT prosrc AS src FROM pg_proc WHERE proname = 'claims_identity_guard'`)[0]?.src ?? ''
  check(
    'T056',
    'Future update compatibility',
    neutralUpdate === '' && /IS DISTINCT FROM/.test(guardSource) && /RETURN NEW/.test(guardSource),
    'an UPDATE that changes no identity column passes the guard, so later lifecycle columns are not blanket-refused',
  )

  // ---------------------------------------------------------------- audit (T057–T061)
  section('Business audit')
  const claimAuditRows = await prisma.auditEvent.findMany({ where: { entityType: ENTITY, entityId: { in: createdClaimIds } } })
  const perClaim = createdClaimIds.map((id) => claimAuditRows.filter((row) => row.entityId === id && row.actionCode === ACTION).length)
  // Six Claims exist by now: main, the held race, the HTTP race, the two of one Encounter and the snapshot.
  check('T057', 'Audit count', createdClaimIds.length >= 6 && perClaim.every((n) => n === 1), `exactly one ${ACTION} for each of the ${createdClaimIds.length} Claims created by this run`)
  const auditText = JSON.stringify(claimAuditRows.map((row) => [row.beforeState, row.afterState]))
  check(
    'T058',
    'Audit minimization',
    claimAuditRows.every((row) => row.beforeState === null && same(Object.keys((row.afterState ?? {}) as object).sort(), ['claimContractVersion', 'createdAt', 'handoffSchemaVersion', 'id'])) &&
      !auditText.includes(main.encounterId) &&
      !auditText.includes(main.assessmentId) &&
      !auditText.includes(main.runId) &&
      !/SYNTHETIC_|findingCode|facilityId|payerId|organizationId/.test(auditText),
    'id, contract, handoff schema and createdAt only; no Encounter, assessment, run, finding or context',
  )
  const rollback = async (probe: string) => {
    const fixture = await readyAssessment(`rollback ${probe}`)
    const audits = await claimAudits()
    failAt(probe, 'forced failure (acceptance)')
    let threw = false
    try {
      await createClaim(fixture.assessmentId, {}, actorUserId)
    } catch {
      threw = true
    }
    clearConcurrencyProbes()
    return threw && (await claimsFor(fixture.assessmentId)) === 0 && (await claimAudits()) === audits
  }
  check('T059', 'Atomic audit rollback', (await rollback('claim.created')) && (await rollback('claim.inserted')), 'a forced failure after the audit, or after the insert, leaves neither Claim nor audit')
  const auditsBeforeReads = await totalAudits()
  await get(`/api/claims/${mainClaim.id}`)
  await get(`/api/encounters/${multiEncounter.id}/claims`)
  await get(`/api/claims/${mainClaim.id}`, asViewer)
  await get(`/api/encounters/${multiEncounter.id}/claims`, asViewer)
  check('T060', 'No audit on reads', (await totalAudits()) === auditsBeforeReads, 'four Claim and list reads wrote no AuditEvent')
  const refusalAuditsBefore = await claimAudits()
  for (const refusal of [
    () => claimHttp(viewerReady.assessmentId, {}, asViewer),
    () => claimHttp('not-a-uuid', {}),
    () => claimHttp(MISSING, {}),
    () => claimHttp(restricted.id, {}),
    () => claimHttp(blocked.id, {}),
    () => claimHttp(otherPolicyAssessment, {}),
    () => claimHttp(supersededOld.id, {}),
    () => claimHttp(tieAssessment.id, {}),
    () => claimHttp(main.assessmentId, {}),
    () => claimHttp(viewerReady.assessmentId, { encounterId: viewerReady.encounterId }),
  ])
    await refusal()
  check(
    'T061',
    'No false audit',
    (await claimAudits()) === refusalAuditsBefore && auditsBeforeRefusals.count >= 0 && (await claimsFor(viewerReady.assessmentId)) === 0,
    'denied, malformed, missing, restricted, blocked, incompatible, superseded, tied, duplicate and injected attempts wrote no AuditEvent',
  )

  // ---------------------------------------------------------------- no copied truth (T062–T066)
  section('No copied A5 truth and derived lineage')
  check('T062', 'No org copy', reachedColumns && !claimColumns.some((name) => /organi[sz]ation/.test(name)), 'the Claim row has no organizationId')
  // The identity words are assembled so this harness never contains a real-data marker itself (T081).
  const patientCopy = columnOrKey(new RegExp(['patient', 'member', 'given', 'family', 'birth', 'dob', 'policy', 'emir' + 'ates', 'pass' + 'port'].join('|'), 'i'))
  check('T063', 'No patient/member copy', reachedColumns && patientCopy.length === 0, patientCopy.length === 0 ? 'no patient name, DOB, member or policy value in the row or DTO' : patientCopy.join(', '))
  const commercialCopy = claimColumns.filter((name) => /payer|tpa|network|product|contract_id|tariff|facility/.test(name))
  check('T064', 'No payer/commercial copy', reachedColumns && commercialCopy.length === 0, commercialCopy.length === 0 ? 'no payer, TPA, network, product, contract, tariff or facility column' : commercialCopy.join(', '))
  const validationCopy = namesWithWord(claimColumns, ['validation', 'finding', 'findings', 'outcome', 'outcomes', 'run', 'count'])
  check('T065', 'No validation copy', reachedColumns && validationCopy.length === 0, validationCopy.length === 0 ? 'no validationRunId, finding count or outcome column' : validationCopy.join(', '))
  const lineage = (
    await prisma.$queryRaw<{ run_id: string; encounter_id: string; profile_id: string; jurisdiction: string }[]>`
      SELECT run.id::text AS run_id, run.encounter_id::text AS encounter_id, run.facility_regulatory_profile_id::text AS profile_id, profile.jurisdiction_code AS jurisdiction
      FROM claims claim
      JOIN pre_claim_readiness_assessments assessment ON assessment.id = claim.pre_claim_readiness_assessment_id
      JOIN validation_runs run ON run.id = assessment.validation_run_id
      JOIN facility_regulatory_profiles profile ON profile.id = run.facility_regulatory_profile_id
      WHERE claim.id = ${mainClaim.id}::uuid`
  )[0]
  check(
    'T066',
    'Derived lineage',
    lineage?.run_id === main.runId && lineage?.encounter_id === main.encounterId && lineage?.profile_id === mainHandoff.body?.validationRun?.context?.facilityRegulatoryProfileId,
    'Claim -> assessment -> run -> exact context reconstructs without any copied mutable truth',
  )

  // ---------------------------------------------------------------- multi-market guards (T067–T077)
  section('UAE-preserving multi-market guards (no US behaviour added)')
  const encounterProfile = (await prisma.encounter.findUniqueOrThrow({ where: { id: main.encounterId }, select: { facilityRegulatoryProfileId: true } })).facilityRegulatoryProfileId
  check('T067', 'Exact regulatory path', !!lineage?.profile_id && lineage.profile_id === encounterProfile && lineage.profile_id === profile.id, 'the bound run keeps the exact non-null facilityRegulatoryProfileId of the Encounter')
  const profileRewrite = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE validation_runs SET facility_regulatory_profile_id = facility_regulatory_profile_id WHERE id = $1::uuid`, main.runId))
  check('T068', 'Historical jurisdiction safe', profileRewrite !== '' && lineage?.profile_id === profile.id, 'the bound run cannot be rewritten, so a later market extension cannot reinterpret the bound UAE profile')
  const countryReady = await readyAssessment('country selector')
  const countryAttempts: number[] = []
  for (const body of [{ jurisdictionCode: 'US-CA' }, { market: 'US' }, { country: 'US' }, { facilityRegulatoryProfileId: profile.id }]) countryAttempts.push((await claimHttp(countryReady.assessmentId, body)).status)
  check('T069', 'No client country selector', countryAttempts.every((code) => code === 400) && (await claimsFor(countryReady.assessmentId)) === 0, `a client-supplied jurisdiction, market, country or profile is refused (${countryAttempts.join('/')})`)
  check('T070', 'No global market switch', reached && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION)\w*/i.test(moduleCode.code) && !/\b(MARKET_MODE|marketMode|countryMode)\b/.test(moduleCode.code), 'no process-global UAE/US mode in the shared Claim path')
  const usColumns = claimColumns.filter((name) => /npi|cpt|hcpcs|medicare|medicaid|x12|clearinghouse/i.test(name))
  check('T071', 'No US core fields', reachedColumns && usColumns.length === 0, 'no NPI, Medicare, Medicaid, X12, clearinghouse, CPT or HCPCS Claim column')
  check('T072', 'No US runtime', reached && !/\b(x12|clearinghouse|medicare|medicaid|hcpcs|npi)\b/i.test(moduleCode.code + feCode.code), 'no US payer or clearinghouse behaviour')
  check('T073', 'No new UAE hard-code', reached && !/['"`](AE-DU|AE-AZ|DHA|DOH|AED)['"`]/.test(moduleCode.code + feCode.code), 'no AE-DU, DHA or AED literal drives Claim creation')
  check('T074', 'UAE synthetic path', mainClaimRes.status === 201 && lineage?.jurisdiction === 'AE-DU', 'an AE-DU/DHA handoff creates an A6-CLAIM-1 Claim')
  check('T075', 'Jurisdiction source', reachedColumns && !claimColumns.some((name) => /jurisdiction|country|market|region/i.test(name)) && lineage?.jurisdiction === 'AE-DU', 'the jurisdiction is derived from the exact regulatory profile, never stored or chosen by the client')
  check('T076', 'DHPO boundary', reached && !/\b(xml|soap|multipart|upload|dhpo|eclaimlink)\b/i.test(moduleCode.code + feCode.code), 'no XML, SOAP or file upload')
  check('T077', 'NABIDH boundary', reached && !/\b(hl7|nabidh|fhir|hie)\b/i.test(moduleCode.code + feCode.code), 'no HIE or NABIDH message behaviour')

  // ---------------------------------------------------------------- scans (T078–T083)
  section('Secret, logging, storage and synthetic-data scans; A1 provisioning and health')
  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [`:/${HARNESS_DIR}`, `:/${MODULE_DIR}`, `:/${FRONTEND_DIR}`],
  )
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [`:/${HARNESS_DIR}`])
  check('T078', 'Secret scan', secretReach.status === 0 && secretScan.status === 1, 'no credential, private key or payer secret is committed (search verified to reach the harness)')
  const scanPaths = [`:/${MODULE_DIR}`, `:/${FRONTEND_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const logReach = gitGrep('composeA6Handoff|createClaim', scanPaths)
  check('T079', 'Logging scan', logReach.status === 0 && logScan.status === 1 && !/req\.query/.test(moduleCode.code) && !/fetch\(`[^`]*\?/.test(feCode.code), 'no Claim or A5 payload is logged; no query string is read or sent (search verified to reach the source)')
  check(
    'T080',
    'Browser storage scan',
    feCode.files.length === 2 && feCode.code.includes('createClaim') && !/\b(localStorage|sessionStorage|indexedDB)\b/.test(feCode.code) && !/findingCode|exactReferences|findingRefs|memberIdentifier|facilityId|payerId/.test(feCode.code),
    'nothing in browser storage; only the Claim id, its bound ids and contract versions are shown',
  )
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git(`show HEAD:${HARNESS_DIR}/a6-claim-foundation.integration.ts`)
  check('T081', 'Synthetic-data proof', harnessSource.length > 0 && harnessSource.match(realDataMarkers) === null && runId.startsWith('A61-'), 'fixtures are runId-keyed synthetic values; no real patient, member or claim marker')
  const organizationsBefore = await prisma.organization.count()
  const anonymousCreate = await httpCall('/api/organizations', anonymous({ method: 'POST', body: JSON.stringify({ name: `${runId} org` }) }))
  const adminCreate = await post('/api/organizations', { name: `${runId} org` })
  check(
    'T082',
    'A1 provisioning security',
    anonymousCreate.status === 404 && adminCreate.status === 404 && (await prisma.organization.count()) === organizationsBefore,
    `anonymous ${anonymousCreate.status}, admin ${adminCreate.status}; no Organization written`,
  )

  // ---------------------------------------------------------------- build gates (T097–T099)
  section('Build gates')
  const unitTests = run('npm run test:unit')
  check('T097', 'Unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), (unitTests.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0])
  const typecheck = run('npm run typecheck')
  check('T098', 'Typecheck', typecheck.ok, 'backend typecheck clean')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T099', 'Frontend build/lint', build.ok && lint.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)
  // PostgreSQL 18 also catalogues each NOT NULL as a pg_constraint row (contype 'n'); those are column
  // nullability, not A6.1 business constraints, and are judged by the column list instead.
  const constraintNames = (await prisma.$queryRaw<{ name: string }[]>`SELECT conname AS name FROM pg_constraint WHERE conrelid = 'claims'::regclass AND contype <> 'n'`).map((row) => row.name).sort()
  const triggerNames = (await prisma.$queryRaw<{ name: string }[]>`SELECT tgname AS name FROM pg_trigger WHERE tgrelid = 'claims'::regclass AND NOT tgisinternal`).map((row) => row.name).sort()
  const uniqueIndexes = (await prisma.$queryRaw<{ def: string }[]>`SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'claims' AND indexdef LIKE 'CREATE UNIQUE%'`).map((row) => row.def)
  check(
    'T100',
    'DB structure',
    same(constraintNames, ['claims_claim_contract_version_chk', 'claims_created_by_user_id_fkey', 'claims_encounter_id_fkey', 'claims_handoff_schema_version_chk', 'claims_pkey', 'claims_pre_claim_readiness_assessment_id_fkey']) &&
      same(triggerNames, ['claims_binding_coherence_trg', 'claims_identity_guard_trg']) &&
      uniqueIndexes.some((def) => /\(pre_claim_readiness_assessment_id\)/.test(def)) &&
      !uniqueIndexes.some((def) => /\(encounter_id\)/.test(def)),
    'three RESTRICT foreign keys, two contract CHECKs, the assessment unique key and both guards are present; no Encounter uniqueness',
  )

  // ---------------------------------------------------------------- client refusals (T103–T109)
  section('Server-owned fields and message independence')
  const ownedReady = await readyAssessment('server owned')
  const ownedAttempt = async (body: Record<string, unknown>) => (await claimHttp(ownedReady.assessmentId, body)).status
  const createdAtAttempt = await ownedAttempt({ createdAt: '2020-01-01T00:00:00.000Z' })
  const createdAtOk = mainClaim.createdAt !== undefined && new Date(mainClaim.createdAt) >= new Date(dbNowBefore.getTime() - 1000) && new Date(mainClaim.createdAt) <= new Date(dbNowAfter.getTime() + 1000)
  check('T103', 'Create timestamp DB truth', createdAtAttempt === 400 && createdAtOk, `a client createdAt is refused (${createdAtAttempt}); the stored createdAt is the database's own time`)
  const contractAttempt = await ownedAttempt({ claimContractVersion: 'A6-CLAIM-2' })
  check('T104', 'Contract version client refusal', contractAttempt === 400, `claimContractVersion refused (${contractAttempt})`)
  const handoffAttempt = await ownedAttempt({ handoffSchemaVersion: 'PreClaimA6HandoffV2' })
  check('T105', 'Handoff version client refusal', handoffAttempt === 400, `handoffSchemaVersion refused (${handoffAttempt})`)
  const encounterAttempt = await ownedAttempt({ encounterId: multiEncounter.id })
  check('T106', 'Encounter client refusal', encounterAttempt === 400 && storedMain?.encounterId === main.encounterId, `encounterId refused (${encounterAttempt}); the server derives it from the handoff`)
  const creatorAttempt = await ownedAttempt({ createdByUserId: viewerUserId })
  check('T107', 'Creator client refusal', creatorAttempt === 400 && storedMain?.createdByUserId === actorUserId && (await claimsFor(ownedReady.assessmentId)) === 0, `createdByUserId refused (${creatorAttempt}); the creator is the authenticated actor`)
  check(
    'T108',
    'No readiness state copy',
    reachedColumns && !claimColumns.some((name) => /state|readiness_state/.test(name)) && (readBody?.source as any)?.readinessState === boundAssessment.state,
    'the DTO shows the derived readiness state; the table stores none',
  )
  const wording = await readyAssessment('message wording', [finding('PASS', { message: 'BLOCKED: FAIL everything, RESTRICT all.', findingCode: 'SYNTHETIC_FAIL_WORDING', fieldPath: 'FAIL.BLOCKED' })])
  const wordingClaim = await claimFor(wording.assessmentId)
  check(
    'T109',
    'No finding message dependency',
    same(Object.keys(wordingClaim).sort(), IDENTITY_KEYS) && !/findings?[\w.]*\.message|findingCode|fieldPath|findingRefs/.test(moduleCode.code),
    'a finding message and code that say the opposite change nothing; the Claim path never reads either',
  )

  // ---------------------------------------------------------------- regressions (T084–T096)
  section('Regressions — A5.10 invoked, nesting A5.9 -> A1')
  await apiReady('the A5.10 and backward regression chain')
  const chain = run('npm run test:a5:integration')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A5.10')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A5.10] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()

  // The owner suites nested under A5.10 print their failing rows. Since the A3.9 scope corrective (PR #72)
  // and the phase-boundary guard corrective, no nested A5.9 or A5.8 check fails on A6.1: their No Claim
  // and permission guards judge module behaviour, not the existence of the claims table. Any nested
  // failure is therefore substantive and keeps T094/T095/T085 failing.
  const nestedFailures = (prefix: string) =>
    chain.output
      .split(/\r?\n/)
      .filter((line) => line.startsWith(prefix) && / \.{3,} FAIL/.test(line))
      .map((line) => (line.slice(prefix.length).match(/^(T\d+)/) ?? ['', ''])[1])
      .filter(Boolean)
  const a59Failures = [...new Set(nestedFailures('[A5.10]      [A5.9] '))]
  const a58Failures = [...new Set(nestedFailures('[A5.10]      [A5.9]      [A5.8] '))]
  // A3: the A3.9 scope suite is run directly and must have no failure at all, and the governance chain
  // nested under A4 must report its substantive checks PASS with no unexpected A3.10 failure.
  const scope = run('npm run test:a3:scope')
  const scopeFails = scope.output.split(/\r?\n/).filter((l) => /^\s*FAIL\s/.test(l))
  const a310Unexpected = [...new Set([...chain.output.matchAll(/unexpected A3\.10 failures: ([T\d, ]+)/g)].flatMap((m) => m[1].split(',').map((id) => id.trim()).filter(Boolean)))]
  const a3Ok = scope.output.includes('[a3.9-scope]') && /ALL CHECKS PASS/.test(scope.output) && scopeFails.length === 0 && a310Unexpected.length === 0 && /A3 substantive checks PASS/.test(chain.output)
  const a58Ok = a58Failures.length === 0 && !/\[A5\.8\] uncaught error|\[A5\.8\] RUN ABORTED/.test(chain.output)
  const a59Ok = a59Failures.length === 0 && !/\[A5\.9\] uncaught error|\[A5\.9\] RUN ABORTED/.test(chain.output)

  // A5.10 asserts facts about its own branch and the paths it was allowed to change. On A6.1 those
  // statements are obsolete by design; every other A5.10 check, including its three owner-suite
  // aggregates and its No Claim guard, is substantive and must PASS.
  const a510NonApplicable: Record<string, string> = {
    T001: "A5.10 'Start gate' requires the current branch to be the A5.10 feature branch; A6.1 is branched from the corrected main",
    T004: "A5.10 'No A5.10 schema' asserts schema.prisma is unchanged against main; A6.1 adds the Claim model",
    T005: "A5.10 'No A5.10 migration' asserts no migration against main; A6.1 adds exactly one",
    T006: "A5.10 'No new production route' asserts its diff touches no production file; A6.1 adds the Claim module and routes",
    T007: "A5.10 'No new permission' asserts no vocabulary is added; A6.1 adds claim.create/claim.read, claim.created and four Claim error codes",
    T110: "A5.10 'No global market switch' includes 'A5.10 changes no production file'; the market-switch scan itself is T070 here",
    T113: "A5.10 'No new UAE hard-code' includes 'A5.10 adds no production branch'; the hard-code scan itself is T073 here",
    T124: "A5.10 'No A5.10 DB drift' asserts no schema change; Prisma validate/generate/status are T004 here",
    T139: "A5.10 'Diff scope' lists the paths A5.10 was allowed to change; A6.1 legitimately changes different ones",
    T140: "A5.10 'Exact head evidence' requires the upstream to be the A5.10 feature branch, deleted when it merged",
  }
  const undocumented = failing.filter((id) => !(id in a510NonApplicable))
  const counts = chain.output.match(/\[A5\.10\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T126') && rows.some((row) => row.id === 'T135')
  check(
    'T096',
    'A5.10 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A5.10 suite did not reach its owner-suite checks'
      : !reconciled
        ? `A5.10 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A5.10 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A5\.10\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.10] automated summary: ', 'A5.10 ')}; all ${failedCount} failure(s) named and accounted for, and every substantive A5 check still holds`,
  )
  for (const id of undocumented) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) console.log(`[A6.1]      ${row.line.slice(0, 400)}`)
  }
  for (const id of Object.keys(a510NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T096/${id}`, `A5.10 ${titleOf(row.line)}`, a510NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0) {
    for (const text of chain.output.split(/\r?\n/).filter((l) => (l.startsWith('[A5.10]      ') || /RUN ABORTED|uncaught error|INVALID RUN/.test(l)) && !/ substantive checks /.test(l)))
      console.log(`[A6.1]      ${text.slice(0, 400)}`)
  }
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const substantive = (layer: string) => new RegExp(`${layer} substantive checks PASS`).test(chain.output)
  check('T084', 'A2 regression', substantive('A2'), `A2 substantive checks ${substantive('A2') ? 'PASS' : 'not PASS'} (nested through A5.10 -> A4)`)
  check(
    'T085',
    'A3 regression',
    a3Ok,
    `A3.9 scope suite run directly: ${(scope.output.match(/\d+ passed, \d+ failed/) ?? ['no summary'])[0]}; nested A3 substantive checks ${/A3 substantive checks PASS/.test(chain.output) ? 'PASS' : 'not PASS'}; unexpected A3.10 failures: ${a310Unexpected.join(', ') || 'none'}`,
  )
  check('T086', 'A4 regression', verdictOf('T134') === 'PASS', `A5.10 T134 (A4.10 and A4.9 to A1) ${verdictOf('T134')}`)
  check('T087', 'A5.1 regression', verdictOf('T133') === 'PASS' && verdictOf('T011') === 'PASS', `A5.10 T133 (A5.2/A5.1 owner suites) ${verdictOf('T133')}, T011 ${verdictOf('T011')}`)
  check('T088', 'A5.2 regression', verdictOf('T133') === 'PASS' && verdictOf('T012') === 'PASS', `A5.10 T133 ${verdictOf('T133')}, T012 ${verdictOf('T012')}`)
  check('T089', 'A5.3 regression', verdictOf('T132') === 'PASS' && verdictOf('T014') === 'PASS', `A5.10 T132 (A5.3) ${verdictOf('T132')}`)
  check('T090', 'A5.4 regression', verdictOf('T131') === 'PASS' && verdictOf('T015') === 'PASS', `A5.10 T131 (A5.4) ${verdictOf('T131')}`)
  check('T091', 'A5.5 regression', verdictOf('T130') === 'PASS' && verdictOf('T017') === 'PASS', `A5.10 T130 (A5.5) ${verdictOf('T130')}`)
  check('T092', 'A5.6 regression', verdictOf('T129') === 'PASS' && verdictOf('T020') === 'PASS', `A5.10 T129 (A5.6) ${verdictOf('T129')}`)
  check('T093', 'A5.7 regression', verdictOf('T128') === 'PASS' && verdictOf('T021') === 'PASS', `A5.10 T128 (A5.7) ${verdictOf('T128')}`)
  const layerChecks = (ids: string[]) => ids.every((id) => verdictOf(id) === 'PASS')
  check(
    'T094',
    'A5.8 regression',
    a58Ok && layerChecks(['T023', 'T024', 'T025', 'T026', 'T027', 'T028', 'T122']),
    `nested A5.8 failures: ${a58Failures.join(', ') || 'none'}; A5.10 A5.8 checks T023-T028 and T122 ${['T023', 'T024', 'T025', 'T026', 'T027', 'T028', 'T122'].map(verdictOf).join('/')}`,
  )
  check(
    'T095',
    'A5.9 regression',
    a59Ok && layerChecks(['T029', 'T030', 'T069', 'T070', 'T074', 'T080', 'T081', 'T123']),
    `nested A5.9 failures: ${a59Failures.join(', ') || 'none'}; A5.10 readiness and handoff checks ${['T029', 'T030', 'T069', 'T070', 'T074', 'T080', 'T081', 'T123'].map(verdictOf).join('/')}`,
  )
  for (const text of chain.output.split(/\r?\n/).filter((l) => l.startsWith('[A5.10]      ') && / substantive checks /.test(l))) console.log(`[A6.1]      ${text.replace('[A5.10]', '').trim().slice(0, 190)}`)

  // ---------------------------------------------------------------- DB truth (T083)
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
  check('T083', 'A1 health truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- closure (T101, T102, T110)
  section('Repeatability, diff scope and exact head')
  await waitFor(databaseUp, 60_000)
  const priorClaimsNow = await prisma.claim.count({ where: { createdAt: { lt: runStartedAt } } })
  check(
    'T101',
    'Repeatability',
    createdClaimIds.length >= 7 && priorClaimsNow === priorClaimsAtStart,
    `this run used a fresh synthetic runId (${runId}), recorded ${recordedRunIds.length} run(s) and created ${createdClaimIds.length} Claim(s); all ${priorClaimsNow} Claim(s) from earlier runs are retained as history`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.types.ts',
    `${A59_DIR}/pre-claim-readiness.service.ts`,
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/database/row-lock.ts',
    'backend/src/shared/errors/error.types.ts',
    'frontend/src/developer/checkRegistry.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !file.startsWith(`${FRONTEND_DIR}/`) && !file.includes('a6_1_claim_foundation_a5_handoff') && !allowed.includes(file),
  )
  const laterDomain = changedPaths.filter((file) => /claim-line|claim_line|submission|pricing|tariff-rate|transmission|remittance|integration\/a9/.test(file))
  check(
    'T102',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && laterDomain.length === 0,
    outOfScope.length === 0 && laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A6.1 module, migration, harness and check page, the narrow A5.9 composer export, the shared lock list, vocabularies, the replay verifier and wiring; no A6.2+ or A9 domain`
      : `unexpected: ${[...outOfScope, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T110',
    'Exact head evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a61Branch}`) && !/ahead|behind/.test(tracking),
    `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A6.1] run ${runId} — HEAD ${headSha}`)
  console.log(`[A6.1] main Claim ${mainClaim.id} bound to readiness assessment ${main.assessmentId} (${mainClaim.claimContractVersion} / ${mainClaim.handoffSchemaVersion})`)
  if (failures.length > 0) {
    console.log(`[A6.1] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.1] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.1] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.1] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.1] A6.1 CLAIM FOUNDATION / A5 HANDOFF BINDING ACCEPTANCE COMPLETE' : '[A6.1] A6.1 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.1] RUN ABORTED: ${error.message}`)
      console.log('[A6.1] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.1] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.1] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
