import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordReadinessAssessment } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'
import { createClaim } from '../../modules/claim/claim.service.ts'
import { removeClaimLine, setClaimLineDiagnosisPointers } from '../../modules/claim-line/claim-line.service.ts'
import { createClaimDiagnosis } from '../../modules/claim-diagnosis/claim-diagnosis.service.ts'
import { updateTariffScheduleVersionVerification } from '../../modules/commercial-coverage/tariff-schedule.service.ts'
import { createPricingRun } from '../../modules/claim-pricing/claim-pricing.service.ts'
import { createDraftAssessment } from '../../modules/claim-draft/claim-draft.service.ts'

// A6.4 — focused acceptance for Claim Draft Assembly & Claim-Level Integrity (T001–T120).
//
// Every Claim is built through its owners: tariff worlds and rates through REF-01 and the A6.3 rate routes,
// runs through the A5.7 recorder, readiness through the A5.9 route, the Claim, its lines, diagnoses and
// pointers through the A6.1/A6.2 routes, pricing runs through the A6.3 route. ADVERSARIAL writes go in only
// to create a state no owner path can create (a corrupted position, a removed pointer target, a changed
// source quantity or modifier — A4.6 exposes no activity edit —, another tenant's Claim, an incompatible
// readiness basis, two runs at one instant) or to prove that the database refuses them; every adversarial
// write that should be refused runs in a transaction that is rolled back. Every value is synthetic and keyed
// by this run's id.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.4] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.4] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.4] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.4] ${title}`)

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

const runId = `A64-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const a61Branch = 'feature/a6-1-claim-foundation-a5-handoff-binding'
const a62Branch = 'feature/a6-2-claim-line-diagnosis-source-traceability'
const a63Branch = 'feature/a6-3-tariff-rate-claim-pricing'
const a64Branch = 'feature/a6-4-claim-draft-integrity'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const DRAFT_DIR = 'backend/src/modules/claim-draft'
const FE_DRAFT_DIR = 'frontend/src/modules/claim-draft'
const HARNESS_DIR = 'backend/src/integration/a6-claim-draft'
const A64_TABLES = ['claim_draft_assessments', 'claim_draft_findings']
const ADVISORY = 'CLAIM_DRAFT_JURISDICTION_RULES_NOT_EVALUATED'
// The owners A6.4 consumes. A change to any of them would be a change to an accepted contract.
const OWNER_DIRS = [
  'backend/src/modules/claim',
  'backend/src/modules/claim-line',
  'backend/src/modules/claim-diagnosis',
  'backend/src/modules/claim-pricing',
  'backend/src/modules/tariff-rate',
  'backend/src/modules/pre-claim-readiness',
  'backend/src/modules/pre-claim-validation',
  'backend/src/modules/validation-run',
  'backend/src/modules/commercial-coverage',
]
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

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

// An adversarial write that must be refused runs in a transaction that is always rolled back, so an
// unexpected acceptance can never leave a row behind. Deferred guards are made to fire inside it.
const NOT_REFUSED = 'NOT_REFUSED_ROLLED_BACK'
const attemptRolledBack = (work: (tx: any) => Promise<unknown>) =>
  attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await work(tx)
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      throw new Error(NOT_REFUSED)
    }),
  )

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
const settledWithin = async (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => true, () => true), pause(ms).then(() => false)])

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

  console.log(`[A6.4] A6.4 claim draft assembly & claim-level integrity — run ${runId}`)
  console.log(`[A6.4] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  const priorAssessmentsAtStart = await prisma.claimDraftAssessment.count({ where: { createdAt: { lt: runStartedAt } } })
  const priorFindingsAtStart = await prisma.claimDraftFinding.count({ where: { createdAt: { lt: runStartedAt } } })

  // ---------------------------------------------------------------- gates (T001–T009)
  section('Start gate, migration, contracts, permissions and wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a61Merge = mergeOf(a61Branch)
  const a62Merge = mergeOf(a62Branch)
  const a63Merge = mergeOf(a63Branch)
  const laterA6Code = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter((file) => /claim-review|claim-approval|claim-payload|claim-submission|claim-transport/.test(file))
  check(
    'T001',
    'Start gate',
    branch === a64Branch && a61Merge.length === 40 && a62Merge.length === 40 && a63Merge.length === 40 && gitOk('merge-base --is-ancestor origin/main HEAD') && laterA6Code.length === 0,
    `branch ${branch}; A6.1 ${a61Merge.slice(0, 7) || 'NOT FOUND'}, A6.2 ${a62Merge.slice(0, 7) || 'NOT FOUND'}, A6.3 ${a63Merge.slice(0, 7) || 'NOT FOUND'} merged; contains latest main ${git('rev-parse --short origin/main')}; no A6.5+ code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A6.1/A6.2/A6.3 ancestry',
    [a61Merge, a62Merge, a63Merge].every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)),
    'the three accepted merge commits are ancestors of HEAD',
  )

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, '')).sort()
  const schemaDiff = git('diff origin/main...HEAD -- :/backend/prisma/schema.prisma').split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const schemaAddedModels = schemaDiff.filter((l) => /^\+\s*model /.test(l)).map((l) => l.replace(/^\+\s*model\s+(\w+).*$/, '$1')).sort()
  const scopeProblems = [
    [same(createdTables, A64_TABLES), `tables created: ${createdTables.join(', ')}`],
    [!/DROP (INDEX|TABLE|COLUMN)/.test(statements) && !/SET DEFAULT pg_catalog/.test(statements), 'drift'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => A64_TABLES.some((table) => m.includes(`"${table}"`))), 'a table outside A6.4 is altered'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 7 && !/ON DELETE (CASCADE|SET NULL)/.test(statements), 'the seven foreign keys are not all ON DELETE RESTRICT'],
    [(statements.match(/CREATE (CONSTRAINT )?TRIGGER [a-z_]+_trg/g) ?? []).length === 5, 'the five integrity/history triggers are not all created'],
    [!/\b(approv\w*|reviewer\w*|sign_?off\w*|lifecycle|status|payload\w*|xml|x12|npi|submission\w*|patient_share|net_amount|copay|nabidh|malaffi|riayati)\b/i.test(statements), 'an approval, lifecycle, payload, submission, patient-share or HIE column appears'],
    [schemaRemoved.length === 0 && same(schemaAddedModels, ['ClaimDraftAssessment', 'ClaimDraftFinding']), 'the schema diff is not exactly the two models and their back-relations'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T004',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1 ? `expected exactly one migration, found ${migrationPaths.length}` : scopeProblems.length === 0 ? 'one migration; exactly two A6.4 tables, seven RESTRICT foreign keys and five guards; no drift' : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  const replayExpected = [
    /PASS {2}the A6\.4 CHECKs pin A6-DRAFT-1 and exactly REVIEWABLE, INCOMPLETE, STALE and INVALID/,
    /PASS {2}claim_draft_assessments_complete_trg is present/,
    /PASS {2}one finding per ordinal per assessment is unique/,
    /PASS {2}claim_draft_assessments carries exactly its 14 A6\.4 columns/,
    /PASS {2}the A6\.4 tables are exactly claim_draft_assessments and claim_draft_findings/,
    /PASS {2}the A6\.3 tables are exactly tariff_rates, claim_pricing_runs and claim_pricing_line_results/,
    /PASS {2}the claim tables are exactly claims plus the four A6\.2 tables/,
  ]
  check(
    'T006',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the A6.4 constraints, unique keys and guards survive beside the A6.2/A6.3 ones`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^claimDraft\./.test(code)).sort()
  const invented = allCodes.filter((code) => /(approve|approval|submit|transmit|signOff|patientShare|claimPayload|claimSubmission|remittance)/i.test(code))
  check(
    'T007',
    'Permissions',
    same(family, ['claimDraft.assess', 'claimDraft.read']) &&
      (await grantsOf('claimDraft.assess')) === 'ORG_ADMIN' &&
      (await grantsOf('claimDraft.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claim.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      invented.length === 0,
    'claimDraft.assess for Admin, claimDraft.read for Admin and Viewer, the preview under claim.read; no approve, sign-off, submit or patient-share permission',
  )

  // ---------------------------------------------------------------- sign-in and wiring
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
  type Who = (init?: RequestInit) => RequestInit
  const api = async (method: string, path: string, body?: unknown, who: Who = asAdmin) => {
    const res = await httpCall(path, who(body === undefined ? { method } : { method, body: JSON.stringify(body) }))
    return { status: res.status, body: res.body as any }
  }
  const post = (path: string, body: unknown, who: Who = asAdmin) => api('POST', path, body, who)
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  const rawError = (body: unknown) => /\bat \w|prisma|SELECT|INSERT|constraint|trigger/i.test(JSON.stringify(body ?? {}))

  const wiring = [
    await api('GET', `/api/claims/${MISSING}/draft`),
    await api('POST', `/api/claims/${MISSING}/draft-assessments`, { pricingRunId: MISSING }),
    await api('GET', `/api/claims/${MISSING}/draft-assessments`),
    await api('GET', `/api/claim-draft-assessments/${MISSING}`),
  ]
  const forbiddenVerbs = [
    await api('DELETE', `/api/claim-draft-assessments/${MISSING}`),
    await api('PATCH', `/api/claim-draft-assessments/${MISSING}`, {}),
    await api('PUT', `/api/claims/${MISSING}/draft`, {}),
    await api('DELETE', `/api/claims/${MISSING}/draft-assessments`),
    await api('POST', `/api/claim-draft-assessments/${MISSING}/approve`, {}),
  ]
  const unauthenticated = [await api('GET', `/api/claims/${MISSING}/draft`, undefined, anonymous), await api('POST', `/api/claims/${MISSING}/draft-assessments`, { pricingRunId: MISSING }, anonymous)]
  check(
    'T008',
    'Route wiring',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && forbiddenVerbs.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `four routes answer a missing target with a privacy-safe 404; DELETE/PATCH/PUT/approve are absent (${forbiddenVerbs.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
  )

  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const constantOf = (path: string, name: string) => (git(`show HEAD:${path}`).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-line/claim-line.types.ts', 'CLAIM_LINE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-diagnosis/claim-diagnosis.types.ts', 'CLAIM_DIAGNOSIS_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-pricing/claim-pricing.types.ts', 'PRICING_CONTRACT_VERSION'),
    constantOf('backend/src/modules/pre-claim-readiness/pre-claim-readiness.types.ts', 'HANDOFF_SCHEMA_VERSION'),
  ]
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)))
  const oldMigrationChanged = changedPaths.filter((file) => file.includes('prisma/migrations/') && !file.includes('a6_4_claim_draft_integrity'))
  check(
    'T009',
    'Old contracts preserved',
    same(contracts, ['A6-CLAIM-1', 'A6-LINE-1', 'A6-DX-1', 'A6-PRICE-1', 'PreClaimA6HandoffV1']) && ownerChanged.length === 0 && oldMigrationChanged.length === 0,
    ownerChanged.length + oldMigrationChanged.length === 0
      ? 'A6-CLAIM-1, A6-LINE-1, A6-DX-1, A6-PRICE-1 and PreClaimA6HandoffV1 unchanged; no A5/A6.1/A6.2/A6.3 owner module or applied migration changed'
      : `changed: ${[...ownerChanged, ...oldMigrationChanged].join(', ').slice(0, 220)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: 'Synthetic service B' })).body)
  const procA = must('procedure A', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PA'), displayName: 'Synthetic procedure A', codeSystem: 'SYNTHETIC', externalCode: key('XA') })).body)
  const procB = must('procedure B', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PB'), displayName: 'Synthetic procedure B', codeSystem: 'SYNTHETIC', externalCode: key('XB') })).body)
  const procC = must('procedure C', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PC'), displayName: 'Synthetic procedure C', codeSystem: 'SYNTHETIC', externalCode: key('XC') })).body)
  const dx: { id: string }[] = []
  for (const letter of ['A', 'B', 'C', 'D']) dx.push(must(`diagnosis ${letter}`, (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key(`DX${letter}`), displayName: `Synthetic diagnosis ${letter}` })).body))

  // A tariff world: payer, contract (with this facility), schedule and one version, all through REF-01.
  const world = async (label: string) => {
    const payer = must(`${label} payer`, (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} ${label} payer` })).body)
    const contract = must(`${label} contract`, (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key(`C-${label}`), displayName: `${runId} ${label} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    must(`${label} contract facility`, (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
    const schedule = must(`${label} schedule`, (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key(`T-${label}`), displayName: `${runId} ${label} tariff` })).body)
    const version = must(`${label} version`, (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key(`V-${label}`), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
    return { payerId: payer.id as string, contractId: contract.id as string, scheduleId: schedule.id as string, versionId: version.id as string }
  }
  type World = Awaited<ReturnType<typeof world>>
  const verify = async (versionId: string) => (await post(`/api/tariff-schedule-versions/${versionId}/verification`, { verificationStatus: 'VERIFIED' })).status
  const mustRate = async (versionId: string, body: Record<string, unknown>) => must('rate', (await post(`/api/tariff-schedule-versions/${versionId}/rates`, body)).body)
  const procRate = (procedureCodeId: string, unitTariffAmount: string) => ({ selectorKind: 'PROCEDURE_CODE', procedureCodeId, modifierCodes: [], currencyCode: 'AED', unitTariffAmount })
  const svcRate = (serviceId: string, unitTariffAmount: string) => ({ selectorKind: 'SERVICE', serviceId, modifierCodes: [], currencyCode: 'AED', unitTariffAmount })

  const pw = await world('priced')
  await mustRate(pw.versionId, procRate(procA.id, '125.2500'))
  await mustRate(pw.versionId, svcRate(svcB.id, '12.1250'))
  await mustRate(pw.versionId, procRate(procB.id, '0.0000'))
  if ((await verify(pw.versionId)) !== 200) throw new Error('fixture: the priced version could not be verified')
  // An unconfigured currency cannot come through the rate route (it refuses USD), so one USD rate is
  // written directly into an UNVERIFIED version, which is then verified through its REF-01 owner.
  const uw = await world('usd')
  await prisma.$executeRawUnsafe(
    `INSERT INTO tariff_rates (id, tariff_schedule_version_id, selector_kind, service_id, procedure_code_id, unit_code_key, modifier_signature, currency_code, unit_tariff_amount, rate_contract_version, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, 'PROCEDURE_CODE', NULL, $2::uuid, NULL, ARRAY[]::text[], 'USD', 10.0000, 'A6-RATE-1', $3::uuid)`,
    uw.versionId,
    procA.id,
    actorUserId,
  )
  if ((await verify(uw.versionId)) !== 200) throw new Error('fixture: the USD version could not be verified')

  const plainContext = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: null as string | null, tpaId: null, networkId: null, insuranceProductId: null,
      providerContractId: null as string | null, tariffScheduleId: null as string | null, tariffScheduleVersionId: null as string | null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  const recordRun = async (encounterId: string, activityIds: string[], diagnosisIds: string[], lineage: World | null) => {
    const contextSnapshot = await plainContext(encounterId)
    if (lineage) {
      contextSnapshot.payerId = lineage.payerId
      contextSnapshot.providerContractId = lineage.contractId
      contextSnapshot.tariffScheduleId = lineage.scheduleId
      contextSnapshot.tariffScheduleVersionId = lineage.versionId
    }
    const findings = [
      finding('WARNING', { layer: 'CODING' }),
      ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId })),
      ...diagnosisIds.map((encounterDiagnosisId) => finding('PASS', { layer: 'CODING', encounterDiagnosisId })),
    ]
    const result = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId, contextSnapshot, validatorVersion: 'A5-VAL-1', findings }, actorUserId, tx))
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    return result.value.id
  }
  // Two runs at one exact instant cannot come from any owner path: the second is copied from the first.
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
      await tx.$executeRawUnsafe(`INSERT INTO validation_findings (id, validation_run_id, sequence, layer, outcome, finding_code, message) VALUES (gen_random_uuid(), $1::uuid, 1, 'TECHNICAL', 'PASS', 'SYNTHETIC_COPY', 'Synthetic copy.')`, newRunId)
    })
  }
  const readinessFor = async (validationRunId: string) => {
    const res = await post(`/api/validation-runs/${validationRunId}/readiness-assessments`, {})
    if (res.status !== 201 || res.body?.state !== 'READY_FOR_REVIEW') throw new Error(`a valid READY assessment was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body.id as string
  }
  const setPointers = async (lineId: string, claimDiagnosisIds: string[]) => {
    const res = await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds })
    if (res.status !== 200) throw new Error(`fixture pointers refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
  }
  const addLine = async (claimId: string, encounterActivityId: string) => must('line', (await post(`/api/claims/${claimId}/lines`, { encounterActivityId })).body).id as string
  const addDiagnosis = async (claimId: string, encounterDiagnosisId: string, roleCode: string) => must('claim diagnosis', (await post(`/api/claims/${claimId}/diagnoses`, { encounterDiagnosisId, roleCode })).body).id as string

  type ActivitySpec = { serviceId?: string; procedureCodeId?: string; quantity: string; unitCode?: string; modifierCodes?: string[] }
  type DraftSpec = { activities: ActivitySpec[]; roles?: string[]; lineCount?: number; pointers?: 'primary' | 'none'; spareDiagnoses?: number; lineage?: World | null }
  // An Encounter with the given activities and diagnoses, all named by one READY run with the given
  // commercial lineage, its Claim, one line per activity (or the first lineCount), one ClaimDiagnosis per
  // role, and every line pointing to the PRIMARY (or first) diagnosis.
  const draftClaim = async (label: string, spec: DraftSpec) => {
    const encounter = must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body)
    const activityIds: string[] = []
    for (const activity of spec.activities) activityIds.push(must(`${label} activity`, (await post(`/api/encounters/${encounter.id}/activities`, activity)).body).id)
    const roles = spec.roles ?? ['PRIMARY']
    const encounterDiagnosisIds: string[] = []
    for (let i = 0; i < roles.length + (spec.spareDiagnoses ?? 0); i += 1)
      encounterDiagnosisIds.push(must(`${label} encounter diagnosis`, (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: dx[i].id })).body).id)
    const validationRunId = await recordRun(encounter.id, activityIds, encounterDiagnosisIds, spec.lineage === undefined ? pw : spec.lineage)
    const readinessAssessmentId = await readinessFor(validationRunId)
    const claim = (await post(`/api/pre-claim-readiness-assessments/${readinessAssessmentId}/claims`, {})).body
    if (!claim?.id) throw new Error(`fixture ${label} claim refused: ${JSON.stringify(claim).slice(0, 200)}`)
    const lineIds: string[] = []
    for (const activityId of activityIds.slice(0, spec.lineCount ?? activityIds.length)) lineIds.push(await addLine(claim.id, activityId))
    const claimDiagnosisIds: string[] = []
    for (let i = 0; i < roles.length; i += 1) claimDiagnosisIds.push(await addDiagnosis(claim.id, encounterDiagnosisIds[i], roles[i]))
    const target = claimDiagnosisIds[roles.indexOf('PRIMARY')] ?? claimDiagnosisIds[0]
    if ((spec.pointers ?? 'primary') === 'primary' && target) for (const lineId of lineIds) await setPointers(lineId, [target])
    return { encounterId: encounter.id as string, claimId: claim.id as string, activityIds, encounterDiagnosisIds, claimDiagnosisIds, lineIds, validationRunId, readinessAssessmentId }
  }
  const price = async (claimId: string) => {
    const res = await post(`/api/claims/${claimId}/pricing-runs`, {})
    if (res.status !== 201) throw new Error(`fixture pricing refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as any
  }
  const preview = (claimId: string, pricingRunId?: string | null, who: Who = asAdmin) => api('GET', `/api/claims/${claimId}/draft${pricingRunId ? `?pricingRunId=${pricingRunId}` : ''}`, undefined, who)
  const assessHttp = (claimId: string, body: unknown, who: Who = asAdmin) => api('POST', `/api/claims/${claimId}/draft-assessments`, body, who)
  const codesOf = (body: any): string[] => (body?.findings ?? []).map((f: any) => f.findingCode)
  const blockersOf = (body: any): string[] => (body?.findings ?? []).filter((f: any) => f.severity === 'BLOCKER').map((f: any) => f.findingCode)
  const relatedOf = (body: any, code: string): string[] => (body?.findings ?? []).filter((f: any) => f.findingCode === code).map((f: any) => f.relatedClaimLineId ?? f.relatedClaimDiagnosisId)
  const onlyAdvisory = (body: any) => same(codesOf(body), [ADVISORY]) && body?.findings?.[0]?.severity === 'ADVISORY'
  const stripTime = (body: any) => JSON.stringify({ ...body, evaluatedAt: '' })
  const assessmentsOf = (claimId: string) => prisma.claimDraftAssessment.count({ where: { claimId } })
  const draftAudits = () => prisma.auditEvent.count({ where: { actionCode: 'claim_draft.assessed' } })
  const runRows = async (pricingRunId: string) => JSON.stringify(await prisma.claimPricingRun.findUnique({ where: { id: pricingRunId }, include: { lineResults: { orderBy: { id: 'asc' } } } }))

  // Another tenant: a verified tariff world and a priced, assessed Claim of the other organization. No owner
  // route acts for another tenant, so its masters are written directly and its Claim chain is built through
  // the owner services in-process (synthetic, keyed by this run).
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  let foreign: { claimId: string; pricingRunId: string; assessmentId: string } | null = null
  if (foreignEncounter) {
    const foreignPayer = await prisma.payer.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign payer` } })
    const foreignContract = await prisma.providerContract.create({ data: { organizationId: otherOrg, payerId: foreignPayer.id, contractKey: key('FC'), displayName: 'Synthetic foreign contract', effectiveFrom: new Date('2000-01-01') } })
    const foreignSchedule = await prisma.tariffSchedule.create({ data: { providerContractId: foreignContract.id, tariffKey: key('FT'), displayName: 'Synthetic foreign tariff' } })
    const foreignVersion = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: foreignSchedule.id, version: key('FV'), effectiveFrom: new Date('2000-01-01') } })
    const verified = await updateTariffScheduleVersionVerification(foreignVersion.id, 'VERIFIED', actorUserId)
    const contextSnapshot = await plainContext(foreignEncounter.id)
    Object.assign(contextSnapshot, { payerId: foreignPayer.id, providerContractId: foreignContract.id, tariffScheduleId: foreignSchedule.id, tariffScheduleVersionId: foreignVersion.id })
    const recorded = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId: foreignEncounter.id, contextSnapshot, validatorVersion: 'A5-VAL-1', findings: [finding('PASS', { findingCode: 'SYNTHETIC_FOREIGN' })] }, actorUserId, tx))
    const assessment = verified.ok && recorded.ok ? await recordReadinessAssessment(recorded.value.id, {}, actorUserId) : null
    const claim = assessment?.ok ? await createClaim(assessment.value.id, {}, actorUserId) : null
    const priced = claim?.ok ? await createPricingRun(claim.value.id, {}, actorUserId) : null
    const assessed = claim?.ok && priced?.ok ? await createDraftAssessment(claim.value.id, { pricingRunId: priced.value.id }, actorUserId) : null
    if (claim?.ok && priced?.ok && assessed?.ok) foreign = { claimId: claim.value.id, pricingRunId: priced.value.id, assessmentId: assessed.value.id }
  }
  if (!foreign) throw new Error('fixture: another tenant\'s priced and assessed Claim could not be built (no encounter of the other organization, or an owner refused)')

  // The REVIEWABLE worked example: 1.5 x AED 125.2500 + 1 x AED 12.1250 = AED 200.01, one PRIMARY diagnosis,
  // both lines pointing to it, and the exact PRICED run of that structure.
  const R = await draftClaim('reviewable', { activities: [{ procedureCodeId: procA.id, quantity: '1.5' }, { serviceId: svcB.id, quantity: '1' }] })
  const runR = await price(R.claimId)
  console.log('[A6.4]      fixtures ready: patient, AE-DU/DHA facility profile, clinician, masters, AED and USD tariff worlds, the worked-example Claim, and another tenant\'s priced and assessed Claim')

  // ---------------------------------------------------------------- tenancy and binding (T011–T020)
  section('Claim ownership, tenancy, handoff composer and exact binding')
  const pR = await preview(R.claimId, runR.id)
  const boundRun = await prisma.validationRun.findUniqueOrThrow({ where: { id: R.validationRunId } })
  check(
    'T011',
    'Admin preview',
    pR.status === 200 &&
      pR.body?.draftContractVersion === 'A6-DRAFT-1' &&
      pR.body?.outcome === 'REVIEWABLE' &&
      onlyAdvisory(pR.body) &&
      same(pR.body?.lineage, {
        claimId: R.claimId,
        claimContractVersion: 'A6-CLAIM-1',
        handoffSchemaVersion: 'PreClaimA6HandoffV1',
        readinessAssessmentId: R.readinessAssessmentId,
        validationRunId: R.validationRunId,
        serviceDate: SERVICE_DATE,
        facilityRegulatoryProfileId: boundRun.facilityRegulatoryProfileId,
        providerContractId: pw.contractId,
        tariffScheduleId: pw.scheduleId,
        tariffScheduleVersionId: pw.versionId,
      }) &&
      pR.body?.pricing?.pricingRunId === runR.id &&
      pR.body?.pricing?.totalExtendedTariffAmount === '200.01' &&
      pR.body?.handoffRefusal === null,
    `200 A6-DRAFT-1 REVIEWABLE against exactly the bound assessment, run, commercial lineage and profile; run ${runR.id} AED ${pR.body?.pricing?.totalExtendedTariffAmount}`,
  )
  const pRviewer = await preview(R.claimId, runR.id, asViewer)
  check('T012', 'Viewer preview', pRviewer.status === 200 && stripTime(pRviewer.body) === stripTime(pR.body), 'claim.read is enough; the Viewer sees exactly the Admin draft (only the evaluation instant differs)')
  const missingClaim = await preview(MISSING)
  const foreignAttempts = [await preview(foreign.claimId, foreign.pricingRunId), await assessHttp(foreign.claimId, { pricingRunId: foreign.pricingRunId }), await api('GET', `/api/claims/${foreign.claimId}/draft-assessments`)]
  check(
    'T013',
    'Foreign Claim',
    foreignAttempts.every((res) => res.status === 404 && errorCode(res.body) === errorCode(missingClaim.body) && res.body?.error?.message === missingClaim.body?.error?.message) &&
      (await assessmentsOf(foreign.claimId)) === 1,
    'preview, assessment and history of another tenant\'s Claim are answered exactly like a missing Claim (404); nothing is written',
  )
  const malformed = [
    await api('GET', '/api/claims/not-a-uuid/draft'),
    await api('GET', `/api/claims/${R.claimId}/draft?latest=true`),
    await api('GET', `/api/claims/${R.claimId}/draft?pricingRunId=${runR.id}&pricingRunId=${runR.id}`),
    await api('GET', `/api/claims/${R.claimId}/draft?pricingRunId=not-a-uuid`),
    await api('GET', '/api/claim-draft-assessments/not-a-uuid'),
  ]
  check(
    'T014',
    'Malformed and missing ids',
    missingClaim.status === 404 && malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)),
    `missing Claim 404; malformed id, unknown query, repeated or malformed pricingRunId ${malformed.map((r) => r.status).join('/')}; no raw database text`,
  )

  const other = await draftClaim('other claim', { activities: [{ procedureCodeId: procA.id, quantity: '1' }] })
  const runOther = await price(other.claimId)
  const crossRun = [await preview(R.claimId, runOther.id), await assessHttp(R.claimId, { pricingRunId: runOther.id }), await preview(R.claimId, foreign.pricingRunId), await assessHttp(R.claimId, { pricingRunId: foreign.pricingRunId })]
  check(
    'T015',
    'Another Claim\'s pricing run',
    crossRun.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && (await assessmentsOf(R.claimId)) === 0,
    'a pricing run of another Claim (same or other tenant) is answered like a missing run (404); it is never substituted and nothing is written',
  )

  const S = await draftClaim('superseded', { activities: [{ procedureCodeId: procA.id, quantity: '1' }] })
  const runS = await price(S.claimId)
  await recordRun(S.encounterId, S.activityIds, S.encounterDiagnosisIds, pw)
  const pS = await preview(S.claimId, runS.id)
  const aS = await assessHttp(S.claimId, { pricingRunId: runS.id })
  check(
    'T016',
    'Superseded handoff',
    pS.status === 200 && pS.body?.outcome === 'INVALID' && pS.body?.handoffRefusal === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' && codesOf(pS.body).includes('CLAIM_DRAFT_HANDOFF_INVALID') &&
      aS.status === 201 && aS.body?.outcome === 'INVALID',
    'after a newer validation run the A5.9 composer refuses on the same snapshot: INVALID with CLAIM_DRAFT_HANDOFF_INVALID, recorded as an INVALID assessment, never reviewable',
  )
  const Ti = await draftClaim('tie', { activities: [{ procedureCodeId: procA.id, quantity: '1' }] })
  const runTi = await price(Ti.claimId)
  await copyRunAtSameInstant(Ti.validationRunId)
  const pTi = await preview(Ti.claimId, runTi.id)
  check('T017', 'Recency tie', pTi.body?.outcome === 'INVALID' && pTi.body?.handoffRefusal === 'VALIDATION_RUN_RECENCY_AMBIGUOUS', 'a second run at the same instant: INVALID with VALIDATION_RUN_RECENCY_AMBIGUOUS; no identifier wins')
  // An incompatible basis cannot come from the A6.1 owner route (it refuses), so the assessment and the
  // Claim bound to it are inserted directly.
  const incompatibleEncounter = must('incompatible', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body)
  const incompatibleActivity = must('activity', (await post(`/api/encounters/${incompatibleEncounter.id}/activities`, { procedureCodeId: procA.id, quantity: '1' })).body)
  const incompatibleRun = await recordRun(incompatibleEncounter.id, [incompatibleActivity.id], [], pw)
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
  const pIn = await preview(incompatibleClaim)
  check(
    'T018',
    'Incompatible handoff',
    pIn.status === 200 && pIn.body?.outcome === 'INVALID' && pIn.body?.handoffRefusal === 'READINESS_POLICY_INCOMPATIBLE' && ['CLAIM_DRAFT_HANDOFF_INVALID', 'CLAIM_DRAFT_NO_LINES', 'CLAIM_DRAFT_PRICING_RUN_MISSING'].every((code) => codesOf(pIn.body).includes(code)),
    'a Claim bound to an A5-READY-2 assessment is INVALID; the other relevant codes are kept beside it',
  )
  const newerVersion = must('newer version', (await post(`/api/tariff-schedules/${pw.scheduleId}/versions`, { version: key('V-newer'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  await mustRate(newerVersion.id, procRate(procA.id, '999.0000'))
  const newerVerified = await verify(newerVersion.id)
  const pRafterNewer = await preview(R.claimId, runR.id)
  check(
    'T019',
    'Exact commercial binding',
    newerVerified === 200 && pRafterNewer.body?.lineage?.tariffScheduleVersionId === pw.versionId && pRafterNewer.body?.lineage?.tariffScheduleVersionId === boundRun.tariffScheduleVersionId && pRafterNewer.body?.outcome === 'REVIEWABLE',
    'a newer VERIFIED version of the same schedule exists; the draft keeps the bound ValidationRun lineage and never re-resolves commercial context',
  )
  const insertAssessmentSql = `INSERT INTO claim_draft_assessments (id, claim_id, pricing_run_id, draft_contract_version, handoff_assessment_id, outcome, assembly_fingerprint, pricing_input_fingerprint, active_line_count, active_diagnosis_count, finding_count, evaluated_at, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, 0, 0, $8::int, now(), $9::uuid) RETURNING id::text AS id`
  type DirectAssessment = { claimId: string; runId: string; handoffId: string; pricingFingerprint: string; contract?: string; outcome?: string; fingerprint?: string; findingCount?: number }
  const insertAssessment = async (tx: any, a: DirectAssessment) =>
    (await tx.$queryRawUnsafe(insertAssessmentSql, a.claimId, a.runId, a.contract ?? 'A6-DRAFT-1', a.handoffId, a.outcome ?? 'INCOMPLETE', a.fingerprint ?? 'a'.repeat(64), a.pricingFingerprint, a.findingCount ?? 1, actorUserId))[0].id as string
  const insertFindingSql = `INSERT INTO claim_draft_findings (id, draft_assessment_id, ordinal, finding_code, severity, owner_scope, related_claim_line_id, related_claim_diagnosis_id) VALUES (gen_random_uuid(), $1::uuid, $2::int, $3, $4, $5, $6::uuid, $7::uuid)`
  const insertFinding = (tx: any, assessmentId: string, ordinal: number, code = 'CLAIM_DRAFT_NO_LINES', severity = 'BLOCKER', scope = 'LINE', lineId: string | null = null, diagnosisId: string | null = null) =>
    tx.$executeRawUnsafe(insertFindingSql, assessmentId, ordinal, code, severity, scope, lineId, diagnosisId)
  const validR: DirectAssessment = { claimId: R.claimId, runId: runR.id, handoffId: R.readinessAssessmentId, pricingFingerprint: runR.inputStructureFingerprint }
  const wrongHandoff = await attemptRolledBack((tx) => insertAssessment(tx, { ...validR, handoffId: other.readinessAssessmentId }))
  const rightHandoff = await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, validR), 1))
  check(
    'T020',
    'Exact readiness binding',
    /claim_draft_assessment_coherence/.test(wrongHandoff) && rightHandoff.includes(NOT_REFUSED),
    'the database refuses an assessment under any readiness assessment other than the one the Claim is bound to; the exact binding is accepted (rolled back)',
  )

  // ---------------------------------------------------------------- lines (T021–T030)
  section('Line source identity, active order, membership and removed sources')
  const M = await draftClaim('modifiers', { activities: [{ procedureCodeId: procB.id, quantity: '2', unitCode: 'SYN-U', modifierCodes: ['M2', 'M1'] }] })
  const pM = await preview(M.claimId)
  const activityRows = await prisma.encounterActivity.findMany({ where: { id: { in: [...R.activityIds, ...M.activityIds] } }, include: { modifiers: { orderBy: { sequence: 'asc' } } } })
  const factsOf = (id: string) => {
    const row = activityRows.find((activity) => activity.id === id)
    return row ? { serviceId: row.serviceId, procedureCodeId: row.procedureCodeId, quantity: row.quantity.toFixed(), unitCode: row.unitCode, modifierCodes: row.modifiers.map((m) => m.code) } : null
  }
  const draftFacts = (line: any) => ({ serviceId: line.serviceId, procedureCodeId: line.procedureCodeId, quantity: line.quantity, unitCode: line.unitCode, modifierCodes: line.modifierCodes })
  check(
    'T021',
    'Exact source facts',
    same(pR.body?.lines?.map((l: any) => l.encounterActivityId), R.activityIds) &&
      pR.body.lines.every((l: any, i: number) => l.sequence === i + 1 && same(draftFacts(l), factsOf(R.activityIds[i]))) &&
      same(draftFacts(pM.body?.lines?.[0]), factsOf(M.activityIds[0])),
    'lines in Claim position order carry exactly the A4.6 service, procedure, quantity, unit and modifiers of their source, read at assembly time',
  )
  const NL = await draftClaim('no lines', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], lineCount: 0 })
  const runNL = await price(NL.claimId)
  const pNL = await preview(NL.claimId, runNL.id)
  check(
    'T022',
    'No lines',
    runNL.overallResult === 'INCOMPLETE' && pNL.body?.outcome === 'INCOMPLETE' && same(blockersOf(pNL.body), ['CLAIM_DRAFT_NO_LINES', 'CLAIM_DRAFT_PRICING_INCOMPLETE']),
    'a Claim with no active line is INCOMPLETE with CLAIM_DRAFT_NO_LINES (and its zero-line run is INCOMPLETE); no default line is invented',
  )
  const O = await draftClaim('order', { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }, { procedureCodeId: procB.id, quantity: '1' }] })
  const removedO = await post(`/api/claim-lines/${O.lineIds[1]}/remove`, {})
  const pO = await preview(O.claimId)
  check(
    'T023',
    'Active order 1..N',
    removedO.status === 200 && same(pO.body?.lines?.map((l: any) => [l.claimLineId, l.sequence]), [[O.lineIds[0], 1], [O.lineIds[2], 2]]),
    'after an A6.2 removal the draft shows only the active lines, renumbered 1..N in their existing order',
  )
  const removedRow = await prisma.claimLine.findUnique({ where: { id: O.lineIds[1] } })
  await prisma.$executeRawUnsafe('UPDATE claim_lines SET sequence = 5 WHERE id = $1::uuid', O.lineIds[2])
  const pOcorrupt = await preview(O.claimId)
  const stillCorrupt = (await prisma.claimLine.findUnique({ where: { id: O.lineIds[2] } }))?.sequence === 5
  check(
    'T024',
    'Corrupted order',
    pOcorrupt.body?.outcome === 'INVALID' && same(relatedOf(pOcorrupt.body, 'CLAIM_DRAFT_ORDER_CORRUPT'), [O.lineIds[2]]) && stillCorrupt,
    'a stored position gap (written directly) is INVALID with CLAIM_DRAFT_ORDER_CORRUPT naming the line; the row is never repaired',
  )
  const handoffActivities = new Set((await prisma.validationFinding.findMany({ where: { validationRunId: R.validationRunId, encounterActivityId: { not: null } }, select: { encounterActivityId: true } })).map((row) => row.encounterActivityId))
  const outsideSource = await attemptRolledBack(async (tx) => {
    const foreignActivity = (await tx.encounterActivity.create({ data: { encounterId: R.encounterId, procedureCodeId: procA.id, quantity: '1' } })).id
    await tx.$executeRawUnsafe(`INSERT INTO claim_line_source_activities (id, claim_line_id, encounter_activity_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`, R.lineIds[0], foreignActivity)
  })
  check(
    'T025',
    'Source membership',
    pR.body.lines.every((l: any) => handoffActivities.has(l.encounterActivityId)) && /claim_source_not_in_handoff|claim_lines_source_required/.test(outsideSource),
    'every line source is in the bound handoff reference set; an activity outside it cannot be attached (rolled back)',
  )
  const RS = await draftClaim('removed source', { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }] })
  const runRS = await price(RS.claimId)
  const runRSBefore = await runRows(runRS.id)
  const removedSource = await post(`/api/encounter-activities/${RS.activityIds[1]}/remove`, {})
  const pRS = await preview(RS.claimId, runRS.id)
  check(
    'T026',
    'Removed source',
    removedSource.status === 200 && pRS.body?.outcome === 'STALE' && same(relatedOf(pRS.body, 'CLAIM_DRAFT_SOURCE_STALE'), [RS.lineIds[1]]) && pRS.body?.lines?.[1]?.sourceRemoved === true && (await runRows(runRS.id)) === runRSBefore,
    'a source activity removed after pricing (A4.6 owner route) makes the draft STALE with CLAIM_DRAFT_SOURCE_STALE naming the line; the pricing run is untouched',
  )
  check(
    'T027',
    'Removed line history',
    removedRow?.removedAt !== null && !pO.body.lines.some((l: any) => l.claimLineId === O.lineIds[1]) && !codesOf(pO.body).some((code) => code === 'CLAIM_DRAFT_LINE_DIAGNOSIS_MISSING' && relatedOf(pO.body, code).includes(O.lineIds[1])),
    'a removed line stays as A6.2 history but is never part of the draft, its fingerprint or its findings',
  )
  const RA = await draftClaim('re-add', { activities: [{ procedureCodeId: procA.id, quantity: '1' }] })
  const fpRA0 = (await preview(RA.claimId)).body?.assemblyFingerprint
  await post(`/api/claim-lines/${RA.lineIds[0]}/remove`, {})
  const reAdded = await addLine(RA.claimId, RA.activityIds[0])
  await setPointers(reAdded, [RA.claimDiagnosisIds[0]])
  const pRA = await preview(RA.claimId)
  check(
    'T028',
    'Line identity in the fingerprint',
    reAdded !== RA.lineIds[0] && pRA.body?.lines?.[0]?.encounterActivityId === RA.activityIds[0] && pRA.body?.assemblyFingerprint !== fpRA0,
    'removing a line and re-adding the same activity creates a new line identity, so the assembly fingerprint changes',
  )
  const draftColumns = (await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('claim_draft_assessments', 'claim_draft_findings')`).map((row) => row.column_name)
  const copiedColumns = draftColumns.filter((name) => /service|procedure|quantity|unit|modifier|code_id|diagnosis_code|amount|currency|price|patient|member|payer/i.test(name))
  check('T029', 'No copied facts', draftColumns.length === 23 && copiedColumns.length === 0, 'no source service, procedure, quantity, unit, modifier, diagnosis code, money, patient, member or payer column in the A6.4 tables')
  check(
    'T030',
    'Typed DTO values',
    pR.body.lines.every((l: any) => typeof l.quantity === 'string' && /^\d+(\.\d+)?$/.test(l.quantity)) && same(pM.body?.lines?.[0]?.modifierCodes, ['M2', 'M1']) && typeof pR.body?.pricing?.totalExtendedTariffAmount === 'string',
    'quantities and money are exact decimal strings, never JSON numbers; modifiers keep their stored order',
  )

  // ---------------------------------------------------------------- diagnoses and pointers (T031–T040)
  section('Explicit diagnosis roles, PRIMARY count and pointer integrity')
  const DX2 = await draftClaim('roles as stored', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], roles: ['SECONDARY', 'PRIMARY'] })
  const runDX2 = await price(DX2.claimId)
  const pDX2 = await preview(DX2.claimId, runDX2.id)
  check(
    'T031',
    'Explicit roles',
    same(pDX2.body?.diagnoses?.map((d: any) => [d.roleCode, d.sequence]), [['SECONDARY', 1], ['PRIMARY', 2]]) && pDX2.body?.outcome === 'REVIEWABLE',
    'roles are shown exactly as captured; a PRIMARY at position 2 is not reordered or inferred from Encounter order',
  )
  const P0 = await draftClaim('no primary', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], roles: ['SECONDARY'] })
  const runP0 = await price(P0.claimId)
  const pP0 = await preview(P0.claimId, runP0.id)
  check('T032', 'PRIMARY missing', pP0.body?.outcome === 'INCOMPLETE' && same(blockersOf(pP0.body), ['CLAIM_DRAFT_PRIMARY_ROLE_MISSING']), 'zero active PRIMARY: INCOMPLETE with CLAIM_DRAFT_PRIMARY_ROLE_MISSING')
  const P2 = await draftClaim('two primaries', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], roles: ['PRIMARY', 'PRIMARY'] })
  const runP2 = await price(P2.claimId)
  const pP2 = await preview(P2.claimId, runP2.id)
  check(
    'T033',
    'PRIMARY multiple',
    pP2.body?.outcome === 'INVALID' && same(relatedOf(pP2.body, 'CLAIM_DRAFT_PRIMARY_ROLE_MULTIPLE'), P2.claimDiagnosisIds),
    'two active PRIMARY: INVALID with CLAIM_DRAFT_PRIMARY_ROLE_MULTIPLE naming both; no winner is chosen',
  )
  const D0 = await draftClaim('no diagnoses', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], roles: [] })
  const runD0 = await price(D0.claimId)
  const pD0 = await preview(D0.claimId, runD0.id)
  check('T034', 'No diagnoses', pD0.body?.outcome === 'INCOMPLETE' && same(blockersOf(pD0.body), ['CLAIM_DRAFT_NO_DIAGNOSES', 'CLAIM_DRAFT_LINE_DIAGNOSIS_MISSING']), 'no active ClaimDiagnosis: INCOMPLETE with both relevant codes')
  const NP = await draftClaim('no pointer', { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }], pointers: 'none' })
  await setPointers(NP.lineIds[0], [NP.claimDiagnosisIds[0]])
  const runNP = await price(NP.claimId)
  const pNP = await preview(NP.claimId, runNP.id)
  check(
    'T035',
    'Line without pointer',
    pNP.body?.outcome === 'INCOMPLETE' && same(relatedOf(pNP.body, 'CLAIM_DRAFT_LINE_DIAGNOSIS_MISSING'), [NP.lineIds[1]]),
    'every active line must point to an active diagnosis: the unpointed line is named, INCOMPLETE',
  )
  const PC = await draftClaim('pointer corruption', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], roles: ['PRIMARY', 'SECONDARY'], pointers: 'none' })
  await setPointers(PC.lineIds[0], [PC.claimDiagnosisIds[1], PC.claimDiagnosisIds[0]])
  const runPC = await price(PC.claimId)
  const pPCbefore = await preview(PC.claimId, runPC.id)
  await prisma.$executeRawUnsafe('UPDATE claim_diagnoses SET removed_at = now() WHERE id = $1::uuid', PC.claimDiagnosisIds[1])
  const pPC = await preview(PC.claimId, runPC.id)
  const corruptPointer = (pPC.body?.findings ?? []).find((f: any) => f.findingCode === 'CLAIM_DRAFT_POINTER_CORRUPT')
  check(
    'T036',
    'Removed pointer target',
    pPC.body?.outcome === 'INVALID' && corruptPointer?.relatedClaimLineId === PC.lineIds[0] && corruptPointer?.relatedClaimDiagnosisId === PC.claimDiagnosisIds[1],
    'an active pointer to a diagnosis removed directly (bypassing A6.2) is INVALID with CLAIM_DRAFT_POINTER_CORRUPT naming the line and target',
  )
  const insertPointerSql = `INSERT INTO claim_line_diagnosis_pointers (id, claim_line_id, claim_diagnosis_id, created_by_user_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, now())`
  const crossPointer = await attemptRolledBack((tx) => tx.$executeRawUnsafe(insertPointerSql, R.lineIds[0], P0.claimDiagnosisIds[0], actorUserId))
  check('T037', 'Cross-Claim pointer', /claim_diagnosis_pointer_mismatch/.test(crossPointer), 'the database refuses a pointer from a line to another Claim\'s diagnosis (rolled back)')
  const duplicatePointer = await attemptRolledBack((tx) => tx.$executeRawUnsafe(insertPointerSql, R.lineIds[0], R.claimDiagnosisIds[0], actorUserId))
  check('T038', 'Duplicate active pointer', /claim_line_diagnosis_pointers_active_uidx|unique|23505/i.test(duplicatePointer), 'the database refuses a second active pointer for the same line and diagnosis (rolled back)')
  check(
    'T039',
    'Pointer order derived',
    same(pPCbefore.body?.lines?.[0]?.claimDiagnosisIds, [PC.claimDiagnosisIds[0], PC.claimDiagnosisIds[1]]) && pPCbefore.body?.outcome === 'REVIEWABLE',
    'pointers requested as [SECONDARY, PRIMARY] are presented in ClaimDiagnosis position order [PRIMARY, SECONDARY]; there is no pointer-order field',
  )
  const AD = await draftClaim('admitting', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], roles: ['PRIMARY', 'ADMITTING'] })
  const runAD = await price(AD.claimId)
  const pAD = await preview(AD.claimId, runAD.id)
  check(
    'T040',
    'ADMITTING unsupported',
    pAD.body?.outcome === 'INCOMPLETE' && same(relatedOf(pAD.body, 'CLAIM_DRAFT_UNSUPPORTED_RULE'), [AD.claimDiagnosisIds[1]]) && !pR.body.diagnoses.some((d: any) => d.roleCode === 'ADMITTING') && pR.body.outcome === 'REVIEWABLE',
    'an ADMITTING diagnosis needs a governed encounter-type rule A6-DRAFT-1 does not have: INCOMPLETE with CLAIM_DRAFT_UNSUPPORTED_RULE; no ADMITTING is ever required',
  )

  // ---------------------------------------------------------------- pricing run (T041–T050)
  section('Exact pricing run, coherence and missing or incomplete pricing')
  const auditsBefore41 = await draftAudits()
  const runRBefore = await runRows(runR.id)
  const claimRowBefore = JSON.stringify(await prisma.claim.findUnique({ where: { id: R.claimId } }))
  const aR = await assessHttp(R.claimId, { pricingRunId: runR.id })
  const auditsAfter41 = await draftAudits()
  check(
    'T041',
    'Admin assessment',
    aR.status === 201 &&
      aR.body?.draftContractVersion === 'A6-DRAFT-1' &&
      aR.body?.outcome === 'REVIEWABLE' &&
      aR.body?.pricingRunId === runR.id &&
      aR.body?.handoffAssessmentId === R.readinessAssessmentId &&
      aR.body?.pricingInputFingerprint === runR.inputStructureFingerprint &&
      aR.body?.assemblyFingerprint === pR.body?.assemblyFingerprint &&
      aR.body?.activeLineCount === 2 &&
      aR.body?.activeDiagnosisCount === 1 &&
      aR.body?.findingCount === 1 &&
      onlyAdvisory(aR.body),
    '201 A6-DRAFT-1 REVIEWABLE bound to the exact run, readiness basis and pricing fingerprint; candidate for review only',
  )
  const badBodies = [
    await assessHttp(R.claimId, {}),
    await assessHttp(R.claimId, { pricingRunId: 'not-a-uuid' }),
    await assessHttp(R.claimId, { pricingRunId: runR.id, outcome: 'REVIEWABLE' }),
    await assessHttp(R.claimId, { pricingRunId: runR.id, extra: 1 }),
    await assessHttp(R.claimId, [runR.id]),
  ]
  check(
    'T042',
    'Body exactly { pricingRunId }',
    badBodies.every((res) => res.status === 400) && (await assessmentsOf(R.claimId)) === 1,
    `missing, malformed, server-owned (outcome), unknown field and non-object bodies are refused (${badBodies.map((r) => r.status).join('/')}); nothing is written`,
  )
  const pRnoRun = await preview(R.claimId)
  check(
    'T043',
    'No automatic run selection',
    pRnoRun.body?.outcome === 'INCOMPLETE' && same(blockersOf(pRnoRun.body), ['CLAIM_DRAFT_PRICING_RUN_MISSING']) && pRnoRun.body?.pricing === null,
    'without a pricingRunId the preview reports CLAIM_DRAFT_PRICING_RUN_MISSING even though the Claim has a PRICED run; no run is picked',
  )
  const missingRun = [await preview(R.claimId, MISSING), await assessHttp(R.claimId, { pricingRunId: MISSING })]
  check('T044', 'Missing pricing run', missingRun.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND'), 'an unknown pricing run is 404 for preview and assessment')
  const runR2 = await price(R.claimId)
  const pROlder = await preview(R.claimId, runR.id)
  check(
    'T045',
    'Exact run honoured',
    pROlder.body?.pricing?.pricingRunId === runR.id && pROlder.body?.outcome === 'REVIEWABLE' && runR2.id !== runR.id,
    'with a newer equally current run present, the named older run is judged as named; nothing is replaced by "latest"',
  )
  const IM = await draftClaim('rate missing', { activities: [{ procedureCodeId: procC.id, quantity: '1' }] })
  const runIM = await price(IM.claimId)
  const pIM = await preview(IM.claimId, runIM.id)
  check('T046', 'INCOMPLETE pricing run', runIM.overallResult === 'INCOMPLETE' && pIM.body?.outcome === 'INCOMPLETE' && same(blockersOf(pIM.body), ['CLAIM_DRAFT_PRICING_INCOMPLETE']), 'a run with an unpriced line is no valid complete pricing evidence: INCOMPLETE')
  const U = await draftClaim('usd', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], lineage: uw })
  const runU = await price(U.claimId)
  const pU = await preview(U.claimId, runU.id)
  check(
    'T047',
    'Unsupported currency',
    runU.overallResult === 'INCOMPLETE' && runU.lines?.[0]?.outcome === 'UNPRICED_UNSUPPORTED_CURRENCY' && pU.body?.outcome === 'INCOMPLETE' && pU.body?.pricing?.totalExtendedTariffAmount === null && pU.body?.pricing?.currencyCode === null,
    'an unconfigured-currency run carries no total and no currency; the draft is INCOMPLETE, never converted',
  )
  const storedRunR = await prisma.claimPricingRun.findUniqueOrThrow({ where: { id: runR.id } })
  check(
    'T048',
    'Commercial lineage equality',
    storedRunR.providerContractId === boundRun.providerContractId && storedRunR.tariffScheduleId === boundRun.tariffScheduleId && storedRunR.tariffScheduleVersionId === boundRun.tariffScheduleVersionId && !codesOf(pR.body).includes('CLAIM_DRAFT_COMMERCIAL_MISMATCH'),
    'the run\'s contract, schedule and version equal the Claim-bound ValidationRun\'s; no CLAIM_DRAFT_COMMERCIAL_MISMATCH',
  )
  const crossClaimRun = await attemptRolledBack((tx) => insertAssessment(tx, { ...validR, runId: runIM.id, pricingFingerprint: runIM.inputStructureFingerprint }))
  check('T049', 'Cross-Claim run (database)', /claim_draft_assessment_coherence/.test(crossClaimRun), 'the database refuses an assessment of a Claim bound to another Claim\'s pricing run (rolled back)')
  const wrongFingerprint = await attemptRolledBack((tx) => insertAssessment(tx, { ...validR, pricingFingerprint: 'f'.repeat(64) }))
  check('T050', 'Pricing fingerprint (database)', /claim_draft_assessment_coherence/.test(wrongFingerprint), 'the database refuses an assessment whose pricing input fingerprint is not the run\'s own (rolled back)')

  // ---------------------------------------------------------------- exact line set (T051–T060)
  section('Pricing line exact set, staleness, totals and no re-pricing')
  check(
    'T051',
    'Exact line set',
    same(pR.body?.pricing?.lines?.map((l: any) => l.claimLineId), pR.body?.lines?.map((l: any) => l.claimLineId)) && pR.body?.outcome === 'REVIEWABLE',
    'one PRICED result for each active line and none extra: REVIEWABLE',
  )
  const LA = await draftClaim('line added', { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }], lineCount: 1 })
  const runLA1 = await price(LA.claimId)
  const addedLine = await addLine(LA.claimId, LA.activityIds[1])
  await setPointers(addedLine, [LA.claimDiagnosisIds[0]])
  const runsLA = await prisma.claimPricingRun.count({ where: { claimId: LA.claimId } })
  const pLA1 = await preview(LA.claimId, runLA1.id)
  check(
    'T052',
    'Line added after pricing',
    pLA1.body?.outcome === 'STALE' && same(relatedOf(pLA1.body, 'CLAIM_DRAFT_PRICING_STALE'), [addedLine]) && (await prisma.claimPricingRun.count({ where: { claimId: LA.claimId } })) === runsLA,
    'a line added after pricing has no result: STALE with CLAIM_DRAFT_PRICING_STALE naming it; nothing is re-priced',
  )
  const LR = await draftClaim('line removed', { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }] })
  const runLR = await price(LR.claimId)
  await post(`/api/claim-lines/${LR.lineIds[1]}/remove`, {})
  const pLR = await preview(LR.claimId, runLR.id)
  check('T053', 'Line removed after pricing', pLR.body?.outcome === 'STALE' && same(relatedOf(pLR.body, 'CLAIM_DRAFT_PRICING_STALE'), [LR.lineIds[1]]), 'a result for a line no longer active: STALE naming the removed line')
  const RR = await draftClaim('remove and re-add', { activities: [{ procedureCodeId: procA.id, quantity: '1.5' }] })
  const runRR = await price(RR.claimId)
  await post(`/api/claim-lines/${RR.lineIds[0]}/remove`, {})
  const reAddedRR = await addLine(RR.claimId, RR.activityIds[0])
  await setPointers(reAddedRR, [RR.claimDiagnosisIds[0]])
  const pRR = await preview(RR.claimId, runRR.id)
  const runRRnew = await price(RR.claimId)
  check(
    'T054',
    'Remove and re-add, same total',
    pRR.body?.outcome === 'STALE' && same(relatedOf(pRR.body, 'CLAIM_DRAFT_PRICING_STALE').sort(), [RR.lineIds[0], reAddedRR].sort()) && runRRnew.totalExtendedTariffAmount === runRR.totalExtendedTariffAmount,
    `the same activity re-added as a new line: STALE although a fresh run would give the same total (AED ${runRR.totalExtendedTariffAmount})`,
  )
  const runLA2 = await price(LA.claimId)
  const pLA2 = await preview(LA.claimId, runLA2.id)
  const pLA1again = await preview(LA.claimId, runLA1.id)
  const runLA1Before = await runRows(runLA1.id)
  const aLA1 = await assessHttp(LA.claimId, { pricingRunId: runLA1.id })
  check(
    'T055',
    'Older run after an edit',
    pLA2.body?.outcome === 'REVIEWABLE' && pLA1again.body?.outcome === 'STALE' && aLA1.status === 201 && aLA1.body?.outcome === 'STALE' && (await runRows(runLA1.id)) === runLA1Before,
    'the older PRICED run named after a later edit is refused as current (STALE, recorded); the newer run is REVIEWABLE; neither run changes and none is auto-picked',
  )
  const runRread = await api('GET', `/api/claim-pricing-runs/${runR.id}`)
  check(
    'T056',
    'Total and currency lineage',
    pR.body?.pricing?.totalExtendedTariffAmount === runRread.body?.totalExtendedTariffAmount &&
      pR.body?.pricing?.currencyCode === 'AED' &&
      same(pR.body?.pricing?.lines?.map((l: any) => l.extendedTariffAmount), runRread.body?.lines?.map((l: any) => l.extendedTariffAmount)),
    `the draft shows exactly the stored A6.3 amounts (AED ${pR.body?.pricing?.totalExtendedTariffAmount}, lines ${pR.body?.pricing?.lines?.map((l: any) => l.extendedTariffAmount).join(' + ')})`,
  )
  const draftCode = committedProductionCodeOf([DRAFT_DIR])
  const reached = draftCode.files.length >= 6
  const runsBefore57 = await prisma.claimPricingRun.count()
  await preview(R.claimId, runR.id)
  await assessHttp(R.claimId, { pricingRunId: runR.id })
  check(
    'T057',
    'No re-pricing',
    reached && (await prisma.claimPricingRun.count()) === runsBefore57 && !/\b(evaluateLine|evaluateRun|matchingRates|extendedAmount)\s*\(|\b(ROUND_HALF_UP|toDecimalPlaces)\b|\.times\(|\.plus\(|parseFloat|\bNumber\(/.test(draftCode.code),
    'previews and assessments create no pricing run; the A6.4 code never matches rates, multiplies, rounds or sums money',
  )
  const hiddenCharge = /copay|coinsur|deductible|discount|tax|patient_?share|payer_?share|net_?amount|net_?payer|balance|benefit/i
  const draftKeys = [...deepKeys(pR.body), ...deepKeys(aR.body)]
  check('T058', 'No hidden charges', !draftKeys.some((k) => hiddenCharge.test(k)) && !draftColumns.some((c) => hiddenCharge.test(c)) && !hiddenCharge.test(draftCode.code), 'no co-pay, tax, discount, patient/payer share, Net, balance or benefit field or logic')
  const Z = await draftClaim('zero price', { activities: [{ procedureCodeId: procB.id, quantity: '1' }] })
  const runZ = await price(Z.claimId)
  const pZ = await preview(Z.claimId, runZ.id)
  check('T059', 'Explicit zero price', runZ.overallResult === 'PRICED' && pZ.body?.pricing?.totalExtendedTariffAmount === '0.00' && pZ.body?.outcome === 'REVIEWABLE', 'an explicit AED 0.00 run is real pricing evidence: REVIEWABLE')
  check('T060', 'Run untouched', (await runRows(runR.id)) === runRBefore, 'the run and its line results read back byte-identical after previews and assessments')

  // ---------------------------------------------------------------- fingerprint (T061–T070)
  section('Assembly fingerprint: stability, order, decimal, role, modifier and pointer changes')
  const pRagain = await preview(R.claimId, runR.id)
  check('T061', 'Stable fingerprint', pRagain.body?.assemblyFingerprint === pR.body?.assemblyFingerprint && aR.body?.assemblyFingerprint === pR.body?.assemblyFingerprint, 'two fresh reads and the recorded assessment agree at unchanged state')
  check('T062', 'Fingerprint independent of viewer', pRviewer.body?.assemblyFingerprint === pR.body?.assemblyFingerprint, 'Admin and Viewer reads give the same fingerprint')
  const F = await draftClaim('reorder', { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }] })
  const runF = await price(F.claimId)
  const pF0 = await preview(F.claimId, runF.id)
  const aF0 = await assessHttp(F.claimId, { pricingRunId: runF.id })
  const aF0Row = JSON.stringify(await prisma.claimDraftAssessment.findUnique({ where: { id: aF0.body?.id }, include: { findings: true } }))
  await api('PUT', `/api/claims/${F.claimId}/lines/order`, { claimLineIds: [F.lineIds[1], F.lineIds[0]] })
  const pF1 = await preview(F.claimId, runF.id)
  const aF1 = await assessHttp(F.claimId, { pricingRunId: runF.id })
  await api('PUT', `/api/claims/${F.claimId}/lines/order`, { claimLineIds: [F.lineIds[0], F.lineIds[1]] })
  const pF2 = await preview(F.claimId, runF.id)
  check(
    'T063',
    'Line reorder',
    pF1.body?.assemblyFingerprint !== pF0.body?.assemblyFingerprint &&
      pF1.body?.outcome === 'STALE' &&
      same(relatedOf(pF1.body, 'CLAIM_DRAFT_STRUCTURE_STALE').sort(), [...F.lineIds].sort()) &&
      pF2.body?.assemblyFingerprint === pF0.body?.assemblyFingerprint &&
      pF2.body?.outcome === 'REVIEWABLE',
    'a reorder after pricing changes the fingerprint and is STALE (structure); restoring the order restores the identical fingerprint',
  )
  const FD = await draftClaim('diagnosis changes', { activities: [{ procedureCodeId: procA.id, quantity: '1' }], roles: ['PRIMARY', 'SECONDARY'] })
  const runFD = await price(FD.claimId)
  const fpFD0 = (await preview(FD.claimId, runFD.id)).body?.assemblyFingerprint
  await api('PUT', `/api/claims/${FD.claimId}/diagnoses/order`, { claimDiagnosisIds: [FD.claimDiagnosisIds[1], FD.claimDiagnosisIds[0]] })
  const pFD1 = await preview(FD.claimId, runFD.id)
  check('T064', 'Diagnosis reorder', pFD1.body?.assemblyFingerprint !== fpFD0 && pFD1.body?.outcome === 'REVIEWABLE', 'a diagnosis reorder leaves the money unchanged but changes the fingerprint, so an earlier review basis is visibly superseded')
  await setPointers(FD.lineIds[0], [FD.claimDiagnosisIds[0], FD.claimDiagnosisIds[1]])
  const pFD2 = await preview(FD.claimId, runFD.id)
  check('T065', 'Pointer change', pFD2.body?.assemblyFingerprint !== pFD1.body?.assemblyFingerprint, 'changing the pointer set changes the fingerprint')
  await post(`/api/claim-diagnoses/${FD.claimDiagnosisIds[1]}/remove`, {})
  const admittingAgain = await addDiagnosis(FD.claimId, FD.encounterDiagnosisIds[1], 'ADMITTING')
  const pFD3 = await preview(FD.claimId, runFD.id)
  check(
    'T066',
    'Role change',
    pFD3.body?.assemblyFingerprint !== pFD2.body?.assemblyFingerprint && pFD3.body?.diagnoses?.some((d: any) => d.claimDiagnosisId === admittingAgain && d.roleCode === 'ADMITTING') && codesOf(pFD3.body).includes('CLAIM_DRAFT_UNSUPPORTED_RULE'),
    'the same source re-captured with another role changes the fingerprint and its findings',
  )
  // A4.6 exposes no activity edit, so a later modifier or quantity correction is simulated directly.
  const MD = await draftClaim('modifier drift', { activities: [{ procedureCodeId: procA.id, quantity: '1' }] })
  const runMD = await price(MD.claimId)
  const pMD0 = await preview(MD.claimId, runMD.id)
  await prisma.$executeRawUnsafe(`INSERT INTO encounter_activity_modifiers (id, encounter_activity_id, sequence, code) VALUES (gen_random_uuid(), $1::uuid, 1, 'M9')`, MD.activityIds[0])
  const pMD1 = await preview(MD.claimId, runMD.id)
  check(
    'T067',
    'Modifier drift',
    pMD0.body?.outcome === 'REVIEWABLE' && pMD1.body?.assemblyFingerprint !== pMD0.body?.assemblyFingerprint && pMD1.body?.outcome === 'STALE' && same(blockersOf(pMD1.body), ['CLAIM_DRAFT_SOURCE_STALE']),
    'a modifier added to the source after pricing changes the fingerprint and is STALE (source), never priced from the new fact',
  )
  const QD = await draftClaim('quantity drift', { activities: [{ procedureCodeId: procA.id, quantity: '1.5' }] })
  const runQD = await price(QD.claimId)
  const pQD0 = await preview(QD.claimId, runQD.id)
  await prisma.$executeRawUnsafe('UPDATE encounter_activities SET quantity = 1.5000 WHERE id = $1::uuid', QD.activityIds[0])
  const pQD1 = await preview(QD.claimId, runQD.id)
  await prisma.$executeRawUnsafe('UPDATE encounter_activities SET quantity = 2 WHERE id = $1::uuid', QD.activityIds[0])
  const pQD2 = await preview(QD.claimId, runQD.id)
  check(
    'T068',
    'Exact decimal quantity',
    pQD1.body?.assemblyFingerprint === pQD0.body?.assemblyFingerprint && pQD1.body?.outcome === 'REVIEWABLE' && pQD2.body?.assemblyFingerprint !== pQD0.body?.assemblyFingerprint && pQD2.body?.outcome === 'STALE',
    'rewriting 1.5 as 1.5000 is the same exact decimal (same fingerprint, REVIEWABLE); 2 is a change (new fingerprint, STALE)',
  )
  await pause(1100)
  const pRlater = await preview(R.claimId, runR.id)
  check(
    'T069',
    'Fingerprint format and clock',
    /^[0-9a-f]{64}$/.test(pR.body?.assemblyFingerprint ?? '') && pR.body?.assemblyFingerprint !== runR.inputStructureFingerprint && pRlater.body?.assemblyFingerprint === pR.body?.assemblyFingerprint && pRlater.body?.evaluatedAt !== pR.body?.evaluatedAt,
    'SHA-256 hex, distinct from the A6.3 pricing fingerprint, and independent of the clock (a later read keeps it while evaluatedAt moves)',
  )
  const aF0After = JSON.stringify(await prisma.claimDraftAssessment.findUnique({ where: { id: aF0.body?.id }, include: { findings: true } }))
  const listF = await api('GET', `/api/claims/${F.claimId}/draft-assessments`)
  check(
    'T070',
    'Re-assessment is new history',
    aF1.status === 201 && aF1.body?.id !== aF0.body?.id && aF1.body?.outcome === 'STALE' && aF0After === aF0Row && same(listF.body?.items?.map((i: any) => i.id), [aF1.body?.id, aF0.body?.id]),
    'a later assessment is a new row; the earlier one reads back byte-identical; history lists newest first',
  )

  // ---------------------------------------------------------------- precedence (T071–T080)
  section('Outcome precedence, issue retention and no approval semantics')
  const PS = await draftClaim('invalid over stale', { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }], roles: ['PRIMARY', 'SECONDARY'], pointers: 'none' })
  await setPointers(PS.lineIds[0], [PS.claimDiagnosisIds[0], PS.claimDiagnosisIds[1]])
  await setPointers(PS.lineIds[1], [PS.claimDiagnosisIds[0]])
  const runPS = await price(PS.claimId)
  await post(`/api/claim-lines/${PS.lineIds[1]}/remove`, {})
  await prisma.$executeRawUnsafe('UPDATE claim_diagnoses SET removed_at = now() WHERE id = $1::uuid', PS.claimDiagnosisIds[1])
  const pPS = await preview(PS.claimId, runPS.id)
  check('T071', 'INVALID over STALE', pPS.body?.outcome === 'INVALID' && ['CLAIM_DRAFT_POINTER_CORRUPT', 'CLAIM_DRAFT_PRICING_STALE'].every((code) => codesOf(pPS.body).includes(code)), 'a corrupt pointer and a stale run: INVALID, with the STALE code kept')
  const SI = await draftClaim('stale over incomplete', { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }, { procedureCodeId: procB.id, quantity: '1' }], lineCount: 2, pointers: 'none' })
  await setPointers(SI.lineIds[0], [SI.claimDiagnosisIds[0]])
  const runSI = await price(SI.claimId)
  const lineSI3 = await addLine(SI.claimId, SI.activityIds[2])
  await setPointers(lineSI3, [SI.claimDiagnosisIds[0]])
  const pSI = await preview(SI.claimId, runSI.id)
  check('T072', 'STALE over INCOMPLETE', pSI.body?.outcome === 'STALE' && ['CLAIM_DRAFT_LINE_DIAGNOSIS_MISSING', 'CLAIM_DRAFT_PRICING_STALE'].every((code) => codesOf(pSI.body).includes(code)), 'a missing pointer and a line added after pricing: STALE, with the INCOMPLETE code kept')
  check(
    'T073',
    'INCOMPLETE alone',
    pP0.body?.outcome === 'INCOMPLETE' && !codesOf(pP0.body).some((code) => /STALE|CORRUPT|INVALID|MULTIPLE|MISMATCH|INTEGRITY/.test(code)),
    'only INCOMPLETE findings reduce to INCOMPLETE',
  )
  const ordinalsPS = (pPS.body?.findings ?? []).map((f: any) => f.ordinal)
  check(
    'T074',
    'All issues retained in order',
    same(ordinalsPS, ordinalsPS.map((_: number, i: number) => i + 1)) &&
      codesOf(pPS.body).at(-1) === ADVISORY &&
      (pPS.body?.findings ?? []).every((f: any) => (f.findingCode === ADVISORY) === (f.severity === 'ADVISORY')) &&
      codesOf(pPS.body).indexOf('CLAIM_DRAFT_POINTER_CORRUPT') < codesOf(pPS.body).indexOf('CLAIM_DRAFT_PRICING_STALE'),
    `ordinals 1..${ordinalsPS.length} in catalogue order; every reduced-away code is still present; the advisory is last and the only non-blocker`,
  )
  const pPSagain = await preview(PS.claimId, runPS.id)
  check('T075', 'Deterministic order', same(pPSagain.body?.findings, pPS.body?.findings), 'the same state gives the identical finding list on a fresh read')
  check('T076', 'REVIEWABLE has no blocker', aR.body?.findings?.every((f: any) => f.severity === 'ADVISORY') && aR.body?.findingCount === 1, 'a REVIEWABLE assessment holds only the jurisdiction advisory')
  const claimColumns = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims' ORDER BY column_name`).map((row) => row.column_name)
  check(
    'T077',
    'Outcome never on the Claim',
    same(claimColumns, ['claim_contract_version', 'created_at', 'created_by_user_id', 'encounter_id', 'handoff_schema_version', 'id', 'pre_claim_readiness_assessment_id']) && JSON.stringify(await prisma.claim.findUnique({ where: { id: R.claimId } })) === claimRowBefore,
    'the Claim keeps exactly its seven A6.1 columns and reads back unchanged after assessment; no current-draft pointer or status',
  )
  check(
    'T078',
    'STALE vs INCOMPLETE',
    pRS.body?.outcome === 'STALE' && !blockersOf(pRS.body).some((code) => /MISSING|NO_|INCOMPLETE|UNSUPPORTED/.test(code)) && pRnoRun.body?.outcome === 'INCOMPLETE' && !blockersOf(pRnoRun.body).some((code) => /STALE/.test(code)),
    'a removed source is STALE (re-evaluation needed); a missing run is INCOMPLETE (evidence absent)',
  )
  check('T079', 'INVALID vs STALE', pS.body?.outcome === 'INVALID' && !blockersOf(pS.body).some((code) => /STALE/.test(code)), 'a superseded readiness basis is an ineligible handoff (INVALID), never a re-evaluable STALE draft')
  const approvalKeys = [...deepKeys(pR.body), ...deepKeys(aR.body), ...deepKeys(listF.body)].filter((k) => /approv|submi|sign|review(er|ed)|lifecycle|status|state/i.test(k))
  const structureCounts = async () => JSON.stringify(await Promise.all([prisma.claim.count(), prisma.claimLine.count(), prisma.claimDiagnosis.count(), prisma.claimLineDiagnosisPointer.count(), prisma.claimPricingRun.count()]))
  const countsBefore80 = await structureCounts()
  await assessHttp(Z.claimId, { pricingRunId: runZ.id })
  check(
    'T080',
    'No approval semantics',
    approvalKeys.length === 0 && (await structureCounts()) === countsBefore80,
    approvalKeys.length === 0 ? 'no approval, sign-off, reviewer, submission, lifecycle or status key; a REVIEWABLE assessment changes no Claim, line, diagnosis, pointer or pricing row' : approvalKeys.join(', '),
  )

  // ---------------------------------------------------------------- database guards (T081–T090)
  section('Append-only assessment and findings, atomicity and database guards')
  const aRid = aR.body?.id as string
  const aUpdate = await attemptRolledBack((tx) => tx.$executeRawUnsafe(`UPDATE claim_draft_assessments SET outcome = 'INVALID' WHERE id = $1::uuid`, aRid))
  const aDelete = await attemptRolledBack((tx) => tx.$executeRawUnsafe('DELETE FROM claim_draft_assessments WHERE id = $1::uuid', aRid))
  check('T081', 'Assessment append-only', /append-only/.test(aUpdate) && /append-only/.test(aDelete), 'a direct UPDATE or DELETE of an assessment is rejected')
  const fUpdate = await attemptRolledBack((tx) => tx.$executeRawUnsafe(`UPDATE claim_draft_findings SET severity = 'ADVISORY' WHERE draft_assessment_id = $1::uuid`, aRid))
  const fDelete = await attemptRolledBack((tx) => tx.$executeRawUnsafe('DELETE FROM claim_draft_findings WHERE draft_assessment_id = $1::uuid', aRid))
  check('T082', 'Findings append-only', /append-only/.test(fUpdate) && /append-only/.test(fDelete), 'a direct UPDATE or DELETE of a finding is rejected')
  const lateFinding = await attemptRolledBack((tx) => insertFinding(tx, aRid, 2))
  check('T083', 'No late finding', /can only be recorded with its own assessment/.test(lateFinding), 'a finding cannot be added to a committed assessment by another transaction')
  const scopeLine = await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, validR), 1, 'CLAIM_DRAFT_PRICING_STALE', 'BLOCKER', 'PRICING', other.lineIds[0]))
  const scopeDiagnosis = await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, validR), 1, 'CLAIM_DRAFT_DIAGNOSIS_INVALID', 'BLOCKER', 'DIAGNOSIS', null, other.claimDiagnosisIds[0]))
  check('T084', 'Finding scope', /claim_draft_finding_scope/.test(scopeLine) && /claim_draft_finding_scope/.test(scopeDiagnosis), 'a finding about another Claim\'s line or diagnosis is refused')
  const shortCount = await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, { ...validR, findingCount: 2 }), 1))
  check('T085', 'Complete at commit', /claim_draft_assessments_complete/.test(shortCount), 'an assessment declaring two findings but holding one is rejected at commit')
  const reviewableBlocker = await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, { ...validR, outcome: 'REVIEWABLE' }), 1))
  const blockedAdvisory = await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, { ...validR, outcome: 'STALE' }), 1, ADVISORY, 'ADVISORY', 'JURISDICTION'))
  check('T086', 'Outcome agrees with findings', /claim_draft_assessments_complete/.test(reviewableBlocker) && /claim_draft_assessments_complete/.test(blockedAdvisory), 'REVIEWABLE with a blocker, or STALE without one, is rejected at commit')
  const badChecks = [
    [await attemptRolledBack((tx) => insertAssessment(tx, { ...validR, contract: 'A6-DRAFT-2' })), 'claim_draft_assessments_contract_version_chk'],
    [await attemptRolledBack((tx) => insertAssessment(tx, { ...validR, outcome: 'APPROVED' })), 'claim_draft_assessments_outcome_chk'],
    [await attemptRolledBack((tx) => insertAssessment(tx, { ...validR, fingerprint: 'not-a-fingerprint' })), 'claim_draft_assessments_fingerprint_chk'],
    [await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, validR), 1, 'CLAIM_DRAFT_NO_LINES', 'MAJOR')), 'claim_draft_findings_severity_chk'],
    [await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, validR), 1, 'CLAIM_DRAFT_NO_LINES', 'BLOCKER', 'PAYER')), 'claim_draft_findings_owner_scope_chk'],
    [await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, validR), 1, 'approved by reviewer')), 'claim_draft_findings_code_chk'],
    [await attemptRolledBack(async (tx) => insertFinding(tx, await insertAssessment(tx, validR), 0)), 'claim_draft_findings_ordinal_chk'],
  ]
  check('T087', 'Database CHECKs', badChecks.every(([message, name]) => message.includes(name)), 'contract, outcome (no APPROVED), fingerprint, severity, owner scope, bounded code and ordinal are each refused by name')
  const countsOfR = async () => JSON.stringify([await assessmentsOf(R.claimId), await prisma.claimDraftFinding.count({ where: { draftAssessment: { claimId: R.claimId } } }), await draftAudits()])
  const beforeRollback = await countsOfR()
  failAt('claimDraft.inserted', 'forced failure after the findings')
  const forcedA = await attemptAdversarial(() => createDraftAssessment(R.claimId, { pricingRunId: runR.id }, actorUserId))
  failAt('claimDraft.audited', 'forced failure after the audit')
  const forcedB = await attemptAdversarial(() => createDraftAssessment(R.claimId, { pricingRunId: runR.id }, actorUserId))
  clearConcurrencyProbes()
  check('T088', 'Atomic rollback', /forced failure/.test(forcedA) && /forced failure/.test(forcedB) && (await countsOfR()) === beforeRollback, 'a failure after the findings or after the audit leaves no assessment, finding or audit (2/2)')
  const fks = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text IN ('claim_draft_assessments', 'claim_draft_findings')`
  const historyDelete = await attemptRolledBack((tx) => tx.$executeRawUnsafe('DELETE FROM claim_pricing_runs WHERE id = $1::uuid', runR.id))
  check('T089', 'RESTRICT foreign keys', fks.length === 7 && fks.every((fk) => fk.confdeltype === 'r') && /append-only|restrict|foreign key/i.test(historyDelete), `${fks.length} foreign keys, all ON DELETE RESTRICT; a referenced pricing run cannot be deleted`)
  const listDB = await prisma.claimDraftAssessment.findMany({ where: { claimId: F.claimId }, include: { _count: { select: { findings: true } } } })
  check(
    'T090',
    'History counts',
    (listF.body?.items ?? []).every((item: any) => listDB.find((row) => row.id === item.id)?._count.findings === item.findingCount) && listDB.length === 2,
    'every listed assessment holds exactly its declared number of findings',
  )

  // ---------------------------------------------------------------- access and audit (T091–T100)
  section('Admin, Viewer, foreign and anonymous access; safe audit; read consistency')
  const auditsBefore91 = await draftAudits()
  const viewerAssess = await assessHttp(R.claimId, { pricingRunId: runR.id }, asViewer)
  check('T091', 'Viewer cannot assess', viewerAssess.status === 403 && (await draftAudits()) === auditsBefore91 && (await assessmentsOf(R.claimId)) === 2, '403; no assessment and no audit')
  const viewerReads = [await preview(R.claimId, runR.id, asViewer), await api('GET', `/api/claims/${R.claimId}/draft-assessments`, undefined, asViewer), await api('GET', `/api/claim-draft-assessments/${aRid}`, undefined, asViewer)]
  check('T092', 'Viewer reads', viewerReads.every((res) => res.status === 200), `preview, history and assessment ${viewerReads.map((r) => r.status).join('/')}`)
  const anonymousCalls = [await preview(R.claimId, runR.id, anonymous), await assessHttp(R.claimId, { pricingRunId: runR.id }, anonymous), await api('GET', `/api/claims/${R.claimId}/draft-assessments`, undefined, anonymous), await api('GET', `/api/claim-draft-assessments/${aRid}`, undefined, anonymous)]
  check('T093', 'Anonymous', anonymousCalls.every((res) => res.status === 401), `401 on all four routes (${anonymousCalls.map((r) => r.status).join('/')})`)
  const foreignRead = await api('GET', `/api/claim-draft-assessments/${foreign.assessmentId}`)
  const missingRead = await api('GET', `/api/claim-draft-assessments/${MISSING}`)
  check(
    'T094',
    'Foreign assessment',
    foreignRead.status === 404 && same(foreignRead.body?.error?.code, missingRead.body?.error?.code) && same(foreignRead.body?.error?.message, missingRead.body?.error?.message) && !JSON.stringify(foreignRead.body).includes(foreign.claimId),
    'another tenant\'s existing assessment is answered exactly like a missing one (404); nothing about it is disclosed',
  )
  const auditR = await prisma.auditEvent.findMany({ where: { actionCode: 'claim_draft.assessed', entityId: aRid } })
  check(
    'T095',
    'Audit exactly once',
    auditsAfter41 === auditsBefore41 + 1 && auditR.length === 1 && auditR[0].entityType === 'CLAIM_DRAFT_ASSESSMENT' && auditR[0].organizationId === org,
    'one claim_draft.assessed event per recorded assessment, on the assessment entity, in the Claim\'s organization',
  )
  const draftAuditRows = await prisma.auditEvent.findMany({ where: { actionCode: 'claim_draft.assessed', occurredAt: { gte: runStartedAt } } })
  const draftAuditText = JSON.stringify(draftAuditRows.map((row) => row.afterState)).replace(UUID_PATTERN, '<id>')
  check(
    'T096',
    'Audit minimal',
    draftAuditRows.length >= 8 &&
      draftAuditRows.every((row) => row.beforeState === null && same(Object.keys(row.afterState as object).sort(), ['claimId', 'draftContractVersion', 'evaluatedAt', 'findingCount', 'id', 'outcome', 'pricingRunId'])) &&
      !/AED|200\.01|amount|tariff|CLAIM_DRAFT_|PRIMARY|SECONDARY|procedure|service|diagnos|patient|payer/i.test(draftAuditText),
    'ids, contract, outcome, finding count and time only; no amount, code, role, patient or payer value',
  )
  const auditsBefore97 = await draftAudits()
  const assessmentsBefore97 = await prisma.claimDraftAssessment.count()
  await preview(R.claimId, runR.id)
  await preview(R.claimId)
  await api('GET', `/api/claims/${R.claimId}/draft-assessments`)
  await api('GET', `/api/claim-draft-assessments/${aRid}`)
  check('T097', 'Reads write nothing', (await draftAudits()) === auditsBefore97 && (await prisma.claimDraftAssessment.count()) === assessmentsBefore97, 'previews, history and assessment reads write no assessment and no audit')
  const auditsBefore98 = await draftAudits()
  await assessHttp(R.claimId, {})
  await assessHttp(R.claimId, { pricingRunId: MISSING })
  await assessHttp(R.claimId, { pricingRunId: runR.id }, asViewer)
  await assessHttp(foreign.claimId, { pricingRunId: foreign.pricingRunId })
  check('T098', 'No audit on refusal', (await draftAudits()) === auditsBefore98 && (await countsOfR()) === JSON.stringify([2, JSON.parse(beforeRollback)[1], auditsBefore98]), 'malformed, unknown-run, forbidden, foreign and rolled-back attempts write no assessment and no audit')
  const feCode = committedProductionCodeOf([FE_DRAFT_DIR])
  const scanPaths = [`:/${DRAFT_DIR}`, `:/${FE_DRAFT_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const logReach = gitGrep('evaluateDraft|ClaimDraftCheck', scanPaths)
  const secretScan = gitGrep("((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})", [`:/${HARNESS_DIR}`, ...scanPaths])
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [`:/${HARNESS_DIR}`])
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git(`show HEAD:${HARNESS_DIR}/a6-claim-draft.integration.ts`)
  const queryReads = (draftCode.code.match(/req\.query/g) ?? []).length
  const hygiene = [
    [feCode.files.length === 1 && !/\b(localStorage|sessionStorage|indexedDB)\b/.test(feCode.code), 'browser storage in the check page'],
    [!/(===|!==|==)\s*'(REVIEWABLE|INCOMPLETE|STALE|INVALID)'/.test(feCode.code) && /JSON\.stringify\(\{ pricingRunId: /.test(feCode.code), 'the check page decides an outcome or sends more than { pricingRunId }'],
    [logReach.status === 0 && logScan.status === 1, 'console logging in A6.4 code'],
    [secretReach.status === 0 && secretScan.status === 1, 'a committed secret'],
    [harnessSource.length > 0 && harnessSource.match(realDataMarkers) === null, 'a real-data marker in the harness'],
    [queryReads === 1 && /previewClaimDraft\(String\(req\.params\.claimId\), req\.query\)/.test(draftCode.code), 'a query string read anywhere except the preview\'s one validated pricingRunId'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T099',
    'No browser truth, logging or secrets',
    hygiene.length === 0,
    hygiene.length === 0 ? 'the check page only displays server outcomes and sends exactly { pricingRunId }; no browser storage, logging, secret or real-data marker; one validated query parameter' : hygiene.join('; '),
  )
  const readAdmin = await api('GET', `/api/claim-draft-assessments/${aRid}`)
  check(
    'T100',
    'Read consistency',
    readAdmin.status === 200 && same(readAdmin.body, viewerReads[2].body) && same(readAdmin.body, aR.body),
    'the assessment reads back identically for Admin and Viewer and equals the creation response, findings included',
  )

  // ---------------------------------------------------------------- concurrency (T101–T110)
  section('Concurrent structure and pricing writes, serialization retry, no split snapshot')
  const raceClaim = async (label: string, extra: Partial<DraftSpec> = {}) => {
    const claim = await draftClaim(label, { activities: [{ procedureCodeId: procA.id, quantity: '1' }, { serviceId: svcB.id, quantity: '1' }], ...extra })
    return { ...claim, run: await price(claim.claimId) }
  }
  const C1 = await raceClaim('race assessment first')
  const hold1 = holdAt('claimDraft.claim_locked')
  const assess1 = createDraftAssessment(C1.claimId, { pricingRunId: C1.run.id }, actorUserId)
  await Promise.race([hold1.arrived, assess1])
  const remove1 = removeClaimLine(C1.lineIds[1], {}, actorUserId)
  const remove1Waited = !(await settledWithin(remove1, 600))
  hold1.release()
  const [r1Assess, r1Remove] = await Promise.all([assess1, remove1])
  clearConcurrencyProbes()
  const p1After = await preview(C1.claimId, C1.run.id)
  check(
    'T101',
    'Assessment holds the Claim',
    remove1Waited && r1Assess.ok && r1Assess.value.outcome === 'REVIEWABLE' && r1Assess.value.activeLineCount === 2 && r1Remove.ok && p1After.body?.outcome === 'STALE',
    'a line removal waited for the assessment holding the Claim; the assessment saw both lines, the removal then committed and the next read is STALE',
  )
  const C2 = await raceClaim('race writer first')
  const hold2 = holdAt('claimLine.remove')
  const remove2 = removeClaimLine(C2.lineIds[1], {}, actorUserId)
  await Promise.race([hold2.arrived, remove2])
  const assess2 = createDraftAssessment(C2.claimId, { pricingRunId: C2.run.id }, actorUserId)
  const assess2Waited = !(await settledWithin(assess2, 600))
  hold2.release()
  const [r2Remove, r2Assess] = await Promise.all([remove2, assess2])
  clearConcurrencyProbes()
  check(
    'T102',
    'Writer first, fresh snapshot',
    assess2Waited && r2Remove.ok && r2Assess.ok && r2Assess.value.activeLineCount === 1 && r2Assess.value.outcome === 'STALE' && r2Assess.value.findings.some((f) => f.findingCode === 'CLAIM_DRAFT_PRICING_STALE'),
    'the assessment waited for a line removal holding the Claim and then judged the post-removal state (STALE), never the snapshot from before it waited',
  )
  const C3 = await raceClaim('race pricing first')
  const hold3 = holdAt('claimPricing.create')
  const pricing3 = createPricingRun(C3.claimId, {}, actorUserId)
  await Promise.race([hold3.arrived, pricing3])
  const assess3 = createDraftAssessment(C3.claimId, { pricingRunId: C3.run.id }, actorUserId)
  const assess3Waited = !(await settledWithin(assess3, 600))
  hold3.release()
  const [r3Pricing, r3Assess] = await Promise.all([pricing3, assess3])
  clearConcurrencyProbes()
  check(
    'T103',
    'Pricing run first',
    assess3Waited && r3Pricing.ok && r3Assess.ok && r3Assess.value.pricingRunId === C3.run.id && new Date(r3Assess.value.evaluatedAt) > new Date(r3Pricing.ok ? r3Pricing.value.evaluatedAt : 0),
    'the assessment waited for a pricing run holding the Claim, then judged exactly the run it was given; nothing was swapped for the newer run',
  )
  const concurrent = await Promise.all([assessHttp(R.claimId, { pricingRunId: runR.id }), assessHttp(R.claimId, { pricingRunId: runR.id })])
  check(
    'T104',
    'Concurrent assessments',
    concurrent.every((res) => res.status === 201 && res.body?.outcome === 'REVIEWABLE') && concurrent[0].body?.id !== concurrent[1].body?.id && concurrent[0].body?.assemblyFingerprint === concurrent[1].body?.assemblyFingerprint,
    'two simultaneous assessments of one Claim both complete as separate immutable rows with the same fingerprint',
  )
  const C5 = await raceClaim('race pointers', { roles: ['PRIMARY', 'SECONDARY'] })
  const hold5 = holdAt('claimLine.pointers')
  const pointers5 = setClaimLineDiagnosisPointers(C5.lineIds[0], { claimDiagnosisIds: C5.claimDiagnosisIds }, actorUserId)
  await Promise.race([hold5.arrived, pointers5])
  const assess5 = createDraftAssessment(C5.claimId, { pricingRunId: C5.run.id }, actorUserId)
  const assess5Waited = !(await settledWithin(assess5, 600))
  hold5.release()
  const [r5Pointers, r5Assess] = await Promise.all([pointers5, assess5])
  clearConcurrencyProbes()
  const p5After = await preview(C5.claimId, C5.run.id)
  check(
    'T105',
    'Pointer write first',
    assess5Waited && r5Pointers.ok && r5Assess.ok && r5Assess.value.assemblyFingerprint === p5After.body?.assemblyFingerprint,
    'the assessment waited for a pointer change and its fingerprint is exactly the post-change state',
  )
  const C6 = await raceClaim('race diagnosis', { spareDiagnoses: 1 })
  const hold6 = holdAt('claimDiagnosis.create')
  const diagnosis6 = createClaimDiagnosis(C6.claimId, { encounterDiagnosisId: C6.encounterDiagnosisIds[1], roleCode: 'SECONDARY' }, actorUserId)
  await Promise.race([hold6.arrived, diagnosis6])
  const assess6 = createDraftAssessment(C6.claimId, { pricingRunId: C6.run.id }, actorUserId)
  const assess6Waited = !(await settledWithin(assess6, 600))
  hold6.release()
  const [r6Diagnosis, r6Assess] = await Promise.all([diagnosis6, assess6])
  clearConcurrencyProbes()
  check('T106', 'Diagnosis write first', assess6Waited && r6Diagnosis.ok && r6Assess.ok && r6Assess.value.activeDiagnosisCount === 2, 'the assessment waited for a diagnosis being added and counted it')
  const C7 = await raceClaim('race preview')
  const hold7 = holdAt('claimLine.removed')
  const remove7 = removeClaimLine(C7.lineIds[1], {}, actorUserId)
  await Promise.race([hold7.arrived, remove7])
  const preview7 = preview(C7.claimId, C7.run.id)
  const preview7Prompt = await settledWithin(preview7, 5000)
  const p7During = await preview7
  hold7.release()
  await remove7
  clearConcurrencyProbes()
  const p7After = await preview(C7.claimId, C7.run.id)
  check(
    'T107',
    'Preview never mixes',
    preview7Prompt && p7During.body?.outcome === 'REVIEWABLE' && p7During.body?.lines?.length === 2 && p7After.body?.lines?.length === 1 && p7After.body?.outcome === 'STALE',
    'a preview during an uncommitted removal answers at once from one committed snapshot (both lines); after the commit it sees one line',
  )
  // A serializable writer that reads this Claim's assessments and changes one of its sources commits while
  // the assessment holds a snapshot: the assessment must be rolled back and retried, never commit stale.
  const C8 = await raceClaim('race serialization')
  const hold8 = holdAt('claimDraft.claim_locked')
  const assess8 = createDraftAssessment(C8.claimId, { pricingRunId: C8.run.id }, actorUserId)
  await Promise.race([hold8.arrived, assess8])
  const conflicting = await attemptAdversarial(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.claimDraftAssessment.count({ where: { claimId: C8.claimId } })
        await tx.$executeRawUnsafe('UPDATE encounter_activities SET quantity = 3 WHERE id = $1::uuid', C8.activityIds[0])
      },
      { isolationLevel: 'Serializable' },
    ),
  )
  hold8.release()
  const r8Assess = await assess8
  clearConcurrencyProbes()
  check(
    'T108',
    'Serialization retry',
    conflicting === '' && r8Assess.ok && r8Assess.value.outcome === 'STALE' && r8Assess.value.findings.some((f) => f.findingCode === 'CLAIM_DRAFT_SOURCE_STALE') && (await assessmentsOf(C8.claimId)) === 1,
    'a conflicting serializable source change committed mid-assessment: the assessment was retried on a fresh snapshot and recorded once, STALE (source)',
  )
  const C9 = await raceClaim('race assessment vs pricing')
  const hold9 = holdAt('claimDraft.claim_locked')
  const assess9 = createDraftAssessment(C9.claimId, { pricingRunId: C9.run.id }, actorUserId)
  await Promise.race([hold9.arrived, assess9])
  const pricing9 = createPricingRun(C9.claimId, {}, actorUserId)
  const pricing9Waited = !(await settledWithin(pricing9, 600))
  hold9.release()
  const [r9Assess, r9Pricing] = await Promise.all([assess9, pricing9])
  clearConcurrencyProbes()
  check(
    'T109',
    'Pricing waits for assessment',
    pricing9Waited && r9Assess.ok && r9Pricing.ok && new Date(r9Pricing.value.evaluatedAt) > new Date(r9Assess.value.evaluatedAt),
    'a pricing run waited for the assessment holding the Claim and was recorded after it',
  )
  const violations = await prisma.$queryRaw<{ id: string }[]>`
    SELECT a.id::text AS id FROM claim_draft_assessments a
    JOIN claims c ON c.id = a.claim_id
    JOIN claim_pricing_runs r ON r.id = a.pricing_run_id
    WHERE a.created_at >= ${runStartedAt}
      AND (r.claim_id <> a.claim_id OR c.pre_claim_readiness_assessment_id <> a.handoff_assessment_id OR r.input_structure_fingerprint <> a.pricing_input_fingerprint
        OR a.finding_count <> (SELECT count(*) FROM claim_draft_findings f WHERE f.draft_assessment_id = a.id)
        OR a.finding_count <> coalesce((SELECT max(f.ordinal) FROM claim_draft_findings f WHERE f.draft_assessment_id = a.id), 0)
        OR (a.outcome = 'REVIEWABLE') <> NOT EXISTS (SELECT 1 FROM claim_draft_findings f WHERE f.draft_assessment_id = a.id AND f.severity = 'BLOCKER'))`
  const createdThisRun = await prisma.claimDraftAssessment.count({ where: { createdAt: { gte: runStartedAt } } })
  check('T110', 'No split snapshot anywhere', violations.length === 0 && createdThisRun >= 15, `${createdThisRun} assessment(s) of this run: every one is complete, coherent with its run and basis, and agrees with its findings`)

  // ---------------------------------------------------------------- regressions (T111–T115)
  section('Regressions — A6.3 invoked, nesting A6.2 -> A6.1 -> A5.10 -> A1')
  await apiReady('the A6.3 and backward regression chain')
  const chain = run('npm run test:a6:claim-pricing')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A6.3')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.3] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.3 asserts facts about its own branch, its own migration, its own diff and its own upstream. On A6.4
  // those statements are obsolete by design; every other A6.3 check is substantive.
  const a63NonApplicable: Record<string, string> = {
    T001: "A6.3 'Start gate' requires the A6.3 feature branch and no A6.4+ code; A6.4 is branched from the main that contains A6.3",
    T004: "A6.3 'Migration scope' judges the single migration this branch adds against main; on A6.4 that is the A6.4 migration",
    T010: "A6.3 'Diff scope' lists the paths A6.3 was allowed to change; A6.4 legitimately changes different ones (T010 here)",
    T100: "A6.3 'Exact head and repeatability' requires the upstream to be the A6.3 feature branch, deleted when it merged (exact head and repeatability are T120 here)",
  }
  const undocumented = failing.filter((id) => !(id in a63NonApplicable))
  const counts = chain.output.match(/\[A6\.3\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T094') && !/\[A6\.3\] RUN ABORTED|\[A6\.3\] uncaught error/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check(
    'T111',
    'A6.3 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A6.3 suite did not complete'
      : !reconciled
        ? `A6.3 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.3 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.3\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.3] automated summary: ', 'A6.3 ')}; all ${failedCount} failure(s) named and accounted for`,
  )
  for (const id of Object.keys(a63NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A6.3 ${titleOf(row.line)}`, a63NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[A6.4]      ${text.slice(0, 400)}`)
  check('T112', 'A6.2 regression', verdictOf('T091') === 'PASS', `A6.3 T091 (A6.2 with its own justified N/A) ${verdictOf('T091')}`)
  check('T113', 'A6.1 regression', verdictOf('T092') === 'PASS', `A6.3 T092 (A6.1) ${verdictOf('T092')}`)
  check('T114', 'A5 regression', verdictOf('T093') === 'PASS', `A6.3 T093 (A5.8, A5.9, A5.10) ${verdictOf('T093')}`)
  check('T115', 'A1–A4 regression', verdictOf('T094') === 'PASS', `A6.3 T094 (A1–A4) ${verdictOf('T094')}`)

  // ---------------------------------------------------------------- builds and DB truth (T116–T119)
  section('Build gates and database truth')
  const unitTests = run('npm run test:unit')
  check('T116', 'Unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), (unitTests.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0])
  const typecheck = run('npm run typecheck')
  check('T117', 'Typecheck', typecheck.ok, 'backend typecheck clean')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T118', 'Frontend build/lint', build.ok && lint.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)
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
  check('T119', 'DB health truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- diff scope, leakage and exact head (T010, T120)
  section('Diff scope, phase leakage and exact head')
  await waitFor(databaseUp, 60_000)
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
  const ownDirs = [DRAFT_DIR, FE_DRAFT_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !file.includes('a6_4_claim_draft_integrity') && !allowed.includes(file))
  const laterDomain = changedPaths.filter((file) => /claim-review|claim-approval|claim-payload|claim-submission|claim-transport|remittance|integration\/a9|nabidh|malaffi|riayati/i.test(file))
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A6.4 module, migration, harness and check page, the shared non-waiting lock helper, vocabularies, the replay verifier and wiring; no owner module changed; no A6.5+ domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const transportTerms = /\b(dhpo|eclaimlink|soap|xml|x12|clearinghouse|nabidh|malaffi|riayati|fhir|hl7)\b/i
  const leakage = [
    [reached && !transportTerms.test(draftCode.code + feCode.code), 'a transport, payload or HIE term in A6.4 code'],
    [reached && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION|CURRENCY|MODE)\w*/i.test(draftCode.code), 'a process-global market or jurisdiction switch'],
    [reached && !/\b(approve\w*|submitClaim|signOff|createSubmission|serializeClaim\w*|toXml|buildPayload)\s*\(/.test(draftCode.code), 'an approval, submission or payload function'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  const priorAssessmentsNow = await prisma.claimDraftAssessment.count({ where: { createdAt: { lt: runStartedAt } } })
  const priorFindingsNow = await prisma.claimDraftFinding.count({ where: { createdAt: { lt: runStartedAt } } })
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T120',
    'Exact head, repeatability, no leakage',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a64Branch}`) && !/ahead|behind/.test(tracking) && priorAssessmentsNow === priorAssessmentsAtStart && priorFindingsNow === priorFindingsAtStart && leakage.length === 0,
    leakage.length > 0
      ? leakage.join('; ')
      : `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; ${priorAssessmentsNow} earlier assessment(s) and ${priorFindingsNow} finding(s) retained unchanged; no approval, payload, transport, HIE or global market mode`,
  )

  console.log(`\n[A6.4] run ${runId} — HEAD ${headSha}`)
  console.log(`[A6.4] worked example: Claim ${R.claimId}, pricing run ${runR.id} (AED ${pR.body?.pricing?.totalExtendedTariffAmount}), assessment ${aRid} ${aR.body?.outcome}, fingerprint ${aR.body?.assemblyFingerprint}`)
  if (failures.length > 0) {
    console.log(`[A6.4] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.4] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.4] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.4] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.4] CLAIM DRAFT ASSEMBLY / CLAIM-LEVEL INTEGRITY ACCEPTANCE COMPLETE' : '[A6.4] A6.4 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.4] RUN ABORTED: ${error.message}`)
      console.log('[A6.4] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.4] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.4] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
